import snapshot from '../data/night-all-provider-inventory.json' with { type: 'json' }
import { AppError } from '../core/errors.mjs'

export const NATIVE_FORWARDING_VERSION = 'mx-insight-hub.native-forwarding.v1'
const PRIVATE_PARAMS = new Set(['cookie', 'token', 'api_key', 'authorization', 'password', 'proxy'])
const FAMILY = { tikhub: 't', justone: 'j' }

// Only this reviewed, code-owned list can dispatch. The catalog/database may
// describe more candidates but can never turn a user-supplied URL into a route.
export const NATIVE_FORWARDING_ENDPOINTS = Object.freeze(snapshot.endpoints
  .filter(row => row.forwarding === 'implemented_disabled')
  .map(row => {
    const key = `${FAMILY[row.provider]}.${row.id.replace(/^(tikhub|justone)_/, '')}`
    return Object.freeze({ ...row, key,
      operation: `native.${key}`, endpointKey: `native.${key}`,
      hubPath: `/api/v1/data/native/${key}`,
      authorizationPlatform: row.platform === 'xianyu' ? 'ecommerce' : 'social',
      parameters: Object.freeze(row.parameters.filter(p => !PRIVATE_PARAMS.has(p.name)).map(p => Object.freeze({ ...p }))),
      fixedQuery: Object.freeze({ ...row.fixedQuery }),
    })
  }))
const byKey = new Map(NATIVE_FORWARDING_ENDPOINTS.map(row => [row.key, row]))
const byPath = new Map(NATIVE_FORWARDING_ENDPOINTS.map(row => [row.hubPath, row]))
export const nativeForwardingEndpoint = key => byKey.get(key) || null
export const nativeForwardingByPath = path => byPath.get(path) || null

export function nativeForwardingOperations(provider) {
  return NATIVE_FORWARDING_ENDPOINTS.filter(row => row.provider === provider).map(row => ({
    operationKey: row.operation, label: `${row.platform} · 原生 ${row.key}`,
    legacyGate: 'nativeForwardingVerified', contractVersion: NATIVE_FORWARDING_VERSION,
    endpointKeys: [row.endpointKey],
  }))
}

export function normalizeNativeForwardingRequest(key, body, { maxPageSize = 100 } = {}) {
  const endpoint = byKey.get(key)
  if (!endpoint) throw new AppError(404, 'native_endpoint_not_found', 'Unknown native data endpoint')
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(name => !['params', 'deliveryMode'].includes(name))
    || !body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
    throw new AppError(400, 'invalid_native_request', 'Submit an object with params and optional deliveryMode')
  }
  if (body.deliveryMode !== undefined && body.deliveryMode !== 'live_only') {
    throw new AppError(400, 'invalid_delivery_mode', 'Native forwarding supports live_only')
  }
  const allowed = new Set(endpoint.parameters.map(p => p.name))
  if (Object.keys(body.params).some(name => !allowed.has(name))) {
    throw new AppError(400, 'unsupported_request_field', 'params contains an undeclared field')
  }
  const query = { ...endpoint.fixedQuery }
  for (const p of endpoint.parameters) {
    const value = body.params[p.name]
    if (value === undefined) {
      if (p.required) throw new AppError(400, 'missing_parameter', `${p.name} is required`)
      continue
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))
      || (typeof value === 'string' && (value.length > 8192 || value.includes('\u0000') || (p.required && !value.trim())))) {
      throw new AppError(400, 'invalid_parameter', `${p.name} must be a bounded scalar`)
    }
    if (['count', 'limit', 'page_size', 'first', 'last'].includes(p.name)
      && (typeof value === 'boolean' || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maxPageSize)) {
      throw new AppError(400, 'invalid_page_size', `${p.name} must be between 1 and ${maxPageSize}`)
    }
    query[p.name] = value
  }
  return Object.freeze({
    key, maxPageSize, contractVersion: NATIVE_FORWARDING_VERSION, endpointContractVersion: NATIVE_FORWARDING_VERSION,
    operation: endpoint.operation, endpointKey: endpoint.endpointKey, endpointVersion: snapshot.version,
    endpointPath: endpoint.path, method: endpoint.method, marketplace: endpoint.platform,
    deliveryMode: 'live_only', upstreamQuery: Object.freeze(query),
    fingerprintBody: { contractVersion: NATIVE_FORWARDING_VERSION, key, params: query, deliveryMode: 'live_only' },
  })
}

export function nativeForwardingPayload(data, request, capturedAt) {
  return { contractVersion: NATIVE_FORWARDING_VERSION, endpoint: request.key, data,
    meta: { capturedAt: new Date(capturedAt).toISOString(), projection: 'native', pagination: 'explicit_parameters' } }
}
