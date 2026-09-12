import { createServer } from 'node:http'
import { ArchiveCatalog } from './archive-catalog.mjs'
import { assertLocalStorage } from './mounts.mjs'
import { MediaJobs } from './jobs.mjs'
import { MediaCache } from './cache.mjs'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, open, stat, statfs, unlink } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createExternalImageLoader, validateExternalImage } from '../../../mx-insight-hub/server/external-platforms/media.mjs'

const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'application/pdf'])
const hash = (value) => createHash('sha256').update(value).digest('hex')
const fail = (status, code) => Object.assign(new Error(code), { status, code })
const equal = (a, b) => {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''))
  return left.length === right.length && timingSafeEqual(left, right)
}
export function validateMedia(body, type) {
  if (type.startsWith('image/')) return validateExternalImage(body, type)
  const valid = type === 'video/mp4' ? body.length >= 12 && body.toString('ascii', 4, 8) === 'ftyp'
    : type === 'video/webm' ? body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : type === 'audio/mpeg' ? body.toString('ascii', 0, 3) === 'ID3' || (body[0] === 255 && (body[1] & 224) === 224)
    : type === 'audio/ogg' ? body.toString('ascii', 0, 4) === 'OggS'
    : type === 'audio/wav' ? body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WAVE'
    : type === 'application/pdf' ? body.toString('ascii', 0, 5) === '%PDF-'
    : false
  if (!valid) throw fail(415, 'media_content_invalid')
}
async function atomic(path, body) {
  const firstCreated = await mkdir(dirname(path), { recursive: true, mode: 0o750 })
  // Persist newly created project/date directory entries as well as the file.
  if (firstCreated) {
    const parent = dirname(firstCreated)
    for (let current = dirname(path); ; current = dirname(current)) {
      const directory = await open(current, 'r')
      try { await directory.sync() } finally { await directory.close() }
      if (current === parent) break
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o640)
    try { await file.writeFile(body); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await unlink(temporary).catch(() => {}) }
}
async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function bounded(req, maximum) {
  if (Number(req.headers['content-length']) > maximum) throw fail(413, 'file_too_large')
  const parts = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maximum) throw fail(413, 'file_too_large')
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}
export function createStaticService({
  root, projects, signingKey, publicUrl = '', readOnly = false,
  maxBytes = 64 * 1024 * 1024, maxConcurrency = 4, minFreeBytes = 512 * 1024 * 1024,
  stateDir = join(root || '/data', '.state'), queueOptions = {}, cacheOptions = {}, waitMs = 1000,
  ioTimeoutMs = 10000, writerUrl = '', workerEnabled = true, allowedOrigins = [], loader = createExternalImageLoader({
    contentTypes: TYPES, validateContent: validateMedia, maxBytes,
    maxConcurrency, timeoutMs: 30_000, maxCacheBytes: 0, maxCacheEntries: 0,
  }),
} = {}) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32 || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw new Error('Invalid worker/wait limits')
  if (!root || !signingKey || signingKey.length < 32 || !projects || !Object.keys(projects).length) throw new Error('mx-static requires root, project credentials and a 32+ character signing key')
  for (const [project, credentials] of Object.entries(projects)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(project) || !credentials.read || !credentials.write || Math.min(credentials.read.length, credentials.write.length) < 32) throw new Error('Invalid project credentials')
  }
  assertLocalStorage([root,stateDir],{controlPaths:[stateDir]})
  let active = 0
  let uploading = 0
  let reading = 0
  const jobs = new MediaJobs(stateDir, { ...queueOptions, readOnly })
  const archive = new ArchiveCatalog(stateDir, {readOnly})
  const memory = new MediaCache(cacheOptions)
  const reads = new Map()
  const running = new Map()
  let stopping = false
  let pumping = false
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  function jobView(job) {
    return { id: job.id, state: job.state, attempts: job.attempts, error: job.error,
      statusUrl: `/static/v1/projects/${job.project}/jobs/${job.id}`,
      ...(job.result ? presented(job.result, 'stored_cache') : {}) }
  }
  async function processJob(job, controller) {
    try {
      const result = await loader(job.url, { cacheScope: `${job.project}/${job.source_hash}`, signal: controller.signal })
      if (controller.signal.aborted) throw fail(503, 'worker_stopped')
      // A retry writes a new immutable object. A stale lease can never replace
      // a completed object or advance the source index.
      const meta = await save(job.project, job.scope, result.body, result.contentType)
      if (jobs.complete(job, meta)) memory.set(meta.key, result.body, meta)
    } catch (error) {
      jobs.fail(job, error.code || 'source_unavailable', {
        aborted: stopping,
        status: error.status || 502,
        retryable: ![400, 401, 403, 413, 415, 422].includes(error.status),
      })
    }
  }
  function pump() {
    if (stopping || readOnly || !workerEnabled || pumping) return
    pumping = true
    try {
      while (running.size < maxConcurrency) {
        const job = jobs.claim()
        if (!job) break
        const controller = new AbortController()
        const promise = processJob(job, controller).catch(() => {
          // A failed control-disk write leaves the lease durable for recovery.
        }).finally(() => { running.delete(job.id); if (!stopping) pump() })
        running.set(job.id, { job, controller, promise })
      }
    } finally { pumping = false }
  }
  const workerTimer = setInterval(() => {
    memory.prune()
    if (!readOnly && !stopping) {
      try { for (const entry of running.values()) jobs.renew(entry.job); pump() } catch { /* keep durable leases; retry on next tick */ }
    }
  }, 500)
  workerTimer.unref()
  if (!readOnly && workerEnabled) queueMicrotask(pump)
  const sign = (key, expires) => createHmac('sha256', signingKey).update(`${key}\n${expires}`).digest('hex')
  function authorize(req, project, write = false) {
    const credential = projects[project]
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    if (!credential || !(equal(token, credential.write) || (!write && equal(token, credential.read)))) throw fail(401, 'unauthorized')
  }
  function presented(meta, sourceMode) {
    const expires = String(Math.floor(Date.now() / 1000) + 900)
    return { ...meta, sourceMode, previewUrl: `${publicUrl}/static/files/${meta.key}?expires=${expires}&signature=${sign(meta.key, expires)}` }
  }
  async function save(project, scope, body, contentType, sourceHash = null) {
    if (body.length > maxBytes) throw fail(413, 'file_too_large')
    validateMedia(body, contentType)
    await mkdir(root, { recursive: true, mode: 0o750 })
    const disk = await statfs(root)
    if (disk.bavail * disk.bsize < minFreeBytes + body.length) throw fail(507, 'storage_full')
    const sha256 = hash(body)
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '/')
    const key = `${project}/${date}/${randomUUID()}`
    const meta = { key, project, scope, sha256, contentType, size: body.length, capturedAt: new Date().toISOString() }
    // Publish the manifest only after the complete immutable object is durable.
    await atomic(join(root, 'objects', key), body)
    await atomic(join(root, 'metadata', `${key}.json`), JSON.stringify(meta))
    if (sourceHash) await atomic(join(root, 'sources', project, `${sourceHash}.json`), JSON.stringify(meta))
    archive.register(meta)
    memory.set(meta.key,body,meta)
    return meta
  }
  async function restore(meta) {
    const stored=archive.get(meta.key)
    if (!stored?.mirrored) throw fail(503, 'stored_media_unavailable')
    if (!readOnly) archive.request(meta.key, 'restore')
    else if (writerUrl) {
      try {
        const response=await fetch(`${writerUrl}/static/v1/projects/${meta.project}/storage/restore`, {method:'POST', redirect:'error', signal:AbortSignal.timeout(1000), headers:{authorization:`Bearer ${projects[meta.project].write}`, 'content-type':'application/json'},body:JSON.stringify({key:meta.key})})
        await response.body?.cancel()
      } catch { /* Local writer outage is retryable, never an NFS call. */ }
    }
  }
  async function ingest(project, input, requestedWait = waitMs) {
    const { url, scope = '', mode = 'cache_first' } = input
    if (typeof url !== 'string' || !url || url.length > 16384 || typeof scope !== 'string' || scope.length > 256 || !['cache_first', 'cache_only', 'refresh'].includes(mode)) throw fail(400, 'invalid_request')
    const sourceHash = hash(`${scope}\0${url}`)
    const known = jobs.ready(project, sourceHash)
    const cached = known?.result || await jsonFile(join(root, 'sources', project, `${sourceHash}.json`))
    const usable = cached && await stat(join(root, 'objects', cached.key)).then(s => s.size === cached.size, () => false)
    if (usable && mode !== 'refresh') return presented(cached, 'stored_cache')
    if (cached && !usable && mode !== 'refresh') {
      await restore(cached)
      return { state:'queued', statusUrl:`/static/v1/projects/${project}/storage`, reason:'media_restore_pending' }
    }
    let job = jobs.pending(project, sourceHash)
    if (!job && mode === 'cache_only') throw fail(404, 'stored_media_not_found')
    if (!job && mode !== 'refresh') {
      const last = jobs.latest(project, sourceHash)
      if (last?.state === 'failed') throw fail(last.error_status || 502, last.error || 'source_unavailable')
    }
    if (!job) job = jobs.enqueue(project, scope, sourceHash, url)
    pump()
    const deadline = Date.now() + requestedWait
    while (Date.now() < deadline && ['queued', 'running'].includes(job.state)) {
      await sleep(Math.min(50, deadline - Date.now()))
      job = jobs.get(job.id, project)
    }
    if (job.state === 'ready') return { ...presented(job.result, 'live'), id: job.id, state: 'ready' }
    if (usable) return { ...presented(cached, job.state === 'failed' ? 'stored_fallback' : 'refreshing_cache'), job: jobView(job) }
    if (job.state === 'failed') throw fail(job.error_status || 502, job.error || 'source_unavailable')
    return jobView(job) // 202 + status URL, never a premature object URL/404.
  }
  async function readCached(file, key, size, meta) {
    const cached = memory.get(key)
    if (cached) return { body: cached, source: 'memory' }
    if (size > memory.maxObjectBytes || size > memory.maxBytes) return null
    let reading = reads.get(key)
    if (!reading) {
      // Bound simultaneous cache fills; extra readers stream via OS page cache.
      if (reads.size >= 16) return null
      reading = readFile(file).then(body => { memory.set(key, body, meta); return body })
      reads.set(key, reading)
      reading.finally(() => reads.delete(key)).catch(() => {})
    }
    return { body: await reading, source: 'disk' }
  }
  const server = createServer(async (req, res) => {
    const json = (status, value) => {
      if(res.writableEnded || res.destroyed) return
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const deadline=setTimeout(()=>{if(!res.headersSent)json(503,{error:{code:'storage_io_timeout'}})},ioTimeoutMs)
    deadline.unref()
    res.once('finish',()=>clearTimeout(deadline));res.once('close',()=>clearTimeout(deadline))
    let readAdmitted = false
    let admitted = false
    let uploadAdmitted = false
    try {
      const url = new URL(req.url, 'http://mx-static')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('content-security-policy', "sandbox; default-src 'none'; frame-ancestors 'self'")
      if (allowedOrigins.includes(req.headers.origin)) {
        res.setHeader('access-control-allow-origin', req.headers.origin)
        res.setHeader('vary', 'Origin')
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Range, Prefer')
        res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS')
        res.setHeader('access-control-expose-headers', 'Content-Range, ETag, Accept-Ranges')
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
      if (url.pathname === '/static/health' && req.method === 'GET') return json(stopping ? 503 : 200, { status: stopping ? 'draining' : 'ok', readOnly })
      if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/static/files/')) {
        const key = url.pathname.slice('/static/files/'.length)
        if (!/^[a-z0-9][a-z0-9-]{0,63}\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9-]{36}$/.test(key)) throw fail(404, 'not_found')
        const expires = url.searchParams.get('expires') || ''
        const signed = /^\d+$/.test(expires) && Number(expires) >= Date.now() / 1000 && Number(expires) <= Date.now() / 1000 + 901 && equal(url.searchParams.get('signature'), sign(key, expires))
        if (!signed) authorize(req, key.split('/')[0])
        if(reading>=64) throw fail(503,'storage_read_busy')
        reading++;readAdmitted=true
        const memoryBody=memory.get(key)
        const meta = (memoryBody && memory.metadata(key)) || await jsonFile(join(root, 'metadata', `${key}.json`))
        if (!meta) throw fail(404, 'not_found')
        const file = join(root, 'objects', key)
        const info = memoryBody ? {size:meta.size} : await stat(file).catch(error => { if(error.code==='ENOENT') return null;throw error })
        if(!info) { await restore(meta);res.setHeader('retry-after','2');throw fail(503,'media_restore_pending') }
        if (info.size !== meta.size) throw fail(503, 'stored_media_corrupt')
        const etag = `"${meta.sha256}"`
        res.setHeader('etag', etag)
        res.setHeader('cache-control', 'private, max-age=0, must-revalidate')
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end() }
        let start = 0, end = meta.size - 1, status = 200
        if (req.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
          if (!range || (!range[1] && !range[2])) throw fail(416, 'invalid_range')
          if (!range[1]) start = Math.max(0, meta.size - Number(range[2]))
          else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])) }
          if (start > end || start >= meta.size) { res.setHeader('content-range', `bytes */${meta.size}`); throw fail(416, 'invalid_range') }
          status = 206; res.setHeader('content-range', `bytes ${start}-${end}/${meta.size}`)
        }
        const cachedRead = req.method === 'HEAD' ? null : memoryBody ? {body:memoryBody,source:'memory'} : await readCached(file, key, meta.size, meta)
        res.setHeader('x-mx-static-cache', cachedRead?.source || 'stream')
        res.writeHead(status, { 'content-type': meta.contentType, 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-disposition': meta.contentType === 'application/pdf' ? 'attachment' : 'inline' })
        if (req.method === 'HEAD') return res.end()
        if (cachedRead) { res.end(cachedRead.body.subarray(start, end + 1)); return }
        await pipeline(createReadStream(file, { start, end }), res)
        return
      }
      const storageRoute=/^\/static\/v1\/projects\/([a-z0-9-]+)\/storage(?:\/(restore|evict|sync))?$/.exec(url.pathname)
      if(storageRoute) {
        const [,project,action]=storageRoute
        authorize(req,project,Boolean(action))
        if(!action && req.method==='GET') return json(200,archive.status(project))
        if(!action || req.method!=='POST' || readOnly || stopping) throw fail(405,'method_not_allowed')
        let input
        try { input=JSON.parse(await bounded(req,4096)) } catch(error) {if(error.status)throw error;throw fail(400,'invalid_json')}
        if(typeof input?.key!=='string' || !input.key.startsWith(project+'/')) throw fail(400,'invalid_archive_key')
        if(!archive.request(input.key,action)) throw fail(409,'storage_transition_unavailable')
        res.setHeader('retry-after','2');return json(202,{key:input.key,state:'queued',action})
      }
      const jobRoute = /^\/static\/v1\/projects\/([a-z0-9-]+)\/jobs(?:\/([a-f0-9-]{36})(\/retry)?)?$/.exec(url.pathname)
      if (jobRoute) {
        const [, project, id, retry] = jobRoute
        authorize(req, project, Boolean(retry))
        if (!id && req.method === 'GET') return json(200, { ...jobs.list(project), cache: memory.stats() })
        if (id && !retry && req.method === 'GET') {
          const job = jobs.get(id, project)
          if (!job) throw fail(404, 'job_not_found')
          if (['queued','running'].includes(job.state)) res.setHeader('retry-after', '1')
          return json(['queued','running'].includes(job.state) ? 202 : 200, jobView(job))
        }
        if (retry && req.method === 'POST' && !readOnly) {
          const job = jobs.retry(id, project)
          if (!job) throw fail(409, 'job_not_retryable')
          pump(); res.setHeader('retry-after', '1'); return json(202, jobView(job))
        }
        throw fail(405, 'method_not_allowed')
      }
      const match = /^\/static\/v1\/projects\/([a-z0-9-]+)\/(ingest|upload)$/.exec(url.pathname)
      if (!match || req.method !== 'POST') throw fail(404, 'not_found')
      if (stopping) throw fail(503, 'draining')
      if (readOnly) throw fail(405, 'read_only')
      const [, project, operation] = match
      authorize(req, project, true)
      // URL requests enter a durable queue; upload buffering has its own bound.
      if (active >= 128) throw fail(429, 'request_busy')
      active++; admitted = true
      const type = String(req.headers['content-type'] || '').split(';')[0]
      if (operation === 'ingest') {
        if (type !== 'application/json') throw fail(415, 'json_required')
        let input
        try { input = JSON.parse(await bounded(req, 32768)) } catch (error) { if (error.status) throw error; throw fail(400, 'invalid_json') }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'invalid_request')
        const result = await ingest(project, input, req.headers.prefer === 'respond-async' ? 0 : waitMs)
        const pending = ['queued','running'].includes(result.state)
        if (pending) res.setHeader('retry-after', '1')
        return json(pending ? 202 : 200, result)
      }
      if (uploading >= 2) throw fail(429, 'upload_busy')
      uploading++; uploadAdmitted = true
      let body = await bounded(req, maxBytes + 65536), contentType = type
      if (type === 'multipart/form-data') {
        let form
        try { form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData() } catch { throw fail(400, 'invalid_form') }
        const files = form.getAll('file')
        if (files.length !== 1 || typeof files[0]?.arrayBuffer !== 'function') throw fail(400, 'one_file_required')
        contentType = files[0].type; body = Buffer.from(await files[0].arrayBuffer())
      }
      return json(201, presented(await save(project, '', body, contentType), 'uploaded'))
    } catch (error) {
      if (res.headersSent) { res.destroy(); return }
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500)
      json(status, { error: { code: status === 500 ? 'storage_error' : error.code || 'request_failed' } })
    } finally { if(readAdmitted) reading--; if (admitted) active--; if (uploadAdmitted) uploading-- }
  })
  server.requestTimeout = 60_000
  server.headersTimeout = 15_000
  let shutdownPromise
  server.shutdown = () => {
    if (!shutdownPromise) {
      stopping = true; clearInterval(workerTimer)
      for (const entry of running.values()) entry.controller.abort()
      shutdownPromise = Promise.allSettled([...running.values()].map(e => e.promise)).then(() => { jobs.close(); archive.close() })
    }
    return shutdownPromise
  }
  server.on('close', () => { server.shutdown().catch(() => {}) })
  return server
}
