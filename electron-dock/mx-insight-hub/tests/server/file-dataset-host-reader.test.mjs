import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ServerFileReader } from '../../server/ingest/external/server-files.mjs'
import { createFileDatasetReader, HOST_FILE_ROOT_ID } from '../../server/data/file-datasets/host-reader.mjs'
import { inspectSource, openVersionSource } from '../../server/data/file-datasets/source.mjs'
import { buildZip } from '../fixtures/zip-writer.mjs'

const hostPath = '/operator/media/sources/list.zip'
const locator = { rootId: HOST_FILE_ROOT_ID, relativePath: `${'3f'.repeat(16)}/list.zip` }
const snapshot = { identity: '2:42', mtimeNs: '1000000', mtime: '1970-01-01T00:00:00.001Z' }
const maxRange = 4 * 1024 * 1024

async function directory(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function socketReader(t, reply, configuredReader) {
  const dir = await directory(t)
  const socket = join(dir, 'reader.sock')
  const calls = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    calls.push({ path: request.url, body })
    const [status, payload] = reply(request.url, body)
    response.writeHead(status, { 'content-type': Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json' })
    response.end(Buffer.isBuffer(payload) ? payload : JSON.stringify(payload))
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const local = configuredReader || await ServerFileReader.create()
  return { reader: createFileDatasetReader(local, socket), calls }
}

function serve(bytes) {
  return (path, body) => {
    if (path === '/resolve') return [200, { ...locator, absolutePath: hostPath }]
    if (path === '/open') return [200, { ...locator, ...snapshot, bytes: bytes.length, filename: 'list.zip', privatePath: hostPath }]
    return [200, bytes.subarray(body.position, body.position + body.length)]
  }
}

test('host file access is opt-in, preserves mounted sources and sanitizes socket failures', async t => {
  const dir = await directory(t)
  const local = await ServerFileReader.create({ roots: [{ rootId: 'internal', path: dir }] })
  assert.equal(createFileDatasetReader(local, ''), local)
  assert.equal(createFileDatasetReader(null, join(dir, 'inactive.sock')), null)
  const reader = createFileDatasetReader(local, join(dir, 'inactive.sock'))
  assert.deepEqual(reader.describeRoots(), { ...local.describeRoots(), hostPaths: true })
  const file = join(dir, 'source.txt')
  await writeFile(file, 'example')
  const selected = await reader.locatorForPath(file)
  assert.deepEqual(selected, { rootId: 'internal', relativePath: 'source.txt' })
  assert.equal((await reader.inspectLargeLocator(selected, { extensions: ['.txt'] })).bytes, 7)
  await assert.rejects(reader.locatorForPath(join(dir, 'file*.txt')), { code: 'invalid_server_file_path' })
  await assert.rejects(reader.openLargeLocator({ rootId: 'wrong', relativePath: 'source.txt' }, { extensions: ['.txt'] }), { code: 'server_file_path_not_allowed' })
  await assert.rejects(reader.locatorForPath(hostPath), error => error.code === 'server_file_host_unavailable' && error.status === 503
    && !error.message.includes(dir) && !error.message.includes(hostPath) && !error.cause)
})

test('ZIP inspection and worker streaming use opaque references and pin every range to the same file', async t => {
  const entry = Buffer.from('+12345678901\n')
  const zip = buildZip([{ name: 'phone_only.txt', data: entry }])
  const { reader, calls } = await socketReader(t, serve(zip))
  assert.deepEqual(reader.describeRoots().roots, [])
  assert.equal(reader.describeRoots().hostPaths, true)
  assert.deepEqual(await reader.locatorForPath(hostPath), locator)
  const inspection = await inspectSource(reader, locator, { extensions: ['.txt'], entry: 'phone_only.txt' })
  assert.equal(inspection.entry.name, 'phone_only.txt')
  assert.equal(inspection.file.identity, snapshot.identity)
  assert.ok(!JSON.stringify(inspection.file).includes(hostPath))
  const opened = await openVersionSource(reader, { source_root_id: locator.rootId, source_relative_path: locator.relativePath,
    source_entry: 'phone_only.txt', source_entry_bytes: entry.length }, { extensions: ['.txt'] })
  try { assert.deepEqual(await opened.content.read(0, entry.length), entry) }
  finally { opened.content.close(); await opened.fileHandle.close() }
  assert.deepEqual(calls[0], { path: '/resolve', body: { path: hostPath } })
  const reads = calls.filter(call => call.path === '/read')
  assert.ok(reads.length)
  for (const { body } of reads) {
    assert.deepEqual(body, { relativePath: locator.relativePath, bytes: zip.length, identity: snapshot.identity,
      mtimeNs: snapshot.mtimeNs, position: body.position, length: body.length })
  }
  assert.ok(!JSON.stringify(calls.slice(1)).includes(hostPath))
})

test('pasting an unmounted sibling uses the host, saved mounted locators retain local failures', async t => {
  const root = await directory(t)
  const local = await ServerFileReader.create({ roots: [{ rootId: 'internal', path: root }] })
  const { reader, calls } = await socketReader(t, serve(Buffer.from('zip')), local)
  const sibling = join(root, 'list.zip')
  assert.deepEqual(await reader.locatorForPath(sibling), locator)
  assert.deepEqual(calls, [{ path: '/resolve', body: { path: sibling } }])
  await assert.rejects(reader.inspectLargeLocator({ rootId: 'internal', relativePath: 'list.zip' }, { extensions: ['.zip'] }),
    { code: 'server_file_not_found' })
  await writeFile(sibling, '')
  await assert.rejects(reader.locatorForPath(sibling), { code: 'server_file_empty' })
  assert.equal(calls.length, 1)
})

test('positioned reads respect destination offsets, maximum ranges, EOF and close', async t => {
  const source = Buffer.alloc(maxRange + 3, 0xa5)
  const { reader, calls } = await socketReader(t, serve(source))
  const { fileHandle } = await reader.openLargeLocator(locator, { extensions: ['.zip'] })
  const dest = Buffer.alloc(source.length + 2)
  const first = await fileHandle.read(dest, 1, source.length, 0)
  assert.equal(first.bytesRead, maxRange)
  assert.equal((await fileHandle.read(dest, 1 + first.bytesRead, 3, maxRange)).bytesRead, 3)
  assert.equal((await fileHandle.read(dest, 0, 1, source.length)).bytesRead, 0)
  assert.deepEqual(dest.subarray(1, -1), source)
  assert.deepEqual([dest[0], dest.at(-1)], [0, 0])
  assert.deepEqual(calls.filter(call => call.path === '/read').map(call => call.body.length), [maxRange, 3])
  await fileHandle.close()
  await assert.rejects(fileHandle.read(dest, 0, 1, 0), /closed/)
})

test('rejects malformed references, mismatched open metadata, corrupt ranges and changed sources', async t => {
  let failure = 'bad-ref'
  const normal = serve(Buffer.from('abc'))
  const { reader } = await socketReader(t, (path, body) => {
    if (failure === 'bad-ref' && path === '/resolve') return [200, { ...locator, relativePath: hostPath }]
    if (failure === 'mismatch' && path === '/open') return [200, { ...normal(path, body)[1], relativePath: 'different' }]
    if (failure === 'too-long' && path === '/read') return [200, Buffer.alloc(4)]
    if (failure === 'too-short' && path === '/read') return [200, Buffer.alloc(2)]
    if (failure === 'changed' && path === '/read') return [409, { code: 'source_changed', message: hostPath }]
    return normal(path, body)
  })
  await assert.rejects(reader.locatorForPath(hostPath), { code: 'server_file_host_unavailable' })
  await assert.rejects(reader.inspectLargeLocator({ ...locator, relativePath: '../list.zip' }, { extensions: ['.zip'] }), { code: 'invalid_server_file_path' })
  failure = 'mismatch'
  await assert.rejects(reader.openLargeLocator(locator, { extensions: ['.zip'] }), { code: 'server_file_host_unavailable' })
  failure = 'too-long'
  const { fileHandle } = await reader.openLargeLocator(locator, { extensions: ['.zip'] })
  try {
    for (const errorMode of ['too-long', 'too-short']) {
      failure = errorMode
      await assert.rejects(fileHandle.read(Buffer.alloc(3), 0, 3, 0), { code: 'server_file_host_unavailable' })
    }
    failure = 'changed'
    await assert.rejects(fileHandle.read(Buffer.alloc(3), 0, 3, 0), error =>
      error.code === 'source_changed' && error.status === 409 && !error.message.includes(hostPath))
  } finally { await fileHandle.close() }
})
