import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { open, chmod, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { AppError } from '../../server/core/errors.mjs'
import { parseServerFileRoots, ServerFileReader } from '../../server/ingest/external/server-files.mjs'

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
let testRoot

beforeEach(async () => {
  testRoot = await realpath(await mkdtemp(join(tmpdir(), 'mxih-server-files-')))
})

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

function isAppError(code) {
  return (error) => error instanceof AppError && error.code === code
}

test('root parser accepts a JSON map and fails closed on unsafe configuration', () => {
  assert.deepEqual(parseServerFileRoots(''), [])
  assert.deepEqual(
    parseServerFileRoots(JSON.stringify({ primary: '/srv/mx/import', archive: '/srv/mx/archive' })),
    [
      { rootId: 'primary', path: '/srv/mx/import' },
      { rootId: 'archive', path: '/srv/mx/archive' },
    ],
  )
  for (const raw of [
    '[]',
    '{not-json}',
    JSON.stringify({ BadId: '/srv/mx/import' }),
    JSON.stringify({ primary: 'relative/path' }),
    JSON.stringify({ primary: '/srv/../etc' }),
    JSON.stringify({ primary: '/srv/*' }),
  ]) {
    assert.throws(() => parseServerFileRoots(raw), isAppError('invalid_configuration'))
  }
})

test('root creation rejects aliases and reports no absolute configured path', async () => {
  const actual = join(testRoot, 'actual')
  const alias = join(testRoot, 'alias')
  await mkdir(actual)
  await symlink(actual, alias, 'dir')

  await assert.rejects(
    ServerFileReader.create({ roots: [{ rootId: 'alias', path: alias }] }),
    (error) => (
      isAppError('invalid_configuration')(error)
      && !error.message.includes(alias)
      && !error.message.includes(actual)
    ),
  )
})

test('description exposes root identities and bounds, never mount paths', async () => {
  const allowed = join(testRoot, 'allowed')
  await mkdir(allowed)
  const reader = await ServerFileReader.create({ roots: { internal: allowed } })
  const description = reader.describeRoots()

  assert.deepEqual(description, {
    enabled: true,
    maxBytes: DEFAULT_MAX_BYTES,
    roots: [{ rootId: 'internal' }],
  })
  assert.equal(JSON.stringify(description).includes(allowed), false)

  const disabled = await ServerFileReader.create()
  assert.deepEqual(disabled.describeRoots(), { enabled: false, maxBytes: DEFAULT_MAX_BYTES, roots: [] })
  await assert.rejects(disabled.readInput('/tmp/input.csv'), isAppError('server_file_roots_unconfigured'))
})

test('reads one regular file and returns safe, content-addressed metadata', async () => {
  const allowed = join(testRoot, 'allowed')
  const nested = join(allowed, 'reports', '2026')
  const file = join(nested, 'weekly.csv')
  const body = Buffer.from('id,title\n1,alpha\n')
  await mkdir(nested, { recursive: true })
  await writeFile(file, body)
  const reader = await ServerFileReader.create({ roots: [{ rootId: 'internal', path: allowed }] })

  const result = await reader.readInput(file)
  assert.equal(result.buffer.equals(body), true)
  assert.equal(result.filename, 'weekly.csv')
  assert.equal(result.rootId, 'internal')
  assert.equal(result.relativePath, join('reports', '2026', 'weekly.csv'))
  assert.equal(result.inputBytes, body.length)
  assert.equal(result.inputSha256, createHash('sha256').update(body).digest('hex'))
  assert.equal(Number.isNaN(Date.parse(result.mtime)), false)
  assert.equal(JSON.stringify({ ...result, buffer: undefined }).includes(allowed), false)
})

test('absolute input selects the longest configured root prefix', async () => {
  const outer = join(testRoot, 'outer')
  const inner = join(outer, 'curated')
  const file = join(inner, 'records.csv')
  await mkdir(inner, { recursive: true })
  await writeFile(file, 'id\n1\n')
  const reader = await ServerFileReader.create({
    roots: [
      { rootId: 'outer', path: outer },
      { rootId: 'curated', path: inner },
    ],
  })

  const direct = await reader.readInput(file)
  assert.equal(direct.rootId, 'curated')
  assert.equal(direct.relativePath, 'records.csv')

  const located = await reader.readLocator({ rootId: 'outer', relativePath: join('curated', 'records.csv') })
  assert.equal(located.rootId, 'outer')
  assert.equal(located.relativePath, join('curated', 'records.csv'))
})

test('rejects traversal, globs, NUL, relative absolute-input and sibling prefix traps', async () => {
  const allowed = join(testRoot, 'allowed')
  const sibling = join(testRoot, 'allowed-extra')
  await mkdir(allowed)
  await mkdir(sibling)
  await writeFile(join(allowed, 'report[1].csv'), 'id\n1\n')
  await writeFile(join(sibling, 'outside.csv'), 'id\n1\n')
  const reader = await ServerFileReader.create({ roots: { internal: allowed } })

  const invalid = [
    'relative.csv',
    `${allowed}/../allowed/report.csv`,
    join(allowed, 'report[1].csv'),
    `${allowed}/bad\0.csv`,
  ]
  for (const candidate of invalid) {
    await assert.rejects(reader.readInput(candidate), isAppError('invalid_server_file_path'))
  }

  await assert.rejects(
    reader.readInput(join(sibling, 'outside.csv')),
    (error) => isAppError('server_file_path_not_allowed')(error) && !error.message.includes(sibling),
  )
  await assert.rejects(
    reader.readLocator({ rootId: 'internal', relativePath: '../outside.csv' }),
    isAppError('invalid_server_file_path'),
  )
  await assert.rejects(
    reader.readLocator({ rootId: 'internal', relativePath: join(allowed, 'file.csv') }),
    isAppError('invalid_server_file_path'),
  )
  await assert.rejects(
    reader.readLocator({ rootId: 'unknown', relativePath: 'file.csv' }),
    isAppError('server_file_path_not_allowed'),
  )
})

test('rejects final and intermediate symbolic links even when their targets remain allowed', async () => {
  const allowed = join(testRoot, 'allowed')
  const realDirectory = join(allowed, 'real')
  const realFile = join(realDirectory, 'source.csv')
  const fileAlias = join(allowed, 'file-alias.csv')
  const directoryAlias = join(allowed, 'directory-alias')
  await mkdir(realDirectory, { recursive: true })
  await writeFile(realFile, 'id\n1\n')
  await symlink(realFile, fileAlias, 'file')
  await symlink(realDirectory, directoryAlias, 'dir')
  const reader = await ServerFileReader.create({ roots: { internal: allowed } })

  await assert.rejects(reader.readInput(fileAlias), isAppError('server_file_symlink_rejected'))
  await assert.rejects(
    reader.readInput(join(directoryAlias, basename(realFile))),
    isAppError('server_file_symlink_rejected'),
  )
})

test('rejects directories, empty, executable, unsupported and oversized files before import', async () => {
  const allowed = join(testRoot, 'allowed')
  await mkdir(allowed)
  const directory = join(allowed, 'directory.csv')
  const empty = join(allowed, 'empty.csv')
  const executable = join(allowed, 'executable.csv')
  const unsupported = join(allowed, 'archive.zip')
  const oversized = join(allowed, 'oversized.csv')
  await mkdir(directory)
  await writeFile(empty, '')
  await writeFile(executable, 'id\n1\n')
  await chmod(executable, 0o744)
  await writeFile(unsupported, 'not an archive')
  await writeFile(oversized, 'x')
  await truncate(oversized, DEFAULT_MAX_BYTES + 1)
  const reader = await ServerFileReader.create({ roots: { internal: allowed } })

  await assert.rejects(reader.readInput(directory), isAppError('server_file_not_regular'))
  await assert.rejects(reader.readInput(empty), isAppError('server_file_empty'))
  await assert.rejects(reader.readInput(executable), isAppError('server_file_executable'))
  await assert.rejects(reader.readInput(unsupported), isAppError('unsupported_file_type'))
  await assert.rejects(reader.readInput(oversized), isAppError('server_file_too_large'))
})

test('filesystem failures are sanitized and do not disclose host paths', async () => {
  const allowed = join(testRoot, 'allowed')
  await mkdir(allowed)
  const missing = join(allowed, 'private-layout', 'missing.csv')
  const reader = await ServerFileReader.create({ roots: { internal: allowed } })

  await assert.rejects(
    reader.readInput(missing),
    (error) => (
      isAppError('server_file_not_found')(error)
      && !error.message.includes(allowed)
      && !error.message.includes(missing)
      && error.details == null
      && error.cause == null
    ),
  )
})

test('rejects a file whose descriptor metadata changes during the bounded read', async () => {
  const allowed = join(testRoot, 'allowed')
  const file = join(allowed, 'changing.csv')
  await mkdir(allowed)
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024, 0x61))
  const reader = await ServerFileReader.create({ roots: { internal: allowed } })
  const writer = await open(file, 'r+')
  let running = true
  let value = 0x62
  const churn = (async () => {
    while (running) {
      await writer.write(Buffer.from([value]), 0, 1, 0)
      value = value === 0x62 ? 0x63 : 0x62
      await new Promise((resolveTurn) => setImmediate(resolveTurn))
    }
  })()

  try {
    await new Promise((resolveTurn) => setImmediate(resolveTurn))
    await assert.rejects(reader.readInput(file), isAppError('server_file_changed'))
  } finally {
    running = false
    await churn
    await writer.close()
  }
})
