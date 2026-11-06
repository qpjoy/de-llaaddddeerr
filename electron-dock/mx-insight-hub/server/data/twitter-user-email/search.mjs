// Read path for the published Twitter user-email dictionary.
// Lanes, precheck, audit and version switching: ../file-datasets/search-base.mjs.
import { FileDatasetSearchBase, escapeLike } from '../file-datasets/search-base.mjs'
import { SCHEMA, versionTables } from '../file-datasets/store.mjs'
import { CONTRACT_VERSION, PRODUCT, PRODUCT_LABEL, QUERY_LIMITS, maskEmail } from './contract.mjs'

const TIMEOUT_MESSAGE = '查询超时：条件太宽，请补充更多字符、加域名，或改用前缀/精确查询'
const BROAD_MESSAGES = Object.freeze({
  contains: '片段太常见，请补充更多字符或加域名',
  fuzzy: '近似匹配范围太大，请输入更长、更具体的用户名或改用前缀查询',
})

export class TwitterUserEmailSearch extends FileDatasetSearchBase {
  constructor({ pool, store, hmacKey, limits = QUERY_LIMITS, now = Date.now }) {
    super({ pool, store, hmacKey, limits, product: PRODUCT, now })
  }

  #auditKey(request) {
    return JSON.stringify([request.mode, request.field, request.query, request.domain])
  }

  /** Usage fingerprint without plaintext query or domain. */
  fingerprint(request) {
    return {
      mode: request.mode,
      field: request.field,
      query: this.hmac(this.#auditKey(request)),
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
      defaultReveal: true,
      masking: '查询默认返回完整邮箱，传入 reveal:false 可返回脱敏邮箱。完整邮箱查看次数计入审计。',
    }
  }

  async search(context, request) {
    const audit = { mode: request.mode, field: request.field, hmac: this.hmac(this.#auditKey(request)) }
    const { version, rows, startedAt } = await this.execute(context, request, audit, current => this.#run(current, request), { timeoutMessage: TIMEOUT_MESSAGE })
    const items = rows.map(row => this.#item(row, request))
    const tookMs = this.now() - startedAt
    await this.audit(context, version, audit, 'ok', items.length, request.reveal ? items.length : 0, tookMs)
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

  /** Upper-bound candidate estimate; throws query_too_broad above budget. */
  async precheck(version, request) {
    return this.trigramPrecheck(version, {
      field: request.field === 'username' ? 'u' : 'l', mode: request.mode, query: request.query,
    }, BROAD_MESSAGES)
  }

  async #run(version, request) {
    const tables = versionTables(version.id, version.partitionCount)
    let domainId = null
    if (request.domain) {
      domainId = await this.domainId(request.domain)
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
    return this.readOnly(sql, params, { slow, similarityThreshold: request.mode === 'fuzzy' ? this.limits.fuzzyThreshold : null })
  }
}
