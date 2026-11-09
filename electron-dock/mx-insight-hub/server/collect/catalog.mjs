import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { COLLECT_BATCH_MAX, collectCapability } from '../../shared/collect-engines.mjs'

// Request validation for each public collection capability, and how its
// normalized input becomes an engine call. Pure functions; no I/O.

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const CLIENT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

const invalid = (message, details) => new AppError(400, 'invalid_collect_request', message, details)

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function assertIdempotencyKey(value) {
  if (!value) throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header is required')
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8-128 safe characters starting with a letter or digit')
  }
  return value
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be a JSON object`, { field: name })
  return value
}

function onlyFields(value, allowed, name) {
  const unsupported = Object.keys(value).filter(key => !allowed.includes(key))
  if (unsupported.length) throw invalid(`Unsupported fields in ${name}: ${unsupported.join(', ')}`, { fields: unsupported })
}

const CONTROL = /[\u0000-\u001f\u007f]/u
const DATE = /^\d{4}-\d{2}-\d{2}$/
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const FACEBOOK_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com'])

function text(value, name, max) {
  const value2 = typeof value === 'string' ? value.trim() : ''
  if (!value2 || [...value2].length > max || CONTROL.test(value2)) throw invalid(`${name} must be 1-${max} characters without control characters`, { field: name })
  return value2
}

function integer(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer between ${min} and ${max}`, { field: name })
  return value
}

function choice(value, name, allowed, fallback) {
  if (value === undefined || value === null) return fallback
  if (!allowed.includes(value)) throw invalid(`${name} must be one of: ${allowed.map(item => item || '(empty)').join(', ')}`, { field: name })
  return value
}

function day(value, name) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid(`${name} must be a YYYY-MM-DD date`, { field: name })
  return value
}

function uniqueList(value, name, min, max, each) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw invalid(`${name} must contain ${min}-${max} entries`, { field: name })
  const list = value.map(each)
  if (new Set(list).size !== list.length) throw invalid(`${name} must be unique`, { field: name })
  return list
}

function facebookUrl(value) {
  let url
  try { url = new URL(typeof value === 'string' ? value.trim() : '') } catch { throw invalid('urls must be Facebook page or Ad Library links', { field: 'urls' }) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !FACEBOOK_HOSTS.has(url.hostname) || url.href.length > 2_000) {
    throw invalid('urls must be https Facebook page or Ad Library links', { field: 'urls' })
  }
  return url.href
}

function domain(value) {
  const host = typeof value === 'string' ? value.trim().toLowerCase().replace(/^www\./, '') : ''
  if (!HOSTNAME.test(host)) throw invalid('domains must be bare hostnames such as example.com', { field: 'domains' })
  return host
}

// ---- capability definitions ----------------------------------------------

const APP_MARKET_IDS = Object.freeze({
  // Xiaomi app IDs are decimal store IDs; kept as strings (canonical identity).
  xiaomi: { pattern: /^[0-9]{1,20}$/, message: 'appIds must be decimal Xiaomi store IDs (1-20 digits)' },
})

