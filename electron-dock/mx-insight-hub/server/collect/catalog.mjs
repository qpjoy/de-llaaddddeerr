import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { AppError } from '../core/errors.mjs'
import { COLLECT_BATCH_MAX, collectCapability } from '../../shared/collect-engines.mjs'
import { DNS_RESOLVERS, DNS_TYPES, dnsLookup } from './native/dns.mjs'
import { rdapDomain } from './native/rdap.mjs'
import { ctIssuances } from './native/ct.mjs'
import { subdomains } from './native/subdomains.mjs'

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

function price(value, name) {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0 || value > 100_000_000) throw invalid(`${name} must be a non-negative integer`, { field: name })
  return value
}

function priceRange(input) {
  const range = { minPrice: price(input.minPrice, 'minPrice'), maxPrice: price(input.maxPrice, 'maxPrice') }
  if (range.minPrice != null && range.maxPrice != null && range.minPrice > range.maxPrice) throw invalid('minPrice must not exceed maxPrice', { field: 'minPrice' })
  return range
}

function flag(value, name) {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw invalid(`${name} must be a boolean`, { field: name })
  return value
}

const keywordList = (value, max = 5) => uniqueList(value, 'keywords', 1, max, item => text(item, 'keywords', 100))
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined))

// Exactly one way in: a keyword search or reviewed links on the platform's own hosts.
function oneOf(input, keys) {
  const present = keys.filter(key => input[key] !== undefined && input[key] !== null)
  if (present.length !== 1) throw invalid(`exactly one of ${keys.join(', ')} is required`, { field: keys[0] })
  return present[0]
}

function hostUrl(value, hosts, name) {
  let url
  try { url = new URL(typeof value === 'string' ? value.trim() : '') } catch { throw invalid(`${name} must be https links on the platform`, { field: name }) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname) || url.href.length > 2_000) {
    throw invalid(`${name} must be https links on the platform`, { field: name })
  }
  return url.href
}

const AMAZON_MARKETS = Object.freeze({ US: 'amazon.com', UK: 'amazon.co.uk', DE: 'amazon.de', FR: 'amazon.fr', IT: 'amazon.it', ES: 'amazon.es',
  CA: 'amazon.ca', JP: 'amazon.co.jp', AU: 'amazon.com.au', IN: 'amazon.in', MX: 'amazon.com.mx' })
const AMAZON_HOSTS = new Set(Object.values(AMAZON_MARKETS).flatMap(host => [host, `www.${host}`]))
const SHOPEE_HOSTS = Object.freeze({ BR: 'shopee.com.br', ID: 'shopee.co.id', TH: 'shopee.co.th', MY: 'shopee.com.my', SG: 'shopee.sg',
  PH: 'shopee.ph', VN: 'shopee.vn', MX: 'shopee.com.mx' })
const ETSY_COUNTRIES = ['US', 'GB', 'CA', 'AU', 'NZ', 'DE', 'FR', 'IT', 'ES', 'NL', 'IE', 'BE', 'AT', 'PT', 'JP', 'BR', 'MX', 'CH', 'SE', 'NO', 'DK', 'PL']
const ALIEXPRESS_SITES = ['aliexpress.com', 'aliexpress.us', 'de.aliexpress.com', 'fr.aliexpress.com', 'es.aliexpress.com', 'it.aliexpress.com',
  'pt.aliexpress.com', 'ru.aliexpress.com']
const COUNTRY = /^[A-Z]{2}$/
const MERCADOLIBRE_COUNTRIES = ['MX', 'AR', 'BR', 'EC', 'DO', 'CL', 'CO', 'PE', 'UY']
const UK_COMPANY_NUMBER = /^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/

// A link on one host whose path starts with one of the reviewed prefixes.
function pathUrl(value, hostOk, prefixes, name) {
  let url
  try { url = new URL(typeof value === 'string' ? value.trim() : '') } catch { throw invalid(`${name} must be a reviewed https link`, { field: name }) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hostOk(url.hostname) || url.href.length > 2_000
    || !prefixes.some(prefix => url.pathname.startsWith(prefix))) throw invalid(`${name} must be a reviewed https link`, { field: name })
  return url.href
}

const CRAIGSLIST_HOST = /^[a-z0-9-]{2,40}\.craigslist\.org$/
const TRIP_HOST = /^(?:[a-z]{2,3}\.)?trip\.com$|^www\.trip\.com$/

// Public DNS names only. Internal-looking suffixes are refused outright even
// though lookups go to public resolvers.
const PRIVATE_SUFFIXES = ['local', 'localhost', 'internal', 'intranet', 'lan', 'home', 'corp', 'svc', 'arpa', 'invalid', 'test', 'example']
function dnsName(value, name, { underscore = false } = {}) {
  const raw = typeof value === 'string' ? value.trim().replace(/\.$/, '') : ''
  const ascii = raw && !raw.includes('/') && !raw.includes(':') ? domainToASCII(raw.toLowerCase()) : ''
  const label = underscore ? /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?$/ : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  const labels = ascii ? ascii.split('.') : []
  if (!ascii || ascii.length > 253 || labels.length < 2 || isIP(ascii) || !labels.every(part => label.test(part))
    || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)) || PRIVATE_SUFFIXES.includes(labels.at(-1))) {
    throw invalid(`${name} must be a public DNS name such as example.com (not a URL or IP)`, { field: name })
  }
  return ascii
}

function inRange(address, base, bits) {
  const toInt = ip => ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
  return Math.floor(toInt(address) / 2 ** (32 - bits)) === Math.floor(toInt(base) / 2 ** (32 - bits))
}
const PRIVATE_V4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]
function publicIp(value) {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const version = isIP(address)
  const refused = () => invalid('ip must be a public IPv4 or IPv6 address', { field: 'ip' })
  if (version === 4) { if (PRIVATE_V4.some(([base, bits]) => inRange(address, base, bits))) throw refused(); return address }
  if (version === 6) { if (address === '::' || address === '::1' || /^(?:f[c-d]|fe[89ab]|ff)/.test(address) || address.startsWith('::ffff:')) throw refused(); return address }
  throw refused()
}

