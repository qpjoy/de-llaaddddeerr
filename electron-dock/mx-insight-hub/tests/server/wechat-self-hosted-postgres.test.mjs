import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { PostgresSelfHostedStore } from '../../server/self-hosted/store.mjs'
import { WechatSelfHostedExecutor } from '../../server/self-hosted/executor.mjs'
import { WechatSelfHostedService } from '../../server/self-hosted/service.mjs'
import { WECHAT_ENGINE_ID } from '../../server/self-hosted/wechat-contract.mjs'
import { WECHAT_SELF_HOSTED, WECHAT_SELF_HOSTED_LIMITS } from '../../shared/wechat-self-hosted.mjs'

// Requires a disposable database migrated through 165; it resets the engine.
const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const native = { skip: connectionString ? false : 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL', concurrency: false }
const PEPPER = 'wechat-self-hosted-pg-test-pepper-at-least-32-bytes'
const CAP = WECHAT_SELF_HOSTED.capability
const live = cache => Response.json({ data: { raw_data: JSON.stringify([{ title: 't', url: 'https://mp.weixin.qq.com/s/x' }]), meta: { cache } }, requestId: 'na' })

async function reset(pool, { billing = false } = {}) {
  await pool.query('DELETE FROM self_hosted.jobs')
  await pool.query('DELETE FROM self_hosted.batches')
  await pool.query('DELETE FROM self_hosted.engine_events')
  await pool.query(`UPDATE self_hosted.engines SET base_url = 'http://127.0.0.1:13141', enabled = true, billing_enabled = $2, revision = 0,
    active_job_id = NULL, quarantine_reason = NULL, quarantined_at = NULL, cooldown_until = NULL WHERE id = $1`, [WECHAT_ENGINE_ID, billing])
}

async function caller(pool) {
  const ledger = new PostgresStore(pool)
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: `wsh-${randomUUID().slice(0, 8)}` })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'delta' })
  await ledger.setPlatformGrant(consumer.id, WECHAT_SELF_HOSTED.platform, true)
  await hub.putCapabilityConfiguration(CAP, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'delta', platforms: [WECHAT_SELF_HOSTED.platform], capabilities: [CAP] })
  return { ledger, hub, context: await hub.authenticate(key.secret) }
}

function executorFor({ jobs, ledger, hub }, answer) {
  const executor = new WechatSelfHostedExecutor({ jobs, ledger, logger: { error() {} }, pollMs: 60_000,
    policyFor: (context, platform) => hub.usagePolicy(context, platform), fetchImpl: async () => answer() })
  executor.stopped = false
  executor.ready = Promise.resolve()
  return executor
}

test('PostgreSQL: concurrent claims and the running index allow exactly one dispatch', native, async () => {
  const pools = Array.from({ length: 4 }, () => new pg.Pool({ connectionString, max: 2 }))
  try {
    await reset(pools[0])
    const { context, ledger } = await caller(pools[0])
    const service = new WechatSelfHostedService({ jobs: new PostgresSelfHostedStore(pools[0]), ledger })
    await service.submitBatch(context, { items: [{ query: 'a' }, { query: 'b' }, { query: 'c' }] }, `pg-batch-${randomUUID()}`)
    const claims = await Promise.all(pools.map((pool, index) => new PostgresSelfHostedStore(pool).claim({ engineId: WECHAT_ENGINE_ID, owner: `p${index}` })))
    assert.equal(claims.filter(row => row.job).length, 1)
    assert.equal(claims.find(row => row.job).job.input.query, 'a', 'batch items run in input order')
    await assert.rejects(pools[0].query(`UPDATE self_hosted.jobs SET status = 'running' WHERE status = 'queued'`), { code: '23505' })
  } finally {
    await Promise.all(pools.map(pool => pool.end()))
  }
})

