import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import { isNightAllLegacyEnvelope } from '../../server/contracts/night-all-legacy.mjs'
import {
  projectTikHubXiaohongshuSearch,
  TikHubXiaohongshuSearchProjectionError,
  toNightAllXiaohongshuRawEnvelope,
} from '../../server/contracts/tikhub-xiaohongshu-search-projection.mjs'

const FIRST_NOTE_ID = '675d277d000000000600e655'
const SECOND_NOTE_ID = '675d277d000000000600e658'
const THIRD_NOTE_ID = '675d277d000000000600e657'

function searchItem({
  externalId = FIRST_NOTE_ID,
  text = '字'.repeat(60),
  title = null,
  author = { id: null, name: '搜索作者', avatarUrl: null },
  media = { coverUrl: null, images: [], videos: [] },
} = {}) {
  return {
    id: `xiaohongshu:${externalId}`,
    externalId,
    platform: 'xiaohongshu',
    contentType: 'note',
    url: `https://www.xiaohongshu.com/explore/${externalId}`,
    title,
    text,
    publishedAt: null,
    collectedAt: '2026-09-08T01:02:03.000Z',
    author,
    metrics: { likes: 12, comments: 4, shares: 5, views: null, bookmarks: 3 },
    media,
    source: { provider: null, endpointId: null },
  }
}

function searchResult(items = [searchItem()], {
  warnings = [{
    code: 'xiaohongshu_detail_required',
    message: '1 note bodies match the provider preview boundary',
  }],
  hasMore = true,
  nextCursor = 'opaque-next-page',
} = {}) {
  return {
    publicBody: {
      data: {
        contractVersion: 'night-all.data-search.v1',
        platform: 'xiaohongshu',
        query: '便携相机',
        items,
        pageInfo: {
          pageIndex: 1,
          pageSize: 20,
          returnedCount: items.length,
          hasMore,
          nextCursor,
          cursorType: nextCursor ? 'opaque' : 'none',
        },
        status: warnings.length > 0 ? 'partial' : 'ok',
        warnings,
        meta: {
          capability: 'search_posts',
          capabilityStatus: warnings.length > 0 ? 'degraded' : 'ready',
          paginationMode: 'compound',
          sourceProvider: null,
          endpointId: null,
          providerCalls: 1,
        },
      },
    },
    bodyStates: items.map((item) => ({
      completeness: item.text?.length === 60 ? 'provider_preview' : 'unverified_complete',
      detailRequired: item.text?.length === 60,
      safetyLimited: false,
    })),
  }
}

function detailResult({
  externalId = FIRST_NOTE_ID,
  text = `${'字'.repeat(60)}，这是详情补齐后的正文😀`,
  secret = 'signed-private-token',
  safetyLimited,
} = {}) {
  const result = {
    publicBody: {
      contractVersion: 'mx-insight-hub.social-post.v1',
      data: {
        item: {
          id: `xiaohongshu:${externalId}`,
          externalId,
          platform: 'xiaohongshu',
          contentType: 'post',
          url: `https://www.xiaohongshu.com/explore/${externalId}?xsec_token=${secret}`,
          title: '详情标题',
          text,
          tags: ['摄影'],
          author: {
            id: 'detail-author-id',
            name: '详情作者不应覆盖搜索作者',
            avatarUrl: `https://avatar.example.test/user.webp?signature=${secret}`,
          },
          metrics: { liked: 9_999, collected: 9_998, comments: 9_997, shared: 9_996 },
          media: [{
            type: 'image',
            url: `https://cdn.example.test/detail.webp?xsec_token=${secret}`,
          }],
          publishedAt: '2026-09-07T16:00:00.000Z',
          collectedAt: '2026-09-08T01:02:04.000Z',
          apiKey: secret,
        },
      },
      meta: { capturedAt: '2026-09-08T01:02:04.000Z' },
    },
  }
  return safetyLimited === undefined ? result : { ...result, safetyLimited }
}

