import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService, businessApiScopes } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryCollectStore, PostgresCollectStore } from '../../server/collect/store.mjs'
import { CollectExecutor } from '../../server/collect/executor.mjs'
import { CollectService } from '../../server/collect/service.mjs'
import { createCollectContracts } from '../../server/collect/contracts/index.mjs'
import { normalizeJobRequest } from '../../server/collect/catalog.mjs'
import { SearchQueries } from '../../server/search/queries.mjs'
import { ingestTiebaPostSearchResult } from '../../server/workers/ingest.mjs'
import { standardEngines, SMOKE_CASES } from '../../scripts/collect-acceptance.mjs'
import { createTiebaPostgresFixture } from '../helpers/tieba-postgres.mjs'

const CAP = 'collect.tieba.posts.search'
const ENGINE = 'night-all-a.tieba'
const PEPPER = 'tieba-integration-test-pepper-at-least-32-bytes'
const REQUEST = { capability: CAP, input: { query: '新能源汽车', maxResults: 1, page: 1, maxPages: 1 } }

function upstream({ persist = true, ambiguous = false } = {}) {
  const calls = [], tasks = new Map()
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (init.method === 'POST') {
      if (ambiguous) throw Object.assign(new Error('response lost'), { name: 'TimeoutError' })
      assert.equal(path, '/api/tasks')
      const body = JSON.parse(init.body), id = tasks.size + 1
      const task = { id, connector_id: body.connector_id, capability: body.capability, parameters: body.parameters,
        credential_id: null, max_attempts: 1 }
      tasks.set(id, task)
      return Response.json({ task, run: { ...task, task_id: id, attempt: 1, status: 'queued' } }, { status: 202 })
    }
    const id = Number(path.split('/').at(-1)), task = tasks.get(id)
    assert.ok(task, `unexpected run ${id}`)
    return Response.json({ ...task, task_id: id, attempt: 1, status: 'succeeded', duration_ms: 12,
      finished_at: '2026-11-18T01:00:00.000Z',
      metrics: { records: { auto_persisted: persist, saved: persist ? 1 : 0, created: persist ? 1 : 0, updated: 0 } },
      result: { items: [{ record_type: 'tieba.thread', source_id: '123456789', source_url: 'https://tieba.baidu.com/p/123456789',
        title: '新能源汽车讨论', text: '充电与电池续航', author: { id: '123', name: '车友' },
        published_at: '2026-11-17T20:00:00+08:00', metrics: { replies: '8', likes: 3, shares: 0 }, media: [],
        attributes: { query: task.parameters.query, forum: '汽车吧', page: task.parameters.page },
        raw: { secretEvidence: 'restricted-upstream-payload' } }],
      metrics: { count: 1, collection: { requested: 1, returned: 1, complete: true, stop_reason: 'requested_limit' } } } })
  }
  return { fetchImpl, calls }
}

async function fixture({ ledger = new MemoryStore(), jobs = new MemoryCollectStore(), api = upstream(), searchQueries = null } = {}) {
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER, searchQueries })
  const tenant = await hub.createTenant({ name: 'Tieba integration' })
  async function caller(name, { platforms = ['tieba'], capabilities = [CAP] } = {}) {
    const consumer = await hub.createConsumer({ tenantId: tenant.id, name })
    for (const platform of platforms) await ledger.setPlatformGrant(consumer.id, platform, true)
    if (capabilities.includes(CAP)) await hub.putCapabilityConfiguration(CAP, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
    const key = await hub.createApiKey({ consumerId: consumer.id, name, platforms, capabilities })
    return { consumer, key, context: await hub.authenticate(key.secret) }
  }
  const owner = await caller('owner')
  const contracts = createCollectContracts(), credentialsFor = async () => null
  const executor = new CollectExecutor({ jobs, ledger, contracts, credentialsFor,
    fetchImpl: api.fetchImpl, policyFor: (context, platform) => hub.usagePolicy(context, platform),
    logger: { error() {}, warn() {} }, pollMs: 60_000 })
  executor.stopped = false
  const service = new CollectService({ jobs, ledger, contracts, executor, credentialsFor, fetchImpl: api.fetchImpl })
  await service.adminCreateEngine({ id: ENGINE, kind: 'night_all_a', displayName: '贴吧集成测试',
    baseUrl: 'http://100.127.0.1:8100', routes: [{ capability: CAP }], enabled: true,
    billingEnabled: true, reason: '本地测试，不访问上游' }, 'tester')
  return { ledger, jobs, hub, api, caller, owner, executor, service }
}

