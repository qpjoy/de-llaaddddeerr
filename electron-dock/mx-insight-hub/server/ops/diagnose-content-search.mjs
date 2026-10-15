import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { inspectWeiboMetricCoverage } from './diagnose-weibo-search.mjs'
import { WEIBO_SEARCH_KEY } from '../contracts/raw-search.mjs'
import { nativeForwardingEndpoint, normalizeNativeForwardingRequest, NATIVE_FORWARDING_VERSION } from '../contracts/native-forwarding.mjs'
import { normalizeTikHubContentSearchRequest, projectTikHubContentSearch, isDouyinRelatedWordsCard, douyinRelatedWordsCardCoverage, TIKHUB_CONTENT_SEARCH_RECIPES } from '../contracts/tikhub-content-search.mjs'
import { isPostgresSafeJsonValue } from '../core/postgres-json.mjs'

const DIAGNOSTIC_BUILD = typeof __CONTENT_SEARCH_DIAGNOSTIC_BUILD__ === 'object' ? __CONTENT_SEARCH_DIAGNOSTIC_BUILD__ : { implementation: 'installed_candidate', parserSha256: null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const MAX_BYTES = 8388608
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const time = value => {
  if (value == null) return null
  const date=new Date(value)
  return Number.isFinite(date.getTime())?date.toISOString():null
}
const allowed = (value, values) => values.includes(value) ? value : value == null ? null : 'other'
const errors = ['external_platform_persistence_unknown', 'external_platform_call_persistence_unknown', 'invalid_content_search_contract',
  'upstream_outcome_unknown', 'request_outcome_unknown', 'external_platform_response_unusable', 'invalid_upstream_contract',
  'reservation_lease_expired', 'invalid_json', 'business_rejected', 'external_platform_rejected',
  'upstream_transport_error', 'upstream_deadline_exceeded', 'upstream_body_read_failed', 'upstream_response_too_large',
  'invalid_upstream_encoding', 'invalid_upstream_json', 'invalid_upstream_content_type', 'upstream_payload_unrepresentable',
  'upstream_rate_limited', 'upstream_auth_or_balance_unavailable', 'upstream_endpoint_unavailable',
  'upstream_business_error', 'upstream_request_rejected', 'upstream_http_error', 'proxy_route_unavailable', 'proxy_routes_unreachable']
const reasons = new Set(['invalid_content_search_shape', 'content_search_business_rejected', 'content_search_page_too_large',
  'invalid_content_search_entry', 'invalid_content_search_identity', 'invalid_content_search_pagination',
  'missing_content_search_continuation', 'invalid_content_search_continuation', 'invalid_content_search_capture_time'])
const fields = ['code', 'data', 'result', 'results', 'items', 'mixFeeds', 'feeds', 'business_data', 'aweme_list', 'parsed_data',
  'has_more', 'hasMore', 'cursor', 'pcursor', 'next_cursor', 'search_id', 'search_hash_id', 'backtrace', 'paging', 'pagination', 'page', 'numPages', 'num_pages']
const rowFields = ['type', 'itemType', 'id', 'cid', 'photoId', 'photo_id', 'aweme_id', 'aweme_info', 'data', 'feed', 'photo', 'object', 'title', 'desc', 'caption', 'shareText', 'content', 'excerpt', 'statistics', 'author', 'user']
const identityState = value => value === undefined ? 'missing' : value === null ? 'null'
  : typeof value === 'string' ? value.trim() && value.length <= 256 && !value.includes('\u0000') ? 'valid_string' : 'invalid_string'
  : typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 ? 'safe_positive_integer'
    : Number.isInteger(value) && !Number.isSafeInteger(value) ? 'unsafe_integer' : 'invalid_number' : 'invalid_type'
const entryType = value => typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 'other_number'
  : ['video', 'aweme', 'relevant_query', 'knowledge_ad', 'user', 'search_user', 'related_search', 'suggestion', 'keyword', 'hot_timing'].includes(value) ? value : kind(value)
const douyinCardFields = ['aweme_id', 'awemeId', 'id', 'desc', 'text', 'title', 'content', 'full_text', 'description', 'caption', 'video', 'images', 'author', 'statistics', 'stats',
  'video_url', 'cover_url', 'like_count', 'comment_count', 'share_count', 'collect_count', 'view_count',
  'create_time', 'created_at', 'share_url', 'url', 'aweme_info', 'aweme', 'aweme_detail', 'aweme_list', 'business_data',
  'cha_info', 'challenge_info', 'challenge', 'hashtag', 'guide_search_words', 'query_list', 'queries', 'query',
  'word_list', 'words', 'word', 'search_words', 'related_search', 'related_words', 'suggestions', 'sug_list',
  'user_info', 'user_list', 'users', 'music_info', 'live_info', 'room', 'ad_info', 'feedback', 'search_feedback',
  'type', 'itemType', 'card_type', 'data', 'item', 'items', 'list', 'object', 'cha_id', 'challenge_id', 'challenge_name']
function douyinCardShape(value, depth = 0, budget = { remaining: 24 }) {
  const shape = { kind: kind(value) }
  if (budget.remaining-- <= 0) return { ...shape, truncated: true }
  if (Array.isArray(value)) {
    shape.count = value.length
    if (depth < 2) shape.samples = value.slice(0, 2).map(row => douyinCardShape(row, depth + 1, budget))
  } else if (value && typeof value === 'object') {
    shape.ownKeyCount = Object.keys(value).length
    shape.fields = Object.fromEntries(douyinCardFields.map(key => [key, kind(value[key])]))
    shape.identities = Object.fromEntries(['aweme_id', 'awemeId', 'id'].map(key => [key, identityState(value[key])]))
    if (depth < 2) shape.nested = Object.fromEntries(['data', 'aweme_info', 'aweme', 'aweme_detail', 'item', 'object', 'cha_info',
      'challenge_info', 'guide_search_words', 'query_list', 'queries', 'word_list', 'words', 'search_words', 'user_info', 'music_info', 'live_info']
      .filter(key => value[key] && typeof value[key] === 'object').map(key => [key, douyinCardShape(value[key], depth + 1, budget)]))
  }
  return shape
}
function valueKinds(value, omitData = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const counts = { null: 0, array: 0, object: 0, string: 0, number: 0, boolean: 0, other: 0 }
  for (const [key, field] of Object.entries(value)) {
    if (omitData && key === 'data') continue
    const type = kind(field)
    counts[Object.hasOwn(counts, type) ? type : 'other']++
  }
  return counts
}

// This incident needs schema names beyond the normal fixed-field inventory.
// Scalars never leave the Pod; dynamic/identifier-like map keys are hashed.
export function inspectSingleCardSchema(card) {
  const limits = { maxDepth: 8, maxNodes: 300, arraySamples: 2, maxEncodedJsonBytes: 65536 }
  let nodesVisited = 0, redactedFieldNames = 0
  const truncationReasons = new Set()
  const truncated = reason => { truncationReasons.add(reason); return { truncated: reason } }
  const keyShape = key => {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) && !/\d/u.test(key) && !/^[a-f\d]{16,}$/iu.test(key)
      && !/[A-Za-z\d]{32,}/u.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)) return { key }
    redactedFieldNames++
    return { keySha256: createHash('sha256').update(key).digest('hex') }
  }
  const visit = (value, depth) => {
    const type = kind(value)
    if (nodesVisited >= limits.maxNodes) return { kind: type, ...truncated('node_limit') }
    nodesVisited++
    const result = { kind: type }
    if (Array.isArray(value)) {
      result.count = value.length
      if (value.length && depth >= limits.maxDepth) return { ...result, ...truncated('depth_limit') }
      result.samples = []
      for (let index = 0; index < Math.min(value.length, limits.arraySamples); index++) {
        if (nodesVisited >= limits.maxNodes) {
          result.omittedSamples = Math.min(value.length, limits.arraySamples) - index
          Object.assign(result, truncated('node_limit')); break
        }
        result.samples.push({ index, shape: visit(value[index], depth + 1) })
      }
      if (value.length > limits.arraySamples) Object.assign(result, truncated('array_sampling'))
    } else if (value && typeof value === 'object') {
      const keys = Object.keys(value)
      result.ownKeyCount = keys.length
      if (keys.length && depth >= limits.maxDepth) return { ...result, ...truncated('depth_limit') }
      result.fields = []
      const ordered = keys.includes('data') ? ['data', ...keys.filter(key => key !== 'data')] : keys
      for (const key of ordered) {
        if (nodesVisited >= limits.maxNodes) {
          result.omittedFields = ordered.length - result.fields.length
          Object.assign(result, truncated('node_limit')); break
        }
        result.fields.push({ ...keyShape(key), shape: visit(value[key], depth + 1) })
      }
    } else if (typeof value === 'string' && /^[\s]*[\[{]/u.test(value)) {
      if (depth >= limits.maxDepth) Object.assign(result, truncated('depth_limit'))
      else if (Buffer.byteLength(value) > limits.maxEncodedJsonBytes) Object.assign(result, truncated('encoded_json_limit'))
      else if (nodesVisited >= limits.maxNodes) Object.assign(result, truncated('node_limit'))
      else {
        try { result.encodedJsonSchema = visit(JSON.parse(value), depth + 1) }
        catch { /* An ordinary string remains only its type, without content. */ }
      }
    }
    return result
  }
  const schema = visit(card, 0)
  return { mode: 'single_card_schema_only', limits, nodesVisited, redactedFieldNames,
    truncated: truncationReasons.size > 0, truncationReasons: [...truncationReasons], schema }
}

export function isDouyinIncidentCardSource(archive, payload) {
  return archive?.id === 'bc969a1f-d327-411d-aef5-4b4c927c4124'
    && archive.usage_request_id === 'ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4'
    && archive.body_sha256 === '19edfbe3c7044f4c081a724efe45ad2532cd3f21bc651be351996226c426f102'
    && Number(archive.body_size) === 348957 && archive.provider_key === 'tikhub'
    && archive.operation === 'native.t.douyin_search_fetch_video_search_v1'
    && archive.endpoint_key === 'native.t.douyin_search_fetch_video_search_v1'
    && archive.endpoint_version === 'night-all-source-snapshot.2026-09-26'
    && archive.contract_version === NATIVE_FORWARDING_VERSION
    && Array.isArray(payload?.data?.data) && payload.data.data.length === 8 && payload.data.data[4]?.type === 6
}

// Diagnose only the observed fixed Douyin envelope. Every row is projected
// independently against the saved request; no content, identity or token value
// leaves the report, and no unknown card is silently treated as non-content.
export function inspectDouyinEntryCoverage(payload, request, capturedAt) {
  const data = payload?.data
  if (!data || !Array.isArray(data.data) || data.business_data != null || data.aweme_list != null) return { available: false }
  const cardBudget = { remaining: 24 }
  const entries = data.data.slice(0, 50).map((entry, index) => {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const selected = object(entry?.data?.aweme_info) ? entry.data.aweme_info : object(entry?.aweme_info) ? entry.aweme_info
      : object(entry?.data) && (entry.data.aweme_id != null || entry.data.awemeId != null) ? entry.data : entry
    let projection
    try {
      const result = projectTikHubContentSearch({ publicBody: { data: { ...data, data: [entry] }, meta: { capturedAt } } }, request)
      projection = { state: 'candidate_accepts', itemCount: result.acquiredItems.length, nonPostCount: result.nonPostCount,
        postgresSafeItems: isPostgresSafeJsonValue(result.acquiredItems) }
    } catch (error) {
      projection = { state: 'candidate_rejects', reason: reasons.has(error.message) ? error.message : 'request_or_projection_rejected' }
    }
    return { index, type: entryType(entry?.type), itemType: entryType(entry?.itemType),
      wrapper: { entry: kind(entry), aweme_info: kind(entry?.aweme_info), data: kind(entry?.data),
        'data.aweme_info': kind(entry?.data?.aweme_info) },
      selected: { aweme_id: identityState(selected?.aweme_id), awemeId: identityState(selected?.awemeId),
        ...Object.fromEntries(['desc', 'video', 'images', 'author', 'statistics', 'stats', 'create_time'].map(key => [key, kind(selected?.[key])])) },
      ...(entry?.type === 6 || projection.state === 'candidate_rejects' ? { cardShape: douyinCardShape(entry, 0, cardBudget),
        compatibility: { relatedWordsCard: isDouyinRelatedWordsCard(entry), relatedWordsCoverage: douyinRelatedWordsCardCoverage(entry),
          cardType: Number.isSafeInteger(entry?.card_type) && entry.card_type >= 0 ? 'safe_nonnegative_integer' : kind(entry?.card_type),
          outerOtherValueKinds: valueKinds(entry, true), dataValueKinds: valueKinds(entry?.data) } } : {}), projection }
  })
  return { available: true, entryCount: data.data.length, examined: entries.length, truncated: data.data.length > entries.length, entries }
}

// Follow the current parser's fixed selection order, without guessing new
// wrappers or treating an unrecognized card as a non-post. The per-row probes
// keep the original pagination fields; adapter/credential checks are not replayed.
export function inspectKuaishouEntryCoverage(payload, request, capturedAt) {
  const data = payload?.data, paths = [['mixFeeds'], ['feeds'], ['result', 'items'], ['items'], ['data']]
  const report = { mode: 'data_projection_only', adapterValidation: 'not_replayed',
    limits: { maxEntries: 100, maxRejectedSchemas: 3, schemaMaxNodes: 300, schemaMaxDepth: 8, schemaArraySamples: 2 } }
  let selectedPath = null, rows = null
  for (const path of paths) {
    const value = path.reduce((current, key) => current?.[key], data)
    if (value != null) { selectedPath = path; rows = value; break }
  }
  if (selectedPath == null && Array.isArray(data)) { selectedPath = []; rows = data }
  if (!Array.isArray(rows)) return { ...report, available: false,
    reason: 'unrecognized_entry_container', selectedPath: selectedPath ? `payload.data.${selectedPath.join('.')}` : null,
    dataSchema: inspectSingleCardSchema(data) }
  let schemas = 0
  const entries = rows.slice(0, report.limits.maxEntries).map((entry, index) => {
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const wrappers = { entry, feed: entry?.feed, photo: entry?.photo, photo_info: entry?.photo_info,
      photoInfo: entry?.photoInfo, data: entry?.data }
    const selected = record(entry?.feed) ? { ...entry, ...entry.feed }
      : record(entry?.photo) ? { ...entry, ...entry.photo } : entry
    const probeData = selectedPath.length ? { ...data } : null
    if (selectedPath.length) {
      let target = probeData
      for (const key of selectedPath.slice(0, -1)) { target[key] = { ...target[key] }; target = target[key] }
      target[selectedPath.at(-1)] = [entry]
    }
    let projection
    try {
      const projected = projectTikHubContentSearch({ publicBody: { data: selectedPath.length ? probeData : [entry], meta: { capturedAt } } }, request)
      projection = { state: 'candidate_accepts', itemCount: projected.acquiredItems.length,
        nonPostCount: projected.nonPostCount, postgresSafeItems: isPostgresSafeJsonValue(projected.acquiredItems) }
    } catch (error) {
      projection = { state: 'candidate_rejects', reason: reasons.has(error.message) ? error.message : 'request_or_projection_rejected' }
    }
    const schema = projection.state === 'candidate_rejects' && schemas < report.limits.maxRejectedSchemas
      ? (schemas++, inspectSingleCardSchema(entry)) : null
    return { index, type: entryType(entry?.type), itemType: entryType(entry?.itemType),
      selectedPath: record(entry?.feed) ? 'entry.feed' : record(entry?.photo) ? 'entry.photo' : 'entry',
      wrappers: Object.fromEntries(Object.entries(wrappers).map(([path, value]) => [path, { kind: kind(value),
        identities: Object.fromEntries(['cid', 'photo_id', 'photoId', 'id', 'external_id', 'externalId'].map(key => [key, identityState(value?.[key])])),
        fields: Object.fromEntries(['caption', 'text', 'title', 'shareText', 'share_info', 'video', 'images', 'user', 'stats'].map(key => [key, kind(value?.[key])])) }])),
      selectedIdentities: Object.fromEntries(['cid', 'photo_id', 'photoId', 'id'].map(key => [key, identityState(selected?.[key])])),
      projection, ...(schema ? { schema } : {}) }
  })
  return { ...report, available: true, selectedPath: selectedPath.length ? `payload.data.${selectedPath.join('.')}` : 'payload.data',
    entryCount: rows.length, examined: entries.length, truncated: rows.length > entries.length,
    rejectedSchemas: schemas, entries }
}
export function inspectContentArchive(archive, snapshot, platform, { incidentSchema = false } = {}) {
  const bytes = archive?.body_bytes
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(Number(archive.body_size)) || bytes.length !== Number(archive.body_size)
    || !bytes.length || bytes.length > MAX_BYTES || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) return { state: archive ? 'archive_integrity_failed' : 'archive_missing' }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')) }
  catch { return { state: 'archive_not_json_utf8', hashVerified: true } }
  const containers = [], samples = []
  const visit = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 4 || containers.length >= 60) return
    if (Array.isArray(value)) {
      containers.push({ path, count: value.length })
      for (const row of value.slice(0, 2)) if (row && typeof row === 'object' && !Array.isArray(row)) {
        samples.push({ path, fields: Object.fromEntries(rowFields.map(key => [key, kind(row[key])])) })
        for (const key of ['data', 'aweme_info', 'feed', 'photo', 'object']) visit(row[key], `${path}[sample].${key}`, depth + 1)
      }
    } else {
      containers.push({ path, fields: Object.fromEntries(fields.map(key => [key, kind(value[key])])) })
      for (const key of fields) if (value[key] && typeof value[key] === 'object') visit(value[key], `${path}.${key}`, depth + 1)
    }
  }
  visit(payload, 'payload', 0)
  const report = { state: 'archive_verified', hashVerified: true, bodySize: bytes.length, bodySha256: archive.body_sha256,
    projectionScope: 'data_projection_only', adapterValidation: 'not_replayed',
    shape: { containers: containers.slice(0, 30), samples: samples.slice(0, 12) } }
  if (incidentSchema && platform === 'douyin' && isDouyinIncidentCardSource(archive, payload)) {
    report.incidentCardSchema = { entryIndex: 4, ...inspectSingleCardSchema(payload.data.data[4]) }
  }
  if (platform === 'weibo') return { ...report, metricCoverage: inspectWeiboMetricCoverage(payload, time(archive.captured_at)) }
  if (!Object.hasOwn(TIKHUB_CONTENT_SEARCH_RECIPES, platform)) return report
  const body = snapshot?.body || {}, params = body.params || {}
  const query = [body.queries?.[0], body.keywords?.[0], body.query, body.keyword].find(value => typeof value === 'string' && value.trim())
  if (!query || !snapshot?.path || body.cursor || typeof params.cursor === 'string' && params.cursor.startsWith('mx')) return { ...report, projection: { state: 'requires_saved_continuation_state' } }
  let request
  try {
    request = normalizeTikHubContentSearchRequest({ platform, query, pageSize: body.pageSize ?? body.count ?? body.limit ?? 20,
      page: body.page ?? 1, params, maxQueryLength: 2048 })
    if (platform === 'douyin') report.entryCoverage = inspectDouyinEntryCoverage(payload, request, time(archive.captured_at))
    if (incidentSchema && platform === 'kuaishou') report.entryCoverage = inspectKuaishouEntryCoverage(payload, request, time(archive.captured_at))
    const result = projectTikHubContentSearch({ publicBody: { data: payload.data, meta: { capturedAt: time(archive.captured_at) } } }, request)
    return { ...report, projection: { state: 'candidate_accepts', itemCount: result.acquiredItems.length,
      nonPostCount: result.nonPostCount, duplicateCount: result.duplicateCount,
      postgresSafeItems: isPostgresSafeJsonValue(result.acquiredItems),
      hasMore: result.providerPage.hasMore, nextParamsFields: Object.keys(result.providerPage.nextParams || {}) } }
  } catch (error) { return { ...report, projection: { state: 'candidate_rejects', reason: reasons.has(error.message) ? error.message : 'request_or_projection_rejected' } } }
}

