#!/usr/bin/env node
// npm run eval:sensors -- [--headed] [--out file.json] [--stuck-ms 8000] [--min-detection 0.8]
//
// 传感器评测：the proving ground's procedures, replayed with no model against
// its broken build (every defect on) and its fixed build (every defect off).
// A sensor earns its keep by finding the defects it is meant to find in the
// first and saying nothing in the second. Both numbers are printed; neither
// says anything about a real product — the proving ground is a fixture.

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { ProcedurePlayer, readProcedure } from '../packages/runtime/procedure.mjs'
import { summarizeSignals } from '../packages/runtime/sensors.mjs'
import { catalog, startProvingGround } from '../test-packs/proving-ground/server.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

export async function provingGroundProcedures() {
  const file = new URL('../test-packs/proving-ground/procedures.json', import.meta.url)
  const { procedures } = JSON.parse(await readFile(file, 'utf8'))
  return procedures.map(({ key, procedure }) => ({ key, body: readProcedure(procedure) }))
}

/** Whether a signal is the one a defect's detector names. */
export function signalMatches(detect, signal) {
  if (detect?.by !== 'sensor' || signal.sensor !== detect.sensor) return false
  if (detect.url && !String(signal.url ?? '').includes(detect.url)) return false
  if (detect.match && !String(signal.title ?? '').includes(detect.match)) return false
  return true
}

async function replayAll({ build, procedures, launcher, provision, headless, sensors, evidence, onProgress }) {
  const ground = await startProvingGround({ bugs: build === 'broken' ? 'all' : 'none' })
  const runs = []
  try {
    const policy = { browserOrigins: [ground.origin], productionHosts: [] }
    for (const { key, body } of procedures) {
      const browser = new BrowserTools(evidence, launcher, { headless, sensors, provision })
      try {
        const result = await new ProcedurePlayer(browser).run(
          { id: `pg_${key}`, revision: 1, ...body, baseUrl: ground.origin },
          { policy, runId: `${build}-${key}` }
        )
        runs.push({
          key,
          title: body.title,
          verdict: result.verdict,
          failedStep: result.failedStep,
          failure: result.failure ? { code: result.failure.code, message: result.failure.message } : null,
          signals: result.signals ?? [],
          metrics: result.metrics ?? null,
          durationMs: result.durationMs
        })
        onProgress?.({ build, key, verdict: result.verdict, signals: (result.signals ?? []).length })
      } finally {
        await browser.close()
      }
    }
  } finally {
    await ground.close()
  }
  return runs
}

/**
 * Replay every proving-ground procedure on both builds and score the sensors.
 *
 * @param {object} [options]
 * @param {object} [options.launcher] a Playwright-like launcher; default: the test browser this machine has
 * @param {object} [options.provision] where that browser comes from, when no launcher is given
 * @param {boolean} [options.headless]
 * @param {object} [options.sensors]   sensor options (thresholds)
 */
export async function runSensorBench({ launcher = null, provision = null, headless = true, sensors = {}, onProgress = null } = {}) {
  const started = Date.now()
  const procedures = await provingGroundProcedures()
  const evidence = await mkdtemp(join(tmpdir(), 'mx-rig-sensor-bench-'))
  const options = { launcher, provision, headless, sensors, evidence, onProgress, procedures }
  const broken = await replayAll({ ...options, build: 'broken' })
  const fixed = await replayAll({ ...options, build: 'fixed' })
  const byKey = (runs) => new Map(runs.map((run) => [run.key, run]))
  const brokenRuns = byKey(broken)
  const fixedRuns = byKey(fixed)

  const defects = catalog.defects.map((defect) => {
    const run = brokenRuns.get(defect.procedure)
    if (defect.detect.by === 'sensor') {
      const hit = (run?.signals ?? []).find((signal) => signalMatches(defect.detect, signal))
      const also = (defect.detect.also ?? []).filter((sensor) => (run?.signals ?? []).some((signal) => signal.sensor === sensor))
      return { id: defect.id, title: defect.title, by: 'sensor', sensor: defect.detect.sensor, detected: Boolean(hit), evidence: hit?.title ?? null, also }
    }
    // An assertion's defect is found when the broken build fails that
    // procedure and the fixed one passes it: the assertion, not the page, decided.
    const fixedRun = fixedRuns.get(defect.procedure)
    const detected = run?.verdict === 'failed' && fixedRun?.verdict === 'passed'
    return {
      id: defect.id,
      title: defect.title,
      by: 'assertion',
      detected,
      evidence: run?.failure ? `第 ${run.failedStep + 1} 步：${run.failure.message}` : null
    }
  })

  const sensorDefects = defects.filter((entry) => entry.by === 'sensor')
  const assertionDefects = defects.filter((entry) => entry.by === 'assertion')
  const explained = (signal) =>
    catalog.defects.some((defect) => signalMatches(defect.detect, signal) || (defect.detect.also ?? []).includes(signal.sensor))
  const unexplained = broken.flatMap((run) =>
    run.signals.filter((signal) => !explained(signal)).map((signal) => ({ procedure: run.key, sensor: signal.sensor, title: signal.title }))
  )
  const falsePositives = fixed.flatMap((run) =>
    run.signals.map((signal) => ({ procedure: run.key, sensor: signal.sensor, title: signal.title }))
  )
  const fixedFailures = fixed
    .filter((run) => run.verdict !== 'passed')
    .map((run) => ({ procedure: run.key, verdict: run.verdict, failure: run.failure }))

  return {
    at: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    note: '试验场是夹具：这些数字只说明检测能力，不代表任何真实产品的质量。',
    summary: {
      sensorDefects: sensorDefects.length,
      sensorDetected: sensorDefects.filter((entry) => entry.detected).length,
      detectionRate: sensorDefects.length ? sensorDefects.filter((entry) => entry.detected).length / sensorDefects.length : null,
      assertionDefects: assertionDefects.length,
      assertionDetected: assertionDefects.filter((entry) => entry.detected).length,
      falsePositives: falsePositives.length,
      unexplained: unexplained.length,
      fixedFailures: fixedFailures.length,
      broken: summarizeSignals(broken.flatMap((run) => run.signals)),
      // Assertions that held while a sensor saw a defect: what sensors add.
      greenButFlagged: broken.filter((run) => run.verdict === 'passed' && run.signals.length).map((run) => run.key)
    },
    defects,
    falsePositives,
    unexplained,
    fixedFailures,
    builds: { broken, fixed }
  }
}

