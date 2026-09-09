import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TikHubAdapter, TikHubUpstreamError } from '../../server/adapters/tikhub.mjs'
import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import {
  buildXiaohongshuSearchDispatch,
  needsXiaohongshuDetail,
  normalizeTikHubXiaohongshuSearchResponse,
  normalizeXiaohongshuSearchRequest,
  TikHubXiaohongshuSearchContractError,
  TikHubXiaohongshuSearchResponseError,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
  xiaohongshuBodyLengths,
} from '../../server/contracts/tikhub-xiaohongshu-search.mjs'
import {
  TIKHUB_XIAOHONGSHU_DATASET_ID,
  TIKHUB_XIAOHONGSHU_SEARCH_PARSER_VERSION,
} from '../../server/ingest/tikhub-xiaohongshu.mjs'

const PROVIDER_KEY = 'provider-key-only-visible-to-fake-fetch'
const FIRST_NOTE_ID = '675d277d000000000600e655'
const SECOND_NOTE_ID = '675d277d000000000600e658'
const REPORTED_SHORT_ID = 'a9ed1c9000000001001ec2b'

function note(id, desc, extras = {}) {
  return {
    id,
    title: `note-${id}`,
    desc,
    timestamp: 1_782_212_583,
    user: { user_id: `user-${id}`, nickname: '作者' },
    interact_info: {
      liked_count: '12', collected_count: '3', comment_count: '4', share_count: '5',
    },
    ...extras,
  }
}

function envelope(items, data = {}) {
  return {
    code: 200,
    request_id: 'tikhub-search-request-1',
    data: {
      data: {
        items: items.map((entry) => ({ model_type: 'note', note: entry })),
        has_more: false,
        ...data,
      },
    },
  }
}

function currentEnvelope(items, pagination = {}, inner = {}) {
  return {
    code: 200,
    request_id: 'tikhub-search-request-current',
    data: {
      page: 1,
      next_page: null,
      search_id: 'current-provider-search-id',
      search_session_id: 'current-provider-session-id',
      ...pagination,
      data: {
        items: items.map((entry) => ({ model_type: 'note', note: entry })),
        ...inner,
      },
    },
  }
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function cursorCodec() {
  const values = new Map()
  return {
    values,
    encodeCursor(state) {
      const cursor = `opaque-${values.size + 1}`
      values.set(cursor, state)
      return cursor
    },
    decodeCursor(cursor) {
      const state = values.get(cursor)
      if (!state) throw new Error('unknown cursor')
      return state
    },
  }
}

test('request pins the App V2 path/defaults and keeps provider continuations in an opaque cursor', () => {
  const codec = cursorCodec()
  const first = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: ' 小红书相机 ', pageSize: 2,
  })
  assert.deepEqual(first.upstreamQuery, {
    keyword: '小红书相机',
    page: '1',
    sort_type: 'time_descending',
    note_type: '不限',
    time_filter: '不限',
    source: 'explore_feed',
    ai_mode: '0',
  })
  assert.equal(buildXiaohongshuSearchDispatch({
    platform: 'xiaohongshu', query: '小红书相机', pageSize: 2,
  }).path, TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH)

  const normalized = normalizeTikHubXiaohongshuSearchResponse(envelope([
    note(FIRST_NOTE_ID, '完整正文'),
  ], {
    has_more: true,
    search_id: 'private-provider-search-id',
    search_session_id: 'private-provider-session-id',
  }), first, { encodeCursor: codec.encodeCursor.bind(codec), capturedAt: '2026-09-08T01:02:03Z' })
  assert.equal(normalized.page.nextCursor, 'opaque-1')
  assert.equal(normalized.publicBody.data.meta.paginationMode, 'cursor')
  assert.deepEqual(codec.values.get('opaque-1'), {
    version: 1,
    platform: 'xiaohongshu',
    page: 2,
    scope: first.cursorScope,
    searchId: 'private-provider-search-id',
    searchSessionId: 'private-provider-session-id',
  })
  assert.doesNotMatch(JSON.stringify(normalized.publicBody), /private-provider|search_?id|session/iu)

  const next = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: '小红书相机', pageSize: 2, cursor: 'opaque-1',
  }, { decodeCursor: codec.decodeCursor.bind(codec) })
  assert.equal(next.page, 2)
  assert.equal(next.upstreamQuery.search_id, 'private-provider-search-id')
  assert.equal(next.upstreamQuery.search_session_id, 'private-provider-session-id')
  assert.throws(
    () => normalizeXiaohongshuSearchRequest({
      platform: 'xiaohongshu', query: '别的查询', pageSize: 2, cursor: 'opaque-1',
    }, { decodeCursor: codec.decodeCursor.bind(codec) }),
    (error) => error instanceof TikHubXiaohongshuSearchContractError
      && error.code === 'cursor_scope_mismatch',
  )
})

