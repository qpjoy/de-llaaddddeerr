import assert from 'node:assert/strict'
import test from 'node:test'
import { runAgentClassifierLoop } from '../../server/workers/classifier.mjs'

const claim = Object.freeze({
  taskId: 41,
  pipelineKey: 'province-geography-v1',
  workerId: 'worker-test',
  generation: 2,
})

function quietLogger() {
  return { log() {}, warn() {} }
}

test('classifier aborts analysis after losing its claim without acknowledging or failing it', async () => {
  const loopController = new AbortController()
  let claimCalls = 0
  let handlerSawAbort = false
  let completed = 0
  let failed = 0
  let released = 0
  const pipelineStore = {
    async reclaimExpired() { return 0 },
    async claimNext() {
      claimCalls += 1
      if (claimCalls === 1) return claim
      loopController.abort()
      return null
    },
    async heartbeat() { return false },
    async completeClaim() { completed += 1 },
    async failClaim() { failed += 1 },
    async releaseClaim() { released += 1 },
  }
  const handlers = new Map([[
    claim.pipelineKey,
    async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      handlerSawAbort = true
      throw signal.reason || new Error('lease lost')
    },
  ]])

  await runAgentClassifierLoop({
    pipelineStore,
    signal: loopController.signal,
    heartbeatMs: 1,
    idleMs: 1,
    reclaimMs: 60_000,
    handlers,
    logger: quietLogger(),
  })

  assert.equal(handlerSawAbort, true)
  assert.equal(completed, 0)
  assert.equal(failed, 0)
  assert.equal(released, 0)
})

test('classifier releases a claim on shutdown without consuming a failure attempt', async () => {
  const loopController = new AbortController()
  let completed = 0
  let failed = 0
  let released = 0
  const pipelineStore = {
    async reclaimExpired() { return 0 },
    async claimNext() { return claim },
    async heartbeat() { return true },
    async completeClaim() { completed += 1 },
    async failClaim() { failed += 1 },
    async releaseClaim() { released += 1; return { released: true } },
  }
  const handlers = new Map([[
    claim.pipelineKey,
    async ({ signal }) => {
      loopController.abort()
      await Promise.resolve()
      throw signal.reason || new Error('shutdown')
    },
  ]])

  await runAgentClassifierLoop({
    pipelineStore,
    signal: loopController.signal,
    heartbeatMs: 60_000,
    idleMs: 1,
    reclaimMs: 60_000,
    handlers,
    logger: quietLogger(),
  })

  assert.equal(completed, 0)
  assert.equal(failed, 0)
  assert.equal(released, 1)
})

test('releaseClaim is owner-fenced and restores the retry attempt', async () => {
  const queries = []
  const { AgentPipelineStore } = await import('../../server/agent/pipeline-store.mjs')
  const store = new AgentPipelineStore({
    async query(sql, parameters) {
      queries.push({ sql, parameters })
      return { rowCount: 1 }
    },
  })

  const result = await store.releaseClaim(claim)

  assert.equal(result.released, true)
  assert.match(queries[0].sql, /attempts = GREATEST\(attempts - 1, 0\)/)
  assert.match(queries[0].sql, /locked_by = \$2 AND claim_generation = \$3/)
  assert.deepEqual(queries[0].parameters, [claim.taskId, claim.workerId, claim.generation])
})
