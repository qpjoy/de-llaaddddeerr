import assert from 'node:assert/strict'
import test from 'node:test'
import { compileTwitterSearchQuery, TWITTER_QUERY_DIALECT } from '../../server/contracts/twitter-search-query.mjs'
import { normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { normalizeRawSearch } from '../../server/contracts/raw-search.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'
import { normalizeDataSearchV2, prepareDataSearchV2, projectDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import { RapidApiAdapter, TWITTER_AIO_HOST } from '../../server/adapters/rapidapi.mjs'
import { createDataSearchCursorCodec, createRawSearchCursorCodec, createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'

const INCIDENT_QUERY = '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") AND NOT ("广告" OR "营销" OR "重复搬运") AND (("diplomacy" OR "foreign policy" OR "diplomatic relations") AND ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost)'
const COMPILED_QUERY = '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") -"广告" -"营销" -"重复搬运" ("diplomacy" OR "foreign policy" OR "diplomatic relations") ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost'
const codec = createDataSearchCursorCodec('twitter-query-synthetic-pepper', 'consumer:key')
const body = { platform: 'twitter', query: INCIDENT_QUERY, pageSize: 20 }
const standard = (patch = {}) => normalizeHubDataSearch({ ...body, ...patch }, codec, 'stable')
const outbound = request => decodeURIComponent(request.providerRequest.endpointPath.slice('/search/'.length))

test('the incident Boolean expression compiles without losing positive groups or exclusions', () => {
  assert.equal(INCIDENT_QUERY.length, 280)
  assert.deepEqual(compileTwitterSearchQuery(INCIDENT_QUERY), {
    query: INCIDENT_QUERY, providerQuery: COMPILED_QUERY, changed: true, dialect: TWITTER_QUERY_DIALECT,
  })
  for (const [query, providerQuery] of [
    ['a AND b', 'a b'], ['a AND NOT (b OR c)', 'a -b -c'],
    ['(a OR b) AND (c OR d)', '(a OR b) (c OR d)'],
    ['(a AND b) OR (c AND d)', '((a b) OR (c d))'],
    ['a AND NOT NOT b', 'a b'], ['a AND NOT (b OR (c OR d))', 'a -b -c -d'],
    ['from:example AND "AND NOT" AND NOT "foreign policy"', 'from:example "AND NOT" -"foreign policy"'],
    ['near:"New York" AND "foreign policy"', 'near:"New York" "foreign policy"'],
    ['a AND(b OR c)', 'a (b OR c)'],
    ['"quote \\" AND text" AND -ad', '"quote \\" AND text" -ad'],
    ['since:2026-10-15 AND until:2026-10-16 AND #外交 -repost', 'since:2026-10-15 until:2026-10-16 #外交 -repost'],
  ]) assert.equal(compileTwitterSearchQuery(query).providerQuery, providerQuery, query)
})

test('native expressions without standalone SQL operators remain byte-for-byte unchanged', () => {
  for (const query of ['外交', '(a OR b)  -ad', '"AND NOT" OR "OR"', 'from:AND -NOTABLE brand:NOT',
    'A/B?C#D%+&= 中文🙂', 'a and b', 'url:example.com/AND', 'foo-bar', '"unfinished AND']) {
    assert.deepEqual(compileTwitterSearchQuery(query), { query, providerQuery: query, changed: false, dialect: null })
  }
})

test('generated Boolean truth tables preserve conjunction precedence, grouping, De Morgan and native negatives', () => {
  // This independent evaluator accepts only the four synthetic atom names and
  // the native output operators. JavaScript evaluates the generated Boolean
  // expression; it does not reuse the production tokenizer or AST renderer.
  const evaluateNative = (query, assignment) => {
    const tokens = query.match(/OR|[abcd]|[()-]/gu) || []
    assert.equal(tokens.join(''), query.replace(/\s/gu, ''))
    let previous, expression = ''
    for (const token of tokens) {
      const endsOperand = previous && (previous === ')' || /^[abcd]$/u.test(previous))
      const startsOperand = token === '(' || token === '-' || /^[abcd]$/u.test(token)
      if (endsOperand && startsOperand) expression += ' && '
      expression += token === 'OR' ? ' || ' : token === '-' ? '!' : /^[abcd]$/u.test(token) ? String(assignment[token]) : token
      previous = token
    }
    return Function(`"use strict"; return (${expression})`)()
  }
  const cases = [
    ['a AND b OR c', ({ a, b, c }) => a && b || c],
    ['a OR b AND c', ({ a, b, c }) => a || b && c],
    ['(a OR b) AND (c OR d)', ({ a, b, c, d }) => (a || b) && (c || d)],
    ['(a AND b) OR (c AND d)', ({ a, b, c, d }) => (a && b) || (c && d)],
    ['(a OR b) AND NOT (c OR d)', ({ a, b, c, d }) => (a || b) && !(c || d)],
    ['a AND NOT (b OR (c OR d))', ({ a, b, c, d }) => a && !(b || c || d)],
    ['NOT NOT a AND b', ({ a, b }) => !!a && b],
    ['(a AND NOT b) OR (c AND NOT d)', ({ a, b, c, d }) => (a && !b) || (c && !d)],
    ['a -b AND (c OR d)', ({ a, b, c, d }) => a && !b && (c || d)],
    ['a AND NOT (b OR NOT c)', ({ a, b, c }) => a && !(b || !c)],
  ]
  for (const [query, expected] of cases) {
    const compiled = compileTwitterSearchQuery(query)
    for (let bits = 0; bits < 16; bits++) {
      const assignment = Object.fromEntries(['a', 'b', 'c', 'd'].map((key, index) => [key, Boolean(bits & 1 << index)]))
      assert.equal(evaluateNative(compiled.providerQuery, assignment), expected(assignment), `${query}: assignment ${bits}`)
    }
  }
})

test('unsupported grammars are bounded and never approximated; the existing standard route passes them through', () => {
  for (const query of ['a AND NOT (b AND c)', 'a AND (b OR NOT c)', 'a AND (b OR)', 'a AND "unfinished', 'a AND )b(',
    'url:example.com/a(b) AND news', 'source:Twitter_for_(iPhone) AND news',
    'a AND OR b', 'NOT (a OR b)', `a AND ${'('.repeat(18)}b${')'.repeat(18)}`]) {
    assert.throws(() => compileTwitterSearchQuery(query), { code: 'invalid_twitter_query', status: 400 }, query)
    // Normalization runs before saved-ledger replay; new grammar validation
    // cannot make old committed receipts inaccessible.
    assert.equal(outbound(standard({ query })), query)
  }
  assert.throws(() => compileTwitterSearchQuery(`a AND ${'b'.repeat(500)}`), { code: 'invalid_twitter_query' })
})

test('real adapter builds the compiled standard URL with default Latest/count and original request identity', async () => {
  const request = standard()
  assert.equal(request.query, INCIDENT_QUERY)
  assert.equal(request.providerRequest.query, INCIDENT_QUERY)
  assert.equal(request.providerRequest.endpointVersion, 'twitter-aio.hub.v1')
  assert.deepEqual(request.fingerprintBody, { ...body, type: 'stable' })
  assert.equal(requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body: request.fingerprintBody }),
    requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body: { ...body, type: 'stable' } }))
  let calls = 0
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-offline-provider-key', fetchImpl: async (url, options) => {
    calls++
    assert.equal(url.origin, `https://${TWITTER_AIO_HOST}`)
    assert.equal(decodeURIComponent(url.pathname.slice('/search/'.length)), COMPILED_QUERY)
    assert.equal(url.pathname.split('/').length, 3)
    assert.equal(url.hash, '')
    assert.deepEqual(Object.fromEntries(url.searchParams), { count: '20', category: 'Latest', includeTimestamp: 'false',
      ...(calls === 2 ? { cursor: 'provider-page-2' } : {}) })
    assert.equal(options.method, 'GET')
    return Response.json({ entries: [] })
  } })
  const result = await adapter.execute(request.providerRequest)
  assert.equal(calls, 1)
  assert.equal(result.publicBody.data.items.length, 0)
  const second = standard({ cursor: request.encodeNext({ page: 2, providerCursor: 'provider-page-2' }) })
  await adapter.execute(second.providerRequest)
  assert.equal(calls, 2, 'page two uses the same compiled query and the exact supplier cursor')
})

