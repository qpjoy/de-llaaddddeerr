import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { PostgresCollectStore } from '../../server/collect/store.mjs'
import { CollectExecutor } from '../../server/collect/executor.mjs'
import { CollectService } from '../../server/collect/service.mjs'
import { createCollectContracts } from '../../server/collect/contracts/index.mjs'
import { ExternalPlatformProxyStore } from '../../server/external-platforms/proxy.mjs'

// Requires a disposable database migrated through 183; it resets schema collect.
const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const native = { skip: connectionString ? false : 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL', concurrency: false }
const PEPPER = 'collect-engines-pg-test-pepper-at-least-32-bytes'
const CAP = 'collect.app.details'
const ENGINE = 'runner.pg-test'
const completed = () => Response.json({ data: { state: 'completed', envelope: { schema_version: '1.0', status: 'success', result: { items: [{ app_id: '1' }] }, error: null } } })

async function reset(pool) {
  await pool.query('TRUNCATE collect.job_results, collect.jobs, collect.batches, collect.engine_events, collect.routes, collect.engine_slots, collect.engines CASCADE')
}

async function caller(pool, name = 'delta') {
  const ledger = new PostgresStore(pool)
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: `col-${randomUUID().slice(0, 8)}` })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name })
  await ledger.setPlatformGrant(consumer.id, 'app_market', true)
  await hub.putCapabilityConfiguration(CAP, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name, platforms: ['app_market'], capabilities: [CAP] })
  return { ledger, hub, context: await hub.authenticate(key.secret) }
}

function serviceFor(pool, ledger, fetchImpl = async () => completed()) {
  return new CollectService({ jobs: new PostgresCollectStore(pool), ledger, contracts: createCollectContracts(), fetchImpl })
}

async function engine(service, overrides = {}) {
  return service.adminCreateEngine({ id: ENGINE, kind: 'runner', displayName: 'pg', slotRef: 'market-195', baseUrl: 'http://127.0.0.1:18300',
    routes: [{ capability: CAP, routeKey: 'xiaomi' }], enabled: true, reason: '原生测试', ...overrides }, 'tester')
}

const body = id => ({ capability: CAP, input: { market: 'xiaomi', appIds: [String(id)] } })

test('PostgreSQL: concurrent claims never exceed capacity and one slot never runs two jobs', native, async () => {
  const pools = Array.from({ length: 4 }, () => new pg.Pool({ connectionString, max: 2 }))
  try {
    await reset(pools[0])
    const { context, ledger } = await caller(pools[0])
    const service = serviceFor(pools[0], ledger)
    await engine(service, { capacity: 2 })
    await service.submitBatch(context, { capability: CAP, items: [1, 2, 3, 4, 5].map(id => ({ input: body(id).input })) }, `pg-batch-${randomUUID()}`)
    const claims = await Promise.all(pools.flatMap((pool, index) => [0, 1].map(round => new PostgresCollectStore(pool)
      .claim({ engineId: ENGINE, owner: `p${index}-${round}`, leaseGraceMs: 30_000 }))))
    const won = claims.filter(row => row.job)
    assert.equal(won.length, 2)
    assert.deepEqual(won.map(row => row.job.input.appIds[0]).sort(), ['1', '2'], 'batch items run in input order')
    assert.deepEqual(won.map(row => row.job.slotNo).sort(), [1, 2])
    await assert.rejects(pools[0].query(`UPDATE collect.jobs SET status = 'running', phase = 'dispatching', slot_no = 1, owner = 'x',
      lease_until = now(), run_deadline_at = now() WHERE status = 'queued'`), { code: '23505' })
  } finally {
    await Promise.all(pools.map(pool => pool.end()))
  }
})

test('PostgreSQL: one caller is limited exactly while different callers proceed in parallel', native, async () => {
  const pools = Array.from({ length: 3 }, () => new pg.Pool({ connectionString, max: 4 }))
  try {
    await reset(pools[0])
    const first = await caller(pools[0], 'a')
    const second = await caller(pools[0], 'b')
    await engine(serviceFor(pools[0], first.ledger), { consumerOpenLimit: 4 })
    const results = await Promise.allSettled(Array.from({ length: 9 }, (_, index) =>
      serviceFor(pools[index % 3], first.ledger).submitJob(first.context, body(index), `pg-limit-${index}-${randomUUID()}`)))
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 4)
    assert.ok(results.filter(row => row.status === 'rejected').every(row => row.reason.code === 'consumer_queue_full'))
    const other = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      serviceFor(pools[index % 3], second.ledger).submitJob(second.context, body(index), `pg-other-${index}-${randomUUID()}`)))
    assert.equal(other.length, 4)
    // Replays race safely under the per-caller lock.
    const key = `pg-replay-${randomUUID()}`
    const replays = await Promise.all(pools.map(pool => serviceFor(pool, second.ledger).submitJob(second.context, body(1), key).catch(error => error)))
    assert.equal(new Set(replays.filter(row => row.data).map(row => row.data.jobId)).size <= 1, true)
  } finally {
    await Promise.all(pools.map(pool => pool.end()))
  }
})

