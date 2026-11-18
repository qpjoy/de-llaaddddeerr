import { AppError } from '../../core/errors.mjs'
import { readBounded, parseJson, failed, unknown, notDelivered, transportCause, MAX_RESULT_BYTES } from '../http.mjs'

// The first reviewed Night-All-A operation is anonymous Tieba thread search.
// A Hub job owns one upstream task/run, never a retry or a fallback connector.
// Task submission has an upstream idempotency key, but a lost response is not
// retried: the deployed upstream may not implement that receipt contract yet.
const CONNECTOR = 'tieba'
const CAPABILITY = 'content.search'
const ACTIVE = new Set(['queued', 'leasing', 'starting', 'running', 'retry_wait'])
const STOPPED = new Set(['succeeded', 'failed', 'blocked', 'cancelled'])
const REQUEST_TIMEOUT_MS = 15_000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveId = value => Number.isSafeInteger(value) && value > 0
const count = value => Number.isSafeInteger(value) && value >= 0
const nextCheckMs = checks => Math.min(30_000, 2_000 + Math.max(0, Number(checks) || 0) * 1_000)
const invalid = (code, message) => new AppError(400, code, message)

function normalizeBaseUrl(value) {
  let url
  try { url = new URL(String(value ?? '').trim()) } catch { /* Rejected below. */ }
  if (!url || url.protocol !== 'http:' || url.hostname !== '100.127.0.1' || !['8100', '8101'].includes(url.port)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw invalid('invalid_engine_base_url', 'Night-All-A 地址须为 http://100.127.0.1:8100 或 http://100.127.0.1:8101')
  }
  return url.origin
}

function sessionHeaders(engine, credential) {
  if (credential == null) {
    if (engine.credentialProvider) throw new Error('session_missing')
    // An engine without a credential provider explicitly uses VPN no-auth.
    return { accept: 'application/json' }
  }
  let session = credential
  if (typeof session === 'string') {
    try { session = JSON.parse(session) } catch { throw new Error('session_invalid') }
  }
  if (!object(session) || Object.keys(session).some(key => !['sessionCookie', 'csrfToken'].includes(key))
    || typeof session.sessionCookie !== 'string' || !session.sessionCookie || session.sessionCookie.length > 8192
    || /[\u0000-\u0020\u007f;]/u.test(session.sessionCookie)
    || typeof session.csrfToken !== 'string' || !session.csrfToken || session.csrfToken.length > 8192
    || /[\u0000-\u0020\u007f]/u.test(session.csrfToken)) throw new Error('session_invalid')
  return { accept: 'application/json', cookie: `dq_admin_session=${session.sessionCookie}`, 'x-csrf-token': session.csrfToken }
}

function parameters(definition, input) {
  if (definition?.nightAllA?.connectorId !== CONNECTOR || definition?.nightAllA?.capability !== CAPABILITY
    || typeof definition.taskParameters !== 'function' || typeof definition.projectResult !== 'function') throw new Error('definition_invalid')
  const values = definition.taskParameters(input)
  if (!object(values) || Object.keys(values).sort().join(',') !== 'auth_mode,max_pages,max_results,page,query'
    || values.auth_mode !== 'anonymous' || typeof values.query !== 'string' || !values.query.trim()
    || values.query.length > 2000 || /[\u0000-\u001f\u007f]/u.test(values.query)
    || !positiveId(values.max_results) || values.max_results > 100
    || !positiveId(values.page) || values.page > 1000 || !positiveId(values.max_pages) || values.max_pages > 10) throw new Error('definition_invalid')
  return values
}

function sameParameters(actual, expected) {
  return object(actual) && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key] === value)
}

function validRun(run, expected, refs = null) {
  return object(run) && positiveId(run.id) && positiveId(run.task_id) && run.connector_id === CONNECTOR
    && run.capability === CAPABILITY && run.attempt === 1 && sameParameters(run.parameters, expected)
    && (ACTIVE.has(run.status) || STOPPED.has(run.status) || run.status === 'orphaned')
    && (!refs || (run.id === refs.runId && run.task_id === refs.taskId))
}

function validTask(task, expected, taskId) {
  return object(task) && task.id === taskId && task.connector_id === CONNECTOR && task.capability === CAPABILITY
    && task.credential_id === null && task.max_attempts === 1 && sameParameters(task.parameters, expected)
}

function references(job) {
  const state = job.upstreamState
  return object(state) && positiveId(state.taskId) && positiveId(state.runId) && job.upstreamRef === String(state.runId)
    ? { taskId: state.taskId, runId: state.runId } : null
}

