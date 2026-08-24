import { AppError } from '../core/errors.mjs'
import { createAgentFromProviders, parseProviderConfig } from './index.mjs'
import { normalizeDatabaseProviders, publicSetting } from './settings-store.mjs'

const DEFAULT_REFRESH_INTERVAL_MS = 5_000
const DEFAULT_PROBE_COOLDOWN_MS = 5_000
const DEFAULT_MAX_CONCURRENT_PROBES = 2

function parseEnvironmentEmbeddingProviders(raw, expected = {}) {
  const providers = parseProviderConfig(raw, { kind: 'embedding' })
  const models = new Set(providers.map((provider) => provider.model))
  const dimensions = new Set(providers.map((provider) => provider.dimensions))
  if (models.size > 1 || dimensions.size > 1) {
    throw new AppError(500, 'invalid_configuration', 'Environment embedding providers must use the same model and dimensions')
  }
  if (expected.model && providers.some((provider) => provider.model !== expected.model)) {
    throw new AppError(500, 'invalid_configuration', 'Environment embedding provider model must match MX_INSIGHT_EMBEDDING_MODEL')
  }
  if (expected.dimensions && providers.some((provider) => provider.dimensions !== expected.dimensions)) {
    throw new AppError(500, 'invalid_configuration', 'Environment embedding provider dimensions must match MX_INSIGHT_EMBEDDING_DIMENSIONS')
  }
  return providers
}

function environmentSetting(kind, raw, metadata, expectedEmbedding = {}) {
  const providers = kind === 'embedding'
    ? parseEnvironmentEmbeddingProviders(raw, expectedEmbedding)
    : parseProviderConfig(raw, { kind })
  if (kind === 'embedding' && metadata?.lockedEmbeddingModel) {
    const matchesLock = providers.every((provider) => (
      provider.model === metadata.lockedEmbeddingModel
      && provider.dimensions === metadata.lockedEmbeddingDimensions
    ))
    if (!matchesLock) {
      throw new AppError(409, 'reindex_required', 'Changing the embedding model or dimensions requires a controlled re-embedding')
    }
  }
  return {
    setting: {
      kind,
      source: 'environment',
      revision: metadata?.revision ?? 0,
      providers: providers.map((provider, priority) => ({
        id: provider.id,
        baseUrl: provider.baseUrl,
        model: provider.model,
        timeoutMs: provider.timeoutMs,
        ...(kind === 'embedding' ? { dimensions: provider.dimensions } : {}),
        enabled: true,
        priority,
        authMode: provider.authMode,
        keyConfigured: provider.authMode !== 'bearer'
          || Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]),
      })),
      updatedBy: metadata?.updatedBy ?? null,
      updatedAt: metadata?.updatedAt ?? null,
    },
    providers,
  }
}

function databaseSetting(kind, stored, credentials, expectedEmbeddingDimensions) {
  const normalized = normalizeDatabaseProviders(stored.providers, {
    kind,
    expectedEmbeddingDimensions,
  })
  const active = normalized.filter(({ provider }) => provider.enabled)
  if (kind === 'embedding' && active.length > 0 && (
    !stored.lockedEmbeddingModel || !stored.lockedEmbeddingDimensions
  )) {
    throw new AppError(409, 'embedding_space_unlocked', 'Embedding provider metadata is missing its persisted vector-space lock')
  }
  if (kind === 'embedding' && stored.lockedEmbeddingModel && normalized.some(({ provider }) => (
    provider.model !== stored.lockedEmbeddingModel
    || provider.dimensions !== stored.lockedEmbeddingDimensions
  ))) {
    throw new AppError(409, 'reindex_required', 'Changing the embedding model or dimensions requires a controlled re-embedding')
  }
  const configuredIds = new Set(credentials.keys())
  const providers = normalized
    .filter(({ provider }) => provider.enabled)
    .map(({ provider }) => ({
      ...provider,
      ...(provider.authMode === 'bearer'
        ? { apiKey: credentials.get(provider.id) || null }
        : {}),
    }))
  return {
    setting: publicSetting({ ...stored, providers: normalized.map((entry) => entry.provider) }, configuredIds),
    providers: parseProviderConfig(providers, { kind, allowInlineApiKey: true }),
  }
}

