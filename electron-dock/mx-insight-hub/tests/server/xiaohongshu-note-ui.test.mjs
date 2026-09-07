import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Xiaohongshu note gallery uses the governed concurrent relay and stable failure placeholders', async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL('../../src/pages-xiaohongshu-note.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles.css', import.meta.url), 'utf8'),
  ])

  assert.match(page, /\.slice\(0, 20\)/u)
  assert.match(page, /media\.map\(\(_, mediaIndex\) =>/u)
  assert.match(page, /productMediaLoader\.load\([\s\S]*?publicDataApi\.socialPostImage/u)
  assert.match(page, /onError=\{\(\) => \{[\s\S]*?URL\.revokeObjectURL\(source\)[\s\S]*?setFailed\(true\)/u)
  assert.match(page, /alt="历史笔记封面" showPlaceholder/u)
  assert.match(styles, /\.mih-xhs-history \.mih-xhs-image-placeholder \{[^}]*width: 48px;[^}]*height: 48px;/u)
  assert.doesNotMatch(page, /<img[^>]+src=\{(?:entry|item)\.?.*?\.url\}/u)
})
