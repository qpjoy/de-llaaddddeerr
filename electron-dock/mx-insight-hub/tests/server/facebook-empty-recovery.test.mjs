import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createFacebookEmptyPageRecovery, FACEBOOK_EMPTY_PAGE_CASE, recoveryArguments } from '../../server/ops/recover-facebook-empty-page.mjs'
import { normalizeFacebookSearch, facebookJustOneArchives } from '../../server/contracts/facebook-search.mjs'
import { createJustOneCallArchiveObject } from '../../server/contracts/justone.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { createExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { FACEBOOK_ENDPOINT, FACEBOOK_OPERATION } from '../../server/contracts/facebook-search.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const at = '2026-10-17T05:26:40.016Z', reserved = '2026-10-17T05:26:36.132Z'
async function normalDelivery(service, context, body, payload) {
  const controls = createExternalPlatformControlStore({}), gateways = {}, calls = []
  for (const provider of ['rapidapi','justone']) {
    const endpointKey = provider === 'rapidapi' ? FACEBOOK_ENDPOINT : 'native.j.facebook_post_search_v1'
    const operation = provider === 'rapidapi' ? FACEBOOK_OPERATION.operationKey : endpointKey
    const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 1000,
      freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100 }
    const current = (await controls.describeProvider(provider, { config, credentialConfigured: true })).find(row => row.operationKey === operation)
    await controls.updatePolicy(provider, operation, { expectedRevision: current.revision, desiredState: 'active', reason: 'Offline recovery response comparison',
      priceBook: { currency: provider === 'rapidapi' ? 'USD' : 'CNY', pricingAsOf: at, monthlyBudgetMinor: 100000,
        monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpointKey]: provider === 'rapidapi' ? 0 : 1 } } },
    { runtime: { config, credentialConfigured: true } })
    const fetchImpl = async () => { calls.push(provider); assert.equal(provider, 'justone'); return Response.json(payload) }
    const adapter = provider === 'rapidapi' ? new RapidApiAdapter({ apiKey: 'offline', fetchImpl })
      : new JustOneAdapter({ token: 'offline', fetchImpl, logger: { warn() {}, error() {} } })
    const platformStore = new MemoryExternalPlatformStore({ usageStore: service.store, providerKey: provider, authorizationPlatform: 'facebook' })
    gateways[provider] = new ExternalPlatformGateway({ usageStore: service.store, platformStore, adapter, config, providerKey: provider,
      operationControlStore: controls, apiKeyPepper: 'offline-recovery-normalization-pepper', reservationLeaseMs: 120000, logger: { warn() {}, error() {} } })
  }
  service.externalDataSearch = (ctx, input) => gateways.rapidapi.searchFacebook(ctx, input,
    { policyStore: { facebook: async () => ({ mode: 'justone', revision: 1 }) }, fallbackGateway: gateways.justone })
  const result = await service.search(context, { body, idempotencyKey: 'offline-normal-delivery-0001', path: '/api/v1/data/search' })
  assert.deepEqual(calls, ['justone'])
  return result.body
}
async function fixture(t, { noCharge = false } = {}) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY)')
  for (const migration of ['001_initial.sql','004_reservation_lease.sql','018_public_capabilities.sql',
    '051_external_platform_gateway.sql','052_external_platform_credentials.sql','053_external_platform_uncertain_retry.sql',
    '054_api_key_entitlements_plans_and_tikhub.sql','055_external_platform_multi_call_rate_limit.sql',
    '056_commercial_billing_ledger.sql','057_external_platform_cost_reservations.sql','058_external_platform_restricted_raw_responses.sql',
    '094_acquisition_request_snapshot.sql','105_tenant_default_request_price.sql','157_facebook_empty_page_recovery.sql'])
    await db.exec(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'))
  // Exact usage additions from 031; avoid its unrelated connector dependencies.
  await db.exec("ALTER TABLE usage_requests ADD delivery_source_mode text CHECK(delivery_source_mode IN ('live','stale')), ADD response_captured_at timestamptz")
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), account = randomUUID()
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Recovery fixture')", [tenant])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1::uuid,$2,'Recovery fixture',$1::text)", [consumer,tenant])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Recovery fixture',$4,'fixture','0000')", [key,tenant,consumer,sha('key')])
  await db.query("INSERT INTO billing.tenant_billing_profiles(tenant_id,mode,default_unit_price_minor,default_currency) VALUES($1,'enforced',1,'CNY')", [tenant])
  await db.query("INSERT INTO billing.credit_accounts(id,tenant_id,currency) VALUES($1,$2,'CNY')", [account,tenant])
  await db.query(`INSERT INTO billing.credit_ledger_entries(account_id,tenant_id,kind,amount_minor,available_delta_minor,held_delta_minor,currency,idempotency_key,actor,reason)
    VALUES($1,$2,'topup',100,100,0,'CNY','offline-topup','test','Synthetic initial funds')`, [account,tenant])
  if (noCharge) await db.query("UPDATE billing.tenant_billing_profiles SET mode='disabled',revision=revision+1 WHERE tenant_id=$1", [tenant])
  const body = { platform: 'facebook', query: '  private fixture query  ', pageSize: 20 }
  // The actual public service normalizes a Delta request with omitted type;
  // keep its raw body separately so tests cannot hide identity drift.
  const service = new HubService({ store: new MemoryStore(), adapter: {}, apiKeyPepper: 'offline-recovery-normalization-pepper' })
  const owner = await service.createTenant({ name: 'Normalization fixture' })
  const caller = await service.createConsumer({ tenantId: owner.id, name: 'Normalization fixture' })
  await service.putPlatformConfiguration('facebook', { tenantId: owner.id, consumerId: caller.id, enabled: true, maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 })
  const credential = await service.createApiKey({ consumerId: caller.id, name: 'Offline key', platforms: ['facebook'], capabilities: [] })
  let normalizedInput
  service.externalDataSearch = async (_context, input) => { normalizedInput = input; return {} }
  await service.search(await service.authenticate(credential.secret), { body, idempotencyKey: 'offline-normalization-0001', path: '/api/v1/data/search' })
  const normalizedRequest = normalizeFacebookSearch(normalizedInput.normalized, {}, normalizedInput.dataSearch, Date.parse(reserved))
  const acquisition = { method: 'POST', path: '/api/v1/data/search', body }
  const fingerprint = requestFingerprint({ ...acquisition, body: normalizedRequest.fingerprintBody }), requestId = randomUUID(), callId = randomUUID(), stepUuid = randomUUID()
  const idem = `delta-page-${stepUuid}-r0-p1-0123456789abcdef`
  // This INSERT really creates the immutable quote and hold via 105/056.
  await db.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,
    billing_meter_key,acquisition_request,reserved_at,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,'facebook','reserved','facebook',$7,$8,$8::timestamptz+interval '3 minutes')`,
  [requestId,tenant,consumer,key,idem,fingerprint,JSON.stringify(acquisition),reserved])
  await db.query(`INSERT INTO usage_idempotency_bindings(tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,current_request_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [tenant,consumer,key,idem,fingerprint,requestId])
  await db.query(`INSERT INTO external_platform.provider_calls(id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,
    operation,contract_version,endpoint_key,endpoint_version,marketplace,request_fingerprint,outcome,billed,cost_minor,cost_kind,currency,started_at,completed_at,latency_ms)
    VALUES($1,'justone',$2,$3,$4,$5,'native.j.facebook_post_search_v1','mx-insight-hub.native-forwarding.v1','native.j.facebook_post_search_v1',
    'night-all-source-snapshot.2026-09-26','facebook',$6,'unknown',true,1,'estimated','CNY',$7,$8,3605)`, [callId,tenant,consumer,key,requestId,fingerprint,reserved,at])
  await db.query("UPDATE usage_requests SET status='unknown',completed_at=$2 WHERE id=$1", [requestId,at])
  const payload = { code: 0, message: 'success', requestId: 'offline-upstream', recordTime: '2026-10-17', data: { results: [] } }
  const bytes = Buffer.from(JSON.stringify(payload).padEnd(153, ' ')), restrictedSha256 = sha(bytes)
  const request = normalizedRequest.forProvider('justone')
  const object = facebookJustOneArchives([createJustOneCallArchiveObject(payload, request, { capturedAt: at,
    httpStatus: 200, outcome: 'success', businessCode: 0, billed: true, bodySha256: restrictedSha256,
    bodySize: bytes.length, contentType: 'application/json', contractState: 'accepted' })], request.endpointVersion)[0]
  const rawPayload = structuredClone(object.rawPayload)
  delete rawPayload.request.page // Original JSONB drift, not an edited production receipt.
  await db.query(`INSERT INTO external_platform.response_archives(id,provider_call_id,contract_state,http_status,business_code,content_type,body_size,payload_sha256,raw_payload,captured_at)
    VALUES($1,$2,'accepted',200,0,'application/json',$3,$4,$5,$6)`, [randomUUID(),callId,bytes.length,object.payloadSha256,JSON.stringify(rawPayload),at])
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses(id,provider_call_id,content_type,body_size,body_sha256,body_bytes,body_text,json_parsed,parsed_payload,captured_at)
    VALUES($1,$2,'application/json',$3,$4,$5,$6,true,$7,$8)`, [randomUUID(),callId,bytes.length,restrictedSha256,bytes,bytes.toString(),JSON.stringify(payload),at])
  await db.query(`INSERT INTO external_platform.archive_objects(id,provider_key,object_kind,marketplace,operation,endpoint_version,captured_date,archive_path,response_pointer,source_key,payload_sha256,raw_payload,provider_call_id,item_ordinal)
    VALUES($1,'justone','response','facebook','native.j.facebook_post_search_v1',$2,$3,$4,'$',$5,$6,$7,$8,0)`,
  [randomUUID(),request.endpointVersion,object.capturedDate,object.archivePath,object.sourceKey,object.payloadSha256,JSON.stringify(rawPayload),callId])
  await db.query(`INSERT INTO external_platform.provider_cost_reservations(id,provider_key,usage_request_id,currency,base_cost_minor,reserved_cost_minor,reserved_subsidy_minor,monthly_budget_minor,monthly_subsidy_budget_minor,status,released_at)
    VALUES($1,'justone',$2,'CNY',0,1,0,100,100,'released',$3)`, [randomUUID(),requestId,at])
  await db.query(`INSERT INTO external_platform.gateway_requests(id,provider_key,tenant_id,consumer_id,usage_request_id,request_fingerprint,source_mode,succeeded,response_status,provider_call_id)
    VALUES($1,'justone',$2,$3,$4,$5,'unavailable',false,503,$6)`, [randomUUID(),tenant,consumer,requestId,fingerprint,callId])
  const binding = { requestId, callId, restrictedSha256, operationalSha256: object.payloadSha256, bodySize: bytes.length, deltaStepUuid: stepUuid }
  const statements = []
  let failureAt = null, loseCommit = false, releasedWith = null
  const query = async (sql, args) => {
    statements.push(sql)
    if (failureAt && sql.includes(failureAt)) throw Error('Synthetic late write failure')
    const value = await db.query(sql, args?.map(item => item && typeof item === 'object' && !(item instanceof Uint8Array) && !(item instanceof Date) ? JSON.stringify(item) : item))
    if (sql === 'COMMIT' && loseCommit) { loseCommit = false; throw Error('Synthetic lost COMMIT acknowledgment') }
    return value
  }
  const pool = { query, connect: async () => ({ query, release: error => { releasedWith = error } }) }
  const recover = createFacebookEmptyPageRecovery(binding)
  const tables = ['usage_requests','usage_idempotency_bindings','external_platform.provider_calls','external_platform.response_archives',
    'external_platform.archive_objects','external_platform.gateway_requests','external_platform.provider_cost_reservations',
    'control.external_platform_restricted_raw_responses','billing.customer_charges','billing.credit_accounts','billing.credit_ledger_entries','control.facebook_empty_page_recoveries']
  const snapshot = async () => JSON.stringify(await Promise.all(tables.map(table => db.query(`SELECT * FROM ${table} ORDER BY 1`))))
  const state = async () => ({ usage: (await db.query('SELECT * FROM usage_requests WHERE id=$1',[requestId])).rows[0],
    call: (await db.query('SELECT * FROM external_platform.provider_calls WHERE id=$1',[callId])).rows[0],
    account: (await db.query('SELECT * FROM billing.credit_accounts WHERE id=$1',[account])).rows[0],
    charge: (await db.query('SELECT * FROM billing.customer_charges WHERE usage_request_id=$1',[requestId])).rows[0],
    ledger: (await db.query('SELECT * FROM billing.credit_ledger_entries WHERE usage_request_id=$1 ORDER BY created_at',[requestId])).rows })
  return { db,pool,recover,binding,statements,snapshot,state,tenant,consumer,key,account,
    normalDelivery: async () => normalDelivery(service, await service.authenticate(credential.secret), body, payload),
    failAt(value) { failureAt = value }, loseCommit() { loseCommit = true }, get releasedWith() { return releasedWith } }
}

test('fixed recovery CLI rejects alternate incidents and requires an explicit reviewed apply', () => {
  assert.deepEqual(recoveryArguments([]), {})
  assert.deepEqual(recoveryArguments(['--show']), { show: true })
  for (const args of [['--apply'],['--request-id',randomUUID()],['--case',JSON.stringify(FACEBOOK_EMPTY_PAGE_CASE)],['--dry-run','--apply']])
    assert.throws(() => recoveryArguments(args), { code: 'recovery_invalid_arguments' })
})

test('actual PostgreSQL recovery is read-only by default, captures the original hold once, preserves archives and appends immutable audit', options, async t => {
  const f = await fixture(t), before = await f.snapshot(), initial = await f.state()
  const preview = await f.recover(f.pool)
  assert.equal(await f.snapshot(), before)
  assert.equal(preview.plan.money.additionalCaptureMinor, '1')
  assert.equal(preview.plan.canonicalQueued, 0)
  assert.deepEqual(preview.plan.sourceWindow, { startDate: '2026-10-16', endDate: '2026-10-17', explicitDates: false })
  assert.doesNotMatch(JSON.stringify(preview), /private fixture query|offline-upstream/)
  assert.equal(initial.account.available_minor, 99); assert.equal(initial.account.held_minor, 1)
  const archives = await Promise.all(['external_platform.response_archives','external_platform.archive_objects','control.external_platform_restricted_raw_responses']
    .map(table => f.db.query(`SELECT * FROM ${table}`)))
  const receipt = await f.recover(f.pool, { apply: true, previewHash: preview.previewHash, reason: 'Verified empty terminal archive' })
  const settled = await f.state()
  assert.equal(settled.usage.status, 'committed'); assert.equal(settled.usage.units_actual, 1)
  assert.deepEqual(settled.usage.response_body.data.items, [])
  assert.equal(settled.usage.response_body.data.pageInfo.hasMore, false)
  assert.equal(settled.usage.response_body.data.meta.providerCalls, 1)
  assert.deepEqual(settled.usage.response_body, { ...await f.normalDelivery(), requestId: f.binding.requestId })
  assert.equal(settled.usage.delivery_source_mode, 'stale')
  assert.equal(settled.call.outcome, 'succeeded'); assert.equal(settled.call.cost_minor, 1); assert.equal(settled.call.billed, true)
  assert.deepEqual(settled.call.completed_at, initial.call.completed_at)
  assert.equal(settled.charge.status, 'captured'); assert.equal(settled.charge.charged_minor, 1)
  assert.equal(settled.account.available_minor, 99); assert.equal(settled.account.held_minor, 0)
  assert.equal(settled.account.revision, initial.account.revision + 1)
  assert.equal(settled.ledger.filter(row => row.kind === 'capture').length, 1)
  assert.deepEqual(settled.charge.pricing_snapshot, initial.charge.pricing_snapshot)
  assert.deepEqual(await Promise.all(['external_platform.response_archives','external_platform.archive_objects','control.external_platform_restricted_raw_responses']
    .map(table => f.db.query(`SELECT * FROM ${table}`))), archives)
  const after = await f.snapshot()
  assert.equal((await f.recover(f.pool, { apply: true, previewHash: preview.previewHash, reason: 'Same reviewed recovery' })).replay, true)
  assert.equal((await f.recover(f.pool, { show: true })).customerCapture.ledgerId, receipt.customerCapture.ledgerId)
  assert.equal(await f.snapshot(), after)
  const events = (await f.db.query('SELECT source_mode,succeeded,response_status,provider_call_id FROM external_platform.gateway_requests ORDER BY created_at')).rows
  assert.deepEqual(events, [
    { source_mode: 'unavailable', succeeded: false, response_status: 503, provider_call_id: f.binding.callId },
    { source_mode: 'stored_fallback', succeeded: true, response_status: 200, provider_call_id: f.binding.callId },
  ])
  for (const sql of ['UPDATE control.facebook_empty_page_recoveries SET actor=actor', 'DELETE FROM control.facebook_empty_page_recoveries',
    'TRUNCATE control.facebook_empty_page_recoveries', 'UPDATE billing.credit_ledger_entries SET reason=reason',
    'UPDATE billing.credit_accounts SET available_minor=available_minor+1'])
    await assert.rejects(f.db.exec(sql))
  assert.equal((await f.db.query('SELECT count(*)::int n FROM external_platform.provider_calls')).rows[0].n, 1)
  assert.equal((await f.db.query('SELECT count(*)::int n FROM ingest.ingest_runs')).rows[0].n, 0)
  assert.ok(!f.statements.some(sql => /INSERT INTO (?:mxq|ingest|external_platform\.provider_calls)/u.test(sql)))
})

test('actual PostgreSQL recovery rejects stale preview and rolls back all money, outcome and gateway writes if audit fails', options, async t => {
  const f = await fixture(t), preview = await f.recover(f.pool), before = await f.snapshot()
  await assert.rejects(f.recover(f.pool, { apply: true, previewHash: 'a'.repeat(64), reason: 'Wrong preview hash' }), { code: 'recovery_preview_changed' })
  assert.equal(await f.snapshot(), before)
  f.failAt('INSERT INTO control.facebook_empty_page_recoveries')
  await assert.rejects(f.recover(f.pool, { apply: true, previewHash: preview.previewHash, reason: 'Fail audit transaction' }), { code: 'recovery_failed_no_changes_committed' })
  f.failAt(null)
  assert.equal(await f.snapshot(), before)
  await f.db.query('UPDATE external_platform.provider_calls SET latency_ms=latency_ms+1 WHERE id=$1',[f.binding.callId])
  await assert.rejects(f.recover(f.pool, { apply: true, previewHash: preview.previewHash, reason: 'Changed immutable evidence' }), { code: 'recovery_preview_changed' })
  assert.equal((await f.state()).charge.status, 'unknown')
})

test('actual PostgreSQL recovery resolves a lost COMMIT by the same saved receipt without charging again', options, async t => {
  const f = await fixture(t), preview = await f.recover(f.pool)
  f.loseCommit()
  const apply = { apply: true, previewHash: preview.previewHash, reason: 'Reviewed exact archive' }
  await assert.rejects(f.recover(f.pool, apply), { code: 'recovery_commit_outcome_unknown_use_same_preview_hash' })
  assert.match(f.releasedWith.message, /lost COMMIT/)
  const after = await f.snapshot()
  assert.equal((await f.recover(f.pool, apply)).replay, true)
  assert.equal(await f.snapshot(), after)
  assert.equal((await f.state()).ledger.filter(row => row.kind === 'capture').length, 1)
})

test('actual PostgreSQL recovery rejects released charges, altered archives and a missing idempotency binding', options, async t => {
  const f = await fixture(t), preview = await f.recover(f.pool)
  for (const sql of ["UPDATE external_platform.response_archives SET raw_payload=raw_payload || '{\"unexpected\":true}'::jsonb",
    "UPDATE external_platform.provider_calls SET cost_minor=2", "UPDATE billing.credit_accounts SET status='suspended',revision=revision+1",
    'DELETE FROM usage_idempotency_bindings']) {
    await f.db.exec('BEGIN')
    try { await f.db.exec(sql); await assert.rejects(f.recover({ connect: async () => ({ query: async (statement,args) => {
      if (/^BEGIN/u.test(statement) || statement === 'ROLLBACK') return { rows: [] }
      return f.pool.query(statement,args)
    }, release() {} }) }, { apply: true, previewHash: preview.previewHash, reason: 'Reject changed source' })) }
    finally { await f.db.exec('ROLLBACK') }
  }
  // Real reconciliation releases the existing hold; recovery must not reprice
  // or recharge it, even though the delivery itself remains unknown.
  await f.db.query("SELECT billing.reconcile_unknown_customer_charge($1,'release',$2,'test','Reviewed no delivery')", [f.binding.requestId,randomUUID()])
  await assert.rejects(f.recover(f.pool, { apply: true, previewHash: preview.previewHash, reason: 'Already financially released' }))
  assert.equal((await f.state()).account.available_minor, 100)
})

test('actual PostgreSQL recovery never creates a missing quote or captures after an existing refund', options, async t => {
  const noCharge = await fixture(t, { noCharge: true }), before = await noCharge.snapshot()
  await assert.rejects(noCharge.recover(noCharge.pool), { code: 'recovery_original_price_invalid' })
  assert.equal(await noCharge.snapshot(), before)
  const f = await fixture(t), preview = await f.recover(f.pool)
  await f.db.query("SELECT billing.reconcile_unknown_customer_charge($1,'capture',$2,'test','Reviewed financial capture')", [f.binding.requestId,randomUUID()])
  const state = await f.state()
  await f.db.query(`INSERT INTO billing.credit_ledger_entries(account_id,tenant_id,charge_id,usage_request_id,kind,
    amount_minor,available_delta_minor,held_delta_minor,currency,idempotency_key,actor,reason)
    VALUES($1,$2,$3,$4,'refund',1,1,0,'CNY',$5,'test','Reviewed existing refund')`,
  [f.account,f.tenant,state.charge.id,f.binding.requestId,randomUUID()])
  const refunded = await f.snapshot()
  await assert.rejects(f.recover(f.pool, { apply: true, previewHash: preview.previewHash, reason: 'Reject already refunded request' }), { code: 'recovery_original_ledger_changed' })
  assert.equal(await f.snapshot(), refunded)
})

test('actual PostgreSQL recovery refuses an active original dispatch lease and accepts an expired one', options, async t => {
  const f = await fixture(t), preview = await f.recover(f.pool)
  await f.db.query(`INSERT INTO external_platform.dispatch_leases(consumer_id,operation,request_fingerprint,owner_request_id,expires_at)
    SELECT consumer_id,'facebook.search',fingerprint,id,now()+interval '1 hour' FROM usage_requests WHERE id=$1`, [f.binding.requestId])
  const blocked = await f.snapshot()
  await assert.rejects(f.recover(f.pool), { code: 'recovery_original_dispatch_still_active' })
  await assert.rejects(f.recover(f.pool, { apply: true, previewHash: preview.previewHash, reason: 'Cannot override running work' }),
    { code: 'recovery_original_dispatch_still_active' })
  assert.equal(await f.snapshot(), blocked)
  await f.db.exec("UPDATE external_platform.dispatch_leases SET expires_at=now()-interval '1 second'")
  await f.recover(f.pool, { apply: true, previewHash: preview.previewHash, reason: 'Original dispatch has expired' })
  assert.equal((await f.db.query('SELECT count(*)::int n FROM external_platform.dispatch_leases')).rows[0].n, 1)
  await f.db.exec("UPDATE external_platform.dispatch_leases SET expires_at=now()+interval '1 hour'")
  assert.equal((await f.recover(f.pool, { show: true })).replay, true)
})

test('actual PostgreSQL receipt remains read-only after fresh idempotency rebinding, account suspension and a later refund', options, async t => {
  const f = await fixture(t), preview = await f.recover(f.pool), nextRequestId = randomUUID()
  await f.db.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,billing_meter_key,acquisition_request)
    SELECT $1,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,'reserved',billing_meter_key,acquisition_request
    FROM usage_requests WHERE id=$2`, [nextRequestId,f.binding.requestId])
  const move = id => f.db.query('UPDATE usage_idempotency_bindings SET current_request_id=$1,updated_at=now()', [id])
  await move(nextRequestId)
  await assert.rejects(f.recover(f.pool), { code: 'recovery_idempotency_changed' })
  await move(f.binding.requestId)
  const current = await f.recover(f.pool) // Binding updated_at legitimately changed: obtain a new exact preview.
  assert.notEqual(current.previewHash, preview.previewHash)
  const apply = { apply: true, previewHash: current.previewHash, reason: 'Reviewed original binding and hold' }
  const receipt = await f.recover(f.pool, apply)
  await move(nextRequestId)
  await f.db.exec("UPDATE billing.credit_accounts SET status='suspended',revision=revision+1")
  const state = await f.state()
  await f.db.query(`INSERT INTO billing.credit_ledger_entries(account_id,tenant_id,charge_id,usage_request_id,kind,
    amount_minor,available_delta_minor,held_delta_minor,currency,idempotency_key,actor,reason)
    VALUES($1,$2,$3,$4,'refund',1,1,0,'CNY',$5,'test','Later authorized refund preserves original recovery history')`,
  [f.account,f.tenant,state.charge.id,f.binding.requestId,randomUUID()])
  const before = await f.snapshot()
  const shown = await f.recover(f.pool, { show: true })
  assert.equal(shown.customerCapture.ledgerId, receipt.customerCapture.ledgerId)
  assert.equal(shown.currentBindingStillOriginal, false)
  assert.equal((await f.recover(f.pool, apply)).customerCapture.ledgerId, receipt.customerCapture.ledgerId)
  assert.equal(await f.snapshot(), before)
  assert.equal((await f.state()).ledger.filter(row => row.kind === 'capture').length, 1)
})
