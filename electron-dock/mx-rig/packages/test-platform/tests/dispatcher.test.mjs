import assert from 'node:assert/strict'
import test from 'node:test'

import { KubernetesDispatcher, dispatchQueued, reconcileServerRuns } from '../server/runner/dispatcher.mjs'
import { suiteCommand, gitRef, relativeDir } from '../server/core/http.mjs'
import { loadConfig } from '../server/config.mjs'

const config = loadConfig({ MXT_STORE: 'memory', MXT_GIT_TOKEN_SECRET: 'mxt-git' })

function dispatcher() {
  return new KubernetesDispatcher({ config, namespace: 'mx-test-framework' })
}

const app = { id: 'tapp_1', slug: 'compass', repoUrl: 'https://example.invalid/compass.git' }
const suite = { id: 'tsuite_1', slug: 'web', engine: 'cypress', command: ['pnpm', 'e2e:run:mock'] }
const run = { id: 'trun_1', appId: app.id, suiteId: suite.id }

test('server capacity and runner resource limits are bounded by default and configurable', () => {
  assert.equal(config.maxConcurrentServerRuns, 1)
  assert.equal(config.runnerResources.cpuLimit, '2')
  assert.equal(config.runnerResources.ephemeralStorageLimit, '14Gi')
  assert.equal(config.artifactLimits.totalBytes, 20 * 1024 * 1024 * 1024)
  assert.equal(config.artifactLimits.totalEntries, 100_000)
  assert.equal(config.artifactLimits.minFreeBytes, 5 * 1024 * 1024 * 1024)
  assert.equal(config.artifactLimits.minFreeInodes, 10_000)
  assert.equal(
    loadConfig({ MXT_STORE: 'memory', MXT_MAX_CONCURRENT_SERVER_RUNS: '3' })
      .maxConcurrentServerRuns,
    3,
  )
  assert.throws(
    () => loadConfig({ MXT_STORE: 'memory', MXT_MAX_CONCURRENT_SERVER_RUNS: '0' }),
    /positive integer/u,
  )
})

// -- the suite command is not a shell string ---------------------------------

test('the test team can name any framework directly', () => {
  // Deciding how to test is their call. Needing a pull request into someone
  // else's repository to change a pytest flag is exactly the friction this
  // platform exists to remove.
  for (const command of [
    ['pytest', '-q', '--junitxml=out.xml'],
    ['npx', 'playwright', 'test', '--reporter=junit'],
    ['npx', 'cypress', 'run', '--reporter', 'junit'],
    ['k6', 'run', 'script.js'],
    ['go', 'test', './...', '-v'],
    ['pnpm', 'e2e:local'],
    ['make', 'e2e'],
  ]) {
    assert.deepEqual(suiteCommand(command), command, command.join(' '))
  }
})

test('shell metacharacters are inert rather than rejected', () => {
  // They reach the process as literal argument text, because execution is
  // argv-only. Rejecting them would break legitimate arguments — a jq filter or
  // a grep pattern — for no gain.
  assert.deepEqual(suiteCommand(['pytest', '-k', 'test_a or test_b']), [
    'pytest',
    '-k',
    'test_a or test_b',
  ])
  assert.deepEqual(suiteCommand(['npx', 'playwright', 'test', '-g', 'login|logout']), [
    'npx',
    'playwright',
    'test',
    '-g',
    'login|logout',
  ])
})

test('argv[0] may not be a shell', () => {
  // The one guard that survives: handing argv[0] to a shell would restore the
  // parsing that argv execution removes. A guard against a slip, not against a
  // determined admin — `runnerImage` accepts any image, so the trust boundary
  // is the admin role, not a vocabulary of approved words.
  for (const shell of ['sh', 'bash', '/bin/bash', 'powershell.exe', 'cmd']) {
    assert.throws(() => suiteCommand([shell, '-c', 'id']), /不能直接调用/u, shell)
  }
})

test('control characters are refused', () => {
  // They break argv handling and let a crafted argument forge lines in the log.
  const NUL = String.fromCharCode(0)
  const LF = String.fromCharCode(10)
  assert.throws(() => suiteCommand(['pytest', `a${NUL}b`]), /控制字符/u)
  assert.throws(() => suiteCommand(['pytest', `a${LF}fake log line`]), /控制字符/u)
})

