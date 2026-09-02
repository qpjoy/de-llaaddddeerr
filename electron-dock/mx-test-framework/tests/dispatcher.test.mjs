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
  assert.match(script, /--data-binary @\/tmp\/payload\.json/u)
  assert.match(script, /"\$attempt" -le 3/u)
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

test('the checkout lives in a capped emptyDir, not on the artifacts volume', () => {
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
  const mount = containers[0].volumeMounts.find((entry) => entry.name === 'workspace')
  assert.equal(mount.mountPath, '/work')
  assert.equal(containers[0].securityContext.allowPrivilegeEscalation, false)
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

// -- dispatch failures are visible --------------------------------------------

test('a run that can never start says so instead of sitting in the queue', async () => {
  const updates = []
  const store = {
    listRuns: async () => [{ id: 'trun_9', appId: app.id, suiteId: suite.id }],
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
