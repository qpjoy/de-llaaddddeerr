// Fill an empty install with a realistic example.
//
// A fresh platform with nothing in it gives a newcomer nowhere to start, and
// "read the docs first" is the failure this is meant to avoid. After seeding
// there is an app, a suite, real cases and a finished run with a report — enough
// to click through the whole flow before touching anything real.

const base = (process.env.MXT_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/u, '')
const token = process.env.MXT_ADMIN_TOKEN || ''

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok && response.status !== 409) {
    throw new Error(`${method} ${path} → ${response.status} ${payload?.error?.message ?? text}`)
  }
  return { status: response.status, body: payload }
}

const log = (message) => console.log(`[seed] ${message}`)

const app = await call('POST', '/api/v1/apps', {
  slug: 'demo-shop',
  displayName: '示例商城（演示用）',
  surfaces: ['web', 'electron'],
})
if (app.status === 409) log('示例应用已存在，继续')
else log('已创建示例应用 demo-shop')

await call('POST', '/api/v1/apps/demo-shop/suites', {
  slug: 'web-smoke',
  displayName: '网页冒烟（服务端自动跑）',
  engine: 'cypress',
  surface: 'web',
  runnerKind: 'server',
  command: ['pnpm', 'e2e:run:mock'],
})
await call('POST', '/api/v1/apps/demo-shop/suites', {
  slug: 'desktop-smoke',
  displayName: '桌面冒烟（需要自己的电脑）',
  engine: 'playwright-electron',
  surface: 'electron',
  runnerKind: 'local',
  requirements: { os: ['windows', 'macos'] },
})
log('已创建两个套件：一个服务端自动跑，一个需要本地执行机')

await call('POST', '/api/v1/apps/demo-shop/catalog:sync', {
  schemaVersion: 2,
  application: 'demo-shop',
  catalogFile: 'testing/catalog/demo-shop.json',
  cases: [
    { id: 'DEMO-FE-AUTH-001', priority: 'P0', title: '未登录访问订单页应跳转到登录并保留目标地址', spec: 'cypress/e2e/auth.cy.ts' },
    { id: 'DEMO-FE-AUTH-002', priority: 'P0', title: '密码错误时提示明确且不泄露账号是否存在', spec: 'cypress/e2e/auth.cy.ts' },
    { id: 'DEMO-FE-CART-001', priority: 'P1', title: '加入购物车后角标数量正确累加', spec: 'cypress/e2e/cart.cy.ts' },
    // Deliberately has no `spec`: it shows up as 待实现 / 未执行, which is the
    // signal newcomers most need to understand.
    { id: 'DEMO-FE-CART-002', priority: 'P1', title: '库存不足时下单被拦截并给出可读原因' },
  ],
})
log('已登记 4 条用例（其中 1 条故意没有实现代码，用来演示「待实现」）')

const task = await call('POST', '/api/v1/tasks', {
  app: 'demo-shop',
  suite: 'web-smoke',
  name: '示例：网页冒烟',
  profile: 'mock',
  track: 'functional',
  targetUrl: 'https://demo-shop.example.internal',
  schedule: { kind: 'manual' },
})
log('已创建示例任务')

// A finished run, so the reports and recordings pages are not empty either.
if (task.body?.task?.id) {
  const triggered = await call('POST', `/api/v1/tasks/${task.body.task.id}:run`)
  const runId = triggered.body?.run?.id
  const runner = await call('POST', '/runner/v1/runners:register', {
    name: `seed-runner-${Date.now()}`,
    kind: 'server',
    os: 'linux',
    engines: ['cypress'],
    surfaces: ['web'],
  })
  const runnerToken = runner.body?.token

  const claimed = await fetch(`${base}/runner/v1/runs:claim`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runnerToken}`, 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => (response.status === 204 ? null : response.json()))

  if (claimed?.runToken) {
    await fetch(`${base}/runner/v1/runs/${runId}:complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${claimed.runToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        exitCode: 1,
        summary: {
          schemaVersion: 2,
          runId,
          app: 'demo-shop',
          status: 'failed',
          totals: { tests: 3, passed: 2, failed: 1 },
          cases: [
            {
              caseId: 'DEMO-FE-AUTH-001',
              status: 'passed',
              durationMs: 3120,
              spec: 'cypress/e2e/auth.cy.ts',
              title: '未登录访问订单页应跳转到登录并保留目标地址',
              steps: [
                { seq: 1, label: '打开订单页', status: 'passed', offsetMs: 200 },
                { seq: 2, label: '确认跳转到登录页', status: 'passed', offsetMs: 1800 },
                { seq: 3, label: '确认地址里带上了 redirect', status: 'passed', offsetMs: 2600 },
              ],
            },
            {
              caseId: 'DEMO-FE-AUTH-002',
              status: 'passed',
              durationMs: 1980,
              spec: 'cypress/e2e/auth.cy.ts',
              title: '密码错误时提示明确且不泄露账号是否存在',
              steps: [
                { seq: 1, label: '输入错误密码并提交', status: 'passed', offsetMs: 300 },
                { seq: 2, label: '确认提示文案不含「账号不存在」', status: 'passed', offsetMs: 1400 },
              ],
            },
            {
              caseId: 'DEMO-FE-CART-001',
              status: 'failed',
              durationMs: 5400,
              spec: 'cypress/e2e/cart.cy.ts',
              title: '加入购物车后角标数量正确累加',
              error: '期望角标显示 2，实际显示 1\n  at cart.cy.ts:42',
              steps: [
                { seq: 1, label: '打开商品详情', status: 'passed', offsetMs: 250 },
                { seq: 2, label: '连续加入购物车两次', status: 'passed', offsetMs: 2100 },
                { seq: 3, label: '确认角标显示 2', status: 'failed', offsetMs: 4300 },
              ],
            },
          ],
        },
      }),
    })
    log('已生成一次示例执行（2 通过 / 1 失败 / 1 未执行）')
  }
}

log('')
log('完成。打开界面即可看到：')
log('  · 概览      —— 引导步骤已经点亮')
log('  · 执行记录  —— 一次失败的执行，点进去能看到失败在第几步')
log('  · 应用与用例 —— 4 条用例，其中 1 条「待实现」')
log('')
log('这些都是演示数据，随时可以删掉。')
