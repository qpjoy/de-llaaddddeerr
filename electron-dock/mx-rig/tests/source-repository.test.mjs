import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { sourceRemote, sourceBaseline } from '../packages/runtime/source-repository.mjs'
import { TestProjectWorkspace } from '../packages/runtime/test-project-workspace.mjs'
import { implementationHash } from '../packages/runtime/test-implementation.mjs'
import { gitFixture } from './fixtures/source-git.mjs'

const ID = '00000000-0000-0000-0000-000000000001'
const OTHER = '00000000-0000-0000-0000-000000000002'
const context = { missionId: ID, workbench: true }
const read = { operation: 'read', path: 'login.ts' }
async function setup(t, git = false) {
  const root = await mkdtemp(join(tmpdir(), 'rig-source-git-'))
  let fixture
  t.after(async () => {
    await fixture?.close()
    await rm(root, { recursive: true, force: true })
  })
  if (git) fixture = await gitFixture(root)
  const local = new TestProjectWorkspace(join(root, 'rig'))
  t.after(() => local.close())
  return { root, local, fixture }
}

test('source repository accepts explicit HTTPS/SSH refs and rejects credential or option injection', () => {
  assert.equal(
    sourceRemote('git@example.com:team/app.git', 'feature/login').fetchRef,
    'refs/heads/feature/login'
  )
  assert.equal(
    sourceRemote('https://example.com/team/app.git', 'refs/tags/v1').fetchRef,
    'refs/tags/v1'
  )
  assert.equal(
    sourceRemote('ssh://git@example.com:2222/team/app.git', 'a'.repeat(40)).fetchRef,
    'a'.repeat(40)
  )
  for (const url of [
    '-upload-pack=bad',
    'file:///tmp/repo',
    '/tmp/repo',
    'ext::cmd',
    'https://token@example.com/app',
    'https://a:b@example.com/app',
    'https://example.com/app?token=secret',
    'http://example.com/app',
    'ssh://-host/repo',
    'git@host:repo;touch'
  ])
    assert.throws(() => sourceRemote(url, 'main'), { code: 'invalid_repository' })
  for (const ref of [
    '-b',
    'main:elsewhere',
    'main~1',
    '../main',
    'refs/remotes/origin/main',
    'branch.lock',
    'main\ncommand'
  ])
    assert.throws(() => sourceRemote('https://example.com/app.git', ref), {
      code: 'invalid_source_ref'
    })
})

test('local Git baseline preserves branch, index and dirty content, without running clean filters', async (t) => {
  const { root, local, fixture: f } = await setup(t, true)
  await writeFile(join(f.work, '.gitattributes'), '*.ts filter=probe\n')
  // Would leave a marker if status executed a repository-configured filter.
  await f.git('config', 'filter.probe.clean', `touch '${join(root, 'filter-ran')}'`)
  await writeFile(join(f.work, 'login.ts'), 'changed before connecting\n')
  const index = await readFile(join(f.work, '.git', 'index'))
  const connected = await local.bind(ID, f.work)
  assert.equal(connected.baseline.commit, f.first)
  assert.equal(connected.baseline.branch, 'main')
  assert.equal(connected.baseline.dirty, true)
  const result = await local.execute(read, context)
  const snapshot = await local.snapshot(ID)
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.equal(snapshot.observations[0].fileHash, result.sha256)
  assert.deepEqual(await readFile(join(f.work, '.git', 'index')), index)
  assert.equal((await readdir(root)).includes('filter-ran'), false)
  // Same Git status (M) but different bytes must invalidate earlier analysis.
  await writeFile(join(f.work, 'login.ts'), 'changed during model analysis\n')
  await assert.rejects(local.snapshot(ID), { code: 'source_changed' })
  await assert.rejects(local.execute(read, context), { code: 'source_changed' })
  await local.refresh(ID)
  assert.match((await local.execute(read, context)).text, /during model/)
  assert.equal(await f.git('branch', '--show-current'), 'main')
})

test('directory reads detect content changes even when Git has no change to report', async (t) => {
  const { root, local } = await setup(t)
  const source = join(root, 'plain')
  await mkdir(source)
  await writeFile(join(source, 'login.ts'), 'initial\n')
  await local.bind(ID, source)
  await local.execute(read, context)
  const snapshot = await local.snapshot(ID)
  // npm test places temporary directories inside the repository's ignored .runtime;
  // standalone runs use the OS temp directory and have no enclosing Git repository.
  const before = await sourceBaseline(source)
  assert.equal(snapshot.observations.length, 1)
  await writeFile(join(source, 'login.ts'), 'edited\n')
  assert.deepEqual(await sourceBaseline(source), before)
  await assert.rejects(local.snapshot(ID), { code: 'source_changed' })
})

