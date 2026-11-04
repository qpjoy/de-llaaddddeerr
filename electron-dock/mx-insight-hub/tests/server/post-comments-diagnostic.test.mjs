import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnosePostComments, INCIDENT_REQUEST_ID } from '../../server/ops/diagnose-post-comments.mjs'

test('comment diagnosis reads the exact incident without exposing body or arbitrary errors', async () => {
  const queries = []; let released = false
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql.includes('FROM public.usage_requests')) return { rows: [{ platform: 'twitter', status: 'released', error_code: 'private secret', path: '/api/v1/night-all/search/post-comments', response_status: 404 }] }
    if (sql.includes('FROM serving.connector_calls')) return { rows: [{ operation: 'post-comments', platform: 'twitter', outcome: 'failed', http_status: 404, error_code: 'night_all_http_404' }] }
    return { rows: [] }
  }, release() { released = true } }
  const result = await diagnosePostComments({ connect: async () => client })
  assert.equal(result.calls[0].httpStatus, 404)
  assert.equal(result.usage[0].errorCode, 'other')
  assert.equal(JSON.stringify(result).includes('private secret'), false)
  assert.match(queries[0].sql, /READ ONLY/)
  for (const q of queries.filter(q => q.values)) assert.deepEqual(q.values, [INCIDENT_REQUEST_ID])
  assert.equal(queries.at(-1).sql, 'ROLLBACK'); assert.equal(released, true)
})

test('invalid ID never reaches the database', async () => {
  await assert.rejects(diagnosePostComments({ connect() { throw new Error('must not connect') } }, 'bad'), /invalid_request_id/)
})
