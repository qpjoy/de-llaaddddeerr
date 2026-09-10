import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
  ECOMMERCE_DELIVERY_MODES,
  JUSTONE_BUSINESS_CODES,
  JUSTONE_CONTRACT_VERSION,
  JUSTONE_ENDPOINTS,
  JUSTONE_OPERATION,
  JUSTONE_PROVIDER_KEY,
  JustOneContractError,
  JustOneResponseContractError,
  classifyJustOneBusinessCode,
  extractJustOneProductSearchItems,
  inspectJustOneEnvelope,
  normalizeJustOneProductSearchRequest,
  normalizeJustOneProductItem,
  normalizeJustOneProductSearchResponse,
  redactJustOnePrivateFields,
} from '../../server/contracts/justone.mjs'

const jdProductSearchV1Fixture = JSON.parse(readFileSync(
  new URL('../fixtures/justone/jd-product-search-v1.success.json', import.meta.url),
  'utf8',
))
const taobaoProductSearchV1Fixture = JSON.parse(readFileSync(
  new URL('../fixtures/justone/taobao-product-search-v1.success.json', import.meta.url),
  'utf8',
))

function envelope(data) {
  return {
    code: 0,
    message: null,
    data,
    recordTime: '2026-09-03T00:00:00Z',
    requestId: 'upstream-request',
  }
}

test('contract pins the provider, operation and official V1 endpoint paths', () => {
  assert.equal(JUSTONE_PROVIDER_KEY, 'justone')
  assert.equal(JUSTONE_OPERATION, 'ecommerce.products.search')
  assert.equal(JUSTONE_CONTRACT_VERSION, 'justone.product-search.v1')
  assert.equal(ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION, 'mx-insight-hub.ecommerce-products.v1')
  assert.deepEqual(
    Object.fromEntries(Object.entries(JUSTONE_ENDPOINTS).map(([marketplace, value]) => [marketplace, value.path])),
    {
      taobao: '/api/taobao/search-item-list/v1',
      tmall: '/api/taobao/search-item-list/v1',
      jd: '/api/jd/search-item-list/v1',
      xiaohongshu_ec: '/api/xiaohongshu-ec/search-products/v1',
      xianyu: '/api/xianyu/search-item-list/v1',
    },
  )
  assert.ok(Object.values(JUSTONE_ENDPOINTS).every((entry) => (
    entry.method === 'GET' && entry.endpointVersion === 'v1' && entry.path.startsWith('/api/')
  )))
  assert.deepEqual(
    Object.fromEntries(Object.entries(JUSTONE_ENDPOINTS).map(([marketplace, value]) => (
      [marketplace, value.contractVersion]
    ))),
    {
      taobao: 'justone.product-search.v2',
      tmall: 'justone.product-search.v2',
      jd: 'justone.product-search.v1',
      xiaohongshu_ec: 'justone.product-search.v1',
      xianyu: 'justone.product-search.v1',
    },
  )
})

