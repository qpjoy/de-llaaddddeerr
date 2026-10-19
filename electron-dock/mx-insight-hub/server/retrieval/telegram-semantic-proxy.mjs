import { AppError } from '../core/errors.mjs'

export const TELEGRAM_SEMANTIC_PATH = '/api/v1/data/telegram/semantic-search'
export const TELEGRAM_SEMANTIC_INTERNAL_PATH = '/internal/v1/services/telegram/semantic-search'

// Only this fixed operation crosses planes. Public never loads model secrets,
// forwards Admin authority, or accepts a caller-selected upstream URL/path.
export function telegramSemanticInternalUrl(env = process.env) {
  return env.MX_INSIGHT_TELEGRAM_SEMANTIC_INTERNAL_URL?.trim()
    || (env.KUBERNETES_SERVICE_HOST ? 'http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151' : null)
}

export function createTelegramSemanticProxy({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 25000 }) {
  if (!baseUrl) return null
  const origin = new URL(baseUrl)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Telegram semantic internal URL must be an HTTP(S) origin')
  }
  let active = 0
  return async ({ apiKey, idempotencyKey, body }) => {
    if (active >= 16) throw new AppError(429, 'retrieval_busy', 'Telegram semantic search is busy; retry with the same request identity')
    active++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(new URL(TELEGRAM_SEMANTIC_INTERNAL_PATH, origin), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(body),
      })
      const chunks = []; let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.byteLength
        if (bytes > 4 * 1024 * 1024) { controller.abort(); throw new Error('response_too_large') }
        chunks.push(Buffer.from(chunk))
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || typeof payload.requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.requestId)
        || (response.status === 200
          ? payload.data?.contractVersion !== 'mx-insight-hub.telegram-semantic.v1'
          : !payload.error)) throw new Error('invalid_response')
      const retryAfter = response.headers.get('retry-after')
      return { status: response.status, body: payload, requestId: payload.requestId,
        retryAfter: /^\d{1,5}$/.test(retryAfter ?? '') && Number(retryAfter) <= 86400 ? retryAfter : null,
        replay: response.headers.get('idempotent-replay') === 'true' }
    } catch {
      // The executor may have committed. Public owns no reservation and must
      // never release/retry it on a transport failure or follow a redirect.
      throw new AppError(502, 'semantic_search_outcome_unknown',
        'Semantic search delivery is unavailable; check the original Idempotency-Key request status before retrying')
    } finally {
      clearTimeout(timer)
      active--
    }
  }
}
