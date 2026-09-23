import assert from 'node:assert/strict'
import test from 'node:test'
import { claimNoteTagsRequest, xiaohongshuTopicHref } from '../../src/xiaohongshu-topics.js'
import { mergeNoteDetail } from '../../src/xiaohongshu-feed.js'

const payload = { meta: { tagsAvailable: false }, data: { item: { text: '#正文里出现的词[话题]#', tags: [] } } }
const ready = { payload, apiKey: 'test-key', resolveIssues: [] }

test('missing structured tags claim one existing body API call and never parse the text', () => {
  const saved = {}
  assert.equal(claimNoteTagsRequest(saved, ready), true)
  assert.equal(claimNoteTagsRequest(saved, ready), false)
  assert.equal(claimNoteTagsRequest(saved, { ...ready, apiKey: 'renewed-key' }), false)
  assert.deepEqual(mergeNoteDetail({ tags: [] }, payload).tags, [])
  const structured = { data: { item: { tags: ['接口标签'], text: '完整正文' } } }
  const displayed = mergeNoteDetail(mergeNoteDetail({ tags: [] }, structured, { tagsAvailable: true }), payload)
  assert.deepEqual(displayed.tags, ['接口标签'])
  assert.equal(displayed.text, payload.data.item.text)
  const missing = { meta: { tagsAvailable: true }, data: { item: { text: payload.data.item.text, tags: [] } } }
  assert.deepEqual(mergeNoteDetail({ tags: ['已获取的列表标签'] }, missing).tags, ['已获取的列表标签'])
  assert.equal(mergeNoteDetail({ tags: [] }, missing).text, payload.data.item.text, 'preserve body including topic markers')
})

test('supplied tags, no-data, missing grants and earlier success or failures prevent supplemental calls', () => {
  for (const saved of [{ result: {} }, { error: new Error('unknown result') }, { identity: { key: 'failed-request-key' } }]) {
    assert.equal(claimNoteTagsRequest(saved, ready), false)
  }
  for (const input of [
    { ...ready, apiKey: '' },
    { ...ready, resolveIssues: [{ kind: 'authorization' }] },
    { ...ready, resolveIssues: [{ kind: 'runtime' }] },
    { ...ready, payload: { meta: { tagsAvailable: true }, data: { item: { tags: [] } } } },
    { ...ready, payload: { data: { item: null } } },
  ]) assert.equal(claimNoteTagsRequest({}, input), false)
})

test('structured topic links encode names within a fixed HTTPS search destination', () => {
  const topic = 'OPPO & Live?下一页=2/<script>'
  const href = xiaohongshuTopicHref(topic)
  const url = new URL(href)
  assert.equal(url.origin, 'https://www.xiaohongshu.com')
  assert.equal(url.pathname, '/search_result')
  assert.deepEqual([...url.searchParams.entries()], [['keyword', topic]])
  assert.equal(url.hash, '')
  assert.doesNotMatch(href, /<script>/)
})
