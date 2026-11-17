// One fixed paid receipt, read-only. No runtime, adapter, credential or HTTP initialization.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const SOURCE = Object.freeze({ usageId: 'e531d032-0bfa-463e-9e0f-ff10e2457a5d',
  callId: '783683dc-0dde-45ac-9c9c-76753f9c8949', size: 200594,
  sha256: '34747817708f7dd6e4ab1b8dd9f4b92f20f2fd5c8f96165e347532d3a35fa2a6' })
const OPERATION = 'native.r.twitter_aio_tweet_thread', PATH = '/api/v1/data/social/post-comments'
const FILES = ['contracts/twitter-rapid-comment-page.mjs', 'contracts/post-comment-projection.mjs',
  'contracts/post-comments.mjs', 'contracts/native-forwarding.mjs', 'contracts/twitter-rapidapi-endpoints.mjs',
  'external-platforms/social-account-workflow.mjs']
const ERRORS = new Set(['invalid_arguments', 'public_postgres_container_required', 'source_unverified', 'archive_unverified',
  'request_unverified', 'installed_contract_unavailable', 'invalid_upstream_contract', 'invalid_post_comments_request',
  'invalid_parameter', 'missing_parameter', 'unsupported_request_field', 'external_platform_contract_unverified'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const hash = value => createHash('sha256').update(value).digest('hex')
const need = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }) }
const known = (value, choices) => choices.includes(value) ? value : 'other'
const add = (counts, name) => { counts[name] = (counts[name] || 0) + 1 }

export function safeFailure(error) {
  const frames = []
  for (const line of String(error?.stack || '').split('\n').slice(1, 12)) {
    if (!/^\s*at /u.test(line)) continue
    for (const file of FILES) {
      const match = line.match(new RegExp(`${file.replaceAll('.', '\\.')}:([0-9]+):([0-9]+)`))
      if (match && frames.length < 8) frames.push({ file, line: Number(match[1]), column: Number(match[2]) })
    }
  }
  return { code: ERRORS.has(error?.code) ? error.code : 'diagnostic_unavailable', frames }
}

