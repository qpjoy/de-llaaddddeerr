// The Compass source snapshot this QA version is pinned to, made runnable.
//
// The snapshot is Rig's own copy of one commit (never the developer's
// checkout). Running it adds only build output that Git ignores — node_modules
// and dist — and the tracked files are checked before every run: a snapshot
// whose sources changed is not the commit the result would claim to be about.
// The build points the app at an `.invalid` API host, and the cases answer
// every API call themselves.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { FAKE_API_ORIGIN } from './network.mjs'

export class Blocked extends Error {}

function run(command, args, { cwd, env = {}, log, quiet = false }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32'
    })
    let output = ''
    const take = (data) => {
      const text = data.toString('utf8')
      output = (output + text).slice(-20_000)
      if (!quiet) for (const line of text.split('\n')) if (line.trim()) log?.(`    ${line.trimEnd()}`)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', () => resolvePromise({ code: 127, output }))
    child.on('close', (code) => resolvePromise({ code, output }))
  })
}

const git = (dir, args) =>
  run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', dir, ...args], {
    cwd: dir,
    env: { GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0' },
    quiet: true
  })

/** Find the snapshot of `commit`: RIG_SOURCE_DIR, or the project's workspace on this machine. */
export async function findSnapshot({ app, commit }) {
  if (process.env.RIG_SOURCE_DIR) return resolve(process.env.RIG_SOURCE_DIR)
  const workspaces = process.env.MXT_PROJECT_WORKSPACES
  if (!workspaces)
    throw new Blocked('这台电脑没有 Rig 测试项目工作区（MXT_PROJECT_WORKSPACES 未设置）。对快照运行只能在持有快照的电脑上进行。')
  const root = join(resolve(workspaces), app, 'source')
  const entries = await readdir(root).catch(() => [])
  for (const entry of entries) {
    const meta = await readFile(join(root, entry, '.rig-snapshot.json'), 'utf8').then(JSON.parse, () => null)
    if (meta?.commit === commit) return join(root, entry)
  }
  throw new Blocked(`这台电脑没有 ${commit.slice(0, 7)} 的源码快照。先在桌面端为这个项目建立快照。`)
}

/** The snapshot is the pinned commit, with every tracked file as committed. */
export async function verifySnapshot(dir, commit) {
  const head = await git(dir, ['rev-parse', 'HEAD'])
  if (head.code !== 0) throw new Blocked(`快照目录不是 Git 检出：${dir}`)
  if (head.output.trim() !== commit)
    throw new Blocked(`快照是 ${head.output.trim().slice(0, 7)}，这个 QA 版本固定的是 ${commit.slice(0, 7)}`)
  const status = await git(dir, ['status', '--porcelain', '--untracked-files=no'])
  if (status.code !== 0 || status.output.trim())
    throw new Blocked('快照里有被改动的源码文件；Rig 不会在改过的源码上运行。请重新建立快照。')
}

const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Install dependencies (offline first) and build the SPA against the fake API host, once per commit. */
export async function prepareBuild(projectDir, { commit, log }) {
  const lock = await readFile(join(projectDir, 'pnpm-lock.yaml'), 'utf8').catch(() => null)
  if (!lock) throw new Blocked('快照里没有 pnpm-lock.yaml，无法按锁定版本安装依赖')
  const installed = await readFile(join(projectDir, 'node_modules', '.rig-install'), 'utf8').catch(() => '')
  if (installed !== digest(lock)) {
    log('  安装快照依赖（优先使用本机缓存，不执行安装脚本）')
    // No install scripts: the web build needs neither the Electron download
    // nor a native rebuild, and a snapshot's scripts are not ours to run.
    const result = await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline'], { cwd: projectDir, log, quiet: true })
    if (result.code === 127) throw new Blocked('这台电脑没有 pnpm；安装 pnpm 后再运行')
    if (result.code !== 0) throw new Blocked(`快照依赖安装失败：${result.output.trim().split('\n').slice(-3).join(' ')}`)
    await writeFile(join(projectDir, 'node_modules', '.rig-install'), digest(lock))
  }
  const marker = JSON.stringify({ commit, api: FAKE_API_ORIGIN, mode: 'rig-mock' })
  const built = await readFile(join(projectDir, 'dist', 'spa', '.rig-build'), 'utf8').catch(() => '')
  if (built !== marker) {
    log('  构建快照（Web，接口指向不可解析的假地址）')
    const result = await run(join(projectDir, 'node_modules', '.bin', 'quasar'), ['build'], {
      cwd: projectDir,
      env: {
        COMPASS_ENV: 'development',
        VITE_API_BASE_URL: FAKE_API_ORIGIN,
        VITE_API_PROXY_TARGET: FAKE_API_ORIGIN,
        BROWSER: 'none'
      },
      log,
      quiet: true
    })
    if (result.code !== 0) throw new Blocked(`快照构建失败：${result.output.trim().split('\n').slice(-4).join(' ')}`)
    await writeFile(join(projectDir, 'dist', 'spa', '.rig-build'), marker)
  }
  return join(projectDir, 'dist', 'spa')
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

/** Serve the built SPA on a loopback port, with history-mode fallback to index.html. */
export async function serveStatic(root) {
  const base = resolve(root)
  const server = createServer(async (request, response) => {
    let path = '/'
    try {
      path = normalize(decodeURIComponent(new URL(request.url, 'http://local').pathname))
    } catch {
      /* a malformed path gets the app shell */
    }
    let file = resolve(base, `.${path}`)
    if (!(file === base || file.startsWith(base + sep))) file = join(base, 'index.html')
    const info = await stat(file).catch(() => null)
    if (!info || info.isDirectory()) file = join(base, 'index.html')
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }
}
