import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Xiaohongshu note gallery uses the governed concurrent relay and stable failure placeholders', async () => {
  const [page, styles, api] = await Promise.all([
    readFile(new URL('../../src/pages-xiaohongshu-note.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
  ])

  assert.match(page, /\.slice\(0, 20\)/u)
  assert.match(page, /media\.map\(\(_, mediaIndex\) =>/u)
  assert.match(page, /productMediaLoader\.load\([\s\S]*?publicDataApi\.socialPostImage/u)
  assert.match(page, /onError=\{\(\) => \{[\s\S]*?URL\.revokeObjectURL\(source\)[\s\S]*?setFailed\(true\)/u)
  assert.match(page, /alt="历史笔记封面" showPlaceholder/u)
  assert.match(styles, /\.mih-xhs-history \.mih-xhs-image-placeholder \{[^}]*width: 48px;[^}]*height: 48px;/u)
  assert.doesNotMatch(page, /<img[^>]+src=\{(?:entry|item)\.?.*?\.url\}/u)
  const xiaohongshuRequest = api.match(/xiaohongshuNote:[\s\S]*?\n  \),/u)?.[0] || ''
  assert.match(xiaohongshuRequest, /'\/api\/v1\/xiaohongshu\/app\/get_note_info'/u)
  assert.match(xiaohongshuRequest, /\{ method: 'POST', body, idempotencyKey, retryOfRequestId, signal \}/u)
  assert.doesNotMatch(xiaohongshuRequest, /queryString|share_text|delivery_mode/u)
  assert.match(page, /POST \/api\/v1\/xiaohongshu\/app\/get_note_info/u)
  assert.match(page, /publicDocsHref\('\/docs\/xiaohongshu-note#xiaohongshu-note'\)/u)
  assert.match(page, /签发 \/ 轮换 API Key/u)
  assert.match(page, /查看开放能力/u)
  assert.match(page, /const \[apiKey, setApiKey\] = useState\(''\)/u)
  assert.doesNotMatch(page, /(?:localStorage|sessionStorage)\.setItem\([^\n]*apiKey/iu)
  assert.doesNotMatch(page, /tikhub|TikHub/iu)
  assert.doesNotMatch(page, /<select\b/iu)
  assert.match(page, /<DropdownField[\s\S]*?label="交付策略"[\s\S]*?options=\{DELIVERY_OPTIONS\}/u)
})

test('Xiaohongshu note body renders text beyond 60 characters without a UI clamp', async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL('../../src/pages-xiaohongshu-note.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles.css', import.meta.url), 'utf8'),
  ])

  assert.match(page, /<p className="mih-xhs-body">\{item\.text \|\|/u)
  assert.doesNotMatch(page, /item\.text\s*\.(?:slice|substring)\(/u)
  const bodyRule = styles.match(/\.mih-xhs-body \{[^}]+\}/u)?.[0] || ''
  assert.match(bodyRule, /white-space:\s*pre-wrap/u)
  assert.doesNotMatch(bodyRule, /line-clamp|max-height|overflow:\s*hidden|text-overflow/u)
})
