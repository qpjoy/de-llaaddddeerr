import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../core/errors.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'
import { FACEBOOK_SELFHOSTED_ENDPOINT, FACEBOOK_SELFHOSTED_MAX_INPUT, FACEBOOK_SELFHOSTED_PROVIDER,
  projectFacebookSearch } from '../contracts/facebook-search.mjs'

const MAX_BYTES = 8 * 1024 * 1024
const ACTIVE = new Set(['queued', 'leasing', 'starting', 'running', 'retry_wait'])
// Night-All-A stops the collector container after this many seconds. The Hub
// budget adds container start, record persistence and the cancel round trip.
export const NIGHT_ALL_A_FACEBOOK_RUN_SECONDS = 40
export const NIGHT_ALL_A_FACEBOOK_BUDGET_MS = 60_000
// Collector error codes (collectors/protocol/facebook/adapter.py). Account and
// session failures persist until an operator fixes Night-All-A, so they count
// toward the provider circuit; a caller's invalid input does not.
const RUN_FAILURES = {
  auth_expired: 'facebook_selfhosted_session_invalid', verification_required: 'facebook_selfhosted_session_invalid',
  credential_missing: 'facebook_selfhosted_session_invalid', resource_misconfigured: 'facebook_selfhosted_misconfigured',
  runner_unavailable: 'facebook_selfhosted_misconfigured', adapter_unavailable: 'facebook_selfhosted_misconfigured',
  unsupported_capability: 'facebook_selfhosted_misconfigured',
  account_rate_limited: 'facebook_selfhosted_rate_limited', soft_blocked: 'facebook_selfhosted_rate_limited',
  transport_error: 'facebook_selfhosted_transport_failed', invalid_input: 'facebook_selfhosted_invalid_input',
}

export class NightAllAUpstreamError extends Error {
  constructor(evidence, persistence = {}) {
    super('Self-hosted Facebook collection failed')
    this.name = 'NightAllAUpstreamError'
    this.evidence = evidence
    for (const key of ['responseArchive', 'upstreamEvidence', 'restrictedResponseArchive']) {
      Object.defineProperty(this, key, { value: persistence[key] ?? null, enumerable: false })
    }
    this.archiveObjects = []
  }
}

const refused = error => ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']
  .includes(error?.cause?.code ?? error?.code)

// One self-hosted search = one Night-All-A task with max_attempts 1. Hub owns
// queueing and the global concurrency/rate limits; this adapter only submits,
// waits for the run's terminal state and cancels a run that outlives the budget.
export class NightAllAFacebookAdapter {
  constructor({ baseUrl, fetchImpl = fetch, budgetMs = NIGHT_ALL_A_FACEBOOK_BUDGET_MS, pollMs = 1000,
    requestTimeoutMs = 10_000, clock = Date.now, wait = sleep, headers = {} } = {}) {
    this.baseUrl = baseUrl || null
    this.fetch = fetchImpl; this.budgetMs = budgetMs; this.pollMs = pollMs
    this.requestTimeoutMs = requestTimeoutMs; this.clock = clock; this.wait = wait; this.headers = headers
  }
  // Night-All-A is reached over the VPN without a Hub-held secret.
  async resolveCredential() { return this.baseUrl ? FACEBOOK_SELFHOSTED_PROVIDER : null }

