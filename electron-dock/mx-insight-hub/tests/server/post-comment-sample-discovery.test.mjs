import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { discoverPostCommentSamples, normalizeCommentSampleTarget } from '../../server/ops/find-post-comment-samples.mjs'

const redditSourceId = 'af456ad4-2523-4f73-a1fc-c95104b329a4'
const kuaishouSourceId = 'bf456ad4-2523-4f73-a1fc-c95104b329a4'
const canonicalSourceId = 'cf456ad4-2523-4f73-a1fc-c95104b329a4'
const redditTarget = '1q4aqti'
const kuaishouTarget = '3xprivatefixture'
const usage = (platform, body, overrides = {}) => ({
  id: platform === 'reddit' ? redditSourceId : kuaishouSourceId,
  platform, method: 'POST', path: '/api/v1/search/post-comments', body: { platform, ...body }, ...overrides,
})
const canonical = (platform, target, overrides = {}) => ({
  id: canonicalSourceId, platform, object_type: 'post', external_id: target, url: null, ...overrides,
})

function harness({ incident = [], usages = [], canonicals = [], sourceUsages = [], sourceCanonicals = [],
  errorTag = null, errorCode = null, errorOnce = false } = {}) {
  const queries = []
  let releases = 0, failed = false, aborted = false
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql.startsWith('ROLLBACK TO SAVEPOINT')) { aborted = false; return { rows: [] } }
    if (sql === 'ROLLBACK') { aborted = false; return { rows: [] } }
    if (aborted) throw Object.assign(new Error('transaction must be recovered before another query'), { code: '25P02' })
    if (errorTag && sql.includes(errorTag) && (!errorOnce || !failed)) {
      failed = true; aborted = true
      throw Object.assign(new Error('private-database-error'), { code: errorCode })
    }
    if (sql.includes('comment-samples:incident')) return { rows: incident }
    if (sql.includes('comment-samples:usages')) return { rows: usages }
    if (sql.includes('comment-samples:canonical')) return { rows: canonicals }
    if (sql.includes('comment-samples:source-usage')) return { rows: sourceUsages }
    if (sql.includes('comment-samples:source-canonical')) return { rows: sourceCanonicals }
    return { rows: [] }
  }, release() { releases++ } }
  return { pool: { connect: async () => client }, queries, get releases() { return releases } }
}

test('sample normalization accepts exact platform IDs and consistent URL aliases without fetching', () => {
  const bare = normalizeCommentSampleTarget('reddit', { postId: redditTarget })
  assert.ok(bare)
  assert.equal(normalizeCommentSampleTarget('reddit', { contentId: `t3_${redditTarget}` }), bare)
  assert.equal(normalizeCommentSampleTarget('reddit', { postId: redditTarget, content_id: `t3_${redditTarget}`,
    url: `https://www.reddit.com/r/test/comments/${redditTarget}/example/` }), bare)
  assert.equal(normalizeCommentSampleTarget('reddit', { url: `https://old.reddit.com/comments/${redditTarget}/` }), bare)
  assert.equal(normalizeCommentSampleTarget('kuaishou', { photo_id: kuaishouTarget }), kuaishouTarget)
  assert.equal(normalizeCommentSampleTarget('kuaishou', { video_id: kuaishouTarget }), kuaishouTarget)
  assert.equal(normalizeCommentSampleTarget('kuaishou', { videoId: kuaishouTarget,
    url: `https://www.kuaishou.com/short-video/${kuaishouTarget}` }), kuaishouTarget)
})

test('sample normalization rejects conflicting identifiers, unsafe numeric IDs and unrelated or deceptive URLs', () => {
  for (const [platform, input] of [
    ['reddit', { postId: redditTarget, contentId: 'different' }],
    ['reddit', { postId: redditTarget, url: 'https://www.reddit.com/comments/different/' }],
    ['reddit', { postId: 9007199254740993 }],
    ['kuaishou', { postId: 9007199254740993 }],
    ['kuaishou', { photoId: kuaishouTarget, photo_id: 'other-photo' }],
    ['reddit', { url: `https://reddit.com.evil.example/comments/${redditTarget}/` }],
    ['reddit', { url: `https://user:secret@reddit.com/comments/${redditTarget}/` }],
    ['reddit', { url: `https://reddit.com/user/${redditTarget}` }],
    ['kuaishou', { url: `https://kuaishou.com.evil.example/short-video/${kuaishouTarget}` }],
    ['kuaishou', { url: 'https://v.kuaishou.com/private-short-link' }],
    ['kuaishou', { url: `file:///short-video/${kuaishouTarget}` }],
    ['twitter', { postId: '123' }],
  ]) assert.equal(normalizeCommentSampleTarget(platform, input), null)
})

