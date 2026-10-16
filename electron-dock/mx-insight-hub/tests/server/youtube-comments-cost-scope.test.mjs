import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const cost = { costMinor: 2, costKind: 'estimated', currency: 'USD', monthlyBudgetMinor: 100, monthlySubsidyBudgetMinor: 100 }

async function fixture(t, postgres) {
  const usage = { id: randomUUID(), tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(),
    fingerprint: 'a'.repeat(64), platform: 'youtube', status: 'reserved', billingMeterKey: 'social.comments.list',
    leaseExpiresAt: new Date(Date.now() + 120000).toISOString() }
  const input = { usageRequestId: usage.id, tenantId: usage.tenantId, consumerId: usage.consumerId, apiKeyId: usage.apiKeyId,
    fingerprint: usage.fingerprint, operation: 'native.t.api_4a6f21264dc0b4a1', contractVersion: 'mx-insight-hub.native-forwarding.v1',
    endpointKey: 'native.t.api_4a6f21264dc0b4a1', endpointVersion: 'youtube-comments.2026-10-17', marketplace: 'youtube' }
  if (!postgres) {
    const usageStore = { requests: new Map([[usage.id, structuredClone(usage)]]) }
    const stores = Object.fromEntries(['social', 'youtube'].map(authorizationPlatform => [authorizationPlatform,
      new MemoryExternalPlatformStore({ usageStore, providerKey: 'tikhub', authorizationPlatform })]))
    return { input, stores, setUsage: async changes => Object.assign(usageStore.requests.get(usage.id), usage, changes),
      counts: async () => ({ reservations: stores.youtube.costReservations.size + stores.social.costReservations.size,
        calls: stores.youtube.calls.size + stores.social.calls.size }) }
  }
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE TABLE tenants (id uuid PRIMARY KEY); CREATE TABLE consumers (id uuid PRIMARY KEY);
    CREATE TABLE api_keys (id uuid PRIMARY KEY);
    CREATE TABLE usage_requests (id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,fingerprint char(64),
      platform text,status text,billing_meter_key text,lease_expires_at timestamptz);
    CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs (id uuid PRIMARY KEY);
    CREATE SCHEMA billing;
    CREATE TABLE billing.customer_charges (id uuid,usage_request_id uuid,tenant_id uuid,consumer_id uuid,api_key_id uuid,
      account_id uuid,meter_key text,billing_unit text,enforcement_mode text,status text,quoted_minor bigint,currency char(3));
    CREATE TABLE billing.credit_ledger_entries (charge_id uuid,usage_request_id uuid,account_id uuid,tenant_id uuid,
      kind text,amount_minor bigint,available_delta_minor bigint,held_delta_minor bigint,currency char(3));`)
  for (const migration of ['051_external_platform_gateway.sql', '053_external_platform_uncertain_retry.sql',
    '055_external_platform_multi_call_rate_limit.sql', '057_external_platform_cost_reservations.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  await db.query('INSERT INTO tenants VALUES ($1)', [usage.tenantId])
  await db.query('INSERT INTO consumers VALUES ($1)', [usage.consumerId])
  await db.query('INSERT INTO api_keys VALUES ($1)', [usage.apiKeyId])
  await db.query(`INSERT INTO usage_requests VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [usage.id, usage.tenantId, usage.consumerId, usage.apiKeyId, usage.fingerprint, usage.platform, usage.status, usage.billingMeterKey, usage.leaseExpiresAt])
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
  const stores = Object.fromEntries(['social', 'youtube'].map(authorizationPlatform => [authorizationPlatform,
    new PostgresExternalPlatformStore({ pool, providerKey: 'tikhub', authorizationPlatform })]))
  return { input, stores,
    setUsage: async changes => {
      const row = { ...usage, ...changes }
      await db.query('UPDATE usage_requests SET status=$2,lease_expires_at=$3 WHERE id=$1', [usage.id, row.status, row.leaseExpiresAt])
    },
    counts: async () => ({
      reservations: (await db.query('SELECT count(*)::int count FROM external_platform.provider_cost_reservations')).rows[0].count,
      calls: (await db.query('SELECT count(*)::int count FROM external_platform.provider_calls')).rows[0].count,
    }) }
}

for (const postgres of [false, true]) {
  test(`${postgres ? 'PGlite' : 'Memory'} YouTube cost and call admission require the exact live usage scope`, {
    skip: postgres && !modulePath ? 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL scope checks' : false,
  }, async t => {
    const h = await fixture(t, postgres)
    const cases = [
      ['legacy social store', h.stores.social, {}, {}],
      ['wrong tenant', h.stores.youtube, { tenantId: randomUUID() }, {}],
      ['wrong consumer', h.stores.youtube, { consumerId: randomUUID() }, {}],
      ['wrong API Key', h.stores.youtube, { apiKeyId: randomUUID() }, {}],
      ['wrong fingerprint', h.stores.youtube, { fingerprint: 'b'.repeat(64) }, {}],
      ['released usage', h.stores.youtube, {}, { status: 'released' }],
      ['unknown usage', h.stores.youtube, {}, { status: 'unknown' }],
      ['expired usage', h.stores.youtube, {}, { leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }],
    ]
    for (const [name, store, changes, usageChanges] of cases) {
      await h.setUsage(usageChanges)
      const input = { ...h.input, ...changes }
      await assert.rejects(store.reserveProviderCostWorkflow({ ...input, costControls: [cost] }),
        { code: 'external_platform_usage_scope_mismatch' }, `${name}: procurement reservation`)
      await assert.rejects(store.beginProviderCall({ ...input, costControl: cost }),
        { code: 'external_platform_usage_scope_mismatch' }, `${name}: provider call`)
      assert.deepEqual(await h.counts(), { reservations: 0, calls: 0 }, `${name}: rejected work leaves no ledger rows`)
    }
    await h.setUsage({})
    const reservation = await h.stores.youtube.reserveProviderCostWorkflow({ ...h.input, costControls: [cost] })
    assert.equal(reservation.usageRequestId, h.input.usageRequestId)
    assert.equal(reservation.reservedCostMinor, 2)
    assert.deepEqual(await h.counts(), { reservations: 1, calls: 0 })
    const call = await h.stores.youtube.beginProviderCall({ ...h.input, costControl: cost, costReservationId: reservation.id })
    assert.ok(call.id)
    assert.deepEqual(await h.counts(), { reservations: 1, calls: 1 })
  })
}
