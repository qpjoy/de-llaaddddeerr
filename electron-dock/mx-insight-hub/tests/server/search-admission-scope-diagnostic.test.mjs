import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { diagnoseAdmissionScope } from '../../server/ops/diagnose-search-admission-scope.mjs'
import { searchAdmissionDispositionFixture, pgOptions } from '../fixtures/search-admission-disposition.mjs'

const writes = statements => statements.filter(sql => /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql))

test('lists every unresolved request in the blocker scope and marks only in-flight ones as blocking, read-only', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t)
  const second = await f.addUnknown()
  const running = await f.addUnknown({ status: 'reserved', protocol: false, withCall: false })
  await f.db.query("UPDATE usage_requests SET lease_expires_at=now()+interval '2 minutes' WHERE id=$1", [running.id])
  const unrelated = await f.addUnknown({ query: 'unrelated scope query' })
  const before = f.statements.length
  const report = await diagnoseAdmissionScope(f.pool, f.id)
  assert.deepEqual(writes(f.statements.slice(before)), [])
  assert.equal(report.diagnosticRevision, 'search-admission-scope.v2')
  assert.equal(report.readOnlyTransaction, true)
  assert.deepEqual(report.inFlightRule, { installed: true })
  assert.deepEqual(report.disposition, { tablePresent: true, moduleInstalled: true, available: true })
  assert.deepEqual(report.blockers.map(row => row.requestId).sort(), [f.id, second.id, running.id].sort())
  assert.ok(!report.blockers.some(row => row.requestId === unrelated.id))
  const first = report.blockers.find(row => row.requestId === f.id)
  assert.equal(first.usageStatus, 'unknown')
  assert.equal(first.bindingState, 'unknown')
  assert.equal(first.action, 'none_not_in_flight')
  assert.equal(first.inFlightUntil, null)
  assert.deepEqual(first.calls.map(call => [call.provider, call.operation, call.outcome]), [['rapidapi', 'social.content.search', 'unknown']])
  const live = report.blockers.find(row => row.requestId === running.id)
  assert.equal(live.action, 'wait_in_progress')
  assert.ok(Date.parse(live.inFlightUntil) > Date.now())
  assert.deepEqual(report.summary, { blocking: 1, needDisposition: 0, inProgress: 1, stuck: 0, blockerIdListed: true })
  assert.equal(report.scope.queryLength, f.body.query.length)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(f.body.query))
})

test('disposed blockers report as disposed and a finished lease stops blocking', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t)
  const running = await f.addUnknown({ status: 'reserved', protocol: false, withCall: false })
  await f.db.query("UPDATE usage_requests SET lease_expires_at=now()+interval '2 minutes' WHERE id=$1", [running.id])
  await f.resolve()
  const report = await diagnoseAdmissionScope(f.pool, f.id)
  assert.equal(report.blockers.find(row => row.requestId === f.id).action, 'none_disposed')
  assert.equal(report.blockers.find(row => row.requestId === running.id).action, 'wait_in_progress')
  assert.deepEqual(report.summary, { blocking: 1, needDisposition: 0, inProgress: 1, stuck: 0, blockerIdListed: true })
  const later = await diagnoseAdmissionScope(f.pool, f.id, { now: Date.now() + 5 * 60000 })
  assert.equal(later.blockers.find(row => row.requestId === running.id).action, 'none_not_in_flight')
  assert.deepEqual(later.summary, { blocking: 0, needDisposition: 0, inProgress: 0, stuck: 0, blockerIdListed: true })
})

test('without the disposition migration an ended unknown is still reported as not blocking', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t, { withMigration: false })
  const report = await diagnoseAdmissionScope(f.pool, f.id)
  assert.equal(report.disposition.tablePresent, false)
  assert.equal(report.disposition.available, false)
  assert.equal(report.blockers[0].action, 'none_not_in_flight')
  assert.equal(report.summary.blocking, 0)
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
