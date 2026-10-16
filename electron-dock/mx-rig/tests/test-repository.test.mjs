import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestRepositories, taskBranch } from '../packages/runtime/test-repository.mjs'

// docs/23: a test project's repository on this computer. Approved
// implementations land on their task's branch, verified commits go to main,
// and versions travel to other computers as git bundles — no Git server.

let root
const MISSION_A = '11111111-2222-3333-4444-555555555555'
const MISSION_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()

const implementation = (overrides = {}) => ({
  version: 1,
  caseRevision: 2,
  hash: 'a'.repeat(64),
  engine: 'playwright',
  platform: 'web',
  reviewedAt: '2026-10-06T00:00:00.000Z',
  files: [{ path: 'tests/login.spec.ts', content: "import { test } from '@playwright/test'\ntest('PG-WEB-AUTH-001 登录', async () => {})\n" }],
  mappings: [{ caseId: 'PG-WEB-AUTH-001', path: 'tests/login.spec.ts', assertion: '登录后进入首页' }],
  ...overrides
})

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'rig-repo-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('a project without a pack gets the Playwright Web template, committed as main', async () => {
  const repos = new TestRepositories(join(root, 'one'))
  const state = await repos.ensure('demo')
  assert.equal(state.kind, 'generic')
  assert.deepEqual(state.branches.map((entry) => entry.name), ['main'])
  const qa = repos.path('demo')
  for (const file of ['package.json', 'pnpm-lock.yaml', 'playwright.config.mjs', 'rig/reporter.mjs', '.gitignore', '.rig/project.json'])
    assert.ok(git(qa, 'ls-files', file), `${file} is committed`)
  assert.match(await readFile(join(qa, 'package.json'), 'utf8'), /"@playwright\/test": "1\.58\.2"/)
  // Asking again changes nothing.
  assert.equal((await repos.ensure('demo')).branches[0].commit, state.branches[0].commit)
})

test('an approved implementation lands on its task branch; the checkout is not touched', async () => {
  const repos = new TestRepositories(join(root, 'one'))
  const qa = repos.path('demo')
  const head = git(qa, 'rev-parse', 'HEAD')
  const first = await repos.commitImplementation('demo', { missionId: MISSION_A, goal: '登录验收', implementation: implementation() })
  assert.equal(first.branch, taskBranch(MISSION_A))
  assert.equal(first.branch, 'task/11111111')
  assert.equal(first.unchanged, false)
  assert.equal(git(qa, 'rev-parse', 'HEAD'), head, 'main is still where it was')
  assert.equal(git(qa, 'symbolic-ref', '--short', 'HEAD'), 'main')
  assert.equal(git(qa, 'status', '--porcelain'), '', 'the working tree is clean')
  assert.match(git(qa, 'show', `${first.commit}:tests/login.spec.ts`), /PG-WEB-AUTH-001/)
  const mapping = JSON.parse(git(qa, 'show', `${first.commit}:.rig/cases/PG-WEB-AUTH-001.json`))
  assert.deepEqual([mapping.caseId, mapping.path, mapping.missionId, mapping.version], ['PG-WEB-AUTH-001', 'tests/login.spec.ts', MISSION_A, 1])
  assert.match(git(qa, 'log', '-1', '--format=%B', first.commit), /Rig-Implementation: a{64}/)

  // The same version again: nothing new. A new version: one more commit on the same branch.
  assert.deepEqual(await repos.commitImplementation('demo', { missionId: MISSION_A, implementation: implementation() }), { ...first, unchanged: true })
  const second = await repos.commitImplementation('demo', {
    missionId: MISSION_A,
    implementation: implementation({ version: 2, hash: 'b'.repeat(64), files: [{ path: 'tests/login.spec.ts', content: "test('v2', async () => {})\n" }] })
  })
  assert.equal(git(qa, 'rev-parse', `${second.commit}^`), first.commit)
})

