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
  assert.match(page, /const \[apiKey\] = useDemoApiKey\(\)/u)
  assert.doesNotMatch(page, /(?:localStorage|sessionStorage)\.setItem\([^\n]*apiKey/iu)
  // This page lives in the admin console (route capability `apikey.read`; the
  // public listener serves no SPA), so it may name the vendor the way the
  // External Data Platforms page already does -- an operator triaging a
  // degraded product needs to know which vendor to look at. What must stay
  // provider-neutral is the tenant-facing contract: the request body carries no
  // provider selector, and the public docs never name one. Both are asserted
  // elsewhere; `public-docs.test.mjs` guards the documentation shell.
  assert.doesNotMatch(page, /provider['"]?\s*[:=]|marketplace: *'tikhub'/u)
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

test('the gallery reports per-call consumption from the reason, not from sourceMode', async () => {
  const [page, api] = await Promise.all([
    readFile(new URL('../../src/pages-xiaohongshu-note.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
  ])

  // The API layer must surface the reason at all, including on a rejection,
  // where it is the only explanation the caller gets.
  assert.match(api, /reason: payload\?\.meta\?\.reason/u)
  assert.match(api, /x-mx-insight-reason/u)
  assert.match(api, /this\.reason = reason \|\| details\?\.reason \|\| null/u)

  // Upstream consumption is read from liveAttempted. Inferring it from
  // sourceMode cannot distinguish a fallback taken before dispatch (nothing
  // spent) from one taken after an upstream failure (already spent).
  assert.match(page, /reason\?\.liveAttempted === true/u)
  assert.match(page, /reason\?\.liveAttempted === false/u)
  assert.match(page, /<dt>上游调用<\/dt>/u)
  assert.match(page, /<dt>Hub 用量<\/dt>/u)

  // A replay returns an already-committed result, so it is the one delivery
  // that creates no new Hub usage either.
  assert.match(page, /idempotent_replay' \? '否 · 重放已提交结果'/u)

  // The evidence panel must render for failures too, or a blocked request
  // would show no explanation at all.
  assert.match(page, /<DeliveryEvidence evidence=\{result\?\.evidence\} error=\{error\}/u)
  assert.match(page, /reason\?\.detail\?\.blockers/u)

  // Every delivery mode the contract accepts is offered.
  for (const mode of ['cache_only', 'cache_first', 'refresh', 'live_only']) {
    assert.match(page, new RegExp(`value: '${mode}'`, 'u'), `${mode} must be selectable`)
  }
})
