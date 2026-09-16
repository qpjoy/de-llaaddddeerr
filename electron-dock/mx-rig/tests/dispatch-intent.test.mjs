import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { overlap, pieces, planDispatch } from '../apps/server/dispatch-intent.mjs'

const APPS = [
  { id: 'app_1', slug: 'compass', displayName: 'Compass' },
  { id: 'app_2', slug: 'luopan', displayName: 'Luopan' }
]
const TASKS = [
  {
    id: 'tsk_login',
    appId: 'app_1',
    name: 'Compass Electron 登录验收',
    profile: 'prod',
    track: 'demo'
  },
  { id: 'tsk_web', appId: 'app_1', name: 'Compass Web 冒烟', profile: 'mock', track: 'functional' },
  {
    id: 'tsk_luopan',
    appId: 'app_2',
    name: 'Luopan 网络回归',
    profile: 'mock',
    track: 'functional'
  }
]
const ORCHESTRATIONS = [
  {
    key: 'guarded-dispatch',
    displayName: '有人接才派发',
    summary: '先确认有在线执行机，再派发测试计划。',
    inputs: [{ name: 'taskId', label: '测试计划', kind: 'task', required: true }],
    missingTools: []
  },
  {
    key: 'runner-patrol',
    displayName: '每日执行机巡检',
    summary: '只读执行机状态并汇总。',
    inputs: [],
    missingTools: []
  }
]
const AGENTS = [
  {
    key: 'result-analyst',
    displayName: '结果分析师',
    summary: '把一次执行拆到用例与步骤级。',
    surface: 'any',
    effectiveTools: ['tests_result']
  },
  {
    key: 'failure-triage',
    displayName: '失败定级员',
    summary: '给出产品缺陷 / 环境受阻 / 用例问题 / flaky 四选一。',
    surface: 'any',
    effectiveTools: ['tests_result']
  },
  {
    key: 'page-inspector',
    displayName: '页面巡检员',
    summary: '在允许的 origin 上打开页面取证。',
    surface: 'desktop',
    effectiveTools: []
  }
]

const plan = (text, extra = {}) =>
  planDispatch({
    text,
    apps: APPS,
    tasks: TASKS,
    orchestrations: ORCHESTRATIONS,
    agents: AGENTS,
    runnersOnline: 1,
    modelConfigured: true,
    ...extra
  })

test('a Chinese name matches without a segmenter, a single shared character does not', () => {
  const said = pieces('跑一下 Compass Electron 的登录验收')
  assert.ok(said.has('compass'))
  assert.ok(said.has('electron'))
  assert.ok(said.has('登录'))
  assert.ok(said.has('验收'))
  // Two-character shingles only: one incidental character is not a match.
  assert.equal(pieces('测').size, 1)
  assert.equal(overlap('登录验收', pieces('这里没有相同的词')).ratio, 0)
  assert.equal(overlap('Compass Web 冒烟', pieces('compass web 冒烟')).ratio, 1)
})

test('one sentence naming a plan becomes a confident workflow proposal', () => {
  const result = plan('跑一下 Compass Electron 的登录验收')
  const workflow = result.proposals.find((entry) => entry.kind === 'workflow')
  assert.ok(workflow)
  assert.equal(workflow.body.mode, 'workflow')
  assert.equal(workflow.body.taskId, 'tsk_login')
  assert.equal(workflow.confidence, 'high')
  assert.deepEqual(workflow.missing, [])
  // The reasons are checkable, not a score: they name what matched.
  assert.ok(workflow.because.some((line) => line.includes('派发动作')))
  assert.ok(workflow.because.some((line) => line.includes('计划名匹配')))
  assert.ok(workflow.note.includes('派发成功不代表测试通过'))
})

test('a plan id in the sentence wins over any name similarity', () => {
  const result = plan('派发 tsk_web，别跑登录验收')
  const workflow = result.proposals.find((entry) => entry.kind === 'workflow')
  assert.equal(workflow.body.taskId, 'tsk_web')
  assert.equal(workflow.confidence, 'high')
  assert.ok(workflow.because.some((line) => line.includes('tsk_web')))
})

test('a verb with no target asks which plan instead of guessing one', () => {
  const result = plan('帮我跑一下测试')
  const workflow = result.proposals.find((entry) => entry.kind === 'workflow')
  assert.deepEqual(workflow.missing, ['taskId'])
  assert.equal(workflow.body.taskId, undefined)
  assert.equal(workflow.confidence, 'low')
  assert.equal(workflow.candidates.length, TASKS.length)
})

