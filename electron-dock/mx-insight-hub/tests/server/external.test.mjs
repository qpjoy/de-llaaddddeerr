import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  ParseError,
  parseDelimited,
  parseJson,
  parseJsonLines,
  parseText,
  parseFile,
  SUPPORTED_EXTENSIONS,
} from '../../server/ingest/external/parsers.mjs'
import {
  MappingError,
  applyMapping,
  CHUNKER_VERSION,
  inferFieldMap,
  validateFieldMap,
} from '../../server/ingest/external/mapping.mjs'
import {
  ExternalImporter,
  buildFileStructure,
  fingerprintFileStructure,
} from '../../server/ingest/external/importer.mjs'
import {
  DatabaseSourcePuller,
  validateDatabaseConnection,
} from '../../server/ingest/external/database-source.mjs'
import { runExternalPullJob } from '../../server/ingest/external/sync-job.mjs'
import { scheduleActiveDatabaseSources } from '../../server/ingest/external/scheduler.mjs'
import { TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST } from '../../server/ingest/telegram/monitor-pipeline.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16)

function zipStored(files) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name)
    const data = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    localParts.push(local, nameBuffer, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

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

test('structure rules reject headers that collide after normalization', () => {
  assert.throws(
    () => buildFileStructure({
      columns: ['ID', ' id '],
      records: [{ ID: '1', ' id ': '2' }],
    }, 'records.csv'),
    (error) => error?.status === 400 && error?.code === 'ambiguous_file_columns',
  )
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

test('JSON accepts a top-level object and an array of objects with deterministic selectors', () => {
  assert.deepEqual(parseJson('{"id":"one","title":"single"}'), {
    columns: ['id', 'title'],
    records: [{ id: 'one', title: 'single' }],
    selector: 'top-level-object',
  })
  assert.deepEqual(parseJson('[{"id":"one"},{"title":"two","id":"two"}]'), {
    columns: ['id', 'title'],
    records: [{ id: 'one' }, { title: 'two', id: 'two' }],
    selector: 'top-level-array',
  })
})

test('JSON unwraps exactly one common object-array envelope', () => {
  for (const key of ['items', 'records', 'data']) {
    const parsed = parseJson(JSON.stringify({ ok: true, [key]: [{ id: 'one' }, { id: 'two' }] }))
    assert.deepEqual(parsed.records, [{ id: 'one' }, { id: 'two' }])
    assert.equal(parsed.selector, `envelope:${key}`)
  }
})

test('JSON rejects primitives, mixed arrays and ambiguous envelopes', () => {
  for (const input of ['null', '42', '"text"', 'true', '[{"id":1},2]', '[1,2]']) {
    assert.throws(() => parseJson(input), ParseError)
  }
  assert.throws(
    () => parseJson('{"items":[{"id":1}],"data":[{"id":2}]}'),
    /multiple object-array envelopes/,
  )
})

test('JSON enforces the shared external-file row limit', () => {
  const oversized = `[${Array.from({ length: 500_001 }, () => '{}').join(',')}]`
  assert.throws(() => parseJson(oversized), /more than 500000 rows/)
})

test('text records are keyed by content hash, not position', () => {
  const original = parseText('first para\n\nsecond para', { hash })
  const withInsert = parseText('inserted\n\nfirst para\n\nsecond para', { hash })
  // Keying on line number would renumber -- and therefore duplicate -- every
  // paragraph after an insertion.
  assert.equal(original.records[0].externalId, withInsert.records[1].externalId)
  assert.equal(original.records[0].contentHash, original.records[0].externalId)
})

test('plain-text inference produces an approvable stable mapping', () => {
  const parsed = parseFile(Buffer.from('first para\n\nsecond para'), 'notes.md', { hash })
  const inferred = inferFieldMap(parsed.columns)
  assert.deepEqual(inferred, {
    externalId: { from: 'externalId' },
    body: { from: 'content' },
  })
  assert.equal(validateFieldMap(inferred), true)
  assert.equal(
    applyMapping(parsed.records[0], inferred, { platform: 'external' }).record.externalId,
    parsed.records[0].externalId,
  )
})

test('a generic contentHash column is not inferred as record identity', () => {
  assert.deepEqual(inferFieldMap(['contentHash', 'content']), {
    body: { from: 'content' },
  })
})

test('unsupported file types are rejected with the supported list', () => {
  assert.throws(() => parseFile(Buffer.from(''), 'data.pdf'), /unsupported file type/)
  assert.ok(SUPPORTED_EXTENSIONS.includes('.json'))
  assert.ok(SUPPORTED_EXTENSIONS.includes('.xlsx'))
  assert.ok(SUPPORTED_EXTENSIONS.includes('.md'))
})

test('file preview returns content identity and a value-free reusable structure fingerprint', async () => {
  const importer = new ExternalImporter({ store: {} })
  const first = await importer.preview(
    Buffer.from(' ID ,title\n1,first\n2,second\n'),
    'weekly-one.CSV',
  )
  const sameStructure = await importer.preview(
    Buffer.from('id,title\n99,entirely different\n'),
    'weekly-two.csv',
  )

  assert.match(first.inputSha256, /^[a-f0-9]{64}$/)
  assert.notEqual(first.inputSha256, sameStructure.inputSha256)
  assert.equal(first.schemaFingerprint, sameStructure.schemaFingerprint)
  assert.deepEqual(first.fileStructure, {
    parserFamily: 'delimited',
    format: 'csv',
    selector: 'header-row',
    parserVersion: CHUNKER_VERSION,
    columns: [
      { name: 'id', valueTypeFamilies: ['string'], required: true },
      { name: 'title', valueTypeFamilies: ['string'], required: true },
    ],
  })
  assert.equal(first.rowCount, 2, 'existing preview fields remain available')
  assert.equal(first.fileStructure.columns.some((column) => 'sample' in column), false)
  assert.equal(first.schemaFingerprint, fingerprintFileStructure(first.fileStructure))
})

test('JSONL structure ignores object key discovery order but detects type and required drift', async () => {
  const importer = new ExternalImporter({ store: {} })
  const first = await importer.preview(
    Buffer.from('{"id":1,"title":"one"}\n{"title":"two","id":2}\n'),
    'first.jsonl',
  )
  const reordered = await importer.preview(
    Buffer.from('{"title":"different","id":99}\n'),
    'renamed.jsonl',
  )
  const typeDrift = await importer.preview(
    Buffer.from('{"title":"different","id":"99"}\n'),
    'typed.jsonl',
  )
  const requiredDrift = await importer.preview(
    Buffer.from('{"id":1,"title":"one"}\n{"id":2}\n'),
    'optional.jsonl',
  )

  assert.deepEqual(first.fileStructure.columns.map((column) => column.name), ['id', 'title'])
  assert.equal(first.schemaFingerprint, reordered.schemaFingerprint)
  assert.notEqual(first.schemaFingerprint, typeDrift.schemaFingerprint)
  assert.notEqual(first.schemaFingerprint, requiredDrift.schemaFingerprint)
  assert.equal(requiredDrift.fileStructure.columns.find((column) => column.name === 'title').required, false)
})

test('JSON file structure fingerprints include the selected document location', async () => {
  const importer = new ExternalImporter({ store: {} })
  const topLevel = await importer.preview(Buffer.from('[{"id":"one"}]'), 'records.json')
  const enveloped = await importer.preview(Buffer.from('{"records":[{"id":"one"}]}'), 'records.json')

  assert.equal(topLevel.fileStructure.parserFamily, 'json-document')
  assert.equal(topLevel.fileStructure.format, 'json')
  assert.equal(topLevel.fileStructure.selector, 'top-level-array')
  assert.equal(enveloped.fileStructure.selector, 'envelope:records')
  assert.notEqual(topLevel.schemaFingerprint, enveloped.schemaFingerprint)
})

test('file structure fingerprint includes format and selector without filename or row count', () => {
  const parsed = { columns: ['id'], records: [{ id: '1' }, { id: '2' }] }
  const csv = buildFileStructure(parsed, 'a.csv')
  const tsv = buildFileStructure(parsed, 'anything.tsv')
  const workbook = buildFileStructure(parsed, 'anything.xlsx')

  assert.notEqual(fingerprintFileStructure(csv), fingerprintFileStructure(tsv))
  assert.equal(csv.selector, 'header-row')
  assert.equal(workbook.selector, 'first-worksheet')
  assert.equal('filename' in csv, false)
  assert.equal('rowCount' in csv, false)
})

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

test('a non-ZIP payload is rejected before any parsing', () => {
  assert.throws(() => parseFile(Buffer.from('this is not a workbook'), 'book.xlsx'), ParseError)
})

test('XLSX follows workbook tab order instead of numeric worksheet filenames', () => {
  const workbook = `<?xml version="1.0"?><workbook xmlns:r="relationships"><sheets><sheet name="Visible first" r:id="rId9"/><sheet name="Other" r:id="rId2"/></sheets></workbook>`
  const relationships = `<?xml version="1.0"?><Relationships><Relationship Id="rId9" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>`
  const sheet = (value) => `<?xml version="1.0"?><worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>id</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`
  const workbookBuffer = zipStored({
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': relationships,
    'xl/worksheets/sheet1.xml': sheet('wrong-sheet'),
    'xl/worksheets/sheet2.xml': sheet('first-tab'),
  })
  assert.deepEqual(parseFile(workbookBuffer, 'tabs.xlsx').records, [{ id: 'first-tab' }])
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

test('a composite external id keeps Telegram message ids scoped to their chat', () => {
  const mapping = {
    externalId: { from: ['chat_id', 'message_id'], type: 'composite', separator: ':' },
    'relations.chatId': { from: 'chat_id' },
    'relations.messageId': { from: 'message_id' },
  }
  validateFieldMap(mapping)
  const { record } = applyMapping({ chat_id: '-1007', message_id: 42 }, mapping, {
    platform: 'telegram', objectType: 'message',
  })
  assert.equal(record.externalId, '-1007:42')
  assert.deepEqual(record.stableFields.relations, { chatId: '-1007', messageId: '42' })
  assert.equal(applyMapping({ chat_id: '-1007' }, mapping, { platform: 'telegram' }).record, null)
})

test('Telegram edits, tombstones and structured fields survive mapping without exposing dropped collector fields', () => {
  const mapping = {
    externalId: { from: ['chat_id', 'message_id'], type: 'composite', separator: ':' },
    body: { from: 'message_text' },
    eventTime: { from: 'message_at' },
    collectedAt: { from: 'collected_at' },
    editedAt: { from: 'edited_at' },
    deletedAt: { from: 'deleted_at' },
    media: { from: 'media' },
    entities: { from: 'entities' },
    'attributes.username': { from: 'sender_username' },
    'attributes.isOutgoing': { from: 'is_outgoing' },
    'relations.threadId': { from: 'thread_id' },
    'relations.groupedId': { from: 'grouped_id' },
    _drop: { from: ['id', 'collected_by_account_id', 'metadata'] },
  }
  validateFieldMap(mapping)
  const deletedAt = '2026-08-10T03:00:00Z'
  const { record } = applyMapping({
    id: 88,
    chat_id: -1007,
    message_id: 42,
    message_text: 'hello',
    message_at: '2026-08-09T03:00:00Z',
    collected_at: '2026-08-09T03:00:01Z',
    edited_at: '2026-08-09T04:00:00Z',
    deleted_at: deletedAt,
    sender_username: 'mx_user',
    is_outgoing: false,
    thread_id: 7,
    grouped_id: 9,
    media: { media_kind: 'image', size_bytes: 123 },
    entities: [{ type: 'url', offset: 0, length: 5 }],
    collected_by_account_id: 999,
    metadata: { provider_token: 'must-not-project' },
  }, mapping, {
    platform: 'telegram',
    objectType: 'message',
    source: { origin: 'database', sourceKey: 'telegram-monitor-messages' },
  })

  assert.equal(record.deletedAt.toISOString(), '2026-08-10T03:00:00.000Z')
  assert.equal(record.stableFields.editedAt.toISOString(), '2026-08-09T04:00:00.000Z')
  assert.equal(record.stableFields.author.handle, 'mx_user')
  assert.equal(record.stableFields.attributes.isOutgoing, false)
  assert.deepEqual(record.stableFields.media, { media_kind: 'image', size_bytes: 123 })
  assert.deepEqual(record.stableFields.entities, [{ type: 'url', offset: 0, length: 5 }])
  assert.deepEqual(record.stableFields.relations, { threadId: '7', groupedId: '9' })
  assert.deepEqual(record.stableFields.source, { origin: 'database', sourceKey: 'telegram-monitor-messages' })
  assert.deepEqual(record.extensions, {})
  assert.ok(!JSON.stringify({ stableFields: record.stableFields, extensions: record.extensions }).includes('must-not-project'))
})

test('a tombstone changes the canonical content hash', () => {
  const mapping = {
    externalId: { from: 'id' },
    deletedAt: { from: 'deleted_at' },
  }
  const live = applyMapping({ id: '1', deleted_at: null }, mapping, { platform: 'telegram' })
  const deleted = applyMapping({ id: '1', deleted_at: '2026-08-10T03:00:00Z' }, mapping, { platform: 'telegram' })
  assert.notEqual(live.record.payloadSha256, deleted.record.payloadSha256)
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

test('JSON mappings can read nested values without changing the preserved raw object', () => {
  const raw = {
    chat_id: '-1007',
    message_id: 42,
    metadata: { views: 1200, forwards: 18, grouped_id: 'album-1' },
  }
  const { record } = applyMapping(raw, {
    externalId: { from: ['chat_id', 'message_id'], type: 'composite', separator: ':' },
    'metrics.views': { from: 'metadata.views', type: 'number' },
    'metrics.shares': { from: 'metadata.forwards', type: 'number' },
    'relations.groupedId': { from: 'metadata.grouped_id' },
  }, { platform: 'telegram' })

  assert.deepEqual(record.metrics, { shares: 18, views: 1200 })
  assert.equal(record.stableFields.relations.groupedId, 'album-1')
  assert.deepEqual(record.rawItem, raw)
  assert.deepEqual(record.extensions.metadata, raw.metadata)
})

test('an exact dotted column name takes precedence over nested JSON lookup', () => {
  const { record } = applyMapping({
    id: '1',
    'metadata.views': 7,
    metadata: { views: 99 },
  }, {
    externalId: { from: 'id' },
    'metrics.views': { from: 'metadata.views', type: 'number' },
  }, { platform: 'external' })

  assert.equal(record.metrics.views, 7)
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

test('the content hash tracks projected metrics but ignores collection time', () => {
  const first = applyMapping({ id: '1', 标题: 't', 点赞数: '10' }, fieldMap, { platform: 'external' })
  const second = applyMapping({ id: '1', 标题: 't', 点赞数: '999' }, fieldMap, { platform: 'external' })
  assert.notEqual(first.record.payloadSha256, second.record.payloadSha256)

  const edited = applyMapping({ id: '1', 标题: 'changed', 点赞数: '10' }, fieldMap, { platform: 'external' })
  assert.notEqual(first.record.payloadSha256, edited.record.payloadSha256)
})

test('direct-file deduplication keys include the immutable parser, mapping, and format', async () => {
  const mapping = { version: 1, fieldMap: { externalId: { from: 'id' } } }
  const started = []
  const importer = new ExternalImporter({
    store: {
      getExternalSource: async () => ({
        id: 'source-file', sourceKey: 'files', status: 'active',
        datasetId: 'files.v1', platform: 'external', objectType: 'document',
      }),
      getActiveMapping: async () => mapping,
      startImportRun: async (input) => {
        started.push(input)
        return { id: null, duplicateOf: 'previous-run' }
      },
    },
  })
  const content = Buffer.from('id,title\n1,hello\n')
  const keyFor = (mappingVersion, format) => createHash('sha256')
    .update(`parser=${CHUNKER_VERSION}\nmapping=${mappingVersion}\nformat=${format}`)
    .digest('hex')

  await importer.importFile({ sourceKey: 'files', buffer: content, filename: 'first.CSV' })
  mapping.version = 2
  await importer.importFile({ sourceKey: 'files', buffer: content, filename: 'second.csv' })
  mapping.version = 1
  await importer.importFile({ sourceKey: 'files', buffer: content, filename: 'first.txt' })

  assert.equal(started[0].interpretationKey, keyFor(1, '.csv'))
  assert.equal(started[1].interpretationKey, keyFor(2, '.csv'))
  assert.equal(started[2].interpretationKey, keyFor(1, '.txt'))
  assert.match(started[0].interpretationKey, /^[a-f0-9]{64}$/)
  assert.equal(new Set(started.map((run) => run.inputSha256)).size, 1)
})

test('direct-file interpretation and parser versions include a shared format-rule version when present', async () => {
  const started = []
  const parserVersions = []
  const importer = new ExternalImporter({
    store: {
      getExternalSource: async () => ({
        id: 'source-file', sourceKey: 'files', status: 'active',
        datasetId: 'files.v1', platform: 'external', objectType: 'document',
      }),
      getActiveMapping: async () => ({
        version: 3,
        formatRuleVersionId: 'rule-version-7',
        fieldMap: { externalId: { from: 'id' } },
      }),
      startImportRun: async (input) => {
        started.push(input)
        return { id: 'rule-run', duplicateOf: null }
      },
      ingestExternalRecords: async ({ records }) => {
        parserVersions.push(...records.map((record) => record.parserVersion))
        return { ingested: records.length, changed: records.length }
      },
      recordRejectedRows: async () => {},
      finishImportRun: async () => {},
    },
  })

  await importer.importFile({
    sourceKey: 'files', buffer: Buffer.from('id\n1\n'), filename: 'records.csv',
  })

  const expectedKey = createHash('sha256')
    .update(`parser=${CHUNKER_VERSION}\nmapping=3\nformat=.csv\nformatRuleVersion=rule-version-7`)
    .digest('hex')
  assert.equal(started[0].interpretationKey, expectedKey)
  assert.deepEqual(parserVersions, [`${CHUNKER_VERSION}:map3:rule=rule-version-7`])
})

test('direct-file imports fence claim, batch writes, evidence, and finish with the source lock guard', async () => {
  const events = []
  const sessionClient = { name: 'held-source-lock-session' }
  const importer = new ExternalImporter({
    store: {
      getExternalSource: async () => ({
        id: 'source-file', sourceKey: 'files', status: 'active',
        datasetId: 'files.v1', platform: 'external', objectType: 'document',
      }),
      getActiveMapping: async () => ({
        version: 1, fieldMap: { externalId: { from: 'id' }, title: { from: 'title' } },
      }),
      startImportRun: async (input) => {
        assert.equal(input.sessionClient, sessionClient)
        events.push('claim')
        return { id: 'guarded-run', duplicateOf: null }
      },
      ingestExternalRecords: async (input) => {
        assert.equal(input.sessionClient, sessionClient)
        assert.equal(input.records[0].parserVersion, `${CHUNKER_VERSION}:map1`)
        events.push('ingest')
        return { ingested: 1, changed: 1 }
      },
      recordRejectedRows: async (_id, _rows, options) => {
        assert.equal(options.sessionClient, sessionClient)
        events.push('evidence')
      },
      finishImportRun: async (_id, result, options) => {
        assert.equal(options.sessionClient, sessionClient)
        events.push(`finish:${result.status}`)
      },
    },
  })

  await importer.importFile({
    sourceKey: 'files', buffer: Buffer.from('id,title\n1,hello\n'), filename: 'records.csv',
    assertOwned: async () => { events.push('guard') },
    sessionClient,
  })

  assert.deepEqual(events, [
    'guard', 'claim', 'guard', 'ingest', 'guard', 'evidence', 'guard', 'finish:succeeded',
  ])
})

test('a lost source lock fences direct-file writes and terminalizes its claimed run', async () => {
  let guardCalls = 0
  let canonicalWritten = false
  const finished = []
  const importer = new ExternalImporter({
    store: {
      getExternalSource: async () => ({
        id: 'source-file', sourceKey: 'files', status: 'active',
        datasetId: 'files.v1', platform: 'external', objectType: 'document',
      }),
      getActiveMapping: async () => ({ version: 1, fieldMap: { externalId: { from: 'id' } } }),
      startImportRun: async () => ({ id: 'lost-lock-run', duplicateOf: null }),
      ingestExternalRecords: async () => { canonicalWritten = true },
      recordRejectedRows: async () => {},
      finishImportRun: async (_id, result) => { finished.push(result) },
    },
  })

  await assert.rejects(
    () => importer.importFile({
      sourceKey: 'files', buffer: Buffer.from('id\n1\n'), filename: 'records.csv',
      assertOwned: async () => {
        guardCalls += 1
        if (guardCalls === 2) {
          const error = new Error('source lock lost')
          error.code = 'source_lock_lost'
          throw error
        }
      },
    }),
    (error) => error?.code === 'source_lock_lost',
  )

  assert.equal(canonicalWritten, false)
  assert.equal(finished.at(-1).status, 'failed')
})

// ---------------------------------------------------------------------------
// Foreign database source
// ---------------------------------------------------------------------------

test('foreign-database identifiers are validated, not quoted-and-hoped', async () => {
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
  const store = {
    getExternalSource: async () => ({
      id: 's1', sourceKey: 'legacy', sourceKind: 'database',
      datasetId: 'd', platform: 'external', objectType: 'record', status: 'active',
      // Legacy deployment-managed DSNs remain supported.
      connection: {
        table: 'posts', dsnEnv: 'DEFINITELY_NOT_SET_IN_TESTS',
        cursorColumn: 'updated_at', idColumn: 'id',
      },
    }),
    getActiveMapping: async () => ({ version: 1, fieldMap: { externalId: { from: 'id' } } }),
  }
  const puller = new DatabaseSourcePuller({ store, queue: {}, logger: { warn() {} } })
  await assert.rejects(() => puller.pullBatch('legacy'), /is not set in this deployment/)
})

test('a database source rejects a file-kind source', async () => {
  const store = { getExternalSource: async () => ({ id: 's1', sourceKind: 'file' }) }
  const puller = new DatabaseSourcePuller({ store, queue: {}, logger: { warn() {} } })
  await assert.rejects(() => puller.pullBatch('sheet'), /not a database source/)
})

test('a database source accepts direct credentials or a legacy env name but rejects literal DSNs', () => {
  assert.equal(validateDatabaseConnection({
    dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_messages', cursorColumn: 'updated_at', idColumn: 'id',
  }), true)
  assert.equal(validateDatabaseConnection({
    host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
    password: 'plain-by-operator-policy', sslMode: 'disable', schema: 'public',
    table: 'tg_monitor_messages', cursorColumn: 'updated_at', idColumn: 'id',
  }), true)
  assert.throws(
    () => validateDatabaseConnection({ dsn: 'postgres://user:secret@db/x', table: 'messages' }),
    /Unsupported database connection fields/,
  )
  assert.throws(
    () => validateDatabaseConnection({
      dsnEnv: 'TG_DATABASE_URL', host: 'database.internal', database: 'night_all',
      username: 'mx_data', password: 'ambiguous', table: 'messages',
    }),
    /either connection\.dsnEnv or direct PostgreSQL credentials/,
  )
})

test('direct source tests reload plaintext credentials for every read-only session', async () => {
  let password = 'first-password'
  const optionsSeen = []
  const store = {
    getExternalSource: async () => ({
      id: 's1', sourceKey: 'direct', sourceKind: 'database', status: 'paused',
      connection: {
        host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
        password, sslMode: 'verify-full', schema: 'public', table: 'tg_monitor_messages',
      },
    }),
    getActiveMapping: async () => null,
  }
  const puller = new DatabaseSourcePuller({
    store,
    queue: null,
    poolFactory: (options) => {
      optionsSeen.push(options)
      return {
        query: async () => ({ rows: [{
          database_name: 'night_all', database_user: 'mx_data', server_version: '16.11', read_only: 'on',
        }] }),
        end: async () => {},
      }
    },
  })

  assert.deepEqual(await puller.testSource('direct'), {
    database: 'night_all', user: 'mx_data', serverVersion: '16.11', readOnly: true,
  })
  password = 'rotated-password'
  await puller.testSource('direct')
  const direct = await store.getExternalSource()
  direct.connection.sslMode = 'verify-ca'
  store.getExternalSource = async () => direct
  await puller.testSource('direct')
  assert.equal(optionsSeen[0].password, 'first-password')
  assert.equal(optionsSeen[1].password, 'rotated-password')
  assert.equal(optionsSeen[0].options, '-c default_transaction_read_only=on')
  assert.equal(optionsSeen[0].connectionTimeoutMillis, 10_000)
  assert.deepEqual(optionsSeen[0].ssl, { rejectUnauthorized: true })
  assert.equal(optionsSeen[2].ssl.rejectUnauthorized, true)
  assert.equal(typeof optionsSeen[2].ssl.checkServerIdentity, 'function')
})

test('source connection failures never echo host, username, or password', async () => {
  const connection = {
    host: 'private.internal', port: 5432, database: 'night_all', username: 'private_user',
    password: 'private-password', sslMode: 'disable', schema: 'public', table: 'messages',
  }
  const puller = new DatabaseSourcePuller({
    store: {}, queue: null,
    poolFactory: () => {
      throw new Error('postgres://private_user:private-password@private.internal/night_all refused')
    },
  })
  await assert.rejects(
    () => puller.testConnection(connection),
    (error) => error?.status === 503
      && error?.code === 'source_connection_failed'
      && !error.message.includes('private.internal')
      && !error.message.includes('private_user')
      && !error.message.includes('private-password'),
  )
})

test('schema and preview driver failures never expose source coordinates to admin logs', async () => {
  const leaked = 'postgres://private_user:private-password@private.internal/night_all'
  const source = {
    id: 's1', sourceKey: 'direct', sourceKind: 'database', status: 'paused',
    connection: {
      host: 'private.internal', port: 5432, database: 'night_all', username: 'private_user',
      password: 'private-password', sslMode: 'disable', schema: 'public', table: 'messages',
    },
  }
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => null,
    },
    queue: null,
    poolFactory: () => ({
      query: async () => { throw new Error(`${leaked} refused`) },
      end: async () => {},
    }),
  })

  for (const [operation, code, message] of [
    [() => puller.describe('direct'), 'source_schema_probe_failed', 'PostgreSQL source schema probe failed'],
    [() => puller.preview('direct'), 'source_preview_failed', 'PostgreSQL source preview failed'],
  ]) {
    let adminError
    try {
      await operation()
    } catch (error) {
      adminError = error
    }
    assert.equal(adminError?.status, 503)
    assert.equal(adminError?.code, code)
    assert.equal(adminError?.message, message)
    const logged = adminError?.stack || adminError?.message
    for (const secret of [leaked, 'private.internal', 'private_user', 'private-password']) {
      assert.equal(logged.includes(secret), false)
    }
  }
})

test('password rotation preserves the checkpoint contract while source generation or coordinates require reset', async () => {
  const source = {
    id: 's1', sourceKey: 'direct', sourceKind: 'database', status: 'paused',
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
    connection: {
      host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
      password: 'first-password', sslMode: 'disable', schema: 'public', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  const mapping = { version: 2, fieldMap: { externalId: { from: 'id' } } }
  let saved = null
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
    },
    queue: { getCursor: async () => saved },
  })

  const initial = await puller.assertCheckpointCompatible('direct')
  saved = { position: { contractHash: initial.contractHash, mappingVersion: 2 } }
  source.connection.password = 'rotated-password'
  const rotated = await puller.assertCheckpointCompatible('direct')
  assert.equal(rotated.contractHash, initial.contractHash)

  source.connection.sourceContractId = '0123456789abcdef0123456789abcdef'
  await assert.rejects(
    () => puller.assertCheckpointCompatible('direct'),
    (error) => error?.status === 409 && error?.code === 'checkpoint_contract_mismatch',
  )

  delete source.connection.sourceContractId
  source.connection.host = 'replacement.internal'
  await assert.rejects(
    () => puller.assertCheckpointCompatible('direct'),
    (error) => error?.status === 409 && error?.code === 'checkpoint_contract_mismatch',
  )
})

test('a managed source rejects a non-empty legacy checkpoint without a contract hash', async () => {
  const source = {
    id: 's-managed-legacy', sourceKey: 'telegram-monitor-messages',
    sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
    connection: {
      host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
      password: 'private', sslMode: 'disable', schema: 'public', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
      sourceContractId: '0123456789abcdef0123456789abcdef',
    },
  }
  const mapping = { version: 2, fieldMap: { externalId: { from: 'id' } } }
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
    },
    queue: {
      getCursor: async () => ({
        position: { cursor: '2026-08-01T00:00:00.000Z', lastId: '42' },
      }),
    },
    poolFactory: () => { throw new Error('source pool must not open before checkpoint validation') },
  })

  for (const operation of [
    () => puller.assertCheckpointCompatible(source.sourceKey),
    () => puller.pullBatch(source.sourceKey),
  ]) {
    await assert.rejects(
      operation,
      (error) => error?.status === 409 && error?.code === 'checkpoint_contract_mismatch',
    )
  }
})

test('a managed Telegram pull attests generation and rejects partition children', async () => {
  const source = {
    id: 's-managed', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
    connection: {
      host: 'database.internal', database: 'night_all', username: 'mx_data', password: 'private',
      sslMode: 'disable', schema: 'public', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
      sourceContractId: '0123456789abcdef0123456789abcdef',
    },
  }
  const mapping = { version: 2, fieldMap: { externalId: { from: 'id' } } }
  let markerSql = ''
  const pool = {
    async query(sql) {
      if (/telegram_monitor_contract/.test(sql)) {
        markerSql = sql
        return { rows: [{
          version: 1, generation: source.connection.sourceContractId,
          chats_match: true, messages_match: true,
          chats_ordinary: false, messages_ordinary: true,
        }] }
      }
      if (
        /FROM pg_trigger/.test(sql)
        || /FROM pg_index/.test(sql)
        || /FROM pg_constraint/.test(sql)
      ) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
    async end() {},
  }
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
    },
    queue: { getCursor: async () => null },
    poolFactory: () => pool,
  })
  await assert.rejects(
    () => puller.pullBatch(source.sourceKey),
    (error) => error?.status === 409 && error?.code === 'source_contract_mismatch',
  )
  assert.match(markerSql, /NOT c\.relispartition/)
  assert.match(markerSql, /FROM pg_inherits i/)
})

