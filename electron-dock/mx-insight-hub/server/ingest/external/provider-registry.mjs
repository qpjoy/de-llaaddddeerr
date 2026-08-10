import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { AppError } from '../../core/errors.mjs'

export const PROVIDER_MASTER_KEY_ENV = 'MX_INSIGHT_PROVIDER_MASTER_KEY'

const ALGORITHM = 'aes-256-gcm'
const ENVELOPE_VERSION = 1
const CONFIG_FIELDS = new Set(['host', 'port', 'database', 'username', 'sslMode'])
const UPDATE_FIELDS = new Set(['displayName', 'config', 'password'])
const SSL_MODES = new Set(['disable', 'require', 'verify-ca', 'verify-full'])
const HEALTH_STATUSES = new Set(['unknown', 'healthy', 'unhealthy'])

function invalid(code, message, details) {
  throw new AppError(400, code, message, details)
}

function textField(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid('invalid_provider_config', `${name} must be a non-empty string of at most ${maxLength} characters`)
  }
  return value.trim()
}

export function normalizeProviderKey(value) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(value)) {
    invalid(
      'invalid_provider_key',
      'providerKey must be 1-128 lowercase letters, digits, dots, underscores, or hyphens',
    )
  }
  return value
}

export function normalizePostgresProviderConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('invalid_provider_config', 'config must be an object')
  }
  const unknown = Object.keys(input).filter((key) => !CONFIG_FIELDS.has(key))
  if (unknown.length > 0) {
    invalid('invalid_provider_config', 'config contains unsupported fields', { fields: unknown.sort() })
  }

  const port = input.port ?? 5432
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    invalid('invalid_provider_config', 'port must be an integer between 1 and 65535')
  }
  const sslMode = input.sslMode ?? 'require'
  if (!SSL_MODES.has(sslMode)) {
    invalid('invalid_provider_config', 'sslMode must be disable, require, verify-ca, or verify-full')
  }

  const host = textField(input.host, 'host', 253)
  if (/\s|\/|@|:\/\//.test(host)) {
    invalid('invalid_provider_config', 'host must not contain a URL scheme, path, credentials, or whitespace')
  }

  return {
    host,
    port,
    database: textField(input.database, 'database', 128),
    username: textField(input.username, 'username', 128),
    sslMode,
  }
}

function passwordValue(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4_096) {
    invalid('invalid_provider_secret', 'password must be a non-empty string of at most 4096 bytes')
  }
  return value
}

function decodedBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  const canonical = decoded.toString('base64').replace(/=+$/, '')
  return canonical === value.replace(/=+$/, '') ? decoded : null
}

export function parseProviderMasterKey(value) {
  const encoded = typeof value === 'string' ? value.trim() : ''
  if (!encoded) {
    throw new AppError(
      500,
      'provider_master_key_not_configured',
      `${PROVIDER_MASTER_KEY_ENV} is required for source provider secrets`,
    )
  }
  const key = /^[0-9a-fA-F]{64}$/.test(encoded)
    ? Buffer.from(encoded, 'hex')
    : decodedBase64(encoded)
  if (!key || key.length !== 32) {
    throw new AppError(
      500,
      'invalid_provider_master_key',
      `${PROVIDER_MASTER_KEY_ENV} must be a 32-byte base64 value or 64 hexadecimal characters`,
    )
  }
  return key
}

