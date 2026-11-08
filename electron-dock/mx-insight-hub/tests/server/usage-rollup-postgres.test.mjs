import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'

import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import {
  USAGE_ROLLUP_VERSION, UsageRollupMaintainer, buildUsageRollup, compactUsageRollup, readUsageRollupState,
} from '../../server/stores/usage-rollup.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const skip = connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured'
const HOUR = 3_600_000

async function caller(service, tenant, platform) {
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: `Rollup ${platform}` })
  await service.putPlatformConfiguration(platform, { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 10_000, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: `Rollup ${platform}`, platforms: [platform], capabilities: [] })
  return { tenant, consumer, key }
}

async function tenantWith(service, mode) {
  const tenant = await service.createTenant({ name: `Usage rollup ${mode} ${randomUUID()}` })
  await service.setTenantBillingProfile(tenant.id, { mode, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'test-admin')
  if (mode === 'enforced') await service.addTenantCredit(tenant.id, { amountMinor: 100_000, currency: 'CNY', reason: 'Rollup test credit' }, { actor: 'test', idempotencyKey: randomUUID() })
  return tenant
}

function requestFor(owner, platform, meterKey = platform) {
  return { requestId: randomUUID(), idempotencyKey: randomUUID(), fingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    tenantId: owner.tenant.id, consumerId: owner.consumer.id, apiKeyId: owner.key.id, platform, meterKey, unitsReserved: 1,
    maxRequests: 10_000, windowStart: new Date(Date.now() - HOUR), leaseExpiresAt: new Date(Date.now() + 60_000) }
}

// Mixed outcomes, units, latencies (incl. null) and meters for one owner.
async function traffic(store, owner, platform, count, offset = 0) {
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const input = requestFor(owner, platform, index % 3 === 0 ? `${platform}.detail` : platform)
    await store.reserve(input)
    ids.push(input.requestId)
    const kind = (index + offset) % 5
    if (kind === 0 || kind === 1) {
      await store.commitRequest(input.requestId, { responseStatus: 200, responseBody: { data: { items: [] } },
        unitsActual: 1 + (index % 4), upstreamLatencyMs: kind === 0 ? 100 + index * 7 : null })
    } else if (kind === 2) await store.releaseRequest(input.requestId, 'definitive_failure')
    else if (kind === 3) await store.markRequestUnknown(input.requestId, 'outcome_unknown')
    // kind 4 stays reserved
  }
  return ids
}

// Every filter shape callers use: platform-wide, owner scopes, aligned and
// unaligned windows, a window inside one hour, reversed and one-sided bounds.
function filterMatrix(owners, now) {
  const hour = Math.floor(now / HOUR) * HOUR
  const iso = value => new Date(value).toISOString()
  const windows = [
    {},
    { from: iso(hour - 5 * HOUR), to: iso(hour + HOUR) },
    { from: iso(hour - 5 * HOUR + 17 * 60_000), to: iso(now + 1000) },
    { from: iso(hour - 3 * HOUR + 60_000), to: iso(hour - 3 * HOUR + 50 * 60_000) },
    { from: iso(now + 1000), to: iso(hour - 2 * HOUR) },
    { from: iso(hour - 2 * HOUR + 1) },
    { to: iso(hour - HOUR + 123) },
  ]
  const scopes = [{}, { tenantId: owners[0].tenant.id }, { consumerId: owners[1].consumer.id },
    { apiKeyId: owners[2].key.id }, { tenantId: owners[3].tenant.id, consumerId: owners[3].consumer.id }]
  return scopes.flatMap(scope => windows.map(window => ({ ...scope, ...window })))
}

async function assertSameAsHistory(store, filters, label) {
  for (const filter of filters) {
    const [history, current] = [await store.usage(filter, { rollup: false }), await store.usage(filter)]
    assert.deepEqual(current, history, `${label}: ${JSON.stringify(filter)}`)
  }
}

async function setPending(pool) {
  await pool.query("UPDATE reporting.usage_rollup_state SET status = 'pending', definition_version = 0")
}

