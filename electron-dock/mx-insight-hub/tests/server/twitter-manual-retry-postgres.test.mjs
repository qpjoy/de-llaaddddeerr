import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { claimTwitterManualRetry, validateTwitterManualRetry, twitterManualRetryOwnerFor } from '../../server/external-platforms/twitter-manual-retry.mjs'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { PostgresAcquisitionHistoryStore } from '../../server/acquisitions/history-store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL constraints' }
const path = '/api/v1/data/search'
const body = { platform: 'twitter', query: 'offline fixture #chipban', pageSize: 20, type: 'fresh' }
const fingerprint = requestFingerprint({ method: 'POST', path, body })
const denied = error => error?.code === 'uncertain_retry_not_allowed'

async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY)')
  for (const name of ['001_initial.sql', '004_reservation_lease.sql', '051_external_platform_gateway.sql',
    '053_external_platform_uncertain_retry.sql', '094_acquisition_request_snapshot.sql', '152_twitter_manual_retry.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  const tenantId = randomUUID(), consumerId = randomUUID(), apiKeyId = randomUUID()
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Fixture tenant')", [tenantId])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Fixture consumer',$3)", [consumerId, tenantId, consumerId])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Fixture key',$4,'fixture','0000')",
    [apiKeyId, tenantId, consumerId, 'a'.repeat(64)])
  const identity = { tenantId, consumerId, apiKeyId, fingerprint }
  const store = { pool: db, providerKey: 'rapidapi' }
  const addRequest = async (status = 'unknown', overrides = {}) => {
    const row = { id: randomUUID(), ...identity, status, platform: 'twitter', idempotencyKey: randomUUID(),
      snapshot: { method: 'POST', path, body }, ...overrides }
    await db.query(`INSERT INTO usage_requests
      (id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,acquisition_request,lease_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '2 minutes')`,
    [row.id,row.tenantId,row.consumerId,row.apiKeyId,row.idempotencyKey,row.fingerprint,row.platform,row.status,JSON.stringify(row.snapshot)])
    return row
  }
  const addCall = async (request, overrides = {}) => {
    const row = { id: randomUUID(), provider: 'rapidapi', operation: 'social.content.search', contract: 'mx-insight-hub.social-data.v1',
      endpoint: 'twitter-aio.search', version: 'twitter-aio.hub.v1', outcome: 'unknown', ...overrides }
    await db.query(`INSERT INTO external_platform.provider_calls
      (id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,operation,contract_version,endpoint_key,endpoint_version,
      marketplace,request_fingerprint,outcome,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'twitter',$11,$12,CASE WHEN $12='pending' THEN NULL ELSE now() END)`,
    [row.id,row.provider,request.tenantId,request.consumerId,request.apiKeyId,request.id,row.operation,row.contract,row.endpoint,row.version,request.fingerprint,row.outcome])
    return row
  }
  const input = (original, successor, extra = {}) => ({ ...identity, retryOfRequestId: original.id,
    ...(successor ? { usageRequestId: successor.id, idempotencyKey: successor.idempotencyKey } : {}), ...extra })
  // PGlite has one session. Serialize transaction callbacks explicitly: these
  // tests verify real SQL/unique constraints, not multi-session lock scheduling.
  let pending = Promise.resolve()
  const transaction = fn => {
    const result = pending.then(async () => {
      await db.exec('BEGIN')
      try { const value = await fn(db); await db.exec('COMMIT'); return value }
      catch (error) { await db.exec('ROLLBACK'); throw error }
    })
    pending = result.catch(() => {})
    return result
  }
  return { db, store, identity, addRequest, addCall, input, transaction }
}

