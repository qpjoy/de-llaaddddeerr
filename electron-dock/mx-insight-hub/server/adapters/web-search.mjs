import { createHash } from 'node:crypto'
import { buildSearchHttp, normalizeSearchResponse } from '../web-search/contract.mjs'
import { createCredentialEchoRedactor } from '../core/credential-redaction.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'
import { HUB_USER_AGENT } from '../core/outbound-identity.mjs'
import { AppError } from '../core/errors.mjs'

const MAX_BYTES = 4 * 1024 * 1024
export class WebSearchUpstreamError extends Error {
  constructor(evidence, persistence = {}) {
    super('Web search request failed')
    this.name = 'WebSearchUpstreamError'
    this.evidence = evidence
    for (const key of ['responseArchive', 'upstreamEvidence', 'restrictedResponseArchive']) {
      Object.defineProperty(this, key, { value: persistence[key] ?? null, enumerable: false })
    }
    this.archiveObjects = []
  }
}

async function readBody(response, controller) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { controller.abort(); throw new Error('response_too_large') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('response_body_unavailable')
  const chunks = []; let size = 0
  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) { controller.abort(); throw new Error('response_too_large') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}

export class WebSearchAdapter {
  constructor({ apiKey = '', credentialResolver = null, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    this.apiKey = apiKey
    this.credentialResolver = credentialResolver
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }
  async resolveCredential() {
    return this.credentialResolver ? await this.credentialResolver() : this.apiKey || null
  }
  async execute(normalized, { credential } = {}) {
    const { request, provider } = normalized
    const bundle = credential === undefined ? await this.resolveCredential() : credential
    const key = typeof bundle === 'string' ? bundle : bundle?.apiKey
    if (typeof key !== 'string' || !key) throw new Error('External credential is unavailable')
    const { url, options } = buildSearchHttp(provider, request, key)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response, bytes, raw, bodyText, parsed = false
    const capturedAt = new Date().toISOString()
    const scrub = createCredentialEchoRedactor(key)
    const safe = value => {
      if (typeof value === 'string') return scrub(value)
      if (Array.isArray(value)) return value.map(safe)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [scrub(k), safe(v)]))
      return value
    }
    const persistence = state => ({
      upstreamEvidence: { requestId: scrub(response?.headers.get('x-request-id') || '') || null },
      responseArchive: response ? { contractState: state, httpStatus: response.status, businessCode: null,
        contentType: response.headers.get('content-type'), bodySize: bytes?.length ?? null,
        payloadSha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
        rawPayload: { response: { httpStatus: response.status, requestId: scrub(response.headers.get('x-request-id') || '') || null } }, capturedAt } : null,
      restrictedResponseArchive: bytes ? { state, capturedAt, httpStatus: response.status, contentType: response.headers.get('content-type'),
        bodySize: bytes.length, bodySha256: createHash('sha256').update(bytes).digest('hex'), bodyBytes: bytes,
        bodyText: isPostgresSafeText(bodyText) ? bodyText : null, jsonParsed: parsed,
        parsedPayload: parsed && isPostgresSafeJsonValue(raw) ? raw : null } : null,
    })
    try {
      response = await this.fetch(url, { ...options, redirect: 'error', signal: controller.signal,
        headers: { ...options.headers, 'user-agent': HUB_USER_AGENT } })
      bytes = await readBody(response, controller)
      bodyText = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes)
      try { raw = JSON.parse(bodyText.replace(/^\uFEFF/, '')); parsed = true } catch { /* preserved exact bytes below */ }
      if (!response.ok) {
        const code = raw?.error?.code ?? raw?.code
        const businessCode = typeof code === 'string' ? scrub(code) : code
        throw new WebSearchUpstreamError({ outcome: response.status < 500 ? 'rejected' : 'unknown', billed: null,
          httpStatus: response.status, businessCode: Number.isFinite(businessCode) || (typeof businessCode === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(businessCode)) ? businessCode : null,
          errorCode: 'web_search_upstream_rejected', affectsCircuit: response.status >= 500,
        }, persistence('rejected'))
      }
      if (!parsed || !isPostgresSafeJsonValue(raw)) throw new Error('invalid_response_json')
      let publicBody
      try { publicBody = normalizeSearchResponse(safe(raw), provider, request, capturedAt) }
      catch { throw new Error('invalid_web_search_response') }
      const result = { publicBody, items: publicBody.data.items, records: [], archiveObjects: [], ...persistence('accepted') }
      Object.defineProperty(result, 'restrictedResponseArchive', { value: result.restrictedResponseArchive, enumerable: false })
      return result
    } catch (error) {
      if (error instanceof WebSearchUpstreamError) throw error
      if (error instanceof AppError && ['proxy_route_unavailable', 'proxy_routes_unreachable'].includes(error.code)) {
        throw new WebSearchUpstreamError({ outcome: 'rejected', billed: false, httpStatus: null, businessCode: null,
          errorCode: 'web_search_egress_unavailable', affectsCircuit: false }, persistence('not_dispatched'))
      }
      throw new WebSearchUpstreamError({ outcome: response?.ok ? 'succeeded_unusable' : 'unknown', billed: null,
        httpStatus: response?.status ?? null, businessCode: null, errorCode: controller.signal.aborted ? 'web_search_upstream_timeout_or_size_limit' : 'web_search_upstream_response_unusable',
      }, persistence(response?.ok ? 'succeeded_unusable' : 'unknown'))
    } finally { clearTimeout(timer) }
  }
}
