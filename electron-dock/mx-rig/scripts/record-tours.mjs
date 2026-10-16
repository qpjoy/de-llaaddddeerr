// 演示录像 (docs/24 M8c): every tour played in 演示 on a fresh desktop
// against a service of its own, recorded, and cut into one video per tour.
// Run it at release, so 新手引导 shows the interface being shipped.
//
//   npm run record:tours                    # .runtime/tours/<id>.webm + index.json
//   MX_RIG_URL=https://rig.example MX_RIG_ADMIN_TOKEN=… npm run record:tours -- --publish
//   … npm run record:tours -- --publish-only  # publish what is already in .runtime/tours
//
// Everything on screen is a fixture: a stand-in po-frontend repository, the
// built-in proving ground, a computer named 演示电脑. The tours run as they
// would for anyone — the script only answers the directory dialog, puts the
// stand-in's commit in the Compass form beforehand, and between tours presses
// the run that 新项目 stops at, so 读懂一次执行 has a real run to read.

import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { _electron } from 'playwright'
import { start } from '../apps/server/index.mjs'
import { PRODUCT_VERSION } from '../packages/contracts/version.mjs'
import { TOURS } from '../apps/web/tours.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(process.env.MX_RIG_TOURS_DIR || join(root, '.runtime/tours'))
const publishOnly = process.argv.includes('--publish-only')
const publish = publishOnly || process.argv.includes('--publish')
// 720p fits any display the window is opened on, so nothing is letterboxed.
const SIZE = { width: 1280, height: 720 }
const ORDER = ['compass-web-smoke', 'new-project', 'read-a-run']
if (ORDER.some((id) => !TOURS.some((tour) => tour.id === id)) || TOURS.some((tour) => !ORDER.includes(tour.id)))
  throw new Error('record-tours.mjs 的录制顺序与关卡目录不一致')

/** The ffmpeg Playwright records with, or one on PATH. */
async function findFfmpeg() {
  if (process.env.MX_RIG_FFMPEG) return process.env.MX_RIG_FFMPEG
  if (spawnSync('ffmpeg', ['-version']).status === 0) return 'ffmpeg'
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright')
  ].filter(Boolean)
  for (const cache of caches) {
    for (const entry of (await readdir(cache).catch(() => [])).filter((name) => name.startsWith('ffmpeg')).sort().reverse()) {
      for (const name of ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg-win64.exe']) {
        const file = join(cache, entry, name)
        if (await stat(file).then(() => true, () => false)) return file
      }
    }
  }
  throw new Error('找不到 ffmpeg：先运行 npx playwright install ffmpeg，或设置 MX_RIG_FFMPEG')
}

