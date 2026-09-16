import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { start } from '../apps/server/index.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const qa = resolve(root, '.runtime/qa')
await mkdir(qa, { recursive: true })
const state = await mkdtemp(join(qa, 'browser-'))
const target = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    '<title>Rig Browser Acceptance</title><label>项目名称<input aria-label="项目名称"></label><label>密码<input type="password" aria-label="密码"></label><button onclick="document.querySelector(\'h1\').textContent=\'操作完成\'">保存</button><h1>准备就绪</h1>'
  )
})
await new Promise((r) => target.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${target.address().port}`
const tools = new BrowserTools(join(state, 'artifacts'))
const context = {
  policy: { browserOrigins: [origin] },
  signal: new AbortController().signal,
  missionId: '00000000-0000-0000-0000-000000000001'
}
let server, browser
try {
  const opened = await tools.execute('browser_open', { url: origin }, context)
  assert.equal(opened.title, 'Rig Browser Acceptance')
  assert.match(opened.text, /准备就绪/)
  await tools.execute('browser_fill', { label: '项目名称', value: 'MX Rig' }, context)
  await assert.rejects(
    tools.execute('browser_fill', { label: '密码', value: 'never-fill' }, context),
    { code: 'sensitive_field' }
  )
  const result = await tools.execute('browser_click', { role: 'button', name: '保存' }, context)
  assert.match(result.text, /操作完成/)
  assert.ok((await stat(join(state, 'artifacts', result.screenshot))).size > 0)
  await assert.rejects(tools.execute('browser_open', { url: 'http://localhost:1' }, context), {
    code: 'origin_denied'
  })
  await tools.close()
  // A scripted upstream that answers over SSE, slowly enough that the
  // workbench really has to render a partial draft, and finishes the first
  // turn by submitting a structured conclusion.
  const FINDING = {
    verdict: 'environment-blocked',
    confidence: 'high',
    summary: '这次不是产品缺陷：窗口内执行机全部离线。',
    evidence: '引用 trun_smoke_未读 作为对照；本次任务并没有真的读过它。',
    nextStep: '让管理员上线一台执行机后复跑。'
  }
  const encoder = new TextEncoder()
  const frame = (payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
  let turns = 0
  server = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'web-test-secret',
      MX_RIG_PORT: '0',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'test-artifacts')
    },
    {
      schedule: false,
      modelOptions: {
        environment: { MX_RIG_MODEL_API_KEY: 'fixture-key' },
        fetchImpl: async () => {
          const first = ++turns === 1
          const pieces = first
            ? ['正在读这次执行的证据', '：执行机在窗口内全部离线', '，所以先排除产品缺陷。']
            : ['已提交结论：环境受阻，不是产品缺陷。']
          return new Response(
            new ReadableStream({
              async start(controller) {
                for (const piece of pieces) {
                  controller.enqueue(frame({ choices: [{ delta: { content: piece } }] }))
                  await new Promise((r) => setTimeout(r, 450))
                }
                if (first)
                  controller.enqueue(
                    frame({
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: 'call_finding',
                                function: {
                                  name: 'finding_submit',
                                  arguments: JSON.stringify(FINDING)
                                }
                              }
                            ]
                          }
                        }
                      ]
                    })
                  )
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                controller.close()
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
      }
    }
  )
  browser = await chromium.launch({ headless: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(server.origin + '/rig/')
  await page.locator('#account').fill('admin')
  await page.locator('#password').fill('web-test-secret')
  await page.locator('#login-form button').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '任务工作台', exact: false }).click()
  await page.locator('#goal').fill('检查未配置模型的明确失败状态')
  await page.locator('#start').click()
  await page.waitForFunction(
    () => document.querySelector('#mission-status')?.textContent === '受阻'
  )
  await page.getByRole('button', { name: 'Internal 配置', exact: false }).click()
  await page.locator('#max-turns').fill('8')
  await page.locator('#save-settings').click()
  await page.getByText('已保存').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '工具与边界', exact: false }).click()
  await page.locator('.rig-table[data-layout="tools"]').first().waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-tools.png') })
  await page.getByRole('button', { name: 'Agent 市场', exact: false }).click()
  await page.getByText('结果分析师', { exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-agents.png') })
  // The quality report, and the lens switcher that reorders it. The switcher
  // sits inside a wrapper on purpose; a regression there collapses it to a
  // 2px sliver that still passes a visibility check but cannot be clicked.
  await page.locator('.rig-nav__item', { hasText: '质量报告' }).click()
  await page.locator('.rig-trend, .rig-empty').first().waitFor({ state: 'visible' })
  const lens = page.locator('.rig-nav__lens .qp-segmented')
  assert.ok(
    (await lens.evaluate((el) => el.getBoundingClientRect().height)) > 24,
    'the lens switcher must not collapse'
  )
  const metrics = await page.locator('.qp-metric__value').allTextContents()
  assert.equal(metrics.length, 4)
  // Nothing ran in this fixture, so every rate must read "—", never 0% or 100%.
  assert.equal(metrics[0], '—')
  await page.getByRole('button', { name: '负责人', exact: true }).click()
  await page.waitForTimeout(400)
  const ordered = await page.locator('.rig-view > .qp-panel > h2').allTextContents()
  assert.equal(ordered[0], '每日通过率', `lead lens leads with the trend, saw ${ordered[0]}`)
  await page.getByRole('button', { name: '测试', exact: true }).click()
  await page.waitForTimeout(400)
  assert.equal(
    (await page.locator('.rig-view > .qp-panel > h2').allTextContents())[0],
    '要先处理的'
  )
  await page.screenshot({ path: join(qa, 'web-report.png'), fullPage: true })

  await page.getByRole('button', { name: '编排中心', exact: false }).click()
  await page.locator('.rig-graph svg').waitFor({ state: 'visible' })
  // The generic task graph: seven nodes, one of them the approval pause.
  assert.equal(await page.locator('.rig-graph__node').count(), 7)
  await page.screenshot({ path: join(qa, 'web-orchestration.png') })
  await page.getByRole('button', { name: '出网与通道', exact: false }).click()
  await page.locator('.rig-table[data-layout="egress"]').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-egress.png') })

  // The orchestration centre: open a saved spec, break it, see the compiler
  // refuse it by name, repair it, and watch the draft preview come back.
  await page.getByRole('button', { name: '编排中心', exact: false }).click()
  await page.getByRole('button', { name: '有人接才派发', exact: true }).click()
  // Selecting a spec fetches its compiled shape; wait for one of its own
  // nodes rather than for "a graph", which the task graph already satisfies.
  await page
    .locator('.rig-graph__node', { hasText: 'n_read_runners' })
    .waitFor({ state: 'visible' })
  const authored = await page.locator('.rig-graph__node').count()
  assert.ok(authored >= 9, `expected the compiled spec, saw ${authored} nodes`)
  await page.getByRole('button', { name: '校验并预览', exact: true }).click()
  await page.getByText('草稿可以编译', { exact: false }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-orchestration-editor.png'), fullPage: true })
  await page.evaluate(() => {
    const field = [...document.querySelectorAll('input.qp-input')].find(
      (input) => input.value === 'onlineRunners'
    )
    field.value = 'ghostVariable'
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.getByRole('button', { name: '校验并预览', exact: true }).click()
  await page
    .getByText('判断了未定义的变量 ghostVariable', { exact: false })
    .first()
    .waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-orchestration-invalid.png') })

  // -- the system layer -------------------------------------------------------
  // Two pages have been visited by now (工具与边界, 出网与通道), so their
  // signal-evidence quests must be claimable and the platform-state ones must
  // not: this asserts the difference is real, not decorative.
  await page.locator('.rig-nav__item', { hasText: '系统' }).click()
  await page.locator('.rig-level').waitFor({ state: 'visible' })
  assert.match(await page.locator('.rig-level h2').textContent(), /Lv\.1/)
  const chapters = await page.locator('.rig-quests').count()
  assert.equal(chapters, 6, `expected six chapters, saw ${chapters}`)
  const openApp = page.locator('.rig-quest', { hasText: '接入一个被测应用' }).first()
  assert.equal(await openApp.getAttribute('data-status'), 'open')
  const claimable = page.locator('.rig-quest[data-status="claimable"]')
  assert.ok((await claimable.count()) >= 2, '两个已访问页面的任务应当可领取')
  const boundary = page.locator('.rig-quest', { hasText: '看清工具与边界这一页' }).first()
  const reward = await boundary.getByRole('button', { name: '领取', exact: false }).textContent()
  await boundary.getByRole('button', { name: '领取', exact: false }).click()
  // The reward is only XP: the quest turns claimed and the level line moves.
  await page.getByText(`经验 ${reward.replace(/\D/g, '')}`, { exact: false }).waitFor()
  await page
    .locator('.rig-quest[data-status="claimed"]', { hasText: '看清工具与边界这一页' })
    .waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-system.png'), fullPage: true })

  // The teaching panel follows the reader across pages and can be put away.
  await page.locator('#hud-toggle').click()
  await page.locator('#hud .rig-quest').waitFor({ state: 'visible' })
  await page.locator('.rig-nav__item', { hasText: '总览' }).click()
  await page.locator('#hud .rig-quest').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-system-hud.png') })
  await page.locator('#hud').getByRole('button', { name: '收起', exact: true }).click()
  assert.ok(await page.locator('#hud').isHidden(), 'the panel must close when asked')

  // -- 对话式下任务 -----------------------------------------------------------
  // A real plan exists for this one, so the parse has something to match.
  const api = async (path, body) => {
    const response = await fetch(server.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer web-test-secret',
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
  const plan = await api('/api/v1/tasks', {
    app: 'compass',
    suite: 'smoke',
    name: 'Compass Web 冒烟',
    profile: 'mock',
    track: 'functional'
  })
  assert.equal(plan.status, 201, JSON.stringify(plan.body))
  // A new task, not the blocked one from earlier: parsing belongs to a fresh
  // composer, and a follow-up on a finished mission has no target to choose.
  await page.locator('#new-mission').click()
  await page.locator('#refresh').click()
  await page.locator('#goal').waitFor({ state: 'visible' })
  await page.locator('#goal').fill('跑一下 Compass Web 冒烟')
  await page.getByRole('button', { name: '解析成任务', exact: false }).click()
  await page.locator('.rig-proposal').first().waitFor({ state: 'visible' })
  const proposal = await page.locator('.rig-proposal pre').first().textContent()
  assert.match(proposal, new RegExp(plan.body.task.id), '候选里应当是真实的计划 ID')
  assert.match(
    await page.locator('.rig-proposal ul').first().textContent(),
    /计划名匹配/,
    'the parse has to say what it matched on'
  )
  // Parsing alone must not have started anything.
  assert.equal((await api('/api/v1/runs')).body.runs.length, 0)
  await page.screenshot({ path: join(qa, 'web-dispatch-plan.png'), fullPage: true })
  await page.getByRole('button', { name: '收起解析结果', exact: true }).click()

  // -- 流式输出与结构化结论 ---------------------------------------------------
  await server.settings.update({
    ...server.settings.value,
    providers: [
      {
        id: 'primary',
        displayName: '替身模型',
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture-streamer',
        apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
        timeoutMs: 60_000,
        enabled: true,
        stream: true
      }
    ],
    sequence: ['primary']
  })
  await page.locator('#new-mission').click()
  await page.locator('#goal').waitFor({ state: 'visible' })
  await page.locator('#goal').fill('这次执行为什么没通过？读证据后给结论。')
  await page.locator('#start').click()
  // The draft has to be on screen while the answer is still being written.
  await page.locator('.rig-stream').waitFor({ state: 'visible', timeout: 15_000 })
  const partial = await page.locator('.rig-stream').textContent()
  assert.ok(partial.length > 0, '流式草稿应当有内容')
  await page.screenshot({ path: join(qa, 'web-streaming.png'), fullPage: true })
  await page.waitForFunction(
    () => document.querySelector('#mission-status')?.textContent === '任务完成',
    null,
    { timeout: 30_000 }
  )
  // And it must be gone once the real answer exists.
  assert.equal(await page.locator('.rig-stream').count(), 0, '结束后不该留着半句草稿')
  const finding = page.locator('.rig-finding')
  await finding.waitFor({ state: 'visible' })
  assert.match(await finding.textContent(), /环境受阻/)
  assert.match(await finding.textContent(), /不是测试结论/)
  // The citation was never read in this mission, and the card says so.
  assert.match(await page.locator('.rig-ref').first().textContent(), /未读到/)
  await page.screenshot({ path: join(qa, 'web-finding.png'), fullPage: true })

  // -- 出网通道 ---------------------------------------------------------------
  await page.locator('.rig-nav__item', { hasText: '出网与通道' }).click()
  await page.getByRole('button', { name: '保存通道', exact: true }).waitFor({ state: 'visible' })
  await page.getByLabel('通道 ID').fill('office')
  await page.getByLabel('名称').fill('办公网代理')
  await page.getByLabel('通道地址').fill('http://127.0.0.1:7890')
  await page.getByLabel('直连列表（逗号分隔）').fill('.internal.example.com')
  await page.getByRole('button', { name: '保存通道', exact: true }).click()
  await page.getByRole('button', { name: '切到这条', exact: true }).click()
  await page.getByText('已切换出网通道', { exact: false }).waitFor({ state: 'visible' })
  const routes = await page.locator('.qp-metric').allTextContents()
  assert.match(routes[0], /模型调用Rig 通道|模型调用\s*Rig 通道/, `saw ${routes[0]}`)
  // The environment observation must not have been rewritten by the switch.
  assert.match(await page.locator('.rig-view .qp-panel h2').first().textContent(), /环境观测/)
  await page.screenshot({ path: join(qa, 'web-egress-channel.png'), fullPage: true })
  await page.getByRole('button', { name: '改为直连', exact: true }).click()
  await page.getByText('已改为直连', { exact: false }).waitFor({ state: 'visible' })

  assert.deepEqual(errors, [])
  console.log(
    'Browser tools and Web smoke passed: origin policy, real page fill/click, password refusal, screenshots, HttpOnly login, unconfigured model blocked, Internal settings, Agent market, quality report (empty rates read "—", lens reorders sections), orchestration centre (compiled spec, draft preview, refused draft), egress observation, the system layer (signal vs platform evidence, claim, floating panel), one-line dispatch parsing (real plan id, no execution), switching Rig\'s own egress channel, streamed model output (a visible draft that the final answer replaces), and a structured finding whose unread citation is marked.'
  )
} finally {
  await tools.close()
  await browser?.close()
  await server?.close()
  await new Promise((r) => target.close(r))
}