test('database schema discovery returns value-free operational metadata and validates the pull index', async () => {
  const source = {
    id: 's1', sourceKey: 'telegram-monitor-messages', displayName: 'Telegram messages',
    sourceKind: 'database', datasetId: 'telegram.monitor.messages.v1', platform: 'telegram',
    objectType: 'message', status: 'paused',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', schema: 'public', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  const mapping = {
    version: 2,
    fieldMap: {
      externalId: { from: ['chat_id', 'message_id'], type: 'composite' },
      eventTime: { from: 'updated_at' },
    },
  }
  const queries = []
  const pool = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('information_schema.columns')) {
        return { rows: [
          { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
          { column_name: 'chat_id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 2 },
          { column_name: 'message_id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 3 },
          { column_name: 'text', data_type: 'text', udt_name: 'text', is_nullable: 'YES', ordinal_position: 4 },
          { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 5 },
        ] }
      }
      if (sql.includes('greatest(c.reltuples')) {
        return { rows: [{ estimated_rows: '123456', total_bytes: '9876543' }] }
      }
      if (sql.includes('FROM pg_indexes')) {
        return { rows: [
          {
            name: 'tg_monitor_messages_pull_idx',
            definition: 'CREATE INDEX tg_monitor_messages_pull_idx ON public.tg_monitor_messages USING btree (updated_at DESC, id DESC)',
          },
          {
            name: 'tg_monitor_messages_pkey',
            definition: 'CREATE UNIQUE INDEX tg_monitor_messages_pkey ON public.tg_monitor_messages USING btree (id)',
          },
        ] }
      }
      if (sql.includes('FROM pg_constraint')) {
        return { rows: [{ name: 'tg_monitor_messages_pkey', type: 'p', definition: 'PRIMARY KEY (id)' }] }
      }
      if (sql.includes('information_schema.triggers')) {
        return { rows: [{ name: 'touch_updated_at', event: 'UPDATE', timing: 'BEFORE', statement: 'EXECUTE FUNCTION touch_updated_at()' }] }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
    async end() {},
  }
  const puller = new DatabaseSourcePuller({
    store: { getExternalSource: async () => source, getActiveMapping: async () => mapping },
    queue: null,
    env: { TG_DATABASE_URL: 'postgres://private.invalid/secret-db' },
    poolFactory: () => pool,
  })
  const result = await puller.describe(source.sourceKey)
  assert.deepEqual(result.issues, [])
  assert.equal(result.estimatedRows, 123456)
  assert.equal(result.totalBytes, 9876543)
  assert.equal(result.indexes[0].name, 'tg_monitor_messages_pull_idx')
  assert.equal(result.constraints[0].type, 'p')
  assert.equal(result.triggers[0].event, 'UPDATE')
  assert.equal(JSON.stringify(result).includes('private.invalid'), false)
  assert.equal(JSON.stringify(result).includes('secret-db'), false)
  assert.equal(queries.some((sql) => /SELECT\s+\*/i.test(sql)), false)
})

test('database schema discovery keeps an unverified source paused by reporting missing cursor configuration', async () => {
  const source = {
    id: 's1', sourceKey: 'telegram-monitor-chats', displayName: 'Telegram chats',
    sourceKind: 'database', datasetId: 'telegram.monitor.chats.v1', platform: 'telegram',
    objectType: 'chat', status: 'paused',
    connection: { dsnEnv: 'TG_DATABASE_URL', schema: 'public', table: 'tg_monitor_chats' },
  }
  const pool = {
    async query(sql) {
      if (sql.includes('information_schema.columns')) {
        return { rows: [{
          column_name: 'chat_id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1,
        }] }
      }
      if (sql.includes('greatest(c.reltuples')) return { rows: [{ estimated_rows: '1', total_bytes: '8192' }] }
      return { rows: [] }
    },
    async end() {},
  }
  const puller = new DatabaseSourcePuller({
    store: { getExternalSource: async () => source, getActiveMapping: async () => null },
    queue: null,
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => pool,
  })
  const result = await puller.describe(source.sourceKey)
  assert.deepEqual(result.cursor, { cursorColumn: null, idColumn: null })
  assert.ok(result.issues.includes('cursorColumn is not configured'))
  assert.ok(result.issues.includes('idColumn is not configured'))
})

test('database schema discovery rejects nullable cursors and partial indexes as full-scan evidence', async () => {
  const source = {
    id: 's1', sourceKey: 'telegram-monitor-chats', displayName: 'Telegram chats',
    sourceKind: 'database', datasetId: 'telegram.monitor.chats.v1', platform: 'telegram',
    objectType: 'chat', status: 'paused',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', schema: 'public', table: 'tg_monitor_chats',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  const pool = {
    async query(sql) {
      if (sql.includes('information_schema.columns')) {
        return { rows: [
          { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
          { column_name: 'chat_id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 2 },
          { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'YES', ordinal_position: 3 },
        ] }
      }
      if (sql.includes('greatest(c.reltuples')) return { rows: [{ estimated_rows: '10', total_bytes: '8192' }] }
      if (sql.includes('FROM pg_indexes')) {
        return { rows: [{
          name: 'unsafe_partial_cursor',
          valid: false,
          ready: false,
          definition: 'CREATE UNIQUE INDEX unsafe_partial_cursor ON public.tg_monitor_chats (updated_at, id) WHERE updated_at IS NOT NULL',
        }] }
      }
      return { rows: [] }
    },
    async end() {},
  }
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => ({
        version: 2,
        fieldMap: { externalId: { from: 'chat_id' }, eventTime: { from: 'updated_at' } },
      }),
    },
    queue: null,
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => pool,
  })
  const result = await puller.describe(source.sourceKey)
  assert.ok(result.issues.includes('cursor column updated_at must be non-null'))
  assert.ok(result.issues.includes('no index begins with (updated_at, id)'))
  assert.ok(result.issues.includes('no unique index proves (updated_at, id) is a total order'))
  assert.equal(result.indexes[0].valid, false)
  assert.equal(result.indexes[0].ready, false)
})

test('database preview returns value-free shapes, never raw row content', async () => {
  const source = {
    id: 's1', sourceKey: 'telegram-monitor-messages', displayName: 'Telegram messages',
    sourceKind: 'database', datasetId: 'telegram.monitor.messages.v1', platform: 'telegram',
    objectType: 'message', status: 'active',
    connection: { dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_messages', cursorColumn: 'updated_at', idColumn: 'id' },
  }
  const mapping = {
    version: 1,
    fieldMap: {
      externalId: { from: ['chat_id', 'message_id'], type: 'composite' },
      body: { from: 'text' },
      eventTime: { from: 'created_at' },
      collectedAt: { from: 'updated_at' },
    },
  }
  const queries = []
  const pool = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('information_schema.columns')) {
        return { rows: ['id', 'chat_id', 'message_id', 'text', 'created_at', 'updated_at'].map((name, index) => ({
          column_name: name, data_type: name.endsWith('_at') ? 'timestamp with time zone' : 'text',
          udt_name: name.endsWith('_at') ? 'timestamptz' : 'text', is_nullable: 'NO', ordinal_position: index + 1,
        })) }
      }
      return { rows: [{
        id: 9, chat_id: '-1007', message_id: 42, text: 'safe text',
        created_at: new Date('2026-08-01T00:00:00Z'), updated_at: new Date('2026-08-02T00:00:00Z'),
        raw: { endpointId: 'private', nested: { token: 'private', safe: 'ok' } },
      }] }
    },
    async end() {},
  }
  const puller = new DatabaseSourcePuller({
    store: { getExternalSource: async () => source, getActiveMapping: async () => mapping },
    queue: null,
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => pool,
  })
  const result = await puller.preview(source.sourceKey)
  assert.deepEqual(result.sampleShapes[0].text, {
    jsonType: 'string', isNull: false, serializedLength: JSON.stringify('safe text').length,
  })
  assert.equal(result.sampleShapes[0].raw.jsonType, 'object')
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('safe text'), false)
  assert.match(queries[1], /LIMIT \$1/)
  assert.equal(/ORDER BY/i.test(queries[1]), false)
})

