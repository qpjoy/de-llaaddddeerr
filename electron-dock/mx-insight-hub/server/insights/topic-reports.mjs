import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { CRAWLER_SOURCES } from '../ingest/crawler/source-contract.mjs'

export const TOPIC_REPORT_CONTRACT_VERSION = 'mx-insight-hub.data-products.topic-report.v1'
export const TOPIC_REPORT_USAGE_SCOPE = 'data.topic-reports'
export const TOPIC_REPORT_PLATFORMS = Object.freeze(CRAWLER_SOURCES.map((source) => source.platform))

const PLATFORM_CATEGORY = Object.freeze({
  automotive: '汽车',
  finance: '财经',
  forum: '论坛',
  hotspot: '热点',
  local_news: '地方新闻',
  media: '媒体',
  news: '新闻资讯',
  other: '其他',
  recruitment: '招聘',
  research: '研究',
  social: '社交媒体',
  technology: '科技',
  web: '网页',
})
const TOPIC_REPORT_PLATFORM_SET = new Set(TOPIC_REPORT_PLATFORMS)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LANGUAGES = new Set(['zh-CN', 'en'])
const SOURCE_SCOPES = new Set(['all_granted', 'selected'])
const MAX_ATTEMPTS = 3
const DEFAULT_SAMPLE_LIMIT = 240

function requiredText(value, field, { min = 1, max = 300 } = {}) {
  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_request', `${field} must be a string`)
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (normalized.length < min || normalized.length > max) {
    throw new AppError(400, 'invalid_request', `${field} must contain ${min}-${max} characters`)
  }
  return normalized
}

function requiredDate(value, field) {
  const parsed = new Date(value)
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'invalid_request', `${field} must be an RFC3339 timestamp`)
  }
  return parsed
}

function normalizedPlatforms(value, allowedPlatforms) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, 'invalid_request', 'platforms must be a non-empty array')
  }
  const platforms = [...new Set(value.map((item) => requiredText(item, 'platform', { max: 96 }).toLowerCase()))]
  const unknown = platforms.filter((platform) => !TOPIC_REPORT_PLATFORM_SET.has(platform))
  if (unknown.length > 0) {
    throw new AppError(400, 'invalid_platform', `Unsupported topic-report platforms: ${unknown.join(', ')}`)
  }
  const allowed = new Set(allowedPlatforms)
  const forbidden = platforms.filter((platform) => !allowed.has(platform))
  if (forbidden.length > 0) {
    throw new AppError(403, 'platform_not_granted', 'One or more requested platforms are not granted')
  }
  return platforms.sort()
}

