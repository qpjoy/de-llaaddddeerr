import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from './errors.mjs'
const PREFIX = 'mih_demo_'
const TTL = 60 * 60 * 1000
function signature(payload, pepper) {
  return createHmac('sha256', pepper).update(`hub-data-product-demo-v1:${payload}`).digest()
}
export function issueDemoCredential(keyId, pepper, now = Date.now()) {
  const expiresAt = now + TTL
  const payload = Buffer.from(JSON.stringify({ keyId, expiresAt })).toString('base64url')
  return { secret: `${PREFIX}${payload}.${signature(payload, pepper).toString('base64url')}`, expiresAt }
}
export function readDemoCredential(secret, pepper, now = Date.now()) {
  if (!secret.startsWith(PREFIX)) return null
  try {
    if (secret.length > 1024) throw new Error()
    const parts = secret.slice(PREFIX.length).split('.')
    if (parts.length !== 2) throw new Error()
    const expected = signature(parts[0], pepper)
    const actual = Buffer.from(parts[1], 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
    const { keyId, expiresAt } = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    if (!/^[0-9a-f-]{36}$/i.test(keyId) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= now || expiresAt > now + TTL) throw new Error()
    return keyId
  } catch { throw new AppError(401, 'demo_credential_expired_or_invalid', 'Demo credential expired or invalid; refresh the demo identity') }
}
