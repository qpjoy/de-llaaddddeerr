import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

// The reviewed package catalog (packages.json). Only the slots listed there
// can run, only their listed operations, and only while each package tree
// still hashes to the recorded sha256. Requests never carry code, commands,
// interpreters or paths.

export const SLOT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/
const OPERATION = /^[a-z][a-z0-9_]{0,63}$/
const PARAM_KEY = /^[a-z][a-z0-9_]{0,63}$/
const PROXY_POLICIES = new Set(['never', 'allowed'])
// Runner-owned values the runner writes into params itself.
const INJECTABLE = new Set(['work_dir', 'run_dir', 'runtime_dir'])

// Generated or runtime-only paths. Everything else in a package directory is
// delivered source and must match the recorded hash.
const SKIP_DIRS = new Set(['.venv', '.runtime', '__pycache__', '.pytest_cache', '.mypy_cache', 'node_modules', 'build', 'data'])
const skipFile = name => name.endsWith('.pyc') || name.endsWith('.pyo') || name === '.DS_Store'
const skipDir = (name, depth) => SKIP_DIRS.has(name) && (depth === 0 || name === '__pycache__' || name === '.pytest_cache' || name === 'node_modules')
  || name.endsWith('.egg-info')

function listFiles(root) {
  const files = []
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, entry.name)
      // Installed environments (.venv may link to a shared one) are not source.
      if (skipDir(entry.name, depth)) continue
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        if (!skipFile(entry.name)) files.push(full)
      } else if (entry.isSymbolicLink()) {
        // A reviewed package never needs a link out of its own tree.
        throw Object.assign(new Error(`symbolic link in package: ${relative(root, full)}`), { code: 'package_symlink' })
      }
    }
  }
  walk(root, 0)
  return files
}

// sha256 over every delivered file: relative POSIX path, NUL, length, NUL,
// content. Independent of mtime, permissions and the host OS.
export function treeHash(root) {
  const digest = createHash('sha256')
  const files = listFiles(root)
  for (const file of files) {
    const content = readFileSync(file)
    digest.update(relative(root, file).split(sep).join('/'))
    digest.update('\0')
    digest.update(String(content.length))
    digest.update('\0')
    digest.update(content)
  }
  return { sha256: digest.digest('hex'), files: files.length }
}

function fail(message) {
  throw Object.assign(new Error(`packages.json: ${message}`), { code: 'catalog_invalid' })
}

const UPSTREAM_ID = /^[a-z0-9][a-z0-9._-]{0,63}@[0-9a-f]{12}$/
const insideRunner = value => typeof value === 'string' && value && !value.startsWith('/') && !value.split('/').includes('..')