async function platformStore(f) {
  for (const name of ['055_external_platform_multi_call_rate_limit.sql', '138_admission_recovery.sql']) {
    await f.db.exec('CREATE SCHEMA IF NOT EXISTS control')
    await f.db.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  let pending = Promise.resolve()
  const pool = { query: (sql, args) => f.db.query(sql, args), connect: async () => {
    const before = pending
    let release
    pending = new Promise(resolve => { release = resolve })
    await before
    return { query: (sql, args) => f.db.query(sql, args), release }
  } }
  return new PostgresExternalPlatformStore({ pool, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
}

test('PG Admin preparation reads original parameters and the durable successor without changing unknown history', options, async t => {
  const f = await fixture(t), original = await f.addRequest(), successor = await f.addRequest('reserved')
  await f.addCall(original)
  const pool = { query: (...args) => f.db.query(...args),
    connect: async () => ({ query: (...args) => f.db.query(...args), release() {} }) }
  const history = new PostgresAcquisitionHistoryStore(pool)
  const before = (await f.db.query('SELECT * FROM usage_requests WHERE id=$1', [original.id])).rows[0]
  const prepared = await history.getAdminTwitterRetryPreparation(original.id)
  assert.equal(prepared.eligibility.allowed, true)
  assert.deepEqual(prepared.requestEvidence.request, { method: 'POST', path, body })
  assert.equal(prepared.owner.apiKeyId, f.identity.apiKeyId)
  await f.transaction(client => claimTwitterManualRetry(f.store, f.input(original, successor), client))
  const receipt = await history.getAdminTwitterRetryPreparation(original.id)
  assert.equal(receipt.eligibility.allowed, false)
  assert.deepEqual(receipt.successor, { requestId: successor.id, status: 'reserved',
    idempotencyKey: successor.idempotencyKey, apiKeyId: f.identity.apiKeyId, responseStatus: null })
  assert.deepEqual((await f.db.query('SELECT * FROM usage_requests WHERE id=$1', [original.id])).rows[0], before)
})

test('PG retry validation is read-only and a rolled-back dispatch does not consume the successor claim', options, async t => {
  const f = await fixture(t), original = await f.addRequest(), successor = await f.addRequest('reserved')
  await f.addCall(original)
  const before = (await f.db.query('SELECT * FROM usage_requests WHERE id=$1', [original.id])).rows[0]
  assert.deepEqual(await validateTwitterManualRetry(f.store, f.input(original)),
    { retryOfRequestId: original.id, ancestorRequestIds: [original.id] })
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), null)
  await assert.rejects(f.transaction(async client => {
    await claimTwitterManualRetry(f.store, f.input(original, successor), client)
    throw new Error('synthetic dispatch transaction failure')
  }), /synthetic dispatch/u)
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), null)
  await f.transaction(client => claimTwitterManualRetry(f.store, f.input(original, successor), client))
  await f.transaction(client => claimTwitterManualRetry(f.store, f.input(original, successor), client))
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), successor.id)
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM external_platform.twitter_manual_retries')).rows[0].n, 1)
  assert.deepEqual((await f.db.query('SELECT * FROM usage_requests WHERE id=$1', [original.id])).rows[0], before)
})

test('PG unique successor arbitration admits only one of two submitted replacement intents', options, async t => {
  const f = await fixture(t), original = await f.addRequest(), one = await f.addRequest('reserved'), two = await f.addRequest('reserved')
  await f.addCall(original)
  const results = await Promise.allSettled([one, two].map(successor =>
    f.transaction(client => claimTwitterManualRetry(f.store, f.input(original, successor), client))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && denied(result.reason)).length, 1)
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), one.id)
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM external_platform.twitter_manual_retries')).rows[0].n, 1)
  // These are the actual migration constraints, independent of application checks.
  const other = await f.addRequest()
  await assert.rejects(f.db.query(`INSERT INTO external_platform.twitter_manual_retries
    (original_usage_request_id,successor_usage_request_id,tenant_id,consumer_id,api_key_id,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6)`, [other.id,one.id,f.identity.tenantId,f.identity.consumerId,f.identity.apiKeyId,fingerprint]),
  error => error.code === '23505')
  await assert.rejects(f.db.query('DELETE FROM usage_requests WHERE id=$1', [one.id]), error => error.code === '23503')
})

