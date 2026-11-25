import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeShareLinkInput, resolveShareLinks, SHARE_LINK_LIMITS } from '../../server/services/share-link-resolver.mjs'

const awemeId = '7711199887010673919'
const noteId = '6afed50c000000002b0044c7'
const note = `https://www.xiaohongshu.com/explore/${noteId}`
const work = `https://www.iesdouyin.com/share/slides/${awemeId}`
const short = 'https://xhslink.cn/o/abc'
const redirect = location => new Response(null, { status: 302, headers: { location } })
const noRequests = async () => { throw new Error('unexpected outbound fetch') }
const local = (text, platform) => resolveShareLinks({ text, platform }, { fetchImpl: noRequests })

test('extracts mixed pasted text in order, retaining exact string IDs and query values', async () => {
  const text = `作品“${work}”。另一个:「www.xiaohongshu.com/explore/${noteId}?from=share;xsec_token=Ab+c%2Fd==」 重复 ${work}`
  const { results, total, succeeded, failed } = await local(text)
  assert.deepEqual([total, succeeded, failed], [2, 2, 0])
  assert.deepEqual(results.map(r => [r.platform, r.type, r.postId, r.how]), [
    ['douyin', 'slides', awemeId, 'direct'], ['xiaohongshu', 'note', noteId, 'direct'],
  ])
  assert.equal(results[0].aweme_id, awemeId)
  assert.equal(results[1].note_id, noteId)
  assert.equal(results[1].xsec_token, 'Ab+c/d==')
  const activity = encodeURIComponent('{"social_author_id":9876543210123456789}')
  const [video] = (await local(`中文:https://douyin.com/video/${awemeId}?activity_info=${activity}`)).results
  assert.equal(video.author_uid, '9876543210123456789')
})

test('allows same-platform HTTPS short links and stops before fetching the long link', async () => {
  const called = []
  const fetchImpl = async (url, options) => {
    called.push(url)
    assert.equal(options.redirect, 'manual')
    assert.ok(options.signal instanceof AbortSignal)
    return redirect(called.length === 1 ? '/o/second' : note)
  }
  const result = await resolveShareLinks({ text: 'http://xhslink.cn/o/abc?xsec_token=abc==' }, { fetchImpl })
  assert.deepEqual(called, [short + '?xsec_token=abc==', 'https://xhslink.cn/o/second'])
  assert.equal(result.results[0].how, 'redirect')
  assert.equal(result.results[0].xsec_token, 'abc==')
  assert.equal(result.results[0].postId, noteId)
})

test('resolves the actual pasted Markdown destination once, ignoring URLs in visible labels', async () => {
  const example = '[https://xhslink.cn/o/3EUFAcQijZe](https://xhslink.cn/o/3EUFAcQijZe)'
  const douyin = 'https://v.douyin.com/7h9Ip7hjLRY/'
  const xhs = 'https://xhslink.cn/o/3EUFAcQijZe'
  const calls = []
  const result = await resolveShareLinks({ text: `${example} [${xhs}](<${douyin}> "地址") ${example}` }, {
    fetchImpl: async url => {
      calls.push(url)
      if (url === xhs) return redirect('https://www.xiaohongshu.com/discovery/item/6afedd3200000000260272af')
      if (url === douyin) return redirect('https://www.iesdouyin.com/share/note/7711088087472025201/')
      throw new Error('unexpected short URL')
    },
  })
  assert.deepEqual(calls, [xhs, douyin])
  assert.deepEqual(result.results.map(row => row.postId), ['6afedd3200000000260272af', '7711088087472025201'])
  assert.deepEqual((await local(`[${work}](https://other.example/path)`)).results, [])
  assert.deepEqual((await local(`[${work}](/xhslink.cn/o/abc)`)).results, [])
})

test('resolves login redirectPath only on the official Xiaohongshu page', async () => {
  const target = encodeURIComponent('/discovery/item/' + noteId + '?xsec_token=ab%2B%3D')
  const [row] = (await local('https://www.xiaohongshu.com/login?redirectPath=' + target)).results
  assert.equal(row.note_id, noteId)
  assert.equal(row.xsec_token, 'ab+=')
  const [bad] = (await local('https://www.xiaohongshu.com/login?redirectPath=' + encodeURIComponent('https://other.example/explore/' + noteId))).results
  assert.equal(bad.code, 'unrecognized_link')
})

test('ignores other hosts, fake domains, credentials, ports and URLs embedded in unrelated links', async () => {
  const inputs = [
    'https://notdouyin.com/video/' + awemeId, 'fakexhslink.cn/o/abc', 'www.xiaohongshu.com.invalid/explore/' + noteId,
    'https://invalid.example/?u=' + work, 'https://invalid.example/xyz/' + short, 'https://name@xhslink.cn/o/abc',
    'https://xhslink.cn:1999/o/abc', 'ftp://xhslink.cn/o/abc', 'unknown.xiaohongshu.com/explore/' + noteId,
    'https://xhslink.cn。别处.example/o/abc', 'https://xhslink.cn假域名/o/abc', 'https://ｘｈｓｌｉｎｋ.cn/o/abc',
    '伪域名．xhslink.cn/o/abc', '用户xhslink.cn/o/abc', 'https://其他.example/?nested=' + short,
  ]
  assert.deepEqual((await local(inputs.join(' '))).results, [])
})

