import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AppError } from '../core/errors.mjs'
import { slotProfile } from '../../shared/integration-slots.mjs'

// Explicit method/path pairs. Documentation registration never authorizes dispatch.
export const NIGHT_ALL_A_OPERATIONS = {
  health: ['GET', '/api/health'],
  connectors: ['GET', '/api/connectors'],
  sourceFamilies: ['GET', '/api/source-families'],
  tasks: ['GET', '/api/tasks'],
  task: ['GET', '/api/tasks/{id}'],
  runs: ['GET', '/api/runs'],
  run: ['GET', '/api/runs/{id}'],
  runLogs: ['GET', '/api/runs/{id}/logs'],
  runSteps: ['GET', '/api/runs/{id}/steps'],
  runArtifacts: ['GET', '/api/runs/{id}/artifacts'],
  plans: ['GET', '/api/collection-plans'],
  plan: ['GET', '/api/collection-plans/{id}'],
  occurrences: ['GET', '/api/collection-plans/{id}/occurrences'],
  records: ['GET', '/api/records'],
  record: ['GET', '/api/records/{id}'],
  recordMetrics: ['GET', '/api/records/{id}/metrics'],
  createTask: ['POST', '/api/tasks'],
  runPlan: ['POST', '/api/collection-plans/{id}/run-now'],
}

export function nightAllAConfig(env = process.env) {
  const raw = env.MX_INSIGHT_NIGHT_ALL_A_BASE_URL || 'http://100.127.0.1:8100'
  let valid = false
  try {
    const url = new URL(raw)
    valid = url.protocol === 'http:' && url.hostname === '100.127.0.1'
      && ['8100', '8101'].includes(url.port) && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
  } catch { /* Invalid optional integration must never fail Hub startup. */ }
  return { baseUrl: valid ? raw.replace(/\/$/, '') : null,
    enabled: env.MX_INSIGHT_NIGHT_ALL_A_ENABLED === '1' && valid,
    writesEnabled: env.MX_INSIGHT_NIGHT_ALL_A_WRITES_ENABLED === '1' && valid,
    sessionCookie: env.MX_INSIGHT_NIGHT_ALL_A_SESSION_COOKIE || '',
    csrfToken: env.MX_INSIGHT_NIGHT_ALL_A_CSRF_TOKEN || '',
    configurationError: valid ? null : '仅支持 VPN 固定地址 http://100.127.0.1:8100 或可选代理端口 8101',
  }
}