test('provider-neutral request maps only reviewed marketplace parameters', () => {
  const taobao = normalizeJustOneProductSearchRequest({
    marketplace: 'taobao',
    query: ' 焕颜有方 ',
    sort: 'price_asc',
    price: { min: '10', max: '99.90' },
    page: 2,
  })
  assert.deepEqual(taobao.upstreamQuery, {
    keyword: '焕颜有方',
    page: '2',
    sort: 'bid',
    startPrice: '10',
    endPrice: '99.90',
  })
  assert.equal(taobao.endpointKey, 'taobao-tmall.product-search.v1')
  assert.equal(taobao.endpointContractVersion, 'justone.product-search.v2')
  assert.equal(taobao.fingerprintBody.page, 2)
  assert.equal(taobao.deliveryMode, 'cache_first')
  assert.deepEqual(ECOMMERCE_DELIVERY_MODES, ['cache_only', 'cache_first', 'refresh'])

  const cacheOnly = normalizeJustOneProductSearchRequest({
    marketplace: 'taobao', query: '焕颜有方', deliveryMode: 'cache_only',
  })
  const refresh = normalizeJustOneProductSearchRequest({
    marketplace: 'taobao', query: '焕颜有方', deliveryMode: 'refresh',
  })
  assert.equal(cacheOnly.deliveryMode, 'cache_only')
  assert.equal(refresh.deliveryMode, 'refresh')
  assert.deepEqual(
    cacheOnly.fingerprintBody,
    refresh.fingerprintBody,
    'delivery preference must not fragment the logical query snapshot',
  )

  const tmall = normalizeJustOneProductSearchRequest({ marketplace: 'tmall', query: '面霜' })
  assert.equal(tmall.endpointContractVersion, 'justone.product-search.v2')
  assert.deepEqual(tmall.upstreamQuery, {
    keyword: '面霜', page: '1', sort: '_sale', tmall: 'true',
  })

  const jd = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机' })
  assert.equal(jd.endpointContractVersion, 'justone.product-search.v1')

  assert.throws(
    () => normalizeJustOneProductSearchRequest({
      marketplace: 'jd', query: '手机', token: 'must-not-pass-through',
    }),
    (error) => error instanceof JustOneContractError && error.code === 'unsupported_request_field',
  )
  assert.throws(
    () => normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机', sort: 'sales_desc' }),
    (error) => error instanceof JustOneContractError && error.code === 'unsupported_sort',
  )
  assert.throws(
    () => normalizeJustOneProductSearchRequest({ marketplace: 'xianyu', query: '相机', price: { min: 1 } }),
    (error) => error instanceof JustOneContractError && error.code === 'unsupported_price_filter',
  )
  assert.throws(
    () => normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机', deliveryMode: 'provider_only' }),
    (error) => error instanceof JustOneContractError && error.code === 'invalid_delivery_mode',
  )
})

test('price filters accept only bounded exact decimal strings', () => {
  const valid = normalizeJustOneProductSearchRequest({
    marketplace: 'taobao',
    query: '相机',
    price: { min: '0.00000001', max: '999999999999.99999999' },
  })
  assert.deepEqual(valid.price, { min: '0.00000001', max: '999999999999.99999999' })

  for (const value of [null, '', 0, 1.25, ' 1.25', '01', '1.', '.5', '1e2', '-1', '1000000000000', '1.000000000']) {
    assert.throws(
      () => normalizeJustOneProductSearchRequest({
        marketplace: 'taobao', query: '相机', price: { min: value },
      }),
      (error) => error instanceof JustOneContractError && error.code === 'invalid_price',
    )
  }
  assert.throws(
    () => normalizeJustOneProductSearchRequest({
      marketplace: 'taobao', query: '相机', price: null,
    }),
    (error) => error instanceof JustOneContractError && error.code === 'invalid_price',
  )
  assert.throws(
    () => normalizeJustOneProductSearchRequest({
      marketplace: 'taobao', query: '相机', price: { min: '900719925474.09999999', max: '900719925474.00000001' },
    }),
    (error) => error instanceof JustOneContractError && error.code === 'invalid_price',
  )
})

