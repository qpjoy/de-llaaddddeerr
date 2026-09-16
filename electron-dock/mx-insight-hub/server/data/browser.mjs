import { z } from 'zod'
import { AppError } from '../core/errors.mjs'

const querySchema = z.object({
  view: z.enum(['accounts', 'contents', 'hotspots']).default('contents'),
  q: z.string().trim().max(200).default(''),
  platform: z.string().max(100).default(''),
  account: z.string().max(500).default(''),
  tag: z.string().max(200).default(''),
  id: z.uuid().optional(),
  objectType: z.string().max(100).default(''),
  contentType: z.string().max(100).default(''),
  from: z.union([z.iso.date(), z.literal('')]).default(''),
  to: z.union([z.iso.date(), z.literal('')]).default(''),
  sort: z.enum(['newest', 'oldest', 'directory', 'activity']).default('newest'),
  summary: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict().refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'invalid date range' }).refine((v) => !v.account || Boolean(v.platform), { message: 'account requires platform' })

export function parseBrowserQuery(params) {
  if ([...params.keys()].some((key) => params.getAll(key).length > 1)) {
    throw new AppError(400, 'invalid_browser_query', 'Duplicate query fields are not supported')
  }
  const parsed = querySchema.safeParse(Object.fromEntries(params))
  if (!parsed.success) throw new AppError(400, 'invalid_browser_query', 'Invalid browser filters or pagination')
  return parsed.data
}

// Account identity is always platform scoped. Names never establish identity.
const accountId = `CASE WHEN r.object_type IN ('user','account','profile') THEN NULLIF(r.external_id, '') ELSE NULLIF(r.author_external_id, '') END`
const accountName = `CASE WHEN r.object_type IN ('user','account','profile') THEN COALESCE(NULLIF(r.title,''), r.author_name) ELSE r.author_name END`
const tags = `CASE WHEN jsonb_typeof(r.stable_fields->'tags') = 'array' THEN r.stable_fields->'tags' ELSE '[]'::jsonb END`

