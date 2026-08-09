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
import {
  DatabaseSourcePuller,
  validateDatabaseConnection,
} from '../../server/ingest/external/database-source.mjs'
import { runExternalPullJob } from '../../server/ingest/external/sync-job.mjs'
import { scheduleActiveDatabaseSources } from '../../server/ingest/external/scheduler.mjs'

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

test('the content hash tracks projected metrics but ignores collection time', () => {
  const first = applyMapping({ id: '1', 标题: 't', 点赞数: '10' }, fieldMap, { platform: 'external' })
  const second = applyMapping({ id: '1', 标题: 't', 点赞数: '999' }, fieldMap, { platform: 'external' })
  assert.notEqual(first.record.payloadSha256, second.record.payloadSha256)

  const edited = applyMapping({ id: '1', 标题: 'changed', 点赞数: '10' }, fieldMap, { platform: 'external' })
  assert.notEqual(first.record.payloadSha256, edited.record.payloadSha256)
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
      // The DSN is referenced by env var name, never stored in the row: a
      // password in a database row is a password in every backup.
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

test('a database source accepts an env name but rejects literal connection secrets', () => {
  assert.equal(validateDatabaseConnection({
    dsnEnv: 'TG_DATABASE_URL', table: 'tg_monitor_messages', cursorColumn: 'updated_at', idColumn: 'id',
  }), true)
  assert.throws(
    () => validateDatabaseConnection({ dsn: 'postgres://user:secret@db/x', table: 'messages' }),
    /Unsupported database connection fields/,
  )
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
      getCursor: async () => ({ position: { cursor: '2026-08-01T00:00:00Z', lastId: '2' } }),
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
  assert.deepEqual(saved.at(-1).position, { cursor: new Date('2026-08-02T00:00:00Z'), lastId: '10' })
  assert.equal(saved.at(-1).options.status, 'idle')
  assert.deepEqual(rejectedRows, [{ id: 'run-1', rows: [] }])
  assert.equal(finished.at(-1).result.status, 'succeeded')
})

test('a rejected database row records evidence and does not advance its cursor', async () => {
  const position = { cursor: '2026-08-01T00:00:00Z', lastId: '2' }
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
  assert.deepEqual(saved.at(-1).position, position)
  assert.equal(saved.at(-1).options.status, 'failed')
})

test('a failed database ingest records only a safe code and leaves its cursor unchanged', async () => {
  const position = { cursor: '2026-08-01T00:00:00Z', lastId: '2' }
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

  await assert.rejects(() => puller.pullBatch(source.sourceKey), /private\.invalid/)
  assert.equal(finished.at(-1).result.status, 'failed')
  assert.equal(finished.at(-1).result.error, 'ECONNRESET')
  assert.equal(JSON.stringify(finished).includes('private.invalid'), false)
  assert.deepEqual(saved.at(-1).position, position)
  assert.equal(saved.at(-1).options.error, 'ECONNRESET')
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
        return { pulled: 2500, ingested: 2500, changed: 20, rejected: 0, done: false }
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
    { sourceKey: 'telegram-monitor-messages', batchSize: 2500, chunk: 8 },
    { dedupeKey: 'external-pull:telegram-monitor-messages:8', priority: 220 },
  ]])
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
        { sourceKey: 'telegram-monitor-chats', sourceKind: 'database', status: 'active' },
        { sourceKey: 'telegram-monitor-messages', sourceKind: 'database', status: 'active' },
        { sourceKey: 'telegram-monitor-failed', sourceKind: 'database', status: 'active' },
        { sourceKey: 'telegram-monitor-paused', sourceKind: 'database', status: 'paused' },
        { sourceKey: 'weekly-file', sourceKind: 'file', status: 'active' },
      ],
    },
    queue: {
      getCursor: async (id) => ({
        'external:telegram-monitor-chats': { status: 'idle' },
        'external:telegram-monitor-messages': { status: 'running' },
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
    { sourceKey: 'telegram-monitor-chats', batchSize: 750, chunk: 0 },
    { dedupeKey: 'external-pull:telegram-monitor-chats:0', priority: 220 },
  ]])
})