const SHODAN_QUERY = (value, name = 'query') => text(value, name, 1_000)
const SHODAN_FACETS = /^[a-z0-9_.]+(?::[0-9]{1,4})?(?:,[a-z0-9_.]+(?::[0-9]{1,4})?){0,9}$/
function facets(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !SHODAN_FACETS.test(value)) throw invalid('facets must be up to 10 comma-separated facet names such as country,port:10', { field: 'facets' })
  return value
}

function ukCompanyNumber(value) {
  let number = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim().toUpperCase() : ''
  if (/^[0-9]{1,8}$/.test(number)) number = number.padStart(8, '0')
  if (!UK_COMPANY_NUMBER.test(number)) throw invalid('companyNumbers must be 8-character Companies House numbers such as 00000006 or SC123456', { field: 'companyNumbers' })
  return number
}

function domain(value) {
  const host = typeof value === 'string' ? value.trim().toLowerCase().replace(/^www\./, '') : ''
  if (!HOSTNAME.test(host)) throw invalid('domains must be bare hostnames such as example.com', { field: 'domains' })
  return host
}

// ---- capability definitions ----------------------------------------------

// App markets of collect.app.details (packages 195/197/198/216/217/219 share
// one Scrapy template; 193 is Google Play). Identifiers stay strings: the
// canonical identity is market + identifier, never a number.
const NUMERIC_ID = /^[0-9]{1,20}$/
const ANDROID_PACKAGE = /^(?=.{3,255}$)[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/
const APP_ID_KINDS = Object.freeze({
  id: { pattern: NUMERIC_ID, message: 'decimal store IDs (1-20 digits)' },
  pid: { pattern: NUMERIC_ID, message: 'decimal Baidu pid values (1-20 digits)' },
  docid: { pattern: NUMERIC_ID, message: 'decimal Baidu docid values (1-20 digits)' },
  package: { pattern: ANDROID_PACKAGE, message: 'Android package names such as com.tencent.mm' },
})
const APP_MARKETS = Object.freeze({
  xiaomi: { idKinds: ['id'] },
  vivo: { idKinds: ['id'] },
  tencent: { idKinds: ['package'] },
  // History is a bounded list of past versions, not a complete archive.
  baidu: { idKinds: ['package', 'pid', 'docid'], historyKinds: ['pid'] },
  lenovo: { idKinds: ['package'] },
  wandoujia: { idKinds: ['id'], historyKinds: ['id'] },
  // One app per call (package 193 `app` operation); batches fan out.
  googleplay: { idKinds: ['package'], maxIds: 1, store: true },
})
const APP_IDS_MAX = 50
const APP_HISTORY_IDS_MAX = 10
const GP_COUNTRY = /^[a-z]{2}$/
const GP_LANG = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/

function storeLocale(input, { country = true } = {}) {
  const out = {}
  if (country) {
    const value = input.country === undefined || input.country === null ? 'us' : typeof input.country === 'string' ? input.country.trim().toLowerCase() : ''
    if (!GP_COUNTRY.test(value)) throw invalid('country must be a two-letter store country code such as us', { field: 'country' })
    out.country = value
  }
  const lang = input.lang === undefined || input.lang === null ? 'en' : typeof input.lang === 'string' ? input.lang.trim() : ''
  if (!GP_LANG.test(lang)) throw invalid('lang must be a language code such as en or zh-CN', { field: 'lang' })
  out.lang = lang
  return out
}

const playPackage = (value, name = 'appId') => {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!ANDROID_PACKAGE.test(id)) throw invalid(`${name} must be an Android package name such as com.google.android.apps.translate`, { field: name })
  return id
}

// Adapter results keep the SDK object: { status, data: { items: [...] }, ... }.
const sdkItemCount = envelope => {
  const result = envelope?.result
  if (Array.isArray(result?.data?.items)) return result.data.items.length
  if (Array.isArray(result?.items)) return result.items.length
  return Array.isArray(result) ? result.length : null
}

function googlePlay(operation, fields, normalize, params) {
  return {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, fields, 'input')
      return normalize(input)
    },
    runner: input => ({ operation, params: params(input) }),
    itemCount: sdkItemCount,
  }
}

// Phase 5 link rules: each site accepts only its own hosts and the link
// shapes its package was accepted on. Custom domains (a Substack or Medium
// publication on its own domain) are refused: the runner shares the Hub
// node's network, so it must never be pointed at an arbitrary host.
const PINTEREST_HOST = /^(?:(?:www|[a-z]{2})\.)?pinterest\.(?:com|ca|de|fr|es|it|jp|ch|at|nz|ie|pt|se|dk|cl|ph|co\.uk|co\.kr|com\.au|com\.mx)$/
const SUBDOMAIN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\./
const URL_SITES = Object.freeze({
  pinterest: { host: host => PINTEREST_HOST.test(host) || host === 'pin.it',
    path: url => (url.hostname === 'pin.it' ? /^\/[A-Za-z0-9]{4,20}\/?$/ : /^\/pin\/[A-Za-z0-9_-]{5,40}\/?$/).test(url.pathname),
    shape: 'a pin link such as https://www.pinterest.com/pin/858146903966145189/ or https://pin.it/xxxx' },
  medium: { host: host => host === 'medium.com' || host === 'www.medium.com' || (/^[a-z0-9-]{1,63}\.medium\.com$/.test(host) && !host.startsWith('www.')),
    path: url => /^\/p\/[0-9a-f]{8,16}\/?$/.test(url.pathname) || /(?:^|[/-])[0-9a-f]{8,16}\/?$/.test(url.pathname.replace(/^\/@?[^/]+(?=\/)/, '')),
    shape: 'an article link such as https://medium.com/@author/title-1a2b3c4d5e6f' },
  snapchat: { host: host => host === 'www.snapchat.com' || host === 'snapchat.com', path: url => /^\/spotlight\/[A-Za-z0-9_-]{10,200}\/?$/.test(url.pathname),
    shape: 'a Spotlight link such as https://www.snapchat.com/spotlight/<id>' },
  dailymotion: { host: host => ['www.dailymotion.com', 'dailymotion.com', 'dai.ly'].includes(host),
    path: url => (url.hostname === 'dai.ly' ? /^\/[A-Za-z0-9]{5,12}\/?$/ : /^\/video\/[A-Za-z0-9]{5,12}\/?$/).test(url.pathname),
    shape: 'a video link such as https://www.dailymotion.com/video/xhfpjn' },
  // Clips and past broadcasts only; live channels were never accepted.
  kick: { host: host => host === 'kick.com' || host === 'www.kick.com', keep: ['clip'],
    path: url => /^\/[A-Za-z0-9_-]{1,64}\/(?:clips\/clip_[A-Za-z0-9_-]{6,64}|videos\/[0-9a-f-]{36})\/?$/i.test(url.pathname)
      || (/^\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname) && /^clip_[A-Za-z0-9_-]{6,64}$/.test(url.searchParams.get('clip') || '')),
    shape: 'a clip or video link such as https://kick.com/<channel>?clip=clip_<id> or https://kick.com/<channel>/videos/<uuid>' },
  substack: { host: host => /^[a-z0-9-]{1,63}\.substack\.com$/.test(host) && !['www', 'api', 'on'].includes(SUBDOMAIN.exec(host)?.[1]),
    path: url => url.pathname === '/' || url.pathname === '', root: true, shape: 'a newsletter address such as https://example.substack.com' },
  wordpress: { host: host => /^[a-z0-9-]{1,63}\.wordpress\.com$/.test(host) && !['www', 'public-api', 'subscribe', 'en', 'developer'].includes(SUBDOMAIN.exec(host)?.[1]),
    path: url => url.pathname === '/' || url.pathname === '', root: true, shape: 'a blog address such as https://example.wordpress.com' },
})

function siteUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  let url
  try { url = new URL(raw) } catch { throw invalid('url must be a complete https link', { field: 'url' }) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || raw.length > 2_000 || CONTROL.test(raw)) {
    throw invalid('url must be an https link without credentials or a port', { field: 'url' })
  }
  const host = url.hostname.toLowerCase()
  const site = Object.keys(URL_SITES).find(key => URL_SITES[key].host(host))
  if (!site) throw invalid(`url host is not supported; sites: ${Object.keys(URL_SITES).join(', ')}`, { field: 'url' })
  const rule = URL_SITES[site]
  if (!rule.path(url)) throw invalid(`${site} url must be ${rule.shape}`, { field: 'url' })
  const query = new URLSearchParams()
  for (const key of rule.keep || []) if (url.searchParams.has(key)) query.set(key, url.searchParams.get(key))
  // Site addresses go without a trailing slash: the libraries append their
  // own paths (Substack builds `<address>/api/v1/archive`).
  if (rule.root) return { site, url: `https://${host}` }
  return { site, url: `https://${host}${url.pathname || '/'}${query.size ? `?${query}` : ''}` }
}

const siteOf = envelope => {
  try { return Object.keys(URL_SITES).find(key => URL_SITES[key].host(new URL(envelope.result.target).hostname)) || '' } catch { return '' }
}

// Items each package's result carries (envelope.result is the collector record).
const URL_ITEM_COUNT = Object.freeze({
  pinterest: data => (Array.isArray(data?.messages) ? data.messages.filter(message => Array.isArray(message) && Number(message[0]) === 3).length : 0),
  medium: data => (data?.markdown ? 1 : 0),
  snapchat: data => (data?.id ? 1 : 0), dailymotion: data => (data?.id ? 1 : 0), kick: data => (data?.id ? 1 : 0),
  substack: data => (Array.isArray(data?.posts) ? data.posts.length : 0),
  wordpress: data => (Array.isArray(data?.articles) ? data.articles.length : 0),
})

// Phase 6 audio (packages 45, 46, 220, 222). Stable platform IDs only; the
// packages' built-in sample IDs are never used (an ID list is required).
const XYZ_ID = /^[a-f0-9]{24}$/
const XIMALAYA_TRACK = /^[1-9][0-9]{0,14}$/
const AUDIO_SHOWS_MAX = 20
const AUDIO_EPISODE_SHOWS_MAX = 10

function audioIds(value, name, pattern, max, message) {
  return uniqueList(value, name, 1, max, item => {
    const id = typeof item === 'string' ? item.trim().toLowerCase() : typeof item === 'number' && Number.isSafeInteger(item) ? String(item) : ''
    if (!pattern.test(id)) throw invalid(`${name} must be ${message}`, { field: name })
    return id
  })
}

// Normalized show selection per platform; `max` bounds how many shows one
// call may touch (lower when episodes are collected too).
function audioShows(input, max, extra = []) {
  object(input, 'input')
  const platform = typeof input.platform === 'string' ? input.platform.trim() : ''
  const fields = {
    xiaoyuzhou: ['podcastIds', 'episodeIds'], ximalaya: ['trackIds'], apple: ['mode', 'keyword', 'genreId', 'country', 'limit'], librivox: ['offset', 'limit'],
  }[platform]
  if (!fields) throw invalid('platform must be one of: xiaoyuzhou, ximalaya, apple, librivox', { field: 'platform' })
  onlyFields(input, ['platform', ...fields, ...extra], 'input')
  if (platform === 'xiaoyuzhou') {
    if ((input.podcastIds === undefined) === (input.episodeIds === undefined)) throw invalid('give exactly one of podcastIds or episodeIds', { field: 'podcastIds' })
    const key = input.podcastIds !== undefined ? 'podcastIds' : 'episodeIds'
    return { platform, [key]: audioIds(input[key], key, XYZ_ID, max, '24-character lowercase hex 小宇宙 IDs') }
  }
  if (platform === 'ximalaya') return { platform, trackIds: audioIds(input.trackIds, 'trackIds', XIMALAYA_TRACK, max, 'decimal 喜马拉雅 track IDs') }
  if (platform === 'apple') {
    const mode = choice(input.mode, 'mode', ['search', 'charts'], 'search')
    const country = input.country === undefined || input.country === null ? 'us' : typeof input.country === 'string' ? input.country.trim().toLowerCase() : ''
    if (!/^[a-z]{2}$/.test(country)) throw invalid('country must be a two-letter store country code such as us', { field: 'country' })
    if (mode === 'search' && input.genreId !== undefined) throw invalid('genreId is only for mode charts', { field: 'genreId' })
    if (mode === 'charts' && input.keyword !== undefined) throw invalid('keyword is only for mode search', { field: 'keyword' })
    const genreId = mode === 'charts' ? Number(typeof input.genreId === 'string' && /^[0-9]{1,6}$/.test(input.genreId.trim()) ? input.genreId.trim() : input.genreId) : null
    if (mode === 'charts' && !(Number.isInteger(genreId) && genreId >= 1 && genreId <= 100_000)) throw invalid('genreId must be an Apple Podcasts genre ID such as 1318', { field: 'genreId' })
    return compact({ platform, mode, keyword: mode === 'search' ? text(input.keyword, 'keyword', 200) : null, genreId, country, limit: integer(input.limit, 'limit', 1, max, Math.min(10, max)) })
  }
  return { platform, offset: integer(input.offset, 'offset', 0, 1_000_000, 0), limit: integer(input.limit, 'limit', 1, max, Math.min(10, max)) }
}

