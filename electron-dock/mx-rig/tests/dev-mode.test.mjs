import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevMode } from '../scripts/dev-mode.mjs'
import { buildArches, resourceArches, targetPlatform } from '../scripts/package-targets.mjs'

// Local Launcher packages for development, the published ones for every
// build (scripts/dev-mode.mjs, after mx-launcher's dev-mode). package.json and
// package-lock.json never change; only what node_modules points at.

const PKG = { name: '@qpjoy/electron-launcher', dir: 'mono/launcher', outputs: ['dist/index.js'] }

async function fixture(t, { lock = '2.3.19', installed = '2.3.19', workspace = '2.3.20', built = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'mx-rig-dev-mode-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'rig')
  const npmCopy = join(root, 'node_modules', '@qpjoy', 'electron-launcher')
  mkdirSync(npmCopy, { recursive: true })
  writeFileSync(join(npmCopy, 'package.json'), JSON.stringify({ name: PKG.name, version: installed }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@qpjoy/electron-launcher': { version: lock } } }))
  const source = join(base, 'mono', 'launcher')
  mkdirSync(join(source, 'dist'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: PKG.name, version: workspace }))
  if (built) writeFileSync(join(source, 'dist', 'index.js'), 'export {}')
  const runs = []
  const logs = []
  const devMode = createDevMode({
    root,
    monorepo: base,
    packages: [PKG],
    run: (command, args, cwd) => {
      runs.push([command, ...args].join(' '))
      // npm install restores the locked copy.
      if (command === 'npm') {
        mkdirSync(npmCopy, { recursive: true })
        writeFileSync(join(npmCopy, 'package.json'), JSON.stringify({ name: PKG.name, version: lock }))
      }
    },
    log: (line) => logs.push(line)
  })
  return { base, root, source, npmCopy, runs, logs, devMode }
}

test('local links the workspace package and keeps the npm copy; npm puts it back, checked', async (t) => {
  const f = await fixture(t)
  mkdirSync(join(f.base, 'electron-dock', 'mx-launcher', 'node_modules'), { recursive: true })
  f.devMode.useLocal()
  assert.ok(lstatSync(f.npmCopy).isSymbolicLink())
  assert.equal(realpathSync(f.npmCopy), realpathSync(f.source))
  assert.deepEqual(f.runs, ['pnpm --filter @qpjoy/electron-launcher... build'], 'built with what it depends on')
  assert.equal(f.devMode.current(), 'local')
  assert.equal(JSON.parse(readFileSync(join(f.root, '.dev-mode.json'), 'utf8')).mode, 'local')
  assert.equal(f.devMode.status()[0].workspaceVersion, '2.3.20')
  f.devMode.useNpm()
  assert.equal(lstatSync(f.npmCopy).isSymbolicLink(), false)
  assert.equal(JSON.parse(readFileSync(join(f.npmCopy, 'package.json'), 'utf8')).version, '2.3.19', 'the npm copy itself, not a reinstall')
  assert.equal(f.runs.length, 1, 'no npm install needed: the copy was kept')
  assert.equal(f.devMode.current(), 'npm')
  assert.ok(f.logs.some((line) => /2\.3\.20，比打包用的 2\.3\.19 新/.test(line)), 'a newer unreleased workspace version is pointed out')
  // Again, without building: the switch back after a build.
  f.devMode.useLocal({ build: false })
  assert.equal(f.runs.length, 1)
  assert.equal(f.devMode.current(), 'local')
  // A build's temporary switch leaves the developer's choice recorded.
  f.devMode.useNpm({ remember: false })
  assert.equal(f.devMode.current(), 'npm')
  assert.equal(f.devMode.recorded(), 'local', 'an interrupted build still knows to go back')
})

test('npm mode restores from the lockfile when the copy is gone, and refuses a mismatch', async (t) => {
  const gone = await fixture(t)
  await rm(gone.npmCopy, { recursive: true })
  gone.devMode.useNpm()
  assert.deepEqual(gone.runs, ['npm install --prefer-offline --no-audit --no-fund'])
  assert.equal(gone.devMode.status()[0].version, '2.3.19')
  const wrong = await fixture(t, { installed: '2.3.18' })
  assert.throws(() => wrong.devMode.useNpm(), /装的是 2\.3\.18，package-lock 是 2\.3\.19/)
})

test('local mode needs the whole repository and a complete build', async (t) => {
  const unbuilt = await fixture(t, { built: false })
  mkdirSync(join(unbuilt.base, 'electron-dock', 'mx-launcher', 'node_modules'), { recursive: true })
  assert.throws(() => unbuilt.devMode.useLocal(), /本地构建不完整：缺少 dist\/index\.js/)
  assert.equal(lstatSync(unbuilt.npmCopy).isSymbolicLink(), false, 'nothing is swapped before the build is there')
  const alone = await fixture(t)
  await rm(alone.source, { recursive: true })
  assert.throws(() => alone.devMode.useLocal(), /需要整个仓库/)
  // The workspace never installed: installed first, once.
  const fresh = await fixture(t)
  fresh.devMode.useLocal()
  assert.equal(fresh.runs[0], 'pnpm install --prefer-offline --frozen-lockfile=false')
  assert.ok(existsSync(join(fresh.root, '.dev-mode.json')))
})

test('which installers one package command makes', () => {
  const flags = (...names) => new Set(names)
  assert.equal(targetPlatform(flags(), 'darwin'), 'mac')
  assert.equal(targetPlatform(flags('win'), 'darwin'), 'win')
  assert.throws(() => targetPlatform(flags('mac', 'win')), /一次只打一个平台/)
  assert.deepEqual(buildArches('mac', flags('all'), 'arm64'), ['arm64', 'x64', 'universal'])
  assert.deepEqual(buildArches('win', flags('all'), 'arm64'), ['x64'])
  assert.deepEqual(buildArches('mac', flags('x64', 'universal'), 'arm64'), ['x64', 'universal'])
  assert.deepEqual(buildArches('mac', flags(), 'arm64'), ['arm64'])
  assert.deepEqual(buildArches('win', flags(), 'arm64'), ['x64'], 'Windows is x64 even when built on an Arm machine')
  assert.throws(() => buildArches('win', flags('universal')), /Windows 只出 x64/)
  assert.throws(() => buildArches('win', flags('arm64')), /Windows 只出 x64/)
  assert.deepEqual(resourceArches('universal'), ['arm64', 'x64'])
  assert.deepEqual(resourceArches('x64'), ['x64'])
})