  async #json(method, path, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const response = await this.fetch(new URL(path, this.baseUrl), { method, redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...this.headers },
        body: body ? JSON.stringify(body) : undefined })
      const text = await response.text()
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('response_too_large')
      let payload = null
      try { payload = JSON.parse(text) } catch { /* Status alone classifies a non-JSON reply. */ }
      return { status: response.status, payload, text }
    } finally { clearTimeout(timer) }
  }

  async execute(request, { signal } = {}) {
    if (request.endpointKey !== FACEBOOK_SELFHOSTED_ENDPOINT || request.platform !== 'facebook') {
      throw new AppError(400, 'night_all_a_platform_not_supported', 'Night-All-A serves only Facebook post search here')
    }
    if (!this.baseUrl) throw new AppError(503, 'external_platform_not_configured', 'Night-All-A address is not configured')
    const startedAt = this.clock(), deadline = startedAt + this.budgetMs
    const { query, start_date: startDate, end_date: endDate, pages, cursor } = request.upstreamQuery
    let taskId = null, runId = null, run = null, started = false
    const evidence = (state, extra = {}) => ({
      upstreamEvidence: { requestId: runId ? `night-all-a-run:${runId}` : null },
      responseArchive: { contractState: state, httpStatus: extra.httpStatus ?? null, businessCode: null,
        contentType: 'application/json', bodySize: null, payloadSha256: null, capturedAt: new Date().toISOString(),
        rawPayload: { response: { taskId, runId, status: run?.status ?? null, errorType: run?.error_type ?? null,
          durationMs: run?.duration_ms ?? null, resultState: run?.result?.metrics?.result_state ?? null } } },
    })
    const fail = (outcome, errorCode, extra = {}) => new NightAllAUpstreamError({ outcome, billed: false,
      httpStatus: extra.httpStatus ?? null, businessCode: extra.businessCode ?? null, errorCode,
      affectsCircuit: extra.affectsCircuit ?? outcome !== 'rejected', ...(extra.retryAfterMs ? { retryAfterMs: extra.retryAfterMs } : {}) },
    evidence(outcome, extra))
    if ([query, cursor].some(value => typeof value === 'string' && value.length > FACEBOOK_SELFHOSTED_MAX_INPUT)) {
      throw fail('rejected', 'facebook_selfhosted_invalid_input', { affectsCircuit: false })
    }
    let submitted
    try {
      submitted = await this.#json('POST', '/api/tasks', { connector_id: 'facebook-protocol', capability: 'search.posts',
        parameters: { query, ...(startDate ? { start_date: startDate } : {}), ...(endDate ? { end_date: endDate } : {}),
          pages: pages || 1, ...(cursor ? { cursor } : {}) },
        task_type: 'query', priority: 0, max_attempts: 1, timeout_seconds: NIGHT_ALL_A_FACEBOOK_RUN_SECONDS, persist_results: true })
    } catch (error) {
      // A refused connection created nothing; any later loss may have created a task.
      throw refused(error) ? fail('rejected', 'night_all_a_unreachable', { affectsCircuit: true })
        : fail('unknown', 'night_all_a_submit_unknown')
    }
    if (submitted.status >= 500) throw fail('unknown', 'night_all_a_submit_unknown', { httpStatus: submitted.status })
    taskId = submitted.payload?.task?.id ?? null; runId = submitted.payload?.run?.id ?? null
    if (submitted.status >= 400 || !Number.isSafeInteger(taskId) || !Number.isSafeInteger(runId)) {
      throw submitted.status >= 200 && submitted.status < 300 ? fail('unknown', 'night_all_a_submit_unknown', { httpStatus: submitted.status })
        : fail('rejected', submitted.status === 422 ? 'facebook_selfhosted_invalid_input' : 'night_all_a_rejected',
          { httpStatus: submitted.status, affectsCircuit: submitted.status !== 422 })
    }
    let delay = this.pollMs
    while (true) {
      if (signal?.aborted || this.clock() >= deadline) break
      try {
        const polled = await this.#json('GET', `/api/runs/${runId}?include_result=true`)
        if (polled.status === 200 && polled.payload?.id === runId) run = polled.payload
      } catch { /* A lost poll is not a run outcome; keep polling until the budget. */ }
      if (run && !ACTIVE.has(run.status)) break
      if (run && run.status !== 'queued') started = true
      await this.wait(Math.max(0, Math.min(delay, deadline - this.clock())))
      delay = Math.min(2000, delay + 250)
    }
    if (!run || ACTIVE.has(run.status)) {
      // Stop the collector so the global slot can be trusted again. A queued run
      // that Night-All-A confirms cancelled never reached Facebook.
      let cancelled = null
      try { cancelled = await this.#json('POST', `/api/tasks/${taskId}/cancel`) } catch { /* Outcome stays unknown. */ }
      if (!started && cancelled?.status === 200 && cancelled.payload?.status === 'cancelled') {
        throw fail('rejected', 'night_all_a_queue_timeout', { affectsCircuit: false })
      }
      throw fail('unknown', 'night_all_a_run_timeout')
    }
    if (run.status !== 'succeeded') {
      const code = RUN_FAILURES[run.error_code] || RUN_FAILURES[run.error_type]
      if (['cancelled', 'orphaned'].includes(run.status)) throw fail('unknown', 'night_all_a_run_interrupted')
      throw fail('rejected', code || 'facebook_selfhosted_failed', { affectsCircuit: code !== 'facebook_selfhosted_invalid_input',
        ...(code === 'facebook_selfhosted_rate_limited' ? { httpStatus: 429, retryAfterMs: run.error_code === 'soft_blocked' ? 60_000 : 300_000 } : {}) })
    }
    // The archived body is the run's result object: re-projecting it later
    // (buffered standard-search pages) needs nothing else from the run row.
    const capturedAt = new Date().toISOString()
    const bodyText = JSON.stringify(run.result ?? null), bytes = Buffer.from(bodyText)
    const bodySha256 = createHash('sha256').update(bytes).digest('hex'), textSafe = isPostgresSafeText(bodyText)
    const persistence = state => {
      const base = evidence(state, { httpStatus: 200 })
      return { ...base, responseArchive: { ...base.responseArchive, bodySize: bytes.length, payloadSha256: bodySha256, capturedAt },
        restrictedResponseArchive: { state, capturedAt, httpStatus: 200, contentType: 'application/json', bodySize: bytes.length,
          bodySha256, bodyBytes: bytes, bodyText: textSafe ? bodyText : null, jsonParsed: true,
          parsedPayload: textSafe && isPostgresSafeJsonValue(run.result) ? run.result : null } }
    }
    let publicBody
    try {
      if (bytes.length > MAX_BYTES || !isPostgresSafeJsonValue(run.result)) throw new Error('invalid_facebook_response')
      publicBody = projectFacebookSearch(run.result, request, FACEBOOK_SELFHOSTED_PROVIDER, capturedAt, { allowOverflow: true }).publicBody
    } catch {
      throw new NightAllAUpstreamError({ outcome: 'succeeded_unusable', billed: false, httpStatus: 200, businessCode: null,
        errorCode: 'invalid_facebook_response', affectsCircuit: true }, persistence('succeeded_unusable'))
    }
    const state = run.result?.metrics?.result_state
    if (['partial', 'permission_limited'].includes(state)) publicBody.data.warnings.push({ code: 'FACEBOOK_SELFHOSTED_PARTIAL',
      message: 'The self-hosted collector marked this page partial; completeness is not confirmed.' })
    const result = { publicBody, items: publicBody.data.items, records: [], archiveObjects: [], ...persistence('accepted') }
    Object.defineProperty(result, 'restrictedResponseArchive', { value: result.restrictedResponseArchive, enumerable: false })
    return result
  }
}
