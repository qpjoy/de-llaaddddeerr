import { readFileSync } from 'node:fs'

export const DEFAULT_COMPASS_REPO = 'https://github.com/mingxiinfo/po-frontend'

const ELECTRON_CATALOG = JSON.parse(
  readFileSync(new URL('./compass-electron.json', import.meta.url), 'utf8'),
)

function text(value, fallback = null) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function command(value) {
  if (value == null) return ['pnpm', 'test']
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== 'string' || !part)) {
    throw new TypeError('electronCommand must be a non-empty string array')
  }
  return [...value]
}

function operatingSystems(value) {
  const entries = Array.isArray(value) ? value : String(value ?? 'windows').split(',')
  const normalized = entries.map((entry) => String(entry).trim()).filter(Boolean)
  return normalized.length ? [...new Set(normalized)] : ['windows']
}

/**
 * The first real product template for MX AutoTest.
 *
 * It is deliberately data, not a shell command. The Admin API and the optional
 * CLI compatibility wrapper consume the same plan, so neither path can drift
 * into a different suite, branch or task contract.
 */
export function buildCompassPlan(options = {}) {
  const appSlug = text(options.appSlug, 'luopan')
  const repoUrl = text(options.webRepoUrl, DEFAULT_COMPASS_REPO)
  const webBranch = text(options.webBranch, 'public')
  const electronRepoUrl = text(options.electronQaRepoUrl)
  const timezone = text(options.timezone, 'Asia/Shanghai')
  const functionalCron = text(options.functionalCron)

  const suites = [
    {
      slug: 'web-functional',
      displayName: 'Compass Web · Functional',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'server',
      runnerImage: 'cypress/included:15.19.0',
      repoUrl,
      defaultBranch: webBranch,
      workingDir: 'po-frontend',
      targetMode: 'self',
      command: ['pnpm', 'e2e:local'],
      retryPolicy: { maxAttempts: 1 },
      writesData: false,
    },
    {
      slug: 'web-demo',
      displayName: 'Compass Web · Demo 视频',
      engine: 'cypress',
      surface: 'web',
      // The local runner records the human-speed track and uploads it only
      // after completion; server Jobs intentionally do not retain video.
      runnerKind: 'local',
      runnerImage: 'cypress/included:15.19.0',
      repoUrl,
      defaultBranch: webBranch,
      workingDir: 'po-frontend',
      targetMode: 'self',
      command: ['pnpm', 'e2e:local'],
      retryPolicy: { maxAttempts: 1 },
      writesData: false,
    },
  ]

  const tasks = [
    {
      suiteSlug: 'web-functional',
      name: 'Compass Web · Functional',
      profile: 'mock',
      track: 'functional',
      runsOn: 'server',
      schedule: functionalCron
        ? { kind: 'cron', cronExpr: functionalCron, timezone }
        : { kind: 'manual' },
    },
    {
      suiteSlug: 'web-demo',
      name: 'Compass Web · Demo（人工观看）',
      profile: 'mock',
      track: 'demo',
      runsOn: 'any-runner',
      schedule: { kind: 'manual' },
    },
  ]
  const catalogs = []

  if (electronRepoUrl) {
    suites.push({
      slug: 'compass-electron-smoke',
      displayName: 'Compass Electron · Playwright',
      engine: 'playwright-electron',
      surface: 'electron',
      runnerKind: 'local',
      repoUrl: electronRepoUrl,
      defaultBranch: text(options.electronBranch, 'main'),
      workingDir: text(options.electronWorkingDir, '.'),
      targetMode: 'self',
      requirements: { os: operatingSystems(options.electronOs) },
      command: command(options.electronCommand),
      secretRefs: ['COMPASS_E2E_ACCOUNT', 'COMPASS_E2E_PASSWORD'],
      retryPolicy: { maxAttempts: 1 },
      writesData: false,
    })
    tasks.push(
      {
        suiteSlug: 'compass-electron-smoke',
        name: 'Compass Electron · 启动冒烟',
        profile: 'mock',
        track: 'functional',
        runsOn: 'any-runner',
        caseFilter: 'CPS-EL-BOOT-001,CPS-EL-BOOT-002',
        schedule: { kind: 'manual' },
      },
      {
        suiteSlug: 'compass-electron-smoke',
        name: 'Compass Electron · 正式登录验收',
        profile: 'real',
        track: 'functional',
        runsOn: 'any-runner',
        caseFilter: 'CPS-EL-AUTH-001',
        schedule: { kind: 'manual' },
      },
    )
    catalogs.push(structuredClone(ELECTRON_CATALOG))
  }

  return {
    app: {
      slug: appSlug,
      displayName: '罗盘 Compass (po-frontend)',
      repoUrl,
      defaultBranch: webBranch,
      surfaces: ['web', 'electron'],
    },
    suites,
    tasks,
    catalogs,
    electronConfigured: Boolean(electronRepoUrl),
  }
}
