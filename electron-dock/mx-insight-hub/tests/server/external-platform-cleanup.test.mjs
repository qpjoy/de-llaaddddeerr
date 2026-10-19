import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { createHubPostgresPool } from '../../server/core/postgres-pool.mjs'

function fixture({ providerKey = 'justone', idleCount = 1, waitingCount = 0,
  acquired = true, queryFailure = false, rollbackFailure = false, commitFailure = false } = {}) {
  const queries = [], releases = []
  let connects = 0
  const error = Object.assign(new Error('synthetic lock timeout'), { code: '55P03' })
  const rollbackError = new Error('synthetic rollback connection loss')
  const commitError = new Error('synthetic lost COMMIT acknowledgement')
  const store = new PostgresExternalPlatformStore({ providerKey, authorizationPlatform: 'ecommerce', pool: {
    idleCount, waitingCount,
    connect: async () => {
      connects++
      return { query: async (sql, params) => {
        queries.push({ sql, params })
        if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired }] }
        if (sql.includes('UPDATE external_platform.provider_cost_reservations') || sql.includes('DELETE FROM external_platform.dispatch_leases')) {
          if (queryFailure) throw error
          return { rows: [{ id: params[0] }], rowCount: 1 }
        }
        if (sql === 'ROLLBACK' && rollbackFailure) throw rollbackError
        if (sql === 'COMMIT' && commitFailure) throw commitError
        return { rows: [] }
      }, release: error => releases.push(error) }
    },
  } })
  const cost = { reservationId: randomUUID(), usageRequestId: randomUUID(), bestEffortRelease: true }
  const lease = { consumerId: randomUUID(), operation: 'search', fingerprint: 'f'.repeat(64),
    ownerRequestId: cost.usageRequestId, bestEffortRelease: true }
  return { store, cost, lease, queries, releases, error, rollbackError, commitError, connects: () => connects }
}

test('post-delivery cleanup skips a busy pool without enqueueing another database operation', async () => {
  for (const pressure of [{ idleCount: 0 }, { waitingCount: 1 }]) {
    const f = fixture(pressure)
    assert.equal(await f.store.releaseProviderCostWorkflow(f.cost), false)
    assert.equal(await f.store.releaseDispatchLease(f.lease), false)
    assert.equal(f.connects(), 0)
    assert.deepEqual(f.queries, [])
  }
})

test('post-delivery cost cleanup never waits for the provider budget advisory lock', async () => {
  for (const providerKey of ['justone', 'tikhub', 'rapidapi', 'websearch']) {
    const f = fixture({ providerKey, acquired: false })
    assert.equal(await f.store.releaseProviderCostWorkflow(f.cost), false)
    assert.deepEqual(f.queries.slice(0, 4).map(row => row.sql), ['BEGIN', "SET LOCAL lock_timeout = '100ms'",
      "SET LOCAL statement_timeout = '500ms'", 'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired'])
    assert.deepEqual(f.queries[3].params, [`external-platform-cost:${providerKey}`])
    assert.ok(f.queries.every(row => !row.sql.includes('UPDATE') && !row.sql.includes('pg_advisory_xact_lock(')))
    assert.equal(f.queries.at(-1).sql, 'COMMIT')
  }
})

test('post-delivery dispatch cleanup skips locked leases and retains exact owner scope', async () => {
  const f = fixture()
  assert.equal(await f.store.releaseDispatchLease(f.lease), true)
  assert.deepEqual(f.queries.slice(0, 3).map(row => row.sql), ['BEGIN', "SET LOCAL lock_timeout = '100ms'",
    "SET LOCAL statement_timeout = '500ms'"])
  const deletion = f.queries.find(row => row.sql.includes('DELETE FROM external_platform.dispatch_leases'))
  assert.match(deletion.sql, /FOR UPDATE SKIP LOCKED/)
  assert.match(deletion.sql, /owner_request_id = \$4/)
  assert.deepEqual(deletion.params, [f.lease.consumerId, f.lease.operation, f.lease.fingerprint, f.lease.ownerRequestId])
  assert.equal(f.queries.at(-1).sql, 'COMMIT')
})

