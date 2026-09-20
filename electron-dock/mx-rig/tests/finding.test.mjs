import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor, toolByName, toolSchemas } from '../packages/runtime/tools.mjs'
import {
  CONFIDENCE_KEYS,
  VERDICT_KEYS,
  auditFinding,
  normalizeFinding
} from '../packages/runtime/finding.mjs'
import { validateArgs } from '../packages/contracts/index.mjs'

const FINDING = {
  verdict: 'environment-blocked',
  confidence: 'high',
  summary: '这次不是产品问题：所有执行机在窗口内都离线。',
  evidence: 'trun_9f2 的 runner 全部离线；tsk_login 上一次 passed。',
  nextStep: '让管理员上线一台执行机后复跑 tsk_login。'
}

async function fixture(t, replies = []) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-finding-'))
  const store = await new MissionStore(root).init()
  const policy = {
    revision: 'v1',
    maxTurns: 4,
    allowedTools: ['tests_result', 'finding_submit'],
    browserOrigins: []
  }
  const paths = []
  const client = {
    async request(path, body, signal) {
      signal?.throwIfAborted()
      paths.push(path)
      if (path === '/api/rig/v1/execution-config') return { policy: structuredClone(policy) }
      if (path === '/api/rig/v1/model/turn')
        return { message: replies.shift() || { content: '完成' } }
      // A real run read earlier in the mission, so a citation can be checked.
      return { run: { id: 'trun_9f2', status: 'blocked' } }
    }
  }
  const engine = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client),
    owner: 'alice'
  })
  t.after(() => engine.close())
  return { store, engine, paths, policy }
}

const toolCall = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
  ]
})

test('the schema is a closed set at the door, not just in the description', () => {
  const definition = toolByName('finding_submit')
  assert.equal(definition.effect, 'read')
  assert.deepEqual(definition.parameters.properties.verdict.enum, VERDICT_KEYS)
  assert.deepEqual(definition.parameters.properties.confidence.enum, CONFIDENCE_KEYS)
  assert.deepEqual(validateArgs(definition.parameters, FINDING), FINDING)
  assert.throws(
    () => validateArgs(definition.parameters, { ...FINDING, verdict: 'looks-fine-to-me' }),
    { code: 'invalid_arguments' }
  )
  assert.throws(() => validateArgs(definition.parameters, { ...FINDING, confidence: '很高' }), {
    code: 'invalid_arguments'
  })
  // nextStep is optional; the rest is not.
  const { nextStep, ...required } = FINDING
  assert.equal(validateArgs(definition.parameters, required).nextStep, undefined)
  assert.throws(
    () => validateArgs(definition.parameters, { verdict: 'flaky', confidence: 'low' }),
    /缺少参数/
  )
  // The schema handed to the model carries our own description, not a caller's.
  const [schema] = toolSchemas(['finding_submit'])
  assert.match(schema.function.description, /不改变任何测试结论/)
})

test('a citation counts as read only if this mission actually read it', () => {
  const finding = normalizeFinding(FINDING)
  assert.equal(finding.verdict, 'environment-blocked')
  assert.ok(finding.at)
  // Authored orchestrations keep tool output in `evidence`…
  const fromEvidence = auditFinding(finding, {
    evidence: [{ tool: 'tests_result', summary: '{"run":{"id":"trun_9f2","status":"blocked"}}' }]
  })
  assert.equal(fromEvidence.checkable, true)
  assert.deepEqual(
    fromEvidence.references.map((entry) => `${entry.id}:${entry.seen}`),
    ['trun_9f2:true', 'tsk_login:false']
  )
  assert.equal(fromEvidence.unverified, 1)
  // …Agent missions keep it in the model transcript. Both are "what it read".
  const fromMessages = auditFinding(finding, {
    messages: [
      { role: 'assistant', content: '让我看看 tsk_login' },
      toolCall('tests_list', {}),
      { role: 'tool', tool_call_id: 'call_tests_list', content: '{"tasks":[{"id":"tsk_login"}]}' }
    ]
  })
  assert.deepEqual(
    fromMessages.references.filter((entry) => entry.seen).map((entry) => entry.id),
    ['tsk_login']
  )
  // An assistant message is the model quoting itself; that is not evidence.
  assert.equal(fromMessages.references.find((entry) => entry.id === 'trun_9f2').seen, false)
  // No checkable ids at all is reported as such, not as a clean bill.
  const prose = auditFinding(normalizeFinding({ ...FINDING, evidence: '所有执行机都离线了。' }), {})
  assert.equal(prose.checkable, false)
  assert.deepEqual(prose.references, [])
  assert.throws(() => normalizeFinding({ ...FINDING, verdict: 'fine' }), {
    code: 'invalid_finding'
  })
})