/** Send each recording to the service named by MX_RIG_URL, as an admin. */
async function publishAll(index) {
  const url = process.env.MX_RIG_URL
  const adminToken = process.env.MX_RIG_ADMIN_TOKEN
  if (!url || !adminToken) throw new Error('发布需要环境变量 MX_RIG_URL 和 MX_RIG_ADMIN_TOKEN')
  for (const entry of index) {
    const answer = await fetch(`${url.replace(/\/$/, '')}/api/rig/v1/tour-videos/${entry.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: entry.version,
        recordedAt: entry.recordedAt,
        durationMs: entry.durationMs,
        video: (await readFile(join(out, entry.file))).toString('base64')
      })
    })
    if (!answer.ok) throw new Error(`发布 ${entry.id} 失败：${answer.status} ${await answer.text()}`)
    console.log(`published ${entry.id} to ${url}`)
  }
}

if (publishOnly) {
  await publishAll(JSON.parse(await readFile(join(out, 'index.json'), 'utf8')))
  process.exit(0)
}

async function openNav(page, title) {
  const item = page.locator('.rig-nav__item').filter({ hasText: title })
  await item.waitFor({ state: 'attached' })
  const group = item.locator('xpath=parent::details')
  if ((await group.count()) && !(await group.evaluate((node) => node.open))) await group.locator('summary').click()
  await item.click()
}

// A neutral place: no home folder, no host name in the picture.
const work = await mkdtemp(join(tmpdir(), 'mx-rig-tours-'))
const token = randomBytes(16).toString('hex')
const server = await start(
  {
    MX_RIG_HOST: '127.0.0.1',
    MX_RIG_PORT: '0',
    MX_RIG_STORE: 'memory',
    MX_RIG_ADMIN_TOKEN: token,
    MX_RIG_SECRET_KEY: randomBytes(32).toString('hex'),
    MX_RIG_STATE_DIR: join(work, 'control'),
    MX_RIG_ARTIFACTS_DIR: join(work, 'artifacts')
  },
  { schedule: false }
)
const call = async (method, path, body) => {
  const answer = await fetch(server.origin + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status} ${await answer.text()}`)
  return answer.json()
}

// The stand-in for po-frontend: a repository on the branch the pack names.
const source = join(work, 'compass')
await mkdir(join(source, 'po-frontend'), { recursive: true })
const git = (...args) =>
  execFileSync('git', ['-c', 'user.name=Rig', '-c', 'user.email=rig@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd: source,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
  }).trim()
git('init', '-q', '-b', 'feat/yjj/hdo_v2')
await writeFile(join(source, 'po-frontend', 'package.json'), '{"name":"po-frontend","private":true}\n')
git('add', '.')
git('commit', '-q', '-m', '演示用的替身仓库')
const sourceCommit = git('rev-parse', 'HEAD')
const ground = join(work, 'proving-ground')
await cp(join(root, 'test-packs/proving-ground'), ground, { recursive: true })

const defaultsFile = join(root, 'apps/desktop/defaults.json')
const previousDefaults = await readFile(defaultsFile, 'utf8').catch(() => null)
await writeFile(defaultsFile, JSON.stringify({ server: server.origin, privateHttp: false }))
const env = { ...process.env, MX_RIG_USER_DATA_DIR: join(work, 'profile'), MX_RIG_PROVING_GROUND_DIR: ground }
delete env.ELECTRON_RUN_AS_NODE
delete env.MX_RIG_SERVER_URL

const segments = []
let desktop
let video
try {
  desktop = await _electron.launch({
    args: [join(root, 'apps/desktop/main.mjs')],
    env,
    timeout: 30_000,
    recordVideo: { dir: join(work, 'video'), size: SIZE }
  })
  const page = await desktop.firstWindow()
  // The recording starts with the window; segments are measured from here.
  const t0 = Date.now()
  const at = () => (Date.now() - t0) / 1000
  page.setDefaultTimeout(30_000)
  // The video is as big as the window's content; keep it there for the whole session.
  const fit = () =>
    desktop.evaluate(({ BrowserWindow }, size) => {
      const [window] = BrowserWindow.getAllWindows()
      window.setResizable(true)
      window.setContentSize(size.width, size.height)
      window.setResizable(false)
      return window.getContentSize()
    }, SIZE)
  await fit()
  await page.waitForFunction((origin) => document.querySelector('#server').value === origin, server.origin)
  await page.locator('#account').fill('admin')
  await page.locator('#password').fill(token)
  await page.locator('#login-form button[type=submit]').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await desktop.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, join(source, 'po-frontend'))
  await page.evaluate(() => window.mxRig.request('runner-register', { name: '演示电脑' }))
  const ask = (action, body) => page.evaluate(([name, input]) => window.mxRig.request(name, input), [action, body])

  async function record(id, before) {
    await before?.()
    const content = await fit()
    console.log(`${id}: window ${content.join('×')}, page ${await page.evaluate(() => `${innerWidth}×${innerHeight}`)}`)
    await openNav(page, '新手引导')
    await page.locator(`[data-tour-card="${id}"] [data-tour-start]`).click()
    const startAt = at()
    await page.locator('#tour[data-state="intro"]').waitFor({ state: 'attached' })
    // Long enough to read what it will create.
    await page.waitForTimeout(3000)
    await page.locator('#tour [data-tour-action="demo"]').click()
    await page.locator('#tour[data-state="final"]').waitFor({ state: 'attached', timeout: 600_000 })
    // The step the person presses, held for a moment.
    await page.waitForTimeout(3500)
    segments.push({ id, start: startAt, end: at() })
    console.log(`${id} ends: page ${await page.evaluate(() => `${innerWidth}×${innerHeight}`)}`)
    await page.locator('#tour [data-tour-action="end"]').click()
    await page.locator('#tour').waitFor({ state: 'detached' })
    console.log(`recorded ${id}: ${(segments.at(-1).end - startAt).toFixed(1)} s`)
  }

  await record('compass-web-smoke', async () => {
    // The stand-in has its own commit, not the one the pack pins.
    await openNav(page, '项目与任务')
    await page.locator('#pack-creator > summary').click()
    await page.locator('#pack-commit-compass').fill(sourceCommit)
    await page.locator('#pack-creator > summary').click()
  })
  await record('new-project')
  // What a person does next: run the commit on the proving ground.
  await page.locator('#repository-run').click()
  await page.getByRole('button', { name: '按此范围开始执行', exact: true }).click()
  const deadline = Date.now() + 300_000
  let finished = null
  while (!finished && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const app = (await call('GET', '/api/v1/apps')).apps.find((entry) => entry.slug === 'proving-ground')
    const runs = (await call('GET', '/api/v1/runs?limit=20')).runs.filter((run) => run.appId === app?.id)
    finished = runs.find((run) => !['queued', 'pending-runner', 'running'].includes(run.status)) ?? null
  }
  console.log(`the proving-ground run: ${finished?.status ?? 'did not finish'}`)
  await record('read-a-run')
  await ask('runner-stop').catch(() => {})
  video = page.video()
} finally {
  await desktop?.close().catch(() => {})
  if (previousDefaults === null) await rm(defaultsFile, { force: true })
  else await writeFile(defaultsFile, previousDefaults)
  await server.close()
}

// One video per tour, cut from the session.
const ffmpeg = await findFfmpeg()
const full = await video.path()
await mkdir(out, { recursive: true })
const recordedAt = new Date().toISOString()
const index = []
for (const { id, start: from, end } of segments) {
  const file = join(out, `${id}.webm`)
  const cut = spawnSync(
    ffmpeg,
    ['-y', '-loglevel', 'error', '-ss', from.toFixed(2), '-i', full, '-t', (end - from).toFixed(2), '-an', '-c:v', 'libvpx', '-b:v', '1500k', '-crf', '10', '-deadline', 'good', '-cpu-used', '4', file],
    { encoding: 'utf8' }
  )
  if (cut.status !== 0) throw new Error(`剪辑 ${id} 失败：${cut.stderr}`)
  const bytes = (await stat(file)).size
  index.push({ id, title: TOURS.find((tour) => tour.id === id).title, file: `${id}.webm`, version: PRODUCT_VERSION, recordedAt, durationMs: Math.round((end - from) * 1000), bytes })
}
await writeFile(join(out, 'index.json'), JSON.stringify(index, null, 2))
for (const entry of index) console.log(`${entry.id}.webm  ${(entry.durationMs / 1000).toFixed(1)} s  ${(entry.bytes / 1024 / 1024).toFixed(1)} MB`)

if (publish) await publishAll(index)
await rm(work, { recursive: true, force: true })
