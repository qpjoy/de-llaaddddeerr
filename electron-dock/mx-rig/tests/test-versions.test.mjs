import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestVersions, provesCommit } from '../apps/server/test-versions.mjs'

// docs/23: the service keeps published test versions without running Git. It
// checks what it can: the bundle looks like one, a passed run of this project
// tested exactly this commit, and the version builds on the latest one.

let root
const APP = 'app_demo'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const bundle = Buffer.from('# v2 git bundle\n' + 'x'.repeat(64)).toString('base64')
const passed = (commit, extra = {}) => ({ id: 'trun_ok', appId: APP, status: 'passed', sourceRef: { ref: commit, gitSha: commit, version: `QA ${commit.slice(0, 7)}` }, ...extra })
const body = (overrides = {}) => ({ commit: A, parent: null, branch: 'task/11111111', summary: '登录验收', runId: 'trun_ok', cases: ['PG-WEB-AUTH-001'], bundle, ...overrides })
const principal = { id: 'local:tester', displayName: '测试员' }

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'rig-versions-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('a run proves a commit only when it belongs to the project, passed, and tested that commit', () => {
  assert.equal(provesCommit(passed(A), { appId: APP, commit: A }), null)
  assert.match(provesCommit(passed(A, { appId: 'app_other' }), { appId: APP, commit: A }), /不属于这个项目/)
  assert.match(provesCommit(passed(A, { status: 'failed' }), { appId: APP, commit: A }), /通过/)
  assert.match(provesCommit(passed(B), { appId: APP, commit: A }), /不是这个提交/)
  // A pack run: the source commit, with the QA commit as its version.
  assert.equal(provesCommit({ appId: APP, status: 'passed', sourceRef: { gitSha: 'c'.repeat(40), version: `QA ${A.slice(0, 7)}` } }, { appId: APP, commit: A }), null)
  assert.match(provesCommit(null, { appId: APP, commit: A }), /不属于/)
})

test('versions are appended in order, each building on the latest, and keep their content', async () => {
  const versions = new TestVersions((key) => join(root, `${key}.json`))
  await assert.rejects(versions.publish(APP, principal, body({ bundle: Buffer.from('not a bundle').toString('base64') }), passed(A)), /不是 git bundle/)
  await assert.rejects(versions.publish(APP, principal, body(), passed(B)), (error) => error.code === 'version_unproven')
  await assert.rejects(versions.publish(APP, principal, body({ parent: B }), passed(A)), (error) => error.code === 'version_conflict')
  const v1 = await versions.publish(APP, principal, body(), passed(A))
  assert.deepEqual([v1.version, v1.commit, v1.parent, v1.publisherName, v1.cases], [1, A, null, '测试员', ['PG-WEB-AUTH-001']])
  // Building on an old version, or publishing the same commit again, is refused.
  await assert.rejects(versions.publish(APP, principal, body({ commit: B }), passed(B)), (error) => error.code === 'version_conflict' && /v1/.test(error.message))
  await assert.rejects(versions.publish(APP, principal, body({ parent: A }), passed(A)), (error) => error.code === 'version_exists')
  const v2 = await versions.publish(APP, principal, body({ commit: B, parent: A, branch: 'main' }), passed(B))
  assert.equal(v2.version, 2)
  const listed = await versions.list(APP)
  assert.deepEqual(listed.versions.map((entry) => entry.version), [2, 1], 'newest first')
  assert.equal(listed.head.commit, B)
  assert.deepEqual(await versions.bundle(APP, 1), { version: 1, commit: A, parent: null, checkpoint: true, bundle })
  await assert.rejects(versions.bundle(APP, 9), (error) => error.code === 'not_found')
  // Another project's versions are its own.
  assert.equal((await versions.list('app_other')).head, null)
})

