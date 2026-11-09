import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HubService, businessApiScopes } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { MemoryCollectStore } from '../../server/collect/store.mjs'
import { CollectExecutor } from '../../server/collect/executor.mjs'
import { CollectService } from '../../server/collect/service.mjs'
import { createCollectContracts } from '../../server/collect/contracts/index.mjs'
import { normalizeJobRequest } from '../../server/collect/catalog.mjs'
import { COLLECT_AUDIO_PLATFORM_SLOTS, COLLECT_CAPABILITIES, collectEgressProvider } from '../../shared/collect-engines.mjs'

// Integration plan phase 6: audio shows and episodes on the runner.
const PEPPER = 'collect-audio-test-pepper-at-least-32-bytes'
const SHOWS = 'collect.audio.shows'
const EPISODES = 'collect.audio.episodes'
const XYZ = '5e4ee557418a84a0466737b7'
const normalize = (capability, input) => normalizeJobRequest({ capability, input })
const rejects = (capability, input) => assert.throws(() => normalize(capability, input), { code: 'invalid_collect_request' }, JSON.stringify(input))
const audioEnvelope = (operation, status, items) => ({ schema_version: '1.0', project_id: '45', source_id: '45', operation, observed_at: '2026-11-09T08:00:00Z',
  status, result: { items, errors: [], warnings: [], stats: null, pagination: null }, error: null })

test('audio: every platform has its own reviewed inputs; package sample IDs are never used', () => {
  const shows = [
    [{ platform: 'xiaoyuzhou', podcastIds: [XYZ.toUpperCase()] }, { podcast_ids: [XYZ], limit: 1 }],
    [{ platform: 'xiaoyuzhou', episodeIds: ['6aaa6e139d326477816a1bf6'] }, { episode_ids: ['6aaa6e139d326477816a1bf6'], limit: 1 }],
    [{ platform: 'ximalaya', trackIds: [3558286, '42'] }, { track_ids: ['3558286', '42'], limit: 2 }],
    [{ platform: 'apple', keyword: 'BBC Minute', limit: 3 }, { mode: 'search', keyword: 'BBC Minute', country: 'us', limit: 3 }],
    [{ platform: 'apple', mode: 'charts', genreId: '1318', country: 'GB' }, { mode: 'charts', genre_id: 1318, country: 'gb', limit: 10 }],
    [{ platform: 'librivox', offset: 30, limit: 5 }, { offset: 30, limit: 5 }],
  ]
  for (const [input, params] of shows) {
    const { item, definition } = normalize(SHOWS, input)
    assert.equal(item.routeKey, input.platform)
    assert.deepEqual(definition.runner(item.input), { operation: 'discover', params: { request_timeout: 30, total_timeout: 120, ...params } }, JSON.stringify(input))
  }
  rejects(SHOWS, { platform: 'xiaoyuzhou' }) // no IDs: the package would fall back to its sample show
  rejects(SHOWS, { platform: 'xiaoyuzhou', podcastIds: [XYZ], episodeIds: [XYZ] })
  rejects(SHOWS, { platform: 'xiaoyuzhou', podcastIds: ['https://www.xiaoyuzhoufm.com/podcast/x'] })
  rejects(SHOWS, { platform: 'ximalaya', trackIds: [] })
  rejects(SHOWS, { platform: 'ximalaya', trackIds: Array.from({ length: 21 }, (_, index) => String(index + 1)) })
  rejects(SHOWS, { platform: 'apple' })
  rejects(SHOWS, { platform: 'apple', mode: 'charts' })
  rejects(SHOWS, { platform: 'apple', mode: 'charts', genreId: 1318, keyword: 'x' })
  rejects(SHOWS, { platform: 'apple', keyword: 'x', country: 'usa' })
  rejects(SHOWS, { platform: 'librivox', limit: 21 })
  rejects(SHOWS, { platform: 'podcastindex', keyword: 'x' }) // waits for credentials
  rejects(SHOWS, { platform: 'librivox', run_dir: '/etc' })
  rejects(SHOWS, { platform: 'librivox', episodesPerShow: 5 }) // only for episodes
})

