import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildInsights,
  caseHealth,
  coverage,
  fleet,
  risks,
  runsInWindow,
  trend
} from '../apps/server/insights.mjs'

const at = (daysAgo, hour = 12) =>
  new Date(Date.UTC(2026, 8, 16, hour) - daysAgo * 86_400_000).toISOString()
const run = (status, daysAgo, extra = {}) => ({
  id: `trun_${status}_${daysAgo}_${Math.random().toString(36).slice(2, 6)}`,
  status,
  queuedAt: at(daysAgo),
  finishedAt: at(daysAgo),
  durationMs: 60_000,
  ...extra
})
const NOW = new Date(Date.UTC(2026, 8, 16, 12))

test('a rate over zero samples is null, never a flattering 100%', () => {
  const empty = buildInsights({ now: NOW })
  assert.equal(empty.verdicts.passRate, null)
  assert.equal(empty.verdicts.judged, 0)
  assert.equal(empty.coverage.automationRate, null)
  assert.equal(empty.duration.p50, null)
  // And it says why, rather than showing a confident empty dashboard.
  assert.ok(empty.caveats.length >= 3)
})

test('blocked runs count as neither a pass nor a failure', () => {
  const insights = buildInsights({
    runs: [run('passed', 1), run('failed', 1), run('blocked', 1), run('blocked', 2)],
    now: NOW
  })
  assert.equal(insights.verdicts.decided, 4)
  // Only passed/failed/flaky reach the product, so the denominator is 2.
  assert.equal(insights.verdicts.judged, 2)
  assert.equal(insights.verdicts.passRate, 0.5)
  assert.equal(insights.verdicts.blocked, 2)
  assert.equal(insights.verdicts.blockedRate, 0.5)
  // A week of broken runners must not read as a week of falling quality.
  const allBlocked = buildInsights({ runs: [run('blocked', 1), run('blocked', 2)], now: NOW })
  assert.equal(allBlocked.verdicts.passRate, null)
})

test('only runs inside the window are counted', () => {
  const runs = [run('passed', 1), run('failed', 13), run('passed', 30)]
  const from = new Date(NOW.getTime() - 14 * 86_400_000)
  assert.equal(runsInWindow(runs, { from, to: NOW }).length, 2)
  const insights = buildInsights({ runs, windowDays: 14, now: NOW })
  assert.equal(insights.verdicts.total, 2)
  // Newest first, so a caller can slice the head for "最近".
  const ordered = runsInWindow(runs, { from, to: NOW })
  assert.ok(ordered[0].finishedAt > ordered[1].finishedAt)
})

test('case health and risk cards exclude old failures even when a caller supplies them', () => {
  const runs = [run('failed', 30), run('failed', 31)]
  const report = buildInsights({
    runs,
    now: NOW,
    windowDays: 7,
    runCasesByRun: new Map(runs.map((entry) => [entry.id, [{ caseId: 'login', status: 'failed' }]]))
  })
  assert.equal(report.verdicts.total, 0)
  assert.deepEqual(report.cases.alwaysFailing, [])
  assert.equal(
    report.risks.some((risk) => risk.kind === 'case'),
    false
  )
})

test('the trend has one bucket per day including days with no runs', () => {
  const buckets = trend([run('passed', 0), run('failed', 0), run('passed', 2)], {
    from: new Date(NOW.getTime() - 3 * 86_400_000),
    to: NOW,
    timeZone: 'UTC'
  })
  assert.equal(buckets.length, 4)
  const today = buckets.at(-1)
  assert.equal(today.passed, 1)
  assert.equal(today.failed, 1)
  assert.equal(today.passRate, 0.5)
  const quiet = buckets.find((bucket) => bucket.judged === 0)
  assert.equal(quiet.passRate, null, 'a day with no runs has no pass rate')
})

