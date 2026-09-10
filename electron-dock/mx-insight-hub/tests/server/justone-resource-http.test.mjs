import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  JUSTONE_RESOURCE_CATALOG,
  JUSTONE_RELEASED_RESOURCES,
  justoneResourceByHubPath,
  justoneResourceEndpointKeys,
  normalizeJustOneResourceRequest,
  normalizeJustOneResourceResponse,
} from '../../server/contracts/justone-resources.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../../server/external-platforms/control-store.mjs'

const DELIVERY_MODES = ['cache_only', 'cache_first', 'refresh']

test('the request path and parameter names are the provider\'s own, unrenamed', () => {
  const detail = normalizeJustOneResourceRequest(
    'taobao-tmall.product-detail', { itemId: '778899' }, { deliveryModes: DELIVERY_MODES },
  )
  assert.equal(detail.endpointPath, '/api/taobao/get-item-detail/v7')
  assert.deepEqual(detail.upstreamQuery, { itemId: '778899' })

  const reviews = normalizeJustOneResourceRequest(
    'taobao-tmall.product-reviews', { itemId: '1', orderType: 'feedbackdate', page: 2 }, {},
  )
  assert.equal(reviews.endpointPath, '/api/taobao/get-item-comment/v3')
  assert.deepEqual(reviews.upstreamQuery, { itemId: '1', orderType: 'feedbackdate', page: 2 })

  const questions = normalizeJustOneResourceRequest(
    'taobao-tmall.product-questions', { itemId: '1' }, {},
  )
  assert.equal(questions.endpointPath, '/api/taobao/get-social-feed/v1')
  assert.deepEqual(questions.upstreamQuery, { itemId: '1', page: 1 })
})

test('each shop-list version keeps its own required identifier', () => {
  assert.deepEqual(
    normalizeJustOneResourceRequest('taobao-tmall.shop-products', { sellerId: 'S1' }, {}).upstreamQuery,
    { sellerId: 'S1', page: 1 },
  )
  assert.deepEqual(
    normalizeJustOneResourceRequest('taobao-tmall.shop-products', { version: 'v1', userId: 'U1' }, {}).upstreamQuery,
    { userId: 'U1', page: 1 },
  )
  assert.deepEqual(
    normalizeJustOneResourceRequest('taobao-tmall.shop-products', { version: 'v2', userId: 'U1', shopId: 'P1' }, {}).upstreamQuery,
    { userId: 'U1', shopId: 'P1', page: 1 },
  )
  // v4 identifies the shop by sellerId, so userId is not a field it accepts.
  assert.throws(
    () => normalizeJustOneResourceRequest('taobao-tmall.shop-products', { version: 'v4', userId: 'U1' }, {}),
    (error) => error.code === 'unsupported_request_field',
  )
  assert.throws(
    () => normalizeJustOneResourceRequest('taobao-tmall.shop-products', { version: 'v2', userId: 'U1' }, {}),
    (error) => error.code === 'invalid_shopId',
  )
})

test('the registry is a closed surface: unknown fields, versions and resources are refused', () => {
  assert.throws(
    () => normalizeJustOneResourceRequest('taobao-tmall.product-detail', { itemId: '1', token: 'leak' }, {}),
    (error) => error.code === 'unsupported_request_field',
  )
  assert.throws(
    () => normalizeJustOneResourceRequest('taobao-tmall.product-detail', { itemId: '1', version: 'v2' }, {}),
    (error) => error.code === 'unsupported_version',
  )
  assert.throws(
    () => normalizeJustOneResourceRequest('taobao-tmall.product-detail', { itemId: '../../etc/passwd' }, {}),
    (error) => error.code === 'invalid_itemId',
  )
  // Declared extension room is not reachable until a reviewed release.
  assert.equal(JUSTONE_RESOURCE_CATALOG['jd.product-detail'].released, false)
  assert.throws(
    () => normalizeJustOneResourceRequest('jd.product-detail', { itemId: '1' }, {}),
    (error) => error.code === 'unsupported_resource',
  )
})

