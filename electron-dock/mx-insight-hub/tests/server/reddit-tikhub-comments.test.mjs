import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseTikHubRedditCommentPage } from '../../server/contracts/reddit-comment-page.mjs'

const postId = 't3_post123'
function tree(index, changes = {}) {
  return { childCount: 0, depth: 0, more: null, parentId: null,
    node: { __typename: 'Comment', id: `t1_c${index}`, authorInfo: { id: `t2_user${index}`, name: `Author ${index}`,
      iconSmall: { url: `https://example.invalid/avatar${index}.png` } },
      content: { markdown: `  Full comment ${index}\n第二行😀  `, unreviewedMedia: [{ arbitrary: 'preserved raw' }] },
      createdAt: '2026-01-10T15:21:49.595000+0000', score: index - 2, isScoreHidden: false, isRemoved: false,
      permalink: `/r/test/comments/post123/title/c${index}/` }, ...changes }
}
function payload(trees = [tree(1), tree(2), tree(3)], pageInfo = { commentCount: 3, hasNextPage: false }) {
  return { code: 200, requestEcho: { after: 'never-a-next-cursor' }, data: { postInfoById: { id: postId,
    commentForest: { pageInfo, trees } } } }
}
const parse = value => parseTikHubRedditCommentPage(value, postId)
const bad = value => assert.throws(() => parse(value), { code: 'invalid_upstream_contract' })

test('paid terminal shape maps every full comment without turning score into likes or guessing parents', () => {
  const source = payload(), before = structuredClone(source), result = parse(source)
  assert.equal(result.comments.length, 3)
  assert.deepEqual(result.providerPage, { hasMore: false, nextParams: null, nextPage: null })
  for (const [index, comment] of result.comments.entries()) {
    const expected = source.data.postInfoById.commentForest.trees[index], value = comment.values
    assert.equal(value.commentId, expected.node.id)
    assert.equal(value.text, expected.node.content.markdown)
    assert.equal(value.publishedAt, '2026-01-10T15:21:49.595Z')
    assert.equal(value.author.id, expected.node.authorInfo.id)
    assert.equal(value.author.avatarUrl, expected.node.authorInfo.iconSmall.url)
    assert.equal(value.likes, null)
    assert.equal(value.metrics.score, expected.node.score)
    assert.equal(value.parentExternalId, null)
    assert.equal(value.parentCommentId, null)
    assert.equal(value.parentRelationship, 'unknown')
    assert.deepEqual(comment.raw, expected)
  }
  assert.deepEqual(source, before)
})

test('post matching accepts t3 aliases while comment identities retain the t1 namespace', () => {
  const source = payload([tree(1)])
  source.data.postInfoById.id = 'post123'
  source.data.postInfoById.commentForest.trees[0].node.id = 'c1'
  assert.equal(parseTikHubRedditCommentPage(source, 'post123').comments[0].values.commentId, 't1_c1')
  source.data.postInfoById.id = 't3_other'
  bad(source)
  for (const value of [123, '', 't1_post123', 't3_a-b']) assert.throws(() => parseTikHubRedditCommentPage(payload(), value), { code: 'invalid_upstream_contract' })
})

test('root context is excluded and same base36 suffix in the comment namespace is allowed', () => {
  const root = tree(1, { node: { __typename: 'Post', id: postId } })
  const comment = tree(2); comment.node.id = 't1_post123'; comment.node.permalink = '/r/test/comments/post123/title/post123/'
  const result = parse(payload([root, comment]))
  assert.deepEqual(result.comments.map(row => row.values.commentId), ['t1_post123'])
})

test('explicit parent IDs distinguish root and comment replies; invalid roots and self-parent fail', () => {
  const rootReply = tree(1, { parentId: postId, childCount: 1 })
  const nested = tree(2, { parentId: 't1_c1', depth: 1 })
  const result = parse(payload([rootReply, nested]))
  assert.equal(result.comments[0].values.parentRelationship, 'post')
  assert.equal(result.comments[0].values.parentExternalId, postId)
  assert.equal(result.comments[0].values.parentCommentId, null)
  assert.equal(result.comments[1].values.parentRelationship, 'comment')
  assert.equal(result.comments[1].values.parentCommentId, 't1_c1')
  assert.equal(result.providerPage.hasMore, false)
  for (const parentId of ['t3_other', 't1_c1', 'unknown bare parent']) bad(payload([tree(1, { parentId })]))
})

test('negative scores are preserved, hidden scores become null and invalid score types fail', () => {
  const first = tree(1); first.node.score = -9
  assert.equal(parse(payload([first])).comments[0].values.metrics.score, -9)
  first.node.isScoreHidden = true
  assert.equal(parse(payload([first])).comments[0].values.metrics.score, null)
  for (const score of ['12', false, 0.5, Number.MAX_SAFE_INTEGER + 1]) { first.node.score = score; bad(payload([first])) }
})

