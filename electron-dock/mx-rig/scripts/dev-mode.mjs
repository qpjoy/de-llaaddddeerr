#!/usr/bin/env node
// 开发用本地包，打包用已发布的包（参考 mx-launcher 的 dev-mode，docs/18）。
//
//   node scripts/dev-mode.mjs local    开发：用本仓库里的 Launcher 包（先构建）
//   node scripts/dev-mode.mjs npm      发布：用 package-lock.json 锁定的 npm 版本
//   node scripts/dev-mode.mjs status   现在用的是哪一份
//   node scripts/dev-mode.mjs ensure   按记录的模式重新摆好
//
// Rig imports two packages from the Launcher monorepo at run time:
// @qpjoy/electron-launcher (network, updates) and @qpjoy/electron-core-mihomo
// (the overseas channel). Their package.json files use `workspace:` versions,
// which npm cannot install, so Rig never points package.json at them. Local
// mode instead puts a link in node_modules/@qpjoy/<name> to the built
// workspace package, and keeps the npm copy aside; npm mode puts the npm copy
// back and checks it is the version package-lock.json pins. package.json and
// package-lock.json never change, so a commit is always a release build.
//
// scripts/package.mjs switches to npm mode by itself and returns to local
// afterwards: an installer is always built from published packages.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MONOREPO = resolve(ROOT, '..', '..')

