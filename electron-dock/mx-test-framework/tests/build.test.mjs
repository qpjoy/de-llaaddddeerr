import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

import { ArtifactStore } from '../server/artifacts.mjs'
import { loadConfig } from '../server/config.mjs'
import { completeBuildRun, findBuildArtifact } from '../server/ingest/build.mjs'
import { start } from '../server/index.mjs'

// A build run is not a test run with zero tests.
//
// What it inherits is the platform's oldest rule in a build-shaped form:
// 零用例不是通过 → 没有产物不是构建成功. Both are the case where the exit code
// claims success and nothing actually happened.

const ADMIN_TOKEN = 'test-admin-token'
const ROOT = join(
  process.env.TMPDIR || process.env.TEMP || '.',
  `mxt-build-test-${process.pid}`,
)
let base
let runtime
let artifacts

const api = async (method, path, { body, token = ADMIN_TOKEN } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

before(async () => {
  await rm(ROOT, { recursive: true, force: true })
  runtime = await start(
    loadConfig({
      MXT_STORE: 'memory',
      MXT_ADMIN_TOKEN: ADMIN_TOKEN,
      MXT_PORT: '0',
      MXT_ARTIFACTS_DIR: ROOT,
      MXT_PUBLIC_URL: 'http://mxt.internal:30879',
    }),
    { schedule: false },
  )
  base = `http://127.0.0.1:${runtime.port}`
  artifacts = new ArtifactStore({ root: ROOT })

  await api('POST', '/api/v1/apps', {
    body: { slug: 'luopan', displayName: '罗盘', surfaces: ['electron'] },
  })
  await api('POST', '/api/v1/apps/luopan/suites', {
    body: {
      slug: 'win-installer',
      displayName: 'Windows 安装包',
      kind: 'build',
      engine: 'generic',
      runnerImage: 'node:22',
      surface: 'electron',
      runnerKind: 'local',
      targetMode: 'self',
      workingDir: 'po-frontend',
      artifactPath: 'dist/electron/Packaged/*.exe',
      command: ['pnpm', 'build:electron:exe'],
      requirements: { os: ['windows'] },
    },
  })
})

after(async () => {
  await runtime.close()
  await rm(ROOT, { recursive: true, force: true })
})

async function newBuildRun() {
  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'luopan',
      suite: 'win-installer',
      name: `build-${Math.random().toString(36).slice(2, 8)}`,
      profile: 'mock',
      track: 'functional',
    },
  })
  assert.equal(task.status, 201, JSON.stringify(task.body))
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  return run.body.run
}

async function claim(runnerToken) {
  const claimed = await api('POST', '/runner/v1/runs:claim', { token: runnerToken })
  return claimed.body
}

let runnerToken

test('a build suite can be registered with a glob for its output', async () => {
  const suites = await api('GET', '/api/v1/apps/luopan/suites')
  const suite = suites.body.suites.find((entry) => entry.slug === 'win-installer')
  assert.equal(suite.kind, 'build')
  assert.equal(suite.artifactPath, 'dist/electron/Packaged/*.exe')

  const registered = await api('POST', '/runner/v1/runners:register', {
    body: { name: 'win-box', os: 'windows', engines: ['generic'], surfaces: ['electron'] },
  })
  runnerToken = registered.body.token
})

// -- the inherited rule -------------------------------------------------------

test('a build that exits 0 without producing anything is blocked, not passed', async () => {
  // The same shape of lie as a test run reporting zero cases and calling it
  // green: the exit code says success and nothing happened.
  const run = await newBuildRun()
  const claimed = await claim(runnerToken)
  const result = await api('POST', `/runner/v1/runs/${claimed.runId}:complete`, {
    token: claimed.runToken,
    body: { exitCode: 0 },
  })
  assert.equal(result.body.run.status, 'blocked')
  assert.match(result.body.run.blockedReason, /没有找到产物/u)
  void run
})

test('a failed build is failed, and a blocked one stays blocked', async () => {
  for (const [exitCode, expected] of [
    [1, 'failed'],
    [2, 'blocked'],
  ]) {
    const run = await newBuildRun()
    const claimed = await claim(runnerToken)
    const result = await api('POST', `/runner/v1/runs/${claimed.runId}:complete`, {
      token: claimed.runToken,
      body: { exitCode },
    })
    assert.equal(result.body.run.status, expected, `exit ${exitCode}`)
    void run
  }
})

// -- the successful path ------------------------------------------------------

