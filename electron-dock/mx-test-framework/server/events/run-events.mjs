// Live progress of a run: what the platform knows while the tests are running.
//
// The design is in docs/25-live-runs-and-runner-onboarding.md. Two decisions
// from it show up directly in this file:
//
//   1. **The server assigns `seq`, not the runner.** It is the resume point a
//      reconnecting browser sends back as `Last-Event-ID`, so it has to be
//      monotonic per run. A runner numbering its own events would turn every
//      network retry and every process restart into a duplicate.
//   2. **A runner is not trusted.** It executes code from the repository under
//      test, so every label, line and case id here goes through the same
//      redaction the summary does before it reaches the database.

import { redactLine } from '../core/redact.mjs'

/** Closed set. An unknown kind is dropped, not stored — see `normalizeRunEvent`. */
export const RUN_EVENT_KINDS = [
  'run.claimed',
  'stage',
  'case.started',
  'case.finished',
  'step',
  'log',
  'run.finished',
]

/**
 * The stages of a run, in order, as the UI draws them.
 *
 * Everything before `execute` is infrastructure: when one of these fails the
 * run is `blocked`, not red. Keeping the list here means the pipeline drawn on
 * the run page and the stages a runner reports cannot drift apart.
 */
export const RUN_STAGES = ['claim', 'checkout', 'install', 'launch', 'execute', 'upload', 'archive']

const STAGE_STATUS = ['started', 'ok', 'failed', 'skipped']
const CASE_STATUS = ['passed', 'failed', 'skipped', 'flaky', 'notRun', 'running']
const STEP_STATUS = ['passed', 'failed', 'running', 'skipped']

/**
 * Per-run ceiling.
 *
 * Without one, a test stuck in a loop that logs on every iteration holds an
 * open licence to write to the database. Events past the cap are dropped and a
 * single `log` row records that they were — silently losing them would make the
 * timeline lie about being complete.
 */
export const RUN_EVENT_CAP = 5000

/** Events accepted in one POST. A runner batches; it does not stream one by one. */
export const RUN_EVENT_BATCH_MAX = 200

const clampInt = (value, { min = 0, max = 2_147_483_647 } = {}) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

const oneOf = (value, allowed) => (allowed.includes(value) ? value : null)

// Colour codes, cursor moves and the rest of what a build tool writes to a
// terminal. They are meaningless in an HTML panel and read as mojibake, so they
// come off here rather than in each runner: this is the one place every event
// passes through, and a runner is not trusted to do it anyway.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu
const stripAnsi = (value) => (typeof value === 'string' ? value.replace(ANSI, '') : value)

const caseId = (value) => redactLine(String(value ?? ''), 64) || null

const PAYLOAD = {
  'run.claimed': (input) => ({
    runner: redactLine(input.runner ?? '', 96),
    os: redactLine(input.os ?? '', 16),
  }),
  stage: (input) => ({
    stage: oneOf(input.stage, RUN_STAGES) ?? 'execute',
    status: oneOf(input.status, STAGE_STATUS) ?? 'started',
    detail: redactLine(stripAnsi(input.detail ?? ''), 300),
  }),
  'case.started': (input) => ({
    caseId: caseId(input.caseId),
    title: redactLine(input.title ?? '', 200),
    index: clampInt(input.index),
    total: clampInt(input.total),
  }),
  'case.finished': (input) => ({
    caseId: caseId(input.caseId),
    status: oneOf(input.status, CASE_STATUS) ?? 'passed',
    durationMs: clampInt(input.durationMs),
  }),
  step: (input) => ({
    caseId: caseId(input.caseId),
    seq: clampInt(input.seq) ?? 0,
    label: redactLine(input.label ?? '', 200),
    status: oneOf(input.status, STEP_STATUS) ?? 'passed',
    offsetMs: clampInt(input.offsetMs),
  }),
  log: (input) => ({
    stream: oneOf(input.stream, ['stdout', 'stderr']) ?? 'stdout',
    line: redactLine(stripAnsi(input.line ?? ''), 500),
  }),
  'run.finished': (input) => ({
    status: redactLine(input.status ?? '', 24),
    durationMs: clampInt(input.durationMs),
  }),
}

