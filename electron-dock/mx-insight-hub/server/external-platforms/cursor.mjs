import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_CURSOR_LENGTH = 8_192
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

function decodePart(value, expectedBytes = null) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw new Error('invalid cursor')
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value
    || (expectedBytes != null && decoded.length !== expectedBytes)) {
    throw new Error('invalid cursor')
  }
  return decoded
}

function createScopedCursorCodec(secret, consumerId, { prefix, aadLabel, keyLabel }) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('cursor secret is required')
  if (typeof consumerId !== 'string' || !consumerId) throw new TypeError('consumerId is required')
  const aad = Buffer.from(`${prefix}\u0000${aadLabel}`, 'utf8')
  const scopedKey = createHmac('sha256', secret)
    .update(`${keyLabel}\u0000${consumerId}`)
    .digest()

  return {
    encode(state) {
      const plaintext = Buffer.from(JSON.stringify(state), 'utf8')
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, scopedKey, iv)
      cipher.setAAD(aad)
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      const cursor = `${prefix}.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`
      if (cursor.length > MAX_CURSOR_LENGTH) throw new Error('invalid cursor')
      return cursor
    },
    decode(value) {
      try {
        if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH) {
          throw new Error('invalid cursor')
        }
        const [encodedPrefix, encodedIv, encodedCiphertext, encodedTag, extra] = value.split('.')
        if (encodedPrefix !== prefix || extra !== undefined) throw new Error('invalid cursor')
        const iv = decodePart(encodedIv, IV_BYTES)
        const ciphertext = decodePart(encodedCiphertext)
        const tag = decodePart(encodedTag, TAG_BYTES)
        const decipher = createDecipheriv(ALGORITHM, scopedKey, iv)
        decipher.setAAD(aad)
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        const decoded = JSON.parse(plaintext.toString('utf8'))
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('invalid cursor')
        }
        return decoded
      } catch {
        throw new Error('invalid cursor')
      }
    },
  }
}

export function createExternalPlatformCursorCodec(secret, consumerId) {
  // Derive a consumer-scoped encryption key. Besides rejecting cross-consumer
  // reuse, authenticated encryption keeps provider pagination state such as a
  // searchId opaque to the public caller. These labels preserve the existing
  // mxec2 wire contract for already-issued direct cursors.
  return createScopedCursorCodec(secret, consumerId, {
    prefix: 'mxec2',
    aadLabel: 'external-platform-cursor',
    keyLabel: 'external-platform-cursor-aes-gcm',
  })
}

export function createNightAllCompatibilityCursorCodec(secret, consumerId) {
  return createScopedCursorCodec(secret, consumerId, {
    prefix: 'mxnc1',
    aadLabel: 'night-all-compatibility-cursor',
    keyLabel: 'night-all-compatibility-cursor-aes-gcm',
  })
}
