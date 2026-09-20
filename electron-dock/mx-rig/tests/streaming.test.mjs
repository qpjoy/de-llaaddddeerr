import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { Settings } from '../apps/server/settings.mjs'
import { ModelGateway } from '../apps/server/model.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { RigClient } from '../packages/runtime/client.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'

const file = async () => join(await mkdtemp(join(tmpdir(), 'mx-rig-stream-')), 'settings.json')
const provider = (extra = {}) => ({
  id: 'primary',
  displayName: '主模型',
  baseUrl: 'https://models.example/v1',
  model: 'streamer',
  apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
  timeoutMs: 60_000,
  enabled: true,
  ...extra
})

/** An SSE body in the shape OpenAI-compatible gateways actually send. */
const sse = (frames) =>
  new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    }
  )
const say = (content) => ({ choices: [{ delta: { content } }] })

test('SSE cannot turn an EOF, malformed frame or token limit into a completed answer', async () => {
  const partialTool = {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              function: { name: 'tests_result', arguments: '{"runId":"trun_123"}' }
            }
          ]
        }
      }
    ]
  }
  for (const body of [
    `data: ${JSON.stringify(say('partial'))}\n\n`,
    `data: ${JSON.stringify(partialTool)}\n\n`,
    'data: {broken}\n\ndata: [DONE]\n\n',
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`,
    'data: {"error":{"message":"do not expose provider details"}}\n\ndata: [DONE]\n\n'
  ]) {
    const gateway = new ModelGateway(await settingsWith([provider()]), {
      environment: { MX_RIG_MODEL_API_KEY: 'fixture' },
      fetchImpl: async () =>
        new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    await assert.rejects(
      () =>
        gateway.turn(
          'alice',
          {
            messages: [{ role: 'user', content: 'go' }],
            tools: [{ type: 'function', function: { name: 'tests_result' } }]
          },
          undefined,
          () => {}
        ),
      (error) => ['model_incomplete', 'model_response'].includes(error.code)
    )
  }
})

async function settingsWith(providers) {
  const settings = await new Settings(await file()).init()
  await settings.update({
    ...settings.value,
    providers,
    sequence: providers.map((entry) => entry.id)
  })
  return settings
}

test('a streamed turn reports text as it arrives and assembles the same message', async () => {
  const settings = await settingsWith([provider()])
  let sent
  const gateway = new ModelGateway(settings, {
    environment: { MX_RIG_MODEL_API_KEY: 'k' },
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body)
      return sse([say('先读'), say('证据，'), say('再下结论。')])
    }
  })
  const seen = []
  const result = await gateway.turn(
    'alice',
    { messages: [{ role: 'user', content: 'go' }], tools: [] },
    undefined,
    (delta) => seen.push(delta)
  )
  assert.equal(sent.stream, true)
  assert.deepEqual(seen, ['先读', '证据，', '再下结论。'])
  assert.equal(result.message.content, '先读证据，再下结论。')
  assert.equal(result.streamed, true)
})

test('a streamed tool call is stitched back together and still validated', async () => {
  const settings = await settingsWith([provider()])
  const gateway = new ModelGateway(settings, {
    environment: { MX_RIG_MODEL_API_KEY: 'k' },
    fetchImpl: async () =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'tests_result' } }]
              }
            }
          ]
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"runId":' } }] } }]
        },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"trun_9"}' } }] } }]
        }
      ])
  })
  const input = {
    messages: [{ role: 'user', content: 'read it' }],
    tools: [{ type: 'function', function: { name: 'tests_result' } }]
  }
  const { message } = await gateway.turn('alice', input, undefined, () => {})
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].function.name, 'tests_result')
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { runId: 'trun_9' })

  // A name outside our registry must be refused on the streamed path too.
  const rogue = new ModelGateway(await settingsWith([provider()]), {
    environment: { MX_RIG_MODEL_API_KEY: 'k' },
    fetchImpl: async () =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'x', function: { name: 'rm_rf', arguments: '{}' } }]
              }
            }
          ]
        }
      ])
  })
  await assert.rejects(() => rogue.turn('bob', input, undefined, () => {}), {
    code: 'model_response'
  })
})

test('a gateway that ignores stream, and a provider told not to stream', async () => {
  // Answered with an ordinary JSON body: read as one, and not reported as streamed.
  const ignoring = new ModelGateway(await settingsWith([provider()]), {
    environment: { MX_RIG_MODEL_API_KEY: 'k' },
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '一次给完' } }] }))
  })
  const deltas = []
  const result = await ignoring.turn(
    'alice',
    { messages: [{ role: 'user', content: 'go' }], tools: [] },
    undefined,
    (delta) => deltas.push(delta)
  )
  assert.equal(result.message.content, '一次给完')
  assert.equal(result.streamed, false)
  assert.deepEqual(deltas, [])

  // Switched off per provider: the request itself must not ask for a stream.
  let sent
  const off = new ModelGateway(await settingsWith([provider({ stream: false })]), {
    environment: { MX_RIG_MODEL_API_KEY: 'k' },
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: '直接给' } }] }))
    }
  })
  assert.equal(
    (
      await off.turn(
        'alice',
        { messages: [{ role: 'user', content: 'x' }], tools: [] },
        undefined,
        () => {}
      )
    ).message.content,
    '直接给'
  )
  assert.equal(sent.stream, undefined)
})

test('a break after the first token is not retried on the next provider', async () => {
  const settings = await settingsWith([
    provider({ id: 'first' }),
    provider({ id: 'second', model: 'backup' })
  ])
  const asked = []
  const gateway = new ModelGateway(settings, {
    environment: { MX_RIG_MODEL_API_KEY: 'k' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      asked.push(body.model)
      if (body.model === 'streamer')
        return new Response(
          // The frame is delivered first and the failure arrives after it:
          // erroring inside start() discards the queue, which is a different
          // story (a break *before* the first token, covered below).
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(say('半句'))}\n\n`)
              )
            },
            pull(controller) {
              controller.error(new Error('upstream died'))
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      return sse([say('备用模型的完整回答')])
    }
  })
  const deltas = []
  await assert.rejects(() =>
    gateway.turn(
      'alice',
      { messages: [{ role: 'user', content: 'go' }], tools: [] },
      undefined,
      (d) => deltas.push(d)
    )
  )
  assert.deepEqual(deltas, ['半句'])
  // Only the first provider was tried: stitching a second answer onto half of
  // a first one is worse than saying the first broke.
  assert.deepEqual(asked, ['streamer'])

  // A failure *before* any token still falls through the chain as before.
  const early = new ModelGateway(settings, {
    environment: { MX_RIG_MODEL_API_KEY: 'k' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      if (body.model === 'streamer') return new Response('nope', { status: 500 })
      return sse([say('备用回答')])
    }
  })
  const fallback = await early.turn(
    'alice',
    { messages: [{ role: 'user', content: 'go' }], tools: [] },
    undefined,
    () => {}
  )
  assert.equal(fallback.message.content, '备用回答')
  assert.equal(fallback.provider.id, 'second')
})

