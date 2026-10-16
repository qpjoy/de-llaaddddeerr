import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { signalSchema } from '../packages/runtime/sensors.mjs'
import { renderSensorReport, runSensorBench } from '../evals/sensors.mjs'
import { DEFECT_IDS, readBugs, startProvingGround } from '../test-packs/proving-ground/server.mjs'

// 试验场: the same procedures against a build with every defect on and one
// with every defect off. Sensors must find what they are meant to find in the
// first and stay silent in the second; assertions keep deciding the verdicts.

async function chromiumLauncher(t) {
  const { chromium } = await import('playwright')
  const launcher = { launch: (options) => chromium.launch({ ...options, headless: true, channel: 'chromium' }) }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) {
    t.skip('Chromium 未安装；运行 npm run browser:install 后执行')
    return null
  }
  await probe.close()
  return launcher
}

test('defects are switched by id, and an unknown id is refused', () => {
  assert.equal(readBugs('all').size, DEFECT_IDS.length)
  assert.equal(readBugs('none').size, 0)
  assert.deepEqual([...readBugs('pg-001, PG-003')], ['PG-001', 'PG-003'])
  assert.throws(() => readBugs('PG-999'), /未知的缺陷编号/)
})

test('the proving ground serves its pages, guards its API and closes cleanly', async () => {
  const ground = await startProvingGround({ bugs: 'none' })
  try {
    const page = await fetch(`${ground.origin}/items`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /"bugs":\[\]/)
    assert.equal((await fetch(`${ground.origin}/api/items`)).status, 401)
    const login = await fetch(`${ground.origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tester' })
    })
    const { token } = await login.json()
    const items = await fetch(`${ground.origin}/api/items?status=archived&q=螺栓`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(items.status, 200)
    assert.equal((await items.json()).total, 1)
  } finally {
    await ground.close()
  }
})

test('sensors find every defect they are meant to, say nothing on the fixed build, and leave verdicts to assertions', async (t) => {
  const launcher = await chromiumLauncher(t)
  if (!launcher) return
  const report = await runSensorBench({ launcher, sensors: { stuckMs: 2000 } })
  const s = report.summary
  assert.equal(s.sensorDetected, s.sensorDefects, renderSensorReport(report))
  assert.equal(s.sensorDefects, 10)
  assert.equal(s.assertionDetected, 2, renderSensorReport(report))
  assert.equal(s.falsePositives, 0, renderSensorReport(report))
  assert.equal(s.fixedFailures, 0, renderSensorReport(report))
  assert.equal(s.unexplained, 0, renderSensorReport(report))

  // The leads sit beside the verdicts and never change them: a procedure
  // whose assertions hold stays passed with a 500 under it.
  const broken = new Map(report.builds.broken.map((run) => [run.key, run]))
  assert.equal(broken.get('list-filter').verdict, 'passed')
  assert.ok(broken.get('list-filter').signals.some((signal) => signal.sensor === 'http_error'))
  assert.deepEqual(
    report.builds.broken.filter((run) => run.verdict === 'failed').map((run) => run.key).sort(),
    ['create-once', 'list-empty', 'session-expired']
  )
  assert.ok(s.greenButFlagged.includes('reports'))
  for (const run of report.builds.broken) {
    for (const signal of run.signals) {
      assert.equal(signalSchema.safeParse(signal).success, true, JSON.stringify(signal))
      // No credential leaves the page: the token is named, never shown.
      assert.doesNotMatch(JSON.stringify(signal), /eyJ[A-Za-z0-9_-]{8,}\./)
    }
    assert.ok(run.metrics?.pages.length, `${run.key} has page timings`)
  }
})

test('an Agent’s browser step carries what the sensors read, beside its result', async (t) => {
  const launcher = await chromiumLauncher(t)
  if (!launcher) return
  const ground = await startProvingGround({ bugs: 'PG-008,PG-010,PG-012' })
  t.after(() => ground.close())
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-sensed-step-'))
  const tools = new BrowserTools(root, launcher, { headless: true })
  t.after(() => tools.close())
  const policy = { browserOrigins: [ground.origin], productionHosts: [] }
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZXIifQ.c2lnbmF0dXJlLXZhbHVl'
  const opened = await tools.execute('browser_open', { url: `${ground.origin}/items?token=${token}` }, { policy, missionId: 'm1' })
  assert.ok(opened.snapshot, 'the observation is still there')
  const secret = opened.signals?.find((signal) => signal.sensor === 'secret_in_url')
  assert.ok(secret, JSON.stringify(opened.signals))
  assert.equal(secret.url, `${ground.origin}/items`)
  assert.doesNotMatch(JSON.stringify(opened.signals), /eyJhbGci/)

  // A button that does nothing, clicked the way an Agent clicks: aimed,
  // with a masked intent screenshot first. The station's own nodes (the
  // pilot, Playwright's screenshot glass) are not the page reacting.
  await tools.execute('browser_open', { url: `${ground.origin}/login` }, { policy, missionId: 'm1' })
  await tools.execute('browser_fill', { label: '用户名', value: 'tester' }, { policy, missionId: 'm1' })
  await tools.execute('browser_click', { role: 'button', name: '登录' }, { policy, missionId: 'm1' })
  await tools.execute('browser_wait', { text: '防水密封圈' }, { policy, missionId: 'm1' })
  await tools.execute('browser_click', { role: 'link', name: '防水密封圈' }, { policy, missionId: 'm1' })
  await tools.execute('browser_wait', { text: '负责人' }, { policy, missionId: 'm1' })
  const clicked = await tools.execute('browser_click', { role: 'button', name: '收藏' }, { policy, missionId: 'm1' })
  assert.deepEqual(clicked.signals?.map((signal) => signal.sensor), ['dead_click'])
  assert.ok(clicked.frame?.intent, 'the intent frame was taken before the click')

  // No sensors: nothing extra on the result.
  const quiet = new BrowserTools(root, launcher, { headless: true, sensors: false })
  t.after(() => quiet.close())
  const plain = await quiet.execute('browser_open', { url: `${ground.origin}/items?token=${token}` }, { policy, missionId: 'm2' })
  assert.equal(plain.signals, undefined)
})
