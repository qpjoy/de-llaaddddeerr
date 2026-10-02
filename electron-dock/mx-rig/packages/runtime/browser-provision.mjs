// 测试浏览器从哪里来: the Chromium the isolated browser runs on, found or
// fetched without anyone having to run `npx playwright install`.
//
// In order, the first one that exists:
//   1. MX_RIG_CHROMIUM_PATH — an executable someone pointed at on purpose;
//   2. the copy shipped inside the desktop installer (`bundled`);
//   3. Playwright's own cache (PLAYWRIGHT_BROWSERS_PATH, or the per-user
//      default) — what `npm run browser:install` fills on a developer machine;
//   4. the copy this tool downloaded before (`dir`);
//   5. Google Chrome or Microsoft Edge already installed on the computer.
// With none of them, the version-matched Chromium is downloaded into `dir`:
// from Playwright's CDN, and from a mirror reachable in China when that fails
// (the CDN redirects to storage.googleapis.com). The archive and how it is
// unpacked are Playwright's own, run out of process as `playwright install`
// would run it.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { RigError } from '../contracts/index.mjs'

const require = createRequire(import.meta.url)

// Chrome for Testing archives by platform, and where the executable sits in
// one. Playwright's registry says the same for the machine it runs on; this
// table also covers packaging for another platform.
const PLATFORMS = {
  'mac-arm64': { archive: 'mac-arm64/chrome-mac-arm64.zip', executable: ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'] },
  'mac-x64': { archive: 'mac-x64/chrome-mac-x64.zip', executable: ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'] },
  'win-x64': { archive: 'win64/chrome-win64.zip', executable: ['chrome-win64', 'chrome.exe'] },
  'linux-x64': { archive: 'linux64/chrome-linux64.zip', executable: ['chrome-linux64', 'chrome'] }
}

const OFFICIAL = 'https://cdn.playwright.dev/builds/cft'
// npmmirror keeps Chrome for Testing under its own path, so Playwright's
// download-host override cannot point at it; the URLs are built here.
const MIRROR = 'https://cdn.npmmirror.com/binaries/chrome-for-testing'

/** The Chromium this Playwright expects: its revision, version and folder name. */
export function chromiumBuild() {
  const { browsers } = JSON.parse(readFileSync(join(playwrightCore(), 'browsers.json'), 'utf8'))
  const entry = browsers.find((browser) => browser.name === 'chromium')
  return { revision: entry.revision, version: entry.browserVersion, folder: `chromium-${entry.revision}` }
}

// Found through playwright itself: a packaged app keeps playwright-core under
// node_modules/playwright/node_modules, a source checkout hoists it.
const fromPlaywright = () => createRequire(require.resolve('playwright/package.json'))
const playwrightCore = () => dirname(fromPlaywright().resolve('playwright-core/package.json'))
const registry = () => fromPlaywright()('playwright-core/lib/server/registry/index').registry

/** `mac-arm64`, `win-x64`… for this machine, or null where no build exists. */
export function hostPlatform(platform = process.platform, arch = process.arch) {
  const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform]
  const cpu = { arm64: 'arm64', x64: 'x64' }[arch]
  const key = os && cpu ? `${os}-${cpu}` : null
  return key && PLATFORMS[key] ? key : null
}

/** Where the executable is, inside a browsers folder laid out the way Playwright lays it out. */
export function executableIn(browsersDir, platform = hostPlatform()) {
  const layout = PLATFORMS[platform]
  if (!browsersDir || !layout) return null
  return join(browsersDir, chromiumBuild().folder, ...layout.executable)
}

/** Download addresses for one platform, the official CDN first. */
export function downloadUrls(platform = hostPlatform(), env = process.env) {
  const layout = PLATFORMS[platform]
  if (!layout) return []
  const { version } = chromiumBuild()
  // Mirrors of the chrome-for-testing tree, tried in the order given.
  const custom = String(env.MX_RIG_BROWSER_MIRROR ?? '')
    .split(',')
    .map((base) => base.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  const bases = custom.length ? custom : env.MX_RIG_BROWSER_MIRROR_ONLY === '1' ? [MIRROR] : [OFFICIAL, MIRROR]
  return bases.map((base) => `${base}/${version}/${layout.archive}`)
}

/** Playwright's own folder on this machine (PLAYWRIGHT_BROWSERS_PATH or the per-user cache). */
export function playwrightCache() {
  try {
    const executable = registry().findExecutable('chromium')?.executablePath('javascript')
    if (!executable) return null
    const parts = executable.split(sep)
    const at = parts.findIndex((part) => /^chromium-\d+$/.test(part))
    return at > 0 ? parts.slice(0, at).join(sep) || sep : null
  } catch {
    return null
  }
}

/** Installed Chrome / Edge, where Playwright knows to look for them. */
function installedChannel() {
  try {
    for (const [channel, title] of [
      ['chrome', 'Google Chrome'],
      ['msedge', 'Microsoft Edge']
    ]) {
      const path = registry().findExecutable(channel)?.executablePath('javascript')
      if (path && existsSync(path)) return { channel, title, path }
    }
  } catch {
    /* No registry, no channels. */
  }
  return null
}

/**
 * One machine's way to a browser. `bundled` is the installer's copy (read
 * only); `dir` is where this tool may download one.
 */
export class BrowserProvision {
  constructor({ bundled = null, dir = null, env = process.env, platform = hostPlatform(), allowSystem = true } = {}) {
    this.bundled = bundled
    this.dir = dir
    this.env = env
    this.platform = platform
    this.allowSystem = allowSystem
    this.downloading = null
    this.progress = null
    this.failure = null
    this.onProgress = null
  }

  /** The browser that would be launched now, or null. */
  find() {
    const explicit = this.env.MX_RIG_CHROMIUM_PATH
    if (explicit && existsSync(explicit)) return { source: 'explicit', title: '指定的 Chromium', executablePath: explicit }
    for (const [source, title, folder] of [
      ['bundled', '安装包自带的测试浏览器', this.bundled],
      ['cache', 'Playwright 的 Chromium', playwrightCache()],
      ['downloaded', '下载过的测试浏览器', this.dir]
    ]) {
      const executablePath = executableIn(folder, this.platform)
      if (executablePath && existsSync(executablePath)) return { source, title, executablePath }
    }
    if (this.allowSystem) {
      const installed = installedChannel()
      if (installed) return { source: 'system', title: `本机的 ${installed.title}`, channel: installed.channel }
    }
    return null
  }

  /** For a status line: what is used, or what is happening instead. */
  status() {
    const found = this.find()
    return {
      ready: Boolean(found),
      using: found ? { source: found.source, title: found.title } : null,
      downloading: Boolean(this.downloading),
      progress: this.progress,
      failure: this.failure,
      canDownload: Boolean(this.dir && PLATFORMS[this.platform])
    }
  }

  /**
   * Options for `chromium.launch`. With nothing on the machine, downloads
   * first — the first browser step of a fresh install waits for it.
   */
  async launchOptions() {
    let found = this.find()
    if (!found && this.dir && PLATFORMS[this.platform]) {
      await this.download()
      found = this.find()
    }
    if (!found)
      throw new RigError(
        'browser_unavailable',
        this.failure
          ? `没有可用的测试浏览器，下载也没有成功（${this.failure}）。可以安装 Google Chrome，或者设置 MX_RIG_BROWSER_MIRROR 指向可以访问的镜像后重试`
          : '没有可用的测试浏览器：请安装 Google Chrome，或者运行 npm run browser:install',
        409
      )
    return found.executablePath ? { executablePath: found.executablePath } : { channel: found.channel }
  }

  /** Download into `dir` once; callers arriving meanwhile wait for the same download. */
  download({ force = false } = {}) {
    if (!this.dir) return Promise.reject(new RigError('browser_unavailable', '没有可以下载测试浏览器的位置', 409))
    if (!force) {
      const here = executableIn(this.dir, this.platform)
      if (here && existsSync(here)) return Promise.resolve({ executablePath: here })
    }
    this.downloading ??= installChromium({
      dir: this.dir,
      platform: this.platform,
      env: this.env,
      onProgress: (progress) => {
        this.progress = progress
        this.#tell({ phase: 'downloading', ...progress })
      }
    })
      .then((result) => {
        this.failure = null
        this.progress = null
        this.downloading = null
        this.#tell({ phase: 'ready', ...this.status() })
        return result
      })
      .catch((error) => {
        this.failure = String(error?.message ?? error).split('\n')[0].slice(0, 300)
        this.progress = null
        this.downloading = null
        this.#tell({ phase: 'failed', ...this.status() })
        throw error
      })
    return this.downloading
  }

  #tell(event) {
    try {
      this.onProgress?.(event)
    } catch {
      /* Presentation only. */
    }
  }
}

/**
 * The provision a process is told about: the installer's copy in
 * MX_RIG_BUNDLED_BROWSERS, downloads into MX_RIG_BROWSERS_DIR (or `dir`).
 * A desktop passes both to the processes it starts, so they share one copy.
 */
export function provisionFromEnv(env = process.env, { dir = null } = {}) {
  return new BrowserProvision({
    bundled: env.MX_RIG_BUNDLED_BROWSERS || null,
    dir: env.MX_RIG_BROWSERS_DIR || dir,
    env
  })
}

/** One line for a terminal: where the download is, every tenth of the way. */
export function progressLine(event, last = { step: -1 }) {
  if (event.phase === 'ready') return `测试浏览器已就绪：${event.using?.title ?? 'Chromium'}`
  if (event.phase === 'failed') return `测试浏览器下载失败：${event.failure}`
  if (event.phase !== 'downloading') return null
  const step = event.total ? Math.floor((event.done / event.total) * 10) : 0
  if (step === last.step) return null
  last.step = step
  const size = event.total ? `，共 ${Math.round(event.total / 1048576)} MB` : ''
  return `正在下载测试浏览器 Chromium ${event.version}（${event.source}${size}）… ${step * 10}%`
}

/** Playwright's out-of-process downloader: fetches one URL, unpacks, marks the folder complete. */
function downloaderScript() {
  const file = join(playwrightCore(), 'lib', 'server', 'registry', 'oopDownloadBrowserMain.js')
  // In a packaged desktop the module tree is read from app.asar, but a child
  // process needs the real file next to it.
  const unpacked = file.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  return existsSync(unpacked) ? unpacked : file
}

function downloadOnce({ url, zipPath, folder, executablePath, onProgress }) {
  return new Promise((resolve) => {
    const child = fork(downloaderScript(), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)))
    child.on('message', (message) => {
      if (message?.method === 'progress') onProgress?.(message.params)
    })
    child.on('error', (error) => resolve({ error: error.message }))
    child.on('exit', (code) =>
      resolve(code === 0 && existsSync(join(folder, 'INSTALLATION_COMPLETE')) ? {} : { error: stderr.trim().split('\n')[0] || `下载进程退出码 ${code}` })
    )
    child.send({
      method: 'download',
      params: {
        title: 'Chrome for Testing',
        browserDirectory: folder,
        url,
        zipPath,
        executablePath,
        socketTimeout: 60_000,
        userAgent: 'mx-rig'
      }
    })
  })
}

