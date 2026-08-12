import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const RULE_ID = '22222222-2222-4222-8222-222222222222'
const VERSION_ID = '33333333-3333-4333-8333-333333333333'
const RUN_ID = '44444444-4444-4444-8444-444444444444'
const FINGERPRINT = 'a'.repeat(64)
const FILE_STRUCTURE = {
  parserFamily: 'delimited',
  format: 'csv',
  selector: 'header-row',
  parserVersion: 'mxih-external.v1',
  columns: [{ name: 'id', valueTypeFamilies: ['string'], required: true }],
}
const FIELD_MAP = { title: { from: 'title' }, externalId: { from: 'id' } }

function mappingRow(overrides = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    source_id: SOURCE_ID,
    version: 1,
    field_map: FIELD_MAP,
    origin: 'inferred',
    agent_model: null,
    agent_confidence: null,
    notes: null,
    schema_fingerprint: FINGERPRINT,
    file_structure: FILE_STRUCTURE,
    format_rule_version_id: null,
    approved_at: null,
    approved_by: null,
    created_at: '2026-08-13T00:00:00.000Z',
    dataset_id: 'external.files.v1',
    platform: 'external',
    object_type: 'record',
    source_kind: 'file',
    ...overrides,
  }
}

function transactionPool(handler) {
  const calls = []
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      return handler(sql, values, calls)
    },
    release() {},
  }
  return { pool: { connect: async () => client }, calls }
}

test('source mapping version allocation is serialized per source and preserves structure evidence', async () => {
  const row = mappingRow()
  const { pool, calls } = transactionPool(async (sql) => {
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{ pg_advisory_xact_lock: null }] }
    if (/INSERT INTO catalog\.source_mappings/.test(sql)) return { rows: [row] }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const store = new PostgresStore(pool)

  const created = await store.createSourceMapping({
    sourceId: SOURCE_ID,
    fieldMap: FIELD_MAP,
    origin: 'inferred',
    schemaFingerprint: FINGERPRINT,
    fileStructure: FILE_STRUCTURE,
  })

  assert.deepEqual(calls.map(({ sql }) => sql.trim().split(/\s+/)[0]), [
    'BEGIN', 'SELECT', 'INSERT', 'COMMIT',
  ])
  assert.equal(calls[1].values[0], `mx-insight-hub:source-mapping:${SOURCE_ID}`)
  assert.match(calls[2].sql, /max\(version\).*source_id = \$2/s)
  assert.deepEqual(calls[2].values.slice(7), [FINGERPRINT, FILE_STRUCTURE, null])
  assert.equal(created.schemaFingerprint, FINGERPRINT)
  assert.deepEqual(created.fileStructure, FILE_STRUCTURE)
})