test('database pull advances a durable total-order cursor only after idempotent ingest', async () => {
  const source = {
    id: 's1', sourceKey: 'telegram-monitor-messages', sourceKind: 'database',
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message', status: 'active',
    connection: { dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_messages', cursorColumn: 'updated_at', idColumn: 'id' },
  }
  const mapping = {
    version: 1,
    fieldMap: {
      externalId: { from: ['chat_id', 'message_id'], type: 'composite' },
      eventTime: { from: 'created_at' },
      collectedAt: { from: 'updated_at' },
    },
  }
  const saved = []
  const ingested = []
  const finished = []
  const rejectedRows = []
  let selectSql = ''
  let queryCount = 0
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
      startImportRun: async () => ({ id: 'run-1', duplicateOf: null }),
      finishImportRun: async (id, result) => finished.push({ id, result }),
      recordRejectedRows: async (id, rows) => rejectedRows.push({ id, rows }),
      ingestExternalRecords: async (input) => {
        ingested.push(input)
        return { ingested: input.records.length, changed: input.records.length }
      },
    },
    queue: {
      getCursor: async () => ({ position: {} }),
      saveCursor: async (id, position, options) => saved.push({ id, position, options }),
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        queryCount += 1
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        selectSql = sql
        return { rows: [{
          id: 10, chat_id: '-1007', message_id: 42,
          created_at: new Date('2026-08-01T01:00:00Z'), updated_at: new Date('2026-08-02T00:00:00Z'),
        }] }
      },
      async end() {},
    }),
  })
  const result = await puller.pullBatch(source.sourceKey, { batchSize: 10 })
  assert.equal(result.done, true)
  assert.equal(result.importRunId, 'run-1')
  assert.equal(ingested[0].records[0].externalId, '-1007:42')
  assert.equal(ingested[0].importRunId, 'run-1')
  assert.equal(queryCount, 2)
  assert.match(selectSql, /"updated_at" IS NOT NULL/)
  assert.match(selectSql, /\("updated_at", "id"\) > \(\$1::timestamptz, \$2::bigint\)/)
  assert.match(selectSql, /ORDER BY "updated_at", "id"/)
  assert.equal(saved.at(-1).position.cursor.toISOString(), '2026-08-02T00:00:00.000Z')
  assert.equal(saved.at(-1).position.lastId, '10')
  assert.equal(saved.at(-1).position.mappingVersion, 1)
  assert.match(saved.at(-1).position.contractHash, /^[a-f0-9]{64}$/)
  assert.equal(saved.at(-1).options.status, 'idle')
  assert.deepEqual(rejectedRows, [])
  assert.equal(finished.at(-1).result.status, 'succeeded')
})

