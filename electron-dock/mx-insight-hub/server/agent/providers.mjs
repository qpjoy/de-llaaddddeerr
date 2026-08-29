import { AppError } from '../core/errors.mjs'
import { ProxyAgent } from 'undici'

// Model provider registry with ordered failover.
//
// Chat providers may speak either the OpenAI-compatible REST shape
// (`/chat/completions`) used by OpenAI, DeepSeek, Kimi, Qwen, vLLM and Ollama,
// or Anthropic's Messages shape (`/messages`). The rest of the Hub consumes one
// stable OpenAI-shaped envelope so adding a transport never leaks vendor
// conditionals into Agent graphs. Embeddings remain OpenAI-compatible because
// Anthropic does not expose an embedding endpoint.
//
// Configuration (MX_INSIGHT_AGENT_PROVIDERS, JSON array, priority order):
//
//   [
//     { "id": "deepseek", "baseUrl": "https://api.deepseek.com/v1",
//       "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" },
//     { "id": "openai", "baseUrl": "https://api.openai.com/v1",
//       "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" }
//   ]
//
// API keys are referenced by environment variable NAME. The provider list is
// visible in a ConfigMap and in admin responses; the keys are not, and live in
// the runtime Secret.

const DEFAULT_TIMEOUT_MS = 60_000
// After this many consecutive failures a provider is skipped until its cooldown
// elapses. Without it, a dead primary makes every single request pay its full
// timeout before failing over — the failover works and the system is still
// unusable.
const CIRCUIT_THRESHOLD = 3
const CIRCUIT_COOLDOWN_MS = 60_000
const MAX_CACHED_PROXY_DISPATCHERS = 32
const proxyDispatchers = new Map()

function closeProxyDispatcher(dispatcher) {
  try {
    Promise.resolve(dispatcher.close()).catch(() => {})
  } catch {
    // Eviction is best-effort. A close failure must not fail an unrelated model
    // request or put an already-removed dispatcher back into the cache.
  }
}

function evictIdleProxyDispatchers() {
  while (proxyDispatchers.size > MAX_CACHED_PROXY_DISPATCHERS) {
    const oldestIdle = [...proxyDispatchers]
      .find(([, entry]) => entry.active === 0)
    if (!oldestIdle) return
    const [proxyUrl, entry] = oldestIdle
    proxyDispatchers.delete(proxyUrl)
    closeProxyDispatcher(entry.dispatcher)
  }
}

function acquireProxyDispatcher(proxyUrl) {
  let entry = proxyDispatchers.get(proxyUrl)
  if (!entry) {
    entry = { dispatcher: new ProxyAgent(proxyUrl), active: 0 }
  } else {
    // Map insertion order is the LRU order. Active entries remain protected by
    // their lease even if they become the oldest item while a body is streaming.
    proxyDispatchers.delete(proxyUrl)
  }
  entry.active += 1
  proxyDispatchers.set(proxyUrl, entry)
  evictIdleProxyDispatchers()

  let released = false
  return {
    dispatcher: entry.dispatcher,
    release() {
      if (released) return
      released = true
      entry.active -= 1
      evictIdleProxyDispatchers()
    },
  }
}

export class NoProviderAvailableError extends AppError {
  constructor(attempts, { invalidResponse = false } = {}) {
    super(
      invalidResponse ? 502 : 503,
      invalidResponse ? 'agent_invalid_response' : 'agent_providers_unavailable',
      `No model provider could serve the request (${attempts.map((a) => `${a.provider}: ${a.error}`).join('; ')})`,
    )
    this.name = 'NoProviderAvailableError'
    this.attempts = attempts
  }
}

/** Validate the subset of the OpenAI chat shape consumed by HubAgent. */
export function validateChatResponse(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    const choice = payload?.choices?.[0]
    const reasoningContent = choice?.message?.reasoning_content
    const exhaustedWhileReasoning = choice?.finish_reason === 'length'
      && typeof reasoningContent === 'string'
      && reasoningContent.trim().length > 0
    throw new AppError(
      502,
      'agent_invalid_response',
      exhaustedWhileReasoning
        ? 'Provider exhausted the output token budget while reasoning before producing final chat message content'
        : 'Provider response did not contain chat message content',
    )
  }
}

