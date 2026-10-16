import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { normalizeSearchContent, normalizeSearchMedia } from '../contracts/search-content.mjs'
import { hasNoContentTitle } from '../contracts/social-content-title.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PLATFORMS = new Set(['douyin', 'reddit', 'twitter', 'facebook', 'weibo', 'instagram'])
const STAGES = new Set(['arguments', 'database_connection', 'begin_read_only', 'select_deliveries', 'select_linked_snapshots',
  'read_committed_delivery', 'read_compatibility_snapshot', 'select_canonical', 'read_canonical', 'rollback'])
const SQL_STATES = { '57014': 'query_timeout_or_cancelled', '55P03': 'lock_unavailable', '42501': 'insufficient_privilege',
  '42P01': 'missing_relation', '42703': 'missing_column', '3F000': 'missing_schema', '25006': 'read_only_violation' }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(String(value)).digest('hex')
const identity = value => typeof value === 'string' && /^[\w:.-]{1,200}$/.test(value) ? value : null
const list = value => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}
const url = value => typeof value === 'string' ? value : object(value) ? value.url || value.playUrl || value.play_url || '' : ''
const text = row => [row.title, row.full_text, row.content, row.text, row.body].filter(value => typeof value === 'string').join('\n')
const authorId = row => String(row.author_external_id ?? row.author_id ?? row.authorId ?? row.author?.id ?? row.user_id ?? '')
const postId = row => String(row.external_id ?? row.externalId ?? row.content_id ?? row.id ?? '')

// Hash the path too: CDN paths can themselves contain signed/bearer material.
// Matching path hashes are only candidates, never proof of equivalent images.
export function describeMediaUrl(value) {
  const raw = url(value)
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:'].includes(parsed.protocol)) return { hash: hash(raw), state: 'non_http' }
    return { hash: hash(raw), host: parsed.hostname, pathHash: hash(`${parsed.hostname}${parsed.pathname}`),
      queryKeys: [...new Set(parsed.searchParams.keys())].map(key => /^[a-zA-Z_][\w.-]{0,63}$/.test(key) ? key : '[other]').sort(),
      hasCredentials: Boolean(parsed.username || parsed.password), hasFragment: Boolean(parsed.hash) }
  } catch { return { hash: hash(raw), state: 'invalid_url' } }
}

function mediaEvidence(row) {
  const media = row.stable_fields?.media || row.media || {}
  const groups = {
    image_urls: list(row.image_urls), images: list(row.images), 'media.images': list(media.images),
    video_urls: list(row.video_urls), videos: list(row.videos), 'media.videos': list(media.videos),
  }
  const allVideos = [...groups.video_urls, ...groups.videos, ...groups['media.videos']]
  const videos = allVideos.slice(0, 100)
  const covers = [row.cover_url, row.coverUrl, media.cover_url, media.coverUrl,
    ...videos.flatMap(item => object(item) ? [item.coverUrl, item.cover_url, item.thumbnailUrl, item.thumbnail_url] : [])]
    .filter(value => typeof value === 'string' && value)
  const uniqueCovers = [...new Set(covers)].map(describeMediaUrl)
  const entries = Object.entries(groups).flatMap(([field, values]) => values.slice(0, 100).map((value, index) => {
    const descriptor = describeMediaUrl(value)
    if (!descriptor) return null
    return { field, index, ...descriptor,
      exactCoverMatch: uniqueCovers.some(cover => cover.hash === descriptor.hash),
      samePathDifferentUrl: Boolean(descriptor.pathHash && uniqueCovers.some(cover => cover.pathHash === descriptor.pathHash && cover.hash !== descriptor.hash)) }
  }).filter(Boolean))
  return { counts: Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, values.length])),
    entriesTruncated: Object.values(groups).some(values => values.length > 100), coverMetadataTruncated: allVideos.length > 100,
    covers: uniqueCovers, entries,
    explicitSourceMetadata: { thumbnail: Object.hasOwn(row, 'thumbnail'), preview: Object.hasOwn(row, 'preview'),
      resolutions: Object.hasOwn(row, 'resolutions') } }
}

export function inspectSearchRow(row, platform, format = 'raw') {
  const before = mediaEvidence(row)
  const normalized = format === 'canonical'
    ? { ...row, title: hasNoContentTitle(platform, { objectType: row.object_type, contentType: row.content_type }) ? null : row.title,
      stable_fields: { ...row.stable_fields, media: normalizeSearchMedia(row.stable_fields?.media, platform,
        { objectType: row.object_type, contentType: row.content_type }) } }
    : format === 'data' ? normalizeSearchContent({ data: { items: [row] } }, platform).data.items[0]
      : normalizeSearchContent({ data: { raw_data: [row] } }, platform, { format: 'raw' }).data.raw_data[0]
  const after = mediaEvidence(normalized)
  return { postExternalId: identity(postId(row)), authorExternalId: identity(authorId(row)),
    title: { present: typeof row.title === 'string' && row.title.length > 0,
      length: typeof row.title === 'string' ? row.title.length : 0,
      suppressedByCurrentPolicy: Boolean(row.title && !normalized.title) },
    before, currentNormalization: { mediaChanged: JSON.stringify(before) !== JSON.stringify(after), after },
    note: 'samePathDifferentUrl is a candidate only; this report does not compare pixels or repair data' }
}

