import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { ContentSearchStateStore } from '../../server/external-platforms/content-search-store.mjs'
import { DispatchQueue } from '../../server/external-platforms/dispatch-queue.mjs'
import { pinTwitterSearchFallback, assertTwitterSearchFallback } from '../../server/external-platforms/twitter-search-fallback.mjs'
import { normalizeTikHubContentSearchRequest, TIKHUB_CONTENT_SEARCH_VERSION } from '../../server/contracts/tikhub-content-search.mjs'
import { projectContentPage } from '../../server/external-platforms/content-search-workflow.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { createTwitterSearchRouter } from '../../server/data/twitter-search-routing.mjs'
import { runTwitterSearchFill } from '../../server/external-platforms/twitter-search-fill.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for real PostgreSQL fallback settlement' }
const digest = value => createHash('sha256').update(value).digest('hex')
const twitterBusyRetryScope = digest('rapidapi:twitter-aio.search:busy-retry')

async function assertRetryQueueReleased(db, backoffMs) {
  const result = await db.query(`SELECT scope, state->'active'->>'id' AS active_id, state->'queue' AS waiting,
      (state->'busyBackoff'->>'delayMs')::int AS backoff_ms
    FROM external_platform.dispatch_queues`)
  assert.deepEqual(result.rows, [{ scope: twitterBusyRetryScope, active_id: null, waiting: [], backoff_ms: backoffMs }])
}

