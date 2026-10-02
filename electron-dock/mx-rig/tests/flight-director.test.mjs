import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDraft, draftFlightPlan, templatePlan } from '../apps/server/flight-director.mjs'
import { validateOrchestration } from '../packages/graph/orchestration.mjs'
import { start } from '../apps/server/index.mjs'

const apps = [{ id: 'app-1', slug: 'compass', displayName: 'Compass' }]
const suites = [
  { id: 'suite-web', engine: 'cypress', surface: 'web' },
  { id: 'suite-el', engine: 'playwright-electron', surface: 'electron' }
]
const tasks = [
  { id: 'tsk_login', name: 'Compass 登录冒烟', appId: 'app-1', suiteId: 'suite-web' },
  { id: 'tsk_full', name: 'Compass 全量回归', appId: 'app-1', suiteId: 'suite-el' },
  { id: 'tsk_other', name: '订单导出', appId: 'app-9', suiteId: 'suite-web' }
]

test('a sentence becomes a reviewable plan without any model', () => {
  const { spec, matched, warnings } = templatePlan({
    text: '跑一下 Compass 登录冒烟，然后全量回归，结果发飞书',
    tasks,
    apps,
    suites
  })
  assert.ok(validateOrchestration(spec))
  const types = spec.nodes.map((node) => node.type)
  assert.deepEqual(types, ['preflight', 'flight', 'gate', 'flight', 'gate', 'debrief'])
  assert.equal(spec.nodes[1].taskId, 'tsk_login')
  assert.equal(spec.nodes[3].taskId, 'tsk_full')
  assert.ok(spec.nodes[0].checks.includes('package'), 'the Electron regression needs a package')
  assert.equal(spec.nodes.at(-1).notify, true)
  assert.ok(spec.nodes.filter((node) => node.type === 'gate').every((node) => node.onFail === 'debrief'))
  assert.equal(spec.nodes[0].onNoGo, 'debrief', 'a scrub still ends in a report')
  assert.equal(spec.nodes[4].confirm, true, 'regression release asks a person')
  assert.deepEqual(matched.map((entry) => entry.taskId), ['tsk_login', 'tsk_full'])
  assert.deepEqual(warnings, [])
  assert.deepEqual(spec.authorize, { dispatch: false })
})

test('exploration is proposed only where it can run', () => {
  const web = templatePlan({ text: '巡检一下 Compass 登录冒烟的页面', tasks, apps, suites })
  assert.ok(!web.spec.nodes.some((node) => node.type === 'explore'))
  assert.match(web.warnings.join(), /只能在桌面端/)
  const desktop = templatePlan({
    text: '巡检一下 Compass 登录冒烟的页面',
    tasks,
    apps,
    suites,
    desktop: true,
    browserReady: true
  })
  const explore = desktop.spec.nodes.find((node) => node.type === 'explore')
  assert.ok(explore)
  assert.ok(desktop.spec.nodes[0].checks.includes('browser'))
  const unmatched = templatePlan({ text: '随便测测', tasks, apps, suites })
  assert.match(unmatched.warnings.join(), /没有找到/)
  assert.ok(validateOrchestration(unmatched.spec))
})

const modelPlan = {
  key: 'Bad Key!',
  displayName: '登录飞行',
  summary: '模型写的',
  entry: 'pf',
  schedule: { cronExpr: '* * * * *' },
  authorize: { dispatch: true },
  nodes: [
    { id: 'pf', type: 'preflight', title: '预检', taskIds: ['tsk_login'], checks: ['runners'], onNoGo: 'rep', next: 'f1' },
    { id: 'f1', type: 'flight', title: '冒烟', taskId: 'tsk_login', next: 'g1' },
    { id: 'g1', type: 'gate', title: '放行', criteria: [{ metric: 'run_passed', stage: 'f1' }], onFail: 'rep', next: 'rep' },
    { id: 'rep', type: 'debrief', title: '讲评', next: null }
  ]
}

