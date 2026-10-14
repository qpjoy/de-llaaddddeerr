import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

// Stdin runs from the deployed /app working directory without writing a file.
// Normal module imports resolve relative to this saved source instead.
const contracts = process.argv[1] === '-'
  ? pathToFileURL(`${process.cwd()}/server/contracts/`) : new URL('../contracts/', import.meta.url)
const { normalizeHubSocialRequest, normalizeTwitterResponse, HUB_SOCIAL_VERSION } = await import(new URL('hub-social.mjs', contracts))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BYTES = 4 * 1024 * 1024
const MAX_NODES = 10000
const ROUTES = new Set(['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw', '/api/v1/data/social/search'])
const REASONS = new Set(['invalid_response_shape', 'upstream_business_errors', 'invalid_timeline_shape',
  'timeline_too_large', 'upstream_page_exceeds_requested_count'])
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const object = value => kind(value) === 'object'
const shape = value => ({ type: kind(value), ...(typeof value === 'string' ? { length: value.length } : {}) })
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const known = (value, choices) => choices.includes(value) ? value : 'other_or_missing'
const listCount = value => Array.isArray(value) ? value.length : null
const resultType = value => known(value, ['Tweet', 'LegacyTweet', 'TweetWithVisibilityResults', 'TweetUnavailable', 'TweetTombstone'])

export function twitterInputShapes(snapshot) {
  const body = snapshot?.body
  return { savedBody: kind(body), fields: Object.fromEntries(['platform', 'query', 'keyword', 'pageSize',
    'count', 'limit', 'cursor', 'page', 'type', 'sort', 'params'].map(key => [key, shape(body?.[key])])),
  requestedPageSize: integer(body?.pageSize), count: integer(body?.count), limit: integer(body?.limit),
  resultType: known(body?.type, ['fresh', 'stable']), sort: known(body?.sort, ['top', 'latest']) }
}

// Traverse fixed structural fields only. Never print source text, query/token
// values, IDs, arbitrary field names, URLs or exception messages.
function timelineShape(payload) {
  const root = object(payload?.data) ? payload.data : payload
  const summary = { payload: kind(payload), data: kind(payload?.data), root: kind(root),
    errors: listCount(payload?.errors), rootErrors: listCount(root?.errors),
    rootError: kind(root?.error), rootMessage: kind(root?.message),
    instructionCount: 0, instructionTypes: {}, entryCount: 0, entries: [],
    moduleItemsCount: 0, itemsCount: 0, moduleCount: 0,
    tweetResultCount: 0, tweetResultTypes: {}, tweetLegacyCount: 0, tweetStringIdentityCount: 0,
    tweetNumericIdentityCount: 0, bottomCursorCount: 0, showMoreCursorCount: 0, topCursorCount: 0,
    nodesInspected: 0, truncated: false }
  const pending = [payload], seen = new Set()
  const enqueue = value => {
    if (!object(value)) return
    if (pending.length < MAX_NODES) pending.push(value)
    else summary.truncated = true
  }
  for (let index = 0; index < pending.length && index < MAX_NODES; index++) {
    const node = pending[index]
    if (!object(node) || seen.has(node)) continue
    seen.add(node); summary.nodesInspected++
    if (Array.isArray(node.instructions)) {
      summary.instructionCount += node.instructions.length
      for (const instruction of node.instructions.slice(0, MAX_NODES)) {
        const type = known(instruction?.type, ['TimelineAddEntries', 'TimelineReplaceEntry', 'TimelineAddToModule',
          'TimelineTerminateTimeline', 'TimelineClearCache', 'TimelinePinEntry'])
        summary.instructionTypes[type] = (summary.instructionTypes[type] || 0) + 1
      }
    }
    if (Array.isArray(node.entries)) {
      summary.entryCount += node.entries.length
      for (const entry of node.entries.slice(0, 20)) {
        if (summary.entries.length >= 20) break
        const content = entry?.content, item = content?.itemContent, result = item?.tweet_results?.result
        summary.entries.push({ content: kind(content), itemContent: kind(item),
          itemType: known(item?.itemType, ['TimelineTweet', 'TimelineUser', 'TimelineTombstone']),
          tweetResults: kind(item?.tweet_results), result: kind(result), resultType: resultType(result?.__typename),
          tweet: kind(result?.tweet), legacy: kind((result?.tweet || result)?.legacy),
          items: listCount(content?.items), moduleItems: listCount(content?.moduleItems),
          cursorType: known(content?.cursorType, ['Bottom', 'Top', 'ShowMore']) })
      }
    }
    if (Array.isArray(node.moduleItems)) summary.moduleItemsCount += node.moduleItems.length
    if (Array.isArray(node.items)) summary.itemsCount += node.items.length
    if (node.entryType === 'TimelineTimelineModule') summary.moduleCount++
    if (node.cursorType === 'Bottom') summary.bottomCursorCount++
    if (node.cursorType === 'ShowMore') summary.showMoreCursorCount++
    if (node.cursorType === 'Top') summary.topCursorCount++
    if (object(node.tweet_results)) {
      const result = node.tweet_results.result, tweet = object(result?.tweet) ? result.tweet : result
      summary.tweetResultCount++
      const type = resultType(result?.__typename)
      summary.tweetResultTypes[type] = (summary.tweetResultTypes[type] || 0) + 1
      if (object(tweet?.legacy)) summary.tweetLegacyCount++
      if (typeof tweet?.rest_id === 'string' && /^\d{1,30}$/.test(tweet.rest_id)) summary.tweetStringIdentityCount++
      if (typeof tweet?.rest_id === 'number') summary.tweetNumericIdentityCount++
    }
    for (const field of ['data', 'search_by_raw_query', 'search_timeline', 'timeline', 'timeline_v2',
      'user', 'result', 'module', 'content', 'itemContent', 'item', 'tweet_results', 'tweet', 'entry']) enqueue(node[field])
    for (const field of ['instructions', 'entries', 'items', 'moduleItems']) {
      if (!Array.isArray(node[field])) continue
      if (node[field].length > MAX_NODES) summary.truncated = true
      for (const child of node[field].slice(0, MAX_NODES)) enqueue(child)
    }
  }
  summary.entriesTruncated = summary.entryCount > summary.entries.length
  return summary
}