async function reservedTwitterSearch(t, enforcementMode = 'enforced') {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY); CREATE SCHEMA control; CREATE SCHEMA billing;')
  for (const migration of ['001_initial.sql', '004_reservation_lease.sql', '051_external_platform_gateway.sql',
    '053_external_platform_uncertain_retry.sql', '055_external_platform_multi_call_rate_limit.sql',
    '057_external_platform_cost_reservations.sql', '058_external_platform_restricted_raw_responses.sql',
    '071_contract_circuit_scopes.sql', '094_acquisition_request_snapshot.sql', '107_external_dispatch_queue.sql', '138_admission_recovery.sql',
    '163_provider_cost_ledger.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  await db.exec(`ALTER TABLE usage_requests ADD COLUMN delivery_source_mode text, ADD COLUMN response_captured_at timestamptz,
      ADD COLUMN billing_meter_key text DEFAULT 'twitter';
    CREATE TABLE usage_idempotency_bindings(consumer_id uuid,idempotency_key text,current_request_id uuid,PRIMARY KEY(consumer_id,idempotency_key));
    CREATE TABLE billing.customer_charges(id uuid,usage_request_id uuid,tenant_id uuid,account_id uuid,status text,
      consumer_id uuid,api_key_id uuid,meter_key text,billing_unit text,
      enforcement_mode text,quoted_minor int,currency text,charged_minor int,settled_at timestamptz);
    CREATE TABLE billing.credit_ledger_entries(account_id uuid,tenant_id uuid,charge_id uuid,usage_request_id uuid,
      kind text,amount_minor int,available_delta_minor int,held_delta_minor int,currency text,idempotency_key text UNIQUE,actor text,reason text);`)
  // Run the production customer settlement trigger, not a fixture imitation.
  const billing = await readFile(new URL('../../migrations/056_commercial_billing_ledger.sql', import.meta.url), 'utf8')
  const trigger = billing.match(/CREATE OR REPLACE FUNCTION billing\.settle_customer_charge\(\)[\s\S]*?EXECUTE FUNCTION billing\.settle_customer_charge\(\);/u)?.[0]
  assert.ok(trigger); await db.exec(trigger)
  // node-postgres returns bytea as Buffer; PGlite exposes Uint8Array. Mirror the
  // production driver's binary representation without changing SQL behavior.
  const query = async (sql, args) => {
    const result = await db.query(sql, args)
    result.rows = result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, value instanceof Uint8Array ? Buffer.from(value) : value])))
    return result
  }
  const pool = { query, connect: async () => ({ query, release() {} }) }
  const usageStore = new PostgresStore(pool)
  const rapid = new PostgresExternalPlatformStore({ pool, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
  const tik = new PostgresExternalPlatformStore({ pool, providerKey: 'tikhub', authorizationPlatform: 'twitter' })
  const context = { tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } }
  const body = { platform: 'twitter', query: '("外交" OR "diplomacy") AND "update" -ad', pageSize: 1, type: 'stable' }
  const snapshot = { method: 'POST', path: '/api/v1/data/search', body }
  const delivery = { tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
    usageRequestId: randomUUID(), fingerprint: requestFingerprint(snapshot), operation: 'social.content.search' }
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Fixture')", [delivery.tenantId])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Fixture',$3)", [delivery.consumerId, delivery.tenantId, randomUUID()])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Fixture',$4,'fixture','0000')",
    [delivery.apiKeyId, delivery.tenantId, delivery.consumerId, 'a'.repeat(64)])
  await db.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,acquisition_request,lease_expires_at)
    VALUES($1,$2,$3,$4,'same-customer-key',$5,'twitter','reserved',$6,now()+interval '2 minutes')`,
  [delivery.usageRequestId, delivery.tenantId, delivery.consumerId, delivery.apiKeyId, delivery.fingerprint, JSON.stringify(snapshot)])
  await db.query('INSERT INTO usage_idempotency_bindings VALUES($1,$2,$3)', [delivery.consumerId, 'same-customer-key', delivery.usageRequestId])
  const chargeId = randomUUID(), accountId = randomUUID()
  await db.query(`INSERT INTO billing.customer_charges(id,usage_request_id,tenant_id,account_id,status,enforcement_mode,quoted_minor,currency,
    consumer_id,api_key_id,meter_key,billing_unit)
    VALUES($1,$2,$3,$4,'reserved',$7,9,'CNY',$5,$6,'twitter','request')`,
  [chargeId, delivery.usageRequestId, delivery.tenantId, accountId, delivery.consumerId, delivery.apiKeyId, enforcementMode])
  if (enforcementMode === 'enforced') await db.query(`INSERT INTO billing.credit_ledger_entries(account_id,tenant_id,charge_id,usage_request_id,kind,amount_minor,
    available_delta_minor,held_delta_minor,currency,idempotency_key) VALUES($1,$2,$3,$4,'hold',9,-9,9,'CNY','fixture-hold')`,
  [accountId, delivery.tenantId, chargeId, delivery.usageRequestId])
  const cost = { costMinor: 1, costKind: 'estimated', currency: 'CNY', monthlyBudgetMinor: 1000, monthlySubsidyBudgetMinor: 1000 }
  const codec = createDataSearchCursorCodec('offline-fallback', `${delivery.consumerId}:${delivery.apiKeyId}`)
  const request = normalizeHubDataSearch(body, codec, 'stable')
  return { db, usageStore, rapid, tik, context, body, delivery, cost, request }
}

function runRapidSearch({ usageStore, rapid, context, delivery, cost, request }, fetchImpl) {
  const adapter = new RapidApiAdapter({ apiKey: 'fixture-only', fetchImpl })
  return runTwitterSearchFill({
    gateway: { platformStore: rapid, usageStore, adapter, config: { timeoutMs: 100, maxRequestsPerMinute: 90 },
      operationControlStore: { authorizeDispatch: async () => null } },
    context, delivery, request, deadlineAt: Date.now() + 120000, revalidateIdentity: async () => context,
    resolveCredential: async () => ({ ready: true, credential: 'fixture-only' }),
    providerCostControl: () => cost, enterCapacity: async () => true, leaveCapacity() {},
  })
}

