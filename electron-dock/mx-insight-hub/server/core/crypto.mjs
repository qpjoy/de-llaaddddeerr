import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

export function hmacSecret(secret, pepper) {
  return createHmac('sha256', pepper).update(secret).digest('hex')
}

export function issueApiKey(pepper, environment = 'live') {
  const id = randomUUID()
  const random = randomBytes(32).toString('base64url')
  const plaintext = `mih_${environment}_${id.replaceAll('-', '').slice(0, 12)}_${random}`
  return {
    id,
    plaintext,
    digest: hmacSecret(plaintext, pepper),
    prefix: plaintext.slice(0, 25),
    lastFour: plaintext.slice(-4),
  }
}

export function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    )
  }
  return value
}

export function requestFingerprint({ method, path, body }) {
  return createHash('sha256')
    .update(JSON.stringify(normalize({ method, path, body })))
    .digest('hex')
}
