import { createHash } from 'node:crypto'
import { AppError } from '../../core/errors.mjs'
import { parseFile } from './parsers.mjs'
import { applyMapping, validateFieldMap, inferFieldMap, CHUNKER_VERSION } from './mapping.mjs'

// Orchestrates one external import: parse -> map -> write, with the rejected
// rows and the run record kept as evidence either way.

const BATCH_SIZE = 500

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

const FILE_FORMATS = {
  '.csv': { parserFamily: 'delimited', format: 'csv', selector: 'header-row' },
  '.tsv': { parserFamily: 'delimited', format: 'tsv', selector: 'header-row' },
  '.jsonl': { parserFamily: 'json-lines', format: 'jsonl', selector: 'line-object' },
  '.ndjson': { parserFamily: 'json-lines', format: 'ndjson', selector: 'line-object' },
  '.xlsx': { parserFamily: 'openxml-workbook', format: 'xlsx', selector: 'first-worksheet' },
  '.xlsm': { parserFamily: 'openxml-workbook', format: 'xlsm', selector: 'first-worksheet' },
  '.txt': { parserFamily: 'plain-text', format: 'txt', selector: 'paragraph' },
  '.md': { parserFamily: 'plain-text', format: 'md', selector: 'paragraph' },
}

function extensionOf(filename) {
  return /\.[^.]+$/.exec(String(filename).toLowerCase())?.[0] ?? ''
}