test('a produced installer is hashed by the platform and registered', async () => {
  const run = await newBuildRun()
  const claimed = await claim(runnerToken)

  const bytes = Buffer.from('MZ fake installer payload for the test')
  const dir = join(ROOT, 'runs', claimed.runId, 'package')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Compass-Setup-2.0.1.exe'), bytes)

  const result = await api('POST', `/runner/v1/runs/${claimed.runId}:complete`, {
    token: claimed.runToken,
    body: { exitCode: 0 },
  })
  assert.equal(result.body.run.status, 'passed')

  const app = await runtime.store.getAppBySlug('luopan')
  const pkg = app.latestPackage
  assert.equal(pkg.filename, 'Compass-Setup-2.0.1.exe')
  // Hashed from the bytes the platform received, not from a digest the runner
  // claimed: the runner executes code from the repository under test, and its
  // arithmetic is no more trustworthy than its output.
  assert.equal(pkg.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(pkg.buildRunId, claimed.runId)
  assert.match(pkg.url, /\/runner\/v1\/runs\/.*\/package$/u)
  void run
})

test('a build run records no cases and no catalog drift', async () => {
  // Running a build through the test pipeline would report "0 tests" and a
  // catalog claiming every registered case went unexecuted — true, meaningless,
  // and it would poison the drift numbers for the suites that test things.
  const runs = await api('GET', '/api/v1/runs?app=luopan')
  const passed = runs.body.runs.find((entry) => entry.status === 'passed')
  assert.deepEqual(passed.catalog, {})
  assert.deepEqual(passed.totals, {})
  const cases = await api('GET', `/api/v1/runs/${passed.id}/cases`)
  assert.deepEqual(cases.body.cases, [])
})

test('two candidate files are an error rather than a guess', async () => {
  // "Which .exe did we test" has to have one answer, and picking the first
  // alphabetically would answer it differently after a version bump.
  const runId = 'trun_ambiguous'
  const dir = join(ROOT, 'runs', runId, 'package')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'a.exe'), 'a')
  await writeFile(join(dir, 'b.exe'), 'b')
  await assert.rejects(() => findBuildArtifact(artifacts, runId), /无法确定/u)
})

// -- delivery to the machine that will run it ---------------------------------

test('a runner may download the installer; a stranger may not', async () => {
  const app = await runtime.store.getAppBySlug('luopan')
  const path = new URL(app.latestPackage.url).pathname

  const authorised = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${runnerToken}` },
  })
  assert.equal(authorised.status, 200)
  assert.equal(
    createHash('sha256').update(Buffer.from(await authorised.arrayBuffer())).digest('hex'),
    app.latestPackage.sha256,
    '下载到的字节必须和登记的校验和一致',
  )

  // A registered runner is already trusted to execute test code on real
  // hardware, so downloading the application it is about to launch adds
  // nothing. Everyone else is refused.
  for (const headers of [{}, { authorization: 'Bearer not-a-real-token' }]) {
    const refused = await fetch(`${base}${path}`, { headers })
    assert.equal(refused.status, 401, JSON.stringify(headers))
  }
})

// -- the unit boundary --------------------------------------------------------

test('completeBuildRun leaves the store untouched when there is nothing to record', async () => {
  const calls = []
  const outcome = await completeBuildRun({
    store: { setLatestPackage: async (...args) => calls.push(args) },
    artifacts: { list: async () => [] },
    run: { id: 'trun_x', appId: 'app_x' },
    exitCode: 0,
    config: {},
  })
  assert.equal(outcome.status, 'blocked')
  assert.equal(outcome.package, null)
  assert.deepEqual(calls, [], '构建没成功就不该登记任何包')
})

test('the claim tells a runner it is building, and where to look', async () => {
  // Without these the local runner would treat a build like a test run: it
  // would look for JUnit that was never written and report blocked, while the
  // installer it just produced sat unread on disk.
  const run = await newBuildRun()
  const claimed = await claim(runnerToken)
  assert.equal(claimed.suite.kind, 'build')
  assert.equal(claimed.suite.artifactPath, 'dist/electron/Packaged/*.exe')
  void run
})

test('构建产物必须能追溯到 commit', async () => {
  // The second time this provenance was silently dropped. The first was on the
  // test path (the runner computed the sha, normalisation discarded it); this
  // is the build path, where the runner only attached it *inside the summary* —
  // and a build run has no summary. The result was a 200 MB installer handed to
  // testers with `source_ref = {}`.
  const gitSha = '48af4908771071e79d2774de11b4fb9257d620f9'
  const run = await newBuildRun()
  const claimed = await claim(runnerToken)

  const dir = join(ROOT, 'runs', claimed.runId, 'package')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Compass-Setup-3.0.0.exe'), Buffer.from('MZ traced'))

  const result = await api('POST', `/runner/v1/runs/${claimed.runId}:complete`, {
    token: claimed.runToken,
    body: { exitCode: 0, sourceRef: { ref: 'public', gitSha } },
  })
  assert.equal(result.body.run.status, 'passed')
  assert.equal(result.body.run.sourceRef.gitSha, gitSha)

  const app = await runtime.store.getAppBySlug('luopan')
  assert.equal(app.latestPackage.gitSha, gitSha)
  // The short sha is what a person reads off a build list.
  assert.equal(app.latestPackage.version, gitSha.slice(0, 12))
  void run
})

test('假的 provenance 比没有更糟，所以要被丢掉', async () => {
  const run = await newBuildRun()
  const claimed = await claim(runnerToken)

  const dir = join(ROOT, 'runs', claimed.runId, 'package')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Compass-Setup-3.0.1.exe'), Buffer.from('MZ untraced'))

  const result = await api('POST', `/runner/v1/runs/${claimed.runId}:complete`, {
    token: claimed.runToken,
    body: { exitCode: 0, sourceRef: { ref: 'public', gitSha: '不是一个 sha' } },
  })
  assert.equal(result.body.run.status, 'passed')
  assert.ok(!result.body.run.sourceRef?.gitSha, JSON.stringify(result.body.run.sourceRef))

  const app = await runtime.store.getAppBySlug('luopan')
  assert.equal(app.latestPackage.gitSha, null)
  void run
})
