import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  JUSTONE_BASE_URL,
  JustOneAdapter,
  JustOneAmbiguousError,
  JustOneRejectedError,
  JustOneSucceededUnusableError,
} from '../../server/adapters/justone.mjs'

const jdProductSearchV1Fixture = JSON.parse(readFileSync(
  new URL('../fixtures/justone/jd-product-search-v1.success.json', import.meta.url),
  'utf8',
))

function response(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function envelope(data) {
  return {
    code: 0,
    message: null,
    data,
    recordTime: '2026-09-03T00:00:00Z',
    requestId: 'request-1',
  }
}

test('adapter uses the pinned HTTPS path and injects token only into query', async () => {
  const secret = 'private-token-value'
  let call
  const adapter = new JustOneAdapter({
    token: secret,
    fetchImpl: async (url, options) => {
      call = { url: new URL(url), options }
      return response(envelope({
        items: [{
          itemId: 'tb-1',
          title: `商品一 ${secret}`,
          itemUrl: `https://item.example.invalid/tb-1?token=${secret}&campaign=safe`,
          provider: 'private-provider',
          token: secret,
          debugUrl: `${JUSTONE_BASE_URL}/debug?token=${secret}`,
        }],
        hasMore: false,
      }))
    },
  })

  const result = await adapter.searchProducts({ marketplace: 'taobao', query: '面霜' }, {
    capturedAt: '2026-09-03T00:00:00Z',
  })
  assert.equal(call.url.origin, JUSTONE_BASE_URL)
  assert.equal(call.url.pathname, '/api/taobao/search-item-list/v1')
  assert.equal(call.url.searchParams.get('token'), secret)
  assert.equal(call.url.searchParams.get('keyword'), '面霜')
  assert.equal(call.options.method, 'GET')
  assert.equal(call.options.redirect, 'error')
  assert.equal(call.options.headers.authorization, undefined)
  assert.equal(call.options.headers['x-api-key'], undefined)
  assert.equal(result.payload.data.items[0].id, 'tb-1')
  assert.equal(result.payload.data.items[0].title, '商品一 [REDACTED]')
  assert.equal(
    result.payload.data.items[0].url,
    'https://item.example.invalid/tb-1?token=[REDACTED]&campaign=safe',
  )
  assert.equal(result.records[0].externalId, 'taobao:tb-1')
  assert.equal(result.records[0].rawItem.provider, 'private-provider')
  assert.equal(result.records[0].rawItem.token, '[REDACTED]')
  assert.equal(result.restrictedResponseArchive.parsedPayload.data.items[0].token, secret)
  assert.match(result.restrictedResponseArchive.bodyText, new RegExp(secret, 'u'))
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
  assert.doesNotMatch(JSON.stringify(result.payload), /provider|endpoint|billing|credential/iu)
  const responseArchive = result.archiveObjects[0]
  assert.equal(responseArchive.kind, 'response')
  assert.equal(responseArchive.contractState, 'accepted')
  assert.equal(responseArchive.bodySize > 0, true)
  assert.equal(responseArchive.contentType, 'application/json')
  assert.equal(responseArchive.upstreamRequestId, 'request-1')
  assert.equal(responseArchive.upstreamRecordTime, '2026-09-03T00:00:00Z')
  assert.equal(responseArchive.rawPayload.response.envelope.code, 0)
  assert.equal(responseArchive.rawPayload.response.envelope.data.items.length, 1)
  assert.match(responseArchive.payloadSha256, /^[a-f0-9]{64}$/u)
  assert.match(responseArchive.rawPayload.response.bodySha256, /^[a-f0-9]{64}$/u)
  assert.match(responseArchive.archivePath, /\/responses\/[a-f0-9]{64}\.json$/u)
  assert.equal(result.archiveObjects[1].kind, 'item')
})

test('adapter removes the exact URLSearchParams credential encoding from public and operational data', async () => {
  const secret = 'api/key+space ?&'
  let reflectedToken
  let lowerCaseToken
  let doubleEncodedToken
  const adapter = new JustOneAdapter({
    token: secret,
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.toString()
      reflectedToken = /^token=([^&]*)/u.exec(query)?.[1]
      lowerCaseToken = reflectedToken.replace(
        /%[0-9A-F]{2}/gu,
        (escape) => escape.toLowerCase(),
      )
      const nestedQuery = new URLSearchParams()
      nestedQuery.set('token', lowerCaseToken)
      doubleEncodedToken = nestedQuery.toString().slice('token='.length).replace(
        /%[0-9A-F]{2}/gu,
        (escape) => escape.toLowerCase(),
      )
      return response(envelope({
        items: [{
          itemId: 'encoded-secret-item',
          title: `provider echo ${lowerCaseToken}`,
          itemUrl: `https://item.example.invalid/encoded-secret-item?token=${doubleEncodedToken}`,
          debugUrl: `https://api.example.invalid/debug?token=${reflectedToken}`,
        }],
        hasMore: false,
      }))
    },
  })

  const result = await adapter.searchProducts({ marketplace: 'taobao', query: 'encoded token' })
  const serialized = JSON.stringify(result)
  const operationalArchives = JSON.stringify(result.archiveObjects)

  assert.equal(reflectedToken, 'api%2Fkey%2Bspace+%3F%26')
  assert.equal(result.payload.data.items[0].url.includes('[REDACTED]'), true)
  for (const encoded of [reflectedToken, lowerCaseToken, doubleEncodedToken]) {
    assert.equal(serialized.includes(encoded), false)
    assert.equal(operationalArchives.includes(encoded), false)
  }
  assert.equal(serialized.includes(secret), false)
  assert.equal(operationalArchives.includes(secret), false)
  assert.equal(result.restrictedResponseArchive.bodyText.includes(reflectedToken), true)
})

