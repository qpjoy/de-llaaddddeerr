import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { AppError } from '../../server/core/errors.mjs'
import {
  createExternalImageLoader,
  externalImageAddressAllowed,
} from '../../server/external-platforms/media.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PUBLIC_IPV4 = '93.184.216.34'

function imageChunk(type, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

function pngImage(width = 16, height = 12, { animated = false, payloadBytes = 0 } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    imageChunk('IHDR', ihdr),
    ...(animated ? [imageChunk('acTL', Buffer.alloc(8))] : []),
    ...(payloadBytes > 0 ? [imageChunk('IDAT', Buffer.alloc(payloadBytes))] : []),
    imageChunk('IEND'),
  ])
}

function jpegImage(width = 16, height = 12) {
  const frame = Buffer.alloc(17)
  frame.writeUInt16BE(frame.length, 0)
  frame[2] = 8
  frame.writeUInt16BE(height, 3)
  frame.writeUInt16BE(width, 5)
  frame[7] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), frame])
}

function webpImage(width = 16, height = 12, { animated = false } = {}) {
  const image = Buffer.alloc(30)
  image.write('RIFF', 0, 4, 'ascii')
  image.writeUInt32LE(22, 4)
  image.write('WEBP', 8, 4, 'ascii')
  image.write('VP8X', 12, 4, 'ascii')
  image.writeUInt32LE(10, 16)
  image[20] = animated ? 0x02 : 0
  image.writeUIntLE(width - 1, 24, 3)
  image.writeUIntLE(height - 1, 27, 3)
  return image
}

function webpLosslessImage(width = 16, height = 12, {
  animationChunk = false,
  ancillaryChunks = 0,
} = {}) {
  const widthMinusOne = width - 1
  const heightMinusOne = height - 1
  const lossless = Buffer.alloc(5)
  lossless[0] = 0x2f
  lossless[1] = widthMinusOne & 0xff
  lossless[2] = ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6)
  lossless[3] = (heightMinusOne >> 2) & 0xff
  lossless[4] = (heightMinusOne >> 10) & 0x0f
  const chunks = [webpChunk('VP8L', lossless)]
  if (animationChunk) chunks.push(webpChunk('ANIM', Buffer.alloc(6)))
  for (let index = 0; index < ancillaryChunks; index += 1) {
    chunks.push(webpChunk('JUNK', Buffer.alloc(0)))
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 4, 'ascii')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WEBP', 8, 4, 'ascii')
  return Buffer.concat([header, body])
}

function webpChunk(type, data) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32LE(data.length, 4)
  return Buffer.concat([header, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])])
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function bodyOf(...chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    async dump() {},
  }
}

function response({ statusCode = 200, contentType = 'image/png', contentLength, location, body }) {
  return {
    statusCode,
    headers: {
      ...(contentType == null ? {} : { 'content-type': contentType }),
      ...(contentLength == null ? {} : { 'content-length': String(contentLength) }),
      ...(location == null ? {} : { location }),
    },
    body: body || bodyOf(),
  }
}

function publicLookup(calls = []) {
  return async (hostname, options) => {
    calls.push({ hostname, options })
    return [{ address: PUBLIC_IPV4, family: 4 }]
  }
}

function noAgent() {
  return null
}

async function rejectsMedia(action, { status, code }) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    return true
  })
}

test('external image loader rejects HTTP, localhost and private targets before dispatch', async () => {
  const requests = []
  const lookup = async (hostname) => {
    if (hostname === 'private.example.test') return [{ address: '10.24.0.8', family: 4 }]
    throw new Error(`unexpected lookup for ${hostname}`)
  }
  const loader = createExternalImageLoader({
    lookup,
    request: async (url) => {
      requests.push(String(url))
      return response({})
    },
    agentFactory: noAgent,
  })

  await rejectsMedia(() => loader('http://images.example.test/a.png'), {
    status: 422,
    code: 'external_media_url_blocked',
  })
  await rejectsMedia(() => loader('https://localhost/a.png'), {
    status: 422,
    code: 'external_media_url_blocked',
  })
  await rejectsMedia(() => loader('https://127.0.0.1/a.png'), {
    status: 422,
    code: 'external_media_host_blocked',
  })
  await rejectsMedia(() => loader('https://private.example.test/a.png'), {
    status: 422,
    code: 'external_media_host_blocked',
  })
  assert.equal(requests.length, 0)
  assert.equal(externalImageAddressAllowed('192.168.1.10', 4), false)
  assert.equal(externalImageAddressAllowed('::1', 6), false)
  assert.equal(externalImageAddressAllowed(PUBLIC_IPV4, 4), true)
})