test('verified commits go to main: fast-forward, a merge when task lines diverged, a refusal when they collide', async () => {
  const repos = new TestRepositories(join(root, 'one'))
  const qa = repos.path('demo')
  const a = git(qa, 'rev-parse', 'task/11111111')
  // Task B starts from the same main as A did, before A is merged.
  const b = await repos.commitImplementation('demo', {
    missionId: MISSION_B,
    implementation: implementation({ hash: 'c'.repeat(64), files: [{ path: 'tests/orders.spec.ts', content: "test('PG-WEB-ORDER-001', async () => {})\n" }], mappings: [{ caseId: 'PG-WEB-ORDER-001', path: 'tests/orders.spec.ts', assertion: '下单成功' }] })
  })
  assert.deepEqual(await repos.mergeToMain('demo', a), { main: a, merged: true })
  assert.equal(git(qa, 'rev-parse', 'main'), a)
  assert.equal(await readFile(join(qa, 'tests', 'login.spec.ts'), 'utf8'), "test('v2', async () => {})\n", 'a clean checkout of main follows')
  const mergedB = await repos.mergeToMain('demo', b.commit)
  assert.equal(git(qa, 'rev-list', '--parents', '-n', '1', mergedB.main).split(' ').length, 3, 'a merge commit')
  assert.deepEqual(git(qa, 'ls-tree', '--name-only', 'main:.rig/cases').split('\n'), ['PG-WEB-AUTH-001.json', 'PG-WEB-ORDER-001.json'])
  // Merging what main already has changes nothing.
  assert.deepEqual(await repos.mergeToMain('demo', a), { main: mergedB.main, merged: false })

  // Two tasks from the same main rewriting the same file cannot be merged silently.
  const c1 = await repos.commitImplementation('demo', { missionId: '33333333-0000-0000-0000-000000000000', implementation: implementation({ hash: 'd'.repeat(64), files: [{ path: 'tests/shared.spec.ts', content: 'one\n' }], mappings: [{ caseId: 'PG-WEB-X-001', path: 'tests/shared.spec.ts', assertion: 'x' }] }) })
  const c2 = await repos.commitImplementation('demo', { missionId: '44444444-0000-0000-0000-000000000000', implementation: implementation({ hash: 'e'.repeat(64), files: [{ path: 'tests/shared.spec.ts', content: 'two\n' }], mappings: [{ caseId: 'PG-WEB-X-002', path: 'tests/shared.spec.ts', assertion: 'y' }] }) })
  await repos.mergeToMain('demo', c1.commit)
  const before = git(qa, 'rev-parse', 'main')
  await assert.rejects(repos.mergeToMain('demo', c2.commit), (error) => error.code === 'merge_conflict' && /tests\/shared\.spec\.ts/.test(error.message))
  assert.equal(git(qa, 'rev-parse', 'main'), before, 'main is left as it was')
})

test('what the repository refuses', async () => {
  const repos = new TestRepositories(join(root, 'one'))
  await assert.rejects(repos.commitImplementation('demo', { missionId: MISSION_A, implementation: implementation({ engine: 'playwright-electron', platform: 'electron' }) }), /Playwright Web/)
  await assert.rejects(repos.commitImplementation('demo', { missionId: MISSION_A, implementation: implementation({ reviewedAt: null }) }), /批准过/)
  await assert.rejects(repos.commitImplementation('nothing-here', { missionId: MISSION_A, implementation: implementation() }), (error) => error.code === 'repository_missing')
  await assert.rejects(repos.mergeToMain('demo', 'f'.repeat(40)), (error) => error.code === 'commit_missing')
  // A pack's repository (罗盘) keeps its tests in rig-specs.
  const pack = join(root, 'one', 'pack', 'qa')
  await mkdir(join(pack, '.rig'), { recursive: true })
  await writeFile(join(pack, '.rig', 'project.json'), JSON.stringify({ pack: 'compass', app: 'pack' }))
  git(pack, 'init', '-q', '-b', 'main')
  git(pack, 'add', '.')
  git(pack, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'pack')
  await assert.rejects(repos.commitImplementation('pack', { missionId: MISSION_A, implementation: implementation() }), (error) => error.code === 'repository_pack')
})