// Pure re-enactment of fresh standard-page consumption from complete owned
// receipts. This checks the old shared-reference failure without creating a
// delivery, changing an unknown request or calling a supplier.
export function inspectContentFillCoverage(calls, snapshot, platform) {
  const body = snapshot?.body || {}
  if (snapshot?.path !== '/api/v1/data/search' || body.cursor || !Object.hasOwn(TIKHUB_CONTENT_SEARCH_RECIPES, platform)
    || body.page != null && String(body.page) !== '1'
    || Object.entries({ page: 1, offset: 0, cursor: 0, search_id: '', backtrace: '', pcursor: '', search_hash_id: '' })
      .some(([name, initial]) => body.params?.[name] != null && String(body.params[name]) !== String(initial))
    || !calls.length || calls.length > 3 || calls.some(call => call.outcome !== 'succeeded')) return { available: false }
  const query = body.query ?? body.keyword, pageSize = body.pageSize ?? 20
  const mode = { mode: 'offline_consumption_simulation', manifestChecks: 'minimal_cursor_state_only' }
  const seen = new Set(), acquired = new Set(), pages = []
  const job = { providerCursor: null, providerPage: 1, buffer: null }
  let delivered = 0, acquiredCount = 0, legacyManifestJsonSafe = true
  try {
    for (const call of [...calls].sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())) {
      if (delivered >= pageSize || job.buffer) return { available: false, reason: 'unexpected_additional_receipt' }
      const verified = inspectContentArchive(call, snapshot, platform)
      if (verified.state !== 'archive_verified') return { available: false, reason: 'requires_verified_archives' }
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(call.body_bytes).replace(/^\uFEFF/u, ''))
      const request = normalizeTikHubContentSearchRequest({ platform, query, pageSize, params: body.params || {},
        page: job.providerPage, providerCursor: job.providerCursor })
      const projected = projectTikHubContentSearch({ publicBody: { data: payload.data, meta: { capturedAt: time(call.captured_at) } } }, request)
      const rows = projected.acquiredItems
      acquiredCount += rows.length
      rows.forEach(row => acquired.add(row.content_id))
      let position = 0
      while (position < rows.length && delivered < pageSize) {
        const row = rows[position++]
        if (seen.has(row.content_id)) continue
        seen.add(row.content_id); delivered++
      }
      pages.push({ acquiredCount: rows.length, consumedSourceRows: position,
        nonPostCount: projected.nonPostCount, postgresSafeItems: isPostgresSafeJsonValue(rows) })
      if (position < rows.length) {
        if (pages.length < calls.length) return { available: false, reason: 'unexpected_additional_receipt' }
        job.buffer = { offset: position, providerCursor: job.providerCursor, providerPage: job.providerPage }
        legacyManifestJsonSafe = isPostgresSafeJsonValue({ state: { jobs: [job] } })
        job.buffer.providerCursor = job.providerCursor == null ? null : { ...job.providerCursor }
        return { available: true, ...mode, sourcePageCount: pages.length, acquiredCount, uniqueAcquiredCount: acquired.size,
          deliveredCount: delivered, bufferedSourceRows: rows.length - position,
          bufferedUniqueUndelivered: new Set(rows.slice(position).filter(row => !seen.has(row.content_id)).map(row => row.content_id)).size,
          legacyManifestJsonSafe, copiedManifestJsonSafe: isPostgresSafeJsonValue({ state: { jobs: [job] } }), pages }
      }
      job.providerCursor = projected.providerPage.nextParams
      job.providerPage = projected.providerPage.nextPage || job.providerPage + 1
      if (!job.providerCursor && pages.length < calls.length) return { available: false, reason: 'unexpected_additional_receipt' }
    }
    return { available: true, ...mode, sourcePageCount: pages.length, acquiredCount, uniqueAcquiredCount: acquired.size,
      deliveredCount: delivered, bufferedSourceRows: 0, bufferedUniqueUndelivered: 0,
      legacyManifestJsonSafe, copiedManifestJsonSafe: isPostgresSafeJsonValue({ state: { jobs: [job] } }), pages }
  } catch (error) {
    return { available: false, reason: reasons.has(error.message) ? error.message : 'request_or_projection_rejected' }
  }
}

function boundedWeiboQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500 || value.includes('\u0000')) throw new Error('invalid_weibo_query')
  return value.trim()
}
export function parseContentDiagnosticArguments(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('invalid_identifiers')
  const flags = args.filter(value => value.startsWith('--weibo-query='))
  if (flags.length > 1) throw new Error('invalid_weibo_query')
  const identifiers = args.filter(value => !value.startsWith('--weibo-query='))
  if (!identifiers.length || identifiers.length > 10 || identifiers.some(value => !UUID.test(value))) throw new Error('invalid_identifiers')
  return { identifiers, options: { weiboQuery: boundedWeiboQuery(flags.length ? flags[0].slice('--weibo-query='.length) : '王一博') } }
}
export async function diagnoseContentSearch(pool, identifiers, { weiboQuery = '王一博' } = {}) {
  if (!Array.isArray(identifiers) || !identifiers.length || identifiers.length > 10 || identifiers.some(value => !UUID.test(value))) throw new Error('invalid_identifiers')
  weiboQuery = boundedWeiboQuery(weiboQuery)
  let client,stage='connect',requestId=null,callId=null
  try {
    client = await pool.connect()
    stage='begin_readonly'
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='8s'")
    await client.query("SET LOCAL lock_timeout='1s'")
    stage='lookup_requests'
    const { rows: requests } = await client.query(`SELECT id,tenant_id,consumer_id,api_key_id,platform,status,error_code,response_status,reserved_at,completed_at,acquisition_request,
      idempotency_key = ANY($2::text[]) AS matched_idempotency_key
      FROM public.usage_requests WHERE id=ANY($1::uuid[]) OR idempotency_key=ANY($2::text[])
      ORDER BY reserved_at DESC LIMIT 12`, [identifiers, identifiers])
    // Screenshot-specific follow-ups: exact selected query, same calling Key as
    // a matched request, at most three per platform within 48 hours. No free
    // browsing across tenants and no query values leave the report.
    stage='lookup_same_key_followups'
    const { rows: recent } = await client.query(`SELECT * FROM (
      SELECT followup.id,followup.platform,followup.status,followup.error_code,followup.response_status,
        followup.reserved_at,followup.completed_at,followup.acquisition_request,false AS matched_idempotency_key,
        true AS recent_same_key_candidate,
        row_number() OVER (PARTITION BY followup.platform ORDER BY followup.reserved_at DESC) AS rn
      FROM public.usage_requests followup WHERE followup.platform IN ('weibo','douyin')
        AND followup.reserved_at>=now()-interval '48 hours'
        AND followup.acquisition_request->>'path' IN ('/api/v1/data/search','/api/v1/night-all/search/raw','/api/v1/search/raw')
        AND coalesce(followup.acquisition_request->'body'->>'query',followup.acquisition_request->'body'->>'keyword')
          = CASE followup.platform WHEN 'weibo' THEN $2::text ELSE '深夜热舞' END
        AND EXISTS(SELECT 1 FROM public.usage_requests matched WHERE matched.id=ANY($1::uuid[])
          AND matched.tenant_id=followup.tenant_id AND matched.consumer_id=followup.consumer_id AND matched.api_key_id=followup.api_key_id)
    ) scoped WHERE rn<=3 ORDER BY reserved_at DESC LIMIT 6`, [requests.map(request=>request.id), weiboQuery])
    const combined=[...requests,...recent.filter(row=>!requests.some(request=>request.id===row.id))]
    stage='read_database_clock'
    const {rows:[database]}=await client.query('SELECT clock_timestamp() AS database_now')
    const reports = []
    for (const request of combined) {
      requestId=request.id;callId=null;stage='resolve_fixed_recipe'
      if (!Object.hasOwn(TIKHUB_CONTENT_SEARCH_RECIPES, request.platform) && request.platform!=='weibo') continue
      const endpoint=nativeForwardingEndpoint(request.platform==='weibo'?WEIBO_SEARCH_KEY:TIKHUB_CONTENT_SEARCH_RECIPES[request.platform].key)
      // Use complete fixed recipes to resolve version metadata. Required flags
      // vary (Douyin keyword is optional; Bilibili requires paging defaults).
      const route=request.platform==='weibo'
        ?normalizeNativeForwardingRequest(WEIBO_SEARCH_KEY,{params:{query:'offline-diagnostic',page:1}})
        :normalizeTikHubContentSearchRequest({platform:request.platform,query:'offline-diagnostic',pageSize:20})
      const endpointVersion=route.endpointVersion
      const operation = endpoint.operation
      stage='lookup_provider_calls'
      const { rows: calls } = await client.query(`SELECT call.id,call.usage_request_id,call.provider_key,call.operation,call.endpoint_key,
        call.endpoint_version,call.contract_version,call.outcome,call.http_status,call.business_code,call.billed,call.error_code,
        call.item_count,call.started_at,call.completed_at,request.acquisition_request,
        raw.body_bytes,raw.body_size,raw.body_sha256,raw.captured_at
        FROM external_platform.provider_calls call JOIN public.usage_requests request ON request.id=call.usage_request_id
        LEFT JOIN control.external_platform_restricted_raw_responses raw ON raw.provider_call_id=call.id AND raw.body_size<=8388608
        WHERE call.provider_key='tikhub' AND call.operation=$2 AND (call.usage_request_id=$1 OR (
          call.outcome='succeeded_unusable' AND call.completed_at<=$3::timestamptz AND call.completed_at>$3::timestamptz-interval '15 minutes'))
        ORDER BY call.started_at DESC LIMIT 12`, [request.id, operation, request.completed_at || request.reserved_at])
      const evidence=[]
      for (const call of calls) {
        callId=call.id;stage='read_persistence_status'
        const { rows: [persistence] } = await client.query(`SELECT
          EXISTS(SELECT 1 FROM external_platform.response_archives WHERE provider_call_id=$1) AS operational_archive,
          (SELECT count(*)::int FROM external_platform.archive_objects WHERE provider_call_id=$1) AS archive_objects,
          EXISTS(SELECT 1 FROM mxq.jobs WHERE queue='mx-insight-hub:ingest' AND dedupe_key='external-platform:tikhub:' || $1::text) AS ingest_job`, [call.id])
        stage='inspect_archive'
        evidence.push({ callId:call.id, requestId:call.usage_request_id, relation:call.usage_request_id===request.id?'own':'quarantine_candidate',
          operation:allowed(call.operation,[operation]), endpointVersion:allowed(call.endpoint_version,[endpointVersion]),
          contractVersion:allowed(call.contract_version,[NATIVE_FORWARDING_VERSION]),
          outcome:allowed(call.outcome,['pending','succeeded','succeeded_unusable','unknown','rejected']), httpStatus:call.http_status,
          businessCode:call.business_code,billed:call.billed,itemCount:call.item_count,errorCode:allowed(call.error_code,errors),
          startedAt:time(call.started_at),completedAt:time(call.completed_at),persistence,
          archive:call.endpoint_key===endpoint.endpointKey && call.endpoint_version===endpointVersion && call.contract_version===NATIVE_FORWARDING_VERSION
            ?inspectContentArchive(call.body_bytes?call:null,call.acquisition_request,request.platform,
              {incidentSchema:call.usage_request_id===request.id}):{state:'source_contract_mismatch'} })
      }
      stage='summarize_request'
      const body=request.acquisition_request?.body || {}
      reports.push({requestId:request.id,matchedIdempotencyKey:request.matched_idempotency_key,recentSameKeyCandidate:request.recent_same_key_candidate===true,platform:request.platform,
        status:allowed(request.status,['reserved','committed','released','unknown']),responseStatus:request.response_status,
        errorCode:allowed(request.error_code,errors),reservedAt:time(request.reserved_at),completedAt:time(request.completed_at),
        input:{path:allowed(request.acquisition_request?.path,['/api/v1/data/search','/api/v1/night-all/search/raw','/api/v1/search/raw']),
          pageSize:body.pageSize ?? body.count ?? body.limit ?? null,queryLength:typeof(body.query??body.keyword)==='string'?(body.query??body.keyword).length:null,
          cursor:kind(body.cursor),paramsFields:Object.keys(body.params||{}).filter(key=>['sort','sort_type','publish_time','duration','cursor','offset','pcursor','search_id','backtrace','search_hash_id'].includes(key))},
        evidence, fillCoverage: inspectContentFillCoverage(calls.filter(call => call.usage_request_id === request.id
          && call.endpoint_key === endpoint.endpointKey && call.endpoint_version === endpointVersion && call.contract_version === NATIVE_FORWARDING_VERSION),
        request.acquisition_request, request.platform)})
    }
    stage='finish_readonly'
    await client.query('ROLLBACK')
    return {diagnosticRevision:'content-search-diagnostic.v9',...DIAGNOSTIC_BUILD,runtimeNow:new Date().toISOString(),databaseNow:time(database.database_now),requests:reports,matchedRequestCount:requests.length}
  } catch(error) {
    if(client) await client.query('ROLLBACK').catch(()=>{})
    if(error && typeof error==='object') Object.defineProperty(error,'diagnosticContext',{value:{stage,requestId,callId},configurable:true})
    throw error
  } finally {client?.release()}
}
export function contentDiagnosticFailure(error) {
  const context=error?.diagnosticContext || {}
  const stages=['connect','begin_readonly','lookup_requests','lookup_same_key_followups','read_database_clock',
    'resolve_fixed_recipe','lookup_provider_calls','read_persistence_status','inspect_archive','summarize_request','finish_readonly']
  const codes=['missing_parameter','unsupported_request_field','invalid_parameter','invalid_page_size','invalid_platform','invalid_query']
  const messages=['invalid_identifiers','invalid_weibo_query','database_url_required','diagnostic_contract_changed']
  return {diagnosticRevision:'content-search-diagnostic.v9',...DIAGNOSTIC_BUILD,
    error:messages.includes(error?.message)?error.message:'diagnostic_read_failed',
    stage:stages.includes(context.stage)?context.stage:'initialization',
    errorType:allowed(error?.name,['AppError','TypeError','RangeError','Error']),
    reason:codes.includes(error?.code)?error.code:error instanceof RangeError?'invalid_range':'unclassified',
    sqlState:typeof error?.code==='string'&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:null,
    requestId:UUID.test(context.requestId || '')?context.requestId:null,callId:UUID.test(context.callId || '')?context.callId:null}
}

if (process.argv[1] && (process.argv[1]==='-' || import.meta.url===pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000})
    const {identifiers,options}=parseContentDiagnosticArguments(process.argv.slice(2))
    console.log(JSON.stringify(await diagnoseContentSearch(pool,identifiers,options),null,2))
  } catch(error) {
    console.error(JSON.stringify(contentDiagnosticFailure(error)))
    process.exitCode=1
  } finally {await pool?.end()}
}
