import test from 'node:test'
import assert from 'node:assert/strict'
import { projectInstagramSearch } from '../../server/contracts/instagram-search.mjs'

const capturedAt = '2026-10-12T03:57:09.272Z'
const account = { pk: '123', username: 'fixture-account' }
const post = { id: '123456789012345678_123', pk: '123456789012345678', code: 'fixture',
  media_type: 1, caption: { text: 'Full caption\n#fixture' }, taken_at: 1791777420,
  user: account, image_versions2: { candidates: [
    { url: 'https://example.test/small.jpg', width: 100, height: 100 },
    { url: 'https://example.test/large.jpg', width: 1080, height: 1920 },
  ] } }
const groups = [
  { list: [{ place: { location: { pk: '123', name: 'fixture-place' } }, position: 0 }] },
  { users: [account] }, { users: [{ position: 0, user: account }] },
  { hashtags: [{ id: '456', name: 'fixture-tag' }] }, { hashtags: [{ hashtag: {} }] },
  { places: [{ location: { pk: '123', name: 'fixture-place' } }] }, { places: [{ place: {} }] },
  { other_results: { keyword_recommendations: { keywords: [{ id: '456', name: 'fixture-term' }] } } },
]
function project(data, overrides = {}) {
  return projectInstagramSearch({ publicBody: { data, meta: { capturedAt } } }, {
    query: 'fixture', page: 1, pageSize: 20, archiveCallId: '00000000-0000-0000-0000-000000000001',
    encodeNext: value => JSON.stringify(value), ...overrides,
  })
}

test('all documented recommendation groups and mixed place wrappers preserve valid continuation or explicit partial status', () => {
  for (const group of groups) {
    const data = { status: 'ok', ...group, has_more: false }
    const before = structuredClone(data)
    const complete = project(data)
    assert.equal(complete.publicBody.data.status, 'ok')
    assert.deepEqual(complete.items, [])
    assert.equal(complete.publicBody.data.page.hasMore, false)
    assert.deepEqual(data, before)
    const partial = project({ ...data, has_more: true })
    assert.equal(partial.publicBody.data.status, 'partial')
    assert.equal(partial.publicBody.data.page.nextCursor, null)
    assert.equal(partial.publicBody.data.warnings[0].code, 'INSTAGRAM_NON_POST_CONTINUATION_UNAVAILABLE')
    const next = project({ ...data, has_more: true, next_max_id: 'next', rank_token: 'rank' })
    assert.equal(next.publicBody.data.status, 'ok')
    assert.deepEqual(JSON.parse(next.publicBody.data.page.nextCursor), {
      page: 2, providerCursor: { next_max_id: 'next', rank_token: 'rank' },
    })
    const mixed = project({ ...data, items: [post] })
    assert.equal(mixed.items.length, 1)
    assert.equal(mixed.items[0].full_text, post.caption.text)
    assert.throws(() => project({ ...data, items: [post], has_more: true }), /missing_instagram_continuation/)
  }
})

test('coexisting containers retain every post and deduplicate IDs without mutating paid evidence', () => {
  const second = { ...post, id: '2', code: 'second' }
  const third = { ...post, id: '3', code: 'third' }
  const data = { status: 'ok', media_grid: { sections: [{ layout_content: { medias: [{ media: post }] } }] },
    items: [second], list: [{ user: account }, { media: third }, post],
    users: [account], hashtags: [{ name: 'fixture-tag' }], places: [{ location: {} }],
    has_next_page: true, next_max_id: 'next', rank_token: 'rank' }
  const before = structuredClone(data)
  const result = project({ data })
  assert.deepEqual(result.items.map(row => row.content_id), [post.id, second.id, third.id])
  assert.equal(result.publicBody.data.page.hasMore, true)
  assert.deepEqual(data, before)
  assert.equal(project({ status: 'ok', media_grid: { sections: [] }, list: [{ media: post }] }).items.length, 1)
  const first = project(data, { pageSize: 2 })
  assert.deepEqual(first.items.map(row => row.content_id), [post.id, second.id])
  const buffered = project(data, { pageSize: 2, ...JSON.parse(first.publicBody.data.page.nextCursor) })
  assert.deepEqual(buffered.items.map(row => row.content_id), [third.id])
  assert.deepEqual(JSON.parse(buffered.publicBody.data.page.nextCursor), { page: 3,
    providerCursor: { next_max_id: 'next', rank_token: 'rank' } })
  assert.equal(buffered.publicBody.data.meta.upstreamCallCount, 0)
  assert.deepEqual(data, before)
})

