import { AppError } from '../core/errors.mjs'

const PROVIDER_KEY = 'justone'
const UPDATE_FIELDS = new Set(['apiKey', 'expectedRevision'])

function assertProvider(providerKey) {
  if (providerKey !== PROVIDER_KEY) {
    throw new AppError(404, 'external_platform_not_found', 'External platform not found')
  }
}

function invalid(message) {
  throw new AppError(400, 'invalid_external_platform_credential', message)
}

function credentialStoreUnavailable() {
  return new AppError(
    503,
    'external_platform_credential_store_unavailable',
    'External platform credential storage is unavailable',
  )
}

function normalizeUpdate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('request body must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !UPDATE_FIELDS.has(field))
  if (unsupported.length > 0) {
    invalid(`request contains unsupported field ${unsupported[0]}`)
  }
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4_096) {
    invalid('apiKey must be a non-empty string of at most 4096 characters')
  }
  if (
    !Object.hasOwn(input, 'expectedRevision')
    || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 0
  ) {
    invalid('expectedRevision must be a non-negative safe integer')
  }
  return {
    apiKey: input.apiKey.trim(),
    expectedRevision: input.expectedRevision,
  }
}

function safeCredential(setting, { environmentConfigured, databaseConfigured = false }) {
  const source = setting?.source === 'database' ? 'database' : 'environment'
  const credentialConfigured = source === 'database'
    ? Boolean(databaseConfigured)
    : Boolean(environmentConfigured)
  return {
    source,
    revision: Number(setting?.revision ?? 0),
    credentialConfigured,
    revealable: source === 'database' && credentialConfigured,
    updatedAt: setting?.updatedAt ?? null,
  }
}

function settingFromRow(row) {
  if (!row) return null
  return {
    source: row.source,
    revision: Number(row.revision),
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
  }
}

function revisionConflict(expectedRevision, currentRevision) {
  return new AppError(
    409,
    'external_platform_credential_revision_conflict',
    'External platform credential changed; reload and retry',
    { expectedRevision, currentRevision },
  )
}

export class MemoryExternalPlatformCredentialStore {
  constructor({ environmentConfigured = false } = {}) {
    this.environmentConfigured = Boolean(environmentConfigured)
    this.setting = {
      source: 'environment',
      revision: 0,
      updatedAt: null,
    }
    this.apiKey = null
  }

  async describeCredential(providerKey) {
    assertProvider(providerKey)
    return safeCredential(this.setting, {
      environmentConfigured: this.environmentConfigured,
      databaseConfigured: this.apiKey != null,
    })
  }

  async updateCredential(providerKey, input, { updatedBy = 'admin-token' } = {}) {
    assertProvider(providerKey)
    const normalized = normalizeUpdate(input)
    if (normalized.expectedRevision !== this.setting.revision) {
      throw revisionConflict(normalized.expectedRevision, this.setting.revision)
    }
    this.apiKey = normalized.apiKey
    this.setting = {
      source: 'database',
      revision: this.setting.revision + 1,
      updatedBy,
      updatedAt: new Date().toISOString(),
    }
    return this.describeCredential(providerKey)
  }

  /** Secret-bearing runtime/re-auth query. Never include its result in ordinary DTOs. */
  async readCredential(providerKey) {
    assertProvider(providerKey)
    if (this.setting.source !== 'database') return null
    if (!this.apiKey) throw credentialStoreUnavailable()
    return this.apiKey
  }
}

export class PostgresExternalPlatformCredentialStore {
  constructor({ pool, environmentConfigured = false }) {
    this.pool = pool
    this.environmentConfigured = Boolean(environmentConfigured)
  }

  async describeCredential(providerKey) {
    assertProvider(providerKey)
    const { rows } = await this.pool.query(
      `SELECT settings.source, settings.revision, settings.updated_at,
              EXISTS (
                SELECT 1
                  FROM control.external_platform_provider_credentials credential
                 WHERE credential.provider_key = settings.provider_key
              ) AS credential_configured
         FROM control.external_platform_provider_settings settings
        WHERE settings.provider_key = $1`,
      [providerKey],
    )
    const row = rows[0]
    return safeCredential(settingFromRow(row), {
      environmentConfigured: this.environmentConfigured,
      databaseConfigured: row?.credential_configured === true,
    })
  }

  async updateCredential(providerKey, input, { updatedBy = 'admin-token' } = {}) {
    assertProvider(providerKey)
    const normalized = normalizeUpdate(input)
    try {
      const client = await this.pool.connect()
      let commitStarted = false
      let committed = false
      let releaseError = null
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO control.external_platform_provider_settings (provider_key)
           VALUES ($1)
           ON CONFLICT (provider_key) DO NOTHING`,
          [providerKey],
        )
        const currentResult = await client.query(
          `SELECT source, revision, updated_at
             FROM control.external_platform_provider_settings
            WHERE provider_key = $1
            FOR UPDATE`,
          [providerKey],
        )
        const current = settingFromRow(currentResult.rows[0])
        if (!current) throw credentialStoreUnavailable()
        if (normalized.expectedRevision !== current.revision) {
          throw revisionConflict(normalized.expectedRevision, current.revision)
        }
        await client.query(
          `INSERT INTO control.external_platform_provider_credentials
             (provider_key, api_key, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (provider_key) DO UPDATE SET
             api_key = EXCLUDED.api_key,
             updated_at = now()`,
          [providerKey, normalized.apiKey],
        )
        const updated = await client.query(
          `UPDATE control.external_platform_provider_settings
              SET source = 'database',
                  revision = revision + 1,
                  updated_by = $2,
                  updated_at = now()
            WHERE provider_key = $1
          RETURNING source, revision, updated_at`,
          [providerKey, updatedBy],
        )
        const setting = settingFromRow(updated.rows[0])
        if (!setting) throw credentialStoreUnavailable()
        commitStarted = true
        await client.query('COMMIT')
        committed = true
        return safeCredential(setting, {
          environmentConfigured: this.environmentConfigured,
          databaseConfigured: true,
        })
      } catch (error) {
        if (commitStarted && !committed) {
          releaseError = error
        } else {
          releaseError = await client.query('ROLLBACK').then(
            () => null,
            (rollbackError) => rollbackError,
          )
        }
        throw error
      } finally {
        client.release(releaseError)
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      // `pg` errors may expose bind values through detail/query/parameters.
      // Never let an original database error cross into the generic app logger.
      throw credentialStoreUnavailable()
    }
  }

  /** Secret-bearing runtime/re-auth query. Never include its result in ordinary DTOs. */
  async readCredential(providerKey) {
    assertProvider(providerKey)
    try {
      const { rows } = await this.pool.query(
        `SELECT settings.source, credential.api_key
           FROM control.external_platform_provider_settings settings
           LEFT JOIN control.external_platform_provider_credentials credential
             ON credential.provider_key = settings.provider_key
          WHERE settings.provider_key = $1`,
        [providerKey],
      )
      const row = rows[0]
      if (!row || row.source !== 'database') return null
      if (!row.api_key) throw credentialStoreUnavailable()
      return row.api_key
    } catch (error) {
      if (error instanceof AppError) throw error
      throw credentialStoreUnavailable()
    }
  }
}

export function createExternalPlatformCredentialStore({
  pool = null,
  environmentConfigured = false,
} = {}) {
  return pool
    ? new PostgresExternalPlatformCredentialStore({ pool, environmentConfigured })
    : new MemoryExternalPlatformCredentialStore({ environmentConfigured })
}