test('current TikHub response reads pagination from the outer data object', () => {
  const codec = cursorCodec()
  const request = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: '真实响应', pageSize: 1,
  })
  const normalized = normalizeTikHubXiaohongshuSearchResponse(currentEnvelope([
    note(FIRST_NOTE_ID, '完整正文'),
  ], {
    page: 1,
    next_page: 2,
  }), request, { encodeCursor: codec.encodeCursor.bind(codec) })

  assert.equal(normalized.page.nextCursor, 'opaque-1')
  assert.deepEqual(codec.values.get('opaque-1'), {
    version: 1,
    platform: 'xiaohongshu',
    page: 2,
    scope: request.cursorScope,
    searchId: 'current-provider-search-id',
    searchSessionId: 'current-provider-session-id',
  })
})

test('pagination accepts terminal outer next_page and rejects page or layer conflicts', () => {
  const request = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: '分页校验', pageSize: 1,
  })
  const terminal = normalizeTikHubXiaohongshuSearchResponse(currentEnvelope([
    note(FIRST_NOTE_ID, '完整正文'),
  ]), request)
  assert.equal(terminal.page.hasMore, false)
  assert.equal(terminal.page.nextCursor, null)

  for (const payload of [
    currentEnvelope([note(FIRST_NOTE_ID, '完整正文')], { page: 2 }),
    currentEnvelope([note(FIRST_NOTE_ID, '完整正文')], { next_page: 2 }, { has_more: false }),
    currentEnvelope([note(FIRST_NOTE_ID, '完整正文')], {
      next_page: 2,
      search_id: 'outer-search-id',
    }, {
      search_id: 'different-inner-search-id',
    }),
  ]) {
    assert.throws(
      () => normalizeTikHubXiaohongshuSearchResponse(payload, request, {
        encodeCursor: (state) => JSON.stringify(state),
      }),
      (error) => error instanceof TikHubXiaohongshuSearchResponseError
        && error.code === 'invalid_upstream_pagination',
    )
  }
})

test('pagination is capped at 15 pages even when TikHub reports another page', () => {
  const codec = cursorCodec()
  const first = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: '页数上限', pageSize: 1,
  })
  codec.values.set('page-15', {
    version: 1,
    platform: 'xiaohongshu',
    page: 15,
    scope: first.cursorScope,
    searchId: 'current-provider-search-id',
    searchSessionId: 'current-provider-session-id',
  })
  const request = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: '页数上限', pageSize: 1, cursor: 'page-15',
  }, { decodeCursor: codec.decodeCursor.bind(codec) })
  const normalized = normalizeTikHubXiaohongshuSearchResponse(currentEnvelope([
    note(FIRST_NOTE_ID, '完整正文'),
  ], { page: 15, next_page: 16 }), request)

  assert.equal(normalized.page.pageIndex, 15)
  assert.equal(normalized.page.hasMore, false)
  assert.equal(normalized.page.nextCursor, null)
  assert.equal(normalized.publicBody.data.warnings.at(-1).code, 'page_limit_reached')

  codec.values.set('page-16', { ...codec.values.get('page-15'), page: 16 })
  assert.throws(
    () => normalizeXiaohongshuSearchRequest({
      platform: 'xiaohongshu', query: '页数上限', pageSize: 1, cursor: 'page-16',
    }, { decodeCursor: codec.decodeCursor.bind(codec) }),
    (error) => error instanceof TikHubXiaohongshuSearchContractError
      && error.code === 'invalid_cursor',
  )
})

