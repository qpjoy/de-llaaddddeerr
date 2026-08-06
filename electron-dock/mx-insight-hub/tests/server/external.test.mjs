import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  ParseError,
  parseDelimited,
  parseJsonLines,
  parseText,
  parseFile,
  SUPPORTED_EXTENSIONS,
} from '../../server/ingest/external/parsers.mjs'
import {
  MappingError,
  applyMapping,
  inferFieldMap,
  validateFieldMap,
} from '../../server/ingest/external/mapping.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16)

// ---------------------------------------------------------------------------
// Delimited parsing
// ---------------------------------------------------------------------------

test('quoted fields keep embedded newlines, commas and escaped quotes', () => {
  const { records } = parseDelimited('id,text\n1,"line one\nline two, with comma and ""quotes"""')
  // A naive line split would shred this row into fragments that then fail
  // mapping for entirely the wrong reason.
  assert.equal(records[0].text, 'line one\nline two, with comma and "quotes"')
})

test('blank and duplicate headers get stable synthetic names', () => {
  const { columns } = parseDelimited('id,,备注,备注\n1,a,b,c')
  // Dropping them would lose data; overwriting would lose one of the two
  // identically named columns.
  assert.deepEqual(columns, ['id', 'column_2', '备注', '备注_2'])
})

test('an unterminated quote is an error rather than a truncated row', () => {
  assert.throws(() => parseDelimited('id,text\n1,"never closed'), ParseError)
})

test('a UTF-8 BOM does not corrupt the first column name', () => {
  const { columns } = parseDelimited('﻿id,title\n1,x')
  assert.equal(columns[0], 'id', 'the BOM would otherwise become part of the header')
})

test('JSON Lines reports the offending line number', () => {
  assert.throws(() => parseJsonLines('{"a":1}\nnot json\n'), /line 2/)
})

test('text records are keyed by content hash, not position', () => {
  const original = parseText('first para\n\nsecond para', { hash })
  const withInsert = parseText('inserted\n\nfirst para\n\nsecond para', { hash })
  // Keying on line number would renumber -- and therefore duplicate -- every
  // paragraph after an insertion.
  assert.equal(original.records[0].contentHash, withInsert.records[1].contentHash)
})

test('unsupported file types are rejected with the supported list', () => {
  assert.throws(() => parseFile(Buffer.from(''), 'data.pdf'), /unsupported file type/)
  assert.ok(SUPPORTED_EXTENSIONS.includes('.xlsx'))
})

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

test('a non-ZIP payload is rejected before any parsing', () => {
  assert.throws(() => parseFile(Buffer.from('this is not a workbook'), 'book.xlsx'), ParseError)
})

// ---------------------------------------------------------------------------
// Mapping validation
// ---------------------------------------------------------------------------

test('a mapping without externalId is rejected', () => {
  // Without a dedup key every import would re-create every row: silent
  // duplication rather than a visible failure.
  assert.throws(() => validateFieldMap({ title: { from: 'x' } }), /externalId is required/)
})

test('a misspelled target field is rejected rather than silently ignored', () => {
  assert.throws(
    () => validateFieldMap({ externalId: { from: 'id' }, titel: { from: 't' } }),
    /unknown target field: titel/,
  )
})

test('inference never assigns one column to two targets', () => {
  const fieldMap = inferFieldMap(['uid', 'title'])
  const sources = Object.values(fieldMap).map((rule) => rule.from)
  assert.equal(new Set(sources).size, sources.length)
  // "uid" is an alias of both externalId and authorExternalId; a record that is
  // its own author is worse than a null field.
  assert.notEqual(fieldMap.externalId?.from, fieldMap.authorExternalId?.from)
})

// ---------------------------------------------------------------------------
// Mapping application
// ---------------------------------------------------------------------------

const fieldMap = {
  externalId: { from: ['id', '编号'] },
  title: { from: '标题' },
  eventTime: { from: '发布时间' },
  'metrics.likes': { from: '点赞数' },
}

test('the first non-empty source column wins', () => {
  const { record } = applyMapping({ id: '', 编号: 'B-2', 标题: 't' }, fieldMap, { platform: 'external' })
  // One mapping absorbs a source that renamed a column mid-history instead of
  // splitting into two mappings.
  assert.equal(record.externalId, 'B-2')
})

test('a row without an external id is rejected, not given a synthetic key', () => {
  const { record, rejected } = applyMapping({ 标题: 'orphan' }, fieldMap, { platform: 'external' })
  assert.equal(record, null)
  assert.match(rejected, /externalId is empty or missing/)
})