test('PG retry scope rejects changed identity, request body, status, contract and reused original idempotency', options, async t => {
  const f = await fixture(t), original = await f.addRequest(), successor = await f.addRequest('reserved')
  const call = await f.addCall(original)
  for (const key of ['tenantId', 'consumerId', 'apiKeyId', 'fingerprint']) {
    await assert.rejects(validateTwitterManualRetry(f.store, f.input(original, successor,
      { [key]: key === 'fingerprint' ? 'b'.repeat(64) : randomUUID() })), denied)
  }
  await assert.rejects(validateTwitterManualRetry(f.store, f.input(original, successor,
    { idempotencyKey: original.idempotencyKey })), denied)
  await f.db.query("UPDATE usage_requests SET status='committed' WHERE id=$1", [original.id])
  await assert.rejects(validateTwitterManualRetry(f.store, f.input(original, successor)), denied)
  await f.db.query("UPDATE usage_requests SET status='unknown',acquisition_request=$2 WHERE id=$1",
    [original.id,JSON.stringify({ method: 'POST', path, body: { ...body, query: 'different query' } })])
  await assert.rejects(validateTwitterManualRetry(f.store, f.input(original, successor)), denied)
  await f.db.query('UPDATE usage_requests SET acquisition_request=$2 WHERE id=$1', [original.id,JSON.stringify(original.snapshot)])
  await f.db.query("UPDATE external_platform.provider_calls SET contract_version='unsupported.old.contract' WHERE id=$1", [call.id])
  await assert.rejects(validateTwitterManualRetry(f.store, f.input(original, successor)), denied)
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), null)
})

test('PG latest unknown successor authorizes only its verified ancestor chain and refuses forks or forged scope', options, async t => {
  const f = await fixture(t), original = await f.addRequest(), successor = await f.addRequest('reserved'), latest = await f.addRequest('reserved')
  const unrelated = await f.addRequest()
  await f.addCall(original); await f.addCall(unrelated)
  await f.transaction(client => claimTwitterManualRetry(f.store, f.input(original, successor), client))
  await f.db.query("UPDATE usage_requests SET status='unknown' WHERE id=$1", [successor.id])
  await f.addCall(successor)
  const validated = await validateTwitterManualRetry(f.store, f.input(successor, latest))
  assert.deepEqual(validated.ancestorRequestIds, [successor.id, original.id])
  assert.equal(validated.ancestorRequestIds.includes(unrelated.id), false)
  await f.transaction(client => claimTwitterManualRetry(f.store, f.input(successor, latest), client))
  await assert.rejects(validateTwitterManualRetry(f.store, f.input(original, latest)), denied)
  await f.db.query('UPDATE external_platform.twitter_manual_retries SET api_key_id=$2 WHERE original_usage_request_id=$1',
    [original.id,randomUUID()])
  await assert.rejects(validateTwitterManualRetry(f.store, f.input(successor, latest)), denied)
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM usage_requests WHERE status='unknown'")).rows[0].n, 3)
})

test('PG cyclic stored retry lineage is refused and a buffer-only target needs a successful scoped source', options, async t => {
  const f = await fixture(t), one = await f.addRequest(), two = await f.addRequest(), successor = await f.addRequest('reserved')
  await f.addCall(one); await f.addCall(two)
  for (const [original, next] of [[one,two],[two,one]]) await f.db.query(`INSERT INTO external_platform.twitter_manual_retries
    (original_usage_request_id,successor_usage_request_id,tenant_id,consumer_id,api_key_id,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6)`, [original.id,next.id,f.identity.tenantId,f.identity.consumerId,f.identity.apiKeyId,fingerprint])
  await assert.rejects(validateTwitterManualRetry(f.store, f.input(one, successor)), denied)
  const snapshot = { method: 'POST', path, body: { ...body, cursor: 'mxds1.offline-store-fixture' } }
  const scopedFingerprint = requestFingerprint(snapshot)
  const noCalls = await f.addRequest('unknown', { snapshot, fingerprint: scopedFingerprint })
  const bufferSuccessor = await f.addRequest('reserved', { snapshot, fingerprint: scopedFingerprint })
  const source = await f.addRequest('committed'), sourceCall = await f.addCall(source, { outcome: 'succeeded' })
  const bufferInput = f.input(noCalls, bufferSuccessor, { fingerprint: scopedFingerprint })
  await assert.rejects(validateTwitterManualRetry(f.store, bufferInput), denied)
  assert.deepEqual((await validateTwitterManualRetry(f.store, { ...bufferInput, bufferCallId: sourceCall.id })).ancestorRequestIds,
    [noCalls.id])
  await f.db.query("UPDATE external_platform.provider_calls SET outcome='unknown' WHERE id=$1", [sourceCall.id])
  await assert.rejects(validateTwitterManualRetry(f.store, { ...bufferInput, bufferCallId: sourceCall.id }), denied)
})