test('external image loader accepts bounded JPEG, PNG and WebP images', async (t) => {
  for (const [name, contentType, image] of [
    ['JPEG', 'image/jpeg', jpegImage()],
    ['PNG', 'image/png', pngImage()],
    ['WebP', 'image/webp', webpImage()],
    ['WebP-Lossless', 'image/webp', webpLosslessImage()],
  ]) {
    await t.test(name, async () => {
      const lookupCalls = []
      const requestCalls = []
      const loader = createExternalImageLoader({
        lookup: publicLookup(lookupCalls),
        request: async (url, options) => {
          requestCalls.push({ url: String(url), options })
          return response({
            contentType: `${contentType}; charset=binary`,
            body: bodyOf(image.subarray(0, 5), image.subarray(5)),
          })
        },
        agentFactory: noAgent,
      })

      const loaded = await loader(`https://images.example.test/product-${name.toLowerCase()}#ignored`)
      assert.equal(loaded.contentType, contentType)
      assert.deepEqual(loaded.body, image)
      assert.deepEqual(lookupCalls.map(({ hostname }) => hostname), ['images.example.test'])
      assert.equal(requestCalls.length, 1)
      assert.equal(requestCalls[0].url, `https://images.example.test/product-${name.toLowerCase()}`)
      assert.equal(requestCalls[0].options.method, 'GET')
      assert.equal(requestCalls[0].options.maxRedirections, 0)
    })
  }
})

test('external image loader canonicalizes legacy Alibaba search image hosts before dispatch', async () => {
  const lookupCalls = []
  const requestCalls = []
  const loader = createExternalImageLoader({
    lookup: publicLookup(lookupCalls),
    request: async (url) => {
      requestCalls.push(String(url))
      return response({ body: bodyOf(pngImage()) })
    },
    agentFactory: noAgent,
  })

  for (const [source, expected] of [
    ['g.search.alicdn.com', 'g-search1.alicdn.com'],
    ['g.search1.alicdn.com', 'g-search1.alicdn.com'],
    ['g.search2.alicdn.com', 'g-search2.alicdn.com'],
    ['g.search3.alicdn.com', 'g-search3.alicdn.com'],
  ]) {
    await loader(`https://${source}/img/bao/uploaded/product.png?quality=90#ignored`)
    assert.equal(lookupCalls.at(-1).hostname, expected)
    assert.equal(
      requestCalls.at(-1),
      `https://${expected}/img/bao/uploaded/product.png?quality=90`,
    )
  }
})

test('external image loader blocks IPv6 transition and NAT64 targets before dispatch', async () => {
  const blocked = [
    '::7f00:1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::7f00:1',
    '2001::1',
    '2002:7f00:1::',
    'fec0::1',
  ]
  for (const address of blocked) assert.equal(externalImageAddressAllowed(address, 6), false, address)
  assert.equal(externalImageAddressAllowed('2606:2800:220:1:248:1893:25c8:1946', 6), true)

  const requests = []
  const loader = createExternalImageLoader({
    lookup: async () => {
      throw new Error('IP literals must not reach DNS')
    },
    request: async (url) => {
      requests.push(String(url))
      return response({ body: bodyOf(pngImage()) })
    },
    agentFactory: noAgent,
  })
  for (const address of ['64:ff9b::7f00:1', '64:ff9b:1::7f00:1', '2002:7f00:1::']) {
    await rejectsMedia(() => loader(`https://[${address}]/product.png`), {
      status: 422,
      code: 'external_media_host_blocked',
    })
  }
  assert.equal(requests.length, 0)
})

test('external image loader bounds DNS resolution with its deadline', async () => {
  let requestCount = 0
  const loader = createExternalImageLoader({
    lookup: async () => new Promise(() => {}),
    request: async () => {
      requestCount += 1
      return response({ body: bodyOf(pngImage()) })
    },
    timeoutMs: 10,
    agentFactory: noAgent,
  })
  let watchdog
  try {
    await Promise.race([
      rejectsMedia(() => loader('https://slow-dns.example.test/product.png'), {
        status: 504,
        code: 'external_media_timeout',
      }),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('DNS deadline did not settle')), 500)
      }),
    ])
  } finally {
    clearTimeout(watchdog)
  }
  assert.equal(requestCount, 0)
})