export function extractSearchRows(body) {
  const results = [], queue = [{ data: body?.data, depth: 0 }]
  let containers = 0, truncated = false
  while (queue.length && containers++ < 100) {
    const { data, depth } = queue.shift()
    if (!object(data)) continue
    for (const [key, format] of [['raw_data', 'raw'], ['items', 'data']]) {
      const rows = list(data[key])
      if (rows.length > 500) truncated = true
      for (const row of rows.slice(0, 500)) if (object(row)) results.push({ row, format })
    }
    const children = list(data.results)
    if (depth >= 4 && children.length) truncated = true
    else queue.push(...children.slice(0, 100).map(child => ({ data: child?.data || child, depth: depth + 1 })))
    if (children.length > 100 || results.length > 1000) { truncated = true; break }
  }
  return { rows: results.slice(0, 1000), truncated: truncated || queue.length > 0 }
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const options = { recent: 50, limit: 20 }
  const keys = { '--platform': 'platform', '--post-id': 'postId', '--author-id': 'authorId', '--text': 'text', '--request-id': 'requestId', '--recent': 'recent', '--limit': 'limit' }
  for (let i = 0; i < args.length; i += 2) {
    const key = keys[args[i]], value = args[i + 1]
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key) && !['recent', 'limit'].includes(key)) throw new Error('invalid_arguments')
    options[key] = ['recent', 'limit'].includes(key) ? Number(value) : value
  }
  validate(options)
  return options
}

function validate(options) {
  if (!PLATFORMS.has(options.platform)) throw new Error('invalid_platform')
  if (!options.postId && !options.authorId && !options.text && !options.requestId) throw new Error('selector_required')
  if (options.postId && !identity(options.postId)) throw new Error('invalid_post_id')
  if (options.authorId && !identity(options.authorId)) throw new Error('invalid_author_id')
  if (options.text && (typeof options.text !== 'string' || options.text.trim().length < 3 || options.text.length > 300)) throw new Error('invalid_text')
  if (options.requestId && !UUID.test(options.requestId)) throw new Error('invalid_request_id')
  if (!Number.isInteger(options.recent) || options.recent < 1 || options.recent > 200 || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) throw new Error('invalid_limit')
}

export function diagnosticErrorReport(error, fallbackStage = 'arguments') {
  const known = new Set(['invalid_arguments', 'invalid_platform', 'selector_required', 'invalid_post_id', 'invalid_author_id', 'invalid_text', 'invalid_request_id', 'invalid_limit', 'database_url_required'])
  const stage = STAGES.has(error.diagnosticStage) ? error.diagnosticStage : STAGES.has(fallbackStage) ? fallbackStage : 'unknown'
  return { error: known.has(error.message) ? error.message : 'diagnostic_read_failed', stage,
    ...(Object.hasOwn(SQL_STATES, error.code || '') ? { sqlState: error.code, reason: SQL_STATES[error.code] } : {}) }
}

