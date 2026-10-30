import { createHash } from 'node:crypto'
import { HUB_SOCIAL_ENDPOINTS, normalizeTwitterResponse } from '../contracts/hub-social.mjs'
import { createCredentialEchoRedactor } from '../core/credential-redaction.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'
import { HUB_USER_AGENT } from '../core/outbound-identity.mjs'
import { AppError } from '../core/errors.mjs'
import { FACEBOOK_HOST, FACEBOOK_ENDPOINT, projectFacebookSearch } from '../contracts/facebook-search.mjs'
import { rapidQuotaObservation } from '../external-platforms/platform-search-policy.mjs'
import { twitterAccountFailure } from '../contracts/twitter-account-failure.mjs'

export const TWITTER_AIO_HOST = 'twitter-aio.p.rapidapi.com'
const TWITTER_ENDPOINTS = new Set(Object.values(HUB_SOCIAL_ENDPOINTS).map(endpoint => endpoint.endpointKey))
const MAX_BYTES = 4 * 1024 * 1024
const RATE_LIMIT_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
  'x-ratelimit-requests-limit', 'x-ratelimit-requests-remaining', 'x-ratelimit-requests-reset']
const unsignedHeader = value => typeof value === 'string' && /^\d{1,16}$/u.test(value)
  && Number.isSafeInteger(Number(value)) ? Number(value) : null