test('case health separates "never passes" from "sometimes fails"', () => {
  const byRun = new Map([
    [
      'r1',
      [
        { caseId: 'A', status: 'failed' },
        { caseId: 'B', status: 'passed' },
        { caseId: 'C', status: 'passed' }
      ]
    ],
    [
      'r2',
      [
        { caseId: 'A', status: 'failed' },
        { caseId: 'B', status: 'failed' },
        { caseId: 'C', status: 'passed' }
      ]
    ],
    [
      'r3',
      [
        { caseId: 'A', status: 'failed' },
        { caseId: 'B', status: 'flaky' },
        { caseId: 'C', status: 'passed' }
      ]
    ]
  ])
  const health = caseHealth(byRun)
  assert.equal(health.executed, 3)
  assert.deepEqual(
    health.alwaysFailing.map((entry) => entry.caseId),
    ['A']
  )
  assert.deepEqual(
    health.unstable.map((entry) => entry.caseId),
    ['B']
  )
  // A case that only ran once is not evidence of anything.
  const single = caseHealth(new Map([['r1', [{ caseId: 'D', status: 'failed' }]]]))
  assert.deepEqual(single.alwaysFailing, [])
})

test('coverage counts what a machine actually runs, and names the P0 gap', () => {
  const cover = coverage([
    { caseId: 'P0-1', priority: 'P0', automationState: 'implemented' },
    { caseId: 'P0-2', priority: 'P0', automationState: 'blocked-prerequisite' },
    { caseId: 'P1-1', priority: 'P1', automationState: 'implemented' },
    { caseId: 'P1-2', priority: 'P1', automationState: 'manual-only' },
    { caseId: 'OLD', priority: 'P0', automationState: 'implemented', retiredAt: at(1) }
  ])
  assert.equal(cover.total, 4)
  assert.equal(cover.automated, 2)
  assert.equal(cover.automationRate, 0.5)
  assert.deepEqual(cover.p0, { total: 2, automated: 1 })
  assert.deepEqual(
    cover.p0Gap.map((entry) => entry.caseId),
    ['P0-2']
  )
  assert.equal(cover.byState['manual-only'], 1)
})

test('risks name the difference between a fleet problem and a quality problem', () => {
  const machines = fleet([{ id: 'r1', online: false }])
  assert.equal(machines.online, 0)
  const list = risks({
    verdicts: { blocked: 3 },
    cases: { alwaysFailing: [{ caseId: 'A', failed: 3, runs: 3 }], unstable: [] },
    coverage: { p0Gap: [{ caseId: 'P0-2' }] },
    fleet: machines,
    pending: { waitingForRunner: 2 }
  })
  const fleetRisk = list.find((entry) => entry.kind === 'fleet')
  assert.match(fleetRisk.detail, /不是产品质量问题/)
  const environment = list.find((entry) => entry.kind === 'environment')
  assert.match(environment.detail, /受阻不是失败/)
  // Highest level first, so the top of the list is the thing to do now.
  assert.equal(list[0].level, 'high')
})

test('a full build wires every section together', () => {
  const insights = buildInsights({
    runs: [run('passed', 0), run('failed', 1), run('blocked', 2), run('passed', 3)],
    cases: [{ caseId: 'P0-1', priority: 'P0', automationState: 'implemented' }],
    runners: [{ id: 'r1', online: true, status: 'idle' }],
    tasks: [{ id: 't1' }],
    apps: [{ id: 'a1' }],
    runCasesByRun: new Map([['r1', [{ caseId: 'A', status: 'passed' }]]]),
    windowDays: 7,
    timeZone: 'UTC',
    now: NOW
  })
  assert.equal(insights.window.days, 7)
  assert.equal(insights.verdicts.passed, 2)
  // Rounded to three decimals at the source so every reader sees one number.
  assert.equal(insights.verdicts.passRate, 0.667)
  assert.equal(insights.trend.length, 8)
  assert.equal(insights.fleet.online, 1)
  assert.deepEqual(insights.assets, { apps: 1, tasks: 1 })
  assert.equal(insights.duration.p50, 60_000)
  assert.ok(Array.isArray(insights.risks))
})

// -- Agent findings and page assertions ---------------------------------------

const { missionInsights } = await import('../apps/server/insights.mjs')
const { start: startServer } = await import('../apps/server/index.mjs')

const AGENT_NOW = new Date('2026-09-25T12:00:00.000Z')
const mission = (overrides) => ({
  id: crypto.randomUUID(),
  goal: '任务',
  mode: 'agent',
  status: 'completed',
  createdAt: '2026-09-24T08:00:00.000Z',
  events: [],
  ...overrides
})

