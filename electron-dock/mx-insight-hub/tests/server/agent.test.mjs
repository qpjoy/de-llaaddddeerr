import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { ProxyAgent } from 'undici'
import {
  EmbeddingRouter,
  HubAgent,
  NoProviderAvailableError,
  ProviderRouter,
  parseProviderConfig,
  shouldFailover,
  validateChatResponse,
} from '../../server/agent/index.mjs'

const quiet = { warn() {}, log() {}, error() {} }

function providers(...ids) {
  return ids.map((id) => ({
    id,
    baseUrl: `https://${id}.invalid/v1`,
    model: `${id}-model`,
    apiKeyEnv: null,
    timeoutMs: 1_000,
    kind: 'chat',
  }))
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function chatReply(content) {
  return { choices: [{ message: { content } }] }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('provider config requires id, baseUrl and model', () => {
  assert.throws(() => parseProviderConfig('[{"id":"x"}]'), /requires id, baseUrl and model/)
  assert.throws(() => parseProviderConfig('not json'), /not valid JSON/)
  assert.throws(
    () => parseProviderConfig('{"apiKey":"secret-parser-sentinel"'),
    (error) => error.message === 'agent provider config is not valid JSON'
      && !error.message.includes('secret-parser-sentinel'),
  )
  assert.deepEqual(parseProviderConfig(null), [])
})

test('environment provider config rejects inline API keys', () => {
  assert.throws(
    () => parseProviderConfig([{
      id: 'unsafe', baseUrl: 'https://provider.invalid/v1', model: 'm', apiKey: 'must-not-enter-configmap',
    }]),
    /inline apiKey is forbidden/,
  )
  assert.throws(
    () => parseProviderConfig([{
      id: 'bad-mode', baseUrl: 'https://provider.invalid/v1', model: 'm', authMode: 'custom',
    }]),
    /authMode must be bearer or none/,
  )
  assert.throws(
    () => parseProviderConfig([{
      id: 'anonymous', baseUrl: 'https://provider.invalid/v1', model: 'm',
      authMode: 'none', apiKeyEnv: 'MUST_NOT_BE_SENT',
    }]),
    /cannot configure an API key when authMode is none/,
  )
})

test('provider order is the failover order', () => {
  const parsed = parseProviderConfig(JSON.stringify([
    { id: 'deepseek', baseUrl: 'https://a/v1/', model: 'deepseek-chat' },
    { id: 'openai', baseUrl: 'https://b/v1', model: 'gpt-4o-mini' },
  ]))
  assert.deepEqual(parsed.map((p) => p.id), ['deepseek', 'openai'])
  assert.equal(parsed[0].baseUrl, 'https://a/v1', 'trailing slash is normalised away')
})

test('an LLM Sequence selects and orders a provider subset without changing catalog order', async () => {
  const seen = []
  const router = new ProviderRouter({
    providers: providers('catalog-first', 'sequence-first', 'sequence-second'),
    logger: quiet,
    fetchImpl: async (url) => {
      const id = new URL(url).hostname.split('.')[0]
      seen.push(id)
      return id === 'sequence-first'
        ? jsonResponse({ error: 'overloaded' }, 503)
        : jsonResponse(chatReply('ok'))
    },
  })

  const result = await router.callSequence(
    ['sequence-first', 'sequence-second'],
    '/chat/completions',
    (entry) => ({ model: entry.model }),
  )

  assert.equal(result.provider, 'sequence-second')
  assert.deepEqual(seen, ['sequence-first', 'sequence-second'])
  assert.equal(router.providers[0].id, 'catalog-first')
})

test('Anthropic Messages providers are adapted to the stable Hub chat envelope', async () => {
  let observed
  const router = new ProviderRouter({
    providers: [{
      ...providers('claude')[0],
      protocol: 'anthropic-messages',
      authMode: 'bearer',
      apiKey: 'anthropic-secret-sentinel',
    }],
    logger: quiet,
    fetchImpl: async (url, options) => {
      observed = { url, options, body: JSON.parse(options.body) }
      return jsonResponse({
        id: 'msg_1',
        model: 'claude-model',
        content: [{ type: 'text', text: 'hello from Claude' }],
        usage: { input_tokens: 7, output_tokens: 4 },
      })
    },
  })
  const agent = new HubAgent({
    chat: router,
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })

  const result = await agent.complete([
    { role: 'system', content: 'System contract' },
    { role: 'user', content: 'Say hi' },
  ], { temperature: 1.7, maxTokens: 55 })

  assert.equal(observed.url, 'https://claude.invalid/v1/messages')
  assert.equal(observed.options.headers['x-api-key'], 'anthropic-secret-sentinel')
  assert.equal(observed.options.headers.authorization, undefined)
  assert.equal(observed.options.headers['anthropic-version'], '2023-06-01')
  assert.deepEqual(observed.body, {
    model: 'claude-model',
    max_tokens: 55,
    messages: [{ role: 'user', content: 'Say hi' }],
    system: 'System contract',
    temperature: 1,
  })
  assert.equal(result.payload.choices[0].message.content, 'hello from Claude')
  assert.equal(result.requestedTemperature, 1.7)
  assert.equal(result.effectiveTemperature, 1)
  assert.deepEqual(result.payload.usage, {
    prompt_tokens: 7,
    completion_tokens: 4,
    total_tokens: 11,
  })
})

test('a Provider Proxy Sequence falls back to direct only after proxy transport failure', async () => {
  const routes = []
  const router = new ProviderRouter({
    providers: [{
      ...providers('proxied')[0],
      proxyUrls: ['http://127.0.0.1:7890'],
      directFallback: true,
    }],
    logger: quiet,
    fetchImpl: async (_url, options) => {
      routes.push(options.dispatcher ? 'proxy' : 'direct')
      if (options.dispatcher) throw new Error('proxy unavailable')
      return jsonResponse(chatReply('direct fallback'))
    },
  })

  const result = await router.call('/chat/completions', (entry) => ({ model: entry.model }))

  assert.equal(result.provider, 'proxied')
  assert.deepEqual(routes, ['proxy', 'direct'])
})

test('a transport override does not mutate the Provider catalog and shares its circuit', async () => {
  const catalogProvider = providers('shared-circuit')[0]
  let calls = 0
  let effectiveProvider = null
  const router = new ProviderRouter({
    providers: [catalogProvider],
    logger: quiet,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({ error: 'unavailable' }, 503)
    },
  })
  const transportOverride = {
    proxyUrls: ['http://127.0.0.1:17890'],
    directFallback: false,
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => router.call('/chat/completions', (provider) => {
      effectiveProvider = provider
      return { model: provider.model }
    }, { transportOverride }))
  }

  assert.notEqual(effectiveProvider, catalogProvider, 'the request receives an effective clone')
  assert.deepEqual(effectiveProvider.proxyUrls, transportOverride.proxyUrls)
  assert.equal(effectiveProvider.directFallback, false)
  assert.equal(router.providers[0], catalogProvider, 'the catalog retains its original object')
  assert.equal(Object.hasOwn(catalogProvider, 'proxyUrls'), false)
  assert.equal(Object.hasOwn(catalogProvider, 'directFallback'), false)
  assert.equal(router.status()[0].circuit, 'open')

  await assert.rejects(
    () => router.call('/chat/completions', (provider) => ({ model: provider.model })),
    (error) => error.attempts?.[0]?.error === 'circuit open',
  )
  assert.equal(calls, 3, 'the non-override call shares and respects the opened circuit')
})