test('new standard continuations pin the compiler while old unmarked continuations retain their original query', () => {
  const first = standard(), cursor = first.encodeNext({ page: 2, providerCursor: 'provider-page-2' })
  const state = codec.decode(cursor)
  assert.equal(state.queryDialect, TWITTER_QUERY_DIALECT)
  const second = standard({ cursor })
  assert.equal(outbound(second), COMPILED_QUERY)
  assert.equal(second.providerRequest.upstreamQuery.cursor, 'provider-page-2')
  assert.equal(second.scopeHash, first.scopeHash)
  assert.equal(codec.decode(second.encodeNext({ page: 3, providerCursor: 'provider-page-3' })).queryDialect, TWITTER_QUERY_DIALECT)
  const { queryDialect: _, ...legacyState } = state
  const old = standard({ cursor: codec.encode(legacyState) })
  assert.equal(outbound(old), INCIDENT_QUERY)
  assert.equal(Object.hasOwn(codec.decode(old.encodeNext({ page: 3, providerCursor: 'provider-page-3' })), 'queryDialect'), false)
  for (const queryDialect of ['twitter.boolean.v2', '', null, {}, false]) {
    assert.throws(() => standard({ cursor: codec.encode({ ...state, queryDialect }) }), { code: 'invalid_cursor' })
  }
  assert.throws(() => standard({ query: 'changed', cursor }), { code: 'invalid_cursor' })
  assert.throws(() => normalizeHubDataSearch({ ...body, cursor }, codec, 'fresh'), { code: 'invalid_cursor' })
})

