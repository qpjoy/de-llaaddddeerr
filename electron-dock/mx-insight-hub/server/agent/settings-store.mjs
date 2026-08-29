import { AppError } from '../core/errors.mjs'
import { isIP } from 'node:net'

const KINDS = new Set(['chat', 'embedding'])
const SOURCES = new Set(['environment', 'database'])
const AUTH_MODES = new Set(['bearer', 'none'])
const PROVIDER_PROTOCOLS = new Set(['openai-compatible', 'anthropic-messages'])
const ENDPOINT_PATHS = ['/chat/completions', '/embeddings', '/completions', '/messages']
const MAX_PROVIDERS = 32
const DEFAULT_TIMEOUT_MS = 60_000
const INPUT_FIELDS = new Set([
  'id', 'baseUrl', 'model', 'timeoutMs', 'dimensions', 'enabled', 'priority',
  'authMode', 'apiKey', 'clearApiKey', 'displayName', 'protocol',
  'proxySequenceKey',
])
const UPDATE_FIELDS = new Set(['expectedRevision', 'source', 'providers'])

function invalid(message) {
  throw new AppError(400, 'invalid_provider_settings', message)
}

export function assertProviderKind(kind) {
  if (!KINDS.has(kind)) invalid('kind must be chat or embedding')
  return kind
}

function normalizeBaseUrl(value, index) {
  if (typeof value !== 'string' || !value.trim()) invalid(`provider[${index}].baseUrl is required`)
  const raw = value.trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    invalid(`provider[${index}].baseUrl must be a valid URL`)
  }
  // Database-managed credentials may only be sent over TLS. Static environment
  // providers retain their existing compatibility rules in parseProviderConfig.
  if (url.protocol !== 'https:') invalid(`provider[${index}].baseUrl must use https`)
  if (url.username || url.password) invalid(`provider[${index}].baseUrl must not contain userinfo`)
  // URL.search/hash are empty for a bare trailing "?"/"#". Reject the
  // delimiters in the original input too so the no-query/no-fragment contract
  // remains literal rather than accepting those ambiguous spellings.
  if (raw.includes('?')) invalid(`provider[${index}].baseUrl must not contain a query string`)
  if (raw.includes('#')) invalid(`provider[${index}].baseUrl must not contain a fragment`)
  // DNS treats a trailing dot as the same absolute hostname. Canonicalize it
  // before the localhost check so `localhost.` cannot bypass the policy.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    invalid(`provider[${index}].baseUrl must not use localhost or an IP literal`)
  }
  url.hostname = hostname

  const path = url.pathname.replace(/\/+$/, '')
  for (const endpoint of ENDPOINT_PATHS) {
    if (path.endsWith(endpoint)) {
      invalid(`provider[${index}].baseUrl must be the API root, not an endpoint`)
    }
  }
  url.pathname = path || '/'
  return url.toString().replace(/\/+$/, '')
}