test('delivery mode is validated but stays out of the request identity', () => {
  const a = normalizeJustOneResourceRequest(
    'taobao-tmall.product-detail', { itemId: '1', deliveryMode: 'refresh' }, { deliveryModes: DELIVERY_MODES },
  )
  const b = normalizeJustOneResourceRequest(
    'taobao-tmall.product-detail', { itemId: '1', deliveryMode: 'cache_only' }, { deliveryModes: DELIVERY_MODES },
  )
  assert.notEqual(a.deliveryMode, b.deliveryMode)
  assert.deepEqual(a.fingerprintBody, b.fingerprintBody)

  assert.throws(
    () => normalizeJustOneResourceRequest(
      'taobao-tmall.product-detail', { itemId: '1', deliveryMode: 'live' }, { deliveryModes: DELIVERY_MODES },
    ),
    (error) => error.code === 'invalid_delivery_mode',
  )
})

test('a different upstream version is a different logical request', () => {
  const v7 = normalizeJustOneResourceRequest('taobao-tmall.product-detail', { itemId: '1' }, {})
  const v9 = normalizeJustOneResourceRequest('taobao-tmall.product-detail', { itemId: '1', version: 'v9' }, {})
  assert.notDeepEqual(v7.fingerprintBody, v9.fingerprintBody)
})

test('the response carries the provider payload unrenamed inside the Hub envelope', () => {
  const request = normalizeJustOneResourceRequest('taobao-tmall.product-reviews', { itemId: '1', page: 3 }, {})
  const upstream = {
    code: 0,
    message: null,
    recordTime: '2026-09-11T00:00:00Z',
    data: { commentList: [{ content: '很好', skuInfo: '红色' }], paginator: { lastPage: 9 } },
  }
  const { publicBody, archiveObject } = normalizeJustOneResourceResponse(upstream, request, {
    capturedAt: new Date('2026-09-11T01:00:00Z'),
  })

  assert.deepEqual(publicBody.data, upstream.data)
  assert.equal(publicBody.contractVersion, 'mx-insight-hub.ecommerce-resource.v1')
  assert.deepEqual(publicBody.resource, { key: 'taobao-tmall.product-reviews', version: 'v3', page: 3 })
  assert.equal(publicBody.meta.capturedAt, '2026-09-11T01:00:00.000Z')
  assert.equal(archiveObject.envelopePointer, '$.data')
})

test('an envelope without data is refused rather than delivered as an empty payload', () => {
  const request = normalizeJustOneResourceRequest('taobao-tmall.product-detail', { itemId: '1' }, {})
  assert.throws(
    () => normalizeJustOneResourceResponse({ code: 0, message: null, recordTime: null }, request),
    (error) => error.code === 'invalid_upstream_envelope',
  )
})

test('every released resource is routable and priced through its own operation', () => {
  const justone = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone
  for (const resource of JUSTONE_RELEASED_RESOURCES) {
    assert.equal(justoneResourceByHubPath(resource.hubPath)?.resourceKey, resource.resourceKey)

    const operation = justone.find((entry) => entry.operationKey === resource.operationKey)
    assert.ok(operation, `${resource.operationKey} must exist in the control-plane catalog`)
    assert.ok(
      operation.endpointKeys.includes(resource.endpointKey),
      `${resource.endpointKey} must be priced under ${resource.operationKey}`,
    )
    assert.deepEqual(justoneResourceEndpointKeys(resource.operationKey), operation.endpointKeys)
  }
})

test('unreleased resources claim no route and no endpoint price', () => {
  const releasedKeys = new Set(JUSTONE_RELEASED_RESOURCES.map((entry) => entry.resourceKey))
  const pricedKeys = new Set(EXTERNAL_PLATFORM_OPERATION_CATALOG.justone.flatMap((entry) => entry.endpointKeys))

  for (const resource of Object.values(JUSTONE_RESOURCE_CATALOG)) {
    if (releasedKeys.has(resource.resourceKey)) continue
    assert.equal(justoneResourceByHubPath(resource.hubPath), null)
    assert.equal(
      pricedKeys.has(resource.endpointKey),
      false,
      `${resource.endpointKey} is unreleased and must not demand a price`,
    )
  }
})