test('no online runner is a warning on the proposal, not a refusal', () => {
  const result = plan('跑一下 Compass Web 冒烟', { runnersOnline: 0 })
  const workflow = result.proposals.find((entry) => entry.kind === 'workflow')
  assert.equal(workflow.blocked, null)
  assert.ok(workflow.warnings.some((line) => line.includes('等待执行机')))
  // With nothing registered at all, dispatch really is blocked.
  const bare = planDispatch({ text: '跑一下测试', tasks: [], apps: [], runnersOnline: 0 })
  assert.match(bare.proposals[0].blocked, /还没有测试计划/)
})

test('an analysis verb reaches the right Agent, and says so when no model can run it', () => {
  const result = plan('分析一下 trun_20260916_01 为什么失败')
  const agent = result.proposals.find((entry) => entry.kind === 'agent')
  assert.ok(agent)
  assert.equal(agent.body.mode, 'agent')
  assert.ok(['result-analyst', 'failure-triage'].includes(agent.body.agentKey))
  assert.ok(agent.because.some((line) => line.includes('trun_20260916_01')))
  assert.equal(agent.blocked, null)
  const unconfigured = plan('分析一下 trun_1 为什么失败', { modelConfigured: false })
  assert.match(
    unconfigured.proposals.find((entry) => entry.kind === 'agent').blocked,
    /没有可用的模型/
  )
  // A desktop-only Agent is not offered to the web workbench.
  const named = plan('让页面巡检员去看看', { native: false })
  assert.ok(!named.proposals.some((entry) => entry.body.agentKey === 'page-inspector'))
  const desktop = plan('让页面巡检员去看看', { native: true })
  assert.ok(desktop.proposals.some((entry) => entry.body.agentKey === 'page-inspector'))
})

test('an orchestration is proposed with the inputs the sentence actually supplied', () => {
  const result = plan('用有人接才派发的编排跑 Compass Web 冒烟')
  const flow = result.proposals.find((entry) => entry.kind === 'orchestration')
  assert.ok(flow)
  assert.equal(flow.body.orchestrationKey, 'guarded-dispatch')
  assert.equal(flow.body.inputs.taskId, 'tsk_web')
  assert.deepEqual(flow.missing, [])
  // Without a plan in the sentence, the required input stays missing.
  const bare = plan('跑一下有人接才派发这条编排')
  const unfilled = bare.proposals.find((entry) => entry.kind === 'orchestration')
  assert.deepEqual(unfilled.missing, ['taskId'])
  assert.equal(unfilled.candidates[0].label.includes('测试计划'), true)
})

test('an unmatched sentence proposes nothing and says what to type instead', () => {
  const result = plan('今天天气不错')
  assert.deepEqual(result.proposals, [])
  assert.ok(result.note.includes('跑 <计划名>'))
})

test('blocked candidates sort behind ones that can actually run', () => {
  const result = plan('分析 trun_1，然后跑一下 Compass Web 冒烟', { modelConfigured: false })
  assert.ok(result.proposals.length >= 2)
  assert.equal(result.proposals[0].blocked, null)
  assert.equal(result.proposals.at(-1).kind, 'agent')
})

test('the planning route reads real catalogues, needs operator, and starts nothing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-dispatch-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: root,
      MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body) => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer test-only-rig-secret',
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
    name: 'Compass Web 冒烟',
    profile: 'mock',
    track: 'functional'
  })
  assert.equal(task.status, 201, JSON.stringify(task.body))
  const planned = await api('/api/rig/v1/dispatch:plan', { text: '跑一下 Compass Web 冒烟' })
  assert.equal(planned.status, 200)
  const workflow = planned.body.plan.proposals.find((entry) => entry.kind === 'workflow')
  assert.equal(workflow.body.taskId, task.body.task.id)
  // Parsing must not have created anything.
  assert.equal((await api('/api/v1/runs')).body.runs.length, 0)
  assert.equal((await api('/api/rig/v1/missions')).body.missions.length, 0)
  // The proposal is exactly a mission request body, and it works as one.
  const started = await api('/api/rig/v1/missions', workflow.body)
  assert.equal(started.status, 201, JSON.stringify(started.body))
  assert.equal((await api('/api/rig/v1/dispatch:plan', { text: '' })).status, 400)
  assert.equal(
    (await api('/api/rig/v1/dispatch:plan', { text: 'x', surface: 'phone' })).status,
    400
  )
})
