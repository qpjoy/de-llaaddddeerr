import { createHash } from 'node:crypto'
import { normalizeIpRiskResponse } from '../contracts/ip-risk.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'

export class IpSearchAdapter {
  constructor({ apiKey = '', fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    this.apiKey = apiKey.trim()
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }
  get configured() { return !!this.apiKey && this.apiKey.length <= 1024 && !/\s/u.test(this.apiKey) }
  async query(ip, { apiKey = this.apiKey } = {}) {
    const started = Date.now()
    const result = { outcome: 'unknown', errorCode: 'ip_query_outcome_unknown', httpStatus: null, businessCode: null }
    try {
      const response = await this.fetch('https://api.ipdatacloud.com/v2/query', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ip, key: apiKey }).toString(),
      })
      result.httpStatus = response.status
      const chunks = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 1048576) { result.errorCode = 'ip_response_too_large'; return result }
        chunks.push(chunk)
      }
      const bodyBytes = Buffer.concat(chunks)
      let bodyText = null, payload = null, jsonParsed = false
      try { bodyText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bodyBytes) } catch {}
      try { payload = JSON.parse(bodyText); jsonParsed = bodyText != null } catch {}
      const hash = createHash('sha256').update(bodyBytes).digest('hex')
      result.restrictedResponseArchive = {
        bodyBytes, bodySize: size, bodySha256: hash, capturedAt: new Date(),
        bodyText: isPostgresSafeText(bodyText) ? bodyText : null,
        jsonParsed, parsedPayload: isPostgresSafeText(bodyText) && isPostgresSafeJsonValue(payload) ? payload : null,
      }
      result.businessCode = Number.isSafeInteger(Number(payload?.code)) ? Number(payload.code) : null
      result.responseArchive = { httpStatus: response.status, businessCode: result.businessCode, contractState: 'verified', payloadSha256: hash, bodySize: size, capturedAt: new Date(), rawPayload: null }
      if (response.status >= 500 || !jsonParsed || !payload || !Object.hasOwn(payload, 'code')) {
        result.outcome = 'unknown'; result.errorCode = 'ip_query_outcome_unknown'
      } else if (response.status !== 200 || ![200, '200'].includes(payload?.code)) {
        result.outcome = 'rejected'; result.errorCode = 'ip_query_rejected'
      } else {
        result.normalized = normalizeIpRiskResponse(payload, apiKey)
        result.outcome = result.normalized.status === 'unknown' ? 'succeeded_unusable' : 'succeeded'
        result.errorCode = result.outcome === 'succeeded' ? null : 'ip_response_unusable'
      }
      return result
    } catch { return result }
    finally { result.latencyMs = Date.now() - started }
  }
}
