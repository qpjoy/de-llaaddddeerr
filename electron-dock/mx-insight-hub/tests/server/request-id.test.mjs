import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'
import { requestUuid } from '../../src/request-id.js'

test('HTTP browsers without randomUUID receive unique RFC 4122 v4 request IDs', () => {
  const httpCrypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }
  const ids = Array.from({ length: 1000 }, () => requestUuid(httpCrypto))
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('secure contexts keep native UUID support; missing secure randomness fails explicitly', () => {
  assert.equal(requestUuid({ randomUUID: () => 'native-id' }), 'native-id')
  assert.throws(() => requestUuid({}), /安全请求 ID/)
})
