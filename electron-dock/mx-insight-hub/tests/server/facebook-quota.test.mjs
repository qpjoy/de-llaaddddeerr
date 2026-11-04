import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PlatformSearchPolicyStore, facebookRapidAvailable, facebookRecoveryCheckAt,
  rapidQuotaObservation } from '../../server/external-platforms/platform-search-policy.mjs'

const observe = (headers, status = 200) => rapidQuotaObservation(new Response('', { status, headers }))
const policy = { probe_interval_hours: 72, billing_cycle_day: 27, billing_probe_interval_hours: 6 }

test('Facebook uses only the subscribed Requests billing counters, including the newer header spelling', () => {
  for (const prefix of ['x-ratelimit-requests', 'x-rapidapi-requests']) {
    const result = observe({ [`${prefix}-remaining`]: '999', [`${prefix}-limit`]: '1000', [`${prefix}-reset`]: '2000000',
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '60',
      'x-rate-limit-rapid-free-plans-hard-limit-remaining': '0', 'x-rate-limit-rapid-free-plans-hard-limit-reset': '86400' })
    assert.equal(result.remaining, 999)
    assert.equal(result.limit, 1000)
    assert.equal(result.resetSeconds, 2000000)
    assert.equal(result.billingHeaderSource, prefix)
  }
  const unknown = observe({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '60',
    'x-rate-limit-rapid-free-plans-hard-limit-remaining': '100', 'x-rate-limit-rapid-free-plans-hard-limit-reset': '86400' })
  assert.equal(unknown.remaining, null)
  assert.equal(unknown.resetSeconds, null)
})

test('conflicting billing headers and unpaired reset headers cannot establish quota recovery', () => {
  for (const field of ['remaining', 'limit', 'reset']) {
    const result = observe({ 'x-ratelimit-requests-remaining': '999', 'x-rapidapi-requests-remaining': '999',
      [`x-ratelimit-requests-${field}`]: '100', [`x-rapidapi-requests-${field}`]: '200' })
    assert.equal(result.quotaConflict, true)
    assert.equal(result.remaining, null)
    assert.equal(result.resetSeconds, null)
  }
  assert.equal(observe({ 'x-ratelimit-requests-reset': '86400' }).resetSeconds, null)
  assert.equal(observe({ 'x-ratelimit-requests-remaining': '900', 'x-rapidapi-requests-reset': '86400' }).resetSeconds, null)
  assert.equal(observe({ 'x-ratelimit-requests-remaining': '-1' }).remaining, null)
})

const pgLite = { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }
const { facebookQuotaFixture } = await import('../helpers/facebook-quota.mjs')

test('supplier reset replaces calendar hints; no reset means no scheduled probe', () => {
  for (const day of [25, 26, 27, 29, 30]) {
    const now = Date.parse(`2026-10-${day}T12:00:00+08:00`)
    const state = { ...policy, used: 1000, remaining: 0, updated_at: new Date(now - 8 * 3600000),
      blocked_until: new Date(now + 64 * 3600000), reset_at: null }
    assert.equal(facebookRecoveryCheckAt(state, now), null)
    assert.equal(facebookRapidAvailable(state, now), false)
    assert.equal(facebookRecoveryCheckAt({ ...state, reset_at: new Date(now + 1000) }, now), now + 1000)
    assert.equal(facebookRapidAvailable({ ...state, remaining: 16 }, now), true)
  }
})

test('supplier remaining 16 overrides local 1000; snapshot and in-flight reservation are distinct', pgLite, async t => {
  const { db, store } = await facebookQuotaFixture(t)
  await db.exec('UPDATE control.facebook_rapid_quota SET used=1000,remaining=1')
  const admission = await store.admitRapid()
  assert.equal(admission.allowed, true)
  await store.observeRapid(admission, observe({ 'x-ratelimit-requests-remaining': '16', 'x-ratelimit-requests-limit': '1000' }))
  const state = await store.facebook()
  assert.equal(state.used, 1001)
  assert.equal(state.remaining, 16)
  assert.equal(state.supplier_remaining, 16)
  assert.equal(state.supplier_limit, 1000)
  assert.equal(state.rapid_available, true)
  assert.equal((await store.admitRapid()).remaining, 15)
  const pending = await store.facebook()
  assert.equal(pending.supplier_remaining, 16)
  assert.equal(pending.available_included, 15)
  assert.equal(pending.rapid_available, true, 'catalog availability preserves the existing wait-for-lease path')
})

