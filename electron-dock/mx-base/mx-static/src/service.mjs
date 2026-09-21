import { createServer } from 'node:http'
import { ArchiveCatalog } from './archive-catalog.mjs'
import { assertLocalStorage } from './mounts.mjs'
import { MediaJobs } from './jobs.mjs'
import { MediaCache } from './cache.mjs'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, open, stat, statfs, unlink } from 'node:fs/promises'
import { createReadStream, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createMediaFetcher } from './fetch-media.mjs'
import { TYPES, validateMedia } from './media-types.mjs'
import { planCapacity } from './capacity.mjs'
import { isObjectKey, newObjectKey } from './keys.mjs'
import { resolveConfig, describeSchema, validateOverrides } from './config.mjs'
import { adminPage } from './admin-page.mjs'

export { validateMedia }
const HASH_CHUNK = 4 * 1024 * 1024
const hash = (value) => createHash('sha256').update(value).digest('hex')
const fail = (status, code) => Object.assign(new Error(code), { status, code })
const equal = (a, b) => {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''))
  return left.length === right.length && timingSafeEqual(left, right)
}
// Hashing a 64 MiB upload in one call blocks this process for tens of
// milliseconds; every other request on it waits. Yield between chunks.
async function digest(body) {
  const sum = createHash('sha256')
  for (let offset = 0; offset < body.length; offset += HASH_CHUNK) {
    sum.update(body.subarray(offset, offset + HASH_CHUNK))
    if (offset + HASH_CHUNK < body.length) await new Promise(setImmediate)
  }
  return sum.digest('hex')
}
async function syncDir(path) {
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
async function durableParent(path) {
  const firstCreated = await mkdir(dirname(path), { recursive: true, mode: 0o750 })
  // Persist newly created project/date directory entries as well as the file.
  if (!firstCreated) return
  const parent = dirname(firstCreated)
  for (let current = dirname(path); ; current = dirname(current)) {
    await syncDir(current)
    if (current === parent) break
  }
}
async function atomic(path, body) {
  await durableParent(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o640)
    try { await file.writeFile(body); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    await syncDir(dirname(path))
  } finally { await unlink(temporary).catch(() => {}) }
}
// A staged download was already fsynced where it was written; publishing it is
// just the rename, so a video never passes through this process's memory.
async function adopt(staged, path) {
  await durableParent(path)
  await rename(staged, path)
  await syncDir(dirname(path))
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
// Explicit constructor options win over configuration; configuration wins over
// the value derived from the service level. Everything is re-derivable at
// runtime, so changing a limit does not need a restart.
const prefer = (...candidates) => candidates.find(value => value !== undefined && value !== null && value !== 0)
export function createStaticService({
  root, projects, signingKey, readOnly = false,
  env = process.env, settings = null, adminToken = '',
  minFreeBytes = 512 * 1024 * 1024,
  stateDir = join(root || '/data', '.state'), queueOptions = {}, cacheOptions = {},
  writerUrl = '', workerEnabled = true,
  stagingDir = join(root || '/data', '.staging'),
  loader = null,
  // Optional overrides, mostly for tests and for pinning a value regardless of
  // what the settings store says.
  publicUrl, allowedOrigins, maxBytes, maxConcurrency, waitMs, ioTimeoutMs, touchIntervalMs = 10_000, accelRedirect,
  slo, maxReads, maxAssetStreams, maxVideoStreams, maxLagMs, maxBatch,
  fileMaxAge, restoreDebounceMs,
  metaCacheOptions = { maxBytes: 32 * 1024 * 1024, maxObjectBytes: 65536, maxEntries: 100000, ttlMs: 300000 },
} = {}) {
  if (!root || !signingKey || signingKey.length < 32 || !projects || !Object.keys(projects).length) throw new Error('mx-static requires root, project credentials and a 32+ character signing key')
  for (const [project, credentials] of Object.entries(projects)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(project) || !credentials.read || !credentials.write || Math.min(credentials.read.length, credentials.write.length) < 32) throw new Error('Invalid project credentials')
  }
  assertLocalStorage([root,stateDir],{controlPaths:[stateDir]})
  if (!readOnly) mkdirSync(stagingDir, { recursive: true, mode: 0o750 })
  // Tuning is a live object: every knob below is recomputed by applyConfig().
  let tuning = {}, configWarnings = []
  const objectLimit = () => tuning.maxBytes
  let active = 0
  let uploading = 0
  let reading = 0
  let assetStreams = 0
  let videoStreams = 0
  // Smoothed event-loop delay. Cheap, and it is the one signal that reflects
  // every kind of self-inflicted stall: SQLite commits, hashing, GC.
  let loopLag = 0, lagMark = performance.now()
  const lagTimer = setInterval(() => {
    const now = performance.now()
    loopLag = loopLag * 0.7 + Math.max(0, now - lagMark - 50) * 0.3
    lagMark = now
  }, 50)
  lagTimer.unref()
  const streamClassOf = contentType => /^(video|audio)\//.test(contentType || '') ? 'video' : 'asset'
  const jobs = new MediaJobs(stateDir, { ...queueOptions, readOnly })
  const fetchMedia = loader || createMediaFetcher({ stagingDir, types: TYPES, timeoutMs: 30_000, maxBytes: () => objectLimit() })
  const archive = new ArchiveCatalog(stateDir, {readOnly})
  const memory = new MediaCache(cacheOptions)
  // Objects over maxObjectBytes never enter the body cache, so without this a
  // video re-read its manifest on every Range request a seeking player sends.
  const metaCache = new MediaCache(metaCacheOptions)
  const restoreRequests = new Map()
  // Eviction can only target genuinely cold objects if something records when
  // each one was last read. Doing that inline would put a control-plane write
  // on every served file, so reads only stamp an in-memory map and a timer
  // folds it into one transaction (or one request, from a read-only replica).
  const recentReads = new Map()
  async function flushReads() {
    if (!recentReads.size) return
    const batch = [...recentReads.entries()]
    recentReads.clear()
    if (!readOnly) { archive.touchMany(batch); return }
    if (!writerUrl) return
    const byProject = new Map()
    for (const [key] of batch) {
      const project = key.split('/')[0]
      if (!projects[project]) continue
      if (!byProject.has(project)) byProject.set(project, [])
      byProject.get(project).push(key)
    }
    for (const [project, keys] of byProject) {
      try {
        const response = await fetch(`${writerUrl}/static/v1/projects/${project}/storage/touch`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
          headers: { authorization: `Bearer ${projects[project].write}`, 'content-type': 'application/json' },
          body: JSON.stringify({ keys: keys.slice(0, 2000) }),
        })
        await response.body?.cancel()
      } catch { /* access times are advisory; the next batch carries on */ }
    }
  }
  const readsTimer = setInterval(() => { flushReads().catch(() => {}) }, touchIntervalMs)
  readsTimer.unref()
  // Waiting on a job used to mean a synchronous SQLite read every 50 ms per
  // waiter, on the event loop. The writer owns the job lifecycle, so it can
  // just say when one finishes; the timeout stays as a safety net for work
  // completed by a recovered lease rather than by us.
  const waiters = new Map()
  function notify(id) {
    const listeners = waiters.get(id)
    if (!listeners) return
    waiters.delete(id)
    for (const wake of listeners) wake()
  }
  function settled(id, ms) {
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { waiters.get(id)?.delete(wake); resolve() }, ms)
      if (!waiters.has(id)) waiters.set(id, new Set())
      waiters.get(id).add(wake)
    })
  }
  const reads = new Map()
  const running = new Map()
  const inFlight = { image: 0, video: 0 }
  let stopping = false
  let pumping = false
  let allowed = new Set(allowedOrigins || [])
  let publicBase = publicUrl || ''
  function applyConfig() {
    const resolved = resolveConfig(env, settings ? settings.read() : {})
    const values = resolved.values
    configWarnings = resolved.warnings
    let plan
    try {
      plan = planCapacity(slo || {
        assetQps: values.assetQps, assetP95Ms: values.assetP95Ms, assetSizeKb: values.assetSizeKb,
        videoViewers: values.videoViewers, videoBitrateKbps: values.videoBitrateKbps, burst: values.burst,
        linkMbps: values.linkMbps, diskReadMbps: values.diskReadMbps, utilisation: values.utilisation / 100,
      })
    } catch (error) {
      // A service level that cannot be planned must not take the service down.
      plan = planCapacity()
      configWarnings = [...configWarnings, `capacity: ${error.message}; using defaults`]
    }
    tuning = {
      capacity: plan,
      maxReads: prefer(maxReads, values.maxReads, plan.limits.maxReads),
      maxAssetStreams: prefer(maxAssetStreams, values.maxAssetStreams, plan.limits.maxAssetStreams),
      maxVideoStreams: prefer(maxVideoStreams, values.maxVideoStreams, plan.limits.maxVideoStreams),
      maxLagMs: prefer(maxLagMs, values.maxLagMs),
      maxBatch: prefer(maxBatch, values.maxBatch),
      fileMaxAge: fileMaxAge ?? values.fileMaxAge,
      restoreDebounceMs: restoreDebounceMs ?? values.restoreDebounceMs,
      waitMs: waitMs ?? values.waitMs,
      ioTimeoutMs: prefer(ioTimeoutMs, values.ioTimeoutMs),
      maxBytes: prefer(maxBytes, values.maxBytes),
      // A prefix means an internal nginx location serves the bytes; this
      // process then only authorises the request and never touches the file.
      accelRedirect: accelRedirect ?? (String(values.accelRedirect || '').trim()),
      // Separate pools: a queue full of videos must never starve image work.
      workers: maxConcurrency
        ? { image: maxConcurrency, video: maxConcurrency }
        : { image: values.imageWorkers, video: values.videoWorkers },
      values,
    }
    memory.configure({ maxBytes: values.cacheBytes, ttlMs: values.cacheTtlMs, maxObjectBytes: values.cacheObjectBytes, ...cacheOptions })
    metaCache.configure({ maxEntries: values.manifestEntries })
    jobs.setCapacity(queueOptions.maxQueued ?? values.maxQueued)
    allowed = new Set(allowedOrigins || String(values.corsOrigins || '').split(',').map(o => o.trim()).filter(Boolean))
    publicBase = publicUrl ?? values.publicUrl ?? ''
    return tuning
  }
  applyConfig()
  // Another container may change a setting; notice it without a restart.
  let settingsRevision = settings ? JSON.stringify(settings.revision()) : null
  const settingsTimer = settings && setInterval(() => {
    try {
      const current = JSON.stringify(settings.revision())
      if (current === settingsRevision) return
      settingsRevision = current
      applyConfig()
      if (!readOnly) pump()
    } catch { /* a locked control DB is retried on the next tick */ }
  }, 3000)
  settingsTimer?.unref()
  const VIDEO_SOURCE = /\.(mp4|m4v|mov|webm|mkv|m3u8|mpd|ts|avi|flv|ogv|mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i
  // Audio rides with video: both are long transfers, unlike an image.
  const kindOf = (url, declared) => (declared === 'video' || declared === 'image' ? declared
    : VIDEO_SOURCE.test(String(url).split(/[?#]/)[0]) ? 'video' : 'image')
  const latency = { asset: [], video: [], ingest: [] }
  function observe(bucket, startedAt) {
    const samples = latency[bucket]
    samples.push(Date.now() - startedAt)
    if (samples.length > 1024) samples.shift()
  }
  function percentiles(samples) {
    if (!samples.length) return { count: 0 }
    const sorted = [...samples].sort((a, b) => a - b)
    const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
    return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] }
  }
  const capacitySnapshot = () => ({
    latencyMs: { asset: percentiles(latency.asset), video: percentiles(latency.video), ingest: percentiles(latency.ingest) },
    eventLoopLagMs: Number(loopLag.toFixed(1)),
    reads: { inUse: reading, limit: tuning.maxReads },
    assetStreams: { inUse: assetStreams, limit: tuning.maxAssetStreams },
    videoStreams: { inUse: videoStreams, limit: tuning.maxVideoStreams, sheddingAboveLagMs: tuning.maxLagMs },
    writes: { inUse: active, limit: 128, uploads: uploading },
    downloads: { image: { inUse: inFlight.image, limit: tuning.workers.image }, video: { inUse: inFlight.video, limit: tuning.workers.video } },
    cache: memory.stats(), manifests: metaCache.stats(), readOnly,
  })
  function jobView(job) {
    return { id: job.id, state: job.state, kind: job.kind, attempts: job.attempts, error: job.error,
      statusUrl: `/static/v1/projects/${job.project}/jobs/${job.id}`,
      ...(job.result ? presented(job.result, 'stored_cache') : {}) }
  }
  async function processJob(job, controller) {
    let staged = null
    try {
      const result = await fetchMedia(job.url, { cacheScope: `${job.project}/${job.source_hash}`, signal: controller.signal })
      staged = result.path || null
      if (controller.signal.aborted) throw fail(503, 'worker_stopped')
      // A retry writes a new immutable object. A stale lease can never replace
      // a completed object or advance the source index.
      const published = staged
        ? await saveStaged(job.project, job.scope, result)
        : await save(job.project, job.scope, result.body, result.contentType)
      // Only an adopted staging file stops being ours; a deduplicated download
      // still has its temporary copy to clean up.
      if (!published.deduped) staged = null
      jobs.complete(job, published.meta)
      notify(job.id)
    } catch (error) {
      jobs.fail(job, error.code || 'source_unavailable', {
        aborted: stopping,
        status: error.status || 502,
        retryable: ![400, 401, 403, 413, 415, 422].includes(error.status),
      })
      notify(job.id)
    } finally {
      if (staged) await unlink(staged).catch(() => {})
    }
  }
  function pump() {
    if (stopping || readOnly || !workerEnabled || pumping) return
    pumping = true
    try {
      for (const kind of ['image', 'video']) {
        while (inFlight[kind] < tuning.workers[kind]) {
          const job = jobs.claim(kind)
          if (!job) break
          const controller = new AbortController()
          inFlight[kind]++
          const promise = processJob(job, controller).catch(() => {
            // A failed control-disk write leaves the lease durable for recovery.
          }).finally(() => { inFlight[kind]--; running.delete(job.id); if (!stopping) pump() })
          running.set(job.id, { job, controller, promise })
        }
      }
    } finally { pumping = false }
  }
  const workerTimer = setInterval(() => {
    memory.prune(); metaCache.prune()
    if (!readOnly && !stopping) {
      try { for (const entry of running.values()) jobs.renew(entry.job); pump() } catch { /* keep durable leases; retry on next tick */ }
    }
  }, 500)
  workerTimer.unref()
  if (!readOnly && workerEnabled) queueMicrotask(() => { sweepStaging().catch(() => {}); pump() })
  const sign = (key, expires) => createHmac('sha256', signingKey).update(`${key}\n${expires}`).digest('hex')
  function authorize(req, project, write = false) {
    const credential = projects[project]
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    if (!credential || !(equal(token, credential.write) || (!write && equal(token, credential.read)))) throw fail(401, 'unauthorized')
  }
  function presented(meta, sourceMode) {
    const expires = String(Math.floor(Date.now() / 1000) + 900)
    return { ...meta, sourceMode, previewUrl: `${publicBase}/static/files/${meta.key}?expires=${expires}&signature=${sign(meta.key, expires)}` }
  }
  async function publish(project, scope, { contentType, size, sha256 }, place) {
    if (size > tuning.maxBytes) throw fail(413, 'file_too_large')
    await mkdir(root, { recursive: true, mode: 0o750 })
    // The free-space floor holds for every write. Linking existing content
    // consumes no data blocks, so only a genuinely new object is also measured
    // against its own size.
    const disk = await statfs(root)
    const free = disk.bavail * disk.bsize
    if (free < minFreeBytes) throw fail(507, 'storage_full')
    const key = newObjectKey(project)
    const target = join(root, 'objects', key)
    // Identical bytes we already hold become another link to the same inode,
    // not a second copy. The filesystem then does the physical reference
    // counting: the bytes go when the last key pointing at them is unlinked.
    let deduped = false
    const twin = archive.localTwin(sha256)
    if (twin) {
      try {
        await durableParent(target)
        await link(join(root, 'objects', twin), target)
        await syncDir(dirname(target))
        deduped = true
      } catch (error) {
        // A twin that was evicted, purged, or lives on another device is just
        // a miss; fall through and store the bytes.
        if (!['ENOENT', 'EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP'].includes(error.code)) throw error
      }
    }
    if (!deduped) {
      if (free < minFreeBytes + size) throw fail(507, 'storage_full')
      // Publish the manifest only after the complete immutable object is durable.
      await place(target)
    }
    const meta = { key, project, scope, sha256, contentType, size, capturedAt: new Date().toISOString() }
    await atomic(join(root, 'metadata', `${key}.json`), JSON.stringify(meta))
    archive.register(meta)
    return { meta, deduped }
  }
  // Uploads and injected loaders still hand over a whole buffer.
  async function save(project, scope, body, contentType) {
    validateMedia(body, contentType)
    const published = await publish(project, scope, { contentType, size: body.length, sha256: await digest(body) },
      target => atomic(target, body))
    memory.set(published.meta.key, body, published.meta)
    return published
  }
  // A streamed download is already on the object filesystem and already hashed.
  async function saveStaged(project, scope, staged) {
    const published = await publish(project, scope, staged, target => adopt(staged.path, target))
    if (published.meta.size <= memory.maxObjectBytes) {
      // Reading back a just-written small file is a page-cache hit and keeps
      // the ingest-then-display path from paying a cold read.
      await readFile(join(root, 'objects', published.meta.key)).then(body => memory.set(published.meta.key, body, published.meta), () => {})
    }
    return published
  }
  // Pre-publication downloads that a crash left behind reference nothing.
  async function sweepStaging() {
    const entries = await readdir(stagingDir).catch(() => [])
    for (const entry of entries.slice(0, 10000)) {
      if (entry.endsWith('.part')) await unlink(join(stagingDir, entry)).catch(() => {})
    }
  }
  async function restore(meta) {
    const stored=archive.get(meta.key)
    if (!stored?.mirrored) throw fail(503, 'stored_media_unavailable')
    if (!readOnly) archive.request(meta.key, 'restore')
    else if (writerUrl) {
      // A cold key requested by many viewers is one restore, not one per read:
      // each POST is a durable write on the writer, and the archive worker
      // drains far slower than readers can ask.
      const asked = restoreRequests.get(meta.key)
      if (asked && Date.now() - asked < tuning.restoreDebounceMs) return
      if (restoreRequests.size >= 10000) restoreRequests.clear()
      restoreRequests.set(meta.key, Date.now())
      try {
        const response=await fetch(`${writerUrl}/static/v1/projects/${meta.project}/storage/restore`, {method:'POST', redirect:'error', signal:AbortSignal.timeout(1000), headers:{authorization:`Bearer ${projects[meta.project].write}`, 'content-type':'application/json'},body:JSON.stringify({key:meta.key})})
        await response.body?.cancel()
      } catch { /* Local writer outage is retryable, never an NFS call. */ }
    }
  }
  // Everything up to the decision to enqueue. Reads only, so a batch can run
  // this per item and still commit the whole page in one transaction.
  async function resolveSource(project, input) {
    const { url, scope = '', mode = 'cache_first', kind } = input || {}
    if (typeof url !== 'string' || !url || url.length > 16384 || typeof scope !== 'string' || scope.length > 256 || !['cache_first', 'cache_only', 'refresh'].includes(mode)) throw fail(400, 'invalid_request')
    if (kind !== undefined && !['image', 'video'].includes(kind)) throw fail(400, 'invalid_request')
    const sourceHash = hash(`${scope}\0${url}`)
    const known = jobs.ready(project, sourceHash)
    const cached = known?.result || await jsonFile(join(root, 'sources', project, `${sourceHash}.json`))
    const usable = cached && await stat(join(root, 'objects', cached.key)).then(s => s.size === cached.size, () => false)
    if (usable && mode !== 'refresh') return { settled: presented(cached, 'stored_cache') }
    if (cached && !usable && mode !== 'refresh') {
      await restore(cached)
      return { settled: { state: 'queued', statusUrl: `/static/v1/projects/${project}/storage`, reason: 'media_restore_pending' } }
    }
    const job = jobs.pending(project, sourceHash)
    if (!job && mode === 'cache_only') throw fail(404, 'stored_media_not_found')
    if (!job && mode !== 'refresh') {
      const last = jobs.latest(project, sourceHash)
      if (last?.state === 'failed') throw fail(last.error_status || 502, last.error || 'source_unavailable')
    }
    return { job, cached: usable ? cached : null, work: { scope, sourceHash, url, kind: kindOf(url, kind) } }
  }
  // One upstream page of media URLs: one durable transaction, one round trip.
  // Always asynchronous -- the point of a batch is not to hold request slots.
  async function ingestBatch(project, input) {
    const { items, scope = '', mode = 'cache_first' } = input || {}
    if (!Array.isArray(items) || !items.length || items.length > tuning.maxBatch) throw fail(400, 'invalid_request')
    const resolved = await Promise.all(items.map(item => resolveSource(project, { scope, mode, ...(typeof item === 'string' ? { url: item } : item) })
      .then(value => ({ value }), error => ({ error }))))
    const fresh = resolved.filter(entry => entry.value && !entry.value.settled && !entry.value.job).map(entry => entry.value.work)
    const enqueued = fresh.length ? jobs.enqueueMany(project, fresh) : []
    let cursor = 0
    const results = resolved.map(entry => {
      if (entry.error) return { error: { code: entry.error.code || 'request_failed' }, status: entry.error.status || 500 }
      if (entry.value.settled) return entry.value.settled
      const row = entry.value.job || enqueued[cursor++]
      return row.error ? { error: { code: row.error }, status: row.status } : jobView(row)
    })
    pump()
    return { results }
  }
  async function ingest(project, input, requestedWait = tuning.waitMs) {
    const resolved = await resolveSource(project, input)
    if (resolved.settled) return resolved.settled
    const { cached, work } = resolved
    const usable = Boolean(cached)
    let job = resolved.job || jobs.enqueue(project, work.scope, work.sourceHash, work.url, work.kind)
    pump()
    const deadline = Date.now() + requestedWait
    while (Date.now() < deadline && ['queued', 'running'].includes(job.state)) {
      await settled(job.id, Math.min(250, deadline - Date.now()))
      job = jobs.get(job.id, project)
    }
    if (job.state === 'ready') return { ...presented(job.result, 'live'), id: job.id, state: 'ready' }
    if (usable) return { ...presented(cached, job.state === 'failed' ? 'stored_fallback' : 'refreshing_cache'), job: jobView(job) }
    if (job.state === 'failed') throw fail(job.error_status || 502, job.error || 'source_unavailable')
    return jobView(job) // 202 + status URL, never a premature object URL/404.
  }
  async function readMeta(key) {
    if (metaCache.get(key)) return metaCache.metadata(key)
    const meta = await jsonFile(join(root, 'metadata', `${key}.json`))
    // Manifests are written once and never rewritten, so caching one cannot go
    // stale; object presence is still checked per request.
    if (meta) metaCache.set(key, Buffer.from(JSON.stringify(meta)), meta)
    return meta
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
    const deadline=setTimeout(()=>{if(!res.headersSent)json(503,{error:{code:'storage_io_timeout'}})},tuning.ioTimeoutMs)
    deadline.unref()
    res.once('finish',()=>clearTimeout(deadline));res.once('close',()=>clearTimeout(deadline))
    const startedAt = Date.now()
    let observed = null
    let readAdmitted = false
    let streamAdmitted = null
    let admitted = false
    let uploadAdmitted = false
    try {
      const url = new URL(req.url, 'http://mx-static')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('content-security-policy', "sandbox; default-src 'none'; frame-ancestors 'self'")
      if (allowed.has(req.headers.origin)) {
        res.setHeader('access-control-allow-origin', req.headers.origin)
        res.setHeader('vary', 'Origin')
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Range, Prefer')
        res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS')
        res.setHeader('access-control-expose-headers', 'Content-Range, ETag, Accept-Ranges')
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
      if (url.pathname === '/static/health' && req.method === 'GET') return json(stopping ? 503 : 200, { status: stopping ? 'draining' : 'ok', readOnly })

      // The console and its API exist only when an admin token is configured,
      // so a deployment that never sets one has no settings surface at all.
      if (url.pathname === '/static/admin' || url.pathname.startsWith('/static/v1/admin/')) {
        if (!adminToken || adminToken.length < 32) throw fail(404, 'not_found')
        if (url.pathname === '/static/admin') {
          if (req.method !== 'GET') throw fail(405, 'method_not_allowed')
          // The page asks for the token itself; it holds no secret of its own.
          const nonce = randomUUID().replaceAll('-', '')
          res.setHeader('content-security-policy', `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(adminPage(nonce))
        }
        if (!equal(String(req.headers.authorization || '').replace(/^Bearer /, ''), adminToken)) throw fail(401, 'unauthorized')
        if (url.pathname !== '/static/v1/admin/settings') throw fail(404, 'not_found')
        if (req.method === 'GET') {
          return json(200, {
            schema: describeSchema(), values: tuning.values, overrides: settings ? settings.read() : {},
            warnings: [...tuning.capacity.warnings, ...configWarnings],
            budget: tuning.capacity.budget, limits: tuning.capacity.limits, readOnly: readOnly || !settings,
            live: capacitySnapshot(),
          })
        }
        if (req.method !== 'PUT') throw fail(405, 'method_not_allowed')
        if (readOnly || !settings) throw fail(409, 'settings_read_only')
        let input
        try { input = JSON.parse(await bounded(req, 65536)) } catch (error) { if (error.status) throw error; throw fail(400, 'invalid_json') }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'invalid_request')
        const { accepted, rejected } = validateOverrides(input)
        if (Object.keys(accepted).length) { settings.write(accepted); settingsRevision = JSON.stringify(settings.revision()) }
        applyConfig()
        pump()
        return json(200, { applied: accepted, rejected, values: tuning.values })
      }
      if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/static/files/')) {
        const key = url.pathname.slice('/static/files/'.length)
        if (!isObjectKey(key)) throw fail(404, 'not_found')
        const expires = url.searchParams.get('expires') || ''
        const signed = /^\d+$/.test(expires) && Number(expires) >= Date.now() / 1000 && Number(expires) <= Date.now() / 1000 + 901 && equal(url.searchParams.get('signature'), sign(key, expires))
        if (!signed) authorize(req, key.split('/')[0])
        const memoryBody=memory.get(key)
        // The read permit bounds disk concurrency. A request answered entirely
        // from memory touches no disk, so making it hold a disk permit would
        // let a burst of cache hits shed each other for no reason.
        let meta = memoryBody ? memory.metadata(key) : (metaCache.get(key) ? metaCache.metadata(key) : null)
        if (!memoryBody || !meta) {
          if(reading>=tuning.maxReads) throw fail(503,'storage_read_busy')
          reading++;readAdmitted=true
          meta = meta || await readMeta(key)
        }
        if (!meta) throw fail(404, 'not_found')
        const file = join(root, 'objects', key)
        const info = memoryBody ? {size:meta.size} : await stat(file).catch(error => { if(error.code==='ENOENT') return null;throw error })
        if(!info) { await restore(meta);res.setHeader('retry-after','2');throw fail(503,'media_restore_pending') }
        if (info.size !== meta.size) throw fail(503, 'stored_media_corrupt')
        recentReads.set(key, Date.now())
        if (recentReads.size >= 5000) flushReads().catch(() => {})
        observed = streamClassOf(meta.contentType)
        const etag = `"${meta.sha256}"`
        res.setHeader('etag', etag)
        // Objects are content addressed and never rewritten. A signed link may
        // not be cached past its own expiry, so the window is the shorter of
        // the two -- revocation by key rotation is unaffected beyond that.
        const maxAge = signed ? Math.max(0, Math.min(tuning.fileMaxAge, Number(expires) - Math.floor(Date.now() / 1000))) : tuning.fileMaxAge
        res.setHeader('cache-control', maxAge > 0 ? `private, max-age=${maxAge}, immutable` : 'private, max-age=0, must-revalidate')
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
        // Hand the transfer to nginx: it can sendfile() the object, serve the
        // range itself, and this process stops being in the byte path at all.
        // A memory hit is still answered here -- it is already faster than a
        // second hop, and it avoids re-reading a file we are holding.
        if (tuning.accelRedirect && req.method === 'GET' && !memoryBody) {
          res.setHeader('x-accel-redirect', tuning.accelRedirect.replace(/\/?$/, '/') + key)
          res.setHeader('x-mx-static-cache', 'accel')
          res.writeHead(200, { 'content-type': meta.contentType, 'accept-ranges': 'bytes',
            'content-disposition': meta.contentType === 'application/pdf' ? 'attachment' : 'inline' })
          return res.end()
        }
        const cachedRead = req.method === 'HEAD' ? null : memoryBody ? {body:memoryBody,source:'memory'} : await readCached(file, key, meta.size, meta)
        // Claim the stream slot before the headers go out: after writeHead the
        // only way to report 503 is to destroy the connection.
        if (req.method !== 'HEAD' && !cachedRead) {
          const streamClass = streamClassOf(meta.contentType)
          if (streamClass === 'video') {
            // Video degrades first, on purpose: images and static assets are
            // the class with the stated floor.
            if (loopLag > tuning.maxLagMs) { res.setHeader('retry-after', '1'); throw fail(503, 'storage_overloaded') }
            if (videoStreams >= tuning.maxVideoStreams) throw fail(503, 'storage_stream_busy')
            videoStreams++
          } else {
            if (assetStreams >= tuning.maxAssetStreams) throw fail(503, 'storage_stream_busy')
            assetStreams++
          }
          streamAdmitted = streamClass
        }
        res.setHeader('x-mx-static-cache', cachedRead?.source || 'stream')
        res.writeHead(status, { 'content-type': meta.contentType, 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'content-disposition': meta.contentType === 'application/pdf' ? 'attachment' : 'inline' })
        if (req.method === 'HEAD') return res.end()
        if (cachedRead) { res.end(cachedRead.body.subarray(start, end + 1)); return }
        // Release the short-read slot. What remains is a transfer paced by the
        // client, and a watched video must not hold a disk-read permit for its
        // whole duration while image requests are turned away.
        reading--; readAdmitted = false
        await pipeline(createReadStream(file, { start, end }), res)
        return
      }
      const objectRoute = /^\/static\/v1\/projects\/([a-z0-9-]+)\/objects\/(.+)$/.exec(url.pathname)
      if (objectRoute) {
        const [, project, key] = objectRoute
        authorize(req, project, true)
        if (req.method !== 'DELETE') throw fail(405, 'method_not_allowed')
        if (readOnly || stopping) throw fail(405, 'read_only')
        if (!isObjectKey(key) || key.split('/')[0] !== project) throw fail(404, 'not_found')
        const dropped = archive.dropReference(key)
        if (!dropped) throw fail(404, 'not_found')
        if (dropped.busy) throw fail(409, 'archive_busy')
        // Unlink this key's own paths. Bytes shared with another key survive,
        // because that key is a separate link to the same inode.
        const absent = error => { if (error.code !== 'ENOENT') throw error }
        await unlink(join(root, 'objects', key)).catch(absent)
        await unlink(join(root, 'metadata', `${key}.json`)).catch(absent)
        memory.delete(key); metaCache.delete(key); recentReads.delete(key)
        return json(200, { key, references: dropped.remaining, contentRemoved: dropped.remaining === 0,
          archivedCopyQueuedForRemoval: dropped.mirrored })
      }
      const capacityRoute = /^\/static\/v1\/projects\/([a-z0-9-]+)\/capacity$/.exec(url.pathname)
      if (capacityRoute) {
        authorize(req, capacityRoute[1])
        if (req.method !== 'GET') throw fail(405, 'method_not_allowed')
        return json(200, {
          ...tuning.capacity,
          limits: { maxReads: tuning.maxReads, maxAssetStreams: tuning.maxAssetStreams, maxVideoStreams: tuning.maxVideoStreams },
          warnings: [...tuning.capacity.warnings, ...configWarnings],
          live: capacitySnapshot(),
        })
      }
      const storageRoute=/^\/static\/v1\/projects\/([a-z0-9-]+)\/storage(?:\/(restore|evict|sync|touch))?$/.exec(url.pathname)
      if(storageRoute) {
        const [,project,action]=storageRoute
        authorize(req,project,Boolean(action))
        if(!action && req.method==='GET') {
          const before = Date.now() - Number(url.searchParams.get('coldFor') || 86400000)
          return json(200, { ...archive.status(project), coldest: archive.coldest(project, { before, limit: 20 }) })
        }
        // Read-only replicas report what they served so access times stay real.
        if(action==='touch') {
          if(req.method!=='POST'||readOnly) throw fail(405,'method_not_allowed')
          let input
          try { input=JSON.parse(await bounded(req,262144)) } catch(error) {if(error.status)throw error;throw fail(400,'invalid_json')}
          if(!Array.isArray(input?.keys)) throw fail(400,'invalid_request')
          const now=Date.now()
          const entries=input.keys.filter(key=>isObjectKey(key)&&key.split('/')[0]===project).slice(0,2000).map(key=>[key,now])
          return json(200,{touched:archive.touchMany(entries)})
        }
        if(!action || req.method!=='POST' || readOnly || stopping) throw fail(405,'method_not_allowed')
        let input
        try { input=JSON.parse(await bounded(req,4096)) } catch(error) {if(error.status)throw error;throw fail(400,'invalid_json')}
        if(typeof input?.key!=='string' || !input.key.startsWith(project+'/')) throw fail(400,'invalid_archive_key')
        const refused=archive.request(input.key,action)
        if(refused) throw fail(409,refused)
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
      const match = /^\/static\/v1\/projects\/([a-z0-9-]+)\/(ingest\/batch|ingest|upload)$/.exec(url.pathname)
      if (!match || req.method !== 'POST') throw fail(404, 'not_found')
      if (stopping) throw fail(503, 'draining')
      if (readOnly) throw fail(405, 'read_only')
      const [, project, operation] = match
      authorize(req, project, true)
      // URL requests enter a durable queue; upload buffering has its own bound.
      if (active >= 128) throw fail(429, 'request_busy')
      active++; admitted = true
      const type = String(req.headers['content-type'] || '').split(';')[0]
      if (operation === 'ingest/batch' || operation === 'ingest') {
        if (type !== 'application/json') throw fail(415, 'json_required')
        const limit = operation === 'ingest' ? 32768 : 1024 * 1024
        let input
        try { input = JSON.parse(await bounded(req, limit)) } catch (error) { if (error.status) throw error; throw fail(400, 'invalid_json') }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'invalid_request')
        observed = 'ingest'
        if (operation === 'ingest/batch') return json(200, await ingestBatch(project, input))
        const result = await ingest(project, input, req.headers.prefer === 'respond-async' ? 0 : tuning.waitMs)
        const pending = ['queued','running'].includes(result.state)
        if (pending) res.setHeader('retry-after', '1')
        return json(pending ? 202 : 200, result)
      }
      if (uploading >= 2) throw fail(429, 'upload_busy')
      uploading++; uploadAdmitted = true
      let body = await bounded(req, tuning.maxBytes + 65536), contentType = type
      if (type === 'multipart/form-data') {
        let form
        try { form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData() } catch { throw fail(400, 'invalid_form') }
        const files = form.getAll('file')
        if (files.length !== 1 || typeof files[0]?.arrayBuffer !== 'function') throw fail(400, 'one_file_required')
        contentType = files[0].type; body = Buffer.from(await files[0].arrayBuffer())
      }
      return json(201, presented((await save(project, '', body, contentType)).meta, 'uploaded'))
    } catch (error) {
      if (res.headersSent) { res.destroy(); return }
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500)
      json(status, { error: { code: status === 500 ? 'storage_error' : error.code || 'request_failed' } })
    } finally {
      if (observed) observe(observed === 'video' ? 'video' : observed === 'ingest' ? 'ingest' : 'asset', startedAt)
      if(readAdmitted) reading--
      if(streamAdmitted === 'video') videoStreams--; else if (streamAdmitted === 'asset') assetStreams--
      if (admitted) active--; if (uploadAdmitted) uploading--
    }
  })
  server.requestTimeout = 60_000
  server.headersTimeout = 15_000
  let shutdownPromise
  server.shutdown = () => {
    if (!shutdownPromise) {
      stopping = true; clearInterval(workerTimer); clearInterval(lagTimer); clearInterval(readsTimer); if (settingsTimer) clearInterval(settingsTimer)
      for (const id of [...waiters.keys()]) notify(id)
      for (const entry of running.values()) entry.controller.abort()
      shutdownPromise = Promise.allSettled([...running.values()].map(e => e.promise))
        .then(() => flushReads().catch(() => {}))
        .then(() => { jobs.close(); archive.close() })
    }
    return shutdownPromise
  }
  server.on('close', () => { server.shutdown().catch(() => {}) })
  return server
}