test('hourly usage statistics equal the history queries through build, deltas, compaction, hour moves and reconciliation', { skip }, async () => {
  const pool = new pg.Pool({ connectionString })
  const store = new PostgresStore(pool)
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'usage-rollup-postgres-pepper-at-least-32-bytes' })
  try {
    // The statistics triggers fire before every billing trigger that changes a charge.
    const triggers = (await pool.query(`SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.usage_requests'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows.map(row => row.tgname)
    for (const billing of triggers.filter(name => /_(reserve|settle)_/u.test(name))) {
      assert.ok(triggers.indexOf('usage_requests_report_update') < triggers.indexOf(billing), billing)
      assert.ok(triggers.indexOf('usage_requests_report_insert_delete') < triggers.indexOf(billing), billing)
    }

    await setPending(pool)
    const enforced = await tenantWith(service, 'enforced'), shadow = await tenantWith(service, 'shadow')
    const owners = [await caller(service, enforced, 'weibo'), await caller(service, enforced, 'telegram'),
      await caller(service, shadow, 'weibo'), await caller(service, shadow, 'telegram')]
    const ids = []
    for (const [index, owner] of owners.entries()) ids.push(...await traffic(store, owner, index % 2 ? 'telegram' : 'weibo', 12, index))
    // Capability-only requests have no platform (migration 018): one inserted
    // that way, two converted from platform rows (NULL in old/new deltas).
    await pool.query(`INSERT INTO usage_requests (id, tenant_id, consumer_id, api_key_id, idempotency_key, fingerprint,
        capability, billing_meter_key, status, units_reserved, upstream_latency_ms)
      VALUES ($1, $2, $3, $4, $5, $6, 'nlp.tokenize', NULL, 'reserved', 1, 12)`,
    [randomUUID(), owners[0].tenant.id, owners[0].consumer.id, owners[0].key.id, randomUUID(), 'c'.repeat(64)])
    await pool.query(`UPDATE usage_requests SET platform = NULL, capability = 'nlp.tokenize'
      WHERE id = ANY($1::uuid[])`, [[ids[1], ids[14]]])
    // Spread rows over earlier hours (a request moving hour also moves its charge).
    await pool.query(`UPDATE usage_requests SET created_at = created_at - make_interval(mins => ((ord * 37) % 360)::int)
      FROM unnest($1::uuid[]) WITH ORDINALITY AS moved(id, ord) WHERE usage_requests.id = moved.id`, [ids])
    const filters = filterMatrix(owners, Date.now())

    assert.equal((await readUsageRollupState(pool)).status, 'pending')
    await assertSameAsHistory(store, filters, 'before build')

    const built = await buildUsageRollup(pool)
    assert.equal(built.built, true)
    assert.deepEqual(await pool.query('SELECT count(*)::int AS n FROM reporting.usage_request_deltas').then(r => r.rows[0].n), 0)
    const state = await readUsageRollupState(pool)
    assert.deepEqual([state.status, state.definition_version], ['ready', USAGE_ROLLUP_VERSION])
    await assertSameAsHistory(store, filters, 'after build')

    // New traffic and transitions of old rows stay pending as deltas.
    const later = await traffic(store, owners[0], 'weibo', 7, 2)
    const reservedEarlier = (await pool.query(`SELECT id FROM usage_requests WHERE id = ANY($1::uuid[]) AND status = 'reserved' LIMIT 2`, [ids])).rows
    await store.commitRequest(reservedEarlier[0].id, { responseStatus: 200, responseBody: { ok: true }, unitsActual: 9, upstreamLatencyMs: 55 })
    await store.markRequestUnknown(reservedEarlier[1].id, 'outcome_unknown')
    // An ambiguous commit: committed → unknown keeps the captured charge.
    const committedEarlier = (await pool.query(`SELECT id FROM usage_requests WHERE id = ANY($1::uuid[]) AND status = 'committed' LIMIT 1`, [ids])).rows[0]
    await store.markRequestUnknown(committedEarlier.id, 'usage_commit_ambiguous')
    await pool.query(`UPDATE usage_requests SET created_at = created_at - interval '2 hours' WHERE id = $1`, [later[0]])
    assert.ok(await pool.query('SELECT count(*)::int AS n FROM reporting.usage_request_deltas').then(r => r.rows[0].n) > 0)
    await assertSameAsHistory(store, filters, 'pending deltas')

    const compacted = await compactUsageRollup(pool)
    assert.ok(compacted.moved > 0)
    assert.equal(await pool.query('SELECT count(*)::int AS n FROM reporting.usage_request_deltas').then(r => r.rows[0].n), 0)
    await assertSameAsHistory(store, filters, 'after compaction')

    // Operator reconciliation changes only the charge of an unknown request.
    const unknownCharge = (await pool.query(`SELECT charge.usage_request_id FROM billing.customer_charges charge
      JOIN usage_requests request ON request.id = charge.usage_request_id
      WHERE request.tenant_id = $1 AND charge.status = 'unknown' AND charge.enforcement_mode = 'enforced' LIMIT 1`, [enforced.id])).rows[0]
    await store.reconcileUnknownCustomerCharge({ usageRequestId: unknownCharge.usage_request_id, disposition: 'capture',
      idempotencyKey: `rollup-${randomUUID()}`, actor: 'test', reason: 'Rollup reconciliation coverage' })
    await assertSameAsHistory(store, filters, 'after reconciliation')
    await compactUsageRollup(pool)
    await assertSameAsHistory(store, filters, 'reconciliation compacted')
    // Zero-net groups are pruned; totals never go negative.
    assert.equal(await pool.query('SELECT count(*)::int AS n FROM reporting.usage_request_totals WHERE requests <= 0').then(r => r.rows[0].n), 0)
    assert.equal(await pool.query('SELECT count(*)::int AS n FROM reporting.customer_charge_totals WHERE charges <= 0').then(r => r.rows[0].n), 0)
  } finally { await pool.end() }
})

test('a change committed while the baseline is built is counted exactly once', { skip }, async () => {
  const pool = new pg.Pool({ connectionString })
  const store = new PostgresStore(pool)
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'usage-rollup-postgres-pepper-at-least-32-bytes' })
  const open = await pool.connect()
  try {
    const owner = await caller(service, await tenantWith(service, 'enforced'), 'weibo')
    const [reserved] = await traffic(store, owner, 'weibo', 1, 4)
    const committedBefore = await traffic(store, owner, 'weibo', 3, 0)
    await setPending(pool)
    // In flight across the build: invisible to its snapshot, committed after it.
    await open.query('BEGIN')
    await open.query(`UPDATE usage_requests SET status = 'committed', units_actual = 4, upstream_latency_ms = 40, completed_at = now()
      WHERE id = $1`, [reserved])
    assert.equal((await buildUsageRollup(pool)).built, true)
    // The compactor never moves an uncommitted delta either.
    await compactUsageRollup(pool)
    await open.query('COMMIT')
    const filters = [{}, { apiKeyId: owner.key.id }, { tenantId: owner.tenant.id, from: new Date(Date.now() - HOUR).toISOString() }]
    await assertSameAsHistory(store, filters, 'concurrent commit')
    await compactUsageRollup(pool)
    await assertSameAsHistory(store, filters, 'concurrent commit compacted')
    const scoped = await store.usage({ apiKeyId: owner.key.id })
    assert.deepEqual([scoped.requests, scoped.committed], [1 + committedBefore.length, 1 + committedBefore.filter((_, i) => i % 5 < 2).length])
  } finally {
    await open.query('ROLLBACK').catch(() => {})
    open.release()
    await pool.end()
  }
})

test('owner-scoped recent requests read only the hours holding the newest rows', { skip }, async () => {
  const pool = new pg.Pool({ connectionString })
  const store = new PostgresStore(pool)
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'usage-rollup-postgres-pepper-at-least-32-bytes' })
  try {
    const sparse = await caller(service, await tenantWith(service, 'enforced'), 'weibo')
    const dense = await caller(service, await tenantWith(service, 'shadow'), 'weibo')
    // Sparse: 6 requests spread over 6 days; dense: 70 in the last hours.
    const sparseIds = await traffic(store, sparse, 'weibo', 6)
    await pool.query(`UPDATE usage_requests SET created_at = now() - make_interval(days => ord::int)
      FROM unnest($1::uuid[]) WITH ORDINALITY AS moved(id, ord) WHERE usage_requests.id = moved.id`, [sparseIds])
    const denseIds = await traffic(store, dense, 'weibo', 70, 1)
    await pool.query(`UPDATE usage_requests SET created_at = now() - make_interval(mins => (ord * 3)::int)
      FROM unnest($1::uuid[]) WITH ORDINALITY AS moved(id, ord) WHERE usage_requests.id = moved.id`, [denseIds])
    if ((await readUsageRollupState(pool)).status !== 'ready') await buildUsageRollup(pool)
    const now = Date.now()
    const filters = [{ apiKeyId: sparse.key.id }, { consumerId: dense.consumer.id }, { tenantId: dense.tenant.id },
      { apiKeyId: dense.key.id, from: new Date(now - 2 * HOUR - 61_000).toISOString(), to: new Date(now - 20 * 60_000).toISOString() },
      { apiKeyId: sparse.key.id, from: new Date(now - 3.5 * 86_400_000).toISOString() }]
    await assertSameAsHistory(store, filters, 'recent rows')
    assert.equal((await store.usage({ apiKeyId: dense.key.id })).recentRequests.length, 50)
    assert.equal((await store.usage({ apiKeyId: sparse.key.id })).recentRequests.length, 6)
    await compactUsageRollup(pool)
    await assertSameAsHistory(store, filters, 'recent rows compacted')
  } finally { await pool.end() }
})

test('the maintainer builds once, compacts afterwards and backs off after a failed build', { skip }, async () => {
  const pool = new pg.Pool({ connectionString })
  const logs = []
  const logger = { info: message => logs.push(message), warn: message => logs.push(message) }
  try {
    await setPending(pool)
    let clock = 1_000
    const maintainer = new UsageRollupMaintainer(pool, { logger, buildRetryMs: 60_000, now: () => clock })
    assert.equal((await maintainer.runOnce()).built, true)
    assert.equal((await readUsageRollupState(pool)).status, 'ready')
    assert.ok('moved' in await maintainer.runOnce())

    // A failing build (lock timeout behind an exclusive lock) leaves the
    // history queries in charge and waits before retrying.
    await setPending(pool)
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE reporting.usage_request_totals IN ACCESS EXCLUSIVE MODE')
      assert.equal((await maintainer.runOnce()).failed, true)
      assert.equal((await maintainer.runOnce()).skipped, 'retry_wait')
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    clock += 60_001
    assert.equal((await maintainer.runOnce()).built, true)
    assert.ok(logs.some(message => /build failed/u.test(message)))
  } finally { await pool.end() }
})

test('an inconsistent total falls back to the exact history queries and is rebuilt', { skip }, async () => {
  const pool = new pg.Pool({ connectionString })
  const store = new PostgresStore(pool)
  try {
    if ((await readUsageRollupState(pool)).status !== 'ready') await buildUsageRollup(pool)
    await compactUsageRollup(pool)
    const exact = await store.usage({}, { rollup: false })
    // A write the triggers never saw, e.g. a bulk repair with triggers disabled.
    await pool.query(`INSERT INTO reporting.usage_request_deltas
      SELECT bucket, tenant_id, consumer_id, api_key_id, platform, capability, meter_key, status,
             -requests - 1, -units, -latency_sum, -latency_count
        FROM reporting.usage_request_totals ORDER BY bucket LIMIT 1`)
    const compacted = await compactUsageRollup(pool)
    assert.equal(compacted.invalidated, 'usage_request_totals')
    assert.equal((await readUsageRollupState(pool)).status, 'pending')
    assert.deepEqual(await store.usage({}), exact, 'served from history while pending')
    assert.equal((await new UsageRollupMaintainer(pool, { logger: {} }).runOnce()).built, true)
    assert.deepEqual(await store.usage({}), exact)
  } finally { await pool.end() }
})
