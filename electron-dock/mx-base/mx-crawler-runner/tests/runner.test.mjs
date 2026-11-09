import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadCatalog, parseCatalog, treeHash, verifyCatalog } from '../src/catalog.mjs'
import { createRunnerServer } from '../src/http.mjs'
import { PROTOCOL, Runner } from '../src/runner.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TOKEN = 'test-token-0123456789abcdef'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx-runner-'))
  cpSync(join(here, 'fixtures', 'echo'), join(dir, 'packages', 'echo'), { recursive: true })
  // A vendored upstream library, like yt-dlp for the video packages.
  mkdirSync(join(dir, 'upstream', 'lib@0123456789ab', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'upstream', 'lib@0123456789ab', 'lib', '__init__.py'), 'VERSION = "1"\n')
  const sha256 = treeHash(join(dir, 'packages', 'echo')).sha256
  const entry = (extra = {}) => ({ packageId: 'echo', label: 'Echo', root: 'packages/echo', interpreter: 'node', entry: 'adapter.mjs',
    operations: ['collect', 'app'], inject: { work_dir: 'work' }, reserved: [], sha256, ...extra })
  writeFileSync(join(dir, 'packages.json'), JSON.stringify({ catalogVersion: 1,
    upstreams: { 'lib@0123456789ab': { repo: 'example/lib', root: 'upstream/lib@0123456789ab', sha256: treeHash(join(dir, 'upstream', 'lib@0123456789ab')).sha256 } },
    packages: {
      'market-echo': entry(), 'market-proxy': entry({ proxy: 'allowed', reserved: ['proxy'], upstreams: ['lib@0123456789ab'] }),
      'market-tampered': entry({ sha256: '0'.repeat(64) }),
      'market-steps': entry({ inject: { run_dir: 'work' }, operations: ['discover', 'collect'] }),
    } }))
  return dir
}

async function waitFor(fn, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(25)
  }
}

describe('catalog', () => {
  test('tree hash ignores installed environments and caches but not source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mx-runner-hash-'))
    cpSync(join(here, 'fixtures', 'echo'), dir, { recursive: true })
    const before = treeHash(dir).sha256
    for (const name of ['.venv', '.runtime', '__pycache__', 'data']) cpSync(join(here, 'fixtures', 'echo'), join(dir, name), { recursive: true })
    assert.equal(treeHash(dir).sha256, before)
    writeFileSync(join(dir, 'adapter.mjs'), '// changed\n', { flag: 'a' })
    assert.notEqual(treeHash(dir).sha256, before)
    rmSync(dir, { recursive: true, force: true })
  })

  test('rejects catalogs that could reach outside the runner', () => {
    const base = { packageId: 'x', root: 'packages/x', interpreter: 'python', entry: 'adapter.py', operations: ['collect'], sha256: 'a'.repeat(64) }
    const parse = entry => parseCatalog(JSON.stringify({ catalogVersion: 1, packages: { 'market-x': { ...base, ...entry } } }), { baseDir: '/srv' })
    assert.ok(parse({}).get('market-x'))
    for (const bad of [{ root: '../x' }, { root: '/etc' }, { interpreter: 'bash' }, { entry: '../adapter.py' }, { inject: { node_path: 'work' } }, { proxy: 'always' }]) {
      assert.throws(() => parse(bad), { code: 'catalog_invalid' }, JSON.stringify(bad))
    }
  })

  test('a tampered package is refused, the rest stay available', () => {
    const dir = fixture()
    const states = verifyCatalog(loadCatalog(join(dir, 'packages.json')))
    assert.equal(states.get('market-echo').available, true)
    assert.equal(states.get('market-proxy').available, true)
    assert.equal(states.get('market-tampered').reason, 'integrity_mismatch')
    // A changed upstream library disables exactly the packages that import it.
    writeFileSync(join(dir, 'upstream', 'lib@0123456789ab', 'lib', '__init__.py'), 'VERSION = "2"\n')
    const after = verifyCatalog(loadCatalog(join(dir, 'packages.json')))
    assert.equal(after.get('market-proxy').reason, 'upstream_mismatch:lib@0123456789ab')
    assert.equal(after.get('market-echo').available, true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the delivered packages and vendored upstreams still match packages.json', () => {
    const root = join(here, '..')
    for (const slot of loadCatalog(join(root, 'packages.json')).values()) {
      assert.equal(treeHash(slot.root).sha256, slot.sha256, slot.slotId)
      for (const upstream of slot.upstreams) assert.equal(treeHash(upstream.root).sha256, upstream.sha256, upstream.id)
      assert.ok(existsSync(slot.requirements), `${slot.slotId} lock file`)
    }
  })

  test('upstreams must be declared, hashed and inside the runner', () => {
    const base = { packageId: 'x', root: 'packages/x', interpreter: 'python', entry: 'adapter.py', operations: ['collect'], sha256: 'a'.repeat(64) }
    const parse = (upstreams, uses, extra = {}) => parseCatalog(JSON.stringify({ catalogVersion: 1, upstreams, packages: { 'market-x': { ...base, upstreams: uses, ...extra } } }), { baseDir: '/srv' })
    assert.ok(parse({ 'lib@0123456789ab': { root: 'upstream/lib', sha256: 'b'.repeat(64) } }, ['lib@0123456789ab']).get('market-x').upstreams.length === 1)
    assert.throws(() => parse({}, ['lib@0123456789ab']), { code: 'catalog_invalid' })
    assert.throws(() => parse({ 'lib@0123456789ab': { root: '../lib', sha256: 'b'.repeat(64) } }, []), { code: 'catalog_invalid' })
    assert.throws(() => parse({ 'lib@main': { root: 'upstream/lib', sha256: 'b'.repeat(64) } }, []), { code: 'catalog_invalid' })
    assert.throws(() => parse({}, [], { requirements: '/etc/req.txt' }), { code: 'catalog_invalid' })
  })
})

