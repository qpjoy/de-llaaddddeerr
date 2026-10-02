import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { BUILTIN_AGENTS } from '../apps/server/agent-presets.mjs'
import { blockingSteps } from '../apps/server/orchestration-schedule.mjs'
import { checkDraft, templatePlan } from '../apps/server/flight-director.mjs'
import { validateOrchestration } from '../packages/graph/orchestration.mjs'
import { RigClient } from '../packages/runtime/client.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'
import { BrowserTools } from '../packages/runtime/browser.mjs'

const ADMIN = 'procedure-stage-admin'
const P1 = 'prc_aaaaaaaaaaaaaaaaaa'
const P2 = 'prc_bbbbbbbbbbbbbbbbbb'

const plan = (procedureIds) => ({
  key: 'procedure-smoke',
  displayName: '规程冒烟',
  summary: '重放规程并放行',
  entry: 'tminus',
  nodes: [
    {
      id: 'tminus',
      type: 'preflight',
      title: '预检',
      checks: ['browser'],
      onNoGo: 'debrief',
      next: 'replay'
    },
    {
      id: 'replay',
      type: 'procedure',
      title: '规程试车',
      stage: 'static-fire',
      procedureIds,
      next: 'go'
    },
    {
      id: 'go',
      type: 'gate',
      title: '规程放行',
      criteria: [{ metric: 'procedures_passed', stage: 'replay' }],
      onFail: 'debrief',
      next: 'debrief'
    },
    { id: 'debrief', type: 'debrief', title: '讲评', next: null }
  ]
})

test('a procedure stage is a closed, literal step that gates can read', () => {
  const { expanded } = validateOrchestration(plan([P1, P2]))
  assert.equal(expanded.nodes.find((node) => node.id === 'replay').procedureIds.length, 2)
  assert.throws(() => validateOrchestration(plan([P1, P1])), /重复的规程/)
  assert.throws(() => validateOrchestration(plan(['{{id}}'])), /规程编号格式/)
  const wrongStage = plan([P1])
  wrongStage.nodes[2].criteria = [{ metric: 'procedures_passed', stage: 'tminus' }]
  assert.throws(() => validateOrchestration(wrongStage), /需要引用一个规程试车节点/)
  // Scheduled plans run on the service, which has no browser station.
  assert.ok(
    blockingSteps(plan([P1]), []).some((reason) =>
      /规程试车「规程试车」只在桌面端执行/.test(reason)
    )
  )
})

test('the director offers matching procedures on the desktop, and only real ones', () => {
  const procedures = [
    { id: P1, title: '个人设置保存', app: 'profile', caseId: 'PRF-WEB-SET-001', status: 'active' },
    { id: P2, title: '个人设置头像上传', app: 'profile', caseId: null, status: 'draft' }
  ]
  const desk = templatePlan({
    text: '跑一下个人设置的规程试车',
    tasks: [],
    apps: [],
    desktop: true,
    procedures
  })
  const stage = desk.spec.nodes.find((node) => node.type === 'procedure')
  assert.deepEqual(stage.procedureIds, [P1], 'active procedures only')
  assert.ok(
    desk.spec.nodes.some(
      (node) => node.type === 'gate' && node.criteria[0].metric === 'procedures_passed'
    )
  )
  assert.deepEqual(desk.warnings, [])
  const web = templatePlan({
    text: '跑一下个人设置的规程试车',
    tasks: [],
    apps: [],
    desktop: false,
    procedures
  })
  assert.ok(!web.spec.nodes.some((node) => node.type === 'procedure'))
  assert.match(web.warnings.join(''), /只能在桌面端/)

  const reply = (ids) => '```json\n' + JSON.stringify({ ...plan(ids), key: 'x' }) + '\n```'
  assert.equal(checkDraft(reply([P1]), { tasks: [], desktop: true, procedures }).nodes.length, 4)
  assert.throws(
    () => checkDraft(reply([P2]), { tasks: [], desktop: true, procedures }),
    /不存在或未启用/
  )
  assert.throws(
    () => checkDraft(reply([P1]), { tasks: [], desktop: false, procedures }),
    /不是桌面端/
  )
})

