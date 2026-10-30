import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { waitForFacebookRapidAdmission } from '../../server/external-platforms/facebook-rapid-admission.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { diagnoseFacebookQuota } from '../../server/ops/diagnose-facebook-quota.mjs'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { facebookQuotaFixture as fixture } from '../helpers/facebook-quota.mjs'

const pg = { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }
const ticket = () => ({ id: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 10000 })

test('shared FIFO preserves quota until its head acquires it, then the last included call cannot be purchased twice', pg, async t => {
  const { db, store, replica } = await fixture(t)
  await db.exec('UPDATE control.facebook_rapid_quota SET used=998,remaining=2')
  const first = await store.admitRapid(ticket())
  assert.equal(first.allowed, true)
  const a = ticket(), b = ticket()
  assert.equal((await store.admitRapid(a)).reason, 'source_busy')
  assert.equal((await replica.admitRapid(b)).reason, 'source_busy')
  const before = await store.facebook()
  assert.equal(before.used, 999); assert.equal(before.remaining, 1); assert.equal(before.queue_depth, 2)
  await store.observeRapid(first, { ok: true, remaining: 1, limit: 1000 })
  assert.equal((await replica.admitRapid(b)).reason, 'source_busy', 'a later waiter cannot jump the head even after release')
  assert.equal((await store.admitRapid()).reason, 'source_busy', 'legacy callers cannot jump an existing FIFO')
  const last = await store.admitRapid(a)
  assert.equal(last.allowed, true)
  assert.equal(last.used, 1000); assert.equal(last.remaining, 0)
  await store.observeRapid(last, { ok: true, remaining: 0, limit: 1000 })
  assert.equal((await replica.admitRapid(b)).reason, 'quota_exhausted')
  assert.equal((await store.facebook()).queue_depth, 0)
  assert.equal((await store.facebook()).available_included, 0)
})

test('current serialized headers replace conservative allowance; stale lease callbacks cannot overwrite a new owner', pg, async t => {
  const { db, store, replica } = await fixture(t)
  await db.exec('UPDATE control.facebook_rapid_quota SET used=990,remaining=10')
  const ordinary = await store.admitRapid(ticket())
  await store.observeRapid(ordinary, { ok: true, remaining: 999, limit: 1000 })
  let state = await store.facebook()
  assert.equal(state.used, 991); assert.equal(state.remaining, 999)
  await db.exec("UPDATE control.facebook_rapid_quota SET used=1000,remaining=0,reason='quota_exhausted',reset_at=now()-interval '1 second'")
  const probe = await store.admitRapid(ticket())
  assert.equal(probe.allowed, true); assert.equal(probe.probe, true)
  const pending = ticket()
  assert.equal((await replica.admitRapid(pending)).reason, 'source_busy')
  await store.observeRapid(probe, { ok: true, remaining: 998, limit: 1000 })
  state = await store.facebook()
  assert.equal(state.used, 1001); assert.equal(state.remaining, 998)
  const next = await replica.admitRapid(pending)
  assert.equal(next.allowed, true); assert.equal(next.probe, false)
  // A stale callback for the old probe cannot release/replenish a new owner.
  await store.observeRapid(probe, { ok: true, remaining: 999, limit: 1000 })
  assert.equal((await store.facebook()).used, 1002)
  await replica.observeRapid(next)
})

test('waiting is bounded and cancellation/expiry remove only the matching ticket without moving recovery timing', pg, async t => {
  const { db, store } = await fixture(t)
  const active = await store.admitRapid(ticket())
  const observedAt = (await store.facebook()).observed_at
  const tickets = Array.from({ length: 32 }, ticket)
  for (const item of tickets) assert.equal((await store.admitRapid(item)).reason, 'source_busy')
  assert.equal((await store.admitRapid(ticket())).reason, 'queue_full')
  await store.cancelRapidWait({ ...tickets[0], requestId: randomUUID() })
  assert.equal((await store.facebook()).queue_depth, 32)
  await store.cancelRapidWait(tickets[0])
  assert.equal((await store.facebook()).queue_depth, 31)
  assert.equal(new Date((await store.facebook()).observed_at).getTime(), new Date(observedAt).getTime())
  await db.exec("UPDATE control.facebook_rapid_quota SET waiters=jsonb_set(waiters,'{0,deadline}',to_jsonb(0))")
  assert.equal((await store.admitRapid(ticket())).reason, 'source_busy')
  assert.equal((await store.facebook()).queue_depth, 31)
  await store.observeRapid(active)
  assert.equal((await store.facebook()).used, 1, 'waiting never reserved extra allowance')
})

test('HTTP admission waits only for shared busy, revalidates after acquisition and logs bounded metadata', async () => {
  let now = 1000, tries = 0, checks = 0, cancelled = 0
  const logs = [], input = { requestId: randomUUID(), deadlineAt: 100000, timeoutMs: 1000,
    logger: { info: value => logs.push(JSON.parse(value)) }, revalidate: async () => { checks++ },
    policyStore: { admitRapid: async () => ++tries < 3 ? { allowed: false, reason: 'source_busy' }
      : { allowed: true, token: 'fixture', used: 1, remaining: 999 }, cancelRapidWait: async () => { cancelled++ } } }
  const result = await waitForFacebookRapidAdmission(input, { clock: () => now, wait: async ms => { now += ms } })
  assert.equal(result.allowed, true); assert.equal(checks, 1); assert.equal(tries, 3); assert.equal(cancelled, 0)
  assert.equal(logs[0].reason, 'included_quota'); assert.equal(logs[0].waitedMs, 1000)
  const refused = await waitForFacebookRapidAdmission({ ...input,
    policyStore: { admitRapid: async () => ({ allowed: false, reason: 'quota_exhausted' }) } }, { clock: () => now })
  assert.equal(refused.allowed, false); assert.equal(checks, 1)
})

