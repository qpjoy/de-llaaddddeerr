import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as contract from '../../server/contracts/tikhub-content-search.mjs'
import { diagnoseRedditSearch, inspectRedditArchive, noticeClass, unknownNodeGuard } from '../../server/ops/diagnose-reddit-search.mjs'

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
  assert.match(receipt.bodySha256, /^[a-f0-9]{64}$/u)
  assert.equal(receipt.edgeCount, 3)
  assert.deepEqual(receipt.branches, { post: 1, unrecognized: 1, children: 1 })
  assert.equal(receipt.nodes[0].identity, 't3_')
  assert.equal(receipt.nodes[1].typename, 'SearchModifier')
  assert.deepEqual(receipt.nodes[1].nested, { modifier: { typename: 'SpellcheckModifier', keys: ['__typename', 'text'] } })
  assert.deepEqual(receipt.nodes[2].children.map(child => child.branch), ['post', 'non_post:community'])
  assert.deepEqual(receipt.pageInfoKeys, ['endCursor', 'hasNextPage'])
  // The parser now excludes a widget that carries no post.
  assert.deepEqual(receipt.parser, { state: 'accepts' })
  assert.doesNotMatch(JSON.stringify(receipt), /private-customer-text/u)
})

test('Reddit shape diagnostic reads only TikHub Reddit calls inside a read-only transaction', async () => {
  const queries = []
  let released = false
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/u)
    if (sql.includes('reddit-shape:calls')) return { rows: [{ id: '93494c87-5a7e-4c90-b0b7-51793e9a1fda', outcome: 'succeeded_unusable',
      http_status: 200, business_code: 200, error_code: 'invalid_content_search_contract', ...archive([
        { node: { __typename: 'SearchSpellCorrectionApplied', telemetry: {
          trackingContext: { post: null }, search: { scope: { a: { b: { c: { d: { e: secret } } } } } } } } },
        { node: { children: Array.from({ length: 7 }, (_, i) => ({ post: post(`p${i}`) })) } },
      ]) }] }
    return { rows: [] }
  }, release() { released = true } } } }
  const result = await diagnoseRedditSearch(pool, ['93494c87-5a7e-4c90-b0b7-51793e9a1fda'], { contract })
  assert.equal(result.calls[0].errorCode, 'invalid_content_search_contract')
  assert.deepEqual(result.calls[0].receipt.parser, { state: 'installed_accepts', itemCount: 7, nonPostCount: 1,
    hasMore: true, warningCodes: ['reddit_spell_correction'] })
  assert.equal(queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.match(queries.find(query => query.sql.includes('reddit-shape:calls')).sql, /provider_key = 'tikhub' AND c\.endpoint_key LIKE '%reddit%'/u)
  assert.equal(queries.at(-1).sql, 'ROLLBACK')
  assert.equal(released, true)
  await assert.rejects(diagnoseRedditSearch(pool, ['not-a-uuid']), { diagnosticCode: 'invalid_call_ids' })
})

test('Reddit shape diagnostic classifies notices exactly like the parser and never echoes their text', () => {
  for (const message of ['Hm... we couldn’t find any results', 'No results found', '没有找到相关结果', 'Something went wrong', '']) {
    const node = { __typename: 'SearchErrorMessage', presentation: { message } }
    assert.equal(noticeClass(node), contract.redditSearchMessageClass(node), message)
  }
  const receipt = inspectRedditArchive(archive([{ node: { __typename: 'SearchErrorMessage', presentation: { message: `Something went wrong ${secret}` } } }]))
  assert.deepEqual(receipt.branches, { notice: 1 })
  assert.equal(receipt.nodes[0].noticeClass, 'error')
  assert.doesNotMatch(JSON.stringify(receipt), /private-customer-text|went wrong/u)
})

test('unknown widget guard reports each parser rejection without exposing values', () => {
  let deep = secret
  for (let i = 0; i < 6; i++) deep = { nested: deep }
  const cases = [
    [{ telemetry: deep }, 'depth_limit'],
    [{ telemetry: Array(201).fill(secret) }, 'array_limit'],
    [{ telemetry: { id: `t3_${secret}` } }, 'post_id_prefix'],
    [{ telemetry: { __typename: 'SubredditPost' } }, 'post_typename'],
    [{ telemetry: { post: { text: secret } } }, 'post_field'],
  ]
  for (const [fields, reason] of cases) {
    const node = { __typename: 'UnknownWidget', ...fields }
    const result = unknownNodeGuard(node)
    assert.equal(result.state, 'guard_rejects')
    assert.equal(result.reason, reason)
    const report = inspectRedditArchive(archive([{ node }]), payload => replay(payload))
    assert.equal(report.parser, 'invalid_content_search_entry')
    assert.deepEqual(report.nodes[0].guard, result)
    assert.doesNotMatch(JSON.stringify(report), /private-customer-text/u)
  }
  assert.equal(unknownNodeGuard({ telemetry: deep }).depth, 7)
})

