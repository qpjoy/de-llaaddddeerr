import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { facebookJustOneArchives, FACEBOOK_JUSTONE_KEY } from '../../server/contracts/facebook-search.mjs'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE' }
const endpointVersion = 'night-all-source-snapshot.2026-09-26'

async function fixture(t, posts = []) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE consumers(id uuid PRIMARY KEY);
    CREATE TABLE api_keys(id uuid PRIMARY KEY);
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,status text,error_code text,completed_at timestamptz);`)
  // Use the real production evidence table definitions, including JSONB, bytea,
  // outcome constraints and unique receipts. The unrelated identity tables
  // above only provide the referenced keys for this isolated persistence test.
  for (const [migration, tables] of [
    ['051_external_platform_gateway.sql', ['external_platform.provider_calls', 'external_platform.response_archives',
      'external_platform.archive_objects', 'external_platform.response_snapshots', 'external_platform.gateway_requests']],
    ['058_external_platform_restricted_raw_responses.sql', ['control.external_platform_restricted_raw_responses']],
  ]) {
    const source = await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8')
    for (const table of tables) {
      const ddl = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replaceAll('.', '\\.')} \\([\\s\\S]*?\\n\\);`))?.[0]
      assert.ok(ddl, table)
      await db.exec(ddl)
    }
  }
  const delivery = { tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(), usageRequestId: randomUUID(),
    operation: 'native.j.facebook_post_search_v1', fingerprint: 'a'.repeat(64) }
  for (const [table, id] of [['tenants', delivery.tenantId], ['consumers', delivery.consumerId], ['api_keys', delivery.apiKeyId]])
    await db.query(`INSERT INTO ${table}(id) VALUES($1)`, [id])
  await db.query("INSERT INTO usage_requests(id,status) VALUES($1,'reserved')", [delivery.usageRequestId])
  const callId = randomUUID()
  await db.query(`INSERT INTO external_platform.provider_calls(id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,
    operation,contract_version,endpoint_key,endpoint_version,marketplace,request_fingerprint)
    VALUES($1,'justone',$2,$3,$4,$5,$6,'mx-insight-hub.native-forwarding.v1',$6,$7,'facebook',$8)`,
  [callId, delivery.tenantId, delivery.consumerId, delivery.apiKeyId, delivery.usageRequestId, delivery.operation, endpointVersion, delivery.fingerprint])
  let dispatches = 0, rollbacks = 0
  const adapter = new JustOneAdapter({ token: 'offline-only-token', fetchImpl: async () => {
    dispatches++
    return Response.json({ code: 0, message: 'success', requestId: 'offline-request', recordTime: '2026-10-17',
      data: { business_data: posts, cursor: null } })
  }, logger: { warn() {}, error() {} } })
  const result = await adapter.forwardNative(FACEBOOK_JUSTONE_KEY, { params: {
    keyword: 'offline fixture', startDate: '2026-10-16', endDate: '2026-10-17',
  } })
  const archiveObjects = facebookJustOneArchives(result.archiveObjects, endpointVersion)
  const object = archiveObjects.find(value => value.kind === 'response')
  const rawPayload = object.rawPayload, response = rawPayload.response
  const evidence = { callId, delivery, outcome: 'succeeded', billed: true, httpStatus: 200, businessCode: 0,
    costMinor: null, costKind: 'unknown', currency: null, latencyMs: 1, itemCount: posts.length, errorCode: null,
    responseArchive: { contractState: object.contractState, httpStatus: response.httpStatus,
      businessCode: response.businessCode, contentType: object.contentType, bodySize: object.bodySize,
      payloadSha256: object.payloadSha256, rawPayload, capturedAt: rawPayload.capturedAt },
    upstreamEvidence: { requestId: object.upstreamRequestId, recordTime: object.upstreamRecordTime },
    restrictedResponseArchive: result.restrictedResponseArchive, archiveObjects }
  const query = async (sql, args) => {
    if (sql === 'ROLLBACK') rollbacks++
    const result = await db.query(sql, args?.map(value => value && typeof value === 'object'
      && !(value instanceof Uint8Array) && !(value instanceof Date) ? JSON.stringify(value) : value))
    // node-postgres returns bytea as Buffer; PGlite returns Uint8Array.
    for (const row of result.rows) for (const [key, value] of Object.entries(row))
      if (value instanceof Uint8Array) row[key] = Buffer.from(value)
    return result
  }
  const store = new PostgresExternalPlatformStore({ pool: { query, connect: async () => ({ query, release() {} }) }, providerKey: 'justone' })
  const state = async () => ({
    call: (await query('SELECT outcome,http_status,business_code,error_code FROM external_platform.provider_calls WHERE id=$1', [callId])).rows[0],
    usage: (await query('SELECT status,error_code FROM usage_requests WHERE id=$1', [delivery.usageRequestId])).rows[0],
    archives: (await query(`SELECT (SELECT count(*)::int FROM external_platform.response_archives) AS operational,
      (SELECT count(*)::int FROM control.external_platform_restricted_raw_responses) AS restricted,
      (SELECT count(*)::int FROM external_platform.archive_objects) AS objects`)).rows[0],
  })
  return { query, store, evidence, state, get dispatches() { return dispatches }, get rollbacks() { return rollbacks } }
}