test('real remote Git is pinned per task; explicit refresh advances without deleting old checkouts', async (t) => {
  const { local, fixture: f } = await setup(t, true)
  const first = await local.connectGit(ID, { repoUrl: f.repoUrl, ref: 'main' })
  assert.equal(first.baseline.commit, f.first)
  assert.equal(first.baseline.dirty, false)
  assert.equal(await f.git('rev-parse', 'HEAD'), f.first)
  await local.execute(read, context)
  const snapshot = await local.snapshot(ID)
  assert.equal(snapshot.observations.length, 1)
  const secondSHA = await f.commit('export const second = true\n')
  assert.equal(local.status(ID).baseline.commit, f.first, 'polling never fetches')
  assert.match((await local.execute(read, context)).text, /workspaceTitle/)
  const second = await local.refresh(ID)
  assert.equal(second.baseline.commit, secondSHA)
  assert.notEqual(first.directory, second.directory)
  assert.match(await readFile(join(first.directory, 'login.ts'), 'utf8'), /workspaceTitle/)
  const other = await local.connectGit(OTHER, { repoUrl: f.repoUrl, ref: 'main' })
  assert.notEqual(other.directory, second.directory)
  await f.git('tag', 'v1', f.first)
  await f.git('push', '-q', f.bare, 'refs/tags/v1')
  const tag = await local.connectGit(OTHER, { repoUrl: f.repoUrl, ref: 'refs/tags/v1' })
  assert.equal(tag.baseline.commit, f.first)
  await assert.rejects(local.connectGit(ID, { repoUrl: f.repoUrl, ref: 'missing-branch' }), {
    code: 'git_failed'
  })
  assert.equal(local.status(ID).directory, second.directory)
  assert.ok(
    !(await readdir(join(local.root, 'sources', ID))).some((name) => name.startsWith('.fetch-'))
  )
  await writeFile(join(second.directory, 'login.ts'), 'external edit\n')
  await assert.rejects(local.execute(read, context), { code: 'source_changed' })
})

test('cancelled fetch releases its task and keeps the previous local connection', async (t) => {
  const { root, local } = await setup(t)
  const source = join(root, 'plain')
  await mkdir(source)
  const first = await local.bind(ID, source)
  let received
  const request = new Promise((resolve) => {
    received = resolve
  })
  const server = createServer(() => received())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const connection = local.connectGit(ID, {
    repoUrl: `http://127.0.0.1:${server.address().port}/slow.git`,
    ref: 'main'
  })
  const rejected = assert.rejects(connection, { code: 'source_cancelled' })
  await request
  assert.equal(local.busy(ID), true)
  await assert.rejects(local.bind(ID, source), { code: 'busy' })
  await local.cancel(ID)
  await rejected
  assert.equal(local.busy(ID), false)
  assert.equal(local.status(ID).baseline.id, first.baseline.id)
  assert.deepEqual(await readdir(join(local.root, 'sources', ID)), [])
})

test('managed source directories cannot write through symlinks; provenance participates in implementation hash', async (t) => {
  const { root, local, fixture: f } = await setup(t, true)
  await mkdir(local.root)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(local.root, 'sources'))
  await assert.rejects(local.connectGit(ID, { repoUrl: f.repoUrl, ref: 'main' }), {
    code: 'outside_workspace'
  })
  assert.deepEqual(await readdir(outside), [])
  const base = {
    caseRevision: 1,
    summary: 'x',
    engine: 'playwright',
    platform: 'web',
    files: [],
    mappings: []
  }
  const source = { ...(await sourceBaseline(f.work)), observations: [] }
  assert.equal(
    implementationHash({ ...base, sourceBaseline: source }),
    implementationHash({
      ...base,
      sourceBaseline: Object.fromEntries(Object.entries(source).reverse())
    })
  )
  assert.notEqual(implementationHash(base), implementationHash({ ...base, sourceBaseline: source }))
  assert.notEqual(
    implementationHash({ ...base, sourceBaseline: source }),
    implementationHash({ ...base, sourceBaseline: { ...source, commit: 'b'.repeat(40) } })
  )
})