export class NightAllADispatchStore {
  constructor(pool) { this.pool = pool }
  async reserve(row) {
    if (!this.pool) throw new AppError(503, 'night_all_a_journal_unavailable', '触发采集需要 PostgreSQL 持久记录')
    const result = await this.pool.query(`INSERT INTO night_all_a_dispatches
      (id,idempotency_key,fingerprint,operation,actor,reason,state) VALUES ($1,$2,$3,$4,$5,$6,'reserved')
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [row.id, row.key, row.fingerprint, row.operation, row.actor, row.reason])
    if (result.rows[0]) return { fresh: true, row: result.rows[0] }
    const existing = await this.pool.query('SELECT * FROM night_all_a_dispatches WHERE idempotency_key=$1', [row.key])
    return { fresh: false, row: existing.rows[0] }
  }
  async finish(id, state, response) {
    await this.pool.query('UPDATE night_all_a_dispatches SET state=$2,response=$3::jsonb,updated_at=now() WHERE id=$1', [id, state, JSON.stringify(response)])
  }
  async get(id) {
    if (!this.pool) throw new AppError(503, 'night_all_a_journal_unavailable', '持久记录不可用')
    return (await this.pool.query('SELECT id,operation,state,response,created_at,updated_at FROM night_all_a_dispatches WHERE id=$1', [id])).rows[0] || null
  }
  async list() {
    if (!this.pool) return { available: false, items: [], note: 'PostgreSQL 派发记录未配置；这里不模拟历史数据。' }
    try {
      const result = await this.pool.query(`SELECT id,operation,actor,reason,state,created_at,updated_at,
        CASE WHEN response IS NULL THEN NULL ELSE jsonb_build_object(
          'upstreamStatus', response->'upstreamStatus', 'dispatchId', response->'dispatchId',
          'data', jsonb_build_object('id', response#>'{data,id}',
            'task', jsonb_build_object('id', response#>'{data,task,id}'),
            'run', jsonb_build_object('id', response#>'{data,run,id}'))
        ) END AS response
        FROM night_all_a_dispatches ORDER BY created_at DESC,id DESC LIMIT 50`)
      return { available: true, items: result.rows, limit: 50 }
    } catch {
      return { available: false, items: [], note: '派发记录暂不可读，请核对数据库和迁移；未读取上游。' }
    }
  }
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const invalid = message => new AppError(400, 'invalid_night_all_a_request', message)
let catalogPromise
const readCatalog = () => catalogPromise ||= readFile(new URL('./night-all-a-catalog.json', import.meta.url), 'utf8').then(JSON.parse).catch(error => { catalogPromise = null; throw error })

export class NightAllAService {
  providerKey = 'night-all-a'
  constructor({ config = nightAllAConfig(), journal = new NightAllADispatchStore(null), fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    this.config = config; this.journal = journal; this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.inflight = 0
  }
  async overview(range = '7d') {
    if (!['24h', '7d', '30d'].includes(range)) throw invalid('无效统计窗口')
    return { providers: [{ key: this.providerKey, displayName: 'Night-All-A', status: 'unknown',
      configured: this.config.enabled, metrics: {}, billing: {},
      description: '海外采集控制平台，经 OpenVPN 直连。异步采集触发与内网数据库清洗分开管理；调用统计尚未汇总。' }] }
  }
  async detail(key, range) {
    if (key !== this.providerKey) throw new AppError(404, 'external_platform_not_found', '平台不存在')
    const catalog = await readCatalog()
    return { provider: (await this.overview(range)).providers[0], catalog, integration: slotProfile(this.providerKey),
      connection: { baseUrl: this.config.baseUrl, enabled: this.config.enabled, writesEnabled: this.config.enabled && this.config.writesEnabled,
        configurationError: this.config.configurationError, authentication: this.config.sessionCookie ? '已配置平台会话；有效性待请求核验' : 'VPN 访问；上游若启用登录需配置平台会话与 CSRF' },
      operations: Object.entries(NIGHT_ALL_A_OPERATIONS).map(([key, [method, path]]) => ({ key, method, path })),
    }
  }
  updateCredential() { throw new AppError(409, 'deployment_managed', 'Night-All-A 会话由独立部署 Secret 管理') }
  revealCredential() { throw new AppError(409, 'deployment_managed', '此处不提供上游会话读取') }
  updateProviderPriceBook() { throw new AppError(409, 'not_supported', 'Night-All-A 尚未建立采购计费合同') }
  updateOperationPolicy() { throw new AppError(409, 'deployment_managed', 'Night-All-A 使用独立部署开关') }
  async dispatch(...args) {
    if (this.inflight >= 8) throw new AppError(429, 'night_all_a_busy', '转发并发已满')
    this.inflight++
    try { return await this.performDispatch(...args) } finally { this.inflight-- }
  }
  async performDispatch(operation, input = {}, { idempotencyKey, actor = 'admin-token' } = {}) {
    if (!Object.hasOwn(NIGHT_ALL_A_OPERATIONS, operation)) throw new AppError(404, 'night_all_a_operation_not_allowed', '该接口仅登记，不允许转发')
    if (!this.config.enabled) throw new AppError(503, 'night_all_a_disabled', 'Night-All-A 转发尚未启用')
    if (!input || Array.isArray(input) || typeof input !== 'object') throw invalid('请求必须是 JSON 对象')
    if (Object.keys(input).some(key => !['id', 'query', 'body', 'reason'].includes(key))) throw invalid('不支持自定义地址、路径或请求头')
    const [method, template] = NIGHT_ALL_A_OPERATIONS[operation]
    const write = method === 'POST'
    if (write && !this.config.writesEnabled) throw new AppError(503, 'night_all_a_writes_disabled', '采集触发尚未启用')
    let path = template
    if (template.includes('{id}')) {
      if (!/^[1-9]\d{0,18}$/.test(String(input.id || ''))) throw invalid('id 必须是正整数')
      path = template.replace('{id}', String(input.id))
    } else if (input.id !== undefined) throw invalid('该操作不接受 id')
    const catalog = await readCatalog()
    const idName = template.startsWith('/api/records/') ? '{record_id}' : template.startsWith('/api/tasks/') ? '{task_id}' : template.startsWith('/api/runs/') ? '{run_id}' : '{plan_id}'
    const spec = catalog.openapi.paths[template.replace('{id}', idName)]?.[method.toLowerCase()]
    const query = input.query || {}
    if (typeof query !== 'object' || Array.isArray(query)) throw invalid('query 必须是对象')
    const allowedQuery = new Set((spec?.parameters || []).filter(p => p.in === 'query').map(p => p.name))
    const url = new URL(path, this.config.baseUrl)
    for (const [key, value] of Object.entries(query)) {
      if (!allowedQuery.has(key) || !['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 2000) throw invalid('query 包含不支持的字段或值')
      url.searchParams.set(key, String(value))
    }
    let body
    if (operation === 'createTask') {
      body = input.body
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('需要任务 body')
      const allowed = new Set(['connector_id', 'platform_id', 'capability', 'parameters', 'credential_id', 'agent_profile_id', 'persist_results', 'tieba_detail', 'task_type', 'priority', 'max_attempts', 'timeout_seconds'])
      if (Object.keys(body).some(key => !allowed.has(key))) throw invalid('任务包含不支持的字段')
      if ((!body.connector_id && !body.platform_id) || typeof body.capability !== 'string' || !body.capability.trim()) throw invalid('需要 connector_id/platform_id 和 capability')
      body = { ...body, persist_results: body.persist_results ?? true, max_attempts: body.max_attempts ?? 1 }
    } else if (input.body && Object.keys(input.body).length) throw invalid('该操作不接受 body')
    let dispatchId
    if (write) {
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey || '')) throw invalid('触发请求需要 16–128 位 Idempotency-Key')
      if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) throw invalid('触发请求需要操作原因（1–500 字）')
      dispatchId = randomUUID()
      const fingerprint = createHash('sha256').update(JSON.stringify(stable({ operation, path, query, body: body || null }))).digest('hex')
      const reserved = await this.journal.reserve({ id: dispatchId, key: idempotencyKey, fingerprint, operation, actor, reason: input.reason.trim() })
      if (!reserved.row || reserved.row.fingerprint !== fingerprint) throw new AppError(409, 'night_all_a_idempotency_conflict', '同一幂等键不能用于不同请求')
      dispatchId = reserved.row.id
      if (!reserved.fresh) {
        if (reserved.row.state === 'completed') return { ...reserved.row.response, replay: true }
        throw new AppError(409, 'night_all_a_outcome_unknown', '请求已登记，可能仍在执行或结果未知；请查询记录，不要重新触发', { dispatchId })
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = { accept: 'application/json' }
      if (body) headers['content-type'] = 'application/json'
      if (this.config.sessionCookie) headers.cookie = `dq_admin_session=${this.config.sessionCookie}`
      if (write && this.config.csrfToken) headers['x-csrf-token'] = this.config.csrfToken
      const response = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: controller.signal })
      let size = 0; const chunks = []
      for await (const chunk of response.body || []) {
        size += chunk.length
        if (size > 4 * 1024 * 1024) { controller.abort(); throw new Error('response_limit') }
        chunks.push(Buffer.from(chunk))
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const result = { dispatchId: dispatchId || null, upstreamStatus: response.status, data: payload, replay: false }
      // A 5xx may have happened after creating the task. Never label it safe to retry.
      if (write && response.status >= 500) throw new Error('ambiguous_upstream_error')
      if (write) await this.journal.finish(dispatchId, 'completed', result)
      return result
    } catch {
      if (write) {
        await this.journal.finish(dispatchId, 'unknown', null).catch(() => {})
        throw new AppError(502, 'night_all_a_outcome_unknown', '上游结果未知；保留幂等键并核对任务，禁止自动重发', { dispatchId })
      }
      throw new AppError(502, 'night_all_a_unavailable', 'Night-All-A 未返回可用 JSON；请核对 VPN、上游会话及服务状态')
    } finally { clearTimeout(timer) }
  }
}
