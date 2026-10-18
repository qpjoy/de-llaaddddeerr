import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeHubSocialRequest, HUB_SOCIAL_VERSION } from '../../server/contracts/hub-social.mjs'
import { normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { normalizeRawSearch } from '../../server/contracts/raw-search.mjs'
import { RapidApiAdapter, TWITTER_AIO_HOST } from '../../server/adapters/rapidapi.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { createExternalPlatformCursorCodec, createRawSearchCursorCodec, createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

const INCIDENT_QUERY = '("US semiconductor export" OR "semiconductor export controls" OR SMIC) AND #chipban'
const INCIDENT_PATH = '/search/%28%22US%20semiconductor%20export%22%20OR%20%22semiconductor%20export%20controls%22%20OR%20SMIC%29%20AND%20%23chipban'
const STANDARD_PATH = '/search/%28%22US%20semiconductor%20export%22%20OR%20%22semiconductor%20export%20controls%22%20OR%20SMIC%29%20%23chipban'
const BODY = { platform: 'twitter', query: INCIDENT_QUERY, pageSize: 20 }
const SECRET = 'twitter-path-encoding-fixture-only-pepper', IDENTITY = 'fixture-consumer:fixture-key'
const CODECS = {
  social: createExternalPlatformCursorCodec(SECRET, IDENTITY), raw: createRawSearchCursorCodec(SECRET, IDENTITY),
  data: createDataSearchCursorCodec(SECRET, IDENTITY),
}
// Frozen state from the pre-fix identity format, with synthetic credentials and
// a fixed 2100 expiry. The original search encoder left the query's () literal.
// Keep these opaque tokens fixed so a new identity/version or codec cannot
// silently turn this into a test that only accepts newly issued cursors.
const LEGACY = {
  social: {
    queryHash: '650d360efdd58d129c1157bc0ea2a66c0307a52498ac2d55fc318cd394a081d0',
    fingerprint: 'b38261ecf18bfc531eaacb65755112ded27c1fbebfc21b95774f4b552f0637dd',
    cursor: 'mxec2.SH6xwIlYyMXmAuaE.6wvXcO73Gy3bxhjnprsJ7K6CBplSVBUZ5zeO1vZLCMHvLuBS68MbViFy9tHknxf83g2f2pCVphngtw6SCOUnGqnIgIgz3XZJ8kE42Lprlmkakbq8icPhhKIDYyRUWqjEmf5B5JXIGNzoZXz5XzGkvesqKovyMCZ-VQhK6M-uZNm1ZExnGRsiKPqZ_m50HcIWj1s52N2f0sO6vSg6r8PukJ4qDmCbnR82VhIIzo4U7p5loNz_XXcVfrfTjJrdWlnmZN7g1lE8UJc.AuVSC-eCbMXNpQqEVLbkkg',
  },
  raw: {
    scope: '9f64a51b58ed226f43ac837d88c8071827d34dc376cbc75b4fc060241d94de14',
    fingerprint: 'd0fd1a08306f1a5903a6ad69e068ede3afc1ee99faf995818c231ac30c995e33',
    cursor: 'mxraw1.oVlvXhRLwuWW9y0D.HObduUoNQjL0W4xLh1AMcz1b4PN4pYarUBt0M_Y7hUXio-9TxkoiFamF21WG20C0bmBC-0a1XnjcrfuZyrZrKHrIL13nAqc3dNPjA2wSLwEntLf3delw18KwKQZrIOem6QMsmiqDe0Tzb-LLKkB191nyyTcToeI5wLzTVB3YpT_l-T5KqORRpDXpegZT69PPLmc1-nX04VN6KHPJdmrx_5AaFn32fbVBhBhDP9A76jjpve-ntMXZGBv4PalPYIvsSQca.nlYPp_2VfTgsNRJZpA1iFw',
  },
  fresh: {
    scope: '0f4e4be3a50645dcc6708a5ad0f83389e1734c7658ddcf4fc21109cf5198a0f8',
    fingerprint: '6bf6860642d86596d8b93d25b320aea3f89bdc96ec8237b4e6ffa34e18441b4f',
    cursor: 'mxds1.YGIYKKxKnOlefh7T.3SlJ_-JtoXifJJFCl8zWdBpcZyIMHGL-nKFtQXn7eZu-U-umhLavQnJLcRujomMFKrID4Hnf9LFi_d3TZivd4VSQ78ASb6xqoEqa0e2Ww6zOrV4akjJW_sh8dIS1AWomDt6qyh2-drTs4fr1svmIIwyQHsB98yz1O_NCIXmqssxVIhb-LsMiJ1dzVTqOfZdG1MbHT1uLsPOpKKdZ53vnLMif0t2A4BaPW0zdCF1qNCp_9FIJmgXag66B62glQua3bEbPSU3QyWuUVtCTEQuJThxK4k9JMxP8AQ.szuqS9u-B7NT10Qmcp4nDg',
  },
  stable: {
    scope: '990fe7bd80f0c8b1d254887c6ee7311c555d68e0ff7d58ce6055e61177eb41a8',
    fingerprint: '6c61e5eb1a83be4f51f11cf04fe2a877543af2417f8a757acd3ce5bd249fc250',
    cursor: 'mxds1.t-XYZtXWIU4ooqyc.p2vxPXsrGEv2wb6VJWgsW1bE7gT8kIzCGfZ6xfLT-buN9kbrd1MxP4Y0AqKFkRVieKpEU3EAEHY16gj7dzRL1hBk4C-jJqkVBxJqPISwSSoB2O7Pw8ULWMqpf-21QYFTGphfvcZofKFa4Rjjw6SFbZWGDCAfnzslaHUnSspBefnrV2p_c663LH18ngj9DzvAon8Ft821fJOCnZ79r-NzZGyrj4IOLrZ7NwtWdNr8PVt6fK4g859jpHq-ZdQX94-x4osh1OoNNnjt0TGK01-rU_LU7TBcSlt06w.VETQpl8AQpvh0XI_uzoXiw',
  },
}
const fingerprint = (path, request) => requestFingerprint({ method: 'POST', path, body: request.fingerprintBody })
const social = (query = INCIDENT_QUERY, extra = {}) => normalizeHubSocialRequest('search', { platform: 'twitter', query, count: 20, ...extra },
  { decodeCursor: CODECS.social.decode })
const raw = (extra = {}) => normalizeRawSearch({ platform: 'twitter', pageSize: 20,
  upstreamBody: { platform: 'twitter', query: INCIDENT_QUERY, count: 20, ...extra } }, CODECS.raw)

test('Twitter search encodes query data into one path segment without changing the query or adding a fragment', async () => {
  const cases = [
    [INCIDENT_QUERY, INCIDENT_PATH], ['timo', '/search/timo'],
    ["!'()*", '/search/%21%27%28%29%2A'],
    ['A/B?C#D%+&= 中文🙂', '/search/A%2FB%3FC%23D%25%2B%26%3D%20%E4%B8%AD%E6%96%87%F0%9F%99%82'],
    ['%28literal%29 #chipban', '/search/%2528literal%2529%20%23chipban'],
    ['AZaz09-._~', '/search/AZaz09-._~'],
  ]
  for (const [query, expectedPath] of cases) {
    const request = social(query)
    assert.equal(request.query, query)
    assert.equal(request.fingerprintBody.query, query)
    assert.equal(request.endpointPath, expectedPath)
    let calls = 0
    const adapter = new RapidApiAdapter({ apiKey: 'synthetic-offline-provider-key', fetchImpl: async (url, options) => {
      calls++
      assert.equal(url.origin, `https://${TWITTER_AIO_HOST}`)
      assert.equal(url.pathname, expectedPath)
      assert.equal(url.pathname.split('/').length, 3)
      assert.equal(decodeURIComponent(url.pathname.slice('/search/'.length)), query, 'one decode recovers exact input, including literal percent escapes')
      assert.doesNotMatch(url.pathname, /[!'()*?#]/u)
      assert.equal(url.hash, '')
      assert.deepEqual(Object.fromEntries(url.searchParams), { count: '20', category: 'Latest', includeTimestamp: 'false' })
      assert.equal(options.method, 'GET')
      assert.equal(options.redirect, 'error')
      // A valid synthetic empty response tests URL construction only. It does
      // not model or establish what caused the supplier's production HTTP 400.
      return Response.json({ entries: [] })
    } })
    const result = await adapter.execute(request)
    assert.equal(calls, 1)
    assert.equal(result.publicBody.data.items.length, 0)
  }
})

test('new standard fresh and stable searches compile Boolean AND with the same encoding and existing Top parameters', async () => {
  const seen = []
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-offline-provider-key', fetchImpl: async url => {
    seen.push(url.href)
    assert.equal(url.pathname, STANDARD_PATH)
    assert.equal(url.hash, '')
    assert.deepEqual(Object.fromEntries(url.searchParams), { count: '20', category: 'Top', includeTimestamp: 'false' })
    return Response.json({ entries: [] })
  } })
  for (const type of ['fresh', 'stable']) {
    const request = normalizeHubDataSearch(BODY, CODECS.data, type)
    assert.equal(request.query, INCIDENT_QUERY)
    assert.equal(request.providerRequest.endpointPath, STANDARD_PATH)
    assert.equal(request.providerRequest.standardSearch, true)
    await adapter.execute(request.providerRequest)
  }
  assert.equal(seen.length, 2)
  assert.equal(seen[0], seen[1])
  assert.equal(raw().providerRequest.endpointPath, INCIDENT_PATH)
  assert.deepEqual(raw().providerRequest.upstreamQuery, { count: 20, category: 'Latest', includeTimestamp: 'false' })
})