export function summarizeTwitterRawShape(payload) {
  const instructions = payload?.data?.threaded_conversation_with_injections_v2?.instructions
  const report = { envelope: kind(payload), instructions: kind(instructions), instructionCount: Array.isArray(instructions) ? instructions.length : null,
    instructionTypes: {}, instructionShapes: {}, entryKinds: {}, contentTypes: {}, itemTypes: {}, resultTypes: {},
    cursorTypes: {}, bottomValueStates: {}, anomalies: {}, entriesInspected: 0, itemsInspected: 0, truncated: false,
    terminateTimeline: { count: 0, directions: {}, directionTypes: {}, typenameStates: {},
      knownFields: { type: 0, direction: 0, __typename: 0 }, unexpectedFieldCount: 0, instructionsWithUnexpectedFields: 0 } }
  const MAX = 2000
  function item(value) {
    if (report.itemsInspected >= MAX) { report.truncated = true; return }
    report.itemsInspected++
    if (!object(value)) { add(report.anomalies, 'itemContent_not_object'); return }
    add(report.itemTypes, known(value.itemType, ['TimelineTweet', 'TimelineTimelineCursor', 'TimelineTombstone', 'TimelineUser']))
    const result = value.tweet_results?.result
    if (!object(result)) { if (value.itemType === 'TimelineTweet') add(report.anomalies, 'tweetResult_not_object'); return }
    add(report.resultTypes, known(result.__typename, ['Tweet', 'TweetWithVisibilityResults', 'TweetTombstone', 'TweetUnavailable']))
    const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result
    if (!object(tweet)) { add(report.anomalies, 'wrappedTweet_not_object'); return }
    if (['TweetTombstone', 'TweetUnavailable'].includes(tweet.__typename)) return
    if (!object(tweet.legacy)) { add(report.anomalies, 'legacy_not_object'); return }
    const legacy = tweet.legacy, id = tweet.rest_id ?? legacy.id_str
    if (typeof id !== 'string' || !/^\d{1,30}$/u.test(id)) add(report.anomalies, 'tweetId_not_numeric_string')
    if (legacy.id_str != null && legacy.id_str !== id) add(report.anomalies, 'tweetId_fields_disagree')
    for (const key of ['conversation_id_str', 'in_reply_to_status_id_str']) {
      if (legacy[key] != null && (typeof legacy[key] !== 'string' || !/^\d{1,30}$/u.test(legacy[key]))) add(report.anomalies, `${key}_invalid`)
    }
    const note = tweet.note_tweet?.note_tweet_results?.result
    if (typeof (note?.text ?? note?.richtext?.text ?? legacy.full_text) !== 'string') add(report.anomalies, 'text_not_string')
    if (typeof legacy.created_at === 'string' && !Number.isFinite(Date.parse(legacy.created_at))) add(report.anomalies, 'created_at_invalid')
  }
  function entry(value) {
    if (report.entriesInspected >= MAX) { report.truncated = true; return }
    report.entriesInspected++
    if (!object(value?.content)) { add(report.anomalies, 'entryContent_not_object'); return }
    const content = value.content
    const prefix = typeof value.entryId === 'string'
      ? ['conversationthread-', 'tweet-', 'cursor-'].find(prefix => value.entryId.startsWith(prefix)) : null
    add(report.entryKinds, prefix ? prefix.slice(0, -1) : 'other')
    add(report.contentTypes, known(content.entryType ?? content.__typename, ['TimelineTimelineModule', 'TimelineTimelineItem', 'TimelineTimelineCursor']))
    if (content.cursorType != null) add(report.cursorTypes, known(content.cursorType, ['Bottom', 'Top', 'ShowMore']))
    if (content.cursorType === 'Bottom') add(report.bottomValueStates, content.value === undefined ? 'missing'
      : content.value === null ? 'null' : typeof content.value !== 'string' ? 'non_string'
        : content.value.includes('\0') ? 'contains_nul' : content.value.length > 8192 ? 'oversize'
          : content.value === '' ? 'empty' : 'nonempty')
    if (prefix === 'tweet-') item(content.itemContent)
    if (prefix === 'conversationthread-') {
      if (!Array.isArray(content.items)) { add(report.anomalies, 'moduleItems_not_array'); return }
      if (content.items.length > MAX) report.truncated = true
      for (const child of content.items.slice(0, MAX)) item(child?.item?.itemContent)
    }
  }
  if (Array.isArray(instructions)) {
    if (instructions.length > MAX) report.truncated = true
    for (const instruction of instructions.slice(0, MAX)) {
      add(report.instructionTypes, known(instruction?.type, ['TimelineAddEntries', 'TimelineReplaceEntry', 'TimelineClearCache',
        'TimelineAddToModule', 'TimelineTerminateTimeline', 'TimelinePinEntry']))
      if (instruction?.type === 'TimelineTerminateTimeline') {
        const summary = report.terminateTimeline
        summary.count++
        add(summary.directions, known(instruction.direction, ['Top', 'Bottom', 'TopAndBottom']))
        add(summary.directionTypes, kind(instruction.direction))
        add(summary.typenameStates, !Object.hasOwn(instruction, '__typename') ? 'absent'
          : instruction.__typename === 'TimelineTerminateTimeline' ? 'matching' : 'other')
        const allowed = ['type', 'direction', '__typename']
        for (const key of allowed) if (Object.hasOwn(instruction, key)) summary.knownFields[key]++
        const unexpected = Object.keys(instruction).filter(key => !allowed.includes(key)).length
        summary.unexpectedFieldCount += unexpected
        if (unexpected) summary.instructionsWithUnexpectedFields++
      }
      for (const key of ['entries', 'entry', 'moduleItems']) {
        if (instruction?.[key] !== undefined) add(report.instructionShapes, `${key}_${kind(instruction[key])}`)
      }
      if (Array.isArray(instruction?.entries)) {
        if (instruction.entries.length > MAX) report.truncated = true
        for (const row of instruction.entries.slice(0, MAX)) entry(row)
      }
      if (instruction?.entry !== undefined) entry(instruction.entry)
      if (Array.isArray(instruction?.moduleItems)) {
        if (instruction.moduleItems.length > MAX) report.truncated = true
        for (const child of instruction.moduleItems.slice(0, MAX)) item(child?.item?.itemContent)
      }
    }
  }
  return report
}

// Pure offline replay, separately testable with synthetic payloads. The CLI
// always obtains its inputs through the fixed receipt/hash guard below.
export function replayTwitterRawPage(payload, { request, step, capturedAt, parse, project, workflowProject, traversal, isJsonSafe }) {
  const report = { jsonSafe: isJsonSafe(payload), shape: summarizeTwitterRawShape(payload) }
  try {
    const result = parse(payload, request.postId, step.postComments.continuation)
    report.parser = { ok: true, commentCount: result.comments.length, continuationPresent: Boolean(result.providerPage.nextParams) }
  } catch (error) { report.parser = { ok: false, ...safeFailure(error) } }
  try {
    const result = project(payload, step, { capturedAt })
    report.projection = { ok: true, itemCount: result.projected.acquiredItems.length, recordCount: result.records.length,
      jsonSafe: isJsonSafe(result.projected), recordFieldsJsonSafe: result.records.every(record => Object.entries(record).every(([key, value]) =>
        isJsonSafe(['eventTime', 'collectedAt', 'editedAt', 'deletedAt'].includes(key) && value instanceof Date ? value.toISOString() : value))) }
  } catch (error) { report.projection = { ok: false, ...safeFailure(error) } }
  try {
    const result = workflowProject(payload, step, 'comments', capturedAt, traversal)
    report.workflow = { ok: true, itemCount: result.projected.acquiredItems.length, recordCount: result.records.length }
  } catch (error) { report.workflow = { ok: false, ...safeFailure(error) } }
  return report
}