test('rejects cross-platform, external, credentialed and malformed redirect targets without a second fetch', async () => {
  for (const target of ['https://127.0.0.1/', work, '//www.xiaohongshu.com.invalid/test',
    'https://user@xhslink.cn/o/stolen', 'http://xhslink.cn:8443/test', 'https://', 'file:///tmp/file',
    'https://' + encodeURIComponent('ｘｈｓｌｉｎｋ') + '.cn/o/stolen']) {
    let calls = 0
    const fetchImpl = async () => { calls++; return redirect(target) }
    const [row] = (await resolveShareLinks({ text: short }, { fetchImpl })).results
    assert.equal(calls, 1)
    assert.equal(row.code, 'invalid_redirect')
    assert.ok(!row.error.includes(target))
  }
})

test('bounds redirect depth, detects cycles and preserves other rows when a short link fails', async () => {
  let calls = 0
  const fetchImpl = async () => redirect('/o/link' + ++calls)
  const result = await resolveShareLinks({ text: short + ' ' + work }, { fetchImpl })
  assert.equal(calls, 5)
  assert.equal(result.results[0].code, 'redirect_limit')
  assert.equal(result.results[1].postId, awemeId)
  assert.deepEqual([result.succeeded, result.failed], [1, 1])
  const cycle = await resolveShareLinks({ text: short }, { fetchImpl: async () => redirect(short) })
  assert.equal(cycle.results[0].code, 'redirect_limit')
  const aborted = await resolveShareLinks({ text: short }, { signal: AbortSignal.abort(), fetchImpl: noRequests })
  assert.equal(aborted.results[0].code, 'resolution_timeout')
})

test('classifies non-posts, pure Douyin share codes, mismatches and unknown paths without a fetch', async () => {
  const text = [
    'https://www.douyin.com/user/a-profile', 'https://www.iesdouyin.com/share/music/1234',
    'https://www.xiaohongshu.com/user/profile/' + noteId, 'https://www.douyin.com/video/' + awemeId + '0123456789',
    note + 'bad', 'https://xhslink.cn/api/admin/remove',
  ].join(' ')
  assert.deepEqual((await local(text)).results.map(r => r.code), [
    'not_a_post', 'not_a_post', 'not_a_post', 'unrecognized_link', 'unrecognized_link', 'unrecognized_link',
  ])
  assert.equal((await local('抖音 纯口令')).results[0].type, 'share_code')
  assert.deepEqual((await local('一段话，没有链接')).results, [])
  assert.equal((await local(short, 'douyin')).results[0].code, 'platform_mismatch')
})

test('bounded HTML fallback uses declared page identity only and flags uncertainty', async () => {
  const parse = async html => (await resolveShareLinks({ text: short }, {
    fetchImpl: async () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  })).results[0]
  const found = await parse(`<head><meta content="${note}?xsec_token=abc==&amp;from=share" property="og:url"></head>`)
  assert.equal(found.postId, noteId)
  assert.equal(found.xsec_token, 'abc==')
  assert.equal(found.uncertain, true)
  assert.equal(found.how, 'body-scan')
  for (const html of [noteId, `<a href="${note}">推荐</a>`, `<script>'<link rel="canonical" href="${note}">'</script>`,
    `<link rel="canonical" href="${note}"><meta property="og:url" content="${note.replace(noteId, 'a'.repeat(24))}">`]) {
    assert.equal((await parse(html)).code, 'unrecognized_link')
  }
  assert.equal((await parse(' '.repeat(256 * 1024 + 1))).code, 'response_too_large')
})

test('rejects invalid text, platform and oversized batches before any network request', async () => {
  const input = { text: '  ' + short + '  ' }
  assert.deepEqual(normalizeShareLinkInput(input), { text: short, platform: 'auto' })
  assert.equal(input.text, '  ' + short + '  ')
  await assert.rejects(resolveShareLinks([]), { status: 400, code: 'invalid_request' })
  await assert.rejects(resolveShareLinks({ text: short, fetchUrl: short }), { status: 400, code: 'unsupported_fields' })
  for (const text of [null, {}, 17, ' ', 'a'.repeat(SHARE_LINK_LIMITS.maxTextLength + 1)]) {
    await assert.rejects(local(text), { status: 400, code: 'invalid_share_text' })
  }
  await assert.rejects(local('abc', 'all'), { status: 400, code: 'invalid_platform' })
  const text = Array.from({ length: SHARE_LINK_LIMITS.maxLinks + 1 }, (_, i) => short + i).join(' ')
  assert.throws(() => normalizeShareLinkInput({ text }), { status: 400, code: 'too_many_share_links' })
  await assert.rejects(local(text), { status: 400, code: 'too_many_share_links' })
})