test('external image loader revalidates a redirect target and never dispatches to its private address', async () => {
  const lookupCalls = []
  const requestCalls = []
  const loader = createExternalImageLoader({
    lookup: async (hostname, options) => {
      lookupCalls.push({ hostname, options })
      if (hostname === 'images.example.test') return [{ address: PUBLIC_IPV4, family: 4 }]
      if (hostname === 'redirected.example.test') return [{ address: '169.254.169.254', family: 4 }]
      throw new Error(`unexpected lookup for ${hostname}`)
    },
    request: async (url) => {
      requestCalls.push(String(url))
      return response({
        statusCode: 302,
        contentType: null,
        location: 'https://redirected.example.test/latest.png',
      })
    },
    agentFactory: noAgent,
  })

  await rejectsMedia(() => loader('https://images.example.test/product.png'), {
    status: 422,
    code: 'external_media_host_blocked',
  })
  assert.deepEqual(lookupCalls.map(({ hostname }) => hostname), [
    'images.example.test',
    'redirected.example.test',
  ])
  assert.deepEqual(requestCalls, ['https://images.example.test/product.png'])
})

test('external image loader rejects oversized, non-image and forged image responses', async (t) => {
  await t.test('declared body exceeds the byte limit', async () => {
    const loader = createExternalImageLoader({
      lookup: publicLookup(),
      request: async () => response({ contentLength: 33 }),
      maxBytes: 32,
      agentFactory: noAgent,
    })
    await rejectsMedia(() => loader('https://images.example.test/large.png'), {
      status: 413,
      code: 'external_media_too_large',
    })
  })

  await t.test('streamed body exceeds the byte limit without a content-length header', async () => {
    const loader = createExternalImageLoader({
      lookup: publicLookup(),
      request: async () => response({
        contentType: 'image/png',
        body: bodyOf(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          Buffer.alloc(25),
        ),
      }),
      maxBytes: 32,
      agentFactory: noAgent,
    })
    await rejectsMedia(() => loader('https://images.example.test/chunked-large.png'), {
      status: 413,
      code: 'external_media_too_large',
    })
  })

  await t.test('declared MIME is not an allowed image type', async () => {
    const loader = createExternalImageLoader({
      lookup: publicLookup(),
      request: async () => response({ contentType: 'text/html', body: bodyOf(Buffer.from('<html>')) }),
      agentFactory: noAgent,
    })
    await rejectsMedia(() => loader('https://images.example.test/not-image'), {
      status: 415,
      code: 'external_media_type_rejected',
    })
  })

  for (const contentType of ['image/gif', 'image/avif']) {
    await t.test(`${contentType} is not in the safe raster set`, async () => {
      const loader = createExternalImageLoader({
        lookup: publicLookup(),
        request: async () => response({ contentType, body: bodyOf(Buffer.alloc(32)) }),
        agentFactory: noAgent,
      })
      await rejectsMedia(() => loader(`https://images.example.test/unsupported-${contentType.slice(6)}`), {
        status: 415,
        code: 'external_media_type_rejected',
      })
    })
  }

  await t.test('payload magic does not match the declared image MIME', async () => {
    const loader = createExternalImageLoader({
      lookup: publicLookup(),
      request: async () => response({ contentType: 'image/png', body: bodyOf(Buffer.from('<html>not png</html>')) }),
      agentFactory: noAgent,
    })
    await rejectsMedia(() => loader('https://images.example.test/forged.png'), {
      status: 415,
      code: 'external_media_content_invalid',
    })
  })
})