test('an empty command stays empty', () => {
  assert.deepEqual(suiteCommand([]), [])
  assert.deepEqual(suiteCommand(null), [])
  assert.deepEqual(suiteCommand(['pytest']), ['pytest'])
})

test('the command reaches the container as JSON, never spliced into the script', () => {
  const manifest = dispatcher().manifest({
    run,
    suite,
    app,
    env: {},
    runToken: 'mxt-run-x',
    apiBase: 'http://mxt',
  })
  const [container] = manifest.spec.template.spec.containers
  const commandJson = container.env.find((entry) => entry.name === 'MXT_COMMAND_JSON')
  assert.equal(commandJson.value, '["pnpm","e2e:run:mock"]')
  assert.ok(
    !container.args[0].includes('e2e:run:mock'),
    'the suite command must not appear in the shell script text',
  )
})

// -- the checkout is named ----------------------------------------------------

test('a git ref that could be read as an option or a traversal is refused', () => {
  assert.equal(gitRef({ ref: 'release/2.0' }, 'ref'), 'release/2.0')
  assert.equal(gitRef({ ref: 'a1b2c3d' }, 'ref'), 'a1b2c3d')
  assert.equal(gitRef({}, 'ref'), null)
  for (const bad of ['--upload-pack=sh', '-x', '../../etc', 'a/../../b', 'a b']) {
    assert.throws(() => gitRef({ ref: bad }, 'ref'), /不是合法/u, bad)
  }
})

test('the run pins a ref, falling back to the app default and then to HEAD', () => {
  assert.equal(
    KubernetesDispatcher.sourceRefFor({ sourceRef: { ref: 'feat/x' } }, { defaultBranch: 'main' }),
    'feat/x',
  )
  assert.equal(KubernetesDispatcher.sourceRefFor({}, { defaultBranch: 'main' }), 'main')
  assert.equal(KubernetesDispatcher.sourceRefFor({}, {}), 'HEAD')
})

test('the manifest carries the repo and ref the checkout needs', () => {
  const manifest = dispatcher().manifest({
    run: { ...run, sourceRef: { ref: 'release/2.0' } },
    suite,
    app,
    env: { MXT_RUN_ID: run.id },
    runToken: 'mxt-run-x',
    apiBase: 'http://mxt',
  })
  const env = Object.fromEntries(
    manifest.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry.value]),
  )
  assert.equal(env.MXT_REPO_URL, app.repoUrl)
  assert.equal(env.MXT_SOURCE_REF, 'release/2.0')
})

test('a monorepo suite runs at its own project root', () => {
  // po-frontend keeps package.json, pnpm-lock.yaml and cypress/ under
  // po-frontend/. Without this the runner installs at the checkout root, finds
  // no lockfile, and reports blocked on a repository that is perfectly fine.
  const manifest = dispatcher().manifest({
    run,
    suite: { ...suite, workingDir: 'po-frontend' },
    app,
    env: {},
    runToken: 'mxt-run-x',
    apiBase: 'http://mxt',
  })
  const env = Object.fromEntries(
    manifest.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry.value]),
  )
  assert.equal(env.MXT_WORKING_DIR, 'po-frontend')

  const script = dispatcher().script({ apiBase: 'http://mxt' })
  assert.match(script, /cd "\$MXT_WORKING_DIR" \|\| blocked/u)
})

test('a suite without a working directory sets no variable at all', () => {
  const manifest = dispatcher().manifest({
    run,
    suite,
    app,
    env: {},
    runToken: 'mxt-run-x',
    apiBase: 'http://mxt',
  })
  const names = manifest.spec.template.spec.containers[0].env.map((entry) => entry.name)
  assert.ok(!names.includes('MXT_WORKING_DIR'))
})

test('a working directory cannot escape the checkout', () => {
  assert.equal(relativeDir({ dir: 'po-frontend' }, 'dir'), 'po-frontend')
  assert.equal(relativeDir({ dir: 'apps/web/' }, 'dir'), 'apps/web')
  assert.equal(relativeDir({}, 'dir'), null)
  for (const bad of ['../etc', 'po-frontend/../../etc', '/etc', '-rf', 'a b']) {
    assert.throws(() => relativeDir({ dir: bad }, 'dir'), /相对目录/u, bad)
  }
})

