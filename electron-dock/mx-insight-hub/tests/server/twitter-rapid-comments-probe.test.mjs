import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { previewRapidComments, runRapidCommentVerification, inspectRapidCommentError, inspectThreadResumeEvidence, assertThreadResumeEvidence,
  SOURCE_REQUEST_ID, KEYS, OPERATION, THREAD_KEYS, THREAD_OPERATION, RESUME_SOURCE } from '../../server/ops/verify-twitter-rapid-comments.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'

const pepper = 'offline-twitter-rapid-probe-pepper-32-chars', secret = 'synthetic-probe-provider-credential'
const dbRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/gu, c => `_${c.toLowerCase()}`), value]))
const tweet = (id, parent = '100', replies = 0) => ({ __typename: 'Tweet', rest_id: id,
  legacy: { id_str: id, full_text: `Private synthetic comment ${id}`, conversation_id_str: '100', in_reply_to_status_id_str: parent,
    created_at: 'Sat Feb 07 04:39:56 +0000 2026', favorite_count: 2, reply_count: replies },
  core: { user_results: { result: { rest_id: '42', legacy: { name: 'Private author', screen_name: 'private_author' } } } } })
const page = (tweets, cursor = null) => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries',
  entries: [{ entryId: 'conversationthread-fixture', content: { entryType: 'TimelineTimelineModule', items: tweets.map(result => ({
    item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result } } } })) } },
  ...(cursor ? [{ content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: cursor } }] : [])] }] } } })

