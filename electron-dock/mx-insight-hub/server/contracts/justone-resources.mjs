// Declarative registry for the JustOne resources beyond product search.
//
// Product search normalizes into a Hub-owned item schema because its response
// shape is pinned by reviewed fixtures. The remaining resources cannot be
// treated that way: the provider's own OpenAPI types `data` as `{}` and its
// published examples load client-side, so there is no documented shape to pin.
// Inventing a Hub schema for them would mean guessing field names and silently
// dropping whatever the guess missed.
//
// These resources therefore use the platform-shaped contract: the request path
// and parameter names are the provider's own, and the response carries the
// provider's own `data` field names, bounded and credential-redacted, inside
// Hub's envelope (contractVersion / meta / requestId). Callers read the
// provider's documentation for the payload and Hub's contract for delivery,
// freshness and degradation.
//
// Adding a resource is a data change here plus a reviewed migration that
// releases its endpoint key with a price. Nothing in the extractor is
// per-marketplace, so a new platform does not touch the dispatch path.

import { JustOneContractError, JustOneResponseContractError } from './justone.mjs'

export const JUSTONE_RESOURCE_CONTRACT_VERSION = 'mx-insight-hub.ecommerce-resource.v1'

const MAX_ID_LENGTH = 64
const MAX_ENUM_LENGTH = 40
const MAX_PAGE = 1_000

// Parameter kinds are closed. A resource cannot introduce an ad-hoc validator,
// which is what keeps this registry from becoming an arbitrary query proxy.
const PARAM_KINDS = Object.freeze({
  id: (value, param) => {
    if (typeof value !== 'string') throw invalid(param.name, 'must be a string')
    const trimmed = value.trim()
    if (!trimmed) throw invalid(param.name, 'must not be empty')
    if (trimmed.length > MAX_ID_LENGTH) throw invalid(param.name, `must be at most ${MAX_ID_LENGTH} characters`)
    // Upstream identifiers are opaque, but they are interpolated into a query
    // string, so the character set stays deliberately narrow.
    if (!/^[A-Za-z0-9_:.-]+$/u.test(trimmed)) throw invalid(param.name, 'contains unsupported characters')
    return trimmed
  },
  page: (value, param) => {
    if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
      throw invalid(param.name, `must be an integer between 1 and ${MAX_PAGE}`)
    }
    return value
  },
  enum: (value, param) => {
    if (typeof value !== 'string') throw invalid(param.name, 'must be a string')
    const trimmed = value.trim()
    if (trimmed.length > MAX_ENUM_LENGTH || !param.values.includes(trimmed)) {
      throw invalid(param.name, `must be one of ${param.values.join(', ')}`)
    }
    return trimmed
  },
})

function invalid(name, detail) {
  return new JustOneContractError(`invalid_${name}`, `${name} ${detail}`)
}

function param(name, kind, { required = false, values = null, defaultValue = null } = {}) {
  return Object.freeze({ name, kind, required, values: values ? Object.freeze([...values]) : null, defaultValue })
}

function variant({ version, params, upstreamPath }) {
  return Object.freeze({ version, params: Object.freeze(params), upstreamPath })
}

function resource({
  resourceKey,
  operationKey,
  endpointKey,
  label,
  hubPath,
  marketplaces,
  variants,
  defaultVersion,
  paged = false,
  released = true,
}) {
  // Provider-call evidence is grouped by marketplace, and the upstream endpoint
  // belongs to a marketplace family rather than to one storefront: a Tmall item
  // is served by the Taobao endpoint, exactly as product search shares one
  // endpoint key across both. The family's primary name is that label.
  const marketplace = marketplaces[0]
  const byVersion = new Map(variants.map((entry) => [entry.version, entry]))
  if (!byVersion.has(defaultVersion)) {
    throw new TypeError(`${resourceKey}: defaultVersion ${defaultVersion} has no variant`)
  }
  return Object.freeze({
    resourceKey,
    operationKey,
    endpointKey,
    label,
    hubPath,
    marketplace,
    marketplaces: Object.freeze([...marketplaces]),
    versions: Object.freeze(variants.map((entry) => entry.version)),
    defaultVersion,
    paged,
    // A resource that is declared but not released is extension room: it is
    // visible to reviewers and tests, and it demands no price, no migration and
    // no tenant grant until a reviewed release turns it on.
    released,
    variantFor(version) {
      const entry = byVersion.get(version)
      if (!entry) {
        throw new JustOneContractError(
          'unsupported_version',
          `version must be one of ${[...byVersion.keys()].join(', ')}`,
        )
      }
      return entry
    },
  })
}