export function normalizeStructureColumnName(value) {
  return String(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

function assertUnambiguousStructureColumns(columns) {
  const normalized = new Set()
  for (const column of columns) {
    const name = normalizeStructureColumnName(column)
    if (normalized.has(name)) {
      throw new AppError(
        400,
        'ambiguous_file_columns',
        'File columns must remain unique after case and whitespace normalization',
      )
    }
    normalized.add(name)
  }
}

function hasRequiredValue(record, column) {
  if (!Object.prototype.hasOwnProperty.call(record, column)) return false
  const value = record[column]
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')
}

function valueTypeFamily(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' || typeof value === 'bigint') return 'number'
  return 'string'
}

/**
 * Describe only the reusable shape of one parsed file. Content identity, row
 * count, filename and sample values deliberately stay out of this object.
 */
export function buildFileStructure({ columns, records }, filename) {
  const descriptor = FILE_FORMATS[extensionOf(filename)]
  if (!descriptor) throw new Error(`Cannot describe unsupported file format: ${filename}`)
  assertUnambiguousStructureColumns(columns)

  const profiledColumns = columns.map((column) => {
    const families = new Set()
    for (const record of records) {
      const family = valueTypeFamily(record[column])
      if (family) families.add(family)
    }
    return {
      name: normalizeStructureColumnName(column),
      valueTypeFamilies: families.size > 0 ? [...families].sort() : ['unknown'],
      required: records.length > 0 && records.every((record) => hasRequiredValue(record, column)),
    }
  })

  // JSON object key order is not schema. parseJsonLines discovers columns in
  // first-seen order, so canonicalize it before hashing to avoid false drift.
  if (descriptor.parserFamily === 'json-lines') {
    profiledColumns.sort((left, right) => {
      const leftKey = JSON.stringify(left)
      const rightKey = JSON.stringify(right)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  }

  return { ...descriptor, parserVersion: CHUNKER_VERSION, columns: profiledColumns }
}

export function fingerprintFileStructure(fileStructure) {
  return sha256(JSON.stringify(fileStructure))
}

export class ExternalImporter {
  constructor({ store, logger = console }) {
    this.store = store
    this.logger = logger
  }

  /**
   * Suggest a mapping for a file without importing anything.
   *
   * Preview-before-import exists because a wrong mapping is not a visible
   * failure — it produces plausible-looking records with the wrong fields in
   * them. Seeing the inferred mapping and a few mapped rows first is what makes
   * that catchable.
   */
  async preview(buffer, filename) {
    const { columns, records } = parseFile(buffer, filename, { hash: sha256 })
    const fieldMap = inferFieldMap(columns)
    const fileStructure = buildFileStructure({ columns, records }, filename)
    const sample = records.slice(0, 5).map((raw) => {
      const { record, rejected } = applyMapping(raw, fieldMap, { platform: 'preview' })
      return rejected ? { rejected, raw } : { mapped: record, raw }
    })
    return {
      columns,
      rowCount: records.length,
      inputSha256: sha256(buffer),
      schemaFingerprint: fingerprintFileStructure(fileStructure),
      fileStructure,
      inferredFieldMap: fieldMap,
      // Columns the inference could not place. These are the ones that will
      // land in `extensions` — usually correct, occasionally the sign that the
      // real title column is named something unexpected.
      unmappedColumns: columns.filter(
        (column) => !Object.values(fieldMap).some((rule) => rule.from === column),
      ),
      sample,
    }
  }

  /**
   * Import a file against a source's approved mapping.
   *
   * Refuses to run without an approved mapping rather than falling back to
   * inference: inference is a starting point for a human, not a silent default
   * that decides how data is stored.
   */
  async importFile({
    sourceKey,
    buffer,
    filename,
    assertOwned = async () => {},
    sessionClient = null,
  }) {
    const source = await this.store.getExternalSource(sourceKey)
    if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    if (source.status !== 'active') {
      throw new AppError(409, 'source_paused', 'This source is paused')
    }

    const mapping = await this.store.getActiveMapping(source.id)
    if (!mapping) {
      throw new AppError(409, 'no_approved_mapping', 'This source has no approved field mapping', {
        hint: 'POST the mapping, then approve it, before importing',
      })
    }
    validateFieldMap(mapping.fieldMap)

    const inputSha256 = sha256(buffer)
    const formatRuleVersionId = mapping.formatRuleVersionId == null
      ? null
      : String(mapping.formatRuleVersionId)
    const parserVersion = `${CHUNKER_VERSION}:map${mapping.version}`
      + (formatRuleVersionId === null ? '' : `:rule=${formatRuleVersionId}`)
    const inputFormat = /\.[^.]+$/.exec(String(filename).toLowerCase())?.[0] ?? '(none)'
    // Hash the auditable components into a fixed-width index key. The filename
    // is untrusted, so indexing the raw extension would let an oversized name
    // exceed PostgreSQL's btree entry limit.
    const interpretationKey = sha256([
      `parser=${CHUNKER_VERSION}`,
      `mapping=${mapping.version}`,
      `format=${inputFormat}`,
      ...(formatRuleVersionId === null ? [] : [`formatRuleVersion=${formatRuleVersionId}`]),
    ].join('\n'))
    await assertOwned()
    const run = await this.store.startImportRun({
      sourceId: source.id,
      mappingVersion: mapping.version,
      inputSha256,
      interpretationKey,
      inputName: filename,
      inputBytes: buffer.length,
      sessionClient,
    })
    // Byte-identical input under this exact parser, mapping, and format that
    // already succeeded: report it plainly instead of re-doing the work and
    // reporting "0 changed", which reads like a bug.
    if (run.duplicateOf) {
      return { status: 'skipped', reason: 'identical input already imported', duplicateOf: run.duplicateOf }
    }
    let parsed
    try {
      parsed = parseFile(buffer, filename, { hash: sha256 })
    } catch (error) {
      await this.store.finishImportRun(run.id, {
        status: 'failed', rowCount: 0, rejectedCount: 0, error: error.message,
      }, { sessionClient })
      throw new AppError(400, 'parse_failed', error.message)
    }

    const rejections = []
    const mapped = []
    for (const [index, raw] of parsed.records.entries()) {
      const { record, rejected } = applyMapping(raw, mapping.fieldMap, {
        platform: source.platform,
        objectType: source.objectType,
        source: { origin: 'file', sourceKey: source.sourceKey },
      })
      if (rejected) {
        rejections.push({ rowIndex: index + 1, reason: rejected, raw })
        continue
      }
      record.parserVersion = parserVersion
      mapped.push(record)
    }

    let ingested = 0
    let changed = 0
    try {
      // Batched so one oversized spreadsheet does not hold a single transaction
      // open for minutes and block the projector's outbox reads.
      for (let offset = 0; offset < mapped.length; offset += BATCH_SIZE) {
        await assertOwned()
        const result = await this.store.ingestExternalRecords({
          datasetId: source.datasetId,
          platform: source.platform,
          connectorId: `external:${source.sourceKey}`,
          records: mapped.slice(offset, offset + BATCH_SIZE),
          importRunId: run.id,
          sessionClient,
        })
        ingested += result.ingested
        changed += result.changed
      }
      await assertOwned()
      await this.store.recordRejectedRows(run.id, rejections, { sessionClient })
      await assertOwned()
      await this.store.finishImportRun(run.id, {
        status: 'succeeded',
        rowCount: parsed.records.length,
        rejectedCount: rejections.length,
        error: null,
      }, { sessionClient })
    } catch (error) {
      try {
        await this.store.finishImportRun(run.id, {
          status: 'failed', rowCount: parsed.records.length, rejectedCount: rejections.length, error: error.message,
        }, { sessionClient })
      } catch (finishError) {
        // A failed held-session write means the session can no longer own the
        // advisory lock. Preserve the operation error; the next claim's DB
        // fence will terminalize this run on its healthy lock session.
        if (!sessionClient) throw finishError
      }
      throw error
    }

    // A high rejection rate is reported, not just counted. An import that
    // "succeeded" at 60% coverage is usually a renamed column, and it should be
    // visible in the logs the day it happens rather than a month later.
    const rejectionRate = parsed.records.length > 0 ? rejections.length / parsed.records.length : 0
    if (rejectionRate > 0.1) {
      this.logger?.warn?.(
        `[import] ${sourceKey}: ${rejections.length}/${parsed.records.length} rows rejected ` +
          `(${Math.round(rejectionRate * 100)}%) - check whether a source column was renamed`,
      )
    }

    return {
      status: 'succeeded',
      importRunId: run.id,
      mappingVersion: mapping.version,
      rowCount: parsed.records.length,
      ingested,
      changed,
      rejected: rejections.length,
      rejectionRate: Math.round(rejectionRate * 1000) / 1000,
    }
  }
}