test('a model draft is held to the same rules, and cannot grant itself anything', () => {
  const spec = checkDraft('```json\n' + JSON.stringify(modelPlan) + '\n```', { tasks, desktop: false })
  assert.match(spec.key, /^flight-/, 'an invalid key is replaced')
  assert.equal(spec.schedule, null, 'a draft cannot schedule itself')
  assert.deepEqual(spec.authorize, { dispatch: false }, 'nor pre-authorise its dispatches')
  const invented = structuredClone(modelPlan)
  invented.nodes[1].taskId = 'tsk_made_up'
  assert.throws(() => checkDraft(JSON.stringify(invented), { tasks }), /不存在的测试计划/)
  assert.throws(() => checkDraft('这不是 JSON', { tasks }), /不是 JSON/)
})

test('a draft that fails twice falls back to the template and says why', async () => {
  const replies = [{ content: '好的，这是计划' }, { content: '```json {"nodes": []} ```' }]
  const seen = []
  const draft = await draftFlightPlan({
    text: '跑一下 Compass 登录冒烟',
    tasks,
    apps,
    suites,
    turn: async (body) => {
      seen.push(structuredClone(body))
      return { message: replies.shift() }
    }
  })
  assert.equal(draft.source, 'template')
  assert.match(draft.warnings[0], /两次都没有通过校验/)
  assert.equal(seen.length, 2)
  assert.match(seen[1].messages.at(-1).content, /没有通过校验/, 'the second try is told what was wrong')
  assert.ok(seen[0].messages.every((message) => message.role === 'user'))
  assert.match(seen[0].messages[0].content, /tsk_login｜Compass 登录冒烟/)

  const good = await draftFlightPlan({
    text: '跑一下 Compass 登录冒烟',
    tasks,
    apps,
    suites,
    turn: async () => ({ message: { content: JSON.stringify(modelPlan) } })
  })
  assert.equal(good.source, 'model')
  assert.equal(good.spec.nodes[1].taskId, 'tsk_login')
})

test('the draft route answers with a plan and the graph it compiles to', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-director-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'director-admin',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body) => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer director-admin',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  await api('/api/v1/apps', { slug: 'compass', displayName: 'Compass', surfaces: ['web'] })
  await api('/api/v1/apps/compass/suites', {
    slug: 'smoke',
    displayName: 'Smoke',
    engine: 'playwright',
    surface: 'web',
    runnerKind: 'local',
    command: ['node', 'test.mjs'],
    targetMode: 'self'
  })
  const task = await api('/api/v1/tasks', {
    app: 'compass',
    suite: 'smoke',
    name: '登录冒烟',
    profile: 'mock',
    track: 'functional'
  })
  const drafted = await api('/api/rig/v1/flight-plans:draft', { text: '跑一下登录冒烟' })
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body))
  const { draft } = drafted.body
  assert.equal(draft.source, 'template', 'no model is configured')
  assert.equal(draft.spec.nodes.find((node) => node.type === 'flight').taskId, task.body.task.id)
  assert.ok(draft.graph.nodes.some((node) => node.name === 'n_static_fire__wait'))

  // Run once, as drafted: the dispatch still waits for a person.
  const started = await api('/api/rig/v1/missions', {
    mode: 'orchestration',
    goal: draft.spec.displayName,
    spec: draft.spec
  })
  assert.equal(started.status, 201, JSON.stringify(started.body))
  const id = started.body.mission.id
  let row
  for (let i = 0; i < 100; i += 1) {
    row = runtime.missions.get(id, 'service-admin')
    if (row.status !== 'queued' && row.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // No runner is registered, so the pre-flight scrubs it and the debrief
  // still writes the report.
  assert.equal(row.status, 'blocked', JSON.stringify(row.events.at(-1)))
  assert.equal(row.flight.verdict, 'scrubbed')
  assert.match(row.report.markdown, /SCRUB/)
  assert.equal((await api('/api/v1/runs')).body.runs.length, 0)

  const invalid = await api('/api/rig/v1/missions', {
    mode: 'orchestration',
    goal: 'x',
    spec: { key: 'bad', nodes: [{ id: 'a', type: 'shell' }] }
  })
  assert.equal(invalid.status, 400)
})