test('longer same-id detail enriches body and missing fields without replacing search metrics', () => {
  const input = searchResult()
  const before = structuredClone(input)
  const projection = projectTikHubXiaohongshuSearch(input, {
    detailResults: [detailResult()],
    durationMs: 37,
  })
  const item = projection.items[0]

  assert.equal(isNightAllDataSearchV1Envelope(projection.publicBody), true)
  assert.equal(item.text, `${'字'.repeat(60)}，这是详情补齐后的正文😀`)
  assert.equal(item.title, '详情标题')
  assert.equal(item.author.id, 'detail-author-id')
  assert.equal(item.author.name, '搜索作者')
  assert.equal(item.author.avatarUrl, 'https://avatar.example.test/user.webp')
  assert.deepEqual(item.media, {
    coverUrl: 'https://cdn.example.test/detail.webp',
    images: ['https://cdn.example.test/detail.webp'],
    videos: [],
  })
  assert.deepEqual(item.metrics, {
    likes: 12, comments: 4, shares: 5, views: null, bookmarks: 3,
  })
  assert.equal(projection.publicBody.data.status, 'ok')
  assert.deepEqual(projection.publicBody.data.warnings, [])
  assert.equal(projection.publicBody.data.meta.durationMs, 37)
  assert.equal(projection.publicBody.data.meta.providerCalls, 2)
  assert.equal(projection.bodyCompleteness[0].completeness, 'detail_enriched')
  assert.equal(projection.bodyCompleteness[0].detailUsed, true)
  assert.deepEqual(projection.detailSummary, {
    successful: 1, matched: 1, enriched: 1, failed: 0, unresolved: 0, providerCalls: 2,
  })
  assert.deepEqual(input, before, 'pure projection must not mutate adapter results')
  assert.equal(Object.isFrozen(projection.publicBody.data.items[0]), true)
})

test('equal/shorter or different-id details never replace a 60-character preview', () => {
  const preview = '预'.repeat(60)
  const projection = projectTikHubXiaohongshuSearch(searchResult([
    searchItem({ text: preview }),
  ]), {
    detailResults: [
      detailResult({ text: '等'.repeat(60) }),
      detailResult({ externalId: SECOND_NOTE_ID, text: '错'.repeat(200) }),
    ],
    detailFailureCount: 1,
    durationMs: 11,
  })

  assert.equal(projection.items[0].text, preview)
  assert.equal(projection.bodyCompleteness[0].completeness, 'provider_preview')
  assert.equal(projection.detailSummary.matched, 1)
  assert.equal(projection.detailSummary.enriched, 0)
  assert.equal(projection.detailSummary.unresolved, 1)
  assert.equal(projection.publicBody.data.meta.providerCalls, 4)
  assert.equal(projection.publicBody.data.status, 'partial')
  assert.deepEqual(projection.publicBody.data.warnings.map(({ code }) => code), [
    'xiaohongshu_detail_incomplete',
    'xiaohongshu_detail_unavailable',
  ])
  assert.deepEqual(projection.items[0].metrics, {
    likes: 12, comments: 4, shares: 5, views: null, bookmarks: 3,
  })
})

test('emoji lengths use code points and the explicit 50000-point limit is reported', () => {
  const projection = projectTikHubXiaohongshuSearch(searchResult([
    searchItem({ externalId: THIRD_NOTE_ID, text: '短😀' }),
  ], { warnings: [], hasMore: false, nextCursor: null }), {
    detailResults: [detailResult({
      externalId: THIRD_NOTE_ID,
      text: `${'😀'.repeat(50_000)}不能静默保留`,
    })],
    durationMs: 5,
  })

  assert.equal([...projection.items[0].text].length, 50_000)
  assert.equal(projection.items[0].text.length, 100_000)
  assert.equal(projection.bodyCompleteness[0].completeness, 'safety_limited')
  assert.equal(projection.publicBody.data.status, 'partial')
  assert.deepEqual(projection.publicBody.data.warnings.map(({ code }) => code), [
    'text_safety_limit_applied',
  ])
})

test('fresh and cached exact-limit details preserve conservative safety completeness', () => {
  const exactBody = '汉'.repeat(50_000)
  const input = searchResult([searchItem({ text: '短正文' })], {
    warnings: [], hasMore: false, nextCursor: null,
  })

  const knownExact = projectTikHubXiaohongshuSearch(input, {
    detailResults: [detailResult({ text: exactBody, safetyLimited: false })],
  })
  assert.equal(knownExact.bodyCompleteness[0].completeness, 'detail_enriched')
  assert.equal(knownExact.publicBody.data.status, 'ok')
  assert.equal('safetyLimited' in knownExact.items[0], false)

  const knownLimited = projectTikHubXiaohongshuSearch(input, {
    detailResults: [detailResult({ text: exactBody, safetyLimited: true })],
  })
  assert.equal(knownLimited.bodyCompleteness[0].completeness, 'safety_limited')
  assert.deepEqual(knownLimited.publicBody.data.warnings.map(({ code }) => code), [
    'text_safety_limit_applied',
  ])

  const cachedWithoutSignal = projectTikHubXiaohongshuSearch(input, {
    detailResults: [detailResult({ text: exactBody })],
  })
  assert.equal(cachedWithoutSignal.bodyCompleteness[0].completeness, 'safety_limited')
  assert.equal([...cachedWithoutSignal.items[0].text].length, 50_000)
  assert.equal('safetyLimited' in cachedWithoutSignal.items[0], false)
})

