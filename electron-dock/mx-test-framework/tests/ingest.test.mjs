import assert from 'node:assert/strict'
import test from 'node:test'
import { redactLine, redactText, sanitizeUrl } from '../server/core/redact.mjs'
import { compareWithCatalog, normalizeSummary } from '../server/ingest/summary.mjs'

const v2 = (overrides = {}) => ({
  schemaVersion: 2,
  runId: 'trun_1',
  app: 'compass',
  status: 'passed',
  totals: { tests: 1, passed: 1 },
  cases: [{ caseId: 'CPS-FE-AUTH-001', status: 'passed' }],
  ...overrides,
})

test('strips credentials the runner failed to redact', () => {
  const summary = v2({
    cases: [
      {
        caseId: 'CPS-FE-AUTH-001',
        status: 'failed',
        error: 'request failed: Authorization: Bearer sk-live-abcdef123 for https://u:p@api.internal/x?token=zzz',
      },
    ],
    totals: { tests: 1, failed: 1 },
  })
  const { cases } = normalizeSummary(summary, 1)
  const error = cases[0].errorText
  assert.ok(!error.includes('sk-live-abcdef123'), error)
  assert.ok(!error.includes('token=zzz'), error)
  assert.ok(!error.includes('u:p@'), error)
})

test('sanitizeUrl drops credentials, query and fragment', () => {
  assert.equal(sanitizeUrl('https://a:b@host.internal/path?q=1#f'), 'https://host.internal/path')
  assert.equal(sanitizeUrl('not a url'), '')
})

test('redaction bounds length and collapses newlines in labels', () => {
  assert.equal(redactText('x'.repeat(9000)).length, 4096)
  assert.equal(redactLine('a\nb'), 'a b')
})

test('artifact paths that escape the run directory are dropped', () => {
  const { cases } = normalizeSummary(
    v2({
      cases: [
        {
          caseId: 'CPS-FE-AUTH-001',
          status: 'passed',
          artifacts: [
            { kind: 'video', path: 'videos/ok.mp4' },
            { kind: 'video', path: '/etc/passwd' },
            { kind: 'video', path: '../../secrets.mp4' },
            { kind: 'video', path: 'https://evil.example/x.mp4' },
            { kind: 'not-a-kind', path: 'videos/ok.mp4' },
          ],
        },
      ],
    }),
    0,
  )
  assert.deepEqual(cases[0].artifacts, [{ kind: 'video', path: 'videos/ok.mp4' }])
})

test('a case reported twice is recorded once and flagged', () => {
  const result = normalizeSummary(
    v2({
      totals: { tests: 2, passed: 2 },
      cases: [
        { caseId: 'CPS-FE-AUTH-001', status: 'passed' },
        { caseId: 'CPS-FE-AUTH-001', status: 'failed' },
      ],
    }),
    0,
  )
  assert.equal(result.cases.length, 1)
  assert.deepEqual(result.duplicates, ['CPS-FE-AUTH-001'])
})

test('an unparseable schemaVersion is rejected rather than guessed', () => {
  assert.throws(() => normalizeSummary({ schemaVersion: 9 }, 0), (error) => error.code === 'summary_schema_invalid')
  assert.throws(() => normalizeSummary(null, 0), (error) => error.code === 'summary_schema_invalid')
})

test('flaky is a pass with a flag, not a failure', () => {
  const result = normalizeSummary(
    v2({
      totals: { tests: 2, passed: 1, flaky: 1 },
      cases: [
        { caseId: 'CPS-FE-AUTH-001', status: 'passed' },
        { caseId: 'CPS-FE-AUTH-002', status: 'flaky', attempts: 2 },
      ],
    }),
    0,
  )
  assert.equal(result.status, 'flaky')
})

test('an unrecognized exit code is blocked, and says which code', () => {
  const result = normalizeSummary(v2(), 137)
  assert.equal(result.status, 'blocked')
  assert.match(result.blockedReason, /137/)
})

test('catalog reconciliation separates notRun from unmapped', () => {
  const catalog = [
    { caseId: 'A-FE-X-001', requirementRef: 'REQ-1' },
    { caseId: 'A-FE-X-002' },
    { caseId: 'A-FE-X-003' },
  ]
  const executed = [
    { caseId: 'A-FE-X-001', status: 'passed' },
    { caseId: 'A-FE-X-002', status: 'failed' },
    { caseId: 'A-FE-X-999', status: 'passed', specPath: 'spec.ts', title: '未登记' },
  ]
  const { cases, catalog: summary } = compareWithCatalog(catalog, executed)

  assert.equal(summary.counts.notRun, 1)
  assert.equal(summary.counts.passed, 1)
  assert.equal(summary.counts.failed, 1)
  assert.deepEqual(
    summary.unmapped.map((entry) => entry.caseId),
    ['A-FE-X-999'],
  )
  // Unmapped executions must stay out of the catalog tallies, or the
  // denominators stop meaning anything.
  assert.equal(summary.catalogTotal, 3)
  assert.equal(summary.coverage.catalogCompletionPercent, 66.67)
  assert.equal(summary.coverage.executedPassPercent, 50)
  assert.equal(summary.coverage.requirementLinkedPercent, 33.33)
  assert.equal(cases.length, 4)
  assert.equal(cases.find((entry) => entry.caseId === 'A-FE-X-999').inCatalog, false)
})

test('an empty catalog yields zeroes, not a division by zero', () => {
  const { catalog } = compareWithCatalog([], [])
  assert.equal(catalog.coverage.catalogPassPercent, 0)
  assert.equal(catalog.catalogTotal, 0)
})