test('audio episodes: discover then collect in one invocation, bounded to 10 shows x 50 episodes', () => {
  const { item, definition } = normalize(EPISODES, { platform: 'ximalaya', trackIds: ['3558286'], episodesPerShow: 20 })
  assert.deepEqual(definition.runner(item.input), { steps: [
    { operation: 'discover', params: { request_timeout: 30, total_timeout: 120, track_ids: ['3558286'], limit: 1 } },
    { operation: 'collect', params: { request_timeout: 30, total_timeout: 300, feed_limit: 1, episodes_per_feed: 20, probe_range: 0, max_track_requests: 20 } },
  ] })
  const apple = normalize(EPISODES, { platform: 'apple', keyword: 'BBC Minute', limit: 3 })
  assert.deepEqual(apple.definition.runner(apple.item.input).steps[1].params, { request_timeout: 30, total_timeout: 300, feed_limit: 3, episodes_per_feed: 10 })
  rejects(EPISODES, { platform: 'librivox', limit: 11 })
  rejects(EPISODES, { platform: 'xiaoyuzhou', podcastIds: Array.from({ length: 11 }, (_, index) => index.toString(16).padStart(24, '0')) })
  rejects(EPISODES, { platform: 'librivox', episodesPerShow: 51 })
})

test('audio capabilities are public candidates; domestic platforms go direct, overseas ones through the binding', () => {
  for (const key of [SHOWS, EPISODES]) {
    const capability = COLLECT_CAPABILITIES.find(row => row.key === key)
    assert.deepEqual(capability.routes.map(route => [route.key, route.slotRef]), Object.entries(COLLECT_AUDIO_PLATFORM_SLOTS))
    assert.equal(capability.stage, 'candidate')
    assert.equal(businessApiScopes().capabilities.includes(key), false)
  }
  assert.equal(collectEgressProvider({ kind: 'runner', slotRef: 'xiaoyuzhou-45' }), null)
  assert.equal(collectEgressProvider({ kind: 'runner', slotRef: 'ximalaya-46' }), null)
  assert.equal(collectEgressProvider({ kind: 'runner', slotRef: 'applepodcasts-220' }), 'overseas')
  assert.equal(collectEgressProvider({ kind: 'runner', slotRef: 'librivox-222' }), 'overseas')
})

async function fixture({ fetchImpl, egressFor = async () => 'http://127.0.0.1:7788', baseUrl = 'http://127.0.0.1:18190' }) {
  const ledger = new MemoryStore()
  const hub = new HubService({ store: ledger, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await hub.createTenant({ name: 'Delta' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'LCY-delta' })
  await ledger.setPlatformGrant(consumer.id, 'audio', true)
  for (const capability of [SHOWS, EPISODES]) await hub.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'delta', platforms: ['audio'], capabilities: [SHOWS, EPISODES] })
  const context = await hub.authenticate(key.secret)
  const jobs = new MemoryCollectStore()
  const contracts = createCollectContracts()
  const credentialsFor = async () => 'runner-token-0123456789abcdef'
  const executor = new CollectExecutor({ jobs, ledger, contracts, credentialsFor, logger: { error() {}, warn() {} }, pollMs: 60_000,
    policyFor: (ctx, platform) => hub.usagePolicy(ctx, platform), fetchImpl, deps: { egressFor } })
  executor.stopped = false
  const service = new CollectService({ jobs, ledger, contracts, executor, credentialsFor, fetchImpl })
  for (const [platform, slotRef] of Object.entries(COLLECT_AUDIO_PLATFORM_SLOTS)) {
    await service.adminCreateEngine({ kind: 'runner', id: `runner.${slotRef}`, displayName: platform, slotRef, baseUrl, enabled: true,
      routes: [{ capability: SHOWS, routeKey: platform }, { capability: EPISODES, routeKey: platform }], reason: '测试引擎' }, 'tester')
  }
  return { context, jobs, executor, service }
}
async function settle(fx, jobId) {
  for (let attempt = 0; attempt < 200 && ['queued', 'running'].includes((await fx.jobs.get(jobId)).status); attempt++) {
    for (const job of fx.jobs.jobs.values()) if (job.phase === 'waiting') job.nextCheckAt = new Date(Date.now() - 1).toISOString()
    await fx.executor.drain()
    await new Promise(done => setTimeout(done, 25))
  }
  return fx.jobs.get(jobId)
}