test('a trustworthy changed plan limit is accepted without a local monthly setting', pgLite, async t => {
  const { store } = await facebookQuotaFixture(t)
  await store.observeRapid(await store.admitRapid(), observe({ 'x-ratelimit-requests-remaining': '4999', 'x-ratelimit-requests-limit': '5000' }))
  const state = await store.facebook()
  assert.equal(state.monthly_limit, 1000)
  assert.equal(state.supplier_limit, 5000)
  assert.equal(state.remaining, 4999)
  assert.equal(state.used, 1)
})

test('missing/conflicting/malformed headers retain deductions and require evidence, never a calendar retry', pgLite, async t => {
  const { db, store } = await facebookQuotaFixture(t)
  for (const headers of [{}, { 'x-ratelimit-remaining': '999' },
    { 'x-ratelimit-requests-remaining': '16', 'x-rapidapi-requests-remaining': '17' },
    { 'x-ratelimit-requests-remaining': '1001', 'x-ratelimit-requests-limit': '1000' }]) {
    await db.exec("UPDATE control.facebook_rapid_quota SET remaining=16,reason=NULL,lease_until=NULL,lease_token=NULL")
    const admission = await store.admitRapid()
    await store.observeRapid(admission, observe(headers))
    const state = await store.facebook()
    assert.equal(state.remaining, 15)
    assert.equal(state.availability_reason, 'quota_unknown')
    assert.equal(state.next_recovery_check_at, null)
    assert.equal(state.rapid_available, false)
    assert.equal((await store.admitRapid()).allowed, false)
  }
})

test('elapsed reset admits exactly one request; unsuccessful evidence never permits another automatic probe', pgLite, async t => {
  const { db, store, replica } = await facebookQuotaFixture(t)
  await db.exec("UPDATE control.facebook_rapid_quota SET used=1000,remaining=0,reason='quota_exhausted',reset_at=now()-interval '1 second'")
  const results = await Promise.all(Array.from({ length: 12 }, () => replica.admitRapid()))
  const admitted = results.find(row => row.allowed)
  assert.equal(results.filter(row => row.allowed).length, 1)
  assert.equal(admitted.probe, true)
  assert.equal((await store.facebook()).reset_at, null)
  await store.observeRapid(admitted, observe({}))
  assert.equal((await store.admitRapid()).allowed, false)
  assert.equal((await store.facebook()).next_recovery_check_at, null)
})

test('expired initial probe lease cannot create an endless sequence of headerless paid calls', pgLite, async t => {
  const { db, store } = await facebookQuotaFixture(t)
  assert.equal((await store.admitRapid()).probe, true)
  await db.exec("UPDATE control.facebook_rapid_quota SET lease_until=now()-interval '1 second'")
  assert.equal((await store.admitRapid()).allowed, false)
  assert.equal((await store.facebook()).rapid_available, false)
})

test('manual check is audited, revision checked, single-use, and does not clear quota or dispatch', pgLite, async t => {
  const { db, store, replica } = await facebookQuotaFixture(t)
  await db.exec("UPDATE control.facebook_rapid_quota SET used=1000,remaining=0,reason='quota_unknown'")
  const before = await store.facebook()
  const input = { expectedObservedAt: before.observed_at.toISOString(), reason: 'Verify supplier allowance once' }
  const check = await store.requestRapidCheck(input)
  assert.equal(check.dispatched, false)
  assert.equal((await store.facebook()).remaining, 0)
  assert.equal((await store.facebook()).rapid_available, true)
  await assert.rejects(store.requestRapidCheck(input), error => ['facebook_quota_changed', 'facebook_quota_check_unavailable'].includes(error.code))
  const results = await Promise.all([store.admitRapid(), replica.admitRapid()])
  assert.equal(results.filter(row => row.allowed).length, 1)
  assert.equal(results.find(row => row.allowed).probe, true)
  assert.equal((await store.facebook()).manual_check_until, null)
  await store.observeRapid(results.find(row => row.allowed), observe({}))
  assert.equal((await replica.admitRapid()).allowed, false)
  assert.equal((await db.query('SELECT count(*)::int n FROM control.facebook_rapid_check_events')).rows[0].n, 1)
})

test('expired/manual checks preserve pause, active lease, and rate-limit protections', pgLite, async t => {
  const { db, store } = await facebookQuotaFixture(t)
  await db.exec("UPDATE control.facebook_rapid_quota SET used=1000,remaining=0,reason='quota_unknown',manual_check_until=now()-interval '1 second'")
  assert.equal((await store.admitRapid()).allowed, false)
  await db.exec("UPDATE control.platform_search_policies SET mode='paused' WHERE platform='facebook'")
  const state = await store.facebook()
  await assert.rejects(store.requestRapidCheck({ expectedObservedAt: state.observed_at.toISOString(), reason: 'check' }), { code: 'facebook_quota_check_unavailable' })
  await db.exec("UPDATE control.platform_search_policies SET mode='auto' WHERE platform='facebook'; UPDATE control.facebook_rapid_quota SET remaining=16,reason='rate_limited',blocked_until=now()+interval '5 minutes',manual_check_until=now()+interval '5 minutes'")
  assert.equal((await store.admitRapid()).reason, 'rate_limited')
})

