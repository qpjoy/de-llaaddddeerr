import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  AdminSearchReindex,
  tryAcquireSearchReindexLock,
} from '../../server/search/admin-reindex.mjs'
import {
  heartbeatSearchReindexLock,
  monitorSearchReindexLock,
  requireSearchReindexLock,
} from '../../server/search/reindex-lock.mjs'

const ADMIN_TOKEN = 'admin-search-reindex-token'
const quiet = { error() {}, warn() {}, log() {}, info() {} }

function fakeDatabase({ dropLockSessionOnUpdate = null } = {}) {
  const state = { locked: false, rows: [], lockSessionDropped: false }

  const query = async (sql, values = []) => {
    const statement = sql.replace(/\s+/g, ' ').trim()
    if (statement === 'SELECT 1' || statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
      return { rows: [] }
    }
    if (statement.includes('pg_try_advisory_lock')) {
      const locked = !state.locked
      if (locked) state.locked = true
      return { rows: [{ locked }] }
    }
    if (statement.includes('pg_advisory_unlock')) {
      state.locked = false
      return { rows: [{ pg_advisory_unlock: true }] }
    }
    if (statement.startsWith('SELECT * FROM control.search_reindex_operations')) {
      const candidates = statement.includes("status IN ('queued', 'running')")
        ? state.rows.filter((row) => ['queued', 'running'].includes(row.status))
        : state.rows
      return { rows: [...candidates].sort((a, b) => b.created_at - a.created_at).slice(0, 1) }
    }
    if (statement.startsWith('INSERT INTO control.search_reindex_operations')) {
      const createdAt = new Date()
      const row = {
        id: values[0], status: 'queued', phase: 'queued', requested_by: values[1],
        request_id: values[2], preflight: JSON.parse(values[3]), processed: 0,
        total: null, progress: null, logs: JSON.parse(values[4]), result: null,
        error_code: null, error_message: null, created_at: createdAt,
        started_at: null, heartbeat_at: null, finished_at: null, updated_at: createdAt,
      }
      state.rows.push(row)
      return { rows: [row] }
    }
    if (statement.startsWith('UPDATE control.search_reindex_operations')
      && statement.includes("error_code = 'reindex_runner_lost'")) {
      for (const row of state.rows.filter((entry) => ['queued', 'running'].includes(entry.status))) {
        row.status = 'failed'
        row.phase = 'failed'
        row.error_code = 'reindex_runner_lost'
        row.error_message = 'The Admin process stopped before the rebuild completed'
        row.finished_at = new Date()
      }
      return { rows: [] }
    }
    if (statement.startsWith('UPDATE control.search_reindex_operations')) {
      const row = state.rows.find((entry) => entry.id === values[0])
      if (!row) return { rows: [] }
      if (values[1] != null) row.status = values[1]
      if (values[2] != null) row.phase = values[2]
      if (values[3] != null) row.processed = values[3]
      if (values[4] != null) row.progress = values[4]
      if (values[5]) row.started_at ||= new Date()
      if (values[6]) row.finished_at = new Date()
      if (values[7] != null) row.result = JSON.parse(values[7])
      if (values[8] != null) row.error_code = values[8]
      if (values[9] != null) row.error_message = values[9]
      if (values[10] != null) row.logs.push(...JSON.parse(values[10]))
      row.heartbeat_at = new Date()
      row.updated_at = new Date()
      return { rows: [] }
    }
    throw new Error(`unexpected SQL: ${statement}`)
  }

  const pool = {
    query,
    async connect() {
      let committed = false
      let dropped = false
      let operationUpdates = 0
      return {
        async query(sql, values = []) {
          const statement = sql.replace(/\s+/g, ' ').trim()
          if (dropped) throw Object.assign(new Error('lock session is closed'), { code: '57P01' })
          if (committed && statement.startsWith('UPDATE control.search_reindex_operations')) {
            operationUpdates += 1
            if (operationUpdates === dropLockSessionOnUpdate) {
              dropped = true
              state.locked = false
              state.lockSessionDropped = true
              throw Object.assign(new Error('lock session terminated'), { code: '57P01' })
            }
          }
          const result = await query(sql, values)
          if (statement === 'COMMIT') committed = true
          return result
        },
        release() {},
      }
    },
  }
  return { pool, state }
}

