// Read path for the published "邮箱库" (e-mail list).
//
//   email     exact address (case-insensitive local part, exact domain)
//   prefix    local-part prefix, optional domain filter          B-tree
//   domain    every address at a domain, keyset pages           B-tree
//   contains  local-part substring, optional domain   precheck + slow lane
//   fuzzy     local-part similar spelling              precheck + slow lane
import { FileDatasetSearchBase, escapeLike } from '../file-datasets/search-base.mjs'
import { SCHEMA, versionTables } from '../file-datasets/store.mjs'
import {
  CONTRACT_VERSION, CURSOR_MODES, MODES, PRODUCT, QUERY_LIMITS, encodeCursor, maskLocal,
} from './contract.mjs'

const TIMEOUT_MESSAGE = '查询超时：条件太宽，请补充更多字符、加域名，或改用前缀/精确查询'
const BROAD_MESSAGES = Object.freeze({
  contains: '片段太常见，请补充更多字符或加域名',
  fuzzy: '近似匹配范围太大，请输入更长、更具体的邮箱名或改用前缀查询',
})

export class EmailDirectorySearch extends FileDatasetSearchBase {
  constructor({ pool, store, hmacKey, limits = QUERY_LIMITS, now = Date.now }) {
    super({ pool, store, hmacKey, limits, product: PRODUCT, now })
  }

  #auditKey(request) {
    return JSON.stringify([request.mode, request.query, request.domain, request.after ? [request.after.localKey, request.after.ordinal] : null])
  }

  /** Usage fingerprint without plaintext query, domain or cursor. */
  fingerprint(request) {
    return { mode: request.mode, query: this.hmac(this.#auditKey(request)), limit: request.limit, reveal: request.reveal, page: Boolean(request.after) }
  }

  async metadata() {
    const version = await this.active()
    return {
      contractVersion: CONTRACT_VERSION,
      product: PRODUCT.label,
      published: Boolean(version),
      version: version ? { id: version.id, publishedAt: version.publishedAt, addresses: version.uniqueMappings } : null,
      modes: [...MODES],
      cursorModes: [...CURSOR_MODES],
      limits: {
        defaultLimit: this.limits.defaultLimit,
        maxLimit: this.limits.maxLimit,
        prefixMinChars: this.limits.prefixMinChars,
        containsMinChars: this.limits.containsMinChars,
        fuzzyMinChars: this.limits.fuzzyMinChars,
        fuzzyMaxChars: this.limits.fuzzyMaxChars,
      },
      defaultReveal: true,
      masking: '查询默认返回完整邮箱，传入 reveal:false 可返回脱敏邮箱。完整邮箱返回条数计入审计。',
    }
  }

  async search(context, request) {
    const audit = { mode: request.mode, field: null, hmac: this.hmac(this.#auditKey(request)) }
    const { version, rows, startedAt } = await this.execute(context, request, audit, current => this.#run(current, request), { timeoutMessage: TIMEOUT_MESSAGE })
    const items = rows.map(row => this.#item(row, request))
    const tookMs = this.now() - startedAt
    await this.audit(context, version, audit, 'ok', items.length, request.reveal ? items.length : 0, tookMs)
    const full = items.length === request.limit
    return {
      contractVersion: CONTRACT_VERSION,
      items,
      meta: {
        datasetVersion: version.id,
        publishedAt: version.publishedAt,
        mode: request.mode,
        domain: request.domain,
        limit: request.limit,
        returned: items.length,
        truncated: full,
        // Only domain listings page; other modes are narrowed with more characters.
        nextCursor: full && CURSOR_MODES.includes(request.mode) ? encodeCursor(rows.at(-1)) : null,
        revealed: request.reveal,
        tookMs,
        note: '结果来自已发布的来源文件，不代表邮箱当前可用或已验证归属。',
      },
    }
  }

  #item(row, request) {
    const matchType = request.mode === 'email' ? (row.exact ? 'exact' : 'case_insensitive')
      : request.mode === 'fuzzy' ? 'similar' : request.mode
    return {
      email: request.reveal ? `${row.email_local}@${row.domain}` : `${maskLocal(row.email_local)}@${row.domain}`,
      emailMasked: !request.reveal,
      domain: row.domain,
      matchType,
      ...(row.score === undefined ? {} : { similarity: Math.round(Number(row.score) * 1000) / 1000 }),
      sourceRecords: Number(row.dup_count),
    }
  }

  async precheck(version, request) {
    return this.trigramPrecheck(version, { field: 'l', mode: request.mode, query: request.query }, BROAD_MESSAGES)
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
    const select = `SELECT m.email_local, d.name AS domain, m.dup_count, m.first_ordinal, lower(m.email_local) AS local_key`
    const from = `FROM ${tables.mappings} m JOIN ${SCHEMA}.domains d ON d.id = m.domain_id`
    const params = []
    const param = value => { params.push(value); return `$${params.length}` }
    const domainFilter = () => domainId ? `AND m.domain_id = ${param(domainId)}` : ''
    let sql
    if (request.mode === 'email') {
      const local = param(request.local)
      sql = `${select}, (m.email_local = ${local}) AS exact ${from}
        WHERE lower(m.email_local) = lower(${local}) AND m.domain_id = ${param(domainId)}
        ORDER BY exact DESC, m.first_ordinal LIMIT ${param(request.limit)}`
    } else if (request.mode === 'prefix') {
      // The text_pattern_ops ordering keeps the planner on the B-tree.
      sql = `${select} ${from}
        WHERE lower(m.email_local) LIKE lower(${param(escapeLike(request.query))}) || '%' ${domainFilter()}
        ORDER BY lower(m.email_local) USING ~<~ LIMIT ${param(request.limit)}`
    } else if (request.mode === 'domain') {
      // Keyset over (domain, lower(local), first ordinal): each page is one
      // index range scan, however deep the listing goes.
      const domain = param(domainId)
      let after = ''
      if (request.after) {
        const key = param(request.after.localKey)
        const ordinal = param(request.after.ordinal)
        after = `AND lower(m.email_local) ~>=~ ${key}
          AND (lower(m.email_local) ~>~ ${key} OR m.first_ordinal > ${ordinal}::bigint)`
      }
      sql = `${select} ${from}
        WHERE m.domain_id = ${domain} ${after}
        ORDER BY lower(m.email_local) USING ~<~, m.first_ordinal LIMIT ${param(request.limit)}`
    } else if (request.mode === 'contains') {
      sql = `${select} ${from}
        WHERE lower(m.email_local) LIKE '%' || lower(${param(escapeLike(request.query))}) || '%' ${domainFilter()}
        LIMIT ${param(request.limit)}`
    } else {
      const q = param(request.query)
      sql = `${select}, similarity(lower(m.email_local), lower(${q})) AS score ${from}
        WHERE lower(m.email_local) % lower(${q}) ${domainFilter()}
        ORDER BY score DESC LIMIT ${param(request.limit)}`
    }
    return this.readOnly(sql, params, { slow, similarityThreshold: request.mode === 'fuzzy' ? this.limits.fuzzyThreshold : null })
  }
}