test('database pull preserves PostgreSQL cursor microseconds across checkpoints and fingerprints', async () => {
  const exactCursor = '2026-08-05 03:25:49.438776+00'
  const source = {
    id: 's-precise', sourceKey: 'precise-events', sourceKind: 'database',
    datasetId: 'precise.events.v1', platform: 'telegram', objectType: 'message', status: 'active',
    connection: { dsnEnv: 'TG_DATABASE_URL', table: 'precise_events', cursorColumn: 'updated_at', idColumn: 'id' },
  }
  const mapping = {
    version: 1,
    fieldMap: {
      externalId: { from: 'id' },
      eventTime: { from: 'created_at' },
      collectedAt: { from: 'updated_at' },
    },
  }
  let position = { cursor: '2026-08-05T03:25:49.438Z', lastId: '10' }
  let selectCount = 0
  let firstCheckpoint
  let ingestedBatch
  const selects = []
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
      startImportRun: async () => ({ id: 'run-precise', duplicateOf: null }),
      finishImportRun: async () => {},
      recordRejectedRows: async () => {},
      ingestExternalRecords: async (input) => {
        ingestedBatch = input
        return { ingested: input.records.length, changed: 0 }
      },
    },
    queue: {
      getCursor: async () => ({ status: 'idle', position }),
      saveCursor: async (id, nextPosition, options) => {
        position = nextPosition
        if (options.status === 'idle' && nextPosition.cursor === exactCursor) firstCheckpoint = nextPosition
        return { id, position: nextPosition, status: options.status }
      },
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql, values) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'created_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 3 },
            { column_name: '__mx_insight_cursor_0', data_type: 'text', udt_name: 'text', is_nullable: 'YES', ordinal_position: 4 },
          ] }
        }
        selects.push({ sql, values })
        selectCount += 1
        if (selectCount > 1) return { rows: [] }
        const alias = sql.match(/"updated_at"::text AS "([^"]+)"/)?.[1]
        assert.equal(alias, '__mx_insight_cursor_1', 'the internal alias must avoid source-column collisions')
        return { rows: [{
          id: '10',
          created_at: new Date('2026-08-05T03:00:00Z'),
          updated_at: new Date('2026-08-05T03:25:49.438Z'),
          __mx_insight_cursor_0: 'real-source-field',
          [alias]: exactCursor,
        }] }
      },
      async end() {},
    }),
  })

  const first = await puller.pullBatch(source.sourceKey, { batchSize: 10 })
  assert.equal(first.pulled, 1)
  assert.equal(firstCheckpoint.cursor, exactCursor)
  assert.equal(firstCheckpoint.lastId, '10')
  assert.equal(ingestedBatch.records[0].rawItem.__mx_insight_cursor_0, 'real-source-field')
  assert.equal('__mx_insight_cursor_1' in ingestedBatch.records[0].rawItem, false)
  assert.equal(
    ingestedBatch.batch.pageFingerprint,
    createHash('sha256').update(JSON.stringify([[exactCursor, '10']])).digest('hex'),
  )

  const second = await puller.pullBatch(source.sourceKey, { batchSize: 10 })
  assert.equal(second.pulled, 0)
  assert.deepEqual(selects[1].values.slice(0, 2), [exactCursor, '10'])
})

test('a rejected database row records evidence and does not advance its cursor', async () => {
  const position = {}
  const saved = []
  const finished = []
  const rejectedRows = []
  let ingested = false
  const source = {
    id: 's1', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
    connection: { dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_messages', cursorColumn: 'updated_at', idColumn: 'id' },
  }
  const mapping = {
    version: 3,
    fieldMap: { externalId: { from: 'external_id' }, eventTime: { from: 'updated_at' } },
  }
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
      startImportRun: async () => ({ id: 'run-rejected', duplicateOf: null }),
      recordRejectedRows: async (id, rows) => rejectedRows.push({ id, rows }),
      finishImportRun: async (id, result) => finished.push({ id, result }),
      ingestExternalRecords: async () => { ingested = true },
    },
    queue: {
      getCursor: async () => ({ position }),
      saveCursor: async (id, nextPosition, options) => saved.push({ id, position: nextPosition, options }),
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        return { rows: [
          { id: 3, external_id: 'valid', updated_at: new Date('2026-08-02T00:00:00Z') },
          { id: 4, external_id: null, updated_at: new Date('2026-08-02T00:00:01Z') },
        ] }
      },
      async end() {},
    }),
  })

  await assert.rejects(
    () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
    (error) => error?.code === 'row_rejections_detected',
  )
  assert.equal(ingested, false)
  assert.equal(rejectedRows[0].rows.length, 1)
  assert.equal(finished.at(-1).result.status, 'failed')
  assert.equal(finished.at(-1).result.error, 'row_rejections_detected')
  assert.equal(saved.at(-1).position.cursor, position.cursor)
  assert.equal(saved.at(-1).position.lastId, position.lastId)
  assert.equal(saved.at(-1).position.importRunId, undefined)
  assert.match(saved.at(-1).position.contractHash, /^[a-f0-9]{64}$/)
  assert.equal(saved.at(-1).options.status, 'failed')
})