test('actual v2 preparation and outer-cursor projection preserve inner compiler, original query and frozen window on page two', () => {
  const outerCodec = createDataSearchV2CursorCodec('twitter-v2-query-synthetic-pepper', 'consumer:key')
  const v2Body = normalizeDataSearchV2({ ...body, timeWindow: {
    from: '2026-10-15T09:18:59.946Z', to: '2026-10-16T09:18:59.946Z', timezone: 'Asia/Shanghai', boundary: '[from,to)',
  } })
  const before = structuredClone(v2Body)
  const preparedFirst = prepareDataSearchV2(v2Body, outerCodec)
  const first = normalizeHubDataSearch(preparedFirst.upstream, codec, preparedFirst.upstream.type)
  const innerCursor = first.encodeNext({ page: 2, providerCursor: 'supplier-next-page' })
  const underlying = { requestId: 'saved-first-page', sourceMode: 'live', body: { data: {
    platform: 'twitter', query: INCIDENT_QUERY, items: [], status: 'ok',
    pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 0, hasMore: true, nextCursor: innerCursor, cursorType: 'opaque' },
  } } }
  const projected = projectDataSearchV2(underlying, v2Body, preparedFirst, outerCodec)
  const nextBody = normalizeDataSearchV2({ ...v2Body, cursor: projected.body.data.pageInfo.nextCursor })
  const preparedSecond = prepareDataSearchV2(nextBody, outerCodec)
  const second = normalizeHubDataSearch(preparedSecond.upstream, codec, preparedSecond.upstream.type)
  assert.deepEqual(v2Body, before)
  assert.deepEqual(nextBody.timeWindow, v2Body.timeWindow)
  assert.deepEqual(projected.body.data.meta.requestedWindow, v2Body.timeWindow)
  assert.equal(nextBody.query, INCIDENT_QUERY)
  assert.equal(second.query, INCIDENT_QUERY)
  assert.equal(second.providerRequest.queryDialect, TWITTER_QUERY_DIALECT)
  assert.equal(outbound(second), COMPILED_QUERY)
  assert.equal(second.providerRequest.upstreamQuery.cursor, 'supplier-next-page')
  assert.equal(preparedSecond.state.cursor, innerCursor)
  assert.equal(second.page, 2)
  assert.equal(preparedSecond.state.page, 2)
})

test('simple native queries, direct social search and raw search retain their prior contracts', () => {
  const simple = standard({ query: '(a OR b) -ad' })
  const state = codec.decode(simple.encodeNext({ page: 2, providerCursor: 'provider-page-2' }))
  assert.equal(Object.hasOwn(state, 'queryDialect'), false)
  assert.equal(outbound(standard({ query: '(a OR b) -ad', cursor: codec.encode(state) })), '(a OR b) -ad')
  assert.throws(() => standard({ query: '(a OR b) -ad', cursor: codec.encode({ ...state, queryDialect: TWITTER_QUERY_DIALECT }) }), { code: 'invalid_cursor' })
  const social = normalizeHubSocialRequest('search', { platform: 'twitter', query: INCIDENT_QUERY })
  assert.equal(decodeURIComponent(social.endpointPath.slice('/search/'.length)), INCIDENT_QUERY)
  const rawCodec = createRawSearchCursorCodec('twitter-query-synthetic-pepper', 'consumer:key')
  const raw = normalizeRawSearch({ platform: 'twitter', pageSize: 20,
    upstreamBody: { platform: 'twitter', query: INCIDENT_QUERY, count: 20 } }, rawCodec)
  assert.equal(outbound(raw), INCIDENT_QUERY)
  assert.deepEqual(raw.providerRequest.upstreamQuery, { count: 20, category: 'Latest', includeTimestamp: 'false' })
})