async function exchange(fetchImpl, baseUrl, path, headers, body, extraHeaders = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { ...headers, ...extraHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: parseJson(await readBounded(response, MAX_RESULT_BYTES)) }
}

function persistenceConfirmed(run) {
  const items = run.result?.items
  if (!Array.isArray(items)) return false
  // Upstream deliberately skips persistence for empty, non-incremental runs.
  if (!items.length) return true
  const records = run.metrics?.records
  return object(records) && records.auto_persisted === true && count(records.saved) && count(records.created) && count(records.updated)
    && records.saved === items.length && records.created + records.updated === records.saved
    && (records.skipped === undefined || records.skipped === 0) && !records.tag_conflicts
}

function terminal(run, definition, input) {
  if (run.status === 'orphaned') return { outcome: unknown('collector_run_orphaned', '采集运行失联，是否已停止未知；请核对执行槽') }
  if (run.status !== 'succeeded') {
    return { outcome: failed('collector_run_failed', '采集运行已结束但未成功，不收费', { status: run.status }) }
  }
  if (!persistenceConfirmed(run)) return { outcome: failed('collector_persistence_unconfirmed', '采集结果的持久化证据不完整，不交付或收费') }
  try {
    // Poll time is not capture time: a delayed result must not supersede a
    // newer observation merely because this executor checked it later.
    if (typeof run.finished_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(run.finished_at)
      || !Number.isFinite(new Date(run.finished_at).getTime())) throw new Error('capture_time_invalid')
    const projected = definition.projectResult(run.result, { input, taskId: run.task_id, runId: run.id, capturedAt: new Date(run.finished_at).toISOString() })
    if (!object(projected) || !object(projected.result) || !count(projected.itemCount)
      || projected.itemCount !== run.result.items.length || !['success', 'partial', 'no_data'].includes(projected.dataStatus)
      || !object(projected.ingestion)) throw new Error('projection_invalid')
    return { outcome: { status: 'succeeded', dataStatus: projected.dataStatus, result: projected.result,
      itemCount: projected.itemCount, ingestion: projected.ingestion, charge: true,
      upstreamDurationMs: count(run.duration_ms) ? run.duration_ms : null } }
  } catch {
    return { outcome: failed('collector_result_unusable', '采集结果未通过帖子类型或字段合同校验，不交付或收费') }
  }
}