test('the clone credential never lands in the remote URL or the process table', () => {
  const script = dispatcher().script({ apiBase: 'http://mxt' })
  assert.match(script, /credential\.helper/u)
  assert.match(script, /git config --global --unset-all credential\.helper/u)
  assert.match(script, /unset MXT_GIT_TOKEN/u)
  assert.ok(
    script.indexOf('unset MXT_GIT_TOKEN') < script.indexOf('stage install'),
    'dependency hooks and the suite command must not inherit the clone token',
  )
  assert.ok(
    !/https:\/\/\$MXT_GIT_TOKEN@/u.test(script),
    'a token in the remote URL would be written into .git/config',
  )
})

// -- no silent degradation ----------------------------------------------------

test('a failed install ends the run as blocked instead of falling back', () => {
  const script = dispatcher().script({ apiBase: 'http://mxt' })
  // The original script ran `pnpm install || npm install`, which quietly built a
  // different dependency tree than the lockfile describes, and `|| true`, which
  // let the suite run against no dependencies at all.
  assert.ok(!/\|\| npm install/u.test(script), 'must not cross-fall-back between package managers')
  assert.ok(!/\|\| true/u.test(script), 'must not swallow an install failure')
  assert.match(script, /pnpm install --frozen-lockfile \|\| blocked/u)
  assert.match(script, /npm ci --no-audit --no-fund \|\| blocked/u)
  assert.match(script, /no lockfile; refusing/u)
})

test('every checkout failure names its own reason', () => {
  const script = dispatcher().script({ apiBase: 'http://mxt' })
  for (const step of ['git init', 'git fetch', 'git checkout']) {
    assert.match(script, new RegExp(`${step}[^\\n]*\\|\\| blocked|${step}[^\\n]*\\\\\\n *\\|\\| blocked`, 'u'), step)
  }
})

test('a result that cannot be delivered is retried and then surfaces as a failed Job', () => {
  const script = dispatcher().script({ apiBase: 'http://mxt' })
  // `exit 0` at the end of the old script meant Kubernetes saw every Job as
  // successful, discarding the one signal that survives a container that dies
  // before it can report anything.
  assert.match(script, /mxt-api\.js post ".*:complete" \/tmp\/payload\.json 3/u, '结果要带重试')
  assert.match(script, /exit 75/u)
})

