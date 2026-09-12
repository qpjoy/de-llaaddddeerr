import { AppError } from '../core/errors.mjs'
import { createHash } from 'node:crypto'
import { createCredentialEchoRedactor } from '../core/credential-redaction.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'
import { HUB_USER_AGENT } from '../core/outbound-identity.mjs'
import {
  normalizeSocialAccountSearchRequest,
  normalizeSocialAccountSearchResponse,
} from '../contracts/social-accounts.mjs'
import { normalizeSocialAccountArchiveObjects } from '../ingest/social-accounts.mjs'

import {
  isTikHubXiaohongshuUnavailable,
  normalizeTikHubXiaohongshuNoteResult,
  normalizeXiaohongshuPostRequest,
  redactTikHubEnvelope,
  sha256Json,
  TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
  XIAOHONGSHU_PLATFORM,
  XIAOHONGSHU_POST_CONTRACT_VERSION,
} from '../contracts/tikhub-xiaohongshu.mjs'
import {
  buildXiaohongshuSearchDispatch,
  normalizeTikHubXiaohongshuSearchResponse,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
} from '../contracts/tikhub-xiaohongshu-search.mjs'
import {
  normalizeTikHubXiaohongshuSearchUsersResponse,
  normalizeTikHubXiaohongshuUserInfoResponse,
  TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
  TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
} from '../contracts/tikhub-xiaohongshu-user-info.mjs'
import {
  normalizeTikHubXiaohongshuUserPostsResponse,
  TikHubXiaohongshuUserPostsContractError,
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION,
} from '../contracts/tikhub-xiaohongshu-user-posts.mjs'
import {
  createTikHubXiaohongshuRecord,
  createTikHubXiaohongshuSearchRecord,
} from '../ingest/tikhub-xiaohongshu.mjs'

export const TIKHUB_BASE_URL = 'https://api.tikhub.io'
export const TIKHUB_MAINLAND_BASE_URL = 'https://api.tikhub.dev'
const TIKHUB_ALLOWED_BASE_URLS = new Set([TIKHUB_BASE_URL, TIKHUB_MAINLAND_BASE_URL])
export const TIKHUB_DEFAULT_TIMEOUT_MS = 30_000
export const TIKHUB_MAX_TIMEOUT_MS = 120_000
export const TIKHUB_DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
export const TIKHUB_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const OFFICIAL_APP_V2_ENDPOINTS = Object.freeze({
  [TIKHUB_XIAOHONGSHU_ENDPOINT_KEY]: Object.freeze({
    path: TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
    version: TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
    fields: Object.freeze(['note_id', 'share_text']),
  }),
  [TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY]: Object.freeze({
    path: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
    version: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
    fields: Object.freeze([
      'keyword', 'page', 'sort_type', 'note_type', 'time_filter',
      'search_id', 'search_session_id', 'source', 'ai_mode',
    ]),
  }),
  [TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY]: Object.freeze({
    path: TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
    version: TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
    fields: Object.freeze(['keyword', 'page', 'search_id', 'source']),
  }),
  [TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY]: Object.freeze({
    path: TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
    version: TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
    fields: Object.freeze(['user_id', 'share_text']),
  }),
  [TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY]: Object.freeze({
    path: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
    version: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION,
    fields: Object.freeze(['user_id', 'share_text', 'cursor']),
  }),
})

function credential(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    throw new TypeError('apiKey must be a non-empty string of at most 4096 characters')
  }
  return value.trim()
}