test('discovery prefers prior comment requests and returns only a redacted bounded-evidence summary', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('supplier HTTP is forbidden') })
  const h = harness({ usages: [
    usage('reddit', { contentId: `t3_${redditTarget}`, token: 'private-api-key', ignoredMetadata: 'private-cursor' }),
    usage('kuaishou', { postId: kuaishouTarget }),
  ], canonicals: [canonical('reddit', 'different-post'), canonical('kuaishou', 'different-video')] })
  const result = await discoverPostCommentSamples(h.pool)
  assert.equal(result.revision, 'post-comment-sample-discovery.v1')
  assert.equal(result.results.length, 2)
  for (const platform of ['reddit', 'kuaishou']) {
    const row = result.results.find(value => value.platform === platform)
    assert.equal(row.state, 'found')
    assert.equal(row.sourceKind, 'usage')
    assert.equal(row.sourceId, platform === 'reddit' ? redditSourceId : kuaishouSourceId)
    assert.equal(row.postId, undefined)
  }
  const output = JSON.stringify(result)
  for (const privateValue of [redditTarget, kuaishouTarget, 'private-api-key', 'private-cursor', 'different-post', 'different-video']) {
    assert.equal(output.includes(privateValue), false)
  }
  assert.match(h.queries[0].sql, /READ ONLY/)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
  assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK)\b/u.test(row.sql.trim())), true)
  for (const row of h.queries.filter(value => /comment-samples:(?:usages|canonical)/u.test(value.sql))) {
    assert.match(row.sql, /\bLIMIT\b/iu)
  }
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(result.supplierHttpCallsMade, 0)
  assert.equal(result.databaseWritesMade, 0)
})

test('private preparation returns only the selected platform target and source identity', async () => {
  const h = harness({ usages: [usage('reddit', { postId: redditTarget }), usage('kuaishou', { postId: kuaishouTarget })] })
  const result = await discoverPostCommentSamples(h.pool, { preparePlatform: 'reddit' })
  assert.deepEqual(result, { revision: 'post-comment-target-sample.v1', platform: 'reddit',
    postId: normalizeCommentSampleTarget('reddit', { postId: redditTarget }), sourceKind: 'usage', sourceId: redditSourceId })
  assert.equal(JSON.stringify(result).includes(kuaishouTarget), false)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
})

test('discovery skips malformed historical requests and comment records before using an eligible canonical post', async () => {
  const h = harness({ usages: [
    usage('reddit', { postId: redditTarget }, { method: 'DELETE' }),
    usage('reddit', { postId: redditTarget }, { path: '/api/v1/search' }),
    usage('reddit', { postId: redditTarget }, { id: 'private-not-a-uuid' }),
    usage('reddit', { postId: redditTarget, contentId: 'different' }),
    usage('reddit', { postId: redditTarget }, { body: { platform: 'twitter', postId: redditTarget } }),
    usage('reddit', { postId: redditTarget, page: 2 }),
    usage('reddit', { postId: redditTarget, cursor: 'private-next-page' }),
    usage('reddit', { postId: redditTarget, params: { cursor: 'private-next-page' } }),
  ], canonicals: [
    canonical('reddit', 'private-comment-id', { object_type: 'comment' }),
    canonical('reddit', redditTarget),
  ] })
  const result = await discoverPostCommentSamples(h.pool, { preparePlatform: 'reddit' })
  assert.deepEqual(result, { revision: 'post-comment-target-sample.v1', platform: 'reddit',
    postId: normalizeCommentSampleTarget('reddit', { postId: redditTarget }), sourceKind: 'canonical', sourceId: canonicalSourceId })
})