test('PostgreSQL: executors on separate pools share slots, check async runs and settle', native, async () => {
  const pools = Array.from({ length: 2 }, () => new pg.Pool({ connectionString, max: 4 }))
  try {
    await reset(pools[0])
    const { context, ledger, hub } = await caller(pools[0])
    const states = new Map()
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname
      if (init.method === 'POST') return Response.json({ data: { state: 'accepted' } }, { status: 202 })
      return states.get(path.split('/').pop()) ? completed() : Response.json({ data: { state: 'running' } })
    }
    const service = serviceFor(pools[0], ledger, fetchImpl)
    await engine(service, { capacity: 3 })
    const ids = []
    for (let index = 0; index < 6; index++) ids.push((await service.submitJob(context, body(index), `pg-exec-${index}-${randomUUID()}`)).data.jobId)
    const executors = pools.map((pool, index) => Object.assign(new CollectExecutor({ jobs: new PostgresCollectStore(pool), ledger,
      credentialsFor: async () => 'runner-token-0123456789abcdef',
      contracts: createCollectContracts(), fetchImpl, logger: { error() {}, warn() {} }, pollMs: 60_000, owner: `exec-${index}`,
      policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform) }), { stopped: false }))
    await Promise.all(executors.map(executor => executor.drain()))
    const { rows: [counts] } = await pools[0].query(`SELECT count(*) FILTER (WHERE phase = 'waiting')::int AS waiting,
      count(*) FILTER (WHERE status = 'queued')::int AS queued FROM collect.jobs`)
    assert.deepEqual(counts, { waiting: 3, queued: 3 })
    for (const id of ids.slice(0, 3)) states.set(id, true)
    await pools[0].query(`UPDATE collect.jobs SET next_check_at = now() - interval '1 second' WHERE phase = 'waiting'`)
    await Promise.all(executors.map(executor => executor.drain()))
    const { rows } = await pools[0].query('SELECT status, count(*)::int AS total FROM collect.jobs GROUP BY status ORDER BY status')
    assert.deepEqual(rows, [{ status: 'running', total: 3 }, { status: 'succeeded', total: 3 }])
    const { rows: results } = await pools[0].query('SELECT count(*)::int AS total FROM collect.job_results')
    assert.equal(results[0].total, 3)
    const { rows: slots } = await pools[0].query('SELECT count(*)::int AS busy FROM collect.engine_slots WHERE job_id IS NOT NULL')
    assert.equal(slots[0].busy, 3)
  } finally {
    await Promise.all(pools.map(pool => pool.end()))
  }
})

