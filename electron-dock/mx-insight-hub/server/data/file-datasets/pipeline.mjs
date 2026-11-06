// Admin-plane control of one file dataset's cleaning task ("清洗计划").
//
// The Admin listener only records intent (source, start/pause/resume/discard,
// publish/rollback) and reads progress. The dedicated dictionary worker does
// the heavy work, so the Admin process never parses the multi-GB source file.
import { AppError } from '../../core/errors.mjs'
import { inspectSource, isArchivePath } from './source.mjs'
import { datasetView, versionView } from './store.mjs'

const STAGE_LABELS = {
  pending: '等待 worker',
  verifying: '校验文件指纹',
  importing: '导入',
  building: '去重与建索引',
  validating: '核对计数',
  ready: '待发布',
  published: '已发布',
  retired: '已下线',
  discarded: '已放弃',
}
const WORKER_STALE_MS = 2 * 60_000

function text(value, name, { max = 512, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new AppError(400, 'invalid_request', `${name} is required`)
    return null
  }
  if (typeof value !== 'string' || value.length > max) throw new AppError(400, 'invalid_request', `${name} must be a string of at most ${max} characters`)
  return value.trim() || null
}

export function versionProgress(row, partitions = []) {
  if (!row) return null
  const view = versionView(row)
  const bytes = view.source.bytes || 0
  let percent = 0
  let etaSeconds = null
  let estimatedTotalPairs = null
  // Inside a .zip the checkpoint counts uncompressed bytes of the entry.
  const contentBytes = view.source.entryBytes || bytes
  if (view.pairsRead > 0 && view.byteOffset > 0) {
    const bytesPerPair = view.byteOffset / view.pairsRead
    estimatedTotalPairs = view.parserState === 'end' ? view.pairsRead : Math.round(contentBytes / bytesPerPair)
    if (view.stage === 'importing' && view.rowsPerSecond > 0) {
      etaSeconds = Math.round(((contentBytes - view.byteOffset) / bytesPerPair) / view.rowsPerSecond)
    }
  }
  const steps = { staged: 0, deduplicated: 1, indexed: 2, attached: 3 }
  const partitionSteps = partitions.reduce((sum, partition) => sum + (steps[partition.step] ?? 0), 0)
  const totalSteps = (view.partitionCount || partitions.length || 1) * 3
  if (view.stage === 'verifying') percent = bytes ? view.source.shaBytes / bytes : 0
  else if (view.stage === 'importing') percent = contentBytes ? view.byteOffset / contentBytes : 0
  else if (view.stage === 'building') percent = partitionSteps / totalSteps
  else if (['validating', 'ready', 'published', 'retired'].includes(view.stage)) percent = 1
  const heartbeatAge = view.heartbeatAt ? Date.now() - Date.parse(view.heartbeatAt) : null
  return {
    ...view,
    stageLabel: STAGE_LABELS[view.stage] || view.stage,
    progress: {
      percent: Math.max(0, Math.min(1, percent)),
      estimatedTotalPairs,
      etaSeconds,
      partitionsDone: partitions.filter(partition => partition.step === 'attached').length,
      partitionStepsDone: partitionSteps,
      partitionStepsTotal: totalSteps,
      heartbeatAgeMs: heartbeatAge,
      workerStale: view.runState === 'running' && heartbeatAge !== null && heartbeatAge > WORKER_STALE_MS,
    },
    partitions: partitions.map(partition => ({
      no: partition.partition_no,
      step: partition.step,
      stagedRows: partition.staged_rows === null ? null : Number(partition.staged_rows),
      uniqueRows: partition.unique_rows === null ? null : Number(partition.unique_rows),
      tableBytes: partition.table_bytes === null ? null : Number(partition.table_bytes),
      indexBytes: partition.index_bytes === null ? null : Number(partition.index_bytes),
    })),
  }
}

export class FileDatasetPipeline {
  constructor({ store, product, serverFileReader = null }) {
    this.store = store
    this.product = product
    this.kind = store.kind
    this.serverFileReader = serverFileReader
  }

