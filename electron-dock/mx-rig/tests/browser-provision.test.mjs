import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BrowserProvision,
  chromiumBuild,
  downloadUrls,
  executableIn,
  hostPlatform,
  installChromium,
  progressLine
} from '../packages/runtime/browser-provision.mjs'

// 测试浏览器从哪里来: found where it already is, or fetched once — from a
// mirror when the official CDN cannot be reached — without `npx playwright`.

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)

/** A file standing in for Chromium, where a real one would sit. */
async function fakeBrowsers(dir, platform = hostPlatform()) {
  const executable = executableIn(dir, platform)
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, '#!/bin/sh\n')
  await chmod(executable, 0o755)
  return executable
}

/** A Chrome for Testing archive with the real layout and a stand-in executable. */
async function fakeArchive(platform) {
  const { yazl } = require('playwright-core/lib/zipBundle')
  const zip = new yazl.ZipFile()
  const executable = executableIn('/', platform).split(/[\\/]/).filter(Boolean).slice(1).join('/')
  zip.addBuffer(Buffer.from('#!/bin/sh\necho chromium\n'), executable, { mode: 0o100755 })
  zip.end()
  const chunks = []
  for await (const chunk of zip.outputStream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('the build Playwright expects, and where it comes from', () => {
  const build = chromiumBuild()
  assert.match(build.revision, /^\d+$/)
  assert.equal(build.folder, `chromium-${build.revision}`)
  assert.equal(hostPlatform('darwin', 'arm64'), 'mac-arm64')
  assert.equal(hostPlatform('win32', 'x64'), 'win-x64')
  assert.equal(hostPlatform('linux', 'x64'), 'linux-x64')
  assert.equal(hostPlatform('linux', 'arm64'), null, 'no Chrome for Testing build there')
  assert.match(executableIn('/b', 'win-x64'), /chromium-\d+[\\/]chrome-win64[\\/]chrome\.exe$/)
  // The official CDN first, the China mirror second; a mirror list replaces both.
  assert.deepEqual(downloadUrls('linux-x64', {}), [
    `https://cdn.playwright.dev/builds/cft/${build.version}/linux64/chrome-linux64.zip`,
    `https://cdn.npmmirror.com/binaries/chrome-for-testing/${build.version}/linux64/chrome-linux64.zip`
  ])
  assert.deepEqual(downloadUrls('win-x64', { MX_RIG_BROWSER_MIRROR: 'https://a.example/cft/, https://b.example' }), [
    `https://a.example/cft/${build.version}/win64/chrome-win64.zip`,
    `https://b.example/${build.version}/win64/chrome-win64.zip`
  ])
  assert.equal(downloadUrls('mac-x64', { MX_RIG_BROWSER_MIRROR_ONLY: '1' }).length, 1)
  assert.equal(
    progressLine({ phase: 'downloading', source: 'cdn.npmmirror.com', version: build.version, done: 52, total: 100 }, { step: -1 }),
    `正在下载测试浏览器 Chromium ${build.version}（cdn.npmmirror.com，共 0 MB）… 50%`
  )
})

test('the installer’s own copy comes first, then one named on purpose', async () => {
  if (!hostPlatform()) return
  const bundled = await mkdtemp(join(tmpdir(), 'mx-rig-bundled-'))
  await fakeBrowsers(bundled)
  const provision = new BrowserProvision({ bundled, dir: null, env: {} })
  assert.equal(provision.find().source, 'bundled')
  assert.deepEqual(await provision.launchOptions(), { executablePath: executableIn(bundled) })
  const explicit = join(bundled, 'explicit-chrome')
  await writeFile(explicit, '')
  assert.equal(new BrowserProvision({ bundled, env: { MX_RIG_CHROMIUM_PATH: explicit } }).find().source, 'explicit')
})

test('a fresh computer downloads once, falling back to the next mirror; a failed download says why', async (t) => {
  const platform = hostPlatform()
  if (!platform) return
  const archive = await fakeArchive(platform)
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url)
    if (!req.url.startsWith('/good/')) {
      res.writeHead(404)
      return res.end('no such build')
    }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': archive.length })
    res.end(archive)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const dir = await mkdtemp(join(tmpdir(), 'mx-rig-download-'))
  const events = []
  const result = await installChromium({
    dir,
    platform,
    env: { MX_RIG_BROWSER_MIRROR: `${base}/missing,${base}/good` },
    onProgress: (event) => events.push(event)
  })
  assert.equal(result.executablePath, executableIn(dir, platform))
  assert.ok(existsSync(result.executablePath))
  assert.ok(existsSync(join(dir, chromiumBuild().folder, 'INSTALLATION_COMPLETE')))
  assert.deepEqual(
    hits.map((url) => url.split('/')[1]),
    ['missing', 'good'],
    'the mirror that failed was tried first, then the next'
  )
  assert.ok(events.some((event) => event.total === archive.length && event.done === archive.length))
  // Already there: nothing is fetched again.
  await installChromium({ dir, platform, env: { MX_RIG_BROWSER_MIRROR: `${base}/good` } })
  assert.equal(hits.length, 2)

  const nowhere = await mkdtemp(join(tmpdir(), 'mx-rig-download-'))
  await assert.rejects(installChromium({ dir: nowhere, platform, env: { MX_RIG_BROWSER_MIRROR: `${base}/missing` } }), {
    code: 'browser_download_failed',
    message: /127\.0\.0\.1/
  })
})

test('with nothing on the machine, the first browser step waits for the download, and the download is shared', async (t) => {
  if (!hostPlatform()) return
  // A process of its own: Playwright reads where its browsers are once.
  const archiveDir = await mkdtemp(join(tmpdir(), 'mx-rig-provision-'))
  const archive = await fakeArchive(hostPlatform())
  let downloads = 0
  const server = createServer((req, res) => {
    downloads += 1
    res.writeHead(200, { 'content-length': archive.length })
    res.end(archive)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const script = `
    const { BrowserProvision } = await import(${JSON.stringify(join(root, 'packages/runtime/browser-provision.mjs'))})
    const empty = new BrowserProvision({ dir: null, env: process.env, allowSystem: false })
    const none = empty.find()
    let refused = null
    try { await empty.launchOptions() } catch (error) { refused = error.code }
    const provision = new BrowserProvision({ dir: ${JSON.stringify(join(archiveDir, 'browsers'))}, env: process.env, allowSystem: false })
    const phases = []
    provision.onProgress = (event) => phases.push(event.phase)
    const before = provision.status()
    const [a, b] = await Promise.all([provision.launchOptions(), provision.launchOptions()])
    console.log(JSON.stringify({ none, refused, before, a, b, after: provision.status(), phases: [...new Set(phases)] }))
  `
  const output = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: join(archiveDir, 'empty-cache'),
          MX_RIG_BROWSER_MIRROR: `http://127.0.0.1:${server.address().port}`
        }
      },
      (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout))
    )
  )
  const seen = JSON.parse(output.trim().split('\n').at(-1))
  assert.equal(seen.none, null)
  assert.equal(seen.refused, 'browser_unavailable')
  assert.equal(seen.before.ready, false)
  assert.equal(seen.before.canDownload, true)
  assert.equal(seen.a.executablePath, executableIn(join(archiveDir, 'browsers')))
  assert.deepEqual(seen.a, seen.b)
  assert.equal(downloads, 1, 'two browser steps at once share one download')
  assert.deepEqual(seen.after.using, { source: 'downloaded', title: '下载过的测试浏览器' })
  assert.deepEqual(seen.phases, ['downloading', 'ready'])
})
