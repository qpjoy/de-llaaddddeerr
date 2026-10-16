import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ProjectWorkspaces, directoryFingerprint } from '../packages/runtime/project-workspace.mjs'
import { workspaceRemote } from '../packages/test-platform/bin/mxt-runner.mjs'
import { Blocked, findSnapshot, verifySnapshot } from '../test-packs/compass/rig-specs/lib/snapshot.mjs'

// A test project's workspace (docs/21 §5): a snapshot pinned to one commit and
// a QA repository. What matters most: the developer's repository is only read.

let root
let origin
let seed
let first
let second

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
  }).trim()

/** Every file under .git with its size and content hash: any write shows up. */
async function fingerprint(dir) {
  const hash = createHash('sha256')
  const walk = async (path) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else hash.update(`${relative(dir, full)}:${(await stat(full)).size}:${createHash('sha256').update(await readFile(full)).digest('hex')}\n`)
    }
  }
  await walk(join(dir, '.git'))
  hash.update(git(dir, 'status', '--porcelain'))
  return hash.digest('hex')
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'rig-workspace-'))
  origin = join(root, 'developer', 'monorepo')
  await mkdir(join(origin, 'app'), { recursive: true })
  git(origin, 'init', '-q', '-b', 'feat/x')
  await writeFile(join(origin, 'app', 'index.html'), '<h1>v1</h1>')
  await writeFile(join(origin, 'other.txt'), 'not part of the project')
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'v1')
  first = git(origin, 'rev-parse', 'HEAD')
  await writeFile(join(origin, 'app', 'index.html'), '<h1>v2</h1>')
  git(origin, 'commit', '-qam', 'v2')
  second = git(origin, 'rev-parse', 'HEAD')
  // The developer has uncommitted work: it must stay exactly as it is.
  await writeFile(join(origin, 'app', 'index.html'), '<h1>work in progress</h1>')

  seed = join(root, 'pack')
  await mkdir(join(seed, 'rig-specs', 'node_modules', 'junk'), { recursive: true })
  await writeFile(join(seed, 'rig-specs', 'run.mjs'), 'console.log("ok")\n')
  await writeFile(join(seed, 'rig-specs', 'node_modules', 'junk', 'x.js'), '')
  await writeFile(join(seed, 'README.md'), '# demo\n')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const pack = () => ({ id: 'demo', version: '1.0.0', dir: seed, seed: ['rig-specs', 'README.md'], source: { ref: 'feat/x', subdir: 'app' } })

