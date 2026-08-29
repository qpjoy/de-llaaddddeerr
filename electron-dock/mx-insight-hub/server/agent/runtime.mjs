import { AppError } from '../core/errors.mjs'
import { createAgentFromProviders, parseProviderConfig } from './index.mjs'
import {
  aggregateProviderProxyRouteFingerprint,
  egressRouteOverride,
  projectSequenceRouteProof,
  providerProxyRouteFingerprint,
  resolveProviderProxyRoute,
} from './control-store.mjs'
import {
  normalizeDatabaseProviders,
  providerConnection,
  publicSetting,
  resolveEmbeddingProviderSetting,
} from './settings-store.mjs'
import { publicEmbeddingCapabilityCatalog } from './embedding-capabilities.mjs'

const DEFAULT_REFRESH_INTERVAL_MS = 5_000
const DEFAULT_PROBE_COOLDOWN_MS = 5_000
const DEFAULT_MAX_CONCURRENT_PROBES = 2
const PROBE_EVIDENCE_MAX_AGE_MS = 15 * 60_000

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
  const safeProviders = providers.map((provider, priority) => ({
    id: provider.id,
    displayName: provider.displayName || provider.id,
    baseUrl: provider.baseUrl,
    model: provider.model,
    protocol: provider.protocol || 'openai-compatible',
    proxySequenceKey: provider.proxySequenceKey || null,
    timeoutMs: provider.timeoutMs,
    ...(kind === 'embedding' ? { dimensions: provider.dimensions } : {}),
    enabled: true,
    priority,
    authMode: provider.authMode,
  }))
  const configuredIds = new Set(providers.flatMap((provider) => (
    provider.authMode !== 'bearer' || Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv])
      ? [provider.id]
      : []
  )))
  return {
    setting: publicSetting({
      kind,
      source: 'environment',
      revision: metadata?.revision ?? 0,
      providers: safeProviders,
      updatedBy: metadata?.updatedBy ?? null,
      updatedAt: metadata?.updatedAt ?? null,
    }, configuredIds),
    providers,
  }
}

function resolvedDatabaseSnapshot(
  kind,
  stored,
  credentials,
  expectedEmbeddingDimensions,
  { chatSetting = null, inheritedChatCredentials = new Map() } = {},
) {
  const normalized = normalizeDatabaseProviders(stored.providers, {
    kind,
    expectedEmbeddingDimensions,
  })
  const normalizedSetting = { ...stored, providers: normalized.map(({ provider }) => provider) }
  const resolvedSetting = kind === 'embedding'
    ? resolveEmbeddingProviderSetting(normalizedSetting, chatSetting, { tolerateUnavailable: true })
    : normalizedSetting
  const active = resolvedSetting.providers.filter((provider) => (
    provider.enabled && provider.connectionReady !== false
  ))
  if (kind === 'embedding' && active.length > 0 && (
    !stored.lockedEmbeddingModel || !stored.lockedEmbeddingDimensions
  )) {
    throw new AppError(409, 'embedding_space_unlocked', 'Embedding provider metadata is missing its persisted vector-space lock')
  }
  if (kind === 'embedding' && stored.lockedEmbeddingModel && resolvedSetting.providers.some((provider) => (
    provider.model !== stored.lockedEmbeddingModel
    || provider.dimensions !== stored.lockedEmbeddingDimensions
  ))) {
    throw new AppError(409, 'reindex_required', 'Changing the embedding model or dimensions requires a controlled re-embedding')
  }
  const configuredIds = new Set()
  const allProviders = resolvedSetting.providers.map((provider) => {
    const connection = providerConnection(provider, kind)
    const apiKey = connection.mode === 'inherit-chat'
      ? inheritedChatCredentials.get(connection.providerId)
      : credentials.get(provider.id)
    if (provider.authMode === 'none' || apiKey) configuredIds.add(provider.id)
    return {
      ...provider,
      ...(provider.authMode === 'bearer' ? { apiKey: apiKey || null } : {}),
    }
  })
  return {
    resolvedSetting,
    configuredIds,
    allProviders,
    providers: allProviders.filter((provider) => (
      provider.enabled && provider.connectionReady !== false
    )),
  }
}

function databaseSetting(
  kind,
  stored,
  credentials,
  expectedEmbeddingDimensions,
  dependencies = {},
) {
  const snapshot = resolvedDatabaseSnapshot(
    kind, stored, credentials, expectedEmbeddingDimensions, dependencies,
  )
  return {
    setting: publicSetting(snapshot.resolvedSetting, snapshot.configuredIds),
    providers: parseProviderConfig(snapshot.providers, { kind, allowInlineApiKey: true }),
  }
}

