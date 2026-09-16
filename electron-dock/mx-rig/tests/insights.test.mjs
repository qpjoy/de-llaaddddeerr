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