export function browserStatement(filters, { fullContent = false } = {}) {
  const values = []
  const bind = (value) => { values.push(value); return `$${values.length}` }
  const conditions = ['r.deleted_at IS NULL']
  if (filters.platform) conditions.push(`r.platform = ${bind(filters.platform)}`)
  if (filters.account) conditions.push(`${accountId} = ${bind(filters.account)}`)
  if (filters.id) conditions.push(`r.id = ${bind(filters.id)}::uuid`)
  if (filters.tag) conditions.push(`${tags} @> ${bind(JSON.stringify([filters.tag]))}::jsonb`)
  if (filters.objectType) conditions.push(`r.object_type = ${bind(filters.objectType)}`)
  if (filters.contentType) conditions.push(`r.content_type = ${bind(filters.contentType)}`)
  if (filters.from) conditions.push(`r.event_time >= (${bind(filters.from)}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`)
  if (filters.to) conditions.push(`r.event_time < ((${bind(filters.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`)
  if (filters.q) {
    const p = bind(`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`)
    conditions.push(filters.view === 'accounts'
      ? `(${accountName} ILIKE ${p} OR ${accountId} ILIKE ${p})`
      : `(r.title ILIKE ${p} OR r.body ILIKE ${p})`)
  }
  if (filters.summary === 'true' && filters.account && filters.view === 'contents') {
    return { text: `WITH matches AS MATERIALIZED (
      SELECT r.id, r.event_time, ${tags} AS tags FROM core.canonical_records r WHERE ${conditions.join(' AND ')}
    ) SELECT NULL::int AS total, '[]'::jsonb AS items, jsonb_build_object(
      'firstPublishedAt', min(event_time), 'lastPublishedAt', max(event_time), 'datedRecords', count(event_time),
      'tags', (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (
        SELECT t.value #>> '{}' AS tag, count(DISTINCT m.id)::int AS records
        FROM matches m CROSS JOIN LATERAL jsonb_array_elements(m.tags) t(value)
        WHERE jsonb_typeof(t.value) = 'string' AND length(t.value #>> '{}') BETWEEN 1 AND 200
        GROUP BY t.value ORDER BY records DESC, tag LIMIT 20
      ) e)
    ) AS account_summary FROM matches`, values }
  }
  let statement
  if (filters.view === 'accounts') {
    conditions.push(`${accountId} IS NOT NULL`)
    const sort = filters.sort === 'activity' ? 'records DESC, platform, account_id' : 'platform, account_id'
    const limit = bind(filters.pageSize + 1)
    const offset = bind((filters.page - 1) * filters.pageSize)
    return { text: `WITH accounts AS NOT MATERIALIZED (
      SELECT r.platform, ${accountId} AS account_id, count(*)::int AS records,
        count(*) FILTER (WHERE r.object_type NOT IN ('user','account','profile'))::int AS contents,
        max(r.collected_at) AS updated_at
      FROM core.canonical_records r WHERE ${conditions.join(' AND ')}
      GROUP BY r.platform, ${accountId}
    ), selected AS MATERIALIZED (
      SELECT * FROM accounts ORDER BY ${sort} LIMIT ${limit} OFFSET ${offset}
    ), page AS (
      SELECT a.*, n.name FROM selected a LEFT JOIN LATERAL (
        SELECT ${accountName} AS name FROM core.canonical_records r
        WHERE ${conditions.join(' AND ')} AND r.platform = a.platform AND ${accountId} = a.account_id
          AND NULLIF(${accountName}, '') IS NOT NULL
        ORDER BY r.collected_at DESC NULLS LAST, r.id DESC LIMIT 1
      ) n ON true
    ) SELECT NULL::int AS total, COALESCE(jsonb_agg(page ORDER BY ${sort}), '[]'::jsonb) AS items FROM page`, values }
  } else if (filters.view === 'hotspots') {
    conditions.push(`r.event_time >= now() - interval '7 days' AND r.event_time <= now()`)
    statement = `SELECT tag.value #>> '{}' AS tag, count(DISTINCT r.id)::int AS records,
      count(DISTINCT r.platform)::int AS platforms, max(r.event_time) AS updated_at,
      count(DISTINCT r.id) FILTER (WHERE r.event_time >= now() - interval '24 hours')::int AS recent
      FROM core.canonical_records r CROSS JOIN LATERAL jsonb_array_elements(${tags}) tag(value)
      WHERE ${conditions.join(' AND ')} AND jsonb_typeof(tag.value) = 'string'
        AND length(tag.value #>> '{}') BETWEEN 1 AND 200
      GROUP BY tag.value HAVING count(DISTINCT r.id) >= 2`
  } else {
    // Limit a narrow index-ordered identity page before reading large bodies or
    // JSON. In particular, no total-count CTE may materialize the whole corpus.
    const direction = filters.sort === 'oldest' ? 'ASC' : 'DESC'
    const time = 'coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at)'
    const limit = bind(filters.pageSize + 1)
    const offset = bind((filters.page - 1) * filters.pageSize)
    return { text: `WITH page_ids AS MATERIALIZED (
      SELECT r.id, ${time} AS sort_time FROM core.canonical_records r
      WHERE ${conditions.join(' AND ')} ORDER BY ${time} ${direction}, r.id ${direction}
      LIMIT ${limit} OFFSET ${offset}
    ), page AS (
      SELECT ${filters.id || fullContent ? 'r.*' : "r.id, r.platform, r.object_type, r.content_type, r.external_id, r.title, left(r.body, 200) AS body, r.author_external_id, r.author_name, r.event_time, r.collected_at, jsonb_build_object('tags', r.stable_fields->'tags', 'metrics', r.stable_fields->'metrics') AS stable_fields, r.current_revision, r.dataset_id"},
        ${accountId} AS account_id, p.sort_time
      FROM page_ids p JOIN core.canonical_records r ON r.id = p.id
    ) SELECT NULL::int AS total, COALESCE(jsonb_agg(page ORDER BY sort_time ${direction}, id ${direction}), '[]'::jsonb) AS items FROM page`, values }
  }
  const sort = filters.view === 'accounts' ? (filters.sort === 'activity' ? 'records DESC, platform, account_id' : 'platform, account_id')
    : filters.view === 'hotspots' ? 'recent DESC, records DESC, tag' : 'collected_at DESC NULLS LAST, id DESC'
  const limit = bind(filters.pageSize + 1)
  const offset = bind((filters.page - 1) * filters.pageSize)
  return { text: `WITH matches AS NOT MATERIALIZED (${statement}), page AS (SELECT * FROM matches ORDER BY ${sort} LIMIT ${limit} OFFSET ${offset})
    SELECT NULL::int AS total, COALESCE(jsonb_agg(page ORDER BY ${sort}), '[]'::jsonb) AS items FROM page`, values }

}

