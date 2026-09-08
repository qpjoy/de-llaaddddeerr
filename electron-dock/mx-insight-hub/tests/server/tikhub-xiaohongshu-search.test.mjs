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

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xDC00 || next > 0xDFFF) return true
      index += 1
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return true
    }
  }
  return false
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

test('the 50000-code-point safety limit is explicit rather than a silent completeness claim', () => {
  const request = normalizeXiaohongshuSearchRequest({
    platform: 'xiaohongshu', query: '超长正文', pageSize: 1,
  })
  const response = normalizeTikHubXiaohongshuSearchResponse(envelope([
    note(FIRST_NOTE_ID, `${'文'.repeat(50_000)}😀尾部`),
  ]), request)
  assert.equal([...response.items[0].text].length, 50_000)
  assert.equal(response.bodyStates[0].completeness, 'safety_limited')
  assert.equal(response.publicBody.data.warnings[0].code, 'text_safety_limit_applied')
})

test('search text is scalar-safe before public projection and canonical ingest', async () => {
  const boundary = `${'文'.repeat(49_999)}😀尾`
  const malformed = '前\uD83D后'
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async () => jsonResponse(envelope([
      note(FIRST_NOTE_ID, boundary),
      note(SECOND_NOTE_ID, malformed),
    ])),
  })
  const result = await adapter.searchXiaohongshuNotes({
    platform: 'xiaohongshu', query: 'Unicode 边界', pageSize: 2,
  })

  const items = result.publicBody.data.items
  assert.equal([...items[0].text].length, 50_000)
  assert.equal(items[0].text.endsWith('😀'), true)
  assert.equal(items[0].text.includes('尾'), false)
  assert.equal(result.bodyStates[0].completeness, 'safety_limited')
  assert.equal(items[1].text, '前\uFFFD后')
  for (const record of result.records) {
    assert.equal(hasLoneSurrogate(record.body), false)
    assert.equal(hasLoneSurrogate(record.rawItem.text), false)
  }
  assert.equal(result.records[0].extensions.bodyCompleteness, 'safety_limited')
  assert.equal(result.records[1].body, '前\uFFFD后')
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

test('adapter returns legacy-compatible output, provider-neutral records and secret-free archives', async () => {
  const secret = 'private-provider-token-that-must-not-leak'
  let call
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async (url, options) => {
      call = { url: new URL(url), options }
      return jsonResponse(envelope([
        note(FIRST_NOTE_ID, '正文'.repeat(31), {
          xsec_token: secret,
          image_list: [{ url_default: `https://media.example.test/note.webp?xsec_token=${secret}` }],
        }),
      ], {
        diagnostic_token: secret,
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
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
  assert.doesNotMatch(JSON.stringify(result), /diagnostic_token/iu)
  assert.match(JSON.stringify(result.responseArchive), /xsec_token=%5BREDACTED%5D/iu)
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
