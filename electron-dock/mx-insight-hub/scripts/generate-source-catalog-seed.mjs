import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = resolve(projectRoot, 'spec_docs/data_source')
const seedModulePath = resolve(projectRoot, 'server/data/source-catalog-seed.mjs')
const migrationPath = resolve(projectRoot, 'migrations/036_source_catalog.sql')

const FILES = Object.freeze({
  support: '01.support_platform.txt',
  base: '02.base.txt',
  covered: '02.fugai.txt',
  uncovered: '02.weifugai.txt',
  detail: '03.txt',
})

const BASE_HEADER = Object.freeze([
  '序号', '大类', '细分场景', '区域', '数据源/平台',
  '当前覆盖状态', '备注待补充', '负责人',
])
// The exported header is reversed: column 7 is empty for all 215 rows, while
// column 8 contains connector/policy notes. Keep the observed data semantics.
const BASE_COLUMNS = Object.freeze([
  'legacySequence', 'majorCategory', 'scenario', 'region', 'canonicalName',
  'coverageLabel', 'ownerRaw', 'noteRaw',
])
const SUPPORT_COLUMNS = Object.freeze(['legacySequence', 'scenario', 'canonicalName'])
const DETAIL_COLUMNS = Object.freeze([
  'legacySequence', 'majorCategory', 'scenario', 'region', 'detailName',
  'entryModules', 'monitorableContent', 'extractableClues', 'trackingFields',
  'suggestedAccess', 'complianceBoundary', 'priority', 'reviewLabel',
  'ownerRaw', 'noteRaw',
])