test('the client reads NDJSON across chunk boundaries and reports a mid-stream break', async () => {
  const lines = (chunks) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        }
      })
    )
  const client = new RigClient({
    url: 'http://127.0.0.1:8791',
    token: 't',
    // Split mid-line and mid-multibyte-character on purpose.
    fetchImpl: async () =>
      lines([
        '{"delta":"读证',
        '据"}\n{"delta":"，再下结论"}\n{"message":{"content":"读证据，再下结论"}}\n'
      ])
  })
  const seen = []
  const result = await client.stream('/api/rig/v1/model/turn:stream', {}, undefined, (delta) =>
    seen.push(delta)
  )
  assert.deepEqual(seen, ['读证据', '，再下结论'])
  assert.equal(result.message.content, '读证据，再下结论')

  const broken = new RigClient({
    url: 'http://127.0.0.1:8791',
    token: 't',
    fetchImpl: async () =>
      lines(['{"delta":"一半"}\n{"error":{"code":"model_error","message":"上游断了"}}\n'])
  })
  await assert.rejects(
    () => broken.stream('/api/rig/v1/model/turn:stream', {}, undefined, () => {}),
    {
      code: 'model_error'
    }
  )
  const truncated = new RigClient({
    url: 'http://127.0.0.1:8791',
    token: 't',
    fetchImpl: async () => lines(['{"delta":"只有增量"}\n'])
  })
  await assert.rejects(
    () => truncated.stream('/api/rig/v1/model/turn:stream', {}, undefined, () => {}),
    { code: 'invalid_response' }
  )
})