function twitterRateLimitObservation(response) {
  const observedAt = new Date()
  const retryAfter = response.headers.get('retry-after')
  let retryAfterSeconds = unsignedHeader(retryAfter)
  if (retryAfterSeconds === null && typeof retryAfter === 'string'
    && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(retryAfter)) {
    const until = new Date(retryAfter)
    if (Number.isFinite(until.getTime()) && until.toUTCString() === retryAfter) {
      retryAfterSeconds = Math.max(0, Math.ceil((until.getTime() - observedAt.getTime()) / 1000))
    }
  }
  // Preserve fixed numeric evidence only. Generic reset can be seconds or an
  // epoch timestamp; Requests headers do not prove a monthly or hard quota.
  return { observedAt: observedAt.toISOString(), httpStatus: response.status, retryAfterSeconds,
    headers: Object.fromEntries(RATE_LIMIT_HEADERS.map(name => [name, unsignedHeader(response.headers.get(name))])) }
}
// Fetch hides DNS/TCP/TLS errors in cause or AggregateError. Retain only fixed
// technical codes; exception messages, stacks and URLs can contain credentials.
const SAFE_FAILURE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'ABORT_ERR',
  'proxy_route_unavailable', 'proxy_routes_unreachable',
  // The fetch wrapper reads the provider route before a business HTTP call.
  // These codes distinguish failed route reads without asserting dispatch.
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '42501', '42703', '42P01', '53300', '53400', '57P01', '57P02', '57P03',
])
function transportFailure(error, phase, deadlineExceeded, startedAt, timeoutMs) {
  const pending = [error], seen = new Set(), codes = new Set()
  for (let index = 0; index < pending.length && index < 12; index++) {
    const entry = pending[index]
    if (!entry || typeof entry !== 'object' || seen.has(entry)) continue
    seen.add(entry)
    try {
      const code = entry.code, errors = entry.errors
      if (SAFE_FAILURE_CODES.has(code)) codes.add(code)
      pending.push(entry.cause)
      if (Array.isArray(errors)) pending.push(...errors.slice(0, 4))
    } catch { /* Diagnostic accessors must not replace the original failure. */ }
  }
  return { phase, codes: [...codes], deadlineExceeded,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), timeoutMs }
}
export class RapidApiUpstreamError extends Error {
  constructor(evidence, persistence = {}) {
    super('External social data request failed')
    this.name = 'RapidApiUpstreamError'
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

export class RapidApiAdapter {
  constructor({ apiKey = '', credentialResolver = null, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    this.apiKey = apiKey
    this.credentialResolver = credentialResolver
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }
  async resolveCredential() {
    return this.credentialResolver ? await this.credentialResolver() : this.apiKey || null
  }
  async execute(request, { credential, encodeCursor } = {}) {
    const facebook = request.endpointKey === FACEBOOK_ENDPOINT
    if ((!facebook && (!TWITTER_ENDPOINTS.has(request.endpointKey) || request.platform !== 'twitter'))
      || (facebook && (request.platform !== 'facebook' || request.endpointPath !== '/search/posts'))) {
      throw new AppError(400, 'rapidapi_platform_not_supported', 'RapidAPI is available only for Twitter and Facebook search')
    }
    const key = credential === undefined ? await this.resolveCredential() : credential
    if (typeof key !== 'string' || !key) throw new Error('External credential is unavailable')
    const host = facebook ? FACEBOOK_HOST : TWITTER_AIO_HOST
    const url = new URL(request.endpointPath, `https://${host}`)
    if (url.origin !== `https://${host}`) throw new Error('Unexpected provider origin')
    for (const [name, value] of Object.entries(request.upstreamQuery)) url.searchParams.set(name, String(value))
    const controller = new AbortController()
    let deadlineExceeded = false
    const timer = setTimeout(() => { deadlineExceeded = true; controller.abort() }, this.timeoutMs)
    let response, bytes, raw, bodyText, quota, rateLimit, failure = null, phase = 'request', parsed = false
    const startedAt = performance.now()
    const capturedAt = new Date().toISOString()
    const scrub = createCredentialEchoRedactor(key)
    const safe = value => {
      if (typeof value === 'string') return scrub(value)
      if (Array.isArray(value)) return value.map(safe)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [scrub(k), safe(v)]))
      return value
    }
    const persistence = state => ({
      upstreamEvidence: { requestId: scrub(response?.headers.get('x-rapidapi-request-id') || response?.headers.get('x-request-id') || '') || null },
      responseArchive: response || failure ? { contractState: state, httpStatus: response?.status ?? null, businessCode: null,
        contentType: response?.headers.get('content-type') ?? null, bodySize: bytes?.length ?? null,
        payloadSha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
        rawPayload: { response: { httpStatus: response?.status ?? null, requestId: scrub(response?.headers.get('x-rapidapi-request-id') || '') || null,
          ...(failure ? { transportFailure: failure } : {}),
          ...(rateLimit ? { rateLimit } : {}),
          ...(facebook ? { quota } : {}) } }, capturedAt } : null,
      restrictedResponseArchive: bytes ? { state, capturedAt, httpStatus: response.status, contentType: response.headers.get('content-type'),
        bodySize: bytes.length, bodySha256: createHash('sha256').update(bytes).digest('hex'), bodyBytes: bytes,
        bodyText: isPostgresSafeText(bodyText) ? bodyText : null, jsonParsed: parsed,
        parsedPayload: parsed && isPostgresSafeJsonValue(raw) ? raw : null } : null,
    })
    try {
      response = await this.fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { 'x-rapidapi-host': host, 'x-rapidapi-key': key, 'user-agent': HUB_USER_AGENT } })
      if (!facebook) rateLimit = twitterRateLimitObservation(response)
      phase = 'body'
      if (facebook) quota = rapidQuotaObservation(response)
      bytes = await readBody(response, controller)
      phase = 'decode'
      bodyText = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes)
      try { raw = JSON.parse(bodyText.replace(/^\uFEFF/, '')); parsed = true } catch { /* preserved exact bytes below */ }
      if (facebook) quota = { ...quota, monthlyExhausted: response.status === 429
        && /(?:monthly|month)[\s\S]{0,80}(?:quota|limit)|(?:quota|limit)[\s\S]{0,80}(?:monthly|month)/i.test(String(raw?.message || raw?.error?.message || '').slice(0, 500)) }
      if (!response.ok) {
        const code = raw?.error?.code ?? raw?.code
        const businessCode = typeof code === 'string' ? scrub(code) : code
        throw new RapidApiUpstreamError({ outcome: response.status < 500 ? 'rejected' : 'unknown', billed: null,
          httpStatus: response.status, businessCode: Number.isFinite(businessCode) || (typeof businessCode === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(businessCode)) ? businessCode : null,
          errorCode: 'social_upstream_rejected', affectsCircuit: response.status >= 500,
          ...(facebook ? { quota } : {}),
        }, persistence('rejected'))
      }
      if (!parsed || !isPostgresSafeJsonValue(raw)) throw new Error('invalid_response_json')
      // AIO explicitly reports a negative account lookup with HTTP 200. Keep
      // this business result separate from malformed profiles, only for the
      // new account workflow; historical social/search contracts stay intact.
      const accountFailure = request.accountCompatibility === true && request.operation === 'user-info'
        && request.endpointKey === 'twitter-aio.user-info' ? twitterAccountFailure(raw) : null
      if (accountFailure) {
        throw new RapidApiUpstreamError({ outcome: 'rejected', billed: null, httpStatus: response.status,
          businessCode: null, errorCode: accountFailure.code, affectsCircuit: false,
          ...(accountFailure.code === 'social_account_unavailable' ? { accountReason: accountFailure.reason } : {}),
        }, persistence('rejected'))
      }
      let publicBody
      try { publicBody = facebook ? projectFacebookSearch(safe(raw), request, 'rapidapi', capturedAt,
        { allowOverflow: request.standardSearch === true && request.allowOverflow === true }).publicBody
        : normalizeTwitterResponse(safe(raw), request, { encodeCursor, capturedAt,
          allowOverflow: (request.operation === 'search' && request.standardSearch === true || request.accountCompatibility === true) && request.allowOverflow === true }) }
      catch { throw new Error('invalid_social_response') }
      const result = { publicBody, items: publicBody.data.items, records: [], archiveObjects: [], ...persistence('accepted'),
        ...(facebook ? { quota } : {}) }
      Object.defineProperty(result, 'restrictedResponseArchive', { value: result.restrictedResponseArchive, enumerable: false })
      return result
    } catch (error) {
      if (error instanceof RapidApiUpstreamError) throw error
      if (phase === 'request' || phase === 'body') failure = transportFailure(error, phase, deadlineExceeded, startedAt, this.timeoutMs)
      if (error instanceof AppError && ['proxy_route_unavailable', 'proxy_routes_unreachable'].includes(error.code)) {
        throw new RapidApiUpstreamError({ outcome: 'rejected', billed: false, httpStatus: null, businessCode: null,
          errorCode: 'social_egress_unavailable', affectsCircuit: false }, persistence('not_dispatched'))
      }
      throw new RapidApiUpstreamError({ outcome: response?.ok ? 'succeeded_unusable' : facebook && response?.status === 429 ? 'rejected' : 'unknown', billed: null,
        httpStatus: response?.status ?? null, businessCode: null, errorCode: controller.signal.aborted ? 'social_upstream_timeout_or_size_limit' : 'social_upstream_response_unusable',
        ...(facebook && response?.status === 429 ? { affectsCircuit: false } : {}),
        ...(quota ? { quota } : {}),
      }, persistence(response?.ok ? 'succeeded_unusable' : facebook && response?.status === 429 ? 'rejected' : 'unknown'))
    } finally { clearTimeout(timer) }
  }
}