test('Xiaohongshu searchId is carried only inside the provider-neutral cursor', () => {
  const encodedStates = new Map()
  const encodeCursor = (state) => {
    const cursor = `opaque-${encodedStates.size + 1}`
    encodedStates.set(cursor, state)
    return cursor
  }
  const firstRequest = normalizeJustOneProductSearchRequest({
    marketplace: 'xiaohongshu_ec', query: '精华液',
  })
  const first = normalizeJustOneProductSearchResponse(envelope({
    items: [{ goodsId: 'xhs-1', title: '商品一' }],
    searchId: 'private-search-id',
    hasMore: true,
  }), firstRequest, { encodeCursor, capturedAt: '2026-09-03T01:02:03Z' })

  assert.equal(first.page.nextCursor, 'opaque-1')
  assert.equal(encodedStates.get('opaque-1').continuation, 'private-search-id')
  assert.doesNotMatch(JSON.stringify(first.publicBody), /search_?id|private-search-id/iu)

  const secondRequest = normalizeJustOneProductSearchRequest({
    marketplace: 'xiaohongshu_ec', query: '精华液', cursor: 'opaque-1',
  }, { decodeCursor: (cursor) => encodedStates.get(cursor) })
  assert.equal(secondRequest.page, 2)
  assert.equal(secondRequest.upstreamQuery.searchId, 'private-search-id')
  const second = normalizeJustOneProductSearchResponse(envelope({
    items: [{ goodsId: 'xhs-2', title: '商品二' }],
    searchId: 'rotated-search-id-must-not-replace-the-first',
    hasMore: true,
  }), secondRequest, { encodeCursor })
  assert.equal(second.page.nextCursor, 'opaque-2')
  assert.equal(encodedStates.get('opaque-2').continuation, 'private-search-id')
  assert.throws(
    () => normalizeJustOneProductSearchRequest({
      marketplace: 'xiaohongshu_ec', query: '另一个词', cursor: 'opaque-1',
    }, { decodeCursor: (cursor) => encodedStates.get(cursor) }),
    (error) => error.code === 'cursor_scope_mismatch',
  )
  assert.throws(
    () => normalizeJustOneProductSearchRequest({
      marketplace: 'xiaohongshu_ec', query: '精华液', cursor: 'opaque-1',
    }),
    (error) => error.code === 'cursor_codec_required',
  )
})

test('an untyped non-empty page never implies a safe continuation', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机' })
  const response = normalizeJustOneProductSearchResponse({
    code: 0,
    message: 'ok',
    recordTime: '2026-09-03T01:02:03Z',
    data: { items: [{ skuId: 'jd-1', title: '手机' }] },
  }, request, {
    encodeCursor: () => assert.fail('cursor must not be issued without explicit hasMore=true'),
  })

  assert.equal(response.page.hasMore, null)
  assert.equal(response.page.nextCursor, null)
})

test('response extraction is shallow, explicit and rejects unreviewed envelope drift', () => {
  const raw = envelope({ items: [{ itemId: 'tb-1' }] })
  assert.deepEqual(extractJustOneProductSearchItems(raw, 'taobao').path, ['data', 'items'])
  assert.throws(
    () => extractJustOneProductSearchItems(envelope({ wrapper: { items: [{ itemId: 'hidden' }] } }), 'taobao'),
    (error) => error instanceof JustOneResponseContractError && error.code === 'invalid_upstream_items',
  )
  assert.deepEqual(inspectJustOneEnvelope({ ...raw, code: '0' }), {
    outcome: 'invalid', classification: null,
  })
  assert.throws(
    () => extractJustOneProductSearchItems({ code: 0, data: { items: [] } }, 'taobao'),
    (error) => error.code === 'invalid_upstream_envelope',
  )
})

test('JD V1 accepts the reviewed data.products response shape and its data-level page counters', () => {
  const extracted = extractJustOneProductSearchItems(jdProductSearchV1Fixture, 'jd')
  assert.deepEqual(extracted.path, ['data', 'products'])
  assert.equal(extracted.items.length, 1)

  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '耳机' })
  const response = normalizeJustOneProductSearchResponse(jdProductSearchV1Fixture, request, {
    capturedAt: '2026-09-06T05:00:17Z',
  })

  assert.deepEqual(response.publicBody.data.items[0], {
    id: 'jd-product-1',
    marketplace: 'jd',
    title: '脱敏示例商品',
    url: null,
    pricing: { current: '199.00', original: null, currency: 'CNY' },
    shop: { id: 'jd-shop-1', name: '脱敏示例店铺' },
    images: [],
    signals: { sales: null, reviewCount: null, location: null },
    attributes: { brand: null, category: null },
  })
  // The reviewed fixture is a single-page result (currentPage 1 of totalPages 1).
  // An explicit false is the upstream saying "no more"; null stays reserved for
  // "upstream did not say" so callers can tell the two apart.
  assert.deepEqual(response.page, {
    page: 1,
    returnedCount: 1,
    discardedCount: 0,
    hasMore: false,
    nextCursor: null,
  })
  assert.equal(response.archiveObjects[1].envelopePointer, '$.data.products[0]')
})

