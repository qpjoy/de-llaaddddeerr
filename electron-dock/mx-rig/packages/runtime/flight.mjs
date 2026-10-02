// Flight plans: the deterministic half.
//
// Everything here is a pure function over what a mission recorded — stage
// results, gate outcomes, assertions, findings. No model is consulted. A
// Go/No-Go that depended on how a model felt about a run would be a guess
// with a badge on it; these read counts.

import { GATE_METRICS, STAGES } from '../graph/orchestration.mjs'

export const VERDICT_LABEL = Object.freeze({
  go: 'GO · 放行',
  'no-go': 'NO-GO · 不放行',
  scrubbed: 'SCRUB · 取消发射'
})

const RUN_TERMINAL = new Set([
  'passed',
  'failed',
  'flaky',
  'blocked',
  'expired',
  'timeout',
  'cancelled'
])

/** Case-level counts of one run, with the failures named. */
export function summarizeCases(cases = []) {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0, blocked: 0, notRun: 0, total: 0 }
  for (const entry of cases) {
    counts.total += 1
    if (counts[entry.status] !== undefined) counts[entry.status] += 1
  }
  const failed = cases
    .filter((entry) => entry.status === 'failed' || entry.status === 'flaky')
    .slice(0, 10)
    .map((entry) => ({
      caseId: String(entry.caseId ?? ''),
      title: String(entry.title ?? entry.caseId ?? '').slice(0, 120),
      status: entry.status
    }))
  return { counts, failed }
}

export function isTerminalRun(status) {
  return RUN_TERMINAL.has(status)
}

/** One criterion, judged against the recorded stage it names. */
export function evaluateCriterion(criterion, stages = {}) {
  const meta = GATE_METRICS[criterion.metric]
  const stage = stages[criterion.stage]
  const base = {
    metric: criterion.metric,
    label: meta?.label ?? criterion.metric,
    stage: criterion.stage,
    ...(criterion.value !== undefined ? { value: criterion.value } : {})
  }
  if (!stage) return { ...base, ok: false, actual: '该阶段没有执行' }
  const counts = stage.counts ?? {}
  switch (criterion.metric) {
    case 'preflight_go':
      return { ...base, ok: stage.go === true, actual: stage.go ? 'Go' : 'No-Go' }
    case 'run_passed':
      return { ...base, ok: stage.status === 'passed', actual: stage.status ?? '—' }
    case 'failed_max': {
      const failed = (counts.failed ?? 0) + (counts.flaky ?? 0)
      return {
        ...base,
        ok: isTerminalRun(stage.status) && failed <= criterion.value,
        actual: isTerminalRun(stage.status) ? String(failed) : `未结束（${stage.status ?? '—'}）`
      }
    }
    case 'blocked_none':
      return {
        ...base,
        ok:
          isTerminalRun(stage.status) && stage.status !== 'blocked' && (counts.blocked ?? 0) === 0,
        actual: stage.status === 'blocked' ? '执行受阻' : `受阻用例 ${counts.blocked ?? 0}`
      }
    case 'procedures_passed': {
      const total = counts.total ?? 0
      return {
        ...base,
        // No procedure ran is not "all passed".
        ok: total > 0 && (counts.passed ?? 0) === total,
        actual: `${counts.passed ?? 0}/${total} 通过${counts.blocked ? `，${counts.blocked} 条受阻` : ''}`
      }
    }
    case 'procedure_pass_rate_min': {
      // Blocked replays are the environment's: neither passed nor failed.
      const judged = (counts.passed ?? 0) + (counts.failed ?? 0)
      const rate = judged ? Math.round(((counts.passed ?? 0) / judged) * 1000) / 10 : null
      return {
        ...base,
        ok: rate !== null && rate >= criterion.value,
        actual: rate === null ? '没有可判定的规程' : `${rate}%`
      }
    }
    case 'pass_rate_min': {
      const judged = (counts.passed ?? 0) + (counts.failed ?? 0) + (counts.flaky ?? 0)
      // No judged cases is not 100%: the gate cannot pass on no evidence.
      const rate = judged ? Math.round(((counts.passed ?? 0) / judged) * 1000) / 10 : null
      return {
        ...base,
        ok: rate !== null && rate >= criterion.value,
        actual: rate === null ? '没有可判定的用例' : `${rate}%`
      }
    }
    case 'assertions_all_passed': {
      const total = stage.assertions ?? 0
      const failed = stage.failedAssertions ?? 0
      return {
        ...base,
        ok: total > 0 && failed === 0,
        actual: total ? `${total - failed}/${total} 通过` : '没有断言'
      }
    }
    default:
      return { ...base, ok: false, actual: '未知标准' }
  }
}