export function parseProviderConfig(raw, { kind = 'chat', allowInlineApiKey = false } = {}) {
  if (!raw) return []
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    // Parser messages can quote the malformed input. Static configuration must
    // never be reflected into logs because operators sometimes paste secrets
    // while diagnosing a provider entry.
    throw new AppError(500, 'invalid_configuration', 'agent provider config is not valid JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new AppError(500, 'invalid_configuration', 'agent provider config must be a JSON array')
  }
  return parsed.map((entry, index) => {
    if (!entry?.id || !entry?.baseUrl || !entry?.model) {
      throw new AppError(
        500,
        'invalid_configuration',
        `provider[${index}] requires id, baseUrl and model`,
      )
    }
    const hasInlineApiKey = Object.prototype.hasOwnProperty.call(entry, 'apiKey')
    if (hasInlineApiKey && !allowInlineApiKey) {
      throw new AppError(
        500,
        'invalid_configuration',
        `provider[${index}] must reference a runtime Secret with apiKeyEnv; inline apiKey is forbidden`,
      )
    }
    if (hasInlineApiKey && entry.apiKeyEnv) {
      throw new AppError(500, 'invalid_configuration', `provider[${index}] cannot use apiKey and apiKeyEnv together`)
    }
    const authMode = entry.authMode ?? (entry.apiKeyEnv || entry.apiKey ? 'bearer' : 'none')
    if (!['bearer', 'none'].includes(authMode)) {
      throw new AppError(500, 'invalid_configuration', `provider[${index}].authMode must be bearer or none`)
    }
    if (authMode === 'none' && (entry.apiKeyEnv || entry.apiKey)) {
      throw new AppError(500, 'invalid_configuration', `provider[${index}] cannot configure an API key when authMode is none`)
    }
    // The router appends the endpoint path itself, so a baseUrl that already
    // contains one produces `/v1/chat/completions/chat/completions` and a 404
    // on every call. Caught here because the alternative is discovering it
    // through a provider chain that silently fails over to nothing.
    const baseUrl = String(entry.baseUrl).replace(/\/+$/, '')
    for (const endpoint of ['/chat/completions', '/embeddings', '/completions', '/messages']) {
      if (baseUrl.endsWith(endpoint)) {
        throw new AppError(
          500,
          'invalid_configuration',
          `provider[${index}] "${entry.id}": baseUrl must be the API root, not an endpoint. ` +
            `Use "${baseUrl.slice(0, -endpoint.length)}" instead of "${baseUrl}".`,
        )
      }
    }

    const protocol = entry.protocol ?? 'openai-compatible'
    if (!['openai-compatible', 'anthropic-messages'].includes(protocol)) {
      throw new AppError(
        500,
        'invalid_configuration',
        `provider[${index}].protocol must be openai-compatible or anthropic-messages`,
      )
    }
    if (kind === 'embedding' && protocol !== 'openai-compatible') {
      throw new AppError(
        500,
        'invalid_configuration',
        `provider[${index}].protocol must be openai-compatible for embeddings`,
      )
    }

    return {
      id: entry.id,
      displayName: entry.displayName || entry.id,
      baseUrl,
      model: entry.model,
      protocol,
      proxySequenceKey: entry.proxySequenceKey || null,
      apiKeyEnv: entry.apiKeyEnv || null,
      // Database-backed settings resolve a credential before constructing the
      // router. Environment configuration keeps the original apiKeyEnv path.
      apiKey: entry.apiKey || null,
      authMode,
      timeoutMs: entry.timeoutMs || DEFAULT_TIMEOUT_MS,
      // Embedding providers carry dimensions because the index mapping is fixed
      // to them; see EmbeddingRouter for why mixing them is forbidden.
      dimensions: kind === 'embedding' ? (entry.dimensions ?? null) : undefined,
      kind,
    }
  })
}

/**
 * Decide whether a failure should fail over to the next provider.
 *
 * The distinction that matters: a provider-side problem (down, overloaded,
 * rate-limited, misconfigured key) means "ask someone else". A request-side
 * problem (malformed body, context too long) means "asking someone else will
 * fail identically" — retrying it across every provider just multiplies the
 * latency and the bill before returning the same error.
 */
