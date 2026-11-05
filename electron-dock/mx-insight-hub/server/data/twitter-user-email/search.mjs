// Read path for the published Twitter user-email dictionary.
//
// Stability rules (measured, see the architecture doc):
// - exact and prefix lookups use B-tree indexes and run in the fast lane;
// - contains and fuzzy use trigram GIN indexes. They first pass a cost
//   precheck from sampled trigram frequencies, then run in a slow lane that
//   allows only a few concurrent queries across all Hub processes, each with
//   a short statement timeout. Too-broad queries get a clear 422 instead of
//   loading the shared database.
// - the query text is never logged or stored; audit keeps an HMAC.
import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError } from '../../core/errors.mjs'
import { CONTRACT_VERSION, PRODUCT_LABEL, QUERY_LIMITS, escapeLike, maskEmail } from './contract.mjs'
import { SCHEMA, SLOW_LANE_LOCK_CLASS, versionTables } from './store.mjs'

const ACTIVE_CACHE_MS = 5_000

function tooBroad(message) {
  return new AppError(422, 'query_too_broad', message)
}

export class TwitterUserEmailSearch {
  constructor({ pool, store, hmacKey, limits = QUERY_LIMITS, now = Date.now }) {
    if (!hmacKey) throw new Error('TwitterUserEmailSearch requires an HMAC key')
    Object.assign(this, { pool, store, hmacKey, limits, now })
    this.cached = null
  }

  async active({ fresh = false } = {}) {
    if (!fresh && this.cached && this.now() - this.cached.at < ACTIVE_CACHE_MS) return this.cached.value
    const value = await this.store.activeVersion()
    this.cached = { at: this.now(), value }
    return value
  }

  hmac(value) {
    return createHmac('sha256', this.hmacKey).update(`twitter-user-email:${value}`).digest('hex')
  }

  /** Usage fingerprint without plaintext query or domain. */
  fingerprint(request) {
    return {
      mode: request.mode,
      field: request.field,
      query: this.hmac(JSON.stringify([request.mode, request.field, request.query, request.domain])),
      limit: request.limit,
      reveal: request.reveal,
    }
  }

  async metadata() {
    const version = await this.active()
    return {
      contractVersion: CONTRACT_VERSION,
      product: PRODUCT_LABEL,
      published: Boolean(version),
      version: version ? { id: version.id, publishedAt: version.publishedAt, mappings: version.uniqueMappings } : null,
      modes: ['username', 'email', 'prefix', 'contains', 'fuzzy'],
      fields: ['username', 'email_local'],
      limits: {
        defaultLimit: this.limits.defaultLimit,
        maxLimit: this.limits.maxLimit,
        prefixMinChars: this.limits.prefixMinChars,
        containsMinChars: this.limits.containsMinChars,
        fuzzyMinChars: this.limits.fuzzyMinChars,
        fuzzyMaxChars: this.limits.fuzzyMaxChars,
      },
      masking: '默认返回脱敏邮箱；查看完整邮箱需要单独授权，并留审计记录。',
    }
  }

  async search(context, request) {
    const startedAt = this.now()
    let version = await this.active()
    if (!version) throw new AppError(503, 'twitter_user_email_not_published', 'Twitter 用户邮箱尚未发布数据版本')
    const audit = { mode: request.mode, field: request.field, hmac: this.hmac(JSON.stringify([request.mode, request.field, request.query, request.domain])) }
    try {
      let result
      try {
        result = await this.#run(version, request)
      } catch (error) {
        // A version switched or dropped between cache and query: retry once.
        if (error.code !== '42P01') throw error
        version = await this.active({ fresh: true })
        if (!version) throw new AppError(503, 'twitter_user_email_not_published', 'Twitter 用户邮箱尚未发布数据版本')
        result = await this.#run(version, request)
      }
      const items = result.map(row => this.#item(row, request))
      const tookMs = this.now() - startedAt
      await this.#audit(context, version, audit, 'ok', items.length, request.reveal ? items.length : 0, tookMs)
      return {
        contractVersion: CONTRACT_VERSION,
        items,
        meta: {
          datasetVersion: version.id,
          publishedAt: version.publishedAt,
          mode: request.mode,
          field: request.field,
          domain: request.domain,
          limit: request.limit,
          returned: items.length,
          truncated: items.length === request.limit,
          revealed: request.reveal,
          tookMs,
          note: '结果是来源文件记录的关联，近似匹配不代表已验证的账号归属。',
        },
      }
    } catch (error) {
      const outcome = error.code === 'query_too_broad' ? 'too_broad'
        : error.code === 'twitter_user_email_busy' ? 'busy'
          : error.code === '57014' ? 'timeout' : 'error'
      await this.#audit(context, version, audit, outcome, 0, 0, this.now() - startedAt).catch(() => {})
      if (error.code === '57014') throw tooBroad('查询超时：条件太宽，请补充更多字符、加域名，或改用前缀/精确查询')
      throw error
    }
  }

  #item(row, request) {
    const matchType = request.mode === 'username' || request.mode === 'email'
      ? (row.exact ? 'exact' : 'case_insensitive')
      : request.mode === 'fuzzy' ? 'similar' : request.mode
    return {
      username: row.username,
      email: request.reveal ? `${row.email_local}@${row.domain}` : maskEmail(row.email_local, row.domain),
      emailMasked: !request.reveal,
      domain: row.domain,
      matchType,
      matchedField: request.mode === 'username' ? 'username' : request.mode === 'email' ? 'email' : request.field,
      ...(row.score === undefined ? {} : { similarity: Math.round(Number(row.score) * 1000) / 1000 }),
      sourceRecords: Number(row.dup_count),
    }
  }