const SEED_NAMESPACE = '83b02ad3-9485-5f42-b19a-3832188038b7'
const SEED_BATCH = 'mx-insight-hub-source-catalog-v1'
const SEED_TIMESTAMP = '2026-08-27T00:00:00.000Z'
const TELEGRAM_EVIDENCE = Object.freeze([
  { type: 'document', key: 'docs/operations/telegram-monitor-ingestion.md', label: 'Telegram monitor ingestion runbook' },
  { type: 'document', key: 'docs/operations/telegram-sqlite-api-ingestion.md', label: 'Telegram SQLite API ingestion runbook' },
  { type: 'pipeline', key: 'server/ingest/telegram/monitor-pipeline.mjs', label: 'Telegram monitor pipeline' },
  { type: 'pipeline', key: 'server/ingest/telegram/sqlite-pipeline.mjs', label: 'Telegram SQLite pipeline' },
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function uuidBytes(uuid) {
  const hex = uuid.replaceAll('-', '')
  assert.match(hex, /^[0-9a-f]{32}$/i, `Invalid UUID namespace: ${uuid}`)
  return Buffer.from(hex, 'hex')
}

function uuidV5(name) {
  const digest = createHash('sha1')
    .update(uuidBytes(SEED_NAMESPACE))
    .update(name)
    .digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sourceKey(sequence) {
  return `source-catalog-${String(sequence).padStart(4, '0')}`
}

function logicalLines(text) {
  const withoutFinalNewline = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = withoutFinalNewline.split('\n')
  assert.ok(lines.length > 0 && lines.every((line) => line.length > 0), 'Source files must not contain blank lines')
  return lines
}

async function loadInput(key) {
  const filename = FILES[key]
  const path = resolve(sourceDirectory, filename)
  const bytes = await readFile(path)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  assert.equal(text.includes('\r'), false, `${filename} must use LF line endings`)
  assert.notEqual(text.charCodeAt(0), 0xfeff, `${filename} must not have a UTF-8 BOM`)
  return {
    key,
    filename,
    path: relative(projectRoot, path).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: sha256(bytes),
    lines: logicalLines(text),
  }
}

function parseSequence(value, filename, rowNumber) {
  assert.match(value, /^[1-9][0-9]*$/, `${filename}:${rowNumber} has an invalid sequence`)
  return Number(value)
}

function parseRows(input, columns, { skip = 0 } = {}) {
  return input.lines.slice(skip).map((line, index) => {
    const rowNumber = index + skip + 1
    const fields = line.split('\t')
    assert.equal(fields.length, columns.length, `${input.filename}:${rowNumber} must have ${columns.length} tab-separated fields`)
    assert.ok(fields.every((field) => field === field.trim()), `${input.filename}:${rowNumber} has surrounding field whitespace`)
    const record = Object.fromEntries(columns.map((column, fieldIndex) => [column, fields[fieldIndex]]))
    record.legacySequence = parseSequence(record.legacySequence, input.filename, rowNumber)
    record.rowNumber = rowNumber
    record.rawFields = fields
    return record
  })
}

function countBy(records, selector) {
  const counts = new Map()
  for (const record of records) {
    const key = selector(record)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return Object.fromEntries([...counts.entries()])
}

function indexBySequence(records, label) {
  const result = new Map()
  for (const record of records) {
    assert.equal(result.has(record.legacySequence), false, `${label} has duplicate sequence ${record.legacySequence}`)
    result.set(record.legacySequence, record)
  }
  return result
}

function rowFields(records) {
  return records.map((record) => record.rawFields)
}

function validateInputs(inputs, tables) {
  assert.deepEqual(inputs.base.lines[0].trim().split(/\s+/u), BASE_HEADER, '02.base.txt header changed')
  assert.equal(inputs.base.lines[0].includes('\t'), false, '02.base.txt header is expected to be space-delimited')

  assert.equal(tables.base.length, 215, 'Base catalog must contain 215 records')
  assert.equal(tables.detail.length, 215, 'Detail catalog must contain 215 records')
  assert.equal(tables.covered.length, 29, 'Covered view must contain 29 records')
  assert.equal(tables.uncovered.length, 186, 'Uncovered view must contain 186 records')
  assert.equal(tables.support.length, 29, 'Supported-platform projection must contain 29 records')

  const expectedSequences = Array.from({ length: 215 }, (_, index) => index + 1)
  assert.deepEqual(tables.base.map((record) => record.legacySequence), expectedSequences, 'Base sequences must be 1..215')
  assert.deepEqual(tables.detail.map((record) => record.legacySequence), expectedSequences, 'Detail sequences must be 1..215')
  indexBySequence(tables.covered, 'Covered view')
  indexBySequence(tables.uncovered, 'Uncovered view')
  indexBySequence(tables.support, 'Supported-platform projection')

  const coveredFromBase = tables.base.filter((record) => record.coverageLabel === '已覆盖')
  const uncoveredFromBase = tables.base.filter((record) => record.coverageLabel === '未覆盖')
  assert.deepEqual(rowFields(tables.covered), rowFields(coveredFromBase), '02.fugai.txt must exactly equal the covered base rows')
  assert.deepEqual(rowFields(tables.uncovered), rowFields(uncoveredFromBase), '02.weifugai.txt must exactly equal the uncovered base rows')
  assert.deepEqual(
    rowFields(tables.support),
    tables.covered.map((record) => [String(record.legacySequence), record.scenario, record.canonicalName]),
    '01.support_platform.txt must exactly project sequence/scenario/platform from covered rows',
  )

  assert.deepEqual(countBy(tables.base, (record) => record.coverageLabel), { 已覆盖: 29, 未覆盖: 186 })
  assert.deepEqual(countBy(tables.detail, (record) => record.priority), { P0: 43, P1: 67, P2: 105 })
  assert.ok(tables.detail.every((record) => record.reviewLabel === '待补充'), 'All detail review labels must be 待补充')
  assert.ok(tables.base.every((record) => record.ownerRaw === ''), 'Base column 7 is forced to nullable owner and must remain empty')
  assert.ok(tables.detail.every((record) => record.ownerRaw === ''), 'Detail owners must remain empty')
  assert.equal(tables.base.filter((record) => record.noteRaw).length, 36, 'Base note/connector clue count changed')

  const detailBySequence = indexBySequence(tables.detail, 'Detail catalog')
  const nameConflicts = []
  for (const base of tables.base) {
    const detail = detailBySequence.get(base.legacySequence)
    assert.ok(detail, `Missing detail record ${base.legacySequence}`)
    assert.deepEqual(
      [detail.majorCategory, detail.scenario, detail.region],
      [base.majorCategory, base.scenario, base.region],
      `Base/detail taxonomy mismatch for ${base.legacySequence}`,
    )
    if (detail.detailName !== base.canonicalName) {
      nameConflicts.push([base.legacySequence, base.canonicalName, detail.detailName])
    }
  }
  assert.deepEqual(nameConflicts, [[62, '抖音电商', '抖音小店']], 'Only the documented ID 62 alias conflict is allowed')
  assert.equal(new Set(tables.base.map((record) => record.canonicalName.normalize('NFKC').toLocaleLowerCase())).size, 215, 'Canonical names must be unique')
}

function splitList(value) {
  return [...new Set(value.split('、').map((item) => item.trim()).filter(Boolean))]
}

function splitRegions(value) {
  return [...new Set(value.split('/').map((item) => item.trim()).filter(Boolean))]
}

function connectorHints(note) {
  if (!note) return []
  const hints = []
  const add = (value) => { if (!hints.includes(value)) hints.push(value) }
  if (/tikhub/iu.test(note)) add('tikhub')
  if (/justone/iu.test(note)) add('justone')
  if (/rapid/iu.test(note)) add('rapid')
  if (/apify/iu.test(note)) add('apify')
  if (/真机/u.test(note)) add('device')
  if (/自建/u.test(note)) add('self_hosted')
  if (/mcp/iu.test(note)) add('official_mcp')
  else if (/官方提供.*接口/u.test(note)) add('official_api')
  if (/\bvip\b/iu.test(note)) add('vip')
  return hints
}

function sourceKind(base) {
  if (base.legacySequence === 62 || base.majorCategory === '群聊与私域线索（可选）') return 'platform_module'
  if (base.majorCategory === '主体追踪与资质数据源') return 'registry'
  if (base.majorCategory === '广告投放与第三方监测数据') return 'provider'
  if (base.majorCategory === '搜索引擎与开放网络') return 'source_class'
  return 'platform'
}

function coverageStatus(label) {
  if (label === '已覆盖') return 'covered'
  if (label === '未覆盖') return 'not_covered'
  throw new Error(`Unsupported coverage label: ${label}`)
}

function deliveryStatus(base, detail) {
  if (base.legacySequence === 160 || base.legacySequence === 161) return 'complete'
  if (base.coverageLabel === '已覆盖') return 'doing'
  if (detail.priority === 'P0') return 'exploring'
  return 'planned'
}

function fileEvidence(input, rowNumber, label) {
  return {
    type: 'dataset',
    key: `${input.path}#sha256=${input.sha256}&row=${rowNumber}`,
    label,
  }
}

function importProvenance(inputs, batchSha256) {
  return {
    batch: SEED_BATCH,
    batchSha256,
    parser: 'fixed-schema-tsv-v1',
    sourceDirectory: 'spec_docs/data_source',
    files: Object.fromEntries(Object.values(inputs).map((input) => [input.filename, {
      sha256: input.sha256,
      bytes: input.bytes,
      logicalLines: input.lines.length,
    }])),
  }
}

function buildRecords(inputs, tables) {
  const detailBySequence = indexBySequence(tables.detail, 'Detail catalog')
  const coveredBySequence = indexBySequence(tables.covered, 'Covered view')
  const uncoveredBySequence = indexBySequence(tables.uncovered, 'Uncovered view')
  const supportBySequence = indexBySequence(tables.support, 'Supported-platform projection')
  const batchSha256 = sha256(Object.values(inputs)
    .map((input) => `${input.filename}:${input.sha256}`)
    .join('\n'))
  const provenance = importProvenance(inputs, batchSha256)
  const importedFrom = `${SEED_BATCH}:${batchSha256}`

  const records = tables.base.map((base) => {
    const detail = detailBySequence.get(base.legacySequence)
    const view = coveredBySequence.get(base.legacySequence) || uncoveredBySequence.get(base.legacySequence)
    const evidenceRefs = [
      fileEvidence(inputs.base, base.rowNumber, 'Source catalog base row'),
      fileEvidence(inputs.detail, detail.rowNumber, 'Source catalog detail row'),
      fileEvidence(
        base.coverageLabel === '已覆盖' ? inputs.covered : inputs.uncovered,
        view.rowNumber,
        `${base.coverageLabel} filtered view row`,
      ),
    ]
    if (supportBySequence.has(base.legacySequence)) {
      evidenceRefs.push(fileEvidence(inputs.support, supportBySequence.get(base.legacySequence).rowNumber, 'Supported-platform projection row'))
    }
    if (base.legacySequence === 160 || base.legacySequence === 161) {
      evidenceRefs.push(...TELEGRAM_EVIDENCE)
    }

    const nameConflict = detail.detailName === base.canonicalName
      ? null
      : { canonicalName: base.canonicalName, detailAlias: detail.detailName }
    return {
      id: uuidV5(sourceKey(base.legacySequence)),
      sourceKey: sourceKey(base.legacySequence),
      legacySequence: base.legacySequence,
      canonicalName: base.canonicalName,
      aliases: nameConflict ? [detail.detailName] : [],
      sourceKind: sourceKind(base),
      parentSourceId: null,
      majorCategory: base.majorCategory,
      scenarios: [base.scenario],
      regions: splitRegions(base.region),
      entryModules: splitList(detail.entryModules),
      monitorableContent: splitList(detail.monitorableContent),
      extractableClues: splitList(detail.extractableClues),
      trackingFields: splitList(detail.trackingFields),
      suggestedAccess: splitList(detail.suggestedAccess),
      complianceBoundary: detail.complianceBoundary,
      priority: detail.priority,
      coverageStatus: coverageStatus(base.coverageLabel),
      deliveryStatus: deliveryStatus(base, detail),
      reviewStatus: 'needs_review',
      runtimeStatus: 'unknown',
      owner: null,
      connectorHints: connectorHints(base.noteRaw),
      notes: base.noteRaw || detail.noteRaw || null,
      tags: [],
      evidenceRefs,
      customFields: {
        importProvenance: {
          batch: provenance.batch,
          batchSha256: provenance.batchSha256,
          parser: provenance.parser,
        },
        legacy: {
          baseCoverageLabel: base.coverageLabel,
          baseRegionLabel: base.region,
          baseOwnerRaw: null,
          baseNoteRaw: base.noteRaw || null,
          detailReviewLabel: detail.reviewLabel,
          detailOwnerRaw: null,
          detailNoteRaw: detail.noteRaw || null,
          ...(nameConflict ? { nameConflict } : {}),
        },
      },
      revision: 1,
      archivedAt: null,
      importedFrom,
      createdAt: SEED_TIMESTAMP,
      updatedAt: SEED_TIMESTAMP,
    }
  })

  assert.equal(new Set(records.map((record) => record.id)).size, 215, 'Deterministic UUIDs must be unique')
  assert.equal(new Set(records.map((record) => record.sourceKey)).size, 215, 'Source keys must be unique')
  assert.deepEqual(countBy(records, (record) => record.coverageStatus), { covered: 29, not_covered: 186 })
  assert.deepEqual(countBy(records, (record) => record.deliveryStatus), {
    doing: 27,
    exploring: 20,
    planned: 166,
    complete: 2,
  })
  assert.deepEqual(records.find((record) => record.legacySequence === 62).aliases, ['抖音小店'])
  assert.ok(records.every((record) => record.owner === null), 'Owners must seed as null')
  return { records, provenance, importedFrom }
}

function databaseRecord(record) {
  return {
    id: record.id,
    source_key: record.sourceKey,
    legacy_sequence: record.legacySequence,
    canonical_name: record.canonicalName,
    aliases: record.aliases,
    source_kind: record.sourceKind,
    parent_source_id: record.parentSourceId,
    major_category: record.majorCategory,
    scenarios: record.scenarios,
    regions: record.regions,
    entry_modules: record.entryModules,
    monitorable_content: record.monitorableContent,
    extractable_clues: record.extractableClues,
    tracking_fields: record.trackingFields,
    suggested_access: record.suggestedAccess,
    compliance_boundary: record.complianceBoundary,
    priority: record.priority,
    coverage_status: record.coverageStatus,
    delivery_status: record.deliveryStatus,
    review_status: record.reviewStatus,
    runtime_status: record.runtimeStatus,
    owner: record.owner,
    connector_hints: record.connectorHints,
    notes: record.notes,
    tags: record.tags,
    evidence_refs: record.evidenceRefs,
    custom_fields: record.customFields,
    revision: record.revision,
    archived_at: record.archivedAt,
    imported_from: record.importedFrom,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    event_id: uuidV5(`${record.sourceKey}:seed-event`),
    event_changes: {
      after: {
        id: record.id,
        sourceKey: record.sourceKey,
        legacySequence: record.legacySequence,
        revision: record.revision,
        importedFrom: record.importedFrom,
      },
    },
  }
}

function seedModule({ records, provenance }) {
  return `// Generated by scripts/generate-source-catalog-seed.mjs. Do not edit by hand.\n\nexport const SOURCE_CATALOG_IMPORT_PROVENANCE = Object.freeze(${JSON.stringify(provenance, null, 2)})\n\nexport const SOURCE_CATALOG_SEED = ${JSON.stringify(records, null, 2)}\n`
}

function sqlMigration({ records, provenance, importedFrom }) {
  const sqlSeed = JSON.stringify(records.map(databaseRecord), null, 2)
  const sourceHashes = Object.entries(provenance.files)
    .map(([filename, metadata]) => `--   ${filename}: ${metadata.sha256}`)
    .join('\n')
  return `-- Deterministic governed source catalog generated from spec_docs/data_source.\n-- Regenerate with: npm run generate:source-catalog\n${sourceHashes}\n\nCREATE SCHEMA IF NOT EXISTS catalog;\n\nCREATE TABLE IF NOT EXISTS catalog.source_catalog_entries (\n  id uuid PRIMARY KEY,\n  source_key text NOT NULL UNIQUE\n    CHECK (source_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),\n  legacy_sequence integer UNIQUE CHECK (legacy_sequence > 0),\n  canonical_name text NOT NULL CHECK (length(btrim(canonical_name)) BETWEEN 1 AND 160),\n  aliases text[] NOT NULL DEFAULT ARRAY[]::text[],\n  source_kind text NOT NULL DEFAULT 'platform'\n    CHECK (source_kind IN ('platform', 'platform_module', 'source_class', 'registry', 'provider', 'dataset', 'other')),\n  parent_source_id uuid REFERENCES catalog.source_catalog_entries(id) ON DELETE RESTRICT,\n  major_category text NOT NULL CHECK (length(btrim(major_category)) BETWEEN 1 AND 160),\n  scenarios text[] NOT NULL CHECK (cardinality(scenarios) > 0),\n  regions text[] NOT NULL CHECK (cardinality(regions) > 0),\n  entry_modules text[] NOT NULL DEFAULT ARRAY[]::text[],\n  monitorable_content text[] NOT NULL DEFAULT ARRAY[]::text[],\n  extractable_clues text[] NOT NULL DEFAULT ARRAY[]::text[],\n  tracking_fields text[] NOT NULL DEFAULT ARRAY[]::text[],\n  suggested_access text[] NOT NULL DEFAULT ARRAY[]::text[],\n  compliance_boundary text,\n  priority text NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),\n  coverage_status text NOT NULL DEFAULT 'unknown'\n    CHECK (coverage_status IN ('unknown', 'not_covered', 'partial', 'covered')),\n  delivery_status text NOT NULL DEFAULT 'exploring'\n    CHECK (delivery_status IN ('exploring', 'planned', 'doing', 'blocked', 'complete', 'paused', 'retired')),\n  review_status text NOT NULL DEFAULT 'needs_review'\n    CHECK (review_status IN ('needs_review', 'verified', 'rejected')),\n  runtime_status text NOT NULL DEFAULT 'not_configured'\n    CHECK (runtime_status IN ('not_configured', 'unknown', 'healthy', 'degraded', 'failed')),\n  owner text,\n  connector_hints text[] NOT NULL DEFAULT ARRAY[]::text[],\n  notes text,\n  tags text[] NOT NULL DEFAULT ARRAY[]::text[],\n  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb\n    CHECK (jsonb_typeof(evidence_refs) = 'array'),\n  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb\n    CHECK (jsonb_typeof(custom_fields) = 'object'),\n  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),\n  archived_at timestamptz,\n  imported_from text,\n  created_at timestamptz NOT NULL DEFAULT now(),\n  updated_at timestamptz NOT NULL DEFAULT now(),\n  CHECK (parent_source_id IS NULL OR parent_source_id <> id)\n);\n\nCREATE TABLE IF NOT EXISTS catalog.source_catalog_events (\n  id uuid PRIMARY KEY,\n  entry_id uuid NOT NULL REFERENCES catalog.source_catalog_entries(id) ON DELETE RESTRICT,\n  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),\n  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 160),\n  from_revision integer CHECK (from_revision IS NULL OR from_revision > 0),\n  to_revision integer NOT NULL CHECK (to_revision > 0),\n  changes jsonb NOT NULL DEFAULT '{}'::jsonb\n    CHECK (jsonb_typeof(changes) = 'object'),\n  created_at timestamptz NOT NULL DEFAULT now(),\n  CHECK (from_revision IS NULL OR to_revision > from_revision)\n);\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_active_status_idx\n  ON catalog.source_catalog_entries\n    (coverage_status, delivery_status, priority, updated_at DESC)\n  WHERE archived_at IS NULL;\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_category_idx\n  ON catalog.source_catalog_entries (major_category, priority, legacy_sequence)\n  WHERE archived_at IS NULL;\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_parent_idx\n  ON catalog.source_catalog_entries (parent_source_id)\n  WHERE parent_source_id IS NOT NULL;\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_owner_idx\n  ON catalog.source_catalog_entries (owner, updated_at DESC)\n  WHERE owner IS NOT NULL AND archived_at IS NULL;\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_name_idx\n  ON catalog.source_catalog_entries (lower(canonical_name));\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_aliases_idx\n  ON catalog.source_catalog_entries USING gin (aliases);\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_scenarios_idx\n  ON catalog.source_catalog_entries USING gin (scenarios);\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_regions_idx\n  ON catalog.source_catalog_entries USING gin (regions);\n\nCREATE INDEX IF NOT EXISTS source_catalog_entries_tags_idx\n  ON catalog.source_catalog_entries USING gin (tags);\n\nCREATE INDEX IF NOT EXISTS source_catalog_events_entry_idx\n  ON catalog.source_catalog_events (entry_id, created_at DESC, id DESC);\n\nCREATE INDEX IF NOT EXISTS source_catalog_events_type_idx\n  ON catalog.source_catalog_events (event_type, created_at DESC, id DESC);\n\nCREATE TEMP TABLE source_catalog_seed_036 ON COMMIT DROP AS\nSELECT *\nFROM jsonb_to_recordset(\n$source_catalog_seed$\n${sqlSeed}\n$source_catalog_seed$::jsonb\n) AS seed(\n  id uuid,\n  source_key text,\n  legacy_sequence integer,\n  canonical_name text,\n  aliases text[],\n  source_kind text,\n  parent_source_id uuid,\n  major_category text,\n  scenarios text[],\n  regions text[],\n  entry_modules text[],\n  monitorable_content text[],\n  extractable_clues text[],\n  tracking_fields text[],\n  suggested_access text[],\n  compliance_boundary text,\n  priority text,\n  coverage_status text,\n  delivery_status text,\n  review_status text,\n  runtime_status text,\n  owner text,\n  connector_hints text[],\n  notes text,\n  tags text[],\n  evidence_refs jsonb,\n  custom_fields jsonb,\n  revision integer,\n  archived_at timestamptz,\n  imported_from text,\n  created_at timestamptz,\n  updated_at timestamptz,\n  event_id uuid,\n  event_changes jsonb\n);\n\nINSERT INTO catalog.source_catalog_entries\n  (id, source_key, legacy_sequence, canonical_name, aliases, source_kind,\n   parent_source_id, major_category, scenarios, regions, entry_modules,\n   monitorable_content, extractable_clues, tracking_fields, suggested_access,\n   compliance_boundary, priority, coverage_status, delivery_status, review_status,\n   runtime_status, owner, connector_hints, notes, tags, evidence_refs, custom_fields,\n   revision, archived_at, imported_from, created_at, updated_at)\nSELECT\n  id, source_key, legacy_sequence, canonical_name, aliases, source_kind,\n  parent_source_id, major_category, scenarios, regions, entry_modules,\n  monitorable_content, extractable_clues, tracking_fields, suggested_access,\n  compliance_boundary, priority, coverage_status, delivery_status, review_status,\n  runtime_status, owner, connector_hints, notes, tags, evidence_refs, custom_fields,\n  revision, archived_at, imported_from, created_at, updated_at\nFROM source_catalog_seed_036\nON CONFLICT (source_key) DO NOTHING;\n\nINSERT INTO catalog.source_catalog_events\n  (id, entry_id, event_type, actor, from_revision, to_revision, changes, created_at)\nSELECT\n  seed.event_id, entry.id, 'seed_import', 'migration-036', NULL, entry.revision,\n  seed.event_changes, seed.created_at\nFROM source_catalog_seed_036 seed\nJOIN catalog.source_catalog_entries entry USING (source_key)\nON CONFLICT (id) DO NOTHING;\n\nDO $$\nDECLARE\n  seeded_total integer;\n  covered_total integer;\n  not_covered_total integer;\n  complete_total integer;\nBEGIN\n  SELECT\n    count(*),\n    count(*) FILTER (WHERE coverage_status = 'covered'),\n    count(*) FILTER (WHERE coverage_status = 'not_covered'),\n    count(*) FILTER (WHERE delivery_status = 'complete')\n  INTO seeded_total, covered_total, not_covered_total, complete_total\n  FROM catalog.source_catalog_entries\n  WHERE imported_from = '${importedFrom}';\n\n  IF ROW(seeded_total, covered_total, not_covered_total, complete_total)\n     IS DISTINCT FROM ROW(215, 29, 186, 2) THEN\n    RAISE EXCEPTION\n      'source catalog seed validation failed: total=%, covered=%, not_covered=%, complete=%',\n      seeded_total, covered_total, not_covered_total, complete_total;\n  END IF;\n\n  IF NOT EXISTS (\n    SELECT 1\n    FROM catalog.source_catalog_entries\n    WHERE legacy_sequence = 62\n      AND canonical_name = '抖音电商'\n      AND aliases = ARRAY['抖音小店']::text[]\n  ) THEN\n    RAISE EXCEPTION 'source catalog seed validation failed for legacy sequence 62 alias';\n  END IF;\nEND\n$$;\n\nCOMMENT ON TABLE catalog.source_catalog_entries IS\n  'Hub-owned governed source directory. Coverage, delivery, review and runtime are separate state axes.';\n\nCOMMENT ON TABLE catalog.source_catalog_events IS\n  'Append-only audit events for governed source catalog revisions.';\n`
}

async function main() {
  const inputs = Object.fromEntries(await Promise.all(Object.keys(FILES).map(async (key) => [key, await loadInput(key)])))
  for (const evidence of TELEGRAM_EVIDENCE) await readFile(resolve(projectRoot, evidence.key))

  const tables = {
    support: parseRows(inputs.support, SUPPORT_COLUMNS),
    base: parseRows(inputs.base, BASE_COLUMNS, { skip: 1 }),
    covered: parseRows(inputs.covered, BASE_COLUMNS),
    uncovered: parseRows(inputs.uncovered, BASE_COLUMNS),
    detail: parseRows(inputs.detail, DETAIL_COLUMNS),
  }
  validateInputs(inputs, tables)
  const seed = buildRecords(inputs, tables)
  await writeFile(seedModulePath, seedModule(seed), 'utf8')
  await writeFile(migrationPath, sqlMigration(seed), 'utf8')

  console.log(`validated 215 source records: 29 covered, 186 not covered`)
  console.log(`validated views: 29 covered + 186 uncovered; 29-row support projection`)
  console.log('validated alias conflict: 62 抖音电商 <- 抖音小店')
  console.log(`wrote ${relative(projectRoot, seedModulePath)}`)
  console.log(`wrote ${relative(projectRoot, migrationPath)}`)
}

await main()