describe('runner', () => {
  let dir, runner, logs
  before(async () => {
    dir = fixture()
    logs = []
    runner = new Runner({ slots: loadCatalog(join(dir, 'packages.json')), dataDir: join(dir, 'data'), logger: entry => logs.push(entry) })
    await runner.init()
  })
  after(async () => { await runner.close(); rmSync(dir, { recursive: true, force: true }) })

  const submit = (params, extra = {}) => runner.submit({ protocol: PROTOCOL, dispatchId: randomUUID(), slotId: 'market-echo', operation: 'collect', params, deadlineMs: 20_000, ...extra })
  const settled = id => waitFor(async () => { const view = await runner.get(id); return view.state === 'completed' && view })

  test('registers durably, runs the adapter with the runner-owned work dir and returns the envelope', async () => {
    const { status, invocation } = await submit({ mode: 'echo', q: 1 })
    assert.equal(status, 202)
    assert.equal(invocation.state, 'accepted')
    const done = await settled(invocation.dispatchId)
    assert.equal(done.envelope.status, 'success')
    assert.equal(done.envelope.result.params.q, 1)
    assert.match(done.envelope.result.params.work_dir, new RegExp(`work/market-echo/${invocation.dispatchId}/data$`))
    assert.equal(done.failure, null)
    // Same dispatchId and request: the stored answer, no second process.
    const again = await runner.submit({ protocol: PROTOCOL, dispatchId: invocation.dispatchId, slotId: 'market-echo', operation: 'collect', params: { mode: 'echo', q: 1 }, deadlineMs: 5_000 })
    assert.equal(again.status, 200)
    assert.equal(again.invocation.finishedAt, done.finishedAt)
    await assert.rejects(runner.submit({ protocol: PROTOCOL, dispatchId: invocation.dispatchId, slotId: 'market-echo', operation: 'collect', params: { mode: 'echo', q: 2 }, deadlineMs: 5_000 }),
      { code: 'invocation_conflict', status: 409 })
  })

  test('the child sees a minimal environment: no runner secrets, proxy only when given', async () => {
    process.env.MX_RUNNER_TOKEN = 'must-not-leak'
    try {
      const { invocation } = await submit({ mode: 'env' })
      const { envelope } = await settled(invocation.dispatchId)
      assert.equal(envelope.result.env.TOKEN, null)
      assert.equal(envelope.result.env.HTTPS_PROXY, null)
      assert.ok(!envelope.result.env.keys.some(key => /token|secret|key/i.test(key) && key !== 'PYTHONNOUSERSITE'))
      assert.ok(envelope.result.cwd.endsWith(invocation.dispatchId))
      const proxied = await runner.submit({ protocol: PROTOCOL, dispatchId: randomUUID(), slotId: 'market-proxy', operation: 'collect', params: { mode: 'env' },
        deadlineMs: 20_000, proxyUrl: 'http://user:pa55@127.0.0.1:7788' })
      const done = await settled(proxied.invocation.dispatchId)
      // The child had the proxy; an adapter that echoes it (some copy their
      // worker's stderr into the result) cannot hand it to Hub.
      assert.equal(done.envelope.result.env.proxyLength, 'http://user:pa55@127.0.0.1:7788'.length)
      assert.equal(done.envelope.result.env.HTTPS_PROXY, '[redacted]')
      assert.ok(done.envelope.result.env.PYTHONPATH.endsWith(join(dir, 'upstream', 'lib@0123456789ab')), 'vendored upstreams follow the package source')
      const stored = readFileSync(join(dir, 'data', 'invocations', `${proxied.invocation.dispatchId}.json`), 'utf8')
      assert.ok(!stored.includes('pa55') && !stored.includes('127.0.0.1:7788'))
      assert.equal(JSON.parse(stored).proxied, true)
    } finally { delete process.env.MX_RUNNER_TOKEN }
  })

  test('rejects what the catalog does not allow before registering anything', async () => {
    const count = () => readdirSync(join(dir, 'data', 'invocations')).filter(name => name.endsWith('.json')).length
    const before = count()
    await assert.rejects(submit({}, { slotId: 'market-unknown' }), { code: 'slot_unknown', status: 404 })
    await assert.rejects(submit({}, { operation: 'search' }), { code: 'operation_not_allowed' })
    await assert.rejects(submit({ work_dir: '/etc' }), { code: 'reserved_param' })
    await assert.rejects(submit({}, { proxyUrl: 'http://127.0.0.1:7788' }), { code: 'proxy_not_allowed' })
    await assert.rejects(submit({}, { slotId: 'market-proxy', proxyUrl: 'socks5://127.0.0.1:1080' }), { code: 'invalid_proxy' })
    await assert.rejects(submit({}, { protocol: 'v0' }), { code: 'protocol_unsupported' })
    await assert.rejects(submit({}, { deadlineMs: 10 }), { code: 'invalid_deadline' })
    await assert.rejects(submit({}, { dispatchId: '../../etc/passwd' }), { code: 'invalid_dispatch_id' })
    await assert.rejects(submit({}, { slotId: 'market-tampered' }), { code: 'package_unavailable', status: 424 })
    await assert.rejects(submit({}, { command: 'rm -rf /' }), { code: 'invalid_request' })
    assert.equal(count(), before)
  })

  test('steps run in order in one run_dir; a later step only follows usable output', async () => {
    const steps = (first, second = { mode: 'load' }) => runner.submit({ protocol: PROTOCOL, dispatchId: randomUUID(), slotId: 'market-steps', deadlineMs: 20_000,
      steps: [{ operation: 'discover', params: first }, { operation: 'collect', params: second }] })
    const { invocation } = await steps({ mode: 'store', value: 'show-1' })
    assert.equal(invocation.operation, 'discover+collect')
    const done = await settled(invocation.dispatchId)
    assert.deepEqual(done.envelope.result.items, [{ value: 'show-1' }], 'collect read what discover stored')
    assert.match(done.envelope.result.dir, new RegExp(`${invocation.dispatchId}/data$`))
    assert.deepEqual(done.steps.map(step => [step.operation, step.status, Boolean(step.envelope)]), [['discover', 'success', true], ['collect', 'success', false]])
    assert.deepEqual(done.steps[0].envelope.result.items, [{ stored: 'show-1' }])
    // no_data (or error, or a runner failure) ends the invocation there.
    const empty = await settled((await steps({ mode: 'store', value: 'x', status: 'no_data' })).invocation.dispatchId)
    assert.equal(empty.envelope.status, 'no_data')
    assert.equal(empty.steps.length, 1)
    assert.equal(empty.envelope.operation, 'discover')
    // Same steps replay; different steps conflict.
    const id = randomUUID()
    const body = { protocol: PROTOCOL, dispatchId: id, slotId: 'market-steps', deadlineMs: 20_000, steps: [{ operation: 'discover', params: { mode: 'store', value: 'a' } }] }
    await runner.submit(body)
    await settled(id)
    assert.equal((await runner.submit(body)).status, 200)
    await assert.rejects(runner.submit({ ...body, steps: [{ operation: 'discover', params: { mode: 'store', value: 'b' } }] }), { code: 'invocation_conflict' })
  })

  test('every step is checked against the catalog before anything is registered', async () => {
    const base = { protocol: PROTOCOL, dispatchId: randomUUID(), slotId: 'market-steps', deadlineMs: 20_000 }
    await assert.rejects(runner.submit({ ...base, steps: [{ operation: 'discover' }, { operation: 'download' }] }), { code: 'operation_not_allowed', message: /steps\[1\]/ })
    await assert.rejects(runner.submit({ ...base, steps: [{ operation: 'discover', params: { run_dir: '/etc' } }] }), { code: 'reserved_param' })
    await assert.rejects(runner.submit({ ...base, operation: 'discover', steps: [{ operation: 'discover' }] }), { code: 'invalid_request' })
    await assert.rejects(runner.submit({ ...base, steps: [] }), { code: 'invalid_steps' })
    await assert.rejects(runner.submit({ ...base, steps: Array(5).fill({ operation: 'discover' }) }), { code: 'invalid_steps' })
    await assert.rejects(runner.submit({ ...base, steps: [{ operation: 'discover', command: 'sh' }] }), { code: 'invalid_steps' })
    await assert.rejects(runner.get(base.dispatchId), { code: 'invocation_not_found' })
  })

  test('maps unusable output, crashes and oversize output to explicit failures', async () => {
    const garbage = await settled((await submit({ mode: 'garbage' })).invocation.dispatchId)
    assert.equal(garbage.failure.code, 'output_unusable')
    const crash = await settled((await submit({ mode: 'crash' })).invocation.dispatchId)
    assert.equal(crash.failure.code, 'output_unusable')
    assert.equal(crash.exitCode, 3)
    const small = new Runner({ slots: runner.slots, dataDir: join(dir, 'data-small'), logger: () => {},
      run: options => runner.run({ ...options, maxOutputBytes: 1024 }) })
    await small.init()
    const { invocation } = await small.submit({ protocol: PROTOCOL, dispatchId: randomUUID(), slotId: 'market-echo', operation: 'collect', params: { mode: 'big', bytes: 50_000 }, deadlineMs: 20_000 })
    const big = await waitFor(async () => { const view = await small.get(invocation.dispatchId); return view.state === 'completed' && view })
    assert.equal(big.failure.code, 'output_too_large')
  })

  test('the deadline stops the adapter and every helper in its process group', async () => {
    const { invocation } = await submit({ mode: 'child' }, { deadlineMs: 1_500 })
    const pidFile = join(dir, 'data', 'work', 'market-echo', invocation.dispatchId, 'data', 'helper.pid')
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'))
    const helper = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(alive(helper))
    const done = await settled(invocation.dispatchId)
    assert.equal(done.failure.code, 'deadline_exceeded')
    await waitFor(() => !alive(helper), 3_000)
  })

  test('abort is confirmed only after the process has ended', async () => {
    const { invocation } = await submit({ mode: 'sleep' })
    await waitFor(async () => (await runner.get(invocation.dispatchId)).state === 'running')
    const aborted = await runner.abort(invocation.dispatchId)
    assert.equal(aborted.state, 'completed')
    assert.equal(aborted.failure.code, 'aborted')
  })

  test('capacity is enforced globally and per slot without registering the refused call', async () => {
    const tight = new Runner({ slots: runner.slots, dataDir: join(dir, 'data-tight'), logger: () => {}, limits: { capacity: 2, perSlot: 1 } })
    await tight.init()
    const call = slotId => tight.submit({ protocol: PROTOCOL, dispatchId: randomUUID(), slotId, operation: 'collect', params: { mode: 'sleep' }, deadlineMs: 20_000 })
    await call('market-echo')
    await assert.rejects(call('market-echo'), { code: 'runner_busy', status: 429 })
    await call('market-proxy')
    await assert.rejects(call('market-proxy'), { code: 'runner_busy' })
    assert.equal(readdirSync(join(dir, 'data-tight', 'invocations')).filter(name => name.endsWith('.json')).length, 2)
    await tight.close()
  })

  test('a restart marks unfinished records interrupted instead of leaving them running', async () => {
    const id = randomUUID()
    await runner.registry.write({ dispatchId: id, slotId: 'market-echo', operation: 'collect', requestHash: 'x', state: 'running', acceptedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString() })
    const restarted = new Runner({ slots: runner.slots, dataDir: join(dir, 'data'), logger: () => {} })
    await restarted.init()
    const view = await restarted.get(id)
    assert.equal(view.state, 'completed')
    assert.equal(view.failure.code, 'interrupted')
  })

  test('a relative data directory still hands adapters an absolute work_dir', async () => {
    const target = join(dir, 'data-relative')
    const relativeRunner = new Runner({ slots: runner.slots, dataDir: relative(process.cwd(), target), logger: () => {} })
    await relativeRunner.init()
    const { invocation } = await relativeRunner.submit({ protocol: PROTOCOL, dispatchId: randomUUID(), slotId: 'market-echo', operation: 'collect', params: {}, deadlineMs: 20_000 })
    const done = await waitFor(async () => { const view = await relativeRunner.get(invocation.dispatchId); return view.state === 'completed' && view })
    assert.equal(done.envelope.result.params.work_dir, join(target, 'work', 'market-echo', invocation.dispatchId, 'data'))
  })

  test('prune removes finished records and their work directories after retention', async () => {
    const pruner = new Runner({ slots: runner.slots, dataDir: join(dir, 'data-prune'), logger: () => {}, limits: { retentionMs: 0 } })
    await pruner.init()
    const { invocation } = await pruner.submit({ protocol: PROTOCOL, dispatchId: randomUUID(), slotId: 'market-echo', operation: 'collect', params: {}, deadlineMs: 20_000 })
    await waitFor(async () => (await pruner.get(invocation.dispatchId)).state === 'completed')
    assert.equal(await pruner.prune(), 1)
    await assert.rejects(pruner.get(invocation.dispatchId), { code: 'invocation_not_found' })
    assert.equal(existsSync(join(dir, 'data-prune', 'work', 'market-echo', invocation.dispatchId)), false)
  })

  test('stderr in the runner log never carries the proxy credentials', async () => {
    const { invocation } = await runner.submit({ protocol: PROTOCOL, dispatchId: randomUUID(), slotId: 'market-proxy', operation: 'collect', params: { mode: 'sleep' },
      deadlineMs: 1_200, proxyUrl: 'http://user:s3cret-pass@127.0.0.1:7788' })
    // The completion log line follows the durable record by a tick.
    const entry = await waitFor(() => logs.find(item => item.dispatchId === invocation.dispatchId && item.event === 'invocation_completed'))
    assert.match(entry.stderrTail, /sleeping via \[redacted\]/)
    assert.ok(!JSON.stringify(logs).includes('s3cret-pass'))
  })
})

