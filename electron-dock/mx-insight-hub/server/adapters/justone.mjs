import { createHash } from 'node:crypto'
import {
  classifyJustOneBusinessCode,
  createJustOneCallArchiveObject,
  inspectJustOneEnvelope,
  normalizeJustOneProductSearchRequest,
  redactJustOnePrivateFields,
} from '../contracts/justone.mjs'
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
  constructor(name, message, errorEvidence, archiveObjects = []) {
    super(message)
    this.name = name
    this.evidence = Object.freeze({ ...errorEvidence })
    // Full provider evidence is deliberately opt-in for the persistence layer;
    // ordinary error serialization and HTTP handling only see safe evidence.
    Object.defineProperty(this, 'archiveObjects', {
      value: Object.freeze([...archiveObjects]),
      enumerable: false,
    })
  }
}

export class JustOneRejectedError extends JustOneUpstreamError {
  constructor(errorEvidence, archiveObjects) {
    super('JustOneRejectedError', 'Upstream rejected the product search request', errorEvidence, archiveObjects)
  }
}

export class JustOneAmbiguousError extends JustOneUpstreamError {
  constructor(errorEvidence, archiveObjects) {
    super('JustOneAmbiguousError', 'Upstream product search outcome is unknown', errorEvidence, archiveObjects)
  }
}

export class JustOneSucceededUnusableError extends JustOneUpstreamError {
  constructor(errorEvidence, archiveObjects) {
    super(
      'JustOneSucceededUnusableError',
      'Upstream charged a successful result that the Hub could not safely use',
      errorEvidence,
      archiveObjects,
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
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
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
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    bodySize: bytes.byteLength,
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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
    const credential = suppliedCredential === undefined
      ? await this.resolveCredential()
      : normalizedCredential(suppliedCredential)
    if (!credential) throw new TypeError('JustOne credential is unavailable')
    const request = normalizeJustOneProductSearchRequest(body, { decodeCursor, maxPageSize })
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
          headers: { accept: 'application/json' },
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
      const { text, bodySize } = bodyResult
      const bodySha256 = sha256(text)
      const responseContext = {
        ...baseArchiveContext,
        httpStatus,
        contentType,
        bodySize,
        bodySha256,
      }

      let raw
      try {
        raw = JSON.parse(text)
      } catch {
        const context = { ...responseContext, contractState: 'invalid_json' }
        throw ambiguous(httpStatus, 'invalid_upstream_json', context)
      }
      const parsedContext = { ...responseContext, raw }
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

      const acceptedCapturedAt = capturedAt ?? new Date()
      let normalized
      try {
        normalized = normalizeJustOneProductSearchPayload(raw, request, {
          encodeCursor,
          capturedAt: acceptedCapturedAt,
          httpStatus,
          bodySha256,
          bodySize,
          contentType,
          contractState: 'accepted',
          secret: credential,
        })
      } catch (error) {
        if (error instanceof JustOneUpstreamError) throw error
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
      return Object.freeze(result)
    } finally {
      clearTimeout(timer)
    }
  }
}