test('October 12 live response shape: account list and 18 grid photos, videos and carousels retain their media', () => {
  // Anonymized structural fixture from the single Paris live call. No provider
  // credentials, account names, signed CDN URLs or real continuation tokens.
  const media = Array.from({ length: 18 }, (_, index) => ({ ...post, id: `${index + 100}_123`,
    pk: String(index + 100), code: `fixture${index}`, media_type: index < 9 ? 1 : index < 14 ? 2 : 8,
    ...(index >= 9 && index < 14 ? { video_versions: [{ url: 'https://example.test/video.mp4' }] } : {}),
    ...(index >= 14 ? { carousel_media: [
      { media_type: 1, image_versions2: { candidates: [{ url: 'https://example.test/slide.jpg' }] } },
      { media_type: 2, video_versions: [{ url: 'https://example.test/slide.mp4' }] },
    ] } : {}),
  }))
  const data = { status: 'ok', list: [{ position: 0, user: account }], rank_token: 'fixture-rank',
    media_grid: { sections: [{ layout_type: 'media_grid', feed_type: 'media',
      layout_content: { medias: media.map(media => ({ media })) } }],
    has_more: true, next_max_id: 'fixture-next', rank_token: 'fixture-rank' } }
  const result = project(data)
  assert.equal(result.items.length, 18)
  assert.equal(result.items.filter(row => row.content_type === 'video').length, 5)
  assert.equal(result.publicBody.data.status, 'ok')
  assert.equal(result.publicBody.data.page.hasMore, true)
  for (const [i, row] of result.items.entries()) {
    assert.equal(row.content_id, media[i].id)
    assert.equal(row.cover_url, 'https://example.test/large.jpg')
    assert.equal(row.text, post.caption.text)
    assert.equal(row.author_id, account.pk)
    if (i >= 14) {
      assert.deepEqual(JSON.parse(row.image_urls), ['https://example.test/large.jpg', 'https://example.test/slide.jpg'])
      assert.deepEqual(JSON.parse(row.video_urls), ['https://example.test/slide.mp4'])
    }
  }
  const alias = project({ mediaGrid: { sections: [{ layoutContent: { media: [{ media: post }] } }] } })
  assert.equal(alias.items.length, 1)
})

test('explicit empty groups remain empty and valid cursors do not require a post on this page', () => {
  for (const group of [{ users: [] }, { hashtags: [] }, { places: [] }, { items: [] },
    { list: [] }, { media_grid: { sections: [] } },
    { other_results: { keyword_recommendations: { keywords: [] } } }]) {
    assert.deepEqual(project({ status: 'ok', ...group }).items, [])
    assert.throws(() => project({ status: 'ok', ...group, has_more: true }), /missing_instagram_continuation/)
    const next = project({ status: 'ok', ...group, has_more: true, next_max_id: 'next' },
      { providerCursor: { rank_token: 'retained-rank' } })
    assert.equal(next.publicBody.data.page.hasMore, true)
    assert.equal(JSON.parse(next.publicBody.data.page.nextCursor).providerCursor.rank_token, 'retained-rank')
  }
  for (const overrides of [{ page: 15 }, { providerCursor: { next_max_id: 'same' } }]) {
    assert.equal(project({ status: 'ok', places: [{}], has_more: true, next_max_id: 'same' }, overrides)
      .publicBody.data.page.hasMore, false)
  }
})

test('recommendations never hide malformed posts, conflicting kinds or invalid sibling containers', () => {
  for (const invalid of [
    { users: {} }, { users: [null] }, { users: [{ username: 'no-id' }] },
    { users: [{ ...account, media: null }] }, { users: [{ user: account, hashtag: {} }] },
    { hashtags: [post] }, { hashtags: [{ hashtag: {}, media: post }] },
    { places: ['unknown'] }, { places: [{ place: {}, user: account }] },
    { list: [{ place: null }] }, { list: [{ place: {}, media: null }] },
    { list: [{ user: account, hashtag: {} }] }, { list: [{ place: {}, caption: 'bad post' }] },
    { list: [{ hashtag: { code: 'bad-post' } }] }, { list: [{ unknown: {} }] },
    { media_grid: {} }, { items: {} }, { list: {} },
    { other_results: { keyword_recommendations: { keywords: [null] } } },
  ]) {
    assert.throws(() => project({ status: 'ok', ...invalid }), /invalid_instagram_search_shape/)
    assert.throws(() => project({ status: 'ok', items: [post], users: [account], ...invalid }), /invalid_instagram_search_shape/)
  }
  for (const value of [null, false, 'unknown', { ...post, code: {} }, { ...post, code: '  ' }]) {
    assert.throws(() => project({ items: [value], hashtags: [{}] }), /invalid_instagram_post_identity/)
  }
  assert.throws(() => project({ status: 'ok', media_grid: { sections: [null] }, places: [{}] }), /invalid_instagram_media_grid/)
  for (const more of [true, 1, '1', 'true']) assert.equal(project({ places: [{}], has_more: more }).publicBody.data.status, 'partial')
  assert.throws(() => project({ places: [{}], has_more: 'unknown' }), /invalid_instagram_pagination/)
  assert.throws(() => project({ places: [{}], next_max_id: {} }), /invalid_instagram_continuation/)
})