test('JD issues a continuation when its own page counters prove another page exists', () => {
  const encodedStates = []
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '耳机' })
  const response = normalizeJustOneProductSearchResponse({
    ...jdProductSearchV1Fixture,
    data: { ...jdProductSearchV1Fixture.data, totalCount: 96, currentPage: 1, totalPages: 2 },
  }, request, {
    capturedAt: '2026-09-06T05:00:17Z',
    encodeCursor: (state) => {
      encodedStates.push(state)
      return 'opaque-jd-page-2'
    },
  })

  assert.equal(response.page.hasMore, true)
  assert.equal(response.page.nextCursor, 'opaque-jd-page-2')
  assert.deepEqual(encodedStates, [{
    version: 1, marketplace: 'jd', page: 2, scope: request.cursorScope, continuation: null,
  }])
})

test('JD page counters are ignored when they disagree with the requested page', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '耳机', page: 3 })
  const response = normalizeJustOneProductSearchResponse({
    ...jdProductSearchV1Fixture,
    data: { ...jdProductSearchV1Fixture.data, currentPage: 1, totalPages: 9 },
  }, request, {
    capturedAt: '2026-09-06T05:00:17Z',
    encodeCursor: () => assert.fail('a mismatched counter block must not issue a cursor'),
  })

  assert.equal(response.page.hasMore, null)
  assert.equal(response.page.nextCursor, null)
})

test('Taobao model.page pagination evidence cannot issue a cursor for another marketplace', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '相机' })
  const response = normalizeJustOneProductSearchResponse(envelope({
    products: [{ skuId: 'jd-1', title: '示例相机' }],
    model: { page: { pageNo: 1, totalPages: 2 } },
  }), request, {
    capturedAt: '2026-09-07T07:00:18Z',
    encodeCursor: () => 'must-not-be-issued',
  })

  assert.equal(response.page.hasMore, null)
  assert.equal(response.page.nextCursor, null)
})

test('Taobao V1 accepts the observed data.model.itemList shape and model.page pagination', () => {
  const extracted = extractJustOneProductSearchItems(taobaoProductSearchV1Fixture, 'taobao')
  assert.deepEqual(extracted.path, ['data', 'model', 'itemList'])
  assert.equal(extracted.items.length, 1)

  const encodedStates = []
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'taobao', query: '便携相机' })
  const response = normalizeJustOneProductSearchResponse(taobaoProductSearchV1Fixture, request, {
    capturedAt: '2026-09-07T07:00:18Z',
    encodeCursor: (state) => {
      encodedStates.push(state)
      return 'opaque-taobao-page-2'
    },
  })

  assert.deepEqual(response.publicBody.data.items[0], {
    id: '10001',
    marketplace: 'taobao',
    title: '脱敏便携相机',
    url: null,
    pricing: { current: '1299', original: '1399', currency: 'CNY' },
    shop: { id: '20001', name: '脱敏示例店铺' },
    images: ['https://g.search.alicdn.com/img/bao/uploaded/i4/i3/example/product.jpg'],
    signals: { sales: '860', reviewCount: '144', location: '浙江 杭州' },
    attributes: { brand: null, category: null },
  })
  assert.deepEqual(response.page, {
    page: 1,
    returnedCount: 1,
    discardedCount: 0,
    hasMore: true,
    nextCursor: 'opaque-taobao-page-2',
  })
  assert.deepEqual(encodedStates, [{
    version: 1,
    marketplace: 'taobao',
    page: 2,
    scope: request.cursorScope,
    continuation: null,
  }])
  assert.equal(response.archiveObjects[1].envelopePointer, '$.data.model.itemList[0]')
})

