import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { newsFields } from './news-record.mjs'
import { publicSourceCatalogItem } from './public-source-catalog.mjs'

export const NEWS_CONTRACT = 'mx-insight-hub.news-discovery.v1'
export const NEWS_METER = 'data.canonical-search'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIELDS = new Set(['query', 'catalogEntryIds', 'sourceCodes', 'categories', 'binding', 'from', 'to', 'timeField', 'pageSize', 'cursor'])
export const NEWS_PREDICATE = `c.deleted_at IS NULL
  AND c.platform LIKE 'data\\_center\\_saved\\_records\\_%' ESCAPE '\\'
  AND (c.content_type IN ('news', 'news.article', 'news.resolved')
    OR (c.content_type = 'bbc.article' AND c.stable_fields #>> '{crawler,lineage,collector,connectorId}' = 'bbc-news-openweb'))
  AND (nullif(btrim(c.title), '') IS NOT NULL OR nullif(btrim(c.body), '') IS NOT NULL)
  AND coalesce(c.stable_fields #>> '{crawler,lineage,qualityStatus}', '') <> 'rejected'`
const SOURCE_CODE = `nullif(c.stable_fields #>> '{crawler,lineage,publisher,code}', '')`
const BINDING_ID = `coalesce(CASE WHEN b.record_revision = c.current_revision THEN b.entry_id::text END,
  c.stable_fields #>> '{sourceCatalog,publisher,entryId}', c.stable_fields #>> '{commerce,marketplace,entryId}')`
export const CATALOG_JOINS = `LEFT JOIN catalog.record_catalog_bindings b ON b.record_id = c.id
  LEFT JOIN catalog.source_catalog_entries e ON e.id::text = ${BINDING_ID} AND e.archived_at IS NULL AND e.source_kind <> 'provider'`

function fail(message, code = 'invalid_request') { throw new AppError(400, code, message) }
function list(input, name, pattern) {
  const value = input[name] ?? []
  if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string' || !pattern.test(item))) fail(`Invalid ${name}`)
  return [...new Set(value)].sort()
}
function date(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('Dates must be RFC3339 timestamps with at most microsecond precision')
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail('Invalid calendar timestamp')
  const fraction = (value.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0')
  return `${new Date(value).toISOString().slice(0, 19)}.${fraction}Z`
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url') }

export function normalizeNewsQuery(input = {}, { platforms = [], maxPageSize = 100, identity, secret } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('A JSON object is required')
  if (Object.keys(input).some(key => !FIELDS.has(key))) fail('Unsupported news search fields', 'unsupported_fields')
  const allowed = [...new Set(platforms)].sort()
  if (!allowed.length) throw new AppError(403, 'platform_not_granted', 'A saved-record category grant is required')
  const categories = list(input, 'categories', /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
  if (categories.some(category => !allowed.includes(`data_center_saved_records_${category}`))) throw new AppError(403, 'platform_not_granted', 'One or more categories are not granted')
  const query = input.query ?? ''
  if (typeof query !== 'string' || query.length > 300) fail('query must be at most 300 characters')
  const pageSize = input.pageSize ?? Math.min(20, maxPageSize)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > Math.min(100, maxPageSize)) fail('pageSize exceeds the current policy')
  const timeField = input.timeField ?? 'firstSeenAt'
  if (!['firstSeenAt', 'publishedAt'].includes(timeField)) fail('Invalid timeField')
  const binding = input.binding ?? 'all'
  if (!['all', 'mapped', 'unmapped'].includes(binding)) fail('Invalid binding')
  const filters = { query: query.trim(), catalogEntryIds: list(input, 'catalogEntryIds', UUID),
    sourceCodes: list(input, 'sourceCodes', /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/), categories, binding,
    from: date(input.from), to: date(input.to), timeField, pageSize }
  if (filters.from && filters.to && filters.from >= filters.to) fail('from must precede to')
  const scope = categories.length ? categories.map(value => `data_center_saved_records_${value}`) : allowed
  const fingerprint = digest({ version: NEWS_CONTRACT, filters, allowed, identity })
  let boundary = null
  if (input.cursor != null) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 4096) throw Error()
      const [payload, signature, extra] = input.cursor.split('.')
      const expected = sign(payload, secret)
      if (extra || signature?.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw Error()
      const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString())
      if (cursor.q !== fingerprint || cursor.exp < Date.now() || !Number.isFinite(cursor.exp) || !UUID.test(cursor.id) || !date(cursor.time)) throw Error()
      boundary = { id: cursor.id, time: cursor.time }
    } catch { fail('Cursor is invalid or its identity, filters or authorization changed', 'invalid_cursor') }
  }
  return { filters, platforms: scope, allowedPlatforms: allowed, fingerprint, boundary }
}
export function newsCursor(row, query, secret) {
  const payload = Buffer.from(JSON.stringify({ q: query.fingerprint, time: row.cursor_time || new Date(row.sort_time).toISOString(), id: row.id, exp: Date.now() + 6 * 3600_000 })).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}
function safeUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:auth|credential|key|password|secret|signature|token)/iu.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch { return null }
}
function iso(value) { return value ? new Date(value).toISOString() : null }
function sourceLabel(value) {
  const safe = publicSourceCatalogItem({ canonicalName: value }).canonicalName
  return safe && safe !== '[redacted]' ? safe : null
}
export function publicNewsArticle(row, { detail = false } = {}) {
  const stable = row.stable_fields || {}
  const fields = stable.news || newsFields(row.news_raw || {})
  const publisher = stable.crawler?.lineage?.publisher || {}
  const publicationDate = stable.crawler?.publishedAt
  const dateOnly = publicationDate?.status === 'date-only'
  return {
    id: row.id, revision: row.current_revision, category: row.platform.replace('data_center_saved_records_', ''),
    source: { catalogEntryId: row.catalog_id || null, name: sourceLabel(row.catalog_name) || sourceLabel(publisher.name) || sourceLabel(publisher.code) || '未识别来源',
      code: sourceLabel(publisher.code), bindingStatus: row.catalog_id ? 'mapped' : 'unmapped' },
    title: row.title || null, excerpt: (row.body || '').slice(0, 360), summary: fields.summary || null,
    ...(detail ? { body: row.body || null } : {}), url: safeUrl(row.url), author: { name: row.author_name || null },
    publishedAt: iso(row.event_time), publishedDate: dateOnly ? publicationDate.normalized : null,
    publishedAtPrecision: row.event_time || dateOnly ? publicationDate?.precision || null : null,
    firstSeenAt: iso(row.collected_at), contentExtent: fields.contentExtent || 'unknown',
    topics: fields.topics || [], keywords: fields.keywords || [], section: fields.section || null,
  }
}
export function newsCatalog(entries) {
  return entries.filter(entry => !entry.archivedAt && entry.sourceKind !== 'provider').map(entry => {
    const safe = publicSourceCatalogItem(entry)
    return { id: safe.id, name: safe.canonicalName, majorCategory: safe.majorCategory, scenarios: safe.scenarios }
  }).filter(entry => entry.name && entry.name !== '[redacted]')
}
export function newsWhere(query, { cursor = true } = {}) {
  const values = [query.platforms]
  const conditions = [NEWS_PREDICATE, 'c.platform = ANY($1::text[])']
  const bind = value => { values.push(value); return `$${values.length}` }
  const f = query.filters
  if (f.query) {
    const p = bind(`%${f.query.replace(/[\\%_]/g, value => `\\${value}`)}%`)
    conditions.push(`(c.title ILIKE ${p} ESCAPE '\\' OR c.body ILIKE ${p} ESCAPE '\\')`)
  }
  if (f.catalogEntryIds.length) conditions.push(`e.id = ANY(${bind(f.catalogEntryIds)}::uuid[])`)
  if (f.sourceCodes.length) conditions.push(`${SOURCE_CODE} = ANY(${bind(f.sourceCodes)}::text[])`)
  if (f.binding !== 'all') conditions.push(`e.id IS ${f.binding === 'mapped' ? 'NOT ' : ''}NULL`)
  const time = f.timeField === 'publishedAt' ? 'c.event_time' : 'c.collected_at'
  conditions.push(`${time} IS NOT NULL`)
  if (f.from) conditions.push(`${time} >= ${bind(f.from)}::timestamptz`)
  if (f.to) conditions.push(`${time} < ${bind(f.to)}::timestamptz`)
  if (cursor && query.boundary) conditions.push(`(${time}, c.id) < (${bind(query.boundary.time)}::timestamptz, ${bind(query.boundary.id)}::uuid)`)
  return { sql: conditions.join('\n AND '), values, time }
}