/** The packages that have a local workspace source, and what must be built there. */
export const PACKAGES = Object.freeze([
  {
    name: '@qpjoy/electron-launcher',
    dir: 'electron-dock/mx-launcher/packages/electron-launcher',
    outputs: ['dist/index.js', 'dist/application-updater.js', 'dist/asar-bootstrap.cjs', 'dist/oversea.js']
  },
  {
    name: '@qpjoy/electron-core-mihomo',
    dir: 'electron-plugin/packages/electron-core-mihomo',
    outputs: ['dist/index.js']
  }
])

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
const exists = (path) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** A newer workspace version than the one shipped is worth saying out loud. */
function newer(left, right) {
  const parts = (value) => String(value ?? '').split(/[.+-]/).slice(0, 3).map(Number)
  const [a, b] = [parts(left), parts(right)]
  for (let i = 0; i < 3; i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return false
}

export function createDevMode({
  root = ROOT,
  monorepo = MONOREPO,
  packages = PACKAGES,
  run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }),
  log = (line) => console.log(`[dev-mode] ${line}`)
} = {}) {
  const sentinel = join(root, '.dev-mode.json')
  const stashRoot = join(root, 'node_modules', '.mx-rig-dev-mode')
  const installed = (pkg) => join(root, 'node_modules', ...pkg.name.split('/'))
  const stashed = (pkg) => join(stashRoot, pkg.name.replace('/', '+'))
  const source = (pkg) => join(monorepo, pkg.dir)
  const lockVersion = (pkg) => {
    try {
      return readJson(join(root, 'package-lock.json')).packages?.[`node_modules/${pkg.name}`]?.version ?? null
    } catch {
      return null
    }
  }
  const versionAt = (dir) => {
    try {
      return readJson(join(dir, 'package.json')).version ?? null
    } catch {
      return null
    }
  }
  const remember = (mode) => writeFileSync(sentinel, `${JSON.stringify({ mode, at: new Date().toISOString() }, null, 2)}\n`)

  /** What each package resolves to now. */
  function status() {
    return packages.map((pkg) => {
      const path = installed(pkg)
      const local = isLink(path)
      return {
        name: pkg.name,
        mode: local ? 'local' : exists(path) ? 'npm' : 'missing',
        version: versionAt(path),
        lockVersion: lockVersion(pkg),
        workspaceVersion: versionAt(source(pkg)),
        source: local ? resolve(dirname(path), readlinkSync(path)) : null
      }
    })
  }

  /** The mode in effect: local only if every package is linked. */
  function current() {
    const modes = status().map((entry) => entry.mode)
    return modes.every((mode) => mode === 'local') ? 'local' : modes.some((mode) => mode === 'local') ? 'mixed' : 'npm'
  }

  function recorded() {
    try {
      return readJson(sentinel).mode === 'local' ? 'local' : 'npm'
    } catch {
      return 'npm'
    }
  }

  /**
   * Development: link the workspace packages, built first unless told not to.
   * `remember: false` is a build's temporary switch: the developer's chosen
   * mode stays what .dev-mode.json says, even if the build is interrupted.
   */
  function useLocal({ build = true, remember: keep = true } = {}) {
    const missing = packages.filter((pkg) => !existsSync(join(source(pkg), 'package.json')))
    if (missing.length)
      throw new Error(`本地包模式需要整个仓库（${missing.map((pkg) => pkg.dir).join('、')} 不在）；只有 mx-rig 时用 npm 模式`)
    if (build) {
      const launcher = join(monorepo, 'electron-dock', 'mx-launcher')
      if (!existsSync(join(launcher, 'node_modules'))) run('pnpm', ['install', '--prefer-offline', '--frozen-lockfile=false'], launcher)
      // Each package with the workspace packages it depends on, in order.
      for (const pkg of packages) run('pnpm', ['--filter', `${pkg.name}...`, 'build'], launcher)
    }
    for (const pkg of packages) {
      const absent = pkg.outputs.filter((file) => !existsSync(join(source(pkg), file)))
      if (absent.length) throw new Error(`${pkg.name} 的本地构建不完整：缺少 ${absent.join('、')}`)
    }
    for (const pkg of packages) {
      const path = installed(pkg)
      if (isLink(path)) rmSync(path)
      else if (exists(path)) {
        mkdirSync(stashRoot, { recursive: true })
        rmSync(stashed(pkg), { recursive: true, force: true })
        renameSync(path, stashed(pkg))
      }
      mkdirSync(dirname(path), { recursive: true })
      // A junction needs no administrator on Windows.
      symlinkSync(source(pkg), path, process.platform === 'win32' ? 'junction' : 'dir')
      log(`${pkg.name} → 本地 ${pkg.dir}（${versionAt(source(pkg))}）`)
    }
    if (keep) remember('local')
    return status()
  }

  /** Release: the npm copies package-lock.json pins, checked. */
  function useNpm({ remember: keep = true } = {}) {
    let restore = false
    for (const pkg of packages) {
      const path = installed(pkg)
      if (isLink(path)) rmSync(path)
      if (!exists(path)) {
        if (existsSync(stashed(pkg))) renameSync(stashed(pkg), path)
        else restore = true
      }
    }
    if (restore) run('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], root)
    const wrong = []
    for (const entry of status()) {
      if (entry.mode !== 'npm' || !entry.lockVersion || entry.version !== entry.lockVersion)
        wrong.push(`${entry.name}（装的是 ${entry.version ?? '无'}，package-lock 是 ${entry.lockVersion ?? '无'}）`)
      else log(`${entry.name} → npm ${entry.version}`)
      if (entry.workspaceVersion && newer(entry.workspaceVersion, entry.lockVersion))
        log(`注意：本仓库的 ${entry.name} 是 ${entry.workspaceVersion}，比打包用的 ${entry.lockVersion} 新；要带上它，先发布再更新 package.json`)
    }
    if (wrong.length) throw new Error(`npm 包和 package-lock.json 不一致：${wrong.join('；')}。运行 npm ci 后再试`)
    if (keep) remember('npm')
    return status()
  }

  return { status, current, recorded, useLocal, useNpm }
}

// -- the command ------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'status'
  const devMode = createDevMode()
  try {
    if (mode === 'local') devMode.useLocal({ build: !process.argv.includes('--no-build') })
    else if (mode === 'npm') devMode.useNpm()
    else if (mode === 'ensure') devMode.recorded() === 'local' ? devMode.useLocal() : devMode.useNpm()
    else if (mode !== 'status') throw new Error('用法：node scripts/dev-mode.mjs local | npm | status | ensure')
    for (const entry of devMode.status())
      console.log(
        `${entry.name}: ${entry.mode === 'local' ? `本地 ${entry.workspaceVersion}` : entry.mode === 'npm' ? `npm ${entry.version}` : '未安装'}` +
          `（package-lock ${entry.lockVersion ?? '—'}，仓库 ${entry.workspaceVersion ?? '—'}）`
      )
  } catch (error) {
    console.error(`[dev-mode] ${error.message}`)
    process.exit(1)
  }
}