function providerCredentialSafePayload(value, resolvedCredential) {
  const scrub = createCredentialEchoRedactor(resolvedCredential)
  if (!value || typeof value !== 'object') return scrub(value)
  const output = Array.isArray(value) ? [] : {}
  const pending = [{ source: value, target: output }]
  while (pending.length > 0) {
    const { source, target } = pending.pop()
    for (const [key, child] of Object.entries(source)) {
      const safeKey = Array.isArray(target) ? key : scrub(key)
      let safeChild
      if (child && typeof child === 'object') {
        safeChild = Array.isArray(child) ? [] : {}
        pending.push({ source: child, target: safeChild })
      } else {
        safeChild = scrub(child)
      }
      Object.defineProperty(target, safeKey, {
        value: safeChild,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
  }
  return output
}

function postgresSafeText(value) {
  return isPostgresSafeText(value) ? value : null
}

function boundedInteger(value, fallback, maximum, name) {
  const parsed = value ?? fallback
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`)
  }
  return parsed
}

class BodyLimitError extends Error {
  constructor(size = null) {
    super('response_too_large')
    this.size = Number.isSafeInteger(size) ? size : null
  }
}

class BodyEncodingError extends Error {
  constructor(bytes) {
    super('response_invalid_utf8')
    this.bodyBytes = Buffer.from(bytes)
    this.size = this.bodyBytes.byteLength
  }
}

function decodeUtf8(bytes) {
  try {
    // Keep an initial UTF-8 BOM in the restricted text view. JSON parsing may
    // ignore that marker, but the exact body/hash must still represent the
    // provider bytes rather than a decoder-normalized string.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new BodyEncodingError(bytes)
  }
}

function parseJsonText(text) {
  return JSON.parse(text.codePointAt(0) === 0xFEFF ? text.slice(1) : text)
}

async function boundedBody(response, maximum, controller) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maximum) {
    controller.abort()
    throw new BodyLimitError(declared)
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximum) throw new BodyLimitError(bytes.byteLength)
    return {
      text: decodeUtf8(bytes),
      size: bytes.byteLength,
      bytes: Buffer.from(bytes),
    }
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        controller.abort()
        throw new BodyLimitError(size)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    text: decodeUtf8(bytes),
    size: bytes.byteLength,
    bytes: Buffer.from(bytes),
  }
}

function archiveEvidence({
  raw,
  providerCredential = null,
  capturedAt,
  httpStatus,
  contentType,
  bodySize,
  bodyBytes = null,
  state,
  endpointVersion = TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
}) {
  let sanitized = null
  let payloadHash = Buffer.isBuffer(bodyBytes)
    ? createHash('sha256').update(bodyBytes).digest('hex')
    : null
  let operationalPayload = null
  if (raw != null) {
    try {
      sanitized = redactTikHubEnvelope(providerCredentialSafePayload(raw, providerCredential))
      if (isPostgresSafeJsonValue(sanitized)) {
        payloadHash = sha256Json(sanitized)
        try {
          // The store intentionally uses structuredClone at its trust boundary.
          // Keep the secret-free operational projection only when it can cross
          // that boundary; exact restricted bytes remain authoritative.
          operationalPayload = structuredClone(sanitized)
        } catch {
          operationalPayload = null
        }
      }
    } catch {
      // Exact bounded response bytes are persisted in the restricted archive.
      // A pathologically deep, but valid, JSON value may exceed the JS clone
      // stack; omit only this optional secret-free JSON projection rather than
      // losing post-dispatch evidence or risking credential exposure.
      sanitized = null
      // Keep the exact-byte fingerprint initialized above. It is the durable
      // identity for this paid response even when the optional operational
      // projection cannot be constructed.
      operationalPayload = null
    }
  }
  return {
    responseArchive: {
      contractState: state,
      httpStatus,
      businessCode: Number.isInteger(raw?.code) ? raw.code : null,
      contentType,
      bodySize,
      payloadSha256: payloadHash,
      rawPayload: operationalPayload,
      capturedAt,
    },
    upstreamEvidence: {
      requestId: postgresSafeText(raw?.request_id),
      recordTime: null,
    },
    archiveObjects: payloadHash == null ? [] : [{
      kind: 'response',
      marketplace: XIAOHONGSHU_PLATFORM,
      endpointVersion,
      capturedDate: new Date(capturedAt).toISOString().slice(0, 10),
      archivePath: `external/tikhub/xiaohongshu/${new Date(capturedAt).toISOString().slice(0, 10)}/responses/${payloadHash}.json`,
      envelopePointer: '$',
      sourceKey: payloadHash,
      payloadSha256: payloadHash,
      rawPayload: operationalPayload,
      contractState: state,
      contentType,
      bodySize,
      upstreamRequestId: postgresSafeText(raw?.request_id),
    }],
  }
}

function restrictedArchiveEvidence({
  raw,
  bodyText,
  bodyBytes,
  jsonParsed,
  capturedAt,
  httpStatus,
  contentType,
  state,
}) {
  if ((bodyText !== null && typeof bodyText !== 'string') || !Buffer.isBuffer(bodyBytes)) return null
  let parsedPayload = null
  if (jsonParsed === true && isPostgresSafeJsonValue(raw)) {
    try {
      parsedPayload = structuredClone(raw)
    } catch {
      // bodyBytes/bodySha256 are the exact source of truth. parsedPayload is a
      // convenience JSONB projection and may be absent for excessive depth.
      parsedPayload = null
    }
  }
  return Object.freeze({
    state,
    capturedAt: new Date(capturedAt).toISOString(),
    httpStatus,
    contentType,
    bodySize: bodyBytes.byteLength,
    bodySha256: createHash('sha256').update(bodyBytes).digest('hex'),
    bodyBytes: Buffer.from(bodyBytes),
    bodyText: isPostgresSafeText(bodyText) ? bodyText : null,
    jsonParsed: jsonParsed === true,
    parsedPayload,
  })
}

function securedProviderResult(value, persistence) {
  Object.defineProperty(value, 'restrictedResponseArchive', {
    value: persistence?.restrictedResponseArchive || null,
    enumerable: false,
  })
  return Object.freeze(value)
}

function evidence({ outcome, httpStatus, businessCode = null, billed, errorCode, affectsCircuit = true }) {
  return Object.freeze({
    outcome,
    httpStatus,
    businessCode,
    billed,
    errorCode,
    affectsCircuit,
    retryable: false,
  })
}

export class TikHubUpstreamError extends Error {
  constructor(message, errorEvidence, persistenceEvidence = {}) {
    super(message)
    this.name = 'TikHubUpstreamError'
    this.evidence = Object.freeze({ ...errorEvidence })
    Object.defineProperties(this, {
      archiveObjects: { value: Object.freeze([...(persistenceEvidence.archiveObjects || [])]), enumerable: false },
      responseArchive: { value: persistenceEvidence.responseArchive || null, enumerable: false },
      upstreamEvidence: { value: persistenceEvidence.upstreamEvidence || null, enumerable: false },
      restrictedResponseArchive: {
        value: persistenceEvidence.restrictedResponseArchive || null,
        enumerable: false,
      },
    })
  }
}

function upstreamError(message, errorEvidence, persistenceEvidence) {
  return new TikHubUpstreamError(message, evidence(errorEvidence), persistenceEvidence)
}

function httpFailureEvidence(httpStatus, businessCode = null) {
  const clientFailure = Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500
  const credentialFailure = [401, 402, 403].includes(httpStatus)
  const routeContractFailure = [404, 405, 422].includes(httpStatus)
  const capacityFailure = httpStatus === 429
  return {
    outcome: clientFailure ? 'rejected' : 'unknown',
    httpStatus,
    businessCode,
    // App V2 documents chargeability for successful envelopes, but does not
    // make a general no-charge promise for every HTTP error. Preserve unknown
    // cost rather than understating spend in the customer ledger.
    billed: null,
    errorCode: capacityFailure ? 'upstream_rate_limited'
      : credentialFailure ? 'upstream_auth_or_balance_unavailable'
        : routeContractFailure ? 'upstream_endpoint_unavailable'
          : clientFailure ? 'upstream_request_rejected' : 'upstream_http_error',
    // The endpoint, credential and shared provider capacity are global Hub
    // dependencies. Other 4xx responses remain request-local; 5xx/unknown
    // responses are allowed to open the defensive circuit as well.
    affectsCircuit: capacityFailure || credentialFailure || routeContractFailure
      || httpStatus === 408 || !clientFailure,
  }
}

async function requestTikHubJson(
  adapter,
  path,
  query,
  resolvedCredential,
  capturedAt,
  endpointVersion,
) {
  const url = new URL(path, adapter.baseUrl)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), adapter.timeoutMs)
  const attemptedAt = capturedAt || new Date()
  try {
    let response
    try {
      response = await adapter.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${resolvedCredential}`,
          'user-agent': HUB_USER_AGENT,
        },
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof AppError && ['proxy_route_unavailable', 'proxy_routes_unreachable'].includes(error.code)) {
        throw upstreamError('TikHub proxy connectivity failed before paid dispatch', {
          outcome: 'rejected', httpStatus: null, billed: false, errorCode: error.code,
        })
      }
      throw upstreamError('TikHub request outcome is unknown', {
        outcome: 'unknown',
        httpStatus: null,
        billed: null,
        errorCode: controller.signal.aborted ? 'upstream_deadline_exceeded' : 'upstream_transport_error',
      })
    }
    const httpStatus = Number.isInteger(response?.status) ? response.status : null
    const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase().slice(0, 256)
    if (!response.ok) {
      let raw = null
      let bodySize = null
      let bodyText = null
      let bodyBytes = null
      let jsonParsed = false
      let archiveState = 'provider_rejected'
      try {
        const body = await boundedBody(response, adapter.maxResponseBytes, controller)
        bodySize = body.size
        bodyText = body.text
        bodyBytes = body.bytes
        try {
          raw = parseJsonText(body.text)
          jsonParsed = true
        } catch {
          archiveState = 'provider_rejected_invalid_json'
        }
      } catch (error) {
        bodySize = error instanceof BodyLimitError ? error.size : null
        if (error instanceof BodyEncodingError) {
          bodySize = error.size
          bodyBytes = error.bodyBytes
        }
        archiveState = error instanceof BodyLimitError
          ? 'provider_rejected_response_too_large'
          : 'provider_rejected_body_unreadable'
      }
      throw upstreamError(
        'TikHub rejected the request',
        httpFailureEvidence(httpStatus, Number.isInteger(raw?.code) ? raw.code : null),
        {
          ...archiveEvidence({
            raw,
            providerCredential: resolvedCredential,
            capturedAt: attemptedAt,
            httpStatus,
            contentType,
            bodySize,
            bodyBytes,
            state: archiveState,
            endpointVersion,
          }),
          restrictedResponseArchive: restrictedArchiveEvidence({
            raw, bodyText, bodyBytes, jsonParsed,
            capturedAt: attemptedAt, httpStatus, contentType, state: archiveState,
          }),
        },
      )
    }

    let body
    try {
      body = await boundedBody(response, adapter.maxResponseBytes, controller)
    } catch (error) {
      const contractFailure = error instanceof BodyLimitError || error instanceof BodyEncodingError
      throw upstreamError('TikHub response could not be read safely', {
        outcome: contractFailure ? 'succeeded_unusable' : 'unknown', httpStatus, billed: null,
        errorCode: error instanceof BodyLimitError
          ? 'upstream_response_too_large'
          : error instanceof BodyEncodingError ? 'invalid_upstream_encoding'
            : controller.signal.aborted ? 'upstream_deadline_exceeded' : 'upstream_body_read_failed',
        affectsCircuit: true,
      }, error instanceof BodyEncodingError ? {
        ...archiveEvidence({
          raw: null,
          providerCredential: resolvedCredential,
          capturedAt: attemptedAt,
          httpStatus,
          contentType,
          bodySize: error.size,
          bodyBytes: error.bodyBytes,
          state: 'invalid_encoding',
          endpointVersion,
        }),
        restrictedResponseArchive: restrictedArchiveEvidence({
          raw: null,
          bodyText: null,
          bodyBytes: error.bodyBytes,
          jsonParsed: false,
          capturedAt: attemptedAt,
          httpStatus,
          contentType,
          state: 'invalid_encoding',
        }),
      } : {})
    }
    let raw
    try { raw = parseJsonText(body.text) } catch {
      throw upstreamError('TikHub returned invalid JSON', {
        outcome: 'succeeded_unusable', httpStatus, billed: null,
        errorCode: 'invalid_upstream_json', affectsCircuit: true,
      }, {
        ...archiveEvidence({
          raw: null,
          providerCredential: resolvedCredential,
          capturedAt: attemptedAt,
          httpStatus,
          contentType,
          bodySize: body.size,
          bodyBytes: body.bytes,
          state: 'invalid_json',
          endpointVersion,
        }),
        restrictedResponseArchive: restrictedArchiveEvidence({
          raw: null, bodyText: body.text, bodyBytes: body.bytes, jsonParsed: false,
          capturedAt: attemptedAt,
          httpStatus, contentType, state: 'invalid_json',
        }),
      })
    }
    const persisted = (state, at = attemptedAt) => ({
      ...archiveEvidence({
        raw,
        providerCredential: resolvedCredential,
        capturedAt: at,
        httpStatus,
        contentType,
        bodySize: body.size,
        bodyBytes: body.bytes,
        state,
        endpointVersion,
      }),
      restrictedResponseArchive: restrictedArchiveEvidence({
        raw, bodyText: body.text, bodyBytes: body.bytes, jsonParsed: true,
        capturedAt: at, httpStatus, contentType, state,
      }),
    })
    if (!Number.isInteger(raw?.code)) {
      throw upstreamError('TikHub response omitted its business status', {
        outcome: 'succeeded_unusable', httpStatus, businessCode: null,
        billed: null, errorCode: 'invalid_upstream_contract', affectsCircuit: true,
      }, persisted('succeeded_unusable'))
    }
    if (raw.code !== 200) {
      const businessCode = raw.code
      const globalCapacityFailure = businessCode === 429
      const globalCredentialFailure = [401, 402, 403].includes(businessCode)
      const routeContractFailure = [404, 405, 422].includes(businessCode)
      const globalProviderFailure = businessCode >= 500
      const recognizedBusinessFailure = [400, 401, 402, 403, 404, 405, 408, 422, 429]
        .includes(businessCode)
      throw upstreamError('TikHub returned a business error', {
        outcome: 'rejected', httpStatus, businessCode, billed: null,
        errorCode: globalCapacityFailure ? 'upstream_rate_limited'
          : globalCredentialFailure ? 'upstream_auth_or_balance_unavailable'
            : routeContractFailure ? 'upstream_endpoint_unavailable'
              : globalProviderFailure ? 'upstream_business_error'
                : 'upstream_request_rejected',
        affectsCircuit: globalCapacityFailure || globalCredentialFailure || routeContractFailure
          || globalProviderFailure || businessCode === 408 || !recognizedBusinessFailure,
      }, persisted('provider_rejected'))
    }
    if (!contentType.includes('application/json') && !contentType.includes('+json')) {
      throw upstreamError('TikHub returned an unsupported content type', {
        outcome: 'succeeded_unusable', httpStatus, businessCode: 200,
        billed: true, errorCode: 'invalid_upstream_content_type', affectsCircuit: true,
      }, persisted('invalid_content_type'))
    }
    if (!isPostgresSafeJsonValue(raw)) {
      throw upstreamError('TikHub returned JSON that cannot be represented in PostgreSQL', {
        outcome: 'succeeded_unusable', httpStatus, businessCode: 200,
        billed: true, errorCode: 'upstream_payload_unrepresentable', affectsCircuit: true,
      }, persisted('succeeded_unusable'))
    }
    return {
      raw,
      httpStatus,
      acceptedAt: capturedAt || new Date(),
      persisted,
      restrictedResponseArchive: restrictedArchiveEvidence({
        raw, bodyText: body.text, bodyBytes: body.bytes, jsonParsed: true,
        capturedAt: capturedAt || attemptedAt,
        httpStatus, contentType, state: 'accepted',
      }),
    }
  } finally {
    clearTimeout(timer)
  }
}