test('policy edits remain CAS-audited; omitted retired settings preserve their historical values', pgLite, async t => {
  const { store } = await facebookQuotaFixture(t)
  const initial = await store.facebook()
  const input = { mode: 'auto', expectedRevision: initial.revision, reason: 'supplier headers' }
  const saved = await store.update('facebook', input)
  assert.equal(saved.monthly_limit, initial.monthly_limit)
  assert.equal(saved.billing_cycle_day, initial.billing_cycle_day)
  await assert.rejects(store.update('facebook', input), { code: 'platform_search_revision_conflict' })
  const old = await store.update('facebook', { ...input, expectedRevision: saved.revision, monthlyLimit: 1,
    probeIntervalHours: 24, billingCycleDay: 1, billingProbeIntervalHours: 1 })
  assert.equal(old.monthly_limit, 1)
  await store.observeRapid(await store.admitRapid(), observe({ 'x-ratelimit-requests-remaining': '16', 'x-ratelimit-requests-limit': '1000' }))
  assert.equal((await store.admitRapid()).allowed, true)
})

test('real PostgreSQL replicas serialize the last supplier allowance', { skip: !process.env.MX_FACEBOOK_TEST_DATABASE_URL }, async () => {
  const source = new URL(process.env.MX_FACEBOOK_TEST_DATABASE_URL)
  assert.match(source.pathname, /^\/mx_facebook_test_/)
  const database = `mx_facebook_test_quota_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: source.toString() })
  await admin.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`)
  source.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: source.toString() })
  try {
    await pool.query('CREATE SCHEMA control')
    const sql = await readFile(new URL('../../migrations/143_facebook_platform_search.sql', import.meta.url), 'utf8')
    await pool.query(sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf('ALTER TABLE')))
    for (const name of ['149_facebook_billing_window.sql', '151_facebook_rapid_admission_queue.sql', '169_facebook_supplier_quota.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
    }
    await pool.query('UPDATE control.facebook_rapid_quota SET used=1000,remaining=1')
    const store = new PlatformSearchPolicyStore(pool)
    const results = await Promise.all(Array.from({ length: 20 }, () => store.admitRapid()))
    assert.equal(results.filter(row => row.allowed).length, 1)
    await store.observeRapid(results.find(row => row.allowed), observe({ 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-limit': '1000' }))
    assert.equal((await store.admitRapid()).allowed, false)
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end() }
})

test('429 without billing evidence keeps a cooldown even with an explicit check, then stays unknown', pgLite, async t => {
  const { db, store } = await facebookQuotaFixture(t)
  await db.exec('UPDATE control.facebook_rapid_quota SET used=1000,remaining=16')
  await store.observeRapid(await store.admitRapid(), observe({ 'retry-after': '120' }, 429))
  const state = await store.facebook()
  assert.equal(state.availability_reason, 'quota_unknown')
  assert.equal(state.remaining, 15)
  await store.requestRapidCheck({ expectedObservedAt: state.observed_at.toISOString(), reason: 'single check after cooldown' })
  assert.equal((await store.admitRapid()).reason, 'rate_limited')
  assert.equal((await store.facebook()).rapid_available, false)
  await db.exec("UPDATE control.facebook_rapid_quota SET blocked_until=now()-interval '1 second',manual_check_until=NULL")
  assert.equal((await store.admitRapid()).allowed, false)
})

test('legacy migration preserves historical count/allowance and never manufactures an original supplier header', pgLite, async t => {
  const { PGlite } = await import(process.env.MX_INSIGHT_TEST_PGLITE_MODULE)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  const sql = await readFile(new URL('../../migrations/143_facebook_platform_search.sql', import.meta.url), 'utf8')
  await db.exec(sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf('ALTER TABLE')))
  await db.exec("UPDATE control.facebook_rapid_quota SET used=1000,remaining=0,reason='quota_exhausted',blocked_until=now()+interval '3 days'")
  await db.exec(await readFile(new URL('../../migrations/169_facebook_supplier_quota.sql', import.meta.url), 'utf8'))
  const row = (await db.query('SELECT * FROM control.facebook_rapid_quota')).rows[0]
  assert.equal(row.used, 1000); assert.equal(row.remaining, 0)
  assert.equal(row.reason, 'quota_unknown'); assert.equal(row.blocked_until, null)
  assert.equal(row.supplier_remaining, null); assert.equal(row.supplier_observed_at, null)
  assert.equal(row.manual_check_until, null)
})