test('a bounded scan without valid posts is reported as inconclusive and preparation refuses a missing target', async () => {
  const h = harness({ canonicals: [canonical('reddit', 'private-comment', { object_type: 'comment' })] })
  const result = await discoverPostCommentSamples(h.pool)
  assert.equal(result.results.length, 2)
  for (const row of result.results) {
    assert.equal(row.state, 'not_found_in_bounded_scan')
    assert.equal(row.sourceKind, null)
    assert.equal(row.sourceId, null)
  }
  const missing = harness()
  await assert.rejects(discoverPostCommentSamples(missing.pool, { preparePlatform: 'kuaishou' }), /sample_not_found/)
  assert.equal(missing.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(missing.releases, 1)
})

test('historical first-page requests may carry an empty params object and empty cursor', async () => {
  const h = harness({ usages: [usage('reddit', { postId: redditTarget, page: '1', params: {}, cursor: '' })] })
  const result = await discoverPostCommentSamples(h.pool, { preparePlatform: 'reddit' })
  assert.equal(result.sourceKind, 'usage')
  assert.equal(result.postId, redditTarget)
  assert.equal(result.sourceId, redditSourceId)
})

test('a timed-out history scan recovers its savepoint and can still discover canonical targets', async () => {
  const h = harness({ errorTag: 'comment-samples:usages', errorCode: '57014', errorOnce: true,
    canonicals: [canonical('reddit', redditTarget)] })
  const result = await discoverPostCommentSamples(h.pool)
  assert.equal(result.results.find(row => row.platform === 'reddit').state, 'found')
  assert.equal(result.results.find(row => row.platform === 'reddit').sourceKind, 'canonical')
  assert.equal(result.scans.find(row => row.source === 'recent_usages').state, 'timed_out')
  assert.equal(JSON.stringify(result).includes('private-database-error'), false)
  const failedIndex = h.queries.findIndex(row => row.sql.includes('comment-samples:usages'))
  assert.equal(h.queries[failedIndex + 1].sql, 'ROLLBACK TO SAVEPOINT comment_sample_read')
  assert.equal(h.queries[failedIndex + 2].sql, 'RELEASE SAVEPOINT comment_sample_read')
  assert.match(h.queries[0].sql, /READ ONLY/)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
})

test('missing tables produce incomplete discovery rather than a false absence or an unsafe prepared target', async () => {
  const h = harness({ errorTag: 'comment-samples:canonical', errorCode: '42P01' })
  const result = await discoverPostCommentSamples(h.pool)
  assert.equal(result.results.every(row => row.state === 'discovery_incomplete'), true)
  assert.equal(result.scans.some(row => row.state === 'schema_unavailable'), true)
  assert.equal(result.results.every(row => row.sourceId === null && row.sourceKind === null), true)
  assert.equal(JSON.stringify(result).includes('private-database-error'), false)
  const missing = harness({ errorTag: 'comment-samples:canonical', errorCode: '42703' })
  await assert.rejects(discoverPostCommentSamples(missing.pool, { preparePlatform: 'reddit' }), /sample_discovery_incomplete/)
  assert.equal(missing.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(missing.releases, 1)
})

test('canonical Kuaishou photo IDs come from public URLs rather than internal numeric cid, while Reddit keeps its post ID', async () => {
  const rows = [
    canonical('kuaishou', '9876543210000000000'),
    canonical('kuaishou', '9876543210000000001', { url: `https://www.kuaishou.com/short-video/${kuaishouTarget}` }),
    canonical('reddit', `t3_${redditTarget}`, { url: 'https://news.example/private-outbound-article' }),
  ]
  const kuaishou = await discoverPostCommentSamples(harness({ canonicals: rows }).pool, { preparePlatform: 'kuaishou' })
  assert.equal(kuaishou.postId, kuaishouTarget)
  assert.equal(kuaishou.sourceKind, 'canonical')
  const reddit = await discoverPostCommentSamples(harness({ canonicals: rows }).pool, { preparePlatform: 'reddit' })
  assert.equal(reddit.postId, redditTarget)
  const onlyCid = harness({ canonicals: [canonical('kuaishou', '9876543210000000000')] })
  await assert.rejects(discoverPostCommentSamples(onlyCid.pool, { preparePlatform: 'kuaishou' }), /sample_not_found/)
})

test('canonical discovery prefers an eligible post with a positive saved comment count', async () => {
  const h = harness({ canonicals: [
    canonical('reddit', 'zero', { comment_count: '0' }),
    canonical('reddit', redditTarget, { comment_count: '23' }),
    canonical('reddit', 'invalid', { comment_count: 'private-not-a-number' }),
  ] })
  const result = await discoverPostCommentSamples(h.pool, { preparePlatform: 'reddit' })
  assert.equal(result.postId, redditTarget)
})

test('an incident window is read before recent history and preserves the first eligible historical target', async () => {
  const at = '2026-11-02T03:00:00.000Z'
  const h = harness({ incident: [{ created_at: at }], usages: [usage('reddit', { postId: redditTarget })] })
  const result = await discoverPostCommentSamples(h.pool)
  assert.equal(result.results.find(row => row.platform === 'reddit').sourceKind, 'usage')
  const usageQueries = h.queries.filter(row => row.sql.includes('comment-samples:usages'))
  assert.equal(usageQueries.length, 2)
  assert.deepEqual(usageQueries[0].values, [at])
  assert.deepEqual(usageQueries[1].values, [])
  assert.match(usageQueries[0].sql, /interval '1 hour'/u)
  assert.match(usageQueries[0].sql, /LIMIT 5000/u)
  assert.match(usageQueries[0].sql, /LIMIT 50/u)
})

test('discovery validates prepare platforms before connecting and releases after a transaction-start failure', async () => {
  await assert.rejects(discoverPostCommentSamples({ connect() { throw new Error('must not connect') } }, { preparePlatform: 'twitter' }),
    /invalid_arguments/)
  const h = harness({ errorTag: 'BEGIN' })
  await assert.rejects(discoverPostCommentSamples(h.pool), /private-database-error/)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
})

const pinnedRedditSourceId = 'ee8dd99d-9146-4cb9-9ddc-eeeca3174c49'
const pinnedKuaishouSourceId = '120ec88d-84f3-4369-b5d9-92b877f75bd7'
const pinnedUsage = (overrides = {}) => usage('reddit', { postId: redditTarget }, { id: pinnedRedditSourceId, ...overrides })
const pinnedCanonical = (overrides = {}) => canonical('kuaishou', '9876543210000000001', {
  id: pinnedKuaishouSourceId, dataset_id: 'night-all.compat.v1', deleted_at: null,
  url: `https://www.kuaishou.com/short-video/${kuaishouTarget}`, ...overrides,
})
const usagePin = { preparePlatform: 'reddit', sourceKind: 'usage', sourceId: pinnedRedditSourceId }
const canonicalPin = { preparePlatform: 'kuaishou', sourceKind: 'canonical', sourceId: pinnedKuaishouSourceId }

function assertExactSourceRead(h, sourceKind, sourceId, platform) {
  const reads = h.queries.filter(row => row.sql.includes('comment-samples:'))
  assert.equal(reads.length, 1)
  assert.ok(reads[0].sql.includes(`comment-samples:source-${sourceKind}`))
  assert.ok(reads[0].values.includes(sourceId))
  assert.ok(reads[0].values.includes(platform))
  assert.equal(reads[0].sql.includes(sourceId), false)
  assert.match(reads[0].sql, /\bid\s*=\s*\$\d+(?:::uuid)?/iu)
  assert.match(h.queries[0].sql, /READ ONLY/)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
  assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK)\b/u.test(row.sql.trim())), true)
}

