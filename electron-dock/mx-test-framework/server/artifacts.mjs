import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AppError } from './core/errors.mjs'

// Artifact storage: plain files under <artifactsDir>/runs/<runId>/.
//
// No object store, no content-addressing, no lifecycle tiers. Recordings and
// reports are the only large things here, they expire on a fixed schedule, and
// the database keeps the index. See specs/10-deployment.md.

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
}

export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

export class ArtifactStore {
  constructor({ root }) {
    this.root = resolve(root)
  }

  runDir(runId) {
    return join(this.root, 'runs', runId)
  }

  /**
   * Resolve a caller-supplied relative path inside a run directory.
   *
   * The path comes from a runner or a URL, neither of which is trusted, so the
   * check is on the *resolved* path rather than on the input string: that is the
   * only form that cannot be fooled by encoding, `..` or a symlink-shaped name.
   */
  resolveWithin(runId, relativePath) {
    const base = this.runDir(runId)
    const target = resolve(base, relativePath)
    if (target !== base && !target.startsWith(base + sep)) {
      throw new AppError(400, 'invalid_artifact_path', 'Artifact path escapes the run directory')
    }
    return target
  }

  contentType(path) {
    return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  }

  /** Stream a request body to disk. Returns the byte count written. */
  async write(runId, relativePath, readable, { limitBytes = MAX_ARTIFACT_BYTES } = {}) {
    const target = this.resolveWithin(runId, relativePath)
    await mkdir(dirname(target), { recursive: true })

    let bytes = 0
    const meter = async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length
        if (bytes > limitBytes) {
          throw new AppError(413, 'artifact_too_large', `Artifact exceeds ${limitBytes} bytes`)
        }
        yield chunk
      }
    }

    try {
      await pipeline(readable, meter, createWriteStream(target))
    } catch (error) {
      // A partial file is worse than none: it would be served as if complete.
      await rm(target, { force: true }).catch(() => {})
      if (error instanceof AppError) throw error
      if (error?.code === 'ENOSPC') {
        throw new AppError(507, 'artifact_storage_full', '产物存储空间已满', {
          hint: '运行 `manage.sh clean` 清理过期产物，或扩容 PVC。',
        })
      }
      throw error
    }
    return bytes
  }

  /** Every file under a run directory, as paths relative to it. */
  async list(runId) {
    const base = this.runDir(runId)
    const found = []
    const walk = async (dir) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          const info = await stat(full)
          found.push({
            path: relative(base, full).split(sep).join('/'),
            bytes: info.size,
            contentType: this.contentType(full),
          })
        }
      }
    }
    await walk(base)
    return found.sort((a, b) => a.path.localeCompare(b.path))
  }

  async remove(runId) {
    await rm(this.runDir(runId), { recursive: true, force: true })
  }

  /**
   * Serve a file, honouring HTTP Range.
   *
   * Range is not an optimization here: without it a browser cannot seek in a
   * recording, so "jump to the failing step" — the entire point of the step
   * timeline — would mean re-watching from the start.
   */
  async serve(runId, relativePath, request, response) {
    const target = this.resolveWithin(runId, relativePath)
    let info
    try {
      info = await stat(target)
    } catch {
      throw new AppError(404, 'artifact_not_found', '产物不存在或已过期', {
        hint: '产物默认保留 30 天，过期后执行记录仍在，但文件已清理。',
      })
    }
    if (info.isDirectory()) {
      return this.serve(runId, join(relativePath, 'index.html'), request, response)
    }

    const contentType = this.contentType(target)
    const headers = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=300',
      // Artifacts are attacker-influenced content served from our origin. A
      // restrictive CSP and nosniff keep an uploaded .html from turning into
      // stored XSS against the platform session.
      'content-security-policy': "sandbox allow-scripts; default-src 'self' data: blob:",
      'x-content-type-options': 'nosniff',
    }

    const range = request.headers.range
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range ?? '')
    if (match && info.size > 0) {
      const [, rawStart, rawEnd] = match
      let start = rawStart === '' ? info.size - Number(rawEnd) : Number(rawStart)
      let end = rawStart === '' || rawEnd === '' ? info.size - 1 : Number(rawEnd)
      start = Math.max(0, Math.min(start, info.size - 1))
      end = Math.max(start, Math.min(end, info.size - 1))
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        response.writeHead(416, { 'content-range': `bytes */${info.size}` }).end()
        return
      }
      response.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${info.size}`,
        'content-length': end - start + 1,
      })
      await pipeline(createReadStream(target, { start, end }), response)
      return
    }

    response.writeHead(200, { ...headers, 'content-length': info.size })
    await pipeline(createReadStream(target), response)
  }

  /** Delete run directories older than `days`. Returns the run ids purged. */
  async purgeOlderThan(days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const base = join(this.root, 'runs')
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const purged = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(base, entry.name)
      const info = await stat(full)
      if (info.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true })
        purged.push(entry.name)
      }
    }
    return purged
  }
}
