import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson, normalizeSearchPayload, sha256 } from '../../server/ingest/normalizers.mjs'
import { normalizeNightAllLegacyPayload } from '../../server/ingest/legacy-night-all.mjs'
import { refreshMappedPayloadSha256 } from '../../server/ingest/external/mapping.mjs'

const externalId = '2087779969447686278'
const body = '原文第一行\n第二行 ' + '完整正文'.repeat(100)
const generatedTitle = `twitter ${body.replace(/\s+/g, ' ')}`.slice(0, 120)

test('Twitter data-search normalization clears legacy titles without mutating source evidence', () => {
  for (const title of [undefined, '', generatedTitle, body.slice(0, 80)]) {
    const item = { externalId, title, text: body, author: { id: '42', name: 'Alice' } }
    const original = structuredClone(item)
    const { records, skipped } = normalizeSearchPayload({ data: { items: [item] } }, 'twitter')
    assert.equal(skipped, 0)
    assert.equal(records.length, 1)
    assert.equal(records[0].title, null)
    assert.equal(records[0].body, body)
    assert.equal(records[0].externalId, externalId)
    assert.equal(records[0].authorName, 'Alice')
    assert.equal(records[0].contentType, 'tweet')
    assert.deepEqual(records[0].rawItem, original)
    assert.deepEqual(item, original)
  }
})

test('Twitter legacy content leaves title empty while profiles and archived envelopes remain intact', () => {
  const raw = { content_id: externalId, title: generatedTitle, name: generatedTitle,
    full_text: body, author_id: '42', user_name: 'Alice',
    image_urls: '["https://example.test/image.jpg"]', published_at: 1785715200 }
  const payload = { data: { raw_data: JSON.stringify([raw]),
    raw_info: JSON.stringify([{ user_id: '42', name: 'Alice', user_name: 'alice' }]) } }
  const original = structuredClone(payload)
  for (const operation of ['raw', 'crawl', 'user-info']) {
    const { records, skipped } = normalizeNightAllLegacyPayload(payload, 'twitter', operation)
    const content = records.find(record => record.objectType === 'post')
    const profile = records.find(record => record.objectType === 'profile')
    assert.equal(skipped, 0)
    assert.equal(records.length, 2)
    assert.equal(content.title, null)
    assert.equal(content.body, body)
    assert.equal(content.externalId, externalId)
    assert.equal(content.authorName, 'Alice')
    assert.deepEqual(content.stableFields.media.images, ['https://example.test/image.jpg'])
    assert.deepEqual(content.rawItem, raw)
    // Account labels are independent from the title of a tweet.
    assert.equal(profile.title, 'alice')
    assert.equal(profile.authorName, 'alice')
    const hashInput = structuredClone(content)
    delete hashInput.payloadSha256
    assert.equal(refreshMappedPayloadSha256(hashInput).payloadSha256, content.payloadSha256)
  }
  assert.deepEqual(payload, original)
})

test('Twitter media-only posts remain ingestible without a fabricated title', () => {
  const payload = { data: { raw_info: '[]', raw_data: JSON.stringify([
    { content_id: externalId, image_urls: '["https://example.test/image.jpg"]' }
  ]) } }
  const { records, skipped } = normalizeNightAllLegacyPayload(payload, 'twitter', 'raw')
  assert.equal(skipped, 0)
  assert.equal(records.length, 1)
  assert.equal(records[0].title, null)
  assert.equal(records[0].body, null)
  assert.equal(records[0].stableFields.media.images.length, 1)
})

test('Twitter title correction changes the old digest once and stays stable on subsequent sightings', () => {
  const item = { externalId, title: generatedTitle, text: body }
  const normalize = value => normalizeSearchPayload({ data: { items: [value] } }, 'twitter').records[0]
  const first = normalize(item)
  assert.notEqual(first.payloadSha256, sha256(canonicalJson(item)))
  assert.equal(first.payloadSha256, normalize({ ...item }).payloadSha256)
  assert.equal(first.payloadSha256, normalize({ ...item, collectedAt: '2026-09-21T00:00:00Z', metrics: { likes: 10 } }).payloadSha256)
  assert.notEqual(first.payloadSha256, normalize({ ...item, text: 'edited body' }).payloadSha256)
})

test('other platforms retain existing title and name fallback behavior', () => {
  for (const platform of ['xiaohongshu', 'douyin', 'weibo', 'facebook', 'reddit']) {
    const row = { externalId: 'post-1', title: '原生标题', text: body }
    const search = normalizeSearchPayload({ data: { items: [row] } }, platform)
    assert.equal(search.records[0].title, '原生标题', platform)
    assert.equal(search.records[0].payloadSha256, sha256(canonicalJson(row)), platform)
    for (const title of ['', '原生标题']) {
      const payload = { data: { raw_info: '[]', raw_data: JSON.stringify([
        { content_id: 'post-1', title, name: 'existing name fallback', full_text: body }
      ]) } }
      const { records } = normalizeNightAllLegacyPayload(payload, platform, 'raw')
      assert.equal(records[0].title, title || 'existing name fallback', platform)
      assert.equal(records[0].body, body, platform)
    }
  }
})