export class TikHubAdapter {
  #fallbackCredential
  #credentialResolver

  constructor({
    apiKey = null,
    credentialResolver = null,
    baseUrl = TIKHUB_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = TIKHUB_DEFAULT_TIMEOUT_MS,
    maxResponseBytes = TIKHUB_DEFAULT_MAX_RESPONSE_BYTES,
  } = {}) {
    this.#fallbackCredential = credential(apiKey)
    if (credentialResolver != null && typeof credentialResolver !== 'function') {
      throw new TypeError('credentialResolver must be a function')
    }
    if (!this.#fallbackCredential && !credentialResolver) {
      throw new TypeError('apiKey or credentialResolver is required')
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
    if (!TIKHUB_ALLOWED_BASE_URLS.has(baseUrl)) {
      throw new TypeError('baseUrl must be an approved TikHub HTTPS origin')
    }
    this.#credentialResolver = credentialResolver
    this.baseUrl = baseUrl
    this.fetchImpl = fetchImpl
    this.timeoutMs = boundedInteger(timeoutMs, TIKHUB_DEFAULT_TIMEOUT_MS, TIKHUB_MAX_TIMEOUT_MS, 'timeoutMs')
    this.maxResponseBytes = boundedInteger(
      maxResponseBytes,
      TIKHUB_DEFAULT_MAX_RESPONSE_BYTES,
      TIKHUB_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    )
  }

  async resolveCredential() {
    const dynamic = this.#credentialResolver ? await this.#credentialResolver() : null
    return credential(dynamic) || this.#fallbackCredential
  }

  async getXiaohongshuAppV2(endpointKey, query, {
    capturedAt = null,
    credential: suppliedCredential,
  } = {}) {
    const endpoint = OFFICIAL_APP_V2_ENDPOINTS[endpointKey]
    if (!endpoint) throw new TypeError('endpointKey is not an approved Xiaohongshu App V2 endpoint')
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new TypeError('query must be an object')
    }
    const allowed = new Set(endpoint.fields)
    const normalizedQuery = {}
    for (const [key, value] of Object.entries(query)) {
      if (!allowed.has(key)) throw new TypeError(`${key} is not allowed for this endpoint`)
      if (typeof value !== 'string' || !value || value.length > 8_192) {
        throw new TypeError(`${key} must be a non-empty string of at most 8192 characters`)
      }
      normalizedQuery[key] = value
    }
    const resolvedCredential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : credential(suppliedCredential)
    if (!resolvedCredential) throw new TypeError('TikHub credential is unavailable')
    const exchange = await requestTikHubJson(
      this,
      endpoint.path,
      normalizedQuery,
      resolvedCredential,
      capturedAt,
      endpoint.version,
    )
    const persistence = exchange.persisted('accepted', exchange.acceptedAt)
    return securedProviderResult({
      payload: providerCredentialSafePayload(exchange.raw, resolvedCredential),
      archiveObjects: persistence.archiveObjects,
      responseArchive: persistence.responseArchive,
      upstreamEvidence: persistence.upstreamEvidence,
      endpointKey,
      capturedAt: exchange.acceptedAt,
    }, persistence)
  }

