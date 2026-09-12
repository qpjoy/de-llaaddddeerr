// The shared provider rate limiter, against a real PostgreSQL.
//
// This existed only as a memory-store test plus PostgreSQL tests that pass a
// stub pool, so its SQL was never sent to a real server. It carried two typing
// faults that PostgreSQL rejects outright -- a bare "$2 - $4" (42725, neither
// side has a type in an INSERT ... SELECT) and then a $2 deduced as both
// double precision and the integer capacity column (42P08) -- and because the
// limiter runs only on a real dispatch, every live call returned a 500.
//
// A stub pool cannot catch a query the server refuses to parse. This talks to
// the database.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'

import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

test('PostgreSQL admits, exhausts and refills the shared provider bucket', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 5_000 })
  const providerKey = `ratelimit-${randomUUID().slice(0, 8)}`
  const store = new PostgresExternalPlatformStore({ pool, providerKey })
  try {
    // The first call inserts the bucket: the path that failed to parse.
    const first = await store.acquireProviderRateLimit({ limit: 3, tokens: 1, windowMs: 60_000 })
    assert.equal(first.allowed, true, 'the first call is admitted')

    const second = await store.acquireProviderRateLimit({ limit: 3, tokens: 1, windowMs: 60_000 })
    const third = await store.acquireProviderRateLimit({ limit: 3, tokens: 1, windowMs: 60_000 })
    assert.equal(second.allowed, true)
    assert.equal(third.allowed, true)

    // Capacity spent: the limiter must refuse rather than overspend upstream.
    const fourth = await store.acquireProviderRateLimit({ limit: 3, tokens: 1, windowMs: 60_000 })
    assert.equal(fourth.allowed, false, 'a spent bucket refuses')

    const row = await pool.query(
      'SELECT capacity, window_ms, tokens FROM external_platform.provider_rate_buckets WHERE provider_key = $1',
      [providerKey],
    )
    assert.equal(Number(row.rows[0].capacity), 3)
    assert.equal(Number(row.rows[0].window_ms), 60_000)
    assert.ok(Number(row.rows[0].tokens) < 1, 'fewer than one token remains')

    // Raising the limit must not hand out a free burst: the bucket keeps the
    // tokens it has and refills over time, so a spent provider stays spent
    // until real time passes.
    const raised = await store.acquireProviderRateLimit({ limit: 60, tokens: 1, windowMs: 1_000 })
    assert.equal(raised.allowed, false, 'a larger bucket does not refill instantly')

    // 60 tokens per second, so a fraction of a second is plenty.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const refilled = await store.acquireProviderRateLimit({ limit: 60, tokens: 1, windowMs: 1_000 })
    assert.equal(refilled.allowed, true, 'the bucket refills as time passes')
  } finally {
    await pool.query(
      'DELETE FROM external_platform.provider_rate_buckets WHERE provider_key = $1',
      [providerKey],
    ).catch(() => {})
    await pool.end()
  }
})

test('PostgreSQL rejects a token request larger than the bucket', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 5_000 })
  const store = new PostgresExternalPlatformStore({ pool, providerKey: `ratelimit-${randomUUID().slice(0, 8)}` })
  try {
    await assert.rejects(
      () => store.acquireProviderRateLimit({ limit: 2, tokens: 5, windowMs: 60_000 }),
      (error) => error instanceof TypeError,
      'asking for more than the bucket holds is a programming error, not a refusal',
    )
  } finally {
    await pool.end()
  }
})
