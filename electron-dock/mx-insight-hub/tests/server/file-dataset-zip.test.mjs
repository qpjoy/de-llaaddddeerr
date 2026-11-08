import assert from 'node:assert/strict'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openZipEntry, readZipDirectory } from '../../server/data/file-datasets/zip.mjs'
import { chooseEntry } from '../../server/data/file-datasets/source.mjs'
import { readLineWindows } from '../../server/data/file-datasets/lines.mjs'
import { buildZip } from '../fixtures/zip-writer.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { publicFailure } from '../../server/data/file-datasets/engine.mjs'

const lines = count => Array.from({ length: count }, (_, i) => `user${i}@example${i % 7}.com`).join('\n') + '\n'

async function withZip(t, buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'fdz-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'a.zip')
  await writeFile(path, buffer)
  const handle = await open(path)
  t.after(() => handle.close())
  return { handle, bytes: buffer.length }
}

async function readAll(reader, from = 0, window = 4096) {
  const parts = []
  for (let position = from; position < reader.bytes;) {
    const chunk = await reader.read(position, Math.min(window, reader.bytes - position))
    assert.ok(chunk.length > 0)
    parts.push(chunk)
    position += chunk.length
  }
  return Buffer.concat(parts)
}

for (const zip64 of [false, true]) {
  test(`reads stored and deflated entries in place${zip64 ? ' (ZIP64)' : ''}`, async t => {
    const email = Buffer.from(lines(20_000))
    const phone = Buffer.from('+14155550123\n+442079460958\n')
    const { handle, bytes } = await withZip(t, buildZip([
      { name: 'email_only.txt', data: email }, { name: 'phone_only.txt', data: phone, method: 0 }, { name: 'docs/', data: '' , method: 0 },
    ], { zip64 }))
    const entries = await readZipDirectory(handle, bytes)
    assert.deepEqual(entries.map(row => [row.name, row.methodName, row.size, row.supported]), [
      ['email_only.txt', 'deflate', email.length, true], ['phone_only.txt', 'stored', phone.length, true], ['docs/', 'stored', 0, false],
    ])
    assert.ok(entries[0].compressedSize < email.length)
    assert.deepEqual(await readAll(await openZipEntry(handle, entries[0])), email)
    assert.deepEqual(await readAll(await openZipEntry(handle, entries[1])), phone)
  })
}

test('a resume re-inflates from the entry start and continues at the checkpoint', async t => {
  const text = lines(5_000)
  const { handle, bytes } = await withZip(t, buildZip([{ name: 'email_only.txt', data: text }]))
  const [entry] = await readZipDirectory(handle, bytes)
  const reader = await openZipEntry(handle, entry)
  const first = []
  let checkpoint = 0
  for await (const window of readLineWindows({ read: reader.read, size: reader.bytes, chunkBytes: 1000 })) {
    for (const record of window.pairs) { first.push(record.text); checkpoint = record.endOffset }
    if (first.length > 2_000) break
  }
  // A fresh reader (worker restart) resumes from the saved byte offset.
  const resumed = await openZipEntry(handle, entry)
  const rest = []
  for await (const window of readLineWindows({ read: resumed.read, size: resumed.bytes, offset: checkpoint, state: 'after_pair', chunkBytes: 777 })) {
    for (const record of window.pairs) rest.push(record.text)
  }
  assert.deepEqual([...first, ...rest], text.trimEnd().split('\n'))
  // The same reader may also rewind.
  assert.equal((await reader.read(0, 6)).toString(), 'user0@')
})

test('corrupt, oversized, encrypted and unsupported entries fail with clear codes', async t => {
  const data = Buffer.from(lines(1_000))
  const { handle, bytes } = await withZip(t, buildZip([
    { name: 'bad-crc.txt', data, crc: 12345 },
    { name: 'too-big.txt', data, declaredSize: 100 },
    { name: 'secret.txt', data, encrypted: true },
    { name: 'deflate64.txt', data, declaredMethod: 9 },
  ]))
  const entries = await readZipDirectory(handle, bytes)
  await assert.rejects(readAll(await openZipEntry(handle, entries[0])), error => error.code === 'archive_entry_corrupt' && /CRC/.test(error.message))
  await assert.rejects(readAll(await openZipEntry(handle, entries[1]), 0, 50), error => error.code === 'archive_entry_corrupt' && /larger/.test(error.message))
  await assert.rejects(openZipEntry(handle, entries[2]), error => error.code === 'archive_entry_encrypted')
  await assert.rejects(openZipEntry(handle, entries[3]), error => error.code === 'archive_method_unsupported' && /Deflate64/.test(error.message))
  const notZip = await withZip(t, Buffer.from('just text, no archive'))
  await assert.rejects(readZipDirectory(notZip.handle, notZip.bytes), error => error.code === 'archive_invalid')
})

test('entry choice: requested name, then the dataset default, then the only candidate', () => {
  const entry = (name, extra = {}) => ({ name, method: 8, methodName: 'deflate', size: 10, compressedSize: 5, directory: false, encrypted: false, supported: true, ...extra })
  const both = [entry('email_only.txt'), entry('phone_only.txt'), entry('readme.md')]
  const options = { extensions: ['.txt'] }
  assert.equal(chooseEntry(both, { ...options, preferred: 'phone_only.txt' }).name, 'phone_only.txt')
  assert.equal(chooseEntry(both, { ...options, requested: 'email_only.txt' }).name, 'email_only.txt')
  assert.equal(chooseEntry([entry('only.txt'), entry('a.md')], options).name, 'only.txt')
  assert.throws(() => chooseEntry(both, options), error => error.status === 409 && error.code === 'archive_entry_required'
    && error.details.entries.map(row => row.name).join() === 'email_only.txt,phone_only.txt')
  assert.throws(() => chooseEntry(both, { ...options, requested: 'nope.txt' }), error => error.code === 'archive_entry_not_found')
  assert.throws(() => chooseEntry(both, { ...options, requested: 'readme.md' }), error => error.code === 'unsupported_file_type')
  assert.throws(() => chooseEntry([entry('x.txt', { method: 9, methodName: 'Deflate64', supported: false })], options), error => error.code === 'archive_method_unsupported')
})

test('a lost host reader during ZIP inflation is retryable and a changed source stays failed', async t => {
  const text = lines(250)
  const { handle, bytes } = await withZip(t, buildZip([{ name: 'phone.txt', data: text }]))
  const [entry] = await readZipDirectory(handle, bytes)
  for (const code of ['source_changed', 'server_file_host_unavailable']) {
    const failure = new AppError(code === 'source_changed' ? 409 : 503, code, 'fixture')
    let interrupt = false
    const reader = await openZipEntry({ read(...args) {
      if (interrupt) throw failure
      return handle.read(...args)
    } }, entry)
    interrupt = true
    await assert.rejects(reader.read(0, 64), error => error === failure)
    const classified = publicFailure(failure)
    assert.equal(classified.code, code)
    assert.equal(Boolean(classified.transient), code === 'server_file_host_unavailable')
    await reader.close()
  }
})