test('a transport exception advances from the first override proxy to the second', async () => {
  const dispatchers = []
  const agent = new HubAgent({
    chat: new ProviderRouter({
      providers: providers('override-sequence'),
      logger: quiet,
      fetchImpl: async (_url, options) => {
        dispatchers.push(options.dispatcher)
        if (dispatchers.length === 1) throw new Error('first proxy unavailable')
        return jsonResponse(chatReply('second proxy'))
      },
    }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })

  const result = await agent.complete([{ role: 'user', content: 'hello' }], {
    providerIds: ['override-sequence'],
    transportOverride: {
      proxyUrls: ['http://127.0.0.1:17891', 'http://127.0.0.1:17892'],
      directFallback: false,
    },
  })

  assert.equal(result.payload.choices[0].message.content, 'second proxy')
  assert.equal(dispatchers.length, 2)
  assert.ok(dispatchers.every(Boolean))
  assert.notEqual(dispatchers[0], dispatchers[1])
})

test('the ProxyAgent cache evicts idle LRU entries without closing an active response', async () => {
  const originalClose = ProxyAgent.prototype.close
  const closed = new Set()
  ProxyAgent.prototype.close = function closeForTest() {
    closed.add(this)
    return Promise.resolve()
  }

  let activeBodyController
  let activeDispatcher
  let markActiveStarted
  const activeStarted = new Promise((resolve) => { markActiveStarted = resolve })
  const activeProvider = { ...providers('active-proxy-cache')[0], timeoutMs: 30_000 }
  const activeRouter = new ProviderRouter({
    providers: [activeProvider],
    logger: quiet,
    fetchImpl: async (_url, options) => {
      activeDispatcher = options.dispatcher
      markActiveStarted()
      return new Response(new ReadableStream({
        start(controller) { activeBodyController = controller },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const activeCall = activeRouter.callProvider(
    activeProvider.id,
    '/chat/completions',
    (provider) => ({ model: provider.model }),
    {
      validatePayload: validateChatResponse,
      transportOverride: {
        proxyUrls: ['http://127.0.0.1:17910'],
        directFallback: false,
      },
    },
  )

  try {
    await activeStarted
    const churnRouter = new ProviderRouter({
      providers: providers('proxy-cache-churn'),
      logger: quiet,
      fetchImpl: async () => jsonResponse(chatReply('OK')),
    })
    for (let index = 0; index < 40; index += 1) {
      await churnRouter.callProvider(
        'proxy-cache-churn',
        '/chat/completions',
        (provider) => ({ model: provider.model }),
        {
          validatePayload: validateChatResponse,
          transportOverride: {
            proxyUrls: [`http://127.0.0.1:${18000 + index}`],
            directFallback: false,
          },
        },
      )
    }
    assert.ok(closed.size > 0, 'idle historical dispatchers are reclaimed above the bound')
    assert.equal(closed.has(activeDispatcher), false, 'an unread active response keeps its lease')

    activeBodyController.enqueue(new TextEncoder().encode(JSON.stringify(chatReply('active OK'))))
    activeBodyController.close()
    await activeCall

    for (let index = 0; index < 40; index += 1) {
      await churnRouter.callProvider(
        'proxy-cache-churn',
        '/chat/completions',
        (provider) => ({ model: provider.model }),
        {
          validatePayload: validateChatResponse,
          transportOverride: {
            proxyUrls: [`http://127.0.0.1:${18100 + index}`],
            directFallback: false,
          },
        },
      )
    }
    assert.equal(closed.has(activeDispatcher), true, 'the released LRU dispatcher becomes reclaimable')
  } finally {
    ProxyAgent.prototype.close = originalClose
    if (activeBodyController) {
      try { activeBodyController.close() } catch {}
    }
    await activeCall.catch(() => {})
  }
})

test('an HTTP 5xx is a Provider outcome and is not replayed through another proxy', async () => {
  let calls = 0
  let cancelled = false
  const agent = new HubAgent({
    chat: new ProviderRouter({
      providers: providers('override-probe'),
      logger: quiet,
      fetchImpl: async () => {
        calls += 1
        return new Response(new ReadableStream({
          cancel() { cancelled = true },
        }), { status: 502 })
      },
    }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })

  await assert.rejects(() => agent.testProvider({
    kind: 'chat',
    providerId: 'override-probe',
    transportOverride: {
      proxyUrls: ['http://127.0.0.1:17893', 'http://127.0.0.1:17894'],
      directFallback: false,
    },
  }), (error) => error instanceof NoProviderAvailableError
    && error.attempts?.[0]?.error === 'HTTP 502')

  assert.equal(calls, 1)
  assert.equal(cancelled, true)
})

test('provider HTTP outcomes other than 5xx do not retry through another proxy', async () => {
  for (const status of [429, 401, 403, 404]) {
    let calls = 0
    const router = new ProviderRouter({
      providers: providers(`status-${status}`),
      logger: quiet,
      fetchImpl: async () => {
        calls += 1
        return jsonResponse({ error: 'provider outcome' }, status)
      },
    })

    await assert.rejects(() => router.callProvider(
      `status-${status}`,
      '/chat/completions',
      (provider) => ({ model: provider.model }),
      {
        transportOverride: {
          proxyUrls: ['http://127.0.0.1:17895', 'http://127.0.0.1:17896'],
          directFallback: false,
        },
      },
    ))
    assert.equal(calls, 1, `HTTP ${status} is not retried through another proxy`)
  }
})

test('a 5xx from the final transport route still fails over to the next Provider', async () => {
  const seen = []
  const router = new ProviderRouter({
    providers: providers('route-primary', 'route-secondary'),
    logger: quiet,
    fetchImpl: async (url) => {
      const id = new URL(url).hostname.split('.')[0]
      seen.push(id)
      return id === 'route-primary'
        ? jsonResponse({ error: 'unavailable' }, 503)
        : jsonResponse(chatReply('fallback Provider'))
    },
  })

  const result = await router.call('/chat/completions', (provider) => ({ model: provider.model }), {
    transportOverride: {
      proxyUrls: ['http://127.0.0.1:17897'],
      directFallback: false,
    },
  })

  assert.equal(result.provider, 'route-secondary')
  assert.deepEqual(seen, ['route-primary', 'route-secondary'])
  assert.deepEqual(result.attempts, [{ provider: 'route-primary', error: 'HTTP 503' }])
})

test('caller abort does not continue to another override transport route', async () => {
  const controller = new AbortController()
  let calls = 0
  const router = new ProviderRouter({
    providers: providers('abort-route'),
    logger: quiet,
    fetchImpl: async () => {
      calls += 1
      controller.abort(new Error('caller stopped'))
      throw controller.signal.reason
    },
  })

  await assert.rejects(
    () => router.call('/chat/completions', (provider) => ({ model: provider.model }), {
      signal: controller.signal,
      transportOverride: {
        proxyUrls: ['http://127.0.0.1:17898', 'http://127.0.0.1:17899'],
        directFallback: false,
      },
    }),
    /caller stopped/,
  )
  assert.equal(calls, 1)
})

test('transport diagnostics never leak proxy or network details into attempts', async () => {
  const router = new ProviderRouter({
    providers: providers('private-route'),
    logger: quiet,
    fetchImpl: async () => {
      throw new Error('connect db-password=AUDIT_SENTINEL via 10.0.0.7')
    },
  })

  await assert.rejects(
    () => router.call('/chat/completions', (entry) => ({ model: entry.model })),
    (error) => {
      assert.equal(error.attempts[0].error, 'transport failure')
      assert.doesNotMatch(error.message, /AUDIT_SENTINEL|10\.0\.0\.7/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// Failover policy
// ---------------------------------------------------------------------------

test('provider-side failures fail over; request-side failures do not', () => {
  // Someone else may be able to serve this.
  for (const status of [null, 429, 500, 503, 401, 403, 404]) {
    assert.equal(shouldFailover(status), true, `${status} should fail over`)
  }
  // Asking a second provider the same malformed question fails identically,
  // and costs another round trip and another bill.
  for (const status of [400, 422]) {
    assert.equal(shouldFailover(status), false, `${status} should not fail over`)
  }
})

test('a down primary falls over to the next provider', async () => {
  const seen = []
  const router = new ProviderRouter({
    providers: providers('primary', 'secondary'),
    logger: quiet,
    fetchImpl: async (url) => {
      seen.push(new URL(url).hostname)
      if (url.includes('primary')) return jsonResponse({ error: 'overloaded' }, 503)
      return jsonResponse(chatReply('ok'))
    },
  })
  const result = await router.call('/chat/completions', (p) => ({ model: p.model }))
  assert.equal(result.provider, 'secondary')
  assert.deepEqual(seen, ['primary.invalid', 'secondary.invalid'])
  // The attempt trail is part of the result: a system quietly running on its
  // second-choice model for a month is otherwise invisible.
  assert.equal(result.attempts.length, 1)
  assert.match(result.attempts[0].error, /503/)
})

test('an exact provider probe never succeeds through a fallback provider', async () => {
  const seen = []
  const router = new ProviderRouter({
    providers: providers('primary', 'secondary'),
    logger: quiet,
    fetchImpl: async (url) => {
      seen.push(new URL(url).hostname)
      if (url.includes('primary')) return jsonResponse({ error: 'unavailable' }, 503)
      return jsonResponse(chatReply('fallback must not be used'))
    },
  })

  await assert.rejects(
    () => router.callProvider('primary', '/chat/completions', (provider) => ({ model: provider.model })),
    (error) => {
      assert.ok(error instanceof NoProviderAvailableError)
      assert.deepEqual(error.attempts, [{ provider: 'primary', error: 'HTTP 503' }])
      return true
    },
  )
  assert.deepEqual(seen, ['primary.invalid'])
})

test('a 2xx chat payload without message content fails over before closing the circuit', async () => {
  const seen = []
  const chat = new ProviderRouter({
    providers: providers('primary', 'secondary'),
    logger: quiet,
    fetchImpl: async (url) => {
      seen.push(new URL(url).hostname)
      return url.includes('primary')
        ? jsonResponse({ choices: [{}] })
        : jsonResponse(chatReply('valid fallback'))
    },
  })
  const agent = new HubAgent({
    chat,
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })

  const result = await agent.complete([{ role: 'user', content: 'hello' }])

  assert.equal(result.provider, 'secondary')
  assert.deepEqual(seen, ['primary.invalid', 'secondary.invalid'])
  assert.match(result.attempts[0].error, /chat message content/)
  assert.equal(chat.status()[0].circuit, 'degraded')
  assert.equal(chat.status()[1].circuit, 'closed')
})

test('an exact chat probe maps a semantic 2xx failure to a stable 502', async () => {
  const agent = new HubAgent({
    chat: new ProviderRouter({
      providers: providers('broken'),
      logger: quiet,
      fetchImpl: async () => jsonResponse({ choices: [{}] }),
    }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })

  await assert.rejects(
    () => agent.testProvider({ kind: 'chat', providerId: 'broken' }),
    (error) => {
      assert.ok(error instanceof NoProviderAvailableError)
      assert.equal(error.status, 502)
      assert.equal(error.code, 'agent_invalid_response')
      return true
    },
  )
})

test('a malformed request is not retried across every provider', async () => {
  let calls = 0
  const router = new ProviderRouter({
    providers: providers('primary', 'secondary'),
    logger: quiet,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({ error: 'context length exceeded' }, 400)
    },
  })
  await assert.rejects(() => router.call('/chat/completions', (p) => ({ model: p.model })), /rejected the request/)
  assert.equal(calls, 1, 'the second provider is never asked')
})

test('a timeout counts as a provider failure and fails over', async () => {
  const router = new ProviderRouter({
    providers: [{ ...providers('slow')[0], timeoutMs: 20 }, ...providers('fast')],
    logger: quiet,
    fetchImpl: async (url, options) => {
      if (url.includes('slow')) {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }
      return jsonResponse(chatReply('ok'))
    },
  })
  const result = await router.call('/chat/completions', (p) => ({ model: p.model }))
  assert.equal(result.provider, 'fast')
  assert.match(result.attempts[0].error, /timed out/)
})

test('completed provider calls detach the shared worker abort listener', async () => {
  const router = new ProviderRouter({
    providers: providers('primary'),
    logger: quiet,
    fetchImpl: async () => jsonResponse(chatReply('ok')),
  })
  const controller = new AbortController()

  for (let index = 0; index < 20; index += 1) {
    await router.call('/chat/completions', (provider) => ({ model: provider.model }), {
      signal: controller.signal,
    })
  }

  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('every provider failing raises NoProviderAvailableError with the trail', async () => {
  const router = new ProviderRouter({
    providers: providers('a', 'b'),
    logger: quiet,
    fetchImpl: async () => jsonResponse({}, 500),
  })
  await assert.rejects(
    () => router.call('/chat/completions', (p) => ({ model: p.model })),
    (error) => error instanceof NoProviderAvailableError
      && error.status === 503
      && error.code === 'agent_providers_unavailable'
      && error.attempts.length === 2,
  )
})

test('a configured-but-unset API key is reported, not silently skipped', async () => {
  const router = new ProviderRouter({
    providers: [{ ...providers('keyed')[0], apiKeyEnv: 'DEFINITELY_UNSET_KEY' }],
    logger: quiet,
    fetchImpl: async () => assert.fail('must not be called without a key'),
  })
  await assert.rejects(
    () => router.call('/chat/completions', (p) => ({ model: p.model })),
    (error) => {
      assert.match(error.message, /API key is not configured/)
      assert.doesNotMatch(error.message, /DEFINITELY_UNSET_KEY/)
      return true
    },
  )
})

test('provider calls do not expose upstream bodies and refuse redirects', async () => {
  let redirectMode = null
  const router = new ProviderRouter({
    providers: providers('only'),
    logger: quiet,
    fetchImpl: async (_url, options) => {
      redirectMode = options.redirect
      return new Response('reflected-secret-and-prompt', { status: 503 })
    },
  })
  await assert.rejects(
    () => router.call('/chat/completions', () => ({})),
    (error) => {
      assert.equal(redirectMode, 'error')
      assert.doesNotMatch(JSON.stringify(error), /reflected-secret-and-prompt/)
      assert.equal(error.attempts[0].error, 'HTTP 503')
      return true
    },
  )
})

test('invalid successful provider JSON is replaced before attempts or logs', async () => {
  const logged = []
  const router = new ProviderRouter({
    providers: providers('only'),
    logger: { warn(message) { logged.push(message) } },
    fetchImpl: async () => new Response('sensitive-upstream-response-fragment', { status: 200 }),
  })
  await assert.rejects(
    () => router.call('/chat/completions', () => ({})),
    (error) => {
      assert.equal(error.attempts[0].error, 'provider returned invalid JSON')
      assert.doesNotMatch(JSON.stringify({ error, logged }), /sensitive-upstream-response-fragment/)
      return true
    },
  )
})

test('authMode none never emits an Authorization header', async () => {
  let authorization = 'not-called'
  const router = new ProviderRouter({
    providers: [{
      ...providers('anonymous')[0], authMode: 'none', apiKey: 'must-not-be-sent',
    }],
    logger: quiet,
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization
      return jsonResponse(chatReply('ok'))
    },
  })
  await router.call('/chat/completions', () => ({}))
  assert.equal(authorization, undefined)
})

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

test('a repeatedly failing provider is skipped instead of timing out every request', async () => {
  let primaryCalls = 0
  const router = new ProviderRouter({
    providers: providers('primary', 'secondary'),
    logger: quiet,
    fetchImpl: async (url) => {
      if (url.includes('primary')) {
        primaryCalls += 1
        return jsonResponse({}, 500)
      }
      return jsonResponse(chatReply('ok'))
    },
  })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await router.call('/chat/completions', (p) => ({ model: p.model }))
  }
  // Without the breaker every request would pay the dead primary's full
  // timeout: failover works and the system is still unusable.
  assert.equal(primaryCalls, 3, 'the primary stops being tried after 3 consecutive failures')
  assert.equal(router.status()[0].circuit, 'open')
})

test('a manual Sequence probe can recover an open circuit without changing production routing', async () => {
  let healthy = false
  let calls = 0
  const router = new ProviderRouter({
    providers: providers('primary'),
    logger: quiet,
    fetchImpl: async () => {
      calls += 1
      return healthy ? jsonResponse(chatReply('recovered')) : jsonResponse({}, 503)
    },
  })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => router.callSequence(
      ['primary'], '/chat/completions', (provider) => ({ model: provider.model }),
    ))
  }
  healthy = true
  await assert.rejects(
    () => router.callSequence(['primary'], '/chat/completions', () => ({})),
    (error) => error.attempts?.[0]?.error === 'circuit open',
  )
  assert.equal(calls, 3, 'normal traffic still skips the open circuit')

  const recovered = await router.callSequence(
    ['primary'], '/chat/completions', (provider) => ({ model: provider.model }),
    { ignoreCircuit: true },
  )
  assert.equal(recovered.provider, 'primary')
  assert.equal(calls, 4)
  assert.equal(router.status()[0].circuit, 'closed')
})

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

test('embedding providers with different dimensions are rejected at construction', () => {
  // This is the failover that silently corrupts a vector index: dense_vector
  // has a fixed `dims`, and a differently-sized fallback either errors on every
  // write or writes mutually incomparable vectors.
  assert.throws(
    () => new EmbeddingRouter({
      providers: [
        { id: 'a', baseUrl: 'https://a/v1', model: 'm1', dimensions: 1024, timeoutMs: 1000 },
        { id: 'b', baseUrl: 'https://b/v1', model: 'm2', dimensions: 1536, timeoutMs: 1000 },
      ],
      logger: quiet,
    }),
    /disagree on dimensions/,
  )
})

test('embedding failover requires the same model even when dimensions match', () => {
  assert.throws(
    () => new EmbeddingRouter({
      providers: [
        { id: 'a', baseUrl: 'https://a/v1', model: 'space-a', dimensions: 4, timeoutMs: 1000 },
        { id: 'b', baseUrl: 'https://b/v1', model: 'space-b', dimensions: 4, timeoutMs: 1000 },
      ],
      logger: quiet,
    }),
    /disagree on model/,
  )
})

test('embedding providers must match the dimensions the index was built for', () => {
  assert.throws(
    () => new EmbeddingRouter({
      providers: [{ id: 'a', baseUrl: 'https://a/v1', model: 'm1', dimensions: 1024, timeoutMs: 1000 }],
      expectedDimensions: 768,
      logger: quiet,
    }),
    /produce 1024 dimensions but the index expects 768/,
  )
})

test('a provider that returns the wrong dimension count is rejected at the boundary', async () => {
  const router = new EmbeddingRouter({
    providers: [{ id: 'a', baseUrl: 'https://a/v1', model: 'm1', dimensions: 4, apiKeyEnv: null, timeoutMs: 1000 }],
    logger: quiet,
    // Configuration can be right while a provider silently serves a different
    // model revision.
    fetchImpl: async () => jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] }),
  })
  await assert.rejects(() => router.embed(['hello']), /returned 2 dimensions, expected 4/)
})

test('an invalid embedding 2xx payload fails over before circuit success is recorded', async () => {
  const seen = []
  const shared = {
    model: 'shared-space', dimensions: 2, apiKeyEnv: null, timeoutMs: 1_000,
  }
  const router = new EmbeddingRouter({
    providers: [
      { ...shared, id: 'primary', baseUrl: 'https://primary.invalid/v1' },
      { ...shared, id: 'secondary', baseUrl: 'https://secondary.invalid/v1' },
    ],
    logger: quiet,
    fetchImpl: async (url) => {
      seen.push(new URL(url).hostname)
      return url.includes('primary')
        ? jsonResponse({ data: [{ index: 0, embedding: [1] }] })
        : jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] })
    },
  })

  const result = await router.embed(['hello'])

  assert.equal(result.provider, 'secondary')
  assert.deepEqual(result.vectors, [[1, 2]])
  assert.deepEqual(seen, ['primary.invalid', 'secondary.invalid'])
  assert.equal(router.status()[0].circuit, 'degraded')
  assert.equal(router.status()[1].circuit, 'closed')
})

test('embedding validates every finite vector and any returned model identity', async () => {
  const providerConfig = {
    id: 'only', baseUrl: 'https://only.invalid/v1', model: 'space-a',
    dimensions: 2, apiKeyEnv: null, timeoutMs: 1_000,
  }
  for (const payload of [
    {
      model: 'space-a',
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [3, Number.NaN] },
      ],
    },
    {
      model: 'space-b',
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [3, 4] },
      ],
    },
  ]) {
    const router = new EmbeddingRouter({
      providers: [providerConfig],
      logger: quiet,
      fetchImpl: async () => jsonResponse(payload),
    })
    await assert.rejects(
      () => router.embed(['first', 'second']),
      (error) => error.status === 502 && error.code === 'agent_invalid_response',
    )
  }
})

test('embeddings are returned in input order regardless of response order', async () => {
  const router = new EmbeddingRouter({
    providers: [{ id: 'a', baseUrl: 'https://a/v1', model: 'm1', dimensions: 2, apiKeyEnv: null, timeoutMs: 1000 }],
    logger: quiet,
    fetchImpl: async () => jsonResponse({
      data: [
        { index: 1, embedding: [3, 4] },
        { index: 0, embedding: [1, 2] },
      ],
    }),
  })
  const { vectors } = await router.embed(['first', 'second'])
  assert.deepEqual(vectors, [[1, 2], [3, 4]])
})

test('HubAgent forwards a transport override through an embedding Sequence', async () => {
  let dispatcher = null
  const embeddingProvider = {
    id: 'embedding-override',
    baseUrl: 'https://embedding-override.invalid/v1',
    model: 'shared-space',
    dimensions: 2,
    apiKeyEnv: null,
    timeoutMs: 1_000,
  }
  const agent = new HubAgent({
    chat: new ProviderRouter({ providers: [], logger: quiet }),
    embeddings: new EmbeddingRouter({
      providers: [embeddingProvider],
      logger: quiet,
      fetchImpl: async (_url, options) => {
        dispatcher = options.dispatcher
        return jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] })
      },
    }),
    logger: quiet,
  })

  const result = await agent.embed(['hello'], {
    providerIds: ['embedding-override'],
    transportOverride: {
      proxyUrls: ['http://127.0.0.1:17900'],
      directFallback: false,
    },
  })

  assert.ok(dispatcher)
  assert.deepEqual(result.vectors, [[1, 2]])
})

