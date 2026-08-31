import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { freshAdvancedSearchDefinition } from '../../agent-market/advanced-search/manifest.ts'
import { runAdvancedSearchDryRun } from '../../server/agent-market/runner.ts'
import {
  AGENT_MARKET_RUN_HISTORY_POLICY,
  AGENT_MARKET_RUN_HISTORY_STORAGE_KEY,
  clearAgentMarketRunHistory,
  getAgentMarketRunHistoryStorage,
  inspectAgentMarketRunTerminal,
  readAgentMarketRunHistory,
  rememberAgentMarketRun,
} from '../../src/agent-market-run-history.ts'

class MemoryStorage {
  values = new Map()

  getItem(key) {
    return this.values.get(key) ?? null
  }

  setItem(key, value) {
    this.values.set(key, String(value))
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

const ACTIVE_STAGES = ['triage', 'rewrite', 'retrieve', 'fuse', 'grade', 'geo', 'answer']

function trace(type, overrides = {}) {
  return {
    stageId: type,
    type,
    title: type,
    attempt: 0,
    status: 'succeeded',
    startedAt: '2026-08-31T00:00:00.000Z',
    durationMs: 1,
    input: { query: 'safe query' },
    messages: [{ role: 'system', content: 'Return JSON only.' }],
    parameters: {},
    toolCalls: [],
    output: { ok: true },
    validation: { schemaName: type + 'Schema', valid: true, issues: [] },
    model: null,
    note: null,
    ...overrides,
  }
}

function run(overrides = {}) {
  return {
    contractVersion: 'mx-insight.agent-market.dry-run.v1',
    agentKey: 'advanced-search-dry-run',
    dryRun: true,
    definitionHash: 'a'.repeat(64),
    startedAt: '2026-08-31T00:00:00.000Z',
    finishedAt: '2026-08-31T00:00:01.000Z',
    durationMs: 1_000,
    graph: { stages: ACTIVE_STAGES },
    safety: { writes: 0 },
    dataAccess: { postgres: true },
    traces: ACTIVE_STAGES.map((stage) => trace(stage)),
    final: { answer: 'Grounded result', citations: [], confidence: 0.8, limitations: [], refused: false },
    evaluation: { correctiveRetries: 0 },
    ...overrides,
  }
}

test('Agent Market page restores only Admin-session history and renders the terminal audit', async () => {
  const source = await readFile(new URL('../../src/pages-agent-market.tsx', import.meta.url), 'utf8')
  assert.match(source, /if \(!canAdmin \|\| !isAdvancedWorkbench \|\| !selectedAgentKey\) return/u)
  assert.match(source, /readAgentMarketRunHistory\(runHistoryStorage, selectedAgentKey\)/u)
  assert.match(source, /setResult\(restored\[0\] \|\| null\)/u)
  assert.match(source, /setPreviousResult\(restored\[1\] \|\| null\)/u)
  assert.match(source, /if \(canAdmin\) rememberAgentMarketRun/u)
  assert.match(source, /if \(canAdmin\) return\s+setResult\(null\)\s+setPreviousResult\(null\)/u)
  assert.match(source, /完整性 · \{audit\.complete \? 'PASS' : 'FAIL'\}/u)
  assert.match(source, /节点终态 · \{audit\.terminalStages\.length\}\/\{ADVANCED_SEARCH_STAGE_TYPES\.length\}/u)
  assert.match(source, /Retry · 声明 \{audit\.retry\.declared\} \/ 观测 \{audit\.retry\.observed\}/u)
  assert.match(source, /<strong>Taken path<\/strong>/u)
})

test('session run history restores newest runs and removes credentials and hidden reasoning', () => {
  const storage = new MemoryStorage()
  const now = Date.parse('2026-08-31T01:00:00.000Z')
  const first = run({
    traces: [trace('answer', {
      input: {
        authorization: 'Bearer must-not-survive',
        token: 'must-not-survive',
        password: 'must-not-survive',
        query: 'api_key=must-not-survive safe',
        reasoning_content: 'private chain of thought',
      },
      messages: [
        { role: 'system', content: 'Bearer must-not-survive' },
        { role: 'assistant', content: 'private chain of thought' },
      ],
      model: { attempts: [{ accessToken: 'must-not-survive' }] },
    })],
  })
  const second = run({
    definitionHash: 'b'.repeat(64),
    finishedAt: '2026-08-31T00:00:02.000Z',
    final: { answer: 'Latest', citations: [], confidence: 1, limitations: [], refused: false },
  })

  assert.equal(rememberAgentMarketRun(storage, 'advanced-search', first, now), true)
  assert.equal(rememberAgentMarketRun(storage, 'advanced-search', second, now + 1), true)

  const raw = storage.getItem(AGENT_MARKET_RUN_HISTORY_STORAGE_KEY)
  assert.doesNotMatch(raw, /must-not-survive|private chain of thought/)
  assert.match(raw, /\[redacted\]/)
  const restored = readAgentMarketRunHistory(storage, 'advanced-search', now + 2)
  assert.equal(restored.length, 2)
  assert.equal(restored[0].run.definitionHash, 'b'.repeat(64))
  assert.equal(restored[1].run.definitionHash, 'a'.repeat(64))
})

test('session run history enforces per-Agent count, TTL and total byte bounds', () => {
  const storage = new MemoryStorage()
  const now = Date.parse('2026-08-31T01:00:00.000Z')
  for (let index = 0; index < 8; index += 1) {
    const value = run({
      definitionHash: String(index).repeat(64),
      finishedAt: new Date(now + index).toISOString(),
      final: {
        answer: String(index) + '汉'.repeat(AGENT_MARKET_RUN_HISTORY_POLICY.maxStringChars * 4),
        citations: [],
        confidence: 0,
        limitations: [],
        refused: false,
      },
    })
    assert.equal(rememberAgentMarketRun(storage, 'advanced-search', value, now + index), true)
  }

  assert.equal(
    readAgentMarketRunHistory(storage, 'advanced-search', now + 10).length,
    AGENT_MARKET_RUN_HISTORY_POLICY.maxEntriesPerAgent,
  )
  const raw = storage.getItem(AGENT_MARKET_RUN_HISTORY_STORAGE_KEY)
  assert.ok(new TextEncoder().encode(raw).byteLength <= AGENT_MARKET_RUN_HISTORY_POLICY.maxStorageBytes)

  const expired = readAgentMarketRunHistory(
    storage,
    'advanced-search',
    now + AGENT_MARKET_RUN_HISTORY_POLICY.ttlMs + 20,
  )
  assert.deepEqual(expired, [])
})

test('session run history is best-effort when browser storage is unavailable or corrupt', () => {
  const storage = new MemoryStorage()
  storage.setItem(AGENT_MARKET_RUN_HISTORY_STORAGE_KEY, '{not-json')
  assert.deepEqual(readAgentMarketRunHistory(storage, 'advanced-search'), [])
  assert.equal(rememberAgentMarketRun(null, 'advanced-search', run()), false)
  assert.equal(getAgentMarketRunHistoryStorage(), null)

  assert.equal(rememberAgentMarketRun(storage, 'advanced-search', run()), true)
  clearAgentMarketRunHistory(storage, 'advanced-search')
  assert.deepEqual(readAgentMarketRunHistory(storage, 'advanced-search'), [])
})

test('terminal audit reports taken path, branch skips, retries and final refusal', () => {
  const definition = freshAdvancedSearchDefinition()
  const traces = [
    trace('triage'),
    trace('rewrite'),
    trace('retrieve'),
    trace('fuse'),
    trace('grade', { status: 'degraded' }),
    trace('rewrite', { attempt: 1 }),
    trace('retrieve', { attempt: 1 }),
    trace('fuse', { attempt: 1 }),
    trace('grade', { attempt: 1, status: 'degraded' }),
    trace('geo', { status: 'skipped' }),
    trace('answer', { status: 'degraded', durationMs: 0 }),
  ]
  const result = run({
    traces,
    final: { answer: 'No grounded evidence', citations: [], confidence: 0, limitations: [], refused: true },
    evaluation: { correctiveRetries: 1 },
  })
  const audit = inspectAgentMarketRunTerminal(result, definition)

  assert.equal(audit.complete, true)
  assert.deepEqual(audit.missingTerminalStages, [])
  assert.equal(audit.takenPath.some((entry) => entry.stage === 'geo'), false)
  assert.deepEqual(audit.skippedStages, ['geo'])
  assert.deepEqual(audit.retry, { declared: 1, observed: 1, consistent: true })
  assert.equal(audit.finalOutcome, 'refusal')
})

test('terminal audit exposes incomplete trace or retry evidence instead of treating it as success', () => {
  const definition = freshAdvancedSearchDefinition()
  const incomplete = run({
    traces: ACTIVE_STAGES.filter((stage) => stage !== 'answer').map((stage) => trace(stage)),
    final: null,
    evaluation: { correctiveRetries: 1 },
  })
  const audit = inspectAgentMarketRunTerminal(incomplete, definition)

  assert.equal(audit.complete, false)
  assert.deepEqual(audit.missingTerminalStages, ['answer'])
  assert.deepEqual(audit.retry, { declared: 1, observed: 0, consistent: false })
  assert.equal(audit.finalOutcome, 'missing')
})

test('the real grounded-refusal branch reaches a terminal Answer trace even when it takes less than one millisecond', async () => {
  const definition = freshAdvancedSearchDefinition()
  definition.stages.find((stage) => stage.type === 'retrieve').state = 'trashed'
  const result = await runAdvancedSearchDryRun({
    body: {
      dryRun: true,
      query: '北京 人工智能 数据安全',
      filters: { platform: null, datasetId: null, objectType: null, fromTime: null, toTime: null },
      definition,
    },
    search: null,
    agent: { available: false, embeddings: { available: false } },
  })
  const answer = result.traces.find((entry) => entry.type === 'answer')
  const audit = inspectAgentMarketRunTerminal(result, definition)

  assert.equal(answer.status, 'degraded')
  assert.equal(answer.validation.valid, true)
  assert.ok(answer.durationMs >= 0, 'Date.now() timing may truthfully report 0 ms')
  assert.deepEqual(answer.output, result.final)
  assert.equal(result.final.refused, true)
  assert.equal(audit.complete, true)
  assert.equal(audit.finalOutcome, 'refusal')
  assert.ok(audit.takenPath.some((entry) => entry.stage === 'answer'))
})