for (const status of [409, 503]) test(`standard Twitter settles a RapidAPI HTTP ${status} with a textual business code in PostgreSQL`, options, async t => {
  const f = await reservedTwitterSearch(t), { db, usageStore, delivery } = f
  let calls = 0
  const payload = { code: 'SUPPLIER_CONFLICT' }
  const rejected = status < 500
  await assert.rejects(runRapidSearch(f, async () => {
    calls++
    return Response.json(payload, { status })
  }), { status: 502, code: rejected ? 'social_upstream_rejected' : 'social_upstream_outcome_unknown' })
  assert.equal(calls, 1)
  const receipt = await db.query(`SELECT c.http_status, c.outcome, c.business_code, c.billed, r.body_bytes
    FROM external_platform.provider_calls c
    JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = c.id`)
  assert.deepEqual(receipt.rows.map(row => ({ ...row, body_bytes: Buffer.from(row.body_bytes).toString() })),
    [{ http_status: status, outcome: rejected ? 'rejected' : 'unknown', business_code: null, billed: null, body_bytes: JSON.stringify(payload) }])
  const saved = await usageStore.getUsageRequestByIdempotencyKey(delivery.consumerId, 'same-customer-key')
  assert.equal(saved.status, rejected ? 'committed' : 'unknown')
  if (rejected) {
    assert.equal(saved.responseStatus, 502)
    assert.equal(saved.responseBody.error.details.upstreamStatus, 409)
  }
})

const busyPayload = { code: 'busy', error: 'TWI-BUSY - Temporarily unavailable. You were not charged, please retry in a few seconds.' }
const busyRejection = error => error.status === 502 && error.code === 'social_upstream_rejected'
  && error.details?.reasonCode === 'upstream_service_busy' && error.details?.retryable === false

test('two PostgreSQL queue instances cannot dispatch Twitter busy retries concurrently', options, async t => {
  const { rapid } = await reservedTwitterSearch(t)
  const firstWorker = new DispatchQueue({ pool: rapid.pool })
  const secondWorker = new DispatchQueue({ pool: rapid.pool })
  // Zero spacing isolates the active-ticket guard from the spacing guard.
  const policy = { intervalMs: 0, jitterMs: 0, maxPending: 1 }
  const input = { scope: twitterBusyRetryScope, deadline: Date.now() + 60000, leaseMs: 30000, policy }
  const firstId = randomUUID(), secondId = randomUUID()
  const first = await firstWorker.enter({ ...input, id: firstId, fingerprint: digest(firstId) })
  const second = { ...input, id: secondId, fingerprint: digest(secondId), jitterMs: 0 }
  assert.equal((await secondWorker.transition(second.scope, { ...second, type: 'join' })).kind, 'queued')
  assert.equal((await secondWorker.transition(second.scope, { ...second, type: 'claim' })).kind, 'wait')
  await firstWorker.finish(first, 'succeeded')
  assert.equal((await secondWorker.transition(second.scope, { ...second, type: 'claim' })).kind, 'acquired')
  await secondWorker.finish(second, 'succeeded')
})

