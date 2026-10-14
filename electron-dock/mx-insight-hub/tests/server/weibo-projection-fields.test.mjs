import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { weiboRow, projectWeiboSearch, rawSearchRecords } from '../../server/contracts/raw-search.mjs'
import { projectDataSearch } from '../../server/contracts/hub-data-search.mjs'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/weibo-search-fields.json', import.meta.url), 'utf8'))
const request = { platform: 'weibo', query: 'fixture', page: 1, pageSize: 20, encodeNext: () => 'offline-cursor' }
function project(rows) {
  return projectWeiboSearch({ publicBody: { data: { parsed_data: { results: rows,
    pagination: { has_next_page: false } } }, meta: { capturedAt: fixture.capturedAt } } }, request)
}

test('Weibo fixed realtime fields keep complete body/media and normalize the actual protocol-relative post URL', () => {
  const original = structuredClone(fixture.native)
  const projected = project([original])
  const row = projected.items[0]
  assert.equal(row.url, 'https://weibo.com/7069883894/R5DrJi9Lq?refer_flag=1001030103_')
  assert.equal(row.author_id, '7069883894')
  assert.equal(row.full_text, '完整微博正文第一段。\n第二段 & #话题#')
  assert.equal(row.text, row.full_text)
  assert.equal(row.title, '')
  assert.equal(row.body_completeness, 'full_text')
  assert.deepEqual(JSON.parse(row.image_urls), original.media.images)
  assert.deepEqual(JSON.parse(row.video_urls), original.media.videos)
  const item = projectDataSearch(projected, request).data.items[0]
  assert.deepEqual(item.metrics, { likes: 12, comments: 3, shares: 2, views: null, bookmarks: null })
  assert.equal(item.url, row.url)
  assert.equal(item.title, null)
  assert.equal(item.text, row.full_text)
  assert.deepEqual(item.media.images, original.media.images)
  assert.deepEqual(item.media.videos, original.media.videos)
  assert.deepEqual(original, fixture.native)
})

test('Weibo evidenced flat aliases map into both standard metrics and canonical ingestion without fake zero', () => {
  const projected = project([fixture.flat])
  const item = projectDataSearch(projected, request).data.items[0]
  assert.equal(item.url, 'https://weibo.com/7069883894/R5DrJi9Lr')
  assert.deepEqual(item.metrics, { likes: 21, comments: 4, shares: 5, views: 31, bookmarks: 6 })
  const [record] = rawSearchRecords(projected.publicBody, 'weibo', 'tikhub')
  assert.deepEqual(record.stableFields.metrics, item.metrics)
  assert.equal(record.body, fixture.flat.text_raw)
  assert.equal(record.url, item.url)
})

test('Weibo real zeros remain zeros while absent, invalid, boolean and whitespace metrics remain unknown', () => {
  const missing = { weibo_id: '5313432754327442', content: '正文' }
  const zero = { ...missing, weibo_id: '5313432754327443', attitudes_count: 0, like_count: 99,
    comments_count: '0', reposts_count: 0, view_count: '0', collect_count: 0 }
  const invalid = { ...missing, weibo_id: '5313432754327444', like_count: true, comment_count: '  ',
    share_count: -1, view_count: '未提供', collect_count: false }
  const items = projectDataSearch(project([missing, zero, invalid]), request).data.items
  assert.deepEqual(items[0].metrics, { likes: null, comments: null, shares: null, views: null, bookmarks: null })
  assert.deepEqual(items[1].metrics, { likes: 0, comments: 0, shares: 0, views: 0, bookmarks: 0 })
  assert.deepEqual(items[2].metrics, items[0].metrics)
  assert.equal(items[0].url, null)
  assert.equal(weiboRow({ ...missing, post_url: 'javascript:alert(1)' }, fixture.capturedAt).url, null)
  assert.equal(weiboRow({ ...missing, post_url: 'https://secret@example.test/post' }, fixture.capturedAt).url, null)
})