const activeReads = new WeakMap()

// Cache only bounded account/hotspot result pages, never raw detail payloads,
// and coalesce identical in-flight requests.
const aggregateCaches = new WeakMap()
const AGGREGATE_CACHE_MS = 30_000
const MAX_CACHE_ENTRIES = 32
const MAX_CACHE_BYTES = 2 * 1024 * 1024

export async function browseData(store, filters) {
  if (!['accounts', 'hotspots'].includes(filters.view)) return executeBrowseData(store, filters)
  let cache = aggregateCaches.get(store)
  if (!cache) { cache = new Map(); aggregateCaches.set(store, cache) }
  const key = JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)))
  const cached = cache.get(key)
  if (cached?.pending) return structuredClone(await cached.pending)
  if (cached?.expiresAt > Date.now()) return structuredClone(cached.result)
  cache.delete(key)
  // Evict settled entries only; active requests are bounded by admission below.
  for (const [entryKey, entry] of cache) {
    if (!entry.pending && (entry.expiresAt <= Date.now() || cache.size >= MAX_CACHE_ENTRIES)) cache.delete(entryKey)
  }
  const entry = { pending: executeBrowseData(store, filters) }
  cache.set(key, entry)
  try {
    const result = await entry.pending
    if (Buffer.byteLength(JSON.stringify(result)) <= MAX_CACHE_BYTES / MAX_CACHE_ENTRIES) {
      cache.set(key, { result, expiresAt: Date.now() + AGGREGATE_CACHE_MS })
    } else cache.delete(key)
    return structuredClone(result)
  } catch (error) { cache.delete(key); throw error }
}

async function executeBrowseData(store, filters, options = {}) {
  if (!store.pool?.connect) {
    throw new AppError(503, 'data_browser_unavailable', 'Data browser requires the PostgreSQL canonical store')
  }
  const count = activeReads.get(store) || 0
  if (count >= 2) throw new AppError(429, 'data_browser_busy', 'Data browser is busy; retry after the current query completes')
  activeReads.set(store, count + 1)
  let connection
  let destroy = false
  try {
    connection = await store.pool.connect()
    // No mutations, upstream calls, LLM or ES dependency. Bound expensive grouping.
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const aggregate = ['accounts', 'hotspots'].includes(filters.view) || filters.summary === 'true' || options.fullContent
    // Grouping the whole corpus has a separate bounded budget. Ordinary reads
    // and every other Hub endpoint retain their existing timeout policy.
    await connection.query(aggregate
      ? "SET LOCAL statement_timeout = '15000ms'"
      : "SET LOCAL statement_timeout = '3000ms'")
    const query = browserStatement(filters, options)
    const { rows } = await connection.query(query.text, query.values)
    await connection.query('COMMIT')
    const result = rows[0] || { total: null, items: [] }
    const hasMore = result.items.length > filters.pageSize
    result.items = result.items.slice(0, filters.pageSize)
    return { ...result, page: filters.page, pageSize: filters.pageSize,
      hasMore, totalStatus: result.total == null ? 'not_computed' : 'exact',
      evidence: { source: 'postgres-canonical', analysis: 'not_integrated',
        hotspotMethod: 'source-tag-cooccurrence-v1', hotspotWindowDays: 7,
        snapshot: 'per-request', computedAt: new Date().toISOString(), cacheMaxAgeSeconds: ['accounts', 'hotspots'].includes(filters.view) && !options.fullContent ? 30 : 0, identity: 'platform-and-external-id' } }
  } catch (error) {
    if (connection) { try { await connection.query('ROLLBACK') } catch { destroy = true } }
    if (error.code === '57014') throw new AppError(503, 'data_browser_timeout', '数据聚合超时，请稍后重试或按平台缩小范围；本次未返回不完整统计')
    throw error
  } finally {
    activeReads.set(store, (activeReads.get(store) || 1) - 1)
    connection?.release(destroy)
  }
}


export async function exportBrowserData(store, filters, maxRows = 200) {
  // One read-only transaction produces one consistent bounded export. Never
  // concatenate changing offset pages and call that a complete snapshot.
  return executeBrowseData(store, { ...filters, page: 1, pageSize: maxRows, summary: 'false' }, { fullContent: true })
}