export function shouldFailover(status) {
  if (status === null) return true // transport failure or timeout
  if (status === 429) return true
  if (status >= 500) return true
  // 401/403 is this provider's credential being wrong, not the request's fault.
  if (status === 401 || status === 403) return true
  if (status === 404) return true // model not available here
  return false
}

class CircuitBreaker {
  #failures = 0
  #openUntil = 0

  get open() {
    if (this.#openUntil === 0) return false
    if (Date.now() >= this.#openUntil) {
      // Half-open: allow one probe rather than reopening blind.
      this.#openUntil = 0
      this.#failures = CIRCUIT_THRESHOLD - 1
      return false
    }
    return true
  }

  recordSuccess() {
    this.#failures = 0
    this.#openUntil = 0
  }

  recordFailure() {
    this.#failures += 1
    if (this.#failures >= CIRCUIT_THRESHOLD) this.#openUntil = Date.now() + CIRCUIT_COOLDOWN_MS
  }

  get state() {
    return this.open ? 'open' : this.#failures > 0 ? 'degraded' : 'closed'
  }
}

function anthropicRequestBody(body) {
  const system = []
  const messages = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role === 'system') {
      if (typeof message.content === 'string' && message.content) system.push(message.content)
      continue
    }
    if (!['user', 'assistant'].includes(message?.role)) continue
    messages.push({ role: message.role, content: message.content })
  }
  return {
    model: body.model,
    max_tokens: body.max_tokens,
    messages,
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    ...(body.temperature == null ? {} : { temperature: Math.min(1, body.temperature) }),
  }
}

function normalizedAnthropicPayload(payload) {
  const content = Array.isArray(payload?.content)
    ? payload.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    : ''
  return {
    id: payload?.id,
    model: payload?.model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: {
      prompt_tokens: payload?.usage?.input_tokens,
      completion_tokens: payload?.usage?.output_tokens,
      total_tokens: Number.isFinite(payload?.usage?.input_tokens)
        && Number.isFinite(payload?.usage?.output_tokens)
        ? payload.usage.input_tokens + payload.usage.output_tokens
        : undefined,
    },
  }
}

function safeTransportFailure(error, { timedOut, timeoutMs }) {
  if (timedOut || error?.name === 'AbortError') return `timed out after ${timeoutMs}ms`
  // Fetch/Undici transport messages may contain proxy URLs, resolved IPs or
  // TLS diagnostics. Attempts are returned to Admin traces, so expose only a
  // stable class and keep raw details out of both the response and logger.
  return 'transport failure'
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.()
  } catch {
    // The response is already being discarded. A broken body stream must not
    // prevent the router from trying the next safe transport/provider route.
  }
}

export class ProviderRouter {
  #breakers = new Map()

  constructor({ providers, fetchImpl = globalThis.fetch, logger = console }) {
    this.providers = providers
    this.fetchImpl = fetchImpl
    this.logger = logger
    for (const provider of providers) this.#breakers.set(provider.id, new CircuitBreaker())
  }

  get available() {
    return this.providers.length > 0
  }

