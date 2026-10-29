import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as contract from '../../server/contracts/tikhub-content-search.mjs'
import { diagnoseRedditSearch, inspectRedditArchive } from '../../server/ops/diagnose-reddit-search.mjs'

const secret = 'private-customer-text'
const post = id => ({ __typename: 'SubredditPost', id: `t3_${id}`, postTitle: secret, content: { markdown: secret }, permalink: `/r/${secret}/` })
const archive = edges => {
  const bytes = Buffer.from(JSON.stringify({ code: 200, data: { search: { dynamic: { components: {
    main: { edges, pageInfo: { endCursor: secret, hasNextPage: true } } } } } } }))
  return { body_bytes: new Uint8Array(bytes), body_sha256: createHash('sha256').update(bytes).digest('hex'), captured_at: '2026-10-29T03:47:07.000Z' }
}
const replay = payload => {
  const request = contract.normalizeTikHubContentSearchRequest({ platform: 'reddit', query: 'offline-diagnostic', pageSize: 20 })
  try { contract.projectTikHubContentSearch({ publicBody: { data: payload.data, meta: { capturedAt: '2026-10-29T03:47:07.000Z' } } }, request); return 'accepts' }
  catch (error) { return error.message }
}

test('Reddit shape diagnostic names an unrecognized node by type and keys and replays the parser', () => {
  const receipt = inspectRedditArchive(archive([{ node: { post: post('a') } },
    { node: { __typename: 'SearchModifier', modifier: { __typename: 'SpellcheckModifier', text: secret } } },
    { node: { children: [{ post: post('b') }, { community: { name: secret } }] } }]), (payload) => ({ state: replay(payload) }))
  assert.equal(receipt.state, 'archive_verified')
  assert.equal(receipt.edgeCount, 3)
  assert.deepEqual(receipt.branches, { post: 1, unrecognized: 1, children: 1 })
  assert.equal(receipt.nodes[0].identity, 't3_')
  assert.equal(receipt.nodes[1].typename, 'SearchModifier')
  assert.deepEqual(receipt.nodes[1].nested, { modifier: { typename: 'SpellcheckModifier', keys: ['__typename', 'text'] } })
  assert.deepEqual(receipt.nodes[2].children.map(child => child.branch), ['post', 'non_post:community'])
  assert.deepEqual(receipt.pageInfoKeys, ['endCursor', 'hasNextPage'])
  assert.deepEqual(receipt.parser, { state: 'invalid_content_search_entry' })
  assert.doesNotMatch(JSON.stringify(receipt), /private-customer-text/u)
})

test('Reddit shape diagnostic reads only TikHub Reddit calls inside a read-only transaction', async () => {
  const queries = []
  let released = false
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/u)
    if (sql.includes('reddit-shape:calls')) return { rows: [{ id: '93494c87-5a7e-4c90-b0b7-51793e9a1fda', outcome: 'succeeded_unusable',
      http_status: 200, business_code: 200, error_code: 'invalid_content_search_contract', ...archive([{ node: { post: post('a') } }]) }] }
    return { rows: [] }
  }, release() { released = true } } } }
  const result = await diagnoseRedditSearch(pool, ['93494c87-5a7e-4c90-b0b7-51793e9a1fda'], { contract })
  assert.equal(result.calls[0].errorCode, 'invalid_content_search_contract')
  assert.deepEqual(result.calls[0].receipt.parser, { state: 'installed_accepts', itemCount: 1, nonPostCount: 0 })
  assert.equal(queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.match(queries.find(query => query.sql.includes('reddit-shape:calls')).sql, /provider_key = 'tikhub' AND c\.endpoint_key LIKE '%reddit%'/u)
  assert.equal(queries.at(-1).sql, 'ROLLBACK')
  assert.equal(released, true)
  await assert.rejects(diagnoseRedditSearch(pool, ['not-a-uuid']), { diagnosticCode: 'invalid_call_ids' })
})