test('buffered terminal pages and traversal limits report accurate counts without mutating the receipt', () => {
  const data = { items: Array.from({ length: 41 }, (_, i) => ({ ...post, id: String(i + 1) })), has_more: false }
  const first = project(data)
  assert.equal(first.items.length, 20)
  const state = JSON.parse(first.publicBody.data.page.nextCursor)
  const second = project(data, state)
  const third = project(data, JSON.parse(second.publicBody.data.page.nextCursor))
  assert.equal(third.items.length, 1)
  assert.equal(third.publicBody.data.page.hasMore, false)
  const capped = project(data, { page: 15 })
  assert.equal(capped.publicBody.data.page.nextCursor, null)
  assert.equal(capped.publicBody.data.status, 'partial')
  assert.equal(capped.publicBody.data.warnings[0].code, 'INSTAGRAM_PAGE_LIMIT_REACHED')
  assert.throws(() => project({ ...data, items: data.items.toReversed() }, state), /instagram_buffer_mismatch/)
  const invalid = structuredClone(data)
  invalid.items[40].id = null
  invalid.items[40].pk = null
  assert.throws(() => project(invalid), /invalid_instagram_post_identity/)
})

test('one-by-two and two-by-two search sections deliver their clips, fill items and channel media', () => {
  const clip = { ...post, id: '11', code: 'clip' }, fill = { ...post, id: '12', code: 'fill' }, channel = { ...post, id: '13', code: 'channel' }
  const data = { status: 'ok', media_grid: { sections: [
    { layout_type: 'one_by_two_right', layout_content: { one_by_two_item: { clips: { items: [{ media: clip }], max_id: 'x' } }, fill_items: [{ media: fill }] } },
    { layout_type: 'two_by_two_left', layout_content: { two_by_two_item: { channel: { media: channel, title: 'Reels' } } } },
    { layout_type: 'media_grid', layout_content: { medias: [{ media: post }] } },
  ], has_more: true, next_max_id: 'next', rank_token: 'rank' } }
  const result = project(data)
  assert.deepEqual(result.items.map(row => row.content_id).sort(), ['11', '12', '13', post.id].sort())
  assert.equal(result.publicBody.data.status, 'ok')
  assert.equal(result.publicBody.data.page.hasMore, true)
})

test('a section layout Hub cannot read is reported as partial instead of a silent empty page', () => {
  const data = { status: 'ok', media_grid: { sections: [
    { layout_type: 'future_layout', layout_content: { future_item: { posts: [{ media: post }] } } },
    { layout_content: { medias: [{ media: { ...post, id: '21', code: 'known' } }] } },
    { layout_content: {} },
  ], has_more: true, next_max_id: 'next', rank_token: 'rank' } }
  const result = project(data)
  assert.deepEqual(result.items.map(row => row.content_id), ['21'])
  assert.equal(result.publicBody.data.status, 'partial')
  assert.deepEqual(result.publicBody.data.warnings.map(warning => warning.code), ['INSTAGRAM_UNRECOGNIZED_SECTIONS'])
  assert.match(result.publicBody.data.warnings[0].message, /^1 search grid section/u)
  assert.equal(result.publicBody.data.page.hasMore, true)
  assert.throws(() => project({ status: 'ok', media_grid: { sections: [{ layout_content: { fill_items: {} } }] } }), /invalid_instagram_media_grid/)
  assert.throws(() => project({ status: 'ok', media_grid: { sections: [{ layout_content: { two_by_two_item: { channel: { media: [] } } } }] } }),
    /invalid_instagram_media_grid/)
})
