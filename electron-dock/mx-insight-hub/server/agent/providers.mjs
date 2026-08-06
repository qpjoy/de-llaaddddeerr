import { AppError } from '../core/errors.mjs'

// Model provider registry with ordered failover.
//
// Every provider speaks the OpenAI-compatible REST shape (`/chat/completions`,
// `/embeddings`), which is what DeepSeek, Qwen, Moonshot, vLLM, Ollama and
// OpenAI itself all expose. Supporting one wire format instead of an adapter
// per vendor is why adding a provider is a config line rather than a code
// change.
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

export class NoProviderAvailableError extends Error {
  constructor(attempts) {
    super(`No model provider could serve the request (${attempts.map((a) => `${a.provider}: ${a.error}`).join('; ')})`)
    this.name = 'NoProviderAvailableError'
    this.attempts = attempts
  }
}

export function parseProviderConfig(raw, { kind = 'chat' } = {}) {
  if (!raw) return []
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (error) {
    throw new AppError(500, 'invalid_configuration', `agent provider config is not valid JSON: ${error.message}`)
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
    // The router appends the endpoint path itself, so a baseUrl that already
    // contains one produces `/v1/chat/completions/chat/completions` and a 404
    // on every call. Caught here because the alternative is discovering it
    // through a provider chain that silently fails over to nothing.
    const baseUrl = String(entry.baseUrl).replace(/\/+$/, '')
    for (const endpoint of ['/chat/completions', '/embeddings', '/completions']) {
      if (baseUrl.endsWith(endpoint)) {
        throw new AppError(
          500,
          'invalid_configuration',
          `provider[${index}] "${entry.id}": baseUrl must be the API root, not an endpoint. ` +
            `Use "${baseUrl.slice(0, -endpoint.length)}" instead of "${baseUrl}".`,
        )
      }
    }

    return {
      id: entry.id,
      baseUrl,
      model: entry.model,
      apiKeyEnv: entry.apiKeyEnv || null,
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
    if (!provider.apiKeyEnv) return null
    return process.env[provider.apiKeyEnv] || null
  }

  /**
   * Call `path` on each provider in order until one succeeds.
   *
   * `buildBody` receives the provider so the model name (and anything else
   * provider-specific) is substituted per attempt rather than baked in by the
   * caller.
   */
  async call(path, buildBody, { signal } = {}) {
    if (!this.available) {
      throw new AppError(503, 'agent_not_configured', 'No model provider is configured')
    }
    const attempts = []

    for (const provider of this.providers) {
      const breaker = this.#breakers.get(provider.id)
      if (breaker.open) {
        attempts.push({ provider: provider.id, error: 'circuit open', skipped: true })
        continue
      }
      const apiKey = this.#apiKey(provider)
      if (provider.apiKeyEnv && !apiKey) {
        // A configured-but-unset key is a deployment mistake worth surfacing,
        // not a silent skip that looks like the provider is down.
        attempts.push({ provider: provider.id, error: `${provider.apiKeyEnv} is not set` })
        this.logger?.warn?.(`[agent] ${provider.id}: ${provider.apiKeyEnv} is not set`)
        continue
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), provider.timeoutMs)
      signal?.addEventListener('abort', () => controller.abort(), { once: true })
      const startedAt = performance.now()

      try {
        const response = await this.fetchImpl(`${provider.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(buildBody(provider)),
          signal: controller.signal,
        })

        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500)
          if (!shouldFailover(response.status)) {
            // Our request is wrong; every other provider will reject it too.
            breaker.recordSuccess()
            throw new AppError(400, 'agent_request_rejected', `Model rejected the request: ${detail}`, {
              provider: provider.id,
              upstreamStatus: response.status,
            })
          }
          breaker.recordFailure()
          attempts.push({ provider: provider.id, error: `HTTP ${response.status}: ${detail}` })
          this.logger?.warn?.(`[agent] ${provider.id} failed (${response.status}); trying next provider`)
          continue
        }

        const payload = await response.json()
        breaker.recordSuccess()
        return {
          provider: provider.id,
          model: provider.model,
          latencyMs: Math.round(performance.now() - startedAt),
          payload,
          // Which providers were skipped or failed on the way here. Callers
          // record it, because a system quietly running on its third-choice
          // model for a month is a problem nobody notices otherwise.
          attempts,
        }
      } catch (error) {
        if (error instanceof AppError) throw error
        breaker.recordFailure()
        const reason = error.name === 'AbortError' ? `timed out after ${provider.timeoutMs}ms` : error.message
        attempts.push({ provider: provider.id, error: reason })
        this.logger?.warn?.(`[agent] ${provider.id} failed (${reason}); trying next provider`)
      } finally {
        clearTimeout(timer)
      }
    }

    throw new NoProviderAvailableError(attempts)
  }

  status() {
    return this.providers.map((provider) => ({
      id: provider.id,
      model: provider.model,
      dimensions: provider.dimensions,
      keyConfigured: !provider.apiKeyEnv || Boolean(process.env[provider.apiKeyEnv]),
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
    }), options)
    const vectors = (result.payload?.data ?? [])
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((entry) => entry.embedding)
    if (vectors.length !== inputs.length) {
      throw new AppError(502, 'agent_invalid_response', 'Embedding count does not match the input count')
    }
    // Verify at the boundary too: configuration can be right while a provider
    // silently serves a different model revision.
    if (this.dimensions && vectors[0]?.length !== this.dimensions) {
      throw new AppError(
        502,
        'agent_dimension_mismatch',
        `${result.provider} returned ${vectors[0]?.length} dimensions, expected ${this.dimensions}`,
      )
    }
    return { ...result, vectors }
  }
}
