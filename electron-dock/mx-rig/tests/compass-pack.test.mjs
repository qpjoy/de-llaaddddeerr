import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The Compass acceptance pack (test-packs/compass, docs/21 §5) is data the
// platform trusts: the catalog it registers must say exactly what the specs
// run, or the run page reports cases as "not run" that did run.

const pack = fileURLToPath(new URL('../test-packs/compass/', import.meta.url))
const json = async (path) => JSON.parse(await readFile(join(pack, path), 'utf8'))

async function specCases() {
  const cases = []
  for (const file of (await readdir(join(pack, 'rig-specs', 'web'))).filter((name) => name.endsWith('.spec.mjs')).sort()) {
    const { default: list } = await import(pathToFileURL(join(pack, 'rig-specs', 'web', file)).href)
    for (const entry of list) cases.push({ id: entry.id, title: entry.title, spec: `web/${file}`, run: typeof entry.run, backend: typeof entry.backend })
  }
  return cases
}

test('the Web catalog lists exactly the cases the specs define', async () => {
  const catalog = await json('rig-specs/web/case-catalog.web.json')
  const specs = await specCases()
  assert.deepEqual(
    catalog.cases.map((entry) => [entry.id, entry.title, entry.spec]).sort(),
    specs.map((entry) => [entry.id, entry.title, entry.spec]).sort()
  )
  assert.equal(catalog.suite, 'compass-web-snapshot')
  for (const entry of specs) {
    assert.equal(entry.run, 'function', `${entry.id} has a run()`)
    assert.equal(entry.backend, 'function', `${entry.id} has its fake backend`)
  }
  assert.equal(new Set(specs.map((entry) => entry.id)).size, specs.length, 'case ids are unique')
})

test('every plan names real suites and real cases', async () => {
  const definition = await json('pack.json')
  const suites = new Set(definition.suites.map((suite) => suite.slug))
  const ids = new Set()
  for (const path of definition.catalogs) for (const entry of (await json(path)).cases) ids.add(entry.id)
  for (const plan of definition.plans) {
    assert.ok(suites.has(plan.suite), plan.name)
    for (const id of (plan.caseFilter ?? '').split(',').filter(Boolean)) assert.ok(ids.has(id), `${plan.name}: ${id}`)
  }
  // The main-path plan leaves out the resilience case that records a known defect.
  assert.ok(!definition.plans[0].caseFilter.includes('CPS-WEB-STRAT-003'))
})

test('the old cases come in as references: never runnable, never counted', async () => {
  const reference = await json('reference/public-48af490/case-catalog.reference.json')
  assert.equal(reference.cases.length, 23)
  for (const entry of reference.cases) {
    assert.equal(entry.automationState, 'reference', entry.id)
    assert.equal(entry.spec, undefined, `${entry.id} has no spec, so nothing can select it to run`)
    assert.ok(entry.tags.includes('参考'))
  }
})

test('the Electron catalog has one copy, the one its run script reads', async () => {
  const catalog = await json('rig-specs/electron/case-catalog.electron.json')
  assert.equal(catalog.suite, 'compass-electron-smoke')
  assert.deepEqual(catalog.cases.map((entry) => entry.id), ['CPS-EL-BOOT-001', 'CPS-EL-BOOT-002', 'CPS-EL-AUTH-001'])
  const kernel = await readFile(fileURLToPath(new URL('../packages/test-platform/server/onboarding/compass.mjs', import.meta.url)), 'utf8')
  assert.match(kernel, /test-packs\/compass\/rig-specs\/electron\/case-catalog\.electron\.json/)
})

test('a fake backend answers what it knows, and nothing else', async () => {
  const { compassApi, ACCOUNT } = await import(pathToFileURL(join(pack, 'rig-specs', 'web', 'fake-api.mjs')).href)
  const backend = compassApi([['GET /api/extra', () => ({ code: 200, data: 'x' })]])
  assert.ok(backend.handlerFor('POST', '/api/account/login'))
  assert.ok(backend.handlerFor('GET', '/api/portrait/unread-completions'), 'patterns match too')
  assert.ok(backend.handlerFor('GET', '/api/extra'))
  assert.equal(backend.handlerFor('GET', '/api/unknown'), null)
  const login = backend.handlerFor('POST', '/api/account/login')
  assert.equal(login({}, { body: { account: ACCOUNT.account, password: ACCOUNT.password }, state: {} }).code, 200)
  assert.equal(login({}, { body: { account: ACCOUNT.account, password: 'no' }, state: {} }).code, 401)
})
