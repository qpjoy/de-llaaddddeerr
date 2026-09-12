import { createHash } from 'node:crypto'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'
import { HUB_USER_AGENT } from '../core/outbound-identity.mjs'
import {
  assertBoundedJson,
  classifyJustOneBusinessCode,
  createJustOneCallArchiveObject,
  inspectJustOneEnvelope,
  normalizeJustOneProductSearchRequest,
  redactJustOnePrivateFields,
} from '../contracts/justone.mjs'
import {
  normalizeJustOneResourceRequest,
  normalizeJustOneResourceResponse,
} from '../contracts/justone-resources.mjs'
import {
  normalizeSocialAccountSearchRequest,
  normalizeSocialAccountSearchResponse,
} from '../contracts/social-accounts.mjs'
import { normalizeSocialAccountArchiveObjects } from '../ingest/social-accounts.mjs'
import {
  normalizeJustOneProductSearchPayload,
  prepareJustOneArchiveObjects,
} from '../ingest/justone.mjs'

export const JUSTONE_BASE_URL = 'https://api.justoneapi.com'
export const JUSTONE_DEFAULT_TIMEOUT_MS = 60_000
export const JUSTONE_MAX_TIMEOUT_MS = 120_000
export const JUSTONE_DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
export const JUSTONE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

function normalizedCredential(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    throw new TypeError('token must be a non-empty string of at most 4096 characters')
  }
  return value.trim()
}

class BodyLimitError extends Error {
  constructor(bodySize = null) {
    super('response_too_large')
    this.bodySize = Number.isSafeInteger(bodySize) ? bodySize : null
  }
}

const BUSINESS_CIRCUIT_POLICY = Object.freeze({
  request: Object.freeze({ circuitCategory: 'request', affectsCircuit: false }),
  authentication: Object.freeze({ circuitCategory: 'authentication', affectsCircuit: true }),
  authorization: Object.freeze({ circuitCategory: 'authentication', affectsCircuit: true }),
  rate_limit: Object.freeze({ circuitCategory: 'capacity', affectsCircuit: true }),
  quota: Object.freeze({ circuitCategory: 'capacity', affectsCircuit: true }),
  balance: Object.freeze({ circuitCategory: 'capacity', affectsCircuit: true }),
  collection: Object.freeze({ circuitCategory: 'upstream', affectsCircuit: true }),
  upstream: Object.freeze({ circuitCategory: 'upstream', affectsCircuit: true }),
  unknown: Object.freeze({ circuitCategory: 'contract', affectsCircuit: true }),
})

const TRANSPORT_ERROR_CODES = new Set([
  'invalid_upstream_response',
  'upstream_body_read_failed',
  'upstream_deadline_exceeded',
  'upstream_transport_error',
])

function evidence({
  outcome,
  httpStatus = null,
  businessCode = null,
  billed,
  errorCode,
  circuitCategory,
  affectsCircuit,
}) {
  return Object.freeze({
    outcome,
    httpStatus,
    businessCode,
    // JustOne documents code=0 as a charged successful upstream result and
    // non-zero business codes as uncharged. Transport-only outcomes stay unknown.
    billed: typeof billed === 'boolean'
      ? billed
      : businessCode === 0
        ? true
        : Number.isInteger(businessCode) ? false : null,
    errorCode,
    circuitCategory,
    affectsCircuit,
    // The request may already have consumed quota. A caller may choose stale
    // fallback, but it must never blindly redispatch this paid call.
    retryable: false,
  })
}

export class JustOneUpstreamError extends Error {
  constructor(name, message, errorEvidence, archiveObjects = [], restrictedResponseArchive = null) {
    super(message)
    this.name = name
    this.evidence = Object.freeze({ ...errorEvidence })
    // Full provider evidence is deliberately opt-in for the persistence layer;
    // ordinary error serialization and HTTP handling only see safe evidence.
    Object.defineProperty(this, 'archiveObjects', {
      value: Object.freeze([...archiveObjects]),
      enumerable: false,
    })
    Object.defineProperty(this, 'restrictedResponseArchive', {
      value: restrictedResponseArchive,
      enumerable: false,
    })
  }
}

export class JustOneRejectedError extends JustOneUpstreamError {
  constructor(errorEvidence, archiveObjects, restrictedResponseArchive = null) {
    super(
      'JustOneRejectedError',
      'Upstream rejected the product search request',
      errorEvidence,
      archiveObjects,
      restrictedResponseArchive,
    )
  }
}