function databaseProbeProvider(kind, stored, credentials, providerId, expectedEmbeddingDimensions) {
  const normalized = normalizeDatabaseProviders(stored.providers, {
    kind,
    expectedEmbeddingDimensions,
  })
  const selected = normalized.find(({ provider }) => provider.id === providerId)?.provider
  if (!selected) {
    throw new AppError(404, 'agent_provider_not_found', 'The saved provider was not found')
  }
  if (kind === 'embedding') {
    if (!stored.lockedEmbeddingModel || !stored.lockedEmbeddingDimensions) {
      throw new AppError(409, 'embedding_space_unlocked', 'Embedding provider metadata is missing its persisted vector-space lock')
    }
    if (
      selected.model !== stored.lockedEmbeddingModel
      || selected.dimensions !== stored.lockedEmbeddingDimensions
    ) {
      throw new AppError(409, 'reindex_required', 'Changing the embedding model or dimensions requires a controlled re-embedding')
    }
  }
  const provider = {
    ...selected,
    ...(selected.authMode === 'bearer'
      ? { apiKey: credentials.get(selected.id) || null }
      : {}),
  }
  return parseProviderConfig([provider], { kind, allowInlineApiKey: true })[0]
}

export class AgentRuntime {
  #agent
  #timer = null
  #refreshing = null
  #settings = new Map()
  #needsApply = new Set()
  #probeStates = new Map()
  #activeProbes = 0

