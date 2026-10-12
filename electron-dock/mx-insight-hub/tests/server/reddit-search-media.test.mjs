import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSearchContent, normalizeSearchMedia, REDDIT_MEDIA_POLICY } from '../../server/contracts/search-content.mjs'
import { normalizeSearchPayload, canonicalJson, sha256 } from '../../server/ingest/normalizers.mjs'
import { normalizeNightAllLegacyPayload } from '../../server/ingest/legacy-night-all.mjs'
import { refreshMappedPayloadSha256 } from '../../server/ingest/external/mapping.mjs'

// Retained record 1x2arsq: official preview and original share this asset.
// Signature is synthetic; the production signed URL is never saved here.
const PREVIEW = 'https://preview.redd.it/mk4i7zgtwluh1.png?width=140&height=140&crop=1%3A1%2Csmart&auto=webp&s=fixture-signature'
const ORIGINAL = 'https://i.redd.it/mk4i7zgtwluh1.png'
const PHOTO = 'https://i.redd.it/anotherasset.jpg'
const TITLE = "[X] Those people behind him couldn't pour water out of a boot if the instructions were on the heel."
const BODY = '[https://x.com/Acyn/status/2108728878625865794](https://x.com/Acyn/status/2108728878625865794)'
const media = { images: [PREVIEW, ORIGINAL], coverUrl: PREVIEW, videos: [] }
const modernItem = overrides => ({ id: 'reddit:1x2arsq', externalId: '1x2arsq', platform: 'reddit', contentType: 'post',
  title: TITLE, text: BODY, author: { id: 't2_15nmkah', name: 'c-k-q99903' },
  publishedAt: '2026-10-10T09:14:52Z', collectedAt: '2026-10-10T10:44:20Z', media: structuredClone(media), ...overrides })
const rawRow = overrides => ({ content_id: '1x2arsq', author_id: 't2_15nmkah', author_name: 'c-k-q99903',
  content_type: 'post', title: TITLE, full_text: BODY, image_urls: JSON.stringify(media.images),
  video_urls: '[]', cover_url: PREVIEW, ...overrides })

test('verified Reddit preview/original pair becomes one original image without inventing a video or removing the native title', () => {
  const source = { data: { items: [modernItem()], pageInfo: { hasMore: false } } }
  const before = structuredClone(source)
  const output = normalizeSearchContent(source, 'reddit')
  assert.deepEqual(output.data.items[0].media, { images: [ORIGINAL], coverUrl: ORIGINAL, videos: [] })
  assert.equal(output.data.items[0].title, TITLE)
  assert.equal(output.data.items[0].text, BODY)
  assert.deepEqual(output.data.pageInfo, source.data.pageInfo)
  assert.deepEqual(source, before)
  assert.deepEqual(normalizeSearchContent(output, 'reddit'), output)
})

test('raw strings, arrays, nested result rows and cover aliases preserve their field shapes', () => {
  const row = rawRow({ images: [{ url: PREVIEW, width: 140 }, { url: ORIGINAL, width: 900 }, PHOTO],
    coverUrl: PREVIEW, media: { images: [PREVIEW, ORIGINAL, PHOTO], cover_url: PREVIEW, videos: [] } })
  const source = { data: { raw_info: JSON.stringify([row]), raw_data: JSON.stringify([row]),
    results: [{ data: { raw_data: [row] } }, { items: [row] }] } }
  const before = structuredClone(source)
  const output = normalizeSearchContent(source, 'reddit', { format: 'raw' })
  for (const result of [JSON.parse(output.data.raw_data)[0], output.data.results[0].data.raw_data[0], output.data.results[1].items[0]]) {
    assert.equal(result.image_urls, JSON.stringify([ORIGINAL]))
    assert.deepEqual(result.images, [{ url: ORIGINAL, width: 900 }, PHOTO])
    assert.deepEqual(result.media, { images: [ORIGINAL, PHOTO], cover_url: ORIGINAL, videos: [] })
    assert.equal(result.cover_url, ORIGINAL)
    assert.equal(result.coverUrl, ORIGINAL)
    assert.equal(result.video_urls, '[]')
    assert.equal(result.title, TITLE)
    assert.equal(result.full_text, BODY)
  }
  assert.equal(output.data.raw_info, source.data.raw_info)
  assert.deepEqual(source, before)
  assert.deepEqual(normalizeSearchContent(output, 'reddit', { format: 'raw' }), output)
})

test('unknown assets, URL shapes, credentials and other platforms are not collapsed', () => {
  for (const [preview, original] of [
    [PREVIEW, PHOTO], [PREVIEW, ORIGINAL + '?token=private'], [PREVIEW, ORIGINAL + '#fragment'],
    [PREVIEW, ORIGINAL.replace('https:', 'http:')], [PREVIEW, ORIGINAL.replace('i.redd.it', 'i.redd.it:443')],
    [PREVIEW, ORIGINAL.replace('i.redd.it', 'user:password@i.redd.it')],
    [PREVIEW.replace('preview.redd.it', 'preview.redd.it.evil.test'), ORIGINAL],
    [PREVIEW.replace('preview.redd.it', 'user:password@preview.redd.it'), ORIGINAL],
    [PREVIEW.replace('preview.redd.it', 'preview.redd.it:443'), ORIGINAL],
    [PREVIEW + '#fragment', ORIGINAL], [PREVIEW + '\n', ORIGINAL], [PREVIEW, ORIGINAL + '\n'], [PREVIEW.replace('mk4', '%6dk4'), ORIGINAL],
    [PREVIEW.replace('/mk4', '/nested/../mk4'), ORIGINAL],
    [PREVIEW.replace('.png', '.jpg'), ORIGINAL], [PREVIEW.replace('mk4', 'MK4'), ORIGINAL],
  ]) {
    const source = { images: [preview, original], coverUrl: preview, videos: [] }
    assert.equal(normalizeSearchMedia(source, 'reddit'), source)
  }
  const previewOnly = { ...media, images: [PREVIEW, PREVIEW.replace('width=140', 'width=280')] }
  assert.equal(normalizeSearchMedia(previewOnly, 'reddit'), previewOnly)
  for (const platform of ['douyin', 'twitter', 'facebook', 'instagram', 'weibo']) assert.equal(normalizeSearchMedia(media, platform), media)
  assert.equal(normalizeSearchMedia(media, 'reddit', { objectType: 'profile' }), media)
  assert.equal(normalizeSearchMedia(media, 'reddit', { contentType: 'user' }), media)
})