const TAOBAO_MARKETPLACES = ['taobao', 'tmall']
const TAOBAO_SHOP_SORTS = ['default', 'sale', 'price_asc', 'price_desc', 'newest']

export const JUSTONE_RESOURCE_CATALOG = Object.freeze({
  'taobao-tmall.product-detail': resource({
    resourceKey: 'taobao-tmall.product-detail',
    operationKey: 'ecommerce.products.detail',
    endpointKey: 'taobao-tmall.product-detail.v1',
    label: '淘宝天猫商品详情',
    hubPath: '/api/v1/data/ecommerce/taobao/product-detail',
    marketplaces: TAOBAO_MARKETPLACES,
    // V2 is the asynchronous console workflow and V6/V8 are not part of the
    // reviewed synchronous surface, so neither is reachable from Hub.
    defaultVersion: 'v7',
    variants: [
      variant({ version: 'v1', upstreamPath: '/api/taobao/get-item-detail/v1', params: [param('itemId', 'id', { required: true })] }),
      variant({ version: 'v3', upstreamPath: '/api/taobao/get-item-detail/v3', params: [param('itemId', 'id', { required: true })] }),
      variant({ version: 'v4', upstreamPath: '/api/taobao/get-item-detail/v4', params: [param('itemId', 'id', { required: true })] }),
      variant({ version: 'v5', upstreamPath: '/api/taobao/get-item-detail/v5', params: [param('itemId', 'id', { required: true })] }),
      variant({ version: 'v7', upstreamPath: '/api/taobao/get-item-detail/v7', params: [param('itemId', 'id', { required: true })] }),
      variant({ version: 'v9', upstreamPath: '/api/taobao/get-item-detail/v9', params: [param('itemId', 'id', { required: true })] }),
    ],
  }),

  'taobao-tmall.product-reviews': resource({
    resourceKey: 'taobao-tmall.product-reviews',
    operationKey: 'ecommerce.products.reviews',
    endpointKey: 'taobao-tmall.product-reviews.v1',
    label: '淘宝天猫商品评价',
    hubPath: '/api/v1/data/ecommerce/taobao/product-reviews',
    marketplaces: TAOBAO_MARKETPLACES,
    defaultVersion: 'v3',
    paged: true,
    variants: [
      variant({
        version: 'v3',
        upstreamPath: '/api/taobao/get-item-comment/v3',
        params: [
          param('itemId', 'id', { required: true }),
          param('orderType', 'enum', { values: ['general', 'feedbackdate'] }),
          param('page', 'page', { defaultValue: 1 }),
        ],
      }),
    ],
  }),

  'taobao-tmall.product-questions': resource({
    resourceKey: 'taobao-tmall.product-questions',
    operationKey: 'ecommerce.products.questions',
    endpointKey: 'taobao-tmall.product-questions.v1',
    label: '淘宝天猫商品问答',
    hubPath: '/api/v1/data/ecommerce/taobao/product-questions',
    marketplaces: TAOBAO_MARKETPLACES,
    defaultVersion: 'v1',
    paged: true,
    variants: [
      variant({
        version: 'v1',
        upstreamPath: '/api/taobao/get-social-feed/v1',
        params: [
          param('itemId', 'id', { required: true }),
          param('page', 'page', { defaultValue: 1 }),
        ],
      }),
    ],
  }),

  'taobao-tmall.shop-products': resource({
    resourceKey: 'taobao-tmall.shop-products',
    operationKey: 'ecommerce.shops.products',
    endpointKey: 'taobao-tmall.shop-products.v1',
    label: '淘宝天猫店铺商品列表',
    hubPath: '/api/v1/data/ecommerce/taobao/shop-products',
    marketplaces: TAOBAO_MARKETPLACES,
    // The three upstream versions identify a shop by different fields, which is
    // why parameters are declared per version rather than per resource.
    defaultVersion: 'v4',
    paged: true,
    variants: [
      variant({
        version: 'v1',
        upstreamPath: '/api/taobao/get-shop-item-list/v1',
        params: [
          param('userId', 'id', { required: true }),
          param('sort', 'enum', { values: TAOBAO_SHOP_SORTS }),
          param('page', 'page', { defaultValue: 1 }),
        ],
      }),
      variant({
        version: 'v2',
        upstreamPath: '/api/taobao/get-shop-item-list/v2',
        params: [
          param('userId', 'id', { required: true }),
          param('shopId', 'id', { required: true }),
          param('sort', 'enum', { values: TAOBAO_SHOP_SORTS }),
          param('page', 'page', { defaultValue: 1 }),
        ],
      }),
      variant({
        version: 'v4',
        upstreamPath: '/api/taobao/get-shop-item-list/v4',
        params: [
          param('sellerId', 'id', { required: true }),
          param('page', 'page', { defaultValue: 1 }),
        ],
      }),
    ],
  }),

  // ---- extension room -------------------------------------------------
  // Declared, reviewed against the provider's catalog, and deliberately not
  // released. Releasing one is a migration that adds its endpoint key with a
  // price, plus a route line -- no change to validation or dispatch.
  'jd.product-detail': resource({
    resourceKey: 'jd.product-detail',
    operationKey: 'ecommerce.products.detail',
    endpointKey: 'jd.product-detail.v1',
    label: '京东商品详情',
    hubPath: '/api/v1/data/ecommerce/jd/product-detail',
    marketplaces: ['jd'],
    defaultVersion: 'v4',
    released: false,
    variants: [
      variant({ version: 'v1', upstreamPath: '/api/jd/get-item-detail/v1', params: [param('itemId', 'id', { required: true })] }),
      variant({ version: 'v3', upstreamPath: '/api/jd/get-item-detail/v3', params: [param('itemId', 'id', { required: true })] }),
      variant({ version: 'v4', upstreamPath: '/api/jd/get-item-detail/v4', params: [param('itemId', 'id', { required: true })] }),
    ],
  }),

  'jd.product-reviews': resource({
    resourceKey: 'jd.product-reviews',
    operationKey: 'ecommerce.products.reviews',
    endpointKey: 'jd.product-reviews.v1',
    label: '京东商品评价',
    hubPath: '/api/v1/data/ecommerce/jd/product-reviews',
    marketplaces: ['jd'],
    defaultVersion: 'v2',
    paged: true,
    released: false,
    variants: [
      variant({
        version: 'v1',
        upstreamPath: '/api/jd/get-item-comments/v1',
        params: [param('itemId', 'id', { required: true }), param('page', 'page', { defaultValue: 1 })],
      }),
      variant({
        version: 'v2',
        upstreamPath: '/api/jd/get-item-comments/v2',
        params: [param('itemId', 'id', { required: true }), param('page', 'page', { defaultValue: 1 })],
      }),
    ],
  }),

  'jd.shop-products': resource({
    resourceKey: 'jd.shop-products',
    operationKey: 'ecommerce.shops.products',
    endpointKey: 'jd.shop-products.v1',
    label: '京东店铺商品列表',
    hubPath: '/api/v1/data/ecommerce/jd/shop-products',
    marketplaces: ['jd'],
    defaultVersion: 'v1',
    paged: true,
    released: false,
    variants: [
      variant({
        version: 'v1',
        upstreamPath: '/api/jd/get-shop-item-list/v1',
        params: [param('shopId', 'id', { required: true }), param('page', 'page', { defaultValue: 1 })],
      }),
    ],
  }),

  'xianyu.product-detail': resource({
    resourceKey: 'xianyu.product-detail',
    operationKey: 'ecommerce.products.detail',
    endpointKey: 'xianyu.product-detail.v1',
    label: '闲鱼商品详情',
    hubPath: '/api/v1/data/ecommerce/xianyu/product-detail',
    marketplaces: ['xianyu'],
    defaultVersion: 'v1',
    released: false,
    variants: [
      variant({ version: 'v1', upstreamPath: '/api/xianyu/get-item-detail/v1', params: [param('itemId', 'id', { required: true })] }),
    ],
  }),
})