test('strict pre-dispatch cost release retains blocking admission even when the pool is busy', async () => {
  const f = fixture({ idleCount: 0, waitingCount: 4 })
  assert.equal(await f.store.releaseProviderCostWorkflow({ ...f.cost, bestEffortRelease: false }), true)
  assert.equal(f.connects(), 1)
  assert.equal(f.queries[1].sql, 'SELECT pg_advisory_xact_lock(hashtext($1))')
  assert.ok(f.queries.every(row => !row.sql.includes('SET LOCAL') && !row.sql.includes('pg_try_advisory')))
})

test('post-delivery cleanup faults roll back and discard connections when rollback is lost', async () => {
  for (const operation of ['releaseProviderCostWorkflow', 'releaseDispatchLease']) {
    for (const rollbackFailure of [false, true]) {
      const f = fixture({ queryFailure: true, rollbackFailure })
      await assert.rejects(f.store[operation](operation === 'releaseDispatchLease' ? f.lease : f.cost), error => error === f.error)
      assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
      assert.deepEqual(f.releases, [rollbackFailure ? f.rollbackError : null])
      assert.ok(f.queries.every(row => row.sql !== 'COMMIT'))
    }
  }
})

test('lost cleanup commit acknowledgement discards the connection without retrying a write', async () => {
  for (const operation of ['releaseProviderCostWorkflow', 'releaseDispatchLease']) {
    const f = fixture({ commitFailure: true })
    await assert.rejects(f.store[operation](operation === 'releaseDispatchLease' ? f.lease : f.cost), error => error === f.commitError)
    assert.deepEqual(f.releases, [f.commitError])
    assert.equal(f.queries.filter(row => /UPDATE external_platform.provider_cost_reservations|DELETE FROM external_platform.dispatch_leases/.test(row.sql)).length, 1)
    assert.equal(f.queries.at(-1).sql, 'COMMIT')
  }
})

async function memoryLeaseFixture() {
  const tenantId = randomUUID(), consumerId = randomUUID(), ownerRequestId = randomUUID(), replacementId = randomUUID()
  const fingerprint = 'f'.repeat(64)
  const previous = { id: ownerRequestId, tenantId, consumerId, platform: 'ecommerce', fingerprint, status: 'reserved' }
  const replacement = { ...previous, id: replacementId }
  const usageStore = { requests: new Map([[ownerRequestId, previous], [replacementId, replacement]]) }
  const store = new MemoryExternalPlatformStore({ usageStore })
  const lease = { consumerId, operation: 'ecommerce.products.search', fingerprint, ownerRequestId,
    endpointKey: 'jd.product-search.v1', contractVersion: 'v1', expiresAt: new Date(Date.now() + 150000) }
  assert.equal((await store.acquireDispatchLease(lease)).kind, 'acquired')
  previous.status = 'committed'
  return { store, usageStore, previous, replacement, lease, next: { ...lease, ownerRequestId: replacementId } }
}

test('a matching terminal memory lease owner can be replaced without waiting for skipped cleanup', async () => {
  for (const status of ['committed', 'released']) {
    const f = await memoryLeaseFixture()
    f.previous.status = status
    assert.equal((await f.store.acquireDispatchLease(f.next)).kind, 'acquired')
    await f.store.releaseDispatchLease(f.lease)
    assert.equal([...f.store.leases.values()][0].ownerRequestId, f.next.ownerRequestId)
  }
})

