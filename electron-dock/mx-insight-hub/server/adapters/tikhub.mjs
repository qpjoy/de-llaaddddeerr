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
} from '../contracts/tikhub-xiaohongshu-search.mjs'
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

function credential(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    throw new TypeError('apiKey must be a non-empty string of at most 4096 characters')
  }
  return value.trim()
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
  constructor(size) {
    super('response_invalid_utf8')
    this.size = Number.isSafeInteger(size) ? size : null
  }
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new BodyEncodingError(bytes.byteLength)
  }
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
  }
}

function archiveEvidence({
  raw,
  capturedAt,
  httpStatus,
  contentType,
  bodySize,
  state,
  endpointVersion = TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
}) {
  const sanitized = raw == null ? null : redactTikHubEnvelope(raw)
  const payloadHash = sanitized == null ? null : sha256Json(sanitized)
  return {
    responseArchive: {
      contractState: state,
      httpStatus,
      businessCode: Number.isInteger(raw?.code) ? raw.code : null,
      contentType,
      bodySize,
      payloadSha256: payloadHash,
      rawPayload: sanitized,
      capturedAt,
    },
    upstreamEvidence: {
      requestId: typeof raw?.request_id === 'string' ? raw.request_id : null,
      recordTime: null,
    },
    archiveObjects: sanitized == null ? [] : [{
      kind: 'response',
      marketplace: XIAOHONGSHU_PLATFORM,
      endpointVersion,
      capturedDate: new Date(capturedAt).toISOString().slice(0, 10),
      archivePath: `external/tikhub/xiaohongshu/${new Date(capturedAt).toISOString().slice(0, 10)}/responses/${payloadHash}.json`,
      envelopePointer: '$',
      sourceKey: payloadHash,
      payloadSha256: payloadHash,
      rawPayload: sanitized,
      contractState: state,
      contentType,
      bodySize,
      upstreamRequestId: typeof raw?.request_id === 'string' ? raw.request_id : null,
    }],
  }
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
        headers: { accept: 'application/json', authorization: `Bearer ${resolvedCredential}` },
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch {
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
      let archiveState = 'provider_rejected'
      try {
        const body = await boundedBody(response, adapter.maxResponseBytes, controller)
        bodySize = body.size
        try { raw = JSON.parse(body.text) } catch { archiveState = 'provider_rejected_invalid_json' }
      } catch (error) {
        bodySize = error instanceof BodyLimitError ? error.size : null
        archiveState = error instanceof BodyLimitError
          ? 'provider_rejected_response_too_large'
          : 'provider_rejected_body_unreadable'
      }
      throw upstreamError(
        'TikHub rejected the request',
        httpFailureEvidence(httpStatus, Number.isInteger(raw?.code) ? raw.code : null),
        archiveEvidence({
          raw,
          capturedAt: attemptedAt,
          httpStatus,
          contentType,
          bodySize,
          state: archiveState,
          endpointVersion,
        }),
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
      })
    }
    let raw
    try { raw = JSON.parse(body.text) } catch {
      throw upstreamError('TikHub returned invalid JSON', {
        outcome: 'succeeded_unusable', httpStatus, billed: null,
        errorCode: 'invalid_upstream_json', affectsCircuit: true,
      }, archiveEvidence({
        raw: null,
        capturedAt: attemptedAt,
        httpStatus,
        contentType,
        bodySize: body.size,
        state: 'invalid_json',
        endpointVersion,
      }))
    }
    const persisted = (state, at = attemptedAt) => archiveEvidence({
      raw,
      capturedAt: at,
      httpStatus,
      contentType,
      bodySize: body.size,
      state,
      endpointVersion,
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
    return {
      raw,
      httpStatus,
      acceptedAt: capturedAt || new Date(),
      persisted,
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
      return Object.freeze({
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
      })
    } catch (error) {
      if (error instanceof TikHubUpstreamError) throw error
      throw upstreamError('TikHub response did not match the verified search contract', {
        outcome: 'succeeded_unusable', httpStatus: exchange.httpStatus, businessCode: 200,
        billed: true, errorCode: error?.code || 'invalid_upstream_contract', affectsCircuit: true,
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
          headers: { accept: 'application/json', authorization: `Bearer ${resolvedCredential}` },
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        })
      } catch {
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
        let archiveState = 'provider_rejected'
        try {
          const body = await boundedBody(response, this.maxResponseBytes, controller)
          bodySize = body.size
          try {
            raw = JSON.parse(body.text)
          } catch {
            archiveState = 'provider_rejected_invalid_json'
          }
        } catch (error) {
          bodySize = error instanceof BodyLimitError ? error.size : null
          archiveState = error instanceof BodyLimitError
            ? 'provider_rejected_response_too_large'
            : 'provider_rejected_body_unreadable'
        }
        throw upstreamError(
          'TikHub rejected the request',
          httpFailureEvidence(httpStatus, Number.isInteger(raw?.code) ? raw.code : null),
          archiveEvidence({
            raw,
            capturedAt: attemptedAt,
            httpStatus,
            contentType,
            bodySize,
            state: archiveState,
          }),
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
        })
      }
      let raw
      try { raw = JSON.parse(body.text) } catch {
        throw upstreamError('TikHub returned invalid JSON', {
          outcome: 'succeeded_unusable', httpStatus, billed: null,
          errorCode: 'invalid_upstream_json', affectsCircuit: true,
        }, archiveEvidence({
          raw: null, capturedAt: attemptedAt, httpStatus, contentType,
          bodySize: body.size, state: 'invalid_json',
        }))
      }
      const persisted = (state, at = attemptedAt) => archiveEvidence({
        raw, capturedAt: at, httpStatus, contentType,
        bodySize: body.size, state,
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

      const acceptedAt = capturedAt || new Date()
      try {
        const normalized = normalizeTikHubXiaohongshuNoteResult(raw, { capturedAt: acceptedAt })
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
        const record = createTikHubXiaohongshuRecord(item, {
          safetyLimited: normalized.safetyLimited,
        })
        // A signed media locator is retained only in the access-controlled
        // delivery snapshot used by the relay. Generic archive/canonical rows
        // must remain stable and secret-free across CDN signature rotations.
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
        return Object.freeze({
          request,
          publicBody,
          records: [record],
          archiveObjects: persistence.archiveObjects,
          responseArchive: persistence.responseArchive,
          upstreamEvidence: persistence.upstreamEvidence,
          endpointKey: TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
          safetyLimited: normalized.safetyLimited,
        })
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