export function normalizeTopicReportRequest(input, {
  allowedPlatforms = TOPIC_REPORT_PLATFORMS,
  now = new Date(),
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'JSON object body is required')
  }
  const allowedFields = new Set([
    'topic', 'language', 'range', 'from', 'to', 'sourceScope', 'platforms', 'sampleLimit',
  ])
  const unsupported = Object.keys(input).filter((field) => !allowedFields.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported topic report fields: ${unsupported.join(', ')}`)
  }
  const topic = requiredText(input.topic, 'topic', { min: 2, max: 300 })
  const language = input.language == null ? 'zh-CN' : requiredText(input.language, 'language', { max: 16 })
  if (!LANGUAGES.has(language)) {
    throw new AppError(400, 'invalid_request', 'language must be zh-CN or en')
  }
  const range = input.range == null ? '7d' : requiredText(input.range, 'range', { max: 16 })
  const rangeDurations = { '24h': 24 * 60 * 60 * 1_000, '7d': 7 * 24 * 60 * 60 * 1_000, '30d': 30 * 24 * 60 * 60 * 1_000, '90d': 90 * 24 * 60 * 60 * 1_000 }
  let rangeEnd
  let rangeStart
  if (range === 'custom') {
    rangeStart = requiredDate(input.from, 'from')
    rangeEnd = requiredDate(input.to, 'to')
  } else {
    if (!rangeDurations[range]) {
      throw new AppError(400, 'invalid_request', 'range must be 24h, 7d, 30d, 90d, or custom')
    }
    rangeEnd = new Date(now)
    rangeStart = new Date(rangeEnd.getTime() - rangeDurations[range])
  }
  if (rangeStart >= rangeEnd || rangeEnd.getTime() - rangeStart.getTime() > 366 * 24 * 60 * 60 * 1_000) {
    throw new AppError(400, 'invalid_request', 'The report time range must be positive and no longer than 366 days')
  }
  const eligiblePlatforms = [...new Set(allowedPlatforms)].filter((platform) => TOPIC_REPORT_PLATFORM_SET.has(platform))
  if (eligiblePlatforms.length === 0) {
    throw new AppError(403, 'platform_not_granted', 'A saved-record data platform grant is required')
  }
  const sourceScope = input.sourceScope == null ? 'all_granted' : requiredText(input.sourceScope, 'sourceScope', { max: 32 })
  if (!SOURCE_SCOPES.has(sourceScope)) {
    throw new AppError(400, 'invalid_request', 'sourceScope must be all_granted or selected')
  }
  const platforms = sourceScope === 'selected'
    ? normalizedPlatforms(input.platforms, eligiblePlatforms)
    : eligiblePlatforms.sort()
  const sampleLimit = input.sampleLimit == null ? DEFAULT_SAMPLE_LIMIT : Number(input.sampleLimit)
  if (!Number.isInteger(sampleLimit) || sampleLimit < 20 || sampleLimit > 500) {
    throw new AppError(400, 'invalid_request', 'sampleLimit must be an integer from 20 to 500')
  }
  return {
    topic,
    language,
    range,
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    sourceScope,
    platforms,
    sampleLimit,
  }
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString()
}

function categoryForPlatform(platform) {
  const sourceType = String(platform || '').replace(/^data_center_saved_records_/u, '')
  return {
    id: sourceType || 'other',
    label: PLATFORM_CATEGORY[sourceType] || sourceType || '其他',
  }
}

function topicReportRow(row, { includeOwner = false } = {}) {
  if (!row) return null
  return {
    id: row.id,
    contractVersion: TOPIC_REPORT_CONTRACT_VERSION,
    topic: row.topic,
    language: row.language,
    range: { from: iso(row.range_start), to: iso(row.range_end) },
    sourceScope: {
      mode: row.source_scope,
      platforms: [...(row.authorized_platforms || [])],
      categories: (row.authorized_platforms || []).map(categoryForPlatform),
    },
    sampleLimit: row.sample_limit,
    status: row.status,
    phase: row.phase,
    progress: row.progress,
    result: row.status === 'succeeded' ? row.result : null,
    error: row.status === 'failed'
      ? { code: row.error_code || 'topic_report_failed', message: '专题报告生成失败，请重试。' }
      : null,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    ...(includeOwner ? {
      owner: row.consumer_id
        ? { kind: 'consumer', tenantId: row.tenant_id, consumerId: row.consumer_id, apiKeyId: row.api_key_id }
        : { kind: 'admin', createdBy: row.created_by },
      attemptCount: row.attempt_count,
    } : {}),
  }
}

export class TopicReportStore {
  constructor(pool) {
    this.pool = pool
  }

  async create(input, { id = randomUUID(), owner = null, createdBy = 'admin-token' } = {}) {
    const { rows } = await this.pool.query(
      `INSERT INTO insights.topic_reports
         (id, tenant_id, consumer_id, api_key_id, created_by, topic, language,
          range_start, range_end, source_scope, authorized_platforms, sample_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12)
       RETURNING *`,
      [
        id,
        owner?.tenantId || null,
        owner?.consumerId || null,
        owner?.apiKeyId || null,
        String(createdBy || 'admin-token').slice(0, 256),
        input.topic,
        input.language,
        input.rangeStart,
        input.rangeEnd,
        input.sourceScope,
        input.platforms,
        input.sampleLimit,
      ],
    )
    return topicReportRow(rows[0], { includeOwner: !owner })
  }

  async get(id, { consumerId = null, includeOwner = false } = {}) {
    if (!UUID_PATTERN.test(String(id || ''))) {
      throw new AppError(400, 'invalid_request', 'reportId must be a UUID')
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM insights.topic_reports
        WHERE id = $1
          AND ($2::uuid IS NULL OR consumer_id = $2::uuid)`,
      [id, consumerId],
    )
    return topicReportRow(rows[0], { includeOwner })
  }

  async list({ limit = 30 } = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100)
    const { rows } = await this.pool.query(
      `SELECT * FROM insights.topic_reports
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [boundedLimit],
    )
    return rows.map((row) => topicReportRow(row, { includeOwner: true }))
  }

  async claimNext({ workerId, leaseSeconds = 300 } = {}) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT id
           FROM insights.topic_reports
          WHERE status = 'queued'
            AND attempt_count < $1
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [MAX_ATTEMPTS],
      )
      if (!rows[0]) {
        await client.query('COMMIT')
        return null
      }
      const claimed = await client.query(
        `UPDATE insights.topic_reports
            SET status = 'running',
                phase = 'selecting_evidence',
                progress = 10,
                attempt_count = attempt_count + 1,
                locked_by = $2,
                leased_until = now() + make_interval(secs => $3),
                started_at = coalesce(started_at, now()),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [rows[0].id, workerId, leaseSeconds],
      )
      await client.query('COMMIT')
      return claimed.rows[0]
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async heartbeat(claim, leaseSeconds = 300) {
    const result = await this.pool.query(
      `UPDATE insights.topic_reports
          SET leased_until = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [claim.id, claim.locked_by, leaseSeconds],
    )
    return result.rowCount === 1
  }

  async updateProgress(claim, { phase, progress }) {
    const result = await this.pool.query(
      `UPDATE insights.topic_reports
          SET phase = $3, progress = $4, updated_at = now()
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [claim.id, claim.locked_by, phase, progress],
    )
    return result.rowCount === 1
  }

  async complete(claim, result) {
    const updated = await this.pool.query(
      `UPDATE insights.topic_reports
          SET status = 'succeeded', phase = 'complete', progress = 100,
              result = $3::jsonb, error_code = NULL, error_message = NULL,
              locked_by = NULL, leased_until = NULL, completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [claim.id, claim.locked_by, JSON.stringify(result)],
    )
    return updated.rowCount === 1
  }

  async fail(claim, error) {
    const code = typeof error?.code === 'string' ? error.code.slice(0, 128) : 'topic_report_failed'
    const retry = Number(claim.attempt_count || 0) < MAX_ATTEMPTS
    const updated = await this.pool.query(
      `UPDATE insights.topic_reports
          SET status = $3,
              phase = $4,
              progress = CASE WHEN $3 = 'queued' THEN 0 ELSE progress END,
              error_code = $5,
              error_message = $6,
              locked_by = NULL,
              leased_until = NULL,
              completed_at = CASE WHEN $3 = 'failed' THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [claim.id, claim.locked_by, retry ? 'queued' : 'failed', retry ? 'queued' : 'failed', code, 'Report generation failed'],
    )
    return { updated: updated.rowCount === 1, retry }
  }

  async release(claim) {
    const updated = await this.pool.query(
      `UPDATE insights.topic_reports
          SET status = 'queued', phase = 'queued', progress = 0,
              locked_by = NULL, leased_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [claim.id, claim.locked_by],
    )
    return updated.rowCount === 1
  }

  async reclaimExpired() {
    const result = await this.pool.query(
      `UPDATE insights.topic_reports
          SET status = CASE WHEN attempt_count >= $1 THEN 'failed' ELSE 'queued' END,
              phase = CASE WHEN attempt_count >= $1 THEN 'failed' ELSE 'queued' END,
              progress = CASE WHEN attempt_count >= $1 THEN progress ELSE 0 END,
              error_code = CASE WHEN attempt_count >= $1 THEN 'topic_report_lease_expired' ELSE error_code END,
              error_message = CASE WHEN attempt_count >= $1 THEN 'Report generation failed' ELSE error_message END,
              completed_at = CASE WHEN attempt_count >= $1 THEN now() ELSE completed_at END,
              locked_by = NULL, leased_until = NULL, updated_at = now()
        WHERE status = 'running' AND leased_until < now()`,
      [MAX_ATTEMPTS],
    )
    return result.rowCount
  }

  async selectEvidence(claim) {
    const terms = topicSearchTerms(claim.topic)
    const values = [
      claim.authorized_platforms,
      claim.range_start,
      claim.range_end,
      ...terms.map((term) => term.value),
      claim.sample_limit,
    ]
    const termStart = 4
    const predicates = terms.map((_, index) => {
      const parameter = `$${termStart + index}`
      return `(record.title ILIKE '%' || ${parameter} || '%' OR record.body ILIKE '%' || ${parameter} || '%')`
    })
    const scores = terms.map((term, index) => {
      const parameter = `$${termStart + index}`
      return `(CASE WHEN record.title ILIKE '%' || ${parameter} || '%' THEN ${term.weight * 3} ELSE 0 END
             + CASE WHEN record.body ILIKE '%' || ${parameter} || '%' THEN ${term.weight} ELSE 0 END)`
    })
    const limitParameter = `$${values.length}`
    const { rows } = await this.pool.query(
      `SELECT record.id, record.dataset_id, record.platform, record.title, record.body,
              record.url, record.author_name, record.event_time, record.collected_at,
              record.country_code, record.admin1_code, record.stable_fields,
              count(*) OVER ()::bigint AS total_matches,
              coalesce(record.event_time, record.collected_at, record.last_seen_at) AS sort_time
         FROM core.canonical_records record
        WHERE record.platform = ANY($1::text[])
          AND record.deleted_at IS NULL
          AND record.stable_fields #>> '{crawler,publication,eligibility}' = 'candidate'
          AND coalesce(record.event_time, record.collected_at, record.last_seen_at) >= $2::timestamptz
          AND coalesce(record.event_time, record.collected_at, record.last_seen_at) <= $3::timestamptz
          AND (${predicates.join('\n               OR ')})
        ORDER BY (${scores.join('\n                + ')}) DESC,
                 coalesce(record.event_time, record.collected_at, record.last_seen_at) DESC,
                 record.id DESC
        LIMIT ${limitParameter}`,
      values,
    )
    return { rows, terms: terms.map((term) => term.value) }
  }
}

function topicSearchTerms(topic) {
  const normalized = String(topic || '').normalize('NFKC').toLocaleLowerCase('zh-CN')
  const result = []
  const seen = new Set()
  const add = (value, weight = 1) => {
    const term = value.trim()
    if (term.length < 2 || seen.has(term) || result.length >= 12) return
    seen.add(term)
    result.push({ value: term, weight })
  }
  if (normalized.length <= 80) add(normalized, 8)
  for (const part of normalized.split(/[\s,，。；;、:：!！?？/|()（）\[\]【】“”"'与和及]/gu)) {
    if (/^[\p{Script=Han}]+$/u.test(part) && part.length > 4) {
      for (let index = 0; index <= part.length - 3; index += 2) add(part.slice(index, index + 3), 2)
    } else {
      add(part, 3)
    }
  }
  for (const word of normalized.match(/[\p{Letter}\p{Number}]{3,}/gu) || []) add(word, 2)
  return result.length > 0 ? result : [{ value: normalized, weight: 8 }]
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  return normalized ? normalized.slice(0, maxLength) : null
}

function safeUrl(value) {
  const text = safeText(value, 2_048)
  if (!text) return null
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:auth|credential|key|password|secret|signature|token)/iu.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return null
  }
}

function safeArray(value, limit = 24) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => safeText(typeof item === 'object' ? item?.name || item?.label : item, 96)).filter(Boolean))].slice(0, limit)
}

function recordTags(row) {
  return safeArray([
    ...(Array.isArray(row.stable_fields?.tags) ? row.stable_fields.tags : []),
    ...(Array.isArray(row.stable_fields?.attributes?.tags) ? row.stable_fields.attributes.tags : []),
    ...(Array.isArray(row.stable_fields?.keywords) ? row.stable_fields.keywords : []),
  ])
}

function recordLocation(row) {
  return safeText(
    row.stable_fields?.location?.label
      || row.stable_fields?.attributes?.location
      || [row.country_code, row.admin1_code].filter(Boolean).join(' / '),
    96,
  )
}

function increment(map, key, amount = 1) {
  if (!key) return
  map.set(key, (map.get(key) || 0) + amount)
}

function ranked(map, limit, label = (key) => key) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
    .slice(0, limit)
    .map(([key, count]) => ({ id: key, label: label(key), count }))
}

function narrative(report, language) {
  const lead = report.dimensions.categories[0]
  const peak = report.timeline.reduce((current, item) => (!current || item.count > current.count ? item : current), null)
  const location = report.dimensions.locations[0]
  if (language === 'en') {
    return {
      headline: `${report.topic}: evidence map across ${report.coverage.categoryCount} categories`,
      overview: `${report.coverage.matchedRecords} matching canonical records were found; ${report.coverage.analyzedRecords} public-safe records were analyzed for trends and associations.`,
      keyFindings: [
        lead ? `${lead.label} is the leading category with ${lead.count} records.` : 'No leading category was identified.',
        peak ? `Coverage peaks on ${peak.date} with ${peak.count} records.` : 'No clear time peak was identified.',
        location ? `${location.label} is the most frequent explicit location signal.` : 'Most records do not carry an explicit location signal.',
      ],
    }
  }
  return {
    headline: `${report.topic}：${report.coverage.categoryCount} 类数据的证据关联图谱`,
    overview: `时间窗内匹配 ${report.coverage.matchedRecords} 条 canonical 记录，本报告抽取其中 ${report.coverage.analyzedRecords} 条公开安全记录，归纳趋势、主体与交叉线索。`,
    keyFindings: [
      lead ? `${lead.label}是当前最集中的类别，共 ${lead.count} 条证据。` : '当前没有形成明显的类别集中度。',
      peak ? `${peak.date} 出现时间峰值，当日 ${peak.count} 条。` : '当前样本没有形成明显的时间峰值。',
      location ? `显式地域线索以“${location.label}”最集中。` : '多数记录没有携带可公开的显式地域线索。',
    ],
  }
}

export function buildTopicReport(claim, selection, { generatedAt = new Date() } = {}) {
  const rows = selection.rows || []
  const categories = new Map()
  const authors = new Map()
  const locations = new Map()
  const tags = new Map()
  const days = new Map()
  const categoryTags = new Map()
  for (const row of rows) {
    const category = categoryForPlatform(row.platform)
    const rowTags = recordTags(row)
    const location = recordLocation(row)
    const eventTime = iso(row.sort_time)
    increment(categories, category.id)
    increment(authors, safeText(row.author_name, 96))
    increment(locations, location)
    increment(days, eventTime?.slice(0, 10))
    for (const tag of rowTags) {
      increment(tags, tag)
      increment(categoryTags, `${category.id}\u0000${tag}`)
    }
  }
  const evidence = rows.slice(0, 80).map((row) => {
    const category = categoryForPlatform(row.platform)
    const rowTags = recordTags(row)
    const location = recordLocation(row)
    const eventTime = iso(row.sort_time)
    return {
      canonicalId: row.id,
      datasetId: row.dataset_id,
      platform: row.platform,
      category,
      title: safeText(row.title, 320) || '未命名记录',
      summary: safeText(row.body, 420),
      url: safeUrl(row.url),
      author: safeText(row.author_name, 96),
      location,
      tags: rowTags.slice(0, 12),
      eventTime,
    }
  })
  const categoryRanking = ranked(categories, 13, (key) => PLATFORM_CATEGORY[key] || key)
  const tagRanking = ranked(tags, 16)
  const locationRanking = ranked(locations, 10)
  const authorRanking = ranked(authors, 10)
  const timeline = ranked(days, 400).sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, count }) => ({ date: id, count }))
  const nodes = [
    { id: 'topic', type: 'topic', label: claim.topic, weight: rows.length },
    ...categoryRanking.slice(0, 8).map((item) => ({ ...item, id: `category:${item.id}`, type: 'category', weight: item.count })),
    ...tagRanking.slice(0, 10).map((item) => ({ ...item, id: `tag:${item.id}`, type: 'tag', weight: item.count })),
    ...locationRanking.slice(0, 6).map((item) => ({ ...item, id: `location:${item.id}`, type: 'location', weight: item.count })),
    ...authorRanking.slice(0, 6).map((item) => ({ ...item, id: `author:${item.id}`, type: 'author', weight: item.count })),
  ]
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = [
    ...nodes.filter((node) => node.id !== 'topic').map((node) => ({ from: 'topic', to: node.id, weight: node.weight })),
    ...ranked(categoryTags, 16).flatMap((item) => {
      const [categoryId, tag] = item.id.split('\u0000')
      const from = `category:${categoryId}`
      const to = `tag:${tag}`
      return nodeIds.has(from) && nodeIds.has(to) ? [{ from, to, weight: item.count }] : []
    }),
  ]
  const totalMatches = Number(rows[0]?.total_matches || rows.length)
  const report = {
    contractVersion: TOPIC_REPORT_CONTRACT_VERSION,
    generatedAt: generatedAt.toISOString(),
    topic: claim.topic,
    language: claim.language,
    window: { from: iso(claim.range_start), to: iso(claim.range_end) },
    coverage: {
      matchedRecords: totalMatches,
      analyzedRecords: rows.length,
      evidenceRecords: evidence.length,
      categoryCount: categories.size,
      truncated: totalMatches > rows.length,
    },
    executiveSummary: null,
    timeline,
    dimensions: {
      categories: categoryRanking,
      tags: tagRanking,
      locations: locationRanking,
      authors: authorRanking,
    },
    associations: { nodes, edges },
    evidence,
    methodology: {
      dataBasis: 'postgresql_canonical_truth',
      projectionDependency: 'none',
      matching: 'bounded_phrase_and_term_evidence_v1',
      matchedTerms: selection.terms,
      publicationVisibility: 'candidate_only',
      sampleLimit: claim.sample_limit,
      limitations: [
        'Associations are evidence co-occurrences, not causal claims.',
        'Counts reflect the authorized canonical corpus available when the task ran.',
        'No raw payload, connector credential, or internal source identity is exposed.',
      ],
    },
  }
  report.executiveSummary = narrative(report, claim.language)
  return report
}

export async function generateTopicReport({ store, claim }) {
  const selection = await store.selectEvidence(claim)
  const ownsClaim = await store.updateProgress(claim, {
    phase: 'building_associations',
    progress: 65,
  })
  if (!ownsClaim) {
    const error = new Error('Topic report lease was lost')
    error.code = 'topic_report_lease_lost'
    throw error
  }
  return buildTopicReport(claim, selection)
}