  #apiKey(provider) {
    if (provider.apiKey) return provider.apiKey
    if (provider.apiKeyEnv) return process.env[provider.apiKeyEnv] || null
    return null
  }

  #authMode(provider) {
    // Keep compatibility with callers that construct ProviderRouter entries
    // directly instead of going through parseProviderConfig. Historically the
    // presence of apiKeyEnv meant bearer authentication even though authMode
    // did not yet exist on the provider shape.
    return provider.authMode ?? (provider.apiKeyEnv || provider.apiKey ? 'bearer' : 'none')
  }

  /**
   * Call `path` on each provider in order until one succeeds.
   *
   * `buildBody` receives the provider so the model name (and anything else
   * provider-specific) is substituted per attempt rather than baked in by the
   * caller.
   */
  async call(path, buildBody, { signal, validatePayload, transportOverride } = {}) {
    return this.#callProviders(this.providers, path, buildBody, {
      signal,
      validatePayload,
      transportOverride,
    })
  }

  /** Call an ordered subset while sharing the catalog router's circuit state. */
  async callSequence(
    providerIds,
    path,
    buildBody,
    { signal, validatePayload, ignoreCircuit = false, transportOverride } = {},
  ) {
    if (!Array.isArray(providerIds) || providerIds.length === 0) {
      throw new AppError(503, 'agent_sequence_unavailable', 'The selected LLM Sequence has no providers')
    }
    const byId = new Map(this.providers.map((provider) => [provider.id, provider]))
    const providers = providerIds.map((providerId) => byId.get(providerId))
    if (providers.some((provider) => !provider)) {
      throw new AppError(503, 'agent_sequence_unavailable', 'The selected LLM Sequence references an unavailable provider')
    }
    return this.#callProviders(providers, path, buildBody, {
      signal,
      validatePayload,
      ignoreCircuit,
      transportOverride,
    })
  }

  /** Probe exactly one saved provider without silently succeeding on fallback. */
  async callProvider(providerId, path, buildBody, { signal, validatePayload, transportOverride } = {}) {
    const provider = this.providers.find((candidate) => candidate.id === providerId)
    if (!provider) {
      throw new AppError(404, 'agent_provider_not_found', 'The provider was not found in this runtime')
    }
    // An explicit operator probe is the recovery path for an open circuit, so
    // it must actually contact the selected provider. It still records the
    // result and closes/reopens that provider's circuit normally.
    return this.#callProviders([provider], path, buildBody, {
      signal,
      validatePayload,
      ignoreCircuit: true,
      transportOverride,
    })
  }

  async #callProviders(
    providers,
    path,
    buildBody,
    { signal, validatePayload, ignoreCircuit = false, transportOverride } = {},
  ) {
    if (providers.length === 0) {
      throw new AppError(503, 'agent_not_configured', 'No model provider is configured')
    }
    const attempts = []
    let sawInvalidResponse = false

    for (const catalogProvider of providers) {
      // A per-call route is runtime state, not Provider catalog state. Clone
      // only the effective Provider while preserving its ID so calls made with
      // and without an override share one circuit breaker.
      const provider = transportOverride
        ? {
            ...catalogProvider,
            proxyUrls: Array.isArray(transportOverride.proxyUrls)
              ? [...transportOverride.proxyUrls]
              : [],
            directFallback: transportOverride.directFallback,
          }
        : catalogProvider
      const breaker = this.#breakers.get(provider.id)
      if (!ignoreCircuit && breaker.open) {
        attempts.push({ provider: provider.id, error: 'circuit open', skipped: true })
        continue
      }
      const authMode = this.#authMode(provider)
      const apiKey = authMode === 'bearer' ? this.#apiKey(provider) : null
      if (authMode === 'bearer' && !apiKey) {
        // A configured-but-unset key is a deployment mistake worth surfacing,
        // not a silent skip that looks like the provider is down.
        const reason = 'API key is not configured'
        attempts.push({ provider: provider.id, error: reason })
        this.logger?.warn?.(`[agent] ${provider.id}: API key is not configured`)
        continue
      }

      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, provider.timeoutMs)
      const abortFromCaller = () => controller.abort()
      if (signal?.aborted) controller.abort()
      else signal?.addEventListener('abort', abortFromCaller, { once: true })
      const startedAt = performance.now()
      let responseProxyLease = null

      try {
        const anthropic = provider.protocol === 'anthropic-messages' && path === '/chat/completions'
        const requestPath = anthropic ? '/messages' : path
        const requestBody = buildBody(provider)
        const init = {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authMode === 'bearer' && apiKey
              ? anthropic
                ? { 'x-api-key': apiKey }
                : { authorization: `Bearer ${apiKey}` }
              : {}),
            ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}),
          },
          body: JSON.stringify(anthropic ? anthropicRequestBody(requestBody) : requestBody),
          signal: controller.signal,
          redirect: 'error',
        }
        const proxyUrls = Array.isArray(provider.proxyUrls) ? provider.proxyUrls : []
        const transportRoutes = [
          ...proxyUrls.map((proxyUrl) => ({ proxyUrl })),
          ...(provider.directFallback === false ? [] : [{ proxyUrl: null }]),
        ]
        let response = null
        let lastTransportError = null
        for (const route of transportRoutes) {
          if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
          let proxyLease = null
          try {
            proxyLease = route.proxyUrl ? acquireProxyDispatcher(route.proxyUrl) : null
            response = await this.fetchImpl(`${provider.baseUrl}${requestPath}`, {
              ...init,
              ...(proxyLease ? { dispatcher: proxyLease.dispatcher } : {}),
            })
            // Hold the dispatcher through response-body consumption/cancellation.
            // `fetch()` resolving only proves that headers arrived; closing the
            // dispatcher at that point can still interrupt a streaming body.
            responseProxyLease = proxyLease
            // An HTTP response may be a Provider response forwarded unchanged
            // by the proxy. Do not replay this non-idempotent, potentially
            // billable request through another proxy merely because it is 5xx.
            // Only transport exceptions below advance to the next route.
            break
          } catch (error) {
            proxyLease?.release()
            lastTransportError = error
            if (controller.signal.aborted) throw error
            this.logger?.warn?.(
              `[agent] ${provider.id} transport ${route.proxyUrl ? 'proxy' : 'direct'} failed; trying next route`,
            )
          }
        }
        if (!response) throw lastTransportError || new Error('No provider transport route is available')

        if (!response.ok) {
          // Upstream bodies may contain reflected prompts, credentials or vendor
          // diagnostics. Status is enough to decide failover; never copy the body
          // into an API error, attempt trail or log.
          await cancelResponseBody(response)
          if (!shouldFailover(response.status)) {
            // Our request is wrong; every other provider will reject it too.
            breaker.recordSuccess()
            throw new AppError(400, 'agent_request_rejected', 'Model rejected the request', {
              provider: provider.id,
              upstreamStatus: response.status,
            })
          }
          breaker.recordFailure()
          attempts.push({ provider: provider.id, error: `HTTP ${response.status}` })
          this.logger?.warn?.(`[agent] ${provider.id} failed (${response.status}); trying next provider`)
          continue
        }

        let payload
        try {
          payload = await response.json()
          if (anthropic) payload = normalizedAnthropicPayload(payload)
        } catch {
          // JSON parser errors may include a fragment of the upstream body.
          // Replace them before the generic failure trail/logging boundary.
          sawInvalidResponse = true
          breaker.recordFailure()
          attempts.push({ provider: provider.id, error: 'provider returned invalid JSON' })
          this.logger?.warn?.(`[agent] ${provider.id} returned invalid JSON; trying next provider`)
          continue
        }
        try {
          await validatePayload?.(payload, provider)
        } catch (error) {
          // A 2xx only proves that an HTTP server answered. Treat a payload that
          // cannot satisfy the caller's protocol as this provider's failure so
          // a healthy fallback gets a chance, and do not close its circuit.
          sawInvalidResponse = true
          breaker.recordFailure()
          const reason = error instanceof AppError
            ? error.message
            : 'provider returned an invalid response'
          attempts.push({ provider: provider.id, error: reason })
          this.logger?.warn?.(`[agent] ${provider.id} returned an invalid response; trying next provider`)
          continue
        }
        breaker.recordSuccess()
        return {
          provider: provider.id,
          model: provider.model,
          protocol: provider.protocol || 'openai-compatible',
          latencyMs: Math.round(performance.now() - startedAt),
          payload,
          // Which providers were skipped or failed on the way here. Callers
          // record it, because a system quietly running on its third-choice
          // model for a month is a problem nobody notices otherwise.
          attempts,
        }
      } catch (error) {
        if (error instanceof AppError) throw error
        // A caller cancellation is not a provider failure and must not start a
        // paid fallback request after the work that needed it has gone away.
        if (signal?.aborted && !timedOut) throw error
        breaker.recordFailure()
        const reason = safeTransportFailure(error, {
          timedOut,
          timeoutMs: provider.timeoutMs,
        })
        attempts.push({ provider: provider.id, error: reason })
        this.logger?.warn?.(`[agent] ${provider.id} failed (${reason}); trying next provider`)
      } finally {
        responseProxyLease?.release()
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', abortFromCaller)
      }
    }

    throw new NoProviderAvailableError(attempts, { invalidResponse: sawInvalidResponse })
  }

  status() {
    return this.providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName || provider.id,
      model: provider.model,
      protocol: provider.protocol || 'openai-compatible',
      dimensions: provider.dimensions,
      keyConfigured: this.#authMode(provider) !== 'bearer' || Boolean(this.#apiKey(provider)),
      circuit: this.#breakers.get(provider.id).state,
    }))
  }
}