test('findings and assertions are counted in the window, never as test results', () => {
  const stats = missionInsights(
    [
      mission({
        finding: {
          verdict: 'product-defect',
          confidence: 'high',
          summary: '按钮无响应',
          unverified: 0
        }
      }),
      mission({
        surface: 'desktop',
        finding: {
          verdict: 'environment-blocked',
          confidence: 'medium',
          summary: '执行机离线',
          unverified: 2
        },
        assertions: [
          {
            kind: 'text_visible',
            description: '页面上可见指定文本',
            expected: '已保存',
            actual: false,
            passed: false,
            at: '2026-09-24T08:01:00.000Z'
          },
          {
            kind: 'url_contains',
            description: '当前地址包含指定片段',
            expected: '/done',
            actual: 'https://t/done',
            passed: true,
            at: '2026-09-24T08:02:00.000Z'
          }
        ]
      }),
      // Outside the window: not counted anywhere.
      mission({
        createdAt: '2026-08-01T00:00:00.000Z',
        finding: { verdict: 'flaky', summary: '旧' },
        assertions: [{ passed: false }]
      })
    ],
    { windowDays: 7, now: AGENT_NOW }
  )
  assert.equal(stats.total, 2)
  assert.deepEqual(stats.bySurface, { internal: 1, desktop: 1 })
  assert.equal(stats.findings.total, 2)
  assert.equal(stats.findings.byVerdict['product-defect'], 1)
  assert.equal(stats.findings.byVerdict.flaky, 0)
  assert.equal(stats.findings.unverified, 1)
  assert.equal(stats.assertions.total, 2)
  assert.equal(stats.assertions.passRate, 0.5)
  assert.equal(stats.assertions.recentFailures[0].expected, '已保存')
  assert.equal(stats.findings.recent.length, 2)
  assert.ok(stats.caveats.some((line) => /不是测试结论/.test(line)))

  const none = missionInsights([], { windowDays: 7, now: AGENT_NOW })
  assert.equal(none.assertions.passRate, null, 'no checks, no ratio')
  const counts = missionInsights([mission({ finding: { verdict: 'flaky', summary: 's' } })], {
    windowDays: 7,
    now: AGENT_NOW,
    detail: false
  })
  assert.equal(counts.findings.total, 1)
  assert.deepEqual(counts.findings.recent, [])
  assert.equal(none.usage.perMission, null, 'nothing metered, no average')

  const spent = missionInsights(
    [
      mission({ usage: { calls: 3, promptTokens: 900, completionTokens: 100, estimated: false } }),
      mission({ usage: { calls: 1, promptTokens: 80, completionTokens: 20, estimated: true } }),
      mission({})
    ],
    { windowDays: 7, now: AGENT_NOW }
  )
  assert.deepEqual(
    [spent.usage.missions, spent.usage.calls, spent.usage.promptTokens, spent.usage.estimated],
    [2, 4, 980, 1]
  )
  assert.equal(spent.usage.perMission, 550)
})

test('the quality report carries Agent work; a viewer sees counts only', async (t) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-insights-'))
  const runtime = await startServer(
    {
      MX_RIG_ADMIN_TOKEN: 'insights-admin',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const call = async (path, body, token = 'insights-admin') => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  const synced = await call('/api/rig/v1/missions:sync', {
    missions: [
      mission({
        createdAt: new Date().toISOString(),
        finding: {
          verdict: 'product-defect',
          confidence: 'high',
          summary: '保存后没有提示',
          unverified: 0
        },
        assertions: [
          {
            kind: 'text_visible',
            description: '页面上可见指定文本',
            expected: '已保存',
            passed: false
          }
        ]
      })
    ]
  })
  assert.equal(synced.body.synced, 1)
  const report = (await call('/api/rig/v1/insights?window=7')).body.insights.missions
  assert.equal(report.bySurface.desktop, 1)
  assert.equal(report.findings.byVerdict['product-defect'], 1)
  assert.equal(report.findings.recent[0].summary, '保存后没有提示')
  assert.equal(report.assertions.failed, 1)

  await call('/api/v1/members', {
    account: 'reader',
    role: 'viewer',
    password: 'reader-password-1'
  })
  const reader = (
    await call('/api/rig/v1/native-login', { account: 'reader', password: 'reader-password-1' }, '')
  ).body.token
  const seen = (await call('/api/rig/v1/insights?window=7', undefined, reader)).body.insights
    .missions
  assert.equal(seen.findings.total, 1)
  assert.deepEqual(seen.findings.recent, [])
  assert.deepEqual(seen.assertions.recentFailures, [])
})
