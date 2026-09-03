import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  JUSTONE_BASE_URL,
  JustOneAdapter,
  JustOneAmbiguousError,
  JustOneRejectedError,
  JustOneSucceededUnusableError,
} from '../../server/adapters/justone.mjs'

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
  assert.equal(result.payload.data.items[0].url, 'https://item.example.invalid/tb-1?campaign=safe')
  assert.equal(result.records[0].externalId, 'taobao:tb-1')
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
      assert.equal(archive.rawPayload.response.envelope.data.session, undefined)
      assert.match(archive.payloadSha256, /^[a-f0-9]{64}$/u)
      assert.doesNotMatch(JSON.stringify(error), /top-secret-token|private-session/iu)
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