function normalizeProvider(entry, index, kind) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid(`provider[${index}] must be an object`)
  for (const field of Object.keys(entry)) {
    if (!INPUT_FIELDS.has(field)) invalid(`provider[${index}] contains unsupported field ${field}`)
  }
  if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id)) {
    invalid(`provider[${index}].id must be a lowercase provider identifier`)
  }
  if (typeof entry.model !== 'string' || !entry.model.trim() || entry.model.trim().length > 200) {
    invalid(`provider[${index}].model is required and must be at most 200 characters`)
  }
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    invalid(`provider[${index}].timeoutMs must be an integer between 1000 and 300000`)
  }
  const enabled = entry.enabled ?? true
  if (typeof enabled !== 'boolean') invalid(`provider[${index}].enabled must be boolean`)
  const priority = entry.priority ?? index
  if (!Number.isInteger(priority) || priority < 0 || priority > 10_000) {
    invalid(`provider[${index}].priority must be an integer between 0 and 10000`)
  }
  const authMode = entry.authMode ?? 'bearer'
  if (!AUTH_MODES.has(authMode)) invalid(`provider[${index}].authMode must be bearer or none`)
  const displayName = entry.displayName == null ? entry.id : entry.displayName
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 120) {
    invalid(`provider[${index}].displayName must be a non-empty string of at most 120 characters`)
  }
  const protocol = entry.protocol ?? 'openai-compatible'
  if (!PROVIDER_PROTOCOLS.has(protocol)) {
    invalid(`provider[${index}].protocol must be openai-compatible or anthropic-messages`)
  }
  if (kind === 'embedding' && protocol !== 'openai-compatible') {
    invalid(`provider[${index}].protocol must be openai-compatible for embeddings`)
  }
  const proxySequenceKey = entry.proxySequenceKey == null || entry.proxySequenceKey === ''
    ? null
    : entry.proxySequenceKey
  if (proxySequenceKey != null && (
    typeof proxySequenceKey !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(proxySequenceKey)
  )) {
    invalid(`provider[${index}].proxySequenceKey must be a lowercase sequence identifier`)
  }

  let dimensions
  if (kind === 'embedding') {
    dimensions = entry.dimensions
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      invalid(`provider[${index}].dimensions must be a positive integer`)
    }
  } else if (entry.dimensions != null) {
    invalid(`provider[${index}].dimensions is only valid for embedding providers`)
  }

  if (entry.apiKey != null && (
    typeof entry.apiKey !== 'string' || !entry.apiKey.trim() || entry.apiKey.length > 8_192
  )) {
    invalid(`provider[${index}].apiKey must be a non-empty string of at most 8192 characters`)
  }
  if (entry.clearApiKey != null && typeof entry.clearApiKey !== 'boolean') {
    invalid(`provider[${index}].clearApiKey must be boolean`)
  }
  if (entry.apiKey != null && entry.clearApiKey) {
    invalid(`provider[${index}] cannot set and clear its API key together`)
  }
  if (authMode === 'none' && entry.apiKey != null) {
    invalid(`provider[${index}] cannot set an API key when authMode is none`)
  }

  return {
    provider: {
      id: entry.id,
      displayName: displayName.trim(),
      baseUrl: normalizeBaseUrl(entry.baseUrl, index),
      model: entry.model.trim(),
      protocol,
      proxySequenceKey,
      timeoutMs,
      ...(kind === 'embedding' ? { dimensions } : {}),
      enabled,
      priority,
      authMode,
    },
    apiKey: entry.apiKey == null ? null : entry.apiKey.trim(),
    clearApiKey: entry.clearApiKey === true,
    inputIndex: index,
  }
}

export function normalizeDatabaseProviders(raw, { kind, expectedEmbeddingDimensions = null } = {}) {
  assertProviderKind(kind)
  if (!Array.isArray(raw)) invalid('providers must be an array')
  if (raw.length > MAX_PROVIDERS) invalid(`providers must contain at most ${MAX_PROVIDERS} entries`)
  const normalized = raw.map((entry, index) => normalizeProvider(entry, index, kind))
  const ids = new Set()
  for (const entry of normalized) {
    if (ids.has(entry.provider.id)) invalid(`provider id is duplicated: ${entry.provider.id}`)
    ids.add(entry.provider.id)
  }
  normalized.sort((left, right) => (
    left.provider.priority - right.provider.priority || left.inputIndex - right.inputIndex
  ))
  normalized.forEach((entry, priority) => { entry.provider.priority = priority })

  if (kind === 'embedding') {
    const active = normalized.filter((entry) => entry.provider.enabled)
    const dimensions = new Set(active.map((entry) => entry.provider.dimensions))
    const models = new Set(active.map((entry) => entry.provider.model))
    if (dimensions.size > 1 || models.size > 1) {
      invalid('enabled embedding providers must use the same model and dimensions')
    }
    if (expectedEmbeddingDimensions && active.some((entry) => (
      entry.provider.dimensions !== expectedEmbeddingDimensions
    ))) {
      invalid(`embedding providers must use the configured index dimensions (${expectedEmbeddingDimensions})`)
    }
  }
  return normalized
}

function settingRow(row) {
  return {
    kind: row.kind,
    source: row.source,
    revision: Number(row.revision),
    providers: row.providers || [],
    lockedEmbeddingModel: row.locked_embedding_model ?? null,
    lockedEmbeddingDimensions: row.locked_embedding_dimensions == null
      ? null
      : Number(row.locked_embedding_dimensions),
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ?? null,
  }
}

