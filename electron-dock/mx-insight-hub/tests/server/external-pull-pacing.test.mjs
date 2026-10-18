import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../server/config.mjs'
import { externalPullPageDelayMs, startLoop } from '../../server/workers/ingest.mjs'
import { runExternalPullJob } from '../../server/ingest/external/sync-job.mjs'
import { TELEGRAM_MONITOR_SOURCE_KEYS } from '../../server/ingest/telegram/monitor-pipeline.mjs'
import { TELEGRAM_SQLITE_SOURCE_KEYS } from '../../server/ingest/telegram/sqlite-pipeline.mjs'
import { PROVINCE_OPINION_SOURCE_KEY } from '../../server/ingest/province/monitor-pipeline.mjs'
import { CRAWLER_SOURCES } from '../../server/ingest/crawler/source-contract.mjs'

const base = {
  MX_INSIGHT_LISTENER_MODE: 'public',
  MX_INSIGHT_STORE: 'memory',
  MX_INSIGHT_API_KEY_PEPPER: 'offline-test-pepper-at-least-32-bytes',
}
const genericSources = [...CRAWLER_SOURCES.map(source => source.sourceKey), 'future-external-source']

for (const [name, field] of [
  ['MX_INSIGHT_EXTERNAL_PULL_PAGE_DELAY_MS', 'pageDelayMs'],
  ['MX_INSIGHT_EXTERNAL_PULL_WORKER_DELAY_MS', 'workerDelayMs'],
  ['MX_INSIGHT_TELEGRAM_MONITOR_PAGE_DELAY_MS', 'telegramMonitorPageDelayMs'],
]) test(`${name} defaults to 1000ms and accepts only the bounded integer range`, () => {
  assert.equal(loadConfig(base).externalPull[field], 1_000)
  for (const value of ['0', '1', '60000']) {
    assert.equal(loadConfig({ ...base, [name]: value }).externalPull[field], Number(value))
  }
  for (const value of ['-1', '60001', '1.5', 'invalid']) {
    assert.throws(() => loadConfig({ ...base, [name]: value }), /must be an integer between 0 and 60000/)
  }
})

test('database Telegram, Night-All-A and new sources get pacing while province and SQLite keep their defaults', () => {
  const config = loadConfig(base)
  for (const sourceKey of [...genericSources, ...TELEGRAM_MONITOR_SOURCE_KEYS, ...TELEGRAM_SQLITE_SOURCE_KEYS]) {
    assert.equal(externalPullPageDelayMs(sourceKey, config), 1_000, sourceKey)
  }
  assert.equal(externalPullPageDelayMs(PROVINCE_OPINION_SOURCE_KEY, config), 2_000)
})

test('per-source pacing selects the configured override, including explicit zero', () => {
  const config = loadConfig({ ...base,
    MX_INSIGHT_EXTERNAL_PULL_PAGE_DELAY_MS: '3100',
    MX_INSIGHT_TELEGRAM_MONITOR_PAGE_DELAY_MS: '0',
    MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS: '1200',
    MX_INSIGHT_PROVINCE_PAGE_DELAY_MS: '2300',
  })
  for (const sourceKey of genericSources) assert.equal(externalPullPageDelayMs(sourceKey, config), 3_100)
  for (const sourceKey of TELEGRAM_MONITOR_SOURCE_KEYS) assert.equal(externalPullPageDelayMs(sourceKey, config), 0)
  for (const sourceKey of TELEGRAM_SQLITE_SOURCE_KEYS) assert.equal(externalPullPageDelayMs(sourceKey, config), 1_200)
  assert.equal(externalPullPageDelayMs(PROVINCE_OPINION_SOURCE_KEY, config), 2_300)
})

test('paced continuations release the worker without timers and retain the original payload even at shutdown', async t => {
  const config = loadConfig({ ...base, MX_INSIGHT_TELEGRAM_MONITOR_PAGE_DELAY_MS: '60000' })
  const now = new Date('2026-10-19T00:00:00Z')
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('page pacing must not sleep in the worker') })
  for (const sourceKey of [...TELEGRAM_MONITOR_SOURCE_KEYS, genericSources[0], genericSources.at(-1),
    PROVINCE_OPINION_SOURCE_KEY, ...TELEGRAM_SQLITE_SOURCE_KEYS]) {
    const payload = { sourceKey, chunk: 4, batchSize: 250, importRunId: 'original-run', trigger: 'schedule' }
    const original = structuredClone(payload)
    const calls = []
    let pulls = 0, cleared = false
    await runExternalPullJob({
      puller: { async pullBatch(key, options) {
        pulls++
        assert.equal(key, sourceKey)
        assert.deepEqual(options, { batchSize: 250, importRunId: 'original-run', trigger: 'schedule' })
        return { pulled: 250, ingested: 250, changed: 0, importRunId: 'original-run', done: false }
      } },
      queue: { async heartbeat() {}, async enqueue(...args) { calls.push(args) } },
      payload, job: { id: 5 }, signal: { aborted: true }, logger: { log() {} },
      continuationDelayMs: externalPullPageDelayMs(sourceKey, config), now: () => now,
      setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => { cleared = true },
    })
    assert.equal(pulls, 1)
    assert.equal(cleared, true)
    assert.deepEqual(payload, original)
    assert.deepEqual(calls, [['external-pull', { ...original, chunk: 5 }, {
      dedupeKey: `external-pull:${sourceKey}:5`, priority: 220,
      runAt: new Date(now.getTime() + externalPullPageDelayMs(sourceKey, config)),
    }]])
  }
})

test('zero pacing keeps an immediately eligible continuation and a finished source never requeues', async () => {
  const calls = []
  for (const done of [false, true]) {
    await runExternalPullJob({
      puller: { async pullBatch() { return { pulled: 1, ingested: 1, importRunId: 'same-run', done } } },
      queue: { async heartbeat() {}, async enqueue(...args) { calls.push(args) } },
      payload: { sourceKey: genericSources[0], batchSize: 1 }, job: { id: 1 },
      continuationDelayMs: 0, logger: { log() {} },
    })
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].runAt, undefined)
  assert.equal(calls[0][1].importRunId, 'same-run')
})

test('external-pull worker waits after settling a page even when another source is ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const config = loadConfig(base), controller = new AbortController(), calls = []
  const queue = {
    async reclaimExpired() {},
    async claim(name, concurrency) {
      calls.push(['claim', name, concurrency])
      const id = calls.filter(([kind]) => kind === 'claim').length
      return id < 3 ? [{ id, payload: { sourceKey: genericSources[id] } }] : []
    },
    async complete(id) { calls.push(['complete', id]) },
    async fail() { assert.fail('successful batch must not fail') },
  }
  const done = startLoop(queue, 'external-pull', async () => {}, controller.signal, 1, config.externalPull.workerDelayMs)
  t.after(async () => { controller.abort(); t.mock.timers.tick(60_000); await done })
  await new Promise(setImmediate)
  assert.deepEqual(calls, [['claim', 'external-pull', 1], ['complete', 1]])
  t.mock.timers.tick(999)
  await new Promise(setImmediate)
  assert.equal(calls.length, 2)
  t.mock.timers.tick(1)
  await new Promise(setImmediate)
  assert.deepEqual(calls, [['claim', 'external-pull', 1], ['complete', 1], ['claim', 'external-pull', 1], ['complete', 2]])
  controller.abort()
  await done
})
