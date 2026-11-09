// Small HTTP helpers shared by collection contracts.

export const MAX_RESULT_BYTES = 4 * 1024 * 1024
// The connection was never established, so nothing reached the upstream.
export const NOT_DELIVERED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

export async function readBounded(response, limit = MAX_RESULT_BYTES) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw Object.assign(new Error('Upstream response exceeds the size limit'), { code: 'response_too_large' })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function parseJson(text) {
  try { return text ? JSON.parse(text) : null } catch { return undefined }
}

export const transportCause = error => String(error?.cause?.code || error?.code || error?.name || 'connection_failed')
export const notDelivered = error => NOT_DELIVERED.has(error?.cause?.code || error?.code)
export const timedOut = error => error?.name === 'TimeoutError' || error?.name === 'AbortError'

export const failed = (code, message, details) => ({ status: 'failed', charge: false,
  error: { code, message, ...(details ? { details } : {}) } })
// quarantine 'slot' keeps the execution slot occupied until an operator
// confirms the upstream run has ended.
export const unknown = (code, message, details, quarantine = 'slot') => ({ status: 'unknown', dataStatus: 'unknown', charge: false,
  quarantine, error: { code, message, ...(details ? { details } : {}) } })
