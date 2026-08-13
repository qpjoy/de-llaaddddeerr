import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EmbeddingRouter,
  HubAgent,
  NoProviderAvailableError,
  ProviderRouter,
  parseProviderConfig,
  shouldFailover,
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

test('every provider failing raises NoProviderAvailableError with the trail', async () => {
  const router = new ProviderRouter({
    providers: providers('a', 'b'),
    logger: quiet,
    fetchImpl: async () => jsonResponse({}, 500),
  })
  await assert.rejects(
    () => router.call('/chat/completions', (p) => ({ model: p.model })),
    (error) => error instanceof NoProviderAvailableError && error.attempts.length === 2,
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