test('PG dispatch excludes only verified unknown ancestors and retains unrelated, pending and unusable blockers', options, async t => {
  const f = await fixture(t), store = await platformStore(f)
  const original = await f.addRequest(), successor = await f.addRequest('reserved')
  const originalCall = await f.addCall(original)
  const delivery = { ...f.identity, usageRequestId: successor.id, operation: 'social.content.search',
    twitterManualRetry: { retryOfRequestId: original.id } }
  const lease = { consumerId: f.identity.consumerId, operation: delivery.operation, fingerprint,
    endpointKey: 'twitter-aio.search', contractVersion: 'mx-insight-hub.social-data.v1', ownerRequestId: successor.id,
    expiresAt: new Date(Date.now() + 60000), twitterManualRetry: f.input(original, successor) }
  assert.equal(await store.twitterFillUnknownFor({ ...delivery, twitterManualRetry: null }), true)
  assert.equal(await store.twitterFillUnknownFor(delivery), false)
  assert.equal((await store.acquireDispatchLease(lease)).kind, 'acquired')
  await store.releaseDispatchLease(lease)
  const unrelated = await f.addRequest(), unrelatedCall = await f.addCall(unrelated)
  assert.equal(await store.twitterFillUnknownFor(delivery), true)
  assert.equal((await store.acquireDispatchLease(lease)).reason, 'unknown')
  await f.db.query("UPDATE usage_requests SET status='released' WHERE id=$1", [unrelated.id])
  await f.db.query("UPDATE external_platform.provider_calls SET outcome='rejected' WHERE id=$1", [unrelatedCall.id])
  for (const outcome of ['pending', 'succeeded_unusable']) {
    await f.db.query("UPDATE external_platform.provider_calls SET outcome=$2,completed_at=CASE WHEN $2='pending' THEN NULL ELSE now() END WHERE id=$1",
      [originalCall.id,outcome])
    assert.equal((await store.acquireDispatchLease(lease)).reason, outcome)
  }
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), null, 'guard reads do not consume the manual retry')
})

test('PG first provider call and successor edge commit together; later fill calls do not consume another retry', options, async t => {
  const f = await fixture(t), store = await platformStore(f)
  const original = await f.addRequest(), successor = await f.addRequest('reserved'), competing = await f.addRequest('reserved')
  await f.addCall(original)
  const input = { ...f.identity, usageRequestId: successor.id, operation: 'social.content.search',
    contractVersion: 'mx-insight-hub.social-data.v1', endpointKey: 'twitter-aio.search', endpointVersion: 'twitter-aio.hub.v1',
    marketplace: 'twitter', callOrdinal: 0, retryOfRequestId: original.id, twitterManualRetry: { retryOfRequestId: original.id } }
  await assert.rejects(store.beginProviderCall({ ...input, marketplace: null }))
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), null, 'failed provider insertion rolls back the edge')
  const first = await store.beginProviderCall(input)
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), successor.id)
  await store.beginProviderCall({ ...input, callOrdinal: 1, callRole: 'enrichment', retryOfRequestId: null })
  const rows = (await f.db.query(`SELECT id,retry_of_usage_request_id FROM external_platform.provider_calls
    WHERE usage_request_id=$1 ORDER BY call_ordinal`, [successor.id])).rows
  assert.deepEqual(rows.map(row => row.retry_of_usage_request_id), [original.id,null])
  assert.equal(rows[0].id, first.id)
  await assert.rejects(store.beginProviderCall({ ...input, usageRequestId: competing.id }), denied)
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM external_platform.twitter_manual_retries')).rows[0].n, 1)
  assert.equal((await f.db.query('SELECT status FROM usage_requests WHERE id=$1', [original.id])).rows[0].status, 'unknown')
})

