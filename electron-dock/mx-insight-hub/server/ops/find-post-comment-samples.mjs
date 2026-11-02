import { pathToFileURL } from 'node:url'

// Standalone Admin stdin tool. Saved inputs are data, never destinations or
// commands. Default output has no platform IDs, URLs, authors, text or tokens.
const PLATFORMS = ['reddit', 'kuaishou']
const DATASETS = ['night-all.search.v1', 'night-all.compat.v1']
const PATHS = ['/api/v1/search/post-comments', '/api/v1/night-all/search/post-comments', '/api/v1/data/social/post-comments']
const INCIDENT = 'af456ad4-2523-4f73-a1fc-c95104b329a4'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = value => typeof value === 'string' && value.length <= 256 ? value.trim()
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : null
const identity = (platform, value) => {
  const normalized = string(value)
  const text = platform === 'reddit' ? normalized?.replace(/^t3_/u, '') : normalized
  return platform === 'reddit' ? /^[a-z0-9]{1,17}$/u.test(text || '') ? text : null
    : platform === 'kuaishou' && /^[A-Za-z0-9_-]{1,128}$/u.test(text || '') ? text : null
}
function urlIdentity(platform, value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    const hosts = platform === 'reddit' ? ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com']
      : ['kuaishou.com', 'www.kuaishou.com']
    if (!hosts.includes(url.hostname)) return null
    return identity(platform, url.pathname.match(platform === 'reddit' ? /\/comments\/([a-z0-9]+)(?:\/|$)/u
      : /\/(?:short-video|photo)\/([A-Za-z0-9_-]+)(?:\/|$)/u)?.[1])
  } catch { return null }
}

export function normalizeCommentSampleTarget(platform, body) {
  if (!PLATFORMS.includes(platform) || !object(body)) return null
  const aliases = ['postId', 'contentId', 'post_id', 'content_id', ...(platform === 'kuaishou' ? ['photoId', 'photo_id', 'videoId', 'video_id'] : [])]
  const ids = aliases.filter(key => body[key] != null).map(key => identity(platform, body[key]))
  if (ids.some(id => id === null)) return null
  const urlId = urlIdentity(platform, body.url)
  if (urlId) ids.push(urlId)
  return ids.length && new Set(ids).size === 1 ? ids[0] : null
}

function usageSample(row) {
  if (!UUID.test(row?.id || '') || !PLATFORMS.includes(row.platform) || row.method !== 'POST'
    || !PATHS.includes(row.path) || !object(row.body) || row.body.platform !== row.platform
    || row.body.page != null && row.body.page !== 1 && row.body.page !== '1'
    || row.body.cursor != null && row.body.cursor !== ''
    || row.body.params != null && (!object(row.body.params) || Object.keys(row.body.params).length !== 0)) return null
  const postId = normalizeCommentSampleTarget(row.platform, row.body)
  return postId ? { revision: 'post-comment-target-sample.v1', platform: row.platform, postId,
    sourceKind: 'usage', sourceId: row.id } : null
}

function canonicalSample(row, platform) {
  if (!UUID.test(row?.id || '') || row.platform !== platform || row.object_type !== 'post') return null
  // Kuaishou's stored external ID can be internal cid, whereas its public URL
  // carries photoId. Do not manufacture a conflict or call photo_id with cid.
  // Reddit's URL may instead be an outbound article, so prefer its post ID.
  const postId = platform === 'kuaishou' ? urlIdentity(platform, row.url)
    : identity(platform, row.external_id) ?? urlIdentity(platform, row.url)
  return postId ? { revision: 'post-comment-target-sample.v1', platform, postId,
    sourceKind: 'canonical', sourceId: row.id } : null
}

async function optionalRead(client, sql, values = []) {
  await client.query('SAVEPOINT comment_sample_read')
  try {
    const result = await client.query(sql, values)
    await client.query('RELEASE SAVEPOINT comment_sample_read')
    return { state: 'read', rows: result.rows }
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT comment_sample_read')
    await client.query('RELEASE SAVEPOINT comment_sample_read')
    return { state: error.code === '57014' ? 'timed_out' : ['42P01', '42703'].includes(error.code) ? 'schema_unavailable' : 'read_failed', rows: [] }
  }
}