test('a run that reported nothing at all is blocked, not passed', () => {
  const script = dispatcher().script({ apiBase: 'http://mxt' })
  // Either format is an acceptable report; producing neither is not.
  assert.match(script, /! -f "\$SUMMARY"/u)
  assert.match(script, /junit\/\*\.xml/u)
  assert.match(script, /blocked "runner produced neither summary\.json nor junit/u)
})

test('a summary that will not parse becomes blocked rather than an empty pass', () => {
  const script = dispatcher().script({ apiBase: 'http://mxt' })
  assert.match(script, /summary\.json unreadable/u)
  assert.match(script, /status: 'blocked'/u)
  // Substituting a blocked summary is not enough on its own. The platform
  // resolves a code/summary disagreement in favour of the exit code, so a run
  // whose suite exited 0 and then wrote a truncated summary would be recorded
  // as passed unless the code moves to 2 as well.
  assert.match(script, /exitCode = 2/u)
  assert.match(script, /exit "\$effective"/u)
})

// -- the workspace does not outlive the run -----------------------------------

test('checkout and artifacts use separate capped emptyDirs with hard container resources', () => {
  const manifest = dispatcher().manifest({
    run,
    suite,
    app,
    env: {},
    runToken: 'mxt-run-x',
    apiBase: 'http://mxt',
  })
  const { volumes, containers } = manifest.spec.template.spec
  const workspace = volumes.find((volume) => volume.name === 'workspace')
  assert.equal(workspace.emptyDir.sizeLimit, '10Gi')
  const artifacts = volumes.find((volume) => volume.name === 'artifacts')
  assert.equal(artifacts.emptyDir.sizeLimit, '2Gi')
  assert.equal(artifacts.persistentVolumeClaim, undefined)
  const mount = containers[0].volumeMounts.find((entry) => entry.name === 'workspace')
  assert.equal(mount.mountPath, '/work')
  assert.equal(containers[0].securityContext.allowPrivilegeEscalation, false)
  assert.equal(containers[0].resources.limits.cpu, '2')
  assert.equal(containers[0].resources.limits.memory, '8Gi')
  assert.equal(containers[0].resources.limits['ephemeral-storage'], '14Gi')
  assert.equal(containers[0].resources.requests['ephemeral-storage'], '2Gi')
  assert.match(containers[0].args[0], /node \/tmp\/mxt-upload\.js \|\| blocked/u)
  const jobEnv = Object.fromEntries(
    containers[0].env.filter((entry) => Object.hasOwn(entry, 'value')).map((entry) => [entry.name, entry.value]),
  )
  assert.equal(jobEnv.MXT_API_BASE, 'http://mxt')
  assert.equal(jobEnv.MXT_ARTIFACT_MAX_FILE_BYTES, String(512 * 1024 * 1024))
  assert.equal(jobEnv.MXT_ARTIFACT_MAX_RUN_BYTES, String(2 * 1024 * 1024 * 1024))
  assert.equal(jobEnv.MXT_ARTIFACT_MAX_FILES, '1000')
})

// -- a Job that died without reporting ----------------------------------------

function reconcileStore(runs) {
  const updates = []
  return {
    updates,
    listRuns: async ({ status }) => runs.filter((run) => run.status === status),
    updateRun: async (id, patch) => updates.push([id, patch]),
  }
}

test('a run whose Job was killed is closed out instead of hanging in running', async () => {
  // OOMKill, eviction and activeDeadlineSeconds all end the container before it
  // reaches its own reporting step. The Job object is the only witness left.
  const store = reconcileStore([{ id: 'trun_9', status: 'running' }])
  const reconciled = await reconcileServerRuns({
    store,
    dispatcher: {
      available: true,
      listJobs: async () => [{ runId: 'trun_9', failed: true, reason: 'DeadlineExceeded' }],
    },
    logger: { log() {}, error() {} },
  })
  assert.deepEqual(reconciled, ['trun_9'])
  const [id, patch] = store.updates[0]
  assert.equal(id, 'trun_9')
  assert.equal(patch.status, 'blocked')
  assert.match(patch.blockedReason, /DeadlineExceeded/u)
  // The run token has to go with it, or a container that outlives the Job could
  // still write a result into a run that was already closed.
  assert.equal(patch.runTokenSha256, null)
})

test('a healthy or already-reported run is left alone', async () => {
  const store = reconcileStore([{ id: 'trun_ok', status: 'running' }])
  await reconcileServerRuns({
    store,
    dispatcher: {
      available: true,
      listJobs: async () => [
        { runId: 'trun_ok', failed: false, succeeded: true, reason: null },
        // A failed Job for a run that already reported its own result: the run
        // is no longer `running`, so it must not be rewritten.
        { runId: 'trun_done', failed: true, reason: 'BackoffLimitExceeded' },
      ],
    },
    logger: { log() {}, error() {} },
  })
  assert.deepEqual(store.updates, [])
})

test('a listing failure does not break the scheduler tick', async () => {
  const store = reconcileStore([{ id: 'trun_9', status: 'running' }])
  const reconciled = await reconcileServerRuns({
    store,
    dispatcher: {
      available: true,
      listJobs: async () => {
        throw new Error('apiserver unreachable')
      },
    },
    logger: { log() {}, error() {} },
  })
  assert.deepEqual(reconciled, [])
  assert.deepEqual(store.updates, [])
})

test('the next Kubernetes operation reads a rotated ServiceAccount token', async () => {
  let token = 'token-before-rotation'
  let caReads = 0
  const authorizations = []
  const d = new KubernetesDispatcher({
    config,
    namespace: 'mx-test-framework',
    logger: { log() {} },
    readFileImpl: async (path) => {
      if (path.endsWith('/token')) return token
      caReads += 1
      return 'cluster-ca'
    },
    fetchImpl: async (_url, init) => {
      authorizations.push(init.headers.authorization)
      return {
        ok: true,
        json: async () => ({ items: [] }),
      }
    },
  })
  d.apiBase = 'https://kubernetes.test'

  await d.listJobs()
  token = 'token-after-rotation'
  await d.dispatch({ run, suite, app, env: {}, runToken: 'mxt-run-x', apiBase: 'http://mxt' })

  assert.deepEqual(authorizations, [
    'Bearer token-before-rotation',
    'Bearer token-after-rotation',
  ])
  assert.equal(caReads, 1, 'the stable cluster CA may stay cached')
})

// -- dispatch failures are visible --------------------------------------------

test('a run that can never start says so instead of sitting in the queue', async () => {
  const updates = []
  const store = {
    listRuns: async ({ status }) =>
      status === 'queued' ? [{ id: 'trun_9', appId: app.id, suiteId: suite.id }] : [],
    getSuite: async () => ({ ...suite, runnerKind: 'server' }),
    getApp: async () => app,
    updateRun: async (id, patch) => updates.push([id, patch]),
  }
  const dispatched = await dispatchQueued({
    store,
    dispatcher: {
      available: true,
      dispatch: async () => {
        throw new Error('Kubernetes rejected the Job: 403')
      },
    },
    config,
    buildEnv: () => ({}),
    issueRunToken: async () => 'mxt-run-x',
    logger: { error() {} },
  })
  assert.deepEqual(dispatched, [])
  assert.equal(updates[0][1].status, 'blocked')
  assert.match(updates[0][1].blockedReason, /403/u)
})

test('the global server-run cap leaves excess work queued', async () => {
  const runs = [
    { ...run, id: 'trun_a', status: 'queued', runsOn: 'server' },
    { ...run, id: 'trun_b', status: 'queued', runsOn: 'server' },
  ]
  const created = []
  const store = {
    listRuns: async ({ status, limit }) => runs.filter((entry) => entry.status === status).slice(0, limit),
    getSuite: async () => ({ ...suite, runnerKind: 'server' }),
    getApp: async () => app,
    updateRun: async (id, patch) => Object.assign(runs.find((entry) => entry.id === id), patch),
  }
  const dispatched = await dispatchQueued({
    store,
    dispatcher: {
      available: true,
      dispatch: async ({ run: next }) => created.push(next.id),
    },
    config: { ...config, maxConcurrentServerRuns: 1 },
    buildEnv: async () => ({}),
    issueRunToken: async () => 'mxt-run-x',
    logger: { error() {} },
  })
  assert.deepEqual(dispatched, ['trun_a'])
  assert.deepEqual(created, ['trun_a'])
  assert.equal(runs[0].status, 'running')
  assert.equal(runs[1].status, 'queued')
})

test('an already-running server Job consumes the global capacity', async () => {
  const queued = { ...run, id: 'trun_waiting', status: 'queued', runsOn: 'server' }
  const runs = [
    { ...run, id: 'trun_active', status: 'running', runsOn: 'server' },
    queued,
  ]
  let issueCalls = 0
  const dispatched = await dispatchQueued({
    store: {
      listRuns: async ({ status, limit }) =>
        runs.filter((entry) => entry.status === status).slice(0, limit),
      getSuite: async () => ({ ...suite, runnerKind: 'server' }),
    },
    dispatcher: { available: true, dispatch: async () => assert.fail('capacity was exceeded') },
    config: { ...config, maxConcurrentServerRuns: 1 },
    buildEnv: async () => ({}),
    issueRunToken: async () => {
      issueCalls += 1
      return 'mxt-run-x'
    },
    logger: { error() {} },
  })
  assert.deepEqual(dispatched, [])
  assert.equal(issueCalls, 0)
  assert.equal(queued.status, 'queued')
})

test('a live Kubernetes Job keeps capacity closed even after its database run timed out', async () => {
  const queued = { ...run, id: 'trun_after_timeout', status: 'queued', runsOn: 'server' }
  const dispatched = await dispatchQueued({
    store: {
      listRuns: async ({ status }) => (status === 'queued' ? [queued] : []),
      getSuite: async () => ({ ...suite, runnerKind: 'server' }),
    },
    dispatcher: {
      available: true,
      listJobs: async () => [{ runId: 'trun_timed_out', failed: false, succeeded: false }],
      dispatch: async () => assert.fail('a live Job already owns the capacity'),
    },
    config: { ...config, maxConcurrentServerRuns: 1 },
    buildEnv: async () => ({}),
    issueRunToken: async () => 'mxt-run-x',
    logger: { error() {} },
  })
  assert.deepEqual(dispatched, [])
  assert.equal(queued.status, 'queued')
})

test('disjoint database runs and live Jobs consume the union of server capacity', async () => {
  const queued = { ...run, id: 'trun_waiting_union', status: 'queued', runsOn: 'server' }
  const runs = [
    { ...run, id: 'trun_database_only', status: 'running', runsOn: 'server' },
    queued,
  ]
  const dispatched = await dispatchQueued({
    store: {
      listRuns: async ({ status, limit }) =>
        runs.filter((entry) => entry.status === status).slice(0, limit),
      getSuite: async () => ({ ...suite, runnerKind: 'server' }),
    },
    dispatcher: {
      available: true,
      listJobs: async () => [
        { runId: 'trun_kubernetes_only', failed: false, succeeded: false },
      ],
      dispatch: async () => assert.fail('the disjoint active runs fill both slots'),
    },
    config: { ...config, maxConcurrentServerRuns: 2 },
    buildEnv: async () => ({}),
    issueRunToken: async () => 'mxt-run-x',
    logger: { error() {} },
  })
  assert.deepEqual(dispatched, [])
  assert.equal(queued.status, 'queued')
})

test('an overlapping database run and live Job consume one server slot', async () => {
  const queued = { ...run, id: 'trun_after_overlap', status: 'queued', runsOn: 'server' }
  const runs = [
    { ...run, id: 'trun_same_active', status: 'running', runsOn: 'server' },
    queued,
  ]
  const created = []
  const dispatched = await dispatchQueued({
    store: {
      listRuns: async ({ status, limit }) =>
        runs.filter((entry) => entry.status === status).slice(0, limit),
      getSuite: async () => ({ ...suite, runnerKind: 'server' }),
      getApp: async () => app,
      updateRun: async (id, patch) => Object.assign(runs.find((entry) => entry.id === id), patch),
    },
    dispatcher: {
      available: true,
      listJobs: async () => [
        { runId: 'trun_same_active', failed: false, succeeded: false },
      ],
      dispatch: async ({ run: next }) => created.push(next.id),
      imageFor: () => 'runner:test',
    },
    config: { ...config, maxConcurrentServerRuns: 2 },
    buildEnv: async () => ({}),
    issueRunToken: async () => 'mxt-run-x',
    logger: { error() {} },
  })
  assert.deepEqual(dispatched, ['trun_after_overlap'])
  assert.deepEqual(created, ['trun_after_overlap'])
  assert.equal(queued.status, 'running')
})

test('a live Job without a run id conservatively consumes its own server slot', async () => {
  const queued = { ...run, id: 'trun_waiting_unknown', status: 'queued', runsOn: 'server' }
  const runs = [
    { ...run, id: 'trun_known_active', status: 'running', runsOn: 'server' },
    queued,
  ]
  const dispatched = await dispatchQueued({
    store: {
      listRuns: async ({ status, limit }) =>
        runs.filter((entry) => entry.status === status).slice(0, limit),
      getSuite: async () => ({ ...suite, runnerKind: 'server' }),
    },
    dispatcher: {
      available: true,
      listJobs: async () => [{ runId: null, failed: false, succeeded: false }],
      dispatch: async () => assert.fail('an unidentified live Job may not be ignored'),
    },
    config: { ...config, maxConcurrentServerRuns: 2 },
    buildEnv: async () => ({}),
    issueRunToken: async () => 'mxt-run-x',
    logger: { error() {} },
  })
  assert.deepEqual(dispatched, [])
  assert.equal(queued.status, 'queued')
})

test('a local-runner execution does not consume Kubernetes server capacity', async () => {
  const runs = [
    { ...run, id: 'trun_local', status: 'running', runsOn: 'any-runner' },
    { ...run, id: 'trun_server', status: 'queued', runsOn: 'server' },
  ]
  const store = {
    listRuns: async ({ status, limit }) => runs.filter((entry) => entry.status === status).slice(0, limit),
    getSuite: async () => ({ ...suite, runnerKind: 'server' }),
    getApp: async () => app,
    updateRun: async (id, patch) => Object.assign(runs.find((entry) => entry.id === id), patch),
  }
  const dispatched = await dispatchQueued({
    store,
    dispatcher: { available: true, dispatch: async () => {} },
    config: { ...config, maxConcurrentServerRuns: 1 },
    buildEnv: async () => ({}),
    issueRunToken: async () => 'mxt-run-x',
    logger: { error() {} },
  })
  assert.deepEqual(dispatched, ['trun_server'])
})

// -- the platform is not tied to one engine -----------------------------------

test('each engine gets a pinned default image, and generic must bring its own', () => {
  const d = dispatcher()
  assert.match(d.imageFor({ engine: 'cypress' }), /^cypress\/included:\d/u)
  assert.match(d.imageFor({ engine: 'playwright' }), /playwright:v\d/u)
  assert.match(d.imageFor({ engine: 'pytest' }), /^python:3\.\d+/u)
  assert.match(d.imageFor({ engine: 'k6' }), /^grafana\/k6:\d/u)
  // A suite naming its own image wins, which is what lets an unlisted stack on.
  assert.equal(
    d.imageFor({ engine: 'pytest', runnerImage: 'mcr.microsoft.com/playwright/python:v1.56.0' }),
    'mcr.microsoft.com/playwright/python:v1.56.0',
  )
  // `generic` with no image is refused rather than defaulted: running a suite in
  // the wrong runtime fails deep inside the test command, and the reason then
  // gets recorded as a test failure instead of as misconfiguration.
  assert.throws(() => d.imageFor({ engine: 'generic', slug: 'x' }), /runnerImage/u)
})

test('no default image is ever floating', () => {
  // `latest` would let a base image change under a suite and turn a green run
  // red for reasons nobody can reconstruct from the run record.
  for (const [engine, image] of Object.entries(config.runnerImages)) {
    if (!image) continue
    assert.ok(!image.endsWith(':latest') && image.includes(':'), `${engine} → ${image}`)
  }
})

// -- who owns the test code ---------------------------------------------------

test('a suite may live in the test team own repository', () => {
  // The application repo needs no change at all — no package.json script, no
  // Makefile, no pull request into a team that did not ask to be involved.
  const qaSuite = {
    ...suite,
    repoUrl: 'https://github.com/qa/luopan-e2e',
    defaultBranch: 'main',
  }
  assert.equal(KubernetesDispatcher.repoUrlFor(app, qaSuite), 'https://github.com/qa/luopan-e2e')
  assert.equal(KubernetesDispatcher.sourceRefFor({}, app, qaSuite), 'main')

  const env = Object.fromEntries(
    dispatcher()
      .manifest({ run, suite: qaSuite, app, env: {}, runToken: 't', apiBase: 'http://mxt' })
      .spec.template.spec.containers[0].env.map((entry) => [entry.name, entry.value]),
  )
  assert.equal(env.MXT_REPO_URL, 'https://github.com/qa/luopan-e2e')
  assert.equal(env.MXT_SOURCE_REF, 'main')
})

test('a co-located suite still follows the application repo', () => {
  // Tests that share fixtures or types with the code under test belong next to
  // it, and nothing about them changes.
  assert.equal(KubernetesDispatcher.repoUrlFor(app, suite), app.repoUrl)
  assert.equal(
    KubernetesDispatcher.sourceRefFor({}, { ...app, defaultBranch: 'public' }, suite),
    'public',
  )
})

test('the run pin still wins over both', () => {
  // "Re-run last Tuesday's failure" has to mean that commit, whatever either
  // repository's default branch says today.
  assert.equal(
    KubernetesDispatcher.sourceRefFor(
      { sourceRef: { ref: 'abc123' } },
      { defaultBranch: 'public' },
      { defaultBranch: 'main' },
    ),
    'abc123',
  )
})

// -- the scripts the container actually runs ----------------------------------
//
// Every one of these is a JavaScript file written inside a JavaScript template
// literal, then written again inside a shell heredoc. Two escaping layers, and
// both have already broken it once: a newline escape in the embedded source
// became a real newline, and a top-level `await` became a syntax error because
// /tmp has no package.json and node parses a bare .js as CommonJS.
//
// Neither failure showed up until a container tried to run it. This is that
// check, moved to where it costs nothing.

test('every embedded script parses the way the container will parse it', async () => {
  const { Script } = await import('node:vm')
  const source = dispatcher().script({ apiBase: 'http://mxt' })

  for (const name of [
    'mxt-api.js',
    'mxt-exec.js',
    'mxt-upload.js',
    'mxt-progress.js',
    'mxt-report.js',
    'mxt-blocked.js',
  ]) {
    const opening = `cat > /tmp/${name} <<'MXT_EOF'\n`
    assert.ok(source.includes(opening), `${name} 必须在脚本里被创建，而不只是被调用`)
    const body = source.split(opening)[1].split('\nMXT_EOF')[0]
    // `new Script` parses as a classic script — exactly what `node file.js`
    // does for a .js with no package.json. Top-level await fails here, as it
    // would there.
    assert.doesNotThrow(() => new Script(body, { filename: name }), `${name} 语法错误`)
  }
})

test('nothing in the container reaches for curl', () => {
  // cypress/included has node and no curl, and the platform runs JavaScript in
  // that image by definition. The first real Kubernetes dispatch died here: the
  // tests ran and the result could not be handed back.
  const source = dispatcher().script({ apiBase: 'http://mxt' })
  assert.ok(!/curl\s+-/u.test(source), '容器脚本不能依赖 curl')
})

test('the suite output has somewhere to go', () => {
  const job = dispatcher().manifest({
    run: { id: 'trun_x', appId: 'app_1', suiteId: 'ste_1' },
    suite: { slug: 's', engine: 'cypress', surface: 'web', command: ['pnpm', 'e2e'] },
    app: { slug: 'a' },
    env: {},
    runToken: 'mxt-run_x',
    apiBase: 'http://mxt:8790',
  })
  const env = job.spec.template.spec.containers[0].env
  const url = env.find((entry) => entry.name === 'MXT_EVENTS_URL')
  assert.equal(url?.value, 'http://mxt:8790/runner/v1/runs/trun_x/events')
})

test('a private repository can be given a credential from configuration alone', async () => {
  // This path was dead: `MXT_GIT_TOKEN_SECRET` was read by the config and never
  // passed to the Deployment, and the Job looked for a key nothing wrote. A
  // private repo failed at `git fetch` with no way to fix it from config.
  const { loadConfig } = await import('../server/config.mjs')
  const { KubernetesDispatcher } = await import('../server/runner/dispatcher.mjs')
  const build = (env) =>
    new KubernetesDispatcher({
      config: loadConfig({ MXT_STORE: 'memory', MXT_ADMIN_TOKEN: 'x', ...env }),
      namespace: 'n',
    }).manifest({
      run: { id: 'trun_1' },
      suite: { slug: 's', engine: 'cypress', command: ['pnpm', 'e2e'] },
      app: { slug: 'a', repoUrl: 'https://github.com/org/private' },
      env: {},
      runToken: 'mxt-run_x',
      apiBase: 'http://mxt',
    })

  const fromPlatformSecret = build({}).spec.template.spec.containers[0].env.find(
    (entry) => entry.name === 'MXT_GIT_TOKEN',
  )
  assert.equal(fromPlatformSecret.valueFrom.secretKeyRef.name, 'mx-test-framework-secrets')
  assert.equal(fromPlatformSecret.valueFrom.secretKeyRef.key, 'MXT_GIT_TOKEN')
  assert.equal(fromPlatformSecret.valueFrom.secretKeyRef.optional, true, '公开仓库不该因为没有凭据就起不来')

  const overridden = build({
    MXT_GIT_TOKEN_SECRET: 'someone-elses-secret',
    MXT_GIT_TOKEN_SECRET_KEY: 'token',
  }).spec.template.spec.containers[0].env.find((entry) => entry.name === 'MXT_GIT_TOKEN')
  assert.equal(overridden.valueFrom.secretKeyRef.name, 'someone-elses-secret')
  assert.equal(overridden.valueFrom.secretKeyRef.key, 'token')
})

test('collection is only reported as done once there is something to collect', () => {
  // The first real dispatch reported `upload ok` and then `upload failed` on the
  // same run: the stage was marked done unconditionally, and the "produced no
  // report" check fired afterwards. Two claims about one step, and the failure
  // was attributed to collecting the artefacts rather than to the suite that
  // produced none.
  const script = dispatcher().script({ apiBase: 'http://mxt' })
  const check = script.indexOf('runner produced neither summary.json')
  const uploadOk = script.indexOf('stage upload ok')
  assert.ok(check !== -1 && uploadOk !== -1)
  assert.ok(uploadOk > check, '「收产物」要在确认有产物之后才算成功')
})

test('a suite with no repository says so instead of hanging on 检出', () => {
  const script = dispatcher().script({ apiBase: 'http://mxt' })
  assert.match(script, /stage checkout skipped/u)
})