test('external image loader rejects excessive dimensions and animated containers', async (t) => {
  for (const [name, contentType, image] of [
    ['dimension above the per-axis limit', 'image/png', pngImage(4_097, 1)],
    ['pixel count above the decoded limit', 'image/webp', webpImage(3_000, 3_000)],
    ['animated PNG', 'image/png', pngImage(16, 12, { animated: true })],
    ['animated WebP', 'image/webp', webpImage(16, 12, { animated: true })],
    ['lossless WebP height above the axis limit', 'image/webp', webpLosslessImage(16, 4_097)],
    ['lossless WebP maximum encoded height', 'image/webp', webpLosslessImage(16, 16_384)],
    ['lossless WebP pixel count above the limit', 'image/webp', webpLosslessImage(3_000, 3_000)],
    ['lossless WebP with an animation chunk', 'image/webp', webpLosslessImage(16, 12, { animationChunk: true })],
    ['lossless WebP with excessive ancillary chunks', 'image/webp', webpLosslessImage(16, 12, { ancillaryChunks: 4_097 })],
  ]) {
    await t.test(name, async () => {
      const loader = createExternalImageLoader({
        lookup: publicLookup(),
        request: async () => response({ contentType, body: bodyOf(image) }),
        agentFactory: noAgent,
      })
      await rejectsMedia(() => loader(`https://images.example.test/${encodeURIComponent(name)}`), {
        status: 415,
        code: 'external_media_dimensions_rejected',
      })
    })
  }
})

test('external image loader caches a successful image without redispatching', async () => {
  const image = pngImage()
  const lookupCalls = []
  let requestCount = 0
  const loader = createExternalImageLoader({
    lookup: publicLookup(lookupCalls),
    request: async () => {
      requestCount += 1
      return response({ body: bodyOf(image) })
    },
    maxCacheBytes: 1_024,
    maxCacheEntries: 2,
    cacheTtlMs: 60_000,
    agentFactory: noAgent,
  })

  const first = await loader('https://images.example.test/cached.png')
  const second = await loader('https://images.example.test/cached.png')
  assert.deepEqual(first, second)
  assert.equal(requestCount, 1)
  assert.equal(lookupCalls.length, 1)
})

test('external image cache entries are isolated by consumer scope', async () => {
  let requestCount = 0
  const loader = createExternalImageLoader({
    lookup: publicLookup(),
    request: async () => {
      requestCount += 1
      return response({ body: bodyOf(pngImage()) })
    },
    agentFactory: noAgent,
  })

  await loader('https://images.example.test/scoped.png', { cacheScope: 'consumer-a' })
  await loader('https://images.example.test/scoped.png', { cacheScope: 'consumer-a' })
  await loader('https://images.example.test/scoped.png', { cacheScope: 'consumer-b' })
  assert.equal(requestCount, 2)
})

test('external image buffering remains bounded across many tiny chunks', async () => {
  const image = pngImage(16, 12, { payloadBytes: 20_000 })
  const loader = createExternalImageLoader({
    lookup: publicLookup(),
    request: async () => response({
      body: {
        async *[Symbol.asyncIterator]() {
          for (const byte of image) yield Buffer.from([byte])
        },
      },
    }),
    agentFactory: noAgent,
  })

  const loaded = await loader('https://images.example.test/tiny-chunks.png')
  assert.deepEqual(loaded.body, image)
})

test('external image loader coalesces concurrent requests for the same source', async () => {
  const image = pngImage()
  const lookupCalls = []
  const requestStarted = deferred()
  const releaseRequest = deferred()
  let requestCount = 0
  const loader = createExternalImageLoader({
    lookup: publicLookup(lookupCalls),
    request: async () => {
      requestCount += 1
      requestStarted.resolve()
      await releaseRequest.promise
      return response({ body: bodyOf(image) })
    },
    agentFactory: noAgent,
  })

  const first = loader('https://images.example.test/concurrent.png')
  const second = loader('https://images.example.test/concurrent.png')
  await requestStarted.promise
  assert.equal(requestCount, 1)
  assert.equal(lookupCalls.length, 1)
  releaseRequest.resolve()
  const results = await Promise.all([first, second])
  assert.deepEqual(results[0], results[1])
})

test('a caller cancelled before entry creates no cache or upstream work', async () => {
  let lookupCount = 0
  let agentCount = 0
  let requestCount = 0
  const loader = createExternalImageLoader({
    lookup: async () => {
      lookupCount += 1
      return [{ address: PUBLIC_IPV4, family: 4 }]
    },
    request: async () => {
      requestCount += 1
      return response({ body: bodyOf(pngImage()) })
    },
    agentFactory: () => {
      agentCount += 1
      return null
    },
  })
  const caller = new AbortController()
  caller.abort()

  await rejectsMedia(
    () => loader(`https://${PUBLIC_IPV4}/already-cancelled.png`, { signal: caller.signal }),
    { status: 499, code: 'external_media_cancelled' },
  )
  assert.equal(lookupCount, 0)
  assert.equal(agentCount, 0)
  assert.equal(requestCount, 0)
})