export const nightAllAContract = Object.freeze({
  kind: 'night_all_a',
  mode: 'async',
  // Checks can resume after a restart if the run reference was persisted.
  // Without it, check returns unknown rather than submitting a second task.
  reconcilable: true,
  normalizeBaseUrl,
  normalizeConfig(config) {
    if (config != null && (!object(config) || Object.keys(config).length)) {
      throw invalid('invalid_engine_config', 'Night-All-A 引擎不接受额外配置；会话使用独立凭据项')
    }
    return {}
  },

  async start({ engine, job, definition, credential, fetchImpl, runDeadlineAt }) {
    let baseUrl, headers, expected
    try { baseUrl = normalizeBaseUrl(engine.baseUrl); headers = sessionHeaders(engine, credential); expected = parameters(definition, job.input) } catch {
      return { outcome: failed('collector_configuration_invalid', '采集引擎地址、会话或能力配置无效，未派发') }
    }
    const remaining = Math.floor((new Date(runDeadlineAt).getTime() - Date.now()) / 1000)
    if (!Number.isFinite(remaining) || remaining < 5) return { outcome: failed('collector_deadline_expired', '采集任务已到截止时间，未派发') }
    const timeoutSeconds = Math.min(3600, Math.max(1, remaining - 5))
    let answer
    try {
      answer = await exchange(fetchImpl, baseUrl, '/api/tasks', headers, {
        connector_id: CONNECTOR, capability: CAPABILITY, parameters: expected,
        persist_results: true, task_type: 'query', priority: 0, max_attempts: 1, timeout_seconds: timeoutSeconds,
      }, { 'idempotency-key': job.id, 'x-request-id': job.id })
    } catch (error) {
      if (notDelivered(error)) return { outcome: failed('engine_unreachable', '无法连接采集引擎，请求未送达', { cause: transportCause(error) }) }
      return { outcome: unknown('collector_submit_unknown', '采集提交应答丢失，上游可能已创建任务；禁止自动重发') }
    }
    const { task, run } = object(answer.body) ? answer.body : {}
    if (answer.status === 202 && validRun(run, expected) && validTask(task, expected, run.task_id)) {
      return { upstream: { ref: String(run.id), state: { taskId: task.id, runId: run.id } }, nextCheckMs: nextCheckMs(0) }
    }
    if ([400, 401, 403, 404, 422, 429].includes(answer.status)) {
      return { outcome: failed('collector_submit_rejected', '采集平台拒绝了任务，不收费', { upstreamStatus: answer.status }) }
    }
    return { outcome: unknown('collector_submit_unknown', '采集平台应答未能确认本次任务身份；禁止自动重发', { upstreamStatus: answer.status }) }
  },

  async check({ engine, job, definition, credential, fetchImpl }) {
    const refs = references(job)
    if (!refs) return { outcome: unknown('collector_run_reference_missing', '任务没有已确认的上游运行编号；禁止自动重发') }
    let baseUrl, headers, expected
    try { baseUrl = normalizeBaseUrl(engine.baseUrl); headers = sessionHeaders(engine, credential); expected = parameters(definition, job.input) } catch {
      return { outcome: unknown('collector_run_unreadable', '采集引擎配置或会话已不可用，运行是否已结束未知') }
    }
    let answer
    try { answer = await exchange(fetchImpl, baseUrl, `/api/runs/${refs.runId}?include_result=true`, headers) } catch {
      return { nextCheckMs: nextCheckMs(job.checks) }
    }
    if (answer.status === 200) {
      if (!validRun(answer.body, expected, refs)) return { outcome: unknown('collector_run_identity_mismatch', '采集平台返回的运行身份或请求内容不匹配') }
      if (ACTIVE.has(answer.body.status)) return { nextCheckMs: nextCheckMs(job.checks) }
      return terminal(answer.body, definition, job.input)
    }
    if ([401, 403, 404, 410].includes(answer.status)) {
      return { outcome: unknown('collector_run_unreadable', '无法读取已接收的采集任务，是否已结束未知', { upstreamStatus: answer.status }) }
    }
    return { nextCheckMs: nextCheckMs(job.checks) }
  },

  async abort({ engine, job, definition, credential, fetchImpl }) {
    const refs = references(job)
    if (!refs) return { stopped: false }
    try {
      const baseUrl = normalizeBaseUrl(engine.baseUrl), headers = sessionHeaders(engine, credential), expected = parameters(definition, job.input)
      // Check ownership before any mutation, including cancellation.
      const before = await exchange(fetchImpl, baseUrl, `/api/runs/${refs.runId}?include_result=false`, headers)
      if (before.status !== 200 || !validRun(before.body, expected, refs)) return { stopped: false }
      if (STOPPED.has(before.body.status)) return { stopped: true, status: before.body.status }
      if (!ACTIVE.has(before.body.status)) return { stopped: false }
      await exchange(fetchImpl, baseUrl, `/api/tasks/${refs.taskId}/cancel`, headers, {})
      const after = await exchange(fetchImpl, baseUrl, `/api/runs/${refs.runId}?include_result=false`, headers)
      return { stopped: after.status === 200 && validRun(after.body, expected, refs) && STOPPED.has(after.body.status),
        status: after.status === 200 && validRun(after.body, expected, refs) ? after.body.status : null }
    } catch { return { stopped: false } }
  },

  async probe({ engine, credential, fetchImpl, baseUrl = engine.baseUrl }) {
    const started = Date.now()
    let origin, headers
    try { origin = normalizeBaseUrl(baseUrl); headers = sessionHeaders(engine, credential) } catch {
      return { reachable: false, healthy: false, httpStatus: null, durationMs: 0, error: 'collector_configuration_invalid' }
    }
    try {
      const answer = await exchange(fetchImpl, origin, '/api/connectors?q=tieba', headers, undefined, {}, 5_000)
      // Reachability is deliberately not a claim about Tieba collection health.
      const connector = Array.isArray(answer.body?.items) ? answer.body.items.find(item => item?.id === CONNECTOR) : null
      const available = answer.status === 200 && connector?.manifest_valid === true
        && Array.isArray(connector.capabilities) && connector.capabilities.some(item => item?.id === CAPABILITY)
      return { baseUrl: origin, reachable: true, healthy: available,
        httpStatus: answer.status, durationMs: Date.now() - started,
        error: available ? null : 'connector_catalog_unavailable' }
    } catch {
      return { baseUrl: origin, reachable: false, healthy: false, httpStatus: null, durationMs: Date.now() - started, error: 'collector_unreachable' }
    }
  },
})