export const RECEIPT_SQL = `SELECT /* fixed-twitter-comment-diagnostic */
  CASE WHEN octet_length(u.acquisition_request::text)<=32768 THEN u.acquisition_request END AS acquisition_request,
  c.error_code,c.completed_at,r.captured_at,r.body_size,r.body_sha256,r.body_bytes
  FROM public.usage_requests u JOIN external_platform.provider_calls c ON c.usage_request_id=u.id
    AND c.tenant_id=u.tenant_id AND c.consumer_id=u.consumer_id AND c.api_key_id=u.api_key_id
  JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
  WHERE u.id=$1::uuid AND c.id=$2::uuid AND u.platform='twitter' AND u.status='committed' AND u.response_status=502
    AND c.provider_key='rapidapi' AND c.operation=$3 AND c.endpoint_key=$3 AND c.marketplace='twitter'
    AND c.contract_version='mx-insight-hub.native-forwarding.v1' AND c.endpoint_version='twitter-aio.tweet-thread.2026-11-17'
    AND c.outcome='succeeded_unusable' AND c.http_status=200 AND c.billed IS NULL
    AND r.body_size=$4 AND octet_length(r.body_bytes)=$4 AND r.body_sha256=$5
    AND (SELECT count(*) FROM external_platform.provider_calls sibling WHERE sibling.usage_request_id=u.id)=1`

export async function diagnoseSavedTwitterPage(client, modules) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  let row
  try {
    await client.query("SET LOCAL statement_timeout='10s'")
    await client.query("SET LOCAL lock_timeout='1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'")
    const result = await client.query(RECEIPT_SQL, [SOURCE.usageId, SOURCE.callId, OPERATION, SOURCE.size, SOURCE.sha256])
    need(result.rows.length === 1, 'source_unverified')
    row = result.rows[0]
    need(row.body_bytes instanceof Uint8Array && row.body_bytes.length === SOURCE.size
      && Number(row.body_size) === SOURCE.size && row.body_sha256 === SOURCE.sha256 && hash(row.body_bytes) === SOURCE.sha256, 'archive_unverified')
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  const snapshot = row.acquisition_request
  need(snapshot?.method === 'POST' && snapshot.path === PATH && snapshot.body?.platform === 'twitter', 'request_unverified')
  const request = modules.normalize(snapshot.body, { provider: 'rapidapi', businessId: snapshot.body.businessId ?? snapshot.body.business_id })
  const step = modules.dispatch(request)
  need(step.operationKey === OPERATION && step.endpointKey === OPERATION && step.endpointPath === '/tweet/{tweetId}'
    && !request.cursor && !Object.keys(request.initialParams || {}).length, 'installed_contract_unavailable')
  const capturedAt = new Date(row.captured_at ?? row.completed_at).toISOString()
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.body_bytes).replace(/^\uFEFF/u, '')) }
  catch { need(false, 'archive_unverified') }
  return { revision: 'twitter-rapid-comment-page-diagnostic.v1', supplierHttpCallsMade: 0, databaseReadOnly: true,
    archive: { bytes: SOURCE.size, sha256: SOURCE.sha256, hashVerified: true },
    replayScope: 'archived_raw_without_credential_redaction', productionSuccessNotEstablished: true,
    savedErrorCode: known(row.error_code, ['invalid_social_contract', 'social_upstream_response_unusable', 'invalid_upstream_contract']),
    ...replayTwitterRawPage(payload, { ...modules, request, step, capturedAt }) }
}

export async function main(args = process.argv.slice(2)) {
  let client
  try {
    need(args.length === 0, 'invalid_arguments')
    need(process.env.DATABASE_URL && process.env.MX_INSIGHT_LISTENER_MODE === 'public', 'public_postgres_container_required')
    const root = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/server/`) : new URL('../', import.meta.url)
    const sources = Object.fromEntries(await Promise.all(FILES.map(async file => [file, hash(await readFile(new URL(file, root)))])))
    const parser = await import(new URL(FILES[0], root)), projection = await import(new URL(FILES[1], root))
    const contract = await import(new URL(FILES[2], root)), safety = await import(new URL('core/postgres-json.mjs', root))
    const workflow = await import(new URL('external-platforms/social-account-workflow.mjs', root))
    const { Client } = await import('pg')
    client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
      application_name: 'twitter-rapid-comment-page-diagnostic.v1' })
    await client.connect()
    const report = await diagnoseSavedTwitterPage(client, { parse: parser.parseRapidApiTwitterCommentPage,
      project: projection.projectPostCommentPage, normalize: contract.normalizePostCommentsRequest,
      dispatch: contract.buildPostCommentsDispatch, isJsonSafe: safety.isPostgresSafeJsonValue,
      workflowProject: workflow.projectPage, traversal: contract.POST_COMMENTS_TRAVERSAL })
    console.log(JSON.stringify({ ...report, sources }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ supplierHttpCallsMade: 0, databaseReadOnly: true, error: safeFailure(error) }))
    process.exitCode = 1
  } finally { await client?.end().catch(() => {}) }
}
const entry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === resolve(process.cwd(), '[eval1]')
  || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href
if (entry) await main()
