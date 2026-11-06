import assert from 'node:assert/strict'
import test from 'node:test'
import { readLineWindows, LineRecordsError } from '../../server/data/file-datasets/lines.mjs'
import { datasetLock } from '../../server/data/file-datasets/store.mjs'
import { FILE_DATASET_DEFINITIONS } from '../../server/data/file-datasets/registry.mjs'
import { FILE_DATASETS, FILE_DATASET_SCOPES, fileDataset } from '../../shared/file-datasets.mjs'
import { isExplicitOnlyKeyScope } from '../../shared/access-limits.mjs'
import { classifyEmailLine, normalizeEmailSearchRequest, encodeCursor } from '../../server/data/email-directory/contract.mjs'
import { classifyPhoneLine, maskPhone, normalizePhoneSearchRequest, queryDigits } from '../../server/data/phone-directory/contract.mjs'

async function collect(text, { chunkBytes = 7, offset = 0, state = 'start' } = {}) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text)
  const records = []
  const windows = []
  for await (const window of readLineWindows({
    read: async (position, length) => buf.subarray(position, position + length), size: buf.length, offset, state, chunkBytes,
  })) {
    windows.push(window.state)
    for (const record of window.pairs) records.push({ text: record.text, issue: record.issue, end: record.endOffset, raw: window.buf.subarray(record.start, record.stop).toString('latin1') })
  }
  return { records, windows }
}

test('line reader splits across tiny windows, strips CR and BOM and keeps a last line without newline', async () => {
  const { records, windows } = await collect('﻿a@x.io\r\nbb@y.io\n\nccc@z.io')
  assert.deepEqual(records.map(row => row.text), ['a@x.io', 'bb@y.io', '', 'ccc@z.io'])
  assert.equal(windows.at(-1), 'end')
  // Offsets are absolute byte positions after each line (resume points).
  assert.deepEqual(records.map(row => row.end), [11, 19, 20, 28])
})

test('line reader resumes from a saved offset with identical records', async () => {
  const text = 'one@a.io\ntwo@b.io\nthree@c.io\n'
  const all = await collect(text, { chunkBytes: 5 })
  const resumed = await collect(text, { chunkBytes: 5, offset: all.records[0].end, state: 'after_pair' })
  assert.deepEqual(resumed.records.map(row => row.text), ['two@b.io', 'three@c.io'])
  assert.deepEqual(await collect(text, { offset: text.length, state: 'end' }), { records: [], windows: [] })
})

test('line reader reports text PostgreSQL cannot store instead of repairing it', async () => {
  const bytes = Buffer.concat([Buffer.from('ok@a.io\n'), Buffer.from([0x62, 0xff, 0x40, 0x61, 0x0a]), Buffer.from('n\u0000l@a.io\n')])
  const { records } = await collect(bytes, { chunkBytes: 64 })
  assert.deepEqual(records.map(row => row.issue), [null, 'invalid_text', 'nul_character'])
  assert.equal(records[1].raw, 'b\xff@a')
  await assert.rejects(collect('x'.repeat(70 * 1024), { chunkBytes: 1024 }), error => error instanceof LineRecordsError && error.code === 'line_too_long')
})

test('e-mail lines split at the last @, lower-case the domain and quarantine junk', () => {
  assert.deepEqual(classifyEmailLine({ text: ' John.Smith@GMail.com ' }), { local: 'John.Smith', domain: 'gmail.com', flags: 3 })
  assert.deepEqual(classifyEmailLine({ text: '"a@b"@example.org' }), { local: '"a@b"', domain: 'example.org', flags: 0 })
  const reasons = ['', 'no-at-sign', '@x.io', 'name@', 'na me@x.io', 'name@ex ample.com', `${'a'.repeat(320)}@x.io`].map(text => classifyEmailLine({ text }).reason)
  assert.deepEqual(reasons, ['empty_line', 'missing_at', 'empty_local', 'empty_domain', 'invalid_local', 'invalid_domain', 'email_too_long'])
  assert.equal(classifyEmailLine({ text: null, issue: 'invalid_text' }).reason, 'invalid_text')
})

test('phone lines become E.164 digits; wrong length and zero country codes are quarantined', () => {
  assert.deepEqual(classifyPhoneLine({ text: '+14155550123' }), { digits: '14155550123', flags: 0 })
  assert.deepEqual(classifyPhoneLine({ text: '+1 (415) 555-0123' }), { digits: '14155550123', flags: 2 })
  assert.deepEqual(classifyPhoneLine({ text: '8613800138000' }), { digits: '8613800138000', flags: 1 })
  const reasons = ['+0', '+000', '+00020877653002349889', '+0123456789', '+1-800-FLOWERS', ''].map(text => classifyPhoneLine({ text }).reason)
  assert.deepEqual(reasons, ['phone_length', 'phone_length', 'phone_length', 'invalid_country_code', 'invalid_phone', 'empty_line'])
  assert.equal(maskPhone('14155550123'), '+141******23')
  assert.equal(queryDigits(' +44 20 7946 0958 '), '442079460958')
  assert.equal(queryDigits('12a4'), null)
})

