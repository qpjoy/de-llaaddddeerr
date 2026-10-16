// A run carried out end to end by a pretend runner, for the smoke tests of the
// run detail (docs/21 M4). It speaks the runner protocol over HTTP exactly as
// mxt-runner does: register, claim, report progress, upload a recording,
// complete. The recording is real — a few seconds of a page, recorded by
// Playwright — so the detail has a video to load and seek.

import { readFile } from 'node:fs/promises'

const ACTIVE = ['queued', 'pending-runner', 'running']

/** A short webm clip of a page, as bytes. */
export async function recordClip(browser, dir) {
  const context = await browser.newContext({
    viewport: { width: 320, height: 240 },
    recordVideo: { dir, size: { width: 320, height: 240 } }
  })
  const page = await context.newPage()
  await page.setContent(
    '<body style="margin:0;background:#141417"><h1 id="t" style="color:#2bf6d2;font:28px sans-serif;margin:24px">MX Rig</h1></body>'
  )
  for (let second = 1; second <= 3; second += 1) {
    await page.waitForTimeout(700)
    await page.evaluate((n) => {
      document.getElementById('t').textContent = `MX Rig · ${n}`
    }, second)
  }
  const video = page.video()
  await context.close()
  return readFile(await video.path())
}

/** Runner-protocol calls against `origin`, with `adminToken` for the person-facing ones. */
export function pretendRunner(origin, adminToken) {
  const call = async (method, path, { token = adminToken, body, raw } = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(raw ? { 'content-type': 'application/octet-stream' } : {})
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined)
    })
    const text = await response.text()
    const answer = text ? JSON.parse(text) : {}
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`)
    return answer
  }
  let runnerToken = null
  return {
    call,
    /** Cancel every active run except `keep`, so the claim below picks the one under test. */
    async clearQueue(keep) {
      const { runs = [] } = await call('GET', '/api/v1/runs?limit=200')
      for (const run of runs)
        if (ACTIVE.includes(run.status) && run.id !== keep) await call('POST', `/api/v1/runs/${run.id}:cancel`, { body: {} })
    },
    async register(name = '冒烟测试机') {
      const answer = await call('POST', '/runner/v1/runners:register', {
        body: { name, kind: 'local', os: 'linux', engines: ['playwright'], surfaces: ['web'] }
      })
      runnerToken = answer.token
      return answer.runner
    },
    async claim() {
      const answer = await call('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
      return { runId: answer.runId, runToken: answer.runToken }
    },
    events: (runId, runToken, events) => call('POST', `/runner/v1/runs/${runId}/events`, { token: runToken, body: { events } }),
    upload: (runId, runToken, path, bytes) =>
      call('PUT', `/runner/v1/runs/${runId}/artifacts/${path}`, { token: runToken, raw: bytes }),
    complete: (runId, runToken, summary) =>
      call('POST', `/runner/v1/runs/${runId}:complete`, { token: runToken, body: { exitCode: 1, summary } }),
    remove: (runnerId) => call('DELETE', `/api/v1/runners/${runnerId}`)
  }
}

/** A repository catalog: cases 001 and 002 have specs, 003 is registered and not written yet. */
export function smokeCatalog(app, suite, prefix) {
  return {
    schemaVersion: 2,
    application: app,
    suite,
    cases: [
      { id: `${prefix}-001`, title: '有效账号登录', spec: 'e2e/auth.spec.ts', priority: 'P0' },
      { id: `${prefix}-002`, title: '错误密码提示', spec: 'e2e/auth.spec.ts', priority: 'P1' },
      { id: `${prefix}-003`, title: '记住登录状态', priority: 'P2' }
    ]
  }
}

/** The result a two-case run reports: one passed with a recording and steps, one failed. */
export function twoCaseSummary(runId, app, { video, passed, failed }) {
  return {
    schemaVersion: 2,
    runId,
    app,
    status: 'failed',
    totals: { tests: 2, passed: 1, failed: 1, durationMs: 2600 },
    cases: [
      {
        caseId: passed,
        title: '有效账号登录',
        status: 'passed',
        durationMs: 1800,
        steps: [
          { seq: 1, label: '打开登录页', status: 'passed', offsetMs: 200 },
          { seq: 2, label: '输入账号和密码', status: 'passed', offsetMs: 900 },
          { seq: 3, label: '看到首页', status: 'passed', offsetMs: 1600 }
        ],
        artifacts: [{ kind: 'video', path: video }]
      },
      {
        caseId: failed,
        title: '错误密码提示',
        status: 'failed',
        durationMs: 800,
        error: 'expected 提示「账号或密码错误」, received 空白页',
        steps: [{ seq: 1, label: '输入错误密码', status: 'failed', offsetMs: null }]
      }
    ]
  }
}