test('bundles are files; every full version drops the increments before it; a project has a quota', async () => {
  const blobRoot = join(root, 'blobs')
  const versions = new TestVersions((key) => join(root, 'files', `${key}.json`), { blobRoot, quotaBytes: 4096 })
  const sized = (n) => Buffer.from('# v2 git bundle\n' + 'y'.repeat(n)).toString('base64')
  const commits = ['1', '2', '3'].map((digit) => digit.repeat(40))
  const v1 = await versions.publish('app_files', principal, body({ commit: commits[0], bundle: sized(1000) }), passed(commits[0], { appId: 'app_files' }))
  assert.equal(v1.checkpoint, true, 'the first version is always complete')
  const { readFile: read, stat } = await import('node:fs/promises')
  assert.ok((await stat(join(blobRoot, 'app_files', 'v1.bundle'))).size > 1000, 'stored as a binary file, not base64 JSON')
  await versions.publish('app_files', principal, body({ commit: commits[1], parent: commits[0], bundle: sized(1000) }), passed(commits[1], { appId: 'app_files' }))
  // Over the quota as an increment…
  await assert.rejects(
    versions.publish('app_files', principal, body({ commit: commits[2], parent: commits[1], bundle: sized(2500) }), passed(commits[2], { appId: 'app_files' })),
    (error) => error.code === 'quota_exceeded'
  )
  // …but a full version replaces what came before, so it fits.
  const v3 = await versions.publish('app_files', principal, body({ commit: commits[2], parent: commits[1], bundle: sized(2500), checkpoint: true }), passed(commits[2], { appId: 'app_files' }))
  assert.equal(v3.checkpoint, true)
  const listed = await versions.list('app_files')
  assert.deepEqual(listed.versions.map((row) => [row.version, Boolean(row.pruned), row.prunedBy ?? null]), [[3, false, null], [2, true, 3], [1, true, 3]])
  assert.deepEqual([listed.usage.stored, listed.usage.checkpoint], [1, 3])
  assert.ok(listed.usage.bytes < 4096)
  await assert.rejects(stat(join(blobRoot, 'app_files', 'v1.bundle')), 'the old increment file is gone')
  await assert.rejects(versions.bundle('app_files', 1), (error) => error.code === 'version_pruned' && error.status === 410 && /v3/.test(error.message))
  assert.equal((await versions.bundle('app_files', 3)).checkpoint, true)
  void read
})

test('a publish never eats into the disk space the artifacts store keeps free', async () => {
  let free = 9_050
  const versions = new TestVersions((key) => join(root, 'room', `${key}.json`), {
    blobRoot: join(root, 'room-blobs'),
    minFreeBytes: 9_000,
    statfsImpl: async () => ({ bavail: free, bsize: 1 })
  })
  await assert.rejects(versions.publish('app_room', principal, body(), passed(A, { appId: 'app_room' })), (error) => error.code === 'storage_low' && error.status === 507)
  assert.equal((await versions.list('app_room')).head, null, 'nothing was listed')
  free = 1_000_000
  assert.equal((await versions.publish('app_room', principal, body(), passed(A, { appId: 'app_room' }))).version, 1)
})

test('versions published before bundles became files are still readable', async () => {
  const legacy = new TestVersions((key) => join(root, 'legacy', `${key}.json`))
  await legacy.publish('app_legacy', principal, body(), passed(A, { appId: 'app_legacy' }))
  const files = new TestVersions((key) => join(root, 'legacy', `${key}.json`), { blobRoot: join(root, 'legacy-blobs') })
  assert.equal((await files.bundle('app_legacy', 1)).bundle, bundle)
})

test('a runner reads the versions of its own running run, with its run token, and nothing else', async () => {
  const { runnerTestVersionRoutes } = await import('../apps/server/test-versions.mjs')
  const { createHash } = await import('node:crypto')
  const versions = new TestVersions((key) => join(root, 'runner', `${key}.json`), { blobRoot: join(root, 'runner-blobs') })
  await versions.publish('app_team', principal, body(), passed(A, { appId: 'app_team' }))
  const hash = (token) => createHash('sha256').update(token).digest('hex')
  const runs = {
    [hash('tok-team')]: { id: 'trun_team', appId: 'app_team', status: 'running', suiteId: 'ste_pub' },
    [hash('tok-done')]: { id: 'trun_done', appId: 'app_team', status: 'passed', suiteId: 'ste_pub' },
    [hash('tok-local')]: { id: 'trun_local', appId: 'app_team', status: 'running', suiteId: 'ste_ws' }
  }
  const store = {
    getRunByTokenHash: async (value) => runs[value] ?? null,
    getSuite: async (id) => ({ ste_pub: { repoUrl: 'rig-published://team' }, ste_ws: { repoUrl: 'rig-workspace://team/qa' } })[id]
  }
  const ask = (path, token) => runnerTestVersionRoutes({ req: { method: 'GET' }, path, token, store, versions })
  assert.equal(await ask('/runner/v1/runs/trun_team/other', 'tok-team'), null, 'not this route')
  const listed = await ask('/runner/v1/runs/trun_team/test-versions', 'tok-team')
  assert.equal(listed.head.commit, A)
  assert.equal((await ask('/runner/v1/runs/trun_team/test-versions/1/bundle', 'tok-team')).bundle, bundle)
  await assert.rejects(ask('/runner/v1/runs/trun_team/test-versions', null), (error) => error.status === 401)
  await assert.rejects(ask('/runner/v1/runs/trun_other/test-versions', 'tok-team'), (error) => error.status === 403, "another run's token")
  await assert.rejects(ask('/runner/v1/runs/trun_done/test-versions', 'tok-done'), (error) => error.code === 'run_not_running')
  await assert.rejects(ask('/runner/v1/runs/trun_local/test-versions', 'tok-local'), (error) => error.status === 403, 'not a published-versions run')
})