test('e-mail search requests are validated without echoing the query', () => {
  assert.deepEqual(normalizeEmailSearchRequest({ query: 'Name@Example.COM' }), {
    mode: 'email', query: 'Name@Example.COM', domain: 'example.com', limit: 20, after: null, reveal: true, local: 'Name',
  })
  const domain = normalizeEmailSearchRequest({ mode: 'domain', query: '@Example.com', limit: 50 })
  assert.equal(domain.domain, 'example.com')
  const cursor = encodeCursor({ local_key: 'john', first_ordinal: '42' })
  assert.deepEqual(normalizeEmailSearchRequest({ mode: 'domain', query: 'example.com', after: cursor }).after, { localKey: 'john', ordinal: '42' })
  assert.equal(normalizeEmailSearchRequest({ mode: 'prefix', query: 'joh', domain: 'Gmail.com' }).domain, 'gmail.com')
  const rejects = [
    { mode: 'prefix', query: 'jo' }, { mode: 'contains', query: 'abc' }, { mode: 'fuzzy', query: 'x'.repeat(65) },
    { mode: 'prefix', query: 'john@gm' }, { mode: 'email', query: 'nobody' }, { mode: 'email', query: 'a@b.c', domain: 'x.io' },
    { mode: 'prefix', query: 'john', after: cursor }, { mode: 'domain', query: 'x.io', after: 'not-a-cursor' }, { query: 'a@b.c', limit: 51 },
  ]
  for (const body of rejects) assert.throws(() => normalizeEmailSearchRequest(body), error => error.status === 400 && !error.message.includes(body.query), JSON.stringify(body))
  assert.throws(() => normalizeEmailSearchRequest({ query: 'a@b.c', sql: 'x' }), error => error.code === 'unsupported_fields')
})

test('phone search requests accept formatted numbers and digit cursors only', () => {
  assert.deepEqual(normalizePhoneSearchRequest({ query: '+1 (415) 555-0123' }), { mode: 'exact', query: '14155550123', limit: 20, after: null, reveal: true })
  assert.equal(normalizePhoneSearchRequest({ mode: 'suffix', query: '0123', after: '3210555' }).after, '3210555')
  const rejects = [
    { query: '12345' }, { mode: 'prefix', query: '+1 4' }, { mode: 'suffix', query: '123' }, { mode: 'exact', query: '1415', after: '1' },
    { mode: 'prefix', query: '1415', after: 'abc' }, { query: 'call me' }, { query: '1'.repeat(16) }, { mode: 'contains', query: '1415' },
  ]
  for (const body of rejects) assert.throws(() => normalizePhoneSearchRequest(body), error => error.status === 400, JSON.stringify(body))
})

test('every shared file dataset has a storage kind, a lock key and explicit-only scopes', () => {
  assert.deepEqual(FILE_DATASET_DEFINITIONS.map(row => row.key), FILE_DATASETS.map(row => row.key))
  const locks = new Set(FILE_DATASETS.map(row => datasetLock(row.key).join(':')))
  assert.equal(locks.size, FILE_DATASETS.length)
  assert.deepEqual(datasetLock('email-directory'), datasetLock('email-directory'))
  for (const scope of FILE_DATASET_SCOPES) assert.equal(isExplicitOnlyKeyScope(scope), true, scope)
  for (const { product, kind } of FILE_DATASET_DEFINITIONS) {
    assert.deepEqual(kind.extensions, product.sourceExtensions)
    assert.equal(kind.leafColumns[0][0], 'first_ordinal')
    assert.ok(kind.indexes.length >= 2 && kind.acceptance.lookups.length >= 2)
    assert.equal(product.searchPath, `/api/v1/data/${product.key}/search`)
  }
  // The published Twitter v1 layout must not drift.
  const twitter = FILE_DATASET_DEFINITIONS.find(row => row.key === 'twitter-user-email').kind
  assert.deepEqual(twitter.leafColumns.map(([name]) => name), ['first_ordinal', 'domain_id', 'dup_count', 'flags', 'username', 'email_local'])
  assert.equal(twitter.partitionKey, 'lower(username)')
  assert.equal(fileDataset('phone-directory').platform, 'phone_directory')
})