test('legacy projection uses standard Night-All fields, JSON strings and Unix seconds', () => {
  const secret = 'must-not-survive-projection'
  const projection = projectTikHubXiaohongshuSearch(searchResult(), {
    detailResults: [detailResult({ secret })],
    durationMs: 37,
  })
  const envelope = toNightAllXiaohongshuRawEnvelope(projection, {
    requestId: 'hub-request-1',
    traceId: 'hub-trace-1',
  })
  const rows = JSON.parse(envelope.data.raw_data)
  const row = rows[0]

  assert.equal(isNightAllLegacyEnvelope(envelope), true)
  assert.equal(envelope.data.raw_info, '[]')
  assert.equal(envelope.requestId, 'hub-request-1')
  assert.equal(envelope.traceId, 'hub-trace-1')
  assert.equal(row.content_id, FIRST_NOTE_ID)
  assert.equal(row.platform_name, 'xiaohongshu')
  assert.equal(row.text, projection.items[0].text)
  assert.equal(row.full_text, row.text)
  assert.equal(row.content, row.text)
  assert.equal(row.published_at, 1_788_796_800)
  assert.equal(row.collected_at, 1_788_829_323)
  assert.equal(row.forward_count, 5)
  assert.equal(row.reply_count, 4)
  assert.equal(row.like_count, 12)
  assert.equal(row.bookmark_count, 3)
  assert.equal(row.view_count, null)
  assert.equal(row.source, 'mx-insight-hub')
  assert.deepEqual(JSON.parse(row.image_urls), ['https://cdn.example.test/detail.webp'])
  assert.deepEqual(JSON.parse(row.video_urls), [])
  assert.deepEqual(JSON.parse(row.metadata), {
    body_completeness: 'detail_enriched', detail_used: true,
  })
  assert.deepEqual(envelope.data.page, {
    page: 1,
    pageSize: 20,
    returnedCount: 1,
    hasMore: true,
    nextCursor: 'opaque-next-page',
    providerCursor: null,
    nextParams: null,
    nextPage: null,
    paginationMode: 'cursor',
  })
  assert.deepEqual(envelope.data.meta.bodyCompleteness, {
    detailEnriched: 1, providerPreview: 0, safetyLimited: 0, unverifiedComplete: 0,
  })
  assert.equal(envelope.data.meta.providerCalls, 2)
  assert.equal(envelope.data.meta.durationMs, 37)
  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(secret, 'u'))
  assert.doesNotMatch(JSON.stringify(envelope), /tikhub|xsec_token|signature|apiKey/iu)
})

test('empty modern results remain valid and get Night-All empty-result warning', () => {
  const projection = projectTikHubXiaohongshuSearch(searchResult([], {
    warnings: [], hasMore: false, nextCursor: null,
  }), { durationMs: 0 })
  const legacy = toNightAllXiaohongshuRawEnvelope(projection)

  assert.equal(isNightAllDataSearchV1Envelope(projection.publicBody), true)
  assert.equal(isNightAllLegacyEnvelope(legacy), true)
  assert.deepEqual(JSON.parse(legacy.data.raw_data), [])
  assert.deepEqual(JSON.parse(legacy.data.raw_info), [])
  assert.equal(legacy.data.meta.resultCount, 0)
  assert.equal(legacy.data.warnings[0].code, 'STANDARD_PAYLOAD_EMPTY')
})

test('unknown modern and successful-detail shapes fail closed', () => {
  assert.throws(
    () => projectTikHubXiaohongshuSearch({ data: { items: [] } }),
    (error) => error instanceof TikHubXiaohongshuSearchProjectionError
      && error.code === 'invalid_search_result',
  )
  assert.throws(
    () => projectTikHubXiaohongshuSearch(searchResult(), {
      detailResults: [{ data: { note: { externalId: FIRST_NOTE_ID } } }],
    }),
    (error) => error instanceof TikHubXiaohongshuSearchProjectionError
      && error.code === 'invalid_detail_result',
  )
})