// ---------------------------------------------------------------------------
// Agent behaviour
// ---------------------------------------------------------------------------

function agentWith(fetchImpl) {
  return new HubAgent({
    chat: new ProviderRouter({ providers: providers('m'), logger: quiet, fetchImpl }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })
}

test('HubAgent tests one chat provider with a bounded data-free request', async () => {
  let request = null
  const agent = new HubAgent({
    chat: new ProviderRouter({
      providers: providers('chat-probe'),
      logger: quiet,
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) }
        return jsonResponse(chatReply('OK'))
      },
    }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })

  const result = await agent.testProvider({ kind: 'chat', providerId: 'chat-probe' })

  assert.equal(request.url, 'https://chat-probe.invalid/v1/chat/completions')
  assert.deepEqual(request.body, {
    model: 'chat-probe-model',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    temperature: 0,
    max_tokens: 1_024,
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'chat')
  assert.equal(result.providerId, 'chat-probe')
  assert.equal(result.model, 'chat-probe-model')
  assert.equal(Number.isInteger(result.latencyMs), true)
  assert.equal(Number.isNaN(Date.parse(result.testedAt)), false)
  assert.equal('payload' in result, false)
})

test('chat provider probes leave enough budget for a reasoning model to produce final content', async () => {
  let requestBody = null
  const agent = new HubAgent({
    chat: new ProviderRouter({
      providers: providers('reasoning-probe'),
      logger: quiet,
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body)
        return requestBody.max_tokens < 1_024
          ? jsonResponse({
              choices: [{
                finish_reason: 'length',
                message: { content: null, reasoning_content: 'Still reasoning' },
              }],
            })
          : jsonResponse(chatReply('OK'))
      },
    }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })

  const result = await agent.testProvider({ kind: 'chat', providerId: 'reasoning-probe' })

  assert.equal(requestBody.max_tokens, 1_024)
  assert.equal(result.ok, true)
})

