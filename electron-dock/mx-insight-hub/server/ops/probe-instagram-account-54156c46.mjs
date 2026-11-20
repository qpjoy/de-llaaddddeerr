import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

// Incident-only operator tool. No direct supplier HTTP, grant changes or historical writes.
export const REVISION = 'instagram-account-54156c46.v2'
export const LEGACY_RUN_DIR = '/tmp/mx-ig-account-54156c46', PRODUCTION_RUN_DIR = '/dev/shm/mx-ig-account-54156c46'
export const INCIDENT = Object.freeze({ requestId: '54156c46-247b-4783-ba5a-24a070be6b88',
  callId: '5f00a6f4-7575-4b02-a805-e285bc2883fb', upstreamRequestId: '7c36b8fe-c8ab-4c3c-9b3d-ccd701c4b9af',
  bodySha256: '212216a9cdac8e6381af466530a9af130624008ffb1b81c9bb598af4ba3df18d', bodySize: 1336 })
export const SLOTS = Object.freeze([
  { name: 'target-v2', key: 't.api_622ad609d30f9780', target: true },
  { name: 'control-v2', key: 't.api_622ad609d30f9780', target: false },
  { name: 'target-v3', key: 't.instagram_v3_get_user_profile', target: true },
].map(slot => Object.freeze({ ...slot, idempotencyKey: `ig-profile-54156c46-v1-${slot.name}` })))
const MAX = 8 * 1024 * 1024, CONTRACT = 'mx-insight-hub.native-forwarding.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const object = value => kind(value) === 'object'
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const requireValue = (condition, code) => { if (!condition) throw new Error(code) }
const REASONS = new Map([
  ['Account profile has no stable identity', 'profile_identity_missing'],
  ['Account identity was not represented losslessly', 'identity_not_lossless'],
  ['Account profile identity does not match the requested account', 'profile_id_mismatch'],
  ['Account profile username does not match the requested account', 'profile_username_mismatch'],
  ['Account profile identity is invalid', 'profile_identity_invalid'], ['invalid_social_projection', 'invalid_social_projection'],
])
const MISSING = new Set(['user not found', 'user does not exist', 'account not found', 'account does not exist',
  'user_not_found', 'account_not_found', '用户不存在', '用户未找到', '账号不存在'])
const TEXT_FIELDS = ['reason', 'message', 'msg', 'error_type', 'error', 'error_code',
  'error_message', 'error_msg', 'errorType', 'errorMessage', 'detail', 'exception']
const messageToken = value => value.trim().toLowerCase().replace(/[.!。！]+$/u, '')
const SAFE_ERRORS = new Set(['source_unverified', 'source_snapshot_invalid', 'source_step_mismatch', 'parser_unavailable',
  'probe_locked', 'probe_directory_required', 'probe_directory_invalid', 'marker_exists', 'marker_write_failed',
  'public_origin_invalid', 'admin_credential_unavailable', 'demo_unavailable', 'demo_identity_mismatch',
  'capabilities_unavailable', 'slot_not_granted_or_ready', 'prior_identity_mismatch', 'prior_order_invalid',
  'saved_receipt_unavailable', 'saved_call_unverified', 'saved_outcome_unknown', 'saved_archive_unverified',
  'supplier_access_or_capacity_rejected', 'http_outcome_unknown', 'invalid_arguments', 'database_url_required',
  'recovery_claim_required', 'recovery_receipt_exists', 'recovery_marker_exists', 'recovery_marker_check_failed', 'marker_check_failed',
  'marker_mount_unavailable', 'marker_mount_readonly', 'marker_mount_not_tmpfs', 'marker_mount_invalid'])
const errorCode = error => SAFE_ERRORS.has(error?.message) ? error.message : 'probe_failed'
const PHASES = new Set(['initialize','connect','acquire_lock','read_source','normalize_source','inspect_archive','read_priors','verify_recovery',
  'verify_marker_mount','prepare_marker_directory','prepare_slot','check_marker','mint_demo','read_capabilities','write_marker','dispatch_native','read_saved_calls','read_saved_archive'])
