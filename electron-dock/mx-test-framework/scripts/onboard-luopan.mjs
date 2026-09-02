// Register 罗盘 (po-frontend) on a running platform: app, suite, catalog, task.
//
// This is the first real application the platform has ever been pointed at, and
// three things about it are not obvious enough to leave to a README:
//
//   1. The Cypress suite lives on the `public` branch. `main` still has
//      `test: echo "No test specified"`.
//   2. The repository is a monorepo. package.json, pnpm-lock.yaml and cypress/
//      are all under `po-frontend/`, so the suite needs a workingDir.
//   3. `pnpm e2e:local` is self-contained — it runs a production Quasar build,
//      serves dist/spa on 127.0.0.1:55955 and points Cypress at that. It needs
//      no target URL and no reachable backend, which is what makes it runnable
//      as a plain Kubernetes Job today.
//
// Usage:
//   MXT_BASE_URL=http://<平台> MXT_ADMIN_TOKEN=... node scripts/onboard-luopan.mjs

const baseUrl = (process.env.MXT_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/u, '')
const token = process.env.MXT_ADMIN_TOKEN
if (!token) {
  console.error('需要 MXT_ADMIN_TOKEN')
  process.exit(1)
}

const REPO = process.env.LUOPAN_REPO_URL || 'https://github.com/mingxiinfo/po-frontend'
const BRANCH = process.env.LUOPAN_BRANCH || 'public'

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const parsed = text ? JSON.parse(text) : null
  if (!response.ok) {
    // 409 means it is already registered, which is the normal second run.
    if (response.status === 409) return { conflict: true }
    throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`)
  }
  return parsed
}

const say = (message) => console.log(`[onboard] ${message}`)

const app = await call('POST', '/api/v1/apps', {
  slug: 'luopan',
  displayName: '罗盘 (po-frontend)',
  repoUrl: REPO,
  defaultBranch: BRANCH,
  surfaces: ['web', 'electron'],
})
say(app.conflict ? '应用 luopan 已存在，跳过' : `已注册应用 luopan（默认分支 ${BRANCH}）`)

// `pnpm e2e:local` rather than `e2e:run:mock`: the latter needs an external
// E2E_BASE_URL, which would make the very first run depend on a deployed
// instance being up. Self-contained first, external targets once it is green.
const suite = await call('POST', '/api/v1/apps/luopan/suites', {
  slug: 'web-mock',
  displayName: 'Web mock 全量（自包含）',
  engine: 'cypress',
  surface: 'web',
  runnerKind: 'server',
  workingDir: 'po-frontend',
  // The suite starts its own target, so no task needs to supply a URL.
  targetMode: 'self',
  command: ['pnpm', 'e2e:local'],
  retryPolicy: { maxAttempts: 2 },
})
say(suite.conflict ? '套件 web-mock 已存在，跳过' : '已登记套件 web-mock')

// The desktop suite. Same repository, same UI (Quasar builds both targets from
// one source), different runner: an .exe cannot run on the Linux cluster, so
// this one waits for a local runner to claim it.
//
// `targetMode: self` here too — an Electron app has no URL. What it needs is
// MXT_APP_PATH, which the runner sets after downloading the installer the
// platform points it at.
const electron = await call('POST', '/api/v1/apps/luopan/suites', {
  slug: 'electron-smoke',
  displayName: 'Electron 打包冒烟（本地执行机）',
  engine: 'playwright-electron',
  surface: 'electron',
  runnerKind: 'local',
  // The desktop用例住在测试团队自己的仓库，不在 po-frontend 里
  // （[ADR-0007](../specs/adr/0007-test-code-ownership.md)）。把它写成
  // po-frontend + `pnpm e2e:electron` 会必然失败：那个脚本在被测仓库里根本
  // 不存在，而 po-frontend 至今一行未改，正是这条决定想要的结果。
  repoUrl: process.env.LUOPAN_QA_REPO || 'E:/world/workspace/mingxi/luopan-qa-e2e',
  defaultBranch: process.env.LUOPAN_QA_BRANCH || 'main',
  // 仓库根目录：QA 仓库不分前后端子目录。
  workingDir: '.',
  targetMode: 'self',
  requirements: { os: ['windows'] },
  command: ['npm', 'run', 'e2e:electron'],
  retryPolicy: { maxAttempts: 2 },
})
say(electron.conflict ? '套件 electron-smoke 已存在，跳过' : '已登记套件 electron-smoke')

// The build suite. Same Windows machine as the Electron tests, different job:
// this one produces the installer that those tests then exercise.
//
// `artifactPath` is where electron-builder already writes, so po-frontend needs
// no change — no copy step, no platform-specific script.
const build = await call('POST', '/api/v1/apps/luopan/suites', {
  slug: 'win-installer',
  displayName: 'Windows 安装包构建',
  kind: 'build',
  // `generic` because nothing is being driven — a build needs a toolchain, not
  // a browser. The image only matters for server-side runs; this one is local.
  engine: 'generic',
  runnerImage: 'node:22-bookworm',
  surface: 'electron',
  runnerKind: 'local',
  targetMode: 'self',
  workingDir: 'po-frontend',
  artifactPath: 'dist/electron/Packaged/*.exe',
  command: ['pnpm', 'build:electron:exe'],
  requirements: { os: ['windows'] },
})
say(build.conflict ? '套件 win-installer 已存在，跳过' : '已登记套件 win-installer')

// The catalog is what turns "some tests ran" into "these registered cases ran,
// and this one did not". It has to come from the repository — inventing case
// ids here would make every real test show up as `unmapped`, which is drift
// detection reporting a problem this script created.
//
// Set LUOPAN_CHECKOUT to a checkout of the `public` branch to sync the real
// thing. Without it the catalog is left empty, which is honest: an empty
// catalog reports every executed test as unmapped, and that is true.
const qaRepo = process.env.LUOPAN_QA_REPO || 'E:/world/workspace/mingxi/luopan-qa-e2e'
const checkout = process.env.LUOPAN_CHECKOUT
if (!checkout) {
  say('未设置 LUOPAN_CHECKOUT，跳过用例目录同步')
  say('  目录为空时，跑完会把所有用例报成 unmapped —— 那是真实的，不是错误')
  say('  同步真实目录：LUOPAN_CHECKOUT=<public 分支检出路径> 重跑本脚本')
} else {
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  // Each catalog is read from the repository that owns the tests it describes.
  //
  // The web cases live with the application; the desktop cases live in the test
  // team's own repository ([ADR-0007](../specs/adr/0007-test-code-ownership.md)).
  // Syncing only the first left the Electron run reporting `unmapped: 4` — the
  // drift check working exactly as designed, on a gap this script had created.
  const sources = [
    { root: join(checkout, 'po-frontend'), file: 'cypress/case-catalog.frontend.json', suite: 'web-mock' },
    { root: join(checkout, 'po-frontend'), file: 'cypress/case-catalog.agents.json', suite: 'web-mock' },
    { root: qaRepo, file: 'case-catalog.electron.json', suite: 'electron-smoke' },
  ]

  let synced = 0
  for (const source of sources) {
    if (!source.root) continue
    const path = join(source.root, source.file)
    if (!existsSync(path)) {
      say(`  ! 找不到 ${path}，跳过`)
      continue
    }
    const catalog = JSON.parse(readFileSync(path, 'utf8'))
    await call('POST', '/api/v1/apps/luopan/catalog:sync', {
      schemaVersion: catalog.schemaVersion ?? 1,
      catalogFile: source.file,
      suite: source.suite,
      cases: catalog.cases,
    })
    synced += (catalog.cases ?? []).length
    say(`  已同步 ${source.file} → ${source.suite}：${(catalog.cases ?? []).length} 条`)
  }
  say(`用例目录同步完成，共 ${synced} 条`)
}

// Tasks have no uniqueness constraint — the same suite can legitimately have a
// nightly one and an on-merge one — so this script has to check for itself
// rather than rely on a 409. Without it, re-running the script quietly stacks
// up duplicate tasks that would all fire.
const TASK_NAME = '罗盘 Web mock · 手动'
const existing = await call('GET', '/api/v1/tasks?app=luopan')
if (existing.tasks?.some((entry) => entry.name === TASK_NAME)) {
  say('任务已存在，跳过')
} else {
  await call('POST', '/api/v1/tasks', {
    app: 'luopan',
    suite: 'web-mock',
    name: TASK_NAME,
    profile: 'mock',
    track: 'functional',
    schedule: { kind: 'manual' },
  })
  say('已创建任务（先设为手动，跑绿之后再改 cron）')
}

console.log(`
[onboard] 完成。接下来：

  1. 打开 ${baseUrl} → 「测试任务」→ 点「立即执行」
  2. 第一次跑会慢：clone → pnpm install → quasar build → cypress，约 8–15 分钟
  3. 跑完在「执行记录」里看报告；失败的用例能点到具体步骤

跑绿之后再把任务改成 cron（例如每晚 02:00），那时它才算无人值守。
`)