async function harness({ failAt = 0, rejectAt = 0, rejectedBody = { message: 'Private supplier refusal' }, rejectedStatus = 403, rejectedHeaders = {},
  empty = false, noReplies = false, fallback = true, legacyReceipt = true } = {}) {
  const store = new MemoryStore(), service = new HubService({ store, apiKeyPepper: pepper })
  const tenant = await service.createTenant({ name: 'Probe fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Existing owner' })
  await store.setPlatformGrant(consumer.id, 'twitter', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'twitter', maxRequests: 10000,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Existing live key', platforms: ['twitter'], capabilities: ['social.comments.list'] })
  const context = await service.authenticate(key.secret)
  const source = { id: SOURCE_REQUEST_ID, tenant_id: tenant.id, consumer_id: consumer.id, api_key_id: context.apiKey.id,
    platform: 'social', status: 'committed', response_status: 200,
    acquisition_request: { method: 'POST', path: '/api/v1/data/native/t.api_3cd88a6621a01120', body: { params: { tweet_id: '100' } } } }
  const sourceCall = { id: '8b5beec0-a8b9-4b4b-862a-1d2f6888f492', tenant_id: tenant.id, consumer_id: consumer.id, api_key_id: context.apiKey.id,
    provider_key: 'tikhub', operation: 'native.t.api_3cd88a6621a01120', endpoint_key: 'native.t.api_3cd88a6621a01120', marketplace: 'twitter',
    outcome: 'succeeded', http_status: 200, billed: true, contract_version: 'mx-insight-hub.native-forwarding.v1' }
  const sourceBytes = Buffer.from(JSON.stringify({ code: 200, data: { id: '100', conversation_id: '100', thread: [
    { id: '200', conversation_id: '100', replies: fallback ? 2 : 0, text: 'Private archived comment' }] } }))
  const sourceArchive = { body_size: sourceBytes.length, body_sha256: createHash('sha256').update(sourceBytes).digest('hex'), body_bytes: sourceBytes }
  const legacyRequest = { ...source, id: RESUME_SOURCE.requestId, platform: 'twitter', status: 'committed', response_status: 502,
    idempotency_key: KEYS[0], acquisition_request: { method: 'POST', path: '/api/v1/data/social/post-comments',
      body: { platform: 'twitter', postId: '100', count: 100, includeRaw: false } } }
  const legacyCall = { ...sourceCall, id: RESUME_SOURCE.callId, usage_request_id: legacyRequest.id, provider_key: 'rapidapi',
    operation: OPERATION, endpoint_key: OPERATION, outcome: 'rejected', http_status: 404, billed: false }
  // The production body/target are intentionally not copied into an offline fixture.
  const legacyBytes = Buffer.from(JSON.stringify({ message: "Endpoint '/tweet/100/replies' does not exist" }))
  const legacyArchive = { body_size: legacyBytes.length, body_sha256: createHash('sha256').update(legacyBytes).digest('hex'), body_bytes: legacyBytes }
  const resumeEvidenceCheck = (saved, stages) => {
    const copies = structuredClone(stages), evidence = copies.find(row => row.stage === 'first')?.providerCalls?.[0]
    if (evidence) {
      assert.equal(evidence.sha256, legacyArchive.body_sha256)
      assert.equal(evidence.bodySize, legacyBytes.length)
      // Only the server-local known archive hash differs in this synthetic fixture.
      evidence.sha256 = RESUME_SOURCE.sha256; evidence.bodySize = RESUME_SOURCE.bodySize
    }
    assertThreadResumeEvidence(saved, copies)
  }
  const owner = { ...source, environment: 'live', key_status: 'active', consumer_status: 'active', tenant_status: 'active',
    expires_at: '2100-01-01T00:00:00Z', twitter_granted: true, comments_granted: true, page_size: 100 }
  const controls = new MemoryExternalPlatformControlStore()
  const config = { configured: true, contractVerified: true, nativeForwardingVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 1000, billing: {} }
  await controls.updatePolicy('rapidapi', THREAD_OPERATION, { expectedRevision: 1, desiredState: 'active', reason: 'Offline probe regression',
    priceBook: { currency: 'USD', pricingAsOf: '2026-11-17T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [THREAD_OPERATION]: 1 } } }, { runtime: { config, credentialConfigured: true } })
  const http = []
  const adapter = new RapidApiAdapter({ apiKey: secret, timeoutMs: 100, fetchImpl: async url => {
    http.push(String(url))
    if (http.length === failAt) throw new Error(`Transport failed with ${secret}`)
    if (http.length === rejectAt) return Response.json(rejectedBody, { status: rejectedStatus, headers: rejectedHeaders })
    if (empty) return Response.json(page([], 'opaque-private-cursor'))
    return Response.json(http.length === 1 ? page([tweet('201', '100', noReplies ? 0 : 3)], 'opaque-private-cursor')
      : page([tweet('203', noReplies ? '200' : '201')]))
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'rapidapi', apiKeyPepper: pepper,
    reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  let locked = false, lockAvailable = true, ownerLookups = 0, foreignCall = false
  const lookup = store.findApiKeyById.bind(store)
  store.findApiKeyById = async value => { ownerLookups++; return lookup(value) }
  const requests = () => [...(legacyReceipt ? [legacyRequest] : []), ...[...store.requests.values()]
    .filter(row => [...KEYS, ...THREAD_KEYS].includes(row.idempotencyKey)).map(dbRow)]
  const calls = () => [...(legacyReceipt ? [legacyCall] : []), ...[...platformStore.calls.values()]
    .filter(row => requests().some(request => request.id === row.usageRequestId)).map(dbRow)]
  const queries = [], routes = ['post-comments','comment-replies'].map(interface_key => ({
    interface_key, mode: 'fixed', primary_provider: 'tikhub', fallback_provider: null, revision: 3 }))
  const pool = { async query(sql, args = []) {
    queries.push(sql)
    if (/^(BEGIN|ROLLBACK|SET LOCAL)/u.test(sql)) return { rows: [] }
    if (sql.includes('twitter-rapid-check:source-calls')) return { rows: [structuredClone(sourceCall)] }
    if (sql.includes('twitter-rapid-check:source */')) return { rows: [structuredClone(source)] }
    if (sql.includes('twitter-rapid-check:owner')) return { rows: [structuredClone(owner)] }
    if (sql.includes('twitter-rapid-check:routes')) return { rows: structuredClone(routes) }
    if (sql.includes('twitter-rapid-check:archive')) {
      if (args[0] === sourceCall.id) return { rows: [sourceArchive] }
      if (args[0] === legacyCall.id) return { rows: [legacyArchive] }
      const value = platformStore.restrictedResponseArchives.get(args[0])
      return { rows: value ? [dbRow(value)] : [] }
    }
    if (sql.includes('twitter-rapid-check:saved')) return { rows: structuredClone(requests()) }
    if (sql.includes('twitter-rapid-check:budget')) return { rows: calls().map(row => ({ ...row,
      ...(foreignCall ? { provider_key: 'tikhub' } : {}), request_tenant_id: source.tenant_id, request_api_key_id: source.api_key_id })) }
    if (sql.includes('twitter-rapid-check:lock')) { const acquired = lockAvailable && !locked; locked ||= acquired; return { rows: [{ acquired }] } }
    if (sql.includes('pg_advisory_unlock')) { locked = false; return { rows: [] } }
    throw new Error('Unexpected diagnostic SQL')
  }, async connect() { return { query: pool.query, release() {} } } }
  const runtime = { pool, store, externalPlatformControlStore: controls,
    rapidApiCredentialStore: { describeCredential: async () => ({ credentialConfigured: true }) },
    postCommentProviderGateways: { twitter: { rapidapi: gateway } }, commentReplyGateways: { twitter: { rapidapi: gateway } } }
  return { runtime, store, gateway, platformStore, adapter, source, sourceArchive, sourceCall, owner, routes, queries, http, context,
    legacyRequest, legacyCall, legacyArchive, resumeEvidenceCheck,
    run: options => runRapidCommentVerification({ runtime, AppError, resumeThread: true, resumeEvidenceCheck, ...options }),
    preview: options => previewRapidComments({ pool, installed: true, readiness: async () => ({ ready: true }), ...options }),
    resumePreview: options => previewRapidComments({ pool, installed: true, readiness: async () => ({ ready: true }),
      resumeThread: true, resumeEvidenceCheck, ...options }),
    ownerLookups: () => ownerLookups, noLock: () => { lockAvailable = false }, corruptCallOwner: () => { foreignCall = true } }
}

test('preview verifies source/ownership/routes without authentication telemetry, runtime dispatch or writes, including an old image', async () => {
  const h = await harness({ legacyReceipt: false }), result = await h.preview()
  assert.equal(result.readyForExecute, true, JSON.stringify(result))
  assert.equal(result.source.hashVerified, true)
  assert.equal(result.routes[0].primaryProvider, 'tikhub')
  assert.equal(h.http.length, 0)
  assert.equal(h.ownerLookups(), 0)
  assert.equal(h.store.requests.size, 0)
  assert.ok(h.queries.every(sql => !/\b(?:UPDATE|INSERT|DELETE)\b/u.test(sql)))
  const old = await h.preview({ installed: false })
  assert.equal(old.errorCode, 'needs_deploy')
  assert.equal(old.source.hashVerified, true)
  assert.equal(old.supplierHttpCallsMade, 0)
})

test('thread resume buys two pages within the original three-call budget and preserves failure, routes and read-only reruns', async () => {
  const h = await harness(), originalFetch = h.adapter.fetch, originalAuthorize = h.runtime.externalPlatformControlStore.authorizeDispatch
  const result = await h.run()
  assert.equal(result.errorCode, undefined, JSON.stringify(result))
  assert.equal(result.supplierHttpCallsMade, 2)
  assert.equal(result.supplierCallsBefore, 1)
  assert.equal(result.supplierCallsAfter, 3)
  assert.equal(result.coverageComplete, false)
  assert.equal(result.publicContractValid, true)
  assert.equal(result.upstreamContinuationVerified, false)
  assert.equal(result.positiveSamplesComplete, true)
  assert.equal(result.sourceUnchanged, true)
  assert.equal(result.originalFailureUnchanged, true)
  assert.deepEqual(result.stages.map(row => row.resultCount), [1,1])
  assert.ok(result.stages.every(row => row.providerCalls[0].hashVerified && row.rawStringWrapperVerified && row.referencesVerified))
  assert.ok(h.http.every(url => !new URL(url).searchParams.has('cursor')))
  assert.equal(new URL(h.http[0]).pathname, '/tweet/100')
  assert.equal(new URL(h.http[1]).pathname, '/tweet/201')
  assert.equal(h.adapter.fetch, originalFetch)
  assert.equal(h.runtime.externalPlatformControlStore.authorizeDispatch, originalAuthorize)
  const lookups = h.ownerLookups()
  h.gateway.postComments = () => { throw new Error('rerun must not invoke a gateway') }
  const again = await h.run()
  assert.equal(again.mode, 'read_saved_only')
  assert.equal(again.supplierHttpCallsMade, 0)
  assert.equal(h.http.length, 2)
  assert.equal(h.ownerLookups(), lookups)
  assert.equal((await h.preview()).mode, 'read_saved_only')
  assert.doesNotMatch(JSON.stringify(result), /synthetic-probe-provider-credential|Private synthetic|Private author|opaque-private-cursor/u)
  assert.deepEqual(result.routesAfter, result.routes)
  assert.equal(h.legacyCall.billed, false, 'the unbilled original call still counts toward HTTP budget')
})

test('unknown first or second outcomes stop every later stage and all subsequent executions', async () => {
  for (const failAt of [1,2]) {
    const h = await harness({ failAt }), result = await h.run()
    assert.ok(result.errorCode)
    assert.equal(h.http.length, failAt)
    const again = await h.run()
    assert.equal(again.mode, 'read_saved_only')
    assert.equal(h.http.length, failAt)
    assert.equal(again.supplierHttpCallsMade, 0)
    assert.equal(result.savedStages[failAt + 2].providerCalls[0].archiveState, 'not_available')
    assert.doesNotMatch(JSON.stringify(result), /synthetic-probe-provider-credential/u)
  }
})

test('missing reply candidates and untested continuations are explicit; verified old candidates need no search', async () => {
  const empty = await harness({ empty: true, fallback: false }), result = await empty.run()
  assert.equal(result.errorCode, undefined, JSON.stringify(result))
  assert.equal(empty.http.length, 1)
  assert.equal(result.coverageComplete, false)
  assert.equal(result.positiveSamplesComplete, false)
  assert.equal(result.upstreamContinuationVerified, false)
  assert.deepEqual(result.stages.slice(1).map(row => row.state), ['not_covered_no_reply_candidate'])
  const fallback = await harness({ noReplies: true }), second = await fallback.run()
  assert.equal(second.errorCode, undefined, JSON.stringify(second))
  assert.equal(new URL(fallback.http[1]).pathname, '/tweet/200')
})

test('source corruption, missing installed gateway, closed operation, grants and concurrent execution fail before purchase', async () => {
  for (const mutate of [h => { h.sourceArchive.body_sha256 = '0'.repeat(64) },
    h => { h.source.acquisition_request.body.params.tweet_id = '999' },
    h => { h.owner.comments_granted = false }, h => h.noLock(),
    h => { h.runtime.postCommentProviderGateways = {} },
    h => { h.gateway.nativeReadiness = async () => ({ [THREAD_OPERATION]: false }) },
    h => { h.routes[0].mode = 'priority'; h.routes[0].fallback_provider = 'rapidapi' },
    h => { h.legacyCall.billed = null }, h => { h.legacyCall.id = '00000000-0000-0000-0000-000000000000' }]) {
    const h = await harness(); mutate(h)
    const result = await h.run()
    assert.ok(result.errorCode)
    assert.equal(h.http.length, 0)
  }
})

test('foreign historical provider evidence never renews allowance or dispatches again', async () => {
  const h = await harness(); await h.run(); h.corruptCallOwner()
  const result = await h.run()
  assert.equal(result.errorCode, 'receipt_owner_mismatch')
  assert.equal(h.http.length, 2)
})

test('existing page limits reduce the probe count and rejected response bytes remain verifiable', async () => {
  const limited = await harness(); limited.owner.page_size = 5
  const report = await limited.run()
  assert.equal(report.errorCode, undefined, JSON.stringify(report))
  assert.equal(report.pageSize, 5)
  assert.ok([...limited.store.requests.values()].every(row => row.acquisitionRequest.body.count === 5))
  const rejected = await harness({ rejectAt: 1 }), failure = await rejected.run()
  assert.equal(rejected.http.length, 1)
  assert.equal(failure.savedStages[3].providerCalls[0].archiveState, 'verified')
  assert.equal(failure.savedStages[3].providerCalls[0].hashVerified, true)
  assert.doesNotMatch(JSON.stringify(failure), /Private supplier refusal/u)
})

test('real RapidAPI 404 failure settlement commits the immutable Hub 502 receipt with zero delivered units', async () => {
  const h = await harness({ rejectAt: 1, rejectedStatus: 404, rejectedHeaders: { 'x-rapidapi-proxy-response': 'true' },
    rejectedBody: { message: "Endpoint '/tweet/100' does not exist" } })
  const idempotencyKey = 'offline-rapid-404-lifecycle'
  await assert.rejects(h.gateway.postComments(h.context, { platform: 'twitter', idempotencyKey,
    path: '/api/v1/data/social/post-comments', body: { platform: 'twitter', postId: '100', count: 100, includeRaw: false } }),
  { code: 'external_platform_rejected' })
  const saved = await h.store.getUsageRequestByIdempotencyKey(h.context.consumer.id, idempotencyKey)
  assert.equal(saved.status, 'committed', 'a definitive Rapid refusal commits its replayable error, independent of supplier billing')
  assert.equal(saved.responseStatus, 502)
  assert.equal(saved.unitsActual, 0)
  assert.equal(saved.responseBody.error.code, 'external_platform_rejected')
  assert.equal(h.legacyRequest.status, saved.status, 'the historical fixture must follow the real failure lifecycle')
  const calls = [...h.platformStore.calls.values()]
  assert.equal(calls.length, 1)
  assert.equal(calls[0].usageRequestId, saved.id)
  assert.equal(calls[0].outcome, 'rejected')
  assert.equal(calls[0].httpStatus, 404)
  assert.equal(calls[0].billed, false)
  assert.ok(h.platformStore.restrictedResponseArchives.has(calls[0].id))
  await assert.rejects(h.gateway.postComments(h.context, { platform: 'twitter', idempotencyKey,
    path: '/api/v1/data/social/post-comments', body: { platform: 'twitter', postId: '100', count: 100, includeRaw: false } }),
  { code: 'external_platform_rejected' })
  assert.equal(h.http.length, 1, 'the committed 502 replays without another supplier request')
})

test('one stage cannot dispatch twice even if an installed adapter attempts an automatic retry', async () => {
  const h = await harness(), original = h.adapter.forwardNative
  h.adapter.forwardNative = async function (...args) {
    await original.apply(this, args)
    return original.apply(this, args)
  }
  const result = await h.run()
  assert.equal(h.http.length, 1)
  assert.ok(result.errorCode)
  await h.run()
  assert.equal(h.http.length, 1)
})

test('saved 404 error diagnosis distinguishes a missing route without replaying the paid request or disclosing message values', async () => {
  const h = await harness(), before = structuredClone(h.legacyRequest)
  const report = await h.preview()
  assert.equal(report.mode, 'read_saved_only')
  assert.equal(report.supplierHttpCallsMade, 0)
  assert.equal(report.savedErrorInspectionVersion, 1)
  assert.equal(h.http.length, 0)
  assert.equal(report.stages[0].usageStatus, 'committed')
  assert.equal(report.resumeSourceInspection.usageStatus, 'committed')
  assert.equal(report.resumeSourceInspection.usageHttpStatus, 502)
  assert.equal(report.resumeSourceInspection.checks.usageCommitted, true)
  const call = report.stages[0].providerCalls[0]
  assert.equal(call.hashVerified, true)
  assert.equal(call.billed, false, 'the saved billing observation is preserved independently of status')
  assert.deepEqual(call.errorInspection, { category: 'endpoint_path_not_found', messageFields: ['message'],
    signals: [{ field: 'message', category: 'endpoint_path_not_found', pathTemplate: '/tweet/{tweetId}/replies',
      matchesRequestedRepliesPath: true }] })
  assert.deepEqual(h.legacyRequest, before, 'read-only inspection preserves immutable failure receipts')
  assert.doesNotMatch(JSON.stringify(report), /\/tweet\/100|synthetic-probe-provider-credential|Private author/u)
  assert.ok(report.stages.slice(1).every(row => row.state === 'not_attempted'))
  assert.equal((await h.run({ resumeThread: false })).mode, 'read_saved_only', 'old --execute never authorizes the second attempt')
  assert.equal(h.http.length, 0)
})

test('resume requires the exact known failed attempt and fixed archive digest; no CLI option bypasses this guard', async () => {
  const h = await harness(), report = await h.preview()
  const saved = { rows: [structuredClone(h.legacyRequest)], calls: [structuredClone(h.legacyCall)] }
  const stages = structuredClone(report.stages)
  const receipt = stages[0].providerCalls[0]
  receipt.sha256 = RESUME_SOURCE.sha256; receipt.bodySize = RESUME_SOURCE.bodySize
  assert.doesNotThrow(() => assertThreadResumeEvidence(saved, stages))
  const accepted = inspectThreadResumeEvidence(saved, stages)
  assert.equal(accepted.verified, true)
  assert.equal(accepted.usageStatus, 'committed')
  assert.deepEqual(accepted.failedChecks, [])
  for (const status of ['released', 'reserved', 'unknown']) {
    const candidate = structuredClone(saved); candidate.rows[0].status = status
    const inspection = inspectThreadResumeEvidence(candidate, stages)
    assert.equal(inspection.verified, false)
    assert.equal(inspection.usageStatus, status)
    assert.deepEqual(inspection.failedChecks, ['usageCommitted'])
    assert.equal(inspection.checks.usageCommitted, false)
    assert.throws(() => assertThreadResumeEvidence(candidate, stages), { code: 'resume_source_unverified' })
    h.legacyRequest.status = status
    const preflight = await h.resumePreview()
    assert.equal(preflight.errorCode, 'resume_source_unverified')
    assert.equal(preflight.resumeSourceInspection.usageStatus, status)
    assert.ok(preflight.resumeSourceInspection.failedChecks.includes('usageCommitted'))
    assert.equal(h.http.length, 0)
  }
  h.legacyRequest.status = 'committed'
  for (const mutate of [value => { value.saved.rows[0].id = SOURCE_REQUEST_ID },
    value => { value.saved.rows[0].status = 'unknown' }, value => { value.saved.rows[0].response_status = 200 },
    value => { value.saved.rows.push({ ...value.saved.rows[0], idempotency_key: KEYS[1] }) },
    value => { value.saved.calls[0].billed = true }, value => { value.saved.calls[0].billed = null },
    value => { value.saved.calls[0].http_status = 403 }, value => { value.saved.calls[0].operation = THREAD_OPERATION },
    value => { value.stages[0].providerCalls[0].sha256 = '0'.repeat(64) },
    value => { value.stages[0].providerCalls[0].hashVerified = false },
    value => { value.stages[0].providerCalls[0].errorInspection.signals[0].matchesRequestedRepliesPath = false }]) {
    const candidate = structuredClone({ saved, stages }); mutate(candidate)
    assert.throws(() => assertThreadResumeEvidence(candidate.saved, candidate.stages), { code: 'resume_source_unverified' })
  }
  const realGuard = await h.resumePreview({ resumeEvidenceCheck: assertThreadResumeEvidence })
  assert.equal(realGuard.errorCode, 'resume_source_unverified', 'synthetic bytes cannot pass the production archive fingerprint')
  assert.equal(h.http.length, 0)
  const privateEvidence = structuredClone({ saved, stages })
  privateEvidence.saved.rows[0].status = secret
  privateEvidence.saved.rows[0].acquisition_request.body.postId = '99999999999999999999'
  privateEvidence.saved.calls[0].endpoint_key = secret
  const privateInspection = inspectThreadResumeEvidence(privateEvidence.saved, privateEvidence.stages)
  assert.equal(privateInspection.verified, false)
  assert.equal(privateInspection.usageStatus, 'other')
  assert.ok(privateInspection.failedChecks.every(key => privateInspection.checks[key] === false))
  assert.doesNotMatch(JSON.stringify(privateInspection), /synthetic-probe-provider-credential|99999999999999999999|\/tweet\/100/u)
})

test('resume preview remains read-only and incomplete thread intents permanently block additional procurement', async () => {
  const h = await harness(), result = await h.resumePreview()
  assert.equal(result.mode, 'resume_thread_preview')
  assert.equal(result.readyForExecute, true)
  assert.equal(result.savedProviderCalls, 1)
  assert.equal(result.remainingSupplierCalls, 2)
  assert.equal(result.upstreamContinuationVerified, false)
  assert.equal(h.ownerLookups(), 0)
  assert.equal((await h.resumePreview({ installed: false })).errorCode, 'needs_deploy')
  assert.equal(h.http.length, 0)
  h.store.requests.set('unused', { id: '33333333-3333-3333-3333-333333333333',
    tenantId: h.source.tenant_id, consumerId: h.source.consumer_id, apiKeyId: h.source.api_key_id,
    platform: 'twitter', idempotencyKey: THREAD_KEYS[0], status: 'released', responseStatus: 503,
    acquisitionRequest: structuredClone(h.legacyRequest.acquisition_request) })
  assert.equal((await h.resumePreview()).mode, 'read_saved_only')
  assert.equal((await h.run()).mode, 'read_saved_only')
  assert.equal(h.http.length, 0, 'an admitted but undispatched intent cannot be repurchased on rerun')
})

test('error inspection classifies bounded known phrases and never guesses from HTTP status or arbitrary supplier text', () => {
  assert.equal(inspectRapidCommentError({ message: 'Tweet not found' }, '100').category, 'tweet_unavailable')
  assert.equal(inspectRapidCommentError({ error: { message: 'You are not subscribed to this API.' } }, '100').category, 'subscription_required')
  const wrong = inspectRapidCommentError({ message: "Endpoint '/tweet/999/replies' does not exist" }, '100')
  assert.equal(wrong.signals[0].matchesRequestedRepliesPath, false)
  assert.equal(inspectRapidCommentError({ message: 'Tweet not found', error: "Endpoint '/tweet/100/replies' does not exist" }, '100').category, 'conflicting_signals')
  for (const payload of [{ message: secret }, { message: 'not found' }, { message: 'x'.repeat(1025) }, { token: secret }]) {
    const summary = inspectRapidCommentError(payload, '100')
    assert.equal(summary.category, 'unclassified')
    assert.doesNotMatch(JSON.stringify(summary), /synthetic-probe-provider-credential/u)
  }
})

test('actual PostgreSQL preview SQL intersects consumer grants and Key snapshots and respects both page limits', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control; CREATE SCHEMA external_platform;
    CREATE TABLE usage_requests(id uuid,tenant_id uuid,consumer_id uuid,api_key_id uuid,platform text,status text,response_status int,
      acquisition_request jsonb,response_body jsonb,idempotency_key text);
    CREATE TABLE external_platform.provider_calls(id uuid,usage_request_id uuid,tenant_id uuid,consumer_id uuid,api_key_id uuid,
      provider_key text,operation text,endpoint_key text,marketplace text,outcome text,http_status int,billed boolean,contract_version text,call_ordinal int);
    CREATE TABLE control.external_platform_restricted_raw_responses(provider_call_id uuid,body_size int,body_sha256 text,body_bytes bytea);
    CREATE TABLE api_keys(id uuid,tenant_id uuid,consumer_id uuid,environment text,status text,expires_at timestamptz,scope_mode text);
    CREATE TABLE consumers(id uuid,status text); CREATE TABLE tenants(id uuid,status text);
    CREATE TABLE platform_grants(consumer_id uuid,platform text); CREATE TABLE capability_grants(consumer_id uuid,capability text);
    CREATE TABLE api_key_platform_entitlements(api_key_id uuid,platform text,max_page_size int);
    CREATE TABLE api_key_capability_entitlements(api_key_id uuid,capability text);
    CREATE TABLE consumer_platform_policies(consumer_id uuid,platform text,max_page_size int);
    CREATE TABLE control.strategy_search_routes(interface_key text,platform text,mode text,primary_provider text,fallback_provider text,revision int);`)
  const h = await harness(), source = h.source, call = h.sourceCall, raw = h.sourceArchive
  await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL)',
    [source.id,source.tenant_id,source.consumer_id,source.api_key_id,source.platform,source.status,source.response_status,JSON.stringify(source.acquisition_request)])
  await db.query('INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0)',
    [call.id,source.id,call.tenant_id,call.consumer_id,call.api_key_id,call.provider_key,call.operation,call.endpoint_key,call.marketplace,
      call.outcome,call.http_status,call.billed,call.contract_version])
  await db.query('INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,$3,$4)', [call.id,raw.body_size,raw.body_sha256,raw.body_bytes])
  await db.query("INSERT INTO api_keys VALUES($1,$2,$3,'live','active','2100-01-01','snapshot')", [source.api_key_id,source.tenant_id,source.consumer_id])
  await db.query("INSERT INTO consumers VALUES($1,'active')", [source.consumer_id])
  await db.query("INSERT INTO tenants VALUES($1,'active')", [source.tenant_id])
  await db.query("INSERT INTO platform_grants VALUES($1,'twitter')", [source.consumer_id])
  await db.query("INSERT INTO capability_grants VALUES($1,'social.comments.list')", [source.consumer_id])
  await db.query("INSERT INTO api_key_platform_entitlements VALUES($1,'twitter',12)", [source.api_key_id])
  await db.query("INSERT INTO api_key_capability_entitlements VALUES($1,'social.comments.list')", [source.api_key_id])
  await db.query("INSERT INTO consumer_platform_policies VALUES($1,'twitter',20)", [source.consumer_id])
  const pool = { connect: async () => ({ query: db.query.bind(db), release() {} }) }
  const preview = () => previewRapidComments({ pool, installed: true, readiness: async () => ({ ready: true }) })
  const result = await preview()
  assert.equal(result.errorCode, undefined, JSON.stringify(result))
  assert.equal(result.pageSize, 12)
  await db.exec("UPDATE consumer_platform_policies SET max_page_size=5")
  assert.equal((await preview()).pageSize, 5)
  await db.exec('DELETE FROM platform_grants')
  assert.equal((await preview()).errorCode, 'original_grants_unavailable', 'a retained snapshot cannot restore a revoked consumer grant')
  await db.query("INSERT INTO platform_grants VALUES($1,'twitter')", [source.consumer_id])
  await db.exec('DELETE FROM capability_grants')
  assert.equal((await preview()).errorCode, 'original_grants_unavailable')
  await db.query("INSERT INTO capability_grants VALUES($1,'social.comments.list')", [source.consumer_id])
  const old = h.legacyRequest, oldCall = h.legacyCall, oldRaw = h.legacyArchive
  await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)',
    [old.id,old.tenant_id,old.consumer_id,old.api_key_id,old.platform,old.status,old.response_status,
      JSON.stringify(old.acquisition_request),old.idempotency_key])
  await db.query('INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0)',
    [oldCall.id,old.id,oldCall.tenant_id,oldCall.consumer_id,oldCall.api_key_id,oldCall.provider_key,oldCall.operation,
      oldCall.endpoint_key,oldCall.marketplace,oldCall.outcome,oldCall.http_status,oldCall.billed,oldCall.contract_version])
  await db.query('INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,$3,$4)',
    [oldCall.id,oldRaw.body_size,oldRaw.body_sha256,oldRaw.body_bytes])
  await db.exec(`INSERT INTO control.strategy_search_routes VALUES
    ('post-comments','twitter','fixed','tikhub',NULL,3),('comment-replies','twitter','fixed','tikhub',NULL,3)`)
  const saved = await preview()
  assert.equal(saved.mode, 'read_saved_only')
  assert.equal(saved.savedProviderCalls, 1)
  assert.equal(saved.stages[0].providerCalls[0].billed, false)
  assert.equal(saved.stages[0].providerCalls[0].hashVerified, true)
  const resumePreview = () => previewRapidComments({ pool, installed: true, readiness: async () => ({ ready: true }),
    resumeThread: true, resumeEvidenceCheck: h.resumeEvidenceCheck })
  assert.equal((await resumePreview()).readyForExecute, true)
  await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)',
    ['33333333-3333-3333-3333-333333333333',old.tenant_id,old.consumer_id,old.api_key_id,old.platform,'released',503,
      JSON.stringify(old.acquisition_request),THREAD_KEYS[0]])
  const interrupted = await resumePreview()
  assert.equal(interrupted.mode, 'read_saved_only')
  assert.equal(interrupted.stages[3].state, 'saved_failure_or_pending')
  assert.deepEqual(interrupted.stages[3].providerCalls, [])
  assert.equal(h.http.length, 0)
})