test('audio contract: steps are sent as steps; the last step decides, an earlier partial keeps it partial', async () => {
  const posts = []
  let answer
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return Response.json({ data: { state: 'accepted' } }, { status: 202 }) }
    return Response.json({ data: answer() })
  }
  const fx = await fixture({ fetchImpl })
  answer = () => ({ state: 'completed', operation: 'discover+collect', durationMs: 3000,
    envelope: audioEnvelope('collect', 'success', [{ id: 'e1', url: 'https://media.xyzcdn.net/a.m4a' }, { id: 'e2', url: 'https://media.xyzcdn.net/b.m4a' }]),
    steps: [{ operation: 'discover', status: 'partial', envelope: audioEnvelope('discover', 'partial', [{ id: 's1', title: '忽左忽右' }]) },
      { operation: 'collect', status: 'success' }] })
  const { data } = await fx.service.submitJob(fx.context, { capability: EPISODES, input: { platform: 'xiaoyuzhou', podcastIds: [XYZ], episodesPerShow: 2 } }, 'audio-episodes-01')
  const job = await settle(fx, data.jobId)
  assert.deepEqual(posts[0].steps.map(step => step.operation), ['discover', 'collect'])
  assert.equal(posts[0].operation, undefined)
  assert.equal(posts[0].proxyUrl, undefined, '小宇宙 is direct')
  assert.equal(job.status, 'succeeded')
  assert.equal(job.dataStatus, 'partial', 'one show of the discovery failed')
  assert.equal(job.result.itemCount, 2)
  const { payload } = await fx.jobs.result(data.jobId)
  assert.deepEqual(payload.steps.map(step => [step.operation, step.envelope.result.items.length]), [['discover', 1], ['collect', 2]])

  // A discovery that found nothing ends there: no_data, collect never ran.
  answer = () => ({ state: 'completed', operation: 'discover', durationMs: 900, envelope: audioEnvelope('discover', 'no_data', []),
    steps: [{ operation: 'discover', status: 'no_data' }] })
  const empty = await fx.service.submitJob(fx.context, { capability: EPISODES, input: { platform: 'apple', keyword: 'nothing at all', limit: 1 } }, 'audio-episodes-02')
  const none = await settle(fx, empty.data.jobId)
  assert.equal(none.dataStatus, 'no_data')
  assert.equal(posts[1].proxyUrl, 'http://127.0.0.1:7788', 'Apple Podcasts goes through the overseas binding')
})

// Protocol check against the real runner: Hub sends steps, the runner runs
// them in one run_dir, Hub stores both envelopes.
const RUNNER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../mx-base/mx-crawler-runner')
test('end to end with mx-crawler-runner: two steps share one run_dir', { skip: !existsSync(join(RUNNER_ROOT, 'src', 'runner.mjs')) && 'mx-crawler-runner not present' }, async () => {
  const { Runner } = await import(pathToFileURL(join(RUNNER_ROOT, 'src', 'runner.mjs')).href)
  const { loadCatalog, treeHash } = await import(pathToFileURL(join(RUNNER_ROOT, 'src', 'catalog.mjs')).href)
  const { createRunnerServer } = await import(pathToFileURL(join(RUNNER_ROOT, 'src', 'http.mjs')).href)
  const dir = mkdtempSync(join(tmpdir(), 'hub-audio-e2e-'))
  cpSync(join(RUNNER_ROOT, 'tests', 'fixtures', 'echo'), join(dir, 'packages', 'echo'), { recursive: true })
  writeFileSync(join(dir, 'packages.json'), JSON.stringify({ catalogVersion: 1, packages: { 'xiaoyuzhou-45': { packageId: 'echo', root: 'packages/echo', interpreter: 'node',
    entry: 'adapter.mjs', operations: ['discover', 'collect'], inject: { run_dir: 'work' }, sha256: treeHash(join(dir, 'packages', 'echo')).sha256 } } }))
  const runner = new Runner({ slots: loadCatalog(join(dir, 'packages.json')), dataDir: join(dir, 'data'), logger: () => {} })
  await runner.init()
  const server = createRunnerServer({ runner, token: 'runner-token-0123456789abcdef', logger: () => {} })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    const fx = await fixture({ fetchImpl: globalThis.fetch, baseUrl: `http://127.0.0.1:${server.address().port}` })
    const { data } = await fx.service.submitJob(fx.context, { capability: EPISODES, input: { platform: 'xiaoyuzhou', podcastIds: [XYZ], episodesPerShow: 3 } }, 'audio-e2e-0001')
    const job = await settle(fx, data.jobId)
    assert.equal(job.status, 'succeeded')
    const { payload } = await fx.jobs.result(data.jobId)
    assert.deepEqual(payload.steps.map(step => step.operation), ['discover', 'collect'])
    const [discover, collect] = payload.steps.map(step => step.envelope.result.params)
    assert.deepEqual(discover.podcast_ids, [XYZ])
    assert.equal(collect.episodes_per_feed, 3)
    assert.equal(discover.run_dir, collect.run_dir, 'both steps use the same runner-owned run_dir')
    assert.match(collect.run_dir, new RegExp(`${data.jobId}/data$`))
  } finally {
    server.close()
    await runner.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
