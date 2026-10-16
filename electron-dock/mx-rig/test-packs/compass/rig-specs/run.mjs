#!/usr/bin/env node
// rig-specs for Compass (罗盘): run the Web cases against the pinned source
// snapshot, with every API call answered by the cases' fake backend.
//
//   node run.mjs                 run every case
//   MXT_CASE_FILTER=CPS-WEB-AUTH-001,web/chat.spec.mjs node run.mjs
//
// On a runner the platform sets MXT_ARTIFACTS_DIR, MXT_RUN_ID and
// MXT_PROJECT_WORKSPACES. Locally, RIG_SOURCE_DIR may point at a snapshot and
// RIG_HEADED=1 shows the browser. Exit codes: 0 passed, 1 failed, 2 blocked —
// blocked means the snapshot could not be run, which says nothing about the
// product.

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runCases, summaryOf, writeSummary } from './lib/harness.mjs'
import { Blocked, findSnapshot, prepareBuild, serveStatic, verifySnapshot } from './lib/snapshot.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const log = (line) => console.log(line)
const startedAt = new Date().toISOString()
const artifactsDir = resolve(process.env.MXT_ARTIFACTS_DIR || join(here, 'artifacts', 'local'))

// The desktop hands its own Chromium to everything it starts; use it rather
// than downloading another.
for (const candidate of [process.env.MX_RIG_BUNDLED_BROWSERS, process.env.MX_RIG_BROWSERS_DIR])
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && candidate && existsSync(candidate)) process.env.PLAYWRIGHT_BROWSERS_PATH = candidate

const project = JSON.parse(await readFile(process.env.RIG_PROJECT_FILE || join(here, '..', '.rig', 'project.json'), 'utf8'))
const qaCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).stdout?.trim() || null
const sourceRef = {
  ref: project.source.ref,
  gitSha: project.source.commit,
  ...(qaCommit && /^[0-9a-f]{40}$/.test(qaCommit) ? { version: `QA ${qaCommit.slice(0, 7)}` } : {})
}

async function loadCases() {
  const cases = []
  for (const folder of ['web']) {
    const files = (await readdir(join(here, folder))).filter((name) => name.endsWith('.spec.mjs')).sort()
    for (const file of files) {
      const spec = `${folder}/${file}`
      const module = await import(pathToFileURL(join(here, spec)).href)
      for (const testCase of module.default) cases.push({ ...testCase, spec })
    }
  }
  const filter = (process.env.MXT_CASE_FILTER || '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  return filter.length ? cases.filter((entry) => filter.includes(entry.id) || filter.includes(entry.spec)) : cases
}

const finish = async (summary, code) => {
  await writeSummary(artifactsDir, summary)
  log(`${summary.status === 'passed' ? '✓ 通过' : summary.status === 'failed' ? '✗ 失败' : '⚠ 受阻'} · ${summary.totals.passed}/${summary.totals.tests}${summary.blockedReason ? ` · ${summary.blockedReason}` : ''}`)
  process.exit(code)
}

const cases = await loadCases()
let server = null
let browser = null
try {
  if (cases.length === 0) throw new Blocked('筛选后没有要跑的用例')
  log(`罗盘 rig-specs · 源码 ${project.source.ref ?? '本机目录'}@${project.source.commit.slice(0, 7)}${qaCommit ? ` · QA ${qaCommit.slice(0, 7)}` : ''} · ${cases.length} 条用例`)
  const snapshot = await findSnapshot({ app: project.app, commit: project.source.commit })
  await verifySnapshot(snapshot, project.source.commit)
  const spa = await prepareBuild(join(snapshot, project.source.subdir || '.'), { commit: project.source.commit, log })
  server = await serveStatic(spa)
  const { chromium } = await import('playwright')
  const headless = process.env.RIG_HEADED !== '1'
  // The full Chromium first (what the desktop ships), then Playwright's default build.
  browser = await chromium
    .launch({ headless, channel: 'chromium' })
    .catch(() => chromium.launch({ headless }))
    .catch((error) => {
      throw new Blocked(`浏览器起不来：${error.message.split('\n')[0]}`)
    })
  const results = await runCases({
    browser,
    cases,
    baseURL: server.origin,
    artifactsDir,
    recordVideo: process.env.MXT_RECORD_VIDEO !== '0',
    log
  })
  const summary = summaryOf({ runId: process.env.MXT_RUN_ID, app: project.app, cases: results, startedAt, sourceRef })
  await browser.close()
  await server.close()
  await finish(summary, summary.status === 'passed' ? 0 : 1)
} catch (error) {
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
  if (!(error instanceof Blocked)) throw error
  await finish(summaryOf({ runId: process.env.MXT_RUN_ID, app: project.app, cases: [], startedAt, sourceRef, blockedReason: error.message }), 2)
}