// Filtering happens only after an indexed, bounded ID slice. Released legacy
// failures are absent from the quota index, so do not rely on it for discovery.
function usagesQuery(incidentWindow) {
  return `WITH recent AS MATERIALIZED (
    SELECT id, created_at FROM public.usage_requests
    ${incidentWindow ? "WHERE created_at >= $1::timestamptz - interval '1 hour' AND created_at <= $1::timestamptz + interval '1 hour'" : ''}
    ORDER BY created_at DESC LIMIT 5000
  ), matches AS MATERIALIZED (
    SELECT u.id,u.platform,u.acquisition_request,r.created_at FROM recent r
    JOIN public.usage_requests u ON u.id=r.id
    WHERE u.platform IN ('reddit','kuaishou')
      AND u.acquisition_request->>'path' IN ('/api/v1/search/post-comments','/api/v1/night-all/search/post-comments','/api/v1/data/social/post-comments')
    ORDER BY r.created_at DESC LIMIT 50
  ) SELECT /* comment-samples:usages */ id,platform,acquisition_request->>'method' AS method,
    acquisition_request->>'path' AS path,
    CASE WHEN octet_length(acquisition_request::text) <= 16384 THEN acquisition_request->'body' END AS body
    FROM matches ORDER BY created_at DESC`
}

