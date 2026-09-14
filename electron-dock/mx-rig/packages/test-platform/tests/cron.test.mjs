import assert from 'node:assert/strict'
import test from 'node:test'
import { nextCronTime, parseCron } from '../server/core/cron.mjs'

const at = (iso) => new Date(iso)

test('parses ranges, lists and steps', () => {
  const parsed = parseCron('0,30 9-17/4 * * *')
  assert.deepEqual([...parsed.minute].sort((a, b) => a - b), [0, 30])
  assert.deepEqual([...parsed.hour].sort((a, b) => a - b), [9, 13, 17])
})

test('a bare step means "from here to the end of the field"', () => {
  const parsed = parseCron('5/15 * * * *')
  assert.deepEqual([...parsed.minute].sort((a, b) => a - b), [5, 20, 35, 50])
})

test('accepts month and weekday aliases, and treats 7 as Sunday', () => {
  assert.ok(parseCron('0 0 * JAN MON').month.has(1))
  assert.ok(parseCron('0 0 * * 7').dayOfWeek.has(0))
})

test('rejects malformed expressions', () => {
  for (const expression of ['* * * *', '60 * * * *', '* 24 * * *', '* * * * 8', '*/0 * * * *']) {
    assert.throws(
      () => parseCron(expression),
      (error) => error.code === 'task_schedule_invalid',
      expression,
    )
  }
})

test('nightly schedule resolves in the configured zone, not UTC', () => {
  // 02:00 Asia/Shanghai is 18:00 UTC the previous day.
  const next = nextCronTime('0 2 * * *', at('2026-08-12T00:00:00Z'), 'Asia/Shanghai')
  assert.equal(next.toISOString(), '2026-08-12T18:00:00.000Z')
})

test('the boundary is exclusive: a matching instant advances to the next one', () => {
  const next = nextCronTime('0 2 * * *', at('2026-08-12T18:00:00Z'), 'Asia/Shanghai')
  assert.equal(next.toISOString(), '2026-08-13T18:00:00.000Z')
})

test('day-of-month and day-of-week are OR-ed when both are restricted', () => {
  // 2026-09-01 is a Tuesday; the next Monday is the 7th. Both must fire.
  const first = nextCronTime('0 0 1 * MON', at('2026-08-20T00:00:00Z'), 'UTC')
  assert.equal(first.toISOString(), '2026-08-24T00:00:00.000Z') // a Monday
  const second = nextCronTime('0 0 1 * MON', at('2026-08-31T12:00:00Z'), 'UTC')
  assert.equal(second.toISOString(), '2026-09-01T00:00:00.000Z') // the 1st
})

test('skips a local time that a spring-forward deletes', () => {
  // US Eastern jumps 02:00 -> 03:00 on 2026-03-08, so 02:30 never happens.
  const next = nextCronTime('30 2 * * *', at('2026-03-07T12:00:00Z'), 'America/New_York')
  assert.equal(next.toISOString(), '2026-03-09T06:30:00.000Z') // 02:30 EDT the next day
})

test('fires once for a local time a fall-back repeats', () => {
  // US Eastern repeats 01:00-01:59 on 2026-11-01; take the first occurrence.
  const next = nextCronTime('30 1 * * *', at('2026-11-01T00:00:00Z'), 'America/New_York')
  assert.equal(next.toISOString(), '2026-11-01T05:30:00.000Z') // 01:30 EDT, not EST
})

test('an unsatisfiable expression returns null rather than looping', () => {
  assert.equal(nextCronTime('0 0 30 2 *', at('2026-01-01T00:00:00Z'), 'UTC'), null)
})

test('resolves a yearly schedule by striding, not by scanning every minute', () => {
  const started = Date.now()
  const next = nextCronTime('0 0 1 1 *', at('2026-01-02T00:00:00Z'), 'UTC')
  assert.equal(next.toISOString(), '2027-01-01T00:00:00.000Z')
  // A year is ~525,000 minutes. The day/hour strides resolve it in a few
  // hundred formatter calls instead. The bound is deliberately loose — this
  // guards against losing the strides, not against a slow CI machine, and a
  // tight bound here is itself a flaky test.
  assert.ok(Date.now() - started < 5_000, 'yearly lookahead degenerated to a minute-by-minute scan')
})
