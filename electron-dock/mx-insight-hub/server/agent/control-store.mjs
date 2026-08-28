import { AppError } from '../core/errors.mjs'

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const CONSUMER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/
const KINDS = new Set(['chat', 'embedding'])
const MAX_SEQUENCE_PROVIDERS = 32
const MAX_PROXY_ENDPOINTS = 16

function invalid(code, message) {
  throw new AppError(400, code, message)
}

function assertKind(kind) {
  if (!KINDS.has(kind)) invalid('invalid_agent_sequence', 'kind must be chat or embedding')
  return kind
}

function assertKey(value, field = 'key') {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    invalid('invalid_agent_sequence', `${field} must be a lowercase identifier`)
  }
  return value
}

function normalizedName(value, field = 'displayName') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
    invalid('invalid_agent_sequence', `${field} must be a non-empty string of at most 120 characters`)
  }
  return value.trim()
}

function expectedRevision(value) {
  if (!Number.isInteger(value) || value < 0) {
    invalid('invalid_agent_sequence', 'expectedRevision must be a non-negative integer')
  }
  return value
}

function uniqueKeys(values, { field, minimum = 0, maximum }) {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
    invalid('invalid_agent_sequence', `${field} must contain ${minimum}-${maximum} identifiers`)
  }
  const normalized = values.map((value) => assertKey(value, field))
  if (new Set(normalized).size !== normalized.length) {
    invalid('invalid_agent_sequence', `${field} must not contain duplicates`)
  }
  return normalized
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null
}