async function finish(fx, pool = null) {
  await fx.executor.drain()
  if (pool) await pool.query("UPDATE collect.jobs SET next_check_at=clock_timestamp()-interval '1 second' WHERE phase='waiting'")
  else for (const job of fx.jobs.jobs.values()) if (job.phase === 'waiting') job.nextCheckAt = new Date(Date.now() - 1).toISOString()
  await fx.executor.drain()
}

test('Tieba catalog bounds public inputs, pins anonymous search and requires explicit rollout and grants', () => {
  const normalized = normalizeJobRequest({ capability: CAP, input: { query: ' 新能源汽车 ' } })
  assert.deepEqual(normalized.item.input, { query: '新能源汽车', maxResults: 20, page: 1, maxPages: 1 })
  assert.deepEqual(normalized.definition.taskParameters(normalized.item.input), {
    query: '新能源汽车', max_results: 20, page: 1, max_pages: 1, auth_mode: 'anonymous',
  })
  for (const input of [{ query: '' }, { query: 'x'.repeat(201) }, { query: 'x\u0000' },
    { query: 'x', maxResults: 101 }, { query: 'x', page: 0 }, { query: 'x', maxPages: 11 },
    { query: 'x', credential_id: 1 }, { query: 'x', auth_mode: 'cookie' }, { query: 'x', connector_id: 'tieba_detail' }]) {
    assert.throws(() => normalizeJobRequest({ capability: CAP, input }), { code: 'invalid_collect_request' })
  }
  assert.equal(businessApiScopes().capabilities.includes(CAP), false)
  assert.equal(standardEngines().find(engine => engine.id === ENGINE).credentialProvider, 'collect-night-all-a-session')
  assert.equal(SMOKE_CASES.find(item => item.capability === CAP).explicitOnly, true)
})

