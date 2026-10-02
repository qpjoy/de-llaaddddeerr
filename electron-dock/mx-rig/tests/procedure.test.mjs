import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import {
  ProcedurePlayer,
  diffSteps,
  kernelSummary,
  procedureFromMission,
  readProcedure
} from '../packages/runtime/procedure.mjs'
import { normalizeSummary } from '../packages/test-platform/server/ingest/summary.mjs'

/** A settings page whose save button can be renamed, as a release would. */
const page = (
  button
) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>个人设置</title></head>
<body><main><h1>个人设置</h1>
<form onsubmit="event.preventDefault();setTimeout(function(){document.getElementById('status').textContent='已保存：'+document.getElementById('nick').value},150)">
<label for="nick">昵称</label><input id="nick" value="旧昵称">
<label for="pw">密码</label><input id="pw" type="password">
<label><input type="checkbox" id="news"> 订阅通知</label>
<button type="submit">${button}</button><button type="button">取消</button>
</form><p id="status" role="status"></p></main></body></html>`

async function station(t) {
  const { chromium } = await import('playwright')
  const launcher = {
    launch: (options) => chromium.launch({ ...options, headless: true, channel: 'chromium' })
  }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) {
    t.skip('Chromium 未安装；运行 npm run browser:install 后执行')
    return null
  }
  await probe.close()
  const state = { button: '保存' }
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(state.button))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-procedure-'))
  const open = () => {
    const tools = new BrowserTools(root, launcher, { headless: true })
    t.after(() => tools.close())
    return tools
  }
  return { origin, state, open, policy: { browserOrigins: [origin], productionHosts: [] } }
}

const saveProfile = (origin) =>
  readProcedure({
    title: '修改昵称并保存',
    app: 'profile',
    caseId: 'PRF-WEB-SET-001',
    baseUrl: origin,
    variables: { nickname: 'Rig' },
    steps: [
      { do: 'open', url: '/settings' },
      { do: 'fill', target: { label: '昵称' }, value: '{{nickname}}', note: '输入新昵称' },
      { do: 'check', target: { role: 'checkbox', name: '订阅通知' }, checked: true },
      { do: 'click', target: { role: 'button', name: '保存' } },
      { do: 'wait', text: '已保存' },
      { do: 'assert', kind: 'text_visible', expected: '已保存：Rig' },
      { do: 'assert', kind: 'value_equals', target: { label: '昵称' }, expected: 'Rig' }
    ]
  })

test('a procedure replays with no model, and a changed page fails where it changed', async (t) => {
  const s = await station(t)
  if (!s) return
  const procedure = { id: 'prc_1', revision: 1, ...saveProfile(s.origin) }

  const passed = await new ProcedurePlayer(s.open()).run(procedure, {
    policy: s.policy,
    runId: 'r1'
  })
  assert.equal(passed.verdict, 'passed', JSON.stringify(passed.failure))
  assert.deepEqual(
    passed.steps.map((step) => step.status),
    new Array(7).fill('passed')
  )
  assert.equal(passed.steps[6].assertion.target.label, '昵称')

  // A release renames the button: the replay stops at that step, says the
  // element is missing, and keeps what the page looked like there.
  s.state.button = '提交'
  const drifted = await new ProcedurePlayer(s.open()).run(procedure, {
    policy: s.policy,
    runId: 'r2'
  })
  assert.equal(drifted.verdict, 'failed')
  assert.equal(drifted.failedStep, 3)
  assert.equal(drifted.failure.code, 'target_missing')
  assert.equal(drifted.repairable, true)
  assert.match(drifted.failure.snapshot, /button "提交"/)
  assert.match(drifted.failure.screenshot, /^r2\//)
  assert.deepEqual(
    drifted.steps.slice(4).map((step) => step.status),
    ['skipped', 'skipped', 'skipped']
  )

  // The same page, a different expectation: an assertion, not a locator.
  s.state.button = '保存'
  const expectation = {
    ...procedure,
    steps: procedure.steps.map((step, index) =>
      index === 5 ? { ...step, expected: '已保存成功', timeoutMs: 300 } : step
    )
  }
  const wrong = await new ProcedurePlayer(s.open()).run(expectation, {
    policy: s.policy,
    runId: 'r3'
  })
  assert.equal(wrong.verdict, 'failed')
  assert.equal(wrong.failure.code, 'assertion_failed')
  assert.equal(wrong.steps[5].assertion.passed, false)

  // Stopping before a step leaves the page there — where a repair begins.
  const tools = s.open()
  const partial = await new ProcedurePlayer(tools).run(procedure, {
    policy: s.policy,
    runId: 'r4',
    stopBefore: 3
  })
  assert.equal(partial.verdict, 'partial')
  assert.equal(await tools.page.getByLabel('昵称', { exact: true }).inputValue(), 'Rig')
})

test('an environment that cannot be reached is blocked, never a product failure', async (t) => {
  const s = await station(t)
  if (!s) return
  const procedure = { id: 'prc_2', revision: 1, ...saveProfile(s.origin) }
  // An admin who allows the list only: a site off it is refused.
  const denied = await new ProcedurePlayer(s.open()).run(procedure, {
    policy: { browserOrigins: [], browserSites: 'list', productionHosts: [] },
    runId: 'b1'
  })
  assert.equal(denied.verdict, 'blocked')
  assert.equal(denied.failure.code, 'origin_denied')
  assert.equal(denied.repairable, false)
  // Out of the box a saved procedure brings its own site: nobody had to list it.
  const carried = await new ProcedurePlayer(s.open()).run(procedure, {
    policy: { browserOrigins: [], productionHosts: [] },
    runId: 'b0'
  })
  assert.equal(carried.verdict, 'passed', JSON.stringify(carried.failure))
  // Production stays closed even to a procedure that names it.
  const production = await new ProcedurePlayer(s.open()).run(procedure, {
    policy: { browserOrigins: [], productionHosts: ['127.0.0.1'] },
    runId: 'b3'
  })
  assert.equal(production.verdict, 'blocked')
  assert.equal(production.failure.code, 'origin_denied')

  const secret = {
    ...procedure,
    steps: [procedure.steps[0], { do: 'fill', target: { label: '密码' }, value: 'x' }]
  }
  const refused = await new ProcedurePlayer(s.open()).run(secret, { policy: s.policy, runId: 'b2' })
  assert.equal(refused.verdict, 'blocked')
  assert.equal(refused.failure.code, 'sensitive_field')

  const kernel = normalizeSummary(kernelSummary(procedure, denied), 0)
  assert.equal(kernel.status, 'blocked', 'the kernel reads it the same way')
})

test('a replay reads to the kernel as one case with the procedure’s steps', () => {
  const procedure = { id: 'prc_9', revision: 3, ...saveProfile('https://t.example') }
  const result = {
    verdict: 'failed',
    durationMs: 1200,
    startedAt: '2026-09-28T01:00:00.000Z',
    finishedAt: '2026-09-28T01:00:01.200Z',
    failure: { index: 3, code: 'target_missing', message: '页面上找不到 button「保存」' },
    steps: procedure.steps.map((step, index) => ({
      index,
      text: `step ${index}`,
      status: index < 3 ? 'passed' : index === 3 ? 'failed' : 'skipped',
      durationMs: 10,
      ...(index === 3 ? { error: { code: 'target_missing', message: '找不到' } } : {})
    }))
  }
  const normalized = normalizeSummary(kernelSummary(procedure, result), 1)
  assert.equal(normalized.status, 'failed')
  assert.equal(normalized.cases[0].caseId, 'PRF-WEB-SET-001')
  assert.equal(normalized.cases[0].steps.length, 7)
  assert.match(normalized.cases[0].errorText, /第 4 步/)
  assert.equal(normalized.cases[0].specPath, 'rig-procedure:prc_9@3')
})

test('an explored mission is captured as steps, keeping what really happened', () => {
  const at = '2026-09-28T00:00:00.000Z'
  const result = (action) => ({
    kind: 'tool_result',
    at,
    message: 'r',
    data: { result: { url: 'x' }, action }
  })
  const mission = {
    goal: '把昵称改成 Rig 并保存',
    events: [
      result({ tool: 'browser_open', url: 'https://t.example/settings' }),
      result({ tool: 'browser_fill', target: { label: '昵称' }, value: 'Rig' }),
      {
        kind: 'tool_result',
        at,
        message: 'r',
        data: { result: { error: 'x' }, action: { tool: 'browser_click' } }
      },
      result({ tool: 'browser_click', target: { role: 'button', name: '保存', nth: 0 } }),
      {
        kind: 'assertion',
        at,
        message: 'a',
        data: { assertion: { kind: 'text_visible', expected: '已保存', passed: true } }
      },
      {
        kind: 'assertion',
        at,
        message: 'a',
        data: { assertion: { kind: 'title_contains', expected: '设置页', passed: false } }
      }
    ]
  }
  const { procedure, warnings } = procedureFromMission(mission, { caseId: 'PRF-WEB-SET-002' })
  assert.equal(procedure.baseUrl, 'https://t.example')
  assert.deepEqual(
    procedure.steps.map((step) => step.do),
    ['open', 'fill', 'click', 'assert', 'assert']
  )
  assert.match(procedure.steps[4].note, /探索时未通过/)
  assert.ok(warnings.some((line) => /未通过/.test(line)))
  assert.throws(() => procedureFromMission({ events: [] }), { code: 'nothing_to_capture' })
})

test('a revision reads as the steps that changed, and bad procedures say why', async () => {
  const before = saveProfile('https://t.example').steps
  const after = before.map((step, index) =>
    index === 3 ? { ...step, target: { role: 'button', name: '提交' } } : step
  )
  const diff = diffSteps(before, after)
  assert.deepEqual([diff.added, diff.removed], [1, 1])
  assert.deepEqual(
    diff.entries.filter((entry) => entry.op !== 'keep').map((entry) => entry.op),
    ['remove', 'add']
  )
  // A loosened expectation or a deleted check is named, whatever the replay says.
  const { droppedAssertions } = await import('../apps/server/procedure-store.mjs')
  assert.equal(droppedAssertions(before, after).length, 0)
  assert.equal(droppedAssertions(before, before.slice(0, 5)).length, 2)
  const loosened = before.map((step) =>
    step.do === 'assert' && step.kind === 'text_visible' ? { ...step, expected: '已保存' } : step
  )
  assert.equal(droppedAssertions(before, loosened).length, 1)
  assert.throws(
    () =>
      readProcedure({
        title: 'x',
        steps: [{ do: 'click', target: { role: 'button', name: 'a' } }]
      }),
    /第一步必须是 open/
  )
  assert.throws(
    () =>
      readProcedure({
        title: 'x',
        baseUrl: 'https://t.example',
        steps: [
          { do: 'open', url: '/' },
          { do: 'assert', kind: 'value_equals', expected: 'a' }
        ]
      }),
    /value_equals 需要 target/
  )
})