export async function discoverPostCommentSamples(pool, { preparePlatform = null, sourceKind = null, sourceId = null } = {}) {
  if (preparePlatform !== null && !PLATFORMS.includes(preparePlatform)) throw new Error('invalid_arguments')
  const pinned = sourceKind !== null || sourceId !== null
  if (pinned && (preparePlatform === null || !['usage', 'canonical'].includes(sourceKind)
    || typeof sourceId !== 'string' || !UUID.test(sourceId))) throw new Error('invalid_arguments')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '4s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    // Once discovery returned a source UUID, read that exact record via its
    // primary key. Do not rescan a hot dataset or silently select another post.
    if (pinned) {
      const { rows } = sourceKind === 'usage'
        ? await client.query(`SELECT /* comment-samples:source-usage */ id,platform,
          acquisition_request->>'method' AS method,acquisition_request->>'path' AS path,
          CASE WHEN octet_length(acquisition_request::text)<=16384 THEN acquisition_request->'body' END AS body
          FROM public.usage_requests WHERE id=$1::uuid AND platform=$2`, [sourceId, preparePlatform])
        : await client.query(`SELECT /* comment-samples:source-canonical */ id,dataset_id,platform,object_type,deleted_at,
          CASE WHEN length(external_id)<=256 THEN external_id END AS external_id,
          CASE WHEN length(url)<=2048 THEN url END AS url
          FROM core.canonical_records WHERE id=$1::uuid AND platform=$2
            AND dataset_id=ANY($3::text[]) AND object_type='post' AND deleted_at IS NULL`,
        [sourceId, preparePlatform, DATASETS])
      const row = rows.length === 1 ? rows[0] : null
      if (!row || row.id !== sourceId || row.platform !== preparePlatform
        || sourceKind === 'canonical' && (!DATASETS.includes(row.dataset_id) || row.deleted_at !== null)) {
        throw new Error('sample_source_unavailable')
      }
      const sample = sourceKind === 'usage' ? usageSample(row) : canonicalSample(row, preparePlatform)
      if (!sample) throw new Error('sample_source_unavailable')
      return sample
    }
    const scans = [], selected = new Map()
    const incident = await optionalRead(client, `SELECT /* comment-samples:incident */ created_at
      FROM public.usage_requests WHERE id=$1::uuid`, [INCIDENT])
    const timestamp = incident.rows[0]?.created_at
    scans.push({ source: 'incident_anchor', state: incident.state === 'read' && !timestamp ? 'not_found' : incident.state })
    for (const [source, at] of [...(timestamp ? [['incident_window', timestamp]] : []), ['recent_usages', null]]) {
      const read = await optionalRead(client, usagesQuery(at !== null), at === null ? [] : [at])
      scans.push({ source, state: read.state, matchedRows: read.rows.length, matchLimitReached: read.rows.length === 50 })
      for (const row of read.rows) {
        const sample = usageSample(row)
        if (sample && !selected.has(sample.platform)) selected.set(sample.platform, sample)
      }
    }
    for (const platform of PLATFORMS) {
      if (selected.has(platform)) continue
      const candidates = []
      for (const dataset of DATASETS) {
        const read = await optionalRead(client, `SELECT /* comment-samples:canonical */ id,platform,object_type,
          CASE WHEN length(external_id)<=256 THEN external_id END AS external_id,
          CASE WHEN length(url)<=2048 THEN url END AS url,
          CASE WHEN length(stable_fields #>> '{metrics,comments}')<=30 THEN stable_fields #>> '{metrics,comments}' END AS comment_count
          FROM core.canonical_records
          WHERE dataset_id=$1 AND platform=$2 AND object_type='post' AND deleted_at IS NULL
          ORDER BY event_time DESC,id DESC LIMIT 50`, [dataset, platform])
        scans.push({ source: 'canonical', platform, dataset, state: read.state, matchedRows: read.rows.length,
          matchLimitReached: read.rows.length === 50 })
        for (const row of read.rows) {
          const sample = canonicalSample(row, platform)
          if (sample) candidates.push({ sample, positiveComments: /^\d{1,20}$/u.test(String(row.comment_count ?? '')) && BigInt(row.comment_count) > 0n })
        }
      }
      candidates.sort((left, right) => Number(right.positiveComments) - Number(left.positiveComments))
      if (candidates.length) selected.set(platform, candidates[0].sample)
    }
    if (preparePlatform !== null) {
      const sample = selected.get(preparePlatform)
      if (!sample) throw new Error(scans.some(row => ['timed_out', 'schema_unavailable', 'read_failed'].includes(row.state))
        ? 'sample_discovery_incomplete' : 'sample_not_found')
      return sample
    }
    return { revision: 'post-comment-sample-discovery.v1',
      results: PLATFORMS.map(platform => {
        const sample = selected.get(platform)
        return { platform, state: sample ? 'found' : scans.some(row => ['timed_out', 'schema_unavailable', 'read_failed'].includes(row.state))
          ? 'discovery_incomplete' : 'not_found_in_bounded_scan', sourceKind: sample?.sourceKind ?? null, sourceId: sample?.sourceId ?? null }
      }), scans, limits: { usageRowsPerWindow: 5000, matchedRequestsPerWindow: 50, canonicalRowsPerDataset: 50 },
      supplierHttpCallsMade: 0, databaseWritesMade: 0,
      boundary: 'Bounded saved request and canonical post discovery only. A found target is not a guarantee of live comments. No match does not prove global absence. No platform post IDs, URLs, text, authors or credentials are returned in this summary.' }
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release() }
  }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const args = process.argv.slice(2)
    if (args.length && (![2, 6].includes(args.length) || args[0] !== '--prepare' || !PLATFORMS.includes(args[1])
      || args.length === 6 && (args[2] !== '--source-kind' || !['usage', 'canonical'].includes(args[3])
        || args[4] !== '--source-id' || !UUID.test(args[5])))) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      query_timeout: 5000, options: '-c default_transaction_read_only=on -c statement_timeout=4000 -c lock_timeout=1000' })
    console.log(JSON.stringify(await discoverPostCommentSamples(pool, { preparePlatform: args[1] ?? null,
      sourceKind: args[3] ?? null, sourceId: args[5] ?? null }), null, 2))
  } catch (error) {
    const safe = ['invalid_arguments', 'database_url_required', 'sample_not_found', 'sample_discovery_incomplete', 'sample_source_unavailable']
    console.error(JSON.stringify({ error: safe.includes(error.message) ? error.message : 'comment_sample_discovery_failed',
      supplierHttpCallsMade: 0, databaseWritesMade: 0 }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