/**
 * The flight's verdict from what was recorded. A scrubbed pre-flight wins over
 * everything; any failed or refused gate is No-Go; Go needs at least one gate —
 * a plan without exit criteria has no verdict to give.
 */
export function flightVerdict(flight) {
  if (!flight) return null
  const stages = Object.values(flight.stages ?? {})
  if (stages.some((stage) => stage.type === 'preflight' && stage.go === false)) return 'scrubbed'
  const gates = Object.values(flight.gates ?? {})
  if (gates.some((gate) => gate.passed === false || gate.approved === false)) return 'no-go'
  if (gates.length && gates.every((gate) => gate.passed === true)) return 'go'
  return null
}

const cell = (value) =>
  String(value ?? '—')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')

/** The Flight Report, as Markdown: pasteable into a chat, a ticket or a doc. */
export function buildFlightReport({ mission, planName, now = new Date() }) {
  const flight = mission.flight ?? { stages: {}, gates: {} }
  const verdict = flight.verdict ?? flightVerdict(flight)
  const lines = [
    `# 飞行报告 · ${planName ?? mission.orchestrationKey ?? mission.goal}`,
    '',
    `- 结论：**${verdict ? VERDICT_LABEL[verdict] : '未设放行标准'}**`,
    `- 任务：${mission.id}${mission.surface === 'desktop' ? '（桌面执行）' : ''}`,
    `- 目标：${mission.goal}`,
    `- 生成时间：${now.toISOString()}`,
    ...(mission.usage?.calls
      ? [
          `- 模型用量：${mission.usage.calls} 次调用，输入 ${mission.usage.promptTokens} / 输出 ${mission.usage.completionTokens} tokens${mission.usage.estimated ? '（部分为估算）' : ''}`
        ]
      : []),
    ''
  ]
  const stages = Object.entries(flight.stages ?? {})
  if (stages.length) {
    lines.push('## 各阶段', '', '| 阶段 | 类型 | 结果 | 说明 |', '| --- | --- | --- | --- |')
    for (const [id, stage] of stages) {
      const label = stage.stage ? STAGES[stage.stage] : ''
      if (stage.type === 'preflight')
        lines.push(
          `| ${cell(stage.title ?? id)} | 预检${label ? ` · ${label}` : ''} | ${stage.go ? 'Go' : 'No-Go'} | ${cell(
            (stage.checks ?? [])
              .filter((check) => !check.ok)
              .map((check) => check.detail)
              .join('；') || '全部通过'
          )} |`
        )
      else if (stage.type === 'flight') {
        const c = stage.counts ?? {}
        lines.push(
          `| ${cell(stage.title ?? id)} | 架次${label ? ` · ${label}` : ''} | ${cell(stage.status)} | Run ${cell(stage.runId)}：通过 ${c.passed ?? 0}，失败 ${c.failed ?? 0}，不稳定 ${c.flaky ?? 0}，跳过 ${c.skipped ?? 0}，共 ${c.total ?? 0}${stage.note ? `；${cell(stage.note)}` : ''} |`
        )
      } else if (stage.type === 'explore')
        lines.push(
          `| ${cell(stage.title ?? id)} | 探索${label ? ` · ${label}` : ''} | 断言 ${(stage.assertions ?? 0) - (stage.failedAssertions ?? 0)}/${stage.assertions ?? 0} | ${cell(stage.summary)} |`
        )
      else if (stage.type === 'procedure') {
        const c = stage.counts ?? {}
        lines.push(
          `| ${cell(stage.title ?? id)} | 规程试车${label ? ` · ${label}` : ''} | ${c.passed ?? 0}/${c.total ?? 0} 通过 | 失败 ${c.failed ?? 0}，受阻 ${c.blocked ?? 0}（每条都记为应用的一次执行） |`
        )
      }
    }
    lines.push('')
  }
  const gates = Object.entries(flight.gates ?? {})
  if (gates.length) {
    lines.push('## 放行评审', '')
    for (const [id, gate] of gates) {
      lines.push(
        `### ${gate.title ?? id}：${gate.passed ? '达标' : '未达标'}${gate.approved === false ? '（人工 No-Go）' : gate.approved === true ? '（人工放行）' : ''}`,
        ''
      )
      for (const result of gate.results ?? [])
        lines.push(
          `- ${result.ok ? '✅' : '❌'} ${result.label}${result.value !== undefined ? ` ${result.value}` : ''}（${result.stage}）：实际 ${result.actual}`
        )
      lines.push('')
    }
  }
  const unproven = stages.flatMap(([, stage]) =>
    stage.type === 'procedure'
      ? (stage.results ?? []).filter((entry) => entry.verdict !== 'passed')
      : []
  )
  if (unproven.length) {
    lines.push('## 未通过的规程', '')
    for (const entry of unproven)
      lines.push(
        `- ${entry.verdict === 'blocked' ? '受阻' : '失败'}：「${entry.title}」（第 ${entry.revision ?? '?'} 版）${
          entry.failedStep !== null && entry.failedStep !== undefined
            ? `第 ${entry.failedStep + 1} 步`
            : ''
        }${entry.message ? `：${entry.message}` : ''}${entry.repairable ? '（可交给规程维护员修正）' : ''}`
      )
    lines.push('')
  }
  const failedCases = stages.flatMap(([, stage]) => stage.failed ?? [])
  if (failedCases.length) {
    lines.push('## 失败用例', '')
    for (const entry of failedCases.slice(0, 20))
      lines.push(`- ${entry.caseId} ${entry.title}（${entry.status}）`)
    lines.push('')
  }
  const failedAssertions = (mission.assertions ?? []).filter((entry) => entry.passed !== true)
  if (failedAssertions.length) {
    lines.push('## 未通过的断言', '')
    for (const entry of failedAssertions.slice(0, 20))
      lines.push(
        `- ${entry.description ?? entry.kind}${entry.expected !== undefined ? `：期望 ${entry.expected}` : ''}，实际 ${entry.actual ?? '—'}`
      )
    lines.push('')
  }
  if (mission.finding) {
    lines.push(
      '## Agent 结论（判断，不是测试结论）',
      '',
      `- ${mission.finding.verdict}（置信度 ${mission.finding.confidence}）：${mission.finding.summary}`,
      ...(mission.finding.unverified
        ? [`- ${mission.finding.unverified} 个引用未核实，需要人工复核`]
        : []),
      ''
    )
  }
  lines.push(
    '## 口径',
    '',
    '- 结论只由预检与放行评审的确定性标准得出，不由模型判断。',
    '- 受阻（blocked）说明环境没把测试跑起来，不算失败，也不算通过。',
    '- 断言只覆盖探索阶段实际走过的页面。'
  )
  return lines.join('\n')
}