  async searchXiaohongshuNotes(input, {
    capturedAt = null,
    credential: suppliedCredential,
    decodeCursor,
    encodeCursor,
    maxPageSize,
  } = {}) {
    const resolvedCredential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : credential(suppliedCredential)
    if (!resolvedCredential) throw new TypeError('TikHub credential is unavailable')
    const dispatch = buildXiaohongshuSearchDispatch(input, { decodeCursor, maxPageSize })
    const exchange = await requestTikHubJson(
      this,
      dispatch.path,
      dispatch.query,
      resolvedCredential,
      capturedAt,
      dispatch.request.endpointVersion,
    )
    try {
      const normalized = normalizeTikHubXiaohongshuSearchResponse(exchange.raw, dispatch.request, {
        encodeCursor,
        capturedAt: exchange.acceptedAt,
        providerCredential: resolvedCredential,
      })
      const persistence = exchange.persisted('accepted', exchange.acceptedAt)
      const records = normalized.items.map((item, index) => createTikHubXiaohongshuSearchRecord(item, {
        rank: index + 1,
        sourcePointer: `$.data.data.items[${index}].note`,
        bodyCompleteness: normalized.bodyStates[index].completeness,
      }))
      for (const record of records) {
        const itemHash = sha256Json(record.rawItem)
        persistence.archiveObjects.push({
          kind: 'item',
          marketplace: XIAOHONGSHU_PLATFORM,
          endpointVersion: dispatch.request.endpointVersion,
          capturedDate: new Date(exchange.acceptedAt).toISOString().slice(0, 10),
          archivePath: `external/tikhub/xiaohongshu/${new Date(exchange.acceptedAt).toISOString().slice(0, 10)}/items/${itemHash}.json`,
          envelopePointer: record.sourcePointer,
          sourceKey: record.externalId,
          payloadSha256: itemHash,
          rawPayload: record.rawItem,
        })
      }
      return securedProviderResult({
        request: dispatch.request,
        payload: normalized.publicBody,
        publicBody: normalized.publicBody,
        records: Object.freeze(records),
        detailCandidates: normalized.detailCandidates,
        bodyStates: normalized.bodyStates,
        archiveObjects: persistence.archiveObjects,
        responseArchive: persistence.responseArchive,
        upstreamEvidence: persistence.upstreamEvidence,
        endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
      }, persistence)
    } catch (error) {
      if (error instanceof TikHubUpstreamError) throw error
      throw upstreamError('TikHub response did not match the verified search contract', {
        outcome: 'succeeded_unusable', httpStatus: exchange.httpStatus, businessCode: 200,
        billed: true, errorCode: error?.code || 'invalid_upstream_contract', affectsCircuit: true,
      }, exchange.persisted('succeeded_unusable', exchange.acceptedAt))
    }
  }