export const JUSTONE_RELEASED_RESOURCES = Object.freeze(
  Object.values(JUSTONE_RESOURCE_CATALOG).filter((entry) => entry.released),
)

// The control plane prices per endpoint key, so an operation's key set must be
// derived from the same registry the dispatcher reads. Deriving it by hand is
// how an operation ends up permanently `blocked` on an endpoint nobody priced.
export function justoneResourceEndpointKeys(operationKey) {
  return Object.freeze([...new Set(
    JUSTONE_RELEASED_RESOURCES
      .filter((entry) => entry.operationKey === operationKey)
      .map((entry) => entry.endpointKey),
  )])
}

// Every distinct operation key a released resource dispatches under. Consumers
// of this list (capability catalog, control plane, docs) stay in step with the
// registry automatically.
export const JUSTONE_RESOURCE_OPERATION_KEYS = Object.freeze([...new Set(
  JUSTONE_RELEASED_RESOURCES.map((entry) => entry.operationKey),
)])

export function justoneResourceOperations() {
  const operations = new Map()
  for (const entry of JUSTONE_RELEASED_RESOURCES) {
    if (!operations.has(entry.operationKey)) operations.set(entry.operationKey, [])
    operations.get(entry.operationKey).push(entry)
  }
  return operations
}

export function justoneResourceByHubPath(hubPath) {
  return Object.values(JUSTONE_RESOURCE_CATALOG).find(
    (entry) => entry.released && entry.hubPath === hubPath,
  ) || null
}

