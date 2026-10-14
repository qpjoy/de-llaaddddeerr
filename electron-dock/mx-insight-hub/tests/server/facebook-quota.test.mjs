import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PlatformSearchPolicyStore, facebookProbeIntervalHours, facebookRecoveryCheckAt,
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

test('the Shanghai billing-day window shortens check scheduling without changing quota', () => {
  for (const [time, expected] of [
    ['2026-10-25T23:59:59+08:00', 72], ['2026-10-26T00:00:00+08:00', 6],
    ['2026-10-29T23:59:59+08:00', 6], ['2026-10-30T00:00:00+08:00', 72],
  ]) assert.equal(facebookProbeIntervalHours(policy, Date.parse(time)), expected)
  assert.equal(facebookProbeIntervalHours({ ...policy, billing_cycle_day: 1 }, Date.parse('2026-12-31T23:00:00+08:00')), 6)
  assert.equal(facebookProbeIntervalHours({ ...policy, billing_cycle_day: 31 }, Date.parse('2027-02-28T23:00:00+08:00')), 6)
  const state = { ...policy, used: 1000, remaining: 0, updated_at: '2026-10-25T18:00:00+08:00',
    blocked_until: '2026-10-28T18:00:00+08:00', reset_at: null }
  assert.equal(facebookRecoveryCheckAt(state, Date.parse('2026-10-26T02:00:00+08:00')), Date.parse('2026-10-26T00:00:00+08:00'))
  assert.deepEqual([state.used, state.remaining], [1000, 0])
  const confirmed = { ...state, reset_at: '2026-10-27T12:00:00+08:00' }
  assert.equal(facebookRecoveryCheckAt(confirmed, Date.parse('2026-10-26T02:00:00+08:00')), Date.parse(confirmed.reset_at))
})