test('PostgreSQL: lost dispatches are reconciled; shrinking capacity drains busy slots', native, async () => {
  const pool = new pg.Pool({ connectionString, max: 4 })
  try {
    await reset(pool)
    const { context, ledger } = await caller(pool)
    const service = serviceFor(pool, ledger)
    await engine(service, { capacity: 2 })
    const store = new PostgresCollectStore(pool)
    await service.submitJob(context, body(1), `pg-orphan-1-${randomUUID()}`)
    await service.submitJob(context, body(2), `pg-orphan-2-${randomUUID()}`)
    const a = await store.claim({ engineId: ENGINE, owner: 'dead', dispatchLeaseMs: 60_000, leaseGraceMs: 30_000 })
    const b = await store.claim({ engineId: ENGINE, owner: 'alive', dispatchLeaseMs: 60_000, leaseGraceMs: 30_000 })
    await pool.query(`UPDATE collect.jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [a.job.id])
    assert.deepEqual(await store.reapOrphans({ reconcilableKinds: ['runner'], leaseGraceMs: 30_000 }), [])
    assert.equal((await store.get(a.job.id)).phase, 'waiting')
    assert.equal((await store.get(b.job.id)).phase, 'dispatching', 'a live lease is never reaped')
    const unknown = await store.reapOrphans({ reconcilableKinds: [], leaseGraceMs: 30_000 })
    assert.equal(unknown.length, 0, 'the reconciled job is no longer dispatching')
    // Shrink to one slot while slot 2 is busy: it drains and disappears when freed.
    const current = await store.engine(ENGINE)
    await service.adminConfigureEngine(ENGINE, { capacity: 1, expectedRevision: current.revision, reason: '缩容' }, 'tester')
    assert.equal((await store.engineDetail(ENGINE)).slots.length, 2)
    await store.finish({ jobId: b.job.id, owner: 'alive', outcome: { status: 'failed', charge: false, error: { code: 'x', message: 'x' } }, billing: 'none' })
    const slots = (await store.engineDetail(ENGINE)).slots
    assert.deepEqual(slots.map(slot => slot.slotNo), [1], 'the freed surplus slot is removed')
  } finally {
    await pool.end()
  }
})

test('PostgreSQL: migration 184 binds apify to the 7788 sequence and engine cost sums per day', native, async () => {
  const pool = new pg.Pool({ connectionString, max: 4 })
  try {
    await reset(pool)
    const apify = await new ExternalPlatformProxyStore(pool, {}, { providerKey: 'apify' }).describe()
    const { rows: [sequence] } = await pool.query(`SELECT enabled FROM control.agent_proxy_sequences WHERE sequence_key = 'tikhub-internal-7788'`)
    assert.deepEqual([apify.mode, apify.sequenceKey], sequence?.enabled ? ['proxy-sequence', 'tikhub-internal-7788'] : ['system-egress', null])
    assert.equal(apify.probePolicy.override.cacheTtlMs, 300_000)
    const tikhub = await new ExternalPlatformProxyStore(pool, {}, { providerKey: 'tikhub' }).describe()
    assert.equal(tikhub.sequenceKey, 'tikhub-internal-7788', 'the TikHub binding is untouched')

    const { context, ledger } = await caller(pool)
    const service = serviceFor(pool, ledger)
    await service.adminCreateEngine({ id: 'apify.pg-test', kind: 'apify', displayName: 'apify', routes: [{ capability: 'collect.ecommerce.temu.search' }],
      enabled: true, reason: '原生测试' }, 'tester')
    assert.equal((await service.jobs.engine('apify.pg-test')).credentialProvider, 'apify')
    const store = new PostgresCollectStore(pool)
    const engines = await store.listEngines()
    assert.equal(engines.find(row => row.id === 'apify.pg-test').stats.costUsd24h, 0)
    await engine(service)
    const submitted = await service.submitJob(context, body(1), `pg-cost-${randomUUID()}`)
    const { job } = await store.claim({ engineId: ENGINE, owner: 'cost', leaseGraceMs: 30_000 })
    assert.equal(job.id, submitted.data.jobId)
    await store.finish({ jobId: job.id, owner: 'cost', billing: 'none', outcome: { status: 'succeeded', dataStatus: 'success', charge: true,
      result: { items: [] }, itemCount: 0, cost: { provider: 'apify', usd: 0.0375, runId: 'RunAbc123456' } } })
    const after = await store.listEngines()
    assert.equal(after.find(row => row.id === ENGINE).stats.costUsd24h, 0.0375)
    assert.equal((await store.get(job.id)).cost.usd, 0.0375)
  } finally {
    await pool.end()
  }
})

test('PostgreSQL: inline claim of one job, silent pacing and the shodan / googleplay / overseas egress bindings (185–187)', native, async () => {
  const pools = Array.from({ length: 3 }, () => new pg.Pool({ connectionString, max: 2 }))
  try {
    const pool = pools[0]
    await reset(pool)
    const shodan = await new ExternalPlatformProxyStore(pool, {}, { providerKey: 'shodan' }).describe()
    const { rows: [sequence] } = await pool.query(`SELECT enabled FROM control.agent_proxy_sequences WHERE sequence_key = 'tikhub-internal-7788'`)
    assert.deepEqual([shodan.mode, shodan.sequenceKey], sequence?.enabled ? ['proxy-sequence', 'tikhub-internal-7788'] : ['system-egress', null])
    const googleplay = await new ExternalPlatformProxyStore(pool, {}, { providerKey: 'googleplay' }).describe()
    assert.deepEqual([googleplay.mode, googleplay.sequenceKey], [shodan.mode, shodan.sequenceKey])
    const overseas = await new ExternalPlatformProxyStore(pool, {}, { providerKey: 'overseas' }).describe()
    assert.deepEqual([overseas.mode, overseas.sequenceKey], [shodan.mode, shodan.sequenceKey])
    const { context, ledger } = await caller(pool)
    const service = serviceFor(pool, ledger)
    await engine(service, { capacity: 1 })
    const first = await service.submitJob(context, body(1), `pg-inline-1-${randomUUID()}`)
    const second = await service.submitJob(context, body(2), `pg-inline-2-${randomUUID()}`)
    // Three processes race to run the second job inline: one wins, none takes the first.
    const claims = await Promise.all(pools.map((p, index) => new PostgresCollectStore(p).claimJob({ jobId: second.data.jobId, owner: `inline-${index}`, leaseGraceMs: 30_000 })))
    const won = claims.filter(row => row.job)
    assert.equal(won.length, 1)
    assert.equal(won[0].job.id, second.data.jobId)
    assert.ok(claims.filter(row => !row.job).every(row => ['no_free_slot', 'not_queued'].includes(row.reason)))
    const store = new PostgresCollectStore(pool)
    assert.equal((await store.get(first.data.jobId)).status, 'queued')
    await store.finish({ jobId: second.data.jobId, owner: won[0].job.owner, billing: 'none', outcome: { status: 'succeeded', dataStatus: 'success', charge: true,
      result: { ok: true }, itemCount: 1, paceUntil: Date.now() + 60_000 } })
    const paced = await store.engine(ENGINE)
    assert.ok(Date.parse(paced.cooldownUntil) > Date.now() + 50_000, 'pacing sets the shared cooldown')
    assert.equal((await store.events(ENGINE)).filter(event => event.action === 'cooldown').length, 0, 'pacing writes no audit event')
    assert.equal((await store.claimJob({ jobId: first.data.jobId, owner: 'inline-x', leaseGraceMs: 30_000 })).reason, 'engine_not_ready', 'a paced engine is not claimed')
  } finally {
    await Promise.all(pools.map(p => p.end()))
  }
})