test('one cancelled coalesced waiter does not cancel another active waiter', async () => {
  const image = pngImage()
  const requestStarted = deferred()
  const releaseRequest = deferred()
  let requestCount = 0
  const loader = createExternalImageLoader({
    lookup: publicLookup(),
    request: async () => {
      requestCount += 1
      requestStarted.resolve()
      await releaseRequest.promise
      return response({ body: bodyOf(image) })
    },
    agentFactory: noAgent,
  })
  const firstCaller = new AbortController()
  const first = loader('https://images.example.test/shared.png', { signal: firstCaller.signal })
  const second = loader('https://images.example.test/shared.png')
  await requestStarted.promise
  firstCaller.abort()
  await rejectsMedia(() => first, {
    status: 499,
    code: 'external_media_cancelled',
  })
  releaseRequest.resolve()
  const loaded = await second
  assert.deepEqual(loaded.body, image)
  assert.equal(requestCount, 1)
})

test('external image loader cancels its upstream work when the last caller aborts', async () => {
  const requestStarted = deferred()
  const upstreamAborted = deferred()
  let upstreamSignal = null
  const loader = createExternalImageLoader({
    lookup: publicLookup(),
    request: async (_url, { signal }) => {
      upstreamSignal = signal
      requestStarted.resolve()
      return new Promise((_, reject) => {
        const cancel = () => {
          upstreamAborted.resolve()
          reject(signal.reason || new Error('aborted'))
        }
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
      })
    },
    timeoutMs: 1_000,
    agentFactory: noAgent,
  })
  const caller = new AbortController()
  const pending = loader('https://images.example.test/cancelled.png', { signal: caller.signal })
  await requestStarted.promise
  caller.abort()
  await rejectsMedia(() => pending, {
    status: 499,
    code: 'external_media_cancelled',
  })
  await upstreamAborted.promise
  assert.equal(upstreamSignal.aborted, true)
})

test('a cancelled in-flight generation cannot poison the next caller for the same image', async () => {
  const firstStarted = deferred()
  const holdCancelledRequest = deferred()
  let requestCount = 0
  const loader = createExternalImageLoader({
    lookup: publicLookup(),
    request: async (_url, { signal }) => {
      requestCount += 1
      if (requestCount === 1) {
        firstStarted.resolve()
        await holdCancelledRequest.promise
        if (signal.aborted) throw signal.reason || new Error('aborted')
      }
      return response({ body: bodyOf(pngImage()) })
    },
    timeoutMs: 1_000,
    agentFactory: noAgent,
  })

  const caller = new AbortController()
  const cancelled = loader('https://images.example.test/retry-after-cancel.png', { signal: caller.signal })
  await firstStarted.promise
  caller.abort()
  await rejectsMedia(() => cancelled, {
    status: 499,
    code: 'external_media_cancelled',
  })

  const replacement = await loader('https://images.example.test/retry-after-cancel.png')
  assert.equal(replacement.contentType, 'image/png')
  assert.equal(requestCount, 2)
  holdCancelledRequest.resolve()
})

async function createConsumer(store, name) {
  const tenant = await store.createTenant({ name: `${name} Tenant`, status: 'active' })
  return store.createConsumer({ tenantId: tenant.id, name, status: 'active' })
}

async function createUsageRequest(store, consumer, {
  platform = 'ecommerce',
  committed = true,
  responseStatus = 200,
  image = 'https://images.example.test/product.png',
} = {}) {
  const requestId = randomUUID()
  const apiKey = await store.createApiKey({ consumerId: consumer.id, name: `key-${requestId}` })
  await store.reserve({
    requestId,
    idempotencyKey: `media-${requestId}`,
    fingerprint: 'a'.repeat(64),
    tenantId: consumer.tenantId,
    consumerId: consumer.id,
    apiKeyId: apiKey.id,
    platform,
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    windowStart: new Date(0),
    maxRequests: 100,
  })
  if (committed) {
    await store.commitRequest(requestId, {
      responseStatus,
      responseBody: {
        data: {
          items: [{ id: 'product-1', images: [image] }],
        },
      },
      unitsActual: 1,
      upstreamLatencyMs: 1,
    })
  }
  return requestId
}