test('exact-source preparation uses the pinned historical request without rescanning newer usage or canonical history', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('supplier HTTP is forbidden') })
  const h = harness({ sourceUsages: [pinnedUsage()], usages: [usage('reddit', { postId: 'newer' })],
    canonicals: [canonical('reddit', 'other')] })
  const result = await discoverPostCommentSamples(h.pool, usagePin)
  assert.deepEqual(result, { revision: 'post-comment-target-sample.v1', platform: 'reddit', postId: redditTarget,
    sourceKind: 'usage', sourceId: pinnedRedditSourceId })
  assertExactSourceRead(h, 'usage', pinnedRedditSourceId, 'reddit')
  assert.equal(fetch.mock.callCount(), 0)
})

test('exact-source preparation reads the pinned Kuaishou compat record and derives its photo ID from its URL', async () => {
  const h = harness({ sourceCanonicals: [pinnedCanonical()], errorTag: 'comment-samples:canonical', errorCode: '57014' })
  const result = await discoverPostCommentSamples(h.pool, canonicalPin)
  assert.deepEqual(result, { revision: 'post-comment-target-sample.v1', platform: 'kuaishou', postId: kuaishouTarget,
    sourceKind: 'canonical', sourceId: pinnedKuaishouSourceId })
  assert.equal(JSON.stringify(result).includes('9876543210000000001'), false)
  assertExactSourceRead(h, 'canonical', pinnedKuaishouSourceId, 'kuaishou')
})