function resourceFor(resourceKey) {
  const entry = JUSTONE_RESOURCE_CATALOG[resourceKey]
  if (!entry) throw new JustOneContractError('unsupported_resource', 'resource is not supported')
  if (!entry.released) throw new JustOneContractError('unsupported_resource', 'resource is not released')
  return entry
}

export function normalizeJustOneResourceRequest(resourceKey, body, { deliveryModes } = {}) {
  const entry = resourceFor(resourceKey)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new JustOneContractError('invalid_request', 'request body must be an object')
  }

  const version = body.version === undefined || body.version === null || body.version === ''
    ? entry.defaultVersion
    : body.version
  if (typeof version !== 'string') throw invalid('version', 'must be a string')
  const chosen = entry.variantFor(version)

  const allowed = new Set(['version', 'deliveryMode', ...chosen.params.map((entry_) => entry_.name)])
  const unknown = Object.keys(body).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new JustOneContractError('unsupported_request_field', `unsupported request field: ${unknown[0]}`)
  }

  let deliveryMode = null
  if (Array.isArray(deliveryModes)) {
    deliveryMode = body.deliveryMode === undefined || body.deliveryMode === null || body.deliveryMode === ''
      ? 'cache_first'
      : body.deliveryMode
    if (!deliveryModes.includes(deliveryMode)) {
      throw new JustOneContractError('invalid_delivery_mode', `deliveryMode must be ${deliveryModes.join(', ')}`)
    }
  }

  const upstreamQuery = {}
  const fingerprintParams = {}
  for (const declared of chosen.params) {
    const supplied = body[declared.name]
    if (supplied === undefined || supplied === null || supplied === '') {
      if (declared.required) throw invalid(declared.name, 'is required')
      if (declared.defaultValue === null) continue
      upstreamQuery[declared.name] = declared.defaultValue
      fingerprintParams[declared.name] = declared.defaultValue
      continue
    }
    const value = PARAM_KINDS[declared.kind](supplied, declared)
    upstreamQuery[declared.name] = value
    fingerprintParams[declared.name] = value
  }

  return Object.freeze({
    contractVersion: JUSTONE_RESOURCE_CONTRACT_VERSION,
    resourceKey: entry.resourceKey,
    operation: entry.operationKey,
    endpointKey: entry.endpointKey,
    endpointContractVersion: JUSTONE_RESOURCE_CONTRACT_VERSION,
    label: entry.label,
    version: chosen.version,
    // Named to match the product-search request so one dispatch path can read
    // either without knowing which contract produced it.
    endpointVersion: chosen.version,
    marketplace: entry.marketplace,
    endpointPath: chosen.upstreamPath,
    paged: entry.paged,
    page: Number.isInteger(fingerprintParams.page) ? fingerprintParams.page : null,
    deliveryMode,
    upstreamQuery: Object.freeze({ ...upstreamQuery }),
    // Delivery mode is a freshness preference, not part of the logical request
    // identity, so it stays out of the fingerprint exactly as product search
    // keeps it out of its own.
    fingerprintBody: Object.freeze({
      contractVersion: JUSTONE_RESOURCE_CONTRACT_VERSION,
      resourceKey: entry.resourceKey,
      version: chosen.version,
      params: Object.freeze({ ...fingerprintParams }),
    }),
  })
}

