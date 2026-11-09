import { readBounded, parseJson, failed, unknown, notDelivered, transportCause, MAX_RESULT_BYTES } from '../http.mjs'

// Contract for Apify Actors (integration plan phase 2). Every call goes to
// api.apify.com through the `apify` System Proxy binding (spider_man D19).
//
//   start:  POST /v2/acts/{actorId}/runs?build=&timeout=&restartOnError=false
//   check:  GET  /v2/actor-runs/{runId}; once SUCCEEDED (or TIMED-OUT) read one
//           bounded page of /v2/datasets/{id}/items, completeness from
//           X-Apify-Pagination-Total
//   abort:  POST /v2/actor-runs/{runId}/abort (run deadline only)
//   probe:  GET  /v2/users/me and /v2/users/me/limits (free, read-only)
//
// No maxTotalChargeUsd is sent (spider_man D18); every run's usageTotalUsd is
// recorded as procurement cost. A start whose answer was lost may have created
// a paid run that Hub cannot find by its own ID, so it is unknown and holds
// the slot until an operator checks the Apify console.

export const APIFY_API = 'https://api.apify.com'
const REQUEST_TIMEOUT_MS = 20_000
const PROBE_TIMEOUT_MS = 10_000
const MAX_PAGE_ITEMS = 1_000
const ACTIVE = new Set(['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'])
const ENDED = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'])
const RUN_ID = /^[A-Za-z0-9]{6,32}$/
// The proxy layer refused before any business request left Hub.
const EGRESS_REFUSED = new Set(['proxy_routes_unreachable', 'proxy_route_unavailable'])
// Apify answers that prove the run was not created.
const START_REFUSED = Object.freeze({
  400: ['apify_input_rejected', 'Apify 拒绝了 Actor 输入，未启动'],
  401: ['apify_auth_failed', 'Apify token 无效，未启动'],
  402: ['apify_payment_required', 'Apify 账户余额或额度不足，未启动'],
  403: ['apify_access_denied', 'Apify 拒绝访问该 Actor，未启动'],
  404: ['apify_actor_not_found', 'Apify 找不到该 Actor 或版本，未启动'],
  429: ['apify_rate_limited', 'Apify 限流，未启动'],
})

const nextCheckMs = checks => Math.min(30_000, Math.round(5_000 * 1.4 ** Math.max(0, checks - 1)))
const auth = credential => ({ accept: 'application/json', authorization: `Bearer ${credential}` })
const usd = value => Number.isFinite(Number(value)) ? Math.round(Number(value) * 1e6) / 1e6 : null