test('path encoding preserves pre-fix social identity, standard and raw fingerprints, and cursor scope hashes', () => {
  const request = social()
  assert.deepEqual(request.fingerprintBody, { version: 'mx-insight-hub.social-data.v1', operation: 'search', platform: 'twitter',
    query: INCIDENT_QUERY, username: null, userId: null, count: 20, sort: 'latest', cursor: null })
  assert.equal(HUB_SOCIAL_VERSION, 'mx-insight-hub.social-data.v1')
  assert.equal(request.queryHash, LEGACY.social.queryHash)
  assert.equal(fingerprint('/api/v1/data/social/search', request), LEGACY.social.fingerprint)
  assert.equal(request.endpointVersion, 'twitter-aio.hub.v1')
  const rawRequest = raw()
  assert.equal(rawRequest.scopeHash, LEGACY.raw.scope)
  assert.equal(fingerprint('/api/v1/night-all/search/raw', rawRequest), LEGACY.raw.fingerprint)
  for (const type of ['fresh', 'stable']) {
    const standard = normalizeHubDataSearch(BODY, CODECS.data, type)
    assert.equal(standard.scopeHash, LEGACY[type].scope)
    assert.equal(fingerprint('/api/v1/data/search', standard), LEGACY[type].fingerprint)
    assert.deepEqual(standard.fingerprintBody, { ...BODY, type })
  }
})