test('PostgreSQL: parallel submissions never exceed the per-caller limit', native, async () => {
  const pools = Array.from({ length: 3 }, () => new pg.Pool({ connectionString, max: 4 }))
  try {
    await reset(pools[0])
    const { context, ledger } = await caller(pools[0])
    const limits = { ...WECHAT_SELF_HOSTED_LIMITS, consumerOpen: 4 }
    const results = await Promise.allSettled(Array.from({ length: 9 }, (_, index) =>
      new WechatSelfHostedService({ jobs: new PostgresSelfHostedStore(pools[index % 3]), ledger, limits })
        .submitJob(context, { query: `q${index}` }, `pg-limit-${index}-${randomUUID()}`)))
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 4)
    assert.ok(results.filter(row => row.status === 'rejected').every(row => row.reason.code === 'consumer_queue_full'))
  } finally {
    await Promise.all(pools.map(pool => pool.end()))
  }
})

test('PostgreSQL: with billing on, the real ledger commits live, releases stale and holds unknown', native, async () => {
  const pool = new pg.Pool({ connectionString, max: 6 })
  try {
    await reset(pool, { billing: true })
    const jobs = new PostgresSelfHostedStore(pool)
    const { context, ledger, hub } = await caller(pool)
    let answer = () => live({ status: 'miss' })
    const executor = executorFor({ jobs, ledger, hub }, () => answer())
    const service = new WechatSelfHostedService({ jobs, ledger, executor })
    const usage = async id => (await pool.query('SELECT status, billing_meter_key, platform FROM usage_requests WHERE id = $1', [id])).rows[0]

    const charged = await service.submitJob(context, { query: 'live' }, `pg-live-${randomUUID()}`)
    await executor.tick()
    const liveJob = await jobs.get(charged.data.jobId)
    assert.deepEqual([liveJob.status, liveJob.billing], ['succeeded', 'charged'])
    assert.deepEqual(await usage(liveJob.usageRequestId), { status: 'committed', billing_meter_key: CAP, platform: 'social' })
    assert.ok((await jobs.queueSnapshot(WECHAT_ENGINE_ID)).medianMs >= 0)

    answer = () => live({ status: 'stale', reason: 'sogou_anti_spider', retryAfterMs: 0 })
    const stale = await service.submitJob(context, { query: 'stale' }, `pg-stale-${randomUUID()}`)
    await executor.tick()
    const staleJob = await jobs.get(stale.data.jobId)
    assert.deepEqual([staleJob.sourceMode, staleJob.billing], ['stored_fallback', 'not_charged'])
    assert.equal((await usage(staleJob.usageRequestId)).status, 'released')

    answer = () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }
    const lost = await service.submitJob(context, { query: 'lost' }, `pg-lost-${randomUUID()}`)
    const after = await service.submitJob(context, { query: 'after' }, `pg-after-${randomUUID()}`)
    await executor.tick()
    const lostJob = await jobs.get(lost.data.jobId)
    assert.deepEqual([lostJob.status, lostJob.billing], ['unknown', 'pending_review'])
    assert.equal((await usage(lostJob.usageRequestId)).status, 'unknown')
    const engine = await jobs.engine(WECHAT_ENGINE_ID)
    assert.deepEqual([engine.quarantineReason, engine.activeJobId], ['upstream_timeout', lost.data.jobId])
    assert.equal((await jobs.get(after.data.jobId)).status, 'queued')

    answer = () => live({ status: 'fresh' })
    await service.adminRecover({ expectedRevision: engine.revision, reason: '已确认爬虫退出' }, 'admin')
    await executor.tick()
    assert.deepEqual([(await jobs.get(after.data.jobId)).status, (await jobs.get(after.data.jobId)).sourceMode], ['succeeded', 'fresh_cache'])
    const events = await jobs.events(WECHAT_ENGINE_ID)
    assert.deepEqual(events.map(event => event.action).slice(0, 2), ['recovered', 'quarantined'])
  } finally {
    await pool.end()
  }
})