async function call(fetchImpl, path, { method = 'GET', credential, body, limit = 256 * 1024, query } = {}) {
  const url = new URL(path, APIFY_API)
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value))
  const response = await fetchImpl(url, { method, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { ...auth(credential), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await readBounded(response, limit)
  return { status: response.status, headers: response.headers, body: parseJson(text) }
}

// The subset of an Apify run Hub keeps; never the user, proxy or env fields.
function runView(data) {
  return { id: data.id, actId: data.actId, status: data.status, buildNumber: data.buildNumber ?? null, defaultDatasetId: data.defaultDatasetId ?? null,
    startedAt: data.startedAt ?? null, finishedAt: data.finishedAt ?? null, usageTotalUsd: usd(data.usageTotalUsd),
    statusMessage: typeof data.statusMessage === 'string' ? data.statusMessage.slice(0, 300) : null }
}

function validRun(data, actorId, runId = null) {
  return data && typeof data === 'object' && typeof data.id === 'string' && RUN_ID.test(data.id) && data.actId === actorId
    && (runId === null || data.id === runId) && (ACTIVE.has(data.status) || ENDED.has(data.status))
}

const costOf = run => ({ provider: 'apify', usd: run.usageTotalUsd, runId: run.id })

// Records that report their own failure make the delivery partial, as the
// reviewed package did; they are kept, not dropped.
const failedRecord = item => !item || typeof item !== 'object' || Boolean(item.error || item.errors || item.success === false)

async function readItems({ fetchImpl, credential, run, definition, input }) {
  let limit = Math.max(1, Math.min(MAX_PAGE_ITEMS, definition.resultLimit(input)))
  for (;;) {
    let answer
    try {
      answer = await call(fetchImpl, `/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items`, { credential, limit: MAX_RESULT_BYTES,
        query: { format: 'json', clean: 'false', offset: 0, limit } })
    } catch (error) {
      // Too large for one result: take a smaller first page and mark it partial.
      if (error?.code === 'response_too_large' && limit > 1) { limit = Math.floor(limit / 2); continue }
      return { retry: true }
    }
    if (answer.status !== 200 || !Array.isArray(answer.body)) return { retry: true }
    const raw = answer.headers.get('x-apify-pagination-total')
    const total = raw == null || raw === '' ? null : Number(raw)
    return { items: answer.body.slice(0, limit), limit, total: Number.isSafeInteger(total) && total >= 0 ? total : null }
  }
}

function delivered({ run, definition, input, page, actor }) {
  const { items, limit, total } = page
  const requested = definition.resultLimit(input)
  const truncated = total == null ? items.length >= limit && limit < requested : items.length < Math.min(total, requested)
  const dataStatus = !items.length ? 'no_data' : (truncated || items.some(failedRecord) || run.status !== 'SUCCEEDED') ? 'partial' : 'success'
  return {
    status: 'succeeded', dataStatus, itemCount: items.length, charge: true, cost: costOf(run),
    upstreamDurationMs: run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
    result: { provider: 'apify', actor, run, dataset: { id: run.defaultDatasetId, total, offset: 0, count: items.length,
      hasMore: total == null ? null : total > items.length }, warnings: [
        ...(total == null ? ['Apify 没有返回 X-Apify-Pagination-Total，无法确认是否完整'] : []),
        ...(run.status !== 'SUCCEEDED' ? [`运行以 ${run.status} 结束，只交付已产出的部分`] : []),
      ], items },
  }
}

export const apifyContract = Object.freeze({
  kind: 'apify',
  mode: 'async',
  // Apify cannot be asked about a run by Hub's own ID.
  reconcilable: false,

  normalizeBaseUrl() {
    throw Object.assign(new Error('Apify engines use the fixed api.apify.com address'), { code: 'invalid_engine_config' })
  },
  normalizeConfig(config) {
    if (config && Object.keys(config).length) {
      throw Object.assign(new Error('apify engines take no extra configuration; Actor and build are pinned per capability'), { code: 'invalid_engine_config' })
    }
    return {}
  },

  async start({ job, definition, credential, fetchImpl, runDeadlineAt }) {
    const { actorId, build } = definition.apify
    // Let Apify end the run itself a minute before Hub's own deadline.
    const timeout = Math.max(30, Math.floor((new Date(runDeadlineAt).getTime() - Date.now()) / 1000) - 60)
    let answer
    try {
      answer = await call(fetchImpl, `/v2/acts/${encodeURIComponent(actorId)}/runs`, { method: 'POST', credential,
        query: { build, timeout, restartOnError: 'false' }, body: definition.actorInput(job.input) })
    } catch (error) {
      if (EGRESS_REFUSED.has(error?.code)) return { outcome: failed('egress_unavailable', 'System Proxy 出口不可用，请求未发出', { cause: error.code }) }
      if (notDelivered(error)) return { outcome: failed('engine_unreachable', '无法连接 Apify，请求未送达', { cause: transportCause(error) }) }
      return { outcome: unknown('apify_start_uncertain', '启动 Actor 的应答丢失，Apify 上可能已有一次付费运行；请在 Apify 控制台核对后恢复执行槽',
        { cause: transportCause(error) }) }
    }
    const data = answer.body?.data
    if ((answer.status === 201 || answer.status === 200) && validRun(data, actorId)) {
      const run = runView(data)
      return { upstream: { ref: run.id, state: { run } }, nextCheckMs: nextCheckMs(1) }
    }
    const refused = START_REFUSED[answer.status]
    if (refused) {
      return { outcome: failed(refused[0], refused[1], { upstreamStatus: answer.status,
        upstreamType: typeof answer.body?.error?.type === 'string' ? answer.body.error.type : null }) }
    }
    return { outcome: unknown('apify_start_uncertain', 'Apify 返回了无法确认的应答，可能已有一次付费运行；请在 Apify 控制台核对后恢复执行槽',
      { upstreamStatus: answer.status }) }
  },

  async check({ job, definition, credential, fetchImpl }) {
    const { actorId, actor, build } = definition.apify
    const runId = job.upstreamRef
    if (!RUN_ID.test(runId || '')) return { outcome: unknown('apify_run_missing', '任务没有可用的 Apify 运行 ID') }
    let answer
    try {
      answer = await call(fetchImpl, `/v2/actor-runs/${encodeURIComponent(runId)}`, { credential })
    } catch {
      return { nextCheckMs: nextCheckMs(job.checks) }
    }
    const data = answer.body?.data
    if (answer.status === 200 && validRun(data, actorId, runId)) {
      const run = runView(data)
      if (ACTIVE.has(run.status)) return { upstream: { state: { run } }, nextCheckMs: nextCheckMs(job.checks) }
      const actorRef = { id: actorId, name: actor, build }
      if (run.status === 'SUCCEEDED' || run.status === 'TIMED-OUT') {
        if (!run.defaultDatasetId) return { outcome: { ...failed('apify_dataset_missing', 'Apify 运行没有默认数据集'), cost: costOf(run), result: { provider: 'apify', actor: actorRef, run, items: [] } } }
        const page = await readItems({ fetchImpl, credential, run, definition, input: job.input })
        if (page.retry) return { upstream: { state: { run } }, nextCheckMs: 10_000 }
        if (run.status === 'TIMED-OUT' && !page.items.length) {
          return { outcome: { ...failed('apify_run_timed_out', 'Apify 运行超时且没有产出数据'), cost: costOf(run), result: { provider: 'apify', actor: actorRef, run, items: [] } } }
        }
        return { outcome: delivered({ run, definition, input: job.input, page, actor: actorRef }) }
      }
      const code = run.status === 'ABORTED' ? 'apify_run_aborted' : 'apify_run_failed'
      return { outcome: { ...failed(code, `Apify 运行以 ${run.status} 结束${run.statusMessage ? `：${run.statusMessage}` : ''}`), cost: costOf(run),
        result: { provider: 'apify', actor: actorRef, run, items: [] } } }
    }
    if ([401, 403, 404].includes(answer.status)) {
      // The run exists (Apify gave us its ID) but can no longer be read:
      // a rotated token or another account. It may still be running.
      return { outcome: unknown('apify_run_unreadable', `无法读取 Apify 运行（HTTP ${answer.status}），运行是否已结束未知`, { upstreamStatus: answer.status }) }
    }
    return { nextCheckMs: nextCheckMs(job.checks) }
  },

  // Called at Hub's run deadline. Only a terminal answer proves it stopped.
  async abort({ job, credential, fetchImpl }) {
    if (!RUN_ID.test(job.upstreamRef || '')) return { stopped: false }
    try {
      const answer = await call(fetchImpl, `/v2/actor-runs/${encodeURIComponent(job.upstreamRef)}/abort`, { method: 'POST', credential })
      const status = answer.body?.data?.status
      return { stopped: answer.status === 200 && ENDED.has(status), status: typeof status === 'string' ? status : null,
        cost: answer.body?.data ? { provider: 'apify', usd: usd(answer.body.data.usageTotalUsd), runId: job.upstreamRef } : null }
    } catch {
      return { stopped: false }
    }
  },

  async probe({ credential, fetchImpl }) {
    const started = Date.now()
    if (!credential) return { baseUrl: APIFY_API, reachable: false, httpStatus: null, healthy: false, durationMs: 0, error: 'credential_missing' }
    try {
      const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
      const me = await fetchImpl(new URL('/v2/users/me', APIFY_API), { redirect: 'manual', headers: auth(credential), signal })
      const body = parseJson(await readBounded(me, 64 * 1024)) || {}
      const data = body.data && typeof body.data === 'object' ? body.data : {}
      let usage = null
      if (me.ok) {
        const limits = await fetchImpl(new URL('/v2/users/me/limits', APIFY_API), { redirect: 'manual', headers: auth(credential), signal }).catch(() => null)
        const limitsBody = limits?.ok ? parseJson(await readBounded(limits, 64 * 1024)) : null
        const current = limitsBody?.data?.current || {}
        const caps = limitsBody?.data?.limits || {}
        if (limitsBody?.data) {
          usage = { monthlyUsageUsd: usd(current.monthlyUsageUsd), maxMonthlyUsageUsd: usd(caps.maxMonthlyUsageUsd),
            maxConcurrentRuns: Number.isInteger(caps.maxConcurrentActorJobs) ? caps.maxConcurrentActorJobs : null,
            cycleEndAt: typeof limitsBody.data.monthlyUsageCycle?.endAt === 'string' ? limitsBody.data.monthlyUsageCycle.endAt : null }
        }
      }
      // Account name and plan only: no e-mail, profile or proxy password.
      return { baseUrl: APIFY_API, reachable: true, httpStatus: me.status, healthy: me.ok, durationMs: Date.now() - started,
        account: me.ok ? { username: typeof data.username === 'string' ? data.username : null, plan: typeof data.plan?.id === 'string' ? data.plan.id : null } : null,
        usage, error: me.ok ? null : (me.status === 401 ? 'credential_rejected' : `http_${me.status}`) }
    } catch (error) {
      return { baseUrl: APIFY_API, reachable: false, httpStatus: null, healthy: false, durationMs: Date.now() - started,
        error: EGRESS_REFUSED.has(error?.code) ? 'egress_unavailable' : error?.name === 'TimeoutError' ? 'timeout' : transportCause(error) }
    }
  },
})
