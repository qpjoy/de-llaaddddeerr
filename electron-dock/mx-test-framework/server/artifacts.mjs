import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, rmdir, stat, statfs } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AppError } from './core/errors.mjs'

// Artifact storage: plain files under <artifactsDir>/runs/<runId>/.
//
// No object store, no content-addressing, no lifecycle tiers. Recordings and
// reports are the only large things here, they expire on a fixed schedule, and
// the database keeps the index. See docs/10-deployment.md.

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
export const MAX_RUN_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_RUN_ARTIFACT_FILES = 1_000
export const MAX_TOTAL_ARTIFACT_BYTES = 20 * 1024 * 1024 * 1024
export const MAX_TOTAL_ARTIFACT_ENTRIES = 100_000
export const MIN_FREE_ARTIFACT_INODES = 10_000

export class ArtifactStore {
  #writeTail = Promise.resolve()

  constructor({
    root,
    maxFileBytes = MAX_ARTIFACT_BYTES,
    maxRunBytes = MAX_RUN_ARTIFACT_BYTES,
    maxFilesPerRun = MAX_RUN_ARTIFACT_FILES,
    maxTotalBytes = MAX_TOTAL_ARTIFACT_BYTES,
    maxTotalEntries = MAX_TOTAL_ARTIFACT_ENTRIES,
    minFreeBytes = 0,
    minFreeInodes = 0,
    statfsImpl = statfs,
  }) {
    this.root = resolve(root)
    this.maxFileBytes = maxFileBytes
    this.maxRunBytes = maxRunBytes
    this.maxFilesPerRun = maxFilesPerRun
    this.maxTotalBytes = maxTotalBytes
    this.maxTotalEntries = maxTotalEntries
    this.minFreeBytes = minFreeBytes
    this.minFreeInodes = minFreeInodes
    this.statfsImpl = statfsImpl
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
    if (target === base || !target.startsWith(base + sep)) {
      throw new AppError(400, 'invalid_artifact_path', 'Artifact path escapes the run directory')
    }
    return target
  }

  contentType(path) {
    return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  }

  /**
   * Stream a request body to disk. Returns the byte count written.
   *
   * All writes are serialised. Without that small lock, parallel uploads from
   * either the same or different runs could observe the same persistent-volume
   * budget and together cross the hard limit.
   */
  async write(runId, relativePath, readable, options = {}) {
    const previous = this.#writeTail
    let release
    const gate = new Promise((resolveGate) => {
      release = resolveGate
    })
    const tail = previous.then(() => gate)
    this.#writeTail = tail
    await previous

    try {
      return await this.#write(runId, relativePath, readable, options)
    } finally {
      release()
    }
  }

