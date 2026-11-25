import test from 'node:test'
import assert from 'node:assert/strict'
import { shareLinkActions, douyinDetailId, xiaohongshuNoteUrl, DOUYIN_DETAIL_ENDPOINT, DOUYIN_SHARE_CODE_ENDPOINT } from '../../src/share-link-actions.js'
import { normalizeXiaohongshuPostRequest } from '../../server/contracts/tikhub-xiaohongshu.mjs'

const douyin = { ok: true, platform: 'douyin', postId: '7711199887010673919' }
const note = { ok: true, platform: 'xiaohongshu', postId: '6afed50c000000002b0044c7', xsec_token: 'private-note-token' }
const scopes = (platform, capability) => ({ platforms: [platform], capabilities: [capability] })

test('resolver handoffs contain only a validated ID and require each downstream product grant', () => {
  assert.deepEqual(shareLinkActions(douyin, scopes('social', 'social.share_links.resolve')), [])
  const [video] = shareLinkActions(douyin, scopes('social', `native.${DOUYIN_DETAIL_ENDPOINT}`))
  const [, videoQuery] = video.href.split('?')
  const params = new URLSearchParams(videoQuery)
  assert.equal(params.get('endpoint'), DOUYIN_DETAIL_ENDPOINT)
  assert.equal(douyinDetailId(params.get('awemeId')), douyin.postId)

  const [detail] = shareLinkActions(note, scopes('xiaohongshu', 'social.posts.resolve'))
  assert.equal(detail.href, `#/data-products/xiaohongshu-note?noteId=${note.postId}`)
  const url = xiaohongshuNoteUrl(new URLSearchParams(detail.href.split('?')[1]).get('noteId'))
  assert.deepEqual(normalizeXiaohongshuPostRequest({ platform: note.platform, url }).upstreamQuery, { note_id: note.postId })

  for (const row of [douyin, note]) {
    assert.deepEqual(shareLinkActions(row, scopes(row.platform, 'social.comments.list')).map(action => action.href),
      [`#/data-products/strategy-search?view=product&interface=post-comments&platform=${row.platform}&contentId=${row.postId}`])
    assert.deepEqual(shareLinkActions({ ...row, ok: false }, null), [])
    assert.deepEqual(shareLinkActions({ ...row, postId: row.postId + '&token=value' }, null), [])
  }
})

test('Douyin share codes link only to the separately authorized manual query without copying the input into navigation', () => {
  const row = { ok: false, platform: 'douyin', type: 'share_code', code: 'share_code_requires_lookup', link: null, share_code: '示例口令' }
  const authorized = scopes('social', `native.${DOUYIN_SHARE_CODE_ENDPOINT}`)
  for (const access of [authorized, null]) {
    const actions = shareLinkActions(row, access)
    assert.equal(actions.length, 1)
    assert.equal(actions[0].href, `#/data-products/social-content?endpoint=${DOUYIN_SHARE_CODE_ENDPOINT}`)
    assert.match(actions[0].hint, /share_code/u)
  }
  assert.deepEqual(shareLinkActions(row, scopes('social', 'social.share_links.resolve')), [])
  assert.deepEqual(shareLinkActions(row, undefined), [])
  assert.deepEqual(shareLinkActions(row, scopes('douyin', `native.${DOUYIN_SHARE_CODE_ENDPOINT}`)), [])
  assert.deepEqual(shareLinkActions({ ...row, platform: 'xiaohongshu' }, authorized), [])
  assert.deepEqual(shareLinkActions({ ...row, code: 'unrecognized_link' }, authorized), [])
})