export function buildJustOneResourceDispatch(resourceKey, body, options) {
  const request = normalizeJustOneResourceRequest(resourceKey, body, options)
  return Object.freeze({
    request,
    method: 'GET',
    path: request.endpointPath,
    query: request.upstreamQuery,
  })
}

// The provider's payload is passed through under its own field names, so the
// only transformations here are safety ones: structural bounds, and the
// caller-visible envelope. Credential redaction happens in the adapter, which
// is the layer that knows the secret.
export function normalizeJustOneResourceResponse(raw, request, {
  capturedAt = new Date(),
  assertBounded,
} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new JustOneResponseContractError('invalid_upstream_envelope', 'upstream response must be an object')
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'data')) {
    throw new JustOneResponseContractError('invalid_upstream_envelope', 'upstream response has no data field')
  }
  if (typeof assertBounded === 'function') assertBounded(raw.data)

  const captured = capturedAt instanceof Date ? capturedAt : new Date(capturedAt)
  if (Number.isNaN(captured.getTime())) {
    throw new JustOneResponseContractError('invalid_captured_at', 'capturedAt must be a valid timestamp')
  }

  const publicBody = {
    contractVersion: JUSTONE_RESOURCE_CONTRACT_VERSION,
    resource: {
      key: request.resourceKey,
      version: request.version,
      ...(request.paged ? { page: request.page } : {}),
    },
    // Provider field names, unrenamed. The provider's own documentation is the
    // schema for this object; Hub does not narrow or rename it, because any
    // narrowing would silently drop fields nobody reviewed.
    data: raw.data,
    meta: { capturedAt: captured.toISOString() },
  }

  return Object.freeze({
    publicBody,
    // One archive object per delivery: the payload is not a list of independently
    // addressable items under any documented contract, so splitting it would
    // invent an item identity that the provider never promised.
    archiveObject: Object.freeze({
      resourceKey: request.resourceKey,
      endpointKey: request.endpointKey,
      endpointVersion: request.version,
      envelopePointer: '$.data',
      payload: raw.data,
    }),
  })
}