test('adapter keeps JustOne business fields in ordinary evidence and exact bytes in restricted evidence', async () => {
  const raw = {
    ...envelope({
      items: [{
        skuId: 'sku-raw-1',
        title: '正文中的 token=业务术语不能被改写',
        itemUrl: 'https://item.example.invalid/sku-raw-1',
      }],
      hasMore: false,
      search_id: 'business-pagination-search-id',
      params: { source: 'XIAOHONGSHU', page: 1 },
      signedUrl: 'https://media.example.invalid/a?signature=business-signature#business-fragment',
    }),
    provider: 'justone',
    billing: { units: 1 },
  }
  const bodyText = JSON.stringify(raw)
  const adapter = new JustOneAdapter({
    token: 'request-only-secret',
    fetchImpl: async () => new Response(bodyText, {
      headers: { 'content-type': 'application/json' },
    }),
  })

  const result = await adapter.searchProducts({ marketplace: 'jd', query: 'raw archive' }, {
    capturedAt: '2026-09-03T00:00:00Z',
  })

  assert.equal(Object.prototype.propertyIsEnumerable.call(result, 'restrictedResponseArchive'), false)
  assert.equal(result.restrictedResponseArchive.bodyText, bodyText)
  assert.deepEqual(result.restrictedResponseArchive.bodyBytes, Buffer.from(bodyText, 'utf8'))
  assert.equal(result.restrictedResponseArchive.bodySize, Buffer.byteLength(bodyText, 'utf8'))
  assert.match(result.restrictedResponseArchive.bodySha256, /^[a-f0-9]{64}$/u)
  assert.equal(result.restrictedResponseArchive.jsonParsed, true)
  assert.deepEqual(result.restrictedResponseArchive.parsedPayload, raw)
  assert.equal(result.restrictedResponseArchive.parsedPayload.data.search_id, 'business-pagination-search-id')
  assert.equal(result.restrictedResponseArchive.parsedPayload.data.params.source, 'XIAOHONGSHU')
  assert.match(result.restrictedResponseArchive.parsedPayload.data.items[0].title, /token=业务术语/u)
  assert.match(result.restrictedResponseArchive.parsedPayload.data.signedUrl, /signature=business-signature/u)
  assert.equal(result.archiveObjects[0].rawPayload.response.envelope.provider, 'justone')
  assert.deepEqual(result.archiveObjects[0].rawPayload.response.envelope.billing, { units: 1 })
  assert.equal(
    result.archiveObjects[0].rawPayload.response.envelope.data.search_id,
    'business-pagination-search-id',
  )
  assert.equal(JSON.stringify(result).includes('business-pagination-search-id'), true)
  assert.doesNotMatch(JSON.stringify(result), /request-only-secret/u)
})

