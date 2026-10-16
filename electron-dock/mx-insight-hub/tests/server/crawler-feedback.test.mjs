import assert from 'node:assert/strict'
import test from 'node:test'
import { crawlerCheckFeedback, crawlerRecoveryFeedback, isCrawlerPipelineSnapshot } from '../../src/crawler-feedback.mjs'

const keys = ['news', 'web', 'tender'].map(type => `night-all-saved-records-${type}`)
const healthy = () => ({ checkedAt: '2026-10-16T10:00:00Z', tasks: keys.map(sourceKey => ({ sourceKey, totalRows: 0, percent: 100, issues: [] })) })

test('source checks distinguish a successful probe from an old failed cleaning cursor', () => {
  const result = healthy()
  result.tasks[0].cursor = { status: 'failed', error: 'old_schema_error' }
  const report = crawlerCheckFeedback(keys, result)
  assert.equal(report.passed, 3)
  assert.equal(report.blocked, 0)
  assert.equal(report.checkedAt, result.checkedAt)
  assert.equal(result.tasks[0].cursor.status, 'failed', 'feedback must not clear a failed cursor')
})

test('source checks report all blocker evidence even with 100 percent completion', () => {
  const result = healthy()
  result.tasks[1].error = { code: 'probe_failed', message: 'cannot inspect this leaf' }
  result.tasks[2].blocker = 'source_contract_mismatch'
  result.tasks[2].issues = ['missing cursor index']
  const report = crawlerCheckFeedback(keys, result)
  assert.equal(report.passed, 1)
  assert.equal(report.blocked, 2)
  assert.deepEqual(report.rows[1].issues, ['probe_failed', 'cannot inspect this leaf'])
  assert.deepEqual(report.rows[2].issues, ['source_contract_mismatch', 'missing cursor index'])
})

test('missing, duplicate and malformed checks never become a successful count', () => {
  const result = healthy()
  result.tasks = [result.tasks[0], result.tasks[0], { sourceKey: keys[1] }, { sourceKey: 'unrelated', totalRows: 100 }]
  const report = crawlerCheckFeedback(keys, result)
  assert.equal(report.total, 3)
  assert.equal(report.passed, 0)
  assert.equal(report.missing, 2)
  assert.equal(report.blocked, 1)
  assert.equal(crawlerCheckFeedback(keys, null).missing, 3)
  assert.equal(crawlerCheckFeedback(keys, { tasks: keys.map(sourceKey => ({ sourceKey, totalRows: 0, error: {} })) }).passed, 0)
})

test('HTTP 200 recovery results preserve partial failure and show error code plus message', () => {
  const result = { tasks: [
    { sourceKey: keys[0], resumed: true },
    { sourceKey: keys[1], resumed: false, status: 'idle' },
    { sourceKey: keys[2], resumed: false, error: { code: 'writer_contract_attestation_required', message: 'current approval missing' } },
  ] }
  const original = structuredClone(result)
  const report = crawlerRecoveryFeedback(keys, result)
  assert.equal(report.resumed, 1)
  assert.equal(report.unchanged, 1)
  assert.equal(report.failed, 1)
  assert.equal(report.tone, 'warning')
  assert.match(report.message, /已恢复 1 个，恢复受阻 1 个，无需恢复 1 个/u)
  assert.deepEqual(report.rows[2].issues, ['writer_contract_attestation_required', 'current approval missing'])
  assert.deepEqual(result, original)
})

test('no-op recovery is informational and missing or contradictory results never report success', () => {
  const unchanged = crawlerRecoveryFeedback(keys, { tasks: keys.map(sourceKey => ({ sourceKey, resumed: false })) })
  assert.equal(unchanged.resumed, 0)
  assert.equal(unchanged.unchanged, 3)
  assert.equal(unchanged.tone, 'info')
  const result = crawlerRecoveryFeedback(keys, { tasks: [
    { sourceKey: keys[0], resumed: true, error: 'inconsistent result' },
    { sourceKey: keys[1] },
  ] })
  assert.equal(result.resumed, 0)
  assert.equal(result.failed, 2)
  assert.equal(result.missing, 1)
  assert.equal(result.tone, 'warning')
  assert.equal(crawlerRecoveryFeedback([], { tasks: [] }).tone, 'warning')
  assert.equal(crawlerRecoveryFeedback([keys[0]], { tasks: [{ sourceKey: keys[0], resumed: true, error: {} }] }).failed, 1)
})

test('only a complete pipeline snapshot can replace UI configuration', () => {
  assert.equal(isCrawlerPipelineSnapshot({ pipelineKey: 'night-all-saved-records', tasks: [], configured: true, status: 'mixed' }), true)
  for (const result of [null, { tasks: [] }, { status: 'scheduled' }, { pipelineKey: 'night-all-saved-records', tasks: [{ resumed: true }] }]) {
    assert.equal(isCrawlerPipelineSnapshot(result), false)
  }
})