  async searchXiaohongshuUsers(username, {
    capturedAt = null,
    credential: suppliedCredential,
  } = {}) {
    const normalizedUsername = typeof username === 'string' ? username.trim().replace(/^@+/u, '') : ''
    if (!normalizedUsername || normalizedUsername.length > 2_048) {
      throw new TypeError('username must be a non-empty string of at most 2048 characters')
    }
    const resolvedCredential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : credential(suppliedCredential)
    if (!resolvedCredential) throw new TypeError('TikHub credential is unavailable')
    const exchange = await requestTikHubJson(
      this,
      TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
      { keyword: normalizedUsername, page: '1' },
      resolvedCredential,
      capturedAt,
      TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
    )
    try {
      const user = normalizeTikHubXiaohongshuSearchUsersResponse(exchange.raw, normalizedUsername, {
        providerCredential: resolvedCredential,
      })
      const persistence = exchange.persisted('accepted', exchange.acceptedAt)
      return securedProviderResult({
        user,
        archiveObjects: persistence.archiveObjects,
        responseArchive: persistence.responseArchive,
        upstreamEvidence: persistence.upstreamEvidence,
        endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
        capturedAt: exchange.acceptedAt,
      }, persistence)
    } catch (error) {
      if (error instanceof TikHubUpstreamError) throw error
      throw upstreamError('TikHub response did not match the verified search-users contract', {
        outcome: 'succeeded_unusable',
        httpStatus: exchange.httpStatus,
        businessCode: 200,
        billed: true,
        errorCode: error?.code || 'invalid_upstream_contract',
        affectsCircuit: error?.code !== 'upstream_user_unavailable',
      }, exchange.persisted('succeeded_unusable', exchange.acceptedAt))
    }
  }

  // Keyword account search for the platforms this vendor serves (Weibo,
  // Kuaishou). The contract, canonical records and dataset are shared with the
  // platforms the other vendor serves: which vendor answered is call evidence,
  // not a property of the account.
  async searchAccounts(body, { capturedAt = null, deliveryModes, credential: suppliedCredential } = {}) {
    const resolvedCredential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : credential(suppliedCredential)
    if (!resolvedCredential) throw new TypeError('TikHub credential is unavailable')
    const request = normalizeSocialAccountSearchRequest(body, { deliveryModes })
    const exchange = await requestTikHubJson(
      this,
      request.endpointPath,
      request.upstreamQuery,
      resolvedCredential,
      capturedAt,
      request.endpointVersion,
    )
    try {
      const normalized = normalizeSocialAccountSearchResponse(exchange.raw, request, {
        capturedAt: exchange.acceptedAt,
      })
      const ingest = normalizeSocialAccountArchiveObjects(normalized.archiveObjects, request, {
        capturedAt: exchange.acceptedAt,
      })
      const persistence = exchange.persisted('accepted', exchange.acceptedAt)
      return securedProviderResult({
        publicBody: normalized.publicBody,
        items: normalized.accounts,
        records: ingest.records,
        archiveObjects: [...persistence.archiveObjects, ...normalized.archiveObjects],
        responseArchive: persistence.responseArchive,
        upstreamEvidence: persistence.upstreamEvidence,
        endpointKey: request.endpointKey,
        capturedAt: exchange.acceptedAt,
      }, persistence)
    } catch (error) {
      if (error instanceof TikHubUpstreamError) throw error
      // The call was accepted and is therefore already billable. A shape Hub
      // cannot read is reported as succeeded-but-unusable rather than retried.
      throw upstreamError('TikHub response did not match the verified account-search contract', {
        outcome: 'succeeded_unusable',
        httpStatus: exchange.httpStatus,
        businessCode: 200,
        billed: true,
        errorCode: error?.code || 'invalid_upstream_contract',
      }, exchange.persisted('succeeded_unusable', exchange.acceptedAt))
    }
  }

