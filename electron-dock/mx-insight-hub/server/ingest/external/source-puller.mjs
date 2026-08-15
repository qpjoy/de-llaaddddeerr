import { AppError } from '../../core/errors.mjs'
import { DatabaseSourcePuller } from './database-source.mjs'
import { SQLiteApiSourcePuller } from './sqlite-api-source.mjs'

/** Route the existing external-source contract to its engine-specific puller. */
export class ExternalSourcePuller {
  constructor({ store, queue, logger = console, databasePuller = null, sqliteApiPuller = null }) {
    this.store = store
    this.databasePuller = databasePuller ?? new DatabaseSourcePuller({ store, queue, logger })
    this.sqliteApiPuller = sqliteApiPuller ?? new SQLiteApiSourcePuller({ store, queue, logger })
  }

  #forKind(sourceKind) {
    if (sourceKind === 'database') return this.databasePuller
    if (sourceKind === 'sqlite_api') return this.sqliteApiPuller
    throw new AppError(400, 'wrong_source_kind', `Unsupported pull source kind: ${sourceKind}`)
  }

  async #forSource(sourceKey) {
    const source = await this.store.getExternalSource(sourceKey)
    if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    return this.#forKind(source.sourceKind)
  }

  testConnection(connection, { sourceKind = connection?.baseUrl ? 'sqlite_api' : 'database' } = {}) {
    return this.#forKind(sourceKind).testConnection(connection)
  }

  async testSource(sourceKey) {
    return (await this.#forSource(sourceKey)).testSource(sourceKey)
  }

  async describe(sourceKey, options) {
    return (await this.#forSource(sourceKey)).describe(sourceKey, options)
  }

  async preview(sourceKey, options) {
    return (await this.#forSource(sourceKey)).preview(sourceKey, options)
  }

  async progress(sourceKey) {
    return (await this.#forSource(sourceKey)).progress(sourceKey)
  }

  async assertCheckpointCompatible(sourceKey, options) {
    return (await this.#forSource(sourceKey)).assertCheckpointCompatible(sourceKey, options)
  }

  async resetCheckpoint(sourceKey) {
    return (await this.#forSource(sourceKey)).resetCheckpoint(sourceKey)
  }

  async resetCheckpoints(sourceKeys, options) {
    if (!Array.isArray(sourceKeys) || sourceKeys.length === 0) return []
    const delegates = await Promise.all(sourceKeys.map((sourceKey) => this.#forSource(sourceKey)))
    if (!delegates.every((delegate) => delegate === delegates[0])) {
      throw new AppError(400, 'mixed_source_kinds', 'A checkpoint batch cannot mix source kinds')
    }
    return delegates[0].resetCheckpoints(sourceKeys, options)
  }

  async withSourceLock(sourceKey, operation) {
    return (await this.#forSource(sourceKey)).withSourceLock(sourceKey, operation)
  }

  async withSourceLocks(sourceKeys, operation) {
    if (!Array.isArray(sourceKeys) || sourceKeys.length === 0) return operation(async () => {}, [])
    const delegates = await Promise.all(sourceKeys.map((sourceKey) => this.#forSource(sourceKey)))
    if (!delegates.every((delegate) => delegate === delegates[0])) {
      throw new AppError(400, 'mixed_source_kinds', 'A source lock batch cannot mix source kinds')
    }
    return delegates[0].withSourceLocks(sourceKeys, operation)
  }

  async pullBatch(sourceKey, options) {
    return (await this.#forSource(sourceKey)).pullBatch(sourceKey, options)
  }

  async markContinuationFailed(sourceKey, importRunId, error) {
    return (await this.#forSource(sourceKey)).markContinuationFailed(sourceKey, importRunId, error)
  }

  async markSourceContractFailed(sourceKey, error) {
    const puller = await this.#forSource(sourceKey)
    if (typeof puller.markSourceContractFailed !== 'function') {
      throw new AppError(409, 'source_contract_mismatch', 'Source contract requires operator action')
    }
    return puller.markSourceContractFailed(sourceKey, error)
  }
}