/** The report as a person reads it in a terminal. */
export function renderSensorReport(report) {
  const s = report.summary
  const percent = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`)
  const lines = [
    '试验场 · 传感器评测（无模型重放；夹具结果，不是产品质量）',
    '',
    `传感器可检出的缺陷：${s.sensorDetected} / ${s.sensorDefects}（检出率 ${percent(s.detectionRate)}）`,
    `断言负责的缺陷：${s.assertionDetected} / ${s.assertionDefects}`,
    `修复版上的误报：${s.falsePositives} 条；修复版上未通过的规程：${s.fixedFailures} 条`,
    `有缺陷版本里无法对应到已知缺陷的线索：${s.unexplained} 条`,
    s.greenButFlagged.length
      ? `断言全部通过、但传感器发现了问题的规程：${s.greenButFlagged.join('、')}`
      : '没有“断言通过但传感器报警”的规程',
    '',
    ...report.defects.map(
      (entry) =>
        `${entry.detected ? '✓' : '✗'} ${entry.id} [${entry.by === 'sensor' ? entry.sensor : '断言'}] ${entry.title}${
          entry.evidence ? `\n    ↳ ${entry.evidence}` : ''
        }`
    )
  ]
  if (report.falsePositives.length)
    lines.push('', '误报：', ...report.falsePositives.map((entry) => `  ! ${entry.procedure} [${entry.sensor}] ${entry.title}`))
  if (report.unexplained.length)
    lines.push('', '未对应的线索：', ...report.unexplained.map((entry) => `  ? ${entry.procedure} [${entry.sensor}] ${entry.title}`))
  if (report.fixedFailures.length)
    lines.push('', '修复版上未通过：', ...report.fixedFailures.map((entry) => `  ✗ ${entry.procedure}：${entry.failure?.message ?? entry.verdict}`))
  lines.push('', `用时 ${(report.durationMs / 1000).toFixed(1)} 秒`)
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      headed: { type: 'boolean', default: false },
      out: { type: 'string' },
      'stuck-ms': { type: 'string' },
      'min-detection': { type: 'string', default: '0.8' }
    }
  })
  const { provisionFromEnv, progressLine } = await import('../packages/runtime/browser-provision.mjs')
  const provision = provisionFromEnv(process.env, { dir: join(root, '.runtime', 'browsers') })
  const seen = { step: -1 }
  provision.onProgress = (event) => {
    const text = progressLine(event, seen)
    if (text) console.log(text)
  }
  const report = await runSensorBench({
    provision,
    headless: !values.headed,
    sensors: values['stuck-ms'] ? { stuckMs: Number(values['stuck-ms']) } : {},
    onProgress: ({ build, key, verdict, signals }) =>
      console.log(`  ${build === 'broken' ? '有缺陷' : '修复版'} · ${key}：${verdict}，${signals} 条线索`)
  })
  console.log(`\n${renderSensorReport(report)}`)
  const out = values.out ?? join(root, '.runtime', 'evals', `sensors-${report.at.replace(/[:.]/g, '-')}.json`)
  await mkdir(join(out, '..'), { recursive: true })
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`报告：${out}`)
  const floor = Number(values['min-detection'])
  if ((report.summary.detectionRate ?? 0) < floor || report.summary.falsePositives > 0) process.exitCode = 1
}