  constructor({
    config,
    settingsStore = null,
    managedKinds = ['chat', 'embedding'],
    logger = console,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    fetchImpl = globalThis.fetch,
    probeCooldownMs = DEFAULT_PROBE_COOLDOWN_MS,
    maxConcurrentProbes = DEFAULT_MAX_CONCURRENT_PROBES,
    nowFn = Date.now,
  }) {
    this.config = config
    this.settingsStore = settingsStore
    this.managedKinds = new Set(managedKinds)
    this.logger = logger
    this.refreshIntervalMs = refreshIntervalMs
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.fetchImpl = fetchImpl
    this.probeCooldownMs = probeCooldownMs
    this.maxConcurrentProbes = maxConcurrentProbes
    this.nowFn = nowFn

    // Environment configuration is the last-known-good bootstrap. A database
    // outage during startup must not turn an optional Agent into an API outage.
    this.#applySnapshot({
      chat: { kind: 'chat', source: 'environment', revision: 0, providers: [] },
      // Until PostgreSQL reveals any persisted vector-space lock, do not use an
      // environment embedding chain in a database-backed runtime. Chat remains
      // available as the bootstrap fallback; embedding fails closed against
      // silent same-dimension model changes.
      embedding: {
        kind: 'embedding', source: this.settingsStore ? 'database' : 'environment',
        revision: 0, providers: [],
      },
      credentials: { chat: new Map(), embedding: new Map() },
    })
  }

  async start() {
    if (this.settingsStore) {
      if (
        this.managedKinds.has('embedding')
        && typeof this.settingsStore.ensureEnvironmentEmbeddingLock === 'function'
      ) {
        try {
          const providers = parseEnvironmentEmbeddingProviders(
            this.config.agent.embeddingProviders,
            this.config.embedding,
          )
          if (providers.length > 0) {
            await this.settingsStore.ensureEnvironmentEmbeddingLock({
              model: providers[0].model,
              dimensions: providers[0].dimensions,
            })
          }
        } catch (error) {
          // Refresh below reads the winning persisted lock and leaves the
          // constructor's empty embedding router in place on disagreement.
          this.logger?.warn?.(`[agent] environment embedding lock failed (${error.message}); embedding remains disabled`)
        }
      }
      await this.refresh({ force: true })
    }
    if (this.settingsStore && this.refreshIntervalMs > 0) {
      this.#timer = this.setIntervalFn(() => {
        this.refresh().catch(() => {})
      }, this.refreshIntervalMs)
      this.#timer?.unref?.()
    }
    return this
  }

  close() {
    if (this.#timer) this.clearIntervalFn(this.#timer)
    this.#timer = null
  }

  async #loadSnapshot() {
    const environmentRow = (kind) => ({
      kind, source: 'environment', revision: 0, providers: [],
      updatedBy: null, updatedAt: null,
    })
    const loadKind = async (kind) => {
      if (!this.managedKinds.has(kind)) {
        return { setting: environmentRow(kind), credentials: new Map() }
      }
      // Production uses one repeatable-read snapshot so a newly committed key
      // can never be paired with metadata from the preceding revision. The
      // fallback keeps small test doubles and compatible store adapters usable.
      if (typeof this.settingsStore.loadRuntimeSetting === 'function') {
        return this.settingsStore.loadRuntimeSetting(kind)
      }
      const setting = await this.settingsStore.loadSetting(kind)
      const credentials = setting.source === 'database'
        ? await this.settingsStore.loadCredentialsInternal(kind)
        : new Map()
      return { setting, credentials }
    }
    const [chatRuntime, embeddingRuntime] = await Promise.all([
      loadKind('chat'),
      loadKind('embedding'),
    ])
    return {
      chat: chatRuntime.setting,
      embedding: embeddingRuntime.setting,
      credentials: {
        chat: chatRuntime.credentials,
        embedding: embeddingRuntime.credentials,
      },
    }
  }

  #applySnapshot(snapshot) {
    const chat = !this.managedKinds.has('chat')
      ? environmentSetting('chat', null, snapshot.chat)
      : snapshot.chat.source === 'database'
      ? databaseSetting('chat', snapshot.chat, snapshot.credentials.chat, null)
      : environmentSetting('chat', this.config.agent.chatProviders, snapshot.chat)
    const embedding = !this.managedKinds.has('embedding')
      ? environmentSetting('embedding', null, snapshot.embedding)
      : snapshot.embedding.source === 'database'
      ? databaseSetting(
          'embedding', snapshot.embedding, snapshot.credentials.embedding,
          this.config.embedding?.dimensions ?? null,
        )
      : environmentSetting(
          'embedding', this.config.agent.embeddingProviders, snapshot.embedding,
          this.config.embedding,
        )

    const agent = createAgentFromProviders({
      chatProviders: chat.providers,
      embeddingProviders: embedding.providers,
      expectedEmbeddingDimensions: this.config.embedding?.dimensions ?? null,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
    })
    // Swap only after every provider and the complete agent constructed. Calls
    // already in flight retain the previous immutable object.
    this.#agent = agent
    this.#settings = new Map([
      ['chat', chat.setting],
      ['embedding', embedding.setting],
    ])
    this.#needsApply.clear()
  }

  #disableKind(kind, setting) {
    const agent = createAgentFromProviders({
      chatProviders: kind === 'chat' ? [] : (this.#agent?.chat?.providers || []),
      embeddingProviders: kind === 'embedding' ? [] : (this.#agent?.embeddings?.providers || []),
      expectedEmbeddingDimensions: this.config.embedding?.dimensions ?? null,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
    })
    this.#agent = agent
    this.#settings = new Map(this.#settings)
    this.#settings.set(kind, setting)
    this.#needsApply.add(kind)
  }

  async refresh({ force = false } = {}) {
    if (!this.settingsStore) return true
    if (this.#refreshing) {
      const activeResult = await this.#refreshing
      if (!force) return activeResult
      // A forced refresh is used immediately after an Admin PUT. The in-flight
      // operation may have captured the preceding revision, so waiting for it
      // is not sufficient: start a second read after it has settled.
      return this.refresh({ force: true })
    }
    const operation = (async () => {
      try {
        const snapshot = await this.#loadSnapshot()
        const unchanged = ['chat', 'embedding'].every((kind) => {
          const current = this.#settings.get(kind)
          const next = snapshot[kind]
          return !this.#needsApply.has(kind)
            && current?.source === next.source
            && current?.revision === next.revision
        })
        if (!force && unchanged) return true
        this.#applySnapshot(snapshot)
        return true
      } catch (error) {
        // Do not include provider configuration in this log. Validation errors
        // identify only the field/provider index; secrets are never interpolated.
        this.logger?.warn?.(`[agent] settings refresh failed (${error.message}); keeping last-known-good`)
        return false
      }
    })()
    this.#refreshing = operation
    try {
      return await operation
    } finally {
      if (this.#refreshing === operation) this.#refreshing = null
    }
  }

  async updateSetting(kind, input, { updatedBy = 'admin-token' } = {}) {
    if (!this.settingsStore) {
      throw new AppError(503, 'agent_settings_unavailable', 'Dynamic provider settings require PostgreSQL')
    }
    if (!this.managedKinds.has(kind)) {
      throw new AppError(503, 'agent_settings_unavailable', `This runtime does not manage ${kind} providers`)
    }
    let embeddingBaseline = null
    let environmentEmbeddingProviders = []
    if (kind === 'embedding' && input?.source === 'database') {
      const environmentProviders = parseEnvironmentEmbeddingProviders(
        this.config.agent.embeddingProviders,
        this.config.embedding,
      )
      if (environmentProviders.length > 0) {
        embeddingBaseline = {
          model: environmentProviders[0].model,
          dimensions: environmentProviders[0].dimensions,
        }
      }
    }
    if (kind === 'embedding' && input?.source === 'environment') {
      environmentEmbeddingProviders = parseEnvironmentEmbeddingProviders(
        this.config.agent.embeddingProviders,
        this.config.embedding,
      ).map((provider) => ({ model: provider.model, dimensions: provider.dimensions }))
    }
    const updated = await this.settingsStore.updateSetting(kind, input, {
      updatedBy,
      expectedEmbeddingDimensions: this.config.embedding?.dimensions ?? null,
      embeddingBaseline,
      environmentEmbeddingProviders,
    })
    const refreshed = await this.refresh({ force: true })
    if (!refreshed) {
      // The database commit is durable but this process could not prove that it
      // loaded the committed key/disable state. Continuing with the old router
      // could send a cleared key or use a provider the operator just disabled.
      // Fail the changed capability closed; the poller will converge later.
      this.#disableKind(kind, updated)
      return { ...updated, runtimeApplied: false }
    }
    return { ...this.#settings.get(kind), runtimeApplied: true }
  }

  get available() {
    return Boolean(this.#agent?.available)
  }

  get embeddings() {
    return this.#agent?.embeddings
  }

  complete(...args) {
    return this.#agent.complete(...args)
  }

  suggestFieldMap(...args) {
    return this.#agent.suggestFieldMap(...args)
  }

  classifyRecord(...args) {
    return this.#agent.classifyRecord(...args)
  }

  embed(...args) {
    return this.#agent.embed(...args)
  }

  async testProvider({ kind, providerId, signal } = {}) {
    if (!['chat', 'embedding'].includes(kind)) {
      throw new AppError(400, 'invalid_provider_kind', 'kind must be chat or embedding')
    }
    // Database-managed IDs are lowercase, while legacy environment chains may
    // contain uppercase IDs. Both are safe path identifiers and must remain
    // testable without rewriting a working environment configuration.
    if (typeof providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(providerId)) {
      throw new AppError(400, 'invalid_provider_id', 'providerId is required')
    }
    if (!this.#settings.get(kind)?.providers?.some((provider) => provider.id === providerId)) {
      throw new AppError(404, 'agent_provider_not_found', 'The saved provider was not found')
    }

    const key = `${kind}:${providerId}`
    const now = this.nowFn()
    const state = this.#probeStates.get(key)
    if (state?.inFlight) {
      throw new AppError(429, 'agent_provider_probe_in_progress', 'A probe for this provider is already running')
    }
    const retryAfterMs = state ? this.probeCooldownMs - (now - state.startedAt) : 0
    if (retryAfterMs > 0) {
      throw new AppError(
        429,
        'agent_provider_probe_rate_limited',
        'Provider probes are temporarily rate limited',
        { retryAfterMs },
      )
    }
    if (this.#activeProbes >= this.maxConcurrentProbes) {
      throw new AppError(429, 'agent_provider_probe_capacity', 'Too many provider probes are running')
    }

    this.#probeStates.set(key, { inFlight: true, startedAt: now })
    this.#activeProbes += 1
    try {
      if (!this.settingsStore || !this.managedKinds.has(kind)) {
        return await this.#agent.testProvider({ kind, providerId, signal })
      }
      let runtime
      if (typeof this.settingsStore.loadRuntimeSetting === 'function') {
        runtime = await this.settingsStore.loadRuntimeSetting(kind)
      } else {
        const setting = await this.settingsStore.loadSetting(kind)
        runtime = {
          setting,
          credentials: setting.source === 'database'
            ? await this.settingsStore.loadCredentialsInternal(kind)
            : new Map(),
        }
      }
      if (runtime.setting.source !== 'database') {
        return await this.#agent.testProvider({ kind, providerId, signal })
      }

      // Build an isolated one-provider router from one secret-bearing database
      // snapshot. A disabled candidate can be checked before it ever joins the
      // production chain, and neither the key nor the response payload escapes.
      const provider = databaseProbeProvider(
        kind,
        runtime.setting,
        runtime.credentials,
        providerId,
        this.config.embedding?.dimensions ?? null,
      )
      const probeAgent = createAgentFromProviders({
        chatProviders: kind === 'chat' ? [provider] : [],
        embeddingProviders: kind === 'embedding' ? [provider] : [],
        expectedEmbeddingDimensions: this.config.embedding?.dimensions ?? null,
        logger: this.logger,
        fetchImpl: this.fetchImpl,
      })
      return await probeAgent.testProvider({ kind, providerId, signal })
    } finally {
      this.#activeProbes -= 1
      const current = this.#probeStates.get(key)
      if (current) current.inFlight = false
    }
  }

  status() {
    return {
      ...this.#agent.status(),
      settings: {
        chat: this.#settings.get('chat'),
        embedding: this.#settings.get('embedding'),
      },
    }
  }
}

export async function createAgentRuntime(options) {
  return new AgentRuntime(options).start()
}