test('deleted null fields fail closed instead of inventing a body or author; intact removed rows survive', () => {
  const source = tree(1); source.node.isRemoved = true
  assert.equal(parse(payload([source])).comments[0].values.isRemoved, true)
  const noText = structuredClone(source); noText.node.content.markdown = null; bad(payload([noText]))
  const noAuthor = structuredClone(source); noAuthor.node.authorInfo = null; bad(payload([noAuthor]))
  const noTime = structuredClone(source); noTime.node.createdAt = null; bad(payload([noTime]))
})

test('every row is checked, including a bad final row beyond the inspector sample limit', () => {
  const rows = Array.from({ length: 12 }, (_, index) => tree(index + 1))
  rows.at(-1).node.createdAt = 'invalid'
  bad(payload(rows))
  rows.at(-1).node.createdAt = '2026-11-02T00:00:00Z'
  rows.at(-1).node.__typename = 'Unknown'
  bad(payload(rows))
})

test('explicit terminal pagination requires no outstanding more or unreturned children', () => {
  const placeholder = { node: null, more: { cursor: 'reply-cursor' }, parentId: 't1_c1', depth: 1, childCount: 2 }
  for (const rows of [[tree(1), placeholder], [tree(1, { childCount: 1 })],
    [tree(1, { unreviewedBranch: { children: [{ more: { cursor: 'nested-reply' } }] } })]]) {
    const result = parse(payload(rows))
    assert.equal(result.comments.length, 1)
    assert.deepEqual(result.providerPage, { hasMore: null, nextParams: null, nextPage: null, stopReason: 'continuation_unproven' })
  }
  assert.deepEqual(parse(payload([], { hasNextPage: false })).providerPage,
    { hasMore: false, nextParams: null, nextPage: null })
  const child = tree(2, { parentId: 't1_c1', depth: 1 })
  assert.equal(parse(payload([tree(1, { childCount: 2 }), child, structuredClone(child)])).providerPage.hasMore, null,
    'duplicate child rows cannot prove that all distinct children were returned')
})

test('unknown or positive pagination never forwards request echoes, reply cursors or guessed next tokens', () => {
  for (const info of [undefined, {}, { hasNextPage: true, after: 'guess', endCursor: 'guess' }]) {
    const source = payload([tree(1)]); source.data.postInfoById.commentForest.pageInfo = info
    const result = parseTikHubRedditCommentPage(source, postId, { after: 'never-a-next-cursor' })
    assert.equal(result.providerPage.hasMore, null)
    assert.equal(result.providerPage.nextParams, null)
    assert.equal(result.providerPage.stopReason, 'continuation_unproven')
  }
  const repeated = payload([tree(1), { node: null, more: { cursor: 'same' }, parentId: null, depth: 0, childCount: 1 }], { hasNextPage: true })
  assert.equal(parseTikHubRedditCommentPage(repeated, postId, { after: 'same' }).providerPage.nextParams, null)
})

test('unrelated or dangerous comment links fail; unknown media metadata remains only raw', () => {
  for (const permalink of ['https://evil.invalid/r/test/comments/post123/title/c1/',
    '/r/test/comments/other/title/c1/', '/r/test/comments/post123/title/c2/', 'javascript:alert(1)']) {
    const source = tree(1); source.node.permalink = permalink; bad(payload([source]))
  }
  const result = parse(payload([tree(1)])).comments[0]
  assert.equal(Object.hasOwn(result.values, 'media'), false)
  assert.deepEqual(result.raw.node.content.unreviewedMedia, [{ arbitrary: 'preserved raw' }])
})

test('invalid envelope, arrays and tree types are rejected with a fixed error', () => {
  for (const value of [null, {}, { ...payload(), code: 0 }, { code: 200, data: [] }]) bad(value)
  for (const value of [null, {}, Array.from({ length: 1001 }, () => tree(1))]) {
    const source = payload(); source.data.postInfoById.commentForest.trees = value; bad(source)
  }
  for (const value of [tree(1, { childCount: -1 }), tree(1, { depth: '0' }), tree(1, { more: 'opaque' }), { node: null }]) bad(payload([value]))
  bad(payload([], { hasNextPage: 'false' }))
})

test('failed saved-archive checks expose only fixed diagnostic reasons', () => {
  const source = payload(); source.data.postInfoById.id = 't3_private'
  assert.throws(() => parse(source), error => error.code === 'invalid_upstream_contract'
    && error.reason === 'root_id_mismatch' && !error.message.includes('private'))
  const row = tree(1); row.node.authorInfo.id = null
  assert.throws(() => parse(payload([row])), { reason: 'author_identity' })
  let nested = {}, root = nested
  for (let i = 0; i < 30; i++) nested = nested.next = {}
  assert.throws(() => parse(payload([tree(1, { metadata: root })])), { reason: 'structure_limit' })
})

test('parser remains standalone without imports for saved archive verification', async () => {
  const source = await readFile(new URL('../../server/contracts/reddit-comment-page.mjs', import.meta.url), 'utf8')
  assert.equal(/^\s*import\s/mu.test(source), false)
  const isolated = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  assert.deepEqual(isolated.parseTikHubRedditCommentPage(payload(), postId), parse(payload()))
})