const ERRNOS = new Set(['EACCES','EPERM','EROFS','ENOENT','ENOTDIR','EEXIST','ENOSPC','EDQUOT','EIO','EMFILE','ENFILE','ETIMEDOUT','ECONNREFUSED','ECONNRESET','ENOTFOUND'])
const SQLSTATES = new Set(['57014','55P03','42501','42P01','42703','42601','22P02','25006','25P02','08000','08001','08003','08006','57P01','53300'])
const failure = (error, phase) => ({ phase: PHASES.has(phase) ? phase : 'initialize', errno: ERRNOS.has(error?.code) ? error.code : null, sqlState: SQLSTATES.has(error?.code) ? error.code : null })
function envelopeShape(value, depth = 0) {
  if (!object(value)) return { type: kind(value) }
  const keys = Object.keys(value).sort(), safe = keys.filter(key => /^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(key)
    && !/credential|token|secret|password|auth|cookie|header|params|query|url|link|api_?key|session|proxy/i.test(key))
  const texts = Object.fromEntries(TEXT_FIELDS.filter(key => typeof value[key] === 'string').map(key => {
    const text = messageToken(value[key])
    return [key, { length: value[key].length, known: MISSING.has(text) ? 'account_not_found'
      : ['ok', 'success', 'successful', 'fail', 'failed', 'error'].includes(text) ? text : 'other_text',
    clues: ['not found', 'not exist', 'private', 'login', 'challenge', 'rate limit', 'timeout', 'temporarily']
      .filter(clue => text.length <= 2048 && text.includes(clue)) }]
  }))
  return { type: 'object', fields: Object.fromEntries(safe.slice(0, 32).map(key => [key, { type: kind(value[key]),
    ...(typeof value[key] === 'string' ? { length: value[key].length } : {}),
    ...(Array.isArray(value[key]) ? { count: value[key].length } : {}) }])),
  withheldKeyCount: keys.length - safe.length, fieldsTruncated: safe.length > 32,
  ...(depth === 0 ? { childFields: Object.fromEntries(safe.filter(key => object(value[key])).slice(0, 8)
    .map(key => [key, envelopeShape(value[key], 1)])), childFieldsTruncated: safe.filter(key => object(value[key])).length > 8 } : {}),
  ...(typeof value.status === 'boolean' ? { status: value.status } : {}),
  codes: Object.fromEntries(['code', 'error_code', 'status_code'].filter(key => Number.isSafeInteger(value[key])).map(key => [key, value[key]])), texts }
}
export function inspectArchive(archive, { step, operation = 'crawl', projectPage, projectionLabel = 'deployed_v2_profile' } = {}) {
  if (!archive) return { state: 'missing', usable: false }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  const report = { bodySize: Number(archive.body_size), bodySha256: /^[0-9a-f]{64}$/u.test(archive.body_sha256 || '') ? archive.body_sha256 : null, usable: false }
  if (!bytes || bytes.length > MAX) return { ...report, state: 'bytes_unavailable_or_too_large' }
  report.actualSha256 = sha(bytes)
  if (report.actualSha256 !== archive.body_sha256 || bytes.length !== Number(archive.body_size)) return { ...report, state: 'integrity_failed' }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')) }
  catch { return { ...report, state: 'invalid_json' } }
  const roots = [payload, payload?.data, payload?.data?.data]
  report.state = 'verified'; report.hashVerified = true
  report.shape = { root: envelopeShape(roots[0]), data: envelopeShape(roots[1]), nestedData: envelopeShape(roots[2]) }
  const errorRoots = roots.flatMap(root => [root, ...TEXT_FIELDS.filter(key => object(root?.[key])).map(key => root[key])])
  report.accountNotFoundText = errorRoots.some(root => object(root) && TEXT_FIELDS.some(key => typeof root[key] === 'string' && MISSING.has(messageToken(root[key]))))
  report.businessFailure = roots.some(root => object(root) && (root.status === false || ['fail', 'failed', 'error'].includes(root.status)))
  report.projection = { label: projectionLabel, state: 'unavailable' }
  const date = new Date(archive.captured_at)
  if (step && typeof projectPage === 'function' && Number.isFinite(date.getTime())) {
    try {
      const result = projectPage(payload, step, operation, date.toISOString())
      report.projection = { label: projectionLabel, state: 'accepts', profileCount: result.projected.profiles.length, itemCount: result.projected.acquiredItems.length }
      report.usable = report.projection.profileCount === 1 && !report.businessFailure && !report.accountNotFoundText
    } catch (error) { report.projection = { label: projectionLabel, state: 'rejects', reason: REASONS.get(error?.message) || 'other_projection_error' } }
  }
  report.accountNotFoundSignal = report.accountNotFoundText && report.businessFailure
    && report.projection.state === 'rejects' && report.projection.reason === 'profile_identity_missing'
  return report
}
async function loadDeployedContracts() {
  const compat = await import('file:///app/server/contracts/hub-social-compat.mjs')
  const native = await import('file:///app/server/contracts/native-forwarding.mjs')
  const workflow = await import('file:///app/server/external-platforms/social-account-workflow.mjs')
  return { ...compat, ...native, projectPage: workflow.projectPage }
}
async function responseJson(response, maxBytes = 2 * 1024 * 1024) {
  const reader = response.body?.getReader(); requireValue(reader, 'probe_failed')
  const chunks = []; let size = 0
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break
      size += value.length; requireValue(size <= maxBytes, 'probe_failed'); chunks.push(value) }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
