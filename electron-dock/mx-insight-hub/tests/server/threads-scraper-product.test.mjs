import test from 'node:test'
import assert from 'node:assert/strict'
import { parseThreadsScraperProfile, parseThreadsScraperAccountPage, parseThreadsScraperPostDetail } from '../../server/contracts/threads.mjs'
import { THREADS_SCRAPER_RAPIDAPI_ENDPOINTS } from '../../server/contracts/threads-rapidapi-endpoints.mjs'
import { normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { nativeForwardingPaths } from '../../server/contracts/native-forwarding-docs.mjs'
import scopes from '../../shared/native-service-access.json' with { type: 'json' }
import liveShapes from '../fixtures/threads-scraper-live-shapes.json' with { type: 'json' }

const capturedAt = '2026-11-13T00:00:00Z', username = 'sample.account', code = 'C8O-JbtAKrp', pk = '3390920896561588969'
const ok = data => ({ status: 'ok', data })
const feedEdge = (...posts) => ({ node: { thread_items: posts.map(post => ({ post })) } })
const author = { pk: '16', username: 'Sample.Account' }
const params = (name, values) => normalizeNativeForwardingRequest(`r.threads_scraper_${name}`, { params: values }).upstreamQuery

test('redacted live profile, account feed and flat detail shapes agree on username, post identity and content', () => {
  const profile = parseThreadsScraperProfile(liveShapes.profile, { username })
  const feed = parseThreadsScraperAccountPage(liveShapes.feed, { username, capturedAt })
  const detail = parseThreadsScraperPostDetail(liveShapes.detail, { code, capturedAt })
  assert.equal(profile.pk, feed.owner.pk)
  assert.equal(profile.username, detail.author_username)
  assert.deepEqual(feed.providerPage.nextParams, { cursor: 'page-cursor' })
  for (const field of ['content_id', 'text', 'published_at', 'url', 'like_count']) assert.equal(detail[field], feed.rows[0][field], field)
  assert.equal(detail.comment_count, null)
})

test('all nine published Threads Scraper operations have a scoped native route with a usable request example', () => {
  assert.equal(THREADS_SCRAPER_RAPIDAPI_ENDPOINTS.length, 9)
  for (const endpoint of THREADS_SCRAPER_RAPIDAPI_ENDPOINTS) {
    assert.ok(scopes.social.includes(endpoint.operation))
    const doc = nativeForwardingPaths[endpoint.hubPath.slice('/api/v1'.length)].post
    const sample = doc.requestBody.content['application/json'].example
    assert.equal(normalizeNativeForwardingRequest(endpoint.key, sample).endpointPath, endpoint.path)
    assert.deepEqual(doc['x-mx-required-capabilities'], [endpoint.operation])
    const response = doc.responses['200'].content['application/json']
    assert.ok(response.schema.properties.data.properties.status)
    assert.equal(response.examples.error.value.data.status, 'error')
  }
})

test('detail, media, resolver, batches and search reject invalid inputs before dispatch', () => {
  const url = `https://www.threads.net/@sample.account/post/${code}`
  for (const key of ['post_detail', 'post_media']) {
    assert.deepEqual(params(key, { code }), { code })
    assert.deepEqual(params(key, { url, code }), { url, code })
    for (const body of [{}, { code: 'abc' }, { code: 'x'.repeat(33) }, { code, url: 'https://elsewhere.test/@sample/post/abcde' },
      { url: url.replace('https', 'http') }, { url: url.replace('www.', 'x@www.') }, { url: url.replace('.net/', '.net:8080/') },
      { url: 'https://threads.com/t/abcde' }, { url: url.replace('@sample.account', '@sample%2Faccount') }]) {
      assert.throws(() => params(key, body), { status: 400 })
    }
  }
  for (const reference of [code, url]) assert.equal(params('resolve_post', { reference }).reference, reference)
  for (const reference of ['', './abcd', url.replace('threads.net', 'threads.net.example')]) assert.throws(() => params('resolve_post', { reference }), { status: 400 })
  assert.equal(params('profiles_batch', { usernames: 'a,B.c,d_e' }).usernames, 'a,B.c,d_e')
  for (const usernames of ['a,b,c,d', 'a,,b', '@account', 'a,b c']) assert.throws(() => params('profiles_batch', { usernames }), { status: 400 })
  for (const key of ['user_detail', 'user_detail_with_biolink', 'user_posts']) assert.throws(() => params(key, { username: '@sample' }), { status: 400 })
  assert.deepEqual(params('search_users', { query: 'example' }), { query: 'example', count: 10 })
  assert.throws(() => normalizeNativeForwardingRequest('r.threads_scraper_search_users', { params: { query: 'example' } }, { maxPageSize: 5 }), { status: 400 })
  assert.equal(normalizeNativeForwardingRequest('r.threads_scraper_search_users', { params: { query: 'example', count: 5 } }, { maxPageSize: 5 }).upstreamQuery.count, 5)
  for (const count of [0, -1, 1.5, '1', 101]) assert.throws(() => params('search_users', { query: 'q', count }), { status: 400 })
})

test('profile detail requires the exact requested public account, including for legacy HTTP-200 failures', () => {
  assert.deepEqual(parseThreadsScraperProfile(ok({ user: author }), { username }), author)
  assert.equal(parseThreadsScraperProfile(ok({ user: null }), { username }), null)
  for (const body of [{ status: 'error', data: { user: author } }, { status: 'error', data: { user: null } },
    { data: { user: null } }, { status: 'ok' }, ok({}), ok({ user: { username: 'another' } }),
    ok({ user: { ...author, pk: Number.MAX_SAFE_INTEGER + 1 } }), ok({ user: { ...author, id: '28' } })]) {
    assert.throws(() => parseThreadsScraperProfile(body, { username }), /invalid_threads_response/)
  }
})

test('feed pagination and ownership are tied to the requested account and source page', () => {
  const parse = (posts, cursor = null) => parseThreadsScraperAccountPage(ok({ posts, cursor }), { username, capturedAt })
  const direct = { pk, user: author }, second = { pk: '30', user: author }
  const found = parse([feedEdge({ pk: '24', user: { username: 'context' } }, direct),
    feedEdge(direct, second)], 'next +=')
  assert.deepEqual(found.rows.map(row => row.content_id), [pk, '30'])
  assert.deepEqual(found.owner, author)
  assert.deepEqual(found.providerPage.nextParams, { cursor: 'next +=' })
  assert.deepEqual(parse([]), { rows: [], owner: null, providerPage: { hasMore: false, nextParams: null, nextPage: null } })
  for (const edges of [[feedEdge({ pk: '24', user: { username: 'someone.else' } })], [feedEdge({ pk: '24' })],
    [feedEdge(direct, { pk: '31', user: { ...author, pk: '2' } })], [feedEdge({ pk: '24', user: { ...author, pk: Number.MAX_SAFE_INTEGER + 1 } })]]) {
    assert.throws(() => parse(edges), /invalid_threads_response/)
  }
})

test('post detail matches every supplied identity and preserves nullable text, timestamps and metrics', () => {
  const parse = post => parseThreadsScraperPostDetail(ok({ post }), { code, capturedAt })
  const post = { code, id: pk, username, text: 'detail', timestamp: '2026-11-10T00:00:00Z', like_count: 0, reply_count: null }
  const row = parse(post)
  assert.equal(row.content_id, pk)
  assert.equal(row.comment_count, null)
  assert.equal(row.like_count, 0)
  assert.equal(row.published_at, '2026-11-10T00:00:00.000Z')
  assert.equal(row.url, `https://www.threads.com/@${username}/post/${code}`)
  assert.equal(parse({ url: row.url }).content_id, pk)
  assert.equal(parse({ pk }).content_id, pk)
  for (const wrong of [null, {}, { code: 'abcde' }, { ...post, pk: '111' }, { id: Number(pk) }, { ...post, url: 'https://example.org' },
    { ...post, id: '111' }, { ...post, url: row.url.replace(code, 'abcde') }]) assert.throws(() => parse(wrong), /invalid_threads_response/)
})
