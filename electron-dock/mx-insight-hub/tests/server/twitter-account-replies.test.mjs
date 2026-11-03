import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeHubSocialCompatRequest as normalize, buildHubSocialCompatDispatch as dispatch,
  projectHubSocialCompatResponse as project, HUB_SOCIAL_COMPAT_ACTIVITIES } from '../../server/contracts/hub-social-compat.mjs'
import { HUB_SOCIAL_OPERATIONS, TWITTER_REPLIES_ENDPOINT_KEY } from '../../server/contracts/hub-social.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { isPostgresSafeJsonValue } from '../../server/core/postgres-json.mjs'

// Structure of a real 2026-11-03 AIO tweetsAndReplies page (count=20) with
// every ID, handle, text and cursor replaced; the account is 42/ui_batch_019.
// It holds 6 own posts, 9 replies to others, 5 self-replies and 10 tweets by
// other accounts that those replies answer.
const page = JSON.parse(readFileSync(new URL('../fixtures/twitter-aio-user-replies.json', import.meta.url), 'utf8'))
const capturedAt = '2026-11-03T08:00:00.000Z'
const resolved = { kind: 'id', value: '42', username: 'ui_batch_019', lookupComplete: true, profileReady: true }
const repliesJob = (extra = {}) => normalize('crawl', { platform: 'twitter', username: 'ui_batch_019', activityTypes: ['replies'], ...extra }).jobs[0]
const tweets = () => page.data.user.result.timeline.timeline.instructions[1].entries.flatMap(entry =>
  entry.content.itemContent ? [entry.content.itemContent] : (entry.content.items || []).map(item => item.item.itemContent))
  .map(content => content.tweet_results.result)

test('Twitter declares replies; posts keep the original timeline, key and request shape', () => {
  assert.deepEqual(HUB_SOCIAL_COMPAT_ACTIVITIES.twitter, ['posts', 'replies'])
  const both = normalize('crawl', { platform: 'twitter', username: 'ui_batch_019', activityTypes: ['posts', 'replies'] })
  assert.deepEqual(both.jobs.map(job => job.activityType), ['posts', 'replies'])
  const posts = dispatch(both.jobs[0], { resolvedIdentity: resolved, pageSize: 20 })
  assert.equal(posts.endpointKey, 'twitter-aio.crawl')
  assert.equal(posts.endpointPath, '/user/42/tweets')
  assert.equal(Object.hasOwn(posts, 'timeline'), false)
  const replies = dispatch(both.jobs[1], { resolvedIdentity: resolved, pageSize: 20 })
  assert.equal(replies.endpointKey, TWITTER_REPLIES_ENDPOINT_KEY)
  assert.equal(replies.operationKey, 'social.content.crawl')
  assert.equal(replies.endpointPath, '/user/42/tweetsAndReplies')
  assert.deepEqual(replies.upstreamQuery, { count: 20 })
  assert.equal(replies.timeline, 'replies')
  // The account is still resolved by its profile first, at the profile price.
  const lookup = dispatch(both.jobs[1])
  assert.equal(lookup.socialCompat.stage, 'resolve')
  assert.equal(lookup.endpointKey, 'twitter-aio.user-info')
  const next = dispatch(both.jobs[1], { resolvedIdentity: resolved, nextParams: { cursor: 'c-2' }, page: 2, pageSize: 20 })
  assert.deepEqual(next.upstreamQuery, { count: 20, cursor: 'c-2' })
})

test('replies are not a Twitter-only name copied to other platforms', () => {
  for (const platform of ['facebook', 'instagram', 'reddit']) {
    assert.throws(() => normalize('crawl', { platform, userId: '42', activityTypes: ['replies'] }), error => error.code === 'unsupported_activity_type')
  }
})