  get #extensions() {
    return { extensions: this.kind.extensions || this.product.sourceExtensions }
  }

  #reader() {
    if (!this.serverFileReader) throw new AppError(503, 'server_file_roots_unconfigured', 'Server file import roots are not configured on this listener')
    return this.serverFileReader
  }

  async get() {
    const dataset = await this.store.dataset()
    const open = await this.store.openVersion()
    const recent = await this.store.recentVersions(10)
    const byId = new Map(recent.map(row => [row.id, row]))
    const load = async id => id ? (byId.get(id) || await this.store.version(id)) : null
    return {
      key: this.product.key,
      label: this.product.pipelineLabel,
      summary: this.product.pipelineSummary,
      product: { label: this.product.label, path: this.product.productPath },
      datasetKey: this.product.key,
      source: {
        format: this.product.sourceFormat,
        extensions: this.#extensions.extensions,
        // A .zip on the server works too; the worker reads the entry as a stream.
        archiveExtensions: ['.zip'],
        defaultRelativePath: this.product.defaultSource.relativePath,
        defaultEntry: this.product.defaultSource.entry || null,
        defaultSha256: this.product.defaultSource.sha256 || null,
      },
      // PostgreSQL only: no canonical records, outbox, Elasticsearch, HanLP or embeddings.
      storage: { engine: 'postgresql', schema: 'account_dictionary', elasticsearch: false },
      dataset: datasetView(dataset),
      open: open ? versionProgress(open, await this.store.partitionRows(open.id)) : null,
      active: versionView(await load(dataset.active_version_id)),
      previous: versionView(await load(dataset.previous_version_id)),
      recent: recent.map(versionView),
      quarantineReasonLabels: this.kind.quarantineReasons,
      serverFiles: this.serverFileReader ? this.serverFileReader.describeRoots() : { enabled: false, roots: [] },
    }
  }

  async progress() {
    const open = await this.store.openVersion()
    return open ? versionProgress(open, await this.store.partitionRows(open.id)) : null
  }

  async #locator(body) {
    const reader = this.#reader()
    const serverPath = text(body.serverPath, 'serverPath', { max: 4096 })
    if (serverPath) return reader.locatorForPath(serverPath)
    return {
      rootId: text(body.rootId, 'rootId', { max: 64, required: true }),
      relativePath: text(body.relativePath, 'relativePath', { max: 4096, required: true }),
    }
  }

  async configure(body, { updatedBy }) {
    if (!body || typeof body !== 'object') throw new AppError(400, 'invalid_request', 'Request body must be an object')
    const unsupported = Object.keys(body).filter(key => !['serverPath', 'rootId', 'relativePath', 'entry', 'expectedSha256', 'owner', 'purpose', 'legalBasis'].includes(key))
    if (unsupported.length) throw new AppError(400, 'unsupported_fields', `Unsupported fields: ${unsupported.join(', ')}`)
    const locator = await this.#locator(body)
    const expected = text(body.expectedSha256, 'expectedSha256', { max: 64 })?.toLowerCase() ?? null
    if (expected && !/^[0-9a-f]{64}$/.test(expected)) throw new AppError(400, 'invalid_request', 'expectedSha256 must be 64 hexadecimal characters')
    const requestedEntry = text(body.entry, 'entry', { max: 1024 })
    const { file, entry, entries } = await inspectSource(this.#reader(), locator, {
      ...this.#extensions, entry: requestedEntry,
      preferredEntry: isArchivePath(locator.relativePath) ? this.product.defaultSource.entry || null : null,
    })
    const dataset = await this.store.configureSource({
      rootId: file.rootId, relativePath: file.relativePath, entry: entry?.name ?? null, expectedSha256: expected,
      owner: text(body.owner, 'owner', { max: 200 }), purpose: text(body.purpose, 'purpose', { max: 1000 }),
      legalBasis: text(body.legalBasis, 'legalBasis', { max: 1000 }), updatedBy,
    })
    return {
      dataset: datasetView(dataset),
      file: { rootId: file.rootId, relativePath: file.relativePath, filename: file.filename, bytes: file.bytes, mtime: file.mtime },
      archive: entries ? { entry, entries } : null,
    }
  }

  async action(body, { by }) {
    const action = body?.action
    if (action === 'start') {
      const dataset = await this.store.dataset()
      if (!dataset.source_root_id) throw new AppError(409, 'dictionary_source_unconfigured', '请先指定服务器上的源文件')
      const { file, entry } = await inspectSource(this.#reader(), { rootId: dataset.source_root_id, relativePath: dataset.source_relative_path }, {
        ...this.#extensions, entry: dataset.source_entry,
      })
      const created = await this.store.createVersion({ file, entry, expectedSha256: dataset.expected_sha256, createdBy: by })
      return versionProgress(created)
    }
    const open = await this.store.openVersion()
    if (!open) throw new AppError(409, 'dictionary_no_open_version', 'There is no version in progress')
    if (body?.versionId !== undefined && body.versionId !== open.id) throw new AppError(409, 'dictionary_version_changed', 'The version in progress changed; refresh and retry')
    let row
    if (action === 'pause') row = await this.store.requestPause(open.id)
    else if (action === 'resume') row = await this.store.requestResume(open.id)
    else if (action === 'discard') row = await this.store.requestDiscard(open.id)
    else throw new AppError(400, 'invalid_request', 'action must be start, pause, resume or discard')
    return versionProgress(row, await this.store.partitionRows(row.id))
  }

  async publish(body, { by }) {
    if (!Number.isSafeInteger(body?.versionId)) throw new AppError(400, 'invalid_request', 'versionId is required')
    return versionView(await this.store.publish(body.versionId, { publishedBy: by }))
  }

  async rollback({ by }) {
    return versionView(await this.store.rollback({ rolledBackBy: by }))
  }

  async accessLog() {
    return this.store.recentAccess(50)
  }
}