test('a failed database ingest exposes only a safe worker/job error and leaves its cursor unchanged', async () => {
  const position = {}
  const saved = []
  const finished = []
  const source = {
    id: 's1', sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.chats.v1', platform: 'telegram', objectType: 'chat',
    connection: { dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_chats', cursorColumn: 'updated_at', idColumn: 'id' },
  }
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => ({
        version: 4, fieldMap: { externalId: { from: 'chat_id' }, eventTime: { from: 'updated_at' } },
      }),
      startImportRun: async () => ({ id: 'run-failed', duplicateOf: null }),
      recordRejectedRows: async () => {},
      finishImportRun: async (id, result) => finished.push({ id, result }),
      ingestExternalRecords: async () => {
        const error = new Error('connection to postgres://user:secret@private.invalid failed')
        error.code = 'ECONNRESET'
        throw error
      },
    },
    queue: {
      getCursor: async () => ({ position }),
      saveCursor: async (id, nextPosition, options) => saved.push({ id, position: nextPosition, options }),
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        return { rows: [{ id: 3, chat_id: '-1007', updated_at: new Date('2026-08-02T00:00:00Z') }] }
      },
      async end() {},
    }),
  })

  let workerError
  try {
    await puller.pullBatch(source.sourceKey)
  } catch (error) {
    workerError = error
  }
  assert.equal(workerError?.status, 503)
  assert.equal(workerError?.code, 'ECONNRESET')
  assert.equal(workerError?.message, 'External source pull failed; retry from the last durable checkpoint')
  // mx-common logs the rejected error and persists error.message in
  // mxq.jobs.last_error. Both representations must be safe at this boundary.
  const workerLog = workerError?.stack || workerError?.message
  const jobLastError = workerError?.message
  for (const secret of ['postgres://user:secret@private.invalid', 'private.invalid', 'user', 'secret']) {
    assert.equal(workerLog.includes(secret), false)
    assert.equal(jobLastError.includes(secret), false)
  }
  assert.equal(finished.at(-1).result.status, 'failed')
  assert.equal(finished.at(-1).result.error, 'ECONNRESET')
  assert.equal(JSON.stringify(finished).includes('private.invalid'), false)
  assert.equal(saved.at(-1).position.cursor, position.cursor)
  assert.equal(saved.at(-1).position.lastId, position.lastId)
  assert.equal(saved.at(-1).position.importRunId, undefined)
  assert.match(saved.at(-1).position.contractHash, /^[a-f0-9]{64}$/)
  assert.equal(saved.at(-1).options.error, 'ECONNRESET')
})

test('a reclaimed batch resumes one durable import run after canonical commit but before cursor acknowledgement', async () => {
  const source = {
    id: 'source-crash', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  const mapping = {
    version: 2,
    fieldMap: {
      externalId: { from: 'message_id' },
      eventTime: { from: 'updated_at' },
    },
  }
  let cursor = { position: {}, status: 'idle', processedCount: 0 }
  let failCursorAcknowledgement = true
  const started = []
  const finished = []
  const batches = []
  let ingestAttempt = 0
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
      startImportRun: async (input) => {
        started.push(input)
        return { id: 'run-stable', duplicateOf: null }
      },
      finishImportRun: async (id, result) => finished.push({ id, result }),
      ingestExternalRecords: async (input) => {
        ingestAttempt += 1
        batches.push(input.batch.key)
        return {
          ingested: 1,
          changed: 1,
          deleted: 0,
          ...(ingestAttempt > 1 ? { replayed: true } : {}),
        }
      },
    },
    queue: {
      getCursor: async () => cursor,
      saveCursor: async (id, position, options) => {
        if (position.cursor && failCursorAcknowledgement) {
          failCursorAcknowledgement = false
          throw new Error('cursor checkpoint write failed')
        }
        cursor = {
          position,
          status: options.status,
          processedCount: cursor.processedCount + (options.processedDelta ?? 0),
        }
        return cursor
      },
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        return { rows: [{
          id: 7,
          message_id: '99',
          updated_at: new Date('2026-08-10T00:00:00.000Z'),
        }] }
      },
      async end() {},
    }),
  })

  await assert.rejects(
    () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
    (error) => error?.status === 503
      && error?.code === 'Error'
      && error?.message === 'External source pull failed; retry from the last durable checkpoint',
  )
  assert.equal(cursor.position.importRunId, 'run-stable')
  assert.equal(cursor.position.cursor, undefined)
  assert.equal(finished.length, 0)

  const retried = await puller.pullBatch(source.sourceKey, { batchSize: 10 })
  assert.equal(retried.replayed, true)
  assert.equal(started.length, 1)
  assert.match(started[0].runKey, /^[a-f0-9]{64}$/)
  assert.deepEqual(batches, [batches[0], batches[0]])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].result.status, 'succeeded')
  assert.equal(cursor.status, 'idle')
  assert.equal(cursor.position.importRunId, undefined)
  assert.equal(cursor.position.lastId, '7')
  assert.equal(cursor.processedCount, 1)
})

test('an ambiguous canonical COMMIT keeps the same run and batch for evidence-based retry', async () => {
  const source = {
    id: 'source-unknown', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  const mapping = {
    version: 2,
    fieldMap: { externalId: { from: 'message_id' }, eventTime: { from: 'updated_at' } },
  }
  let cursor = { position: {}, status: 'idle', processedCount: 0 }
  let committedEvidence = null
  let started = 0
  const finished = []
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
      getImportRunState: async () => ({ id: 'run-unknown', sourceId: source.id, status: 'running' }),
      getImportBatch: async () => committedEvidence,
      startImportRun: async () => {
        started += 1
        return { id: 'run-unknown', duplicateOf: null }
      },
      ingestExternalRecords: async (input) => {
        committedEvidence = {
          key: input.batch.key,
          cursorEnd: input.batch.cursorEnd,
          rowCount: input.batch.rowCount,
          ingested: 1,
          changed: 1,
          deleted: 0,
          rejected: 0,
          status: 'succeeded',
        }
        const error = new Error('commit acknowledgement lost')
        error.code = 'external_commit_outcome_unknown'
        throw error
      },
      finishImportRun: async (id, result) => finished.push({ id, result }),
    },
    queue: {
      getCursor: async () => cursor,
      saveCursor: async (id, position, options) => {
        cursor = {
          position,
          status: options.status,
          processedCount: cursor.processedCount + (options.processedDelta ?? 0),
        }
        return cursor
      },
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        return { rows: [{
          id: 7, message_id: '99', updated_at: new Date('2026-08-10T00:00:00.000Z'),
        }] }
      },
      async end() {},
    }),
  })

  await assert.rejects(
    () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
    (error) => error?.code === 'external_commit_outcome_unknown',
  )
  assert.equal(cursor.status, 'running')
  assert.equal(cursor.position.importRunId, 'run-unknown')
  assert.equal(finished.length, 0)

  const retried = await puller.pullBatch(source.sourceKey, { batchSize: 10 })
  assert.equal(retried.replayed, true)
  assert.equal(started, 1)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].result.status, 'succeeded')
  assert.equal(cursor.status, 'idle')
  assert.equal(cursor.processedCount, 1)
})

test('a checkpoint can resume only its running import run for the same source', async () => {
  const source = {
    id: 'source-owner', sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.chats.v1', platform: 'telegram', objectType: 'chat',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_chats',
      cursorColumn: 'updated_at', idColumn: 'chat_id',
    },
  }
  for (const runState of [
    { id: 'run-terminal', sourceId: source.id, status: 'succeeded' },
    { id: 'run-terminal', sourceId: 'another-source', status: 'running' },
  ]) {
    const puller = new DatabaseSourcePuller({
      store: {
        getExternalSource: async () => source,
        getActiveMapping: async () => ({
          version: 1,
          fieldMap: { externalId: { from: 'chat_id' }, eventTime: { from: 'updated_at' } },
        }),
        getImportRunState: async () => runState,
      },
      queue: {
        getCursor: async () => ({ position: { importRunId: 'run-terminal' }, status: 'running' }),
      },
      env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
      poolFactory: () => { throw new Error('an invalid checkpoint must not read upstream') },
    })
    await assert.rejects(
      () => puller.pullBatch(source.sourceKey),
      (error) => error?.code === 'import_run_checkpoint_invalid',
    )
  }
})

test('a committed replay advances from stored cursor evidence without rereading a drifted source page', async () => {
  const source = {
    id: 'source-replay', sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.messages.v1', platform: 'telegram', objectType: 'message',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_messages',
      cursorColumn: 'updated_at', idColumn: 'id',
    },
  }
  const storedEnd = {
    cursor: '2026-08-10T00:00:05.000Z', lastId: '9',
    contractHash: 'a'.repeat(64), mappingVersion: 2,
  }
  let finalized = null
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => ({
        version: 2,
        fieldMap: { externalId: { from: 'message_id' }, eventTime: { from: 'updated_at' } },
      }),
      getImportRunState: async () => ({ id: 'run-replay', sourceId: source.id, status: 'running' }),
      getImportBatch: async () => ({
        key: 'batch', cursorEnd: storedEnd, rowCount: 1,
        ingested: 1, changed: 1, deleted: 0, rejected: 0, status: 'succeeded',
      }),
      finalizeExternalImportRun: async (input) => {
        finalized = input
        return { cursor: { position: input.position, status: input.cursorStatus } }
      },
    },
    queue: {
      getCursor: async () => ({
        position: { cursor: '2026-08-10T00:00:00.000Z', lastId: '2', importRunId: 'run-replay' },
        status: 'running',
      }),
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => { throw new Error('a replay must not read a page that may have drifted') },
  })

  const result = await puller.pullBatch(source.sourceKey, { batchSize: 10, importRunId: 'run-replay' })
  assert.equal(result.replayed, true)
  assert.equal(result.done, true)
  assert.deepEqual(finalized.position, storedEnd)
  assert.equal(finalized.processedDelta, 1)
  assert.equal(finalized.status, 'succeeded')
})

test('pausing during a full batch closes the run successfully at that batch boundary', async () => {
  const activeSource = {
    id: 'source-pause', sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.chats.v1', platform: 'telegram', objectType: 'chat',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_chats',
      cursorColumn: 'updated_at', idColumn: 'chat_id',
    },
  }
  let sourceRead = 0
  let cursor = { position: {}, status: 'idle' }
  let finalized = null
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => {
        sourceRead += 1
        return sourceRead === 1 ? activeSource : { ...activeSource, status: 'paused' }
      },
      getActiveMapping: async () => ({
        version: 1,
        fieldMap: { externalId: { from: 'chat_id' }, eventTime: { from: 'updated_at' } },
      }),
      startImportRun: async () => ({ id: 'run-pause', duplicateOf: null }),
      ingestExternalRecords: async (input) => ({
        ingested: 1, changed: 1, deleted: 0,
        rowCount: 1, cursorEnd: input.batch.cursorEnd,
      }),
      finalizeExternalImportRun: async (input) => {
        finalized = input
        cursor = { position: input.position, status: input.cursorStatus }
        return { cursor }
      },
    },
    queue: {
      getCursor: async () => cursor,
      saveCursor: async (id, position, options) => {
        cursor = { position, status: options.status }
        return cursor
      },
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'chat_id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        return { rows: [{ chat_id: -1007, updated_at: new Date('2026-08-10T00:00:00.000Z') }] }
      },
      async end() {},
    }),
  })

  const result = await puller.pullBatch(activeSource.sourceKey, { batchSize: 1 })
  assert.equal(result.paused, true)
  assert.equal(result.done, true)
  assert.equal(finalized.status, 'succeeded')
  assert.equal(finalized.cursorStatus, 'idle')
  assert.equal(finalized.position.importRunId, undefined)
})

test('source lock helpers expose deterministic multi-source serialization', async () => {
  const acquired = []
  const puller = new DatabaseSourcePuller({
    store: {
      withExternalSourceLock: async (key, operation) => {
        acquired.push(key)
        return operation()
      },
    },
    queue: null,
  })
  const result = await puller.withSourceLocks(['z-source', 'a-source', 'z-source'], async () => 'done')
  assert.equal(result, 'done')
  assert.deepEqual(acquired, ['a-source', 'z-source'])
})