test('a reasoning-only response reports output-budget exhaustion without exposing reasoning', async () => {
  const agent = new HubAgent({
    chat: new ProviderRouter({
      providers: providers('reasoning-only'),
      logger: quiet,
      fetchImpl: async () => jsonResponse({
        choices: [{
          finish_reason: 'length',
          message: {
            content: null,
            reasoning_content: 'private-reasoning-sentinel',
          },
        }],
      }),
    }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })

  await assert.rejects(
    () => agent.testProvider({ kind: 'chat', providerId: 'reasoning-only' }),
    (error) => {
      assert.equal(error.status, 502)
      assert.equal(error.code, 'agent_invalid_response')
      assert.match(error.message, /output token budget while reasoning/)
      assert.doesNotMatch(error.message, /private-reasoning-sentinel/)
      return true
    },
  )
})

test('HubAgent tests one embedding provider and validates its returned vector', async () => {
  let request = null
  const agent = new HubAgent({
    chat: new ProviderRouter({ providers: [], logger: quiet }),
    embeddings: new EmbeddingRouter({
      providers: [{
        id: 'embedding-probe',
        baseUrl: 'https://embedding-probe.invalid/v1',
        model: 'embedding-probe-model',
        dimensions: 2,
        apiKeyEnv: null,
        timeoutMs: 1_000,
      }],
      logger: quiet,
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) }
        return jsonResponse({ data: [{ index: 0, embedding: [0.25, 0.75] }] })
      },
    }),
    logger: quiet,
  })

  const result = await agent.testProvider({ kind: 'embedding', providerId: 'embedding-probe' })

  assert.equal(request.url, 'https://embedding-probe.invalid/v1/embeddings')
  assert.deepEqual(request.body, {
    model: 'embedding-probe-model',
    input: ['MX Insight Hub provider connectivity test'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'embedding')
  assert.equal(result.providerId, 'embedding-probe')
  assert.equal(result.model, 'embedding-probe-model')
  assert.equal('vectors' in result, false)
})