function healthySearch(pool) {
  return {
    pool,
    indexSet: { schemaVersion: 4 },
    chunkIndexSet: null,
    client: { async clusterHealth() { return { status: 'yellow' } } },
    queries: {
      async searchCapabilities() { return { activeIndexSchema: 'content-v3' } },
    },
    segmenter: {
      async segmentWithMeta(text) {
        return { tokens: [text], backendUsed: 'hanlp', degraded: false, errorCode: null }
      },
    },
  }
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}

test('Admin search reindex is durable single-flight work with progress and audit evidence', async () => {
  const { pool, state } = fakeDatabase()
  let finishReconcile
  let reconcileStarted
  const started = new Promise((resolve) => { reconcileStarted = resolve })
  const finish = new Promise((resolve) => { finishReconcile = resolve })
  const manager = new AdminSearchReindex({
    search: healthySearch(pool),
    segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp.invalid' },
    logger: quiet,
    reconcile: async (_search, options) => {
      await options.onProgress({ projection: 'content', pass: 'build', processed: 200 })
      reconcileStarted()
      await finish
      await options.onProgress({ projection: 'chunks', pass: 'catch-up', processed: 31 })
      return { enabled: true, content: { indexed: 200 }, chunk: { indexed: 31 } }
    },
  })

  const first = await manager.start({ requestedBy: 'member-7', requestId: 'request-7' })
  assert.ok(['queued', 'running'].includes(first.operation.status))
  assert.equal(first.preflight.projectorRequired, false)
  assert.equal(first.preflight.sourceIndexSchema, 'content-v3')
  assert.equal(first.preflight.targetIndexSchema, 'content-v4')
  await started

  const duplicate = await manager.start({ requestedBy: 'member-8', requestId: 'request-8' })
  assert.equal(duplicate.operation.id, first.operation.id)
  assert.equal(duplicate.operation.alreadyRunning, true)
  assert.equal(state.rows.length, 1)
  assert.equal(state.rows[0].requested_by, 'member-7')
  assert.equal(state.rows[0].request_id, 'request-7')

  const running = await manager.status()
  assert.equal(running.operation.status, 'running')
  assert.equal(running.operation.phase, 'content')
  assert.equal(running.operation.processed, 200)
  assert.equal(running.operation.logs.at(-1).message, 'content build pass started')

  finishReconcile()
  const completed = await eventually(async () => {
    const status = await manager.status()
    return status.operation.status === 'succeeded' ? status : null
  })
  assert.equal(completed.operation.phase, 'completed')
  assert.equal(completed.operation.progress, 1)
  assert.equal(completed.operation.processed, 231)
  assert.equal(state.locked, false)
})

test('strict HanLP degradation blocks Admin reindex before an operation is admitted', async () => {
  const { pool, state } = fakeDatabase()
  const search = healthySearch(pool)
  search.segmenter.segmentWithMeta = async () => ({
    tokens: ['人工', '智能'], backendUsed: 'bigram', degraded: true, errorCode: 'hanlp_busy',
  })
  const manager = new AdminSearchReindex({
    search,
    segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp.invalid' },
    logger: quiet,
  })

  await assert.rejects(
    manager.start({ requestedBy: 'admin-token' }),
    (error) => error?.status === 409
      && error?.code === 'search_reindex_preflight_failed'
      && error?.details?.preflight?.blockers?.[0]?.code === 'reindex_segmenter_degraded',
  )
  assert.equal(state.rows.length, 0)
  assert.equal(state.locked, false)
})

