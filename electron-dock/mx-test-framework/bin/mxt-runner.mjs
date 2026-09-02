#!/usr/bin/env node
// mxt-runner — run platform tasks on your own machine.
//
// This exists for the work a Linux container cannot do: driving a packaged
// Electron app on Windows or macOS. It logs in with the same mx-launcher
// account as the web UI, asks the platform for work it is capable of, runs it,
// uploads the artifacts, and reports the result.
//
//   mxt-runner login   --server https://mxt.internal
//   mxt-runner register --name "我的开发机" --engines playwright-electron --surfaces electron
//   mxt-runner watch
//   mxt-runner once
//   mxt-runner status

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { homedir, platform, arch } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

// Where the runner keeps its credentials. Small, and belongs with the user.
const CONFIG_DIR = join(homedir(), '.mxt')
const CONFIG_FILE = join(CONFIG_DIR, 'runner.json')

/**
 * Where the runner keeps checkouts, node_modules, downloaded installers and
 * per-run artifacts — everything large.
 *
 * Deliberately separable from the config directory. Defaulting all of it to the
 * home directory puts several gigabytes per application onto the system drive,
 * which on a Windows workstation is usually the smallest one. That is not a
 * theoretical concern: the first real run of this runner filled C: to zero and
 * failed with `disk I/O error` from pnpm, which reads as a corrupt package
 * store rather than as "out of space".
 *
 * `--data-dir` for a one-off, MXT_RUNNER_DATA_DIR for a machine that should
 * always use another volume.
 */
function dataDir() {
  const chosen = argValue('data-dir') || process.env.MXT_RUNNER_DATA_DIR
  return chosen ? resolve(chosen) : CONFIG_DIR
}

const POLL_IDLE_MS = 15_000

const say = (message) => console.log(`[mxt-runner] ${message}`)
const die = (message) => {
  console.error(`[mxt-runner] ✗ ${message}`)
  process.exit(1)
}

