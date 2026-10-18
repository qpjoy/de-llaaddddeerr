import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { ContentSearchStateStore } from '../../server/external-platforms/content-search-store.mjs'
import { pinTwitterSearchFallback, assertTwitterSearchFallback } from '../../server/external-platforms/twitter-search-fallback.mjs'
import { normalizeTikHubContentSearchRequest, TIKHUB_CONTENT_SEARCH_VERSION } from '../../server/contracts/tikhub-content-search.mjs'
import { projectContentPage } from '../../server/external-platforms/content-search-workflow.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { createTwitterSearchRouter } from '../../server/data/twitter-search-routing.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for real PostgreSQL fallback settlement' }
const digest = value => createHash('sha256').update(value).digest('hex')

test('PostgreSQL actual supplier stores share one reservation, preserve both receipts, use global ordinal1, settle once and replay TikHub', options, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY); CREATE SCHEMA control; CREATE SCHEMA billing;')
  for (const migration of ['001_initial.sql', '004_reservation_lease.sql', '051_external_platform_gateway.sql',
    '053_external_platform_uncertain_retry.sql', '055_external_platform_multi_call_rate_limit.sql',
    '057_external_platform_cost_reservations.sql', '058_external_platform_restricted_raw_responses.sql',
    '071_contract_circuit_scopes.sql', '094_acquisition_request_snapshot.sql', '138_admission_recovery.sql']) {
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
    VALUES($1,$2,$3,$4,'reserved','enforced',9,'CNY',$5,$6,'twitter','request')`,
  [chargeId, delivery.usageRequestId, delivery.tenantId, accountId, delivery.consumerId, delivery.apiKeyId])
  await db.query(`INSERT INTO billing.credit_ledger_entries(account_id,tenant_id,charge_id,usage_request_id,kind,amount_minor,
    available_delta_minor,held_delta_minor,currency,idempotency_key) VALUES($1,$2,$3,$4,'hold',9,-9,9,'CNY','fixture-hold')`,
  [accountId, delivery.tenantId, chargeId, delivery.usageRequestId])
  const lease = { ...delivery, ownerRequestId: delivery.usageRequestId, expiresAt: new Date(Date.now() + 120000) }
  assert.equal((await rapid.acquireTwitterFillDeliveryLease(lease)).kind, 'acquired')
  const cost = { costMinor: 1, costKind: 'estimated', currency: 'CNY', monthlyBudgetMinor: 1000, monthlySubsidyBudgetMinor: 1000 }
  const costReservation = await rapid.reserveProviderCostWorkflow({ ...delivery, costControls: [cost] })
  const codec = createDataSearchCursorCodec('offline-fallback', `${delivery.consumerId}:${delivery.apiKeyId}`)
  const request = normalizeHubDataSearch(body, codec, 'stable')
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