export function publicSetting(setting, configuredIds = new Set()) {
  return {
    kind: setting.kind,
    source: setting.source,
    revision: setting.revision,
    providers: setting.providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName || provider.id,
      baseUrl: provider.baseUrl,
      model: provider.model,
      protocol: provider.protocol || 'openai-compatible',
      proxySequenceKey: provider.proxySequenceKey || null,
      timeoutMs: provider.timeoutMs,
      ...(setting.kind === 'embedding' ? { dimensions: provider.dimensions } : {}),
      enabled: provider.enabled !== false,
      priority: provider.priority,
      authMode: provider.authMode || 'bearer',
      keyConfigured: (provider.authMode || 'bearer') === 'none' || configuredIds.has(provider.id),
    })),
    updatedBy: setting.updatedBy,
    updatedAt: setting.updatedAt,
  }
}

export class AgentSettingsStore {
  constructor(pool) {
    this.pool = pool
  }

  async loadSetting(kind) {
    assertProviderKind(kind)
    const { rows } = await this.pool.query(
      `SELECT kind, source, revision, providers, locked_embedding_model,
              locked_embedding_dimensions, updated_by, updated_at
         FROM control.agent_provider_settings
        WHERE kind = $1`,
      [kind],
    )
    return rows[0]
      ? settingRow(rows[0])
      : {
          kind, source: 'environment', revision: 0, providers: [],
          lockedEmbeddingModel: null, lockedEmbeddingDimensions: null,
          updatedBy: null, updatedAt: null,
        }
  }

  async loadCredentialIds(kind) {
    assertProviderKind(kind)
    const { rows } = await this.pool.query(
      `SELECT provider_id
         FROM control.agent_provider_credentials
        WHERE kind = $1`,
      [kind],
    )
    return new Set(rows.map((row) => row.provider_id))
  }

  /** Secret-bearing runtime query. Never call from an HTTP response path. */
  async loadCredentialsInternal(kind) {
    assertProviderKind(kind)
    const { rows } = await this.pool.query(
      `SELECT provider_id, api_key
         FROM control.agent_provider_credentials
        WHERE kind = $1`,
      [kind],
    )
    return new Map(rows.map((row) => [row.provider_id, row.api_key]))
  }

