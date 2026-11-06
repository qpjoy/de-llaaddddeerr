// Read path shared by every published file dataset.
//
// Stability rules (measured, see docs/architecture/file-datasets.md):
// - exact, prefix, suffix and domain lookups use B-tree indexes and run in
//   the fast lane with a short statement timeout;
// - substring and similar-spelling use trigram GIN indexes. They first pass a
//   cost precheck from sampled trigram frequencies, then run in a slow lane
//   that allows only a few concurrent queries across all Hub processes.
//   Too-broad queries get a clear 422 instead of loading the shared database;
// - the query text is never logged or stored; the audit keeps an HMAC.
import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError } from '../../core/errors.mjs'
import { SCHEMA, SLOW_LANE_LOCK_CLASS } from './store.mjs'

const ACTIVE_CACHE_MS = 5_000

export function tooBroad(message) {
  return new AppError(422, 'query_too_broad', message)
}

export function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&')
}

export class FileDatasetSearchBase {
  /**
   * `product` is the shared registry entry. Error codes derive from its
   * platform: <platform>_not_published and <platform>_busy.
   */
  constructor({ pool, store, hmacKey, limits, product, now = Date.now }) {
    if (!hmacKey) throw new Error(`${product.key} search requires an HMAC key`)
    Object.assign(this, { pool, store, hmacKey, limits, product, now })
    this.cached = null
    this.busyCode = `${product.platform}_busy`
    this.notPublishedCode = `${product.platform}_not_published`
  }

  notPublished() {
    return new AppError(503, this.notPublishedCode, `${this.product.label}尚未发布数据版本`)
  }

  async active({ fresh = false } = {}) {
    if (!fresh && this.cached && this.now() - this.cached.at < ACTIVE_CACHE_MS) return this.cached.value
    const value = await this.store.activeVersion()
    this.cached = { at: this.now(), value }
    return value
  }

  hmac(value) {
    return createHmac('sha256', this.hmacKey).update(`${this.store.datasetKey}:${value}`).digest('hex')
  }

  /**
   * Run `run(version)` against the active version, retrying once when the
   * version switched or was dropped between cache and query, and audit the
   * outcome. Returns { version, rows, tookMs }.
   */
  async execute(context, request, audit, run, { timeoutMessage }) {
    const startedAt = this.now()
    let version = await this.active()
    if (!version) throw this.notPublished()
    try {
      let rows
      try {
        rows = await run(version)
      } catch (error) {
        if (error.code !== '42P01') throw error
        version = await this.active({ fresh: true })
        if (!version) throw this.notPublished()
        rows = await run(version)
      }
      return { version, rows, startedAt }
    } catch (error) {
      const outcome = error.code === 'query_too_broad' ? 'too_broad'
        : error.code === this.busyCode ? 'busy'
          : error.code === '57014' ? 'timeout' : 'error'
      await this.audit(context, version, audit, outcome, 0, 0, this.now() - startedAt).catch(() => {})
      if (error.code === '57014') throw tooBroad(timeoutMessage)
      throw error
    }
  }

  async domainId(name) {
    const { rows } = await this.pool.query(`SELECT id FROM ${SCHEMA}.domains WHERE name = $1`, [name])
    return rows[0]?.id ?? null
  }

  async #trigramCounts(version, field, query) {
    const { rows } = await this.pool.query(
      `SELECT t.trigram, coalesce(sum(s.sample_count), 0)::bigint AS count
       FROM unnest(show_trgm(lower($1))) AS t(trigram)
       LEFT JOIN ${SCHEMA}.trigram_stats s
         ON s.version_id = $2 AND s.field = $3 AND s.trigram = t.trigram
       GROUP BY t.trigram`,
      [query, version.id, field],
    )
    const scale = version.sampleRows > 0 ? version.uniqueMappings / version.sampleRows : 0
    return rows.map(row => ({ trigram: row.trigram, estimate: Number(row.count) * scale }))
  }

  /** Upper-bound candidate estimate; throws query_too_broad above budget. */
  async trigramPrecheck(version, { field, mode, query }, messages) {
    const counts = await this.#trigramCounts(version, field, query)
    if (mode === 'contains') {
      // LIKE '%q%' can only use trigrams inside a word of 3+ letters/digits.
      const inner = counts.filter(row => !row.trigram.includes(' '))
      if (!inner.length) throw tooBroad('片段里至少要有连续 3 个字母或数字')
      const estimate = Math.min(...inner.map(row => row.estimate))
      if (estimate > this.limits.containsMaxCandidates) throw tooBroad(messages.contains)
      return estimate
    }
    // A match with similarity >= t shares at least ceil(t*k) of the k query
    // trigrams, so it must contain one of the (k - m + 1) rarest of them.
    if (!counts.length) throw tooBroad('近似匹配需要包含字母或数字')
    const k = counts.length
    const m = Math.ceil(this.limits.fuzzyThreshold * k)
    const rarest = counts.map(row => row.estimate).sort((a, b) => a - b).slice(0, k - m + 1)
    const estimate = rarest.reduce((sum, value) => sum + value, 0)
    if (estimate > this.limits.fuzzyMaxCandidates) throw tooBroad(messages.fuzzy)
    return estimate
  }

  /** One read-only statement with a timeout; slow queries take a lane slot. */
  async readOnly(sql, params, { slow = false, similarityThreshold = null } = {}) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const timeout = slow ? this.limits.slowStatementTimeoutMs : this.limits.fastStatementTimeoutMs
      await client.query(`SET LOCAL statement_timeout = ${Number(timeout)}`)
      if (slow) await this.#acquireSlowLane(client)
      if (similarityThreshold !== null) await client.query(`SET LOCAL pg_trgm.similarity_threshold = ${Number(similarityThreshold)}`)
      const { rows } = await client.query(sql, params)
      await client.query('COMMIT')
      return rows
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async #acquireSlowLane(client) {
    const deadline = this.now() + this.limits.slowLaneWaitMs
    while (true) {
      const { rows } = await client.query(
        `SELECT slot FROM generate_series(0, $2::integer - 1) AS slot WHERE pg_try_advisory_xact_lock($1::integer, slot) LIMIT 1`,
        [SLOW_LANE_LOCK_CLASS, this.limits.slowLaneSlots],
      )
      if (rows.length) return rows[0].slot
      if (this.now() >= deadline) {
        throw new AppError(503, this.busyCode, '片段/近似查询正忙，请稍后重试', { retryAfterMs: 1000 })
      }
      await delay(100)
    }
  }

  async audit(context, version, audit, outcome, resultCount, revealedCount, tookMs) {
    await this.pool.query(
      `INSERT INTO ${SCHEMA}.access_events (dataset_key, version_id, tenant_id, consumer_id, api_key_id, mode, field,
         query_hmac, outcome, result_count, revealed_count, took_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [this.store.datasetKey, version?.id ?? null, context?.tenant?.id ?? null, context?.consumer?.id ?? null,
        context?.apiKey?.id ?? null, audit.mode, audit.field ?? null, audit.hmac, outcome, resultCount, revealedCount, Math.round(tookMs)],
    )
  }
}