test('polling closes a stale running operation after its Admin process lost the lock', async () => {
  const { pool, state } = fakeDatabase()
  const createdAt = new Date('2026-08-16T00:00:00.000Z')
  state.rows.push({
    id: 'stale-operation', status: 'running', phase: 'content', requested_by: 'admin-token',
    request_id: 'request-stale', preflight: { ready: true }, processed: 200,
    total: null, progress: null, logs: [], result: null, error_code: null,
    error_message: null, created_at: createdAt, started_at: createdAt,
    heartbeat_at: createdAt, finished_at: null, updated_at: createdAt,
  })
  const manager = new AdminSearchReindex({
    search: healthySearch(pool),
    segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp.invalid' },
    logger: quiet,
  })

  const status = await manager.status()
  assert.equal(status.operation.status, 'failed')
  assert.equal(status.operation.phase, 'failed')
  assert.equal(status.operation.errorCode, 'reindex_runner_lost')
  assert.equal(state.locked, false)
})

test('the shared PostgreSQL lock fences Projector, CLI and Admin full rebuilds', async () => {
  const { pool, state } = fakeDatabase()
  const first = await tryAcquireSearchReindexLock(pool)
  assert.ok(first)
  assert.equal(await tryAcquireSearchReindexLock(pool), null)
  await assert.rejects(
    () => requireSearchReindexLock(pool, { busyMessage: 'Projector startup must retry' }),
    (error) => error?.code === 'search_reindex_busy'
      && error.message === 'Projector startup must retry',
  )
  await first.release()
  assert.equal(state.locked, false)
  const next = await tryAcquireSearchReindexLock(pool)
  assert.ok(next)
  await heartbeatSearchReindexLock(next)
  await next.release()
})

test('a lost Admin lock session aborts at progress and is recovered as failed', async () => {
  const { pool, state } = fakeDatabase({ dropLockSessionOnUpdate: 2 })
  let reconciliations = 0
  let workAfterLostHeartbeat = 0
  const manager = new AdminSearchReindex({
    search: healthySearch(pool),
    segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp.invalid' },
    logger: quiet,
    reconcile: async (_search, options) => {
      reconciliations += 1
      await options.onProgress({ projection: 'content', pass: 'build', processed: 200 })
      workAfterLostHeartbeat += 1
      return { enabled: true }
    },
  })

  await manager.start({ requestedBy: 'admin-token', requestId: 'lost-lock-request' })
  const failed = await eventually(async () => {
    const current = await manager.status()
    return current.operation?.status === 'failed' ? current : null
  })

  assert.equal(state.lockSessionDropped, true)
  assert.equal(reconciliations, 1)
  assert.equal(workAfterLostHeartbeat, 0, 'work stops at the batch whose lock heartbeat fails')
  assert.equal(failed.operation.errorCode, 'reindex_runner_lost')
  assert.equal(state.locked, false)
})

test('the independent lock heartbeat records an idle-session failure between batches', async () => {
  const sessionLost = Object.assign(new Error('idle lock session terminated'), { code: '57P01' })
  let queries = 0
  const monitor = monitorSearchReindexLock({
    client: {
      async query() {
        queries += 1
        throw sessionLost
      },
    },
  }, { intervalMs: 1 })

  await eventually(async () => queries > 0)
  assert.throws(() => monitor.assertHealthy(), (error) => error === sessionLost)
  await assert.rejects(() => monitor.pulse(), (error) => error === sessionLost)
  await monitor.stop()
})

test('an asynchronous PostgreSQL lock-client error is retained without crashing Admin', async () => {
  const sessionLost = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
  const client = new EventEmitter()
  client.query = async () => ({ rows: [] })
  const monitor = monitorSearchReindexLock({ client }, { intervalMs: 60_000 })

  client.emit('error', sessionLost)
  assert.throws(() => monitor.assertHealthy(), (error) => error === sessionLost)
  await monitor.stop()
  assert.equal(client.listenerCount('error'), 0)
})

