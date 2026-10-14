import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { HUB_SOCIAL_VERSION } from '../../server/contracts/hub-social.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const PATH = '/api/v1/data/search'
const fingerprint = 'a'.repeat(64)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const ago = milliseconds => new Date(Date.now() - milliseconds).toISOString()

async function fixture(t, postgres) {
  const input = { callId: randomUUID(), tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(), path: PATH }
  const sourceId = randomUUID(), targetId = randomUUID(), accountId = randomUUID()
  const capturedAt = ago(1000)
  // Keep the complete root and its timeline wrapper, not only root.data.
  const payload = { entries: [{ type: 'TimelineAddEntries', entries: [{ content: { cursorType: 'Bottom', value: 'fixture' } }] }], metadata: { marker: 'root' } }
  const bodyBytes = Buffer.from('\uFEFF' + JSON.stringify(payload))
  const archive = { bodyBytes, bodySize: bodyBytes.length, bodySha256: digest(bodyBytes), capturedAt }
  const source = { id: sourceId, tenantId: input.tenantId, consumerId: input.consumerId, apiKeyId: input.apiKeyId,
    platform: 'twitter', status: 'committed', responseStatus: 200, fingerprint: 'b'.repeat(64),
    acquisitionRequest: { path: PATH }, responseBody: { immutable: 'original delivery' }, unitsActual: 20 }
  const target = { ...source, id: targetId, status: 'reserved', responseStatus: null, responseBody: null, fingerprint, unitsActual: null }
  const call = { id: input.callId, usageRequestId: sourceId, tenantId: input.tenantId, consumerId: input.consumerId, apiKeyId: input.apiKeyId,
    providerKey: 'rapidapi', operation: 'social.content.search', endpointKey: 'twitter-aio.search', endpointVersion: 'twitter-aio.hub.v1',
    contractVersion: HUB_SOCIAL_VERSION, outcome: 'succeeded', httpStatus: 200, completedAt: capturedAt }
  const delivery = { usageRequestId: targetId, tenantId: input.tenantId, consumerId: input.consumerId, apiKeyId: input.apiKeyId,
    operation: 'social.content.search', fingerprint }
  const saved = { delivery, sourceCallId: input.callId, sourceMode: 'fresh_cache', capturedAt,
    responseBody: { data: { items: [{ id: '9007199254740993' }] } }, usageUnitsActual: 1 }
  if (!postgres) {
    const usageStore = new MemoryStore()
    usageStore.requests.set(sourceId, structuredClone(source))
    usageStore.requests.set(targetId, structuredClone(target))
    usageStore.creditAccounts.set(input.tenantId, { id: accountId, availableMinor: 91, heldMinor: 9, revision: 1, currency: 'CNY' })
    usageStore.customerCharges.set(targetId, { id: randomUUID(), usageRequestId: targetId, accountId,
      tenantId: input.tenantId, enforcementMode: 'enforced', status: 'reserved', quotedMinor: 9, currency: 'CNY' })
    const store = new MemoryExternalPlatformStore({ usageStore, providerKey: 'rapidapi' })
    store.calls.set(input.callId, structuredClone(call))
    store.restrictedResponseArchives.set(input.callId, structuredClone(archive))
    return { input, payload, archive, source, target, call, saved, store,
      setCall: async changes => Object.assign(store.calls.get(input.callId), changes),
      setUsage: async (id, changes) => Object.assign(usageStore.requests.get(id), changes),
      setArchive: async changes => Object.assign(store.restrictedResponseArchives.get(input.callId), changes),
      getUsage: async id => structuredClone(usageStore.requests.get(id)),
      counts: async () => ({ calls: store.calls.size, gateways: store.requests.length, captures: usageStore.creditLedgerEntries.length,
        sourceCallId: store.requests[0]?.providerCallId, charge: usageStore.customerCharges.get(targetId).status }),
    }
  }
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control; CREATE SCHEMA billing;
    CREATE TABLE usage_requests (id uuid PRIMARY KEY, tenant_id uuid, consumer_id uuid, api_key_id uuid,
      platform text, status text, response_status int, fingerprint char(64), acquisition_request jsonb, response_body jsonb,
      units_actual int, upstream_latency_ms int, delivery_source_mode text, response_captured_at timestamptz, completed_at timestamptz);
    CREATE TABLE external_platform.provider_calls (id uuid PRIMARY KEY, usage_request_id uuid REFERENCES usage_requests,
      tenant_id uuid, consumer_id uuid, api_key_id uuid, provider_key text, operation text, endpoint_key text,
      endpoint_version text, contract_version text, outcome text, http_status int, completed_at timestamptz);
    CREATE TABLE control.external_platform_restricted_raw_responses (provider_call_id uuid REFERENCES external_platform.provider_calls,
      body_bytes bytea, body_sha256 text, body_size int, captured_at timestamptz);
    CREATE TABLE external_platform.gateway_requests (id uuid, provider_key text, tenant_id uuid, consumer_id uuid,
      usage_request_id uuid REFERENCES usage_requests, request_fingerprint text, source_mode text, succeeded boolean,
      response_status int, provider_call_id uuid REFERENCES external_platform.provider_calls, snapshot_id uuid, error_code text);
    CREATE TABLE billing.customer_charges (id uuid, usage_request_id uuid, tenant_id uuid, account_id uuid, status text,
      enforcement_mode text, quoted_minor int, currency text, charged_minor int, settled_at timestamptz);
    CREATE TABLE billing.credit_ledger_entries (account_id uuid, tenant_id uuid, charge_id uuid, usage_request_id uuid,
      kind text, amount_minor int, available_delta_minor int, held_delta_minor int, currency text, idempotency_key text UNIQUE,
      actor text, reason text);`)
  // Exercise the existing production settlement function, not a test imitation.
  const migration = await readFile(new URL('../../migrations/056_commercial_billing_ledger.sql', import.meta.url), 'utf8')
  const settlement = migration.match(/CREATE OR REPLACE FUNCTION billing\.settle_customer_charge\(\)[\s\S]*?EXECUTE FUNCTION billing\.settle_customer_charge\(\);/u)?.[0]
  assert.ok(settlement)
  await db.exec(settlement)
  const columns = { usageRequestId: 'usage_request_id', tenantId: 'tenant_id', consumerId: 'consumer_id', apiKeyId: 'api_key_id',
    providerKey: 'provider_key', endpointKey: 'endpoint_key', endpointVersion: 'endpoint_version', contractVersion: 'contract_version',
    httpStatus: 'http_status', completedAt: 'completed_at', responseStatus: 'response_status', responseBody: 'response_body',
    acquisitionRequest: 'acquisition_request', unitsActual: 'units_actual', bodyBytes: 'body_bytes', bodySize: 'body_size',
    bodySha256: 'body_sha256', capturedAt: 'captured_at' }
  const sqlValue = value => value && typeof value === 'object' && !(value instanceof Uint8Array) ? JSON.stringify(value) : value
  const insert = async (table, data) => {
    const entries = Object.entries(data)
    await db.query(`INSERT INTO ${table} (${entries.map(([key]) => columns[key] || key).join(',')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(',')})`, entries.map(([, value]) => sqlValue(value)))
  }
  const update = async (table, idColumn, id, changes) => {
    const entries = Object.entries(changes)
    await db.query(`UPDATE ${table} SET ${entries.map(([key], i) => `${columns[key] || key}=$${i + 2}`).join(',')} WHERE ${idColumn}=$1`, [id, ...entries.map(([, value]) => sqlValue(value))])
  }
  await insert('usage_requests', source)
  await insert('usage_requests', target)
  await insert('external_platform.provider_calls', call)
  await insert('control.external_platform_restricted_raw_responses', { provider_call_id: input.callId, ...archive })
  await insert('billing.customer_charges', { id: randomUUID(), usage_request_id: targetId, tenant_id: input.tenantId, account_id: accountId,
    status: 'reserved', enforcement_mode: 'enforced', quoted_minor: 9, currency: 'CNY' })
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
  const store = new PostgresExternalPlatformStore({ pool, providerKey: 'rapidapi' })
  return { input, payload, archive, source, target, call, saved, store, db,
    setCall: changes => update('external_platform.provider_calls', 'id', input.callId, changes),
    setUsage: async (id, changes) => {
      // Seed adversarial states without settling their fixture holds. The
      // delivery under test always runs with the production trigger enabled.
      await db.exec('ALTER TABLE usage_requests DISABLE TRIGGER usage_requests_settle_customer_charge')
      try { await update('usage_requests', 'id', id, changes) }
      finally { await db.exec('ALTER TABLE usage_requests ENABLE TRIGGER usage_requests_settle_customer_charge') }
    },
    setArchive: changes => update('control.external_platform_restricted_raw_responses', 'provider_call_id', input.callId, changes),
    getUsage: async id => {
      const row = (await db.query('SELECT * FROM usage_requests WHERE id=$1', [id])).rows[0]
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [Object.entries(columns).find(([, column]) => column === key)?.[0] || key,
        value instanceof Date ? value.toISOString() : value]))
    },
    counts: async () => ({ calls: (await db.query('SELECT count(*)::int n FROM external_platform.provider_calls')).rows[0].n,
      gateways: (await db.query('SELECT count(*)::int n FROM external_platform.gateway_requests')).rows[0].n,
      captures: (await db.query('SELECT count(*)::int n FROM billing.credit_ledger_entries')).rows[0].n,
      sourceCallId: (await db.query('SELECT provider_call_id FROM external_platform.gateway_requests')).rows[0]?.provider_call_id,
      charge: (await db.query('SELECT status FROM billing.customer_charges')).rows[0].status }),
  }
}

for (const postgres of [false, true]) {
  const name = postgres ? 'PostgreSQL' : 'memory'
  const options = { skip: postgres && !modulePath ? 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local @electric-sql/pglite module' : false }
  test(`${name} Twitter buffer reads verify exact archive integrity and original acquisition scope`, options, async t => {
    const f = await fixture(t, postgres)
    const read = () => f.store.twitterPageFor(f.input)
    assert.deepEqual(await read(), { payload: f.payload, capturedAt: f.archive.capturedAt })
    for (const field of ['callId', 'tenantId', 'consumerId', 'apiKeyId', 'path']) {
      assert.equal(await f.store.twitterPageFor({ ...f.input, [field]: field === 'path' ? '/api/v1/search/raw' : randomUUID() }), null, field)
    }
    for (const changes of [{ providerKey: 'tikhub' }, { operation: 'social.account.posts' }, { endpointKey: 'twitter-aio.user-tweets' },
      { endpointVersion: 'unreviewed' }, { contractVersion: 'unreviewed' }, { outcome: 'succeeded_unusable' }, { outcome: 'rejected' },
      { outcome: 'unknown' }, { outcome: 'pending' }, { httpStatus: 201 }, { completedAt: ago(25 * 3600000) }, { completedAt: ago(-3600000) },
      { tenantId: randomUUID() }, { consumerId: randomUUID() }, { apiKeyId: randomUUID() }]) {
      await f.setCall(changes)
      assert.equal(await read(), null, JSON.stringify(changes))
      await f.setCall(f.call)
    }
    for (const changes of [{ platform: 'instagram' }, { status: 'unknown' }, { status: 'released' }, { responseStatus: 502 },
      { tenantId: randomUUID() }, { consumerId: randomUUID() }, { apiKeyId: randomUUID() }, { acquisitionRequest: { path: '/api/v1/search/raw' } }]) {
      await f.setUsage(f.source.id, changes)
      assert.equal(await read(), null, JSON.stringify(changes))
      await f.setUsage(f.source.id, f.source)
    }
    for (const changes of [{ bodySha256: null }, { bodySha256: '0'.repeat(64) }, { bodySize: f.archive.bodySize + 1 },
      { capturedAt: ago(25 * 3600000) }, { capturedAt: ago(-3600000) }]) {
      await f.setArchive(changes)
      assert.equal(await read(), null, JSON.stringify(changes))
      await f.setArchive(f.archive)
    }
    for (const bytes of [Buffer.from([0xff]), Buffer.from('invalid json'), Buffer.from('[]'), Buffer.from('null'), Buffer.from('{"value":"\\u0000"}'),
      Buffer.from(JSON.stringify({ value: 'a'.repeat(4 * 1024 * 1024) }))]) {
      await f.setArchive({ bodyBytes: bytes, bodySize: bytes.length, bodySha256: digest(bytes) })
      assert.equal(await read(), null)
    }
    await f.setArchive(f.archive)
    const otherStore = postgres ? new PostgresExternalPlatformStore({ pool: f.store.pool, providerKey: 'tikhub' })
      : new MemoryExternalPlatformStore({ usageStore: f.store.usageStore, providerKey: 'tikhub' })
    assert.equal(await otherStore.twitterPageFor(f.input), null)
  })

  test(`${name} Twitter buffered delivery settles only its matching reservation and preserves original purchase`, options, async t => {
    const f = await fixture(t, postgres)
    const original = await f.getUsage(f.source.id)
    for (const changes of [{ sourceCallId: randomUUID() }, { capturedAt: ago(2000) }, { sourceMode: 'live' },
      { usageUnitsActual: -1 }, { usageUnitsActual: 101 }, { delivery: { ...f.saved.delivery, apiKeyId: randomUUID() } }]) {
      await assert.rejects(f.store.commitTwitterPage({ ...f.saved, ...changes }), { code: 'search_page_unavailable' })
      assert.equal((await f.getUsage(f.target.id)).status, 'reserved')
    }
    for (const changes of [{ platform: 'instagram' }, { status: 'unknown' }, { tenantId: randomUUID() }, { consumerId: randomUUID() },
      { apiKeyId: randomUUID() }, { fingerprint: 'c'.repeat(64) }, { acquisitionRequest: { path: '/api/v1/search/raw' } }]) {
      await f.setUsage(f.target.id, changes)
      await assert.rejects(f.store.commitTwitterPage(f.saved), { code: 'usage_request_state_conflict' })
      assert.equal((await f.counts()).gateways, 0)
      assert.equal((await f.counts()).captures, 0)
      await f.setUsage(f.target.id, f.target)
    }
    // A bad source cannot become a success through this delivery-only method.
    await f.setCall({ outcome: 'succeeded_unusable' })
    await assert.rejects(f.store.commitTwitterPage(f.saved), { code: 'search_page_unavailable' })
    await f.setCall(f.call)
    if (postgres) {
      await f.db.exec('ALTER TABLE external_platform.gateway_requests ADD CONSTRAINT force_gateway_failure CHECK (false)')
      await assert.rejects(f.store.commitTwitterPage(f.saved))
      assert.equal((await f.getUsage(f.target.id)).status, 'reserved')
      assert.equal((await f.counts()).captures, 0, 'customer settlement rolls back with provenance insert')
      assert.equal((await f.counts()).charge, 'reserved')
      await f.db.exec('ALTER TABLE external_platform.gateway_requests DROP CONSTRAINT force_gateway_failure')
    }
    await f.store.commitTwitterPage(f.saved)
    const delivered = await f.getUsage(f.target.id)
    assert.equal(delivered.status, 'committed')
    assert.equal(delivered.responseStatus, 200)
    assert.equal(delivered.upstreamLatencyMs ?? delivered.upstream_latency_ms, 0)
    assert.equal(delivered.unitsActual, 1)
    assert.deepEqual(delivered.responseBody, f.saved.responseBody)
    assert.equal(new Date(delivered.capturedAt ?? delivered.response_captured_at).toISOString(), f.archive.capturedAt)
    assert.deepEqual(await f.getUsage(f.source.id), original)
    assert.deepEqual(await f.counts(), { calls: 1, gateways: 1, captures: 1, sourceCallId: f.input.callId, charge: 'captured' })
    await assert.rejects(f.store.commitTwitterPage(f.saved), { code: 'usage_request_state_conflict' })
    assert.equal((await f.counts()).captures, 1)
  })
}