test('PostgreSQL archives two RapidAPI busy receipts and captures one customer charge', options, async t => {
  const f = await reservedTwitterSearch(t), { db, delivery } = f
  let attempts = 0, stateBeforeSecondReply, activeRetry
  await assert.rejects(runRapidSearch(f, async () => {
    attempts++
    if (attempts === 2) {
      const { rows } = await db.query(`SELECT state->'active'->>'id' AS active_id
        FROM external_platform.dispatch_queues WHERE scope=$1`, [twitterBusyRetryScope])
      activeRetry = rows
      const first = await db.query(`SELECT c.outcome, r.body_sha256, u.status AS usage, ch.status AS charge
        FROM external_platform.provider_calls c
        JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
        JOIN usage_requests u ON u.id=c.usage_request_id
        JOIN billing.customer_charges ch ON ch.usage_request_id=u.id
        WHERE c.call_ordinal=0`)
      stateBeforeSecondReply = first.rows
    }
    return Response.json(busyPayload, { status: 409, headers: { 'x-rapidapi-request-id': 'busy-' + attempts } })
  }), busyRejection)

  const hash = digest(JSON.stringify(busyPayload))
  assert.equal(attempts, 2)
  assert.deepEqual(activeRetry, [{ active_id: delivery.usageRequestId }])
  await assertRetryQueueReleased(db, 6000)
  assert.deepEqual(stateBeforeSecondReply, [{ outcome: 'rejected', body_sha256: hash, usage: 'reserved', charge: 'reserved' }])
  const receipts = await db.query(`SELECT c.usage_request_id, c.call_ordinal, c.call_role, c.upstream_request_id, c.http_status,
    c.outcome, c.error_code, c.business_code, c.billed, c.cost_minor::int, c.cost_kind,
    a.payload_sha256, r.body_sha256, r.parsed_payload
    FROM external_platform.provider_calls c
    JOIN external_platform.response_archives a ON a.provider_call_id=c.id
    JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
    WHERE c.provider_key='rapidapi' ORDER BY c.call_ordinal`)
  assert.deepEqual(receipts.rows, [0, 1].map(i => ({ usage_request_id: delivery.usageRequestId, call_ordinal: i,
    call_role: i === 0 ? 'primary' : 'retry', upstream_request_id: 'busy-' + (i + 1), http_status: 409,
    outcome: 'rejected', error_code: 'upstream_service_busy', business_code: null, billed: null, cost_minor: 1,
    cost_kind: 'estimated', payload_sha256: hash, body_sha256: hash, parsed_payload: busyPayload })))
  const holds = await db.query(`SELECT base_cost_minor::int AS base, reserved_cost_minor::int AS reserved, status
    FROM external_platform.provider_cost_reservations WHERE usage_request_id=$1 ORDER BY base_cost_minor`, [delivery.usageRequestId])
  assert.deepEqual(holds.rows, [{ base: 0, reserved: 1, status: 'released' }, { base: 1, reserved: 1, status: 'released' }])
  const saved = await f.usageStore.getUsageRequestByIdempotencyKey(delivery.consumerId, 'same-customer-key')
  assert.equal(saved.id, delivery.usageRequestId)
  assert.equal(saved.status, 'committed')
  assert.equal(saved.responseBody.error.code, 'social_upstream_rejected')
  assert.equal(saved.responseBody.error.details.reasonCode, 'upstream_service_busy')
  assert.deepEqual((await db.query('SELECT status, charged_minor FROM billing.customer_charges')).rows,
    [{ status: 'captured', charged_minor: 9 }])
  assert.deepEqual((await db.query('SELECT kind, amount_minor FROM billing.credit_ledger_entries ORDER BY kind')).rows,
    [{ kind: 'capture', amount_minor: 9 }, { kind: 'hold', amount_minor: 9 }])
})

test('PostgreSQL saves the original busy response if the retry exceeds the procurement budget', options, async t => {
  // An enforced customer hold exempts the request from the supplier budget.
  const f = await reservedTwitterSearch(t, 'shadow'), { db, delivery } = f
  f.cost.monthlyBudgetMinor = f.cost.costMinor
  const reserve = f.rapid.reserveProviderCostWorkflow.bind(f.rapid), declined = []
  f.rapid.reserveProviderCostWorkflow = async input => {
    try { return await reserve(input) }
    catch (error) { declined.push(error.code); throw error }
  }
  let attempts = 0
  await assert.rejects(runRapidSearch(f, async () => {
    attempts++
    return Response.json(busyPayload, { status: 409 })
  }), busyRejection)
  assert.equal(attempts, 1)
  assert.deepEqual(declined, ['external_platform_cost_budget_exhausted'])
  await assertRetryQueueReleased(db, null)
  const reservation = await db.query(`SELECT id, status, error_code, delivery_source_mode, response_status,
      response_body->'error'->'details'->>'reasonCode' AS reason
    FROM usage_requests`)
  assert.deepEqual(reservation.rows, [{ id: delivery.usageRequestId, status: 'committed', error_code: 'upstream_service_busy',
    delivery_source_mode: 'live', response_status: 502, reason: 'upstream_service_busy' }])
  assert.deepEqual((await db.query('SELECT outcome, error_code FROM external_platform.provider_calls')).rows,
    [{ outcome: 'rejected', error_code: 'upstream_service_busy' }])
  assert.deepEqual((await db.query('SELECT status FROM external_platform.provider_cost_reservations')).rows,
    [{ status: 'released' }])
  assert.deepEqual((await db.query('SELECT status, charged_minor FROM billing.customer_charges')).rows,
    [{ status: 'captured', charged_minor: 0 }])
})