/**
 * Embedding router with one extra, non-negotiable rule: every provider in the
 * chain must produce the SAME number of dimensions.
 *
 * This is the failover mode that silently corrupts a vector index. An
 * Elasticsearch `dense_vector` field has a fixed `dims`; falling back to a model
 * with different dimensions either errors on every write (best case) or, where
 * dimensions happen to match but the vector space does not, writes vectors that
 * are mutually incomparable — the index keeps working and quietly returns
 * nonsense neighbours. Refusing the configuration at startup is the only place
 * this can be caught cheaply.
 */
export class EmbeddingRouter extends ProviderRouter {
  constructor({ providers, expectedDimensions, ...rest }) {
    if (providers.length > 0) {
      const dimensions = new Set(providers.map((provider) => provider.dimensions))
      if (dimensions.size > 1) {
        throw new AppError(
          500,
          'invalid_configuration',
          `embedding providers disagree on dimensions (${[...dimensions].join(', ')}); ` +
            'falling back to a differently-sized model would corrupt the vector index',
        )
      }
      const models = new Set(providers.map((provider) => provider.model))
      if (models.size > 1) {
        throw new AppError(
          500,
          'invalid_configuration',
          `embedding providers disagree on model (${[...models].join(', ')}); ` +
            'falling back across vector spaces would corrupt retrieval quality',
        )
      }
      const [configured] = [...dimensions]
      if (expectedDimensions && configured && configured !== expectedDimensions) {
        throw new AppError(
          500,
          'invalid_configuration',
          `embedding providers produce ${configured} dimensions but the index expects ${expectedDimensions}`,
        )
      }
    }
    super({ providers, ...rest })
    this.dimensions = providers[0]?.dimensions ?? expectedDimensions ?? null
  }