test('a lost source lock after reading a page prevents canonical ingest and cursor advancement', async () => {
  const source = {
    id: 'source-lock-loss', sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.chats.v1', platform: 'telegram', objectType: 'chat',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_chats',
      cursorColumn: 'updated_at', idColumn: 'chat_id',
    },
  }
  let guardCalls = 0
  let canonicalWritten = false
  const saved = []
  const puller = new DatabaseSourcePuller({
    store: {
      withExternalSourceLock: async (key, operation) => operation(async () => {
        guardCalls += 1
        if (guardCalls >= 4) {
          const error = new Error('source lock lost')
          error.code = 'source_lock_lost'
          throw error
        }
      }),
      getExternalSource: async () => source,
      getActiveMapping: async () => ({
        version: 1,
        fieldMap: { externalId: { from: 'chat_id' }, eventTime: { from: 'updated_at' } },
      }),
      startImportRun: async () => ({ id: 'run-lock-loss', duplicateOf: null }),
      finishImportRun: async () => {},
      ingestExternalRecords: async () => { canonicalWritten = true },
    },
    queue: {
      getCursor: async () => ({ position: {} }),
      saveCursor: async (id, position, options) => saved.push({ position, options }),
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'chat_id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        return { rows: [{ chat_id: -1007, updated_at: new Date('2026-08-10T00:00:00.000Z') }] }
      },
      async end() {},
    }),
  })

  await assert.rejects(
    () => puller.pullBatch(source.sourceKey),
    (error) => error?.code === 'source_lock_lost',
  )
  assert.equal(canonicalWritten, false)
  assert.equal(saved.at(-1).position.cursor, undefined)
  assert.equal(saved.at(-1).position.importRunId, 'run-lock-loss')
})

test('checkpoint reset cannot race an in-flight pull and wins after the source becomes idle', async () => {
  let source = {
    id: 'source-lock', sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.chats.v1', platform: 'telegram', objectType: 'chat',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_chats',
      cursorColumn: 'updated_at', idColumn: 'chat_id',
    },
  }
  const mapping = {
    version: 2,
    fieldMap: { externalId: { from: 'chat_id' }, eventTime: { from: 'updated_at' } },
  }
  let cursor = { position: {}, status: 'idle' }
  let releaseRows
  let rowsStarted
  const rowGate = new Promise((resolve) => { releaseRows = resolve })
  const rowStarted = new Promise((resolve) => { rowsStarted = resolve })
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
      startImportRun: async () => ({ id: 'run-locked', duplicateOf: null }),
      finishImportRun: async () => {},
      ingestExternalRecords: async () => ({ ingested: 1, changed: 1, deleted: 0 }),
    },
    queue: {
      getCursor: async () => cursor,
      saveCursor: async (id, position, options) => {
        cursor = { position, status: options.status }
        return cursor
      },
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'chat_id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        rowsStarted()
        await rowGate
        return { rows: [{ chat_id: -1007, updated_at: new Date('2026-08-10T00:00:00.000Z') }] }
      },
      async end() {},
    }),
  })

  const inFlight = puller.pullBatch(source.sourceKey, { batchSize: 10 })
  await rowStarted
  source = { ...source, status: 'paused' }
  await assert.rejects(
    () => puller.resetCheckpoint(source.sourceKey),
    (error) => error?.status === 409 && error?.code === 'source_busy',
  )
  releaseRows()
  await inFlight

  await puller.resetCheckpoint(source.sourceKey)
  assert.equal(cursor.status, 'idle')
  assert.equal(cursor.position.cursor, undefined)
  assert.equal(cursor.position.importRunId, undefined)
  assert.ok(cursor.position.resetAt)
})

test('external pull worker hands an unfinished batch to a distinct continuation', async () => {
  const enqueued = []
  const heartbeats = []
  let intervalHeartbeat
  let intervalCleared = false
  const result = await runExternalPullJob({
    puller: {
      pullBatch: async (sourceKey, options) => {
        assert.equal(sourceKey, 'telegram-monitor-messages')
        assert.equal(options.batchSize, 2500)
        await intervalHeartbeat()
        return {
          pulled: 2500, ingested: 2500, changed: 20, rejected: 0,
          importRunId: 'run-logical-1', done: false,
        }
      },
    },
    queue: {
      heartbeat: async (id) => heartbeats.push(id),
      enqueue: async (...args) => enqueued.push(args),
    },
    payload: { sourceKey: 'telegram-monitor-messages', batchSize: 2500, chunk: 7 },
    job: { id: 99 },
    signal: { aborted: false },
    logger: { log() {} },
    setIntervalFn: (callback) => {
      intervalHeartbeat = callback
      return { unref() {} }
    },
    clearIntervalFn: () => { intervalCleared = true },
  })
  assert.equal(result.done, false)
  assert.deepEqual(heartbeats, [99, 99, 99])
  assert.equal(intervalCleared, true)
  assert.deepEqual(enqueued, [[
    'external-pull',
    { sourceKey: 'telegram-monitor-messages', batchSize: 2500, importRunId: 'run-logical-1', chunk: 8 },
    { dedupeKey: 'external-pull:telegram-monitor-messages:8', priority: 220 },
  ]])
})

test('an exhausted continuation enqueue marks its cursor failed while preserving the import run id', async () => {
  for (const [attempts, shouldClose] of [[4, false], [5, true]]) {
    const closed = []
    const puller = {
      pullBatch: async () => ({
        pulled: 10, ingested: 10, changed: 1, rejected: 0,
        importRunId: 'run-continuation', done: false,
      }),
      markContinuationFailed: async (...args) => closed.push(args),
    }
    await assert.rejects(
      () => runExternalPullJob({
        puller,
        queue: {
          heartbeat: async () => {},
          enqueue: async () => { throw new Error('queue unavailable') },
        },
        payload: { sourceKey: 'telegram-monitor-messages', chunk: 2 },
        job: { id: 7, attempts, max_attempts: 5 },
        logger: { log() {}, error() {} },
      }),
      /queue unavailable/,
    )
    assert.equal(closed.length, shouldClose ? 1 : 0)
    if (shouldClose) {
      assert.deepEqual(closed[0], [
        'telegram-monitor-messages', 'run-continuation', 'continuation_enqueue_failed',
      ])
    }
  }
})

test('an exhausted ambiguous pull marks its checkpoint failed even before a continuation result exists', async () => {
  for (const [attempts, shouldMark] of [[4, false], [5, true]]) {
    const marked = []
    const error = new Error('commit acknowledgement lost')
    error.code = 'external_commit_outcome_unknown'
    await assert.rejects(
      () => runExternalPullJob({
        puller: {
          pullBatch: async () => { throw error },
          markContinuationFailed: async (...args) => marked.push(args),
        },
        queue: { heartbeat: async () => {} },
        payload: { sourceKey: 'telegram-monitor-messages', chunk: 2 },
        job: { id: 7, attempts, max_attempts: 5 },
        logger: { log() {}, error() {} },
      }),
      (actual) => actual === error,
    )
    assert.equal(marked.length, shouldMark ? 1 : 0)
    if (shouldMark) {
      assert.deepEqual(marked[0], [
        'telegram-monitor-messages', null, 'external_commit_outcome_unknown',
      ])
    }
  }
})

test('operator-action import failures complete the queue job without retrying or advancing', async () => {
  for (const code of ['row_rejections_detected', 'import_batch_failed']) {
    let enqueued = false
    let marked = false
    const error = new Error(code)
    error.code = code
    const result = await runExternalPullJob({
      puller: {
        pullBatch: async () => { throw error },
        markContinuationFailed: async () => { marked = true },
      },
      queue: {
        heartbeat: async () => {},
        enqueue: async () => { enqueued = true },
      },
      payload: { sourceKey: 'telegram-monitor-messages', chunk: 2 },
      job: { id: 7, attempts: 1, max_attempts: 5 },
      logger: { log() {}, warn() {}, error() {} },
    })
    assert.deepEqual(result, {
      pulled: 0, ingested: 0, changed: 0, rejected: 0,
      done: true, failed: true, error: code,
    })
    assert.equal(enqueued, false)
    assert.equal(marked, false)
  }
})

test('source contract drift marks its cursor failed so periodic scheduling cannot loop', async () => {
  const marked = []
  const error = new Error('contract drift')
  error.code = 'source_contract_mismatch'
  const result = await runExternalPullJob({
    puller: {
      pullBatch: async () => { throw error },
      markSourceContractFailed: async (...args) => marked.push(args),
    },
    queue: { heartbeat: async () => {} },
    payload: { sourceKey: 'telegram-monitor-messages', chunk: 0 },
    job: { id: 7, attempts: 1, max_attempts: 5 },
    logger: { log() {}, warn() {} },
  })
  assert.deepEqual(marked, [['telegram-monitor-messages', 'source_contract_mismatch']])
  assert.deepEqual(result, {
    pulled: 0, ingested: 0, changed: 0, rejected: 0,
    done: true, failed: true, error: 'source_contract_mismatch',
  })
})

test('a manual sync resumes the same running import after continuation enqueue exhaustion', async () => {
  const source = {
    id: 'source-resume', sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active',
    datasetId: 'telegram.monitor.chats.v1', platform: 'telegram', objectType: 'chat',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_chats',
      cursorColumn: 'updated_at', idColumn: 'chat_id',
    },
  }
  let runStatus = 'running'
  let markAttempts = 0
  let cursor = {
    position: {
      cursor: '2026-08-10T00:00:00.000Z', lastId: '-1008', importRunId: 'run-resume',
    },
    status: 'running',
  }
  let finalizedRunId = null
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => ({
        version: 1,
        fieldMap: { externalId: { from: 'chat_id' }, eventTime: { from: 'updated_at' } },
      }),
      getImportRunState: async () => ({ id: 'run-resume', sourceId: source.id, status: runStatus }),
      getImportBatch: async () => null,
      markExternalImportCursorFailed: async (input) => {
        markAttempts += 1
        if (markAttempts === 1) {
          const error = new Error('cursor failure commit acknowledgement lost')
          error.code = 'external_cursor_failure_outcome_unknown'
          throw error
        }
        cursor = { position: input.position, status: 'failed', lastError: input.error }
        return { cursor }
      },
      startImportRun: async () => { throw new Error('manual resume must not fork a new run') },
      ingestExternalRecords: async (input) => ({
        ingested: 1, changed: 1, deleted: 0,
        rowCount: 1, cursorEnd: input.batch.cursorEnd,
      }),
      finalizeExternalImportRun: async (input) => {
        finalizedRunId = input.importRunId
        runStatus = input.status
        cursor = { position: input.position, status: input.cursorStatus }
        return { cursor }
      },
    },
    queue: {
      getCursor: async () => cursor,
      saveCursor: async (id, position, options) => {
        cursor = { position, status: options.status }
        return cursor
      },
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/db' },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: [
            { column_name: 'chat_id', data_type: 'bigint', udt_name: 'int8', is_nullable: 'NO', ordinal_position: 1 },
            { column_name: 'updated_at', data_type: 'timestamp with time zone', udt_name: 'timestamptz', is_nullable: 'NO', ordinal_position: 2 },
          ] }
        }
        return { rows: [{ chat_id: -1007, updated_at: new Date('2026-08-10T00:00:01.000Z') }] }
      },
      async end() {},
    }),
  })

  await puller.markContinuationFailed(source.sourceKey, 'run-resume')
  assert.equal(cursor.status, 'failed')
  assert.equal(cursor.position.importRunId, 'run-resume')
  assert.equal(runStatus, 'running')
  assert.equal(markAttempts, 2)

  const resumed = await puller.pullBatch(source.sourceKey, { batchSize: 10 })
  assert.equal(resumed.done, true)
  assert.equal(finalizedRunId, 'run-resume')
  assert.equal(runStatus, 'succeeded')
  assert.equal(cursor.position.importRunId, undefined)
})