test('unmapped columns are preserved under extensions', () => {
  const { record } = applyMapping(
    { id: '1', 标题: 't', 省份: '上海', 空的: '' },
    fieldMap,
    { platform: 'external' },
  )
  // This is the layer that lets a field be promoted to a real column later
  // without re-importing the source.
  assert.deepEqual(record.extensions, { 省份: '上海' })
})

test('spreadsheet number formatting does not silently drop a metric', () => {
  const { record } = applyMapping({ id: '1', 点赞数: '1,234' }, fieldMap, { platform: 'external' })
  assert.equal(record.metrics.likes, 1234)
  const percent = applyMapping({ id: '2', 点赞数: '87%' }, fieldMap, { platform: 'external' })
  assert.equal(percent.record.metrics.likes, 87)
})

test('Excel serial dates are converted rather than read as years', () => {
  const { record } = applyMapping({ id: '1', 发布时间: '46234' }, fieldMap, { platform: 'external' })
  assert.equal(record.eventTime.toISOString().slice(0, 10), '2026-07-31')
})

test('a space-separated timestamp parses as local ISO', () => {
  const { record } = applyMapping(
    { id: '1', 发布时间: '2026-08-06 11:20:25' },
    fieldMap,
    { platform: 'external' },
  )
  assert.equal(record.eventTime.getFullYear(), 2026)
  assert.equal(record.eventTime.getMonth(), 7)
})

test('an unparseable timestamp becomes null rather than an invalid date', () => {
  const { record } = applyMapping({ id: '1', 发布时间: '待定' }, fieldMap, { platform: 'external' })
  assert.equal(record.eventTime, null)
})

test('the content hash ignores metrics and collection time', () => {
  const first = applyMapping({ id: '1', 标题: 't', 点赞数: '10' }, fieldMap, { platform: 'external' })
  const second = applyMapping({ id: '1', 标题: 't', 点赞数: '999' }, fieldMap, { platform: 'external' })
  // Re-importing an unchanged sheet whose counters drifted must not create a
  // revision per row and flood the projection outbox.
  assert.equal(first.record.payloadSha256, second.record.payloadSha256)

  const edited = applyMapping({ id: '1', 标题: 'changed', 点赞数: '10' }, fieldMap, { platform: 'external' })
  assert.notEqual(first.record.payloadSha256, edited.record.payloadSha256)
})

// ---------------------------------------------------------------------------
// Foreign database source
// ---------------------------------------------------------------------------

test('foreign-database identifiers are validated, not quoted-and-hoped', async () => {
  const { DatabaseSourcePuller } = await import('../../server/ingest/external/database-source.mjs')
  const store = {
    getExternalSource: async () => ({
      id: 's1',
      sourceKey: 'legacy',
      sourceKind: 'database',
      datasetId: 'external.legacy.v1',
      platform: 'external',
      objectType: 'record',
      // Identifiers cannot be SQL parameters, so a hostile table name has to be
      // rejected outright rather than escaped.
      connection: { table: 'posts"; DROP TABLE users; --', dsnEnv: 'LEGACY_DSN' },
    }),
    getActiveMapping: async () => ({ version: 1, fieldMap: { externalId: { from: 'id' } } }),
  }
  const puller = new DatabaseSourcePuller({ store, queue: {}, logger: { warn() {} } })
  await assert.rejects(() => puller.pullBatch('legacy'), /must be a plain SQL identifier/)
})

test('a database source refuses to run without a DSN environment variable', async () => {
  const { DatabaseSourcePuller } = await import('../../server/ingest/external/database-source.mjs')
  const store = {
    getExternalSource: async () => ({
      id: 's1', sourceKey: 'legacy', sourceKind: 'database',
      datasetId: 'd', platform: 'external', objectType: 'record',
      // The DSN is referenced by env var name, never stored in the row: a
      // password in a database row is a password in every backup.
      connection: { table: 'posts', dsnEnv: 'DEFINITELY_NOT_SET_IN_TESTS' },
    }),
    getActiveMapping: async () => ({ version: 1, fieldMap: { externalId: { from: 'id' } } }),
  }
  const puller = new DatabaseSourcePuller({ store, queue: {}, logger: { warn() {} } })
  await assert.rejects(() => puller.pullBatch('legacy'), /is not set in this deployment/)
})

test('a database source rejects a file-kind source', async () => {
  const { DatabaseSourcePuller } = await import('../../server/ingest/external/database-source.mjs')
  const store = { getExternalSource: async () => ({ id: 's1', sourceKind: 'file' }) }
  const puller = new DatabaseSourcePuller({ store, queue: {}, logger: { warn() {} } })
  await assert.rejects(() => puller.pullBatch('sheet'), /not a database source/)
})
