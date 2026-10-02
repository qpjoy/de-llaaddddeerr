/**
 * Quality metrics, computed from what actually ran.
 *
 * Two rules shape every number here, and both come from the same place: a test
 * platform that flatters itself is worse than no platform.
 *
 * 1. A rate over zero samples is `null`, never 100%. "No runs yet" and
 *    "everything passed" are different answers to the same question.
 * 2. `blocked` never counts as a failure and never counts as a pass. An
 *    environment that could not run the test has told you nothing about the
 *    product, and folding it either way invents information.
 */
export const VERDICTS = ['passed', 'failed', 'flaky', 'blocked', 'expired', 'cancelled']
const DECIDED = ['passed', 'failed', 'flaky', 'blocked']
// Verdicts that say something about the product under test.
const PRODUCT_VERDICTS = ['passed', 'failed', 'flaky']

const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null)

function localDate(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(iso))
  } catch {
    return String(iso).slice(0, 10)
  }
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  return sorted[index]
}

/** Runs that finished inside the window, newest first. */
export function runsInWindow(runs, { from, to }) {
  return runs
    .filter((run) => {
      const at = run.finishedAt ?? run.queuedAt
      if (!at) return false
      const time = new Date(at).getTime()
      return time >= from.getTime() && time <= to.getTime()
    })
    .sort((a, b) =>
      String(b.finishedAt ?? b.queuedAt).localeCompare(String(a.finishedAt ?? a.queuedAt))
    )
}

function verdicts(runs) {
  const counts = Object.fromEntries(VERDICTS.map((status) => [status, 0]))
  for (const run of runs) if (counts[run.status] !== undefined) counts[run.status] += 1
  const decided = DECIDED.reduce((sum, status) => sum + counts[status], 0)
  // Pass rate is measured against runs that reached the product at all, so a
  // week of broken runners cannot read as a week of falling quality.
  const judged = PRODUCT_VERDICTS.reduce((sum, status) => sum + counts[status], 0)
  return {
    ...counts,
    total: runs.length,
    decided,
    judged,
    passRate: rate(counts.passed, judged),
    blockedRate: rate(counts.blocked, decided)
  }
}

/** One bucket per local day, oldest first, including days with no runs. */
export function trend(runs, { from, to, timeZone }) {
  const buckets = new Map()
  for (let day = new Date(from); day <= to; day.setUTCDate(day.getUTCDate() + 1)) {
    const key = localDate(day.toISOString(), timeZone)
    if (!buckets.has(key))
      buckets.set(key, { date: key, passed: 0, failed: 0, flaky: 0, blocked: 0 })
  }
  for (const run of runs) {
    const key = localDate(run.finishedAt ?? run.queuedAt, timeZone)
    const bucket = buckets.get(key)
    if (bucket && bucket[run.status] !== undefined) bucket[run.status] += 1
  }
  return [...buckets.values()].map((bucket) => {
    const judged = bucket.passed + bucket.failed + bucket.flaky
    return { ...bucket, judged, passRate: rate(bucket.passed, judged) }
  })
}

/**
 * Cases worth someone's attention.
 *
 * `unstable` is the honest name: a case that both passed and failed in the
 * window might be a flaky test or a real intermittent bug, and this cannot
 * tell them apart — it only says where to look.
 */
export function caseHealth(runCasesByRun, { minRuns = 2 } = {}) {
  const seen = new Map()
  for (const [runId, cases] of runCasesByRun)
    for (const entry of cases) {
      if (!entry?.caseId) continue
      const record = seen.get(entry.caseId) ?? {
        caseId: entry.caseId,
        title: entry.title ?? null,
        runs: 0,
        passed: 0,
        failed: 0,
        flaky: 0,
        lastRunId: runId,
        lastStatus: entry.status
      }
      record.runs += 1
      if (entry.status === 'passed') record.passed += 1
      if (entry.status === 'failed') record.failed += 1
      if (entry.status === 'flaky') record.flaky += 1
      record.title = record.title ?? entry.title ?? null
      seen.set(entry.caseId, record)
    }
  const all = [...seen.values()].map((record) => ({
    ...record,
    failRate: rate(record.failed + record.flaky, record.runs)
  }))
  return {
    executed: all.length,
    alwaysFailing: all
      .filter((record) => record.runs >= minRuns && record.passed === 0 && record.failed > 0)
      .sort((a, b) => b.failed - a.failed)
      .slice(0, 10),
    unstable: all
      .filter(
        (record) =>
          record.runs >= minRuns && (record.flaky > 0 || (record.passed > 0 && record.failed > 0))
      )
      .sort((a, b) => b.failRate - a.failRate)
      .slice(0, 10)
  }
}

