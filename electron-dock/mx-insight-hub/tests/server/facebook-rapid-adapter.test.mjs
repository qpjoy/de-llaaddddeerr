import assert from 'node:assert/strict'
import test from 'node:test'
import { RapidApiAdapter, TWITTER_AIO_HOST } from '../../server/adapters/rapidapi.mjs'
import { FACEBOOK_ENDPOINT, FACEBOOK_HOST } from '../../server/contracts/facebook-search.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'

const key = 'facebook-adapter-fixture-only'
const request = () => ({ platform: 'facebook', endpointKey: FACEBOOK_ENDPOINT, endpointPath: '/search/posts',
  upstreamQuery: { query: 'fixture' }, query: 'fixture', page: 1, pageSize: 20,
  providerCursor: null, encodeNext: () => 'opaque-fixture-cursor' })
const quotaHeaders = { 'x-ratelimit-requests-limit': '1000', 'x-ratelimit-requests-remaining': '0',
  'x-ratelimit-requests-reset': '3600' }

test('Facebook receipts retain parsed quota evidence without leaking it into the public response', async () => {
  let calls = 0
  const adapter = new RapidApiAdapter({ apiKey: key, fetchImpl: async url => {
    calls++
    assert.equal(url.host, FACEBOOK_HOST)
    return Response.json({ results: [{ post_id: '123', message: 'fixture' }] }, { headers: quotaHeaders })
  } })
  const result = await adapter.execute(request())
  assert.equal(calls, 1)
  assert.equal(result.quota.remaining, 0)
  assert.deepEqual(result.responseArchive.rawPayload.response.quota, result.quota)
  assert.doesNotMatch(JSON.stringify(result.publicBody), /quota|ratelimit|facebook-adapter-fixture-only/)
})

test('a confirmed Facebook 429 retains rejection and quota even when its response body cannot be read', async () => {
  for (const mode of ['utf8', 'size', 'stream', 'missing']) {
    let calls = 0
    const adapter = new RapidApiAdapter({ apiKey: key, fetchImpl: async () => {
      calls++
      const body = mode === 'utf8' ? new Uint8Array([0xff]) : mode === 'stream'
        ? new ReadableStream({ start(controller) { controller.error(new Error('synthetic stream failure')) } })
        : mode === 'missing' ? null : 'x'
      return new Response(body, { status: 429, headers: { ...quotaHeaders,
        ...(mode === 'size' ? { 'content-length': String(5 * 1024 * 1024) } : {}) } })
    } })
    await assert.rejects(adapter.execute(request()), error => {
      assert.equal(error.evidence.httpStatus, 429)
      assert.equal(error.evidence.outcome, 'rejected')
      assert.equal(error.evidence.affectsCircuit, false)
      assert.equal(error.evidence.quota.remaining, 0)
      assert.equal(error.responseArchive.rawPayload.response.quota.remaining, 0)
      assert.equal(error.responseArchive.contractState, 'rejected')
      assert.equal(error.evidence.billed, null)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('an unreadable 200 or 503 and transport failure never become a confirmed quota rejection', async () => {
  for (const status of [200, 503, null]) {
    let calls = 0
    const adapter = new RapidApiAdapter({ apiKey: key, fetchImpl: async () => {
      calls++
      if (status === null) throw new Error('synthetic transport failure')
      return new Response(new Uint8Array([0xff]), { status, headers: quotaHeaders })
    } })
    await assert.rejects(adapter.execute(request()), error => {
      assert.equal(error.evidence.outcome, status === 200 ? 'succeeded_unusable' : 'unknown')
      assert.equal(error.evidence.quota?.remaining, status === null ? undefined : 0)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('Twitter stays on RapidAPI and never emits Facebook subscription observations', async () => {
  const twitter = normalizeHubSocialRequest('search', { platform: 'twitter', query: 'fixture' })
  for (const status of [200, 429]) {
    let calls = 0
    const adapter = new RapidApiAdapter({ apiKey: key, fetchImpl: async url => {
      calls++
      assert.equal(url.host, TWITTER_AIO_HOST)
      return Response.json(status === 200 ? { data: { search_by_raw_query: { search_timeline: {
        timeline: { instructions: [{ entries: [] }] } } } } } : { message: 'Monthly quota exceeded' },
      { status, headers: quotaHeaders })
    } })
    if (status === 200) {
      const result = await adapter.execute(twitter)
      assert.equal(result.quota, undefined)
      assert.equal(result.responseArchive.rawPayload.response.quota, undefined)
    } else await assert.rejects(adapter.execute(twitter), error => {
      assert.equal(error.evidence.quota, undefined)
      assert.equal(error.responseArchive.rawPayload.response.quota, undefined)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('RapidAPI refuses other platforms and unknown endpoints before resolving credentials or fetching', async () => {
  let calls = 0, credentialReads = 0
  const adapter = new RapidApiAdapter({ credentialResolver: async () => { credentialReads++; return key },
    fetchImpl: async () => { calls++; throw new Error('must not dispatch') } })
  for (const input of [
    { ...request(), platform: 'instagram' },
    { ...request(), endpointKey: 'unknown.search' },
    { ...request(), endpointPath: '/other/operation' },
    { ...normalizeHubSocialRequest('search', { platform: 'twitter', query: 'fixture' }), platform: 'weibo' },
  ]) await assert.rejects(adapter.execute(input), { code: 'rapidapi_platform_not_supported' })
  assert.equal(calls, 0)
  assert.equal(credentialReads, 0)
})