async function saveMarker(handle, value) {
  const bytes = Buffer.from(JSON.stringify(value)); let offset = 0
  while (offset < bytes.length) { const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    requireValue(bytesWritten > 0, 'marker_write_failed'); offset += bytesWritten }
  await handle.truncate(bytes.length); await handle.sync()
}
export async function runProbe({ pool, fetchImpl = fetch, fsImpl = fs, env = process.env, execute = false,
  resumeUnstarted = false, loadContracts = loadDeployedContracts, clock = () => Date.now(), incident = INCIDENT }) {
  const report = { revision: REVISION, originalRequestId: incident.requestId,
    mode: resumeUnstarted ? 'resume-unstarted' : execute ? 'execute' : 'inspect', maxPaidCalls: 3, upstreamCallsAttempted: 0, slots: [],
    markerBoundary: 'Keep the same host run marker and directory. Never remove markers or change directories to repeat this campaign.' }
  let client, locked = false, currentMarker, phase = 'initialize'
  const read = async fn => {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try { await client.query("SET LOCAL statement_timeout='5s'"); await client.query("SET LOCAL lock_timeout='1s'")
      await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'"); return await fn(client) }
    finally { await client.query('ROLLBACK') }
  }
  try {
    requireValue(typeof execute === 'boolean' && typeof resumeUnstarted === 'boolean' && (!resumeUnstarted || execute), 'invalid_arguments')
    if (resumeUnstarted) requireValue(env.MX_IG_PROBE_RECOVERY_CLAIM === INCIDENT.requestId, 'recovery_claim_required')
    phase = 'connect'
    client = await pool.connect()
    phase = 'acquire_lock'
    const { rows: [lock] } = await read(db => db.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked', ['instagram-account-probe', incident.requestId]))
    requireValue(lock?.locked === true, 'probe_locked'); locked = true
    phase = 'read_source'
    const { original, source } = await read(async db => {
      const { rows: [original] } = await db.query(`SELECT /* ig-account-probe:original */ id,tenant_id,consumer_id,api_key_id,platform,status,response_status,
        CASE WHEN octet_length(acquisition_request::text)<=16384 THEN acquisition_request END AS acquisition_request
        FROM public.usage_requests WHERE id=$1::uuid`, [incident.requestId])
      const { rows: [source] } = await db.query(`SELECT /* ig-account-probe:source-call */ p.*,a.body_size,a.body_sha256,a.captured_at,
        CASE WHEN a.body_size<=8388608 AND octet_length(a.body_bytes)<=8388608 THEN a.body_bytes END AS body_bytes
        FROM external_platform.provider_calls p JOIN public.usage_requests u ON u.id=p.usage_request_id
          AND p.tenant_id=u.tenant_id AND p.consumer_id=u.consumer_id AND p.api_key_id=u.api_key_id
        JOIN control.external_platform_restricted_raw_responses a ON a.provider_call_id=p.id
        WHERE u.id=$1::uuid AND p.id=$2::uuid`, [incident.requestId, incident.callId])
      return { original, source }
    })
    requireValue(original?.platform === 'instagram' && original.status === 'committed' && original.response_status === 502
      && uuid(original.api_key_id) && uuid(original.tenant_id) && uuid(original.consumer_id), 'source_unverified')
    const snapshot = original.acquisition_request, body = snapshot?.body
    requireValue(snapshot?.method === 'POST' && ['/api/v1/data/social/crawl','/api/v1/search/crawl','/api/v1/night-all/search/crawl'].includes(snapshot.path)
      && !snapshot.bodyOmitted && object(body) && Buffer.byteLength(JSON.stringify(snapshot)) <= 16384
      && !JSON.stringify(body).includes('[redacted]'), 'source_snapshot_invalid')
    phase = 'normalize_source'; let contracts
    try { contracts = await loadContracts() } catch { throw new Error('parser_unavailable') }
    requireValue(['normalizeHubSocialCompatRequest','buildHubSocialCompatDispatch','normalizeNativeForwardingRequest','projectPage']
      .every(name => typeof contracts[name] === 'function'), 'parser_unavailable')
    const request = contracts.normalizeHubSocialCompatRequest('crawl', body)
    requireValue(request.platform === 'instagram' && request.jobs.length === 1 && request.page === 1 && !request.cursor, 'source_snapshot_invalid')
    const step = contracts.buildHubSocialCompatDispatch(request.jobs[0], { pageSize: request.pageSize })
    const params = step.upstreamQuery
    requireValue(step.key === SLOTS[0].key && step.socialCompat?.stage === 'resolve' && step.socialCompat.kind === 'profile'
      && object(params) && Object.keys(params).length === 1 && Object.keys(params).every(key => ['username','user_id'].includes(key))
      && Object.values(params).every(value => typeof value === 'string' && value.trim() && value.length <= 256), 'source_step_mismatch')
    requireValue(source?.id === incident.callId && source.usage_request_id === incident.requestId && source.provider_key === 'tikhub'
      && source.tenant_id === original.tenant_id && source.consumer_id === original.consumer_id && source.api_key_id === original.api_key_id
      && source.marketplace === 'instagram' && source.call_ordinal === 0 && source.operation === step.endpointKey && source.endpoint_key === step.endpointKey
      && source.endpoint_version === step.endpointVersion && source.contract_version === CONTRACT && source.outcome === 'succeeded_unusable'
      && source.http_status === 200 && source.business_code === 200 && source.error_code === 'invalid_social_contract'
      && source.upstream_request_id === incident.upstreamRequestId && Number(source.body_size) === incident.bodySize
      && source.body_sha256 === incident.bodySha256, 'source_unverified')
    phase = 'inspect_archive'
    report.original = { callId: source.id, billed: typeof source.billed === 'boolean' ? source.billed : null,
      costMinor: Number.isSafeInteger(Number(source.cost_minor)) && source.cost_minor != null ? Number(source.cost_minor) : null,
      costKind: ['estimated','provider_reported','unknown'].includes(source.cost_kind) ? source.cost_kind : null,
      currency: ['CNY','USD'].includes(source.currency) ? source.currency : null,
      archive: inspectArchive(source, { step, projectPage: contracts.projectPage }) }
    requireValue(report.original.archive.state === 'verified', 'source_unverified')
    const originalStop = report.original.archive.usable ? 'original_archive_usable'
      : report.original.archive.accountNotFoundSignal ? 'original_account_not_found_signal' : null
    const canPurchase = execute && !originalStop
    if (originalStop) report.stoppedReason = originalStop
    const allPlans = SLOTS.map(slot => ({ ...slot, path: `/api/v1/data/native/${slot.key}`,
      body: { deliveryMode: 'live_only', params: slot.name === 'control-v2' ? { username: 'instagram' }
        : slot.name === 'target-v3' ? { username: params.username } : { ...params } } }))
    const sameAsControl = params.username?.toLowerCase() === 'instagram'
    if (sameAsControl) report.controlSkipped = 'same_as_original_target'
    const plans = allPlans.filter(plan => !sameAsControl || plan.name !== 'control-v2')
    const priors = async () => {
      phase = 'read_priors'
      const { rows } = await read(db => db.query(`SELECT /* ig-account-probe:priors */ id,tenant_id,consumer_id,api_key_id,platform,status,response_status,idempotency_key,
        CASE WHEN octet_length(acquisition_request::text)<=16384 THEN acquisition_request END AS acquisition_request
        FROM public.usage_requests WHERE consumer_id=$1::uuid AND idempotency_key=ANY($2::text[]) ORDER BY reserved_at LIMIT 4`,
      [original.consumer_id, SLOTS.map(slot => slot.idempotencyKey)]))
      requireValue(rows.length <= 3 && new Set(rows.map(row => row.idempotency_key)).size === rows.length, 'prior_identity_mismatch')
      for (const row of rows) { const plan = allPlans.find(value => value.idempotencyKey === row.idempotency_key)
        requireValue(plan && row.api_key_id === original.api_key_id && row.tenant_id === original.tenant_id && row.consumer_id === original.consumer_id
          && row.platform === 'social' && row.acquisition_request?.method === 'POST' && row.acquisition_request.path === plan.path
          && isDeepStrictEqual(row.acquisition_request.body, plan.body), 'prior_identity_mismatch') }
      return rows
    }
    let saved = await priors()
    if (resumeUnstarted) requireValue(saved.length === 0, 'recovery_receipt_exists')
    if (canPurchase) requireValue(!saved.filter(row => plans.some(plan => plan.idempotencyKey === row.idempotency_key))
      .some(row => plans.slice(0, plans.findIndex(plan => plan.idempotencyKey === row.idempotency_key))
      .some(plan => !saved.some(prior => prior.idempotency_key === plan.idempotencyKey))), 'prior_order_invalid')
    const directory = env.MX_IG_PROBE_RUN_DIR
    const markerStates = async name => {
      const states = { current: 'not_checked', legacy: 'not_checked' }
      for (const [label, base] of [['current',directory],['legacy',LEGACY_RUN_DIR]]) if (typeof base === 'string' && isAbsolute(base)) {
        try { await fsImpl.lstat(join(base, `${name}.json`)); states[label] = 'present' }
        catch (error) { states[label] = error.code === 'ENOENT' ? 'absent' : 'unavailable' }
      }
      return states
    }
    const requireAbsentMarkers = async (slots, recovery = false) => {
      phase = recovery ? 'verify_recovery' : 'check_marker'
      for (const slot of slots) for (const base of new Set([directory,LEGACY_RUN_DIR])) {
        let exists = false
        try { await fsImpl.lstat(join(base, `${slot.name}.json`)); exists = true }
        catch (error) { if (error.code !== 'ENOENT') throw Object.assign(new Error(recovery ? 'recovery_marker_check_failed' : 'marker_check_failed'), { code: error.code }) }
        requireValue(!exists, recovery ? 'recovery_marker_exists' : 'marker_exists')
      }
    }
    if (resumeUnstarted) { requireValue(typeof directory === 'string' && isAbsolute(directory), 'probe_directory_required'); await requireAbsentMarkers(SLOTS, true) }
    if (canPurchase) {
      phase = 'prepare_marker_directory'
      requireValue(typeof directory === 'string' && isAbsolute(directory), 'probe_directory_required')
      if (directory === PRODUCTION_RUN_DIR || directory.startsWith('/dev/shm/')) {
        requireValue(directory === PRODUCTION_RUN_DIR, 'probe_directory_invalid')
        phase = 'verify_marker_mount'; let mountInfo
        try { mountInfo = await fsImpl.readFile('/proc/self/mountinfo', 'utf8') }
        catch (error) { throw Object.assign(new Error('marker_mount_unavailable'), { code: error.code }) }
        const mounts = mountInfo.split('\n').map(line => line.split(' ')).filter(fields => fields[4] === '/dev/shm')
        requireValue(mounts.length === 1, 'marker_mount_unavailable')
        const fields = mounts[0], separator = fields.indexOf('-'), options = fields[5]?.split(',') || [], superOptions = fields[separator + 3]?.split(',') || []
        requireValue(separator >= 6 && fields[separator + 1] === 'tmpfs', 'marker_mount_not_tmpfs')
        requireValue(options.includes('rw') && !options.includes('ro') && superOptions.includes('rw') && !superOptions.includes('ro'), 'marker_mount_readonly')
        let mount
        try { mount = await fsImpl.lstat('/dev/shm') } catch (error) { throw Object.assign(new Error('marker_mount_unavailable'), { code: error.code }) }
        requireValue(mount.isDirectory() && !mount.isSymbolicLink(), 'marker_mount_invalid')
      }
      phase = 'prepare_marker_directory'
      await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 })
      requireValue((await fsImpl.lstat(directory)).isDirectory() && !(await fsImpl.lstat(directory)).isSymbolicLink(), 'probe_directory_invalid')
      const parent = await fsImpl.open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
    }
    let origin, demo, capabilities
    const prepareHttp = async () => {
      if (demo) return
      const publicUrl = env.MX_INSIGHT_PUBLIC_URL
      requireValue(typeof publicUrl === 'string' && publicUrl.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(publicUrl), 'public_origin_invalid')
      try { origin = new URL(publicUrl.trim()) } catch { throw new Error('public_origin_invalid') }
      requireValue(['http:','https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'public_origin_invalid')
      requireValue(typeof env.MX_INSIGHT_ADMIN_TOKEN === 'string' && env.MX_INSIGHT_ADMIN_TOKEN.length >= 32, 'admin_credential_unavailable')
      phase = 'mint_demo'
      const response = await fetchImpl('http://127.0.0.1:18151/internal/v1/admin/demo-credentials', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'x-mx-insight-admin-token': env.MX_INSIGHT_ADMIN_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ keyId: original.api_key_id }) })
      requireValue(response.ok, 'demo_unavailable'); demo = (await responseJson(response)).data
      requireValue(demo?.keyId === original.api_key_id && demo.consumerId === original.consumer_id && typeof demo.secret === 'string'
        && /^mih_demo_[A-Za-z0-9_.-]+$/u.test(demo.secret) && demo.secret.length <= 4096, 'demo_identity_mismatch')
      phase = 'read_capabilities'
      const preflight = await fetchImpl(`${origin.origin}/api/v1/data/capabilities`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${demo.secret}` } })
      requireValue(preflight.ok, 'capabilities_unavailable'); capabilities = (await responseJson(preflight)).data?.capabilities
      requireValue(Array.isArray(capabilities), 'capabilities_unavailable')
    }
    for (const plan of plans) {
      phase = 'prepare_slot'
      if (plan.name === 'target-v3' && !params.username) { report.stoppedReason = 'v3_requires_original_username'; break }
      const native = contracts.normalizeNativeForwardingRequest(plan.key, plan.body)
      requireValue(native.endpointKey === `native.${plan.key}` && native.marketplace === 'instagram', 'source_step_mismatch')
      const marker = canPurchase ? join(directory, `${plan.name}.json`) : null, entry = { slot: plan.name, idempotencyKey: plan.idempotencyKey, endpoint: native.endpointKey,
        requestBodySha256: sha(JSON.stringify(plan.body)), v2ProjectionOnV3: plan.name === 'target-v3' }
      report.slots.push(entry)
      if (!canPurchase) { entry.markerStates = await markerStates(plan.name); entry.markerState = entry.markerStates.current }
      let prior = saved.find(row => row.idempotency_key === plan.idempotencyKey)
      if (!prior && !canPurchase) {
        entry.state = 'no_saved_receipt'
        entry.dispatchState = 'not_proven_by_absent_receipt'
        continue
      }
      if (!prior) {
        await requireAbsentMarkers([plan])
        await prepareHttp()
        requireValue(capabilities.some(row => row?.capability === native.endpointKey && row.ready === true), 'slot_not_granted_or_ready')
        saved = await priors(); prior = saved.find(row => row.idempotency_key === plan.idempotencyKey)
        if (resumeUnstarted && report.upstreamCallsAttempted === 0) requireValue(saved.length === 0, 'recovery_receipt_exists')
      }
      if (!prior) {
        await requireAbsentMarkers([plan]); phase = 'write_marker'
        try { currentMarker = await fsImpl.open(marker, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') throw new Error('marker_exists'); throw error }
        await saveMarker(currentMarker, { ...entry, state: 'dispatch_started', attemptedAt: new Date(clock()).toISOString() })
        const parent = await fsImpl.open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
        report.upstreamCallsAttempted++
        phase = 'dispatch_native'
        try {
          const response = await fetchImpl(`${origin.origin}${plan.path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
            headers: { authorization: `Bearer ${demo.secret}`, 'content-type': 'application/json', 'idempotency-key': plan.idempotencyKey }, body: JSON.stringify(plan.body) })
          entry.httpStatus = response.status; entry.httpRequestId = uuid(response.headers.get('x-mx-insight-request-id'))
          await response.body?.cancel().catch(() => {})
          await saveMarker(currentMarker, { ...entry, state: 'http_response' })
        } catch {
          await saveMarker(currentMarker, { ...entry, state: 'outcome_unknown' })
          throw new Error('http_outcome_unknown')
        } finally { await currentMarker.close(); currentMarker = null }
        saved = await priors(); prior = saved.find(row => row.idempotency_key === plan.idempotencyKey)
      } else entry.reusedSavedReceipt = true
      try {
      requireValue(prior && (!entry.httpRequestId || entry.httpRequestId === prior.id), 'saved_receipt_unavailable')
      entry.requestId = prior.id; entry.savedStatus = ['committed','released','reserved','unknown'].includes(prior.status) ? prior.status : 'other'
      entry.savedHttpStatus = prior.response_status
      phase = 'read_saved_calls'
      const { rows: calls } = await read(db => db.query(`SELECT /* ig-account-probe:calls */ p.* FROM external_platform.provider_calls p
        JOIN public.usage_requests u ON u.id=p.usage_request_id AND p.tenant_id=u.tenant_id AND p.consumer_id=u.consumer_id AND p.api_key_id=u.api_key_id
        WHERE u.id=$1::uuid AND u.api_key_id=$2::uuid AND u.consumer_id=$3::uuid AND u.tenant_id=$4::uuid ORDER BY p.started_at,p.id LIMIT 2`,
      [prior.id, original.api_key_id, original.consumer_id, original.tenant_id]))
      entry.providerCallCount = calls.length
      entry.calls = calls.map(call => ({ callId: uuid(call.id), outcome: ['succeeded','succeeded_unusable','rejected','pending','unknown'].includes(call.outcome) ? call.outcome : 'other' }))
      requireValue(['committed','released'].includes(prior.status), 'saved_outcome_unknown')
      requireValue(calls.length === 1, 'saved_call_unverified'); const call = calls[0]
      requireValue(call.provider_key === 'tikhub' && call.marketplace === 'instagram' && call.usage_request_id === prior.id && call.operation === native.endpointKey
        && call.tenant_id === original.tenant_id && call.consumer_id === original.consumer_id && call.api_key_id === original.api_key_id
        && call.call_ordinal === 0 && call.endpoint_key === native.endpointKey && call.endpoint_version === native.endpointVersion && call.contract_version === CONTRACT, 'saved_call_unverified')
      requireValue(['succeeded','succeeded_unusable','rejected'].includes(call.outcome), 'saved_outcome_unknown')
      entry.call = { callId: uuid(call.id), upstreamRequestId: uuid(call.upstream_request_id), outcome: call.outcome,
        httpStatus: call.http_status, businessCode: call.business_code, billed: typeof call.billed === 'boolean' ? call.billed : null,
        costMinor: Number.isSafeInteger(Number(call.cost_minor)) && call.cost_minor != null ? Number(call.cost_minor) : null,
        costKind: ['estimated','provider_reported','unknown'].includes(call.cost_kind) ? call.cost_kind : null,
        currency: ['CNY','USD'].includes(call.currency) ? call.currency : null }
      requireValue(![401,402,403,429].includes(call.http_status) && !['upstream_auth_or_balance_unavailable','upstream_rate_limited'].includes(call.error_code), 'supplier_access_or_capacity_rejected')
      phase = 'read_saved_archive'
      const { rows: [archive] } = await read(db => db.query(`SELECT /* ig-account-probe:archive */ a.body_size,a.body_sha256,a.captured_at,
        CASE WHEN a.body_size<=8388608 AND octet_length(a.body_bytes)<=8388608 THEN a.body_bytes END AS body_bytes
        FROM control.external_platform_restricted_raw_responses a JOIN external_platform.provider_calls p ON p.id=a.provider_call_id
        JOIN public.usage_requests u ON u.id=p.usage_request_id AND p.tenant_id=u.tenant_id AND p.consumer_id=u.consumer_id AND p.api_key_id=u.api_key_id
        WHERE p.id=$1::uuid AND u.id=$2::uuid AND u.api_key_id=$3::uuid AND u.consumer_id=$4::uuid AND u.tenant_id=$5::uuid`,
      [call.id, prior.id, original.api_key_id, original.consumer_id, original.tenant_id]))
      const projectionStep = plan.target ? step : contracts.buildHubSocialCompatDispatch(
        contracts.normalizeHubSocialCompatRequest('crawl', { platform: 'instagram', username: 'instagram', count: 20 }).jobs[0], { pageSize: 20 })
      phase = 'inspect_archive'; entry.archive = inspectArchive(archive, { step: projectionStep, projectPage: contracts.projectPage,
        projectionLabel: plan.name === 'target-v3' ? 'deployed_v2_profile_projection_on_v3_response_not_route_change' : 'deployed_v2_profile' })
      requireValue(entry.archive.state === 'verified', 'saved_archive_unverified')
      if (plan.target && (entry.archive.usable || entry.archive.accountNotFoundSignal)) {
        report.stoppedReason = entry.archive.usable ? 'target_profile_usable' : 'target_account_not_found_signal'
        if (canPurchase) break
      }
      } catch (error) { entry.inspectionError = errorCode(error); entry.failure = failure(error, phase); if (canPurchase) throw error }
    }
    report.stoppedReason ||= canPurchase ? 'three_slot_budget_complete' : 'inspection_complete'
    return report
  } catch (error) { report.stoppedReason = errorCode(error); report.failure = failure(error, phase); return report }
  finally {
    await currentMarker?.close().catch(() => {})
    if (client) { let releaseError
      try { await client.query('ROLLBACK') } catch (error) { releaseError = error }
      if (locked) try { await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', ['instagram-account-probe', incident.requestId]) } catch (error) { releaseError = error }
      client.release(releaseError) }
  }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const args = process.argv.slice(2)
    requireValue(args.length <= 1 && (!args.length || ['--inspect','--execute','--resume-unstarted'].includes(args[0])), 'invalid_arguments')
    requireValue(process.env.DATABASE_URL, 'database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
    console.log(JSON.stringify(await runProbe({ pool, execute: ['--execute','--resume-unstarted'].includes(args[0]), resumeUnstarted: args[0] === '--resume-unstarted' }), null, 2))
  } catch (error) { console.error(JSON.stringify({ error: errorCode(error), failure: failure(error, 'initialize') })); process.exitCode = 1 }
  finally { await pool?.end() }
}
