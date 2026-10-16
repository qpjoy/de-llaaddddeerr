// Runs rig-spec cases one at a time, each in a fresh browser context with its
// own recording, and reports them in the platform's summary format (schema 2):
// every step carries its offset into that case's video, which is what lets the
// run detail jump the recording to a step.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { guardNetwork } from './network.mjs'

const CASE_TIMEOUT_MS = 90_000

class StepFailure extends Error {}

/** Wait for `check` to hold, retrying until `timeout`; the message says what was expected. */
export async function eventually(check, message, { timeout = 15_000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new StepFailure(last ? `${message}（${last.message.split('\n')[0]}）` : message)
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StepFailure(`${label} 超过 ${Math.round(ms / 1000)} 秒没有完成`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * Run `cases` against `baseURL`. Each case is `{ id, title, spec, backend, run }`;
 * `backend()` builds the case's fake API and `run({ page, step, eventually, log, backend })`
 * drives the page; `backend.state` is what the fake API was sent. Returns the schema-2 case entries.
 */
export async function runCases({ browser, cases, baseURL, artifactsDir, recordVideo = true, log = console.log }) {
  const results = []
  const videoDir = join(artifactsDir, '.video-tmp')
  await mkdir(join(artifactsDir, 'videos'), { recursive: true })
  await mkdir(join(artifactsDir, 'screenshots'), { recursive: true })
  const appOrigin = new URL(baseURL).origin
  for (const testCase of cases) {
    log(`▶ ${testCase.id} ${testCase.title}`)
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      ...(recordVideo ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {})
    })
    const backend = testCase.backend()
    const network = await guardNetwork(context, { appOrigin, backend })
    const page = await context.newPage()
    // The recording starts with the page; offsets are measured from here.
    const origin = Date.now()
    const steps = []
    const step = async (label, work) => {
      const entry = { seq: steps.length + 1, label, status: 'passed', offsetMs: Date.now() - origin, durationMs: 0 }
      steps.push(entry)
      try {
        return await work()
      } catch (error) {
        entry.status = 'failed'
        throw error
      } finally {
        entry.durationMs = Date.now() - origin - entry.offsetMs
      }
    }
    const started = Date.now()
    let status = 'passed'
    let error = null
    const artifacts = []
    try {
      await withTimeout(testCase.run({ page, step, eventually, log, backend }), CASE_TIMEOUT_MS, testCase.id)
    } catch (failure) {
      status = 'failed'
      error = failure instanceof StepFailure ? failure.message : String(failure?.message ?? failure).split('\n').slice(0, 6).join('\n')
    }
    // How the page looked when the case ended, passed or not.
    const shot = `screenshots/${testCase.id}.png`
    await page.screenshot({ path: join(artifactsDir, shot) }).then(
      () => artifacts.push({ kind: 'screenshot', path: shot }),
      () => {}
    )
    const video = page.video()
    await context.close()
    if (video) {
      const path = `videos/${testCase.id}.webm`
      await rename(await video.path(), join(artifactsDir, path)).then(
        () => artifacts.push({ kind: 'video', path }),
        () => {}
      )
    }
    if (network.unanswered.size) log(`  · 没有假数据的接口：${[...network.unanswered].join('、')}`)
    if (network.refused.size) log(`  · 已拦截的外部请求：${[...network.refused].join('、')}`)
    log(`  ${status === 'passed' ? '✓' : '✗'} ${testCase.id}${error ? `：${error.split('\n')[0]}` : ''}`)
    results.push({
      caseId: testCase.id,
      title: testCase.title,
      spec: testCase.spec,
      status,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
      steps: steps.map(({ seq, label, status: stepStatus, offsetMs, durationMs }) => ({
        seq,
        label,
        status: stepStatus,
        offsetMs: recordVideo ? offsetMs : null,
        durationMs
      })),
      artifacts
    })
  }
  await rm(videoDir, { recursive: true, force: true })
  return results
}

/** The platform's summary (schema 2) for these results. */
export function summaryOf({ runId, app, cases, startedAt, sourceRef, blockedReason = null }) {
  const count = (status) => cases.filter((entry) => entry.status === status).length
  const failed = count('failed')
  return {
    schemaVersion: 2,
    runId: runId ?? null,
    app,
    status: blockedReason ? 'blocked' : failed ? 'failed' : 'passed',
    ...(blockedReason ? { blockedReason } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    totals: {
      tests: cases.length,
      passed: count('passed'),
      failed,
      skipped: count('skipped'),
      durationMs: cases.reduce((sum, entry) => sum + entry.durationMs, 0)
    },
    cases,
    ...(sourceRef ? { sourceRef } : {})
  }
}

export async function writeSummary(artifactsDir, summary) {
  await mkdir(artifactsDir, { recursive: true })
  await writeFile(join(artifactsDir, 'summary.json'), JSON.stringify(summary, null, 2))
}
