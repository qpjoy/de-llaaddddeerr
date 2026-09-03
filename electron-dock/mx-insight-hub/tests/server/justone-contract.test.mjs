import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
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

function envelope(data) {
  return {
    code: 0,
    message: null,
    data,
    recordTime: '2026-09-03T00:00:00Z',
    requestId: 'upstream-request',
  }
}

test('contract pins the provider, operation and four official V1 endpoint paths', () => {
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
  assert.equal(taobao.fingerprintBody.page, 2)

  const tmall = normalizeJustOneProductSearchRequest({ marketplace: 'tmall', query: '面霜' })
  assert.deepEqual(tmall.upstreamQuery, {
    keyword: '面霜', page: '1', sort: '_sale', tmall: 'true',
  })

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

test('every successful response has one full, secret-free call archive even for an empty page', () => {
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
  const serialized = JSON.stringify(archive)
  assert.doesNotMatch(serialized, /private-token|private-session|private-sid|private-signature|user:pass/iu)
  assert.match(serialized, /provider_call_evidence/u)
})

test('private scrub covers credential-like object keys, URL query, fragments, and bearer strings', () => {
  const scrubbed = redactJustOnePrivateFields({
    session: 'session-value',
    sid: 'sid-value',
    signature: 'signature-value',
    cookie: 'cookie-value',
    nested: {
      authorization: 'Bearer abc.def.ghi',
      url: 'https://user:pass@example.invalid/item?X-Amz-Signature=signature-value&safe=1#sid=sid-value',
    },
  })
  assert.deepEqual(scrubbed, {
    nested: { url: 'https://example.invalid/item?X-Amz-Signature=%5BREDACTED%5D&safe=1' },
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
  assert.deepEqual(Object.keys(JUSTONE_BUSINESS_CODES).map(Number), [100, 301, 302, 303, 400, 500, 600, 601, 602])
  for (const code of [100, 301, 302, 303, 400, 500, 600, 601, 602]) {
    const classification = classifyJustOneBusinessCode(code)
    assert.equal(classification.businessCode, code)
    assert.equal(classification.retryable, false)
    assert.ok(classification.errorCode)
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
