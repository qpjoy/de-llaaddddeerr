import { readFileSync } from 'node:fs'
import { AppError } from '../core/errors.mjs'

export const ENTERPRISE_PLATFORM = 'enterprise'
export const ENTERPRISE_CAPABILITY = 'enterprise.query'
export const ENTERPRISE_VERSION = 'mx-insight-hub.enterprise-query.v1'
export const ENTERPRISE_DATASET = 'enterprise.responses.v1'
export const QIXIN_CATALOG = JSON.parse(readFileSync(new URL('../external-platforms/qixin-catalog.json', import.meta.url), 'utf8'))
export const enterpriseOperation = id => `enterprise.api.${id}`
export const enterpriseEndpoint = id => `enterprise.${id}`
const apis = new Map(QIXIN_CATALOG.apis.map(api => [api.api_id, api]))
const optional = { '19.91': { query: ['match_type'] }, '42.3': { body: ['industry', 'regist_capi', 'status'] } }
const alternatives = { '66.35': ['keyword', 'import_keyword'], '22.11': ['kind_id', 'register_no'] }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const present = (value, key) => Object.hasOwn(value, key) && value[key] !== null && value[key] !== ''
const invalid = message => { throw new AppError(400, 'invalid_enterprise_request', message) }

export function enterpriseApi(id) {
  const api = apis.get(id)
  if (!api) throw new AppError(404, 'enterprise_api_not_found', 'Unknown enterprise API')
  return api
}

export function enterpriseFields(api, section) {
  return api[section].map(field => ({ ...field,
    required: optional[api.api_id]?.[section]?.includes(field.name) ? 0 : field.required,
  }))
}

export function normalizeEnterpriseRequest(id, input) {
  const api = enterpriseApi(id)
  if (!object(input) || Object.keys(input).some(key => !['query', 'body', 'method', 'deliveryMode'].includes(key))) invalid('Only query, body, method and deliveryMode are accepted')
  const method = input.method ?? (api.methods.includes('GET') ? 'GET' : 'POST')
  if (!api.methods.includes(method)) invalid('Unsupported method for this API')
  const deliveryMode = input.deliveryMode ?? 'live_only'
  if (!['live_only', 'cache_only', 'cache_first', 'refresh'].includes(deliveryMode)) invalid('Invalid deliveryMode')
  for (const section of ['query', 'body']) {
    const values = input[section] ?? {}
    if (!object(values)) invalid(`${section} must be an object`)
    const fields = enterpriseFields(api, section)
    if (Object.keys(values).some(key => !fields.some(field => field.name === key))) invalid(`Undocumented ${section} field`)
    for (const field of fields) {
      if (field.required === 1 && !present(values, field.name)) invalid(`Missing ${section}.${field.name}`)
      if (!present(values, field.name)) continue
      const value = values[field.name]
      if (field.type.toLowerCase() === 'string' && typeof value !== 'string') invalid(`${section}.${field.name} must be a string`)
      if (field.type.toLowerCase() === 'number' && (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)))) invalid(`${section}.${field.name} must be finite numeric data`)
      if (typeof value === 'string' && (value.length > 16000 || /[\u0000\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')))) invalid('Invalid parameter text')
    }
  }
  if (input.body != null && api.body.length === 0) invalid('This API has no JSON body')
  if (method === 'GET' && input.body != null) invalid('GET does not accept a JSON body')
  if (alternatives[id] && !alternatives[id].some(key => present(input.query ?? {}, key))) invalid(`Provide one of ${alternatives[id].join(', ')}`)
  const query = Object.fromEntries(Object.entries(input.query ?? {}).filter(([, value]) => value != null))
  const body = input.body ?? null
  return { api, method, query, body, deliveryMode, marketplace: ENTERPRISE_PLATFORM,
    endpointKey: enterpriseEndpoint(id), endpointVersion: 'qixin-auth-v2.catalog-2026-09-01',
    endpointContractVersion: ENTERPRISE_VERSION, fingerprintBody: { apiId: id, method, query, body },
  }
}

export const QIXIN_CONFIG = Object.freeze({ contractVerified: false, configured: false,
  maxConcurrency: 3, maxConsumerConcurrency: 1, maxRequestsPerMinute: 30,
  freshTtlMs: 3600000, staleTtlMs: 86400000,
  billing: { currency: 'CNY', source: 'unknown', pricingAsOf: null, freeDailyCalls: null,
    unitCostMinorByEndpoint: {}, monthlyBudgetMinor: null, monthlySubsidyBudgetMinor: null },
})

export const QIXIN_OPERATIONS = QIXIN_CATALOG.apis.map(api => Object.freeze({
  operationKey: enterpriseOperation(api.api_id), label: `${api.api_id} · ${api.api_name}`,
  legacyGate: 'contractVerified', contractVersion: ENTERPRISE_VERSION,
  endpointKeys: [enterpriseEndpoint(api.api_id)], allowZeroCost: api.price === 0,
}))