test('public response projects a fixed shape and drops private provider fields', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机' })
  const response = normalizeJustOneProductSearchResponse(envelope({
    items: [{
      skuId: 'jd-1',
      title: '示例手机',
      price: '3999.00',
      shop: { id: 'shop-1', name: '自营店', credential: 'nested-secret' },
      provider: 'private-provider',
      endpointId: 'private-endpoint',
      billing: { amount: 1 },
    }],
    hasMore: false,
  }), request, { capturedAt: '2026-09-03T00:00:00Z' })
  assert.deepEqual(response.publicBody.data.items[0], {
    id: 'jd-1',
    marketplace: 'jd',
    title: '示例手机',
    url: null,
    pricing: { current: '3999.00', original: null, currency: 'CNY' },
    shop: { id: 'shop-1', name: '自营店' },
    images: [],
    signals: { sales: null, reviewCount: null, location: null },
    attributes: { brand: null, category: null },
  })
  assert.doesNotMatch(JSON.stringify(response.publicBody), /provider|credential|endpoint|billing/iu)
  assert.deepEqual(response.publicBody.data.page, {
    page: 1, returnedCount: 1, discardedCount: 0, hasMore: false, nextCursor: null,
  })
})

test('every successful response keeps business evidence and removes only the exact request credential', () => {
  const secret = 'private-token'
  const raw = envelope({
    items: [],
    hasMore: false,
    token: secret,
    sessionId: 'private-session',
    sid: 'private-sid',
    sign: 'private-signature',
    callback: `https://user:pass@example.invalid/callback?session=private-session&safe=1#token=${secret}`,
  })
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机' })
  const response = normalizeJustOneProductSearchResponse(raw, request, {
    capturedAt: '2026-09-03T00:00:00Z',
    httpStatus: 200,
    bodySha256: 'a'.repeat(64),
    bodySize: 321,
    contentType: 'application/json; charset=utf-8',
    secret,
  })

  assert.equal(response.items.length, 0)
  assert.equal(response.archiveObjects.length, 1)
  const archive = response.archiveObjects[0]
  assert.equal(archive.kind, 'response')
  assert.equal(archive.rawPointer, '$')
  assert.equal(archive.payloadSha256, archive.rawPayloadSha256)
  assert.equal(archive.rawPayload, archive.rawItem)
  assert.equal(archive.bodySize, 321)
  assert.equal(archive.contentType, 'application/json; charset=utf-8')
  assert.equal(archive.contractState, 'accepted')
  assert.equal(archive.upstreamRequestId, 'upstream-request')
  assert.equal(archive.upstreamRecordTime, '2026-09-03T00:00:00Z')
  assert.equal(archive.rawPayload.response.businessCode, 0)
  assert.equal(archive.rawPayload.response.billed, true)
  assert.equal(archive.rawPayload.response.bodySha256, 'a'.repeat(64))
  assert.equal(archive.rawPayload.response.envelope.data.token, '[REDACTED]')
  assert.equal(archive.rawPayload.response.envelope.data.sessionId, 'private-session')
  assert.equal(archive.rawPayload.response.envelope.data.sid, 'private-sid')
  assert.equal(archive.rawPayload.response.envelope.data.sign, 'private-signature')
  assert.equal(
    archive.rawPayload.response.envelope.data.callback,
    'https://user:pass@example.invalid/callback?session=private-session&safe=1#token=[REDACTED]',
  )
  const serialized = JSON.stringify(archive)
  assert.doesNotMatch(serialized, /private-token/u)
  assert.match(serialized, /private-session|private-sid|private-signature|user:pass/iu)
  assert.match(serialized, /provider_call_evidence/u)
})