test('a snapshot and a QA repository from a local repository, which is only read', async () => {
  const before = await fingerprint(origin)
  const workspaces = new ProjectWorkspaces(join(root, 'rig'))
  const state = await workspaces.create({ app: 'demo', pack: pack(), source: { kind: 'local', directory: origin }, ref: 'feat/x', commit: first.slice(0, 7) })

  assert.equal(state.pinned, first, 'the short commit is resolved and pinned in full')
  assert.equal(state.snapshot.commit, first)
  assert.equal(state.snapshot.subdir, 'app')
  assert.equal(state.snapshot.origin.kind, 'local')
  assert.equal(await readFile(join(state.snapshot.dir, 'app', 'index.html'), 'utf8'), '<h1>v1</h1>', 'the committed file, not the work in progress')
  assert.equal(existsSync(join(state.snapshot.dir, 'other.txt')), false, 'only the project subdirectory is checked out')

  assert.match(state.qa.subject, /^初始：验收包 demo 1\.0\.0/)
  const qa = join(root, 'rig', 'demo', 'qa')
  assert.equal(await readFile(join(qa, 'rig-specs', 'run.mjs'), 'utf8'), 'console.log("ok")\n')
  assert.equal(existsSync(join(qa, 'rig-specs', 'node_modules')), false, 'installed packages are not seed')
  const project = JSON.parse(await readFile(join(qa, '.rig', 'project.json'), 'utf8'))
  assert.deepEqual(project.source, { ref: 'feat/x', commit: first, subdir: 'app', origin: 'monorepo' })
  assert.equal(git(qa, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(git(qa, 'status', '--porcelain'), '', 'everything is committed')

  assert.deepEqual(await workspaces.behind('demo'), { tip: second, commits: 1 })
  assert.equal(await fingerprint(origin), before, "the developer's repository and working tree are unchanged")
})

test('updating the baseline adds a snapshot and records the change; the old one stays', async () => {
  const workspaces = new ProjectWorkspaces(join(root, 'rig'))
  const state = await workspaces.create({ app: 'demo', pack: pack(), source: { kind: 'local', directory: join(origin, 'app') }, ref: 'feat/x', commit: second })
  assert.equal(state.pinned, second)
  assert.equal(state.snapshots.length, 2)
  assert.match(state.qa.subject, /^更新基准：.{7} → feat\/x@/)
  assert.equal(await readFile(join(state.snapshot.dir, 'app', 'index.html'), 'utf8'), '<h1>v2</h1>')
  // Asking again for the same commit fetches nothing new.
  const again = await workspaces.create({ app: 'demo', pack: pack(), source: { kind: 'local', directory: origin }, ref: 'feat/x', commit: second })
  assert.equal(again.snapshots.length, 2)
  assert.equal(again.qa.commit, state.qa.commit)
})

test('code copied onto this computer, without Git, is snapshotted as a copy and pinned', async () => {
  const copied = join(root, 'copied', 'po-frontend')
  await mkdir(join(copied, 'src'), { recursive: true })
  await mkdir(join(copied, 'node_modules', 'left-out'), { recursive: true })
  await writeFile(join(copied, 'src', 'main.js'), 'console.log(1)\n')
  await writeFile(join(copied, 'node_modules', 'left-out', 'index.js'), 'big\n')
  const workspaces = new ProjectWorkspaces(join(root, 'rig'))
  const state = await workspaces.create({ app: 'plain', pack: pack(), source: { kind: 'local', directory: copied } })
  assert.equal(state.snapshot.origin.kind, 'copy')
  assert.equal(state.snapshot.ref, null)
  assert.match(state.snapshot.name, /^copy@[a-f0-9]{7}$/)
  assert.equal(state.snapshot.subdir, null, 'the folder is the project itself')
  assert.equal(await readFile(join(state.snapshot.dir, 'src', 'main.js'), 'utf8'), 'console.log(1)\n')
  assert.equal(existsSync(join(state.snapshot.dir, 'node_modules')), false, 'installed packages are not copied')
  assert.equal(git(state.snapshot.dir, 'status', '--porcelain', '--untracked-files=no'), '', 'the copy is committed as is')
  assert.deepEqual(await workspaces.behind('plain'), { tip: null, commits: null, changed: false })
  // The same content again: the same snapshot.
  assert.equal((await workspaces.create({ app: 'plain', pack: pack(), source: { kind: 'local', directory: copied } })).snapshots.length, 1)
  // The folder changes: the workspace says so, and a new baseline is a new snapshot.
  await writeFile(join(copied, 'src', 'main.js'), 'console.log(2)\n')
  assert.equal((await workspaces.behind('plain')).changed, true)
  const next = await workspaces.create({ app: 'plain', pack: pack(), source: { kind: 'local', directory: copied } })
  assert.equal(next.snapshots.length, 2)
  assert.notEqual(next.pinned, state.pinned)
  assert.match(next.qa.subject, /^更新基准：/)
  assert.equal((await directoryFingerprint(copied)).files, 1, 'node_modules is not part of the fingerprint')
})

test('what cannot be a source is refused with a reason', async () => {
  const workspaces = new ProjectWorkspaces(join(root, 'rig'))
  await assert.rejects(
    workspaces.create({ app: 'demo', pack: pack(), source: { kind: 'local', directory: origin }, commit: 'f'.repeat(40) }),
    (error) => error.code === 'invalid_source_ref'
  )
  await assert.rejects(workspaces.create({ app: 'Bad Slug', pack: pack(), source: { kind: 'local', directory: origin } }), /项目标识无效/)
  await assert.rejects(workspaces.create({ app: 'demo', pack: pack(), source: { kind: 'git', repoUrl: 'https://example.test/repo.git' }, commit: 'abc' }), /40 位/)
  await assert.rejects(workspaces.create({ app: 'demo', pack: pack(), source: { kind: 'local', directory: join(root, 'rig') }, commit: first }), /不能重叠/)
})

test('the runner finds the QA repository on this machine, and only there', async () => {
  const workspaces = join(root, 'rig')
  assert.equal(workspaceRemote('rig-workspace://demo/qa', workspaces), `file://${join(workspaces, 'demo', 'qa')}`)
  assert.equal(workspaceRemote('https://example.test/qa.git', workspaces), null)
  assert.throws(() => workspaceRemote('rig-workspace://other/qa', workspaces), /没有「other」的测试项目工作区/)
  assert.throws(() => workspaceRemote('rig-workspace://demo/qa', undefined), /没有「demo」/)
})

test('rig-specs find the pinned snapshot and refuse one whose sources were changed', async () => {
  process.env.MXT_PROJECT_WORKSPACES = join(root, 'rig')
  try {
    const dir = await findSnapshot({ app: 'demo', commit: second })
    await verifySnapshot(dir, second)
    await assert.rejects(findSnapshot({ app: 'demo', commit: 'e'.repeat(40) }), Blocked)
    await assert.rejects(verifySnapshot(dir, first), /固定的是/)
    await writeFile(join(dir, 'app', 'index.html'), 'edited')
    await assert.rejects(verifySnapshot(dir, second), /被改动/)
  } finally {
    delete process.env.MXT_PROJECT_WORKSPACES
  }
})
