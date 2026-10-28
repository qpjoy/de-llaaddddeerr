import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { diagnoseAdmissionScope } from '../../server/ops/diagnose-search-admission-scope.mjs'
import { searchAdmissionDispositionFixture, pgOptions } from '../fixtures/search-admission-disposition.mjs'

const writes = statements => statements.filter(sql => /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql))

test('lists every unresolved request in the blocker scope with its required action, read-only', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t)
  const second = await f.addUnknown()
  const running = await f.addUnknown({ status: 'reserved', protocol: false, withCall: false })
  const unrelated = await f.addUnknown({ query: 'unrelated scope query' })
  const before = f.statements.length
  const report = await diagnoseAdmissionScope(f.pool, f.id)
  assert.deepEqual(writes(f.statements.slice(before)), [])
  assert.equal(report.readOnlyTransaction, true)
  assert.deepEqual(report.disposition, { tablePresent: true, moduleInstalled: true, available: true })
  assert.deepEqual(report.blockers.map(row => row.requestId).sort(), [f.id, second.id, running.id].sort())
  assert.ok(!report.blockers.some(row => row.requestId === unrelated.id))
  const first = report.blockers.find(row => row.requestId === f.id)
  assert.equal(first.usageStatus, 'unknown')
  assert.equal(first.bindingState, 'unknown')
  assert.equal(first.action, 'dispose_in_diagnostics_center')
  assert.deepEqual(first.calls.map(call => [call.provider, call.operation, call.outcome]), [['rapidapi', 'social.content.search', 'unknown']])
  assert.equal(report.blockers.find(row => row.requestId === running.id).action, 'investigate_stuck_reservation')
  assert.deepEqual(report.summary, { blocking: 3, needDisposition: 2, inProgress: 0, stuck: 1, blockerIdListed: true })
  assert.equal(report.scope.queryLength, f.body.query.length)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(f.body.query))
})

test('disposed blockers stop counting and a fresh reservation is reported as in progress', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t)
  const running = await f.addUnknown({ status: 'reserved', protocol: false, withCall: false })
  await f.resolve()
  const report = await diagnoseAdmissionScope(f.pool, f.id, { now: Date.now() - 55 * 60000 })
  assert.equal(report.blockers.find(row => row.requestId === f.id).action, 'none_disposed')
  assert.equal(report.blockers.find(row => row.requestId === running.id).action, 'wait_in_progress')
  assert.deepEqual(report.summary, { blocking: 1, needDisposition: 0, inProgress: 1, stuck: 0, blockerIdListed: true })
})

test('without the disposition migration the report says to deploy it first', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t, { withMigration: false })
  const report = await diagnoseAdmissionScope(f.pool, f.id)
  assert.equal(report.disposition.tablePresent, false)
  assert.equal(report.disposition.available, false)
  assert.equal(report.blockers[0].action, 'deploy_disposition_then_dispose')
})

test('the command validates its single request UUID before reading the database', () => {
  const script = fileURLToPath(new URL('../../server/ops/diagnose-search-admission-scope.mjs', import.meta.url))
  for (const [args, code] of [[[], 'invalid_arguments'], [['not-a-uuid'], 'invalid_request_id'],
    [['17b94611-6ecf-4680-a01c-f147476c48e7'], 'database_url_required']]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(run.status, 1)
    assert.equal(JSON.parse(run.stdout).errorCode, code)
  }
})
