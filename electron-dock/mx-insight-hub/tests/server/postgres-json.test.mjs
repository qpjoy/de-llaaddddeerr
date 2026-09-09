import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isPostgresSafeJsonValue,
  isPostgresSafeText,
} from '../../server/core/postgres-json.mjs'

function nestedObjects(depth) {
  let value = 'leaf'
  for (let index = 0; index < depth; index += 1) value = { nested: value }
  return value
}

test('PostgreSQL-safe text rejects U+0000 and lone surrogates without rejecting valid pairs', () => {
  assert.equal(isPostgresSafeText('正文 😀'), true)
  assert.equal(isPostgresSafeText('before\0after'), false)
  assert.equal(isPostgresSafeText('\uD800'), false)
  assert.equal(isPostgresSafeText('\uDC00'), false)
  assert.equal(isPostgresSafeText('\uD83D\uDE00'), true)

  assert.equal(isPostgresSafeJsonValue({ safe: '正文 😀' }), true)
  assert.equal(isPostgresSafeJsonValue({ ['bad\0key']: 'value' }), false)
  assert.equal(isPostgresSafeJsonValue({ value: '\uD800' }), false)
})

test('PostgreSQL-safe JSON rejects numbers that JSON serialization rewrites', () => {
  assert.equal(JSON.parse('1e400'), Number.POSITIVE_INFINITY)
  assert.equal(isPostgresSafeJsonValue(JSON.parse('1e400')), false)
  assert.equal(isPostgresSafeJsonValue(Number.NEGATIVE_INFINITY), false)
  assert.equal(isPostgresSafeJsonValue(Number.NaN), false)
  assert.equal(isPostgresSafeJsonValue(JSON.parse('-0')), false)

  assert.equal(isPostgresSafeJsonValue(0), true)
  assert.equal(isPostgresSafeJsonValue(Number.MAX_VALUE), true)
  assert.equal(isPostgresSafeJsonValue(Number.MIN_VALUE), true)
})

test('PostgreSQL-safe JSON checks deep structures without recursive traversal', () => {
  const pathological = nestedObjects(12_000)

  assert.doesNotThrow(() => isPostgresSafeJsonValue(pathological))
  assert.equal(isPostgresSafeJsonValue(pathological), true)
})

test('PostgreSQL-safe JSON accepts only lossless JSON containers', () => {
  const sparse = []
  sparse.length = 1
  const namedArray = ['item']
  namedArray.extra = 'not serialized'
  const cycle = {}
  cycle.self = cycle
  const accessor = {}
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'computed' })
  const serializationHook = { value: 'original' }
  Object.defineProperty(serializationHook, 'toJSON', {
    value: () => ({ value: 'rewritten' }),
  })
  const arraySerializationHook = ['original']
  Object.defineProperty(arraySerializationHook, 'toJSON', {
    value: () => ['rewritten'],
  })

  assert.equal(isPostgresSafeJsonValue({ nested: [1, 'two', null, true] }), true)
  assert.equal(isPostgresSafeJsonValue({ toJSON: 'provider field', value: 1 }), true)
  assert.equal(isPostgresSafeJsonValue(Object.assign(Object.create(null), { value: 1 })), true)
  assert.equal(isPostgresSafeJsonValue(sparse), false)
  assert.equal(isPostgresSafeJsonValue(namedArray), false)
  assert.equal(isPostgresSafeJsonValue(cycle), false)
  assert.equal(isPostgresSafeJsonValue(accessor), false)
  assert.equal(isPostgresSafeJsonValue(serializationHook), false)
  assert.equal(isPostgresSafeJsonValue(arraySerializationHook), false)
  assert.equal(isPostgresSafeJsonValue(new Date()), false)
  assert.equal(isPostgresSafeJsonValue(1n), false)
  assert.equal(isPostgresSafeJsonValue(undefined), false)
})