test('exact source identity and request semantics must still match, and failures never fall through to another target', async () => {
  for (const rows of [[], [pinnedUsage(), pinnedUsage()],
    [pinnedUsage({ id: redditSourceId })], [pinnedUsage({ platform: 'kuaishou' })],
    [pinnedUsage({ method: 'GET' })], [pinnedUsage({ path: '/api/v1/search' })],
    [pinnedUsage({ body: { platform: 'reddit', postId: redditTarget, contentId: 'other' } })],
    [pinnedUsage({ body: { platform: 'reddit', postId: redditTarget, cursor: 'private-next' } })],
  ]) {
    const h = harness({ sourceUsages: rows, usages: [usage('reddit', { postId: 'fallback' })] })
    await assert.rejects(discoverPostCommentSamples(h.pool, usagePin), /sample_source_unavailable/)
    assertExactSourceRead(h, 'usage', pinnedRedditSourceId, 'reddit')
  }
})

test('pinned canonical preparation rejects changed source scope, deleted records, comments and unverified Kuaishou photo IDs', async () => {
  for (const rows of [[], [pinnedCanonical(), pinnedCanonical()],
    [pinnedCanonical({ id: canonicalSourceId })], [pinnedCanonical({ platform: 'reddit' })],
    [pinnedCanonical({ dataset_id: 'private-unapproved-dataset' })], [pinnedCanonical({ dataset_id: null })],
    [pinnedCanonical({ deleted_at: '2026-11-02T00:00:00.000Z' })], [pinnedCanonical({ object_type: 'comment' })],
    [pinnedCanonical({ url: null })], [pinnedCanonical({ url: `https://kuaishou.com.evil.example/short-video/${kuaishouTarget}` })],
  ]) {
    const h = harness({ sourceCanonicals: rows, canonicals: [pinnedCanonical()] })
    await assert.rejects(discoverPostCommentSamples(h.pool, canonicalPin), /sample_source_unavailable/)
    assertExactSourceRead(h, 'canonical', pinnedKuaishouSourceId, 'kuaishou')
  }
})

test('exact-source options are validated together before connecting', async () => {
  for (const options of [
    { sourceKind: 'usage', sourceId: pinnedRedditSourceId },
    { preparePlatform: 'reddit', sourceKind: 'usage' }, { preparePlatform: 'reddit', sourceId: pinnedRedditSourceId },
    { ...usagePin, sourceKind: 'unknown' }, { ...usagePin, sourceId: 'not-a-uuid' },
    { ...usagePin, sourceId: "' OR true --" }, { ...usagePin, preparePlatform: 'twitter' },
  ]) {
    await assert.rejects(discoverPostCommentSamples({ connect() { throw new Error('must not connect') } }, options), /invalid_arguments/)
  }
})

test('a pinned source read failure rolls back without rescanning or substituting another target', async () => {
  const h = harness({ errorTag: 'comment-samples:source-canonical', errorCode: '57014',
    canonicals: [pinnedCanonical()] })
  await assert.rejects(discoverPostCommentSamples(h.pool, canonicalPin), /private-database-error/)
  assertExactSourceRead(h, 'canonical', pinnedKuaishouSourceId, 'kuaishou')
})

test('standalone exact-source CLI validates complete arguments before any database connection', async () => {
  const source = await readFile(new URL('../../server/ops/find-post-comment-samples.mjs', import.meta.url), 'utf8')
  const env = { ...process.env }
  delete env.DATABASE_URL
  const invoke = args => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], {
      input: source, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    return JSON.parse(result.stderr)
  }
  for (const args of [[], ['--prepare', 'reddit'],
    ['--prepare', 'reddit', '--source-kind', 'usage', '--source-id', pinnedRedditSourceId],
    ['--prepare', 'kuaishou', '--source-kind', 'canonical', '--source-id', pinnedKuaishouSourceId]]) {
    assert.equal(invoke(args).error, 'database_url_required')
  }
  for (const args of [
    ['--prepare', 'reddit', '--source-kind', 'usage'],
    ['--prepare', 'reddit', '--source-kind', 'usage', '--source-id', 'not-a-uuid'],
    ['--prepare', 'reddit', '--source-kind', 'wrong', '--source-id', pinnedRedditSourceId],
    ['--source-kind', 'usage', '--source-id', pinnedRedditSourceId],
    ['--prepare', 'twitter', '--source-kind', 'usage', '--source-id', pinnedRedditSourceId],
    ['--prepare', 'reddit', '--source-kind', 'usage', '--source-id', pinnedRedditSourceId, '--apply'],
  ]) assert.equal(invoke(args).error, 'invalid_arguments')
})
