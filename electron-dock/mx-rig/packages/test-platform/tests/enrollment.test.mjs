import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'
import { sha256 } from '../server/core/ids.mjs'

// Self-service onboarding — docs/25 §6. A person signed in to the browser mints
// a code; the machine redeems it once, from a script, with nobody typing a
// password on it. What these protect is that the code is genuinely one-shot,
// genuinely short-lived, and that the machine never gets to say whose it is.

const ADMIN_TOKEN = 'test-admin-token'
let base
let runtime

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

const text = async (path, headers = {}) => {
  const response = await fetch(`${base}${path}`, { headers })
  return { status: response.status, headers: response.headers, body: await response.text() }
}

before(async () => {
  runtime = await start(
    loadConfig({
      MXT_STORE: 'memory',
      MXT_ADMIN_TOKEN: ADMIN_TOKEN,
      MXT_PORT: '0',
      MXT_ARTIFACTS_DIR: '.runtime/test-artifacts',
    }),
    { schedule: false },
  )
  base = `http://127.0.0.1:${runtime.port}`
})

after(async () => {
  await runtime.close()
})

test('the install scripts and the runner they install need no credentials', async () => {
  // The machine running them has none yet — that is the whole point.
  const unix = await text('/install.sh')
  assert.equal(unix.status, 200)
  assert.match(unix.body, /MXT_CODE/u)
  assert.match(unix.body, /install\/mxt-runner\.mjs/u)
  // It must refuse rather than install a language runtime behind someone's back.
  assert.match(unix.body, /没有找到 node/u)

  const windows = await text('/install.ps1')
  assert.equal(windows.status, 200)
  assert.match(windows.body, /LOCALAPPDATA/u, '装在用户目录，不要管理员权限')

  const runner = await text('/install/mxt-runner.mjs')
  assert.equal(runner.status, 200)
  assert.match(runner.body, /mxt-runner/u)
  const staleDigestRemoval = runner.body.indexOf('delete childEnv.MXT_APP_SHA256')
  const packageDownload = runner.body.indexOf('await downloadPackage(config, claimed.appPackage)')
  const verifiedDigestInjection = runner.body.indexOf('childEnv.MXT_APP_SHA256 = verifiedDigest')
  assert.ok(staleDigestRemoval !== -1 && staleDigestRemoval < packageDownload)
  assert.ok(packageDownload < verifiedDigestInjection)
  assert.match(runner.body, /childEnv\.MX_AUTO_APP_SHA256 = verifiedDigest/u)
})

test('the command carries the address the browser actually reached', async () => {
  // Not the in-cluster name from config: the person is looking at this page
  // from that machine, so that address demonstrably resolves there.
  const created = await api('POST', '/api/v1/runners:enroll')
  assert.equal(created.status, 201)
  assert.match(created.body.commands.unix, new RegExp(`curl -fsSL ${base}/install.sh`, 'u'))
  assert.match(created.body.commands.windows, /irm .*\/install\.ps1 \| iex/u)
  assert.ok(created.body.commands.unix.includes(created.body.code))
})

test('a hostile Host header cannot be pasted into somebody else terminal', async () => {
  const response = await fetch(`${base}/api/v1/runners:enroll`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'x-forwarded-host': 'evil.test"; rm -rf /' },
  })
  const payload = await response.json()
  // The value ends up inside a shell command, so anything that is not plainly a
  // hostname is refused rather than escaped.
  assert.ok(!payload.commands.unix.includes('rm -rf'))
})

