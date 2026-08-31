const STORAGE_VERSION = 1

export const AGENT_MARKET_RUN_HISTORY_STORAGE_KEY = 'mx-insight-hub.agent-market.run-history.v1'

export const AGENT_MARKET_RUN_HISTORY_POLICY = Object.freeze({
  ttlMs: 8 * 60 * 60 * 1_000,
  maxEntries: 12,
  maxEntriesPerAgent: 3,
  maxEntryBytes: 128 * 1_024,
  maxStorageBytes: 384 * 1_024,
  maxTracesPerRun: 32,
  maxArrayItems: 64,
  maxObjectKeys: 96,
  maxStringChars: 8_000,
  maxDepth: 12,
})

const TERMINAL_TRACE_STATUSES = new Set(['succeeded', 'degraded', 'skipped', 'failed'])
const AGENT_KEY = /^[a-z][a-z0-9-]{0,63}$/
const SECRET_FIELD = /(?:authorization|api.?key|access.?token|refresh.?token|^token$|password|passwd|secret|credential|cookie|private.?key|connection.?string|dsn)/i
const HIDDEN_REASONING_FIELD = /^(?:analysis|reasoning|reasoningContent|reasoning_content|chainOfThought|chain_of_thought|thoughts|hiddenReasoning|hidden_reasoning|internalAnalysis|internal_analysis)$/i
const DROP = Symbol('drop')

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type HistoryEntry = {
  agentKey: string
  storedAt: string
  expiresAt: string
  run: Record<string, unknown>
}

type HistoryEnvelope = {
  version: typeof STORAGE_VERSION
  entries: HistoryEntry[]
}

type TraceRecord = Record<string, unknown> & {
  type: string
  attempt: number
  status: string
}

export type AgentMarketRunTerminalAudit = {
  complete: boolean
  activeStages: string[]
  terminalStages: string[]
  missingTerminalStages: string[]
  takenPath: Array<{ stage: string, attempt: number, status: string }>
  skippedStages: string[]
  retry: {
    declared: number
    observed: number
    consistent: boolean
  }
  finalOutcome: 'result' | 'refusal' | 'failed' | 'skipped' | 'missing'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getAgentMarketRunHistoryStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function boundedText(value: string): string {
  let text = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '[redacted-token]')
    .replace(/\bmih_(?:live|test)_[A-Za-z0-9_-]{8,}/g, '[redacted-token]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?[^\s,"']+/gi, '$1=[redacted]')
    .replace(/\b(postgres(?:ql)?|mysql):\/\/[^@\s/]+@/gi, '$1://[redacted]@')
  if (text.length > AGENT_MARKET_RUN_HISTORY_POLICY.maxStringChars) {
    text = text.slice(0, AGENT_MARKET_RUN_HISTORY_POLICY.maxStringChars) + '…'
  }
  return text
}

function sanitizeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown | typeof DROP {
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return boundedText(value)
  if (typeof value !== 'object') return DROP
  if (depth >= AGENT_MARKET_RUN_HISTORY_POLICY.maxDepth || seen.has(value)) return '[omitted]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.slice(0, AGENT_MARKET_RUN_HISTORY_POLICY.maxArrayItems).flatMap((item) => {
        const sanitized = sanitizeValue(item, depth + 1, seen)
        return sanitized === DROP ? [] : [sanitized]
      })
    }
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, AGENT_MARKET_RUN_HISTORY_POLICY.maxObjectKeys)) {
      if (HIDDEN_REASONING_FIELD.test(key)) continue
      if (SECRET_FIELD.test(key)) {
        result[key] = '[redacted]'
        continue
      }
      const sanitized = sanitizeValue(item, depth + 1, seen)
      if (sanitized !== DROP) result[key] = sanitized
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function copyAllowed(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) continue
    const sanitized = sanitizeValue(source[key])
    if (sanitized !== DROP) result[key] = sanitized
  }
  return result
}

function traceSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !TERMINAL_TRACE_STATUSES.has(String(value.status))) {
    return null
  }
  const trace = copyAllowed(value, [
    'stageId', 'type', 'title', 'attempt', 'status', 'startedAt', 'durationMs',
    'input', 'parameters', 'toolCalls', 'output', 'validation', 'model', 'note',
  ])
  trace.messages = Array.isArray(value.messages)
    ? value.messages.slice(0, 16).flatMap((message) => {
        if (!isRecord(message) || !['system', 'user', 'tool'].includes(String(message.role))) return []
        return [{ role: String(message.role), content: boundedText(String(message.content || '')) }]
      })
    : []
  return trace
}

function runSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.traces)) return null
  const snapshot = copyAllowed(value, [
    'contractVersion', 'agentKey', 'dryRun', 'definitionHash', 'startedAt', 'finishedAt',
    'durationMs', 'graph', 'safety', 'dataAccess', 'final', 'evaluation',
  ])
  snapshot.traces = value.traces
    .slice(0, AGENT_MARKET_RUN_HISTORY_POLICY.maxTracesPerRun)
    .map(traceSnapshot)
    .filter((trace): trace is Record<string, unknown> => trace !== null)
  return snapshot
}

function compactRunSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const traces = Array.isArray(value.traces) ? value.traces : []
  return {
    ...copyAllowed(value, [
      'contractVersion', 'agentKey', 'dryRun', 'definitionHash', 'startedAt', 'finishedAt',
      'durationMs', 'graph', 'safety', 'dataAccess', 'final', 'evaluation',
    ]),
    traces: traces.flatMap((trace) => isRecord(trace) ? [{
      ...copyAllowed(trace, [
        'stageId', 'type', 'title', 'attempt', 'status', 'startedAt', 'durationMs',
        'parameters', 'validation', 'model', 'note',
      ]),
      input: null,
      messages: [],
      toolCalls: [],
      output: null,
    }] : []),
  }
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function validEntry(value: unknown, now: number): value is HistoryEntry {
  if (!isRecord(value) || !AGENT_KEY.test(String(value.agentKey))) return false
  if (typeof value.storedAt !== 'string' || typeof value.expiresAt !== 'string' || !isRecord(value.run)) return false
  const storedAt = Date.parse(value.storedAt)
  const expiresAt = Date.parse(value.expiresAt)
  return Number.isFinite(storedAt)
    && Number.isFinite(expiresAt)
    && storedAt <= now + 5 * 60 * 1_000
    && expiresAt > now
    && expiresAt <= storedAt + AGENT_MARKET_RUN_HISTORY_POLICY.ttlMs
}

function emptyEnvelope(): HistoryEnvelope {
  return { version: STORAGE_VERSION, entries: [] }
}

function readEnvelope(storage: StorageLike | null | undefined, now: number): HistoryEnvelope {
  if (!storage) return emptyEnvelope()
  try {
    const raw = storage.getItem(AGENT_MARKET_RUN_HISTORY_STORAGE_KEY)
    if (!raw) return emptyEnvelope()
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.entries)) {
      storage.removeItem(AGENT_MARKET_RUN_HISTORY_STORAGE_KEY)
      return emptyEnvelope()
    }
    return {
      version: STORAGE_VERSION,
      entries: parsed.entries.filter((entry) => validEntry(entry, now)),
    }
  } catch {
    return emptyEnvelope()
  }
}

function boundedEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const perAgent = new Map<string, number>()
  const bounded: HistoryEntry[] = []
  for (const entry of entries) {
    const count = perAgent.get(entry.agentKey) || 0
    if (count >= AGENT_MARKET_RUN_HISTORY_POLICY.maxEntriesPerAgent) continue
    perAgent.set(entry.agentKey, count + 1)
    bounded.push(entry)
    if (bounded.length >= AGENT_MARKET_RUN_HISTORY_POLICY.maxEntries) break
  }
  while (bounded.length > 0 && encodedBytes({ version: STORAGE_VERSION, entries: bounded }) > AGENT_MARKET_RUN_HISTORY_POLICY.maxStorageBytes) {
    bounded.pop()
  }
  return bounded
}

function writeEnvelope(storage: StorageLike, entries: HistoryEntry[]): boolean {
  const bounded = boundedEntries(entries)
  try {
    storage.setItem(AGENT_MARKET_RUN_HISTORY_STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, entries: bounded }))
    return true
  } catch {
    return false
  }
}

