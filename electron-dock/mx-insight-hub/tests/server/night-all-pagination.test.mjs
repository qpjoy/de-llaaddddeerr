import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX,
  capNightAllCompatibilityTraversal,
  capNightAllDataSearchTraversal,
  prepareNightAllCompatibilityTraversal,
} from '../../server/data/night-all-pagination.mjs'
import { createNightAllCompatibilityCursorCodec } from '../../server/external-platforms/cursor.mjs'

const SECRET = 'night-all-pagination-test-secret-with-enough-entropy'
const OPERATION = 'raw'
const PLATFORM = 'xiaohongshu'

function codec(consumerId = 'consumer-a') {
  return createNightAllCompatibilityCursorCodec(SECRET, consumerId)
}

function initialTraversal(overrides = {}, consumerId = 'consumer-a') {
  return prepareNightAllCompatibilityTraversal({
    operation: OPERATION,
    platform: PLATFORM,
    upstreamBody: {
      platform: PLATFORM,
      query: '电子签名避坑',
      count: 20,
      ...overrides,
    },
    codec: codec(consumerId),
  })
}

function envelope(page, business = {}) {
  return {
    success: true,
    data: {
      raw_info: '{  "provider": "tikhub", "nested": { "unchanged": true } }',
      raw_data: JSON.stringify({
        data: {
          items: [{
            id: 'note-1',
            desc: '这是超过六十字且必须逐值保持的正文。'.repeat(8),
          }],
        },
      }),
      ...business,
      page,
    },
  }
}

function assertInvalidCursor(run, messagePattern = null) {
  assert.throws(run, (error) => (
    error?.status === 400
    && error?.code === 'invalid_cursor'
    && (!messagePattern || messagePattern.test(error.message))
  ))
}

test('cursor pagination wraps and unwraps provider state without changing business payload', () => {
  const traversal = initialTraversal()
  const original = envelope({
    hasMore: true,
    nextCursor: 'provider-cursor-sensitive',
    providerCursor: 'provider-cursor-sensitive',
    nextParams: null,
    nextPage: null,
    paginationMode: 'cursor',
  })
  const originalSnapshot = structuredClone(original)

  const capped = capNightAllCompatibilityTraversal(original, {
    operation: OPERATION,
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
  })

  assert.deepEqual(original, originalSnapshot, 'the input payload must not be mutated')
  assert.equal(capped.data.raw_info, original.data.raw_info)
  assert.equal(capped.data.raw_data, original.data.raw_data)
  assert.ok(capped.data.page.nextCursor.startsWith(NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX))
  assert.equal(capped.data.page.providerCursor, capped.data.page.nextCursor)
  assert.doesNotMatch(capped.data.page.nextCursor, /provider-cursor-sensitive/u)

  const next = initialTraversal({ cursor: capped.data.page.nextCursor })
  assert.equal(next.page, 2)
  assert.equal(next.upstreamBody.cursor, 'provider-cursor-sensitive')
  assert.equal(next.upstreamBody.page, undefined)
})

test('composite pagination wraps complete params and unwraps them for the next upstream call', () => {
  const traversal = initialTraversal()
  const providerParams = {
    search_id: 'provider-search-id',
    search_session_id: 'provider-session-id',
    rank_token: 42,
  }
  const original = envelope({
    hasMore: true,
    nextCursor: null,
    providerCursor: null,
    nextParams: providerParams,
    nextPage: null,
    paginationMode: 'composite',
  })

  const capped = capNightAllCompatibilityTraversal(original, {
    operation: OPERATION,
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
  })

  assert.deepEqual(capped.data.raw_info, original.data.raw_info)
  assert.deepEqual(capped.data.raw_data, original.data.raw_data)
  assert.deepEqual(Object.keys(capped.data.page.nextParams), ['cursor'])
  assert.ok(capped.data.page.nextParams.cursor.startsWith(NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX))
  assert.doesNotMatch(capped.data.page.nextParams.cursor, /provider-search-id/u)

  const next = initialTraversal({ params: capped.data.page.nextParams })
  assert.equal(next.page, 2)
  assert.deepEqual(next.upstreamBody.params, providerParams)
  assert.equal(next.upstreamBody.cursor, undefined)
})

test('page pagination exposes only an mxnc1 cursor and restores the provider page internally', () => {
  const traversal = initialTraversal()
  const original = envelope({
    hasMore: true,
    nextCursor: null,
    providerCursor: null,
    nextParams: null,
    nextPage: 2,
    paginationMode: 'page',
  }, {
    acquired: { text: '完整业务正文'.repeat(30), tags: ['原样', '不脱敏'] },
  })

  const capped = capNightAllCompatibilityTraversal(original, {
    operation: OPERATION,
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
  })

  assert.deepEqual(capped.data.acquired, original.data.acquired)
  assert.equal(capped.data.page.nextPage, null)
  assert.equal(capped.data.page.nextParams, null)
  assert.equal(capped.data.page.paginationMode, 'cursor')
  assert.ok(capped.data.page.nextCursor.startsWith(NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX))
  assert.equal(capped.data.page.providerCursor, capped.data.page.nextCursor)

  const next = initialTraversal({ cursor: capped.data.page.nextCursor })
  assert.equal(next.page, 2)
  assert.equal(next.upstreamBody.page, 2)
  assert.equal(next.upstreamBody.cursor, undefined)
  assert.equal(next.upstreamBody.params, undefined)
})

