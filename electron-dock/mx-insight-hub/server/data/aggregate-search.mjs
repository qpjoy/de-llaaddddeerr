import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../contracts/night-all-legacy.mjs'
import { JUSTONE_ENDPOINTS } from '../contracts/justone.mjs'
import { publicStoredSearchItem } from './stored-search.mjs'
import { createAggregateCursorCodec } from '../external-platforms/cursor.mjs'

export const AGGREGATE_CONTRACT = 'mx-insight-hub.aggregate-search.v1'
export const AGGREGATE_TYPES = ['post', 'article', 'message', 'chat', 'comment', 'product', 'account', 'user', 'profile', 'saved_record', 'commerce_capture', 'opinion_item']
const labels = {
  xiaohongshu: '小红书', douyin: '抖音', kuaishou: '快手', bilibili: '哔哩哔哩', weibo: '微博',
  wechat_mp: '微信公众号', wechat_search: '微信搜一搜', twitter: 'X / Twitter', facebook: 'Facebook',
  instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', reddit: 'Reddit', zhihu: '知乎',
  telegram: 'Telegram 会话', public_opinion: '全国舆情', ecommerce: '电商商品', mobile_commerce: '手机电商采集', social: '社交账号',
  taobao: '淘宝', tmall: '天猫', jd: '京东', xiaohongshu_ec: '小红书店铺', xianyu: '闲鱼',
}
const fail = message => { throw new AppError(400, 'invalid_request', message) }
function strings(value, name, max = 100, length = 100) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v.trim() || v.length > length)) fail(`${name} must be an array of at most ${max} non-blank strings`)
  return [...new Set(value.map(v => v.trim()))].sort()
}
function time(value, name) {
  if (value == null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${name} must be an ISO timestamp with timezone`)
  if (new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) fail(`${name} contains an invalid calendar date`)
  return new Date(value).toISOString()
}

// Executable routes are pinned here, independently of the editable source catalog.
// Provider selection remains inside each existing, governed operation.
export function aggregateSourceCatalog(grants, capabilities, crawlerSpecs = []) {
  const crawlers = new Map(crawlerSpecs.map(spec => [spec.platform, spec]))
  const supported = new Set([...NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.raw, 'telegram', 'public_opinion', 'ecommerce', 'social', 'mobile_commerce', ...crawlers.keys()])
  return [...new Set(grants)].filter(platform => supported.has(platform)).sort().flatMap(platform => {
    if (platform === 'ecommerce') return Object.keys(JUSTONE_ENDPOINTS).map(marketplace => ({
      platform: marketplace, label: labels[marketplace] || marketplace, stored: true,
      refresh: capabilities.includes('ecommerce.products.search'), objectTypes: ['product'],
      routes: capabilities.includes('ecommerce.products.search') ? [{ id: `products:${marketplace}`, platform: marketplace, marketplace,
        kind: 'products', operation: 'ecommerce.products.search', objectType: 'product', label: labels[marketplace] || marketplace }] : [],
    }))
    const content = NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.raw.includes(platform)
    const operationGranted = platform !== 'xiaohongshu' || capabilities.includes('social.posts.search')
    const routes = content && operationGranted
      ? [{ id: `posts:${platform}`, platform, kind: 'posts', operation: 'data.search', objectType: 'post', label: labels[platform] || platform }]
      : []
    return {
      platform, label: labels[platform] || `已存分类 · ${crawlers.get(platform)?.sourceType || platform}`,
      stored: true, refresh: routes.length > 0, routes,
      objectTypes: crawlers.has(platform) ? ['saved_record'] : platform === 'telegram' ? ['message', 'chat'] : platform === 'ecommerce' ? ['product'] : platform === 'mobile_commerce' ? ['commerce_capture'] : platform === 'social' ? ['account'] : platform === 'public_opinion' ? ['opinion_item'] : ['post', 'article', 'comment', 'user'],
    }
  })
}

export function normalizeAggregateRequest(body, sources) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON object body is required')
  const allowed = new Set(['query', 'platforms', 'objectTypes', 'filters', 'pageSize', 'cursor', 'mode'])
  if (Object.keys(body).some(k => !allowed.has(k))) fail('Unsupported aggregate search field')
  if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 200) fail('query must contain 1–200 characters')
  const mode = body.mode ?? 'refresh'
  if (!['stored', 'refresh'].includes(mode)) fail('mode must be stored or refresh')
  const requested = strings(body.platforms, 'platforms')
  const available = sources.map(source => source.platform)
  if (requested.some(platform => !available.includes(platform))) throw new AppError(403, 'platform_not_granted', 'A requested platform is not granted or searchable')
  const platforms = requested.length ? requested : available
  if (!platforms.length) throw new AppError(403, 'platform_not_granted', 'No searchable platform is granted to this API key')
  const objectTypes = strings(body.objectTypes, 'objectTypes', AGGREGATE_TYPES.length)
  if (objectTypes.some(type => !AGGREGATE_TYPES.includes(type))) fail('Unsupported objectTypes value')
  const input = body.filters ?? {}
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['tags', 'from', 'to'].includes(k))) fail('filters supports tags, from and to only')
  const filters = { tags: strings(input.tags, 'filters.tags', 10, 200), from: time(input.from, 'filters.from'), to: time(input.to, 'filters.to') }
  if (filters.from && filters.to && filters.from > filters.to) fail('filters.from must not be later than filters.to')
  const pageSize = body.pageSize ?? 20
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('pageSize must be between 1 and 100')
  if (body.cursor != null && (typeof body.cursor !== 'string' || !body.cursor || body.cursor.length > 8192)) fail('Invalid cursor')
  // None of the currently pinned live contracts can enforce a Hub tag or date
  // predicate. Reject before reservation/dispatch rather than pay then discard.
  if (mode === 'refresh' && (filters.tags.length || filters.from || filters.to)) throw new AppError(400, 'refresh_filters_unsupported', 'Live sources do not support Hub tags/date filters; use stored mode or remove these filters')
  const selected = sources.filter(source => platforms.includes(source.platform))
  const routes = mode === 'refresh' ? selected.flatMap(source => source.routes).filter(route => !objectTypes.length || objectTypes.includes(route.objectType)) : []
  if (mode === 'refresh' && !routes.length) throw new AppError(400, 'refresh_unavailable', 'No selected source supports this authorized live operation')
  return { query: body.query.trim(), platforms, authorizationPlatforms: [...new Set(platforms.map(platform => Object.hasOwn(JUSTONE_ENDPOINTS, platform) ? 'ecommerce' : platform))].sort(),
    marketplaces: platforms.filter(platform => Object.hasOwn(JUSTONE_ENDPOINTS, platform)), objectTypes, filters, pageSize, cursor: body.cursor ?? null, mode, routes }
}

export function aggregateResponse(data, query) {
  return { ...data, contractVersion: AGGREGATE_CONTRACT, mode: query.mode, scope: { platforms: query.platforms },
    items: data.items.map(item => item.platform === 'ecommerce' ? { ...item, platform: item.externalId?.split(':')[0] || item.platform } : item),
    filters: { objectTypes: query.objectTypes, ...query.filters },
    // These are counts in this returned page, never corpus/coverage totals.
    sources: query.platforms.map(platform => {
      const returnedCount = data.items.filter(item => (item.platform === 'ecommerce' ? item.externalId?.split(':')[0] : item.platform) === platform).length
      return { platform, mode: 'stored', status: returnedCount ? 'ok' : 'empty', returnedCount }
    }),
  }
}

const scalar = value => typeof value === 'string' ? value : null

// A cursor references committed Hub evidence, not an expanding bundle of
// provider cursors. It is encrypted and bound to the original Key and scope.
export async function aggregateLivePage(query, { context, store, secret }) {
  const codec = createAggregateCursorCodec(secret, `${context.tenant.id}:${context.consumer.id}:${context.apiKey.id}`)
  const { cursor, ...scope } = query
  const binding = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
  const invalid = () => { throw new AppError(400, 'invalid_cursor', 'Live cursor is invalid for this identity or search; start a new search without cursor') }
  let previous = null, rootId = null
  if (cursor) {
    let decoded
    try { decoded = codec.decode(cursor) } catch { invalid() }
    if (decoded.binding !== binding || !/^[a-f0-9-]{36}$/.test(decoded.requestId || '') || !/^[a-f0-9-]{36}$/.test(decoded.rootId || '')) invalid()
    const record = await store.getUsageRequestForRetry(decoded.requestId, context.consumer.id)
    previous = record?.responseBody?.data
    if (record?.apiKeyId !== context.apiKey.id || record?.tenantId !== context.tenant.id || record?.status !== 'committed'
      || previous?.contractVersion !== AGGREGATE_CONTRACT || previous.mode !== 'refresh'
      || previous.pageInfo?.nextCursor !== cursor || !previous.pageInfo.hasMore) invalid()
    rootId = decoded.rootId
  }
  const pageIndex = previous ? previous.pageInfo.pageIndex + 1 : 1
  const routes = previous ? await Promise.all(query.routes.flatMap(route => {
    const source = previous.sources.find(row => row.id === route.id)
    if (!source?.hasMore || !['ok', 'empty', 'partial'].includes(source.status)) return []
    return [(async () => {
      const child = await store.getUsageRequestForRetry(source.requestId, context.consumer.id)
      const next = liveContinuation(child?.responseBody?.data)
      if (child?.apiKeyId !== context.apiKey.id || child?.tenantId !== context.tenant.id || child?.status !== 'committed' || !next) {
        throw new AppError(409, 'aggregate_continuation_unavailable', 'Committed source continuation is unavailable; no source was dispatched')
      }
      return { ...route, cursor: next }
    })()]
  })) : query.routes
  if (!routes.length) invalid()
  return {
    routes, pageIndex, rootId,
    carriedSources: previous?.sources.filter(source => !routes.some(route => route.id === source.id)).map(source => ({ ...source, carried: true })) || [],
    nextCursor: requestId => codec.encode({ binding, requestId, rootId: rootId || requestId }),
  }
}

function liveContinuation(data) {
  const page = data?.pageInfo ?? data?.page
  return data?.items?.length && page?.hasMore !== false && typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
}

function liveItem(item, route, requestId) {
  const externalId = scalar(item.externalId) || scalar(item.id)
  if (!externalId) return null
  const row = {
    id: `live:${createHash('sha256').update(`${route.id}:${externalId}`).digest('hex').slice(0, 32)}`,
    externalId: route.marketplace ? `${route.marketplace}:${externalId}` : externalId,
    platform: route.platform, objectType: route.objectType,
    datasetId: route.kind === 'products' ? 'ecommerce.products.v1' : null,
    title: scalar(item.title), body: scalar(item.text), url: scalar(item.url),
    contentType: scalar(item.contentType), authorExternalId: scalar(item.author?.id || item.shop?.id),
    authorName: scalar(item.author?.name || item.shop?.name), metrics: item.metrics,
    eventTime: item.publishedAt || item.eventTime, collectedAt: item.collectedAt,
  }
  return { ...publicStoredSearchItem(row), acquisitionRequestId: requestId }
}

export async function refreshAggregate(query, { requestId, search, products, concurrency = 3, pageIndex = 1 }) {
  const outcomes = new Array(query.routes.length)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, query.routes.length) }, async () => {
    while (index < query.routes.length) {
      const slot = index++
      const route = query.routes[slot]
      const started = performance.now()
      const idempotencyKey = `agg-${requestId}-${pageIndex > 1 ? `p${pageIndex}-` : ''}${createHash('sha256').update(route.id).digest('hex').slice(0, 12)}`
      try {
        const result = route.kind === 'products'
          ? await products({ body: { marketplace: route.marketplace, query: query.query, deliveryMode: 'live_only', ...(route.cursor ? { cursor: route.cursor } : {}) }, idempotencyKey, path: '/api/v1/data/ecommerce/products/search' })
          : await search({ body: { platform: route.platform, query: query.query, pageSize: 20, ...(route.cursor ? { cursor: route.cursor, type: 'stable' } : {}) }, idempotencyKey, path: '/api/v1/data/search' })
        if (result.status >= 400) throw new AppError(result.status, 'source_request_failed', 'Source request failed', { requestId: result.requestId })
        const data = result.body?.data
        if (!Array.isArray(data?.items)) throw new AppError(502, 'invalid_source_response', 'Source did not return a search result', { requestId: result.requestId })
        const items = data.items.map(item => liveItem(item, route, result.requestId)).filter(Boolean)
        outcomes[slot] = {
          source: { id: route.id, platform: route.platform, label: route.label, mode: 'refresh', operation: route.operation,
            status: data.status === 'partial' ? 'partial' : items.length ? 'ok' : 'empty', requestId: result.requestId, returnedCount: items.length,
            hasMore: Boolean(liveContinuation(data)), replay: result.replay === true,
            ...((data.pageInfo?.hasMore ?? data.page?.hasMore) && !liveContinuation(data) ? { continuationUnavailable: true } : {}),
            durationMs: Math.round(performance.now() - started) }, items,
        }
      } catch (error) {
        outcomes[slot] = { source: { id: route.id, platform: route.platform, label: route.label, mode: 'refresh', operation: route.operation,
          status: error.status === 403 ? 'not_authorized' : /unknown|ambiguous/.test(error.code || '') ? 'unknown' : 'unavailable',
          code: error.status === 403 ? 'source_not_authorized' : /unknown|ambiguous/.test(error.code || '') ? 'source_outcome_unknown' : 'source_unavailable', requestId: error.details?.requestId || null,
          durationMs: Math.round(performance.now() - started) }, items: [] }
      }
    }
  }))
  return { sources: outcomes.map(row => row.source), items: [...new Map(outcomes.flatMap(row => row.items).map(item => [`${item.platform}:${item.externalId}`, item])).values()] }
}