test('claims, page text, unassociated results and ID prefixes cannot verify a citation', () => {
  const finding = normalizeFinding(FINDING)
  const audited = auditFinding(finding, {
    evidence: [
      { tool: 'finding_submit', summary: JSON.stringify(finding) },
      { tool: 'browser_snapshot', summary: finding.evidence },
      { tool: 'tests_result', summary: 'trun_9f2_extra' }
    ],
    messages: [
      toolCall('finding_submit', FINDING),
      { role: 'tool', tool_call_id: 'call_finding_submit', content: JSON.stringify(finding) },
      { role: 'tool', content: finding.evidence }
    ]
  })
  assert.equal(audited.unverified, 2)
})

test('a repeated finding cannot turn its own earlier claim into evidence', async (t) => {
  const f = await fixture(t, [
    toolCall('finding_submit', FINDING),
    toolCall('finding_submit', FINDING)
  ])
  const row = await f.engine.start({ mode: 'agent', goal: '检查证据' })
  await f.engine.job
  const done = f.store.get(row.id, 'alice')
  assert.equal(done.status, 'completed')
  assert.equal(done.finding.unverified, 2)
})

test('submitting a conclusion calls nothing and needs no approval', async (t) => {
  const f = await fixture(t, [
    toolCall('tests_result', { runId: 'trun_9f2' }),
    toolCall('finding_submit', FINDING),
    { content: '简单说：环境问题，不是产品缺陷。' }
  ])
  const row = await f.engine.start({ mode: 'agent', goal: '这次失败是什么原因' })
  await f.engine.job
  const done = f.store.get(row.id, 'alice')
  // Read effect: the mission never stopped for a confirmation.
  assert.equal(done.status, 'completed')
  assert.equal(done.pending, null)
  assert.equal(done.finding.verdict, 'environment-blocked')
  assert.equal(done.finding.confidence, 'high')
  assert.equal(done.finding.unverified, 1)
  assert.deepEqual(
    done.finding.references.map((entry) => `${entry.id}:${entry.seen}`),
    ['trun_9f2:true', 'tsk_login:false']
  )
  const event = done.events.find((entry) => entry.kind === 'finding')
  assert.match(event.message, /环境受阻/)
  assert.equal(event.data.finding.summary, FINDING.summary)
  // It reached no HTTP route of its own: only the config and the real tool did.
  assert.deepEqual(
    [...new Set(f.paths.filter((path) => !path.includes('execution-config')))],
    ['/api/rig/v1/model/turn', '/api/v1/runs/trun_9f2']
  )
  // The public row carries the finding; the transcript still does not.
  const published = f.store.list('alice')[0]
  assert.equal(published.finding.verdict, 'environment-blocked')
  assert.equal(published.messages, undefined)
})

test('an invalid verdict is refused before it can look like a conclusion', async (t) => {
  const f = await fixture(t, [toolCall('finding_submit', { ...FINDING, verdict: '还行' })])
  const row = await f.engine.start({ mode: 'agent', goal: '定级' })
  await f.engine.job
  const done = f.store.get(row.id, 'alice')
  assert.equal(done.status, 'blocked')
  assert.equal(done.finding, undefined)
  assert.ok(done.events.some((entry) => entry.kind === 'error'))
})

test('a conclusion is refused outright when Internal has not allowed the tool', async (t) => {
  const f = await fixture(t, [toolCall('finding_submit', FINDING)])
  f.policy.allowedTools = ['tests_result']
  const row = await f.engine.start({ mode: 'agent', goal: '定级' })
  await f.engine.job
  const done = f.store.get(row.id, 'alice')
  assert.equal(done.status, 'blocked')
  assert.equal(done.finding, undefined)
  // Same rule as every other tool: the allow-list decides, not the Agent.
  assert.ok(done.events.some((entry) => /工具未被 Internal 策略允许/.test(entry.message)))
})