test('offset pagination hides provider params and restores params plus page internally', () => {
  const traversal = initialTraversal()
  const original = envelope({
    hasMore: true,
    nextCursor: null,
    providerCursor: null,
    nextParams: { offset: 20 },
    nextPage: 2,
    paginationMode: 'offset',
  }, {
    acquired: { metrics: { likes: 123 }, media: ['https://example.invalid/original.jpg'] },
  })

  const capped = capNightAllCompatibilityTraversal(original, {
    operation: OPERATION,
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
  })

  assert.deepEqual(capped.data.acquired, original.data.acquired)
  assert.equal(capped.data.page.nextPage, null)
  assert.equal(capped.data.page.nextCursor, null)
  assert.equal(capped.data.page.providerCursor, null)
  assert.equal(capped.data.page.paginationMode, 'composite')
  assert.deepEqual(Object.keys(capped.data.page.nextParams), ['cursor'])
  assert.ok(capped.data.page.nextParams.cursor.startsWith(NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX))

  const next = initialTraversal({ params: capped.data.page.nextParams })
  assert.equal(next.page, 2)
  assert.equal(next.upstreamBody.page, 2)
  assert.deepEqual(next.upstreamBody.params, { offset: 20 })
  assert.equal(next.upstreamBody.cursor, undefined)
})

test('cursor pagination carries first-page static params inside the authenticated state', () => {
  const staticParams = {
    sort: 'latest',
    locale: 'zh-CN',
    filters: { note_type: 'normal' },
  }
  const traversal = initialTraversal({ params: staticParams })
  const capped = capNightAllCompatibilityTraversal(envelope({
    hasMore: true,
    nextCursor: 'provider-cursor-with-static-filters',
    providerCursor: null,
    nextParams: null,
    nextPage: null,
    paginationMode: 'cursor',
  }), {
    operation: OPERATION,
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
    upstreamBody: traversal.upstreamBody,
  })

  const next = initialTraversal({ cursor: capped.data.page.nextCursor })
  assert.equal(next.upstreamBody.cursor, 'provider-cursor-with-static-filters')
  assert.deepEqual(next.upstreamBody.params, staticParams)
})

test('page 15 terminates pagination and preserves all acquired business fields', () => {
  const traversal = initialTraversal({ page: 15 })
  const original = envelope({
    hasMore: true,
    nextCursor: 'provider-page-16',
    providerCursor: 'provider-page-16',
    nextParams: null,
    nextPage: 16,
    paginationMode: 'cursor',
  }, {
    arbitrary_business_field: { keep: ['exactly', 15, true, null] },
  })

  const capped = capNightAllCompatibilityTraversal(original, {
    operation: OPERATION,
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
  })

  assert.equal(capped.data.page.hasMore, false)
  assert.equal(capped.data.page.nextCursor, null)
  assert.equal(capped.data.page.providerCursor, null)
  assert.equal(capped.data.page.nextParams, null)
  assert.equal(capped.data.page.nextPage, null)
  assert.equal(capped.data.warnings.at(-1).code, 'page_limit_reached')
  assert.deepEqual(capped.data.raw_info, original.data.raw_info)
  assert.deepEqual(capped.data.raw_data, original.data.raw_data)
  assert.deepEqual(capped.data.arbitrary_business_field, original.data.arbitrary_business_field)
})

test('an explicit hasMore=false terminates even if stale continuation fields are present', () => {
  const traversal = initialTraversal()
  const original = envelope({
    hasMore: false,
    nextCursor: 'stale-provider-cursor',
    providerCursor: 'stale-provider-cursor',
    nextParams: null,
    nextPage: null,
    paginationMode: 'cursor',
  })

  const capped = capNightAllCompatibilityTraversal(original, {
    operation: OPERATION,
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
  })

  assert.equal(capped.data.page.hasMore, false)
  assert.equal(capped.data.page.nextCursor, null)
  assert.equal(capped.data.page.providerCursor, null)
  assert.deepEqual(capped.data.raw_info, original.data.raw_info)
  assert.deepEqual(capped.data.raw_data, original.data.raw_data)
})

