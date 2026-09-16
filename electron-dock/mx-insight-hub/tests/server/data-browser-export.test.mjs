import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBrowserExport } from '../../server/data/browser-export.mjs'

const result = { items: [{ title: '=HYPERLINK("bad")', body: '完整正文\n第二行,包含逗号', stable_fields: { metrics: { likes: 0 } } }], hasMore: true, evidence: { computedAt: '2026-09-16T00:00:00.000Z' } }
test('CSV preserves multiline business fields and prevents formula execution', () => {
  const output = formatBrowserExport(result, 'csv', { view: 'contents', objectType: 'post' })
  assert.ok(output.content.startsWith('\ufeff'))
  assert.ok(output.content.includes("'="))
  assert.ok(output.content.includes('完整正文\n第二行,包含逗号'))
  assert.equal(output.truncated, true)
  assert.equal(output.exportedRows, 1)
})
test('JSON includes exact business text and applied-filter/snapshot evidence', () => {
  const output = formatBrowserExport(result, 'json', { view: 'contents', contentType: 'video' })
  const parsed = JSON.parse(output.content)
  assert.equal(parsed.items[0].title, result.items[0].title)
  assert.equal(parsed.metadata.filters.contentType, 'video')
  assert.equal(parsed.metadata.truncated, true)
})
test('oversized export fails explicitly instead of generating a silently truncated file', () => {
  assert.throws(() => formatBrowserExport({ ...result, items: [{ body: 'a'.repeat(17 * 1024 * 1024) }] }, 'json', { view: 'contents' }), { code: 'data_browser_export_too_large' })
})
