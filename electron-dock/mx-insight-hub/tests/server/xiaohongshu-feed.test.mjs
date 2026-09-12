import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeNotes, nativeNotePage, storedNote } from '../../src/xiaohongshu-feed.js'
const note = { note_id: '675d277d000000000600e655', desc: '长'.repeat(1000), tag_list: [{ name: '摄影' }] }
const response = (extra = {}) => ({ code: 200, data: { data: { items: [{ model_type: 'note', note }], has_more: true, search_id: 'session', ...extra } } })
test('native feed preserves text/tags, carries search sessions and terminates at page 15', () => {
  const page = nativeNotePage(response(), 'search_notes', { keyword: '摄影', page: 1 })
  assert.equal(page.items[0].text.length, 1000)
  assert.deepEqual(page.items[0].tags, ['摄影'])
  assert.equal(page.next.page, 2)
  assert.equal(page.next.search_id, 'session')
  assert.equal(nativeNotePage(response({ has_more: null, next_page: true }), 'search_notes', { page: 1 }).next.page, 2)
  assert.throws(() => nativeNotePage(response({ next_page: 0 }), 'search_notes', { page: 1 }))
  assert.throws(() => nativeNotePage(response({ next_page: 5 }), 'search_notes', { page: 1 }))
  assert.equal(nativeNotePage(response(), 'search_notes', { page: 15 }).next, null)
  assert.throws(() => nativeNotePage(response({ has_more: null }), 'search_notes', { page: 1 }))
  assert.throws(() => nativeNotePage(response({ items: [] }), 'search_notes', { page: 1 }))
  assert.throws(() => nativeNotePage({ code: 200, data: '服务异常' }, 'search_notes', { page: 1 }))
})
test('user feed forwards only Hub cursors and stops at terminal page', () => {
  const payload = cursor => ({ code: 200, data: { data: { notes: [{ ...note, cursor }] } } })
  const request = { user_id: note.note_id }
  assert.equal(nativeNotePage(payload('mxec2.opaque'), 'get_user_posted_notes', request).next.cursor, 'mxec2.opaque')
  assert.equal(nativeNotePage(payload(null), 'get_user_posted_notes', request).next, null)
  assert.throws(() => nativeNotePage(payload('raw-provider-cursor'), 'get_user_posted_notes', request))
})
test('stored projection retains complete body/tags and merges canonical IDs with native note identity', () => {
  const row = storedNote({ id: 'canonical-uuid', externalId: note.note_id, body: note.desc, stableFields: { tags: ['摄影'], media: { images: ['https://image.test/a'] } } })
  const live = nativeNotePage(response(), 'search_notes', { page: 1 }).items[0]
  assert.equal(row.text.length, 1000)
  assert.deepEqual(row.tags, ['摄影'])
  assert.equal(mergeNotes([live], [row]).length, 1)
  assert.equal(row.media[0].url, 'https://image.test/a')
})