test('credential scrub preserves business field names, signed URL query/hash and bearer-shaped data', () => {
  const secret = 'hub-request-credential'
  const scrubbed = redactJustOnePrivateFields({
    session: 'session-value',
    sid: 'sid-value',
    signature: 'signature-value',
    cookie: 'cookie-value',
    search_id: 'search-value',
    search_session_id: 'search-session-value',
    nested: {
      authorization: 'Bearer abc.def.ghi',
      url: 'https://user:pass@example.invalid/item?X-Amz-Signature=signature-value&safe=1#sid=sid-value',
      echoedCredential: `prefix-${secret}-suffix`,
    },
    [secret]: 'credential-in-key',
  }, { secret })
  assert.deepEqual(scrubbed, {
    session: 'session-value',
    sid: 'sid-value',
    signature: 'signature-value',
    cookie: 'cookie-value',
    search_id: 'search-value',
    search_session_id: 'search-session-value',
    nested: {
      authorization: 'Bearer abc.def.ghi',
      url: 'https://user:pass@example.invalid/item?X-Amz-Signature=signature-value&safe=1#sid=sid-value',
      echoedCredential: 'prefix-[REDACTED]-suffix',
    },
    '[REDACTED]': 'credential-in-key',
  })
  assert.doesNotMatch(JSON.stringify(scrubbed), new RegExp(secret, 'u'))
})

test('credential scrub removes case-varied percent escapes and double URL encoding', () => {
  const secret = "prov/key+value space?&=!*'()"
  const formEncode = (value) => {
    const query = new URLSearchParams()
    query.set('token', value)
    return query.toString().slice('token='.length)
  }
  const lowerPercentHex = (value) => value.replace(
    /%[0-9A-F]{2}/gu,
    (escape) => escape.toLowerCase(),
  )
  const uriEncoded = lowerPercentHex(encodeURIComponent(secret))
  const formEncoded = lowerPercentHex(formEncode(secret))
  const doubleUriEncoded = lowerPercentHex(encodeURIComponent(encodeURIComponent(secret)))
  const doubleFormEncoded = lowerPercentHex(formEncode(formEncode(secret)))
  const innerLowerThenUriEncoded = encodeURIComponent(lowerPercentHex(encodeURIComponent(secret)))
  const innerLowerThenFormEncoded = formEncode(lowerPercentHex(formEncode(secret)))
  const strictEncoded = lowerPercentHex(encodeURIComponent(secret).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`,
  ))
  const scrubbed = redactJustOnePrivateFields({
    uriEncoded: `before-${uriEncoded}-after`,
    formEncoded: `before-${formEncoded}-after`,
    doubleUriEncoded: `before-${doubleUriEncoded}-after`,
    doubleFormEncoded: `before-${doubleFormEncoded}-after`,
    innerLowerThenUriEncoded: `before-${innerLowerThenUriEncoded}-after`,
    innerLowerThenFormEncoded: `before-${innerLowerThenFormEncoded}-after`,
    strictEncoded: `before-${strictEncoded}-after`,
    [doubleUriEncoded]: 'credential-in-key',
    unrelatedBusinessValue: 'https://example.invalid/item?path=%2fpublic%2Bbusiness',
  }, { secret })

  assert.deepEqual(scrubbed, {
    uriEncoded: 'before-[REDACTED]-after',
    formEncoded: 'before-[REDACTED]-after',
    doubleUriEncoded: 'before-[REDACTED]-after',
    doubleFormEncoded: 'before-[REDACTED]-after',
    innerLowerThenUriEncoded: 'before-[REDACTED]-after',
    innerLowerThenFormEncoded: 'before-[REDACTED]-after',
    strictEncoded: 'before-[REDACTED]-after',
    '[REDACTED]': 'credential-in-key',
    unrelatedBusinessValue: 'https://example.invalid/item?path=%2fpublic%2Bbusiness',
  })
})

test('URL normalization never exceeds the public 2048-character contract', () => {
  const item = normalizeJustOneProductItem({
    skuId: 'jd-long-url',
    url: `https://example.invalid/${'汉'.repeat(600)}`,
    images: [`https://example.invalid/${'图'.repeat(600)}`],
  }, 'jd')

  assert.equal(item.url, null)
  assert.deepEqual(item.images, [])
})