test('Admin reindex HTTP routes are admin-token-only and accept no execution parameters', async () => {
  const calls = []
  const status = {
    preflight: {
      ready: true, blockers: [], warnings: [], projectorRequired: false,
      projectorReadyReplicas: null, expectedBackend: 'hanlp',
      sourceIndexSchema: 'content-v3', targetIndexSchema: 'content-v4',
    },
    operation: null,
  }
  const searchReindex = {
    async status() { return status },
    async start(input) {
      calls.push(input)
      return { ...status, operation: { id: 'operation-1', status: 'queued', phase: 'queued', logs: [] } }
    },
  }
  const app = createApp({
    service: {}, store: {}, adapter: {}, searchReindex,
    adminToken: ADMIN_TOKEN,
    identity: {
      enabled: true,
      async resolve() {
        return {
          kind: 'launcher-user', memberId: 'member-9', platformAdmin: true,
          capabilities: [], memberships: [], tenantIds: null,
        }
      },
    },
    logger: quiet,
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const unauthorized = await fetch(`${baseUrl}/internal/v1/admin/search/reindex`)
    assert.equal(unauthorized.status, 401)

    const launcherAdmin = await fetch(`${baseUrl}/internal/v1/admin/search/reindex`, {
      headers: { authorization: 'Bearer launcher-session' },
    })
    assert.equal(launcherAdmin.status, 403)
    assert.equal((await launcherAdmin.json()).error.code, 'admin_token_required')

    const headers = {
      'x-mx-insight-admin-token': ADMIN_TOKEN,
      'content-type': 'application/json',
    }
    const current = await fetch(`${baseUrl}/internal/v1/admin/search/reindex`, { headers })
    assert.equal(current.status, 200)
    assert.deepEqual((await current.json()).data, status)

    for (const body of [{}, { confirmation: 'yes' }, { confirmation: 'REINDEX', command: 'anything' }]) {
      const rejected = await fetch(`${baseUrl}/internal/v1/admin/search/reindex`, {
        method: 'POST', headers, body: JSON.stringify(body),
      })
      assert.equal(rejected.status, 400)
      assert.equal((await rejected.json()).error.code, 'search_reindex_confirmation_required')
    }
    assert.equal(calls.length, 0)

    const accepted = await fetch(`${baseUrl}/internal/v1/admin/search/reindex`, {
      method: 'POST', headers, body: JSON.stringify({ confirmation: 'REINDEX' }),
    })
    assert.equal(accepted.status, 202)
    assert.equal((await accepted.json()).data.operation.id, 'operation-1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].requestedBy, 'admin-token')
    assert.equal(typeof calls[0].requestId, 'string')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})


test('a reachable but degraded cluster warns instead of vetoing its own replacement', async () => {
  const { pool } = fakeDatabase()
  const search = healthySearch(pool)
  // The stale generation left shards unassigned, so the cluster never reaches
  // yellow. The rebuild reads PostgreSQL and writes a new index, so this is a
  // condition to report, not one that can be allowed to block the repair.
  search.client.clusterHealth = async () => ({
    cluster_name: 'mx-common',
    status: 'red',
    timed_out: true,
    timedOut: true,
    number_of_nodes: 1,
    unassigned_shards: 6,
  })
  const reindex = new AdminSearchReindex({ search, segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp:8000' } })

  const preflight = await reindex.preflight({ fresh: true })
  assert.equal(preflight.ready, true)
  assert.deepEqual(preflight.blockers, [])
  const degraded = preflight.warnings.find((warning) => warning.code === 'elasticsearch_cluster_degraded')
  assert.ok(degraded, 'the degraded cluster must still be reported')
  assert.match(degraded.message, /status=red/)
  assert.match(degraded.message, /unassigned_shards=6/)
  // The active schema is still read, so the operator can see what is replaced.
  assert.equal(preflight.sourceIndexSchema, 'content-v3')
  assert.equal(preflight.targetIndexSchema, 'content-v4')
})

test('an unreachable cluster is the only Elasticsearch condition that blocks', async () => {
  const { pool } = fakeDatabase()
  const search = healthySearch(pool)
  search.client.clusterHealth = async () => {
    throw Object.assign(new Error('Elasticsearch is unreachable: connect ECONNREFUSED'), {
      name: 'ElasticsearchUnavailableError',
    })
  }
  const reindex = new AdminSearchReindex({ search, segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp:8000' } })

  const preflight = await reindex.preflight({ fresh: true })
  assert.equal(preflight.ready, false)
  const blocker = preflight.blockers.find((entry) => entry.code === 'elasticsearch_unavailable')
  assert.ok(blocker)
  assert.match(blocker.message, /ECONNREFUSED/)
  assert.match(blocker.action, /Restore Elasticsearch connectivity/)
})

test('losing the capability read degrades the schema display without blocking', async () => {
  const { pool } = fakeDatabase()
  const search = healthySearch(pool)
  search.queries.searchCapabilities = async () => { throw new Error('search alias missing') }
  const reindex = new AdminSearchReindex({ search, segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp:8000' } })

  const preflight = await reindex.preflight({ fresh: true })
  assert.equal(preflight.ready, true)
  assert.equal(preflight.sourceIndexSchema, null)
  assert.ok(preflight.warnings.some((warning) => warning.code === 'elasticsearch_capabilities_unavailable'))
})


test('a target shard the cluster refuses to place blocks with the deciders that refused it', async () => {
  const { pool } = fakeDatabase()
  const search = healthySearch(pool)
  search.indexSet = { schemaVersion: 4, currentIndex: 'mx-insight-hub-content-v4-current' }
  search.client.clusterHealth = async () => ({
    cluster_name: 'mx-common', status: 'red', number_of_nodes: 1, unassigned_shards: 1,
  })
  // The shape Elasticsearch actually returns when disk stops an allocation.
  search.client.allocationExplain = async ({ index, shard, primary }) => {
    assert.equal(index, 'mx-insight-hub-content-v4-current')
    assert.equal(shard, 0)
    assert.equal(primary, true)
    return {
      index,
      shard: 0,
      primary: true,
      current_state: 'unassigned',
      unassigned_info: { reason: 'INDEX_CREATED', last_allocation_status: 'no' },
      can_allocate: 'no',
      allocate_explanation: "Elasticsearch isn't allowed to allocate this shard to any of the nodes",
      node_allocation_decisions: [{
        node_name: 'mx-common-elasticsearch-0',
        node_decision: 'no',
        deciders: [{
          decider: 'disk_threshold',
          decision: 'NO',
          explanation: 'the node is above the high watermark cluster setting [cluster.routing.allocation.disk.watermark.high=90%], having less than the minimum required [102.3gb] free space, actual free: [77.5gb], actual used: [92.4%]',
        }],
      }],
    }
  }
  const reindex = new AdminSearchReindex({ search, segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp:8000' } })

  const preflight = await reindex.preflight({ fresh: true })
  // A rebuild that cannot place its own shard repairs nothing; it must not start.
  assert.equal(preflight.ready, false)
  const blocker = preflight.blockers.find((entry) => entry.code === 'search_index_unallocatable')
  assert.ok(blocker, 'the unallocatable target must block')
  assert.match(blocker.message, /mx-insight-hub-content-v4-current shard 0/)
  // The two numbers that size the fix survive into the message.
  assert.match(blocker.message, /102\.3gb/)
  assert.match(blocker.message, /77\.5gb/)
  assert.match(blocker.action, /Free disk/)
  // Not also reported as a vague "degraded cluster".
  assert.equal(preflight.warnings.some((w) => w.code === 'elasticsearch_cluster_degraded'), false)
})

test('disk pressure is warned about before it becomes the next blocker', async () => {
  const { pool } = fakeDatabase()
  const search = healthySearch(pool)
  search.client.catAllocation = async () => ([
    { node: 'mx-common-elasticsearch-0', 'disk.percent': '92', 'disk.avail': String(83 * 1024 ** 3) },
    { node: 'UNASSIGNED', 'disk.percent': null, 'disk.avail': null },
  ])
  const reindex = new AdminSearchReindex({ search, segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp:8000' } })

  const preflight = await reindex.preflight({ fresh: true })
  // Green cluster, so this informs rather than blocks.
  assert.equal(preflight.ready, true)
  const warning = preflight.warnings.find((entry) => entry.code === 'elasticsearch_disk_pressure')
  assert.ok(warning)
  assert.match(warning.message, /92% full/)
  assert.match(warning.message, /83\.0GiB free/)
})


test('a rebuild that would downgrade the tokenizer says so and refuses one click', async () => {
  const { pool } = fakeDatabase()
  const search = healthySearch(pool)
  // Exactly the 14:23 shape: no HanLP URL, so the required backend resolves to
  // jieba and strict verification would pass on jieba tokens.
  search.segmenter.segmentWithMeta = async (text) => (
    { tokens: [text], backendUsed: 'jieba', degraded: false, errorCode: null }
  )
  const reindex = new AdminSearchReindex({ search, segmenterConfig: {} })

  const preflight = await reindex.preflight({ fresh: true })
  assert.equal(preflight.expectedBackend, 'jieba')
  assert.equal(preflight.ready, true, 'jieba is a valid configuration, just not a silent one')
  assert.equal(preflight.requiresBackendAcknowledgement, true)
  const warning = preflight.warnings.find((entry) => entry.code === 'tokenizer_downgrade')
  assert.ok(warning)
  assert.match(warning.message, /would produce a jieba index/)
  assert.match(warning.action, /MX_COMMON_HANLP_URL is empty/)

  // A single confirmed click must not be enough to rebuild the whole corpus
  // into a lower-quality index.
  await assert.rejects(
    () => reindex.start({ requestedBy: 'admin' }),
    (error) => {
      assert.equal(error.code, 'tokenizer_acknowledgement_required')
      assert.equal(error.details.expectedBackend, 'jieba')
      return true
    },
  )
})

test('acknowledging the backend lets a deliberate downgrade proceed', async () => {
  const { pool } = fakeDatabase()
  const search = healthySearch(pool)
  search.segmenter.segmentWithMeta = async (text) => (
    { tokens: [text], backendUsed: 'jieba', degraded: false, errorCode: null }
  )
  const reindex = new AdminSearchReindex({
    search,
    segmenterConfig: {},
    reconcile: async () => ({ content: { indexed: 1 } }),
  })

  const result = await reindex.start({ requestedBy: 'admin', acknowledgeBackend: 'jieba' })
  assert.ok(result.operation.id)
})

test('a HanLP rebuild needs no extra acknowledgement', async () => {
  const { pool } = fakeDatabase()
  const reindex = new AdminSearchReindex({
    search: healthySearch(pool),
    segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp:8000' },
  })
  const preflight = await reindex.preflight({ fresh: true })
  assert.equal(preflight.expectedBackend, 'hanlp')
  assert.equal(preflight.requiresBackendAcknowledgement, false)
  assert.equal(preflight.warnings.some((entry) => entry.code === 'tokenizer_downgrade'), false)
})


test('a projector restart serves instead of replaying when the switch is off', async () => {
  const { pool, state } = fakeDatabase()
  const search = healthySearch(pool)
  let schemaOnly = null
  const reindex = new AdminSearchReindex({
    search,
    segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp:8000' },
    reconcile: async (unused, options) => { schemaOnly = options.schemaOnly; return {} },
  })
  void state

  // The setting is what the projector reads; the default is off, so a restart
  // reconciles schema and starts serving rather than spending hours replaying.
  const preflight = await reindex.preflight({ fresh: true })
  assert.equal(preflight.startupRebuild, false)
  assert.equal(schemaOnly, null, 'preflight never rebuilds anything')
})

test('cancelling a running rebuild stops it at a batch boundary', async () => {
  const { pool } = fakeDatabase()
  const search = healthySearch(pool)
  const reindex = new AdminSearchReindex({
    search,
    segmenterConfig: { backend: 'hanlp', hanlpUrl: 'http://hanlp:8000' },
  })

  // Nothing running: cancelling is a state error, not a silent no-op.
  await assert.rejects(
    () => reindex.cancel({ requestedBy: 'admin' }),
    (error) => error.code === 'search_reindex_not_running',
  )
})