  async #write(
    runId,
    relativePath,
    readable,
    {
      limitBytes = this.maxFileBytes,
      limitRunBytes = this.maxRunBytes,
      limitFiles = this.maxFilesPerRun,
      limitTotalBytes = this.maxTotalBytes,
      limitTotalEntries = this.maxTotalEntries,
      minFreeBytes = this.minFreeBytes,
      minFreeInodes = this.minFreeInodes,
    } = {},
  ) {
    const target = this.resolveWithin(runId, relativePath)
    await mkdir(this.root, { recursive: true })
    const normalizedPath = relative(this.runDir(runId), target).split(sep).join('/')
    const existing = await this.list(runId)
    const replaced = existing.find((entry) => entry.path === normalizedPath)
    if (!replaced && existing.length >= limitFiles) {
      throw new AppError(
        413,
        'artifact_file_limit',
        `Run artifact count exceeds ${limitFiles} files`,
      )
    }
    const committedBytes = existing.reduce((total, entry) => total + entry.bytes, 0)
    const remainingRunBytes = limitRunBytes - committedBytes + (replaced?.bytes ?? 0)
    if (remainingRunBytes <= 0) {
      throw new AppError(
        413,
        'artifact_run_too_large',
        `Run artifacts exceed ${limitRunBytes} bytes`,
      )
    }
    const storedBytes = await this.totalBytes()
    const remainingTotalBytes = limitTotalBytes - storedBytes + (replaced?.bytes ?? 0)
    if (remainingTotalBytes <= 0) {
      throw new AppError(507, 'artifact_storage_budget', '产物存储已达到平台硬上限', {
        hint: '等待保留策略清理旧产物，或由运维扩容并同步提高 MXT_ARTIFACT_MAX_TOTAL_BYTES。',
      })
    }
    const missingDirectories = await this.#missingParentDirectories(target)
    const storedEntries = await this.totalEntries()
    // A successful new path consumes its missing parent directories and one
    // file entry. While streaming, that file is the root-level staging entry,
    // so the same count also describes the peak. Replacements still need one temporary
    // inode before the atomic rename can release the old file.
    const requiredEntries = missingDirectories.length + 1
    if (storedEntries + requiredEntries > limitTotalEntries) {
      throw new AppError(507, 'artifact_storage_entry_budget', '产物存储条目已达到平台硬上限', {
        hint: '等待保留策略清理旧产物，或由运维扩容并同步提高 MXT_ARTIFACT_MAX_TOTAL_ENTRIES。',
      })
    }
    const filesystem = await this.statfsImpl(this.root)
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
    // The previous file remains allocated while its replacement is staged, so
    // it cannot be credited against the physical free-space reserve here.
    const writableBeforeReserve = availableBytes - minFreeBytes
    if (!Number.isFinite(writableBeforeReserve) || writableBeforeReserve <= 0) {
      throw new AppError(507, 'artifact_storage_low', '产物磁盘已进入安全保留区', {
        hint: '清理旧产物或扩容磁盘；平台不会消耗为节点保留的剩余空间。',
      })
    }
    const availableInodes = Number(filesystem.ffree)
    if (
      !Number.isFinite(availableInodes) ||
      availableInodes - minFreeInodes < requiredEntries
    ) {
      throw new AppError(507, 'artifact_storage_inode_low', '产物磁盘 inode 已进入安全保留区', {
        hint: '清理大量小文件或扩容文件系统；平台不会消耗为节点保留的 inode。',
      })
    }
    const effectiveLimit = Math.min(
      limitBytes,
      remainingRunBytes,
      remainingTotalBytes,
      writableBeforeReserve,
    )
    const staging = join(this.root, `.upload-${randomUUID()}.part`)

    let bytes = 0
    const meter = async function* (source) {
      for await (const chunk of source) {
        bytes += chunk.length
        if (bytes > effectiveLimit) {
          if (effectiveLimit === writableBeforeReserve) {
            throw new AppError(507, 'artifact_storage_low', '产物磁盘将进入安全保留区')
          }
          if (effectiveLimit === remainingTotalBytes) {
            throw new AppError(507, 'artifact_storage_budget', '产物存储将超过平台硬上限')
          }
          if (effectiveLimit === remainingRunBytes) {
            throw new AppError(
              413,
              'artifact_run_too_large',
              `Run artifacts exceed ${limitRunBytes} bytes`,
            )
          }
          throw new AppError(413, 'artifact_too_large', `Artifact exceeds ${limitBytes} bytes`)
        }
        yield chunk
      }
    }

    let stagingHandle
    try {
      // Stream before creating caller-controlled directory trees. A rejected
      // upload therefore leaves neither a partial artifact nor a ladder of
      // empty directories. Rename keeps a completed artifact atomic.
      // Awaiting open is important: createWriteStream opens lazily, so a meter
      // rejection can otherwise run cleanup before the file is actually
      // created and leave a late zero-byte .part file behind.
      stagingHandle = await open(staging, 'wx')
      await pipeline(readable, meter, stagingHandle.createWriteStream({ autoClose: true }))
      await mkdir(dirname(target), { recursive: true })
      await rename(staging, target)
    } catch (error) {
      // A partial file is worse than none: it would be served as if complete.
      await stagingHandle?.close().catch(() => {})
      await rm(staging, { force: true }).catch(() => {})
      for (const directory of [...missingDirectories].reverse()) {
        // Only directories absent at preflight are candidates, and rmdir will
        // refuse anything that another actor populated in the meantime.
        await rmdir(directory).catch(() => {})
      }
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

  /** Current bytes under the persistent artifact root, across every run. */
  async totalBytes() {
    let bytes = 0
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
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) bytes += (await stat(full)).size
      }
    }
    await walk(this.root)
    return bytes
  }

  /** Filesystem entries under the artifact root, including empty directories. */
  async totalEntries() {
    let count = 0
    const walk = async (dir) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        count += 1
        if (entry.isDirectory()) await walk(join(dir, entry.name))
      }
    }
    await walk(this.root)
    return count
  }

  async #missingParentDirectories(target) {
    const parent = dirname(target)
    const parts = relative(this.root, parent).split(sep).filter(Boolean)
    const missing = []
    let cursor = this.root
    let parentMissing = false
    for (const part of parts) {
      cursor = join(cursor, part)
      if (parentMissing) {
        missing.push(cursor)
        continue
      }
      try {
        const info = await lstat(cursor)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new AppError(
            400,
            'invalid_artifact_path',
            'Artifact parent must be a real directory',
          )
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        parentMissing = true
        missing.push(cursor)
      }
    }
    return missing
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
