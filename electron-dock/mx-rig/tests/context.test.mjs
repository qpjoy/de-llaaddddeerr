import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactMessages, estimateTokens, meter } from '../packages/runtime/context.mjs'
import { auditFinding } from '../packages/runtime/finding.mjs'
import { modelTurnBody } from '../apps/server/schemas.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'

test('usage is metered as reported, and estimated — and labelled — when it is not', () => {
  assert.ok(estimateTokens('测试平台') === 4)
  assert.ok(estimateTokens('abcdefgh') === 2)
  assert.ok(
    estimateTokens(`data:image/jpeg;base64,${'A'.repeat(10_000)}`) < 10,
    'images are not text'
  )
  const row = {}
  meter(row, {
    body: { messages: [{ role: 'user', content: 'hi' }] },
    result: {
      message: { content: 'ok' },
      provider: { id: 'primary' },
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
    }
  })
  assert.deepEqual(
    [row.usage.promptTokens, row.usage.completionTokens, row.usage.estimated],
    [120, 30, false]
  )
  meter(row, {
    body: { messages: [{ role: 'user', content: '再来一次' }] },
    result: { message: { content: '好的' }, provider: { id: 'backup' } }
  })
  assert.equal(row.usage.calls, 2)
  assert.equal(row.usage.estimated, true)
  assert.ok(row.usage.byProvider.backup > 0)
})

test('a long conversation is shortened from the oldest tool results, keeping IDs and shape', () => {
  const messages = [{ role: 'user', content: '看看最近的执行' }]
  for (let i = 0; i < 12; i += 1)
    messages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: `c${i}`, type: 'function', function: { name: 'tests_result', arguments: '{}' } }
        ]
      },
      {
        role: 'tool',
        tool_call_id: `c${i}`,
        content: `{"run":{"id":"trun_${i}abc"}} ${'x'.repeat(8_000)}`
      }
    )
  const shortened = compactMessages(messages)
  assert.ok(shortened > 0)
  assert.ok(JSON.stringify(messages).length <= 60_000)
  const tools = messages.filter((message) => message.role === 'tool')
  assert.match(tools[0].content, /已压缩的较早工具结果.*trun_0abc/)
  assert.ok(tools.at(-1).content.length > 8_000, 'the latest results are kept whole')
  assert.equal(
    modelTurnBody.safeParse({ messages, tools: [] }).success,
    true,
    'still a valid transcript'
  )
  // A conclusion citing an early run is still checked against what was read.
  const audited = auditFinding({ evidence: '见 trun_0abc' }, { messages })
  assert.equal(audited.references[0].seen, true)
  assert.equal(compactMessages(messages), 0, 'nothing more to do once under budget')
})

test('a token cap stops the mission before the next call, with the reason', async (t) => {
  const store = await new MissionStore(await mkdtemp(join(tmpdir(), 'mx-rig-budget-'))).init()
  let calls = 0
  const client = {
    async request(path) {
      if (path === '/api/rig/v1/execution-config')
        return {
          policy: {
            revision: 'v1',
            maxTurns: 10,
            allowedTools: ['tests_runs'],
            browserOrigins: [],
            tokenBudget: 500
          },
          model: { configured: true },
          agents: []
        }
      if (path === '/api/rig/v1/model/turn') {
        calls += 1
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `c${calls}`,
                type: 'function',
                function: { name: 'tests_runs', arguments: '{}' }
              }
            ]
          },
          provider: { id: 'primary' },
          usage: { promptTokens: 400, completionTokens: 200, totalTokens: 600 }
        }
      }
      return { runs: [] }
    }
  }
  const engine = new RigRuntime({ store, client, executor: new ToolExecutor(client), owner: 'a' })
  t.after(() => engine.close())
  const row = await engine.start({ mode: 'agent', goal: '一直查' })
  await engine.job
  const done = store.get(row.id, 'a')
  assert.equal(done.status, 'blocked')
  assert.equal(calls, 1, 'the cap is checked before spending more')
  assert.match(done.events.at(-1).message, /用量上限（500 tokens）/)
  assert.equal(store.public(done).usage.promptTokens, 400)
})