test('restricted evidence hashes and preserves the original response bytes including a UTF-8 BOM', async () => {
  const raw = envelope({ items: [{ skuId: 'sku-bom', title: '正文保持原样' }], hasMore: false })
  const bodyBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(raw), 'utf8'),
  ])
  const adapter = new JustOneAdapter({
    token: 'request-only-secret',
    fetchImpl: async () => new Response(bodyBytes, {
      headers: { 'content-type': 'application/json' },
    }),
  })

  const result = await adapter.searchProducts({ marketplace: 'jd', query: 'bom' })

  assert.deepEqual(result.restrictedResponseArchive.bodyBytes, bodyBytes)
  assert.equal(result.restrictedResponseArchive.bodyText.codePointAt(0), 0xfeff)
  assert.equal(result.restrictedResponseArchive.bodySize, bodyBytes.byteLength)
  assert.equal(
    result.restrictedResponseArchive.bodySha256,
    createHash('sha256').update(bodyBytes).digest('hex'),
  )
  assert.equal(result.restrictedResponseArchive.jsonParsed, true)
  assert.deepEqual(result.restrictedResponseArchive.parsedPayload, raw)
})

test('deep valid JSON still retains exact restricted JustOne response bytes', async () => {
  const depth = 12_000
  const bodyText = `{"code":400,"message":"invalid request","recordTime":"2026-09-03T00:00:00Z","requestId":"deep-response","data":${'{"nested":'.repeat(depth)}null${'}'.repeat(depth)}}`
  const bodyBytes = Buffer.from(bodyText, 'utf8')
  const adapter = new JustOneAdapter({
    token: 'request-only-secret',
    fetchImpl: async () => new Response(bodyBytes, {
      headers: { 'content-type': 'application/json' },
    }),
  })

  await assert.rejects(
    () => adapter.searchProducts({ marketplace: 'jd', query: 'deep response' }),
    (error) => {
      assert.ok(error instanceof JustOneRejectedError)
      assert.equal(error.archiveObjects[0].rawPayload.response.envelope, null)
      assert.equal(error.restrictedResponseArchive.bodyBytes.equals(bodyBytes), true)
      assert.equal(error.restrictedResponseArchive.bodyText, bodyText)
      assert.equal(error.restrictedResponseArchive.jsonParsed, true)
      assert.equal(error.restrictedResponseArchive.parsedPayload, null)
      return true
    },
  )
})