/**
 * The notification for a finished flight, in the shape the platform's
 * adapters already render (title, totals, failed cases, a link).
 */
export function debriefMessage({ mission, planName, baseUrl = '' }) {
  const flight = mission.flight ?? { stages: {}, gates: {} }
  const verdict = flight.verdict ?? flightVerdict(flight)
  const flights = Object.values(flight.stages ?? {}).filter((stage) => stage.type === 'flight')
  const totals = { tests: 0, passed: 0, failed: 0, notRun: 0 }
  for (const stage of flights) {
    const c = stage.counts ?? {}
    totals.tests += c.total ?? 0
    totals.passed += c.passed ?? 0
    totals.failed += (c.failed ?? 0) + (c.flaky ?? 0)
    totals.notRun += c.notRun ?? 0
  }
  const failed = flights.flatMap((stage) => stage.failed ?? [])
  const scrub = Object.values(flight.stages ?? {}).find(
    (stage) => stage.type === 'preflight' && stage.go === false
  )
  const icon = { go: '🚀', 'no-go': '🛑', scrubbed: '⏸' }[verdict] ?? '📋'
  return {
    event: 'debrief',
    title: `${icon} 飞行报告 · ${planName ?? mission.goal} · ${verdict ? VERDICT_LABEL[verdict] : '未设放行标准'}`,
    runId: flights[0]?.runId ?? null,
    runUrl: baseUrl ? `${baseUrl.replace(/\/$/u, '')}/rig/` : null,
    taskName: planName ?? mission.goal,
    status: verdict ?? 'completed',
    totals,
    blockedReason: scrub
      ? (scrub.checks ?? [])
          .filter((check) => !check.ok)
          .map((check) => check.detail)
          .join('；')
          .slice(0, 300)
      : null,
    failedCases: failed
      .slice(0, 5)
      .map((entry) => ({ caseId: entry.caseId, title: entry.title, error: null })),
    failedCasesOmitted: Math.max(0, failed.length - 5),
    sourceRef: null,
    lastGood: null
  }
}