test('product image source is available only from the same consumer committed ecommerce response', async () => {
  const store = new MemoryStore()
  const owner = await createConsumer(store, 'Owner')
  const stranger = await createConsumer(store, 'Stranger')
  await store.setPlatformGrant(owner.id, 'ecommerce', true)
  await store.setPlatformGrant(stranger.id, 'ecommerce', true)
  const loadedSources = []
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'media-test-pepper-with-enough-entropy',
    externalImageLoader: async (sourceUrl) => {
      loadedSources.push(sourceUrl)
      return { body: Buffer.from('safe-image'), contentType: 'image/png' }
    },
  })
  const committed = await createUsageRequest(store, owner)
  const reserved = await createUsageRequest(store, owner, { committed: false })
  const wrongPlatform = await createUsageRequest(store, owner, { platform: 'telegram' })
  const failedResponse = await createUsageRequest(store, owner, { responseStatus: 502 })

  const media = await service.ecommerceProductImage(
    { consumer: { id: owner.id } },
    { requestId: committed, itemId: 'product-1', imageIndex: '0' },
  )
  assert.equal(media.contentType, 'image/png')
  assert.deepEqual(loadedSources, ['https://images.example.test/product.png'])

  for (const [context, requestId] of [
    [{ consumer: { id: stranger.id } }, committed],
    [{ consumer: { id: owner.id } }, reserved],
    [{ consumer: { id: owner.id } }, wrongPlatform],
    [{ consumer: { id: owner.id } }, failedResponse],
  ]) {
    await rejectsMedia(
      () => service.ecommerceProductImage(context, {
        requestId,
        itemId: 'product-1',
        imageIndex: '0',
      }),
      { status: 404, code: 'external_media_not_found' },
    )
  }
  assert.equal(loadedSources.length, 1)
  await store.setPlatformGrant(owner.id, 'ecommerce', false)
  await rejectsMedia(
    () => service.ecommerceProductImage(
      { consumer: { id: owner.id } },
      { requestId: committed, itemId: 'product-1', imageIndex: '0' },
    ),
    { status: 403, code: 'platform_not_granted' },
  )
  assert.equal(loadedSources.length, 1)
  await store.close()
})

test('product image reads enforce a separate per-consumer request window', async () => {
  const store = new MemoryStore()
  const consumer = await createConsumer(store, 'Rate Limited')
  await store.setPlatformGrant(consumer.id, 'ecommerce', true)
  const requestId = await createUsageRequest(store, consumer)
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'media-rate-test-pepper-with-enough-entropy',
    externalMediaPolicy: { maxRequests: 1, windowMs: 60_000, maxConcurrency: 1 },
    externalImageLoader: async () => ({ body: pngImage(), contentType: 'image/png' }),
  })

  await service.ecommerceProductImage(
    { consumer: { id: consumer.id } },
    { requestId, itemId: 'product-1', imageIndex: '0' },
  )
  await rejectsMedia(
    () => service.ecommerceProductImage(
      { consumer: { id: consumer.id } },
      { requestId, itemId: 'product-1', imageIndex: '0' },
    ),
    { status: 429, code: 'external_media_rate_limited' },
  )
  await store.close()
})

test('product image reads enforce per-consumer concurrency before another relay begins', async () => {
  const store = new MemoryStore()
  const consumer = await createConsumer(store, 'Concurrent')
  await store.setPlatformGrant(consumer.id, 'ecommerce', true)
  const requestId = await createUsageRequest(store, consumer)
  const started = deferred()
  const released = deferred()
  let loaderCalls = 0
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'media-concurrency-test-pepper-with-enough-entropy',
    externalMediaPolicy: { maxRequests: 10, windowMs: 60_000, maxConcurrency: 1 },
    externalImageLoader: async () => {
      loaderCalls += 1
      started.resolve()
      await released.promise
      return { body: pngImage(), contentType: 'image/png' }
    },
  })

  const first = service.ecommerceProductImage(
    { consumer: { id: consumer.id } },
    { requestId, itemId: 'product-1', imageIndex: '0' },
  )
  await started.promise
  await rejectsMedia(
    () => service.ecommerceProductImage(
      { consumer: { id: consumer.id } },
      { requestId, itemId: 'product-1', imageIndex: '0' },
    ),
    { status: 429, code: 'external_media_busy' },
  )
  assert.equal(loaderCalls, 1)
  released.resolve()
  await first
  await store.close()
})

