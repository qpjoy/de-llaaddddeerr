import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWeiboDetail, weiboRow } from '../../server/contracts/raw-search.mjs'

const capturedAt = '2026-10-08T13:02:09.696Z'
const postId = '5350067051698112', authorId = '7742161132'

// Production excerpts supplied by the operator; suffixes are synthetic fixtures,
// not a reconstruction of either full production post.
const cases = [
  { preview: 'whzy超话统一给大家说一下，一开始上午都是很温馨的，好多屋子好多告示牌应援，几百个祝福哲噶的 展开c',
    full: '#whzy[超话]#统一给大家说一下，一开始上午都是很温馨的，好多屋子好多告示牌应援，几百个祝福哲噶的牌子。这里是测试用完整后文。',
    rendered: 'whzy超话统一给大家说一下，一开始上午都是很温馨的，好多屋子好多告示牌应援，几百个祝福哲噶的牌子。', long: true },
  { preview: '牛逼牛逼到现在一直都是大比分输给对面剃了个光头滚回去牛逼牛逼cn其他队好歹还能黏而…',
    full: '牛逼牛逼[笑cry][笑cry]到现在一直都是大比分输给对面剃了个光头滚回去[打call][打call]牛逼牛逼cn其他队好歹还能黏而这里是测试用完整后文。',
    rendered: '牛逼牛逼到现在一直都是大比分输给对面剃了个光头滚回去牛逼牛逼cn其他队好歹还能黏而…', long: false },
]

function fixtures(sample, overrides = {}) {
  const row = weiboRow({ weibo_id: postId, user_id: authorId, content: sample.preview }, capturedAt)
  const raw = { idstr: postId, user: { idstr: authorId }, isLongText: sample.long,
    text: sample.rendered, text_raw: sample.full, ...(sample.long ? { longText: { content: sample.full } } : {}), ...overrides }
  return { row, result: { publicBody: { data: raw, meta: { capturedAt } } } }
}

test('observed supertopic and emotion representations match without changing the delivered full text', () => {
  for (const sample of cases) {
    const { row, result } = fixtures(sample)
    const before = structuredClone(result)
    assert.equal(mergeWeiboDetail(row, result), true)
    assert.equal(row.text, sample.full)
    assert.equal(row.full_text, sample.full)
    assert.equal(row.content, sample.full)
    assert.equal(row.title, '')
    assert.equal(row.body_completeness, 'full_text')
    assert.deepEqual(result, before)
  }
})

test('display equivalence cannot bypass identity, meaningful text, length or truncation checks', () => {
  for (const overrides of [
    { idstr: '999' }, { user: { idstr: '999' } },
    { text_raw: '不同的正文'.repeat(30) },
    { text_raw: '[未知的实质内容]' + cases[1].full },
    { text_raw: cases[1].full + ' 展开c' },
    { text_raw: '很短' },
  ]) {
    const { row, result } = fixtures(cases[1], overrides)
    const before = structuredClone(row)
    assert.equal(mergeWeiboDetail(row, result), false)
    assert.deepEqual(row, before)
  }
  const { row, result } = fixtures({ preview: '[笑cry] 展开c', full: '[打call]测试正文', rendered: '', long: false })
  assert.equal(mergeWeiboDetail(row, result), false) // A comparison that erases the whole prefix proves nothing.
})
