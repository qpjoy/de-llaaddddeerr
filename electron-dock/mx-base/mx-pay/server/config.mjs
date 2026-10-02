import { readFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { PaymentError } from '../src/index.mjs'

const digest = value => createHash('sha256').update(value).digest()
const positive = (value, fallback, maximum) => {
  const n = Number(value ?? fallback)
  if (!Number.isInteger(n) || n < 1 || n > maximum) throw new Error('Invalid mx-pay numeric configuration')
  return n
}
export function readCredentials(filename) {
  const entries = JSON.parse(readFileSync(filename, 'utf8'))
  const ids = new Set(), secrets = new Set()
  if (!Array.isArray(entries) || !entries.length) throw new Error('MX_PAY_CREDENTIALS_FILE must contain credentials')
  return entries.map(entry => {
    if (!entry || !/^[a-zA-Z0-9._-]{1,80}$/.test(entry.id) || !/^[a-zA-Z0-9._-]{1,80}$/.test(entry.appId)
      || !['test','live'].includes(entry.environment) || typeof entry.secret !== 'string' || entry.secret.length < 32
      || !Array.isArray(entry.scopes) || !entry.scopes.length
      || entry.scopes.some(scope => !['orders.read','orders.write','receipts.confirm','settings.write','events.read','events.ack'].includes(scope))
      || ids.has(entry.id) || secrets.has(entry.secret)) throw new Error('Invalid or duplicate mx-pay credential')
    ids.add(entry.id); secrets.add(entry.secret)
    return { id: entry.id, appId: entry.appId, environment: entry.environment, scopes: entry.scopes, hash: digest(entry.secret) }
  })
}
export function authenticate(header, credentials) {
  const token = typeof header === 'string' && /^Bearer ([^\s]+)$/.exec(header)?.[1]
  if (!token || token.length > 4096) throw new PaymentError(401, 'payment_auth_required', 'Payment service credential required')
  const hash = digest(token)
  let principal
  for (const credential of credentials) if (timingSafeEqual(hash, credential.hash)) principal = credential
  if (!principal) throw new PaymentError(401, 'payment_auth_required', 'Invalid payment service credential')
  return principal
}
export function authorize(principal, scope) {
  if (!principal.scopes.includes(scope)) throw new PaymentError(403, 'payment_scope_required', 'Payment credential has insufficient scope')
}
export function loadConfig(env = process.env) {
  if (!env.MX_PAY_DATABASE_URL) throw new Error('MX_PAY_DATABASE_URL is required (dedicated payment database)')
  if (!env.MX_PAY_CREDENTIALS_FILE) throw new Error('MX_PAY_CREDENTIALS_FILE is required')
  return {
    databaseUrl: env.MX_PAY_DATABASE_URL,
    credentialsFile: env.MX_PAY_CREDENTIALS_FILE,
    host: env.MX_PAY_HOST || '0.0.0.0', port: positive(env.MX_PAY_PORT, 18230, 65535),
    maxConnections: positive(env.MX_PAY_DB_POOL_SIZE, 10, 100),
    drainMs: positive(env.MX_PAY_DRAIN_MS, 3000, 15000),
  }
}