test('Tieba collection is capability gated and consumer isolated; idempotent retries settle only once', async () => {
  const fx = await fixture()
  const denied = await fx.caller('without collection', { capabilities: [] })
  await assert.rejects(fx.service.submitJob(denied.context, REQUEST, 'tieba-denied-001'), { code: 'capability_not_granted' })
  const first = await fx.service.submitJob(fx.owner.context, REQUEST, 'tieba-replay-001')
  const replay = await fx.service.submitJob(fx.owner.context, REQUEST, 'tieba-replay-001')
  assert.equal(replay.data.jobId, first.data.jobId)
  assert.equal(replay.replay, true)
  let commits = 0
  const commit = fx.ledger.commitRequest.bind(fx.ledger)
  fx.ledger.commitRequest = async (...args) => { commits++; return commit(...args) }
  await finish(fx)
  await fx.executor.drain()
  const job = await fx.service.getJob(fx.owner.context, first.data.jobId)
  assert.equal(job.status, 'succeeded')
  assert.equal(job.billing.status, 'charged')
  assert.equal(commits, 1)
  assert.equal(fx.api.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(fx.jobs.ingestJobs.size, 1)
  const result = await fx.service.getResult(fx.owner.context, first.data.jobId)
  assert.equal(result.payload.items[0].id, '123456789')
  assert.equal(JSON.stringify(result).includes('restricted-upstream-payload'), false)
  assert.equal(JSON.stringify(result).includes('taskId'), false)
  const outsider = await fx.caller('other consumer')
  await assert.rejects(fx.service.getResult(outsider.context, first.data.jobId), { code: 'job_not_found' })
})

test('Tieba unpersisted data is not delivered or ingested; unknown submissions hold the slot without replay', async () => {
  for (const ambiguous of [false, true]) {
    const fx = await fixture({ api: upstream({ persist: false, ambiguous }) })
    const { data } = await fx.service.submitJob(fx.owner.context, REQUEST, `tieba-failure-${ambiguous}`)
    await finish(fx)
    await fx.executor.drain()
    const job = await fx.service.getJob(fx.owner.context, data.jobId)
    assert.equal(job.status, ambiguous ? 'unknown' : 'failed')
    assert.equal(job.billing.status, ambiguous ? 'pending_review' : 'not_charged')
    assert.equal(fx.jobs.ingestJobs.size, 0)
    assert.equal(fx.api.calls.filter(call => call.method === 'POST').length, 1)
    await assert.rejects(fx.service.getResult(fx.owner.context, data.jobId), { code: 'result_unavailable' })
  }
})

test('actual PostgreSQL: Tieba task → durable ingest → canonical/outbox → permissioned stored query', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for local PostgreSQL integration',
}, async t => {
  const { pool, store } = await createTiebaPostgresFixture(t)
  const fx = await fixture({ ledger: store, jobs: new PostgresCollectStore(pool), searchQueries: new SearchQueries({ client: null, pool }) })
  const { data } = await fx.service.submitJob(fx.owner.context, REQUEST, 'tieba-postgres-001')
  await finish(fx, pool)
  assert.equal((await fx.service.getJob(fx.owner.context, data.jobId)).status, 'succeeded')
  const queued = (await pool.query("SELECT payload FROM mxq.jobs WHERE queue='ingest' AND dedupe_key=$1", [`collect:tieba-post-search:${data.jobId}`])).rows
  assert.equal(queued.length, 1)
  const first = await ingestTiebaPostSearchResult(queued[0].payload, { pool, store })
  assert.equal(first.ingested, 1)
  const retry = await ingestTiebaPostSearchResult(queued[0].payload, { pool, store })
  assert.equal(retry.changed, 0)
  const canonical = (await pool.query("SELECT * FROM core.canonical_records WHERE platform='tieba'")).rows
  assert.equal(canonical.length, 1)
  assert.equal(canonical[0].dataset_id, 'tieba.posts.v1')
  assert.equal(canonical[0].object_type, 'post')
  assert.equal(canonical[0].body, '充电与电池续航')
  assert.equal(canonical[0].stable_fields.metrics.comments, 8)
  assert.equal(canonical[0].stable_fields.forum.name, '汽车吧')
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM outbox.projection_events')).rows[0].count, 1)
  const search = (context, key) => fx.hub.storedSearch(context, { body: { platform: 'tieba', datasetId: 'tieba.posts.v1',
    objectType: 'post', query: '新能源汽车', pageSize: 20 }, idempotencyKey: key, path: '/api/v1/data/stored/search' })
  const forumOnly = await fx.caller('forum-only', { platforms: ['data_center_saved_records_forum'], capabilities: [] })
  await assert.rejects(search(forumOnly.context, 'tieba-forum-only'), { code: 'platform_not_granted' })
  const collectOnly = await fx.caller('collect-only', { platforms: [] })
  await assert.rejects(search(collectOnly.context, 'tieba-collect-only'), { code: 'platform_not_granted' })
  const answer = await search(fx.owner.context, 'tieba-stored-001')
  assert.equal(answer.body.data.items.length, 1)
  assert.equal(answer.body.data.items[0].externalId, '123456789')
  assert.equal(answer.body.data.items[0].metrics.comments, 8)
  assert.equal(JSON.stringify(answer.body).includes('restricted-upstream-payload'), false)
  assert.equal(JSON.stringify(answer.body).includes('taskId'), false)
  const replay = await search(fx.owner.context, 'tieba-stored-001')
  assert.deepEqual(replay.body.data.items, answer.body.data.items)
  assert.equal(fx.api.calls.filter(call => call.method === 'POST').length, 1, 'ingest retries and stored queries never reacquire')
})