// Only stored Hub deliveries, linked caches and current canonical search rows.
// No provider adapter imports, requests, writes, temporary tables or repairs.
export async function diagnoseSearchMedia(client, input) {
  const options = { recent: 50, limit: 20, ...input }
  validate(options)
  const matches = row => (!options.postId || postId(row) === options.postId)
    && (!options.authorId || authorId(row) === options.authorId) && (!options.text || text(row).includes(options.text))
  const results = [], sources = []
  let stage = 'begin_read_only'
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    stage = 'select_deliveries'
    const { rows: deliveries } = await client.query(`SELECT id, created_at, response_captured_at AS captured_at, compatibility_snapshot_id FROM public.usage_requests
      WHERE platform=$1 AND status='committed' AND response_status=200 AND response_body IS NOT NULL
        AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at DESC, id DESC LIMIT $3`, [options.platform, options.requestId || null, options.recent])
    const snapshotIds = [...new Set(deliveries.map(row => row.compatibility_snapshot_id).filter(Boolean))]
    stage = 'select_linked_snapshots'
    const { rows: snapshots } = await client.query(`SELECT id, created_at, captured_at FROM serving.compatibility_snapshots
      WHERE platform=$1 AND id=ANY($2::uuid[]) LIMIT $3`, [options.platform, snapshotIds, options.recent])
    for (const [source, table, rows] of [['committed_delivery', 'public.usage_requests', deliveries], ['compatibility_snapshot', 'serving.compatibility_snapshots', snapshots]]) {
      const summary = { source, selected: rows.length, inspected: 0, matched: 0, missingOrOversized: 0, rowsTruncated: false }
      sources.push(summary)
      for (const entry of rows) {
        if (results.length >= options.limit) break
        stage = `read_${source}`
        const { rows: [stored] } = await client.query(`SELECT response_body FROM ${table} WHERE id=$1 AND octet_length(response_body::text)<=8388608`, [entry.id])
        summary.inspected++
        if (!stored) { summary.missingOrOversized++; continue }
        const extracted = extractSearchRows(stored.response_body)
        summary.rowsTruncated ||= extracted.truncated
        for (const { row, format } of extracted.rows) if (matches(row)) {
          summary.matched++
          if (results.length < options.limit) results.push({ source, sourceId: entry.id, createdAt: entry.created_at ?? null, capturedAt: entry.captured_at ?? null, format,
            ...inspectSearchRow(row, options.platform, format) })
        }
      }
    }
    // A request id alone does not prove a link to the current canonical version.
    if (!options.requestId || options.postId || options.authorId || options.text) {
      stage = 'select_canonical'
      const { rows: candidates } = await client.query(`SELECT id, collected_at,
        coalesce(event_time, collected_at, last_seen_at, first_seen_at) AS feed_time FROM core.canonical_records
        WHERE dataset_id=ANY($1::text[]) AND platform=$2 AND object_type='post' AND deleted_at IS NULL
          AND ($3::text IS NULL OR author_external_id=$3)
          AND ($4::text IS NULL OR external_id=$4)
        ORDER BY coalesce(event_time, collected_at, last_seen_at, first_seen_at) DESC, id DESC LIMIT $5`, [['night-all.search.v1', 'night-all.compat.v1'], options.platform, options.authorId || null, options.postId || null, options.recent])
      const summary = { source: 'canonical_current', windowOrder: 'event_time_then_collected_at_then_last_seen_at_then_first_seen_at',
        selection: options.postId ? 'exact_external_id_within_search_datasets' : 'bounded_recent_window',
        datasetIds: ['night-all.search.v1', 'night-all.compat.v1'],
        selected: candidates.length, inspected: 0, matched: 0, missingOrOversized: 0 }
      sources.push(summary)
      for (const entry of candidates) {
        if (results.length >= options.limit) break
        stage = 'read_canonical'
        const { rows: [row] } = await client.query(`SELECT id, external_id, author_external_id, object_type, content_type, title, body, stable_fields, current_revision, dataset_id
          FROM core.canonical_records WHERE id=$1 AND octet_length(stable_fields::text)+octet_length(coalesce(body,''))+octet_length(coalesce(title,''))<=8388608`, [entry.id])
        summary.inspected++
        if (!row) { summary.missingOrOversized++; continue }
        if (matches(row)) {
          summary.matched++
          results.push({ source: 'canonical_current', sourceId: entry.id, collectedAt: entry.collected_at ?? null, feedTime: entry.feed_time ?? null,
            datasetId: row.dataset_id, revision: row.current_revision, ...inspectSearchRow(row, options.platform, 'canonical') })
        }
      }
    }
    stage = 'rollback'
    await client.query('ROLLBACK')
    return { mode: 'stored_read_only', platform: options.platform, postId: options.postId || null, requestId: options.requestId || null,
      scope: options.requestId ? 'exact_delivery_and_linked_snapshot; optional canonical selectors are independent' : 'bounded_recent_window; zero matches does not prove absence',
      recentPerSource: options.recent, resultLimit: options.limit, resultLimitReached: results.length >= options.limit,
      snapshotScope: 'only_snapshots_linked_from_selected_deliveries',
      rawProviderArchivesInspected: false, downstreamSavedCopiesInspected: false, sources, results }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    error.diagnosticStage = stage
    throw error
  }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client
  let stage = 'arguments'
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) console.log('Usage: node server/ops/diagnose-search-media.mjs --platform douyin|reddit|twitter|facebook|weibo|instagram [--post-id ID] [--author-id ID] [--text TEXT] [--request-id UUID] [--recent 1..200] [--limit 1..50]\nAt least one selector is required. Selectors are ANDed. Post ID filters canonical external_id within night-all.search.v1/night-all.compat.v1; canonical lookup is independent of request ID. Deliveries still use a bounded recent window unless request ID is supplied. Stored reads only; no signed URLs or body text printed. No match in a bounded recent window does not prove absence.')
    else {
      if (!process.env.DATABASE_URL) throw new Error('database_url_required')
      stage = 'database_connection'
      client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
      await client.connect()
      console.log(JSON.stringify(await diagnoseSearchMedia(client, options), null, 2))
    }
  } catch (error) {
    console.error(JSON.stringify(diagnosticErrorReport(error, stage)))
    process.exitCode = 1
  } finally { await client?.end() }
}
