import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExternalPlatformCursorCodec } from '../../server/external-platforms/cursor.mjs'

const SECRET = 'cursor-encryption-test-secret-with-enough-entropy'
const CONSUMER_ID = 'consumer-a'

test('external-platform cursor encrypts provider pagination state and round-trips it', () => {
  const codec = createExternalPlatformCursorCodec(SECRET, CONSUMER_ID)
  const state = {
    marketplace: 'xiaohongshu_ec',
    page: 2,
    searchId: 'xhs-sensitive-search-id-123',
  }
  const first = codec.encode(state)
  const second = codec.encode(state)

  assert.match(first, /^mxec2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.notEqual(first, second, 'a fresh GCM nonce must produce a different cursor')
  assert.deepEqual(codec.decode(first), state)

  const decodedParts = first.split('.').slice(1).map((part) => (
    Buffer.from(part, 'base64url').toString('utf8')
  )).join('\n')
  assert.doesNotMatch(first, /xhs-sensitive-search-id/u)
  assert.doesNotMatch(decodedParts, /xhs-sensitive-search-id/u)
  assert.throws(
    () => JSON.parse(Buffer.from(first.split('.')[1], 'base64url').toString('utf8')),
  )
})

test('external-platform cursor is consumer-scoped and authenticated', () => {
  const owner = createExternalPlatformCursorCodec(SECRET, CONSUMER_ID)
  const otherConsumer = createExternalPlatformCursorCodec(SECRET, 'consumer-b')
  const cursor = owner.encode({ marketplace: 'jd', page: 3 })

  assert.throws(() => otherConsumer.decode(cursor), /^Error: invalid cursor$/)

  const parts = cursor.split('.')
  const ciphertext = parts[2]
  parts[2] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith('A') ? 'B' : 'A'}`
  assert.throws(() => owner.decode(parts.join('.')), /^Error: invalid cursor$/)
})

test('external-platform cursor rejects malformed and legacy plaintext tokens without details', () => {
  const codec = createExternalPlatformCursorCodec(SECRET, CONSUMER_ID)
  const plaintext = Buffer.from(JSON.stringify({ searchId: 'legacy-leak' })).toString('base64url')
  const invalid = [
    null,
    '',
    `mxec1.${plaintext}.signature`,
    'mxec2.invalid',
    `mxec2.${'a'.repeat(8_193)}`,
  ]

  for (const cursor of invalid) {
    assert.throws(() => codec.decode(cursor), /^Error: invalid cursor$/)
  }
})
