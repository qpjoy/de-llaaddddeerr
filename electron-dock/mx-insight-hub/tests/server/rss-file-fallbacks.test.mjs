import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectFeedFiles } from '../../server/ops/diagnose-rss-file-fallbacks.mjs'

test('file inventory uses the actual producer paths and never reports contents or URLs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rss-files-')); t.after(() => rm(root, { recursive: true }))
  await mkdir(join(root, 'data'))
  await writeFile(join(root, 'data/rss-results.json'), JSON.stringify({ feeds: {
    privateFeed: { items: [{ title: 'private body', link: 'https://private.invalid?token=secret' }] },
  } }))
  await writeFile(join(root, 'data/rss-config.json'), JSON.stringify({ feeds: [{ id: 'privateFeed', url: 'https://private.invalid' }] }))
  const result = await inspectFeedFiles(root)
  assert.equal(result.status, 'observed')
  assert.equal(result.files.rss.feeds, 1)
  assert.equal(result.files.rss.items, 1)
  assert.equal(result.files['rss-config'].feeds, 1)
  assert.equal(result.files.news.state, 'absent')
  assert.doesNotMatch(JSON.stringify(result), /private|secret/)
  await writeFile(join(root, 'data/news-results.json'), '{')
  assert.equal((await inspectFeedFiles(root)).status, 'incomplete')
})