test('memory lease replacement retains missing, cross-scope and unresolved owner protection', async () => {
  const corruptions = [
    f => { f.previous.status = 'reserved' }, f => { f.previous.status = 'unknown' },
    f => { f.usageStore.requests.delete(f.previous.id) }, f => { f.usageStore.requests.delete(f.replacement.id) },
    f => { f.previous.tenantId = randomUUID() }, f => { f.previous.consumerId = randomUUID() },
    f => { f.previous.platform = 'another-platform' }, f => { f.previous.fingerprint = 'b'.repeat(64) },
    f => { f.replacement.fingerprint = 'b'.repeat(64) },
    f => { f.replacement.status = 'unknown' },
    ...['pending', 'unknown'].map(outcome => f => f.store.calls.set(randomUUID(), {
      usageRequestId: f.previous.id, operation: 'another.operation', outcome,
    })),
  ]
  for (const corrupt of corruptions) {
    const f = await memoryLeaseFixture()
    corrupt(f)
    assert.equal((await f.store.acquireDispatchLease(f.next)).kind, 'busy')
    assert.equal([...f.store.leases.values()][0].ownerRequestId, f.previous.id)
  }
})

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL
const native = { skip: !connectionString && 'Requires disposable native PostgreSQL' }
const quiet = { warn() {}, error() {} }

async function nativeFixture(t, { max = 3 } = {}) {
  const admin = createHubPostgresPool({ connectionString, max: 1 }, { logger: quiet })
  const database = `cleanup_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE ${database}`)
  const target = new URL(connectionString)
  target.pathname = `/${database}`
  const pool = createHubPostgresPool({ connectionString: target.toString(), max }, { logger: quiet })
  const holders = []
  t.after(async () => {
    for (const client of holders.splice(0)) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    try { await pool.end(); await admin.query(`DROP DATABASE ${database}`) } finally { await admin.end() }
  })
  await pool.query(`CREATE SCHEMA external_platform;
    CREATE SCHEMA control;
    CREATE TABLE usage_requests (
      id uuid PRIMARY KEY, tenant_id uuid, consumer_id uuid,
      platform text, fingerprint text, status text NOT NULL
    );
    CREATE TABLE control.admission_recoveries (kind text, target text);
    CREATE TABLE external_platform.provider_calls (
      id uuid PRIMARY KEY, provider_key text, usage_request_id uuid, consumer_id uuid,
      operation text, dispatch_fingerprint text, request_fingerprint text,
      outcome text, endpoint_key text, contract_version text, error_code text,
      started_at timestamptz DEFAULT now(), completed_at timestamptz
    );
    CREATE TABLE external_platform.provider_cost_reservations (
      id uuid PRIMARY KEY, provider_key text, usage_request_id uuid,
      status text NOT NULL, released_at timestamptz
    );
    CREATE TABLE external_platform.dispatch_leases (
      consumer_id uuid, operation text, request_fingerprint text,
      owner_request_id uuid NOT NULL, expires_at timestamptz NOT NULL,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY(consumer_id, operation, request_fingerprint)
    )`)
  const cost = { reservationId: randomUUID(), usageRequestId: randomUUID(), bestEffortRelease: true }
  const lease = { consumerId: randomUUID(), operation: 'search', fingerprint: 'f'.repeat(64),
    ownerRequestId: cost.usageRequestId, bestEffortRelease: true }
  await pool.query('INSERT INTO external_platform.provider_cost_reservations VALUES($1,$2,$3,$4,NULL)',
    [cost.reservationId, 'justone', cost.usageRequestId, 'active'])
  await pool.query("INSERT INTO external_platform.dispatch_leases(consumer_id,operation,request_fingerprint,owner_request_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 minutes')",
    [lease.consumerId, lease.operation, lease.fingerprint, lease.ownerRequestId])
  const store = new PostgresExternalPlatformStore({ pool, providerKey: 'justone', authorizationPlatform: 'ecommerce' })
  const hold = async () => { const client = await pool.connect(); holders.push(client); return client }
  return { pool, store, cost, lease, hold }
}