export function inspectTwitterArchive(archive, snapshot, { httpStatus = 200 } = {}) {
  if (!archive) return { state: 'archive_missing' }
  if (integer(archive.body_size) !== null && archive.body_size > MAX_BYTES) return { state: 'archive_too_large' }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (bytes?.length > MAX_BYTES) return { state: 'archive_too_large' }
  if (!bytes || (integer(archive.body_size) !== null && bytes.length !== archive.body_size)
    || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) return { state: 'archive_integrity_failed' }
  const integrity = { hashVerified: true, bodySize: bytes.length, bodySha256: archive.body_sha256 }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')) }
  catch { return { state: 'archive_not_json', ...integrity } }
  const structure = timelineShape(payload)
  if (httpStatus !== 200) return { state: 'not_success_http', ...integrity, structure }
  const body = snapshot?.body
  if (!ROUTES.has(snapshot?.path) || !['twitter', 'x'].includes(body?.platform?.trim?.().toLowerCase())
    || body.cursor || body.params?.cursor || (body.page ?? 1) !== 1) {
    return { state: 'projection_requires_original_first_page_request', ...integrity, structure }
  }
  const standard = snapshot.path === '/api/v1/data/search'
  const query = standard ? body.query : body.query ?? body.keyword
  const pageSize = standard ? body.pageSize ?? 20 : body.count ?? body.pageSize ?? body.limit ?? 20
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > (standard ? 100 : 50)
    || typeof query !== 'string' || !query.trim() || query.length > 500) return { state: 'invalid_saved_search_parameters', ...integrity, structure }
  const date = new Date(archive.captured_at)
  if (!Number.isFinite(date.getTime())) return { state: 'invalid_archive_timestamp', ...integrity, structure }
  let request
  try { request = normalizeHubSocialRequest('search', { platform: 'twitter', query, count: Math.min(pageSize, 50),
    sort: standard ? 'top' : body.sort ?? 'latest' }) }
  catch { return { state: 'invalid_saved_search_parameters', ...integrity, structure } }
  if (standard) request.standardSearch = true
  const mapping = { evidence: 'current_mapping_from_saved_input', method: 'GET', endpointPathTemplate: '/search/{encoded-query}',
    queryLength: request.query.length, requestedPageSize: pageSize, providerCount: request.count,
    category: request.upstreamQuery.category, includeTimestamp: request.upstreamQuery.includeTimestamp }
  try {
    const result = normalizeTwitterResponse(payload, request, { capturedAt: date.toISOString(), encodeCursor: () => 'offline-not-a-cursor' })
    return { state: 'current_projection_accepts', ...integrity, structure, mapping,
      returnedCount: result.data.items.length, duplicateCount: result.data.page.duplicateCount,
      discardedCount: result.data.page.discardedCount, hasMore: result.data.page.hasMore, deliveryStatus: result.data.status }
  } catch (error) {
    return { state: 'current_projection_rejects', ...integrity, structure, mapping,
      reason: REASONS.has(error.message) ? error.message : 'unexpected_projection_error' }
  }
}