test('a code works exactly once, and the machine does not choose its owner', async () => {
  const created = await api('POST', '/api/v1/runners:enroll')
  const code = created.body.code

  const enrolled = await api('POST', '/runner/v1/runners:enroll', {
    token: null,
    body: {
      code,
      name: '新来的 Windows',
      os: 'windows',
      arch: 'x64',
      engines: ['cypress'],
      surfaces: ['web'],
      // Claiming to belong to somebody else is simply not read.
      ownerPrincipal: 'someone-else',
    },
  })
  assert.equal(enrolled.status, 201)
  assert.ok(enrolled.body.token.startsWith('mxt-rnr_'))
  assert.equal(enrolled.body.runner.tokenSha256, undefined)
  assert.notEqual(enrolled.body.runner.ownerPrincipal, 'someone-else')

  const again = await api('POST', '/runner/v1/runners:enroll', {
    token: null,
    body: { code, name: '第二台', os: 'macos', engines: ['cypress'], surfaces: ['web'] },
  })
  assert.equal(again.status, 409)
  assert.match(again.body.error.hint, /只能接一台/u)

  const nonsense = await api('POST', '/runner/v1/runners:enroll', {
    token: null,
    body: { code: 'mxt-enr_not-a-real-code', name: 'x', os: 'linux' },
  })
  assert.equal(nonsense.status, 401)

  // And the token it issued is a working runner credential.
  const claim = await api('POST', '/runner/v1/runs:claim', { token: enrolled.body.token, body: {} })
  assert.equal(claim.status, 204, 'nothing queued, but the credential was accepted')
})

test('an expired code is refused, and says why', async () => {
  // Written straight into the store with a deadline in the past, rather than
  // waiting fifteen minutes for a real one to lapse.
  const code = 'mxt-enr_expired-on-purpose'
  await runtime.store.createEnrollment({
    codeSha256: sha256(code),
    principal: 'admin',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  })

  const refused = await api('POST', '/runner/v1/runners:enroll', {
    token: null,
    body: { code, name: '迟到的机器', os: 'linux' },
  })
  assert.equal(refused.status, 410)
  assert.match(refused.body.error.message, /过期/u)
})

test('the page that issued the code can watch for the machine to arrive', async () => {
  const created = await api('POST', '/api/v1/runners:enroll')
  const pending = await api('GET', `/api/v1/enrollments/${created.body.enrollment.id}`)
  assert.equal(pending.body.status, 'pending')
  assert.equal(pending.body.runner, null)

  await api('POST', '/runner/v1/runners:enroll', {
    token: null,
    body: { code: created.body.code, name: '会出现的机器', os: 'macos', engines: ['cypress'], surfaces: ['web'] },
  })

  const claimed = await api('GET', `/api/v1/enrollments/${created.body.enrollment.id}`)
  assert.equal(claimed.body.status, 'claimed')
  assert.equal(claimed.body.runner.name, '会出现的机器')
  assert.equal(claimed.body.runner.online, true)

  // Someone else's code and a code that never existed answer identically:
  // telling them apart would let anyone enumerate outstanding enrolments.
  const stranger = await api('GET', '/api/v1/enrollments/enr_does_not_exist')
  assert.equal(stranger.status, 404)
})

test('a machine can be removed again', async () => {
  const created = await api('POST', '/api/v1/runners:enroll')
  const enrolled = await api('POST', '/runner/v1/runners:enroll', {
    token: null,
    body: { code: created.body.code, name: '临时机器', os: 'linux', engines: ['cypress'], surfaces: ['web'] },
  })
  const id = enrolled.body.runner.id

  const removed = await api('DELETE', `/api/v1/runners/${id}`)
  assert.equal(removed.status, 204)
  assert.equal((await api('DELETE', `/api/v1/runners/${id}`)).status, 404)
  assert.ok(!(await api('GET', '/api/v1/runners')).body.runners.some((runner) => runner.id === id))

  // The trail keeps both halves: a machine appearing and a machine going away
  // are equally worth being able to look up later.
  const audit = await api('GET', '/api/v1/audit?resourceType=runner')
  const actions = audit.body.events.map((event) => event.action)
  assert.ok(actions.includes('runner.enroll'))
  assert.ok(actions.includes('runner.remove'))
  assert.ok(actions.includes('runner.enroll_code'))
})

// -- removing an application ---------------------------------------------------
//
// The one delete on the platform that takes history with it. Refusing by
// default is the feature: an application with runs is an application with trend
// data, and there is no undo.