test('the Runtime keeps a draft on the mission and clears it when the turn ends', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-stream-run-'))
  const store = await new MissionStore(root).init()
  const policy = { revision: 'v1', maxTurns: 3, allowedTools: ['tests_result'], browserOrigins: [] }
  const drafts = []
  const paths = []
  const client = {
    async request(path) {
      paths.push(path)
      if (path === '/api/rig/v1/execution-config') return { policy: structuredClone(policy) }
      return { message: { content: '非流式兜底' } }
    },
    async stream(path, _body, _signal, onDelta) {
      paths.push(path)
      for (const piece of ['正在', '读证据']) {
        onDelta(piece)
        // Whatever the workbench would see at this instant.
        drafts.push(store.list('alice')[0]?.stream?.text ?? null)
      }
      return { message: { content: '正在读证据，结论如下。' } }
    }
  }
  const engine = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client),
    owner: 'alice'
  })
  t.after(() => engine.close())
  const row = await engine.start({ mode: 'agent', goal: '分析一次执行' })
  await engine.job
  const done = store.get(row.id, 'alice')
  assert.deepEqual(drafts, ['正在', '正在读证据'])
  assert.equal(done.status, 'completed')
  assert.equal(done.result, '正在读证据，结论如下。')
  // The answer replaces the draft; half a sentence must not survive as one.
  assert.equal(done.stream, null)
  assert.ok(paths.includes('/api/rig/v1/model/turn:stream'))
})

test('a service without the streaming route is used once, then remembered', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-stream-old-'))
  const store = await new MissionStore(root).init()
  const policy = { revision: 'v1', maxTurns: 3, allowedTools: [], browserOrigins: [] }
  let attempts = 0
  const client = {
    async request(path) {
      if (path === '/api/rig/v1/execution-config') return { policy: structuredClone(policy) }
      return { message: { content: '老服务的回答' } }
    },
    async stream() {
      attempts += 1
      const error = new Error('not found')
      error.status = 404
      throw error
    }
  }
  const engine = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client),
    owner: 'alice'
  })
  t.after(() => engine.close())
  const first = await engine.start({ mode: 'agent', goal: '一' })
  await engine.job
  assert.equal(store.get(first.id, 'alice').result, '老服务的回答')
  await engine.followup(first.id, { goal: '二' })
  await engine.job
  assert.equal(attempts, 1, '404 只该试一次，之后记住这个服务不支持流式')
})

test('the streaming route answers NDJSON, and refuses before the first byte with a status', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-stream-api-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: state,
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts'),
      MX_RIG_MODEL_API_KEY: 'k'
    },
    {
      schedule: false,
      modelOptions: {
        environment: { MX_RIG_MODEL_API_KEY: 'k' },
        fetchImpl: async () => sse([say('第一段'), say('第二段')])
      }
    }
  )
  t.after(() => runtime.close())
  const post = (path, body, headers = { authorization: 'Bearer test-only-rig-secret' }) =>
    fetch(runtime.origin + path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  const turn = { messages: [{ role: 'user', content: 'go' }], tools: [] }

  // No provider yet: this fails before a single byte is streamed, so it must
  // come back as a normal status with a JSON error, not a 200 with an apology.
  const unconfigured = await post('/api/rig/v1/model/turn:stream', turn)
  assert.equal(unconfigured.status, 409)
  assert.equal((await unconfigured.json()).error.code, 'model_unconfigured')

  await runtime.settings.update({ ...runtime.settings.value, providers: [provider()] })
  const response = await post('/api/rig/v1/model/turn:stream', turn)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/)
  const events = (await response.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    events.filter((event) => event.delta).map((event) => event.delta),
    ['第一段', '第二段']
  )
  assert.equal(events.at(-1).message.content, '第一段第二段')
  assert.equal(events.at(-1).provider.id, 'primary')

  const original = runtime.kernel.identity.resolve
  runtime.kernel.identity.resolve = async (token, source) =>
    token === 'viewer-token' ? { id: 'viewer', role: 'viewer' } : original(token, source)
  assert.equal(
    (await post('/api/rig/v1/model/turn:stream', turn, { authorization: 'Bearer viewer-token' }))
      .status,
    403
  )
})
