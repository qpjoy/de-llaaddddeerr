import assert from 'node:assert/strict'
import test from 'node:test'
import { readPairWindows, scanPairs, JsonPairsError } from '../../server/data/twitter-user-email/json-pairs.mjs'
import {
  FLAG_DOMAIN_CASE, FLAG_VALUE_TRIMMED, classifyPair, escapeLike, maskEmail, normalizeSearchRequest,
} from '../../server/data/twitter-user-email/contract.mjs'

const texts = result => result.pairs.map(pair => [pair.key.text, pair.value.nonString ? null : pair.value.text])

test('scans string pairs with whitespace and escapes', () => {
  const buf = Buffer.from(' {\n "Alice" : "alice@Example.com" ,"b\\"q":"x\\\\y@z.io","\\u00e9t\\u00e9":"\\ud83d\\ude00@e.com"}  ')
  const result = scanPairs(buf, 0, 'start', { final: true })
  assert.deepEqual(texts(result), [['Alice', 'alice@Example.com'], ['b"q', 'x\\y@z.io'], ['été', '😀@e.com']])
  assert.equal(result.state, 'end')
  assert.equal(result.boundary, buf.length)
})

test('reports text PostgreSQL cannot store instead of repairing it', () => {
  const nul = scanPairs(Buffer.from('{"a\\u0000":"x@y.z"}'), 0, 'start', { final: true }).pairs[0]
  assert.equal(nul.key.issue, 'nul_character')
  const rawNul = scanPairs(Buffer.concat([Buffer.from('{"a'), Buffer.from([0]), Buffer.from('":"x@y.z"}')]), 0, 'start', { final: true }).pairs[0]
  assert.equal(rawNul.key.issue, 'nul_character')
  const lone = scanPairs(Buffer.from('{"a":"\\ud800@y.z"}'), 0, 'start', { final: true }).pairs[0]
  assert.equal(lone.value.issue, 'invalid_text')
  const badUtf8 = scanPairs(Buffer.concat([Buffer.from('{"'), Buffer.from([0xc3, 0x28]), Buffer.from('":"x@y.z"}')]), 0, 'start', { final: true }).pairs[0]
  assert.equal(badUtf8.key.issue, 'invalid_text')
  const badEscape = scanPairs(Buffer.from('{"a":"\\q@y.z"}'), 0, 'start', { final: true }).pairs[0]
  assert.equal(badEscape.value.issue, 'invalid_text')
})

test('skips non-string values, including nested ones', () => {
  const result = scanPairs(Buffer.from('{"n":12,"z":null,"o":{"k":["}",1]},"s":"ok@a.b"}'), 0, 'start', { final: true })
  assert.deepEqual(result.pairs.map(pair => pair.value.nonString === true), [true, true, true, false])
  assert.equal(result.pairs[3].value.text, 'ok@a.b')
})

test('stops cleanly inside a token and resumes from the last pair boundary', () => {
  const buf = Buffer.from('{"a":"1@x.y","bb":"2@x')
  const first = scanPairs(buf, 0, 'start')
  assert.deepEqual(texts(first), [['a', '1@x.y']])
  assert.equal(first.state, 'after_pair')
  const rest = Buffer.concat([buf.subarray(first.boundary), Buffer.from('.y"}')])
  const second = scanPairs(rest, 0, first.state, { final: true })
  assert.deepEqual(texts(second), [['bb', '2@x.y']])
  assert.equal(second.state, 'end')
})

test('rejects malformed structure with a byte offset', () => {
  assert.throws(() => scanPairs(Buffer.from('["a"]'), 0, 'start', { final: true }), error => error instanceof JsonPairsError && error.code === 'not_an_object')
  assert.throws(() => scanPairs(Buffer.from('{"a":"b" "c":"d"}'), 0, 'start', { final: true }), error => error.code === 'expected_comma' && error.offset === 9)
  assert.throws(() => scanPairs(Buffer.from('{"a":"b"} x'), 0, 'start', { final: true }), error => error.code === 'trailing_data')
  assert.deepEqual(texts(scanPairs(Buffer.from('{ }'), 0, 'start', { final: true })), [])
})

async function collect(source, { chunkBytes, offset = 0, state = 'start' }) {
  const out = []
  for await (const window of readPairWindows({
    read: async (position, length) => source.subarray(position, position + length),
    size: source.length, offset, state, chunkBytes,
  })) {
    for (const pair of window.pairs) out.push({ key: pair.key.text, value: pair.value.text, endOffset: pair.endOffset })
  }
  return out
}

