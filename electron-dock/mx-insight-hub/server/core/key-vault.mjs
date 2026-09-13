import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

// Separate encryption purpose from the existing authentication HMAC.
function vaultKey(pepper) {
  return Buffer.from(hkdfSync('sha256', pepper, 'mx-insight-hub', 'api-key-vault-v1', 32))
}
export function sealApiKey(secret, id, pepper) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', vaultKey(pepper), iv)
  cipher.setAAD(Buffer.from(id))
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), data.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}
export function openApiKey(envelope, id, pepper) {
  const [version, iv, data, tag] = envelope.split('.')
  if (version !== 'v1') throw new Error('Unsupported key vault version')
  const decipher = createDecipheriv('aes-256-gcm', vaultKey(pepper), Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(id))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}