const OS_NAME = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform()] ?? 'linux'

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1]
  }
  const inline = process.argv.find((entry) => entry.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function saveConfig(patch) {
  await mkdir(CONFIG_DIR, { recursive: true })
  const merged = { ...(await loadConfig()), ...patch }
  // Mode 0600: this file holds tokens, and a home directory is not private on
  // a shared machine.
  await writeFile(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  return merged
}

async function api(config, method, path, { body, token, raw, headers = {} } = {}) {
  const response = await fetch(`${config.server.replace(/\/$/u, '')}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
    duplex: raw ? 'half' : undefined,
  })
  if (response.status === 204) return null
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    const error = payload?.error
    throw new Error(`${error?.message ?? response.statusText}${error?.hint ? `\n  提示：${error.hint}` : ''}`)
  }
  return payload
}

// -- commands ---------------------------------------------------------------

async function cmdLogin() {
  const server = argValue('server') || (await loadConfig()).server
  if (!server) die('需要 --server https://你的测试平台地址')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const username = argValue('username') || (await rl.question('mx-launcher 账号: '))
  // Node has no portable way to mask input; say so rather than pretend.
  const password = argValue('password') || (await rl.question('密码（输入不显示是正常的，直接回车确认）: '))
  rl.close()

  const result = await api({ server }, 'POST', '/api/v1/auth/login', {
    body: { username, password },
  }).catch((error) => die(error.message))

  await saveConfig({ server, userToken: result.token, member: result.member })
  say(`✓ 已登录为 ${result.member.displayName}（权限：${result.member.role}）`)
  say('下一步：mxt-runner register --name "我的机器"')
}

async function cmdRegister() {
  const config = await loadConfig()
  if (!config.userToken) die('请先运行 mxt-runner login')
  // `--server` here would otherwise be accepted and ignored: the machine would
  // register against whatever the last `login` wrote, and the operator would
  // read "✓ 已注册" while the runner points at a different platform. Refuse
  // instead of guessing which one was meant.
  const requested = argValue('server')
  if (requested && requested.replace(/\/+$/, '') !== String(config.server).replace(/\/+$/, '')) {
    die(`当前登录的是 ${config.server}，与 --server ${requested} 不一致。
  先运行：mxt-runner login --server ${requested}`)
  }

  const name = argValue('name') || `${OS_NAME}-${process.env.USER || process.env.USERNAME || 'runner'}`
  const engines = (argValue('engines') || 'playwright-electron,playwright').split(',')
  const surfaces = (argValue('surfaces') || 'electron').split(',')

  const result = await api(config, 'POST', '/runner/v1/runners:register', {
    token: config.userToken,
    body: { name, kind: 'local', os: OS_NAME, arch: arch(), engines, surfaces },
  }).catch((error) => die(error.message))

  await saveConfig({ runnerId: result.runner.id, runnerToken: result.token, runnerName: name })
  say(`✓ 已注册执行机「${name}」(${OS_NAME}/${arch()})`)
  say(`  可执行：${engines.join(', ')} × ${surfaces.join(', ')}`)
  say('下一步：mxt-runner watch  —— 常驻等待任务')
}

async function cmdStatus() {
  const config = await loadConfig()
  if (!config.server) return say('尚未配置。先运行 mxt-runner login --server <地址>')
  say(`平台：${config.server}`)
  say(`账号：${config.member?.displayName ?? '未登录'}`)
  say(`执行机：${config.runnerName ?? '未注册'} ${config.runnerId ? `(${config.runnerId})` : ''}`)
}

/** JUnit XML the suite left behind, in the order the platform will merge it. */
async function readJunitFiles(dir) {
  let names
  try {
    names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.xml'))
  } catch {
    return []
  }
  const documents = []
  for (const name of names.slice(0, 200)) {
    try {
      documents.push(await readFile(join(dir, name), 'utf8'))
    } catch {
      // One unreadable file must not cost the rest of the results.
    }
  }
  return documents
}

/** Walk a directory and upload every file, preserving relative paths. */
async function uploadArtifacts(config, runId, runToken, dir) {
  const files = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  await walk(dir).catch(() => {})

  let uploaded = 0
  for (const file of files) {
    const relativePath = relative(dir, file).split(sep).join('/')
    const info = await stat(file)
    if (info.size === 0) continue
    try {
      await api(config, 'PUT', `/runner/v1/runs/${runId}/artifacts/${encodeURI(relativePath)}`, {
        token: runToken,
        raw: true,
        body: createReadStream(file),
        headers: { 'content-length': String(info.size) },
      })
      uploaded += 1
    } catch (error) {
      // One unreadable file must not cost the whole result.
      say(`  ! 产物 ${relativePath} 上传失败：${error.message}`)
    }
  }
  return uploaded
}

/**
 * Bring the checkout to the ref the platform asked for.
 *
 * Without this the runner could only execute in a directory somebody had
 * already prepared by hand, which makes "the nightly job ran on that machine"
 * mean "it ran on whatever happened to be checked out there". The whole value
 * of a run record is that the code it tested is identified.
 *
 * The clone is cached per app under ~/.mxt/checkouts and updated in place:
 * a fresh clone of a large repository on every run is minutes of nothing.
 */
async function prepareCheckout({ repoUrl, ref, appSlug, gitToken }) {
  if (!repoUrl) return { dir: resolve(argValue('workdir') || process.cwd()), gitSha: null }

  const dir = join(dataDir(), 'checkouts', appSlug || 'app')
  await mkdir(dir, { recursive: true })
  const git = async (args, allowFail = false) => {
    const code = await runCommand(['git', ...args], { cwd: dir, env: process.env, quiet: true })
    if (code !== 0 && !allowFail) throw new Error(`git ${args[0]} 失败（退出码 ${code}）`)
    return code
  }

  await git(['init', '-q', '.'])
  // The token stays in the environment. Writing it into the remote URL would
  // persist it in .git/config on someone's personal machine.
  if (gitToken) {
    await git([
      'config',
      'credential.helper',
      `!f() { echo username=x-access-token; echo "password=$MXT_GIT_TOKEN"; }; f`,
    ])
  }
  await git(['remote', 'remove', 'origin'], true)
  await git(['remote', 'add', 'origin', repoUrl])
  await git(['fetch', '-q', '--depth', '1', 'origin', ref || 'HEAD'])
  await git(['checkout', '-q', '-f', 'FETCH_HEAD'])
  // Anything left behind by a previous run would otherwise leak into this one.
  await git(['clean', '-qfdx', '-e', 'node_modules'], true)

  let gitSha = null
  try {
    const { execFileSync } = await import('node:child_process')
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
  } catch {
    // Not fatal: the checkout succeeded, only the label for it is missing.
  }
  return { dir, gitSha }
}

/** One lockfile, one package manager — never cross-fall-back. */
async function installDependencies(dir, env) {
  const has = async (name) => {
    try {
      await stat(join(dir, name))
      return true
    } catch {
      return false
    }
  }
  if (await has('pnpm-lock.yaml')) return runCommand(['pnpm', 'install', '--frozen-lockfile'], { cwd: dir, env })
  if (await has('package-lock.json')) return runCommand(['npm', 'ci', '--no-audit', '--no-fund'], { cwd: dir, env })
  if (await has('yarn.lock')) return runCommand(['yarn', 'install', '--frozen-lockfile'], { cwd: dir, env })
  if (await has('package.json')) {
    say('  ! package.json 没有锁文件，拒绝安装未锁定的依赖树')
    return 2
  }
  return 0
}

/**
 * Fetch the packaged application this run is meant to exercise.
 *
 * Checksum-verified because the point of testing a specific build is lost if
 * you cannot say which build it was, and because this downloads an executable
 * onto someone's own machine.
 */
// The installer is fetched with the machine's own registration token, not the
// run-scoped one.
//
// The file belongs to the *build* run, and that run's token died when it
// finished — ADR-0005 makes run tokens expire with their run precisely so a
// leaked one cannot be replayed. Sending the current run's token here produced
// `HTTP 401` and a blocked run, on a platform whose server side had this right
// all along; the server even says so in a comment. The unit test passed because
// it downloaded with the runner token, which is what real code should have
// been doing.
async function downloadPackage(config, { url, sha256, filename }) {
  const dir = join(dataDir(), 'packages')
  await mkdir(dir, { recursive: true })
  const target = join(dir, filename || 'app-package')

  say(`  下载被测安装包 ${filename ?? url}`)
  const response = await fetch(url, {
    headers: config.runnerToken ? { authorization: `Bearer ${config.runnerToken}` } : {},
  })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())

  if (sha256) {
    const { createHash } = await import('node:crypto')
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha256.toLowerCase()) {
      // Refusing is the only safe answer: this file is about to be executed.
      throw new Error(`安装包校验和不匹配（期望 ${sha256}，实际 ${actual}）`)
    }
  } else {
    say('  ! 平台没有提供 sha256，无法校验这个安装包')
  }
  await writeFile(target, bytes)
  say(`  已下载 ${(bytes.length / 1e6).toFixed(1)} MB → ${target}`)
  return target
}

/**
 * Turn a downloaded package into something `_electron.launch()` can start.
 *
 * A published package is what users receive — on Windows that is an NSIS
 * installer, not an application. Handing its path straight to Playwright makes
 * the installer's wizard appear, wait for a human, and time out sixty seconds
 * later per test with `electron.launch: Timeout exceeded` — a message that says
 * nothing about the actual cause.
 *
 * Installing here rather than testing an unpacked build is deliberate: the
 * installer is the part of a desktop release most likely to break and least
 * likely to be exercised anywhere else.
 *
 * Nothing about the target machine is assumed. The install location is derived
 * from this runner's own data directory (already per-machine), and the
 * executable inside it is *discovered* rather than named — an app's file names
 * differ per project, per version and per platform.
 */
async function preparePackage(pkg, file) {
  const key = (pkg.sha256 || '').slice(0, 12) || 'unknown'
  const root = join(dataDir(), 'apps', key)
  const marker = join(root, '.mxt-installed')

  // Installing is slow and identical every time for the same bytes, so the
  // sha256 the platform computed doubles as the cache key.
  try {
    const cached = (await readFile(marker, 'utf8')).trim()
    if (cached) {
      await stat(cached)
      say(`  复用已安装的应用 ${cached}`)
      return cached
    }
  } catch {
    // Not installed yet, or the recorded path has since been removed.
  }

  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const executable = await installPackage(file, root)
  await writeFile(marker, executable, 'utf8')
  say(`  已安装被测应用 → ${executable}`)
  return executable
}

async function installPackage(file, root) {
  const lower = file.toLowerCase()

  if (process.platform === 'win32' && lower.endsWith('.exe')) {
    // electron-builder's NSIS installer. `/S` is silent; `/D=` sets the target
    // and, per NSIS, must come last and must NOT be quoted — it consumes the
    // rest of the command line verbatim. Node would add quotes of its own, so
    // the line is built here and passed through unmodified.
    await runInstaller(`"${file}" /S /D=${root}`)
    return findExecutable(root, ['uninstall', '卸载'])
  }

  if (process.platform === 'darwin' && lower.endsWith('.dmg')) {
    // Untested — this runner has never run on a Mac ([23 §1](../specs/23-local-verification.md)).
    // Written out rather than left as a TODO so the first Mac run fails on a
    // real detail instead of on "not implemented".
    const mount = join(root, 'mnt')
    await mkdir(mount, { recursive: true })
    await runInstaller(`hdiutil attach "${file}" -nobrowse -readonly -mountpoint "${mount}"`)
    try {
      const bundle = (await readdir(mount)).find((entry) => entry.endsWith('.app'))
      if (!bundle) throw new Error('这个 .dmg 里没有找到 .app')
      await runInstaller(`cp -R "${join(mount, bundle)}" "${root}"`)
    } finally {
      await runInstaller(`hdiutil detach "${mount}"`).catch(() => {})
    }
    const app = (await readdir(root)).find((entry) => entry.endsWith('.app'))
    const macos = join(root, app, 'Contents', 'MacOS')
    const entries = await readdir(macos)
    if (entries.length !== 1) {
      throw new Error(`${macos} 里有 ${entries.length} 个可执行文件，无法确定启动哪一个：${entries.join('、')}`)
    }
    return join(macos, entries[0])
  }

  if (process.platform === 'linux' && lower.endsWith('.appimage')) {
    const target = join(root, 'app.AppImage')
    await copyFile(file, target)
    await runInstaller(`chmod +x "${target}"`)
    return target
  }

  // Refusing with the reason beats launching something that cannot start.
  throw new Error(
    `不知道怎么在 ${OS_NAME} 上安装这个包：${file}\n` +
      '  目前支持：Windows 的 NSIS .exe、macOS 的 .dmg、Linux 的 .AppImage。\n' +
      '  如果构建产物本来就能直接启动，把套件的 artifactPath 指向那个可执行文件。',
  )
}

function runInstaller(commandLine) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandLine, {
      shell: true,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      env: systemPath(process.env),
    })
    // A silent installer that is waiting for something will never finish, and a
    // hung run is harder to diagnose than a failed one.
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`安装超时（5 分钟）：${commandLine}`))
    }, 5 * 60_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`安装命令失败（退出码 ${code}）：${commandLine}`))
    })
  })
}

/** The one executable in an install directory that is the application itself. */
async function findExecutable(root, excludeWords) {
  const entries = await readdir(root, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => entry.name)
    .filter((name) => !excludeWords.some((word) => name.toLowerCase().includes(word)))

  if (candidates.length === 1) return join(root, candidates[0])
  if (candidates.length === 0) {
    throw new Error(
      `安装完成，但 ${root} 里没有可启动的程序。\n` +
        `  目录内容：${entries.map((entry) => entry.name).join('、') || '（空）'}`,
    )
  }
  // Guessing which of several executables is the app would produce a confusing
  // failure later; naming them lets a person settle it in one line.
  throw new Error(
    `安装完成，但 ${root} 里有多个可执行文件，无法确定启动哪一个：${candidates.join('、')}`,
  )
}

function runCommand(command, { cwd, env, quiet = false }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: quiet ? 'ignore' : 'inherit',
      // Windows needs a shell to resolve `pnpm` to `pnpm.cmd`. Safe because the
      // platform's allowlist rejects any argument containing shell
      // metacharacters before the command ever reaches a runner.
      shell: process.platform === 'win32',
    })
    child.on('error', (error) => {
      console.error(`[mxt-runner] 无法启动命令：${error.message}`)
      resolvePromise(2)
    })
    child.on('close', (code) => resolvePromise(code ?? 2))
  })
}

/**
 * Copy the file a build suite produced into the run's artifact directory.
 *
 * The glob comes from the suite, so the repository under test needs no change:
 * `dist/electron/Packaged/*.exe` is where electron-builder already puts it.
 *
 * Exactly one match is required. "Which .exe did we test" has to have one
 * answer, and picking the first alphabetically would answer it differently
 * after a version bump.
 */
async function collectBuildArtifact({ workDir, pattern, artifactsDir }) {
  if (!pattern) throw new Error('这条 build suite 没有配置 artifactPath，不知道去哪里找产物')

  const segments = pattern.split('/').filter(Boolean)
  const globPart = segments.pop()
  const searchDir = resolve(workDir, segments.join('/'))
  if (!searchDir.startsWith(resolve(workDir))) {
    throw new Error(`artifactPath 指向了工作目录之外：${pattern}`)
  }

  // Only `*` is supported, which is what electron-builder output paths need.
  // A full glob implementation here would be a dependency and a surface area
  // for surprises, in exchange for cases nobody has asked for.
  const quote = (part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const matcher = new RegExp(`^${globPart.split('*').map(quote).join('.*')}$`, 'u')

  let entries
  try {
    entries = (await readdir(searchDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && matcher.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    throw new Error(`产物目录不存在：${searchDir}`)
  }

  if (entries.length === 0) return null
  if (entries.length > 1) {
    throw new Error(`artifactPath 匹配到 ${entries.length} 个文件，无法确定哪个是安装包：${entries.join('、')}`)
  }

  const target = join(artifactsDir, 'package')
  await mkdir(target, { recursive: true })
  await copyFile(join(searchDir, entries[0]), join(target, entries[0]))
  return entries[0]
}

/**
 * The environment a test command runs in, with the operating system's own
 * directories guaranteed to be on PATH.
 *
 * A runner is a machine-level agent and gets started from whatever shell
 * happens to be handy — a service wrapper, a scheduled task, Git Bash. Some of
 * those hand down a PATH that omits `System32\WindowsPowerShell`, and the
 * failure that produces is `spawn powershell.exe ENOENT` raised from inside
 * Cypress, several layers below anything the reader was looking at. It reads as
 * a broken test, not as a broken PATH.
 *
 * Appended rather than prepended: whatever the operator put on PATH still wins.
 */
function systemPath(env) {
  if (process.platform !== 'win32') return { ...env }
  // join() rather than template strings with backslashes: a literal `\v` in a
  // template is a vertical tab, which turns the PowerShell directory into a
  // path that silently does not exist.
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  const required = [
    join(root, 'System32'),
    root,
    join(root, 'System32', 'Wbem'),
    join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
  ]
  // Windows environment variables are case-insensitive; Node preserves whatever
  // casing the parent used, so find the real key rather than assuming `PATH`.
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
  const current = env[key] ?? ''
  const have = new Set(current.split(';').map((entry) => entry.trim().toLowerCase()).filter(Boolean))
  const missing = required.filter((entry) => !have.has(entry.toLowerCase()))
  if (missing.length === 0) return { ...env }
  return { ...env, [key]: [current, ...missing].filter(Boolean).join(';') }
}

async function executeOnce(config) {
  const claimed = await api(config, 'POST', '/runner/v1/runs:claim', {
    token: config.runnerToken,
    body: { runnerId: config.runnerId },
  })
  if (!claimed) return false

  const { runId, command, env, runToken } = claimed
  say(`▶ 认领 ${runId}（${claimed.suite.slug}）`)

  const artifactsRoot = join(dataDir(), 'artifacts')
  const artifactsDir = join(artifactsRoot, runId)
  await rm(artifactsDir, { recursive: true, force: true })
  await mkdir(artifactsDir, { recursive: true })

  const childEnv = {
    ...systemPath(process.env),
    ...env,
    MXT_ARTIFACTS_DIR: artifactsDir,
    // A root, not the run directory. compass appends E2E_RUN_ID to it; passing
    // the run directory made it write to `<runId>/<runId>` and the platform
    // then found no summary.json.
    E2E_ARTIFACTS_DIR: artifactsRoot,
  }
  const heartbeat = setInterval(() => {
    api(config, 'POST', `/runner/v1/runs/${runId}/heartbeat`, { token: runToken }).catch(() => {})
  }, 60_000)
  heartbeat.unref?.()

  let exitCode = 2
  let blockedReason = null
  let gitSha = null
  try {
    // Everything up to the test command is infrastructure: if any of it fails
    // the run is `blocked`, not a red test. Confusing the two is how a team
    // learns to ignore red.
    const checkout = await prepareCheckout({
      repoUrl: claimed.app?.repoUrl ?? null,
      ref: claimed.sourceRef ?? null,
      appSlug: env.MXT_APP,
      gitToken: process.env.MXT_GIT_TOKEN,
    })
    gitSha = checkout.gitSha
    if (gitSha) say(`  检出 ${claimed.sourceRef ?? 'HEAD'} @ ${gitSha.slice(0, 12)}`)

    // The suite's workingDir is the project root inside the checkout, so one
    // runner can serve several suites of a monorepo.
    const workDir = claimed.suite?.workingDir
      ? resolve(checkout.dir, claimed.suite.workingDir)
      : checkout.dir
    if (!workDir.startsWith(checkout.dir)) {
      throw new Error(`suite 的 workingDir 指向了检出目录之外：${claimed.suite.workingDir}`)
    }

    if (claimed.appPackage?.url) {
      // Desktop suites test a built installer, not the source tree. The path is
      // handed to the suite so its spec can launch exactly this build.
      const downloaded = await downloadPackage(config, claimed.appPackage)
      // What the suite gets is a launchable application, not the delivery
      // format it arrived in.
      childEnv.MXT_APP_PATH = await preparePackage(claimed.appPackage, downloaded)
    }

    if (claimed.app?.repoUrl) {
      const installCode = await installDependencies(workDir, childEnv)
      if (installCode !== 0) throw new Error(`依赖安装失败（退出码 ${installCode}）`)
    }

    if (!command || command.length === 0) {
      throw new Error('这条 suite 没有配置执行命令')
    }

    // Credentials for the application under test, fetched with the run-scoped
    // token. Merged into the child's environment only — never printed, never
    // written to disk, and gone when the process exits. A failure here is
    // `blocked`: a suite that asked for a password and started without it fails
    // inside a login form, and the report would blame the login page.
    const secrets = await api(config, 'GET', `/runner/v1/runs/${runId}/secrets`, {
      token: runToken,
    }).catch((error) => {
      throw new Error(`无法获取被测应用的密钥：${error.message}`)
    })
    const secretCount = Object.keys(secrets?.secrets ?? {}).length
    if (secretCount > 0) {
      Object.assign(childEnv, secrets.secrets)
      say(`  已注入 ${secretCount} 个密钥`)
    }

    say(`  执行：${command.join(' ')}（工作目录 ${workDir}）`)
    exitCode = await runCommand(command, { cwd: workDir, env: childEnv })

    // A build suite produces a file, not a result. Copy it where the platform
    // looks so the normal artifact upload carries it — the platform hashes what
    // it receives rather than trusting a digest computed here.
    if (exitCode === 0 && claimed.suite?.kind === 'build') {
      const collected = await collectBuildArtifact({
        workDir,
        pattern: claimed.suite.artifactPath,
        artifactsDir,
      })
      say(collected ? `  已收集产物 ${collected}` : '  ! 构建命令成功，但没有匹配到产物')
    }
  } catch (error) {
    blockedReason = error.message
    exitCode = 2
    say(`  ⚠ ${blockedReason}`)
  }
  clearInterval(heartbeat)

  const count = await uploadArtifacts(config, runId, runToken, artifactsDir)
  if (count > 0) say(`  已上传 ${count} 个产物`)

  const body = { exitCode }
  let summary = null
  try {
    summary = JSON.parse(await readFile(join(artifactsDir, 'summary.json'), 'utf8'))
  } catch {
    // Not an error yet — the suite may have written JUnit instead, which is the
    // format every framework can produce without knowing this platform exists.
  }
  if (summary) {
    body.summary = summary
  } else {
    const junit = await readJunitFiles(join(artifactsDir, 'junit'))
    if (junit.length > 0) {
      body.junit = junit
    } else {
      // Reporting nothing is itself a result. Leaving the run to time out would
      // give the run page no explanation at all.
      body.summary = {
        schemaVersion: 2,
        runId,
        app: env.MXT_APP,
        status: 'blocked',
        totals: { tests: 0 },
        blockedReason: blockedReason || '执行结束但既没有 summary.json 也没有 junit/*.xml',
      }
    }
  }
  if (gitSha) {
    // Reported at the top level, not only inside the summary.
    //
    // A `kind: build` run has no summary at all, so the previous
    // `gitSha && body.summary` guard silently dropped the provenance for
    // exactly the runs where it matters most: the installer that comes out is
    // handed to testers, and "which commit is this 200 MB file" has to be
    // answerable. It was recorded as `{}`.
    body.sourceRef = { ref: claimed.sourceRef ?? null, gitSha }
    if (body.summary) body.summary.sourceRef = { ...(body.summary.sourceRef || {}), ...body.sourceRef }
  }

  const result = await api(config, 'POST', `/runner/v1/runs/${runId}:complete`, {
    token: runToken,
    body,
  })
  const label = { passed: '✓ 通过', failed: '✗ 失败', blocked: '⚠ 受阻', flaky: '~ 不稳定' }
  say(`${label[result.run.status] ?? result.run.status}  ${config.server}/runs/${runId}`)
  return true
}

async function cmdWatch({ once = false } = {}) {
  const config = await loadConfig()
  if (!config.runnerToken) die('请先运行 mxt-runner register')

  say(`等待任务中（${config.runnerName}）。Ctrl-C 退出。`)
  let stop = false
  process.on('SIGINT', () => {
    stop = true
    say('收到退出信号，当前任务完成后停止。')
  })

  while (!stop) {
    let worked = false
    try {
      worked = await executeOnce(config)
    } catch (error) {
      say(`! ${error.message}`)
    }
    if (once) return
    if (!worked && !stop) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_IDLE_MS))
    }
  }
}

const usage = `mxt-runner — 在自己的电脑上执行测试平台派发的任务

  mxt-runner login --server <平台地址>   用 mx-launcher 账号登录
  mxt-runner register --name <名字>      把这台机器注册为执行机
      --engines  默认 playwright-electron,playwright
      --surfaces 默认 electron
  mxt-runner watch [--workdir <目录>]    常驻认领任务
  mxt-runner once  [--workdir <目录>]    只取一个任务
  mxt-runner status                      看当前配置

配置保存在 ~/.mxt/runner.json（权限 0600）。

检出、依赖、被测安装包和产物默认也放在 ~/.mxt —— 那是主目录，
Windows 上通常是系统盘，一个应用就要几 GB。用别的盘：

  mxt-runner watch --data-dir E:/mxt-runner
  # 或永久设置 MXT_RUNNER_DATA_DIR=E:/mxt-runner
`

const command = process.argv[2]
try {
  if (command === 'login') await cmdLogin()
  else if (command === 'register') await cmdRegister()
  else if (command === 'watch') await cmdWatch()
  else if (command === 'once') await cmdWatch({ once: true })
  else if (command === 'status') await cmdStatus()
  else console.log(usage)
} catch (error) {
  die(error.message)
}
