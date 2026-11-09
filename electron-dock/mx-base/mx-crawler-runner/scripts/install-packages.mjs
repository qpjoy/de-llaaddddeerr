#!/usr/bin/env node
// Prepare every reviewed package to run: verify its tree hash and its
// vendored upstreams, create its Python environment from its lock (the
// package's own requirements.lock.txt or a reviewed override; packages with
// identical locks share one environment), install the Google Play Node
// backend from its package-lock.json, then run the package's offline adapter
// tests on this OS. Used by the Dockerfile and for local runs. Python 3.13 is
// what the supplier validated every package on.
//
//   node scripts/install-packages.mjs [--python python3.13] [--venvs DIR]
//     [--index-url URL] [--npm-registry URL] [--only market-195,...] [--skip-tests]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadCatalog, pythonPath, treeHash } from '../src/catalog.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    python: { type: 'string', default: 'python3.13' },
    venvs: { type: 'string', default: join(root, '.venvs') },
    'index-url': { type: 'string' },
    'npm-registry': { type: 'string' },
    only: { type: 'string' },
    'skip-tests': { type: 'boolean', default: false },
  },
})

const run = (command, args, options = {}) => {
  console.log(`$ ${[command, ...args].join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) {
    console.error(`failed (${result.status ?? result.signal ?? result.error?.code})`)
    process.exit(1)
  }
}

const slots = loadCatalog(join(root, 'packages.json'))
const only = values.only ? new Set(values.only.split(',')) : null
const venvRoot = resolve(values.venvs)
mkdirSync(venvRoot, { recursive: true })
const pipIndex = values['index-url'] ? ['--index-url', values['index-url']] : []
const prepared = new Set()

for (const slot of slots.values()) {
  if (only && !only.has(slot.slotId)) continue
  console.log(`\n== ${slot.slotId} (${slot.label}, package ${slot.packageId})`)
  const { sha256 } = treeHash(slot.root)
  if (sha256 !== slot.sha256) { console.error(`integrity mismatch: ${sha256} != ${slot.sha256}`); process.exit(1) }
  for (const upstream of slot.upstreams) {
    if (treeHash(upstream.root).sha256 !== upstream.sha256) { console.error(`upstream ${upstream.id} does not match packages.json`); process.exit(1) }
  }
  if (slot.interpreter !== 'python') continue

  const lock = readFileSync(slot.requirements)
  const venv = join(venvRoot, `py-${createHash('sha256').update(values.python).update('\0').update(lock).digest('hex').slice(0, 16)}`)
  if (!prepared.has(venv)) {
    if (!existsSync(join(venv, 'bin', 'python'))) run(values.python, ['-m', 'venv', venv])
    // --no-deps: the lock is the complete, reviewed dependency set.
    const requirements = lock.toString('utf8').split('\n').some(line => line.trim() && !line.trim().startsWith('#'))
    if (requirements) {
      run(join(venv, 'bin', 'python'), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-deps', '--prefer-binary',
        ...pipIndex, '-r', slot.requirements])
    }
    run(join(venv, 'bin', 'python'), ['-m', 'pip', 'check', '--disable-pip-version-check'])
    prepared.add(venv)
  }
  const link = join(slot.root, '.venv')
  if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink() } catch { return false } })()) rmSync(link, { recursive: true, force: true })
  symlinkSync(relative(slot.root, venv), link)

  const env = { ...process.env, PYTHONPATH: pythonPath(slot), PYTHONDONTWRITEBYTECODE: '1' }
  if (slot.inject.runtime_dir) {
    // Google Play: the package's own installer runs `npm ci --ignore-scripts`
    // against its package-lock.json into .runtime/<source fingerprint>.
    if (values['npm-registry']) env.npm_config_registry = values['npm-registry']
    run(join(slot.root, '.venv', 'bin', 'python'), ['-m', 'mingxi_google_play.runtime', '--runtime-dir', join(slot.root, '.runtime')], { cwd: slot.root, env })
  }
  if (!values['skip-tests']) {
    // The adapter tests mock the SDK, so also import every vendored upstream
    // package with this environment: a dependency missing from the lock
    // fails here, at build time, not on the first real call.
    const modules = slot.upstreams.flatMap(upstream => readdirSync(upstream.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(upstream.root, entry.name, '__init__.py'))).map(entry => entry.name))
    if (modules.length) run(join(slot.root, '.venv', 'bin', 'python'), ['-c', modules.map(name => `import ${name}`).join('; ')], { cwd: slot.root, env })
    // Offline adapter contract tests only; nothing here reaches the network.
    run(join(slot.root, '.venv', 'bin', 'python'), ['-m', 'unittest', 'discover', '-s', 'tests', '-p', slot.tests], { cwd: slot.root, env })
  }
}
console.log('\nall selected packages are installed and verified')
