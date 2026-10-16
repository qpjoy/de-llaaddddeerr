// Playwright results → the platform's case results (summary.json, schema 2).
//
// Which case a test belongs to comes from .rig/cases/<id>.json, written when an
// approved implementation is committed to this repository: each case maps to a
// test file. A test whose title names a mapped case id belongs to that case
// alone; the others in a file count for every case mapped to that file. Steps
// carry their offset into the test's recording, so the run detail can jump the
// video to a step.

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const CASE_ID = /[A-Z0-9]{2,6}(?:-[A-Z0-9]+)+-\d{3}/g

function flatten(steps, origin, out = []) {
  for (const step of steps) {
    if (step.category === 'test.step' || step.category === 'pw:api') {
      out.push({
        label: String(step.title).slice(0, 200),
        status: step.error ? 'failed' : 'passed',
        offsetMs: Math.max(0, step.startTime.getTime() - origin),
        durationMs: step.duration,
        user: step.category === 'test.step'
      })
    }
    if (step.category !== 'pw:api') flatten(step.steps ?? [], origin, out)
  }
  return out
}

export default class RigReporter {
  constructor({ output = 'artifacts/local' } = {}) {
    this.output = output
    this.tests = []
  }

  onBegin(config) {
    this.rootDir = config.rootDir
    this.startedAt = new Date().toISOString()
  }

  onTestEnd(test, result) {
    const origin = result.startTime.getTime()
    const steps = flatten(result.steps, origin)
    // Steps the test named itself say more than the API calls under them.
    const named = steps.filter((step) => step.user)
    this.tests.push({
      file: relative(this.rootDir, test.location.file).split(sep).join('/'),
      title: test.titlePath().slice(1).join(' › '),
      outcome: test.outcome(),
      durationMs: result.duration,
      steps: (named.length ? named : steps).slice(0, 60),
      errors: result.errors.map((error) => String(error.message ?? error.value ?? '').replace(/\u001b\[[0-9;]*m/g, '')),
      video: result.attachments.find((entry) => entry.name === 'video' && entry.path)?.path ?? null,
      screenshot: result.attachments.filter((entry) => entry.name === 'screenshot' && entry.path).at(-1)?.path ?? null
    })
  }

  async onEnd(result) {
    const mappings = []
    for (const name of await readdir('.rig/cases').catch(() => []))
      if (name.endsWith('.json')) mappings.push(JSON.parse(await readFile(join('.rig/cases', name), 'utf8')))
    const mapped = new Set(mappings.map((entry) => entry.caseId))
    const cases = []
    for (const mapping of mappings) {
      const inFile = this.tests.filter((entry) => entry.file === mapping.path)
      const named = inFile.filter((entry) => (entry.title.match(CASE_ID) ?? []).includes(mapping.caseId))
      // Tests that name another mapped case are that case's, not this one's.
      const tests = named.length ? named : inFile.filter((entry) => !(entry.title.match(CASE_ID) ?? []).some((id) => mapped.has(id)))
      if (!tests.length) continue
      const failed = tests.filter((entry) => ['unexpected'].includes(entry.outcome))
      const status = failed.length
        ? 'failed'
        : tests.every((entry) => entry.outcome === 'skipped')
          ? 'skipped'
          : tests.some((entry) => entry.outcome === 'flaky')
            ? 'flaky'
            : 'passed'
      const evidence = failed[0] ?? tests[0]
      const artifacts = []
      if (evidence.video) {
        const path = `videos/${mapping.caseId}.webm`
        await mkdir(join(this.output, 'videos'), { recursive: true })
        await copyFile(evidence.video, join(this.output, path)).then(() => artifacts.push({ kind: 'video', path }), () => {})
      }
      if (evidence.screenshot) {
        const path = `screenshots/${mapping.caseId}.png`
        await mkdir(join(this.output, 'screenshots'), { recursive: true })
        await copyFile(evidence.screenshot, join(this.output, path)).then(() => artifacts.push({ kind: 'screenshot', path }), () => {})
      }
      cases.push({
        caseId: mapping.caseId,
        title: tests.map((entry) => entry.title).join('；').slice(0, 300),
        spec: mapping.path,
        status,
        durationMs: tests.reduce((sum, entry) => sum + entry.durationMs, 0),
        ...(failed.length ? { error: failed.flatMap((entry) => entry.errors).join('\n\n').slice(0, 4000) } : {}),
        steps: evidence.steps.map((step, index) => ({
          seq: index + 1,
          label: step.label,
          status: step.status,
          offsetMs: evidence.video ? step.offsetMs : null,
          durationMs: step.durationMs
        })),
        artifacts
      })
    }
    const unmapped = this.tests.filter((entry) => !mappings.some((mapping) => mapping.path === entry.file))
    if (unmapped.length) console.log(`  · 没有映射到用例的测试（不上报）：${[...new Set(unmapped.map((entry) => entry.file))].join('、')}`)
    const count = (status) => cases.filter((entry) => entry.status === status).length
    const blockedReason = !this.tests.length
      ? process.env.MXT_CASE_FILTER
        ? '筛选到的用例在这个测试仓库里没有对应的测试文件'
        : result.status === 'failed'
          ? 'Playwright 没有跑起任何测试（配置或依赖出错，见详细输出）'
          : '这个测试仓库里还没有测试'
      : null
    const summary = {
      schemaVersion: 2,
      runId: process.env.MXT_RUN_ID ?? null,
      app: process.env.MXT_APP ?? null,
      status: blockedReason ? 'blocked' : count('failed') ? 'failed' : 'passed',
      ...(blockedReason ? { blockedReason } : {}),
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      totals: {
        tests: cases.length,
        passed: count('passed'),
        failed: count('failed'),
        skipped: count('skipped'),
        flaky: count('flaky'),
        durationMs: Math.round(result.duration ?? 0)
      },
      cases
    }
    await mkdir(this.output, { recursive: true })
    await writeFile(join(this.output, 'summary.json'), JSON.stringify(summary, null, 2))
  }

  printsToStdio() {
    return false
  }
}