describe('http', () => {
  let dir, runner, server, base
  before(async () => {
    dir = fixture()
    runner = new Runner({ slots: loadCatalog(join(dir, 'packages.json')), dataDir: join(dir, 'data'), logger: () => {} })
    await runner.init()
    server = createRunnerServer({ runner, token: TOKEN, logger: () => {} })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(async () => { server.close(); await runner.close(); rmSync(dir, { recursive: true, force: true }) })

  const call = (path, { token = TOKEN, ...init } = {}) => fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } })

  test('every route requires the bearer token', async () => {
    for (const path of ['/v1/health', '/v1/invocations/abc', '/v1/invocations']) {
      const response = await call(path, { token: null })
      assert.equal(response.status, 401)
    }
    assert.equal((await call('/v1/health', { token: 'wrong-token-0123456789abcdef' })).status, 401)
    assert.throws(() => createRunnerServer({ runner, token: 'short' }), { code: 'token_invalid' })
  })

  test('health lists the reviewed slots and their availability', async () => {
    const body = await (await call('/v1/health')).json()
    assert.equal(body.data.ok, true)
    assert.equal(body.data.protocol, PROTOCOL)
    assert.deepEqual(body.data.slots.map(slot => [slot.slotId, slot.available]), [['market-echo', true], ['market-proxy', true], ['market-tampered', false], ['market-steps', true]])
  })

  test('the Hub contract round trip: 202, then 200 completed; unknown ids are 404', async () => {
    const dispatchId = randomUUID()
    const started = await call('/v1/invocations', { method: 'POST', body: JSON.stringify({ protocol: PROTOCOL, dispatchId, slotId: 'market-echo', operation: 'collect', params: {}, deadlineMs: 20_000 }) })
    assert.equal(started.status, 202)
    assert.equal((await started.json()).data.state, 'accepted')
    const done = await waitFor(async () => { const body = await (await call(`/v1/invocations/${dispatchId}`)).json(); return body.data.state === 'completed' && body.data })
    assert.equal(done.envelope.status, 'success')
    assert.equal((await call(`/v1/invocations/${randomUUID()}`)).status, 404)
    const bad = await call('/v1/invocations', { method: 'POST', body: '{', headers: {} })
    assert.equal(bad.status, 400)
    const big = await call('/v1/invocations', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) })
    assert.equal(big.status, 413)
  })
})