  async embed(inputs, options = {}) {
    const result = await this.call('/embeddings', (provider) => ({
      model: provider.model,
      input: inputs,
    }), {
      ...options,
      validatePayload: (payload, provider) => this.#validatePayload(payload, provider, inputs),
    })
    return this.#withVectors(result, inputs)
  }

  async embedSequence(providerIds, inputs, options = {}) {
    const result = await this.callSequence(providerIds, '/embeddings', (provider) => ({
      model: provider.model,
      input: inputs,
    }), {
      ...options,
      validatePayload: (payload, provider) => this.#validatePayload(payload, provider, inputs),
    })
    return this.#withVectors(result, inputs)
  }

  async embedProvider(providerId, inputs, options = {}) {
    const result = await this.callProvider(providerId, '/embeddings', (provider) => ({
      model: provider.model,
      input: inputs,
    }), {
      ...options,
      validatePayload: (payload, provider) => this.#validatePayload(payload, provider, inputs),
    })
    return this.#withVectors(result, inputs)
  }

  #validatePayload(payload, provider, inputs) {
    if (payload?.model != null && payload.model !== provider.model) {
      throw new AppError(
        502,
        'agent_model_mismatch',
        'Embedding response model does not match the configured model',
      )
    }
    if (!Array.isArray(payload?.data) || payload.data.length !== inputs.length) {
      throw new AppError(502, 'agent_invalid_response', 'Embedding count does not match the input count')
    }

    const seenIndexes = new Set()
    for (const entry of payload.data) {
      if (!Number.isInteger(entry?.index)
        || entry.index < 0
        || entry.index >= inputs.length
        || seenIndexes.has(entry.index)) {
        throw new AppError(502, 'agent_invalid_response', 'Embedding indexes do not match the inputs')
      }
      seenIndexes.add(entry.index)
      if (!Array.isArray(entry.embedding)
        || entry.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new AppError(502, 'agent_invalid_response', 'Embedding response contained an invalid vector')
      }
      if (this.dimensions && entry.embedding.length !== this.dimensions) {
        throw new AppError(
          502,
          'agent_dimension_mismatch',
          `${provider.id} returned ${entry.embedding.length} dimensions, expected ${this.dimensions}`,
        )
      }
    }
  }

  #withVectors(result, inputs) {
    const vectors = [...(result.payload?.data ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((entry) => entry.embedding)
    return { ...result, vectors }
  }
}