test('JustOne PostgreSQL-unsafe payloads keep exact bytes while optional projections stay null', async () => {
  const cases = [
    {
      bodyText: '{"code":0,"message":null,"recordTime":"2026-09-03T00:00:00Z","requestId":"nul-json","data":{"text":"\\u0000"}}',
      ErrorClass: JustOneSucceededUnusableError,
      expectedCode: 'upstream_payload_unrepresentable',
      expectedJsonParsed: true,
      retainsText: true,
    },
    {
      bodyText: '{"code":0,"message":null,"recordTime":"2026-09-03T00:00:00Z","requestId":"surrogate-json","data":{"text":"\\ud800"}}',
      ErrorClass: JustOneSucceededUnusableError,
      expectedCode: 'upstream_payload_unrepresentable',
      expectedJsonParsed: true,
      retainsText: true,
    },
    {
      bodyText: '{"code":0,"message":null,"recordTime":"2026-09-03T00:00:00Z","requestId":"infinity-json","data":{"value":1e400}}',
      ErrorClass: JustOneSucceededUnusableError,
      expectedCode: 'upstream_payload_unrepresentable',
      expectedJsonParsed: true,
      retainsText: true,
    },
    {
      bodyText: '{"code":0,"message":null,"recordTime":"2026-09-03T00:00:00Z","requestId":"negative-zero-json","data":{"value":-0}}',
      ErrorClass: JustOneSucceededUnusableError,
      expectedCode: 'upstream_payload_unrepresentable',
      expectedJsonParsed: true,
      retainsText: true,
    },
    {
      bodyText: '{"code":0,"message":"literal\0nul","recordTime":null,"data":null}',
      ErrorClass: JustOneAmbiguousError,
      expectedCode: 'invalid_upstream_json',
      expectedJsonParsed: false,
      retainsText: false,
    },
  ]

  for (const expected of cases) {
    const bodyBytes = Buffer.from(expected.bodyText, 'utf8')
    const adapter = new JustOneAdapter({
      token: 'request-only-secret',
      fetchImpl: async () => new Response(bodyBytes, {
        headers: { 'content-type': 'application/json' },
      }),
    })

    await assert.rejects(
      () => adapter.searchProducts({ marketplace: 'jd', query: 'nul response' }),
      (error) => {
        assert.ok(error instanceof expected.ErrorClass)
        assert.equal(error.evidence.errorCode, expected.expectedCode)
        assert.equal(error.archiveObjects.length, 1)
        assert.equal(error.archiveObjects[0].rawPayload.response.envelope, null)
        assert.equal(error.restrictedResponseArchive.bodyBytes.equals(bodyBytes), true)
        assert.equal(
          error.restrictedResponseArchive.bodyText,
          expected.retainsText ? expected.bodyText : null,
        )
        assert.equal(error.restrictedResponseArchive.jsonParsed, expected.expectedJsonParsed)
        assert.equal(error.restrictedResponseArchive.parsedPayload, null)
        return true
      },
    )
  }
})

test('adapter resolves one dynamic credential per dispatch and uses it consistently for redaction', async () => {
  const credentials = ['database-token-one', 'database-token-two']
  const seen = []
  let resolutions = 0
  const adapter = new JustOneAdapter({
    token: 'environment-fallback-token',
    credentialResolver: async () => credentials[resolutions++],
    fetchImpl: async (url) => {
      const token = new URL(url).searchParams.get('token')
      seen.push(token)
      return response(envelope({
        items: [{
          skuId: `sku-${seen.length}`,
          title: `private ${token}`,
          itemUrl: `https://item.example.invalid/${seen.length}?token=${token}`,
        }],
        hasMore: false,
      }))
    },
  })

  const first = await adapter.searchProducts({ marketplace: 'jd', query: 'camera' })
  const second = await adapter.searchProducts({ marketplace: 'jd', query: 'camera' })

  assert.equal(resolutions, 2)
  assert.deepEqual(seen, credentials)
  assert.doesNotMatch(JSON.stringify(first), /database-token-one/u)
  assert.doesNotMatch(JSON.stringify(second), /database-token-two/u)
})

test('adapter falls back to its environment credential when the dynamic store has no value', async () => {
  let resolutions = 0
  let dispatchedToken = null
  const adapter = new JustOneAdapter({
    token: 'environment-fallback-token',
    credentialResolver: async () => {
      resolutions += 1
      return null
    },
    fetchImpl: async (url) => {
      dispatchedToken = new URL(url).searchParams.get('token')
      return response(envelope({ items: [], hasMore: false }))
    },
  })

  await adapter.searchProducts({ marketplace: 'jd', query: 'camera' })

  assert.equal(resolutions, 1)
  assert.equal(dispatchedToken, 'environment-fallback-token')
})