function databaseProbeProvider(
  kind,
  stored,
  credentials,
  providerId,
  expectedEmbeddingDimensions,
  dependencies = {},
) {
  const snapshot = resolvedDatabaseSnapshot(
    kind, stored, credentials, expectedEmbeddingDimensions, dependencies,
  )
  const selected = snapshot.allProviders.find((provider) => provider.id === providerId)
  if (!selected) {
    throw new AppError(404, 'agent_provider_not_found', 'The saved provider was not found')
  }
  if (selected.connectionReady === false) {
    throw new AppError(
      409,
      'embedding_connection_unavailable',
      selected.connectionError || 'The inherited Embedding connection is unavailable',
    )
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
  return parseProviderConfig([selected], { kind, allowInlineApiKey: true })[0]
}

export class AgentRuntime {
  #agent
  #timer = null
  #refreshing = null
  #settings = new Map()
  #needsApply = new Set()
  #probeStates = new Map()
  #activeProbes = 0
  #control = new Map()

  constructor({
    config,
    settingsStore = null,
    controlStore = null,
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
    this.controlStore = controlStore
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
      control: {
        chat: {
          controlAvailable: false, sequences: [], defaultBinding: null,
          proxyEndpoints: [], proxySequences: [], globalProxySequenceKey: null,
          globalEgressMode: 'inherit', proxyRevision: 0,
          deploymentEgress: this.config.deploymentEgress,
        },
        embedding: {
          controlAvailable: false, sequences: [], defaultBinding: null,
          proxyEndpoints: [], proxySequences: [], globalProxySequenceKey: null,
          globalEgressMode: 'inherit', proxyRevision: 0,
          deploymentEgress: this.config.deploymentEgress,
        },
      },
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
      if (this.controlStore && this.config.agent?.autoMigrate !== false) {
        for (const kind of this.managedKinds) {
          await this.#migrateEnvironmentProviders(kind).catch((error) => {
            // Import is additive. Unsupported legacy URLs/IDs or a transient
            // race leave the environment chain authoritative and must never
            // make the Admin listener or workers unavailable.
            this.logger?.warn?.(`[agent] ${kind} environment migration skipped (${error.message})`)
          })
        }
      }
      await this.refresh({ force: true })
      if (this.controlStore) {
        for (const kind of this.managedKinds) {
          const setting = this.#settings.get(kind)
          const providerIds = (setting?.providers || [])
            .filter((provider) => provider.enabled !== false)
            .map((provider) => provider.id)
          if (providerIds.length > 0) {
            await this.controlStore.ensureBootstrapSequence({
              kind,
              providerIds,
              providerRevision: setting?.revision ?? 0,
            }).catch((error) => {
              this.logger?.warn?.(`[agent] compatibility ${kind} Sequence bootstrap failed (${error.message})`)
            })
          }
        }
        await this.refresh({ force: true })
      }
    }
    if (this.settingsStore && this.refreshIntervalMs > 0) {
      this.#timer = this.setIntervalFn(() => {
        this.refresh().catch(() => {})
      }, this.refreshIntervalMs)
      this.#timer?.unref?.()
    }
    return this
  }

  async #migrateEnvironmentProviders(kind) {
    const current = await this.settingsStore.loadSetting(kind)
    if (current.source !== 'environment') return false
    const parsed = kind === 'embedding'
      ? parseEnvironmentEmbeddingProviders(this.config.agent.embeddingProviders, this.config.embedding)
      : parseProviderConfig(this.config.agent.chatProviders, { kind: 'chat' })
    if (parsed.length === 0) return false
    const providers = parsed.map((provider, priority) => {
      const apiKey = provider.authMode === 'bearer'
        ? provider.apiKey || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : null)
        : null
      if (provider.authMode === 'bearer' && !apiKey) {
        throw new AppError(
          503,
          'agent_environment_key_missing',
          `Provider ${provider.id} cannot be migrated because its referenced API key is missing`,
        )
      }
      return {
        id: provider.id,
        displayName: provider.displayName || provider.id,
        baseUrl: provider.baseUrl,
        model: provider.model,
        protocol: provider.protocol || 'openai-compatible',
        proxySequenceKey: provider.proxySequenceKey || null,
        timeoutMs: provider.timeoutMs,
        ...(kind === 'embedding' ? { dimensions: provider.dimensions } : {}),
        enabled: true,
        priority,
        authMode: provider.authMode,
        ...(apiKey ? { apiKey } : {}),
      }
    })
    try {
      await this.settingsStore.updateSetting(kind, {
        expectedRevision: current.revision,
        source: 'database',
        providers,
      }, {
        updatedBy: 'environment-bootstrap',
        expectedEmbeddingDimensions: this.config.embedding?.dimensions ?? null,
        embeddingBaseline: kind === 'embedding' && parsed[0]
          ? { model: parsed[0].model, dimensions: parsed[0].dimensions }
          : null,
      })
      return true
    } catch (error) {
      // Another API/worker process may win the same idempotent bootstrap.
      if (error?.code === 'settings_revision_conflict') return false
      throw error
    }
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
    const embeddingInheritsChat = embeddingRuntime.setting?.source === 'database'
      && (embeddingRuntime.setting.providers || []).some((provider) => (
        providerConnection(provider).mode === 'inherit-chat'
      ))
    // The Embedding store snapshot reads its parent Chat metadata and secrets
    // in the same repeatable-read transaction. When a child inherits, use that
    // same parent snapshot for the Chat router too; otherwise one poll could
    // pair a pre-commit Chat chain with a post-commit Embedding chain.
    const coherentChatRuntime = embeddingInheritsChat
      ? {
          setting: embeddingRuntime.chatSetting || chatRuntime.setting,
          credentials: embeddingRuntime.inheritedChatCredentials || chatRuntime.credentials,
        }
      : chatRuntime
    const emptyControl = {
      controlAvailable: false,
      sequences: [], defaultBinding: null, proxyEndpoints: [], proxySequences: [],
      globalProxySequenceKey: null, globalEgressMode: 'inherit', proxyRevision: 0,
      deploymentEgress: this.config.deploymentEgress,
    }
    const [chatControl, embeddingControl] = await Promise.all([
      this.controlStore && this.managedKinds.has('chat')
        ? this.controlStore.loadRuntimeSnapshot('chat')
        : emptyControl,
      this.controlStore && this.managedKinds.has('embedding')
        ? this.controlStore.loadRuntimeSnapshot('embedding')
        : emptyControl,
    ])
    return {
      chat: coherentChatRuntime.setting,
      embedding: embeddingRuntime.setting,
      credentials: {
        chat: coherentChatRuntime.credentials,
        embedding: embeddingRuntime.credentials,
      },
      dependencies: {
        embedding: {
          chatSetting: embeddingRuntime.chatSetting || coherentChatRuntime.setting,
          inheritedChatCredentials: embeddingRuntime.inheritedChatCredentials || coherentChatRuntime.credentials,
        },
      },
      control: { chat: chatControl, embedding: embeddingControl },
    }
  }

  #withProxyRoutes(providers, control, routeOverride = undefined, { strictProxy = false } = {}) {
    return providers.map((provider) => {
      const route = resolveProviderProxyRoute(provider, control, routeOverride)
      return {
        ...provider,
        proxyUrls: [...route.proxyUrls],
        directFallback: strictProxy && routeOverride != null
          ? false
          : route.directFallback,
      }
    })
  }

  #transportOverride(kind, routeOverride, { strictProxy = false } = {}) {
    const route = resolveProviderProxyRoute(null, this.#control.get(kind), routeOverride)
    return {
      proxyUrls: [...route.proxyUrls],
      directFallback: strictProxy && routeOverride != null
        ? false
        : route.directFallback,
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
          snapshot.dependencies?.embedding,
        )
      : environmentSetting(
          'embedding', this.config.agent.embeddingProviders, snapshot.embedding,
          this.config.embedding,
        )

    const agent = createAgentFromProviders({
      chatProviders: this.#withProxyRoutes(chat.providers, snapshot.control?.chat),
      embeddingProviders: this.#withProxyRoutes(embedding.providers, snapshot.control?.embedding),
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
    this.#control = new Map([
      ['chat', snapshot.control?.chat || { sequences: [], defaultBinding: null }],
      ['embedding', snapshot.control?.embedding || { sequences: [], defaultBinding: null }],
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

  #disableManagedKinds() {
    for (const kind of this.managedKinds) {
      this.#disableKind(kind, this.#settings.get(kind))
    }
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
            && JSON.stringify(this.#control.get(kind) || null)
              === JSON.stringify(snapshot.control?.[kind] || null)
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
    if (input?.source === 'database' && this.controlStore) {
      const proxySequenceKeys = [...new Set((input.providers || [])
        .map((provider) => provider?.proxySequenceKey)
        .filter(Boolean))]
      if (proxySequenceKeys.length > 0) {
        if (typeof this.controlStore.validateProxySequenceKeys !== 'function') {
          throw new AppError(503, 'agent_control_unavailable', 'Proxy settings require the Agent control migration')
        }
        await this.controlStore.validateProxySequenceKeys(proxySequenceKeys)
      }
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
      for (const dependentKind of updated.dependentKinds || []) {
        this.#disableKind(dependentKind, this.#settings.get(dependentKind))
      }
      return { ...updated, runtimeApplied: false }
    }
    return { ...this.#settings.get(kind), runtimeApplied: true }
  }

  get available() {
    return Boolean(this.#agent?.available)
  }

  get embeddings() {
    const embeddings = this.#agent?.embeddings
    if (!embeddings?.available) return embeddings
    try {
      this.#resolveSequence('embedding')
      return embeddings
    } catch (error) {
      if (error?.code !== 'agent_sequence_unavailable') throw error
      // Keep exact Provider/Sequence probes available through the private
      // runtime router, while ordinary embedding consumers see that no governed
      // default service is currently usable.
      return { available: false, dimensions: embeddings.dimensions }
    }
  }

  #resolveSequence(kind, requestedKey = null) {
    const control = this.#control.get(kind)
    const sequenceKey = requestedKey || control?.defaultBinding?.sequenceKey || null
    if (!sequenceKey) {
      // Only an older runtime without the control migration may preserve the
      // legacy ordered catalog. Once governance is available, the absence of an
      // explicit default is itself a fail-closed routing decision.
      if (control?.controlAvailable === false) return null
      throw new AppError(
        503,
        'agent_sequence_unavailable',
        'No default LLM Sequence is configured for this capability',
      )
    }
    const sequence = control?.sequences?.find((candidate) => candidate.sequenceKey === sequenceKey)
    const setting = this.#settings.get(kind)
    const enabledIds = new Set(
      (setting?.providers || [])
        .filter((provider) => (
          provider.enabled !== false && provider.connectionReady !== false
        ))
        .map((provider) => provider.id),
    )
    const valid = sequence?.enabled
      && sequence.providerRevision === (setting?.revision ?? 0)
      && sequence.providerIds.length > 0
      && sequence.providerIds.every((providerId) => enabledIds.has(providerId))
    const currentRouteFingerprint = sequence
      ? this.#providerVerificationState(
          kind,
          sequence.providerIds,
          egressRouteOverride(sequence.egressMode, sequence.proxySequenceKey),
        ).aggregateProxyFingerprint
      : null
    const routeValid = !sequence?.verifiedProxyFingerprint
      || sequence.verifiedProxyFingerprint === currentRouteFingerprint
    if (!valid || !routeValid) {
      throw new AppError(
        503,
        'agent_sequence_unavailable',
        'The selected LLM Sequence is missing, stale, disabled, or references an unavailable Provider or Proxy route',
      )
    }
    return sequence
  }

  complete(messages, options = {}) {
    const sequence = this.#resolveSequence('chat', options.sequenceKey)
    const routeOverride = sequence
      ? egressRouteOverride(sequence.egressMode, sequence.proxySequenceKey)
      : undefined
    const transportOverride = routeOverride === undefined
      ? undefined
      : this.#transportOverride('chat', routeOverride)
    return this.#agent.complete(messages, {
      ...options,
      providerIds: sequence?.providerIds || null,
      sequenceKey: sequence?.sequenceKey || null,
      transportOverride,
    })
  }

  suggestFieldMap(options = {}) {
    const sequence = this.#legacySequenceOrDisabled('chat')
    const routeOverride = sequence
      ? egressRouteOverride(sequence.egressMode, sequence.proxySequenceKey)
      : undefined
    return this.#agent.suggestFieldMap({
      ...options,
      providerIds: sequence?.providerIds || null,
      sequenceKey: sequence?.sequenceKey || null,
      transportOverride: routeOverride === undefined
        ? undefined
        : this.#transportOverride('chat', routeOverride),
    })
  }

  suggestFileProfile(options = {}) {
    const sequence = this.#legacySequenceOrDisabled('chat')
    const routeOverride = sequence
      ? egressRouteOverride(sequence.egressMode, sequence.proxySequenceKey)
      : undefined
    return this.#agent.suggestFileProfile({
      ...options,
      providerIds: sequence?.providerIds || null,
      sequenceKey: sequence?.sequenceKey || null,
      transportOverride: routeOverride === undefined
        ? undefined
        : this.#transportOverride('chat', routeOverride),
    })
  }

  classifyRecord(options = {}) {
    const sequence = this.#legacySequenceOrDisabled('chat')
    const routeOverride = sequence
      ? egressRouteOverride(sequence.egressMode, sequence.proxySequenceKey)
      : undefined
    return this.#agent.classifyRecord({
      ...options,
      providerIds: sequence?.providerIds || null,
      sequenceKey: sequence?.sequenceKey || null,
      transportOverride: routeOverride === undefined
        ? undefined
        : this.#transportOverride('chat', routeOverride),
    })
  }

  embed(texts, options = {}) {
    const sequence = this.#resolveSequence('embedding', options.sequenceKey)
    const routeOverride = sequence
      ? egressRouteOverride(sequence.egressMode, sequence.proxySequenceKey)
      : undefined
    const transportOverride = routeOverride === undefined
      ? undefined
      : this.#transportOverride('embedding', routeOverride)
    return this.#agent.embed(texts, {
      ...options,
      providerIds: sequence?.providerIds || null,
      sequenceKey: sequence?.sequenceKey || null,
      transportOverride,
    })
  }

  #legacySequenceOrDisabled(kind) {
    try {
      return this.#resolveSequence(kind)
    } catch (error) {
      if (error?.code !== 'agent_sequence_unavailable') throw error
      // These legacy facade methods already own deterministic/null fallback.
      // Route them through an intentionally empty chain so their existing
      // catch boundary runs; generic complete/embed remain fail-closed.
      return { sequenceKey: null, providerIds: [] }
    }
  }

  async testProvider({
    kind,
    providerId,
    signal,
    routeOverride = undefined,
    routeMode = null,
    strictProxy = false,
    persistEvidence = true,
  } = {}) {
    if (!['chat', 'embedding'].includes(kind)) {
      throw new AppError(400, 'invalid_provider_kind', 'kind must be chat or embedding')
    }
    // Database-managed IDs are lowercase, while legacy environment chains may
    // contain uppercase IDs. Both are safe path identifiers and must remain
    // testable without rewriting a working environment configuration.
    if (typeof providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(providerId)) {
      throw new AppError(400, 'invalid_provider_id', 'providerId is required')
    }
    if (routeOverride !== undefined && routeOverride !== null && (
      typeof routeOverride !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(routeOverride)
    )) {
      throw new AppError(400, 'invalid_agent_proxy_route', 'Proxy Sequence key is invalid')
    }
    await this.refresh()
    if (!this.#settings.get(kind)?.providers?.some((provider) => provider.id === providerId)) {
      throw new AppError(404, 'agent_provider_not_found', 'The saved provider was not found')
    }

    const routeKey = routeOverride === undefined
      ? 'effective'
      : routeOverride === null
        ? 'system-egress'
        : `proxy:${routeOverride}`
    const key = `${kind}:${providerId}:${routeKey}`
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
    let result = null
    let failure = null
    let evidenceSetting = this.#settings.get(kind)
    let evidenceControl = this.#control.get(kind)
    let evidenceProvider = null
    const withRoute = (value) => routeMode === 'inherit'
      ? { ...value, route: { mode: 'inherit' } }
      : routeOverride === undefined
        ? value
      : {
          ...value,
          route: routeOverride === null
            ? { mode: 'system-egress' }
            : { mode: 'proxy-sequence', sequenceKey: routeOverride },
        }
    try {
      if (!this.settingsStore || !this.managedKinds.has(kind)) {
        if (typeof routeOverride === 'string' && !this.controlStore) {
          throw new AppError(503, 'agent_control_unavailable', 'Proxy route testing requires PostgreSQL')
        }
        const transportOverride = routeOverride === undefined
          ? undefined
          : this.#transportOverride(kind, routeOverride, { strictProxy })
        result = await this.#agent.testProvider({
          kind,
          providerId,
          signal,
          transportOverride,
        })
        return withRoute(result)
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
        const transportOverride = routeOverride === undefined
          ? undefined
          : this.#transportOverride(kind, routeOverride, { strictProxy })
        if (typeof routeOverride === 'string' && transportOverride.proxyUrls.length === 0) {
          throw new AppError(400, 'invalid_agent_proxy_route', 'The selected Proxy Sequence has no usable endpoint')
        }
        result = await this.#agent.testProvider({
          kind,
          providerId,
          signal,
          transportOverride,
        })
        return withRoute(result)
      }

      evidenceSetting = runtime.setting
      evidenceControl = this.controlStore
        ? await this.controlStore.loadRuntimeSnapshot(kind)
        : evidenceControl

      // Build an isolated one-provider router from one secret-bearing database
      // snapshot. A disabled candidate can be checked before it ever joins the
      // production chain, and neither the key nor the response payload escapes.
      const provider = databaseProbeProvider(
        kind,
        runtime.setting,
        runtime.credentials,
        providerId,
        this.config.embedding?.dimensions ?? null,
        kind === 'embedding'
          ? {
              chatSetting: runtime.chatSetting,
              inheritedChatCredentials: runtime.inheritedChatCredentials,
            }
          : {},
      )
      evidenceProvider = provider
      const route = resolveProviderProxyRoute(provider, evidenceControl, routeOverride)
      if (typeof routeOverride === 'string' && route.proxyUrls.length === 0) {
        throw new AppError(400, 'invalid_agent_proxy_route', 'The selected Proxy Sequence has no usable endpoint')
      }
      const transportOverride = {
        proxyUrls: [...route.proxyUrls],
        directFallback: strictProxy && routeOverride != null
          ? false
          : route.directFallback,
      }
      const probeAgent = createAgentFromProviders({
        chatProviders: kind === 'chat' ? [provider] : [],
        embeddingProviders: kind === 'embedding' ? [provider] : [],
        expectedEmbeddingDimensions: this.config.embedding?.dimensions ?? null,
        logger: this.logger,
        fetchImpl: this.fetchImpl,
      })
      result = await probeAgent.testProvider({
        kind,
        providerId,
        signal,
        transportOverride,
      })
      return withRoute(result)
    } catch (error) {
      failure = error
      throw error
    } finally {
      this.#activeProbes -= 1
      const current = this.#probeStates.get(key)
      if (current) current.inFlight = false
      if (this.controlStore && persistEvidence) {
        const provider = evidenceProvider
          || evidenceSetting?.providers?.find((candidate) => candidate.id === providerId)
        if (provider) {
          await this.controlStore.recordProbe({
            kind,
            providerId,
            settingsRevision: evidenceSetting?.revision ?? 0,
            proxyFingerprint: providerProxyRouteFingerprint(provider, evidenceControl, routeOverride),
            model: provider.model,
            protocol: provider.protocol || 'openai-compatible',
            ok: Boolean(result?.ok),
            latencyMs: result?.latencyMs ?? null,
            errorCode: failure?.code || (failure ? 'agent_provider_probe_failed' : null),
          }).catch((error) => {
            this.logger?.warn?.(`[agent] provider probe evidence could not be stored (${error.message})`)
          })
        }
      }
    }
  }

  async saveSequence(sequenceKey, input, { updatedBy = 'admin-token' } = {}) {
    if (!this.controlStore) {
      throw new AppError(503, 'agent_control_unavailable', 'LLM Sequence settings require PostgreSQL')
    }
    const kind = input?.kind
    if (!this.managedKinds.has(kind)) {
      throw new AppError(503, 'agent_control_unavailable', `This runtime does not manage ${kind} providers`)
    }
    if (!Array.isArray(input?.providerIds) || input.providerIds.length === 0) {
      throw new AppError(400, 'invalid_agent_sequence', 'An LLM Sequence requires at least one Provider')
    }
    if (new Set(input.providerIds).size !== input.providerIds.length) {
      throw new AppError(400, 'invalid_agent_sequence', 'An LLM Sequence must not repeat a Provider')
    }
    await this.#requireFreshVerificationState('LLM Sequence was not saved')
    const changesActiveDefault = this.#control.get(kind)?.defaultBinding?.sequenceKey === sequenceKey
    const proxySequenceKey = typeof input?.proxySequenceKey === 'string'
      ? input.proxySequenceKey
      : null
    const routeOverride = egressRouteOverride(input?.egressMode, proxySequenceKey)
    // Verification is deliberately exact-provider and sequential. It cannot
    // silently pass because a different fallback answered, and it stays below
    // the runtime's bounded probe concurrency.
    const { tests, verification } = await this.#ensureProvidersVerified(
      kind,
      input.providerIds,
      routeOverride,
    )
    await this.#requireFreshVerificationState('LLM Sequence was not saved')
    this.#assertVerificationState(kind, input.providerIds, verification, routeOverride)
    const providerRevision = verification.settingsRevision
    const saved = await this.controlStore.saveSequence(sequenceKey, input, {
      providerRevision,
      verification,
      verifiedBy: updatedBy,
      updatedBy,
    })
    const runtimeApplied = await this.refresh({ force: true })
    if (!runtimeApplied && changesActiveDefault) this.#disableKind(kind, this.#settings.get(kind))
    return { ...saved, tests, runtimeApplied }
  }

  async setDefaultSequence(kind, sequenceKey, input, { updatedBy = 'admin-token' } = {}) {
    if (!this.controlStore) {
      throw new AppError(503, 'agent_control_unavailable', 'LLM Sequence settings require PostgreSQL')
    }
    // Require fresh evidence for the exact provider revision before binding.
    // A just-saved Sequence reuses its probes, avoiding duplicate paid calls.
    await this.#requireFreshVerificationState('The business default was not changed')
    const sequence = this.#control.get(kind)?.sequences
      ?.find((candidate) => candidate.sequenceKey === sequenceKey)
    if (!sequence) throw new AppError(404, 'agent_sequence_not_found', 'The LLM Sequence was not found')
    const routeOverride = egressRouteOverride(sequence.egressMode, sequence.proxySequenceKey)
    const { verification } = await this.#ensureProvidersVerified(
      kind,
      sequence.providerIds,
      routeOverride,
    )
    await this.#requireFreshVerificationState('The business default was not changed')
    this.#assertVerificationState(kind, sequence.providerIds, verification, routeOverride)
    // The re-test above records evidence but does not change providerRevision;
    // save the same Sequence to advance its verification timestamp/revision.
    const verified = await this.controlStore.saveSequence(sequenceKey, {
      expectedRevision: sequence.revision,
      displayName: sequence.displayName,
      kind,
      providerIds: sequence.providerIds,
      enabled: sequence.enabled,
      egressMode: sequence.egressMode,
      proxySequenceKey: sequence.proxySequenceKey,
    }, {
      providerRevision: verification.settingsRevision,
      verification,
      verifiedBy: updatedBy,
      updatedBy,
    })
    const binding = await this.controlStore.setDefaultSequence(kind, sequenceKey, {
      expectedRevision: input?.expectedRevision,
      expectedSequenceRevision: verified.revision,
      verification,
      updatedBy,
    })
    const runtimeApplied = await this.refresh({ force: true })
    if (!runtimeApplied) this.#disableKind(kind, this.#settings.get(kind))
    return { binding, sequence: verified, runtimeApplied }
  }

  async clearDefaultSequence(kind, input, { updatedBy = 'admin-token' } = {}) {
    if (!this.controlStore) {
      throw new AppError(503, 'agent_control_unavailable', 'LLM Sequence settings require PostgreSQL')
    }
    if (!this.managedKinds.has(kind)) {
      throw new AppError(503, 'agent_control_unavailable', `This runtime does not manage ${kind} providers`)
    }
    const binding = await this.controlStore.setDefaultSequence(kind, null, {
      expectedRevision: input?.expectedRevision,
      updatedBy,
    })
    const runtimeApplied = await this.refresh({ force: true })
    if (!runtimeApplied) this.#disableKind(kind, this.#settings.get(kind))
    return { binding, runtimeApplied }
  }

  async #requireFreshVerificationState(action) {
    if (!await this.refresh({ force: true })) {
      throw new AppError(
        503,
        'agent_settings_refresh_failed',
        `Current Agent settings could not be loaded; ${action}`,
      )
    }
  }

  #providerVerificationState(kind, providerIds, routeOverride = undefined) {
    const settingsRevision = this.#settings.get(kind)?.revision ?? 0
    const providers = new Map(
      (this.#settings.get(kind)?.providers || []).map((provider) => [provider.id, provider]),
    )
    const proxyFingerprints = new Map(providerIds.map((providerId) => [
      providerId,
      providerProxyRouteFingerprint(
        providers.get(providerId),
        this.#control.get(kind),
        routeOverride,
      ),
    ]))
    return {
      settingsRevision,
      proxyFingerprints,
      aggregateProxyFingerprint: aggregateProviderProxyRouteFingerprint(
        providerIds,
        proxyFingerprints,
      ),
    }
  }

  #assertVerificationState(kind, providerIds, expected, routeOverride = undefined) {
    const current = this.#providerVerificationState(kind, providerIds, routeOverride)
    const unchanged = current.settingsRevision === expected.settingsRevision
      && current.aggregateProxyFingerprint === expected.aggregateProxyFingerprint
      && providerIds.every((providerId) => (
        current.proxyFingerprints.get(providerId) === expected.proxyFingerprints.get(providerId)
      ))
    if (!unchanged) {
      throw new AppError(
        409,
        'agent_provider_verification_stale',
        'Provider or Proxy routing changed during verification; reload and retry',
      )
    }
  }

  async #ensureProvidersVerified(kind, providerIds, routeOverride = undefined) {
    const verification = this.#providerVerificationState(kind, providerIds, routeOverride)
    const matchingPasses = (providerTests) => new Map(
      providerTests
        .filter((test) => {
          const testedAt = Date.parse(test.testedAt || '')
          return test.kind === kind
            && test.settingsRevision === verification.settingsRevision
            && test.proxyFingerprint === verification.proxyFingerprints.get(test.providerId)
            && test.ok
            && Number.isFinite(testedAt)
            && this.nowFn() - testedAt <= PROBE_EVIDENCE_MAX_AGE_MS
        })
        .map((test) => [test.providerId, test]),
    )
    const control = await this.controlStore.listPublicControl()
    const currentPasses = matchingPasses(control.providerTests)
    const tests = []
    for (const providerId of providerIds) {
      const passed = currentPasses.get(providerId)
      if (passed) tests.push(passed)
      else tests.push(await this.testProvider({
        kind,
        providerId,
        routeOverride,
      }))
    }
    // Do not trust only the live call result: route A -> B -> A can otherwise
    // make the final in-memory fingerprint look unchanged even though a probe
    // actually ran on B. Re-read durable evidence and require every Provider's
    // latest successful proof to match the exact state captured above.
    const persistedPasses = matchingPasses(
      (await this.controlStore.listPublicControl()).providerTests,
    )
    const exactTests = providerIds.map((providerId) => persistedPasses.get(providerId))
    if (exactTests.some((test) => !test)) {
      throw new AppError(
        409,
        'agent_provider_verification_stale',
        'Provider or Proxy routing changed during verification; reload and retry',
      )
    }
    return { tests: exactTests, verification }
  }

  async testSequence(sequenceKey, { kind, expectedRevision, signal } = {}) {
    if (!['chat', 'embedding'].includes(kind)) {
      throw new AppError(400, 'invalid_provider_kind', 'kind must be chat or embedding')
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new AppError(400, 'invalid_agent_sequence', 'expectedRevision must be a non-negative integer')
    }
    if (!await this.refresh({ force: true })) {
      throw new AppError(503, 'agent_settings_refresh_failed', 'Current Agent settings could not be loaded; Sequence test was not run')
    }
    const currentSequence = this.#control.get(kind)?.sequences
      ?.find((candidate) => candidate.sequenceKey === sequenceKey)
    if (!currentSequence) {
      throw new AppError(404, 'agent_sequence_not_found', 'The LLM Sequence was not found')
    }
    if (currentSequence.revision !== expectedRevision) {
      throw new AppError(409, 'sequence_revision_conflict', 'LLM Sequence changed; reload and retry', {
        currentRevision: currentSequence.revision,
      })
    }
    const sequence = this.#resolveSequence(kind, sequenceKey)
    if (kind === 'chat') {
      const result = await this.complete([
        { role: 'user', content: 'Say hi in one short sentence.' },
      ], {
        temperature: 0,
        // Keep the operator sample viable for reasoning-capable providers;
        // smaller limits can end in reasoning_content before any final text.
        maxTokens: 1_024,
        signal,
        sequenceKey: sequence.sequenceKey,
        ignoreCircuit: true,
      })
      return {
        ok: true,
        kind,
        sequenceKey: sequence.sequenceKey,
        providerId: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        sample: String(result.payload?.choices?.[0]?.message?.content || '').slice(0, 240),
        attempts: result.attempts || [],
        testedAt: new Date().toISOString(),
      }
    }
    if (kind === 'embedding') {
      const result = await this.embed(['MX Insight Hub LLM Sequence connectivity test'], {
        signal,
        sequenceKey: sequence.sequenceKey,
        ignoreCircuit: true,
      })
      return {
        ok: true,
        kind,
        sequenceKey: sequence.sequenceKey,
        providerId: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        dimensions: result.vectors?.[0]?.length ?? null,
        attempts: result.attempts || [],
        testedAt: new Date().toISOString(),
      }
    }
  }

  async saveProxyEndpoint(proxyKey, input, { updatedBy = 'admin-token' } = {}) {
    if (!this.controlStore) throw new AppError(503, 'agent_control_unavailable', 'Proxy settings require PostgreSQL')
    const saved = await this.controlStore.saveProxyEndpoint(proxyKey, input, { updatedBy })
    const runtimeApplied = await this.refresh({ force: true })
    if (!runtimeApplied) this.#disableManagedKinds()
    return { ...saved, runtimeApplied }
  }

  async deleteProxyEndpoint(proxyKey, input) {
    if (!this.controlStore) throw new AppError(503, 'agent_control_unavailable', 'Proxy settings require PostgreSQL')
    const deleted = await this.controlStore.deleteProxyEndpoint(proxyKey, input)
    const runtimeApplied = await this.refresh({ force: true })
    if (!runtimeApplied) this.#disableManagedKinds()
    return { ...deleted, runtimeApplied }
  }

  #environmentProxyReferences(sequenceKey) {
    return [...this.#settings.entries()].flatMap(([kind, setting]) => (
      setting?.source === 'environment'
        ? (setting.providers || [])
            .filter((provider) => provider.proxySequenceKey === sequenceKey)
            .map((provider) => ({ kind, providerId: provider.id }))
        : []
    ))
  }

  async saveProxySequence(sequenceKey, input, { updatedBy = 'admin-token' } = {}) {
    if (!this.controlStore) throw new AppError(503, 'agent_control_unavailable', 'Proxy settings require PostgreSQL')
    if (input?.enabled === false) {
      if (!await this.refresh({ force: true })) {
        throw new AppError(503, 'agent_settings_refresh_failed', 'Current Agent settings could not be loaded; Proxy Sequence was not disabled')
      }
      const current = [...this.#control.values()]
        .flatMap((control) => control?.proxySequences || [])
        .find((sequence) => sequence.sequenceKey === sequenceKey)
      if (current?.enabled === true) {
        const environmentReferences = this.#environmentProxyReferences(sequenceKey)
        if (environmentReferences.length > 0) {
          throw new AppError(
            409,
            'agent_proxy_sequence_in_use',
            'Remove the Proxy Sequence from every environment Provider before disabling it',
            { global: false, providers: environmentReferences },
          )
        }
      }
    }
    const saved = await this.controlStore.saveProxySequence(sequenceKey, input, { updatedBy })
    const runtimeApplied = await this.refresh({ force: true })
    if (!runtimeApplied) this.#disableManagedKinds()
    return { ...saved, runtimeApplied }
  }

  async deleteProxySequence(sequenceKey, input) {
    if (!this.controlStore) throw new AppError(503, 'agent_control_unavailable', 'Proxy settings require PostgreSQL')
    if (!await this.refresh({ force: true })) {
      throw new AppError(503, 'agent_settings_refresh_failed', 'Current Agent settings could not be loaded; Proxy Sequence was not deleted')
    }
    const environmentReferences = this.#environmentProxyReferences(sequenceKey)
    if (environmentReferences.length > 0) {
      throw new AppError(
        409,
        'agent_proxy_sequence_in_use',
        'Remove the Proxy Sequence from every environment Provider before deleting it',
        { global: false, providers: environmentReferences },
      )
    }
    const deleted = await this.controlStore.deleteProxySequence(sequenceKey, input)
    const runtimeApplied = await this.refresh({ force: true })
    if (!runtimeApplied) this.#disableManagedKinds()
    return { ...deleted, runtimeApplied }
  }

  async setGlobalProxySequence(selection, input = {}, { updatedBy = 'admin-token' } = {}) {
    if (!this.controlStore) throw new AppError(503, 'agent_control_unavailable', 'Proxy settings require PostgreSQL')
    const policy = selection && typeof selection === 'object' && !Array.isArray(selection)
      ? { ...selection, updatedBy }
      : { ...input, sequenceKey: selection, updatedBy }
    const saved = await this.controlStore.setGlobalProxySequence(policy)
    const runtimeApplied = await this.refresh({ force: true })
    if (!runtimeApplied) this.#disableManagedKinds()
    return { ...saved, runtimeApplied }
  }

  async revealProviderCredential(kind, providerId) {
    if (!this.settingsStore?.revealCredentialInternal) {
      throw new AppError(503, 'agent_settings_unavailable', 'Provider credentials require PostgreSQL')
    }
    const apiKey = await this.settingsStore.revealCredentialInternal(kind, providerId)
    if (!apiKey) throw new AppError(404, 'agent_provider_key_not_found', 'The Provider has no saved API key')
    return { kind, providerId, apiKey }
  }

  async controlStatus() {
    if (!this.controlStore) {
      return { sequences: [], bindings: [], providerTests: [], proxy: { endpoints: [], sequences: [], globalSequenceKey: null, revision: 0 } }
    }
    const status = await this.controlStore.listPublicControl()
    return {
      ...status,
      // listPublicControl intentionally reads no environment configuration.
      // Re-project only the proof booleans from this runtime's last applied,
      // already-public Provider metadata and its internal routing snapshot.
      // The helper returns neither the effective route nor its current digest.
      sequences: (status.sequences || []).map((sequence) => projectSequenceRouteProof(
        sequence,
        this.#settings.get(sequence.kind),
        this.#control.get(sequence.kind),
      )),
    }
  }

  status() {
    return {
      ...this.#agent.status(),
      embeddingCapabilities: publicEmbeddingCapabilityCatalog(),
      settings: {
        chat: this.#settings.get('chat'),
        embedding: this.#settings.get('embedding'),
      },
      sequences: [...this.#control.values()].flatMap((control) => control?.sequences || []),
      bindings: [...this.#control.values()].flatMap((control) => control?.defaultBinding ? [control.defaultBinding] : []),
    }
  }
}

export async function createAgentRuntime(options) {
  return new AgentRuntime(options).start()
}
