import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

function fixture(failAt = null) {
  const statements = []
  const failure = Object.assign(new Error('report statement cancelled'), { code: '57014' })
  let released = false, selects = 0
  const store = new PostgresStore({ connect: async () => ({
    async query(sql, values) {
      statements.push({ sql, values })
      if (!sql.startsWith('SELECT')) return { rows: [] }
      selects++
      assert.deepEqual(statements.slice(0, 4).map(item => item.sql), [
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        'SET LOCAL max_parallel_workers_per_gather = 0',
        "SET LOCAL statement_timeout = '5s'",
        "SET LOCAL lock_timeout = '1s'",
      ])
      if (selects === failAt) throw failure
      if (selects === 1) return { rows: [{ platform: 'xiaohongshu', capability: null,
        requests: '7', committed: '5', released: '1', unknown: '1', units: '5', average_latency: 100 }] }
      return { rows: [] }
    },
    release() { released = true },
  }) })
  return { store, statements, failure, get released() { return released } }
}

test('usage reports apply local resource bounds before reading and preserve exact totals and filters', async () => {
  const db = fixture()
  const filters = { apiKeyId: '11111111-1111-4111-8111-111111111111', from: '2026-10-29T00:00:00Z' }
  const result = await db.store.usage(filters)
  assert.equal(result.requests, 7)
  assert.equal(result.committed, 5)
  assert.equal(result.released, 1)
  assert.equal(result.unknown, 1)
  const selects = db.statements.filter(item => item.sql.startsWith('SELECT'))
  assert.equal(selects.length, 4)
  for (const query of selects) {
    assert.deepEqual(query.values, [filters.apiKeyId, filters.from])
    assert.match(query.sql, /request.api_key_id = \$1/)
    assert.match(query.sql, /request.created_at >= \$2/)
  }
  assert.equal(db.statements.at(-1).sql, 'COMMIT')
  assert.equal(db.released, true)
})

for (const failAt of [1, 3]) test(`usage reporting cancels at query ${failAt}, rolls back and returns no partial or zero report`, async () => {
  const db = fixture(failAt)
  await assert.rejects(db.store.usage(), error => error === db.failure)
  assert.equal(db.statements.filter(item => item.sql.startsWith('SELECT')).length, failAt)
  assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
  assert.ok(!db.statements.some(item => item.sql === 'COMMIT'))
  assert.equal(db.released, true)
})