test('wrapped traversal rejects tampering and reuse across consumer, operation, platform, or query scope', () => {
  const traversal = initialTraversal()
  const capped = capNightAllCompatibilityTraversal(envelope({
    hasMore: true,
    nextCursor: 'provider-next',
    providerCursor: 'provider-next',
    nextParams: null,
    nextPage: null,
    paginationMode: 'cursor',
  }), {
    operation: OPERATION,
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
  })
  const wrapped = capped.data.page.nextCursor
  const parts = wrapped.split('.')
  parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith('A') ? 'B' : 'A'}`

  assertInvalidCursor(() => initialTraversal({ cursor: parts.join('.') }))
  assertInvalidCursor(() => initialTraversal({ cursor: wrapped }, 'consumer-b'))
  assertInvalidCursor(() => prepareNightAllCompatibilityTraversal({
    operation: 'crawl',
    platform: PLATFORM,
    upstreamBody: { platform: PLATFORM, query: '电子签名避坑', count: 20, cursor: wrapped },
    codec: codec(),
  }))
  assertInvalidCursor(() => prepareNightAllCompatibilityTraversal({
    operation: OPERATION,
    platform: 'douyin',
    upstreamBody: { platform: 'douyin', query: '电子签名避坑', count: 20, cursor: wrapped },
    codec: codec(),
  }))
  assertInvalidCursor(() => initialTraversal({ query: '不同查询', cursor: wrapped }))
})

test('raw historical cursor and continuation params fail closed with a restart instruction', () => {
  assertInvalidCursor(
    () => initialTraversal({ cursor: 'raw-provider-cursor' }),
    /restart from page 1/u,
  )

  for (const params of [
    { search_id: 'provider-search-id', search_session_id: 'provider-session-id' },
    { next_page_token: 'provider-page-token' },
    { offset: 20 },
    { pagination: { cursor: 'nested-provider-cursor' } },
  ]) {
    assertInvalidCursor(
      () => initialTraversal({ params }),
      /restart from page 1/u,
    )
  }
})

test('Night-All data-search wraps only nextCursor and preserves its strict pageInfo schema', () => {
  const traversal = prepareNightAllCompatibilityTraversal({
    operation: 'data-search',
    platform: PLATFORM,
    upstreamBody: { platform: PLATFORM, query: '电子签名避坑', pageSize: 10 },
    codec: codec(),
  })
  const original = {
    requestId: '00000000-0000-4000-8000-000000000001',
    data: {
      contractVersion: 'night-all.data-search.v1',
      items: [{ id: 'note-1', text: '完整正文'.repeat(40) }],
      pageInfo: {
        pageIndex: 1,
        pageSize: 10,
        returnedCount: 1,
        hasMore: true,
        nextCursor: 'provider-data-search-page-2',
        cursorType: 'opaque',
      },
      warnings: [],
    },
  }

  const capped = capNightAllDataSearchTraversal(original, {
    platform: PLATFORM,
    page: traversal.page,
    scope: traversal.scope,
    codec: codec(),
  })

  assert.deepEqual(Object.keys(capped.data.pageInfo), Object.keys(original.data.pageInfo))
  assert.deepEqual(capped.data.items, original.data.items)
  assert.ok(capped.data.pageInfo.nextCursor.startsWith(NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX))
  assert.doesNotMatch(capped.data.pageInfo.nextCursor, /provider-data-search-page-2/u)

  const next = prepareNightAllCompatibilityTraversal({
    operation: 'data-search',
    platform: PLATFORM,
    upstreamBody: {
      platform: PLATFORM,
      query: '电子签名避坑',
      pageSize: 10,
      cursor: capped.data.pageInfo.nextCursor,
    },
    codec: codec(),
  })
  assert.equal(next.page, 2)
  assert.equal(next.upstreamBody.cursor, 'provider-data-search-page-2')
})

test('Night-All data-search page 15 terminates without adding legacy page fields', () => {
  const capped = capNightAllDataSearchTraversal({
    data: {
      items: [{ id: 'note-15', text: '保持原样' }],
      pageInfo: {
        pageIndex: 15,
        pageSize: 10,
        returnedCount: 1,
        hasMore: true,
        nextCursor: 'provider-data-search-page-16',
        cursorType: 'opaque',
      },
      warnings: [],
    },
  }, {
    platform: PLATFORM,
    page: 15,
    scope: 'test-scope',
    codec: codec(),
  })

  assert.deepEqual(capped.data.items, [{ id: 'note-15', text: '保持原样' }])
  assert.deepEqual(capped.data.pageInfo, {
    pageIndex: 15,
    pageSize: 10,
    returnedCount: 1,
    hasMore: false,
    nextCursor: null,
    cursorType: 'none',
  })
  assert.equal(capped.data.warnings.at(-1).code, 'page_limit_reached')
})

test('Night-All data-search honors hasMore=false even when a stale cursor is present', () => {
  const capped = capNightAllDataSearchTraversal({
    data: {
      items: [{ id: 'terminal-note', text: '完整终页正文' }],
      pageInfo: {
        pageIndex: 3,
        pageSize: 10,
        returnedCount: 1,
        hasMore: false,
        nextCursor: 'stale-provider-cursor',
        cursorType: 'opaque',
      },
      warnings: [],
    },
  }, {
    platform: PLATFORM,
    page: 3,
    scope: 'terminal-scope',
    codec: codec(),
  })

  assert.deepEqual(capped.data.items, [{ id: 'terminal-note', text: '完整终页正文' }])
  assert.deepEqual(capped.data.pageInfo, {
    pageIndex: 3,
    pageSize: 10,
    returnedCount: 1,
    hasMore: false,
    nextCursor: null,
    cursorType: 'none',
  })
  assert.deepEqual(capped.data.warnings, [])
})