/**
 * The version-matched Chromium for `platform`, into `dir` (laid out the way
 * Playwright lays it out). Each address is tried in turn.
 */
export async function installChromium({ dir, platform = hostPlatform(), env = process.env, onProgress = null } = {}) {
  const layout = PLATFORMS[platform]
  if (!layout) throw new RigError('browser_unavailable', `没有适合这台电脑（${process.platform}-${process.arch}）的测试浏览器下载`, 409)
  const { folder: name, version } = chromiumBuild()
  const folder = join(dir, name)
  const executablePath = join(folder, ...layout.executable)
  if (existsSync(join(folder, 'INSTALLATION_COMPLETE')) && existsSync(executablePath)) return { executablePath, folder }
  await mkdir(dir, { recursive: true })
  const scratch = join(tmpdir(), `mx-rig-browser-${process.pid}-${Date.now()}`)
  await mkdir(scratch, { recursive: true })
  const errors = []
  try {
    for (const url of downloadUrls(platform, env)) {
      const source = new URL(url).hostname
      onProgress?.({ source, version, done: 0, total: 0 })
      const outcome = await downloadOnce({
        url,
        zipPath: join(scratch, 'chromium.zip'),
        folder,
        // Permissions are fixed only for this machine's own executable.
        executablePath: platform === hostPlatform() ? executablePath : null,
        onProgress: ({ done, total }) => onProgress?.({ source, version, done, total })
      })
      if (!outcome.error) return { executablePath, folder, source }
      errors.push(`${source}：${outcome.error}`)
      await rm(folder, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
  throw new RigError('browser_download_failed', `测试浏览器下载失败：${errors.join('；')}`, 502)
}