test('the replies projection keeps only the account replies with their reply link', () => {
  const step = dispatch(repliesJob(), { resolvedIdentity: resolved, pageSize: 20 })
  const result = project(page, step, { capturedAt })
  assert.equal(tweets().length, 30)
  assert.equal(result.acquiredItems.length, 14)
  assert.ok(result.acquiredItems.every(row => row.author_id === '42' && row.user_name === 'ui_batch_019' && row.activityType === 'replies'))
  assert.equal(result.acquiredItems.filter(row => row.isSelfReply).length, 5)
  const byId = new Map(tweets().map(tweet => [tweet.rest_id, tweet]))
  for (const row of result.acquiredItems) {
    const source = byId.get(row.content_id).legacy
    assert.equal(row.parentExternalId, source.in_reply_to_status_id_str)
    assert.equal(row.reply_to_content_id, source.in_reply_to_status_id_str)
    assert.deepEqual(row.replyTo, { id: source.in_reply_to_status_id_str, userId: source.in_reply_to_user_id_str, username: source.in_reply_to_screen_name })
    assert.equal(row.conversationId, source.conversation_id_str)
    assert.equal(row.conversation_id, source.conversation_id_str)
    assert.equal(row.isSelfReply, source.in_reply_to_user_id_str === '42')
  }
  // Newest first, as the timeline lists them; context tweets never leak in.
  const expected = tweets().filter(tweet => tweet.legacy.user_id_str === '42' && tweet.legacy.in_reply_to_status_id_str).map(tweet => tweet.rest_id)
  assert.deepEqual(result.acquiredItems.map(row => row.content_id), expected)
  assert.deepEqual(result.providerPage, { hasMore: true, nextParams: { cursor: 'synthetic-bottom-cursor' }, nextPage: 2 })
  assert.ok(isPostgresSafeJsonValue(result))
})

test('the posts projection of the same page is unchanged by the replies filter', () => {
  const posts = dispatch(normalize('crawl', { platform: 'twitter', username: 'ui_batch_019' }).jobs[0], { resolvedIdentity: resolved, pageSize: 20 })
  const result = project(page, posts, { capturedAt })
  assert.equal(result.acquiredItems.length, 30)
  assert.ok(result.acquiredItems.every(row => !Object.hasOwn(row, 'replyTo') && !Object.hasOwn(row, 'parentExternalId')))
})

test('a replies page with nothing left after filtering keeps its continuation', () => {
  const step = dispatch(repliesJob(), { resolvedIdentity: resolved, pageSize: 20 })
  const onlyOthers = structuredClone(page)
  const entries = onlyOthers.data.user.result.timeline.timeline.instructions[1].entries
  onlyOthers.data.user.result.timeline.timeline.instructions[1].entries = entries.filter(entry =>
    entry.content.cursorType || entry.content.itemContent?.tweet_results.result.legacy.user_id_str === '42')
  const filtered = project(onlyOthers, step, { capturedAt })
  assert.equal(filtered.acquiredItems.length, 0)
  assert.deepEqual(filtered.providerPage, { hasMore: true, nextParams: { cursor: 'synthetic-bottom-cursor' }, nextPage: 2 })
  // Without a cursor, rows the filter removed still leave completeness unknown.
  const withoutCursor = structuredClone(onlyOthers)
  const rest = withoutCursor.data.user.result.timeline.timeline.instructions[1]
  rest.entries = rest.entries.filter(entry => !entry.content.cursorType)
  assert.equal(project(withoutCursor, step, { capturedAt }).providerPage.hasMore, null)
  rest.entries = []
  assert.equal(project(withoutCursor, step, { capturedAt }).providerPage.hasMore, false)
})

test('the crawl operation prices replies as an optional endpoint and the adapter calls tweetsAndReplies', async () => {
  const crawl = HUB_SOCIAL_OPERATIONS.find(row => row.operationKey === 'social.content.crawl')
  assert.deepEqual(crawl.endpointKeys, ['twitter-aio.crawl'])
  assert.deepEqual(crawl.optionalEndpointKeys, [TWITTER_REPLIES_ENDPOINT_KEY])
  assert.ok(HUB_SOCIAL_OPERATIONS.filter(row => row !== crawl).every(row => !row.optionalEndpointKeys))
  const urls = []
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-key', fetchImpl: async url => { urls.push(new URL(url)); return Response.json(page) } })
  const step = dispatch(repliesJob(), { resolvedIdentity: resolved, pageSize: 20 })
  const response = await adapter.execute(step, { encodeCursor: () => null })
  assert.equal(urls.length, 1)
  assert.equal(urls[0].pathname, '/user/42/tweetsAndReplies')
  assert.equal(urls[0].searchParams.get('count'), '20')
  // The adapter page still has every tweet; the account filter is the projection's.
  assert.equal(response.items.length, 30)
  assert.equal(response.items.filter(item => item.replyTo).length, tweets().filter(tweet => tweet.legacy.in_reply_to_status_id_str).length)
})