test('product image concurrency remains held until downstream delivery completes', async () => {
  const store = new MemoryStore()
  const consumer = await createConsumer(store, 'Delivery')
  await store.setPlatformGrant(consumer.id, 'ecommerce', true)
  const requestId = await createUsageRequest(store, consumer)
  const delivery = deferred()
  let loaderCalls = 0
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'media-delivery-test-pepper-with-enough-entropy',
    externalMediaPolicy: { maxRequests: 10, windowMs: 60_000, maxConcurrency: 1 },
    externalImageLoader: async () => {
      loaderCalls += 1
      return { body: pngImage(), contentType: 'image/png' }
    },
  })

  await service.ecommerceProductImage(
    { consumer: { id: consumer.id } },
    {
      requestId,
      itemId: 'product-1',
      imageIndex: '0',
      deliveryComplete: delivery.promise,
    },
  )
  await rejectsMedia(
    () => service.ecommerceProductImage(
      { consumer: { id: consumer.id } },
      { requestId, itemId: 'product-1', imageIndex: '0' },
    ),
    { status: 429, code: 'external_media_busy' },
  )
  delivery.resolve()
  await Promise.resolve()
  await service.ecommerceProductImage(
    { consumer: { id: consumer.id } },
    { requestId, itemId: 'product-1', imageIndex: '0' },
  )
  assert.equal(loaderCalls, 2)
  await store.close()
})

test('busy media attempts also consume the per-consumer request window', async () => {
  const store = new MemoryStore()
  const consumer = await createConsumer(store, 'Busy Window')
  await store.setPlatformGrant(consumer.id, 'ecommerce', true)
  const requestId = await createUsageRequest(store, consumer)
  const started = deferred()
  const released = deferred()
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'media-busy-window-test-pepper-with-enough-entropy',
    externalMediaPolicy: { maxRequests: 3, windowMs: 60_000, maxConcurrency: 1 },
    externalImageLoader: async () => {
      started.resolve()
      await released.promise
      return { body: pngImage(), contentType: 'image/png' }
    },
  })

  const first = service.ecommerceProductImage(
    { consumer: { id: consumer.id } },
    { requestId, itemId: 'product-1', imageIndex: '0' },
  )
  await started.promise
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await rejectsMedia(
      () => service.ecommerceProductImage(
        { consumer: { id: consumer.id } },
        { requestId, itemId: 'product-1', imageIndex: '0' },
      ),
      { status: 429, code: 'external_media_busy' },
    )
  }
  await rejectsMedia(
    () => service.ecommerceProductImage(
      { consumer: { id: consumer.id } },
      { requestId, itemId: 'product-1', imageIndex: '0' },
    ),
    { status: 429, code: 'external_media_rate_limited' },
  )
  released.resolve()
  await first
  await store.close()
})

test('rate-window rollover preserves active per-consumer media concurrency', async () => {
  const store = new MemoryStore()
  const consumer = await createConsumer(store, 'Rollover')
  await store.setPlatformGrant(consumer.id, 'ecommerce', true)
  const requestId = await createUsageRequest(store, consumer)
  const started = deferred()
  const released = deferred()
  let loaderCalls = 0
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'media-rollover-test-pepper-with-enough-entropy',
    externalMediaPolicy: { maxRequests: 10, windowMs: 1_000, maxConcurrency: 1 },
    externalImageLoader: async () => {
      loaderCalls += 1
      started.resolve()
      await released.promise
      return { body: pngImage(), contentType: 'image/png' }
    },
  })

  const first = service.ecommerceProductImage(
    { consumer: { id: consumer.id } },
    { requestId, itemId: 'product-1', imageIndex: '0' },
  )
  await started.promise
  service.externalMediaWindows.get(consumer.id).startedAt = Date.now() - 2_000
  await rejectsMedia(
    () => service.ecommerceProductImage(
      { consumer: { id: consumer.id } },
      { requestId, itemId: 'product-1', imageIndex: '0' },
    ),
    { status: 429, code: 'external_media_busy' },
  )
  assert.equal(loaderCalls, 1)
  released.resolve()
  await first
  await store.close()
})
