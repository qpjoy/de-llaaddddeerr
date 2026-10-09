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
  // Request 7316edc1: observed mismatches are [兔子] and [哈哈]. Only
  // operator-provided excerpts are real; the continuation is deliberately synthetic.
  { preview: 'Q：有什么想对队友们说的？Leaf：持续递东西Jawgemo：我超爱这些家伙的。展开c',
    full: 'Q：有什么想对队友们说的？Leaf：持续递东西[兔子]Jawgemo：我超爱这些家伙的。这是测试用完整后文。',
    rendered: 'Q：有什么想对队友们说的？Leaf：持续递东西Jawgemo：我超爱这些家伙的。这是测试用完整后文。', long: true },
  { preview: '到教练！你们可以用自己的语言回答我们看到今天VIT输掉了很多eco局，展开c',
    full: '到教练！你们可以用自己的语言回答[哈哈]我们看到今天VIT输掉了很多eco局，这是测试用完整后文。',
    rendered: '到教练！你们可以用自己的语言回答我们看到今天VIT输掉了很多eco局，这是测试用完整后文。', long: true },
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
    assert.equal(row.summary, sample.preview)
    assert.equal(row.text, sample.full)
    assert.equal(row.full_text, sample.full)
    assert.equal(row.content, sample.full)
    assert.equal(row.title, '')
    assert.equal(row.body_completeness, 'full_text')
    assert.deepEqual(result, before)
  }
})

test('identity and explicit completeness checks reject unusable details without changing summaries', () => {
  for (const overrides of [
    { idstr: '999' }, { user: { idstr: '999' } }, { user: {} },
    { text_raw: cases[1].full + ' 展开c' }, { text_raw: '' },
    { isLongText: true }, { isLongText: undefined }, { deleted: 1 },
  ]) {
    const { row, result } = fixtures(cases[1], overrides)
    const before = structuredClone(row)
    assert.equal(mergeWeiboDetail(row, result), false)
    assert.deepEqual(row, before)
  }
})

test('complete details accept edits, arbitrary emotion labels and natural ellipsis regardless of length/prefix', () => {
  for (const full of ['编辑后的短文', cases[1].preview.replace('…', '。'),
    '[未知的新表情]' + cases[1].full, '到这里结束…']) {
    const { row, result } = fixtures(cases[1], { text_raw: full })
    assert.equal(mergeWeiboDetail(row, result), true)
    assert.equal(row.summary, cases[1].preview)
    assert.equal(row.full_text, full)
    assert.equal(row.body_provenance.fullText.field, 'text_raw')
    assert.equal(row.body_provenance.fullText.source, 'detail')
    assert.equal(row.body_provenance.policy, 'weibo-detail-identity.v1')
  }
  const { row, result } = fixtures(cases[1], { text_raw: cases[1].preview })
  assert.equal(mergeWeiboDetail(row, result), true, 'explicit isLongText=false makes literal ellipsis content')
})

test('rendered HTML or missing long text cannot stand in for an explicit complete field', () => {
  const { row, result } = fixtures(cases[0], { longText: null, text_raw: '未完整的短文', text: cases[0].full })
  assert.equal(mergeWeiboDetail(row, result), false)
  assert.equal(row.full_text, null)
  assert.equal(row.text, row.summary)
})