test('external pull worker stops when complete but durably hands off an unfinished shutdown batch', async () => {
  for (const [done, aborted, shouldEnqueue] of [[true, false, false], [false, true, true]]) {
    let enqueued = false
    await runExternalPullJob({
      puller: { pullBatch: async () => ({ pulled: 0, ingested: 0, done }) },
      queue: { heartbeat: async () => {}, enqueue: async () => { enqueued = true } },
      payload: { sourceKey: 'telegram-monitor-chats', chunk: 0 },
      job: { id: 1 },
      signal: { aborted },
      logger: { log() {} },
    })
    assert.equal(enqueued, shouldEnqueue)
  }
})

test('periodic external scheduling selects only active database sources with per-source dedupe', async () => {
  const calls = []
  const result = await scheduleActiveDatabaseSources({
    store: {
      listExternalSources: async () => [
        { sourceKey: 'warehouse-ready', sourceKind: 'database', status: 'active' },
        { sourceKey: 'warehouse-running', sourceKind: 'database', status: 'active' },
        { sourceKey: 'telegram-monitor-failed', sourceKind: 'database', status: 'active' },
        { sourceKey: 'telegram-monitor-paused', sourceKind: 'database', status: 'paused' },
        { sourceKey: 'weekly-file', sourceKind: 'file', status: 'active' },
      ],
    },
    queue: {
      getCursor: async (id) => ({
        'external:warehouse-ready': { status: 'idle' },
        'external:warehouse-running': { status: 'running' },
        'external:telegram-monitor-failed': { status: 'failed' },
      })[id] ?? null,
      enqueue: async (...args) => {
        calls.push(args)
        return 77
      },
    },
    batchSize: 750,
  })
  assert.deepEqual(result, { active: 3, enqueued: 1 })
  assert.deepEqual(calls, [[
    'external-pull',
    { sourceKey: 'warehouse-ready', batchSize: 750, trigger: 'schedule', chunk: 0 },
    { dedupeKey: 'external-pull:warehouse-ready:0', priority: 220 },
  ]])
})

test('periodic Telegram scheduling waits for both inputs and commits the due pair together', async () => {
  const sources = [
    {
      sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active',
      syncIntervalSeconds: 300,
    },
    {
      sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active',
      syncIntervalSeconds: 300,
    },
  ]
  const statements = []
  const enqueues = []
  const client = {
    query: async (sql) => { statements.push(sql); return { rows: [] } },
    release() {},
  }
  const queue = {
    pool: { connect: async () => client },
    getCursor: async (id) => ({
      status: 'idle',
      updatedAt: id.endsWith('chats')
        ? '2026-08-10T07:50:00.000Z'
        : '2026-08-10T07:58:00.000Z',
    }),
    enqueue: async (name, payload, options) => {
      assert.equal(options.client, client)
      enqueues.push([name, payload, options.dedupeKey])
      return enqueues.length
    },
  }
  let latestAttestation = null
  const store = {
    listExternalSources: async () => sources,
    getLatestPipelineWriterContractAttestation: async () => latestAttestation,
  }

  const early = await scheduleActiveDatabaseSources({
    store, queue, now: new Date('2026-08-10T08:00:00.000Z'), batchSize: 750,
  })
  assert.deepEqual(early, { active: 2, enqueued: 0 })
  assert.deepEqual(enqueues, [])

  const unattested = await scheduleActiveDatabaseSources({
    store, queue, now: new Date('2026-08-10T08:04:00.000Z'), batchSize: 750,
  })
  assert.deepEqual(unattested, { active: 2, enqueued: 0 })
  assert.deepEqual(enqueues, [])

  latestAttestation = {
    contractVersion: 'telegram-monitor.writer.v1',
    contractDigest: TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
  }
  const due = await scheduleActiveDatabaseSources({
    store, queue, now: new Date('2026-08-10T08:04:00.000Z'), batchSize: 750,
  })
  assert.deepEqual(due, { active: 2, enqueued: 2 })
  assert.deepEqual(statements, ['BEGIN', 'COMMIT'])
  assert.deepEqual(enqueues.map(([, payload]) => payload.sourceKey), [
    'telegram-monitor-chats',
    'telegram-monitor-messages',
  ])
})

test('periodic SQLite API scheduling atomically enqueues the due pair with a capped batch', async () => {
  const sources = [
    { sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active' },
    { sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active' },
    {
      sourceKey: 'telegram-sqlite-api-chats', sourceKind: 'sqlite_api', status: 'active',
      syncIntervalSeconds: 300,
    },
    {
      sourceKey: 'telegram-sqlite-api-messages', sourceKind: 'sqlite_api', status: 'active',
      syncIntervalSeconds: 300,
    },
  ]
  const statements = []
  const enqueues = []
  const client = {
    query: async (sql) => { statements.push(sql); return { rows: [] } },
    release() {},
  }
  let messageCursor = {
    status: 'idle',
    updatedAt: '2026-08-10T07:58:00.000Z',
  }
  const queue = {
    pool: { connect: async () => client },
    getCursor: async (id) => {
      if (id === 'external:telegram-sqlite-api-chats') {
        return { status: 'idle', updatedAt: '2026-08-10T07:50:00.000Z' }
      }
      if (id === 'external:telegram-sqlite-api-messages') return messageCursor
      return { status: 'idle' }
    },
    enqueue: async (name, payload, options) => {
      assert.equal(options.client, client)
      enqueues.push([name, payload, options.dedupeKey])
      return enqueues.length
    },
  }
  const store = {
    listExternalSources: async () => sources,
    // An unattested PostgreSQL Telegram monitor must not suppress the
    // independent SQLite API pipeline.
    getLatestPipelineWriterContractAttestation: async () => null,
  }

  const early = await scheduleActiveDatabaseSources({
    store, queue, now: new Date('2026-08-10T08:00:00.000Z'), batchSize: 1_000,
  })
  assert.deepEqual(early, { active: 4, enqueued: 0 })
  assert.deepEqual(enqueues, [])

  messageCursor = { status: 'running', updatedAt: '2026-08-10T07:50:00.000Z' }
  const busy = await scheduleActiveDatabaseSources({
    store, queue, now: new Date('2026-08-10T08:04:00.000Z'), batchSize: 1_000,
  })
  assert.deepEqual(busy, { active: 4, enqueued: 0 })
  assert.deepEqual(enqueues, [])

  messageCursor = { status: 'idle', updatedAt: '2026-08-10T07:50:00.000Z' }
  const due = await scheduleActiveDatabaseSources({
    store, queue, now: new Date('2026-08-10T08:04:00.000Z'), batchSize: 1_000,
  })
  assert.deepEqual(due, { active: 4, enqueued: 2 })
  assert.deepEqual(statements, ['BEGIN', 'COMMIT'])
  assert.deepEqual(enqueues.map(([, payload]) => ({
    sourceKey: payload.sourceKey,
    batchSize: payload.batchSize,
    trigger: payload.trigger,
  })), [
    { sourceKey: 'telegram-sqlite-api-chats', batchSize: 500, trigger: 'schedule' },
    { sourceKey: 'telegram-sqlite-api-messages', batchSize: 500, trigger: 'schedule' },
  ])
})

test('periodic Telegram scheduling rolls back both jobs when the second enqueue fails', async () => {
  const statements = []
  const staged = []
  const committed = []
  const client = {
    async query(sql) {
      statements.push(sql)
      if (sql === 'COMMIT') committed.push(...staged)
      if (sql === 'ROLLBACK') staged.length = 0
      return { rows: [] }
    },
    release() {},
  }
  const queue = {
    pool: { connect: async () => client },
    getCursor: async () => ({ status: 'idle' }),
    enqueue: async (_name, payload, options) => {
      assert.equal(options.client, client)
      if (payload.sourceKey === 'telegram-monitor-messages') throw new Error('queue unavailable')
      staged.push(payload.sourceKey)
      return 1
    },
  }
  await assert.rejects(
    () => scheduleActiveDatabaseSources({
      store: {
        listExternalSources: async () => [
          { sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active' },
          { sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active' },
        ],
        getLatestPipelineWriterContractAttestation: async () => ({
          contractVersion: 'telegram-monitor.writer.v1',
          contractDigest: TELEGRAM_MONITOR_WRITER_CONTRACT_DIGEST,
        }),
      },
      queue,
    }),
    (error) => error?.code === 'telegram_schedule_failed',
  )
  assert.deepEqual(statements, ['BEGIN', 'ROLLBACK'])
  assert.deepEqual(committed, [])
  assert.deepEqual(staged, [])
})

test('periodic external scheduling honours each source interval using its durable cursor time', async () => {
  const calls = []
  const now = new Date('2026-08-10T08:00:00.000Z')
  const result = await scheduleActiveDatabaseSources({
    store: {
      listExternalSources: async () => [
        {
          sourceKey: 'not-due', sourceKind: 'database', status: 'active', syncIntervalSeconds: 300,
        },
        {
          sourceKey: 'due', sourceKind: 'database', status: 'active', syncIntervalSeconds: 60,
        },
      ],
    },
    queue: {
      getCursor: async (id) => ({
        status: 'idle',
        updatedAt: id.endsWith('not-due')
          ? '2026-08-10T07:58:00.000Z'
          : '2026-08-10T07:58:59.000Z',
      }),
      enqueue: async (...args) => {
        calls.push(args)
        return 1
      },
    },
    batchSize: 500,
    now,
  })
  assert.deepEqual(result, { active: 2, enqueued: 1 })
  assert.equal(calls[0][1].sourceKey, 'due')
  assert.equal(calls[0][1].trigger, 'schedule')
})

test('checkpoint contracts reject table or mapping drift and reset only while paused', async () => {
  let source = {
    id: 'source-1', sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'paused',
    datasetId: 'telegram.monitor.chats.v1', platform: 'telegram', objectType: 'chat',
    connection: {
      dsnEnv: 'TG_DATABASE_URL', schema: 'public', table: 'tg_monitor_chats',
      cursorColumn: 'updated_at', idColumn: 'chat_id',
    },
  }
  const mapping = { version: 2, fieldMap: { externalId: { from: 'chat_id' }, eventTime: { from: 'first_seen_at' } } }
  let cursor = { position: {} }
  const saves = []
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
    },
    queue: {
      getCursor: async () => cursor,
      saveCursor: async (id, position, options) => {
        saves.push({ id, position, options })
        cursor = { position, status: options.status }
        return cursor
      },
    },
    env: { TG_DATABASE_URL: 'postgres://private.invalid/night_all' },
  })

  const compatible = await puller.assertCheckpointCompatible(source.sourceKey)
  cursor = {
    position: {
      contractHash: compatible.contractHash,
      mappingVersion: compatible.mappingVersion,
      cursor: '2026-08-10T00:00:00.000Z',
      lastId: '-1007',
    },
  }
  source = { ...source, connection: { ...source.connection, table: 'tg_monitor_chats_v2' } }
  await assert.rejects(
    () => puller.assertCheckpointCompatible(source.sourceKey),
    (error) => error?.status === 409 && error?.code === 'checkpoint_contract_mismatch',
  )

  source = { ...source, connection: { ...source.connection, table: 'tg_monitor_chats' } }
  const reset = await puller.resetCheckpoint(source.sourceKey)
  assert.equal(reset.status, 'idle')
  assert.equal(saves.at(-1).position.cursor, undefined)
  assert.match(saves.at(-1).position.contractHash, /^[a-f0-9]{64}$/)
  assert.ok(saves.at(-1).position.resetAt)

  source = { ...source, status: 'active' }
  await assert.rejects(
    () => puller.resetCheckpoint(source.sourceKey),
    (error) => error?.status === 409 && error?.code === 'source_pause_required',
  )
})

test('PostgresStore rejects terminal or cross-source runs before any canonical write', async () => {
  for (const runRow of [
    { id: 'run-1', source_id: 'source-1', status: 'succeeded' },
    { id: 'run-1', source_id: 'source-2', status: 'running' },
  ]) {
    const queries = []
    const client = {
      async query(sql) {
        queries.push(sql)
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (sql.includes('FROM ingest.import_runs')) return { rows: [runRow], rowCount: 1 }
        throw new Error(`unexpected canonical query: ${sql}`)
      },
      release() {},
    }
    const store = new PostgresStore({ connect: async () => client })
    await assert.rejects(
      () => store.ingestExternalRecords({
        datasetId: 'dataset', platform: 'telegram', connectorId: 'external:test',
        sourceId: 'source-1', importRunId: 'run-1', records: [{}],
      }),
      (error) => error?.code === 'import_run_not_running',
    )
    assert.equal(queries.some((sql) => sql.includes('INSERT INTO ingest.source_objects')), false)
    assert.equal(queries.at(-1), 'ROLLBACK')
  }
})

test('a reclaimed file claim fences the old run before its writer can touch canonical state', async () => {
  const sourceId = '22222222-2222-4222-8222-222222222222'
  const oldRunId = '33333333-3333-4333-8333-333333333333'
  const runs = new Map([[
    oldRunId,
    {
      id: oldRunId,
      source_id: sourceId,
      input_sha256: 'a'.repeat(64),
      interpretation_key: 'b'.repeat(64),
      status: 'running',
      trigger: 'manual',
    },
  ]])
  const queries = []
  let canonicalWrites = 0
  let releases = 0

  const query = async (sql, values = []) => {
    queries.push({ sql, values })
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }
    if (/UPDATE ingest\.import_runs\s+SET status = 'failed'/.test(sql)) {
      let rowCount = 0
      for (const run of runs.values()) {
        if (run.source_id === values[0] && run.input_sha256 && run.status === 'running') {
          run.status = 'failed'
          run.last_error = 'superseded_by_new_file_import'
          rowCount += 1
        }
      }
      return { rows: [], rowCount }
    }
    if (/SELECT id, started_at FROM ingest\.import_runs/.test(sql)) {
      const rows = [...runs.values()].filter((run) => (
        run.source_id === values[0]
        && run.input_sha256 === values[1]
        && run.interpretation_key === values[2]
        && run.status === 'succeeded'
      ))
      return { rows, rowCount: rows.length }
    }
    if (/INSERT INTO ingest\.import_runs/.test(sql)) {
      const run = {
        id: values[0], source_id: values[1], input_sha256: values[3],
        interpretation_key: values[6], status: 'running', trigger: values[8],
      }
      runs.set(run.id, run)
      return { rows: [{ id: run.id }], rowCount: 1 }
    }
    if (/SELECT id, source_id, status\s+FROM ingest\.import_runs/.test(sql)) {
      const run = runs.get(values[0])
      return { rows: run ? [run] : [], rowCount: run ? 1 : 0 }
    }
    if (/UPDATE ingest\.import_runs\s+SET status = \$2/.test(sql)) {
      const run = runs.get(values[0])
      if (!run || (run.status !== 'running' && run.status !== values[1])) {
        return { rows: [], rowCount: 0 }
      }
      run.status = values[1]
      return { rows: [], rowCount: 1 }
    }
    if (/ingest\.source_objects|core\.canonical_records|outbox\.projection_events/.test(sql)) {
      canonicalWrites += 1
    }
    throw new Error(`unexpected SQL after run fence: ${sql}`)
  }
  const sessionClient = {
    query,
    release() { releases += 1 },
  }
  const store = new PostgresStore({ query, connect: async () => sessionClient })

  const claim = await store.startImportRun({
    sourceId,
    mappingVersion: 2,
    inputSha256: 'c'.repeat(64),
    interpretationKey: 'd'.repeat(64),
    inputName: 'retry.csv',
    inputBytes: 12,
    sessionClient,
  })
  assert.equal(runs.get(oldRunId).status, 'failed')
  assert.equal(runs.get(oldRunId).last_error, 'superseded_by_new_file_import')
  assert.equal(runs.get(claim.id).status, 'running')

  await assert.rejects(
    () => store.ingestExternalRecords({
      datasetId: 'dataset', platform: 'external', connectorId: 'external:files',
      sourceId, importRunId: oldRunId, records: [{}], sessionClient,
    }),
    (error) => error?.code === 'import_run_not_running',
  )
  const lateFinish = await store.finishImportRun(oldRunId, {
    status: 'succeeded', rowCount: 1, rejectedCount: 0, error: null,
  }, { sessionClient })

  assert.equal(lateFinish.transitioned, false)
  assert.equal(runs.get(oldRunId).status, 'failed')
  assert.equal(canonicalWrites, 0)
  assert.equal(releases, 0)
  assert.deepEqual(
    queries.slice(0, 5).map(({ sql }) => sql.trim().split(/\s+/)[0]),
    ['BEGIN', 'UPDATE', 'SELECT', 'INSERT', 'COMMIT'],
  )
  assert.match(queries[1].sql, /input_sha256 IS NOT NULL/)
  assert.match(queries[5].sql, /^BEGIN$/)
  assert.match(queries[6].sql, /FOR UPDATE/)
  assert.match(queries[7].sql, /^ROLLBACK$/)
})