test('PostgreSQL actual supplier stores share one reservation, preserve both receipts, use global ordinal1, settle once and replay TikHub', options, async t => {
  const { db, usageStore, rapid, tik, context, body, delivery, cost, request } = await reservedTwitterSearch(t)
  const lease = { ...delivery, ownerRequestId: delivery.usageRequestId, expiresAt: new Date(Date.now() + 120000) }
  assert.equal((await rapid.acquireTwitterFillDeliveryLease(lease)).kind, 'acquired')
  const costReservation = await rapid.reserveProviderCostWorkflow({ ...delivery, costControls: [cost] })
  const rapidCall = await rapid.beginProviderCall({ ...delivery, contractVersion: request.providerRequest.endpointContractVersion,
    endpointKey: request.providerRequest.endpointKey, endpointVersion: request.providerRequest.endpointVersion, marketplace: 'twitter',
    callOrdinal: 0, costControl: cost, costReservationId: costReservation.id })
  let rapidCalls = 0, tikCalls = 0
  const rapidAdapter = new RapidApiAdapter({ apiKey: 'synthetic', fetchImpl: async () => { rapidCalls++; return Response.json({ message: '400, bad request' }, { status: 400 }) } })
  let rejection
  try { await rapidAdapter.execute(request.providerRequest) } catch (error) { rejection = error }
  assert.equal(rejection?.evidence?.outcome, 'rejected'); assert.equal(rejection.evidence.httpStatus, 400)
  await rapid.finishProviderStep({ callId: rapidCall.id, delivery, ...rejection.evidence, ...cost, latencyMs: 1,
    responseArchive: rejection.responseArchive, restrictedResponseArchive: rejection.restrictedResponseArchive,
    upstreamEvidence: rejection.upstreamEvidence, affectsCircuit: false })
  assert.equal((await db.query('SELECT status FROM usage_requests')).rows[0].status, 'reserved')
  assert.equal((await db.query("SELECT count(*)::int n FROM billing.credit_ledger_entries WHERE kind='capture'")).rows[0].n, 0)
  await rapid.releaseProviderCostWorkflow({ reservationId: costReservation.id, usageRequestId: delivery.usageRequestId })
  await pinTwitterSearchFallback({ usageStore, delivery, callId: rapidCall.id })
  await assertTwitterSearchFallback({ usageStore, delivery })
  const native = normalizeTikHubContentSearchRequest({ platform: 'twitter', query: body.query, pageSize: 1 })
  const tikDelivery = { ...delivery, operation: native.operation }
  const tikCost = await tik.reserveProviderCostWorkflow({ ...tikDelivery, costControls: [cost] })
  const callInput = { ...tikDelivery, contractVersion: native.endpointContractVersion, endpointKey: native.endpointKey,
    endpointVersion: native.endpointVersion, marketplace: 'twitter', costControl: cost, costReservationId: tikCost.id }
  await assert.rejects(tik.beginProviderCall({ ...callInput, callOrdinal: 0 }), { code: 'external_platform_call_exists' },
    'The real global ordinal constraint detects a cross-provider ordinal0 collision')
  await assert.rejects(tik.beginProviderCall({ ...callInput, apiKeyId: randomUUID(), callOrdinal: 1 }), { code: 'external_platform_usage_scope_mismatch' })
  const tikCall = await tik.beginProviderCall({ ...callInput, callOrdinal: 1, callRole: 'enrichment' })
  const tikAdapter = new TikHubAdapter({ apiKey: 'synthetic', fetchImpl: async () => { tikCalls++; return Response.json({ code: 200, data: {
    timeline: [1, 2].map(id => ({ tweet_id: String(id), text: `Fixture ${id}`, created_at: 'Sun Oct 18 05:00:00 +0000 2026',
      user_info: { rest_id: '1999999999999999999', screen_name: 'fixture' }, favorites: 0, replies: 0, retweets: 0, views: '1' })), next_cursor: 'native-next',
  } }) } })
  const response = await tikAdapter.forwardNative(native.recipeKey, { params: native.upstreamQuery }, { contentSearchProjection: true })
  const { projected } = projectContentPage(response, native)
  assert.equal(projected.acquiredItems.length, 2)
  await tik.finishProviderStep({ callId: tikCall.id, delivery: tikDelivery, outcome: 'succeeded', httpStatus: 200, businessCode: 200,
    billed: true, ...cost, latencyMs: 1, itemCount: 2, responseArchive: response.responseArchive,
    restrictedResponseArchive: response.restrictedResponseArchive, upstreamEvidence: response.upstreamEvidence, affectsCircuit: false })
  await tik.releaseProviderCostWorkflow({ reservationId: tikCost.id, usageRequestId: delivery.usageRequestId })
  const state = new ContentSearchStateStore(tik, native), scopeHash = 'b'.repeat(64), archive = response.restrictedResponseArchive
  const rowsHash = digest(JSON.stringify(projected.acquiredItems))
  const resultBody = { data: { platform: 'twitter', query: body.query, items: [projected.acquiredItems[0]], pageInfo: { hasMore: true } }, requestId: delivery.usageRequestId }
  const saved = { ...tikDelivery, path: '/api/v1/data/search', scopeHash, delivery: tikDelivery, responseBody: resultBody,
    capturedAt: archive.capturedAt, sourceMode: 'live', usageUnitsActual: 1,
    sources: [{ callId: tikCall.id, bodySize: archive.bodySize, bodySha256: archive.bodySha256, capturedAt: archive.capturedAt, rowsHash, own: true }],
    manifest: { version: TIKHUB_CONTENT_SEARCH_VERSION, scopeHash, previousDeliveryId: null, deliveredIds: [['1']], state: { jobs: [{
      query: body.query, providerCursor: null, providerPage: 1, upstreamPages: 1, started: true, done: false,
      buffer: { callId: tikCall.id, offset: 1, hash: rowsHash, providerCursor: null, providerPage: 1 },
    }] } } }
  await state.commitDelivery(saved)
  await assert.rejects(state.commitDelivery(saved), { code: 'search_page_unavailable' })
  assert.equal((await db.query("SELECT count(*)::int n FROM billing.credit_ledger_entries WHERE kind='capture'")).rows[0].n, 1)
  assert.deepEqual((await db.query('SELECT status,charged_minor FROM billing.customer_charges')).rows[0], { status: 'captured', charged_minor: 9 })
  const receipts = (await db.query('SELECT provider_key,call_ordinal,outcome,http_status,usage_request_id FROM external_platform.provider_calls ORDER BY call_ordinal')).rows
  assert.deepEqual(receipts.map(row => [row.provider_key, row.call_ordinal, row.outcome, row.http_status]),
    [['rapidapi', 0, 'rejected', 400], ['tikhub', 1, 'succeeded', 200]])
  assert.ok(receipts.every(row => row.usage_request_id === delivery.usageRequestId))
  assert.equal((await db.query("SELECT count(*)::int n FROM external_platform.provider_cost_reservations WHERE status='active'")).rows[0].n, 0)
  assert.equal((await db.query('SELECT count(*)::int n FROM control.external_platform_restricted_raw_responses')).rows[0].n, 2)
  const page = await state.pageFor({ ...tikDelivery, path: '/api/v1/data/search', scopeHash, callId: tikCall.id })
  assert.equal(page.bodySha256, archive.bodySha256, 'Paid continuation keeps the exact TikHub archive')
  const stored = await usageStore.getUsageRequestByIdempotencyKey(delivery.consumerId, 'same-customer-key')
  assert.deepEqual(stored.acquisitionRequest.body, body)
  assert.equal(stored.acquisitionRequest.contentSearch.state.jobs[0].buffer.offset, 1)
  const selected = []
  const router = createTwitterSearchRouter({ usageStore, apiKeyPepper: 'offline-fallback', provider: 'rapidapi',
    rapidGateway: { searchRaw() { selected.push('rapidapi'); throw new Error('Must replay saved TikHub delivery') } },
    tikHubGateway: { async searchContent() { selected.push('tikhub'); return stored.responseBody } } })
  assert.deepEqual(await router(context, { body, normalized: body, dataSearch: { resultType: 'stable' }, idempotencyKey: 'same-customer-key' }), resultBody)
  assert.deepEqual(selected, ['tikhub']); assert.deepEqual([rapidCalls, tikCalls], [1, 1])
  await rapid.releaseDispatchLease(lease)
})
