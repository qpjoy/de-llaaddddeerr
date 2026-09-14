import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

// Time-prefixed ids so a plain `ORDER BY id` in ad-hoc SQL is roughly
// chronological, which is what you want when eyeballing a run list in psql.
export function newId(prefix) {
  const stamp = Date.now().toString(36).padStart(9, '0')
  return `${prefix}_${stamp}${randomBytes(8).toString('hex')}`
}

export function newToken(prefix) {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

// Compare secrets without leaking length or position through timing. Hashing
// first makes both sides fixed-length, so the comparison itself is safe even
// when the inputs differ in length.
export function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}
