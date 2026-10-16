// MX Rig 测试仓库的 Playwright 配置（docs/23）。
//
// The address under test comes from the execution plan (MXT_BASE_URL); a plan
// that names cases runs only the files those cases map to (.rig/cases/*.json);
// results reach the platform through rig/reporter.mjs.

import { defineConfig } from '@playwright/test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const output = resolve(process.env.MXT_ARTIFACTS_DIR || 'artifacts/local')
// One file per case: which test file covers it.
const mappings = existsSync('.rig/cases')
  ? readdirSync('.rig/cases').filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join('.rig/cases', name), 'utf8')))
  : []
const wanted = (process.env.MXT_CASE_FILTER || '').split(/[,\s]+/).filter(Boolean)
const files = [...new Set(mappings.filter((entry) => wanted.includes(entry.caseId) || wanted.includes(entry.path)).map((entry) => entry.path))]

export default defineConfig({
  testDir: '.',
  testMatch: wanted.length
    ? files.length
      ? files
      : ['__rig_no_matching_file__']
    : ['tests/**/*.@(spec|test).@(js|mjs|cjs|ts|tsx)', 'e2e/**/*.@(spec|test).@(js|mjs|cjs|ts|tsx)'],
  // Playwright's own working files stay out of the run's artifacts; the
  // reporter copies each case's recording and screenshot there by name.
  outputDir: resolve('test-results'),
  workers: 1,
  retries: 0,
  timeout: 60_000,
  forbidOnly: true,
  reporter: [['line'], ['./rig/reporter.mjs', { output }]],
  use: {
    baseURL: process.env.MXT_BASE_URL || undefined,
    channel: process.env.RIG_BROWSER_CHANNEL || 'chromium',
    headless: process.env.RIG_HEADED !== '1',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    video: process.env.MXT_RECORD_VIDEO === '0' ? 'off' : 'on',
    screenshot: 'on',
    trace: 'off'
  }
})