test('PostgreSQL: billing off forwards without any usage row and idles lock-free', native, async () => {
  const pool = new pg.Pool({ connectionString, max: 4 })
  try {
    await reset(pool)
    const jobs = new PostgresSelfHostedStore(pool)
    const { context, ledger, hub } = await caller(pool)
    assert.deepEqual(await jobs.readiness(WECHAT_ENGINE_ID), { claimable: false })
    const executor = executorFor({ jobs, ledger, hub }, () => live({ status: 'miss' }))
    const service = new WechatSelfHostedService({ jobs, ledger, executor })
    const before = Number((await pool.query('SELECT count(*) FROM usage_requests WHERE consumer_id = $1', [context.consumer.id])).rows[0].count)
    const { data } = await service.submitJob(context, { query: 'forward' }, `pg-forward-${randomUUID()}`)
    assert.deepEqual(await jobs.readiness(WECHAT_ENGINE_ID), { claimable: true })
    await executor.tick()
    const job = await jobs.get(data.jobId)
    assert.deepEqual([job.status, job.billing, job.usageRequestId], ['succeeded', 'none', null])
    const after = Number((await pool.query('SELECT count(*) FROM usage_requests WHERE consumer_id = $1', [context.consumer.id])).rows[0].count)
    assert.equal(after, before)
  } finally {
    await pool.end()
  }
})

test('PostgreSQL: restart recovery, cancel, expiry and pruning', native, async () => {
  const pool = new pg.Pool({ connectionString, max: 4 })
  try {
    await reset(pool)
    const jobs = new PostgresSelfHostedStore(pool)
    const { context, ledger, hub } = await caller(pool)
    const service = new WechatSelfHostedService({ jobs, ledger })
    const interrupted = await service.submitJob(context, { query: 'x' }, `pg-orphan-${randomUUID()}`)
    const cancelled = await service.submitJob(context, { query: 'y' }, `pg-cancel-${randomUUID()}`)
    await jobs.claim({ engineId: WECHAT_ENGINE_ID, owner: 'old' })
    const orphans = await jobs.orphanRunning({ engineId: WECHAT_ENGINE_ID, owner: 'new' })
    assert.deepEqual(orphans.map(job => job.id), [interrupted.data.jobId])
    assert.equal((await jobs.engine(WECHAT_ENGINE_ID)).quarantineReason, 'executor_restarted')
    const late = await jobs.finish({ engineId: WECHAT_ENGINE_ID, jobId: interrupted.data.jobId, owner: 'old', billing: 'charged',
      outcome: { status: 'succeeded', sourceMode: 'live', result: { items: [] } } })
    assert.equal(late.fenced, true)
    assert.ok((await jobs.get(interrupted.data.jobId)).lateEvidence)
    assert.equal((await service.cancelJob(context, cancelled.data.jobId)).status, 'cancelled')
    await assert.rejects(service.cancelJob(context, cancelled.data.jobId), { code: 'job_not_cancellable' })

    await jobs.recoverEngine({ engineId: WECHAT_ENGINE_ID, expectedRevision: 0, actor: 't', reason: '测试恢复' })
    const overdue = await service.submitJob(context, { query: 'z' }, `pg-expire-${randomUUID()}`)
    await pool.query(`UPDATE self_hosted.jobs SET deadline_at = now() - interval '1 second' WHERE id = $1`, [overdue.data.jobId])
    const claimed = await jobs.claim({ engineId: WECHAT_ENGINE_ID, owner: 'new' })
    assert.deepEqual([claimed.job, claimed.expired], [null, 1])
    assert.equal((await jobs.get(overdue.data.jobId)).status, 'expired')

    await pool.query(`UPDATE self_hosted.jobs SET finished_at = now() - interval '40 days' WHERE status IN ('cancelled', 'expired')`)
    assert.equal(await jobs.prune(WECHAT_ENGINE_ID, 30 * 24 * 60 * 60 * 1000), 2)
    assert.equal((await jobs.get(interrupted.data.jobId)).status, 'unknown', 'unknown runs are kept for review')
    void hub
  } finally {
    await pool.end()
  }
})