test('original order and object metadata survive, with unrelated images and videos retained', () => {
  const original = { url: ORIGINAL, width: 900, height: 1200 }
  const source = { images: [PHOTO, original, PREVIEW], coverUrl: 'https://other.example.test/cover.jpg',
    videos: [{ url: 'https://v.redd.it/video.mp4', thumbnailUrl: PREVIEW }] }
  const output = normalizeSearchMedia(source, 'reddit')
  assert.deepEqual(output.images, [PHOTO, original])
  assert.equal(output.images[1], original)
  assert.equal(output.coverUrl, source.coverUrl)
  assert.equal(output.videos, source.videos)
})

test('both canonical mappings retain raw evidence, use a changed stable digest and are idempotent', () => {
  const item = modernItem(), payload = { data: { items: [item] } }
  const record = normalizeSearchPayload(payload, 'reddit').records[0]
  assert.deepEqual(record.stableFields.media, { images: [ORIGINAL], coverUrl: ORIGINAL, videos: [] })
  assert.deepEqual(record.rawItem, item)
  assert.equal(record.title, TITLE)
  assert.ok(record.parserVersion.endsWith(REDDIT_MEDIA_POLICY))
  const { collectedAt, metrics, ...oldContent } = item
  assert.notEqual(record.payloadSha256, sha256(canonicalJson(oldContent)))
  assert.equal(record.payloadSha256, normalizeSearchPayload(payload, 'reddit').records[0].payloadSha256)
  assert.equal(record.payloadSha256, normalizeSearchPayload({ data: { items: [modernItem({ collectedAt: '2026-10-11T10:44:20Z' })] } }, 'reddit').records[0].payloadSha256)

  const raw = rawRow(), legacy = { data: { raw_data: JSON.stringify([raw]) } }
  const post = normalizeNightAllLegacyPayload(legacy, 'reddit', 'raw').records[0]
  assert.deepEqual(post.stableFields.media, record.stableFields.media)
  assert.deepEqual(post.rawItem, raw)
  assert.equal(post.rawPayloadSha256, sha256(canonicalJson(raw)))
  assert.equal(post.title, TITLE)
  assert.ok(post.parserVersion.endsWith(REDDIT_MEDIA_POLICY))
  assert.equal(post.payloadSha256, normalizeNightAllLegacyPayload(legacy, 'reddit', 'raw').records[0].payloadSha256)
  const recalculated = structuredClone(post)
  delete recalculated.payloadSha256
  refreshMappedPayloadSha256(recalculated)
  assert.equal(post.payloadSha256, recalculated.payloadSha256)
  const historical = structuredClone(post)
  historical.parserVersion = historical.parserVersion.replace(`:${REDDIT_MEDIA_POLICY}`, '')
  historical.stableFields.media = media
  delete historical.payloadSha256
  refreshMappedPayloadSha256(historical)
  assert.notEqual(post.payloadSha256, historical.payloadSha256)
})

test('an original in another alias never erases the only attachment in a consumer image list', () => {
  const row = rawRow({ image_urls: JSON.stringify([PREVIEW]), media: { images: [ORIGINAL] } })
  const record = normalizeNightAllLegacyPayload({ data: { raw_data: JSON.stringify([row]) } }, 'reddit', 'raw').records[0]
  assert.deepEqual(record.stableFields.media.images, [PREVIEW])
  assert.equal(record.stableFields.media.coverUrl, ORIGINAL)
  const delivery = normalizeSearchContent({ data: { raw_data: JSON.stringify([row]) } }, 'reddit', { format: 'raw' })
  assert.equal(JSON.parse(delivery.data.raw_data)[0].image_urls, JSON.stringify([PREVIEW]))
  assert.deepEqual(JSON.parse(delivery.data.raw_data)[0].media.images, [ORIGINAL])
  assert.deepEqual(normalizeNightAllLegacyPayload(delivery, 'reddit', 'raw').records[0].stableFields.media, record.stableFields.media)
  const item = modernItem({ images: [ORIGINAL], media: { images: [PREVIEW], coverUrl: PREVIEW, videos: [] } })
  const modern = normalizeSearchContent({ data: { items: [item] } }, 'reddit').data.items[0]
  assert.deepEqual(modern.media.images, [PREVIEW])
  assert.deepEqual(modern.images, [ORIGINAL])
  const nestedRaw = normalizeSearchContent({ data: { raw_data: [rawRow({ image_urls: [ORIGINAL], media: { images: [PREVIEW] } })] } }, 'reddit', { format: 'raw' }).data.raw_data[0]
  assert.deepEqual(nestedRaw.image_urls, [ORIGINAL])
  assert.deepEqual(nestedRaw.media.images, [PREVIEW])
})