export function encryptProviderPassword({ providerKey, password, masterKey }) {
  const aad = Buffer.from(normalizeProviderKey(providerKey), 'utf8')
  const key = parseProviderMasterKey(masterKey)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ password: passwordValue(password) }), 'utf8'),
    cipher.final(),
  ])
  return {
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

function envelopePart(value, bytes) {
  const decoded = decodedBase64(value)
  if (!decoded || (bytes != null && decoded.length !== bytes)) throw new Error('invalid envelope')
  return decoded
}

export function decryptProviderPassword({ providerKey, encryptedSecret, masterKey }) {
  try {
    const aad = Buffer.from(normalizeProviderKey(providerKey), 'utf8')
    const key = parseProviderMasterKey(masterKey)
    if (
      !encryptedSecret || encryptedSecret.version !== ENVELOPE_VERSION ||
      encryptedSecret.algorithm !== ALGORITHM
    ) {
      throw new Error('unsupported envelope')
    }
    const decipher = createDecipheriv(ALGORITHM, key, envelopePart(encryptedSecret.iv, 12))
    decipher.setAAD(aad)
    decipher.setAuthTag(envelopePart(encryptedSecret.authTag, 16))
    const plaintext = Buffer.concat([
      decipher.update(envelopePart(encryptedSecret.ciphertext)),
      decipher.final(),
    ]).toString('utf8')
    const parsed = JSON.parse(plaintext)
    return passwordValue(parsed.password)
  } catch (error) {
    if (error instanceof AppError && error.code?.includes('master_key')) throw error
    throw new AppError(500, 'provider_secret_invalid', 'Source provider secret could not be decrypted')
  }
}

export function safeSourceProvider(provider) {
  if (!provider) return null
  return {
    id: provider.id,
    providerKey: provider.providerKey,
    displayName: provider.displayName,
    providerType: provider.providerType,
    config: provider.config ? normalizePostgresProviderConfig(provider.config) : null,
    secretConfigured: provider.secretConfigured ?? Boolean(provider.encryptedSecret),
    healthStatus: provider.healthStatus,
    healthCheckedAt: provider.healthCheckedAt,
    healthErrorCode: provider.healthErrorCode,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  }
}

export class ProviderRegistry {
  #masterKey

  constructor({ store, masterKey = process.env[PROVIDER_MASTER_KEY_ENV] }) {
    if (!store) throw new TypeError('store is required')
    this.store = store
    this.#masterKey = parseProviderMasterKey(masterKey)
  }

  async create(
    { providerKey, displayName, providerType = 'postgresql', config, password },
    { validateCredentials = null } = {},
  ) {
    const key = normalizeProviderKey(providerKey)
    if (providerType !== 'postgresql') invalid('invalid_provider_type', 'Only postgresql providers are supported')
    const normalizedConfig = normalizePostgresProviderConfig(config)
    const normalizedPassword = passwordValue(password)
    let health = null
    if (validateCredentials != null) {
      if (typeof validateCredentials !== 'function') throw new TypeError('validateCredentials must be a function')
      await validateCredentials({ ...normalizedConfig, password: normalizedPassword })
      health = { status: 'healthy', checkedAt: new Date(), errorCode: null }
    }
    const record = await this.store.createSourceProvider({
      providerKey: key,
      displayName: textField(displayName, 'displayName', 128),
      providerType,
      config: normalizedConfig,
      encryptedSecret: encryptProviderPassword({ providerKey: key, password: normalizedPassword, masterKey: this.#masterKey.toString('base64') }),
      health,
    })
    return safeSourceProvider(record)
  }

  async list() {
    return (await this.store.listSourceProviders()).map(safeSourceProvider)
  }

  async get(providerKey) {
    return safeSourceProvider(await this.store.getSourceProvider(normalizeProviderKey(providerKey)))
  }

  async update(providerKey, patch, { validateCredentials = null } = {}) {
    const key = normalizeProviderKey(providerKey)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      invalid('invalid_provider', 'provider update must be an object')
    }
    const unknown = Object.keys(patch).filter((field) => !UPDATE_FIELDS.has(field))
    if (unknown.length > 0) {
      invalid('invalid_provider', 'provider update contains unsupported fields', { fields: unknown.sort() })
    }
    const update = {}
    if (patch.displayName !== undefined) update.displayName = textField(patch.displayName, 'displayName', 128)
    if (patch.config !== undefined) update.config = normalizePostgresProviderConfig(patch.config)
    if (patch.password !== undefined) {
      update.encryptedSecret = encryptProviderPassword({
        providerKey: key,
        password: patch.password,
        masterKey: this.#masterKey.toString('base64'),
      })
    }
    if (Object.keys(update).length === 0) invalid('invalid_provider', 'provider update must change at least one field')

    const changesConnection = patch.config !== undefined || patch.password !== undefined
    if (changesConnection) {
      if (typeof validateCredentials !== 'function') {
        throw new AppError(
          503,
          'provider_validation_unavailable',
          'Provider connection changes require a successful read-only test before they can be saved',
        )
      }
      const current = await this.store.getSourceProviderSecret(key)
      if (!current) throw new AppError(404, 'provider_not_found', `Unknown source provider: ${key}`)
      const config = patch.config === undefined
        ? normalizePostgresProviderConfig(current.config)
        : update.config
      const password = patch.password === undefined
        ? decryptProviderPassword({
            providerKey: key,
            encryptedSecret: current.encryptedSecret,
            masterKey: this.#masterKey.toString('base64'),
          })
        : passwordValue(patch.password)
      // The candidate is tested before the encrypted envelope or coordinates
      // are replaced. A typo therefore cannot break every source using the
      // provider, and a failed draft test does not poison the last-known-good
      // health evidence.
      await validateCredentials({ ...config, password })
      update.healthStatus = 'healthy'
      update.healthCheckedAt = new Date()
      update.healthErrorCode = null
    }
    return safeSourceProvider(await this.store.updateSourceProvider(key, update))
  }

  async delete(providerKey) {
    return this.store.deleteSourceProvider(normalizeProviderKey(providerKey))
  }

  async recordHealth(providerKey, { status, errorCode = null, checkedAt = new Date() }) {
    if (!HEALTH_STATUSES.has(status)) {
      invalid('invalid_provider_health', 'health status must be unknown, healthy, or unhealthy')
    }
    if (errorCode != null && !/^[a-z][a-z0-9_]{0,127}$/.test(errorCode)) {
      invalid('invalid_provider_health', 'health errorCode must be a lowercase machine code')
    }
    const checked = new Date(checkedAt)
    if (Number.isNaN(checked.valueOf())) invalid('invalid_provider_health', 'health checkedAt must be a valid date')
    return safeSourceProvider(await this.store.updateSourceProviderHealth(
      normalizeProviderKey(providerKey),
      { status, errorCode, checkedAt: checked },
    ))
  }

  async resolveCredentials(providerKey) {
    const key = normalizeProviderKey(providerKey)
    const provider = await this.store.getSourceProviderSecret(key)
    if (!provider) throw new AppError(404, 'provider_not_found', `Unknown source provider: ${key}`)
    return {
      ...normalizePostgresProviderConfig(provider.config),
      password: decryptProviderPassword({
        providerKey: key,
        encryptedSecret: provider.encryptedSecret,
        masterKey: this.#masterKey.toString('base64'),
      }),
    }
  }
}