// The package `discover` parameters for a normalized selection.
function discoverParams(input) {
  const common = { request_timeout: 30, total_timeout: 120 }
  if (input.platform === 'xiaoyuzhou') {
    return input.podcastIds ? { ...common, podcast_ids: input.podcastIds, limit: input.podcastIds.length } : { ...common, episode_ids: input.episodeIds, limit: input.episodeIds.length }
  }
  if (input.platform === 'ximalaya') return { ...common, track_ids: input.trackIds, limit: input.trackIds.length }
  if (input.platform === 'apple') return compact({ ...common, mode: input.mode, keyword: input.keyword, genre_id: input.genreId, country: input.country, limit: input.limit })
  return { ...common, offset: input.offset, limit: input.limit }
}
const showCount = input => input.podcastIds?.length ?? input.episodeIds?.length ?? input.trackIds?.length ?? input.limit
const audioItems = envelope => (Array.isArray(envelope?.result?.items) ? envelope.result.items.length : null)

const DEFINITIONS = Object.freeze({
  'collect.audio.shows': {
    normalize: input => audioShows(input, AUDIO_SHOWS_MAX),
    routeKey: input => input.platform,
    runner: input => ({ operation: 'discover', params: discoverParams(input) }),
    itemCount: audioItems,
  },
  // discover then collect in one invocation and one fresh run_dir: collect
  // takes exactly the shows discover just stored.
  'collect.audio.episodes': {
    normalize(input) {
      const shows = audioShows(input, AUDIO_EPISODE_SHOWS_MAX, ['episodesPerShow'])
      return { ...shows, episodesPerShow: integer(input.episodesPerShow, 'episodesPerShow', 1, 50, 10) }
    },
    routeKey: input => input.platform,
    runner(input) {
      const { episodesPerShow, ...shows } = input
      const collect = { request_timeout: 30, total_timeout: 300, feed_limit: showCount(shows), episodes_per_feed: episodesPerShow,
        // 喜马拉雅: no neighbour probing; enough track pages for the episodes asked for.
        ...(input.platform === 'ximalaya' ? { probe_range: 0, max_track_requests: Math.max(10, Math.min(50, episodesPerShow)) } : {}) }
      return { steps: [{ operation: 'discover', params: discoverParams(shows) }, { operation: 'collect', params: collect }] }
    },
    itemCount: audioItems,
  },
  'collect.web.url.details': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['url'], 'input')
      return siteUrl(input.url)
    },
    routeKey: input => input.site,
    // Package defaults: one link, 110 s for the whole worker; nothing else is
    // passed (work_dir belongs to the runner).
    runner: input => ({ operation: 'collect', params: { target: input.url, timeout: 110 } }),
    itemCount: envelope => (envelope?.status === 'success' ? URL_ITEM_COUNT[envelope?.result?.data ? siteOf(envelope) : '']?.(envelope.result.data) ?? null : 0),
  },
  'collect.intel.subdomains': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['domain', 'sources', 'maxIssuances'], 'input')
      const sources = input.sources === undefined || input.sources === null ? ['certspotter', 'crtsh']
        : uniqueList(input.sources, 'sources', 1, 2, value => choice(value, 'sources', ['certspotter', 'crtsh']))
      return { domain: dnsName(input.domain, 'domain'), sources: [...sources].sort(), maxIssuances: integer(input.maxIssuances, 'maxIssuances', 10, 1_000, 500) }
    },
    native: { run: subdomains },
    resultLimit: input => input.maxIssuances,
  },
  'collect.app.details': {
    normalize(input) {
      object(input, 'input')
      const market = typeof input.market === 'string' ? input.market.trim() : ''
      const rule = APP_MARKETS[market]
      if (!rule) throw invalid(`market must be one of: ${Object.keys(APP_MARKETS).join(', ')}`, { field: 'market' })
      onlyFields(input, ['market', 'appIds', 'idKind', ...(rule.historyKinds ? ['history', 'historyLimit'] : []), ...(rule.store ? ['country', 'lang'] : [])], 'input')
      const idKind = choice(input.idKind, 'idKind', rule.idKinds, rule.idKinds[0])
      const history = flag(input.history, 'history')
      if (history && !rule.historyKinds?.includes(idKind)) throw invalid(`history is only available for ${market} with idKind ${rule.historyKinds?.join('/') || '(none)'}`, { field: 'history' })
      const max = rule.maxIds || (history ? APP_HISTORY_IDS_MAX : APP_IDS_MAX)
      const kind = APP_ID_KINDS[idKind]
      const appIds = uniqueList(input.appIds, 'appIds', 1, max, value => {
        const id = typeof value === 'number' && Number.isSafeInteger(value) && idKind !== 'package' ? String(value) : typeof value === 'string' ? value.trim() : value
        if (typeof id !== 'string' || !kind.pattern.test(id)) throw invalid(`appIds must be ${kind.message} for ${market}`, { field: 'appIds' })
        return id
      })
      return compact({ market, appIds, idKind, history: rule.historyKinds ? history : null,
        historyLimit: history ? integer(input.historyLimit, 'historyLimit', 1, 5, 3) : null,
        ...(rule.store ? storeLocale(input) : {}) })
    },
    routeKey: input => input.market,
    runner(input) {
      if (input.market === 'googleplay') {
        return { operation: 'app', params: { app_id: input.appIds[0], country: input.country, lang: input.lang } }
      }
      // Request budget and wall clock grow with the batch; delay and the
      // adapter's own per-call concurrency stay at the reviewed defaults.
      const perId = input.history ? input.historyLimit + 3 : 3
      const maxRequests = Math.min(200, Math.max(10, input.appIds.length * perId))
      return { operation: 'collect', params: {
        inputs: input.appIds, input_kind: input.idKind, history: Boolean(input.history),
        ...(input.history ? { history_limit: input.historyLimit } : {}),
        max_requests: maxRequests, timeout: Math.min(300, 60 + maxRequests),
      } }
    },
    itemCount: sdkItemCount,
  },
  // Package 193, Google Play. `categories` never passed live acceptance.
  'collect.app.googleplay.search': googlePlay('search', ['term', 'num', 'country', 'lang'],
    input => ({ term: text(input.term, 'term', 100), num: integer(input.num, 'num', 1, 50, 20), ...storeLocale(input) }),
    input => ({ term: input.term, num: input.num, country: input.country, lang: input.lang })),
  'collect.app.googleplay.reviews': googlePlay('reviews', ['appId', 'sort', 'maxPages', 'nextPageToken', 'country', 'lang'],
    input => {
      let token = null
      if (input.nextPageToken !== undefined && input.nextPageToken !== null) {
        token = typeof input.nextPageToken === 'string' ? input.nextPageToken.trim() : ''
        if (!token || token.length > 4096 || CONTROL.test(token)) throw invalid('nextPageToken must be the token from a previous reviews result', { field: 'nextPageToken' })
      }
      return compact({ appId: playPackage(input.appId), sort: choice(input.sort, 'sort', ['newest', 'rating', 'helpfulness'], 'newest'),
        maxPages: integer(input.maxPages, 'maxPages', 1, 5, 1), nextPageToken: token, ...storeLocale(input) })
    },
    input => compact({ app_id: input.appId, sort: input.sort, max_pages: input.maxPages, next_page_token: input.nextPageToken, country: input.country, lang: input.lang })),
  'collect.app.googleplay.charts': googlePlay('list', ['collection', 'category', 'num', 'country', 'lang'],
    input => {
      let category = null
      if (input.category !== undefined && input.category !== null) {
        category = typeof input.category === 'string' ? input.category.trim() : ''
        if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(category)) throw invalid('category must be a Google Play category constant such as GAME_ACTION', { field: 'category' })
      }
      return compact({ collection: choice(input.collection, 'collection', ['TOP_FREE', 'TOP_PAID', 'GROSSING'], 'TOP_FREE'), category,
        num: integer(input.num, 'num', 1, 100, 20), ...storeLocale(input) })
    },
    input => compact({ collection: input.collection, category: input.category, num: input.num, country: input.country, lang: input.lang })),
  'collect.app.googleplay.developer': googlePlay('developer', ['developerId', 'num', 'country', 'lang'],
    input => ({ developerId: text(input.developerId, 'developerId', 200), num: integer(input.num, 'num', 1, 100, 20), ...storeLocale(input) }),
    input => ({ developer_id: input.developerId, num: input.num, country: input.country, lang: input.lang })),
  'collect.app.googleplay.suggest': googlePlay('suggest', ['term', 'country', 'lang'],
    input => ({ term: text(input.term, 'term', 100), ...storeLocale(input) }),
    input => ({ term: input.term, country: input.country, lang: input.lang })),
  'collect.app.googleplay.similar': googlePlay('similar', ['appId', 'country', 'lang'],
    input => ({ appId: playPackage(input.appId), ...storeLocale(input) }),
    input => ({ app_id: input.appId, country: input.country, lang: input.lang })),
  'collect.app.googleplay.permissions': googlePlay('permissions', ['appId', 'country', 'lang'],
    input => ({ appId: playPackage(input.appId), ...storeLocale(input) }),
    input => ({ app_id: input.appId, country: input.country, lang: input.lang })),
  // The data safety page does not reliably follow `country` upstream, so it
  // is not offered rather than silently ignored.
  'collect.app.googleplay.datasafety': googlePlay('datasafety', ['appId', 'lang'],
    input => ({ appId: playPackage(input.appId), ...storeLocale(input, { country: false }) }),
    input => ({ app_id: input.appId, lang: input.lang })),
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
  // Package 108. Sellers, offers, variant prices and the CAPTCHA solver stay off.
  'collect.ecommerce.amazon.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['keyword', 'marketplace', 'urls', 'maxItems'], 'input')
      const mode = oneOf(input, ['keyword', 'urls'])
      const maxItems = integer(input.maxItems, 'maxItems', 1, 100, 20)
      if (mode === 'keyword') {
        return { keyword: text(input.keyword, 'keyword', 100), marketplace: choice(input.marketplace, 'marketplace', Object.keys(AMAZON_MARKETS), 'US'), maxItems }
      }
      if (input.marketplace !== undefined) throw invalid('marketplace applies to keyword search only; links carry their own site', { field: 'marketplace' })
      return { urls: uniqueList(input.urls, 'urls', 1, 10, value => hostUrl(value, AMAZON_HOSTS, 'urls')), maxItems }
    },
    apify: { actorId: 'BG3WDrGdteHgZgbPK', actor: 'junglee/Amazon-crawler', build: '0.0.433' },
    actorInput: input => ({
      categoryOrProductUrls: (input.urls || [`https://www.${AMAZON_MARKETS[input.marketplace]}/s?k=${encodeURIComponent(input.keyword)}`]).map(url => ({ url })),
      maxItemsPerStartUrl: input.maxItems, maxSearchPagesPerStartUrl: Math.min(5, Math.ceil(input.maxItems / 20)),
      scrapeSellers: false, maxOffers: 0, useCaptchaSolver: false, scrapeProductVariantPrices: false, maxProductVariantsAsSeparateResults: 0,
    }),
    resultLimit: input => Math.min(1_000, input.maxItems * (input.urls?.length || 1)),
  },
  // Package 109.
  'collect.ecommerce.ebay.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['keywords', 'marketplace', 'maxItems', 'sort', 'condition', 'listingType', 'minPrice', 'maxPrice'], 'input')
      return {
        keywords: keywordList(input.keywords),
        marketplace: choice(input.marketplace, 'marketplace', ['US', 'UK', 'DE', 'FR', 'IT', 'ES', 'CA', 'AU'], 'US'),
        maxItems: integer(input.maxItems, 'maxItems', 1, 200, 50),
        sort: choice(input.sort, 'sort', ['best_match', 'ending_soonest', 'newly_listed', 'price_low', 'price_high'], 'best_match'),
        condition: input.condition === undefined || input.condition === null ? [] : uniqueList(input.condition, 'condition', 1, 5,
          value => choice(value, 'condition', ['new', 'open_box', 'refurbished', 'used', 'for_parts'])),
        listingType: choice(input.listingType, 'listingType', ['all', 'auction', 'buy_it_now'], 'all'),
        ...priceRange(input),
      }
    },
    apify: { actorId: 'Y7h6Aodb7ZXkv6Ieb', actor: 'automation-lab/ebay-scraper', build: '0.1.36' },
    actorInput: input => compact({
      searchQueries: input.keywords, marketplace: input.marketplace, maxProductsPerSearch: input.maxItems,
      maxSearchPages: Math.min(20, Math.ceil(input.maxItems / 60)), sort: input.sort, listingType: input.listingType,
      condition: input.condition.length ? input.condition : null, minPrice: input.minPrice, maxPrice: input.maxPrice, maxRequestRetries: 3,
    }),
    resultLimit: input => Math.min(1_000, input.maxItems * input.keywords.length),
  },
  // Package 110. Detail pages and reviews stay off (separate capabilities later).
  'collect.ecommerce.aliexpress.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['keyword', 'site', 'shipCountry', 'maxItems'], 'input')
      const shipCountry = input.shipCountry === undefined || input.shipCountry === null ? 'US' : input.shipCountry
      if (typeof shipCountry !== 'string' || !COUNTRY.test(shipCountry)) throw invalid('shipCountry must be an ISO 3166-1 alpha-2 code such as US', { field: 'shipCountry' })
      return { keyword: text(input.keyword, 'keyword', 100), site: choice(input.site, 'site', ALIEXPRESS_SITES, 'aliexpress.com'), shipCountry,
        maxItems: integer(input.maxItems, 'maxItems', 1, 200, 50) }
    },
    apify: { actorId: 'UR7eULfh4hq61XjRe', actor: 'khadinakbar/aliexpress-all-in-one-scraper', build: '1.1.4' },
    actorInput: input => ({ searchQuery: input.keyword, maxResults: input.maxItems, detailedItems: false, includeReviews: false,
      site: input.site, shipCountry: input.shipCountry }),
    resultLimit: input => input.maxItems,
  },
  // Package 113. Sponsored listings are excluded unless asked for.
  'collect.ecommerce.etsy.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['keywords', 'country', 'sort', 'maxItems', 'minPrice', 'maxPrice', 'onSaleOnly', 'freeShippingOnly', 'handmadeOnly', 'includeAds'], 'input')
      return {
        keywords: keywordList(input.keywords),
        country: choice(input.country, 'country', ETSY_COUNTRIES, 'US'),
        sort: choice(input.sort, 'sort', ['score', 'carts', 'lastsale', 'created', 'price-asc', 'price-desc'], 'score'),
        maxItems: integer(input.maxItems, 'maxItems', 1, 200, 48),
        ...priceRange(input),
        onSaleOnly: flag(input.onSaleOnly, 'onSaleOnly'), freeShippingOnly: flag(input.freeShippingOnly, 'freeShippingOnly'),
        handmadeOnly: flag(input.handmadeOnly, 'handmadeOnly'), includeAds: flag(input.includeAds, 'includeAds'),
      }
    },
    apify: { actorId: '6xoTiGfCmvG8ZKmtn', actor: 'yumitori/etsy-listings-scraper', build: '0.1.104' },
    actorInput: input => compact({
      queries: input.keywords, country: input.country, sort: input.sort, maxResults: Math.min(1_080, input.maxItems * input.keywords.length),
      maxPages: Math.min(30, Math.ceil(input.maxItems / 48)), minPrice: input.minPrice, maxPrice: input.maxPrice,
      onSaleOnly: input.onSaleOnly, freeShippingOnly: input.freeShippingOnly, handmadeOnly: input.handmadeOnly, digitalOnly: false,
      includeAds: input.includeAds, dedupeAcrossQueries: true,
    }),
    resultLimit: input => Math.min(1_000, input.maxItems * input.keywords.length),
  },
  // Package 114. The country is explicit (the Actor would default to Brazil)
  // and shop links must belong to that country's site.
  'collect.ecommerce.shopee.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['country', 'keywords', 'shopUrls', 'maxItems'], 'input')
      const country = choice(input.country, 'country', Object.keys(SHOPEE_HOSTS))
      if (!country) throw invalid('country is required', { field: 'country' })
      const mode = oneOf(input, ['keywords', 'shopUrls'])
      const hosts = new Set([SHOPEE_HOSTS[country], `www.${SHOPEE_HOSTS[country]}`])
      return { country, maxItems: integer(input.maxItems, 'maxItems', 10, 500, 50),
        ...(mode === 'keywords' ? { keywords: keywordList(input.keywords) } : { shopUrls: uniqueList(input.shopUrls, 'shopUrls', 1, 10, value => hostUrl(value, hosts, 'shopUrls')) }) }
    },
    apify: { actorId: 'fmKWN5uByUCIy2Sam', actor: 'gio21/shopee-scraper', build: '0.4.66' },
    actorInput: input => ({ country: input.country, keywords: input.keywords || [], shopUrls: input.shopUrls || [], categoryUrls: [],
      maxItems: input.maxItems, priceSlicing: false, debug: false }),
    resultLimit: input => input.maxItems,
  },
  // Package 112. Category or featured list links on www.shein.com only.
  'collect.ecommerce.shein.listing': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['url', 'maxItems'], 'input')
      return { url: hostUrl(input.url, new Set(['www.shein.com']), 'url'), maxItems: integer(input.maxItems, 'maxItems', 1, 200, 20) }
    },
    apify: { actorId: 'bQQXCnhfZv946J3Vs', actor: 'shahidirfan/shein-product-scraper', build: '1.0.12' },
    actorInput: input => ({ startUrl: input.url, results_wanted: input.maxItems }),
    resultLimit: input => input.maxItems,
  },
  // Package 123. The Actor prefers keyword when both are given; Hub takes exactly one.
  'collect.ecommerce.flipkart.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['keyword', 'url', 'sort', 'maxItems'], 'input')
      const mode = oneOf(input, ['keyword', 'url'])
      return {
        ...(mode === 'keyword' ? { keyword: text(input.keyword, 'keyword', 100) } : { url: hostUrl(input.url, new Set(['www.flipkart.com', 'flipkart.com']), 'url') }),
        sort: choice(input.sort, 'sort', ['relevance', 'popularity', 'price_asc', 'price_desc', 'newest'], 'relevance'),
        maxItems: integer(input.maxItems, 'maxItems', 1, 200, 20),
      }
    },
    apify: { actorId: 'TBFjma2NhVb30QONt', actor: 'shahidirfan/Flipkart-Product-Scraper', build: '0.0.8' },
    actorInput: input => input.keyword ? { keyword: input.keyword, sort: input.sort, results_wanted: input.maxItems }
      : { startUrl: input.url, sort: input.sort, results_wanted: input.maxItems },
    resultLimit: input => input.maxItems,
  },
  // Package 118. Search mode only; every enrichment is off.
  'collect.ecommerce.mercadolibre.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['country', 'keyword', 'maxItems'], 'input')
      const country = choice(input.country, 'country', MERCADOLIBRE_COUNTRIES)
      if (!country) throw invalid('country is required', { field: 'country' })
      return { country, keyword: text(input.keyword, 'keyword', 100), maxItems: integer(input.maxItems, 'maxItems', 1, 200, 50) }
    },
    apify: { actorId: 'aQLzms68BSsIJAdf2', actor: 'sourabhbgp/mercadolibre-scraper', build: '0.0.74' },
    actorInput: input => ({ mode: 'search', country: input.country, searchQuery: input.keyword, maxItems: input.maxItems, maxConcurrency: 2,
      scrapeProductDetails: false, includeReviews: false, includeQuestions: false, includeVariations: false, includeSellerProfile: false, includeFeaturedItems: false }),
    resultLimit: input => input.maxItems,
  },
  // Package 124. Marketplace links only, never posts, pages or the Ad Library.
  'collect.ecommerce.fbmarketplace.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['urls', 'maxItems'], 'input')
      return { urls: uniqueList(input.urls, 'urls', 1, 5, value => pathUrl(value, host => FACEBOOK_HOSTS.has(host), ['/marketplace/'], 'urls')),
        maxItems: integer(input.maxItems, 'maxItems', 1, 200, 20) }
    },
    apify: { actorId: 'U5DUNxhH3qKt5PnCf', actor: 'apify/facebook-marketplace-scraper', build: '0.0.326' },
    actorInput: input => ({ startUrls: input.urls.map(url => ({ url })), resultsLimit: input.maxItems, includeListingDetails: false }),
    resultLimit: input => input.maxItems,
  },
  // Package 127. The pinned build has no record limit: the run's maxItems
  // (charged results) and maxAge bound it.
  'collect.classifieds.craigslist.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['urls', 'maxAgeDays', 'maxItems'], 'input')
      return { urls: uniqueList(input.urls, 'urls', 1, 5, value => pathUrl(value, host => CRAIGSLIST_HOST.test(host), ['/search/'], 'urls')),
        maxAgeDays: integer(input.maxAgeDays, 'maxAgeDays', 1, 30, 7), maxItems: integer(input.maxItems, 'maxItems', 1, 200, 50) }
    },
    apify: { actorId: 'owuUx043cdcXvJ6fa', actor: 'ivanvs/craigslist-scraper-pay-per-result', build: '0.0.38' },
    actorInput: input => ({ urls: input.urls.map(url => ({ url })), maxAge: input.maxAgeDays, maxConcurrency: 2 }),
    resultLimit: input => input.maxItems,
  },
  // Package 129. Inventory details stay off.
  'collect.ecommerce.shopify.catalog': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['domains', 'maxItems'], 'input')
      return { domains: uniqueList(input.domains, 'domains', 1, 5, domain), maxItems: integer(input.maxItems, 'maxItems', 1, 500, 50) }
    },
    apify: { actorId: 'dsYHmuqeHvtR7NYxx', actor: 'trovevault/shopify-products-scraper', build: '0.1.75' },
    actorInput: input => ({ domains: input.domains.map(host => `https://${host}`), maxProducts: input.maxItems, includeInventoryDetails: false }),
    resultLimit: input => Math.min(1_000, input.maxItems * input.domains.length),
  },
  // Package 184. maxRequestsPerCrawl defaults to ten million upstream; bound it.
  'collect.web.builtwith.technologies': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['domains'], 'input')
      return { domains: uniqueList(input.domains, 'domains', 1, 10, domain) }
    },
    apify: { actorId: 'eFu56JAhgAGsIXfT4', actor: 'builtwith/builtwith-official-technology-scraper', build: '0.0.35' },
    actorInput: input => ({ startDomains: input.domains, maxRequestsPerCrawl: input.domains.length * 3 }),
    resultLimit: input => Math.min(100, input.domains.length * 5),
  },
  // Package 191. Basic registry data only: officers, PSCs (personal data),
  // filing history, charges and monitoring stay off.
  'collect.company.uk.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['query', 'companyNumbers', 'maxItems'], 'input')
      const mode = oneOf(input, ['query', 'companyNumbers'])
      if (mode === 'query') return { query: text(input.query, 'query', 100), maxItems: integer(input.maxItems, 'maxItems', 1, 100, 20) }
      if (input.maxItems !== undefined) throw invalid('maxItems applies to name search only', { field: 'maxItems' })
      return { companyNumbers: uniqueList(input.companyNumbers, 'companyNumbers', 1, 20, ukCompanyNumber) }
    },
    apify: { actorId: 'BWcp1XUouKEuCvY41', actor: 'scrapesage/companies-house-scraper', build: '1.1.18' },
    actorInput: input => ({ ...(input.query ? { searchQueries: [input.query], maxCompanies: input.maxItems } : { companyNumbers: input.companyNumbers, maxCompanies: input.companyNumbers.length }),
      maxConcurrency: 2, includeOfficers: false, includePSCs: false, includeFilingHistory: false, includeCharges: false, emitOfficerRecords: false, monitoringMode: false }),
    resultLimit: input => input.query ? input.maxItems : input.companyNumbers.length,
  },
  // Package 80. Trip.com hotel detail pages only.
  'collect.travel.tripcom.hotel-reviews': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['hotelUrl', 'maxReviews', 'sortBy', 'since'], 'input')
      return {
        hotelUrl: pathUrl(input.hotelUrl, host => TRIP_HOST.test(host), ['/hotels/'], 'hotelUrl'),
        maxReviews: integer(input.maxReviews, 'maxReviews', 1, 500, 100),
        sortBy: choice(input.sortBy, 'sortBy', ['mostRelevant', 'mostRecent', 'ratingHighToLow', 'ratingLowToHigh'], 'mostRecent'),
        since: day(input.since, 'since'),
      }
    },
    apify: { actorId: 'Y60CBfEPblopOe9P3', actor: 'knagymate/trip-com-reviews-scraper', build: '0.0.23' },
    actorInput: input => compact({ hotelUrl: input.hotelUrl, maxReviews: input.maxReviews, sortBy: input.sortBy, cutoffDate: input.since }),
    resultLimit: input => input.maxReviews,
  },
  // Phase 3, kind native: DNS (replaces package 181).
  'collect.intel.dns.lookup': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['name', 'types', 'resolver'], 'input')
      return {
        name: dnsName(input.name, 'name', { underscore: true }),
        types: input.types === undefined || input.types === null ? ['A', 'AAAA']
          : uniqueList(input.types, 'types', 1, DNS_TYPES.length, value => choice(typeof value === 'string' ? value.toUpperCase() : value, 'types', DNS_TYPES)),
        resolver: choice(input.resolver, 'resolver', Object.keys(DNS_RESOLVERS), 'alidns'),
      }
    },
    native: { run: dnsLookup },
    resultLimit: () => 1,
  },
  // Phase 3, kind native: RDAP (replaces package 180's WHOIS).
  'collect.intel.rdap.domain': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['domain'], 'input')
      return { domain: dnsName(input.domain, 'domain') }
    },
    native: { run: rdapDomain },
    resultLimit: () => 1,
  },
  // Phase 3, kind native: Certificate Transparency (package 182, on demand).
  'collect.intel.ct.issuances': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['domain', 'includeSubdomains', 'maxItems'], 'input')
      return { domain: dnsName(input.domain, 'domain'), includeSubdomains: flag(input.includeSubdomains, 'includeSubdomains'),
        maxItems: integer(input.maxItems, 'maxItems', 1, 1_000, 100) }
    },
    native: { run: ctIssuances },
    resultLimit: input => input.maxItems,
  },
  // Phase 3, kind shodan (package 188). Only first pages; no scans or alerts.
  'collect.intel.shodan.host': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['ip', 'history', 'minify'], 'input')
      return { ip: publicIp(input.ip), history: flag(input.history, 'history'), minify: flag(input.minify, 'minify') }
    },
    shodan: input => ({ operation: 'host', endpoint: '/shodan/host/{ip}', path: `/shodan/host/${encodeURIComponent(input.ip)}`,
      query: { history: input.history || null, minify: input.minify || null }, count: body => Array.isArray(body.data) ? body.data.length : 1 }),
    resultLimit: () => 1,
  },
  'collect.intel.shodan.search': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['query', 'facets', 'minify'], 'input')
      return { query: SHODAN_QUERY(input.query), facets: facets(input.facets), minify: input.minify === undefined ? true : flag(input.minify, 'minify') }
    },
    shodan: input => ({ operation: 'search', endpoint: '/shodan/host/search', path: '/shodan/host/search',
      query: { query: input.query, facets: input.facets, page: 1, minify: input.minify }, count: body => Array.isArray(body.matches) ? body.matches.length : 0 }),
    resultLimit: () => 100,
  },
  'collect.intel.shodan.count': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['query', 'facets'], 'input')
      return { query: SHODAN_QUERY(input.query), facets: facets(input.facets) }
    },
    shodan: input => ({ operation: 'count', endpoint: '/shodan/host/count', path: '/shodan/host/count',
      query: { query: input.query, facets: input.facets }, count: body => Number.isSafeInteger(body.total) ? body.total : 0 }),
    resultLimit: () => 1,
  },
  'collect.intel.shodan.domain': {
    normalize(input) {
      object(input, 'input')
      onlyFields(input, ['domain', 'type'], 'input')
      return { domain: dnsName(input.domain, 'domain'), type: choice(input.type, 'type', ['A', 'AAAA', 'CNAME', 'NS', 'SOA', 'MX', 'TXT'], null) }
    },
    shodan: input => ({ operation: 'domain', endpoint: '/dns/domain/{domain}', path: `/dns/domain/${encodeURIComponent(input.domain)}`,
      query: { type: input.type }, count: body => Array.isArray(body.data) ? body.data.length : 0 }),
    resultLimit: () => 1,
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