test('shallow correction and banner metadata remain nonposts and retain adjacent posts', () => {
  for (const typename of ['SearchSpellCorrectionApplied', 'SearchBanner']) {
    const node = { __typename: typename, presentation: { primaryText: secret }, telemetry: { events: [] } }
    const report = inspectRedditArchive(archive([{ node }, { node: { post: post('a') } }]), payload => replay(payload))
    assert.equal(report.nodes[0].guard.state, 'guard_accepts')
    assert.equal(report.parser, 'accepts')
  }
})

test('guard paths hash non-identifier keys, preserve first-match order, and bound traversal', () => {
  const result = unknownNodeGuard({ [secret]: { id: `t3_${secret}` }, post: {} })
  assert.equal(result.reason, 'post_id_prefix')
  assert.match(result.path[0], /^key-sha256:[a-f0-9]{12}$/u)
  assert.doesNotMatch(JSON.stringify(result), /private-customer-text/u)
  const wide = Object.fromEntries(Array.from({ length: 20001 }, (_, index) => [`field${index}`, secret]))
  assert.equal(unknownNodeGuard(wide).state, 'inspection_truncated')
})

test('guard mirrors narrow widget tracking-context exceptions without exposing analytics values', () => {
  for (const [typename, behavior] of [['SearchSpellCorrectionApplied', 'corrected'], ['SearchSpellCorrectionApplied', 'original'],
    ['SearchBanner', 'cta'], ['SearchBanner', 'dismiss']]) {
    const node = { __typename: typename, behaviors: { [behavior]: { telemetry: { trackingContext: { post: { id: `t3_${secret}` } } } } },
      telemetry: { trackingContext: { post: null } } }
    const report = inspectRedditArchive(archive([{ node }, { node: { post: post('a') } }]), payload => replay(payload))
    assert.equal(report.parser, 'accepts')
    assert.equal(report.nodes[0].guard.state, 'guard_accepts')
    if (typename === 'SearchSpellCorrectionApplied') {
      assert.deepEqual(report.nodes[0].guard.ignoredTelemetry, [['behaviors', behavior, 'telemetry'], ['telemetry']])
      assert.equal(report.nodes[0].previousTrackingContextGuard.state, 'guard_accepts')
    } else assert.deepEqual(report.nodes[0].guard.ignoredTrackingContexts, [
      ['behaviors', behavior, 'telemetry', 'trackingContext'], ['telemetry', 'trackingContext']])
    assert.doesNotMatch(JSON.stringify(report), /private-customer-text/u)
    for (const bad of [{ ...node, __typename: 'UnknownWidget' },
      { ...node, presentation: { post: post('hidden') } },
      { ...node, content: { telemetry: { trackingContext: { post: post('hidden') } } } }]) {
      assert.equal(unknownNodeGuard(bad).state, 'guard_rejects')
      assert.equal(inspectRedditArchive(archive([{ node: bad }]), payload => replay(payload)).parser, 'invalid_content_search_entry')
    }
  }
})

test('diagnostic distinguishes deep metadata inside versus outside the previous trackingContext exception', () => {
  const deep = { search: { scope: { a: { b: { c: { d: { e: secret } } } } } } }
  for (const location of ['root', 'corrected', 'original']) {
    for (const insideContext of [true, false]) {
      const telemetry = insideContext ? { trackingContext: { post: null, ...deep } }
        : { trackingContext: { post: null }, ...deep }
      const node = { __typename: 'SearchSpellCorrectionApplied', ...(location === 'root' ? { telemetry }
        : { behaviors: { [location]: { telemetry } } }) }
      const report = inspectRedditArchive(archive([{ node }]), payload => replay(payload))
      assert.equal(report.parser, 'accepts')
      assert.equal(report.nodes[0].guard.state, 'guard_accepts')
      const previous = report.nodes[0].previousTrackingContextGuard
      assert.equal(previous.state, insideContext ? 'guard_accepts' : 'guard_rejects')
      if (!insideContext) {
        assert.equal(previous.reason, 'depth_limit')
        assert.ok(previous.path.includes('search'))
        assert.ok(previous.path.includes('scope'))
      }
      assert.doesNotMatch(JSON.stringify(report), /private-customer-text/u)
    }
  }
})