export class NewsDiscoveryStore {
  constructor(pool) { this.pool = pool }
  async bounded(sql, values) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query("SET LOCAL statement_timeout = '5s'")
      const result = await client.query(sql, values)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error.code === '57014') throw new AppError(503, 'news_query_timeout', 'Narrow the date range or source filters and retry')
      throw error
    } finally { client.release() }
  }
  async search(query, secret) {
    const where = newsWhere(query)
    const { rows } = await this.bounded(`WITH page AS MATERIALIZED (
      SELECT c.id, ${where.time} AS sort_time FROM core.canonical_records c ${CATALOG_JOINS}
      WHERE ${where.sql} ORDER BY ${where.time} DESC, c.id DESC LIMIT $${where.values.length + 1}
    ) SELECT c.*, page.sort_time,
      to_char(page.sort_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
      e.id AS catalog_id, e.canonical_name AS catalog_name,
      jsonb_build_object('attributes', jsonb_build_object(
        'summary', rv.normalized_payload #> '{attributes,summary}',
        'source_topics', rv.normalized_payload #> '{attributes,source_topics}',
        'source_keywords', rv.normalized_payload #> '{attributes,source_keywords}',
        'body_status', rv.normalized_payload #> '{attributes,body_status}',
        'section', rv.normalized_payload #> '{attributes,section}')) AS news_raw
      FROM page JOIN core.canonical_records c ON c.id = page.id ${CATALOG_JOINS}
      LEFT JOIN core.record_revisions rv ON rv.record_id = c.id AND rv.revision = c.current_revision
      ORDER BY page.sort_time DESC, c.id DESC`, [...where.values, query.filters.pageSize + 1])
    const hasMore = rows.length > query.filters.pageSize
    const page = rows.slice(0, query.filters.pageSize)
    return { contractVersion: NEWS_CONTRACT, items: page.map(row => publicNewsArticle(row)),
      pageInfo: { returnedCount: page.length, hasMore, nextCursor: hasMore ? newsCursor(page.at(-1), query, secret) : null },
      filters: query.filters, dataBasis: 'stored_canonical', pagination: 'live_keyset' }
  }
  async article(id, platforms) {
    if (!UUID.test(id)) fail('Invalid article ID')
    const { rows } = await this.bounded(`SELECT c.*, e.id AS catalog_id, e.canonical_name AS catalog_name,
      jsonb_build_object('attributes', jsonb_build_object('summary', rv.normalized_payload #> '{attributes,summary}',
        'source_topics', rv.normalized_payload #> '{attributes,source_topics}', 'source_keywords', rv.normalized_payload #> '{attributes,source_keywords}',
        'body_status', rv.normalized_payload #> '{attributes,body_status}', 'section', rv.normalized_payload #> '{attributes,section}')) AS news_raw
      FROM core.canonical_records c ${CATALOG_JOINS}
      LEFT JOIN core.record_revisions rv ON rv.record_id = c.id AND rv.revision = c.current_revision
      WHERE c.id = $1 AND c.platform = ANY($2::text[]) AND ${NEWS_PREDICATE}`, [id, platforms])
    if (!rows[0]) throw new AppError(404, 'news_article_not_found', 'Article was not found')
    return { contractVersion: NEWS_CONTRACT, article: publicNewsArticle(rows[0], { detail: true }) }
  }
  async facets(query) {
    const where = newsWhere(query, { cursor: false })
    const { rows } = await this.bounded(`SELECT c.platform, ${SOURCE_CODE} AS code,
      c.stable_fields #>> '{crawler,lineage,publisher,name}' AS name, e.id AS catalog_id,
      e.canonical_name AS catalog_name FROM core.canonical_records c ${CATALOG_JOINS}
      WHERE ${where.sql} ORDER BY ${where.time} DESC, c.id DESC LIMIT 5001`, where.values)
    const sources = new Map(), categories = new Map()
    for (const row of rows.slice(0, 5000)) {
      const key = row.catalog_id || row.code || 'unknown'
      const source = sources.get(key) || { catalogEntryId: row.catalog_id || null, code: sourceLabel(row.code),
        name: key === 'unknown' ? '未识别来源' : sourceLabel(row.catalog_name) || sourceLabel(row.name) || sourceLabel(row.code) || '未识别来源', count: 0 }
      source.count++; sources.set(key, source)
      const category = row.platform.replace('data_center_saved_records_', '')
      categories.set(category, (categories.get(category) || 0) + 1)
    }
    return { contractVersion: NEWS_CONTRACT, scope: 'latest_matching_records', countBasis: 'records',
      sampledRecords: Math.min(rows.length, 5000), truncated: rows.length > 5000, asOf: new Date().toISOString(),
      sources: [...sources.values()].sort((a, b) => b.count - a.count),
      categories: [...categories].map(([id, count]) => ({ id, count })) }
  }
}