  async #domainId(name) {
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
      [query, version.id, field === 'username' ? 'u' : 'l'],
    )
    const scale = version.sampleRows > 0 ? version.uniqueMappings / version.sampleRows : 0
    return rows.map(row => ({ trigram: row.trigram, estimate: Number(row.count) * scale }))
  }

  /** Upper-bound candidate estimate; throws query_too_broad above budget. */
  async precheck(version, request) {
    const counts = await this.#trigramCounts(version, request.field, request.query)
    if (request.mode === 'contains') {
      // LIKE '%q%' can only use trigrams inside a word of 3+ letters/digits.
      const inner = counts.filter(row => !row.trigram.includes(' '))
      if (!inner.length) throw tooBroad('片段里至少要有连续 3 个字母或数字')
      const estimate = Math.min(...inner.map(row => row.estimate))
      if (estimate > this.limits.containsMaxCandidates) throw tooBroad('片段太常见，请补充更多字符或加域名')
      return estimate
    }
    // A match with similarity >= t shares at least ceil(t*k) of the k query
    // trigrams, so it must contain one of the (k - m + 1) rarest of them.
    if (!counts.length) throw tooBroad('近似匹配需要包含字母或数字')
    const k = counts.length
    const m = Math.ceil(this.limits.fuzzyThreshold * k)
    const rarest = counts.map(row => row.estimate).sort((a, b) => a - b).slice(0, k - m + 1)
    const estimate = rarest.reduce((sum, value) => sum + value, 0)
    if (estimate > this.limits.fuzzyMaxCandidates) throw tooBroad('近似匹配范围太大，请输入更长、更具体的用户名或改用前缀查询')
    return estimate
  }

  async #run(version, request) {
    const tables = versionTables(version.id, version.partitionCount)
    let domainId = null
    if (request.domain) {
      domainId = await this.#domainId(request.domain)
      if (domainId === null) return []
    }
    const slow = request.mode === 'contains' || request.mode === 'fuzzy'
    if (slow) await this.precheck(version, request)
    const column = request.field === 'email_local' ? 'email_local' : 'username'
    const select = `SELECT m.username, m.email_local, d.name AS domain, m.dup_count`
    const from = `FROM ${tables.mappings} m JOIN ${SCHEMA}.domains d ON d.id = m.domain_id`
    const params = []
    const param = value => { params.push(value); return `$${params.length}` }
    let sql
    if (request.mode === 'username') {
      const q = param(request.query)
      sql = `${select}, (m.username = ${q}) AS exact ${from}
        WHERE lower(m.username) = lower(${q})${domainId ? ` AND m.domain_id = ${param(domainId)}` : ''}
        ORDER BY exact DESC, m.first_ordinal LIMIT ${param(request.limit)}`
    } else if (request.mode === 'email') {
      const local = param(request.local)
      sql = `${select}, (m.email_local = ${local}) AS exact ${from}
        WHERE lower(m.email_local) = lower(${local}) AND m.domain_id = ${param(domainId)}
        ORDER BY exact DESC, m.first_ordinal LIMIT ${param(request.limit)}`
    } else if (request.mode === 'prefix') {
      // ORDER BY must use the text_pattern_ops operator, or the planner may
      // pick the trigram index and sort every prefix match (measured 108 ms vs 0.35 ms).
      sql = `${select} ${from}
        WHERE lower(m.${column}) LIKE lower(${param(escapeLike(request.query))}) || '%'
        ${domainId ? `AND m.domain_id = ${param(domainId)}` : ''}
        ORDER BY lower(m.${column}) USING ~<~ LIMIT ${param(request.limit)}`
    } else if (request.mode === 'contains') {
      sql = `${select} ${from}
        WHERE lower(m.${column}) LIKE '%' || lower(${param(escapeLike(request.query))}) || '%'
        ${domainId ? `AND m.domain_id = ${param(domainId)}` : ''}
        LIMIT ${param(request.limit)}`
    } else {
      const q = param(request.query)
      sql = `${select}, similarity(lower(m.${column}), lower(${q})) AS score ${from}
        WHERE lower(m.${column}) % lower(${q})
        ${domainId ? `AND m.domain_id = ${param(domainId)}` : ''}
        ORDER BY score DESC LIMIT ${param(request.limit)}`
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const timeout = slow ? this.limits.slowStatementTimeoutMs : this.limits.fastStatementTimeoutMs
      await client.query(`SET LOCAL statement_timeout = ${Number(timeout)}`)
      if (slow) await this.#acquireSlowLane(client)
      if (request.mode === 'fuzzy') await client.query(`SET LOCAL pg_trgm.similarity_threshold = ${Number(this.limits.fuzzyThreshold)}`)
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
        throw new AppError(503, 'twitter_user_email_busy', '片段/近似查询正忙，请稍后重试', { retryAfterMs: 1000 })
      }
      await delay(100)
    }
  }

  async #audit(context, version, audit, outcome, resultCount, revealedCount, tookMs) {
    await this.pool.query(
      `INSERT INTO ${SCHEMA}.access_events (dataset_key, version_id, tenant_id, consumer_id, api_key_id, mode, field,
         query_hmac, outcome, result_count, revealed_count, took_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [this.store.datasetKey, version?.id ?? null, context?.tenant?.id ?? null, context?.consumer?.id ?? null,
        context?.apiKey?.id ?? null, audit.mode, audit.field, audit.hmac, outcome, resultCount, revealedCount, Math.round(tookMs)],
    )
  }
}