test('queue timeout/full/cancel and failed revalidation never trigger another channel or replenish quota', async () => {
  for (const scenario of ['timeout', 'full', 'cancel', 'access', 'database']) {
    let now = 1000, released = 0, cancelled = 0
    const abort = new AbortController()
    const input = { requestId: randomUUID(), deadlineAt: 100000, timeoutMs: 1000, signal: abort.signal,
      revalidate: async () => { throw new AppError(403, 'capability_not_granted', 'access changed') },
      policyStore: { admitRapid: async () => {
        if (scenario === 'database') throw new Error('private-database-credential')
        return scenario === 'access' ? { allowed: true, token: 'fixture' }
          : { allowed: false, reason: scenario === 'full' ? 'queue_full' : 'source_busy' }
      }, cancelRapidWait: async () => { cancelled++ }, observeRapid: async () => { released++ } } }
    await assert.rejects(waitForFacebookRapidAdmission(input, { clock: () => now, wait: async ms => {
      now += ms; if (scenario === 'cancel') abort.abort()
    } }), error => {
      assert.equal(error.code, ({ access: 'capability_not_granted', cancel: 'request_cancelled', database: 'facebook_quota_state_unavailable' })[scenario] || 'external_platform_busy')
      assert.doesNotMatch(JSON.stringify(error), /private-database-credential/)
      return true
    })
    assert.equal(cancelled, scenario === 'access' ? 0 : 1); assert.equal(released, scenario === 'access' ? 1 : 0)
  }
})

test('quota diagnostic executes bounded read-only SQL against both old and new schemas without exposing business data', pg, async t => {
  const { db, pool } = await fixture(t)
  await db.exec(`CREATE SCHEMA external_platform;
    CREATE TABLE external_platform.provider_calls(id uuid,usage_request_id uuid,outcome text,http_status int,
      cost_kind text,started_at timestamptz,completed_at timestamptz,provider_key text,operation text,endpoint_key text);
    CREATE TABLE external_platform.response_archives(provider_call_id uuid,raw_payload jsonb);
    UPDATE control.facebook_rapid_quota SET used=999,remaining=1;`)
  for (let i = 0; i < 31; i++) {
    const callId = randomUUID()
    await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,'succeeded',200,'estimated',now(),now(),
      'rapidapi','social.facebook.search','facebook-scraper3.search')`, [callId, randomUUID()])
    await db.query('INSERT INTO external_platform.response_archives VALUES($1,$2)', [callId, JSON.stringify({
      privateBody: 'private-keyword-and-credential', response: { quota: { remaining: 1, limit: 1000,
        billingHeaderSource: 'x-ratelimit-requests', privateHeader: 'private-credential' } } })])
  }
  const guarded = { connect: async () => {
    const client = await pool.connect()
    return { release: error => client.release(error), query: (sql, params) => {
      assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/u)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT)\b|restricted_raw|body_bytes|acquisition_request/u)
      return client.query(sql, params)
    } }
  } }
  let report = await diagnoseFacebookQuota(guarded)
  assert.equal(report.state.availableIncluded, 1); assert.equal(report.state.queueSupported, true)
  assert.equal(report.recentCalls.length, 30); assert.equal(report.truncated, true)
  assert.equal(report.recentCalls[0].billingHeaders.limit, 1000)
  assert.doesNotMatch(JSON.stringify(report), /private-|privateBody|privateHeader/)
  await db.exec('ALTER TABLE control.facebook_rapid_quota DROP COLUMN waiters')
  report = await diagnoseFacebookQuota(guarded)
  assert.equal(report.state.queueSupported, false); assert.equal(report.state.queueDepth, 0)
  assert.equal(report.state.usedReserved, 999)
})

test('standalone quota diagnostic validates stdin execution without app imports or a live database', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-facebook-quota.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args, expected] of [[[], 'database_url_required'], [['invalid'], 'invalid_arguments']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stderr), { error: expected })
  }
})

test('LCY may bypass a Hub rate cooldown but retains purchased quota and shared dispatch ownership', pg, async t => {
  const { db, store } = await fixture(t)
  await db.exec("UPDATE control.facebook_rapid_quota SET used=10,remaining=990,reason='rate_limited',blocked_until=now()+interval '5 minutes'")
  assert.equal((await store.admitRapid(ticket())).reason, 'rate_limited')
  const admitted = await store.admitRapid({ ...ticket(), hubRateLimitExempt: true })
  assert.equal(admitted.allowed, true)
  assert.equal(admitted.used, 11)
  assert.equal(admitted.remaining, 989)
  const waiting = { ...ticket(), hubRateLimitExempt: true }
  assert.equal((await store.admitRapid(waiting)).reason, 'source_busy')
  await store.cancelRapidWait(waiting)
  await store.observeRapid(admitted)
  await db.exec("UPDATE control.facebook_rapid_quota SET used=1000,remaining=0,reason='quota_exhausted',blocked_until=now()+interval '1 day'")
  assert.equal((await store.admitRapid({ ...ticket(), hubRateLimitExempt: true })).reason, 'quota_exhausted')
})
