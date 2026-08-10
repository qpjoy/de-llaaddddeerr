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
    const sample = records.slice(0, 5).map((raw) => {
      const { record, rejected } = applyMapping(raw, fieldMap, { platform: 'preview' })
      return rejected ? { rejected, raw } : { mapped: record, raw }
    })
    return {
      columns,
      rowCount: records.length,
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
  async importFile({ sourceKey, buffer, filename }) {
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
    const run = await this.store.startImportRun({
      sourceId: source.id,
      mappingVersion: mapping.version,
      inputSha256,
      inputName: filename,
      inputBytes: buffer.length,
    })
    // Byte-identical input that already succeeded: report it plainly instead of
    // re-doing the work and reporting "0 changed", which reads like a bug.
    if (run.duplicateOf) {
      return { status: 'skipped', reason: 'identical input already imported', duplicateOf: run.duplicateOf }
    }

    let parsed
    try {
      parsed = parseFile(buffer, filename, { hash: sha256 })
    } catch (error) {
      await this.store.finishImportRun(run.id, {
        status: 'failed', rowCount: 0, rejectedCount: 0, error: error.message,
      })
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
      record.parserVersion = `${CHUNKER_VERSION}:map${mapping.version}`
      mapped.push(record)
    }

    let ingested = 0
    let changed = 0
    try {
      // Batched so one oversized spreadsheet does not hold a single transaction
      // open for minutes and block the projector's outbox reads.
      for (let offset = 0; offset < mapped.length; offset += BATCH_SIZE) {
        const result = await this.store.ingestExternalRecords({
          datasetId: source.datasetId,
          platform: source.platform,
          connectorId: `external:${source.sourceKey}`,
          records: mapped.slice(offset, offset + BATCH_SIZE),
          importRunId: run.id,
        })
        ingested += result.ingested
        changed += result.changed
      }
    } catch (error) {
      await this.store.finishImportRun(run.id, {
        status: 'failed', rowCount: parsed.records.length, rejectedCount: rejections.length, error: error.message,
      })
      throw error
    }

    await this.store.recordRejectedRows(run.id, rejections)
    await this.store.finishImportRun(run.id, {
      status: 'succeeded',
      rowCount: parsed.records.length,
      rejectedCount: rejections.length,
      error: null,
    })

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