test('versions travel as bundles: another computer pulls them in order and its main follows', async () => {
  const author = new TestRepositories(join(root, 'one'))
  const v1 = git(author.path('demo'), 'rev-parse', 'main')
  const bundle1 = await author.bundle('demo', v1)
  await author.importVersion('demo', { version: 1, commit: v1, bundle: bundle1 })

  const other = new TestRepositories(join(root, 'two'))
  await other.ensure('demo')
  const pulled = await other.importVersion('demo', { version: 1, commit: v1, bundle: bundle1 })
  assert.deepEqual(pulled, { version: 1, commit: v1, followed: true })
  const qa = other.path('demo')
  assert.equal(git(qa, 'rev-parse', 'published'), v1)
  assert.equal(git(qa, 'rev-parse', 'rig/v1'), v1)
  assert.equal(git(qa, 'rev-parse', 'main'), v1, "a fresh computer's main follows the service")
  assert.equal(await readFile(join(qa, 'tests', 'orders.spec.ts'), 'utf8'), "test('PG-WEB-ORDER-001', async () => {})\n")

  // v2 carries only what v1 does not have; it needs v1 first.
  const next = await author.commitImplementation('demo', { missionId: '55555555-0000-0000-0000-000000000000', implementation: implementation({ hash: '9'.repeat(64), files: [{ path: 'tests/more.spec.ts', content: 'more\n' }], mappings: [{ caseId: 'PG-WEB-MORE-001', path: 'tests/more.spec.ts', assertion: 'more' }] }) })
  await author.mergeToMain('demo', next.commit)
  const v2 = git(author.path('demo'), 'rev-parse', 'main')
  const bundle2 = await author.bundle('demo', v2, v1)
  assert.ok(Buffer.from(bundle2, 'base64').length < Buffer.from(bundle1, 'base64').length, 'an incremental bundle')
  const third = new TestRepositories(join(root, 'three'))
  await third.ensure('demo')
  await assert.rejects(third.importVersion('demo', { version: 2, commit: v2, bundle: bundle2 }), (error) => error.code === 'bundle_invalid')
  await other.importVersion('demo', { version: 2, commit: v2, bundle: bundle2 })
  assert.equal(git(qa, 'rev-parse', 'main'), v2)

  // A task on the other computer starts from the service's version.
  const theirs = await other.commitImplementation('demo', { missionId: '66666666-0000-0000-0000-000000000000', implementation: implementation({ hash: '8'.repeat(64) }) })
  assert.equal(git(qa, 'rev-parse', `${theirs.commit}^`), v2)
})

test('what a test version may carry: no recordings, installers, dependencies, secrets or big files', async () => {
  const repos = new TestRepositories(join(root, 'policy'))
  await repos.ensure('demo')
  const qa = repos.path('demo')
  const clean = git(qa, 'rev-parse', 'main')
  assert.deepEqual((await repos.inspect('demo', clean)).problems, [])
  await mkdir(join(qa, 'tests', 'fixtures'), { recursive: true })
  await mkdir(join(qa, 'node_modules', 'x'), { recursive: true })
  await writeFile(join(qa, 'tests', 'fixtures', 'avatar.png'), Buffer.alloc(10_000))
  await writeFile(join(qa, 'tests', 'fixtures', 'huge.json'), Buffer.alloc(3 * 1024 * 1024))
  await writeFile(join(qa, 'tests', 'fixtures', 'run.webm'), Buffer.alloc(100))
  await writeFile(join(qa, 'tests', 'fixtures', 'setup.exe'), Buffer.alloc(100))
  await writeFile(join(qa, '.env.local'), 'TOKEN=x\n')
  await writeFile(join(qa, 'node_modules', 'x', 'index.js'), 'x')
  git(qa, 'add', '--force', '.')
  git(qa, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'everything')
  const messy = git(qa, 'rev-parse', 'HEAD')
  const { problems, files } = await repos.inspect('demo', messy, clean)
  assert.equal(files, 6, 'only what changed since the last version')
  const text = problems.join('\n')
  assert.match(text, /huge\.json：3\.0 MB/)
  assert.match(text, /run\.webm：录像/)
  assert.match(text, /setup\.exe：安装包/)
  assert.match(text, /\.env\.local：环境变量文件/)
  assert.match(text, /node_modules\/x\/index\.js：依赖/)
  assert.doesNotMatch(text, /avatar\.png/, 'a small image fixture is fine')
  // Deleting a file again does not take it out of the history a bundle carries.
  git(qa, 'rm', '-q', '-r', '--cached', 'node_modules', '.env.local', 'tests/fixtures/huge.json', 'tests/fixtures/run.webm', 'tests/fixtures/setup.exe')
  git(qa, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'tidy up')
  const tidied = git(qa, 'rev-parse', 'HEAD')
  const later = await repos.inspect('demo', tidied, clean)
  assert.match(later.problems.join('\n'), /run\.webm：录像/, 'committed in between, so still inside the bundle')
  assert.match(later.problems.join('\n'), /huge\.json：3\.0 MB/)
  assert.deepEqual((await repos.inspect('demo', tidied, messy)).problems, [], 'from a version past it, nothing bad is added')
  assert.equal(await repos.contains('demo', clean, messy), true)
  assert.equal(await repos.contains('demo', messy, clean), false)
  assert.equal(await repos.contains('demo', 'f'.repeat(40), messy), false)
  assert.equal(await repos.tagVersion('demo', 7, messy), true)
  assert.equal(git(qa, 'rev-parse', 'rig/v7'), messy)
  assert.equal(await repos.tagVersion('demo', 8, 'f'.repeat(40)), false)
})
