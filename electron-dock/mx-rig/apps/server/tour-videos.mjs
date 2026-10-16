// 演示录像 (docs/24 M8c): one video per tour, recorded at release by
// scripts/record-tours.mjs and published here, so 新手引导 shows the
// interface being shipped rather than a screen recording someone made once.
//
// Only tours in the catalogue have a video, only the latest recording of each
// is kept, and only an admin publishes. The videos show the workbench against
// fixtures (the proving ground, a stand-in repository), so any member may
// watch them. Files sit under the artifacts root beside the test versions and
// keep the same free-space reserve.

import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { RigError } from '../../packages/contracts/index.mjs'
import { readTestInput } from '../../packages/runtime/test-workspace.mjs'
import { TOURS } from '../web/tours.js'

export const MAX_VIDEO_BYTES = 32 * 1024 * 1024
const TOUR_IDS = new Set(TOURS.map((tour) => tour.id))
// Every WebM file starts with the EBML magic number.
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
const publishBody = z
  .object({
    version: z.string().trim().min(1).max(40),
    recordedAt: z.string().datetime(),
    durationMs: z.number().int().positive().max(30 * 60 * 1000),
    video: z.string().min(16).max(Math.ceil((MAX_VIDEO_BYTES * 4) / 3) + 8)
  })
  .strict()

export class TourVideos {
  constructor(root, { minFreeBytes = 0, statfsImpl = statfs } = {}) {
    this.root = root
    this.minFreeBytes = minFreeBytes
    this.statfsImpl = statfsImpl
  }
  #known(id) {
    if (!TOUR_IDS.has(id)) throw new RigError('not_found', '没有这个演示', 404)
  }
  file(id) {
    this.#known(id)
    return join(this.root, `${id}.webm`)
  }
  async list() {
    const videos = []
    for (const tour of TOURS) {
      const meta = await readFile(join(this.root, `${tour.id}.json`), 'utf8').then(JSON.parse, () => null)
      if (meta) videos.push({ id: tour.id, title: tour.title, ...meta })
    }
    return { videos }
  }
  async publish(id, principal, input) {
    this.#known(id)
    const body = readTestInput(publishBody, input)
    const bytes = Buffer.from(body.video, 'base64')
    if (bytes.length > MAX_VIDEO_BYTES) throw new RigError('video_too_large', '演示录像超过 32 MB', 413)
    if (!bytes.subarray(0, 4).equals(EBML)) throw new RigError('video_invalid', '上传的内容不是 WebM 录像')
    await mkdir(this.root, { recursive: true })
    if (this.minFreeBytes) {
      const filesystem = await this.statfsImpl(this.root)
      const available = Number(filesystem.bavail) * Number(filesystem.bsize)
      if (!Number.isFinite(available) || available - bytes.length < this.minFreeBytes)
        throw new RigError('storage_low', '服务器磁盘已到保留区，暂时不能发布演示录像。', 507)
    }
    const meta = {
      version: body.version,
      recordedAt: body.recordedAt,
      durationMs: body.durationMs,
      bytes: bytes.length,
      publishedBy: principal.displayName ?? principal.id,
      publishedAt: new Date().toISOString()
    }
    // The video first, then what says it is there; each replaced in one step.
    const temp = join(this.root, `.${id}.${randomUUID()}.part`)
    await writeFile(temp, bytes, { mode: 0o600 })
    await rename(temp, this.file(id))
    const metaTemp = `${temp}.json`
    await writeFile(metaTemp, JSON.stringify(meta, null, 2))
    await rename(metaTemp, join(this.root, `${id}.json`))
    return { id, ...meta }
  }
}

/** Send `file`, honouring a single byte range so a <video> can seek. */
async function sendVideo(req, res, file) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) throw new RigError('not_found', '这个演示还没有录像', 404)
  const headers = {
    'content-type': 'video/webm',
    'accept-ranges': 'bytes',
    // Re-recorded at each release under the same name.
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff'
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (match && info.size > 0 && (match[1] !== '' || match[2] !== '')) {
    const [, rawStart, rawEnd] = match
    let start = rawStart === '' ? info.size - Number(rawEnd) : Number(rawStart)
    let end = rawStart === '' || rawEnd === '' ? info.size - 1 : Number(rawEnd)
    if (start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` })
      res.end()
      return
    }
    start = Math.max(0, start)
    end = Math.max(start, Math.min(end, info.size - 1))
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 })
    await pipeline(createReadStream(file, { start, end }), res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': info.size })
  await pipeline(createReadStream(file), res)
}

export async function tourVideoRoutes({ req, res, path, principal, videos, readJson, sendJson, requireRole }) {
  if (path === '/api/rig/v1/tour-videos' && req.method === 'GET') {
    sendJson(res, 200, await videos.list())
    return true
  }
  const match = /^\/api\/rig\/v1\/tour-videos\/([a-z0-9][a-z0-9-]{0,40})(\.webm)?$/.exec(path)
  if (!match) return false
  if (match[2] && req.method === 'GET') {
    await sendVideo(req, res, videos.file(match[1]))
    return true
  }
  if (!match[2] && req.method === 'PUT') {
    requireRole(principal, 'admin')
    sendJson(res, 200, { video: await videos.publish(match[1], principal, await readJson(req, Math.ceil((MAX_VIDEO_BYTES * 4) / 3) + 64 * 1024)) })
    return true
  }
  throw new RigError('method_not_allowed', '不支持的方法', 405)
}
