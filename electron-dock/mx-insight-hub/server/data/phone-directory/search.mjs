// Read path for the published "手机号库" (phone list).
//
//   exact   one full number                      B-tree (digits)
//   prefix  country / area code, keyset pages    B-tree (digits)
//   suffix  last digits, keyset pages            B-tree (reverse(digits))
// Every mode is an index range scan, so all run in the fast lane.
import { FileDatasetSearchBase } from '../file-datasets/search-base.mjs'
import { versionTables } from '../file-datasets/store.mjs'
import { CONTRACT_VERSION, CURSOR_MODES, MODES, PRODUCT, QUERY_LIMITS, maskPhone } from './contract.mjs'

const TIMEOUT_MESSAGE = '查询超时，请输入更多位数后重试'

const reverse = value => [...value].reverse().join('')

export class PhoneDirectorySearch extends FileDatasetSearchBase {
  constructor({ pool, store, hmacKey, limits = QUERY_LIMITS, now = Date.now }) {
    super({ pool, store, hmacKey, limits, product: PRODUCT, now })
  }

  #auditKey(request) {
    return JSON.stringify([request.mode, request.query, request.after])
  }

  /** Usage fingerprint without plaintext digits or cursor. */
  fingerprint(request) {
    return { mode: request.mode, query: this.hmac(this.#auditKey(request)), limit: request.limit, reveal: request.reveal, page: Boolean(request.after) }
  }

  async metadata() {
    const version = await this.active()
    return {
      contractVersion: CONTRACT_VERSION,
      product: PRODUCT.label,
      published: Boolean(version),
      version: version ? { id: version.id, publishedAt: version.publishedAt, numbers: version.uniqueMappings } : null,
      modes: [...MODES],
      cursorModes: [...CURSOR_MODES],
      limits: {
        defaultLimit: this.limits.defaultLimit,
        maxLimit: this.limits.maxLimit,
        prefixMinDigits: this.limits.prefixMinDigits,
        suffixMinDigits: this.limits.suffixMinDigits,
      },
      format: '号码以 E.164 形式返回（+国家码…）；查询可带 +、空格、-、括号和点。',
      defaultReveal: true,
      masking: '查询默认返回完整号码，传入 reveal:false 可返回脱敏号码。完整号码返回条数计入审计。',
    }
  }

  async search(context, request) {
    const audit = { mode: request.mode, field: null, hmac: this.hmac(this.#auditKey(request)) }
    const { version, rows, startedAt } = await this.execute(context, request, audit, current => this.#run(current, request), { timeoutMessage: TIMEOUT_MESSAGE })
    const items = rows.map(row => ({
      phone: request.reveal ? `+${row.digits}` : maskPhone(row.digits),
      phoneMasked: !request.reveal,
      matchType: request.mode,
      sourceRecords: Number(row.dup_count),
    }))
    const tookMs = this.now() - startedAt
    await this.audit(context, version, audit, 'ok', items.length, request.reveal ? items.length : 0, tookMs)
    const full = items.length === request.limit
    const last = rows.at(-1)
    return {
      contractVersion: CONTRACT_VERSION,
      items,
      meta: {
        datasetVersion: version.id,
        publishedAt: version.publishedAt,
        mode: request.mode,
        limit: request.limit,
        returned: items.length,
        truncated: full,
        nextCursor: full && CURSOR_MODES.includes(request.mode) ? (request.mode === 'suffix' ? reverse(last.digits) : last.digits) : null,
        revealed: request.reveal,
        tookMs,
        note: '结果来自已发布的来源文件，不代表号码当前在用或已验证归属。',
      },
    }
  }

  async #run(version, request) {
    const tables = versionTables(version.id, version.partitionCount)
    const params = []
    const param = value => { params.push(value); return `$${params.length}` }
    const select = `SELECT m.digits, m.dup_count FROM ${tables.mappings} m`
    let sql
    if (request.mode === 'exact') {
      sql = `${select} WHERE m.digits = ${param(request.query)} LIMIT 1`
    } else if (request.mode === 'prefix') {
      // Digits only, so LIKE needs no escaping; ~<~ keeps the B-tree order.
      sql = `${select} WHERE m.digits LIKE ${param(request.query)} || '%'
        ${request.after ? `AND m.digits ~>~ ${param(request.after)}` : ''}
        ORDER BY m.digits USING ~<~ LIMIT ${param(request.limit)}`
    } else {
      sql = `${select} WHERE reverse(m.digits) LIKE ${param(reverse(request.query))} || '%'
        ${request.after ? `AND reverse(m.digits) ~>~ ${param(request.after)}` : ''}
        ORDER BY reverse(m.digits) USING ~<~ LIMIT ${param(request.limit)}`
    }
    return this.readOnly(sql, params)
  }
}
