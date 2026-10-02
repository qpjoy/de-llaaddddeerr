// 工位（Station）: a Rig client that takes procedure batches off the queue.
//
// The service only coordinates. It schedules regression (the test kernel's
// cron tasks), queues a run for the app's procedures, and records what comes
// back. The browser work happens here — on a desktop left on duty, in
// `mx-rig station watch`, or in a station container — through the same
// claim / lease / heartbeat / complete protocol every test runner speaks. A
// station registers as a runner whose only engine is `rig-procedure`, so it
// is never handed a Cypress suite, and a Cypress runner is never handed this.
//
// What a claimed batch goes through:
//
// 1. fetch the procedures and the Range Safety policy with the run's token;
// 2. replay each on a fresh page, reporting it live as a case;
// 3. record each replay on its procedure (so the procedure page shows it);
// 4. upload the stop screenshot of each failure as a run artifact;
// 5. complete the run with one case per procedure.
//
// A cancelled run stops between steps and sends the stop receipt; a batch
// that cannot run at all is completed as blocked rather than left to expire.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { RigError } from '../contracts/index.mjs'
import { ProcedurePlayer, batchSummary } from './procedure.mjs'

export const STATION_ENGINES = Object.freeze(['rig-procedure'])
export const STATION_SURFACES = Object.freeze(['web'])
const IDLE_POLL_MS = 15_000

export class ProcedureStation {
  /**
   * @param {object} options
   * @param {string} options.server      the Rig service origin
   * @param {string} options.runnerToken this station's runner credential
   * @param {object} options.browser     a BrowserTools of its own
   * @param {string} [options.root]      where the browser keeps evidence
   */
  constructor({
    server,
    runnerToken,
    browser,
    root = null,
    fetchImpl = fetch,
    pollMs = IDLE_POLL_MS,
    heartbeatMs = null,
    log = () => {}
  }) {
    this.server = String(server).replace(/\/$/, '')
    this.runnerToken = runnerToken
    this.browser = browser
    this.root = root ?? browser.root
    this.fetch = fetchImpl
    this.pollMs = pollMs
    this.heartbeatMs = heartbeatMs
    this.log = log
    this.player = new ProcedurePlayer(browser)
    this.current = null
  }