const DEFINITIONS = Object.freeze({
  'collect.app.details': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['market', 'appIds'], 'input')
      const market = typeof input.market === 'string' ? input.market.trim() : ''
      const rule = APP_MARKET_IDS[market]
      if (!rule) throw invalid(`market must be one of: ${Object.keys(APP_MARKET_IDS).join(', ')}`, { field: 'market' })
      if (!Array.isArray(input.appIds) || input.appIds.length < 1 || input.appIds.length > 50) {
        throw invalid('appIds must contain 1-50 entries', { field: 'appIds' })
      }
      const appIds = input.appIds.map(value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value)
      if (!appIds.every(value => typeof value === 'string' && rule.pattern.test(value))) throw invalid(rule.message, { field: 'appIds' })
      if (new Set(appIds).size !== appIds.length) throw invalid('appIds must be unique', { field: 'appIds' })
      return { market, appIds }
    },
    routeKey: input => input.market,
    // Package 195 contract: operation collect, history is not offered.
    runner: input => ({ operation: 'collect', params: { inputs: input.appIds, input_kind: 'id', history: false } }),
    itemCount: envelope => Array.isArray(envelope?.result?.items) ? envelope.result.items.length
      : Array.isArray(envelope?.result) ? envelope.result.length : null,
  },
  // Package 111. Region is fixed to the reviewed US store.
  'collect.ecommerce.temu.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['keyword', 'sort', 'maxItems'], 'input')
      return {
        keyword: text(input.keyword, 'keyword', 100),
        sort: choice(input.sort, 'sort', ['relevance', 'top_sales', 'most_recent', 'price_low_to_high', 'price_high_to_low'], 'relevance'),
        maxItems: integer(input.maxItems, 'maxItems', 10, 200, 40),
      }
    },
    apify: { actorId: 'dXoeNAkKt3ZRfOKvx', actor: 'crw/temu-products-scraper', build: '0.0.452' },
    actorInput: input => ({ keyword: input.keyword, region: 'US', sort: input.sort, max_items: input.maxItems }),
    resultLimit: input => input.maxItems,
  },
  // Package 202. Details, About pages and ecommerce enrichment stay off.
  'collect.ads.meta.library': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['urls', 'resultsLimit', 'activeStatus', 'newerThan', 'olderThan'], 'input')
      const normalized = {
        urls: uniqueList(input.urls, 'urls', 1, 10, facebookUrl),
        resultsLimit: integer(input.resultsLimit, 'resultsLimit', 1, 200, 20),
        activeStatus: choice(input.activeStatus, 'activeStatus', ['', 'active', 'inactive'], ''),
        newerThan: day(input.newerThan, 'newerThan'),
        olderThan: day(input.olderThan, 'olderThan'),
      }
      if (normalized.newerThan && normalized.olderThan && normalized.newerThan > normalized.olderThan) {
        throw invalid('newerThan must not be later than olderThan', { field: 'newerThan' })
      }
      return normalized
    },
    apify: { actorId: 'JJghSZmShuco4j9gJ', actor: 'apify/facebook-ads-scraper', build: '0.0.375' },
    actorInput: input => ({
      startUrls: input.urls.map(url => ({ url })), resultsLimit: input.resultsLimit, activeStatus: input.activeStatus,
      onlyTotal: false, includeAboutPage: false, isDetailsPerAd: false, enrichWithEcommerceData: false,
      ...(input.newerThan ? { onlyAdsNewerThan: input.newerThan } : {}), ...(input.olderThan ? { onlyAdsOlderThan: input.olderThan } : {}),
    }),
    resultLimit: input => Math.min(1_000, input.resultsLimit * input.urls.length),
  },
  // Package 185.
  'collect.web.similarweb.overview': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['domains'], 'input')
      return { domains: uniqueList(input.domains, 'domains', 1, 10, domain) }
    },
    apify: { actorId: 'heLi1j7hzjC2gFlIx', actor: 'tri_angle/similarweb-scraper', build: '0.0.82' },
    actorInput: input => ({ websites: input.domains }),
    resultLimit: input => Math.min(100, input.domains.length * 5),
  },
})

export function capabilityDefinition(key) {
  const shared = typeof key === 'string' ? collectCapability(key) : null
  const definition = shared ? DEFINITIONS[key] : null
  if (!shared || !definition) return null
  return { ...shared, ...definition }
}

export function requireCapability(key) {
  const definition = capabilityDefinition(key)
  if (!definition) throw invalid('capability is not a supported collection capability', { field: 'capability' })
  return definition
}

function normalizeItem(definition, body, { allowClientRef }) {
  object(body, allowClientRef ? 'item' : 'body')
  onlyFields(body, allowClientRef ? ['input', 'clientRef'] : ['capability', 'input'], allowClientRef ? 'item' : 'body')
  const input = definition.normalize(body.input)
  let clientRef = null
  if (allowClientRef && body.clientRef !== undefined) {
    if (typeof body.clientRef !== 'string' || !CLIENT_REF.test(body.clientRef)) throw invalid('clientRef must be 1-64 safe characters', { field: 'clientRef' })
    clientRef = body.clientRef
  }
  return { clientRef, input, routeKey: definition.routeKey ? definition.routeKey(input) : '', fingerprint: fingerprint({ capability: definition.key, input }) }
}

export function normalizeJobRequest(body) {
  object(body, 'body')
  const definition = requireCapability(body.capability)
  return { definition, item: normalizeItem(definition, body, { allowClientRef: false }) }
}

export function normalizeBatchRequest(body) {
  object(body, 'body')
  onlyFields(body, ['capability', 'items'], 'body')
  const definition = requireCapability(body.capability)
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > COLLECT_BATCH_MAX) {
    throw invalid(`items must contain 1-${COLLECT_BATCH_MAX} entries`, { field: 'items' })
  }
  const items = body.items.map(item => normalizeItem(definition, item, { allowClientRef: true }))
  const refs = items.map(item => item.clientRef).filter(Boolean)
  if (new Set(refs).size !== refs.length) throw invalid('clientRef values must be unique', { field: 'clientRef' })
  return { definition, items, fingerprint: fingerprint({ capability: definition.key, items: items.map(({ clientRef, input }) => ({ clientRef, input })) }) }
}
