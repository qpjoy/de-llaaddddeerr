import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { RapidApiAdapter, RapidApiUpstreamError } from '../../server/adapters/rapidapi.mjs'
import { normalizeNativeForwardingRequest, nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { TWITTER_RAPIDAPI_THREAD_ENDPOINT as endpoint,
  TWITTER_RAPIDAPI_COMMENT_ENDPOINT as legacyEndpoint } from '../../server/contracts/twitter-rapidapi-endpoints.mjs'
import { officialProviderCatalog } from '../../server/data/provider-catalog.mjs'

const tweetId = '1860685212345678901'
const key = endpoint.key
const credential = 'synthetic-rapidapi-key'

test('Twitter TweetDetail uses a new operation while preserving the released replies contract', () => {
  assert.equal(nativeForwardingEndpoint(key), endpoint)
  assert.equal(endpoint.host, 'twitter-aio.p.rapidapi.com')
  assert.equal(endpoint.marketplace, 'twitter')
  assert.equal(endpoint.operation, 'native.r.twitter_aio_tweet_thread')
  assert.equal(endpoint.path, '/tweet/{tweetId}')
  assert.equal(nativeForwardingEndpoint(legacyEndpoint.key), legacyEndpoint)
  assert.equal(legacyEndpoint.path, '/tweet/{tweetId}/replies')
  assert.equal(legacyEndpoint.operation, 'native.r.twitter_aio_tweet_replies')
  const normalized = normalizeNativeForwardingRequest(key, { params: { tweetId } })
  assert.deepEqual(normalized.upstreamQuery, { tweetId, rankingMode: 'Relevance', includePromotedContent: false })
  assert.notDeepEqual(normalized.fingerprintBody,
    normalizeNativeForwardingRequest(key, { params: { tweetId: '1860685212345678902' } }).fingerprintBody)
  const row = officialProviderCatalog().rows.find(row => row.operation === endpoint.operation)
  assert.equal(row.sourceUrl, endpoint.sourceUrl)
  assert.equal(row.hubPath, endpoint.hubPath)
})

test('native transport interpolates only validated path IDs, preserves opaque cursors and exact evidence', async () => {
  const payload = { data: { threaded_conversation_with_injections_v2: { instructions: [] } } }
  const bytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n')
  const calls = []
  const adapter = new RapidApiAdapter({ apiKey: credential, fetchImpl: async (url, request) => {
    calls.push({ url, request })
    return new Response(bytes, { headers: { 'content-type': 'application/json', 'x-rapidapi-request-id': 'fixture-request',
      'x-ratelimit-requests-remaining': '12', 'retry-after': '3' } })
  } })
  const cursor = 'opaque+/=:%cursor'
  const result = await adapter.forwardNative(key, { params: { tweetId, cursor } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.origin + calls[0].url.pathname, `https://${endpoint.host}/tweet/${tweetId}`)
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { rankingMode: 'Relevance', includePromotedContent: 'false', cursor })
  assert.equal(calls[0].request.method, 'GET')
  assert.equal(calls[0].request.redirect, 'error')
  assert.equal(calls[0].request.headers['x-rapidapi-host'], endpoint.host)
  assert.equal(calls[0].request.headers['x-rapidapi-key'], credential)
  assert.deepEqual(result.publicBody.data, payload)
  assert.equal(result.restrictedResponseArchive.bodySha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(result.restrictedResponseArchive.bodyBytes, bytes)
  assert.equal(result.responseArchive.rawPayload.response.rateLimit.headers['x-ratelimit-requests-remaining'], 12)
  assert.equal(result.responseArchive.rawPayload.response.rateLimit.retryAfterSeconds, 3)
  assert.equal(JSON.stringify(result).includes(credential), false)
  assert.equal(Object.keys(result).includes('restrictedResponseArchive'), false)
})

test('historical replies operation retains its original upstream path', async () => {
  const adapter = new RapidApiAdapter({ apiKey: credential, fetchImpl: async url => {
    assert.equal(url.origin + url.pathname, `https://${endpoint.host}/tweet/${tweetId}/replies`)
    return Response.json({ data: { threaded_conversation_with_injections_v2: { instructions: [] } } })
  } })
  await adapter.forwardNative(legacyEndpoint.key, { params: { tweetId } })
})

test('invalid IDs, ads, arbitrary URLs and unsupported pagination are rejected before dispatch', async () => {
  let calls = 0
  const adapter = new RapidApiAdapter({ apiKey: credential, fetchImpl: async () => { calls++; throw new Error('must not dispatch') } })
  for (const params of [{ tweetId: '../user' }, { tweetId: 'https://example.invalid' }, { tweetId: 123 },
    { tweetId: '1'.repeat(31) }, { tweetId, count: 20 }, { tweetId, format: 'simple' },
    { tweetId, rankingMode: 'Latest' }, { tweetId, includePromotedContent: true }]) {
    await assert.rejects(adapter.forwardNative(key, { params }), error => error.status === 400 || error.statusCode === 400)
  }
  assert.equal(calls, 0)
})

test('dispatched failures retain their outcome and never cause another supplier request', async () => {
  for (const status of [403, 429, 503, 200]) {
    let calls = 0
    const adapter = new RapidApiAdapter({ apiKey: credential, fetchImpl: async () => {
      calls++
      return new Response(status === 200 ? 'invalid-json' : JSON.stringify({ message: 'fixture refusal' }),
        { status, headers: { 'x-ratelimit-requests-remaining': '0' } })
    } })
    await assert.rejects(adapter.forwardNative(key, { params: { tweetId } }), error => {
      assert(error instanceof RapidApiUpstreamError)
      assert.equal(error.evidence.httpStatus, status)
      assert.equal(error.evidence.outcome, status === 200 ? 'succeeded_unusable' : status >= 500 ? 'unknown' : 'rejected')
      assert.equal(error.evidence.billed, null)
      assert.equal(error.responseArchive.rawPayload.response.rateLimit.headers['x-ratelimit-requests-remaining'], 0)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('existing query-only RapidAPI contracts keep their URL and parameter layout', async () => {
  const adapter = new RapidApiAdapter({ apiKey: credential, fetchImpl: async url => {
    assert.equal(url.origin + url.pathname, 'https://threads-api4.p.rapidapi.com/api/user/info')
    assert.deepEqual(Object.fromEntries(url.searchParams), { id: '123' })
    return Response.json({ data: { id: '123' } })
  } })
  await adapter.forwardNative('r.threads_user_info', { params: { id: '123' } })
})