test('frozen mxec2, mxraw1 and mxds1 continuations still bind the original query while using the corrected path', () => {
  const continuedSocial = social(INCIDENT_QUERY, { cursor: LEGACY.social.cursor })
  const continuedRaw = raw({ cursor: LEGACY.raw.cursor })
  const continuedData = ['fresh', 'stable'].map(type => normalizeHubDataSearch({ ...BODY, cursor: LEGACY[type].cursor }, CODECS.data, type))
  for (const request of [continuedSocial, continuedRaw, ...continuedData]) {
    assert.equal(request.page, 2)
    assert.equal(request.providerCursor, 'legacy-provider-token-2')
    assert.equal(request.expiresAt, 4102444800000)
    const provider = request.providerRequest ?? request
    assert.equal(provider.endpointPath, INCIDENT_PATH)
    assert.equal(provider.upstreamQuery.cursor, 'legacy-provider-token-2')
    assert.equal(request.fingerprintBody.cursor, request === continuedSocial ? LEGACY.social.cursor
      : request === continuedRaw ? LEGACY.raw.cursor : LEGACY[request.resultType].cursor)
  }
  assert.equal(continuedSocial.queryHash, LEGACY.social.queryHash)
  assert.equal(continuedRaw.scopeHash, LEGACY.raw.scope)
  for (const request of continuedData) assert.equal(request.scopeHash, LEGACY[request.resultType].scope)
  assert.throws(() => social('other-query', { cursor: LEGACY.social.cursor }), { code: 'invalid_cursor' })
  assert.throws(() => raw({ query: 'other-query', cursor: LEGACY.raw.cursor }), { code: 'invalid_cursor' })
  assert.throws(() => normalizeHubDataSearch({ ...BODY, query: 'other-query', cursor: LEGACY.fresh.cursor }, CODECS.data, 'fresh'), { code: 'invalid_cursor' })
  assert.throws(() => normalizeHubDataSearch({ ...BODY, cursor: LEGACY.fresh.cursor }, CODECS.data, 'stable'), { code: 'invalid_cursor' })
})

test('search encoding retains dot-segment rejection and existing account endpoint construction', () => {
  for (const query of ['.', '..']) assert.throws(() => social(query), { code: 'invalid_social_request' })
  for (const [operation, body, endpointPath] of [
    ['user-info', { username: '@Example' }, '/user/by/username/Example'],
    ['user-info', { userId: '42' }, '/user/users/by/ids'],
    ['crawl', { userId: '42' }, '/user/42/tweets'],
    ['crawl', { username: '@Example' }, '/user/-1/tweets'],
  ]) assert.equal(normalizeHubSocialRequest(operation, { platform: 'twitter', ...body }).endpointPath, endpointPath)
})