test('a flight plan replays its procedures and the gate reads the result', async (t) => {
  const { chromium } = await import('playwright')
  const launcher = {
    launch: (options) => chromium.launch({ ...options, headless: true, channel: 'chromium' })
  }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return t.skip('Chromium 未安装')
  await probe.close()

  const web = createServer((req, res) => {
    const button = req.url.startsWith('/renamed') ? '提交' : '保存'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设置</title></head><body>
<form onsubmit="event.preventDefault();document.getElementById('s').textContent='已保存'"><label for="n">昵称</label><input id="n"><button type="submit">${button}</button></form><p id="s"></p></body></html>`)
  })
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => web.close(resolve)))
  const origin = `http://127.0.0.1:${web.address().port}`

  const state = await mkdtemp(join(tmpdir(), 'mx-rig-procedure-stage-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => server.close())
  const api = new RigClient({ url: server.origin, token: ADMIN })
  await api.request('/api/v1/apps', { slug: 'profile', displayName: '个人中心', surfaces: ['web'] })
  const make = async (title, path, caseId) =>
    (
      await api.request('/api/rig/v1/procedures', {
        procedure: {
          title,
          app: 'profile',
          caseId,
          baseUrl: origin,
          steps: [
            { do: 'open', url: path },
            { do: 'fill', target: { label: '昵称' }, value: 'Rig' },
            { do: 'click', target: { role: 'button', name: '保存' } },
            { do: 'assert', kind: 'text_visible', expected: '已保存' }
          ]
        }
      })
    ).procedure.id
  const good = await make('设置保存', '/settings', 'PRF-WEB-SET-001')
  const drifted = await make('改版后的设置保存', '/renamed', 'PRF-WEB-SET-002')

  const policy = {
    revision: 'stage',
    maxTurns: 8,
    allowedTools: ['browser_open', 'browser_snapshot'],
    browserOrigins: [origin],
    productionHosts: []
  }
  const client = {
    url: api.url,
    token: api.token,
    async request(path, body, signal) {
      if (path === '/api/rig/v1/execution-config')
        return {
          policy: structuredClone(policy),
          model: { configured: false },
          agents: BUILTIN_AGENTS
        }
      return api.request(path, body, signal)
    }
  }
  const runtime = new RigRuntime({
    store: await new MissionStore(join(state, 'missions')).init(),
    client,
    executor: new ToolExecutor(
      client,
      new BrowserTools(join(state, 'station'), launcher, { headless: true })
    ),
    owner: 'service-admin'
  })
  t.after(() => runtime.close())

  const mission = await runtime.start({
    mode: 'orchestration',
    goal: '规程冒烟',
    spec: plan([good, drifted])
  })
  await runtime.job
  const row = runtime.store.get(mission.id, 'service-admin')
  const stage = row.flight.stages.replay
  assert.deepEqual(stage.counts, { passed: 1, failed: 1, blocked: 0, total: 2 })
  assert.equal(stage.results[1].failedStep, 2)
  assert.equal(stage.results[1].repairable, true)
  assert.equal(row.flight.verdict, 'no-go', 'the gate read the stage')
  assert.match(row.report.markdown, /## 未通过的规程/)
  assert.match(row.report.markdown, /「改版后的设置保存」（第 1 版）第 3 步/)
  assert.equal(row.events.filter((event) => event.kind === 'procedure').length, 2)

  // Each replay is recorded on its procedure and as a run of the app.
  const runs = (await api.request('/api/v1/runs')).runs.filter(
    (run) => run.trigger === 'rig-procedure'
  )
  assert.deepEqual(runs.map((run) => run.status).sort(), ['failed', 'passed'])
  assert.equal(
    (await api.request(`/api/rig/v1/procedures/${good}`)).procedure.runs[0].verdict,
    'passed'
  )

  // The same plan on the service has no station: blocked, not failed.
  const internal = new RigRuntime({
    store: await new MissionStore(join(state, 'server-missions')).init(),
    client,
    executor: new ToolExecutor(client),
    owner: 'service-admin'
  })
  t.after(() => internal.close())
  const spec = plan([good])
  spec.nodes[0].checks = ['model']
  spec.nodes[0].onNoGo = 'replay'
  const onServer = await internal.start({ mode: 'orchestration', goal: '规程冒烟', spec })
  await internal.job
  const blocked = internal.store.get(onServer.id, 'service-admin').flight.stages.replay
  assert.deepEqual(blocked.counts, { passed: 0, failed: 0, blocked: 1, total: 1 })
  assert.match(blocked.results[0].message, /只在桌面端执行/)
})