test('approval validates a preselected format rule with exact scope and JSONB evidence', async () => {
  const selected = mappingRow({ format_rule_version_id: VERSION_ID })
  const approved = mappingRow({
    format_rule_version_id: VERSION_ID,
    approved_at: '2026-08-13T00:01:00.000Z',
    approved_by: 'admin-token',
  })
  const { pool, calls } = transactionPool(async (sql) => {
    if (/SELECT m\.\*, s\.source_kind/.test(sql)) return { rows: [selected] }
    if (/FROM catalog\.file_format_rule_versions v/.test(sql)) return { rows: [{ id: VERSION_ID }] }
    if (/UPDATE catalog\.source_mappings/.test(sql)) return { rows: [approved] }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const store = new PostgresStore(pool)

  const result = await store.approveSourceMapping({
    sourceId: SOURCE_ID, version: 1, approvedBy: 'admin-token',
  })

  const linked = calls.find(({ sql }) => /FROM catalog\.file_format_rule_versions v/.test(sql))
  assert.match(linked.sql, /r\.dataset_id = \$2 AND r\.platform = \$3 AND r\.object_type = \$4/)
  assert.match(linked.sql, /v\.schema_fingerprint = \$5/)
  assert.match(linked.sql, /v\.field_map = \$6::jsonb/)
  assert.match(linked.sql, /v\.file_structure = \$7::jsonb/)
  assert.deepEqual(linked.values, [
    VERSION_ID, selected.dataset_id, selected.platform, selected.object_type,
    FINGERPRINT, FIELD_MAP, FILE_STRUCTURE,
  ])
  assert.equal(result.formatRuleVersionId, VERSION_ID)
})

test('format-rule equality canonicalizes equivalent source column spellings', async () => {
  const concreteFieldMap = {
    title: { from: '  TiTle\t' },
    externalId: { from: [' ＩＤ ', ' Legacy  ID '] },
  }
  const canonicalFieldMap = {
    title: { from: 'title' },
    externalId: { from: ['id', 'legacy id'] },
  }
  const selected = mappingRow({
    field_map: concreteFieldMap,
    format_rule_version_id: VERSION_ID,
  })
  const { pool, calls } = transactionPool(async (sql) => {
    if (/SELECT m\.\*, s\.source_kind/.test(sql)) return { rows: [selected] }
    if (/FROM catalog\.file_format_rule_versions v/.test(sql)) return { rows: [{ id: VERSION_ID }] }
    if (/UPDATE catalog\.source_mappings/.test(sql)) {
      return { rows: [mappingRow({
        field_map: concreteFieldMap,
        format_rule_version_id: VERSION_ID,
        approved_at: '2026-08-13T00:01:00.000Z',
      })] }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const store = new PostgresStore(pool)

  const approved = await store.approveSourceMapping({
    sourceId: SOURCE_ID, version: 1, approvedBy: 'admin-token',
  })

  const linked = calls.find(({ sql }) => /FROM catalog\.file_format_rule_versions v/.test(sql))
  assert.deepEqual(linked.values[5], canonicalFieldMap)
  assert.deepEqual(approved.fieldMap, concreteFieldMap, 'the source mapping keeps parser-facing column names')
})

test('automatic approval uses PostgreSQL JSONB equality and reuses the matching latest version', async () => {
  const selected = mappingRow()
  const approved = mappingRow({
    format_rule_version_id: VERSION_ID,
    approved_at: '2026-08-13T00:01:00.000Z',
    approved_by: 'admin-token',
  })
  const { pool, calls } = transactionPool(async (sql) => {
    if (/SELECT m\.\*, s\.source_kind/.test(sql)) return { rows: [selected] }
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] }
    if (/SELECT r\.id AS rule_id/.test(sql)) {
      return { rows: [{
        rule_id: RULE_ID,
        version_id: VERSION_ID,
        version: 1,
        file_structure_matches: true,
        field_map_matches: true,
      }] }
    }
    if (/UPDATE catalog\.source_mappings/.test(sql)) return { rows: [approved] }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const store = new PostgresStore(pool)

  await store.approveSourceMapping({ sourceId: SOURCE_ID, version: 1, approvedBy: 'admin-token' })

  const match = calls.find(({ sql }) => /SELECT r\.id AS rule_id/.test(sql))
  assert.match(match.sql, /v\.file_structure = \$5::jsonb AS file_structure_matches/)
  assert.match(match.sql, /v\.field_map = \$6::jsonb AS field_map_matches/)
  assert.deepEqual(match.values.slice(4), [FILE_STRUCTURE, FIELD_MAP])
  assert.equal(calls.some(({ sql }) => /INSERT INTO catalog\.file_format_rule_versions/.test(sql)), false)
  const lock = calls.find(({ sql }) => /pg_advisory_xact_lock/.test(sql))
  assert.equal(lock.values[0], `mx-insight-hub:file-format-rule:${JSON.stringify([
    selected.dataset_id, selected.platform, selected.object_type, FINGERPRINT,
  ])}`)
})

test('a changed field map creates a new format-rule version using the preview format key', async () => {
  const selected = mappingRow({ origin: 'agent', agent_model: 'model-a', agent_confidence: 0.8 })
  const approved = mappingRow({
    format_rule_version_id: VERSION_ID,
    approved_at: '2026-08-13T00:01:00.000Z',
    approved_by: 'admin-token',
  })
  const { pool, calls } = transactionPool(async (sql) => {
    if (/SELECT m\.\*, s\.source_kind/.test(sql)) return { rows: [selected] }
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] }
    if (/SELECT r\.id AS rule_id/.test(sql)) {
      return { rows: [{
        rule_id: RULE_ID,
        version_id: 'old-version',
        version: 1,
        file_structure_matches: true,
        field_map_matches: false,
      }] }
    }
    if (/INSERT INTO catalog\.file_format_rule_versions/.test(sql)) return { rows: [{ id: VERSION_ID }] }
    if (/UPDATE catalog\.source_mappings/.test(sql)) return { rows: [approved] }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const store = new PostgresStore(pool)

  await store.approveSourceMapping({ sourceId: SOURCE_ID, version: 1, approvedBy: 'admin-token' })

  const inserted = calls.find(({ sql }) => /INSERT INTO catalog\.file_format_rule_versions/.test(sql))
  assert.deepEqual(inserted.values.slice(1), [
    RULE_ID,
    FINGERPRINT,
    'delimited',
    'csv',
    FILE_STRUCTURE,
    FIELD_MAP,
    'agent',
    'model-a',
    0.8,
    'admin-token',
  ])
})

test('a fingerprint collision with different JSONB structure evidence fails closed', async () => {
  const { pool, calls } = transactionPool(async (sql) => {
    if (/SELECT m\.\*, s\.source_kind/.test(sql)) return { rows: [mappingRow()] }
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] }
    if (/SELECT r\.id AS rule_id/.test(sql)) {
      return { rows: [{
        rule_id: RULE_ID,
        version_id: VERSION_ID,
        file_structure_matches: false,
        field_map_matches: true,
      }] }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const store = new PostgresStore(pool)

  await assert.rejects(
    () => store.approveSourceMapping({ sourceId: SOURCE_ID, version: 1, approvedBy: 'admin-token' }),
    (error) => error?.status === 409 && error?.code === 'schema_fingerprint_conflict',
  )
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
})

test('file format evidence is rejected for non-file source mappings', async () => {
  const { pool, calls } = transactionPool(async (sql) => {
    if (/SELECT m\.\*, s\.source_kind/.test(sql)) {
      return { rows: [mappingRow({ source_kind: 'database' })] }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  const store = new PostgresStore(pool)

  await assert.rejects(
    () => store.approveSourceMapping({ sourceId: SOURCE_ID, version: 1, approvedBy: 'admin-token' }),
    (error) => error?.status === 409 && error?.code === 'format_rule_mismatch',
  )
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
})

test('file observations enforce source, format-rule and import-run scope in the write query', async () => {
  const row = {
    id: '66666666-6666-4666-8666-666666666666',
    source_id: SOURCE_ID,
    root_id: 'internal-files',
    relative_path: 'reports/data.csv',
    path_hash: 'b'.repeat(64),
    input_sha256: 'c'.repeat(64),
    input_bytes: 42,
    source_mtime: '2026-08-13T00:00:00.000Z',
    schema_fingerprint: FINGERPRINT,
    format_rule_version_id: VERSION_ID,
    import_run_id: RUN_ID,
    status: 'imported',
    first_seen_at: '2026-08-13T00:00:00.000Z',
    last_seen_at: '2026-08-13T00:00:00.000Z',
  }
  let captured
  const store = new PostgresStore({
    async query(sql, values) {
      captured = { sql, values }
      return { rows: [row] }
    },
  })

  const observation = await store.recordFileObservation({
    sourceId: SOURCE_ID,
    rootId: row.root_id,
    relativePath: row.relative_path,
    pathHash: row.path_hash,
    inputSha256: row.input_sha256,
    inputBytes: row.input_bytes,
    mtime: row.source_mtime,
    schemaFingerprint: FINGERPRINT,
    formatRuleVersionId: VERSION_ID,
    importRunId: RUN_ID,
    status: 'imported',
  })

  assert.match(captured.sql, /FROM catalog\.external_sources s/)
  assert.match(captured.sql, /s\.connection->>'fileMode' = 'server_path'/)
  assert.match(captured.sql, /r\.dataset_id = s\.dataset_id/)
  assert.match(captured.sql, /r\.platform = s\.platform/)
  assert.match(captured.sql, /r\.object_type = s\.object_type/)
  assert.match(captured.sql, /v\.schema_fingerprint = \$9/)
  assert.match(captured.sql, /ir\.source_id = s\.id/)
  assert.match(
    captured.sql,
    /WHEN EXCLUDED\.status = 'imported' OR ingest\.file_observations\.status <> 'imported'\s+THEN EXCLUDED\.schema_fingerprint/,
  )
  assert.match(
    captured.sql,
    /WHEN EXCLUDED\.status = 'imported' OR ingest\.file_observations\.status <> 'imported'\s+THEN EXCLUDED\.format_rule_version_id/,
  )
  assert.match(
    captured.sql,
    /WHEN EXCLUDED\.status = 'imported' THEN EXCLUDED\.import_run_id\s+ELSE ingest\.file_observations\.import_run_id/,
  )
  assert.equal(observation.relativePath, row.relative_path)

  const rejected = new PostgresStore({ query: async () => ({ rows: [] }) })
  await assert.rejects(
    () => rejected.recordFileObservation({
      sourceId: SOURCE_ID,
      rootId: row.root_id,
      relativePath: row.relative_path,
      pathHash: row.path_hash,
      inputSha256: row.input_sha256,
      inputBytes: row.input_bytes,
      mtime: row.source_mtime,
      formatRuleVersionId: VERSION_ID,
      importRunId: RUN_ID,
      status: 'imported',
    }),
    (error) => error?.status === 409 && error?.code === 'file_observation_scope_mismatch',
  )
})

test('migration 021 constrains JSON evidence and format-rule linkage', async () => {
  const migration = await readFile(
    new URL('../../migrations/021_server_file_format_rules.sql', import.meta.url),
    'utf8',
  )
  assert.match(migration, /jsonb_typeof\(file_structure\) = 'object'/)
  assert.match(migration, /jsonb_typeof\(field_map\) = 'object'/)
  assert.match(migration, /source_mappings_file_structure_check/)
  assert.match(migration, /schema_fingerprint IS NULL AND file_structure IS NULL AND format_rule_version_id IS NULL/)
  assert.match(migration, /file_format_rules_scope_idx/)
  assert.match(migration, /connection = '\{\}'::jsonb/)
  assert.match(migration, /jsonb_build_object\('fileMode', 'upload'\)/)
})