test('PostgreSQL Facebook quota admission and recovery preserve subscription evidence',
  { skip: !process.env.MX_FACEBOOK_TEST_DATABASE_URL }, async t => {
    const source = new URL(process.env.MX_FACEBOOK_TEST_DATABASE_URL)
    assert.match(source.pathname, /^\/mx_facebook_test_/)
    const database = `mx_facebook_test_quota_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Pool({ connectionString: source.toString() })
    await admin.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`)
    source.pathname = `/${database}`
    const pool = new pg.Pool({ connectionString: source.toString() })
    try {
      await pool.query('CREATE SCHEMA control')
      const baseline = await readFile(new URL('../../migrations/143_facebook_platform_search.sql', import.meta.url), 'utf8')
      await pool.query(baseline.slice(baseline.indexOf('CREATE TABLE'), baseline.indexOf('ALTER TABLE')))
      await pool.query(await readFile(new URL('../../migrations/149_facebook_billing_window.sql', import.meta.url), 'utf8'))
      const store = new PlatformSearchPolicyStore(pool)
      const reset = async () => {
        await pool.query(`UPDATE control.facebook_rapid_quota SET used=0,remaining=NULL,reset_at=NULL,
          blocked_until=NULL,reason=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()`)
        await pool.query(`UPDATE control.platform_search_policies SET mode='auto',monthly_limit=1000,
          probe_interval_hours=72,billing_cycle_day=27,billing_probe_interval_hours=6 WHERE platform='facebook'`)
      }

      await t.test('the last included call is serialized across replicas and stops without a 429', async () => {
        await reset()
        await pool.query('UPDATE control.facebook_rapid_quota SET used=999,remaining=1')
        const admissions = await Promise.all(Array.from({ length: 20 }, () => store.admitRapid()))
        assert.equal(admissions.filter(row => row.allowed).length, 1)
        await store.observeRapid(admissions.find(row => row.allowed), observe({ 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-limit': '1000' }))
        assert.equal((await store.admitRapid()).allowed, false)
        assert.equal((await store.facebook()).remaining, 0)
      })

      await t.test('elapsed reset permits one probe and HTTP 200 without billing headers cannot refill quota', async () => {
        for (const [used, remaining] of [[1000, 0], [400, 600]]) {
          await reset()
          await pool.query(`UPDATE control.facebook_rapid_quota SET used=$1,remaining=$2,
            reset_at=now()-interval '1 second',blocked_until=now()-interval '1 second'`, [used, remaining])
          const admissions = await Promise.all(Array.from({ length: 12 }, () => store.admitRapid()))
          const admitted = admissions.find(row => row.allowed)
          assert.equal(admissions.filter(row => row.allowed).length, 1)
          assert.equal(admitted.probe, true)
          assert.equal((await store.facebook()).used, used + 1, 'clock advancement preserves observed usage')
          await store.observeRapid(admitted, observe({ 'x-ratelimit-remaining': '999', 'x-ratelimit-reset': '60' }))
          assert.equal((await store.admitRapid()).allowed, false)
          assert.equal((await store.facebook()).reset_at, null)
        }
      })

      await t.test('conflicting headers and a different plan limit never confirm recovery', async () => {
        for (const headers of [
          { 'x-ratelimit-requests-remaining': '999', 'x-rapidapi-requests-remaining': '1' },
          { 'x-ratelimit-requests-remaining': '99', 'x-ratelimit-requests-limit': '100' },
          { 'x-rate-limit-rapid-free-plans-hard-limit-remaining': '999' },
        ]) {
          await reset()
          await pool.query(`UPDATE control.facebook_rapid_quota SET used=1000,remaining=0,
            blocked_until=now()-interval '1 second',reason='quota_exhausted'`)
          await store.observeRapid(await store.admitRapid(), observe(headers))
          assert.equal((await store.admitRapid()).allowed, false)
        }
      })

      await t.test('positive billing evidence confirms recovery and ordinary renewal updates the local counter', async () => {
        for (const exhausted of [true, false]) {
          await reset()
          await pool.query(`UPDATE control.facebook_rapid_quota SET used=$1,remaining=$2,
            blocked_until=now()-interval '1 second'`, exhausted ? [1000, 0] : [900, 100])
          await store.observeRapid(await store.admitRapid(), observe({ 'x-rapidapi-requests-remaining': '998', 'x-rapidapi-requests-limit': '1000' }))
          const state = await store.facebook()
          assert.equal(state.used, 2)
          assert.equal(state.remaining, 998)
          assert.equal(state.blocked_until, null)
          assert.equal((await store.admitRapid()).allowed, true)
        }
      })

      await t.test('entering the billing window shortens an existing wait but never overrides an active lease', async () => {
        await reset()
        await pool.query(`UPDATE control.platform_search_policies SET billing_cycle_day=extract(day FROM now() AT TIME ZONE 'Asia/Shanghai') WHERE platform='facebook'`)
        await pool.query(`UPDATE control.facebook_rapid_quota SET used=1000,remaining=0,reason='quota_exhausted',
          updated_at=now()-interval '8 hours',blocked_until=now()+interval '64 hours'`)
        const projected = await store.facebook()
        assert.ok(new Date(projected.next_recovery_check_at) < new Date(projected.blocked_until))
        assert.equal(new Date(projected.next_recovery_check_at) - new Date(projected.observed_at), 6 * 3600000,
          'the projection uses quota observation time, not the policy edit time')
        const admission = await store.admitRapid()
        assert.equal(admission.allowed, true)
        assert.equal(admission.probe, true)
        assert.equal((await store.admitRapid()).reason, 'source_busy')
        await store.observeRapid(admission, {})
        const state = await store.facebook()
        const delay = new Date(state.blocked_until) - new Date(state.observed_at)
        assert.ok(delay > 5.99 * 3600000 && delay <= 6 * 3600000)
      })

      await t.test('the billing window preserves a current short rate-limit cooldown', async () => {
        await reset()
        await pool.query(`UPDATE control.platform_search_policies SET billing_cycle_day=extract(day FROM now() AT TIME ZONE 'Asia/Shanghai') WHERE platform='facebook'`)
        await pool.query(`UPDATE control.facebook_rapid_quota SET used=10,remaining=990,reason='rate_limited',
          updated_at=now()-interval '10 hours',blocked_until=now()+interval '5 minutes'`)
        const state = await store.facebook()
        assert.equal(new Date(state.next_recovery_check_at).getTime(), new Date(state.blocked_until).getTime())
        assert.equal((await store.admitRapid()).reason, 'rate_limited')
      })

      await t.test('old policy clients preserve billing-window settings, and changes retain revision CAS', async () => {
        await reset()
        const initial = await store.facebook()
        const input = { mode: 'auto', monthlyLimit: 1000, probeIntervalHours: 72,
          billingCycleDay: 26, billingProbeIntervalHours: 4, expectedRevision: initial.revision, reason: 'Test window' }
        await store.update('facebook', input)
        await assert.rejects(store.update('facebook', input), { code: 'platform_search_revision_conflict' })
        const { billingCycleDay, billingProbeIntervalHours, ...oldClient } = input
        const retained = await store.update('facebook', { ...oldClient, expectedRevision: initial.revision + 1 })
        assert.equal(retained.billing_cycle_day, 26)
        assert.equal(retained.billing_probe_interval_hours, 4)
      })
    } finally {
      await pool.end()
      await admin.query(`DROP DATABASE ${database}`)
      await admin.end()
    }
  })
