import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { validateExternalImage } from './media.mjs'

// Optional data-plane extension. Authorization still runs in HubService before
// this loader; storage credentials never enter public responses or browser state.
export function withStaticArchive(fallback, { baseUrl = '', token = '', project = 'mx-insight-hub', fetchImpl = fetch, onError = () => {}, cacheBytes = 64 * 1024 * 1024, cacheTtlMs = 60000 } = {}) {
  if (!baseUrl || !token) return fallback
  if (![cacheBytes, cacheTtlMs].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid static cache limits')
  const cache = new Map()
  let usedBytes = 0
  const evict = key => { const entry = cache.get(key); if (entry) usedBytes -= entry.value.body.length; cache.delete(key) }
  const prune = () => {
    for (const [key, entry] of cache) if (entry.expires <= Date.now()) evict(key)
    while (usedBytes > cacheBytes || cache.size > 2048) evict(cache.keys().next().value)
  }
  const timer = setInterval(prune, 10000); timer.unref()
  const remember = (key, value) => {
    if (value.body.length <= cacheBytes && cacheTtlMs > 0) {
      evict(key); cache.set(key, { value, expires: Date.now() + cacheTtlMs }); usedBytes += value.body.length; prune()
    }
    return value
  }
  return async (sourceUrl, options = {}) => {
    if (options.signal?.aborted) throw options.signal.reason
    const key = createHash('sha256').update(`${options.cacheScope || ''}\0${sourceUrl}`).digest('hex')
    prune()
    if (cache.has(key)) {
      const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit.value
    }
    try {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000)
      const headers = { authorization: `Bearer ${token}` }
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/static/v1/projects/${encodeURIComponent(project)}/ingest`, {
        method: 'POST', redirect: 'error', signal,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ url: sourceUrl, scope: createHash('sha256').update(String(options.cacheScope || '')).digest('hex'), mode: 'cache_first' }),
      })
      if (response.status === 202 || response.status === 429) throw new AppError(503, 'external_media_pending', 'Media is queued for durable storage; retry shortly')
      if (!response.ok) throw new Error('static_ingest_failed')
      const meta = await response.json()
      if (typeof meta.key !== 'string' || !meta.key.startsWith(`${project}/`) || !/^[a-z0-9/-]+$/.test(meta.key)) throw new Error('static_metadata_invalid')
      const media = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/static/files/${meta.key}`, { headers, signal, redirect: 'error' })
      if (!media.ok || Number(media.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('static_read_failed')
      const chunks = []; let bytes = 0
      for await (const chunk of media.body) {
        bytes += chunk.length
        if (bytes > 4 * 1024 * 1024) throw new Error('static_media_too_large')
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      const contentType = media.headers.get('content-type').split(';')[0]
      validateExternalImage(body, contentType)
      if (createHash('sha256').update(body).digest('hex') !== meta.sha256) throw new Error('static_checksum_mismatch')
      return remember(key, { body, contentType })
    } catch (error) {
      if (options.signal?.aborted || error.code === 'external_media_pending') throw error
      onError('mx_static_unavailable')
      return remember(key, await fallback(sourceUrl, options))
    }
  }
}