export function rememberAgentMarketRun(
  storage: StorageLike | null | undefined,
  agentKey: string,
  run: unknown,
  now = Date.now(),
): boolean {
  if (!storage || !AGENT_KEY.test(agentKey) || !Number.isFinite(now)) return false
  let snapshot = runSnapshot(run)
  if (!snapshot) return false
  if (encodedBytes(snapshot) > AGENT_MARKET_RUN_HISTORY_POLICY.maxEntryBytes) {
    snapshot = compactRunSnapshot(snapshot)
  }
  if (encodedBytes(snapshot) > AGENT_MARKET_RUN_HISTORY_POLICY.maxEntryBytes) return false

  const storedAt = new Date(now).toISOString()
  const entry: HistoryEntry = {
    agentKey,
    storedAt,
    expiresAt: new Date(now + AGENT_MARKET_RUN_HISTORY_POLICY.ttlMs).toISOString(),
    run: snapshot,
  }
  const previous = readEnvelope(storage, now).entries.filter((candidate) => !(
    candidate.agentKey === agentKey
    && candidate.run.finishedAt === snapshot.finishedAt
    && candidate.run.definitionHash === snapshot.definitionHash
  ))
  return writeEnvelope(storage, [entry, ...previous])
}

export function readAgentMarketRunHistory(
  storage: StorageLike | null | undefined,
  agentKey: string,
  now = Date.now(),
): HistoryEntry[] {
  if (!storage || !AGENT_KEY.test(agentKey) || !Number.isFinite(now)) return []
  const envelope = readEnvelope(storage, now)
  const bounded = boundedEntries(envelope.entries)
  writeEnvelope(storage, bounded)
  return bounded.filter((entry) => entry.agentKey === agentKey)
}

export function clearAgentMarketRunHistory(
  storage: StorageLike | null | undefined,
  agentKey?: string,
  now = Date.now(),
): void {
  if (!storage) return
  if (!agentKey) {
    try {
      storage.removeItem(AGENT_MARKET_RUN_HISTORY_STORAGE_KEY)
    } catch {
      // Browser storage can be disabled; history is best-effort by design.
    }
    return
  }
  if (!AGENT_KEY.test(agentKey)) return
  const remaining = readEnvelope(storage, now).entries.filter((entry) => entry.agentKey !== agentKey)
  writeEnvelope(storage, remaining)
}

function normalizedTrace(value: unknown): TraceRecord | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !TERMINAL_TRACE_STATUSES.has(String(value.status))) {
    return null
  }
  return {
    ...value,
    type: value.type,
    status: String(value.status),
    attempt: Math.max(0, Math.trunc(finiteNumber(value.attempt))),
  }
}

export function inspectAgentMarketRunTerminal(
  run: unknown,
  definition: unknown,
): AgentMarketRunTerminalAudit {
  const stages = isRecord(definition) && Array.isArray(definition.stages) ? definition.stages : []
  const activeStages = stages.flatMap((stage) => (
    isRecord(stage) && stage.state === 'active' && typeof stage.type === 'string' ? [stage.type] : []
  ))
  const traces = isRecord(run) && Array.isArray(run.traces)
    ? run.traces.map(normalizedTrace).filter((trace): trace is TraceRecord => trace !== null)
    : []
  const terminalStages = [...new Set(traces.map((trace) => trace.type))]
  const missingTerminalStages = activeStages.filter((stage) => !terminalStages.includes(stage))
  const takenPath = traces.filter((trace) => trace.status !== 'skipped').map((trace) => ({
    stage: trace.type,
    attempt: trace.attempt,
    status: trace.status,
  }))
  const skippedStages = [...new Set(traces.filter((trace) => trace.status === 'skipped').map((trace) => trace.type))]
  const observedRetries = traces.reduce((highest, trace) => Math.max(highest, trace.attempt), 0)
  const evaluation = isRecord(run) && isRecord(run.evaluation) ? run.evaluation : {}
  const declaredRetries = Math.max(0, Math.trunc(finiteNumber(evaluation.correctiveRetries)))
  const answerActive = activeStages.includes('answer')
  const answerTrace = [...traces].reverse().find((trace) => trace.type === 'answer') || null
  const final = isRecord(run) && isRecord(run.final) ? run.final : null
  const finalOutcome: AgentMarketRunTerminalAudit['finalOutcome'] = final
    ? final.refused === true ? 'refusal' : 'result'
    : answerTrace?.status === 'failed' ? 'failed'
      : !answerActive || answerTrace?.status === 'skipped' ? 'skipped'
        : 'missing'
  const retryConsistent = declaredRetries === observedRetries
  return {
    complete: missingTerminalStages.length === 0 && retryConsistent && finalOutcome !== 'missing',
    activeStages,
    terminalStages,
    missingTerminalStages,
    takenPath,
    skippedStages,
    retry: {
      declared: declaredRetries,
      observed: observedRetries,
      consistent: retryConsistent,
    },
    finalOutcome,
  }
}