export function parseCatalog(text, { baseDir }) {
  let raw
  try { raw = JSON.parse(text) } catch { fail('not valid JSON') }
  if (!raw || typeof raw !== 'object' || raw.catalogVersion !== 1 || !raw.packages || typeof raw.packages !== 'object') fail('catalogVersion 1 with a packages object is required')
  // Upstream libraries a package imports, vendored at the reviewed commit and
  // put on PYTHONPATH (never built or installed); hashed like packages.
  const upstreams = new Map()
  for (const [id, entry] of Object.entries(raw.upstreams || {})) {
    if (!UPSTREAM_ID.test(id)) fail(`invalid upstream id ${id}`)
    if (!entry || !insideRunner(entry.root) || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`upstream ${id} needs a relative root and a sha256`)
    upstreams.set(id, Object.freeze({ id, root: resolve(baseDir, entry.root), sha256: entry.sha256, repo: typeof entry.repo === 'string' ? entry.repo : null }))
  }
  const slots = new Map()
  for (const [slotId, entry] of Object.entries(raw.packages)) {
    if (!SLOT_ID.test(slotId)) fail(`invalid slot id ${slotId}`)
    if (!entry || typeof entry !== 'object') fail(`${slotId} must be an object`)
    const { packageId, label, root, interpreter, entry: entryFile, operations, proxy = 'never', inject = {}, reserved = [], sha256 } = entry
    if (typeof packageId !== 'string' || !packageId) fail(`${slotId}.packageId is required`)
    if (!insideRunner(root)) fail(`${slotId}.root must be a relative path inside the runner`)
    const uses = entry.upstreams === undefined ? [] : entry.upstreams
    if (!Array.isArray(uses) || !uses.every(id => upstreams.has(id))) fail(`${slotId}.upstreams must name declared upstreams`)
    if (entry.requirements !== undefined && !insideRunner(entry.requirements)) fail(`${slotId}.requirements must be a relative path inside the runner`)
    if (!['python', 'node'].includes(interpreter)) fail(`${slotId}.interpreter must be python or node`)
    if (typeof entryFile !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(py|mjs)$/.test(entryFile)) fail(`${slotId}.entry must be a file name in the package root`)
    if (!Array.isArray(operations) || !operations.length || !operations.every(op => typeof op === 'string' && OPERATION.test(op))) fail(`${slotId}.operations must list operations`)
    if (!PROXY_POLICIES.has(proxy)) fail(`${slotId}.proxy must be never or allowed`)
    if (!inject || typeof inject !== 'object' || Object.entries(inject).some(([key, value]) => !INJECTABLE.has(key) || !['work', 'runtime'].includes(value))) {
      fail(`${slotId}.inject may only map work_dir/run_dir/runtime_dir to work/runtime`)
    }
    if (entry.tests !== undefined && (typeof entry.tests !== 'string' || !/^test_[a-z0-9_]+\.py$/.test(entry.tests))) fail(`${slotId}.tests must be a test file name such as test_adapter.py`)
    if (!Array.isArray(reserved) || !reserved.every(key => typeof key === 'string' && PARAM_KEY.test(key))) fail(`${slotId}.reserved must list parameter names`)
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail(`${slotId}.sha256 must be a hex sha256`)
    const absoluteRoot = resolve(baseDir, root)
    slots.set(slotId, Object.freeze({
      slotId, packageId, label: typeof label === 'string' ? label : packageId, root: absoluteRoot, interpreter, entry: entryFile,
      operations: Object.freeze([...operations]), proxy, inject: Object.freeze({ ...inject }),
      reserved: Object.freeze([...new Set([...Object.keys(inject), ...reserved])]), sha256,
      // A reviewed replacement lock (e.g. without Windows-only wheels) or the package's own.
      requirements: entry.requirements ? resolve(baseDir, entry.requirements) : join(absoluteRoot, 'requirements.lock.txt'),
      tests: entry.tests || 'test_adapter.py',
      upstreams: Object.freeze(uses.map(id => upstreams.get(id))),
    }))
  }
  return slots
}

// Import path for a package process: its own source, then its upstreams.
export function pythonPath(slot) {
  return [join(slot.root, 'src'), ...slot.upstreams.map(upstream => upstream.root)].join(':')
}

export function loadCatalog(path) {
  return parseCatalog(readFileSync(path, 'utf8'), { baseDir: dirname(resolve(path)) })
}

export function interpreterPath(slot, { nodePath = process.execPath } = {}) {
  return slot.interpreter === 'python' ? join(slot.root, '.venv', 'bin', 'python') : nodePath
}

// Check every package once at startup. A mismatched or uninstalled package is
// reported and refused; the others keep working.
export function verifyCatalog(slots, { nodePath = process.execPath } = {}) {
  const states = new Map()
  for (const slot of slots.values()) {
    let state
    try {
      if (!existsSync(slot.root) || !statSync(slot.root).isDirectory()) state = { available: false, reason: 'package_missing' }
      else if (!existsSync(join(slot.root, slot.entry))) state = { available: false, reason: 'entry_missing' }
      else {
        const { sha256, files } = treeHash(slot.root)
        const upstream = slot.upstreams.find(item => !existsSync(item.root) || treeHash(item.root).sha256 !== item.sha256)
        if (sha256 !== slot.sha256) state = { available: false, reason: 'integrity_mismatch', files }
        else if (upstream) state = { available: false, reason: `upstream_mismatch:${upstream.id}`, files }
        else if (!existsSync(interpreterPath(slot, { nodePath }))) state = { available: false, reason: 'dependencies_not_installed', files }
        else if (slot.inject.runtime_dir && !existsSync(join(slot.root, '.runtime'))) state = { available: false, reason: 'runtime_not_installed', files }
        else state = { available: true, reason: null, files }
      }
    } catch (error) {
      state = { available: false, reason: error?.code === 'package_symlink' ? 'package_symlink' : 'package_unreadable' }
    }
    states.set(slot.slotId, Object.freeze(state))
  }
  return states
}