  /** Explicit Admin-token re-auth path. Never include this in list/status APIs. */
  async revealCredentialInternal(kind, providerId) {
    assertProviderKind(kind)
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId)) {
      invalid('providerId must be a lowercase provider identifier')
    }
    const { rows } = await this.pool.query(
      `SELECT api_key
         FROM control.agent_provider_credentials
        WHERE kind = $1 AND provider_id = $2`,
      [kind, providerId],
    )
    return rows[0]?.api_key ?? null
  }

  /**
   * Load metadata and credentials from one database snapshot.
   *
   * The queries deliberately remain separate so the normal settings query can
   * never acquire a secret-bearing shape. Repeatable read prevents a provider
   * update from committing between them and pairing a new key with an old
   * baseUrl in a polling runtime.
   */
  async loadRuntimeSetting(kind) {
    assertProviderKind(kind)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const settingResult = await client.query(
        `SELECT kind, source, revision, providers, locked_embedding_model,
                locked_embedding_dimensions, updated_by, updated_at
           FROM control.agent_provider_settings
          WHERE kind = $1`,
        [kind],
      )
      const setting = settingResult.rows[0]
        ? settingRow(settingResult.rows[0])
        : {
            kind, source: 'environment', revision: 0, providers: [],
            lockedEmbeddingModel: null, lockedEmbeddingDimensions: null,
            updatedBy: null, updatedAt: null,
          }
      let credentials = new Map()
      if (setting.source === 'database') {
        const credentialResult = await client.query(
          `SELECT provider_id, api_key
             FROM control.agent_provider_credentials
            WHERE kind = $1`,
          [kind],
        )
        credentials = new Map(credentialResult.rows.map((row) => [row.provider_id, row.api_key]))
      }
      await client.query('COMMIT')
      return { setting, credentials }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async loadPublicSetting(kind) {
    const [setting, configuredIds] = await Promise.all([
      this.loadSetting(kind),
      this.loadCredentialIds(kind),
    ])
    return publicSetting(setting, configuredIds)
  }

  /**
   * Persist the vector-space identity used by an environment-backed chain.
   *
   * The row lock makes first-start races deterministic: one process installs
   * the lock and a concurrent process with a different model observes it and
   * fails closed. Database-backed settings deliberately ignore the environment
   * value because their own persisted snapshot is authoritative.
   */
  async ensureEnvironmentEmbeddingLock({ model, dimensions }) {
    if (typeof model !== 'string' || !model.trim()) invalid('embedding model is required')
    if (!Number.isInteger(dimensions) || dimensions <= 0) invalid('embedding dimensions must be a positive integer')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO control.agent_provider_settings (kind)
         VALUES ('embedding')
         ON CONFLICT (kind) DO NOTHING`,
      )
      const currentResult = await client.query(
        `SELECT kind, source, revision, providers, locked_embedding_model,
                locked_embedding_dimensions, updated_by, updated_at
           FROM control.agent_provider_settings
          WHERE kind = 'embedding'
          FOR UPDATE`,
      )
      let current = settingRow(currentResult.rows[0])
      if (current.source !== 'environment') {
        await client.query('COMMIT')
        return current
      }
      if (current.lockedEmbeddingModel && (
        current.lockedEmbeddingModel !== model.trim()
        || current.lockedEmbeddingDimensions !== dimensions
      )) {
        throw new AppError(409, 'reindex_required', 'Changing the embedding model or dimensions requires a controlled re-embedding')
      }
      if (!current.lockedEmbeddingModel) {
        const updated = await client.query(
          `UPDATE control.agent_provider_settings
              SET locked_embedding_model = $1,
                  locked_embedding_dimensions = $2,
                  revision = revision + 1,
                  updated_by = 'environment-lock',
                  updated_at = now()
            WHERE kind = 'embedding'
              AND source = 'environment'
              AND locked_embedding_model IS NULL
          RETURNING kind, source, revision, providers, locked_embedding_model,
                    locked_embedding_dimensions, updated_by, updated_at`,
          [model.trim(), dimensions],
        )
        if (updated.rows[0]) current = settingRow(updated.rows[0])
      }
      await client.query('COMMIT')
      return current
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async updateSetting(kind, input, {
    updatedBy = 'admin-token',
    expectedEmbeddingDimensions = null,
    embeddingBaseline = null,
    environmentEmbeddingProviders = [],
  } = {}) {
    assertProviderKind(kind)
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('request body must be an object')
    for (const field of Object.keys(input)) {
      if (!UPDATE_FIELDS.has(field)) invalid(`request contains unsupported field ${field}`)
    }
    const expectedRevision = input?.expectedRevision
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      invalid('expectedRevision must be a non-negative integer')
    }
    const source = input?.source
    if (!SOURCES.has(source)) invalid('source must be environment or database')
    if (source === 'environment' && input.providers != null && (
      !Array.isArray(input.providers) || input.providers.length > 0
    )) {
      invalid('providers must be omitted or empty when source is environment')
    }
    const normalized = source === 'database'
      ? normalizeDatabaseProviders(input?.providers, { kind, expectedEmbeddingDimensions })
      : []

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Migration 017 seeds both rows, but keep the DAO correct if an operator
      // repairs/deletes one. The insert participates in PostgreSQL's unique-key
      // serialization, so two expectedRevision=0 writers cannot both upsert a
      // revision-1 value from a missing row.
      await client.query(
        `INSERT INTO control.agent_provider_settings (kind)
         VALUES ($1)
         ON CONFLICT (kind) DO NOTHING`,
        [kind],
      )
      const currentResult = await client.query(
        `SELECT kind, source, revision, providers, locked_embedding_model,
                locked_embedding_dimensions, updated_by, updated_at
           FROM control.agent_provider_settings
          WHERE kind = $1
          FOR UPDATE`,
        [kind],
      )
      const current = currentResult.rows[0]
        ? settingRow(currentResult.rows[0])
        : {
            kind, source: 'environment', revision: 0, providers: [],
            lockedEmbeddingModel: null, lockedEmbeddingDimensions: null,
            updatedBy: null, updatedAt: null,
          }
      if (current.revision !== expectedRevision) {
        throw new AppError(409, 'settings_revision_conflict', 'Provider settings changed; reload and retry', {
          currentRevision: current.revision,
        })
      }

      // Keep Provider → Proxy Sequence binding validation in the same
      // transaction as the Provider write. deleteProxySequence takes the
      // complementary Provider FOR SHARE lock before deleting the Sequence,
      // so validation and persistence cannot be split by a concurrent DELETE.
      const proxySequenceKeys = source === 'database'
        ? [...new Set(normalized.map(({ provider }) => provider.proxySequenceKey).filter(Boolean))]
        : []
      if (proxySequenceKeys.length > 0) {
        let proxySequences
        let enabledProxyEndpoints
        try {
          proxySequences = await client.query(
            `SELECT sequence_key, enabled, proxy_keys
               FROM control.agent_proxy_sequences
              WHERE sequence_key = ANY($1::text[])
              FOR SHARE`,
            [proxySequenceKeys],
          )
          const proxyKeys = [...new Set(proxySequences.rows.flatMap((sequence) => (
            Array.isArray(sequence.proxy_keys) ? sequence.proxy_keys : []
          )))]
          enabledProxyEndpoints = proxyKeys.length > 0
            ? await client.query(
                `SELECT proxy_key
                   FROM control.agent_proxy_endpoints
                  WHERE enabled = true
                    AND proxy_key = ANY($1::text[])
                  FOR SHARE`,
                [proxyKeys],
              )
            : { rows: [] }
        } catch (error) {
          if (error?.code === '42P01' || error?.code === '3F000') {
            throw new AppError(503, 'agent_control_unavailable', 'Proxy settings require the Agent control migration')
          }
          throw error
        }
        const available = new Map(proxySequences.rows.map((sequence) => [sequence.sequence_key, sequence]))
        const enabledKeys = new Set(enabledProxyEndpoints.rows.map((endpoint) => endpoint.proxy_key))
        for (const sequenceKey of proxySequenceKeys) {
          const sequence = available.get(sequenceKey)
          if (!sequence || sequence.enabled === false || !Array.isArray(sequence.proxy_keys)
            || sequence.proxy_keys.length === 0) {
            invalid(`Proxy Sequence ${sequenceKey} is missing, disabled, or contains no endpoints`)
          }
          if (!sequence.proxy_keys.some((proxyKey) => enabledKeys.has(proxyKey))) {
            invalid(`Proxy Sequence ${sequenceKey} has no enabled endpoint`)
          }
        }
      }

      // Provider IDs are embedded in LLM Sequence rows rather than backed by
      // a foreign key because the catalog itself is a versioned JSON value.
      // Keep the same Provider -> Proxy -> LLM lock order used by Sequence
      // writes, then reject a catalog replacement that would strand a saved
      // Sequence. The UI performs the same check for a better explanation,
      // but this transaction is the authority for direct API calls and races.
      if (source === 'database') {
        const retainedProviderIds = new Set(normalized.map(({ provider }) => provider.id))
        const removedProviderIds = current.providers
          .map((provider) => provider.id)
          .filter((providerId) => !retainedProviderIds.has(providerId))
        if (removedProviderIds.length > 0) {
          let references = { rows: [] }
          try {
            references = await client.query(
              `SELECT sequence_key, provider_ids
                 FROM control.agent_llm_sequences
                WHERE kind = $1
                  AND provider_ids && $2::text[]
                ORDER BY sequence_key
                FOR SHARE`,
              [kind, removedProviderIds],
            )
          } catch (error) {
            // Older rolling-deployment peers may update Provider settings
            // before migration 041 exists; without that relation there cannot
            // yet be an LLM Sequence reference to protect.
            if (error?.code !== '42P01' && error?.code !== '3F000') throw error
          }
          if (references.rows.length > 0) {
            throw new AppError(
              409,
              'agent_provider_in_use',
              'Remove the Provider from every LLM Sequence before deleting it',
              {
                providerIds: removedProviderIds,
                sequenceKeys: references.rows.map((row) => row.sequence_key),
              },
            )
          }
        }
      }

      const activeEmbedding = kind === 'embedding' && source === 'database'
        ? normalized.filter(({ provider }) => provider.enabled)
        : []
      const applicableEmbeddingBaseline = current.source === 'environment'
        ? embeddingBaseline
        : null
      let lockedEmbeddingModel = current.lockedEmbeddingModel
        || applicableEmbeddingBaseline?.model || null
      let lockedEmbeddingDimensions = current.lockedEmbeddingDimensions
        || applicableEmbeddingBaseline?.dimensions || null
      if (kind === 'embedding' && source === 'environment' && lockedEmbeddingModel) {
        if (environmentEmbeddingProviders.some((provider) => (
          provider.model !== lockedEmbeddingModel
          || provider.dimensions !== lockedEmbeddingDimensions
        ))) {
          throw new AppError(409, 'reindex_required', 'Changing the embedding model or dimensions requires a controlled re-embedding')
        }
      }
      if (kind === 'embedding' && source === 'database') {
        if (lockedEmbeddingModel && normalized.length === 0) {
          throw new AppError(409, 'embedding_pause_requires_snapshot', 'Pause embedding by disabling the stored providers; do not remove its vector-space snapshot')
        }
        if (!lockedEmbeddingModel && activeEmbedding.length > 0) {
          lockedEmbeddingModel = activeEmbedding[0].provider.model
          lockedEmbeddingDimensions = activeEmbedding[0].provider.dimensions
        }
        if (lockedEmbeddingModel && normalized.some(({ provider }) => (
          provider.model !== lockedEmbeddingModel
          || provider.dimensions !== lockedEmbeddingDimensions
        ))) {
          throw new AppError(409, 'reindex_required', 'Changing the embedding model or dimensions requires a controlled re-embedding')
        }
      }

      const credentialRows = await client.query(
        `SELECT provider_id
           FROM control.agent_provider_credentials
          WHERE kind = $1`,
        [kind],
      )
      const configuredIds = new Set(credentialRows.rows.map((row) => row.provider_id))
      const currentProviders = new Map(current.providers.map((provider) => [provider.id, provider]))

      if (source === 'database') {
        for (const entry of normalized) {
          const { provider, apiKey, clearApiKey } = entry
          const previous = currentProviders.get(provider.id)
          const hadKey = configuredIds.has(provider.id)
          if (provider.authMode === 'none') {
            configuredIds.delete(provider.id)
            continue
          }
          if (hadKey && previous?.baseUrl !== provider.baseUrl && apiKey == null && !clearApiKey) {
            throw new AppError(400, 'credential_reconfirmation_required', `Provider ${provider.id} changed baseUrl; set a new key or explicitly clear it`)
          }
          if (apiKey != null) configuredIds.add(provider.id)
          else if (clearApiKey) configuredIds.delete(provider.id)
          else if (provider.enabled && !hadKey) {
            throw new AppError(400, 'provider_key_required', `Provider ${provider.id} requires a new API key`)
          }
        }
      }

      // Environment rollback keeps the locked vector-space signature and the
      // disabled metadata snapshot. Otherwise a later DB config could bypass
      // the reindex guard by toggling through environment first.
      const providers = source === 'environment' && kind === 'embedding'
        ? current.providers
        : normalized.map((entry) => entry.provider)
      const updated = await client.query(
        `INSERT INTO control.agent_provider_settings
           (kind, source, revision, providers, locked_embedding_model,
            locked_embedding_dimensions, updated_by, updated_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6, now())
         ON CONFLICT (kind) DO UPDATE SET
           source = EXCLUDED.source,
           revision = control.agent_provider_settings.revision + 1,
           providers = EXCLUDED.providers,
           locked_embedding_model = coalesce(EXCLUDED.locked_embedding_model,
             control.agent_provider_settings.locked_embedding_model),
           locked_embedding_dimensions = coalesce(EXCLUDED.locked_embedding_dimensions,
             control.agent_provider_settings.locked_embedding_dimensions),
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING kind, source, revision, providers, locked_embedding_model,
                   locked_embedding_dimensions, updated_by, updated_at`,
        [
          kind, source, JSON.stringify(providers), lockedEmbeddingModel,
          lockedEmbeddingDimensions, updatedBy,
        ],
      )

      if (source === 'environment') {
        await client.query('DELETE FROM control.agent_provider_credentials WHERE kind = $1', [kind])
        configuredIds.clear()
      } else {
        const retained = new Set(providers.map((provider) => provider.id))
        await client.query(
          `DELETE FROM control.agent_provider_credentials
            WHERE kind = $1 AND NOT (provider_id = ANY($2::text[]))`,
          [kind, [...retained]],
        )
        for (const entry of normalized) {
          if (entry.provider.authMode === 'none' || entry.clearApiKey) {
            await client.query(
              'DELETE FROM control.agent_provider_credentials WHERE kind = $1 AND provider_id = $2',
              [kind, entry.provider.id],
            )
          } else if (entry.apiKey != null) {
            await client.query(
              `INSERT INTO control.agent_provider_credentials (kind, provider_id, api_key, updated_at)
               VALUES ($1, $2, $3, now())
               ON CONFLICT (kind, provider_id) DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = now()`,
              [kind, entry.provider.id, entry.apiKey],
            )
          }
        }
      }

      await client.query('COMMIT')
      return publicSetting(settingRow(updated.rows[0]), configuredIds)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}
