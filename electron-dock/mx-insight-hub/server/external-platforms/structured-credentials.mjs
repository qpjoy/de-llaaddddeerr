import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { createExternalPlatformCredentialStore } from './credentials-store.mjs'

export const QIXIN_CREDENTIAL_FIELDS = [{ name: 'appkey', label: 'App Key' }, { name: 'secret_key', label: 'Secret Key' }]

// Atomic multi-field credentials use the same revision/re-auth boundary as
// single-key providers. Encrypt the JSON bundle with a purpose-separated key.
export class StructuredExternalPlatformCredentialStore {
  constructor({ pool = null, providerKey, fields, pepper, storage = null }) {
    if (typeof pepper !== 'string' || pepper.length < 16) throw new TypeError('Credential encryption requires the Hub key pepper')
    this.providerKey = providerKey
    this.fields = fields
    this.storage = storage ?? createExternalPlatformCredentialStore({ pool, providerKey })
    this.key = createHash('sha256').update(`mxih.provider-credentials.v1\0${providerKey}\0${pepper}`).digest()
  }
  async describeCredential(provider) {
    return { ...await this.storage.describeCredential(provider), fields: this.fields }
  }
  async updateCredential(provider, input, actor) {
    const values = input?.credentials
    if (!input || Object.keys(input).some(key => !['credentials', 'expectedRevision'].includes(key))
      || !values || typeof values !== 'object' || Array.isArray(values)
      || Object.keys(values).length !== this.fields.length
      || this.fields.some(({ name }) => typeof values[name] !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(values[name]))) {
      throw new AppError(400, 'invalid_external_platform_credential', 'Provide every credential field together, using 1–1024 non-space ASCII characters')
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(this.providerKey))
    const plaintext = JSON.stringify(Object.fromEntries(this.fields.map(({ name }) => [name, values[name]])))
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const apiKey = ['bundle1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
    await this.storage.updateCredential(provider, { apiKey, expectedRevision: input.expectedRevision }, actor)
    return this.describeCredential(provider)
  }
  decode(value) {
    if (!value) return null
    try {
      const [version, iv, tag, bytes] = value.split('.')
      if (version !== 'bundle1') throw new Error('version')
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      decipher.setAAD(Buffer.from(this.providerKey))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      const result = JSON.parse(Buffer.concat([decipher.update(Buffer.from(bytes, 'base64url')), decipher.final()]).toString())
      if (this.fields.some(({ name }) => typeof result[name] !== 'string' || !result[name])) throw new Error('shape')
      return result
    } catch { throw new AppError(503, 'external_platform_credential_store_unavailable', 'Credential bundle is unavailable') }
  }
  async readCredential(provider) { return this.decode(await this.storage.readCredential(provider)) }
  async readCredentialSnapshot(provider) {
    const snapshot = await this.storage.readCredentialSnapshot(provider)
    return { ...snapshot, apiKey: this.decode(snapshot.apiKey) }
  }
}