export async function diagnoseTwitterSearch(pool, requestId) {
  if (!UUID.test(requestId)) throw new Error('invalid_request_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    const { rows: [request] } = await client.query(`SELECT id, platform, status, response_status, error_code,
      reserved_at, completed_at, acquisition_request,
      response_body->'data'->>'contractVersion' AS delivery_contract_version,
      response_body->'data'->>'status' AS delivery_status,
      response_body->'meta'->>'sourceMode' AS delivery_source_mode,
      CASE WHEN jsonb_typeof(response_body->'data'->'items') = 'array'
        THEN jsonb_array_length(response_body->'data'->'items') END AS delivered_item_count,
      response_body->'data'->'pageInfo'->'returnedCount' AS declared_returned_count,
      response_body->'data'->'pageInfo'->'hasMore' AS delivery_has_more
      FROM public.usage_requests WHERE id = $1`, [requestId])
    if (!request || request.platform !== 'twitter') throw new Error('twitter_request_not_found')
    const { rows: calls } = await client.query(`SELECT id, provider_key, operation, endpoint_key, endpoint_version,
      contract_version, outcome, http_status, business_code, billed, item_count, started_at, completed_at
      FROM external_platform.provider_calls WHERE usage_request_id = $1 ORDER BY started_at, id LIMIT 11`, [requestId])
    const evidence = []
    for (const call of calls.slice(0, 10)) {
      const supported = call.provider_key === 'rapidapi' && call.operation === 'social.content.search'
        && call.endpoint_key === 'twitter-aio.search' && call.endpoint_version === 'twitter-aio.hub.v1'
        && call.contract_version === HUB_SOCIAL_VERSION
      let archive
      if (supported) ({ rows: [archive] } = await client.query(`SELECT body_sha256, body_size, captured_at,
        CASE WHEN body_size <= $2 AND octet_length(body_bytes) <= $2 THEN body_bytes END AS body_bytes
        FROM control.external_platform_restricted_raw_responses WHERE provider_call_id = $1`, [call.id, MAX_BYTES]))
      const projection = supported ? inspectTwitterArchive(archive, request.acquisition_request, { httpStatus: call.http_status })
        : { state: 'not_current_twitter_aio_search_contract' }
      evidence.push({ callId: call.id, provider: known(call.provider_key, ['rapidapi', 'tikhub', 'justone']),
        operation: known(call.operation, ['social.content.search']), endpoint: known(call.endpoint_key, ['twitter-aio.search']),
        endpointVersion: known(call.endpoint_version, ['twitter-aio.hub.v1']),
        contractVersion: known(call.contract_version, [HUB_SOCIAL_VERSION]),
        outcome: known(call.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
        httpStatus: integer(call.http_status), businessCode: integer(call.business_code),
        billed: typeof call.billed === 'boolean' ? call.billed : null, recordedItemCount: integer(call.item_count),
        startedAt: call.started_at, completedAt: call.completed_at, projection,
        deliveredCountMatchesCurrent: projection.state === 'current_projection_accepts'
          && integer(request.delivered_item_count) !== null ? request.delivered_item_count === projection.returnedCount : null })
    }
    await client.query('COMMIT')
    const snapshot = request.acquisition_request
    return { requestId, status: known(request.status, ['reserved', 'committed', 'released', 'unknown']),
      responseStatus: integer(request.response_status), path: ROUTES.has(snapshot?.path) ? snapshot.path : 'other_or_missing',
      requestedAt: request.reserved_at, completedAt: request.completed_at, input: twitterInputShapes(snapshot),
      delivery: { contractVersion: known(request.delivery_contract_version, ['night-all.data-search.v1', HUB_SOCIAL_VERSION]),
        status: known(request.delivery_status, ['ok', 'partial', 'failed']),
        sourceMode: known(request.delivery_source_mode, ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay', 'unavailable']),
        itemCount: integer(request.delivered_item_count), declaredReturnedCount: integer(request.declared_returned_count),
        hasMore: typeof request.delivery_has_more === 'boolean' ? request.delivery_has_more : null },
      callsTruncated: calls.length > 10, evidence }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const [requestId, extra] = process.argv.slice(2)
    if (!requestId || extra) throw new Error('invalid_arguments')
    if (!UUID.test(requestId)) throw new Error('invalid_request_id')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
    console.log(JSON.stringify(await diagnoseTwitterSearch(pool, requestId), null, 2))
  } catch (error) {
    const knownErrors = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required', 'twitter_request_not_found'])
    console.error(JSON.stringify({ error: knownErrors.has(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
