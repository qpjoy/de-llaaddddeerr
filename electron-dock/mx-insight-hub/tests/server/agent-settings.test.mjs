import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { AgentRuntime } from '../../server/agent/runtime.mjs'
import {
  AgentSettingsStore,
  normalizeDatabaseProviders,
} from '../../server/agent/settings-store.mjs'

const quiet = { warn() {}, log() {}, error() {} }

function provider(overrides = {}) {
  return {
    id: 'primary',
    baseUrl: 'https://models.example.com/v1',
    model: 'chat-model',
    timeoutMs: 10_000,
    enabled: true,
    priority: 0,
    authMode: 'bearer',
    ...overrides,
  }
}

function row(kind, overrides = {}) {
  return {
    kind,
    source: 'environment',
    revision: 0,
    providers: [],
    locked_embedding_model: null,
    locked_embedding_dimensions: null,
    updated_by: null,
    updated_at: null,
    ...overrides,
  }
}

function databaseHarness() {
  const state = {
    settings: new Map([
      ['chat', row('chat')],
      ['embedding', row('embedding')],
    ]),
    credentials: new Map([
      ['chat', new Map()],
      ['embedding', new Map()],
    ]),
    queries: [],
  }

  const query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    state.queries.push({ text, params })
    if (text.startsWith('BEGIN') || ['COMMIT', 'ROLLBACK'].includes(text)) {
      return { rows: [], rowCount: 0 }
    }

    if (text.includes('FROM control.agent_provider_settings')) {
      const kind = params[0] || (text.includes("kind = 'embedding'") ? 'embedding' : null)
      const found = state.settings.get(kind)
      return { rows: found ? [structuredClone(found)] : [], rowCount: found ? 1 : 0 }
    }
    if (text.startsWith('SELECT provider_id, api_key')) {
      return {
        rows: [...state.credentials.get(params[0]).entries()].map(([provider_id, api_key]) => ({ provider_id, api_key })),
      }
    }
    if (text.startsWith('SELECT api_key')) {
      const apiKey = state.credentials.get(params[0]).get(params[1])
      return { rows: apiKey == null ? [] : [{ api_key: apiKey }], rowCount: apiKey == null ? 0 : 1 }
    }
    if (text.startsWith('SELECT provider_id')) {
      return { rows: [...state.credentials.get(params[0]).keys()].map((provider_id) => ({ provider_id })) }
    }
    if (text.startsWith('INSERT INTO control.agent_provider_settings') && (
      params.length === 1 || text.includes("VALUES ('embedding')")
    )) {
      const kind = params[0] || 'embedding'
      if (!state.settings.has(kind)) state.settings.set(kind, row(kind))
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('UPDATE control.agent_provider_settings')) {
      const current = state.settings.get('embedding')
      if (current.source !== 'environment' || current.locked_embedding_model != null) {
        return { rows: [], rowCount: 0 }
      }
      const next = row('embedding', {
        ...current,
        revision: current.revision + 1,
        locked_embedding_model: params[0],
        locked_embedding_dimensions: params[1],
        updated_by: 'environment-lock',
        updated_at: '2026-08-12T00:00:00.000Z',
      })
      state.settings.set('embedding', next)
      return { rows: [structuredClone(next)], rowCount: 1 }
    }
    if (text.startsWith('INSERT INTO control.agent_provider_settings')) {
      const [kind, source, serialized, lockedModel, lockedDimensions, updatedBy] = params
      const current = state.settings.get(kind) || row(kind)
      const next = row(kind, {
        source,
        revision: current.revision + 1,
        providers: JSON.parse(serialized),
        locked_embedding_model: lockedModel || current.locked_embedding_model,
        locked_embedding_dimensions: lockedDimensions || current.locked_embedding_dimensions,
        updated_by: updatedBy,
        updated_at: '2026-08-12T00:00:00.000Z',
      })
      state.settings.set(kind, next)
      return { rows: [structuredClone(next)], rowCount: 1 }
    }
    if (text.startsWith('DELETE FROM control.agent_provider_credentials')) {
      const credentials = state.credentials.get(params[0])
      if (text.includes('NOT (provider_id = ANY')) {
        const retained = new Set(params[1])
        for (const id of credentials.keys()) if (!retained.has(id)) credentials.delete(id)
      } else if (params.length > 1) credentials.delete(params[1])
      else credentials.clear()
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('INSERT INTO control.agent_provider_credentials')) {
      state.credentials.get(params[0]).set(params[1], params[2])
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL in test harness: ${text}`)
  }

  const client = { query, release() {} }
  return {
    state,
    pool: { query, async connect() { return client } },
  }
}

function config(overrides = {}) {
  return {
    agent: { chatProviders: null, embeddingProviders: null },
    embedding: { dimensions: null },
    ...overrides,
  }
}

test('migration 041 adds only isolated Agent control-plane state and no business writes', async () => {
  const sql = await readFile(new URL('../../migrations/041_agent_llm_control_plane.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.agent_llm_sequences/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.agent_consumer_bindings/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.agent_proxy_sequences/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_center\.agent_provider_probe_results/)
  assert.doesNotMatch(sql, /INSERT INTO control\.agent_provider_settings/i)
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:core|ingest)\./i)
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i)
})

test('database provider validation rejects credential exfiltration URLs and unknown fields', async () => {
  for (const baseUrl of [
    'http://models.example.com/v1',
    'https://user:pass@models.example.com/v1',
    'https://models.example.com/v1?target=x',
    'https://models.example.com/v1?',
    'https://models.example.com/v1#fragment',
    'https://models.example.com/v1#',
    'https://models.example.com/v1/chat/completions',
    'https://models.example.com/v1/messages',
    'https://localhost/v1',
    'https://localhost./v1',
    'https://api.localhost/v1',
    'https://api.localhost./v1',
    'https://127.0.0.1/v1',
    'https://[::1]/v1',
  ]) {
    assert.throws(
      () => normalizeDatabaseProviders([{ ...provider(), baseUrl, apiKey: 'secret' }], { kind: 'chat' }),
      /baseUrl/,
      baseUrl,
    )
  }
  assert.throws(
    () => normalizeDatabaseProviders([{ ...provider(), apiKeyEnv: 'ARBITRARY_ENV' }], { kind: 'chat' }),
    /unsupported field apiKeyEnv/,
  )
  assert.throws(
    () => normalizeDatabaseProviders([{ ...provider(), keyConfigured: true }], { kind: 'chat' }),
    /unsupported field keyConfigured/,
  )
  assert.throws(
    () => normalizeDatabaseProviders([{ ...provider(), apiKey: 'x'.repeat(8_193) }], { kind: 'chat' }),
    /at most 8192/,
  )
  const [anthropic] = normalizeDatabaseProviders([{
    ...provider(), protocol: 'anthropic-messages', proxySequenceKey: 'agent-egress',
  }], { kind: 'chat' })
  assert.equal(anthropic.provider.protocol, 'anthropic-messages')
  assert.equal(anthropic.provider.proxySequenceKey, 'agent-egress')
  assert.throws(
    () => normalizeDatabaseProviders([{
      ...provider(), protocol: 'anthropic-messages', dimensions: 4,
    }], { kind: 'embedding' }),
    /openai-compatible for embedding/,
  )
})

test('settings store persists plaintext separately while every public shape stays secret-free', async () => {
  const sentinel = 'sk-secret-must-never-echo'
  const harness = databaseHarness()
  const store = new AgentSettingsStore(harness.pool)
  const saved = await store.updateSetting('chat', {
    expectedRevision: 0,
    source: 'database',
    providers: [{ ...provider(), apiKey: sentinel }],
  })

  assert.equal(harness.state.credentials.get('chat').get('primary'), sentinel)
  assert.equal(saved.providers[0].keyConfigured, true)
  assert.doesNotMatch(JSON.stringify(saved), /sk-secret|apiKey|apiKeyEnv/)

  harness.state.queries.length = 0
  const publicResult = await store.loadPublicSetting('chat')
  assert.equal(publicResult.providers[0].keyConfigured, true)
  assert.doesNotMatch(JSON.stringify(publicResult), /sk-secret|apiKey|apiKeyEnv/)
  assert.equal(
    harness.state.queries.some(({ text }) => /\bapi_key\b/.test(text)),
    false,
    'ordinary settings queries never select api_key',
  )

  harness.state.queries.length = 0
  const runtimeResult = await store.loadRuntimeSetting('chat')
  assert.equal(runtimeResult.credentials.get('primary'), sentinel)
  assert.match(harness.state.queries[0].text, /REPEATABLE READ READ ONLY/)
  assert.equal(
    harness.state.queries.filter(({ text }) => /\bapi_key\b/.test(text)).length,
    1,
    'only the explicit runtime snapshot query selects api_key',
  )

  assert.equal(await store.revealCredentialInternal('chat', 'primary'), sentinel)

  const preserved = await store.updateSetting('chat', {
    expectedRevision: 1,
    source: 'database',
    providers: [provider()],
  })
  assert.equal(preserved.revision, 2)
  assert.equal(harness.state.credentials.get('chat').get('primary'), sentinel)

  await assert.rejects(
    () => store.updateSetting('chat', {
      expectedRevision: 2,
      source: 'database',
      providers: [provider({ baseUrl: 'https://other.example.com/v1' })],
    }),
    (error) => error?.code === 'credential_reconfirmation_required',
  )
  assert.equal(harness.state.credentials.get('chat').get('primary'), sentinel)

  const cleared = await store.updateSetting('chat', {
    expectedRevision: 2,
    source: 'database',
    providers: [provider({ baseUrl: 'https://other.example.com/v1', clearApiKey: true })],
  })
  assert.equal(cleared.providers[0].keyConfigured, false)
  assert.equal(harness.state.credentials.get('chat').has('primary'), false)
})

test('settings update is strict at the top level and environment rollback accepts no provider payload', async () => {
  const store = new AgentSettingsStore(databaseHarness().pool)
  await assert.rejects(
    () => store.updateSetting('chat', {
      expectedRevision: 0, source: 'environment', providers: [], surprise: true,
    }),
    /unsupported field surprise/,
  )
  await assert.rejects(
    () => store.updateSetting('chat', {
      expectedRevision: 0,
      source: 'environment',
      providers: [{ ...provider(), apiKeyEnv: 'SHOULD_NOT_BE_ACCEPTED' }],
    }),
    /providers must be omitted or empty/,
  )
})

test('settings store rejects stale revisions with the current revision for retry', async () => {
  const store = new AgentSettingsStore(databaseHarness().pool)
  await assert.rejects(
    () => store.updateSetting('chat', {
      expectedRevision: 7,
      source: 'environment',
    }),
    (error) => (
      error?.status === 409
      && error?.code === 'settings_revision_conflict'
      && error?.details?.currentRevision === 0
    ),
  )
})

test('settings store creates and locks a missing kind row before revision compare-and-swap', async () => {
  const harness = databaseHarness()
  harness.state.settings.delete('chat')
  const store = new AgentSettingsStore(harness.pool)
  const saved = await store.updateSetting('chat', {
    expectedRevision: 0,
    source: 'database',
    providers: [provider({ authMode: 'none' })],
  })
  assert.equal(saved.revision, 1)
  const insertIndex = harness.state.queries.findIndex(({ text, params }) => (
    text.startsWith('INSERT INTO control.agent_provider_settings') && params.length === 1
  ))
  const lockIndex = harness.state.queries.findIndex(({ text }) => text.includes('FOR UPDATE'))
  assert.ok(insertIndex >= 0 && insertIndex < lockIndex)
})

test('environment embedding lock is initialized once and rejects a concurrent different space', async () => {
  const harness = databaseHarness()
  const store = new AgentSettingsStore(harness.pool)
  const installed = await store.ensureEnvironmentEmbeddingLock({ model: 'embedding-a', dimensions: 4 })
  assert.equal(installed.revision, 1)
  assert.equal(installed.lockedEmbeddingModel, 'embedding-a')
  const repeated = await store.ensureEnvironmentEmbeddingLock({ model: 'embedding-a', dimensions: 4 })
  assert.equal(repeated.revision, 1, 'the same startup does not churn the revision')
  await assert.rejects(
    () => store.ensureEnvironmentEmbeddingLock({ model: 'embedding-b', dimensions: 4 }),
    (error) => error?.code === 'reindex_required',
  )
})

test('embedding vector-space lock survives a disabled pause and rejects deletion or model drift', async () => {
  const harness = databaseHarness()
  const store = new AgentSettingsStore(harness.pool)
  const disabled = provider({
    id: 'embed', model: 'embedding-a', dimensions: 4, enabled: false, apiKey: undefined,
  })
  const saved = await store.updateSetting('embedding', {
    expectedRevision: 0,
    source: 'database',
    providers: [disabled],
  }, {
    expectedEmbeddingDimensions: 4,
    embeddingBaseline: { model: 'embedding-a', dimensions: 4 },
  })
  assert.equal(saved.revision, 1)
  assert.equal(harness.state.settings.get('embedding').locked_embedding_model, 'embedding-a')

  await assert.rejects(
    () => store.updateSetting('embedding', {
      expectedRevision: 1, source: 'database', providers: [],
    }, { expectedEmbeddingDimensions: 4 }),
    (error) => error?.code === 'embedding_pause_requires_snapshot',
  )
  await assert.rejects(
    () => store.updateSetting('embedding', {
      expectedRevision: 1,
      source: 'database',
      providers: [{ ...disabled, model: 'embedding-b', enabled: true, apiKey: 'new-key' }],
    }, { expectedEmbeddingDimensions: 4 }),
    (error) => error?.code === 'reindex_required',
  )
  await assert.rejects(
    () => store.updateSetting('embedding', {
      expectedRevision: 1,
      source: 'environment',
      providers: [],
    }, {
      expectedEmbeddingDimensions: 4,
      environmentEmbeddingProviders: [{ model: 'embedding-b', dimensions: 4 }],
    }),
    (error) => error?.code === 'reindex_required',
  )
})

test('AgentRuntime loads DB settings, refreshes atomically, and keeps last-known-good on failure', async () => {
  const state = {
    row: row('chat', {
      source: 'database',
      revision: 1,
      providers: [provider()],
    }),
    fail: false,
  }
  const settingsStore = {
    async loadSetting(kind) {
      if (state.fail) throw new Error('database unavailable')
      return kind === 'chat' ? structuredClone(state.row) : row('embedding')
    },
    async loadCredentialsInternal(kind) {
      assert.equal(kind, 'chat')
      return new Map([['primary', 'runtime-secret']])
    },
  }
  const runtime = await new AgentRuntime({
    config: config(), settingsStore, logger: quiet, refreshIntervalMs: 0,
  }).start()
  assert.equal(runtime.status().chat[0].id, 'primary')
  assert.equal(runtime.status().settings.chat.source, 'database')
  assert.doesNotMatch(JSON.stringify(runtime.status()), /runtime-secret|apiKeyEnv|apiKey/)

  state.row.revision = 2
  state.row.providers = [provider({ id: 'replacement', model: 'replacement-model' })]
  await runtime.refresh()
  assert.equal(runtime.status().chat[0].id, 'replacement')

  state.fail = true
  assert.equal(await runtime.refresh({ force: true }), false)
  assert.equal(runtime.status().chat[0].id, 'replacement')
  runtime.close()
})

test('AgentRuntime routes the global Sequence and keeps legacy catalog fallback for a stale default', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('chat', row('chat', {
    source: 'database',
    revision: 7,
    providers: [
      provider({ id: 'catalog-first', baseUrl: 'https://catalog-first.invalid/v1', authMode: 'none' }),
      provider({ id: 'sequence-only', baseUrl: 'https://sequence-only.invalid/v1', authMode: 'none', priority: 1 }),
    ],
  }))
  const controlState = {
    providerRevision: 7,
    source: 'database',
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot(kind) {
      if (kind !== 'chat') return {
        sequences: [], defaultBinding: null, proxyEndpoints: [], proxySequences: [],
        globalProxySequenceKey: null, proxyRevision: 0,
      }
      return {
        sequences: [{
          sequenceKey: 'selected', displayName: 'Selected', kind: 'chat',
          providerIds: ['sequence-only'], enabled: true,
          providerRevision: controlState.providerRevision, revision: 1,
          source: controlState.source,
        }],
        defaultBinding: { consumerKey: 'hub.chat.default', kind: 'chat', sequenceKey: 'selected', revision: 1 },
        proxyEndpoints: [], proxySequences: [], globalProxySequenceKey: null, proxyRevision: 0,
      }
    },
  }
  const seen = []
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore: new AgentSettingsStore(harness.pool),
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    fetchImpl: async (url) => {
      seen.push(new URL(url).hostname)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  }).start()

  const selected = await runtime.complete([{ role: 'user', content: 'hello' }])
  assert.equal(selected.provider, 'sequence-only')
  assert.equal(selected.sequenceKey, 'selected')

  controlState.providerRevision = 6
  await runtime.refresh({ force: true })
  await assert.rejects(
    async () => runtime.complete([{ role: 'user', content: 'hello' }]),
    (error) => error?.code === 'agent_sequence_unavailable',
  )
  const profile = await runtime.suggestFileProfile({ columns: ['id', 'title'] })
  assert.equal(profile.origin, 'inferred', 'stale custom routing must preserve file preview fallback')
  assert.equal(
    await runtime.classifyRecord({ record: { id: '1' }, categories: ['news'] }),
    null,
    'stale custom routing must preserve the legacy classifier null fallback',
  )
  await assert.rejects(
    async () => runtime.complete([{ role: 'user', content: 'hello' }], { sequenceKey: 'selected' }),
    (error) => error?.code === 'agent_sequence_unavailable',
  )

  controlState.source = 'bootstrap'
  await runtime.refresh({ force: true })
  const fallback = await runtime.complete([{ role: 'user', content: 'hello' }])
  assert.equal(fallback.provider, 'catalog-first')
  assert.equal(fallback.sequenceKey, null)
  assert.deepEqual(seen, ['sequence-only.invalid', 'catalog-first.invalid'])
  runtime.close()
})

test('AgentRuntime imports a legacy environment provider and bootstraps its default Sequence once', async () => {
  const harness = databaseHarness()
  const bootstraps = []
  const controlStore = {
    async loadRuntimeSnapshot() {
      return {
        sequences: [], defaultBinding: null, proxyEndpoints: [], proxySequences: [],
        globalProxySequenceKey: null, proxyRevision: 0,
      }
    },
    async ensureBootstrapSequence(input) { bootstraps.push(input) },
  }
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: JSON.stringify([{
          id: 'legacy-chat', displayName: 'Legacy Chat',
          baseUrl: 'https://legacy-chat.invalid/v1', model: 'legacy-model', authMode: 'none',
        }]),
        embeddingProviders: null,
        autoMigrate: true,
      },
    }),
    settingsStore: new AgentSettingsStore(harness.pool),
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  assert.equal(harness.state.settings.get('chat').source, 'database')
  assert.equal(runtime.status().settings.chat.source, 'database')
  assert.equal(runtime.status().chat[0].id, 'legacy-chat')
  assert.deepEqual(bootstraps, [{ kind: 'chat', providerIds: ['legacy-chat'], providerRevision: 1 }])
  runtime.close()
})

test('AgentRuntime uses environment providers when the database setting selects environment', async () => {
  const settingsStore = {
    async loadSetting(kind) { return row(kind, { revision: 3 }) },
    async loadCredentialsInternal() { throw new Error('environment settings must not read credentials') },
  }
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: JSON.stringify([{
          id: 'env-chat', baseUrl: 'http://legacy-env.internal/v1', model: 'env-model',
        }]),
        embeddingProviders: null,
      },
    }),
    settingsStore,
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  assert.equal(runtime.status().settings.chat.source, 'environment')
  assert.equal(runtime.status().settings.chat.revision, 3)
  assert.equal(runtime.status().chat[0].id, 'env-chat')
  runtime.close()
})

test('AgentRuntime can probe a legacy uppercase environment provider id', async () => {
  const settingsStore = {
    async loadSetting(kind) { return row(kind, { revision: 3 }) },
    async loadCredentialsInternal() { throw new Error('environment settings must not read credentials') },
  }
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: JSON.stringify([{
          id: 'OpenAI',
          baseUrl: 'https://models.example.com/v1',
          model: 'env-model',
          authMode: 'none',
        }]),
        embeddingProviders: null,
      },
    }),
    settingsStore,
    logger: quiet,
    refreshIntervalMs: 0,
    probeCooldownMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  }).start()

  const result = await runtime.testProvider({ kind: 'chat', providerId: 'OpenAI' })
  assert.equal(result.ok, true)
  assert.equal(result.providerId, 'OpenAI')
  runtime.close()
})

test('AgentRuntime probes a disabled saved DB provider in an isolated router without enabling it', async () => {
  const sentinel = 'disabled-provider-secret-must-not-echo'
  const harness = databaseHarness()
  harness.state.settings.set('chat', row('chat', {
    source: 'database',
    revision: 4,
    providers: [provider({ enabled: false })],
  }))
  harness.state.credentials.get('chat').set('primary', sentinel)
  let request = null
  const runtime = await new AgentRuntime({
    config: config(),
    settingsStore: new AgentSettingsStore(harness.pool),
    logger: quiet,
    refreshIntervalMs: 0,
    probeCooldownMs: 0,
    fetchImpl: async (url, options) => {
      request = { url, authorization: options.headers.authorization, body: JSON.parse(options.body) }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }).start()

  assert.deepEqual(runtime.status().chat, [], 'disabled provider must stay out of the production chain')
  const result = await runtime.testProvider({ kind: 'chat', providerId: 'primary' })

  assert.equal(request.url, 'https://models.example.com/v1/chat/completions')
  assert.equal(request.authorization, `Bearer ${sentinel}`)
  assert.equal(request.body.model, 'chat-model')
  assert.equal(result.ok, true)
  assert.equal(result.providerId, 'primary')
  assert.doesNotMatch(JSON.stringify(result), /disabled-provider-secret-must-not-echo|authorization|payload/i)
  assert.deepEqual(runtime.status().chat, [], 'a successful probe must not mutate the production chain')
  runtime.close()
})

test('an exact DB Provider probe uses the same global Proxy Sequence as production calls', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('chat', row('chat', {
    source: 'database', revision: 2,
    providers: [provider({ authMode: 'none' })],
  }))
  const probes = []
  const controlStore = {
    async ensureBootstrapSequence() {},
    async recordProbe(input) { probes.push(input) },
    async loadRuntimeSnapshot(kind) {
      return {
        sequences: [], defaultBinding: null,
        proxyEndpoints: [{ proxyKey: 'host', proxyUrl: 'http://127.0.0.1:7890', enabled: true }],
        proxySequences: [{
          sequenceKey: 'global-egress', proxyKeys: ['host'],
          directFallback: false, enabled: true,
        }],
        globalProxySequenceKey: kind === 'chat' ? 'global-egress' : null,
        proxyRevision: 1,
      }
    },
  }
  let usedProxy = false
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore: new AgentSettingsStore(harness.pool),
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    probeCooldownMs: 0,
    fetchImpl: async (_url, options) => {
      usedProxy = Boolean(options.dispatcher)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  }).start()

  const result = await runtime.testProvider({ kind: 'chat', providerId: 'primary' })
  assert.equal(result.ok, true)
  assert.equal(usedProxy, true)
  assert.equal(probes.length, 1)
  assert.equal(probes[0].ok, true)
  assert.match(probes[0].proxyFingerprint, /^[0-9a-f]{64}$/)
  assert.equal(probes[0].settingsRevision, 2)
  runtime.close()
})

test('a long Provider probe records the exact settings snapshot it actually tested', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('chat', row('chat', {
    source: 'database', revision: 2,
    providers: [provider({ authMode: 'none' })],
  }))
  const evidence = []
  const emptyControl = {
    sequences: [], defaultBinding: null, proxyEndpoints: [], proxySequences: [],
    globalProxySequenceKey: null, proxyRevision: 0,
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() { return emptyControl },
    async recordProbe(input) { evidence.push(input) },
  }
  let announceStarted
  let releaseProbe
  const started = new Promise((resolve) => { announceStarted = resolve })
  const hold = new Promise((resolve) => { releaseProbe = resolve })
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore: new AgentSettingsStore(harness.pool),
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    probeCooldownMs: 0,
    fetchImpl: async () => {
      announceStarted()
      await hold
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  }).start()

  const probe = runtime.testProvider({ kind: 'chat', providerId: 'primary' })
  await started
  harness.state.settings.set('chat', row('chat', {
    source: 'database', revision: 3,
    providers: [provider({ authMode: 'none', model: 'new-model' })],
  }))
  await runtime.refresh({ force: true })
  releaseProbe()
  assert.equal((await probe).ok, true)
  assert.equal(runtime.status().settings.chat.revision, 3)
  assert.equal(evidence[0].settingsRevision, 2)
  assert.equal(evidence[0].model, 'chat-model')
  runtime.close()
})

test('AgentRuntime applies per-provider single-flight and cooldown protection to probes', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('chat', row('chat', {
    source: 'database', revision: 2, providers: [provider({ enabled: false, authMode: 'none' })],
  }))
  let now = 1_000
  let releaseFirst
  let announceFirst
  const firstStarted = new Promise((resolve) => { announceFirst = resolve })
  let calls = 0
  const runtime = await new AgentRuntime({
    config: config(),
    settingsStore: new AgentSettingsStore(harness.pool),
    logger: quiet,
    refreshIntervalMs: 0,
    probeCooldownMs: 5_000,
    nowFn: () => now,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        announceFirst()
        await new Promise((resolve) => { releaseFirst = resolve })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }).start()

  const first = runtime.testProvider({ kind: 'chat', providerId: 'primary' })
  await firstStarted
  await assert.rejects(
    () => runtime.testProvider({ kind: 'chat', providerId: 'primary' }),
    (error) => error?.status === 429 && error?.code === 'agent_provider_probe_in_progress',
  )
  releaseFirst()
  await first
  await assert.rejects(
    () => runtime.testProvider({ kind: 'chat', providerId: 'primary' }),
    (error) => error?.status === 429
      && error?.code === 'agent_provider_probe_rate_limited'
      && error?.details?.retryAfterMs === 5_000,
  )
  now += 5_000
  assert.equal((await runtime.testProvider({ kind: 'chat', providerId: 'primary' })).ok, true)
  assert.equal(calls, 2)
  runtime.close()
})

test('post-commit refresh failure disables the changed kind and reports deferred application', async () => {
  let failReads = false
  let chatState = row('chat', {
    source: 'database', revision: 1, providers: [provider()],
  })
  const settingsStore = {
    async loadSetting(kind) {
      if (failReads) throw new Error('database unavailable after commit')
      return kind === 'chat' ? structuredClone(chatState) : row('embedding')
    },
    async loadCredentialsInternal(kind) {
      if (kind !== 'chat') return new Map()
      return chatState.revision === 1
        ? new Map([['primary', 'old-secret']])
        : new Map([['replacement', 'new-secret']])
    },
    async updateSetting(kind) {
      assert.equal(kind, 'chat')
      chatState = row('chat', {
        source: 'database', revision: 2,
        providers: [provider({ id: 'replacement', model: 'replacement-model' })],
      })
      failReads = true
      return chatState
    },
  }
  const runtime = await new AgentRuntime({
    config: config(), settingsStore, logger: quiet, refreshIntervalMs: 0,
  }).start()
  assert.equal(runtime.status().chat[0].id, 'primary')

  const result = await runtime.updateSetting('chat', {
    expectedRevision: 1, source: 'database',
    providers: [provider({ id: 'replacement', model: 'replacement-model' })],
  })
  assert.equal(result.runtimeApplied, false)
  assert.deepEqual(runtime.status().chat, [])
  assert.equal(runtime.status().settings.chat.revision, 2)
  failReads = false
  assert.equal(await runtime.refresh(), true)
  assert.equal(runtime.status().chat[0].id, 'replacement')
  runtime.close()
})

test('post-commit refresh failure disables a modified active LLM Sequence', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('chat', row('chat', {
    source: 'database', revision: 1,
    providers: [provider({ authMode: 'none' })],
  }))
  let failControlReads = false
  const snapshot = {
    sequences: [{
      sequenceKey: 'active-sequence', displayName: 'Active', kind: 'chat',
      providerIds: ['primary'], enabled: true, source: 'database',
      providerRevision: 1, revision: 1,
    }],
    defaultBinding: {
      consumerKey: 'hub.chat.default', kind: 'chat',
      sequenceKey: 'active-sequence', revision: 1,
    },
    proxyEndpoints: [], proxySequences: [], globalProxySequenceKey: null, proxyRevision: 0,
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() {
      if (failControlReads) throw new Error('control snapshot unavailable after commit')
      return snapshot
    },
    async listPublicControl() {
      return { sequences: snapshot.sequences, bindings: [snapshot.defaultBinding], providerTests: [], proxy: {} }
    },
    async recordProbe() {},
    async saveSequence(_key, input) {
      failControlReads = true
      return { ...snapshot.sequences[0], ...input, revision: 2 }
    },
  }
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore: new AgentSettingsStore(harness.pool),
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    probeCooldownMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  }).start()

  const result = await runtime.saveSequence('active-sequence', {
    expectedRevision: 1,
    displayName: 'Active changed',
    kind: 'chat',
    providerIds: ['primary'],
    enabled: true,
  })
  assert.equal(result.runtimeApplied, false)
  assert.deepEqual(runtime.status().chat, [])
  runtime.close()
})

test('forced refresh after an in-flight poll reads again and applies the committed revision', async () => {
  let blockNextChatRead = false
  let releaseRead
  let announceRead
  let announceUpdate
  const readEntered = new Promise((resolve) => { announceRead = resolve })
  const updateCommitted = new Promise((resolve) => { announceUpdate = resolve })
  const state = {
    chat: row('chat', {
      source: 'database', revision: 1, providers: [provider()],
    }),
  }
  const settingsStore = {
    async loadSetting(kind) {
      if (kind !== 'chat') return row('embedding')
      const captured = structuredClone(state.chat)
      if (blockNextChatRead) {
        blockNextChatRead = false
        announceRead()
        await new Promise((resolve) => { releaseRead = resolve })
      }
      return captured
    },
    async loadCredentialsInternal(kind) {
      assert.equal(kind, 'chat')
      return new Map([
        ['primary', 'old-secret'],
        ['replacement', 'new-secret'],
      ])
    },
    async updateSetting() {
      state.chat = row('chat', {
        source: 'database',
        revision: 2,
        providers: [provider({ id: 'replacement', model: 'replacement-model' })],
      })
      announceUpdate()
      return state.chat
    },
  }
  const runtime = await new AgentRuntime({
    config: config(), settingsStore, logger: quiet, refreshIntervalMs: 0,
  }).start()

  blockNextChatRead = true
  const poll = runtime.refresh()
  await readEntered
  const update = runtime.updateSetting('chat', {
    expectedRevision: 1, source: 'database', providers: [],
  })
  await updateCommitted
  releaseRead()
  await Promise.all([poll, update])

  assert.equal(runtime.status().settings.chat.revision, 2)
  assert.equal(runtime.status().chat[0].id, 'replacement')
  runtime.close()
})

test('projector-style runtime does not query or construct the unmanaged chat chain', async () => {
  const loads = []
  const settingsStore = {
    async loadSetting(kind) {
      loads.push(`setting:${kind}`)
      return row(kind)
    },
    async loadCredentialsInternal(kind) {
      loads.push(`secret:${kind}`)
      return new Map()
    },
  }
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: JSON.stringify([{
          id: 'env-chat', baseUrl: 'https://env.example.com/v1', model: 'env-model', apiKeyEnv: 'ENV_CHAT_KEY',
        }]),
        embeddingProviders: null,
      },
    }),
    settingsStore,
    managedKinds: ['embedding'],
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()
  assert.deepEqual(loads, ['setting:embedding'])
  assert.deepEqual(runtime.status().chat, [])
  runtime.close()
})

test('environment embedding baseline blocks a disabled different DB model before persistence', async () => {
  const harness = databaseHarness()
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: null,
        embeddingProviders: JSON.stringify([{
          id: 'env-embed', baseUrl: 'https://env.example.com/v1', model: 'embedding-a',
          dimensions: 4, apiKeyEnv: 'ENV_EMBED_KEY',
        }]),
      },
      embedding: { dimensions: 4 },
    }),
    settingsStore: new AgentSettingsStore(harness.pool),
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  await assert.rejects(
    () => runtime.updateSetting('embedding', {
      expectedRevision: 1,
      source: 'database',
      providers: [{
        ...provider({ id: 'db-embed', model: 'embedding-b', dimensions: 4, enabled: false }),
      }],
    }),
    (error) => error?.code === 'reindex_required',
  )
  assert.equal(harness.state.settings.get('embedding').revision, 1)
  assert.equal(harness.state.settings.get('embedding').locked_embedding_model, 'embedding-a')
  runtime.close()
})

test('database-backed startup fails embedding closed when environment conflicts with the persisted lock', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('embedding', row('embedding', {
    source: 'environment',
    revision: 2,
    providers: [provider({
      id: 'locked', model: 'embedding-a', dimensions: 4, enabled: false, authMode: 'none',
    })],
    locked_embedding_model: 'embedding-a',
    locked_embedding_dimensions: 4,
  }))
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: null,
        embeddingProviders: JSON.stringify([{
          id: 'env-embed', baseUrl: 'https://env.example.com/v1', model: 'embedding-b',
          dimensions: 4,
        }]),
      },
      embedding: { dimensions: 4 },
    }),
    settingsStore: new AgentSettingsStore(harness.pool),
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  assert.equal(runtime.embeddings.available, false)
  assert.equal(harness.state.settings.get('embedding').revision, 2)
  runtime.close()
})

test('MX_INSIGHT_EMBEDDING_MODEL constrains the environment chain and fails mismatch closed', async () => {
  const harness = databaseHarness()
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: null,
        embeddingProviders: JSON.stringify([{
          id: 'env-embed', baseUrl: 'https://env.example.com/v1', model: 'embedding-b',
          dimensions: 4,
        }]),
      },
      embedding: { model: 'embedding-a', dimensions: 4 },
    }),
    settingsStore: new AgentSettingsStore(harness.pool),
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  assert.equal(runtime.embeddings.available, false)
  assert.equal(harness.state.settings.get('embedding').locked_embedding_model, null)
  runtime.close()
})

test('database runtime refuses provider metadata that conflicts with its persisted embedding lock', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('embedding', row('embedding', {
    source: 'database',
    revision: 3,
    providers: [provider({
      id: 'tampered', model: 'embedding-b', dimensions: 4, authMode: 'none',
    })],
    locked_embedding_model: 'embedding-a',
    locked_embedding_dimensions: 4,
  }))
  const runtime = await new AgentRuntime({
    config: config({ embedding: { dimensions: 4 } }),
    settingsStore: new AgentSettingsStore(harness.pool),
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  assert.equal(runtime.embeddings.available, false)
  runtime.close()
})

test('database runtime fails closed when embedding provider metadata has no persisted lock', async () => {
  for (const lock of [
    {},
    { locked_embedding_model: 'embedding-a' },
    { locked_embedding_dimensions: 4 },
  ]) {
    const harness = databaseHarness()
    harness.state.settings.set('embedding', row('embedding', {
      source: 'database',
      revision: 3,
      providers: [provider({
        id: 'unlocked', model: 'embedding-a', dimensions: 4, authMode: 'none',
      })],
      ...lock,
    }))
    const runtime = await new AgentRuntime({
      config: config({ embedding: { dimensions: 4 } }),
      settingsStore: new AgentSettingsStore(harness.pool),
      logger: quiet,
      refreshIntervalMs: 0,
    }).start()

    assert.equal(runtime.embeddings.available, false)
    runtime.close()
  }
})

test('database embedding snapshot remains authoritative over a stale environment model expectation', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('embedding', row('embedding', {
    source: 'database',
    revision: 3,
    providers: [provider({
      id: 'db-embed', model: 'embedding-b', dimensions: 4, authMode: 'none',
    })],
    locked_embedding_model: 'embedding-b',
    locked_embedding_dimensions: 4,
  }))
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: null,
        embeddingProviders: JSON.stringify([{
          id: 'old-env', baseUrl: 'https://env.example.com/v1', model: 'embedding-a',
          dimensions: 4,
        }]),
      },
      embedding: { model: 'embedding-a', dimensions: 4 },
    }),
    settingsStore: new AgentSettingsStore(harness.pool),
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  assert.equal(runtime.status().embeddings[0].model, 'embedding-b')
  runtime.close()
})

test('runtime rejects database-to-environment embedding switch across vector spaces', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('embedding', row('embedding', {
    source: 'database',
    revision: 1,
    providers: [provider({
      id: 'db-embed', model: 'embedding-a', dimensions: 4, authMode: 'none',
    })],
    locked_embedding_model: 'embedding-a',
    locked_embedding_dimensions: 4,
  }))
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: null,
        embeddingProviders: JSON.stringify([{
          id: 'env-embed', baseUrl: 'https://env.example.com/v1', model: 'embedding-b',
          dimensions: 4,
        }]),
      },
      embedding: { dimensions: 4 },
    }),
    settingsStore: new AgentSettingsStore(harness.pool),
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()
  assert.equal(runtime.status().embeddings[0].model, 'embedding-a')

  await assert.rejects(
    () => runtime.updateSetting('embedding', {
      expectedRevision: 1,
      source: 'environment',
      providers: [],
    }),
    (error) => error?.code === 'reindex_required',
  )
  assert.equal(harness.state.settings.get('embedding').source, 'database')
  assert.equal(runtime.status().embeddings[0].model, 'embedding-a')
  runtime.close()
})

test('admin provider PUT returns only the safe setting shape', async () => {
  const sentinel = 'request-only-secret'
  const agent = {
    available: true,
    status: () => ({ chat: [], embeddings: [], embeddingDimensions: null, settings: {} }),
    async updateSetting(kind, body) {
      assert.equal(kind, 'chat')
      if (body.source === 'environment') {
        return {
          kind: 'chat', source: 'environment', revision: 2, providers: [],
          runtimeApplied: false,
        }
      }
      assert.equal(body.providers[0].apiKey, sentinel)
      return {
        kind: 'chat', source: 'database', revision: 1,
        providers: [{ ...provider(), keyConfigured: true }],
      }
    },
    async testProvider(input) {
      assert.deepEqual(input, { kind: 'chat', providerId: 'primary' })
      return {
        ok: true,
        kind: 'chat',
        providerId: 'primary',
        model: 'model-a',
        latencyMs: 23,
        testedAt: '2026-08-24T10:00:00.000Z',
      }
    },
    async revealProviderCredential(kind, providerId) {
      assert.equal(kind, 'chat')
      assert.equal(providerId, 'primary')
      return { kind, providerId, apiKey: sentinel }
    },
  }
  const app = createApp({
    service: {},
    store: { async ping() { return true } },
    adapter: { async dependencies() { return { status: 'up' } } },
    agent,
    adminToken: 'admin-token-for-agent-settings',
    logger: quiet,
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/internal/v1/admin/agent/providers/chat`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-mx-insight-admin-token': 'admin-token-for-agent-settings',
        },
        body: JSON.stringify({
          expectedRevision: 0,
          source: 'database',
          providers: [{ ...provider(), apiKey: sentinel }],
        }),
      },
    )
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.data.providers[0].keyConfigured, true)
    assert.doesNotMatch(JSON.stringify(payload), /request-only-secret|apiKey|apiKeyEnv/)

    const probe = await fetch(
      `http://127.0.0.1:${server.address().port}/internal/v1/admin/agent/providers/chat/primary/test`,
      {
        method: 'POST',
        headers: { 'x-mx-insight-admin-token': 'admin-token-for-agent-settings' },
      },
    )
    assert.equal(probe.status, 200)
    const probePayload = await probe.json()
    assert.equal(probePayload.data.latencyMs, 23)
    assert.doesNotMatch(JSON.stringify(probePayload), /request-only-secret|apiKey|apiKeyEnv|payload/)

    const deniedReveal = await fetch(
      `http://127.0.0.1:${server.address().port}/internal/v1/admin/agent/providers/chat/primary/reveal`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mx-insight-admin-token': 'admin-token-for-agent-settings',
        },
        body: JSON.stringify({ adminToken: 'wrong-token' }),
      },
    )
    assert.equal(deniedReveal.status, 403)
    assert.doesNotMatch(await deniedReveal.text(), /request-only-secret/)

    const reveal = await fetch(
      `http://127.0.0.1:${server.address().port}/internal/v1/admin/agent/providers/chat/primary/reveal`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mx-insight-admin-token': 'admin-token-for-agent-settings',
        },
        body: JSON.stringify({ adminToken: 'admin-token-for-agent-settings' }),
      },
    )
    assert.equal(reveal.status, 200)
    assert.match(reveal.headers.get('cache-control') || '', /no-store/)
    assert.equal((await reveal.json()).data.apiKey, sentinel)

    const deferred = await fetch(
      `http://127.0.0.1:${server.address().port}/internal/v1/admin/agent/providers/chat`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-mx-insight-admin-token': 'admin-token-for-agent-settings',
        },
        body: JSON.stringify({ expectedRevision: 1, source: 'environment', providers: [] }),
      },
    )
    assert.equal(deferred.status, 202)
    assert.equal((await deferred.json()).data.runtimeApplied, false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
