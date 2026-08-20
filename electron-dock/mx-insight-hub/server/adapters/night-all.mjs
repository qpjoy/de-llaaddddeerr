import { UpstreamAmbiguousError, UpstreamRejectedError } from '../core/errors.mjs'
import { isNightAllDataSearchV1Envelope } from '../contracts/night-all-data-search.mjs'
import {
  isNightAllLegacyEnvelope,
  NIGHT_ALL_LEGACY_OPERATIONS,
} from '../contracts/night-all-legacy.mjs'

const BLOCKED_KEYS = new Set([
  'provider',
  'providerId',
  'providerMetadata',
  'sourceProvider',
  'credentialId',
  'moduleCode',
  'endpoint',
  'endpointId',
  'sourceEndpointId',
  'businessId',
  'availabilityMode',
  'billing',
  'upstream',
  'upstreamUrl',
  'baseUrl',
])

function invalidUpstreamResponse(code) {
  const error = new Error(code)
  error.name = 'InvalidUpstreamResponseError'
  error.code = code
  return error
}

export function stripProviderMetadata(value) {
  if (Array.isArray(value)) return value.map(stripProviderMetadata)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !BLOCKED_KEYS.has(key) && !/(provider|credential|upstream|endpoint|business.?id|availability|billing)/i.test(key))
      .map(([key, nested]) => [key, stripProviderMetadata(nested)]),
  )
}

/**
 * Keep the strict Night-All-v1 item shape after removing private provider data.
 * `provider` and `endpointId` are required nullable fields in the published
 * contract, so deleting their keys would make an otherwise valid response fail
 * the contract clients already validate.
 */
export function redactNightAllDataSearchResponse(payload) {
  const redacted = stripProviderMetadata(payload)
  if (!Array.isArray(redacted?.data?.items)) return redacted
  return {
    ...redacted,
    data: {
      ...redacted.data,
      items: redacted.data.items.map((item) => ({
        ...item,
        source: { provider: null, endpointId: null },
      })),
    },
  }
}

export class NightAllAdapter {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000, serviceToken, exportToken }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.serviceToken = serviceToken
    // Separate credential from the service token: the export route returns
    // stored content in bulk, so it is scoped independently and can be rotated
    // or withdrawn without disturbing the search path.
    this.exportToken = exportToken || null
  }

  // `keepRaw` returns the pre-serving-projection payload alongside the public
  // one. Most adapter methods remove private provider metadata; the three
  // explicitly namespaced compatibility routes opt into an identity projection
  // so their legacy response body remains field-for-field compatible.
  async #request(method, path, body, validate, {
    keepRaw = false,
    token,
    timeoutMs,
    redact = stripProviderMetadata,
  } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || this.timeoutMs)
    try {
      let response
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(token || this.serviceToken
              ? { authorization: `Bearer ${token || this.serviceToken}` }
              : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        })
      } catch (error) {
        throw new UpstreamAmbiguousError('Night-All outcome is unknown', error)
      }

      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('application/json')) {
        if (response.ok) {
          throw new UpstreamAmbiguousError(
            'Night-All returned an unusable successful response; outcome is unknown',
            invalidUpstreamResponse('invalid_upstream_content_type'),
          )
        }
        throw new UpstreamRejectedError(response.status, { code: 'invalid_upstream_content_type' })
      }
      let payload
      try {
        payload = await response.json()
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new UpstreamAmbiguousError('Night-All outcome is unknown', error)
        }
        // Invalid JSON is a definite upstream contract failure. Other body
        // stream failures can happen after Night-All accepted the POST, so the
        // outcome must remain unknown rather than being retried as a 502.
        if (error instanceof SyntaxError && response.ok) {
          throw new UpstreamAmbiguousError(
            'Night-All returned invalid JSON after accepting the request; outcome is unknown',
            invalidUpstreamResponse('invalid_upstream_json'),
          )
        }
        if (error instanceof SyntaxError) payload = null
        else throw new UpstreamAmbiguousError('Night-All outcome is unknown', error)
      }
      if (!response.ok) throw new UpstreamRejectedError(response.status, payload)
      if (!payload || typeof payload !== 'object' || (validate && !validate(payload))) {
        throw new UpstreamAmbiguousError(
          'Night-All returned an invalid success envelope; outcome is unknown',
          invalidUpstreamResponse('invalid_upstream_contract'),
        )
      }
      const redacted = redact(payload)
      return keepRaw ? { payload: redacted, raw: payload } : redacted
    } finally {
      // The deadline covers both response headers and the entire JSON body.
      clearTimeout(timer)
    }
  }

  async dependencies() {
    try {
      const result = await this.#request(
        'GET',
        '/api/v1/health',
        undefined,
        (payload) => payload?.data?.ok === true || Boolean(payload?.data?.status || payload?.status),
      )
      return { status: 'up', detail: result?.data?.status || result?.status || (result?.data?.ok ? 'ready' : 'up') }
    } catch (error) {
      return { status: 'down', detail: error.name }
    }
  }

  async capabilities(allowedPlatforms) {
    const payload = await this.#request(
      'GET',
      '/api/v1/data/capabilities',
      undefined,
      (candidate) => Array.isArray(candidate?.data?.platforms),
    )
    const allow = new Set(allowedPlatforms)
    if (Array.isArray(payload?.data?.platforms)) {
      payload.data.platforms = payload.data.platforms.filter((entry) =>
        allow.has(typeof entry === 'string' ? entry : entry.platform),
      )
    }
    return payload
  }

  /**
   * Pull a page of already-collected content for backfill.
   *
   * Distinct from `search`: this reads Night-All's own store and calls no
   * provider, so it costs no upstream quota and is safe to run in a tight loop.
   * It carries its own token because it is a bulk surface — the export route is
   * the one place under /api/v1/data that returns stored content in volume.
   *
   * `keepRaw` is on for the same reason as search: provider lineage is ingest
   * evidence, stored and never served.
   */
  exportContents({ platform, since, cursor, limit }) {
    const query = new URLSearchParams({ platform })
    if (since) query.set('since', since)
    if (cursor) query.set('cursor', cursor)
    if (limit) query.set('limit', String(limit))
    return this.#request(
      'GET',
      `/api/v1/data/export?${query.toString()}`,
      undefined,
      (payload) => payload?.data && Array.isArray(payload.data.items),
      { keepRaw: true, token: this.exportToken },
    )
  }

  exportWatermarks() {
    return this.#request(
      'GET',
      '/api/v1/data/export/watermarks',
      undefined,
      (payload) => Boolean(payload?.data?.platforms),
      { token: this.exportToken },
    )
  }

  search({ body, businessId }) {
    return this.#request(
      'POST',
      '/api/v1/data/search',
      {
        ...body,
        businessId,
        availabilityMode: 'ready_only',
      },
      isNightAllDataSearchV1Envelope,
      { keepRaw: true, redact: redactNightAllDataSearchResponse },
    )
  }

  legacySearch({ operation, body, businessId }) {
    if (!NIGHT_ALL_LEGACY_OPERATIONS.has(operation)) {
      throw new TypeError(`Unsupported Night-All legacy operation: ${operation}`)
    }
    return this.#request(
      'POST',
      `/api/v1/search/${operation}`,
      { ...body, businessId },
      isNightAllLegacyEnvelope,
      // Compatibility responses intentionally retain Night-All's current data
      // fields. Hub-level masking is a separate, future serving policy.
      { keepRaw: true, redact: (payload) => payload },
    )
  }
}