test('mapping suggestion falls back to the deterministic matcher when no model is configured', async () => {
  const agent = new HubAgent({
    chat: new ProviderRouter({ providers: [], logger: quiet }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })
  const result = await agent.suggestFieldMap({ columns: ['id', '标题', '点赞'] })
  assert.equal(result.origin, 'inferred')
  assert.equal(result.fieldMap.externalId.from, 'id')
})

test('mapping suggestion degrades to inference when every provider fails', async () => {
  const agent = agentWith(async () => jsonResponse({}, 500))
  const result = await agent.suggestFieldMap({ columns: ['id', 'title'] })
  assert.equal(result.origin, 'inferred')
  assert.ok(result.degradedReason, 'the degradation is reported rather than hidden')
})

test('file profile sends only value-free first/middle/last structure evidence', async () => {
  let providerRequest = null
  const agent = agentWith(async (_url, options) => {
    providerRequest = JSON.parse(options.body)
    return jsonResponse(chatReply(JSON.stringify({
      platform: 'twitter',
      objectType: 'post',
      fieldMap: { externalId: { from: 'content_id' }, body: { from: 'text' } },
    })))
  })
  const result = await agent.suggestFileProfile({
    columns: ['content_id', 'text'],
    sampling: {
      strategy: 'head-middle-tail',
      sourceRowCount: 100,
      sampledRowCount: 9,
      sampledPositions: [{ position: 'head', index: 0 }, { position: 'tail', index: 99 }],
      columns: [{
        name: 'content_id', presentCount: 2, nonEmptyCount: 2, valueTypeFamilies: ['string'],
      }],
      signals: { twitterPlatformCount: 2 },
      items: [{ raw: { text: 'must-never-reach-agent', content_id: 'secret-id' } }],
    },
  })
  assert.equal(result.platform, 'twitter')
  assert.equal(result.objectType, 'post')
  assert.equal(result.origin, 'agent')
  assert.doesNotMatch(JSON.stringify(providerRequest), /must-never-reach-agent|secret-id|"raw"/)
  assert.match(JSON.stringify(providerRequest), /head-middle-tail/)
})

test('hallucinated columns are dropped from a model mapping', async () => {
  const agent = agentWith(async () => jsonResponse(chatReply(JSON.stringify({
    externalId: { from: 'id' },
    title: { from: '标题' },
    // Neither of these columns exists in the file.
    body: { from: 'a_column_that_does_not_exist' },
    url: { from: 'invented' },
  }))))
  const result = await agent.suggestFieldMap({ columns: ['id', '标题'] })
  assert.equal(result.origin, 'agent')
  // A hallucinated column produces a mapping that reads plausibly and maps
  // nothing -- the failure mode that survives review.
  assert.deepEqual(Object.keys(result.fieldMap).sort(), ['externalId', 'title'])
})

test('a model mapping that drops externalId degrades instead of being returned', async () => {
  const agent = agentWith(async () => jsonResponse(chatReply(JSON.stringify({ title: { from: 'id' } }))))
  const result = await agent.suggestFieldMap({ columns: ['id'] })
  // Validation runs before the suggestion escapes, so an unusable mapping never
  // reaches the approval screen looking legitimate.
  assert.equal(result.origin, 'inferred')
  assert.match(result.degradedReason, /externalId is required/)
})

test('a fenced JSON response is still parsed', async () => {
  const agent = agentWith(async () => jsonResponse(chatReply(
    'Sure! Here is the mapping:\n```json\n{"externalId": {"from": "id"}}\n```',
  )))
  const result = await agent.suggestFieldMap({ columns: ['id'] })
  assert.equal(result.origin, 'agent')
  assert.equal(result.fieldMap.externalId.from, 'id')
})

test('malformed model JSON never enters degradedReason', async () => {
  const agent = agentWith(async () => jsonResponse(chatReply(
    '{"externalId": sensitive-model-response-fragment}',
  )))
  const result = await agent.suggestFieldMap({ columns: ['id'] })
  assert.equal(result.origin, 'inferred')
  assert.equal(result.degradedReason, 'Model response was not valid JSON')
  assert.doesNotMatch(JSON.stringify(result), /sensitive-model-response-fragment/)
})

test('classification rejects a category outside the allowed set', async () => {
  const agent = agentWith(async () => jsonResponse(chatReply('{"category":"something_invented","confidence":0.9}')))
  const result = await agent.classifyRecord({ record: { a: 1 }, categories: ['post', 'comment'] })
  // A category outside the list is a hallucination, not a new class.
  assert.equal(result.category, 'unknown')
  assert.equal(result.confidence, 0)
})

test('classification returns null when unavailable so the caller keeps the raw record', async () => {
  const agent = new HubAgent({
    chat: new ProviderRouter({ providers: [], logger: quiet }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })
  // An unclassified row in `extensions` is recoverable; a discarded one is not.
  assert.equal(await agent.classifyRecord({ record: {}, categories: ['a'] }), null)
})

test('embedding without a provider fails loudly: there is no fallback for a vector', async () => {
  const agent = new HubAgent({
    chat: new ProviderRouter({ providers: [], logger: quiet }),
    embeddings: new EmbeddingRouter({ providers: [], logger: quiet }),
    logger: quiet,
  })
  await assert.rejects(() => agent.embed(['x']), /No embedding provider is configured/)
})

test('a baseUrl that already contains an endpoint path is rejected', () => {
  // The router appends /chat/completions itself; a baseUrl carrying it produces
  // /v1/chat/completions/chat/completions and 404s on every single call, which
  // then looks like the provider being down and fails over to nothing.
  assert.throws(
    () => parseProviderConfig(JSON.stringify([
      { id: 'openai', baseUrl: 'https://llm.example.com/v1/chat/completions', model: 'gpt-4o-mini' },
    ])),
    /baseUrl must be the API root/,
  )
  assert.throws(
    () => parseProviderConfig(JSON.stringify([
      { id: 'x', baseUrl: 'https://llm.example.com/v1/embeddings', model: 'e' },
    ])),
    /baseUrl must be the API root/,
  )
  assert.throws(
    () => parseProviderConfig(JSON.stringify([
      { id: 'claude', baseUrl: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-0' },
    ])),
    /baseUrl must be the API root/,
  )
  // The message names the correction rather than only the problem.
  try {
    parseProviderConfig(JSON.stringify([
      { id: 'openai', baseUrl: 'https://llm.example.com/v1/chat/completions', model: 'm' },
    ]))
  } catch (error) {
    assert.match(error.message, /Use "https:\/\/llm\.example\.com\/v1"/)
  }
})

test('trailing slashes are normalised without tripping the endpoint check', () => {
  const [provider] = parseProviderConfig(JSON.stringify([
    { id: 'openai', baseUrl: 'https://llm.example.com/v1///', model: 'gpt-4o-mini' },
  ]))
  assert.equal(provider.baseUrl, 'https://llm.example.com/v1')
})
