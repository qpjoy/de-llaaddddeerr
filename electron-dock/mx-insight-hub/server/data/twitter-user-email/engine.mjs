// Dictionary worker engine: one version at a time, resumable at every step.
//
//   verifying  stream the file once, SHA-256 must match the expected value
//   importing  50k-pair batches; rows, quarantine and the byte checkpoint
//              commit in one transaction; paced to protect the shared disk
//   building   per partition: deduplicate -> 4 indexes + VACUUM FREEZE +
//              trigram sample -> attach to mappings_v<N>
//   validating counts must balance, sample lookups must hit -> ready
//
// Pause, resume and discard are read from PostgreSQL between batches and
// between partition steps; a stopped worker simply resumes from the saved
// checkpoint on its next start.
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  IMPORT_BATCH_PAIRS, IMPORT_READ_CHUNK_BYTES, IMPORT_SLOW_COMMIT_MS, IMPORT_TARGET_ROWS_PER_SECOND,
  SHA_MAX_BYTES_PER_SECOND, classifyPair,
} from './contract.mjs'
import { readPairWindows, JsonPairsError } from './json-pairs.mjs'
import { OPEN_STAGES, SCHEMA, WORKER_LOCK, versionTables } from './store.mjs'

const RAW_SAMPLE_BYTES = 1024
const DOMAIN_CACHE_LIMIT = 2_000_000
const SHA_PROGRESS_BYTES = 256 * 1024 * 1024
const SAMPLE_TARGET_ROWS = 125_000

class StopSignal extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

export class WorkerFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function publicFailure(error) {
  if (error instanceof WorkerFailure) return { code: error.code, message: error.message }
  if (error instanceof JsonPairsError) return { code: 'malformed_source_json', message: error.message }
  if (error?.code && /^[0-9A-Z]{5}$/.test(error.code)) {
    // PostgreSQL detail text can quote row values; keep only the SQLSTATE.
    return { code: 'database_error', message: `PostgreSQL error ${error.code}` }
  }
  if (error?.code && typeof error.code === 'string' && error.code.startsWith('server_file')) {
    return { code: error.code, message: error.message }
  }
  return { code: 'dictionary_worker_error', message: 'Dictionary worker failed; see worker logs' }
}