test('60-boundary detection covers code units, code points and graphemes without a 1000-char cap', () => {
  const exactSixty = '字'.repeat(60)
  const emojiSixtyCodePoints = `${'字'.repeat(59)}😀`
  const emojiSixtyCodeUnits = `${'字'.repeat(58)}😀`
  const longBody = '长'.repeat(1_001)
  assert.deepEqual(xiaohongshuBodyLengths(emojiSixtyCodePoints), {
    codeUnits: 61, codePoints: 60, graphemes: 60,
  })
  assert.deepEqual(xiaohongshuBodyLengths(emojiSixtyCodeUnits), {
    codeUnits: 60, codePoints: 59, graphemes: 59,
  })
  assert.equal(needsXiaohongshuDetail(exactSixty), true)
  assert.equal(needsXiaohongshuDetail(emojiSixtyCodePoints), true)
  assert.equal(needsXiaohongshuDetail(emojiSixtyCodeUnits), true)
  assert.equal(needsXiaohongshuDetail(longBody), false)

  const request = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: '边界', pageSize: 4,
  })
  const response = normalizeTikHubXiaohongshuSearchResponse(envelope([
    note(FIRST_NOTE_ID, exactSixty),
    note(SECOND_NOTE_ID, emojiSixtyCodePoints),
    note('675d277d000000000600e656', emojiSixtyCodeUnits),
    note('675d277d000000000600e657', longBody),
  ]), request, { capturedAt: '2026-09-08T01:02:03Z' })
  assert.equal(response.detailCandidates.length, 3)
  assert.equal(response.items[3].text.length, 1_001)
  assert.equal(response.publicBody.data.status, 'partial')
  assert.equal(isNightAllDataSearchV1Envelope(response.publicBody), true)
})

test('search preserves complete acquired text beyond the former field limit', () => {
  const request = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: '超长正文', pageSize: 1,
  })
  const response = normalizeTikHubXiaohongshuSearchResponse(envelope([
    note(FIRST_NOTE_ID, `${'文'.repeat(50_000)}😀尾部`),
  ]), request)
  assert.equal([...response.items[0].text].length, 50_003)
  assert.equal(response.bodyStates[0].completeness, 'unverified_complete')
  assert.deepEqual(response.publicBody.data.warnings, [])
})

test('search rejects a lone-surrogate business value without rewriting its exact evidence', async () => {
  const boundary = `${'文'.repeat(49_999)}😀尾`
  const malformed = '前\uD83D后'
  const bodyText = JSON.stringify(envelope([
    note(FIRST_NOTE_ID, boundary),
    note(SECOND_NOTE_ID, malformed),
  ]))
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async () => new Response(bodyText, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })

  await assert.rejects(
    () => adapter.searchXiaohongshuNotes({
      platform: 'xiaohongshu', query: 'Unicode 边界', pageSize: 2,
    }),
    (error) => {
      assert.ok(error instanceof TikHubUpstreamError)
      assert.equal(error.evidence.errorCode, 'upstream_payload_unrepresentable')
      assert.equal(error.evidence.outcome, 'succeeded_unusable')
      assert.equal(error.responseArchive.rawPayload, null)
      assert.equal(error.restrictedResponseArchive.bodyText, bodyText)
      assert.equal(error.restrictedResponseArchive.bodyBytes.equals(Buffer.from(bodyText)), true)
      assert.equal(error.restrictedResponseArchive.parsedPayload, null)
      return true
    },
  )
})