test('native PG skips post-delivery pool pressure without entering the connection queue', native, async t => {
  const f = await nativeFixture(t, { max: 1 })
  await f.hold()
  const started = performance.now()
  assert.equal(await f.store.releaseProviderCostWorkflow(f.cost), false)
  assert.equal(await f.store.releaseDispatchLease(f.lease), false)
  assert.ok(performance.now() - started < 250)
  assert.equal(f.pool.waitingCount, 0)
  assert.equal(f.pool.getPressureSnapshot().waitingHighWatermark, 1)
})

test('native PG skips busy budget and lease row locks while preserving both durable guards', native, async t => {
  const f = await nativeFixture(t)
  const locker = await f.hold()
  await locker.query('BEGIN')
  await locker.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['external-platform-cost:justone'])
  await locker.query('SELECT * FROM external_platform.dispatch_leases FOR UPDATE')
  // Prime one idle connection: post-delivery cleanup never creates a new one.
  await f.pool.query('SELECT 1')
  const started = performance.now()
  assert.equal(await f.store.releaseProviderCostWorkflow(f.cost), false)
  assert.equal(await f.store.releaseDispatchLease(f.lease), false)
  assert.ok(performance.now() - started < 250)
  assert.equal((await f.pool.query('SELECT status FROM external_platform.provider_cost_reservations')).rows[0].status, 'active')
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM external_platform.dispatch_leases')).rows[0].count, 1)
  await locker.query('ROLLBACK')
  assert.equal(await f.store.releaseProviderCostWorkflow(f.cost), true)
  assert.equal(await f.store.releaseDispatchLease(f.lease), true)
  assert.equal((await f.pool.query('SELECT status FROM external_platform.provider_cost_reservations')).rows[0].status, 'released')
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM external_platform.dispatch_leases')).rows[0].count, 0)
})

