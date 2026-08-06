import { UpstreamAmbiguousError, UpstreamRejectedError } from '../core/errors.mjs'

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

export function stripProviderMetadata(value) {
  if (Array.isArray(value)) return value.map(stripProviderMetadata)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !BLOCKED_KEYS.has(key) && !/(provider|credential|upstream|endpoint|business.?id|availability|billing)/i.test(key))
      .map(([key, nested]) => [key, stripProviderMetadata(nested)]),
  )
}

export class NightAllAdapter {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000, serviceToken }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.serviceToken = serviceToken
  }

  // `keepRaw` returns the pre-redaction payload alongside the public one.
  // Provider/endpoint identifiers are ingest lineage evidence; they are stored,
  // never served, so the redacted copy remains the only thing callers can see.
  async #request(method, path, body, validate, { keepRaw = false } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(this.serviceToken ? { authorization: `Bearer ${this.serviceToken}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } catch (error) {
      throw new UpstreamAmbiguousError('Night-All outcome is unknown', error)
    } finally {
      clearTimeout(timer)
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new UpstreamRejectedError(502, { code: 'invalid_upstream_content_type' })
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (!response.ok) throw new UpstreamRejectedError(response.status, payload)
    if (!payload || typeof payload !== 'object' || (validate && !validate(payload))) {
      throw new UpstreamRejectedError(502, { code: 'invalid_upstream_contract' })
    }
    const redacted = stripProviderMetadata(payload)
    return keepRaw ? { payload: redacted, raw: payload } : redacted
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

  search({ body, businessId }) {
    return this.#request(
      'POST',
      '/api/v1/data/search',
      {
        ...body,
        businessId,
        availabilityMode: 'ready_only',
      },
      (payload) => payload?.data && typeof payload.data === 'object' && Array.isArray(payload.data.items),
      { keepRaw: true },
    )
  }
}