/**
 * One reported event, cleaned up — or `null` if there is nothing worth storing.
 *
 * Dropping beats rejecting: a batch with one malformed entry should still
 * deliver the other nineteen. The runner is reporting progress, not submitting
 * a result, and failing the whole POST would lose information for no gain.
 */
export function normalizeRunEvent(raw, { now = new Date() } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  if (!RUN_EVENT_KINDS.includes(kind)) return null

  const input = raw.payload && typeof raw.payload === 'object' ? raw.payload : raw
  const payload = PAYLOAD[kind](input)

  // A clock on someone else's laptop is not a clock this platform can order
  // things by. The runner's timestamp is accepted only when it is plausible;
  // otherwise the server's own time is used, which is what `seq` orders by
  // anyway.
  let at = now
  const reported = raw.at ? new Date(raw.at) : null
  if (reported && !Number.isNaN(reported.getTime())) {
    const drift = Math.abs(reported.getTime() - now.getTime())
    if (drift < 24 * 60 * 60 * 1000) at = reported
  }
  return { kind, at: at.toISOString(), payload }
}

export function normalizeRunEvents(list, options) {
  if (!Array.isArray(list)) return []
  const events = []
  for (const raw of list.slice(0, RUN_EVENT_BATCH_MAX)) {
    const event = normalizeRunEvent(raw, options)
    if (event) events.push(event)
  }
  return events
}

/**
 * Store progress events and tell everyone watching the run.
 *
 * Shared by the HTTP route a runner posts to and by the k8s dispatcher, which
 * reports its own stages from inside the scheduler tick. Two copies of the cap
 * handling would be two places to get the truncation notice wrong.
 *
 * The last slot under the cap is reserved so that the notice always fits.
 * Dropping events silently would let the timeline claim to be complete when it
 * is not, which is the one thing a timeline must never do.
 */
export function createRunEventRecorder({ store, bus }) {
  return async function record(runId, incoming) {
    const events = incoming.filter(Boolean)
    if (events.length === 0) return { events: [], dropped: 0 }
    const result = await store.appendRunEvents(runId, events, { cap: RUN_EVENT_CAP - 1 })
    if (result.dropped > 0) {
      // Appended against the full cap, so it lands exactly once: every later
      // attempt finds the table at the ceiling and is dropped in turn.
      const notice = await store.appendRunEvents(
        runId,
        [
          normalizeRunEvent({
            kind: 'log',
            stream: 'stderr',
            line: `事件超过 ${RUN_EVENT_CAP} 条上限，后续进度不再记录（结果判定不受影响）`,
          }),
        ],
        { cap: RUN_EVENT_CAP },
      )
      result.events.push(...notice.events)
    }
    bus?.publish(runId, result.events)
    return result
  }
}

/**
 * In-process fan-out from "an event was stored" to "every browser watching".
 *
 * Deliberately not durable and deliberately not redis: the durable copy is the
 * `mxt_run_events` table, and a subscriber that missed something reconnects
 * with `Last-Event-ID` and reads it from there. That is what makes a single
 * `Map` sufficient here, and it stays sufficient until the server runs more
 * than one replica — the trigger conditions are written down in docs/25 §8.
 */
export class RunEventBus {
  #listeners = new Map()

  subscribe(runId, listener) {
    const set = this.#listeners.get(runId) ?? new Set()
    set.add(listener)
    this.#listeners.set(runId, set)
    return () => {
      const current = this.#listeners.get(runId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.#listeners.delete(runId)
    }
  }

  publish(runId, events) {
    const set = this.#listeners.get(runId)
    if (!set || events.length === 0) return 0
    for (const listener of set) {
      // One broken subscriber — a socket that died between the check and the
      // write — must not stop the others from being told.
      try {
        listener(events)
      } catch {
        /* ignore */
      }
    }
    return set.size
  }

  /** Watchers of one run, or of everything. Used by tests and by /healthz. */
  count(runId = null) {
    if (runId) return this.#listeners.get(runId)?.size ?? 0
    let total = 0
    for (const set of this.#listeners.values()) total += set.size
    return total
  }
}