  async getXiaohongshuUserInfo(input, {
    capturedAt = null,
    credential: suppliedCredential,
  } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Xiaohongshu user info input must be an object')
    }
    const keys = Object.keys(input)
    const userId = typeof input.user_id === 'string' ? input.user_id.trim() : ''
    const shareText = typeof input.share_text === 'string' ? input.share_text.trim() : ''
    if (keys.some((key) => !['user_id', 'share_text'].includes(key)) || (!userId && !shareText)) {
      throw new TypeError('user_id or share_text is required')
    }
    const query = userId ? { user_id: userId } : { share_text: shareText }
    const resolvedCredential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : credential(suppliedCredential)
    if (!resolvedCredential) throw new TypeError('TikHub credential is unavailable')
    const exchange = await requestTikHubJson(
      this,
      TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
      query,
      resolvedCredential,
      capturedAt,
      TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
    )
    try {
      const profile = normalizeTikHubXiaohongshuUserInfoResponse(exchange.raw, {
        expectedUserId: userId || null,
        capturedAt: exchange.acceptedAt,
        providerCredential: resolvedCredential,
      })
      const persistence = exchange.persisted('accepted', exchange.acceptedAt)
      const profileHash = sha256Json(profile)
      persistence.archiveObjects.push({
        kind: 'item',
        marketplace: XIAOHONGSHU_PLATFORM,
        endpointVersion: TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
        capturedDate: new Date(exchange.acceptedAt).toISOString().slice(0, 10),
        archivePath: `external/tikhub/xiaohongshu/${new Date(exchange.acceptedAt).toISOString().slice(0, 10)}/profiles/${profileHash}.json`,
        envelopePointer: '$.data',
        sourceKey: profile.user_id,
        payloadSha256: profileHash,
        rawPayload: profile,
      })
      return securedProviderResult({
        profile,
        archiveObjects: persistence.archiveObjects,
        responseArchive: persistence.responseArchive,
        upstreamEvidence: persistence.upstreamEvidence,
        endpointKey: TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
        capturedAt: exchange.acceptedAt,
      }, persistence)
    } catch (error) {
      if (error instanceof TikHubUpstreamError) throw error
      throw upstreamError('TikHub response did not match the verified user-info contract', {
        outcome: 'succeeded_unusable',
        httpStatus: exchange.httpStatus,
        businessCode: 200,
        billed: true,
        errorCode: error?.code || 'invalid_upstream_contract',
        affectsCircuit: true,
      }, exchange.persisted('succeeded_unusable', exchange.acceptedAt))
    }
  }

  async getXiaohongshuUserPostedNotes(input, request, {
    capturedAt = null,
    credential: suppliedCredential,
    encodeCursor,
  } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Xiaohongshu user posts input must be an object')
    }
    const keys = Object.keys(input)
    const userId = typeof input.user_id === 'string' ? input.user_id.trim() : ''
    const shareText = typeof input.share_text === 'string' ? input.share_text.trim() : ''
    const cursor = typeof input.cursor === 'string' ? input.cursor.trim() : ''
    if (
      keys.some((key) => !['user_id', 'share_text', 'cursor'].includes(key))
      || (!userId && !shareText)
      || (input.cursor != null && !cursor)
    ) throw new TypeError('user_id or share_text and an optional non-empty cursor are required')
    const query = {
      ...(userId ? { user_id: userId } : { share_text: shareText }),
      ...(cursor ? { cursor } : {}),
    }
    const resolvedCredential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : credential(suppliedCredential)
    if (!resolvedCredential) throw new TypeError('TikHub credential is unavailable')
    const exchange = await requestTikHubJson(
      this,
      TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
      query,
      resolvedCredential,
      capturedAt,
      TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION,
    )
    try {
      const posts = normalizeTikHubXiaohongshuUserPostsResponse(exchange.raw, request, {
        capturedAt: exchange.acceptedAt,
        encodeCursor,
        resolvedUserId: userId || request?.resolvedUserId,
        providerCredential: resolvedCredential,
      })
      const persistence = exchange.persisted('accepted', exchange.acceptedAt)
      for (const [index, item] of posts.items.entries()) {
        const itemHash = sha256Json(item)
        persistence.archiveObjects.push({
          kind: 'item',
          marketplace: XIAOHONGSHU_PLATFORM,
          endpointVersion: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION,
          capturedDate: new Date(exchange.acceptedAt).toISOString().slice(0, 10),
          archivePath: `external/tikhub/xiaohongshu/${new Date(exchange.acceptedAt).toISOString().slice(0, 10)}/user-posts/${itemHash}.json`,
          envelopePointer: `$.data.data.notes[${index}]`,
          sourceKey: item.externalId,
          payloadSha256: itemHash,
          rawPayload: item,
        })
      }
      return securedProviderResult({
        posts,
        archiveObjects: persistence.archiveObjects,
        responseArchive: persistence.responseArchive,
        upstreamEvidence: persistence.upstreamEvidence,
        endpointKey: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
        capturedAt: exchange.acceptedAt,
      }, persistence)
    } catch (error) {
      if (error instanceof TikHubUpstreamError) throw error
      const code = error instanceof TikHubXiaohongshuUserPostsContractError
        ? error.code : 'invalid_upstream_contract'
      throw upstreamError('TikHub response did not match the verified user-posts contract', {
        outcome: 'succeeded_unusable',
        httpStatus: exchange.httpStatus,
        businessCode: 200,
        billed: true,
        errorCode: code,
        affectsCircuit: true,
      }, exchange.persisted('succeeded_unusable', exchange.acceptedAt))
    }
  }

  async getXiaohongshuPost(input, { capturedAt = null, credential: suppliedCredential } = {}) {
    const resolvedCredential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : credential(suppliedCredential)
    if (!resolvedCredential) throw new TypeError('TikHub credential is unavailable')
    const request = normalizeXiaohongshuPostRequest(input)
    const url = new URL(TIKHUB_XIAOHONGSHU_ENDPOINT_PATH, this.baseUrl)
    for (const [key, value] of Object.entries(request.upstreamQuery)) url.searchParams.set(key, value)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const attemptedAt = capturedAt || new Date()
    let response
    try {
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
          accept: 'application/json',
          authorization: `Bearer ${resolvedCredential}`,
          'user-agent': HUB_USER_AGENT,
        },
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        })
      } catch (error) {
        if (error instanceof AppError && ['proxy_route_unavailable', 'proxy_routes_unreachable'].includes(error.code)) {
          throw upstreamError('TikHub proxy connectivity failed before paid dispatch', {
            outcome: 'rejected', httpStatus: null, billed: false, errorCode: error.code,
          })
        }
        throw upstreamError('TikHub request outcome is unknown', {
          outcome: 'unknown',
          httpStatus: null,
          billed: null,
          errorCode: controller.signal.aborted ? 'upstream_deadline_exceeded' : 'upstream_transport_error',
        })
      }
      const httpStatus = Number.isInteger(response?.status) ? response.status : null
      const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase().slice(0, 256)

      // An HTTP status is authoritative even if the provider's error body is
      // HTML, oversized or truncated. Parse that body only as optional audit
      // evidence so a known 401/402/403/429 can never be downgraded to an
      // "unknown" outcome (and accidentally retried or misdiagnosed).
      if (!response.ok) {
        let raw = null
        let bodySize = null
        let bodyText = null
        let bodyBytes = null
        let jsonParsed = false
        let archiveState = 'provider_rejected'
        try {
          const body = await boundedBody(response, this.maxResponseBytes, controller)
          bodySize = body.size
          bodyText = body.text
          bodyBytes = body.bytes
          try {
            raw = parseJsonText(body.text)
            jsonParsed = true
          } catch {
            archiveState = 'provider_rejected_invalid_json'
          }
        } catch (error) {
          bodySize = error instanceof BodyLimitError ? error.size : null
          if (error instanceof BodyEncodingError) {
            bodySize = error.size
            bodyBytes = error.bodyBytes
          }
          archiveState = error instanceof BodyLimitError
            ? 'provider_rejected_response_too_large'
            : 'provider_rejected_body_unreadable'
        }
        throw upstreamError(
          'TikHub rejected the request',
          httpFailureEvidence(httpStatus, Number.isInteger(raw?.code) ? raw.code : null),
          {
            ...archiveEvidence({
              raw,
              providerCredential: resolvedCredential,
              capturedAt: attemptedAt,
              httpStatus,
              contentType,
              bodySize,
              bodyBytes,
              state: archiveState,
            }),
            restrictedResponseArchive: restrictedArchiveEvidence({
              raw, bodyText, bodyBytes, jsonParsed,
              capturedAt: attemptedAt, httpStatus, contentType, state: archiveState,
            }),
          },
        )
      }

      let body
      try {
        body = await boundedBody(response, this.maxResponseBytes, controller)
      } catch (error) {
        const contractFailure = error instanceof BodyLimitError || error instanceof BodyEncodingError
        throw upstreamError('TikHub response could not be read safely', {
          outcome: contractFailure ? 'succeeded_unusable' : 'unknown', httpStatus, billed: null,
          errorCode: error instanceof BodyLimitError
            ? 'upstream_response_too_large'
            : error instanceof BodyEncodingError ? 'invalid_upstream_encoding'
              : controller.signal.aborted ? 'upstream_deadline_exceeded' : 'upstream_body_read_failed',
          affectsCircuit: true,
        }, error instanceof BodyEncodingError ? {
          ...archiveEvidence({
            raw: null,
            providerCredential: resolvedCredential,
            capturedAt: attemptedAt,
            httpStatus,
            contentType,
            bodySize: error.size,
            bodyBytes: error.bodyBytes,
            state: 'invalid_encoding',
          }),
          restrictedResponseArchive: restrictedArchiveEvidence({
            raw: null,
            bodyText: null,
            bodyBytes: error.bodyBytes,
            jsonParsed: false,
            capturedAt: attemptedAt,
            httpStatus,
            contentType,
            state: 'invalid_encoding',
          }),
        } : {})
      }
      let raw
      try { raw = parseJsonText(body.text) } catch {
        throw upstreamError('TikHub returned invalid JSON', {
          outcome: 'succeeded_unusable', httpStatus, billed: null,
          errorCode: 'invalid_upstream_json', affectsCircuit: true,
        }, {
          ...archiveEvidence({
            raw: null, providerCredential: resolvedCredential,
            capturedAt: attemptedAt, httpStatus, contentType,
            bodySize: body.size, bodyBytes: body.bytes, state: 'invalid_json',
          }),
          restrictedResponseArchive: restrictedArchiveEvidence({
            raw: null, bodyText: body.text, bodyBytes: body.bytes, jsonParsed: false,
            capturedAt: attemptedAt,
            httpStatus, contentType, state: 'invalid_json',
          }),
        })
      }
      const persisted = (state, at = attemptedAt) => ({
        ...archiveEvidence({
          raw, providerCredential: resolvedCredential,
          capturedAt: at, httpStatus, contentType,
          bodySize: body.size, bodyBytes: body.bytes, state,
        }),
        restrictedResponseArchive: restrictedArchiveEvidence({
          raw, bodyText: body.text, bodyBytes: body.bytes, jsonParsed: true,
          capturedAt: at, httpStatus, contentType, state,
        }),
      })
      if (!Number.isInteger(raw?.code)) {
        // A successful HTTP exchange without TikHub's numeric business code is
        // a contract drift.  We cannot prove whether the provider charged it,
        // so preserve an indeterminate billing outcome and trip the global
        // contract circuit instead of pretending it was a free bad request.
        throw upstreamError('TikHub response omitted its business status', {
          outcome: 'succeeded_unusable', httpStatus,
          businessCode: null,
          billed: null, errorCode: 'invalid_upstream_contract', affectsCircuit: true,
        }, persisted('succeeded_unusable'))
      }
      if (raw.code !== 200) {
        const businessCode = raw.code
        const globalCapacityFailure = businessCode === 429
        const globalCredentialFailure = [401, 402, 403].includes(businessCode)
        const routeContractFailure = [404, 405, 422].includes(businessCode)
        const globalProviderFailure = businessCode >= 500
        const recognizedBusinessFailure = [400, 401, 402, 403, 404, 405, 408, 422, 429]
          .includes(businessCode)
        throw upstreamError('TikHub returned a business error', {
          outcome: 'rejected', httpStatus,
          businessCode,
          billed: null,
          errorCode: globalCapacityFailure ? 'upstream_rate_limited'
            : globalCredentialFailure ? 'upstream_auth_or_balance_unavailable'
              : routeContractFailure ? 'upstream_endpoint_unavailable'
                : globalProviderFailure ? 'upstream_business_error'
                : 'upstream_request_rejected',
          affectsCircuit: globalCapacityFailure || globalCredentialFailure || routeContractFailure
            || globalProviderFailure || businessCode === 408 || !recognizedBusinessFailure,
        }, persisted('provider_rejected'))
      }
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        throw upstreamError('TikHub returned an unsupported content type', {
          outcome: 'succeeded_unusable',
          httpStatus,
          businessCode: 200,
          billed: true,
          errorCode: 'invalid_upstream_content_type',
          affectsCircuit: true,
        }, persisted('invalid_content_type'))
      }
      if (!isPostgresSafeJsonValue(raw)) {
        throw upstreamError('TikHub returned JSON that cannot be represented in PostgreSQL', {
          outcome: 'succeeded_unusable', httpStatus, businessCode: 200,
          billed: true, errorCode: 'upstream_payload_unrepresentable', affectsCircuit: true,
        }, persisted('succeeded_unusable'))
      }

      const acceptedAt = capturedAt || new Date()
      try {
        const normalized = normalizeTikHubXiaohongshuNoteResult(raw, {
          capturedAt: acceptedAt,
          providerCredential: resolvedCredential,
        })
        const item = normalized?.item
        if (!item) {
          if (!isTikHubXiaohongshuUnavailable(raw)) {
            throw upstreamError('TikHub response did not match the verified note contract', {
              outcome: 'succeeded_unusable', httpStatus, businessCode: 200,
              billed: true, errorCode: 'invalid_upstream_contract', affectsCircuit: true,
            }, persisted('succeeded_unusable', acceptedAt))
          }
          // TikHub documents a billed HTTP/business success even when a note
          // is unavailable or a short link cannot be resolved. This is a
          // request-local terminal result, not a global provider outage.
          throw upstreamError('TikHub could not return an available Xiaohongshu note', {
            outcome: 'succeeded_unusable', httpStatus, businessCode: 200,
            billed: true, errorCode: 'upstream_note_unavailable', affectsCircuit: false,
          }, persisted('succeeded_unusable', acceptedAt))
        }
        if (request.identity.noteId && item.externalId !== request.identity.noteId) {
          throw upstreamError('TikHub returned a different Xiaohongshu note', {
            outcome: 'succeeded_unusable', httpStatus, businessCode: 200,
            billed: true, errorCode: 'upstream_identity_mismatch',
          }, persisted('succeeded_unusable', acceptedAt))
        }
        const publicBody = {
          contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
          data: { item },
          meta: { capturedAt: new Date(acceptedAt).toISOString() },
        }
        const persistence = persisted('accepted', acceptedAt)
        const record = createTikHubXiaohongshuRecord(item)
        const archivedItem = record.rawItem
        const itemHash = sha256Json(archivedItem)
        persistence.archiveObjects.push({
          kind: 'item',
          marketplace: XIAOHONGSHU_PLATFORM,
          endpointVersion: TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
          capturedDate: new Date(acceptedAt).toISOString().slice(0, 10),
          archivePath: `external/tikhub/xiaohongshu/${new Date(acceptedAt).toISOString().slice(0, 10)}/items/${itemHash}.json`,
          envelopePointer: '$',
          sourceKey: item.externalId,
          payloadSha256: itemHash,
          rawPayload: archivedItem,
        })
        return securedProviderResult({
          request,
          publicBody,
          records: [record],
          archiveObjects: persistence.archiveObjects,
          responseArchive: persistence.responseArchive,
          upstreamEvidence: persistence.upstreamEvidence,
          endpointKey: TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
        }, persistence)
      } catch (error) {
        if (error instanceof TikHubUpstreamError) throw error
        throw upstreamError('TikHub response did not match the verified note contract', {
          outcome: 'succeeded_unusable', httpStatus, businessCode: 200,
          billed: true, errorCode: 'invalid_upstream_contract',
        }, persisted('succeeded_unusable', acceptedAt))
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
