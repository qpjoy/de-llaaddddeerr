import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildCompassPlan } from '../scripts/onboard-compass.mjs'
import { catalogDigest } from '../../mx-launcher/demos/mx-autotest/test-packs/compass-electron/scripts/catalog-digest.mjs'

test('Compass defaults are self-contained and do not invent an Electron remote', () => {
  const plan = buildCompassPlan({})
  assert.equal(plan.app.defaultBranch, 'public')
  assert.equal(plan.app.repoUrl, 'https://github.com/mingxiinfo/po-frontend')
  assert.equal(plan.electronConfigured, false)
  assert.deepEqual(plan.suites.map((suite) => suite.slug), ['web-functional', 'web-demo'])
  for (const suite of plan.suites) {
    assert.equal(suite.workingDir, 'po-frontend')
    assert.equal(suite.targetMode, 'self')
    assert.equal(suite.repoUrl, plan.app.repoUrl)
    assert.equal(suite.defaultBranch, 'public')
    assert.equal(suite.runnerImage, 'cypress/included:15.19.0')
  }
  const demoSuite = plan.suites.find((suite) => suite.slug === 'web-demo')
  const demoTask = plan.tasks.find((task) => task.suiteSlug === 'web-demo')
  assert.equal(demoSuite.runnerKind, 'local')
  assert.equal(demoTask.runsOn, 'any-runner')
  assert.equal(demoTask.schedule.kind, 'manual')
})

test('Electron is added only for an explicit QA repo or Git test-pack', () => {
  const plan = buildCompassPlan({ MX_AUTO_COMPASS_QA_REPO: 'https://example.test/qa/compass-test-pack.git' })
  const suite = plan.suites.find((entry) => entry.slug === 'compass-electron-smoke')
  assert.equal(plan.electronConfigured, true)
  assert.equal(suite.repoUrl, 'https://example.test/qa/compass-test-pack.git')
  assert.equal(suite.engine, 'playwright-electron')
  assert.equal(suite.runnerKind, 'local')
  assert.deepEqual(suite.command, ['pnpm', 'test'])
  assert.deepEqual(suite.secretRefs, ['COMPASS_E2E_ACCOUNT', 'COMPASS_E2E_PASSWORD'])
  const electronTasks = plan.tasks.filter((task) => task.suiteSlug === suite.slug)
  assert.deepEqual(electronTasks.map((task) => task.profile), ['mock', 'real'])
  assert.deepEqual(electronTasks.map((task) => task.caseFilter), [
    'CPS-EL-BOOT-001,CPS-EL-BOOT-002',
    'CPS-EL-AUTH-001'
  ])
  assert.ok(electronTasks.every((task) => task.schedule.kind === 'manual'))
  assert.ok(electronTasks.every((task) => !Object.hasOwn(task, 'command')))
  assert.equal(plan.catalogs.length, 1)
  assert.equal(plan.catalogs[0].suite, suite.slug)
})

test('the onboarding catalog cannot drift from the external Electron pack', () => {
  const serverCatalog = JSON.parse(readFileSync(new URL('../catalogs/compass-electron.json', import.meta.url), 'utf8'))
  const packCatalog = JSON.parse(readFileSync(new URL(
    '../../mx-launcher/demos/mx-autotest/test-packs/compass-electron/case-catalog.electron.json',
    import.meta.url
  ), 'utf8'))
  const stableFields = ({ id, title, priority, tags, tracks, spec, coverageMode, automationState, prerequisites }) => ({
    id,
    title,
    priority,
    tags,
    tracks,
    spec,
    coverageMode,
    automationState,
    prerequisites
  })
  assert.deepEqual(serverCatalog.cases.map(stableFields), packCatalog.cases.map(stableFields))
  assert.equal(serverCatalog.suite, packCatalog.suite)
  assert.equal(serverCatalog.schemaVersion, 2)
  assert.equal(catalogDigest(serverCatalog), catalogDigest(packCatalog))
})

test('a local Electron test-pack must be a Git checkout root, not an arbitrary subdirectory', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'mx-auto-test-pack-'))
  const repository = join(scratch, 'qa-repo')
  const subdirectory = join(repository, 'test-pack')
  mkdirSync(subdirectory, { recursive: true })
  execFileSync('git', ['init', '-q', repository])
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  const plan = buildCompassPlan({ MX_AUTO_COMPASS_TEST_PACK: repository })
  assert.equal(plan.suites.find((entry) => entry.slug === 'compass-electron-smoke').repoUrl, repository)
  assert.throws(
    () => buildCompassPlan({ MX_AUTO_COMPASS_TEST_PACK: subdirectory }),
    /subdirectory, not a Git checkout root/u
  )
})

test('only functional scheduling can be enabled by configuration', () => {
  const plan = buildCompassPlan({ MX_AUTO_COMPASS_FUNCTIONAL_CRON: '0 2 * * *' })
  assert.equal(plan.tasks.find((task) => task.suiteSlug === 'web-functional').schedule.kind, 'cron')
  assert.equal(plan.tasks.find((task) => task.suiteSlug === 'web-demo').schedule.kind, 'manual')
})