test('an application with runs is not deleted by accident', async () => {
  await api('POST', '/api/v1/apps', { body: { slug: 'doomed', displayName: '要删掉的' } })
  await api('POST', '/api/v1/apps/doomed/suites', {
    body: {
      slug: 'smoke',
      displayName: 'Smoke',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'server',
      command: ['pnpm', 'e2e'],
    },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: { app: 'doomed', suite: 'smoke', name: '一次', targetUrl: 'https://doomed.example.internal' },
  })
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`)
  assert.equal(run.status, 202)

  const refused = await api('DELETE', '/api/v1/apps/doomed')
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'app_has_runs')
  assert.match(refused.body.error.hint, /force=true/u)
  assert.ok((await api('GET', '/api/v1/apps')).body.apps.some((app) => app.slug === 'doomed'))

  const forced = await api('DELETE', '/api/v1/apps/doomed?force=true')
  assert.equal(forced.status, 200)
  assert.equal(forced.body.runs, 1)

  // Everything that hung off it goes at the same time — the same cascade the
  // schema declares, so memory mode and PostgreSQL agree about what is left.
  assert.ok(!(await api('GET', '/api/v1/apps')).body.apps.some((app) => app.slug === 'doomed'))
  assert.equal((await api('GET', `/api/v1/runs/${run.body.run.id}`)).status, 404)
  assert.equal((await api('GET', '/api/v1/apps/doomed/suites')).status, 404)
  assert.ok(!(await api('GET', '/api/v1/tasks')).body.tasks.some((entry) => entry.id === task.body.task.id))
})

test('an application with no runs goes without ceremony, and only for an admin', async () => {
  await api('POST', '/api/v1/apps', { body: { slug: 'never-used', displayName: '没跑过' } })
  const clean = await api('DELETE', '/api/v1/apps/never-used')
  assert.equal(clean.status, 200)
  assert.equal(clean.body.runs, 0)
  assert.equal((await api('DELETE', '/api/v1/apps/never-used')).status, 404)
})

test('a suite can be removed, and takes its tasks with it', async () => {
  // Suites could be created and never removed: no delete, no disable. A demo
  // suite added by mistake stayed in the 新建任务 dropdown forever.
  await api('POST', '/api/v1/apps', { body: { slug: 'suitedel', displayName: '删套件' } })
  await api('POST', '/api/v1/apps/suitedel/suites', {
    body: { slug: 'keep', displayName: '留着', engine: 'cypress', surface: 'web', runnerKind: 'server', command: ['pnpm', 'e2e'] },
  })
  await api('POST', '/api/v1/apps/suitedel/suites', {
    body: { slug: 'oops', displayName: '建错了', engine: 'cypress', surface: 'web', runnerKind: 'server', command: ['pnpm', 'e2e'] },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: { app: 'suitedel', suite: 'oops', name: '指向它的任务', targetUrl: 'https://s.example.internal' },
  })

  // Nothing has run yet, so it goes without ceremony.
  const clean = await api('DELETE', '/api/v1/apps/suitedel/suites/oops')
  assert.equal(clean.status, 200)
  const left = await api('GET', '/api/v1/apps/suitedel/suites')
  assert.deepEqual(left.body.suites.map((entry) => entry.slug), ['keep'])
  // The task pointed at it and cannot outlive it.
  assert.ok(!(await api('GET', '/api/v1/tasks')).body.tasks.some((entry) => entry.id === task.body.task.id))

  // One with history refuses until somebody says they mean it.
  const withRuns = await api('POST', '/api/v1/tasks', {
    body: { app: 'suitedel', suite: 'keep', name: '跑过一次', targetUrl: 'https://s.example.internal' },
  })
  await api('POST', `/api/v1/tasks/${withRuns.body.task.id}:run`)
  const refused = await api('DELETE', '/api/v1/apps/suitedel/suites/keep')
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'suite_has_runs')
  assert.equal((await api('DELETE', '/api/v1/apps/suitedel/suites/keep?force=true')).status, 200)

  await api('DELETE', '/api/v1/apps/suitedel?force=true')
})