test('unknown or partially matching provider shapes fail closed', () => {
  const request = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: 'shape', pageSize: 1,
  })
  const cases = [
    { code: 200, data: { items: [{ note: note(FIRST_NOTE_ID, '正文') }] } },
    { code: 200, data: { data: { items: [{ note: note(FIRST_NOTE_ID, '正文') }], has_more: false } } },
    { code: 200, data: { data: { items: [{ model_type: 'query', note: note(FIRST_NOTE_ID, '正文') }], has_more: false } } },
    { code: 200, data: { data: { items: [{ model_type: 'note', card: note(FIRST_NOTE_ID, '正文') }], has_more: false } } },
  ]
  for (const payload of cases) {
    assert.throws(
      () => normalizeTikHubXiaohongshuSearchResponse(payload, request),
      (error) => error instanceof TikHubXiaohongshuSearchResponseError
        && error.code === 'invalid_upstream_contract',
    )
  }
})

test('provider note ids are never guessed or padded to satisfy the 24-hex identity contract', () => {
  assert.equal(REPORTED_SHORT_ID.length, 23)
  const request = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: 'reported identity', pageSize: 1,
  })
  assert.throws(
    () => normalizeTikHubXiaohongshuSearchResponse(envelope([
      note(REPORTED_SHORT_ID, '正文'),
    ]), request),
    (error) => error instanceof TikHubXiaohongshuSearchResponseError
      && error.code === 'invalid_upstream_item',
  )
})

test('adapter preserves business tokens while removing only the active provider credential', async () => {
  const businessToken = 'signed-provider-business-token'
  let call
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async (url, options) => {
      call = { url: new URL(url), options }
      return jsonResponse(envelope([
        note(FIRST_NOTE_ID, '正文'.repeat(31), {
          xsec_token: businessToken,
          image_list: [{ url_default: `https://media.example.test/note.webp?xsec_token=${businessToken}` }],
        }),
      ], {
        diagnostic_token: businessToken,
        provider_credential_echo: PROVIDER_KEY,
        has_more: false,
      }))
    },
  })
  const result = await adapter.searchXiaohongshuNotes({
    platform: 'xiaohongshu', query: '相机', pageSize: 1,
  }, { capturedAt: '2026-09-08T01:02:03Z' })

  assert.equal(call.url.pathname, TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH)
  assert.equal(call.url.searchParams.get('keyword'), '相机')
  assert.equal(call.options.headers.authorization, `Bearer ${PROVIDER_KEY}`)
  assert.equal(isNightAllDataSearchV1Envelope(result.payload), true)
  assert.equal(result.records[0].stableFields.source.connectorId, 'external-platform:tikhub')
  assert.equal(result.records[0].stableFields.source.operation, 'social.posts.search')
  assert.equal(result.records[0].parserVersion, TIKHUB_XIAOHONGSHU_SEARCH_PARSER_VERSION)
  assert.equal(result.records[0].extensions.bodyCompleteness, 'unverified_complete')
  assert.equal(result.records[0].sourcePointer, '$.data.data.items[0].note')
  assert.equal(TIKHUB_XIAOHONGSHU_DATASET_ID, 'social.posts.v1')
  assert.match(result.archiveObjects[0].archivePath, /^external\/tikhub\/xiaohongshu\//u)
  assert.equal(result.archiveObjects[0].endpointVersion, TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION)
  assert.match(JSON.stringify(result), new RegExp(businessToken, 'u'))
  assert.match(JSON.stringify(result), /diagnostic_token/iu)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(PROVIDER_KEY, 'u'))
  assert.match(JSON.stringify(result.responseArchive), /xsec_token=signed-provider-business-token/iu)
})

test('adapter quarantines an HTTP success with an unknown search shape', async () => {
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async () => jsonResponse({ code: 200, data: { unexpected: [] } }),
  })
  await assert.rejects(
    () => adapter.searchXiaohongshuNotes({
      platform: 'xiaohongshu', query: 'shape', pageSize: 1,
    }),
    (error) => error instanceof TikHubUpstreamError
      && error.evidence.errorCode === 'invalid_upstream_contract'
      && error.evidence.billed === true,
  )
})
