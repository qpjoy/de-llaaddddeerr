import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'
import { runnerIsOnline, resolvePlacement } from '../server/runner/placement.mjs'

// 「在哪跑」 — docs/25 §12 and §13. What these protect is that the choice is
// real: a run marked for the server never lands on somebody's laptop, a pinned
// run lands on exactly one machine, and an impossible combination is refused
// when it is chosen rather than twelve hours later when it expires.

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

test('a task that says nothing keeps the behaviour its suite always had', () => {
  const local = resolvePlacement({ task: {}, suite: { runnerKind: 'local' } })
  assert.equal(local.runsOn, 'any-runner')
  assert.equal(local.status, 'pending-runner')
  assert.ok(local.claimDeadline, 'work that waits for a machine can expire waiting')

  const server = resolvePlacement({ task: {}, suite: { runnerKind: 'server' } })
  assert.equal(server.runsOn, 'server')
  assert.equal(server.status, 'queued')
  assert.equal(server.claimDeadline, null, 'a deadline here would double up on the lease')
})

test('online is derived from the last check-in, never stored', () => {
  const now = Date.now()
  assert.equal(runnerIsOnline({ lastSeenAt: new Date(now - 5_000).toISOString() }, now), true)
  assert.equal(runnerIsOnline({ lastSeenAt: new Date(now - 600_000).toISOString() }, now), false)
  assert.equal(runnerIsOnline({ lastSeenAt: null }, now), false)
  // A machine that is busy for twenty minutes is not a machine that is gone.
  assert.equal(
    runnerIsOnline({ status: 'busy', lastSeenAt: new Date(now - 61_000).toISOString() }, now),
    true,
  )
  assert.equal(
    runnerIsOnline({ status: 'disabled', lastSeenAt: new Date(now).toISOString() }, now),
    false,
  )
})

let laptopToken
let capacityToken
let laptopId

test('setting up one web suite, one desktop suite and two machines', async () => {
  await api('POST', '/api/v1/apps', { body: { slug: 'place', displayName: '派活演示' } })
  for (const suite of [
    { slug: 'web', displayName: 'Web 主轨', engine: 'cypress', surface: 'web', runnerKind: 'server' },
    {
      slug: 'desktop',
      displayName: '桌面端',
      engine: 'playwright-electron',
      surface: 'electron',
      runnerKind: 'local',
    },
  ]) {
    const created = await api('POST', '/api/v1/apps/place/suites', {
      body: { ...suite, command: ['pnpm', 'e2e'] },
    })
    assert.equal(created.status, 201)
  }

  const laptop = await api('POST', '/runner/v1/runners:register', {
    body: {
      name: '老王的笔记本',
      kind: 'local',
      os: 'windows',
      engines: ['cypress', 'playwright-electron'],
      surfaces: ['web', 'electron'],
    },
  })
  laptopToken = laptop.body.token
  laptopId = laptop.body.runner.id

  const capacity = await api('POST', '/runner/v1/runners:register', {
    body: { name: 'ci-linux', kind: 'server', os: 'linux', engines: ['cypress'], surfaces: ['web'] },
  })
  capacityToken = capacity.body.token
})

test('a desktop suite cannot be sent to the server, and says so on the spot', async () => {
  const refused = await api('POST', '/api/v1/tasks', {
    body: { app: 'place', suite: 'desktop', name: '不可能的组合', runsOn: 'server' },
  })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'placement_impossible')
  assert.match(refused.body.error.hint, /没有 Windows/u)
})

test('pinning to a machine that cannot run the suite is refused too', async () => {
  const capacityRunner = (await api('GET', '/api/v1/runners')).body.runners.find(
    (runner) => runner.name === 'ci-linux',
  )
  const refused = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'place',
      suite: 'desktop',
      name: '派给跑不了的机器',
      runsOn: 'pinned-runner',
      runnerId: capacityRunner.id,
    },
  })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'runner_incapable')

  const noMachine = await api('POST', '/api/v1/tasks', {
    body: { app: 'place', suite: 'desktop', name: '空的指派', runsOn: 'pinned-runner' },
  })
  assert.equal(noMachine.status, 400, 'a pin with no machine is not a pin')
})

test("a server run is not handed to somebody's laptop", async () => {
  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'place',
      suite: 'web',
      name: '服务器静默跑',
      runsOn: 'server',
      targetUrl: 'https://place.example.internal',
    },
  })
  assert.equal(task.status, 201)
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`)
  assert.equal(run.body.run.status, 'queued')
  assert.match(run.body.note, /不录像/u)

  const laptopClaim = await api('POST', '/runner/v1/runs:claim', { token: laptopToken, body: {} })
  assert.equal(laptopClaim.status, 204, 'a personal machine must not pick up cluster work')

  // A machine registered as platform capacity is a different matter: that is
  // how a deployment with no Kubernetes runs headless work at all.
  const capacityClaim = await api('POST', '/runner/v1/runs:claim', { token: capacityToken, body: {} })
  assert.equal(capacityClaim.status, 200)
  assert.equal(capacityClaim.body.runId, run.body.run.id)
  assert.equal(capacityClaim.body.env.MXT_RECORD_VIDEO, '0', '服务端轨默认不录像')
  assert.equal(capacityClaim.body.env.CYPRESS_VIDEO, 'false', 'cypress reads this one itself')
})

test('a pinned run waits for its own machine and nobody else', async () => {
  const other = await api('POST', '/runner/v1/runners:register', {
    body: {
      name: '另一台 Windows',
      kind: 'local',
      os: 'windows',
      engines: ['playwright-electron'],
      surfaces: ['electron'],
    },
  })

  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'place',
      suite: 'desktop',
      name: '派给老王的笔记本',
      runsOn: 'pinned-runner',
      runnerId: laptopId,
    },
  })
  assert.equal(task.status, 201)
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`)
  assert.equal(run.body.run.status, 'pending-runner')
  assert.equal(run.body.run.assignedRunnerId, laptopId)

  const wrongMachine = await api('POST', '/runner/v1/runs:claim', {
    token: other.body.token,
    body: {},
  })
  assert.equal(wrongMachine.status, 204, 'a pin is not a suggestion')

  const claimed = await api('POST', '/runner/v1/runs:claim', { token: laptopToken, body: {} })
  assert.equal(claimed.status, 200)
  assert.equal(claimed.body.runId, run.body.run.id)
  assert.equal(claimed.body.env.MXT_RECORD_VIDEO, '1', '在真机上跑就是为了看回放')
})

test('where a task runs can be changed later', async () => {
  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'place',
      suite: 'web',
      name: '先服务器后真机',
      runsOn: 'server',
      targetUrl: 'https://place.example.internal',
    },
  })
  const moved = await api('PATCH', `/api/v1/tasks/${task.body.task.id}`, {
    body: { runsOn: 'pinned-runner', runnerId: laptopId },
  })
  assert.equal(moved.status, 200)
  assert.equal(moved.body.task.runsOn, 'pinned-runner')
  assert.equal(moved.body.task.runnerId, laptopId)

  const backToImpossible = await api('PATCH', `/api/v1/tasks/${task.body.task.id}`, {
    body: { runsOn: 'pinned-runner' },
  })
  assert.equal(backToImpossible.status, 400)
})
