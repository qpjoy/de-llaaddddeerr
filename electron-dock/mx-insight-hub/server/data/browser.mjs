import { z } from 'zod'
import { AppError } from '../core/errors.mjs'

const querySchema = z.object({
  view: z.enum(['accounts', 'contents', 'hotspots']).default('contents'),
  q: z.string().trim().max(200).default(''),
  platform: z.string().max(100).default(''),
  account: z.string().max(500).default(''),
  tag: z.string().max(200).default(''),
  id: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict().refine((v) => !v.account || Boolean(v.platform), { message: 'account requires platform' })

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

export function browserStatement(filters) {
  const values = []
  const bind = (value) => { values.push(value); return `$${values.length}` }
  const conditions = ['r.deleted_at IS NULL']
  if (filters.platform) conditions.push(`r.platform = ${bind(filters.platform)}`)
  if (filters.account) conditions.push(`${accountId} = ${bind(filters.account)}`)
  if (filters.id) conditions.push(`r.id = ${bind(filters.id)}::uuid`)
  if (filters.tag) conditions.push(`${tags} @> ${bind(JSON.stringify([filters.tag]))}::jsonb`)
  if (filters.q) {
    const p = bind(filters.q)
    conditions.push(filters.view === 'accounts'
      ? `(strpos(lower(COALESCE(${accountName},'')), lower(${p})) > 0 OR strpos(lower(COALESCE(${accountId},'')), lower(${p})) > 0)`
      : `(strpos(lower(COALESCE(r.title,'') || ' ' || COALESCE(r.body,'')), lower(${p})) > 0)`)
  }
  let statement
  if (filters.view === 'accounts') {
    conditions.push(`${accountId} IS NOT NULL`)
    statement = `SELECT r.platform, ${accountId} AS account_id,
      (max(ARRAY[
        COALESCE(to_char(r.collected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), ''),
        r.id::text, ${accountName}
      ]) FILTER (WHERE NULLIF(${accountName},'') IS NOT NULL))[3] AS name,
      count(*)::int AS records,
      count(*) FILTER (WHERE r.object_type NOT IN ('user','account','profile'))::int AS contents,
      max(r.collected_at) AS updated_at
      FROM core.canonical_records r WHERE ${conditions.join(' AND ')}
      GROUP BY r.platform, ${accountId}`
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
    statement = `SELECT ${filters.id ? "r.*" : "r.id, r.platform, r.object_type, r.content_type, r.external_id, r.title, left(r.body, 200) AS body, r.author_external_id, r.author_name, r.event_time, r.collected_at, jsonb_build_object('tags', r.stable_fields->'tags') AS stable_fields, r.current_revision, r.dataset_id"}, ${accountId} AS account_id
      FROM core.canonical_records r WHERE ${conditions.join(' AND ')}`
  }
  const sort = filters.view === 'accounts' ? 'records DESC, platform, account_id'
    : filters.view === 'hotspots' ? 'recent DESC, records DESC, tag' : 'collected_at DESC NULLS LAST, id DESC'
  const limit = bind(filters.pageSize)
  const offset = bind((filters.page - 1) * filters.pageSize)
  const summary = filters.account && filters.view === 'contents'
    ? `, (SELECT jsonb_build_object(
        'firstPublishedAt', min(event_time), 'lastPublishedAt', max(event_time),
        'datedRecords', count(event_time),
        'tags', (SELECT COALESCE(jsonb_agg(evidence), '[]'::jsonb) FROM (
          SELECT tag.value #>> '{}' AS tag, count(DISTINCT m.id)::int AS records
          FROM matches m CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(m.stable_fields->'tags') = 'array' THEN m.stable_fields->'tags' ELSE '[]'::jsonb END
          ) tag(value)
          WHERE jsonb_typeof(tag.value) = 'string' AND length(tag.value #>> '{}') BETWEEN 1 AND 200
          GROUP BY tag.value ORDER BY records DESC, tag LIMIT 20
        ) evidence)
      ) FROM matches) AS account_summary`
    : ''
  return { text: `WITH matches AS (${statement}), page AS (SELECT * FROM matches ORDER BY ${sort} LIMIT ${limit} OFFSET ${offset})
    SELECT (SELECT count(*)::int FROM matches) AS total, COALESCE((SELECT jsonb_agg(page) FROM page), '[]'::jsonb) AS items${summary}`, values }
}

const activeReads = new WeakMap()

// Aggregates inspect the complete matching corpus. Cache only bounded result
// pages, never raw detail payloads, and coalesce identical in-flight requests.
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

async function executeBrowseData(store, filters) {
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
    const aggregate = ['accounts', 'hotspots'].includes(filters.view)
    // Grouping the whole corpus has a separate bounded budget. Ordinary reads
    // and every other Hub endpoint retain their existing timeout policy.
    await connection.query(aggregate
      ? "SET LOCAL statement_timeout = '15000ms'"
      : "SET LOCAL statement_timeout = '3000ms'")
    const query = browserStatement(filters)
    const { rows } = await connection.query(query.text, query.values)
    await connection.query('COMMIT')
    const result = rows[0] || { total: 0, items: [] }
    return { ...result, page: filters.page, pageSize: filters.pageSize,
      hasMore: filters.page * filters.pageSize < result.total,
      evidence: { source: 'postgres-canonical', analysis: 'not_run',
        hotspotMethod: 'source-tag-cooccurrence-v1', hotspotWindowDays: 7,
        snapshot: 'per-request', computedAt: new Date().toISOString(), cacheMaxAgeSeconds: aggregate ? 30 : 0, identity: 'platform-and-external-id' } }
  } catch (error) {
    if (connection) { try { await connection.query('ROLLBACK') } catch { destroy = true } }
    if (error.code === '57014') throw new AppError(503, 'data_browser_timeout', '数据聚合超时，请稍后重试或按平台缩小范围；本次未返回不完整统计')
    throw error
  } finally {
    activeReads.set(store, (activeReads.get(store) || 1) - 1)
    connection?.release(destroy)
  }
}