test('native PG bounds post-delivery relation locks and rolls back without releasing cost evidence', native, async t => {
  const f = await nativeFixture(t)
  const locker = await f.hold()
  await locker.query('BEGIN')
  await locker.query('LOCK TABLE external_platform.provider_cost_reservations IN ACCESS EXCLUSIVE MODE')
  await f.pool.query('SELECT 1')
  const started = performance.now()
  await assert.rejects(f.store.releaseProviderCostWorkflow(f.cost), { code: '55P03' })
  assert.ok(performance.now() - started < 750)
  await locker.query('ROLLBACK')
  assert.equal((await f.pool.query('SELECT status FROM external_platform.provider_cost_reservations')).rows[0].status, 'active')
  assert.equal((await f.pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s')
  assert.equal((await f.pool.query('SHOW lock_timeout')).rows[0].lock_timeout, '5s')
})

test('native PG cancels slow cleanup at the server before returning and never releases its hold later', native, async t => {
  const f = await nativeFixture(t)
  await f.pool.query(`CREATE FUNCTION slow_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$;
    CREATE TRIGGER slow_cleanup BEFORE UPDATE ON external_platform.provider_cost_reservations
    FOR EACH ROW EXECUTE FUNCTION slow_cleanup()`)
  const started = performance.now()
  await assert.rejects(f.store.releaseProviderCostWorkflow(f.cost), { code: '57014' })
  assert.ok(performance.now() - started >= 450)
  assert.ok(performance.now() - started < 1500)
  assert.equal((await f.pool.query('SELECT status FROM external_platform.provider_cost_reservations')).rows[0].status, 'active')
  assert.equal((await f.pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s')
})

test('native PG atomically replaces a completed exact-scope lease and ignores stale owner cleanup', native, async t => {
  const f = await nativeFixture(t)
  const tenantId = randomUUID(), replacementId = randomUUID()
  await f.pool.query(`INSERT INTO usage_requests VALUES
    ($1,$3,$4,'ecommerce',$5,'committed'), ($2,$3,$4,'ecommerce',$5,'reserved')`,
  [f.lease.ownerRequestId, replacementId, tenantId, f.lease.consumerId, f.lease.fingerprint])
  const next = { ...f.lease, ownerRequestId: replacementId, endpointKey: 'jd.product-search.v1',
    contractVersion: 'v1', expiresAt: new Date(Date.now() + 150000) }
  assert.equal((await f.store.acquireDispatchLease(next)).kind, 'acquired')
  assert.equal(await f.store.releaseDispatchLease(f.lease), false)
  assert.equal((await f.pool.query('SELECT owner_request_id FROM external_platform.dispatch_leases')).rows[0].owner_request_id, replacementId)
  await f.pool.query("UPDATE usage_requests SET status='committed' WHERE id=$1", [replacementId])
  const contenderIds = [randomUUID(), randomUUID()]
  for (const id of contenderIds) await f.pool.query("INSERT INTO usage_requests VALUES($1,$2,$3,'ecommerce',$4,'reserved')",
    [id, tenantId, f.lease.consumerId, f.lease.fingerprint])
  const claims = await Promise.all(contenderIds.map(ownerRequestId => f.store.acquireDispatchLease({ ...next, ownerRequestId })))
  assert.equal(claims.filter(result => result.kind === 'acquired').length, 1)
  assert.equal(claims.filter(result => result.kind === 'busy').length, 1)
})

test('native PG never replaces missing, cross-scope or unresolved paid owners before lease expiry', native, async t => {
  const f = await nativeFixture(t)
  const tenantId = randomUUID(), replacementId = randomUUID()
  const next = { ...f.lease, ownerRequestId: replacementId, endpointKey: 'jd.product-search.v1',
    contractVersion: 'v1', expiresAt: new Date(Date.now() + 150000) }
  const seedOwners = async () => {
    await f.pool.query('DELETE FROM external_platform.provider_calls')
    await f.pool.query('DELETE FROM usage_requests')
    await f.pool.query(`INSERT INTO usage_requests VALUES
      ($1,$3,$4,'ecommerce',$5,'committed'), ($2,$3,$4,'ecommerce',$5,'reserved')`,
    [f.lease.ownerRequestId, replacementId, tenantId, f.lease.consumerId, f.lease.fingerprint])
  }
  const corruptions = [
    () => f.pool.query("UPDATE usage_requests SET status='unknown' WHERE id=$1", [f.lease.ownerRequestId]),
    () => f.pool.query("UPDATE usage_requests SET status='reserved' WHERE id=$1", [f.lease.ownerRequestId]),
    () => f.pool.query('DELETE FROM usage_requests WHERE id=$1', [f.lease.ownerRequestId]),
    () => f.pool.query('DELETE FROM usage_requests WHERE id=$1', [replacementId]),
    () => f.pool.query('UPDATE usage_requests SET tenant_id=$2 WHERE id=$1', [f.lease.ownerRequestId, randomUUID()]),
    () => f.pool.query("UPDATE usage_requests SET platform='another-platform' WHERE id=$1", [f.lease.ownerRequestId]),
    () => f.pool.query('UPDATE usage_requests SET fingerprint=$2 WHERE id=$1', [f.lease.ownerRequestId, 'b'.repeat(64)]),
    ...['pending', 'unknown'].map(outcome => () => f.pool.query(`INSERT INTO external_platform.provider_calls
      (id, provider_key, usage_request_id, consumer_id, operation, dispatch_fingerprint,
       request_fingerprint, outcome, completed_at)
      VALUES ($1,'another-provider',$2,$3,'another.operation',$4,$4,$5,now())`,
    [randomUUID(), f.lease.ownerRequestId, f.lease.consumerId, f.lease.fingerprint, outcome])),
  ]
  for (const corrupt of corruptions) {
    await seedOwners()
    await corrupt()
    assert.equal((await f.store.acquireDispatchLease(next)).kind, 'busy')
    assert.equal((await f.pool.query('SELECT owner_request_id FROM external_platform.dispatch_leases')).rows[0].owner_request_id, f.lease.ownerRequestId)
  }
})