test('chunked windows yield the same pairs and absolute resume offsets', async () => {
  const entries = Array.from({ length: 200 }, (_, i) => [`user_${i}_é`, `mail${i}@Domain${i % 7}.com`])
  const source = Buffer.from(JSON.stringify(Object.fromEntries(entries), null, 1))
  const whole = await collect(source, { chunkBytes: source.length + 1 })
  for (const chunkBytes of [1, 3, 7, 64]) assert.deepEqual(await collect(source, { chunkBytes }), whole)
  assert.deepEqual(whole.map(row => [row.key, row.value]), entries)
  const resumeAt = whole[119].endOffset
  const resumed = await collect(source, { chunkBytes: 5, offset: resumeAt, state: 'after_pair' })
  assert.deepEqual(resumed.map(row => row.key), entries.slice(120).map(([key]) => key))
})

test('a truncated file is an error, not a silent stop', async () => {
  const source = Buffer.from('{"a":"1@x.y","b":"2@x.y"')
  await assert.rejects(collect(source, { chunkBytes: 4 }), error => error.code === 'truncated')
})

test('classifies pairs: last @, lower-case domain, quarantine reasons', () => {
  const ok = (text, issue = null) => ({ text, issue })
  assert.deepEqual(classifyPair(ok('Bob'), ok('b.ob+tag@GMail.com')), { username: 'Bob', local: 'b.ob+tag', domain: 'gmail.com', flags: FLAG_DOMAIN_CASE })
  assert.deepEqual(classifyPair(ok('q'), ok(' "a@b"@x.io ')), { username: 'q', local: '"a@b"', domain: 'x.io', flags: FLAG_VALUE_TRIMMED })
  assert.equal(classifyPair(ok('a'), ok('no-at-sign')).reason, 'missing_at')
  assert.equal(classifyPair(ok(' '), ok('a@b.c')).reason, 'empty_username')
  assert.equal(classifyPair(ok('a'), ok('@b.c')).reason, 'empty_local')
  assert.equal(classifyPair(ok('a'), ok('a@')).reason, 'empty_domain')
  assert.equal(classifyPair(ok('a'), ok('a@b c.d')).reason, 'invalid_domain')
  assert.equal(classifyPair(ok('a'), { nonString: true }).reason, 'non_string_value')
  assert.equal(classifyPair(ok(null, 'nul_character'), ok('a@b.c')).reason, 'nul_character')
  assert.equal(classifyPair(ok('x'.repeat(257)), ok('a@b.c')).reason, 'username_too_long')
})

test('masks the e-mail local part and escapes LIKE patterns', () => {
  assert.equal(maskEmail('alice', 'gmail.com'), 'al***@gmail.com')
  assert.equal(maskEmail('al', 'x.io'), 'a***@x.io')
  assert.equal(maskEmail('😀😀😀😀', 'x.io'), '😀😀***@x.io')
  assert.equal(escapeLike('a_b%c\\d'), 'a\\_b\\%c\\\\d')
})

test('normalizes search requests and enforces minimum lengths', () => {
  assert.deepEqual(normalizeSearchRequest({ query: ' Bob ' }), { mode: 'username', field: null, query: 'Bob', domain: null, limit: 20, reveal: false })
  const email = normalizeSearchRequest({ mode: 'email', query: 'Bob.Smith@GMAIL.com', limit: 5, reveal: true })
  assert.equal(email.local, 'Bob.Smith')
  assert.equal(email.domain, 'gmail.com')
  assert.equal(email.reveal, true)
  assert.equal(normalizeSearchRequest({ mode: 'prefix', query: 'bob', field: 'email_local', domain: '@Gmail.com' }).domain, 'gmail.com')
  const rejects = [
    {}, { query: '' }, { query: 'a', mode: 'regex' }, { query: 'ab', mode: 'prefix' }, { query: 'abc', mode: 'contains' },
    { query: 'abc', mode: 'fuzzy' }, { query: 'a'.repeat(65), mode: 'fuzzy' }, { query: 'nobody', mode: 'email' },
    { query: 'a@b.c', mode: 'email', domain: 'x.io' }, { query: 'bob', limit: 0 }, { query: 'bob', limit: 51 },
    { query: 'bob', field: 'email_local' }, { query: 'bob', reveal: 'yes' }, { query: 'bob', domain: 'a b' },
  ]
  for (const body of rejects) assert.throws(() => normalizeSearchRequest(body), error => error.status === 400, JSON.stringify(body))
  assert.throws(() => normalizeSearchRequest({ query: 'bob', sql: 'x' }), error => error.code === 'unsupported_fields')
})