function legacyEvidence(evidence) {
  const legacy = structuredClone(evidence)
  legacy.responseArchive.rawPayload.request.page = undefined
  for (const object of legacy.archiveObjects) object.rawPayload.request.page = undefined
  return legacy
}

for (const posts of [[], [{ post_id: 'safe-string-id', message: 'synthetic content' }]]) {
  test(`PostgreSQL stages the actual JustOne Facebook ${posts.length ? 'nonempty' : 'empty'} receipt without undefined JSONB drift`, postgres, async t => {
    const f = await fixture(t, posts), legacy = legacyEvidence(f.evidence)
    // The old producer hashed undefined as null but JSON serialization removed
    // its page key. Real SQL then disagreed with its in-memory receipt twice.
    await assert.rejects(f.store.stageProviderEvidence(legacy), { code: 'external_platform_evidence_conflict' })
    assert.equal(f.rollbacks, 2)
    assert.deepEqual(await f.state(), { call: { outcome: 'pending', http_status: null, business_code: null, error_code: null },
      usage: { status: 'reserved', error_code: null }, archives: { operational: 0, restricted: 0, objects: 0 } })

    assert.equal(f.evidence.responseArchive.rawPayload.request.page, null)
    assert.deepEqual(await f.store.stageProviderEvidence(f.evidence), { staged: true, reconciled: false, alreadySettled: false })
    assert.deepEqual(await f.store.stageProviderEvidence(f.evidence), { staged: true, reconciled: true, alreadySettled: false })
    assert.deepEqual(await f.state(), { call: { outcome: 'pending', http_status: 200, business_code: 0, error_code: null },
      usage: { status: 'reserved', error_code: null }, archives: { operational: 1, restricted: 1, objects: 1 } })
    const archive = (await f.query(`SELECT raw_payload,payload_sha256 FROM external_platform.response_archives`)).rows[0]
    assert.deepEqual(archive.raw_payload, f.evidence.responseArchive.rawPayload)
    assert.equal(archive.payload_sha256, legacy.responseArchive.payloadSha256)
    const restricted = (await f.query('SELECT body_bytes,body_sha256 FROM control.external_platform_restricted_raw_responses')).rows[0]
    assert.deepEqual(restricted.body_bytes, Buffer.from(f.evidence.restrictedResponseArchive.bodyBytes))
    assert.equal(restricted.body_sha256, legacy.restrictedResponseArchive.bodySha256)
    assert.equal(f.dispatches, 1)

    const conflicting = structuredClone(f.evidence)
    conflicting.responseArchive.rawPayload.request.page = 2
    await assert.rejects(f.store.stageProviderEvidence(conflicting), { code: 'external_platform_evidence_conflict' })
    assert.deepEqual((await f.query('SELECT raw_payload FROM external_platform.response_archives')).rows[0].raw_payload, archive.raw_payload)
  })
}

test('PostgreSQL reproduces the historical unknown call with accepted HTTP200 archives after legacy staging rollback', postgres, async t => {
  const f = await fixture(t), legacy = legacyEvidence(f.evidence)
  await assert.rejects(f.store.stageProviderEvidence(legacy), { code: 'external_platform_evidence_conflict' })
  // Historical catch passed evidence.errorCode=null into this terminalizer.
  // Keep that explicit input here to demonstrate the incident, independent of
  // any subsequent change to the workflow's failure classification.
  assert.equal(await f.store.markPersistenceUnknown(legacy), true)
  assert.deepEqual(await f.state(), { call: { outcome: 'unknown', http_status: null, business_code: null, error_code: null },
    usage: { status: 'unknown', error_code: null }, archives: { operational: 1, restricted: 1, objects: 1 } })
  assert.deepEqual((await f.query('SELECT contract_state,http_status,business_code FROM external_platform.response_archives')).rows[0],
    { contract_state: 'accepted', http_status: 200, business_code: 0 })
  assert.equal(f.dispatches, 1)
  // A code fix is not authorization to rewrite a historical unknown call.
  await assert.rejects(f.store.stageProviderEvidence(f.evidence), { code: 'external_platform_evidence_conflict' })
  assert.equal((await f.state()).usage.status, 'unknown')
})