test('PG buffer-only delivery claims its successor atomically with commit and never creates a new provider call', options, async t => {
  const f = await fixture(t), store = await platformStore(f)
  await f.db.exec(await readFile(new URL('../../migrations/058_external_platform_restricted_raw_responses.sql', import.meta.url), 'utf8'))
  await f.db.exec(`ALTER TABLE usage_requests ADD COLUMN delivery_source_mode text, ADD COLUMN response_captured_at timestamptz`)
  // The workflow has already authenticated the cursor. This store test checks
  // its successful source receipt and the atomic delivery/claim transaction.
  const snapshot = { method: 'POST', path, body: { ...body, cursor: 'mxds1.offline-store-fixture' } }
  const scopedFingerprint = requestFingerprint(snapshot)
  const original = await f.addRequest('unknown', { snapshot, fingerprint: scopedFingerprint })
  const successor = await f.addRequest('reserved', { snapshot, fingerprint: scopedFingerprint })
  const source = await f.addRequest('committed'), sourceCall = await f.addCall(source, { outcome: 'succeeded' })
  await f.db.query('UPDATE usage_requests SET response_status=200 WHERE id=$1', [source.id])
  await f.db.query('UPDATE external_platform.provider_calls SET http_status=200 WHERE id=$1', [sourceCall.id])
  const bytes = Buffer.from('{"offline":"complete paid receipt"}'), capturedAt = new Date(Date.now() - 1000).toISOString()
  const sha = createHash('sha256').update(bytes).digest('hex')
  await f.db.query(`INSERT INTO control.external_platform_restricted_raw_responses
    (id,provider_call_id,body_size,body_sha256,body_bytes,json_parsed,captured_at) VALUES($1,$2,$3,$4,$5,true,$6)`,
  [randomUUID(),sourceCall.id,bytes.length,sha,bytes,capturedAt])
  const delivery = { ...f.identity, fingerprint: scopedFingerprint, usageRequestId: successor.id, operation: 'social.content.search',
    twitterManualRetry: { retryOfRequestId: original.id, bufferCallId: sourceCall.id } }
  const input = { delivery, query: body.query, pageSize: 20, type: 'fresh', capturedAt, usageUnitsActual: 1, sourceMode: 'fresh_cache',
    responseBody: { data: { platform: 'twitter', query: body.query, pageInfo: { pageSize: 20 }, items: [{ id: '1' }] } },
    lineage: { version: 'twitter-fill.v1', scopeHash: 'c'.repeat(64), upstreamPages: 1 },
    sources: [{ callId: sourceCall.id, bodySize: bytes.length, bodySha256: sha, capturedAt, rowsHash: 'd'.repeat(64) }] }
  const before = (await f.db.query('SELECT * FROM usage_requests WHERE id=$1', [original.id])).rows[0]
  await f.db.exec(`CREATE FUNCTION external_platform.test_fail_gateway() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic gateway insertion failure'; END $$;
    CREATE TRIGGER test_fail_gateway BEFORE INSERT ON external_platform.gateway_requests
      FOR EACH ROW EXECUTE FUNCTION external_platform.test_fail_gateway()`)
  await assert.rejects(store.commitTwitterFillDelivery(input), /synthetic gateway/u)
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), null)
  assert.equal((await f.db.query('SELECT status FROM usage_requests WHERE id=$1', [successor.id])).rows[0].status, 'reserved')
  await f.db.exec('DROP TRIGGER test_fail_gateway ON external_platform.gateway_requests')
  await store.commitTwitterFillDelivery(input)
  assert.equal(await twitterManualRetryOwnerFor(f.store, original.id), successor.id)
  assert.equal((await f.db.query('SELECT status FROM usage_requests WHERE id=$1', [successor.id])).rows[0].status, 'committed')
  assert.deepEqual((await f.db.query('SELECT * FROM usage_requests WHERE id=$1', [original.id])).rows[0], before)
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM external_platform.provider_calls')).rows[0].n, 1)
})