test('default capture timestamp is taken after the complete response body is read', async () => {
  let bodyCompletedAt = null
  const bytes = new TextEncoder().encode(JSON.stringify(envelope({
    items: [{ skuId: 'jd-1', title: '相机' }],
    hasMore: false,
  })))
  const adapter = new JustOneAdapter({
    token: 'test-token',
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          bodyCompletedAt = Date.now()
          controller.enqueue(bytes)
          controller.close()
        }, 20)
      },
    }), { headers: { 'content-type': 'application/json' } }),
  })

  const result = await adapter.searchProducts({ marketplace: 'jd', query: '相机' })
  const capturedAt = new Date(result.publicBody.meta.capturedAt).getTime()
  assert.ok(capturedAt >= bodyCompletedAt)
  assert.equal(result.records[0].collectedAt.getTime(), capturedAt)
})

test('adapter dispatch allowlist contains every marketplace and no caller-selected path', async () => {
  const seen = []
  const adapter = new JustOneAdapter({
    token: 'test-token',
    fetchImpl: async (url) => {
      seen.push(new URL(url).pathname)
      return response(envelope({ items: [], hasMore: false }))
    },
  })
  for (const marketplace of ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu']) {
    await adapter.searchProducts({ marketplace, query: 'test' })
  }
  assert.deepEqual(seen, [
    '/api/taobao/search-item-list/v1',
    '/api/taobao/search-item-list/v1',
    '/api/jd/search-item-list/v1',
    '/api/xiaohongshu-ec/search-products/v1',
    '/api/xianyu/search-item-list/v1',
  ])
  await assert.rejects(
    () => adapter.searchProducts({ marketplace: 'jd', query: 'test', path: 'https://evil.invalid' }),
    (error) => error?.name === 'JustOneContractError',
  )
})

test('adapter accepts the reviewed JD V1 data.products response shape', async () => {
  const adapter = new JustOneAdapter({
    token: 'test-token',
    fetchImpl: async () => response(jdProductSearchV1Fixture),
  })

  const result = await adapter.searchProducts({ marketplace: 'jd', query: '耳机' }, {
    capturedAt: '2026-09-06T05:00:17Z',
  })

  assert.equal(result.payload.data.items.length, 1)
  assert.equal(result.payload.data.items[0].id, 'jd-product-1')
  // The fixture is page 1 of 1, so JD's own counters state "no more pages".
  assert.equal(result.payload.data.page.hasMore, false)
  assert.equal(result.payload.data.page.nextCursor, null)
  assert.equal(result.archiveObjects[0].contractState, 'accepted')
  assert.equal(result.archiveObjects[1].envelopePointer, '$.data.products[0]')
})

test('adapter classifies every required business code with safe evidence', async () => {
  const expected = {
    100: 'upstream_auth_invalid',
    301: 'upstream_collection_failed',
    302: 'upstream_rate_limited',
    303: 'upstream_daily_quota_exceeded',
    400: 'invalid_request',
    500: 'upstream_internal_error',
    600: 'upstream_permission_denied',
    601: 'upstream_balance_exhausted',
    602: 'upstream_token_limit_exceeded',
  }
  for (const [codeText, errorCode] of Object.entries(expected)) {
    const code = Number(codeText)
    const adapter = new JustOneAdapter({
      token: 'do-not-leak-this-token',
      fetchImpl: async () => response({
        ...envelope(null),
        code,
        message: `error with do-not-leak-this-token for provider`,
      }),
    })
    await assert.rejects(
      () => adapter.searchProducts({ marketplace: 'jd', query: 'test' }),
      (error) => {
        assert.ok(error instanceof JustOneRejectedError)
        assert.deepEqual(error.evidence, {
          outcome: 'rejected',
          httpStatus: 200,
          businessCode: code,
          billed: false,
          errorCode,
          circuitCategory: code === 400
            ? 'request'
            : [100, 600].includes(code)
              ? 'authentication'
              : [302, 303, 601, 602].includes(code)
                ? 'capacity'
                : 'upstream',
          affectsCircuit: code !== 400,
          retryable: false,
        })
        assert.equal(error.archiveObjects.length, 1)
        assert.equal(error.archiveObjects[0].kind, 'response')
        assert.equal(error.archiveObjects[0].contractState, 'provider_rejected')
        assert.equal(error.archiveObjects[0].rawPayload.response.businessCode, code)
        assert.equal(error.archiveObjects[0].rawPayload.response.billed, false)
        assert.equal(error.archiveObjects[0].rawPayload.response.requestId, 'request-1')
        assert.equal(error.archiveObjects[0].rawPayload.response.recordTime, '2026-09-03T00:00:00Z')
        assert.match(error.archiveObjects[0].archivePath, /\/responses\/[a-f0-9]{64}\.json$/u)
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /do-not-leak-this-token|provider/iu)
        return true
      },
    )
  }
})

