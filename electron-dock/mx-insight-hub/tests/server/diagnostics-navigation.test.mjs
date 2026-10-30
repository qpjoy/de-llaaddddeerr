import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { diagnosticHref, diagnosticTabRequestId, legacyDiagnosticRedirect } from '../../src/diagnostics-navigation.js'

const source = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8')

function location(hash, canonicalize = true) {
  let replaced
  const window = {
    location: { hash, pathname: '/admin/', search: '?shell=hub' },
    history: { replaceState: (_state, _title, value) => { replaced = value } },
  }
  const readLocation = vm.runInNewContext(`(${source.slice(source.indexOf('function readLocation('), source.indexOf('\nfunction ThemeToggle('))})`, {
    window, URLSearchParams, restorePaymentReturn: () => {}, legacyDiagnosticRedirect,
    LEGACY_ROUTE_REDIRECTS: new Map(), ROUTE_MAP: new Map(['/diagnostics', '/data-browser', '/dashboard'].map(path => [path, {}])),
  })
  return { result: readLocation({ canonicalize }), replaced }
}

test('old diagnostic links resolve before rendering and retain IDs, queries and the admin mount', () => {
  for (const [oldView, newView] of [['diagnostics', 'requests'], ['limits', 'limits']]) {
    const { result, replaced } = location(`#/data-browser?view=${oldView}&requestId=req_a%3Ab&source=usage`)
    assert.equal(result.path, '/diagnostics')
    assert.equal(result.query.get('view'), newView)
    assert.equal(result.query.get('requestId'), 'req_a:b')
    assert.equal(result.query.get('source'), 'usage')
    assert.equal(replaced, `/admin/?shell=hub#/diagnostics?view=${newView}&requestId=req_a%3Ab&source=usage`)
    const initial = location(`#/data-browser?view=${oldView}&requestId=req_a`, false)
    assert.equal(initial.result.path, '/diagnostics', 'initial route does not mount Data Browser or fetch business content')
    assert.equal(initial.replaced, undefined)
  }
})

test('diagnostic links encode identifiers and preserve the selected read-only view on reload', () => {
  for (const view of ['requests', 'limits', 'platforms']) {
    const href = diagnosticHref('req/a?b&c:d', view)
    const { result, replaced } = location(href)
    assert.equal(result.path, '/diagnostics')
    assert.equal(result.query.get('requestId'), 'req/a?b&c:d')
    assert.equal(result.query.get('view'), view)
    assert.equal(replaced, undefined)
  }
  assert.equal(diagnosticHref(), '#/diagnostics?view=requests')
  assert.equal(diagnosticHref('req', 'unrecognized'), '#/diagnostics?view=requests&requestId=req')
  assert.equal(diagnosticHref('hub-id', 'platforms', 'reddit'), '#/diagnostics?view=platforms&requestId=hub-id&platform=reddit')
  assert.equal(diagnosticTabRequestId('platforms', 'hub-id', null, 'admin'), 'hub-id')
})

test('business browsing routes are unchanged and diagnostics retain the existing Admin Token boundary', async () => {
  for (const view of ['accounts', 'contents', 'advanced', 'aggregate', '']) {
    const { result, replaced } = location(`#/data-browser?view=${view}`)
    assert.equal(result.path, '/data-browser')
    assert.equal(result.query.get('view'), view)
    assert.equal(replaced, undefined)
  }
  assert.equal(legacyDiagnosticRedirect('/usage', new URLSearchParams('view=limits')), null)
  const route = source.split('\n').find(line => line.includes("path: '/diagnostics'"))
  assert.match(route, /group: '可观测性'/)
  assert.match(route, /platformAdmin: true, adminTokenOnly: true/)
  const browser = await readFile(new URL('../../src/pages-data-browser.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(browser, /RequestDiagnostics|AdmissionLimits/)
})

test('tab transitions resolve one Hub ID, never an ambiguous upstream ID or stale lookup', () => {
  const session = { token: 'admin', routeIdentifier: 'req_upstream', identifier: 'req_upstream', data: { identifier: 'req_upstream', runs: [{ requestId: 'hub-uuid' }] } }
  assert.equal(diagnosticTabRequestId('requests', 'req_upstream', session, 'admin'), 'hub-uuid')
  assert.equal(diagnosticTabRequestId('requests', 'new-deep-link', session, 'admin'), '')
  assert.equal(diagnosticTabRequestId('requests', 'req_upstream', session, 'different-admin'), '')
  assert.equal(diagnosticTabRequestId('requests', 'req_upstream', { ...session, identifier: 'not-yet-looked-up' }, 'admin'), '')
  for (const runs of [[], [{ requestId: 'hub-a' }, { requestId: 'hub-b' }]]) {
    assert.equal(diagnosticTabRequestId('requests', 'req_upstream', { ...session, data: { identifier: 'req_upstream', runs } }, 'admin'), '')
  }
  assert.equal(diagnosticTabRequestId('limits', 'current-hub-uuid', session, 'admin'), 'current-hub-uuid')
  assert.equal(diagnosticTabRequestId('limits', '', session, 'admin'), '')
})
