import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from './errors.mjs'
const PREFIX = 'mih_demo_'
// Older Public listeners reject member-bound tickets rather than ignoring membership.
const TENANT_PREFIX = 'mih_tenant_demo_'
const TTL = 60 * 60 * 1000
function signature(payload, pepper, prefix = PREFIX) {
  const domain = prefix === TENANT_PREFIX ? 'hub-tenant-product-demo-v1' : 'hub-data-product-demo-v1'
  return createHmac('sha256', pepper).update(`${domain}:${payload}`).digest()
}
export function issueDemoCredential(keyId, pepper, now = Date.now(), memberId = null) {
  const prefix = memberId ? TENANT_PREFIX : PREFIX
  const expiresAt = now + TTL
  const payload = Buffer.from(JSON.stringify({ keyId, expiresAt, ...(memberId ? { memberId } : {}) })).toString('base64url')
  return { secret: `${prefix}${payload}.${signature(payload, pepper, prefix).toString('base64url')}`, expiresAt }
}
export function readDemoCredentialClaims(secret, pepper, now = Date.now()) {
  const prefix = secret.startsWith(TENANT_PREFIX) ? TENANT_PREFIX : secret.startsWith(PREFIX) ? PREFIX : null
  if (!prefix) return null
  try {
    if (secret.length > 1024) throw new Error()
    const parts = secret.slice(prefix.length).split('.')
    if (parts.length !== 2) throw new Error()
    const expected = signature(parts[0], pepper, prefix)
    const actual = Buffer.from(parts[1], 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
    const { keyId, expiresAt, memberId } = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    if (!/^[0-9a-f-]{36}$/i.test(keyId) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= now || expiresAt > now + TTL) throw new Error()
    if (prefix === TENANT_PREFIX && !/^[0-9a-f-]{36}$/i.test(memberId || '')) throw new Error()
    if (prefix === PREFIX && memberId != null) throw new Error()
    return { keyId, expiresAt, memberId: memberId || null }
  } catch { throw new AppError(401, 'demo_credential_expired_or_invalid', 'Demo credential expired or invalid; refresh the demo identity') }
}

export function readDemoCredential(secret, pepper, now = Date.now()) {
  return readDemoCredentialClaims(secret, pepper, now)?.keyId || null
}