test('transport failure is ambiguous and is never retried', async () => {
  let calls = 0
  const adapter = new JustOneAdapter({
    token: 'secret-token',
    fetchImpl: async () => {
      calls += 1
      throw new Error('request failed at https://api.justoneapi.com/?token=secret-token')
    },
  })
  await assert.rejects(
    () => adapter.searchProducts({ marketplace: 'xianyu', query: '相机' }),
    (error) => error instanceof JustOneAmbiguousError
      && error.evidence.outcome === 'unknown'
      && error.evidence.circuitCategory === 'transport'
      && error.evidence.affectsCircuit === true
      && error.evidence.retryable === false
      && !JSON.stringify(error).includes('secret-token'),
  )
  assert.equal(calls, 1)
})

test('deadline covers a response body that stalls after headers', async () => {
  let calls = 0
  const adapter = new JustOneAdapter({
    token: 'secret-token',
    timeoutMs: 10,
    fetchImpl: async (_url, options) => {
      calls += 1
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
      })
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    },
  })
  await assert.rejects(
    () => adapter.searchProducts({ marketplace: 'jd', query: '手机' }),
    (error) => error instanceof JustOneAmbiguousError
      && error.evidence.errorCode === 'upstream_deadline_exceeded',
  )
  assert.equal(calls, 1)
})

test('successful oversized and malformed responses are ambiguous without redispatch', async () => {
  for (const fetchImpl of [
    async () => response(envelope({ items: [], padding: 'x'.repeat(2_000) })),
    async () => new Response('{not-json', { headers: { 'content-type': 'application/json' } }),
    async () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    async () => response({ ...envelope({ items: [] }), code: '0' }),
  ]) {
    let calls = 0
    const adapter = new JustOneAdapter({
      token: 'secret-token',
      maxResponseBytes: 1_024,
      fetchImpl: async (...args) => {
        calls += 1
        return fetchImpl(...args)
      },
    })
    await assert.rejects(
      () => adapter.searchProducts({ marketplace: 'taobao', query: 'test' }),
      (error) => error instanceof JustOneAmbiguousError && error.evidence.retryable === false,
    )
    assert.equal(calls, 1)
  }
})