/** What is登记 versus what a machine actually runs. */
export function coverage(cases) {
  const live = cases.filter((entry) => !entry.retiredAt)
  const automated = live.filter((entry) => entry.automationState === 'implemented')
  const byPriority = (priority) => {
    const subset = live.filter((entry) => entry.priority === priority)
    return {
      total: subset.length,
      automated: subset.filter((entry) => entry.automationState === 'implemented').length
    }
  }
  return {
    total: live.length,
    automated: automated.length,
    automationRate: rate(automated.length, live.length),
    byState: Object.fromEntries(
      ['implemented', 'planned', 'blocked-prerequisite', 'manual-only', 'unsupported'].map(
        (state) => [state, live.filter((entry) => entry.automationState === state).length]
      )
    ),
    p0: byPriority('P0'),
    // P0 cases nobody automated are the coverage gap that actually hurts.
    p0Gap: live
      .filter((entry) => entry.priority === 'P0' && entry.automationState !== 'implemented')
      .map((entry) => ({
        caseId: entry.caseId,
        title: entry.title ?? null,
        automationState: entry.automationState
      }))
      .slice(0, 10)
  }
}

export function fleet(runners, now = new Date()) {
  const online = runners.filter((runner) => runner.online)
  return {
    registered: runners.length,
    online: online.length,
    busy: online.filter((runner) => runner.status === 'busy').length,
    idle: online.filter((runner) => runner.status !== 'busy').length,
    stale: runners.filter((runner) => !runner.online).length,
    observedAt: now.toISOString()
  }
}

/**
 * Things a person should do something about, worst first.
 *
 * Every entry names what it is and what it is not: "no runner" is a fleet
 * problem, not a quality problem, and the list says so rather than leaving
 * a reader to assume the product is failing.
 */
export function risks({
  verdicts: counts,
  cases: health,
  coverage: cover,
  fleet: machines,
  pending
}) {
  const list = []
  if (machines.online === 0 && machines.registered > 0)
    list.push({
      level: 'high',
      kind: 'fleet',
      title: '没有在线执行机',
      detail: `已注册 ${machines.registered} 台，当前全部离线。派发出去的测试只会排队，这不是产品质量问题。`
    })
  if (machines.registered === 0)
    list.push({
      level: 'high',
      kind: 'fleet',
      title: '还没有注册执行机',
      detail: '没有执行机就跑不了测试。到完整测试管理台的「执行机」页接一台。'
    })
  if (pending.waitingForRunner > 0)
    list.push({
      level: 'medium',
      kind: 'fleet',
      title: `${pending.waitingForRunner} 次执行在等执行机`,
      detail: '这些执行还没有开始跑，它们的状态不代表测试结论。'
    })
  for (const entry of health.alwaysFailing.slice(0, 3))
    list.push({
      level: 'high',
      kind: 'case',
      title: `用例 ${entry.caseId} 连续失败 ${entry.failed} 次`,
      detail: `窗口内跑了 ${entry.runs} 次，一次都没通过。先确认是产品缺陷还是用例本身失效。`
    })
  for (const entry of health.unstable.slice(0, 3))
    list.push({
      level: 'medium',
      kind: 'case',
      title: `用例 ${entry.caseId} 不稳定`,
      detail: `${entry.runs} 次里失败或 flaky ${entry.failed + entry.flaky} 次。可能是不稳定的测试，也可能是间歇性缺陷——这项指标分不出来。`
    })
  if (counts.blocked > 0)
    list.push({
      level: 'medium',
      kind: 'environment',
      title: `${counts.blocked} 次执行受阻`,
      detail: '受阻不是失败：环境没能把测试跑起来，它没有告诉你产品好坏。'
    })
  if (cover.p0Gap.length)
    list.push({
      level: 'medium',
      kind: 'coverage',
      title: `${cover.p0Gap.length} 条 P0 用例没有自动化`,
      detail: `例如 ${cover.p0Gap
        .slice(0, 3)
        .map((entry) => entry.caseId)
        .join('、')}。没登记自动化不等于没有风险。`
    })
  const order = { high: 0, medium: 1, low: 2 }
  return list.sort((a, b) => order[a.level] - order[b.level])
}

export function buildInsights({
  runs = [],
  cases = [],
  runners = [],
  tasks = [],
  apps = [],
  runCasesByRun = new Map(),
  windowDays = 14,
  timeZone = 'Asia/Shanghai',
  now = new Date()
} = {}) {
  const to = now
  const from = new Date(now.getTime() - windowDays * 86_400_000)
  const inWindow = runsInWindow(runs, { from, to })
  const counts = verdicts(inWindow)
  const durations = inWindow
    .map((run) => run.durationMs)
    .filter((value) => Number.isFinite(value) && value > 0)
  const windowIds = new Set(inWindow.map((run) => run.id))
  const health = caseHealth(new Map([...runCasesByRun].filter(([id]) => windowIds.has(id))))
  const cover = coverage(cases)
  const machines = fleet(runners, now)
  const pending = {
    queued: runs.filter((run) => run.status === 'queued').length,
    waitingForRunner: runs.filter((run) => run.status === 'pending-runner').length,
    running: runs.filter((run) => run.status === 'running').length
  }
  return {
    window: { days: windowDays, from: from.toISOString(), to: to.toISOString(), timeZone },
    verdicts: counts,
    duration: {
      samples: durations.length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95)
    },
    trend: trend(inWindow, { from, to, timeZone }),
    cases: health,
    coverage: cover,
    fleet: machines,
    pending,
    assets: { apps: apps.length, tasks: tasks.length },
    risks: risks({ verdicts: counts, cases: health, coverage: cover, fleet: machines, pending }),
    // Said out loud so nobody reads a small window as a trend.
    caveats: [
      `统计窗口为最近 ${windowDays} 天，按 ${timeZone} 的自然日分桶。`,
      '通过率的分母只含 passed / failed / flaky；受阻（blocked）单独计，不算通过也不算失败。',
      '服务最多读取最近 200 次执行，用例级健康度只取窗口内最近 40 次已判断执行；达到上限时不是全量统计。'
    ]
  }
}