test('PostgresStore detects a replay before canonical writes and returns its durable cursor end', async () => {
  const queries = []
  const storedEnd = { cursor: '2026-08-10T00:00:05.000Z', lastId: '9' }
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (sql.includes('FROM ingest.import_runs')) {
        return { rows: [{ id: 'run-1', source_id: 'source-1', status: 'running' }], rowCount: 1 }
      }
      if (sql.includes('FROM ingest.import_run_batches')) {
        return { rows: [{
          batch_key: 'batch-1', cursor_end: storedEnd, row_count: 2,
          ingested_count: 2, changed_count: 1, deleted_count: 0,
          rejected_count: 0, status: 'succeeded', page_fingerprint: 'a'.repeat(64),
        }], rowCount: 1 }
      }
      throw new Error(`unexpected canonical query: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const result = await store.ingestExternalRecords({
    datasetId: 'dataset', platform: 'telegram', connectorId: 'external:test',
    sourceId: 'source-1', importRunId: 'run-1', records: [{}],
    batch: { key: 'batch-1', pageFingerprint: 'b'.repeat(64) },
  })
  assert.equal(result.replayed, true)
  assert.equal(result.pageDrifted, true)
  assert.deepEqual(result.cursorEnd, storedEnd)
  assert.equal(queries.some((sql) => sql.includes('INSERT INTO ingest.source_objects')), false)
})

test('PostgresStore reports an ambiguous COMMIT without rolling back or reclassifying the run', async () => {
  const queries = []
  let releasedWith = null
  const commitError = Object.assign(new Error('socket closed after commit send'), { code: 'ECONNRESET' })
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 }
      if (sql === 'COMMIT') throw commitError
      if (sql.includes('FROM ingest.import_runs')) {
        return { rows: [{ id: 'run-1', source_id: 'source-1', status: 'running' }], rowCount: 1 }
      }
      if (sql.includes('FROM ingest.import_run_batches')) {
        return { rows: [{
          batch_key: 'batch-1', cursor_end: { cursor: '5', lastId: '9' }, row_count: 2,
          ingested_count: 2, changed_count: 1, deleted_count: 0,
          rejected_count: 0, status: 'succeeded', page_fingerprint: 'a'.repeat(64),
        }], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
    release(error) { releasedWith = error },
  }
  const store = new PostgresStore({ connect: async () => client })
  await assert.rejects(
    () => store.ingestExternalRecords({
      datasetId: 'dataset', platform: 'telegram', connectorId: 'external:test',
      sourceId: 'source-1', importRunId: 'run-1', records: [{}], batch: { key: 'batch-1' },
    }),
    (error) => error?.code === 'external_commit_outcome_unknown',
  )
  assert.equal(queries.includes('ROLLBACK'), false)
  assert.equal(releasedWith, commitError)
})

test('PostgresStore finalizes and resets import runs with their cursor in one transaction', async () => {
  const makeStore = () => {
    const queries = []
    const client = {
      async query(sql) {
        queries.push(sql)
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
        if (sql.includes('UPDATE ingest.import_runs') && sql.includes("status = $3")) {
          return { rows: [{ id: 'run-1', source_id: 'source-1', status: 'succeeded' }], rowCount: 1 }
        }
        if (sql.includes('UPDATE ingest.import_runs')) return { rows: [{ id: 'run-orphan' }], rowCount: 1 }
        if (sql.includes('FROM ingest.import_runs')) return { rows: [{ id: 'run-1' }], rowCount: 1 }
        if (sql.includes('INSERT INTO mxq.cursors')) {
          return { rows: [{ id: 'external:test', position: { cursor: '5' }, status: 'idle' }], rowCount: 1 }
        }
        throw new Error(`unexpected query: ${sql}`)
      },
      release() {},
    }
    return { store: new PostgresStore({ connect: async () => client }), queries }
  }

  const finalized = makeStore()
  await finalized.store.finalizeExternalImportRun({
    importRunId: 'run-1', sourceId: 'source-1', cursorId: 'external:test',
    position: { cursor: '5' }, status: 'succeeded', cursorStatus: 'idle', processedDelta: 2,
  })
  assert.deepEqual(finalized.queries.map((sql) => (
    sql === 'BEGIN' || sql === 'COMMIT' ? sql : sql.includes('mxq.cursors') ? 'CURSOR' : 'RUN'
  )), ['BEGIN', 'RUN', 'CURSOR', 'COMMIT'])

  const continuation = makeStore()
  await continuation.store.markExternalImportCursorFailed({
    importRunId: 'run-1', sourceId: 'source-1', cursorId: 'external:test',
    position: { cursor: '5', importRunId: 'run-1' }, error: 'continuation_enqueue_failed',
  })
  assert.equal(continuation.queries.some((sql) => sql.includes('UPDATE ingest.import_runs')), false)
  assert.deepEqual(continuation.queries.map((sql) => (
    sql === 'BEGIN' || sql === 'COMMIT' ? sql : sql.includes('mxq.cursors') ? 'CURSOR' : 'RUN'
  )), ['BEGIN', 'RUN', 'CURSOR', 'COMMIT'])

  const reset = makeStore()
  const result = await reset.store.resetExternalImportCheckpoint({
    sourceId: 'source-1', cursorId: 'external:test', position: { resetAt: 'now' },
  })
  assert.deepEqual(result.failedRunIds, ['run-orphan'])
  assert.deepEqual(reset.queries.map((sql) => (
    sql === 'BEGIN' || sql === 'COMMIT' ? sql : sql.includes('mxq.cursors') ? 'CURSOR' : 'RUN'
  )), ['BEGIN', 'RUN', 'CURSOR', 'COMMIT'])
})

test('PostgresStore source lock guard stops work after its advisory-lock session errors or ends', async () => {
  for (const event of ['error', 'end']) {
    const queries = []
    class LockClient extends EventEmitter {
      async query(sql) {
        queries.push(sql)
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: false }] }
        if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] }
        throw new Error(`unexpected query: ${sql}`)
      }

      release() {}
    }
    const client = new LockClient()
    const store = new PostgresStore({ connect: async () => client })
    await assert.rejects(
      () => store.withExternalSourceLock('telegram-monitor-chats', async (assertOwned) => {
        client.emit(event, event === 'error' ? new Error('lock connection lost') : undefined)
        await assertOwned()
      }),
      (error) => error?.code === 'source_lock_lost',
    )
    assert.equal(queries.includes('SELECT 1'), false)
  }
})
