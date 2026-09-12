import { createHash } from 'node:crypto'
export const STATIC_MEDIA_QUEUE = 'static-media'
const digest = value => createHash('sha256').update(value).digest('hex')
export async function enqueueStaticMedia(queue, payload) {
  if (!payload.consumerId) return // Legacy jobs retain on-demand archiving.
  const urls = [...new Set(payload.records.flatMap(r => r.stableFields?.media?.images || []).filter(v => typeof v === 'string'))]
  for (const url of urls) {
    await queue.enqueue(STATIC_MEDIA_QUEUE, { url, scope: digest(String(payload.consumerId)) }, {
      dedupeKey: `static:${digest(`${payload.consumerId}\0${url}`)}`, priority: 200,
    })
  }
}
export async function archiveStaticMedia(payload, { baseUrl, token, signal, fetchImpl = fetch }) {
  if (typeof payload.url !== 'string' || !/^[a-f0-9]{64}$/.test(payload.scope)) throw new Error('invalid_static_job')
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/static/v1/projects/mx-insight-hub/ingest`, {
    method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'respond-async' },
    body: JSON.stringify({ ...payload, mode: 'cache_first' }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
  })
  // Queue retries only storage/media work, never the paid acquisition.
  await response.body?.cancel()
  if (!response.ok) throw new Error(`static_archive_http_${response.status}`)
}
