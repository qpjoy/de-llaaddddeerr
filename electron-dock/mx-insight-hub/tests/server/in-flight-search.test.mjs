import test from 'node:test'
import assert from 'node:assert/strict'
import { IN_FLIGHT_FALLBACK_MS, IN_FLIGHT_FALLBACK_SQL, inFlightRetryAfterSeconds, inFlightUntil, searchInFlight }
  from '../../server/data/in-flight-search.mjs'
import { RESPONSE_QUARANTINE_MS } from '../../server/core/admission-recovery.mjs'

const now = Date.parse('2026-10-28T12:00:00Z')

test('a reservation is in flight only until its lease, or the protocol lease when none is recorded', () => {
  assert.equal(IN_FLIGHT_FALLBACK_MS, 5 * 60_000)
  assert.equal(IN_FLIGHT_FALLBACK_SQL, 'make_interval(secs=>300)')
  assert.equal(searchInFlight({ leaseExpiresAt: new Date(now + 1000) }, now), true)
  assert.equal(searchInFlight({ leaseExpiresAt: new Date(now - 1), reservedAt: new Date(now) }, now), false)
  assert.equal(searchInFlight({ reservedAt: new Date(now - IN_FLIGHT_FALLBACK_MS + 1000) }, now), true)
  assert.equal(searchInFlight({ reservedAt: '2026-10-19T06:05:50.795Z' }, now), false)
  assert.equal(searchInFlight({}, now), false, 'no timestamp can make a row hold indefinitely')
  assert.equal(inFlightUntil({ leaseExpiresAt: '2026-10-28T12:01:00Z' }), Date.parse('2026-10-28T12:01:00Z'))
})

test('the retry hint is the remaining lease, at least one second and at most the existing 300 seconds', () => {
  assert.equal(inFlightRetryAfterSeconds(now + 42_500, now), 43)
  assert.equal(inFlightRetryAfterSeconds(now + 20 * 60_000, now), 300)
  assert.equal(inFlightRetryAfterSeconds(now - 1, now), 1)
  assert.equal(inFlightRetryAfterSeconds(undefined, now), 300)
})

test('the response quarantine is a fixed five minutes', () => {
  assert.equal(RESPONSE_QUARANTINE_MS, 300_000)
})