export class JustOneAmbiguousError extends JustOneUpstreamError {
  constructor(errorEvidence, archiveObjects, restrictedResponseArchive = null) {
    super(
      'JustOneAmbiguousError',
      'Upstream product search outcome is unknown',
      errorEvidence,
      archiveObjects,
      restrictedResponseArchive,
    )
  }
}

export class JustOneSucceededUnusableError extends JustOneUpstreamError {
  constructor(errorEvidence, archiveObjects, restrictedResponseArchive = null) {
    super(
      'JustOneSucceededUnusableError',
      'Upstream charged a successful result that the Hub could not safely use',
      errorEvidence,
      archiveObjects,
      restrictedResponseArchive,
    )
  }
}

function boundedInteger(value, { name, fallback, min, max }) {
  const parsed = value ?? fallback
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

async function readBoundedBody(response, maxBytes, controller) {
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    controller.abort()
    throw new BodyLimitError(declaredLength)
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new BodyLimitError(bytes.byteLength)
    return {
      bytes: Buffer.from(bytes),
      bodySize: bytes.byteLength,
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
      if (size > maxBytes) {
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
    bytes: Buffer.from(bytes),
    bodySize: bytes.byteLength,
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function restrictedResponseArchive(context) {
  if (!Buffer.isBuffer(context?.bodyBytes)) return null
  const jsonParsed = context.jsonParsed === true
  let parsedPayload = null
  if (jsonParsed && isPostgresSafeJsonValue(context.raw)) {
    try {
      parsedPayload = structuredClone(context.raw)
    } catch {
      // Exact bytes remain authoritative. The JSONB convenience projection is
      // optional when a valid, byte-bounded response is too deep to clone.
      parsedPayload = null
    }
  }
  return Object.freeze({
    capturedAt: new Date(context.capturedAt).toISOString(),
    contentType: context.contentType ?? null,
    bodySize: context.bodyBytes.byteLength,
    bodySha256: sha256(context.bodyBytes),
    bodyBytes: Buffer.from(context.bodyBytes),
    bodyText: isPostgresSafeText(context.bodyText)
      ? context.bodyText
      : null,
    jsonParsed,
    parsedPayload,
  })
}

function archiveObjects({
  raw = null,
  request,
  capturedAt,
  httpStatus = null,
  outcome,
  businessCode = null,
  billed = null,
  errorCode,
  bodySha256 = null,
  bodySize = null,
  contentType = null,
  contractState,
  secret,
}) {
  const archive = createJustOneCallArchiveObject(raw, request, {
    capturedAt,
    httpStatus,
    outcome,
    businessCode,
    billed,
    errorCode,
    bodySha256,
    bodySize,
    contentType,
    contractState,
    secret,
  })
  return prepareJustOneArchiveObjects([archive], request, { capturedAt })
}

function rejected(httpStatus, businessCode, errorCode, context) {
  const classification = classifyJustOneBusinessCode(businessCode)
  const circuit = BUSINESS_CIRCUIT_POLICY[classification?.category || 'unknown']
  const errorEvidence = evidence({
    outcome: 'rejected',
    httpStatus,
    businessCode,
    errorCode,
    ...circuit,
  })
  return new JustOneRejectedError(
    errorEvidence,
    archiveObjects({
      ...context,
      ...errorEvidence,
      contractState: context?.contractState || 'provider_rejected',
    }),
    restrictedResponseArchive(context),
  )
}

function ambiguous(httpStatus, errorCode, context) {
  const errorEvidence = evidence({
    outcome: 'unknown',
    httpStatus,
    errorCode,
    circuitCategory: TRANSPORT_ERROR_CODES.has(errorCode) ? 'transport' : 'contract',
    affectsCircuit: true,
  })
  return new JustOneAmbiguousError(
    errorEvidence,
    archiveObjects({ ...context, ...errorEvidence, contractState: context?.contractState || 'unknown' }),
    restrictedResponseArchive(context),
  )
}

function succeededUnusable(httpStatus, errorCode, context) {
  const errorEvidence = evidence({
    outcome: 'succeeded_unusable',
    httpStatus,
    businessCode: 0,
    billed: true,
    errorCode,
    circuitCategory: 'contract',
    affectsCircuit: true,
  })
  return new JustOneSucceededUnusableError(
    errorEvidence,
    archiveObjects({
      ...context,
      ...errorEvidence,
      contractState: context?.contractState || 'succeeded_unusable',
    }),
    restrictedResponseArchive(context),
  )
}

export class JustOneAdapter {
  #fallbackToken
  #credentialResolver

  constructor({
    token = null,
    credentialResolver = null,
    fetchImpl = globalThis.fetch,
    timeoutMs = JUSTONE_DEFAULT_TIMEOUT_MS,
    maxResponseBytes = JUSTONE_DEFAULT_MAX_RESPONSE_BYTES,
    // Used only to report a response shape the contract does not accept yet.
    // Optional so every existing construction keeps working unchanged.
    logger = null,
  } = {}) {
    const fallbackToken = normalizedCredential(token)
    if (credentialResolver != null && typeof credentialResolver !== 'function') {
      throw new TypeError('credentialResolver must be a function')
    }
    if (!fallbackToken && !credentialResolver) {
      throw new TypeError('token or credentialResolver is required')
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
    this.#fallbackToken = fallbackToken
    this.#credentialResolver = credentialResolver
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.timeoutMs = boundedInteger(timeoutMs, {
      name: 'timeoutMs',
      fallback: JUSTONE_DEFAULT_TIMEOUT_MS,
      min: 1,
      max: JUSTONE_MAX_TIMEOUT_MS,
    })
    this.maxResponseBytes = boundedInteger(maxResponseBytes, {
      name: 'maxResponseBytes',
      fallback: JUSTONE_DEFAULT_MAX_RESPONSE_BYTES,
      min: 1_024,
      max: JUSTONE_MAX_RESPONSE_BYTES,
    })
  }

  async resolveCredential() {
    const dynamicToken = this.#credentialResolver
      ? await this.#credentialResolver()
      : null
    return normalizedCredential(dynamicToken) || this.#fallbackToken
  }

  async searchProducts(body, {
    decodeCursor,
    encodeCursor,
    maxPageSize,
    capturedAt = null,
    credential: suppliedCredential,
  } = {}) {
    const credential = await this.#credentialFor(suppliedCredential)
    const request = normalizeJustOneProductSearchRequest(body, { decodeCursor, maxPageSize })
    return this.#dispatch({
      request,
      credential,
      capturedAt,
      normalize: (raw, context) => normalizeJustOneProductSearchPayload(raw, request, {
        encodeCursor,
        capturedAt: context.capturedAt,
        httpStatus: context.httpStatus,
        bodySha256: context.bodySha256,
        bodySize: context.bodySize,
        contentType: context.contentType,
        contractState: 'accepted',
        secret: credential,
      }),
    })
  }

  // Fetch one registry-declared resource. The payload keeps the provider's own
  // field names, so this path adds no marketplace-specific extraction; it is
  // the same transport, envelope and evidence handling as product search.
  async fetchResource(resourceKey, body, {
    capturedAt = null,
    deliveryModes,
    credential: suppliedCredential,
  } = {}) {
    const credential = await this.#credentialFor(suppliedCredential)
    const request = normalizeJustOneResourceRequest(resourceKey, body, { deliveryModes })
    return this.#dispatch({
      request,
      credential,
      capturedAt,
      normalize: (raw, context) => {
        const normalized = normalizeJustOneResourceResponse(raw, request, {
          capturedAt: context.capturedAt,
          assertBounded: assertBoundedJson,
        })
        return {
          publicBody: normalized.publicBody,
          // One provider-call evidence object per dispatch, identical in shape
          // to the one product search records, so a paid resource call is as
          // auditable as a paid search call.
          archiveObjects: Object.freeze([createJustOneCallArchiveObject(raw, request, {
            capturedAt: context.capturedAt,
            httpStatus: context.httpStatus,
            outcome: 'success',
            businessCode: Number.isInteger(raw?.code) ? raw.code : null,
            billed: true,
            bodySha256: context.bodySha256,
            bodySize: context.bodySize,
            contentType: context.contentType,
            contractState: 'accepted',
            secret: credential,
          })]),
          // This contract extracts no per-item projection, because an untyped
          // payload gives no reviewed item identity to extract. Zero is the
          // honest count; the payload itself is retained in the call evidence
          // and in restricted storage.
          items: Object.freeze([]),
        }
      },
    })
  }

  // Keyword account search. The response is normalized (not passed through)
  // because its four upstream shapes differ wildly and the target is a
  // canonical dataset, which needs one record shape.
  async searchAccounts(body, { capturedAt = null, deliveryModes, credential: suppliedCredential } = {}) {
    const credential = await this.#credentialFor(suppliedCredential)
    const request = normalizeSocialAccountSearchRequest(body, { deliveryModes })
    return this.#dispatch({
      request,
      credential,
      capturedAt,
      normalize: (raw, context) => {
        const normalized = normalizeSocialAccountSearchResponse(raw, request, {
          capturedAt: context.capturedAt,
        })
        const ingest = normalizeSocialAccountArchiveObjects(normalized.archiveObjects, request, {
          capturedAt: context.capturedAt,
        })
        return {
          publicBody: normalized.publicBody,
          items: normalized.accounts,
          records: ingest.records,
          archiveObjects: Object.freeze([
            createJustOneCallArchiveObject(raw, request, {
              capturedAt: context.capturedAt,
              httpStatus: context.httpStatus,
              outcome: 'success',
              businessCode: Number.isInteger(raw?.code) ? raw.code : null,
              billed: true,
              bodySha256: context.bodySha256,
              bodySize: context.bodySize,
              contentType: context.contentType,
              contractState: 'accepted',
              secret: credential,
            }),
            ...normalized.archiveObjects.map((object) => Object.freeze({
              ...object,
              rawItem: redactJustOnePrivateFields(object.rawItem, { secret: credential }),
              rawPayload: redactJustOnePrivateFields(object.rawPayload, { secret: credential }),
            })),
          ]),
        }
      },
    })
  }

  async #credentialFor(suppliedCredential) {
    const credential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : normalizedCredential(suppliedCredential)
    if (!credential) throw new TypeError('JustOne credential is unavailable')
    return credential
  }

  async #dispatch({ request, credential, capturedAt, normalize }) {
    const url = new URL(request.endpointPath, JUSTONE_BASE_URL)
    url.searchParams.set('token', credential)
    for (const [key, value] of Object.entries(request.upstreamQuery)) {
      url.searchParams.set(key, value)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    // Failed/ambiguous calls retain an attempt timestamp. Successful calls get
    // a later capture timestamp only after the complete body and envelope have
    // passed the acceptance checks below.
    const attemptCapturedAt = capturedAt ?? new Date()
    const baseArchiveContext = { request, capturedAt: attemptCapturedAt, secret: credential }
    let response
    try {
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': HUB_USER_AGENT },
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        })
      } catch {
        throw ambiguous(
          null,
          controller.signal.aborted ? 'upstream_deadline_exceeded' : 'upstream_transport_error',
          { ...baseArchiveContext, contractState: 'transport_unavailable' },
        )
      }

      const httpStatus = Number.isInteger(response?.status)
        && response.status >= 100
        && response.status <= 599
        ? response.status
        : null
      if (httpStatus === null || typeof response?.ok !== 'boolean' || !response.headers?.get) {
        throw ambiguous(httpStatus, 'invalid_upstream_response', {
          ...baseArchiveContext,
          contractState: 'invalid_transport_response',
        })
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase().slice(0, 256)

      let bodyResult
      try {
        bodyResult = await readBoundedBody(response, this.maxResponseBytes, controller)
      } catch (error) {
        const context = {
          ...baseArchiveContext,
          contentType,
          bodySize: error instanceof BodyLimitError ? error.bodySize : null,
          contractState: error instanceof BodyLimitError ? 'response_too_large' : 'body_unreadable',
        }
        if (error instanceof BodyLimitError) {
          throw ambiguous(httpStatus, 'upstream_response_too_large', context)
        }
        throw ambiguous(
          httpStatus,
          controller.signal.aborted ? 'upstream_deadline_exceeded' : 'upstream_body_read_failed',
          context,
        )
      }
      const { bytes, bodySize } = bodyResult
      const bodySha256 = sha256(bytes)
      const responseContext = {
        ...baseArchiveContext,
        httpStatus,
        contentType,
        bodySize,
        bodySha256,
        bodyBytes: bytes,
        bodyText: null,
        jsonParsed: false,
      }

      let text
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        throw ambiguous(httpStatus, 'upstream_body_read_failed', {
          ...responseContext,
          contractState: 'body_unreadable',
        })
      }
      responseContext.bodyText = text

      let raw
      try {
        raw = JSON.parse(text.codePointAt(0) === 0xfeff ? text.slice(1) : text)
      } catch {
        const context = { ...responseContext, contractState: 'invalid_json' }
        throw ambiguous(httpStatus, 'invalid_upstream_json', context)
      }
      const parsedContext = { ...responseContext, raw, jsonParsed: true }
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        const context = { ...parsedContext, contractState: 'invalid_content_type' }
        if (!response.ok) {
          throw ambiguous(httpStatus, 'invalid_upstream_content_type', context)
        }
        const inspected = inspectJustOneEnvelope(raw)
        if (inspected.outcome === 'rejected') {
          throw rejected(
            httpStatus,
            raw.code,
            inspected.classification?.errorCode || 'upstream_business_error',
            context,
          )
        }
        if (inspected.outcome === 'success') {
          throw succeededUnusable(httpStatus, 'invalid_upstream_content_type', context)
        }
        throw ambiguous(httpStatus, 'invalid_upstream_content_type', context)
      }
      const inspected = inspectJustOneEnvelope(raw)
      if (!response.ok) {
        if (inspected.outcome === 'rejected') {
          const classification = inspected.classification || classifyJustOneBusinessCode(raw.code)
          throw rejected(
            httpStatus,
            raw.code,
            classification?.errorCode || 'upstream_business_error',
            { ...parsedContext, contractState: 'provider_rejected' },
          )
        }
        if (inspected.outcome === 'success') {
          throw succeededUnusable(httpStatus, 'upstream_status_envelope_conflict', {
            ...parsedContext,
            contractState: 'status_envelope_conflict',
          })
        }
        throw ambiguous(httpStatus, 'invalid_upstream_envelope', {
          ...parsedContext,
          contractState: 'invalid_http_error_envelope',
        })
      }
      if (inspected.outcome === 'invalid') {
        throw ambiguous(httpStatus, 'invalid_upstream_envelope', {
          ...parsedContext,
          contractState: 'invalid_envelope',
        })
      }
      if (inspected.outcome === 'rejected') {
        throw rejected(
          httpStatus,
          raw.code,
          inspected.classification?.errorCode || 'upstream_business_error',
          { ...parsedContext, contractState: 'provider_rejected' },
        )
      }

      if (!isPostgresSafeJsonValue(raw)) {
        throw succeededUnusable(httpStatus, 'upstream_payload_unrepresentable', {
          ...parsedContext,
          contractState: 'succeeded_unusable',
        })
      }

      const acceptedCapturedAt = capturedAt ?? new Date()
      let normalized
      try {
        normalized = normalize(raw, {
          capturedAt: acceptedCapturedAt,
          httpStatus,
          bodySha256,
          bodySize,
          contentType,
        })
      } catch (error) {
        if (error instanceof JustOneUpstreamError) throw error
        // The accepted item paths are a closed set on purpose: a new upstream
        // shape is meant to arrive with a reviewed fixture rather than be
        // guessed at. That is only actionable if the shape can be seen, and the
        // response body itself is never archived for an unusable call -- so the
        // keys-and-types outline is logged here, values excluded.
        if (error?.observedShape) {
          this.logger?.warn?.({
            marketplace: request?.marketplace ?? null,
            errorCode: error.code,
            triedPaths: error.triedPaths,
            observedShape: error.observedShape,
          }, '[external-platform] upstream response shape is not in the accepted set')
        }
        throw succeededUnusable(
          httpStatus,
          error?.code || 'invalid_upstream_contract',
          {
            ...parsedContext,
            capturedAt: acceptedCapturedAt,
            contractState: 'succeeded_unusable',
          },
        )
      }
      const result = {
        ...normalized,
        payload: normalized.publicBody,
        raw: redactJustOnePrivateFields(raw, { secret: credential }),
      }
      // Gateway orchestration can inspect the normalized dispatch, while an
      // accidental JSON spread cannot expose an upstream continuation field.
      Object.defineProperty(result, 'request', { value: request, enumerable: false })
      Object.defineProperty(result, 'restrictedResponseArchive', {
        value: restrictedResponseArchive({
          ...parsedContext,
          capturedAt: acceptedCapturedAt,
        }),
        enumerable: false,
      })
      return Object.freeze(result)
    } finally {
      clearTimeout(timer)
    }
  }
}