async function readExact(fileHandle, position, length) {
  const buffer = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await fileHandle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

function rawBytes(buf, start, stop) {
  return Buffer.from(buf.subarray(start, Math.min(stop, start + RAW_SAMPLE_BYTES)))
}

export class TwitterUserEmailEngine {
  constructor({
    pool, store, fileReader, logger = console, workerId = `dictionary-${process.pid}`,
    batchPairs = IMPORT_BATCH_PAIRS, chunkBytes = IMPORT_READ_CHUNK_BYTES,
    targetRowsPerSecond = IMPORT_TARGET_ROWS_PER_SECOND, shaBytesPerSecond = SHA_MAX_BYTES_PER_SECOND,
    sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}),
    // Test hook: awaited after every committed import batch.
    afterBatch = null,
  }) {
    Object.assign(this, { pool, store, fileReader, logger, workerId, batchPairs, chunkBytes, targetRowsPerSecond, shaBytesPerSecond, sleep, afterBatch })
    this.domainCache = new Map()
  }

  /** Process the open version until it pauses, fails or becomes ready. */
  async runOpenVersion(signal) {
    const version = await this.store.openVersion()
    if (!version) return 'idle'
    if (version.desired_state === 'discard') {
      const client = await this.pool.connect()
      try { await this.store.discardVersion(client, version) } finally { client.release() }
      this.logger.log?.(`[dictionary] version ${version.id} discarded`)
      return 'discarded'
    }
    if (version.stage === 'ready') return 'ready'
    if (version.desired_state === 'paused') {
      if (version.run_state !== 'paused') await this.#setRunState(version.id, 'paused')
      return 'paused'
    }
    if (version.run_state === 'failed') return 'failed'
    await this.pool.query(
      `UPDATE ${SCHEMA}.versions SET run_state = 'running', worker_id = $2, heartbeat_at = now(),
         started_at = coalesce(started_at, now()), updated_at = now() WHERE id = $1`,
      [version.id, this.workerId],
    )
    try {
      let current = version
      while (true) {
        if (signal?.aborted) throw new StopSignal('shutdown')
        if (current.stage === 'pending') current = await this.#advance(current.id, 'verifying')
        else if (current.stage === 'verifying') current = await this.#verify(current, signal)
        else if (current.stage === 'importing') current = await this.#import(current, signal)
        else if (current.stage === 'building') current = await this.#build(current, signal)
        else if (current.stage === 'validating') current = await this.#validate(current)
        else break
      }
      this.logger.log?.(`[dictionary] version ${version.id} is ${current.stage}`)
      return current.stage
    } catch (error) {
      if (error instanceof StopSignal) {
        if (error.reason === 'discard') return this.runOpenVersion(signal)
        // Shutdown leaves the version runnable; pause is acknowledged.
        await this.#setRunState(version.id, error.reason === 'paused' ? 'paused' : 'waiting').catch(() => {})
        return error.reason
      }
      const failure = publicFailure(error)
      this.logger.error?.(`[dictionary] version ${version.id} failed: ${failure.code}`, error)
      await this.pool.query(
        `UPDATE ${SCHEMA}.versions SET run_state = 'failed', error_code = $2, error_message = $3, updated_at = now() WHERE id = $1`,
        [version.id, failure.code, failure.message],
      ).catch(() => {})
      return 'failed'
    }
  }

  /** Drop tables of discarded versions and of retired versions beyond the rollback target. */
  async cleanup() {
    const client = await this.pool.connect()
    try {
      for (const version of await this.store.droppableVersions(client)) {
        await this.store.dropVersionTables(client, version.id, version.partition_count)
        await client.query(`UPDATE ${SCHEMA}.versions SET data_dropped_at = now(), updated_at = now() WHERE id = $1`, [version.id])
        this.logger.log?.(`[dictionary] dropped data of version ${version.id}`)
      }
    } finally {
      client.release()
    }
  }

  async #setRunState(id, runState) {
    await this.pool.query(`UPDATE ${SCHEMA}.versions SET run_state = $2, updated_at = now() WHERE id = $1`, [id, runState])
  }

  async #advance(id, stage, extra = '') {
    const { rows } = await this.pool.query(
      `UPDATE ${SCHEMA}.versions SET stage = $2, heartbeat_at = now(), updated_at = now() ${extra} WHERE id = $1 RETURNING *`,
      [id, stage],
    )
    return rows[0]
  }

  // Throws StopSignal when the operator paused or discarded the version.
  async #control(id, signal) {
    if (signal?.aborted) throw new StopSignal('shutdown')
    const { rows } = await this.pool.query(
      `UPDATE ${SCHEMA}.versions SET heartbeat_at = now() WHERE id = $1 RETURNING desired_state, stage`,
      [id],
    )
    const state = rows[0]?.desired_state
    if (!rows[0] || !OPEN_STAGES.includes(rows[0].stage)) throw new StopSignal('discard')
    if (state === 'paused') throw new StopSignal('paused')
    if (state === 'discard') throw new StopSignal('discard')
  }

  async #openSource(version) {
    const file = await this.fileReader.openLargeLocator({ rootId: version.source_root_id, relativePath: version.source_relative_path })
    if (file.identity !== version.source_identity || file.bytes !== Number(version.source_bytes) || file.mtimeNs !== version.source_mtime_ns) {
      await file.fileHandle.close().catch(() => {})
      throw new WorkerFailure('source_changed', 'The source file was replaced or modified after this version started; discard it and start again')
    }
    return file
  }

  async #verify(version, signal) {
    const file = await this.#openSource(version)
    try {
      const hash = createHash('sha256')
      let position = 0
      let reported = 0
      const startedAt = Date.now()
      await this.pool.query(`UPDATE ${SCHEMA}.versions SET sha_bytes = 0 WHERE id = $1`, [version.id])
      while (position < file.bytes) {
        const chunk = await readExact(file.fileHandle, position, Math.min(this.chunkBytes, file.bytes - position))
        if (chunk.length === 0) throw new WorkerFailure('source_changed', 'The source file became shorter while being verified')
        hash.update(chunk)
        position += chunk.length
        if (position - reported >= SHA_PROGRESS_BYTES || position === file.bytes) {
          reported = position
          await this.pool.query(`UPDATE ${SCHEMA}.versions SET sha_bytes = $2, heartbeat_at = now() WHERE id = $1`, [version.id, position])
          await this.#control(version.id, signal)
        }
        const waitMs = (position / this.shaBytesPerSecond) * 1000 - (Date.now() - startedAt)
        if (waitMs >= 1) await this.sleep(waitMs, signal)
      }
      const digest = hash.digest('hex')
      if (version.expected_sha256 && digest !== version.expected_sha256) {
        throw new WorkerFailure('source_sha256_mismatch', `Source SHA-256 ${digest} does not match the expected value`)
      }
      const { rows } = await this.pool.query(
        `UPDATE ${SCHEMA}.versions SET source_sha256 = $2, stage = 'importing', heartbeat_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [version.id, digest],
      )
      return rows[0]
    } finally {
      await file.fileHandle.close().catch(() => {})
    }
  }

  async #prepareTables(version) {
    const tables = versionTables(version.id, version.partition_count)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`CREATE TABLE IF NOT EXISTS ${tables.stage} (
        ordinal bigint NOT NULL, domain_id integer NOT NULL, flags smallint NOT NULL,
        username text NOT NULL, email_local text NOT NULL
      ) PARTITION BY HASH (lower(username))`)
      for (let k = 0; k < tables.partitions; k += 1) {
        // Append-only and dropped after deduplication: no autovacuum churn.
        await client.query(`CREATE TABLE IF NOT EXISTS ${tables.stageLeaf(k)} PARTITION OF ${tables.stage}
          FOR VALUES WITH (MODULUS ${tables.partitions}, REMAINDER ${k}) WITH (autovacuum_enabled = false)`)
      }
      await client.query(`CREATE TABLE IF NOT EXISTS ${tables.mappings} (
        first_ordinal bigint NOT NULL, domain_id integer NOT NULL, dup_count integer NOT NULL,
        flags smallint NOT NULL, username text NOT NULL, email_local text NOT NULL
      ) PARTITION BY HASH (lower(username))`)
      await client.query(
        `INSERT INTO ${SCHEMA}.version_partitions (version_id, partition_no)
         SELECT $1, generate_series(0, $2 - 1) ON CONFLICT DO NOTHING`,
        [version.id, tables.partitions],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    return tables
  }

  async #import(version, signal) {
    const tables = await this.#prepareTables(version)
    const file = await this.#openSource(version)
    try {
      let ordinal = Number(version.pairs_read)
      let offset = Number(version.byte_offset)
      let batch = this.#emptyBatch()
      let lastCommitAt = Date.now()
      const commit = async (state) => {
        const seconds = Math.max(0.001, (Date.now() - lastCommitAt) / 1000)
        const next = await this.#commitBatch(version, tables, batch, offset, state, Math.round((batch.pairs / seconds) * 10) / 10)
        lastCommitAt = Date.now()
        return next
      }
      const windows = readPairWindows({
        read: (position, length) => readExact(file.fileHandle, position, length),
        size: file.bytes,
        offset,
        state: version.parser_state,
        chunkBytes: this.chunkBytes,
      })
      for await (const window of windows) {
        for (const pair of window.pairs) {
          const result = classifyPair(pair.key, pair.value)
          if (result.reason) {
            batch.quarantine.ordinals.push(ordinal)
            batch.quarantine.reasons.push(result.reason)
            batch.quarantine.keys.push(rawBytes(window.buf, pair.key.start, pair.key.stop))
            batch.quarantine.values.push(rawBytes(window.buf, pair.value.start, pair.value.stop))
            batch.reasonCounts[result.reason] = (batch.reasonCounts[result.reason] || 0) + 1
          } else {
            batch.rows.ordinals.push(ordinal)
            batch.rows.domains.push(result.domain)
            batch.rows.flags.push(result.flags)
            batch.rows.usernames.push(result.username)
            batch.rows.locals.push(result.local)
          }
          ordinal += 1
          batch.pairs += 1
          batch.endOffset = pair.endOffset
          if (batch.pairs >= this.batchPairs) {
            offset = await commit('after_pair')
            batch = this.#emptyBatch()
            await this.#control(version.id, signal)
          }
        }
        if (window.state === 'end') {
          batch.endOffset = file.bytes
          offset = await commit('end')
          return this.#advance(version.id, 'building', ', imported_at = now()')
        }
      }
      throw new WorkerFailure('malformed_source_json', 'The source file ended before its closing brace')
    } finally {
      await file.fileHandle.close().catch(() => {})
    }
  }

  #emptyBatch() {
    return {
      pairs: 0,
      endOffset: null,
      reasonCounts: {},
      rows: { ordinals: [], domains: [], flags: [], usernames: [], locals: [] },
      quarantine: { ordinals: [], reasons: [], keys: [], values: [] },
    }
  }

  async #commitBatch(version, tables, batch, expectedOffset, parserState, rowsPerSecond) {
    const startedAt = Date.now()
    const client = await this.pool.connect()
    const resolved = new Map()
    try {
      await client.query('BEGIN')
      const missing = [...new Set(batch.rows.domains.filter(name => !this.domainCache.has(name)))]
      if (missing.length) {
        await client.query(
          `INSERT INTO ${SCHEMA}.domains (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
          [missing],
        )
        const { rows } = await client.query(`SELECT id, name FROM ${SCHEMA}.domains WHERE name = ANY($1::text[])`, [missing])
        for (const row of rows) resolved.set(row.name, row.id)
      }
      const domainIds = batch.rows.domains.map(name => this.domainCache.get(name) ?? resolved.get(name))
      if (batch.rows.ordinals.length) {
        await client.query(
          `INSERT INTO ${tables.stage} (ordinal, domain_id, flags, username, email_local)
           SELECT * FROM unnest($1::bigint[], $2::integer[], $3::smallint[], $4::text[], $5::text[])`,
          [batch.rows.ordinals, domainIds, batch.rows.flags, batch.rows.usernames, batch.rows.locals],
        )
      }
      if (batch.quarantine.ordinals.length) {
        await client.query(
          `INSERT INTO ${SCHEMA}.quarantine (version_id, ordinal, reason, key_raw, value_raw)
           SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::bytea[], $5::bytea[])`,
          [version.id, batch.quarantine.ordinals, batch.quarantine.reasons, batch.quarantine.keys, batch.quarantine.values],
        )
      }
      const { rowCount } = await client.query(
        `UPDATE ${SCHEMA}.versions SET
           byte_offset = $2, parser_state = $3,
           pairs_read = pairs_read + $4, pairs_loaded = pairs_loaded + $5, pairs_quarantined = pairs_quarantined + $6,
           quarantine_reasons = (
             SELECT coalesce(jsonb_object_agg(reason, total), '{}'::jsonb) FROM (
               SELECT key AS reason, sum(value::bigint) AS total
               FROM (SELECT * FROM jsonb_each_text(quarantine_reasons) UNION ALL SELECT * FROM jsonb_each_text($7::jsonb)) parts
               GROUP BY key
             ) merged
           ),
           recent_rows_per_second = $8, heartbeat_at = now(), updated_at = now()
         WHERE id = $1 AND stage = 'importing' AND byte_offset = $9`,
        [version.id, batch.endOffset ?? expectedOffset, parserState, batch.pairs, batch.rows.ordinals.length,
          batch.quarantine.ordinals.length, JSON.stringify(batch.reasonCounts), rowsPerSecond, expectedOffset],
      )
      if (rowCount !== 1) throw new WorkerFailure('checkpoint_conflict', 'The import checkpoint changed underneath this worker')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    // Only committed domain ids may enter the cache.
    if (this.domainCache.size + resolved.size > DOMAIN_CACHE_LIMIT) this.domainCache.clear()
    for (const [name, id] of resolved) this.domainCache.set(name, id)
    const commitMs = Date.now() - startedAt
    const pacingMs = (batch.pairs / this.targetRowsPerSecond) * 1000 - commitMs
    // Back off harder when the database is slow to commit (shared disk).
    const backoffMs = commitMs > IMPORT_SLOW_COMMIT_MS ? commitMs * 2 : 0
    if (pacingMs + backoffMs >= 1) await this.sleep(pacingMs + backoffMs)
    await this.afterBatch?.(version, { pairs: batch.pairs })
    return batch.endOffset ?? expectedOffset
  }

  async #build(version, signal) {
    const tables = versionTables(version.id, version.partition_count)
    for (const partition of await this.store.partitionRows(version.id)) {
      const k = partition.partition_no
      let step = partition.step
      if (step === 'staged') { await this.#deduplicate(version, tables, k); step = 'deduplicated'; await this.#control(version.id, signal) }
      if (step === 'deduplicated') { await this.#index(version, tables, k); step = 'indexed'; await this.#control(version.id, signal) }
      if (step === 'indexed') { await this.#attach(version, tables, k); await this.#control(version.id, signal) }
    }
    await this.pool.query(`DROP TABLE IF EXISTS ${tables.stage}`)
    return this.#advance(version.id, 'validating')
  }

  async #deduplicate(version, tables, k) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL work_mem = '256MB'`)
      await client.query(`CREATE TABLE IF NOT EXISTS ${tables.leaf(k)} (
        first_ordinal bigint NOT NULL, domain_id integer NOT NULL, dup_count integer NOT NULL,
        flags smallint NOT NULL, username text NOT NULL, email_local text NOT NULL
      )`)
      await client.query(`TRUNCATE ${tables.leaf(k)}`)
      // Exact duplicates of (username, e-mail local part, domain) collapse into
      // one row; byte-wise "C" grouping keeps case variants apart and sorts fast.
      await client.query(`INSERT INTO ${tables.leaf(k)} (first_ordinal, domain_id, dup_count, flags, username, email_local)
        SELECT min(ordinal), domain_id, count(*)::integer, bit_or(flags)::smallint, u, l
        FROM (SELECT ordinal, domain_id, flags, username COLLATE "C" AS u, email_local COLLATE "C" AS l
              FROM ${tables.stageLeaf(k)}) source
        GROUP BY u, l, domain_id`)
      const { rows } = await client.query(`SELECT count(*)::bigint AS unique_rows, coalesce(sum(dup_count), 0)::bigint AS staged_rows FROM ${tables.leaf(k)}`)
      await client.query(`DROP TABLE ${tables.stageLeaf(k)}`)
      await client.query(
        `UPDATE ${SCHEMA}.version_partitions SET step = 'deduplicated', staged_rows = $3, unique_rows = $4, updated_at = now()
         WHERE version_id = $1 AND partition_no = $2 AND step = 'staged'`,
        [version.id, k, rows[0].staged_rows, rows[0].unique_rows],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async #index(version, tables, k) {
    const leaf = tables.leaf(k)
    const name = tables.leafName(k)
    const client = await this.pool.connect()
    try {
      await client.query(`SET maintenance_work_mem = '1GB'`)
      await client.query(`CREATE INDEX IF NOT EXISTS ${name}_user ON ${leaf} (lower(username) text_pattern_ops)`)
      await client.query(`CREATE INDEX IF NOT EXISTS ${name}_local ON ${leaf} (lower(email_local) text_pattern_ops, domain_id)`)
      await client.query(`CREATE INDEX IF NOT EXISTS ${name}_user_trgm ON ${leaf} USING gin (lower(username) gin_trgm_ops)`)
      await client.query(`CREATE INDEX IF NOT EXISTS ${name}_local_trgm ON ${leaf} USING gin (lower(email_local) gin_trgm_ops)`)
      // Read-only after this point: freeze now so no anti-wraparound vacuum
      // ever has to rescan the dictionary later.
      await client.query(`VACUUM (FREEZE, ANALYZE) ${leaf}`)
      await client.query('BEGIN')
      const uniqueRows = Number((await client.query(
        `SELECT unique_rows FROM ${SCHEMA}.version_partitions WHERE version_id = $1 AND partition_no = $2`, [version.id, k],
      )).rows[0]?.unique_rows || 0)
      const percent = uniqueRows <= SAMPLE_TARGET_ROWS ? 100 : Math.max(1, Math.min(100, (SAMPLE_TARGET_ROWS / uniqueRows) * 100))
      await client.query(`DELETE FROM ${SCHEMA}.trigram_stats WHERE version_id = $1 AND partition_no = $2`, [version.id, k])
      const sampleClause = percent >= 100 ? '' : `TABLESAMPLE SYSTEM (${percent.toFixed(4)}) REPEATABLE (${k + 1})`
      const { rows } = await client.query(
        `WITH sample AS MATERIALIZED (SELECT lower(username) AS u, lower(email_local) AS l FROM ${leaf} ${sampleClause}),
         user_trigrams AS (
           INSERT INTO ${SCHEMA}.trigram_stats (version_id, field, trigram, partition_no, sample_count)
           SELECT $1, 'u', t, $2, count(*) FROM sample, unnest(show_trgm(u)) t GROUP BY t RETURNING 1),
         local_trigrams AS (
           INSERT INTO ${SCHEMA}.trigram_stats (version_id, field, trigram, partition_no, sample_count)
           SELECT $1, 'l', t, $2, count(*) FROM sample, unnest(show_trgm(l)) t GROUP BY t RETURNING 1)
         SELECT (SELECT count(*) FROM sample)::bigint AS sample_rows,
                (SELECT count(*) FROM user_trigrams) + (SELECT count(*) FROM local_trigrams) AS trigram_rows`,
        [version.id, k],
      )
      await client.query(
        `UPDATE ${SCHEMA}.version_partitions SET step = 'indexed', sample_rows = $3,
           table_bytes = pg_table_size($4::regclass), index_bytes = pg_indexes_size($4::regclass), updated_at = now()
         WHERE version_id = $1 AND partition_no = $2 AND step = 'deduplicated'`,
        [version.id, k, rows[0].sample_rows, leaf],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      await client.query('RESET maintenance_work_mem').catch(() => {})
      client.release()
    }
  }

  async #attach(version, tables, k) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = '30s'`)
      await client.query(`ALTER TABLE ${tables.mappings} ATTACH PARTITION ${tables.leaf(k)}
        FOR VALUES WITH (MODULUS ${tables.partitions}, REMAINDER ${k})`)
      await client.query(
        `UPDATE ${SCHEMA}.version_partitions SET step = 'attached', updated_at = now()
         WHERE version_id = $1 AND partition_no = $2 AND step = 'indexed'`,
        [version.id, k],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async #validate(version) {
    const tables = versionTables(version.id, version.partition_count)
    const fresh = await this.store.version(version.id)
    const partitions = await this.store.partitionRows(version.id)
    const notAttached = partitions.filter(row => row.step !== 'attached')
    if (notAttached.length) throw new WorkerFailure('build_incomplete', `${notAttached.length} partitions are not attached`)
    const staged = partitions.reduce((sum, row) => sum + Number(row.staged_rows || 0), 0)
    const unique = partitions.reduce((sum, row) => sum + Number(row.unique_rows || 0), 0)
    const sampleRows = partitions.reduce((sum, row) => sum + Number(row.sample_rows || 0), 0)
    const tableBytes = partitions.reduce((sum, row) => sum + Number(row.table_bytes || 0), 0)
    const indexBytes = partitions.reduce((sum, row) => sum + Number(row.index_bytes || 0), 0)
    const read = Number(fresh.pairs_read)
    const loaded = Number(fresh.pairs_loaded)
    const quarantined = Number(fresh.pairs_quarantined)
    if (read !== loaded + quarantined) {
      throw new WorkerFailure('count_mismatch', `pairs read ${read} != loaded ${loaded} + quarantined ${quarantined}`)
    }
    if (staged !== loaded) throw new WorkerFailure('count_mismatch', `staged rows ${staged} != loaded pairs ${loaded}`)
    await this.pool.query(`ANALYZE ${tables.mappings}`)
    // Acceptance: sampled rows must be found again through both lookup paths.
    const { rows: samples } = await this.pool.query(`SELECT username, email_local, domain_id FROM ${tables.mappings} LIMIT 5`)
    for (const sample of samples) {
      const byUser = await this.pool.query(`SELECT 1 FROM ${tables.mappings} WHERE lower(username) = lower($1) LIMIT 1`, [sample.username])
      const byEmail = await this.pool.query(
        `SELECT 1 FROM ${tables.mappings} WHERE lower(email_local) = lower($1) AND domain_id = $2 LIMIT 1`,
        [sample.email_local, sample.domain_id],
      )
      if (!byUser.rows.length || !byEmail.rows.length) throw new WorkerFailure('acceptance_failed', 'A sampled mapping could not be found through its index')
    }
    const { rows } = await this.pool.query(
      `UPDATE ${SCHEMA}.versions SET stage = 'ready', run_state = 'done', unique_mappings = $2, duplicate_pairs = $3,
         sample_rows = $4, table_bytes = $5, index_bytes = $6, ready_at = now(), heartbeat_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [version.id, unique, loaded - unique, sampleRows, tableBytes, indexBytes],
    )
    return rows[0]
  }
}

/**
 * Long-running loop for the dedicated worker process: hold the singleton
 * advisory lock, process the open version, clean up old versions, repeat.
 */
export async function runDictionaryWorker({ pool, engine, logger = console, pollMs = 5_000, signal }) {
  let lockClient = null
  let lockLost = false
  const releaseLock = async () => {
    if (!lockClient) return
    const client = lockClient
    lockClient = null
    await client.query('SELECT pg_advisory_unlock($1, $2)', WORKER_LOCK).catch(() => {})
    client.release()
  }
  try {
    while (!signal?.aborted) {
      try {
        if (!lockClient || lockLost) {
          await releaseLock()
          lockLost = false
          const client = await pool.connect()
          const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', WORKER_LOCK)
          if (rows[0]?.acquired) {
            lockClient = client
            client.on('error', () => { lockLost = true })
            logger.log?.('[dictionary] worker lock acquired')
          } else {
            client.release()
          }
        }
        if (lockClient && !lockLost) {
          const outcome = await engine.runOpenVersion(signal)
          await engine.cleanup()
          // Keep going immediately after a discard so the next state is seen.
          if (outcome === 'discarded') continue
        }
      } catch (error) {
        logger.error?.('[dictionary] worker pass failed', error)
        lockLost = true
      }
      await delay(pollMs, undefined, { signal }).catch(() => {})
    }
  } finally {
    await releaseLock()
  }
}