test('non-2xx responses without a verified business code remain unknown and unbilled', async () => {
  const cases = [
    {
      errorCode: 'upstream_response_too_large',
      fetchImpl: async () => response(envelope({ items: [], padding: 'x'.repeat(2_000) }), 502),
    },
    {
      errorCode: 'invalid_upstream_json',
      fetchImpl: async () => new Response('{not-json', {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    },
    {
      errorCode: 'invalid_upstream_content_type',
      fetchImpl: async () => new Response(JSON.stringify({ ...envelope(null), code: 302 }), {
        status: 429,
        headers: { 'content-type': 'text/plain' },
      }),
    },
    {
      errorCode: 'invalid_upstream_envelope',
      fetchImpl: async () => response({ error: 'bad gateway' }, 502),
    },
  ]

  for (const fixture of cases) {
    let calls = 0
    const adapter = new JustOneAdapter({
      token: 'secret-token',
      maxResponseBytes: 1_024,
      fetchImpl: async (...args) => {
        calls += 1
        return fixture.fetchImpl(...args)
      },
    })
    await assert.rejects(
      () => adapter.searchProducts({ marketplace: 'jd', query: 'test' }),
      (error) => {
        assert.ok(error instanceof JustOneAmbiguousError)
        assert.equal(error.evidence.outcome, 'unknown')
        assert.equal(error.evidence.businessCode, null)
        assert.equal(error.evidence.billed, null)
        assert.equal(error.evidence.errorCode, fixture.errorCode)
        assert.equal(error.evidence.circuitCategory, 'contract')
        assert.equal(error.evidence.affectsCircuit, true)
        assert.equal(error.evidence.retryable, false)
        return true
      },
    )
    assert.equal(calls, 1)
  }
})

test('a valid code=0 response that Hub cannot map is billed and marked succeeded_unusable', async () => {
  let calls = 0
  const adapter = new JustOneAdapter({
    token: 'top-secret-token',
    fetchImpl: async () => {
      calls += 1
      return response(envelope({
        unexpectedItems: [{ skuId: 'jd-1' }],
        session: 'private-session',
      }))
    },
  })

  await assert.rejects(
    () => adapter.searchProducts({ marketplace: 'jd', query: '手机' }, {
      capturedAt: '2026-09-03T00:00:00Z',
    }),
    (error) => {
      assert.ok(error instanceof JustOneSucceededUnusableError)
      assert.deepEqual(error.evidence, {
        outcome: 'succeeded_unusable',
        httpStatus: 200,
        businessCode: 0,
        billed: true,
        errorCode: 'invalid_upstream_items',
        circuitCategory: 'contract',
        affectsCircuit: true,
        retryable: false,
      })
      assert.equal(error.archiveObjects.length, 1)
      const archive = error.archiveObjects[0]
      assert.equal(archive.contractState, 'succeeded_unusable')
      assert.equal(archive.rawPayload.response.outcome, 'succeeded_unusable')
      assert.equal(archive.rawPayload.response.businessCode, 0)
      assert.equal(archive.rawPayload.response.billed, true)
      assert.equal(archive.rawPayload.response.envelope.code, 0)
      assert.equal(archive.rawPayload.response.envelope.data.session, 'private-session')
      assert.match(archive.payloadSha256, /^[a-f0-9]{64}$/u)
      assert.doesNotMatch(JSON.stringify(error), /top-secret-token/u)
      return true
    },
  )
  assert.equal(calls, 1)
})

test('code=0 with a conflicting HTTP or content-type status remains billed and unusable', async () => {
  for (const fetchImpl of [
    async () => response(envelope({ items: [] }), 502),
    async () => new Response(JSON.stringify(envelope({ items: [] })), {
      headers: { 'content-type': 'text/plain' },
    }),
  ]) {
    const adapter = new JustOneAdapter({ token: 'secret-token', fetchImpl })
    await assert.rejects(
      () => adapter.searchProducts({ marketplace: 'jd', query: '手机' }),
      (error) => error instanceof JustOneSucceededUnusableError
        && error.evidence.outcome === 'succeeded_unusable'
        && error.evidence.businessCode === 0
        && error.evidence.billed === true
        && error.evidence.circuitCategory === 'contract'
        && error.evidence.affectsCircuit === true
        && error.evidence.retryable === false
        && error.archiveObjects[0].rawPayload.response.envelope.code === 0,
    )
  }
})

test('HTTP rejection remains definite while full response evidence stays opt-in', async () => {
  const adapter = new JustOneAdapter({
    token: 'secret-token',
    fetchImpl: async () => response({
      ...envelope(null), code: 302, message: 'secret provider detail',
    }, 429),
  })
  await assert.rejects(
    () => adapter.searchProducts({ marketplace: 'jd', query: 'test' }),
    (error) => {
      assert.ok(error instanceof JustOneRejectedError)
      assert.equal(error.evidence.httpStatus, 429)
      assert.equal(error.evidence.businessCode, 302)
      assert.equal(error.evidence.billed, false)
      assert.equal(error.archiveObjects[0].rawPayload.response.envelope.message, 'secret provider detail')
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'archiveObjects'), false)
      assert.equal(JSON.stringify(error).includes('secret provider detail'), false)
      return true
    },
  )
})
