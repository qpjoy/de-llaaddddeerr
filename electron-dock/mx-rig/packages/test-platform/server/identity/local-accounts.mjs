import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { AppError } from '../core/errors.mjs'
import { newToken, sha256 } from '../core/ids.mjs'

// Rig's own account system.
//
// Launcher federation stays optional; without it the service admin token used
// to be the only way in, which made "one person tries it" the only supported
// deployment. Local accounts make Rig usable on its own: an admin creates an
// account, the person signs in with a password Rig verifies, and the session is
// an opaque token Rig issued and can revoke. Nothing here talks to another
// system, and no password ever leaves this process.

const scrypt = promisify(scryptCallback)

export const LOCAL_PRINCIPAL_PREFIX = 'local:'
export const SESSION_TOKEN_PREFIX = 'rig_s1'
export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 200
export const MAX_FAILED_LOGINS = 5
export const LOCKOUT_MS = 5 * 60_000

const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9._-]{1,39}$/u
// scrypt at N=2^14 costs ~16 MiB and tens of milliseconds: slow enough to make
// an offline guess expensive, fast enough that a login never feels it.
const COST = Object.freeze({ N: 16_384, r: 8, p: 1 })
const KEY_LENGTH = 64
const MAX_MEMORY = 64 * 1024 * 1024

/** The canonical form of an account name, or null when it cannot be one. */
export function normalizeAccount(value) {
  if (typeof value !== 'string') return null
  const account = value.trim().toLowerCase()
  return ACCOUNT_PATTERN.test(account) ? account : null
}

export function requireAccount(value) {
  const account = normalizeAccount(value)
  if (!account) {
    throw new AppError(400, 'invalid_account', '账号只能用 2–40 位小写字母、数字、点、- 和 _，并以字母或数字开头')
  }
  if (account === 'admin') {
    throw new AppError(400, 'reserved_account', '账号 admin 保留给服务管理员')
  }
  return account
}

export function principalIdFor(account) {
  return `${LOCAL_PRINCIPAL_PREFIX}${account}`
}

export function isLocalPrincipal(principalId) {
  return typeof principalId === 'string' && principalId.startsWith(LOCAL_PRINCIPAL_PREFIX)
}

export function isSessionToken(token) {
  return typeof token === 'string' && token.startsWith(`${SESSION_TOKEN_PREFIX}_`)
}

export function requirePassword(value, label = '密码') {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw new AppError(400, 'weak_password', `${label}长度必须在 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符之间`)
  }
  if (new Set(value).size < 4) {
    throw new AppError(400, 'weak_password', `${label}至少要包含 4 个不同的字符`)
  }
  return value
}

/** A one-time password an admin hands over; the member is asked to change it. */
export function generatePassword() {
  return randomBytes(12).toString('base64url')
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_LENGTH, { ...COST, maxmem: MAX_MEMORY })
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export async function verifyPassword(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.split('$') : []
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string') return false
  const [N, r, p] = parts.slice(1, 4).map(Number)
  if (![N, r, p].every(Number.isSafeInteger)) return false
  const salt = Buffer.from(parts[4], 'base64url')
  const expected = Buffer.from(parts[5], 'base64url')
  if (expected.length !== KEY_LENGTH) return false
  const actual = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY })
  return timingSafeEqual(actual, expected)
}

// Verifying against a fixed hash when the account does not exist keeps the
// response time of "no such account" and "wrong password" the same, so the
// login form cannot be used to enumerate accounts.
let decoyHash = null
export async function burnVerification(password) {
  decoyHash ??= await hashPassword(randomBytes(16).toString('hex'))
  await verifyPassword(typeof password === 'string' ? password : '', decoyHash)
}

export function newSessionToken() {
  return newToken(SESSION_TOKEN_PREFIX)
}

export function sessionKey(token) {
  return sha256(token)
}

/** What a member listing shows about a local account; never the hash. */
export function publicLocalAccount(record) {
  if (!record) return null
  return {
    account: record.account,
    mustChangePassword: Boolean(record.mustChangePassword),
    disabled: Boolean(record.disabledAt),
    lockedUntil: record.lockedUntil ?? null,
    passwordChangedAt: record.passwordChangedAt ?? null,
    createdBy: record.createdBy ?? null,
  }
}