function sequenceRow(row) {
  return {
    sequenceKey: row.sequence_key,
    displayName: row.display_name,
    kind: row.kind,
    providerIds: row.provider_ids || [],
    enabled: row.enabled !== false,
    source: row.source,
    providerRevision: Number(row.provider_revision),
    revision: Number(row.revision),
    verifiedAt: iso(row.verified_at),
    verifiedBy: row.verified_by ?? null,
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function bindingRow(row) {
  return {
    consumerKey: row.consumer_key,
    kind: row.kind,
    sequenceKey: row.sequence_key,
    revision: Number(row.revision),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function proxyEndpointRow(row) {
  return {
    proxyKey: row.proxy_key,
    displayName: row.display_name,
    proxyUrl: row.proxy_url,
    enabled: row.enabled !== false,
    revision: Number(row.revision),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function proxySequenceRow(row) {
  return {
    sequenceKey: row.sequence_key,
    displayName: row.display_name,
    proxyKeys: row.proxy_keys || [],
    directFallback: row.direct_fallback === true,
    enabled: row.enabled !== false,
    revision: Number(row.revision),
    updatedBy: row.updated_by ?? null,
    updatedAt: iso(row.updated_at),
  }
}

function relationMissing(error) {
  return error?.code === '42P01' || error?.code === '3F000'
}

async function lockControlKey(client, namespace, key) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`mx-insight-agent:${namespace}:${key}`],
  )
}

export class AgentControlStore {
  constructor(pool) {
    this.pool = pool
  }

  async ensureBootstrapSequence({ kind, providerIds, providerRevision = 0 }) {
    assertKind(kind)
    const ids = uniqueKeys(providerIds, {
      field: 'providerIds', minimum: 1, maximum: MAX_SEQUENCE_PROVIDERS,
    })
    const sequenceKey = `mx-default-${kind}`
    const consumerKey = `hub.${kind}.default`
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO control.agent_llm_sequences
           (sequence_key, display_name, kind, provider_ids, source,
            provider_revision, updated_by)
         VALUES ($1, $2, $3, $4::text[], 'bootstrap', $5, 'environment-bootstrap')
         ON CONFLICT (sequence_key) DO NOTHING`,
        [sequenceKey, kind === 'chat' ? 'MX Default Chat' : 'MX Default Embedding', kind, ids, providerRevision],
      )
      await client.query(
        `INSERT INTO control.agent_consumer_bindings
           (consumer_key, kind, sequence_key, updated_by)
         VALUES ($1, $2, $3, 'environment-bootstrap')
         ON CONFLICT (consumer_key) DO NOTHING`,
        [consumerKey, kind, sequenceKey],
      )
      await client.query('COMMIT')
      return sequenceKey
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (relationMissing(error)) return null
      throw error
    } finally {
      client.release()
    }
  }

  async loadRuntimeSnapshot(kind) {
    assertKind(kind)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const sequences = await client.query(
        `SELECT sequence_key, display_name, kind, provider_ids, enabled, source,
                provider_revision, revision, verified_at, verified_by,
                updated_by, updated_at
           FROM control.agent_llm_sequences
          WHERE kind = $1
          ORDER BY display_name, sequence_key`,
        [kind],
      )
      const binding = await client.query(
        `SELECT consumer_key, kind, sequence_key, revision, updated_by, updated_at
           FROM control.agent_consumer_bindings
          WHERE consumer_key = $1`,
        [`hub.${kind}.default`],
      )
      const proxyEndpoints = await client.query(
        `SELECT proxy_key, display_name, proxy_url, enabled, revision, updated_by, updated_at
           FROM control.agent_proxy_endpoints
          ORDER BY display_name, proxy_key`,
      )
      const proxySequences = await client.query(
        `SELECT sequence_key, display_name, proxy_keys, direct_fallback,
                enabled, revision, updated_by, updated_at
           FROM control.agent_proxy_sequences
          ORDER BY display_name, sequence_key`,
      )
      const proxySetting = await client.query(
        `SELECT global_sequence_key, revision, updated_by, updated_at
           FROM control.agent_proxy_settings
          WHERE singleton = true`,
      )
      await client.query('COMMIT')
      return {
        sequences: sequences.rows.map(sequenceRow),
        defaultBinding: binding.rows[0] ? bindingRow(binding.rows[0]) : null,
        proxyEndpoints: proxyEndpoints.rows.map(proxyEndpointRow),
        proxySequences: proxySequences.rows.map(proxySequenceRow),
        globalProxySequenceKey: proxySetting.rows[0]?.global_sequence_key ?? null,
        proxyRevision: Number(proxySetting.rows[0]?.revision ?? 0),
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      // An older database may briefly run new application code before the
      // migration Job completes. Sequence governance must degrade to the
      // legacy catalog order rather than taking down login/readiness.
      if (relationMissing(error)) {
        return {
          sequences: [], defaultBinding: null, proxyEndpoints: [],
          proxySequences: [], globalProxySequenceKey: null, proxyRevision: 0,
        }
      }
      throw error
    } finally {
      client.release()
    }
  }

  async listPublicControl() {
    const [chat, embedding, probes] = await Promise.all([
      this.loadRuntimeSnapshot('chat'),
      this.loadRuntimeSnapshot('embedding'),
      this.pool.query(
        `SELECT DISTINCT ON (kind, provider_id)
                kind, provider_id, settings_revision, proxy_fingerprint,
                model, protocol, ok,
                latency_ms, error_code, tested_by, tested_at
           FROM agent_center.agent_provider_probe_results
          ORDER BY kind, provider_id, tested_at DESC`,
      ).catch((error) => relationMissing(error) ? { rows: [] } : Promise.reject(error)),
    ])
    const sequences = [...chat.sequences, ...embedding.sequences]
    const bindings = [chat.defaultBinding, embedding.defaultBinding].filter(Boolean)
    return {
      sequences,
      bindings,
      providerTests: probes.rows.map((row) => ({
        kind: row.kind,
        providerId: row.provider_id,
        settingsRevision: Number(row.settings_revision),
        proxyFingerprint: row.proxy_fingerprint,
        model: row.model,
        protocol: row.protocol,
        ok: row.ok === true,
        latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
        errorCode: row.error_code ?? null,
        testedBy: row.tested_by ?? null,
        testedAt: iso(row.tested_at),
      })),
      proxy: {
        endpoints: chat.proxyEndpoints,
        sequences: chat.proxySequences,
        globalSequenceKey: chat.globalProxySequenceKey,
        revision: chat.proxyRevision,
      },
    }
  }

  async recordProbe({ kind, providerId, settingsRevision, proxyFingerprint, model, protocol, ok, latencyMs = null, errorCode = null, testedBy = 'admin-token' }) {
    assertKind(kind)
    assertKey(providerId, 'providerId')
    if (typeof proxyFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(proxyFingerprint)) {
      invalid('invalid_agent_probe', 'proxyFingerprint must be a SHA-256 digest')
    }
    await this.pool.query(
      `INSERT INTO agent_center.agent_provider_probe_results
         (kind, provider_id, settings_revision, proxy_fingerprint, model,
          protocol, ok, latency_ms, error_code, tested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [kind, providerId, settingsRevision, proxyFingerprint, model, protocol, ok, latencyMs, errorCode, testedBy],
    )
  }

  async validateProxySequenceKeys(sequenceKeys) {
    const keys = uniqueKeys(sequenceKeys, {
      field: 'proxySequenceKeys', minimum: 0, maximum: MAX_SEQUENCE_PROVIDERS,
    })
    if (keys.length === 0) return
    try {
      const result = await this.pool.query(
        `SELECT sequence_key
           FROM control.agent_proxy_sequences
          WHERE enabled = true
            AND sequence_key = ANY($1::text[])`,
        [keys],
      )
      const available = new Set(result.rows.map((row) => row.sequence_key))
      for (const key of keys) {
        if (!available.has(key)) {
          invalid('invalid_provider_settings', `Proxy Sequence ${key} is missing or disabled`)
        }
      }
    } catch (error) {
      if (relationMissing(error)) {
        invalid('invalid_provider_settings', 'Proxy settings migration is not available')
      }
      throw error
    }
  }

  async saveSequence(sequenceKey, input, {
    providerRevision,
    verifiedBy = 'admin-token',
    updatedBy = 'admin-token',
  } = {}) {
    assertKey(sequenceKey, 'sequenceKey')
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      invalid('invalid_agent_sequence', 'request body must be an object')
    }
    for (const field of Object.keys(input)) {
      if (!['expectedRevision', 'displayName', 'kind', 'providerIds', 'enabled'].includes(field)) {
        invalid('invalid_agent_sequence', `request contains unsupported field ${field}`)
      }
    }
    const expected = expectedRevision(input.expectedRevision)
    const kind = assertKind(input.kind)
    const providerIds = uniqueKeys(input.providerIds, {
      field: 'providerIds', minimum: 1, maximum: MAX_SEQUENCE_PROVIDERS,
    })
    const displayName = normalizedName(input.displayName)
    const enabled = input.enabled ?? true
    if (typeof enabled !== 'boolean') invalid('invalid_agent_sequence', 'enabled must be boolean')
    if (!Number.isInteger(providerRevision) || providerRevision < 0) {
      invalid('invalid_agent_sequence', 'provider revision is unavailable')
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'llm-sequence', sequenceKey)
      const setting = await client.query(
        `SELECT revision, providers
           FROM control.agent_provider_settings
          WHERE kind = $1
          FOR SHARE`,
        [kind],
      )
      const currentProviderRevision = Number(setting.rows[0]?.revision ?? 0)
      if (currentProviderRevision !== providerRevision) {
        throw new AppError(409, 'provider_revision_conflict', 'Provider catalog changed during Sequence verification')
      }
      const catalog = new Map((setting.rows[0]?.providers || []).map((provider) => [provider.id, provider]))
      for (const providerId of providerIds) {
        const provider = catalog.get(providerId)
        if (!provider) invalid('invalid_agent_sequence', `Unknown ${kind} provider: ${providerId}`)
        if (provider.enabled === false) invalid('invalid_agent_sequence', `Provider ${providerId} is disabled`)
      }
      const current = await client.query(
        `SELECT revision, kind FROM control.agent_llm_sequences
          WHERE sequence_key = $1 FOR UPDATE`,
        [sequenceKey],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'sequence_revision_conflict', 'LLM Sequence changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (current.rows[0] && current.rows[0].kind !== kind) {
        invalid('invalid_agent_sequence', 'An existing Sequence cannot change capability kind')
      }
      const saved = await client.query(
        `INSERT INTO control.agent_llm_sequences
           (sequence_key, display_name, kind, provider_ids, enabled, source,
            provider_revision, revision, verified_at, verified_by,
            updated_by, updated_at)
         VALUES ($1, $2, $3, $4::text[], $5, 'database', $6, 1, now(), $7, $8, now())
         ON CONFLICT (sequence_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           kind = EXCLUDED.kind,
           provider_ids = EXCLUDED.provider_ids,
           enabled = EXCLUDED.enabled,
           source = 'database',
           provider_revision = EXCLUDED.provider_revision,
           revision = control.agent_llm_sequences.revision + 1,
           verified_at = now(),
           verified_by = EXCLUDED.verified_by,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING sequence_key, display_name, kind, provider_ids, enabled,
                   source, provider_revision, revision, verified_at,
                   verified_by, updated_by, updated_at`,
        [sequenceKey, displayName, kind, providerIds, enabled, providerRevision, verifiedBy, updatedBy],
      )
      await client.query('COMMIT')
      return sequenceRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async setDefaultSequence(kind, sequenceKey, { expectedRevision: expected, updatedBy = 'admin-token' } = {}) {
    assertKind(kind)
    assertKey(sequenceKey, 'sequenceKey')
    expectedRevision(expected)
    const consumerKey = `hub.${kind}.default`
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'consumer-binding', consumerKey)
      const current = await client.query(
        `SELECT revision FROM control.agent_consumer_bindings
          WHERE consumer_key = $1 FOR UPDATE`,
        [consumerKey],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'binding_revision_conflict', 'Default Sequence binding changed; reload and retry', {
          currentRevision: revision,
        })
      }
      const sequence = await client.query(
        `SELECT enabled, provider_revision FROM control.agent_llm_sequences
          WHERE sequence_key = $1 AND kind = $2
          FOR SHARE`,
        [sequenceKey, kind],
      )
      if (!sequence.rows[0] || sequence.rows[0].enabled === false) {
        invalid('invalid_agent_binding', 'The selected Sequence is missing or disabled')
      }
      const setting = await client.query(
        'SELECT revision FROM control.agent_provider_settings WHERE kind = $1 FOR SHARE',
        [kind],
      )
      if (Number(sequence.rows[0].provider_revision) !== Number(setting.rows[0]?.revision ?? 0)) {
        throw new AppError(409, 'sequence_verification_stale', 'The selected Sequence must be tested against the current Provider catalog')
      }
      const saved = await client.query(
        `INSERT INTO control.agent_consumer_bindings
           (consumer_key, kind, sequence_key, revision, updated_by, updated_at)
         VALUES ($1, $2, $3, 1, $4, now())
         ON CONFLICT (consumer_key) DO UPDATE SET
           kind = EXCLUDED.kind,
           sequence_key = EXCLUDED.sequence_key,
           revision = control.agent_consumer_bindings.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING consumer_key, kind, sequence_key, revision, updated_by, updated_at`,
        [consumerKey, kind, sequenceKey, updatedBy],
      )
      await client.query('COMMIT')
      return bindingRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async saveProxyEndpoint(proxyKey, input, { updatedBy = 'admin-token' } = {}) {
    assertKey(proxyKey, 'proxyKey')
    const expected = expectedRevision(input?.expectedRevision)
    const displayName = normalizedName(input?.displayName)
    const enabled = input?.enabled ?? true
    if (typeof enabled !== 'boolean') invalid('invalid_agent_proxy', 'enabled must be boolean')
    let url
    try { url = new URL(input?.proxyUrl) } catch { invalid('invalid_agent_proxy', 'proxyUrl must be a valid URL') }
    if (!['http:', 'https:'].includes(url.protocol)) {
      invalid('invalid_agent_proxy', 'proxyUrl must use http or https')
    }
    if (url.username || url.password) {
      invalid('invalid_agent_proxy', 'proxyUrl must not contain credentials')
    }
    if (url.search || url.hash) invalid('invalid_agent_proxy', 'proxyUrl must not contain query or fragment')
    if (url.pathname !== '/' && url.pathname !== '') invalid('invalid_agent_proxy', 'proxyUrl must not contain a path')
    const proxyUrl = url.toString().replace(/\/$/, '')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'proxy-endpoint', proxyKey)
      const current = await client.query(
        'SELECT revision FROM control.agent_proxy_endpoints WHERE proxy_key = $1 FOR UPDATE',
        [proxyKey],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'proxy_revision_conflict', 'Proxy endpoint changed; reload and retry', {
          currentRevision: revision,
        })
      }
      const saved = await client.query(
        `INSERT INTO control.agent_proxy_endpoints
           (proxy_key, display_name, proxy_url, enabled, revision, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, now())
         ON CONFLICT (proxy_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           proxy_url = EXCLUDED.proxy_url,
           enabled = EXCLUDED.enabled,
           revision = control.agent_proxy_endpoints.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING proxy_key, display_name, proxy_url, enabled, revision, updated_by, updated_at`,
        [proxyKey, displayName, proxyUrl, enabled, updatedBy],
      )
      await client.query('COMMIT')
      return proxyEndpointRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async saveProxySequence(sequenceKey, input, { updatedBy = 'admin-token' } = {}) {
    assertKey(sequenceKey, 'sequenceKey')
    const expected = expectedRevision(input?.expectedRevision)
    const displayName = normalizedName(input?.displayName)
    const proxyKeys = uniqueKeys(input?.proxyKeys || [], {
      field: 'proxyKeys', minimum: 0, maximum: MAX_PROXY_ENDPOINTS,
    })
    const directFallback = input?.directFallback ?? true
    const enabled = input?.enabled ?? true
    if (typeof directFallback !== 'boolean' || typeof enabled !== 'boolean') {
      invalid('invalid_agent_proxy', 'directFallback and enabled must be boolean')
    }
    if (proxyKeys.length === 0 && !directFallback) {
      invalid('invalid_agent_proxy', 'Proxy Sequence requires an endpoint or direct fallback')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'proxy-sequence', sequenceKey)
      const endpoints = await client.query(
        `SELECT proxy_key, enabled
           FROM control.agent_proxy_endpoints
          WHERE proxy_key = ANY($1::text[])
          FOR SHARE`,
        [proxyKeys],
      )
      const enabledKeys = new Set(endpoints.rows.filter((row) => row.enabled).map((row) => row.proxy_key))
      for (const key of proxyKeys) {
        if (!enabledKeys.has(key)) invalid('invalid_agent_proxy', `Proxy endpoint ${key} is missing or disabled`)
      }
      const current = await client.query(
        'SELECT revision FROM control.agent_proxy_sequences WHERE sequence_key = $1 FOR UPDATE',
        [sequenceKey],
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'proxy_sequence_revision_conflict', 'Proxy Sequence changed; reload and retry', {
          currentRevision: revision,
        })
      }
      const saved = await client.query(
        `INSERT INTO control.agent_proxy_sequences
           (sequence_key, display_name, proxy_keys, direct_fallback,
            enabled, revision, updated_by, updated_at)
         VALUES ($1, $2, $3::text[], $4, $5, 1, $6, now())
         ON CONFLICT (sequence_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           proxy_keys = EXCLUDED.proxy_keys,
           direct_fallback = EXCLUDED.direct_fallback,
           enabled = EXCLUDED.enabled,
           revision = control.agent_proxy_sequences.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING sequence_key, display_name, proxy_keys, direct_fallback,
                   enabled, revision, updated_by, updated_at`,
        [sequenceKey, displayName, proxyKeys, directFallback, enabled, updatedBy],
      )
      await client.query('COMMIT')
      return proxySequenceRow(saved.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async setGlobalProxySequence(sequenceKey, { expectedRevision: expected, updatedBy = 'admin-token' } = {}) {
    if (sequenceKey != null) assertKey(sequenceKey, 'sequenceKey')
    expectedRevision(expected)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await lockControlKey(client, 'proxy-settings', 'global')
      const current = await client.query(
        'SELECT revision FROM control.agent_proxy_settings WHERE singleton = true FOR UPDATE',
      )
      const revision = Number(current.rows[0]?.revision ?? 0)
      if (revision !== expected) {
        throw new AppError(409, 'proxy_settings_revision_conflict', 'Global proxy setting changed; reload and retry', {
          currentRevision: revision,
        })
      }
      if (sequenceKey != null) {
        const selected = await client.query(
          'SELECT enabled FROM control.agent_proxy_sequences WHERE sequence_key = $1 FOR SHARE',
          [sequenceKey],
        )
        if (!selected.rows[0] || selected.rows[0].enabled === false) {
          invalid('invalid_agent_proxy', 'The selected Proxy Sequence is missing or disabled')
        }
      }
      const saved = await client.query(
        `INSERT INTO control.agent_proxy_settings
           (singleton, global_sequence_key, revision, updated_by, updated_at)
         VALUES (true, $1, 1, $2, now())
         ON CONFLICT (singleton) DO UPDATE SET
           global_sequence_key = EXCLUDED.global_sequence_key,
           revision = control.agent_proxy_settings.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
         RETURNING global_sequence_key, revision, updated_by, updated_at`,
        [sequenceKey, updatedBy],
      )
      await client.query('COMMIT')
      return {
        globalSequenceKey: saved.rows[0].global_sequence_key ?? null,
        revision: Number(saved.rows[0].revision),
        updatedBy: saved.rows[0].updated_by ?? null,
        updatedAt: iso(saved.rows[0].updated_at),
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}