const FINDING_VERDICTS = [
  'product-defect',
  'environment-blocked',
  'case-issue',
  'flaky',
  'inconclusive'
]
const RECENT = 10

/**
 * What the Agents concluded and what the browser checked, in the same window.
 *
 * Kept apart from the test verdicts above on purpose. A finding is an Agent's
 * judgement about a run; an assertion is a deterministic check on a page the
 * Agent happened to visit. Neither is a test result, and neither is folded
 * into the pass rate. `detail: false` gives counts only — the lists carry
 * mission goals and summaries, which a read-only member does not get to
 * browse across the whole team.
 */
export function missionInsights(
  missions = [],
  { windowDays = 14, now = new Date(), detail = true } = {}
) {
  const from = now.getTime() - windowDays * 86_400_000
  const inWindow = missions.filter((row) => {
    const at = Date.parse(row.createdAt)
    return Number.isFinite(at) && at >= from && at <= now.getTime()
  })
  const bySurface = { internal: 0, desktop: 0 }
  for (const row of inWindow) bySurface[row.surface === 'desktop' ? 'desktop' : 'internal'] += 1

  const findings = inWindow.filter((row) => row.finding)
  const byVerdict = Object.fromEntries(FINDING_VERDICTS.map((verdict) => [verdict, 0]))
  for (const row of findings)
    if (byVerdict[row.finding.verdict] !== undefined) byVerdict[row.finding.verdict] += 1
  const unverified = findings.filter((row) => (row.finding.unverified ?? 0) > 0).length

  const assertions = inWindow.flatMap((row) =>
    (row.assertions ?? []).map((entry) => ({ ...entry, missionId: row.id, goal: row.goal }))
  )
  const passed = assertions.filter((entry) => entry.passed === true).length
  const newest = (a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))

  const metered = inWindow.filter((row) => row.usage?.calls > 0)
  const sum = (key) => metered.reduce((total, row) => total + (Number(row.usage[key]) || 0), 0)
  const usage = {
    missions: metered.length,
    calls: sum('calls'),
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    // Any mission whose provider did not report is counted by estimate.
    estimated: metered.filter((row) => row.usage.estimated).length,
    perMission: metered.length
      ? Math.round((sum('promptTokens') + sum('completionTokens')) / metered.length)
      : null
  }

  return {
    total: inWindow.length,
    bySurface,
    findings: {
      total: findings.length,
      byVerdict,
      unverified,
      recent: detail
        ? findings
            .map((row) => ({
              missionId: row.id,
              goal: row.goal,
              surface: row.surface === 'desktop' ? 'desktop' : 'internal',
              testRunId: row.testRunId ?? null,
              verdict: row.finding.verdict,
              confidence: row.finding.confidence,
              summary: row.finding.summary,
              nextStep: row.finding.nextStep ?? null,
              unverified: row.finding.unverified ?? 0,
              at: row.updatedAt ?? row.createdAt
            }))
            .sort(newest)
            .slice(0, RECENT)
        : []
    },
    assertions: {
      total: assertions.length,
      passed,
      failed: assertions.length - passed,
      // Same rule as the pass rate: no checks, no ratio.
      passRate: rate(passed, assertions.length),
      recentFailures: detail
        ? assertions
            .filter((entry) => entry.passed !== true)
            .sort(newest)
            .slice(0, RECENT)
            .map((entry) => ({
              missionId: entry.missionId,
              goal: entry.goal,
              description: entry.description ?? entry.kind,
              expected: entry.expected ?? null,
              actual:
                entry.actual === undefined || entry.actual === null
                  ? null
                  : String(entry.actual).slice(0, 200),
              at: entry.at ?? null
            }))
        : []
    },
    usage,
    caveats: [
      'Agent 结论是 Agent 对执行结果的判断，不是测试结论，不计入通过率；引用未核实的结论需要人工复核。',
      '页面断言只覆盖 Agent 在浏览器工位里实际走过的页面，是确定性检查，但不等于这些页面的完整回归。',
      '桌面端执行的任务在同步到服务之后才计入；服务最多读取窗口内最近 500 项任务。',
      '模型用量优先采用 Provider 上报的数字；未上报的调用按字数估算，只适合看趋势，不适合对账。'
    ]
  }
}