test('upstream request identifiers are read only from the scrubbed bounded envelope', () => {
  const secret = 'private-token-in-identifiers'
  const raw = {
    ...envelope({ items: [], hasMore: false }),
    requestId: `request-${secret}`,
    recordTime: `time-${secret}-${'x'.repeat(700)}`,
  }
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机' })
  const response = normalizeJustOneProductSearchResponse(raw, request, { secret })
  const archive = response.archiveObjects[0]
  assert.equal(archive.upstreamRequestId, 'request-[REDACTED]')
  assert.equal(archive.upstreamRecordTime.length, 512)
  assert.equal(response.upstreamEvidence.requestId, archive.upstreamRequestId)
  assert.equal(response.upstreamEvidence.recordTime, archive.upstreamRecordTime)
  assert.doesNotMatch(JSON.stringify(response), new RegExp(secret, 'u'))
})

test('all required non-zero business codes have stable, never-auto-retry classifications', () => {
  assert.deepEqual(Object.keys(JUSTONE_BUSINESS_CODES).map(Number), [100, 202, 301, 302, 303, 400, 500, 600, 601, 602])
  for (const code of [100, 202, 301, 302, 303, 400, 500, 600, 601, 602]) {
    const classification = classifyJustOneBusinessCode(code)
    assert.equal(classification.businessCode, code)
    assert.equal(classification.retryable, false)
    assert.ok(classification.errorCode)
  }
  // The provider's OpenAPI enum is wider than its documented table. An
  // undocumented code must stay unknown-but-safe rather than borrow a
  // neighbouring code's retry semantics.
  for (const code of [101, 300, 404, 503]) {
    const classification = classifyJustOneBusinessCode(code)
    assert.equal(classification.category, 'unknown')
    assert.equal(classification.errorCode, 'upstream_business_error')
    assert.equal(classification.retryable, false)
  }
  assert.deepEqual(inspectJustOneEnvelope({ ...envelope(null), code: 601 }), {
    outcome: 'rejected',
    classification: {
      businessCode: 601,
      category: 'balance',
      errorCode: 'upstream_balance_exhausted',
      retryable: false,
    },
  })
})

test('Xiaohongshu cannot claim another page without a usable continuation', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'xiaohongshu_ec', query: '面膜' })
  assert.throws(
    () => normalizeJustOneProductSearchResponse(envelope({
      items: [{ goodsId: 'xhs-1' }], hasMore: true,
    }), request),
    (error) => error instanceof JustOneResponseContractError
      && error.code === 'missing_upstream_continuation',
  )
})

test('pagination never falls back to an unsigned local cursor', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机' })
  assert.throws(
    () => normalizeJustOneProductSearchResponse(envelope({
      items: [{ skuId: 'jd-1' }], hasMore: true,
    }), request),
    (error) => error instanceof JustOneResponseContractError
      && error.code === 'cursor_codec_required',
  )
})

test('item evidence has an explicit structural bound in addition to the HTTP byte bound', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'taobao', query: 'test' })
  const item = { itemId: 'tb-1' }
  let current = item
  for (let depth = 0; depth < 40; depth += 1) {
    current.nested = {}
    current = current.nested
  }
  assert.throws(
    () => normalizeJustOneProductSearchResponse(envelope({ items: [item], hasMore: false }), request),
    (error) => error instanceof JustOneResponseContractError
      && error.code === 'upstream_payload_too_complex',
  )
})