  async #call(method, path, { token, body, signal, raw } = {}) {
    const response = await this.fetch(this.server + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal,
      redirect: 'error'
    })
    if (response.status === 204) return null
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    if (!response.ok)
      throw new RigError(
        json?.error?.code ?? 'station_request_failed',
        json?.error?.message ?? `${method} ${path} → ${response.status}`,
        response.status
      )
    return json
  }

  /** Take one batch if there is one; `null` when the queue is empty. */
  async once({ signal } = {}) {
    const claim = await this.#call('POST', '/runner/v1/runs:claim', {
      token: this.runnerToken,
      body: {},
      signal
    })
    if (!claim) return null
    return this.#execute(claim, signal)
  }

  async #execute(claim, outer) {
    const { runId, runToken } = claim
    const controller = new AbortController()
    const signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal
    let cancelled = false
    this.current = { runId, startedAt: new Date().toISOString() }
    const call = (method, path, options = {}) => this.#call(method, path, { token: runToken, ...options })
    const events = (list) =>
      call('POST', `/runner/v1/runs/${runId}/events`, { body: { events: list } }).catch(() => {})
    // Renewing the lease is also how a stop reaches the station: a cancelled
    // run refuses the heartbeat.
    const lease = this.heartbeatMs ?? Math.max(5, Math.floor((claim.leaseSeconds ?? 60) / 3)) * 1000
    const beat = setInterval(() => {
      call('POST', `/runner/v1/runs/${runId}/heartbeat`, { body: {} }).catch((error) => {
        if (error.status === 409) {
          cancelled = true
          controller.abort()
        }
      })
    }, lease)
    try {
      if (claim.suite?.engine !== 'rig-procedure')
        throw new RigError('wrong_engine', `这个工位只执行试验规程，不执行 ${claim.suite?.engine}`)
      await events([
        { kind: 'stage', stage: 'checkout', status: 'skipped', detail: '试验规程不需要检出代码' },
        { kind: 'stage', stage: 'execute', status: 'started' }
      ])
      const batch = await call('GET', `/api/rig/v1/station/runs/${runId}/procedures`, { signal })
      this.log(`▶ ${runId}：${batch.procedures.length} 条规程（${batch.app}）`)
      const entries = []
      for (const [index, procedure] of batch.procedures.entries()) {
        signal.throwIfAborted()
        await events([
          { kind: 'case.started', caseId: procedure.caseId, title: procedure.title, index, total: batch.procedures.length }
        ])
        await this.browser.close()
        const result = await this.player.run(procedure, {
          policy: batch.policy,
          runId: `${runId}-${index}`,
          signal
        })
        await this.browser.close()
        entries.push({ procedure, result })
        const status = result.verdict === 'passed' ? 'passed' : result.verdict === 'blocked' ? 'skipped' : 'failed'
        await events([
          ...result.steps
            .filter((step) => step.status !== 'skipped')
            .map((step) => ({
              kind: 'step',
              caseId: procedure.caseId,
              seq: step.index,
              label: step.text,
              status: step.status
            })),
          { kind: 'case.finished', caseId: procedure.caseId, status, durationMs: result.durationMs }
        ])
        await this.#evidence(call, runId, index, result)
        await call('POST', `/api/rig/v1/station/runs/${runId}/procedures/${procedure.id}/runs`, {
          body: { run: { ...result, station: 'station' } }
        }).catch((error) => this.log(`! 记录 ${procedure.id} 失败：${error.message}`))
        this.log(`  ${result.verdict === 'passed' ? '✓' : '✗'} ${procedure.title}${result.failure ? ` —— 第 ${result.failedStep + 1} 步：${result.failure.message}` : ''}`)
      }
      await events([{ kind: 'stage', stage: 'execute', status: 'ok' }])
      const summary = batchSummary(entries)
      await call('POST', `/runner/v1/runs/${runId}:complete`, {
        body: { summary, exitCode: summary.status === 'failed' ? 1 : 0 }
      })
      return { runId, status: summary.status, procedures: entries.length }
    } catch (error) {
      if (cancelled) {
        await call('POST', `/runner/v1/runs/${runId}:stopped`, { body: { scope: 'process-group' } }).catch(() => {})
        this.log(`■ ${runId} 已取消，已发送停止回执`)
        return { runId, status: 'cancelled' }
      }
      // A batch that cannot run is the environment's problem: complete it as
      // blocked with the reason, instead of letting the lease run out. That
      // includes a station told to stop at once — the run should say so now,
      // not expire in a minute.
      const reason = outer?.aborted ? '工位在执行中停止值守' : `工位无法执行：${error.message}`
      await call('POST', `/runner/v1/runs/${runId}:complete`, {
        body: {
          summary: {
            schemaVersion: 2,
            status: 'blocked',
            blockedReason: reason.slice(0, 300),
            totals: { tests: 0 },
            cases: []
          },
          exitCode: 0
        },
        signal: AbortSignal.timeout(5_000)
      }).catch(() => {})
      this.log(`! ${runId} 受阻：${reason}`)
      if (outer?.aborted) throw error
      return { runId, status: 'blocked', error: error.message }
    } finally {
      clearInterval(beat)
      this.current = null
      await this.browser.close().catch(() => {})
    }
  }

  /** The page where a replay stopped, kept with the run on the service. */
  async #evidence(call, runId, index, result) {
    if (!result.failure?.screenshot || !this.root) return
    try {
      const bytes = await readFile(join(this.root, result.failure.screenshot))
      await call('PUT', `/runner/v1/runs/${runId}/artifacts/procedures/${index + 1}-stop.png`, { raw: bytes })
    } catch {
      // Evidence is best-effort; the result is what must arrive.
    }
  }

  /**
   * Keep taking batches until stopped.
   *
   * `drain` is the polite stop: no new batch is taken, the current one
   * finishes. `signal` is the hard one: the current replay stops where it is
   * and the run is completed as blocked.
   */
  async watch({ signal, drain } = {}) {
    this.log('工位值守中：等待试验规程回归……')
    const idle = drain ? (signal ? AbortSignal.any([signal, drain]) : drain) : signal
    while (!signal?.aborted && !drain?.aborted) {
      let worked = null
      try {
        worked = await this.once({ signal })
      } catch (error) {
        if (signal?.aborted) break
        this.log(`! ${error.message}`)
      }
      if (!worked) await sleep(this.pollMs, undefined, { signal: idle }).catch(() => {})
    }
    this.log('工位已停止值守')
  }
}

/** Register this machine as a station with a member's session. */
export async function registerStation(client, { name, kind = 'local', os, arch }) {
  const result = await client.request('/runner/v1/runners:register', {
    name,
    kind,
    os,
    arch,
    engines: [...STATION_ENGINES],
    surfaces: [...STATION_SURFACES]
  })
  return { runnerId: result.runner.id, runnerToken: result.token, name: result.runner.name ?? name }
}

/** Register with a one-shot enrolment code, for a machine nobody signs in on. */
export async function enrollStation({ server, code, name, kind = 'server', os, arch, fetchImpl = fetch }) {
  const origin = String(server).replace(/\/$/, '')
  const response = await fetchImpl(`${origin}/runner/v1/runners:enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      name,
      kind,
      os,
      arch,
      engines: [...STATION_ENGINES],
      surfaces: [...STATION_SURFACES]
    }),
    redirect: 'error'
  }).catch((error) => {
    throw new RigError('station_unreachable', `连不上 ${origin}：${error.cause?.code ?? error.cause?.message ?? error.message}`, 502)
  })
  const json = await response.json().catch(() => null)
  if (!response.ok)
    throw new RigError(json?.error?.code ?? 'enroll_failed', json?.error?.message ?? `接入失败（${response.status}）`, response.status)
  return { runnerId: json.runner.id, runnerToken: json.token, name: json.runner.name ?? name }
}
