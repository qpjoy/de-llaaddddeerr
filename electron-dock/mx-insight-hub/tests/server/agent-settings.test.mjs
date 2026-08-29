import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  AgentControlStore,
  providerProxyRouteFingerprint,
} from '../../server/agent/control-store.mjs'
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
    proxySequences: new Map(),
    proxyEndpoints: new Map(),
    llmSequences: new Map(),
    proxyMigrationMissing: false,
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
    if (text.includes('FROM control.agent_proxy_sequences')) {
      if (state.proxyMigrationMissing) {
        const error = new Error('relation does not exist')
        error.code = '42P01'
        throw error
      }
      const requested = new Set(params[0] || [])
      return {
        rows: [...state.proxySequences.values()]
          .filter((sequence) => requested.has(sequence.sequence_key))
          .map((sequence) => structuredClone(sequence)),
      }
    }
    if (text.includes('FROM control.agent_proxy_endpoints')) {
      if (state.proxyMigrationMissing) {
        const error = new Error('relation does not exist')
        error.code = '42P01'
        throw error
      }
      const requested = new Set(params[0] || [])
      return {
        rows: [...state.proxyEndpoints.values()]
          .filter((endpoint) => requested.has(endpoint.proxy_key))
          .filter((endpoint) => !text.includes('enabled = true') || endpoint.enabled)
          .map((endpoint) => structuredClone(endpoint)),
      }
    }
    if (text.includes('FROM control.agent_llm_sequences')) {
      const kind = params[0]
      const removed = new Set(params[1] || [])
      return {
        rows: [...state.llmSequences.values()]
          .filter((sequence) => sequence.kind === kind)
          .filter((sequence) => sequence.provider_ids.some((providerId) => removed.has(providerId)))
          .sort((left, right) => left.sequence_key.localeCompare(right.sequence_key))
          .map((sequence) => structuredClone(sequence)),
      }
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

function proxyControlHarness({
  endpointReferences = [],
  globalSequenceKey = null,
  providerSettings = [],
} = {}) {
  const state = {
    endpoint: {
      proxy_key: 'host-7890', display_name: 'Host 7890',
      proxy_url: 'http://127.0.0.1:7890', enabled: true, revision: 2,
      updated_by: 'admin-token', updated_at: '2026-08-28T00:00:00.000Z',
    },
    sequence: {
      sequence_key: 'agent-egress', display_name: 'Agent egress',
      proxy_keys: ['host-7890'], direct_fallback: false, enabled: true, revision: 3,
      updated_by: 'admin-token', updated_at: '2026-08-28T00:00:00.000Z',
    },
    endpointReferences,
    globalSequenceKey,
    providerSettings,
    deletedEndpoint: false,
    deletedSequence: false,
    queries: [],
  }
  const query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    state.queries.push({ text, params })
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
      || text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
    if (text.includes('FROM control.agent_proxy_endpoints') && text.includes('FOR UPDATE')) {
      return { rows: state.endpoint && !state.deletedEndpoint ? [structuredClone(state.endpoint)] : [] }
    }
    if (text.includes('FROM control.agent_proxy_endpoints') && text.includes('FOR SHARE')) {
      return { rows: state.endpoint && !state.deletedEndpoint ? [structuredClone(state.endpoint)] : [] }
    }
    if (text.includes('FROM control.agent_proxy_sequences') && text.includes('$1 = ANY(proxy_keys)')) {
      return { rows: state.endpointReferences.map((sequence_key) => ({ sequence_key })) }
    }
    if (text.startsWith('DELETE FROM control.agent_proxy_endpoints')) {
      state.deletedEndpoint = true
      return { rows: [structuredClone(state.endpoint)] }
    }
    if (text.includes('FROM control.agent_proxy_settings') && text.includes('FOR SHARE')) {
      return { rows: [{ global_sequence_key: state.globalSequenceKey }] }
    }
    if (text.includes('FROM control.agent_proxy_sequences') && text.includes('FOR UPDATE')) {
      return { rows: state.sequence && !state.deletedSequence ? [structuredClone(state.sequence)] : [] }
    }
    if (text.includes('FROM control.agent_provider_settings') && text.includes('FOR SHARE')) {
      return { rows: structuredClone(state.providerSettings) }
    }
    if (text.startsWith('INSERT INTO control.agent_proxy_sequences')) {
      state.sequence = {
        ...state.sequence,
        sequence_key: params[0],
        display_name: params[1],
        proxy_keys: params[2],
        direct_fallback: params[3],
        enabled: params[4],
        revision: Number(state.sequence?.revision || 0) + 1,
        updated_by: params[5],
      }
      return { rows: [structuredClone(state.sequence)] }
    }
    if (text.startsWith('DELETE FROM control.agent_proxy_sequences')) {
      state.deletedSequence = true
      return { rows: [structuredClone(state.sequence)] }
    }
    throw new Error(`Unhandled proxy control SQL in test harness: ${text}`)
  }
  const client = { query, release() {} }
  return { state, store: new AgentControlStore({ async connect() { return client } }) }
}

function sequenceVerificationHarness() {
  const state = {
    providerSetting: {
      revision: 2,
      providers: [provider({ authMode: 'none', proxySequenceKey: null })],
    },
    globalSequenceKey: null,
    proxySequences: new Map([['agent-egress', {
      sequence_key: 'agent-egress', proxy_keys: ['host-7890'],
      direct_fallback: false, enabled: true,
    }]]),
    proxyEndpoints: new Map([['host-7890', {
      proxy_key: 'host-7890', proxy_url: 'http://127.0.0.1:7890', enabled: true,
    }]]),
    llmSequence: {
      sequence_key: 'candidate', display_name: 'Candidate', kind: 'chat',
      provider_ids: ['primary'], enabled: true, source: 'database',
      provider_revision: 2, revision: 1,
    },
    bindingRevision: 0,
    sequenceWrites: 0,
    bindingWrites: 0,
    queries: [],
  }
  const query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    state.queries.push({ text, params })
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
      || text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
    if (text.includes('FROM control.agent_proxy_settings')) {
      return { rows: [{ global_sequence_key: state.globalSequenceKey }] }
    }
    if (text.includes('FROM control.agent_provider_settings')) {
      return { rows: [structuredClone(state.providerSetting)] }
    }
    if (text.includes('FROM control.agent_proxy_sequences')) {
      const requested = new Set(params[0] || [])
      return {
        rows: [...state.proxySequences.values()]
          .filter((sequence) => requested.has(sequence.sequence_key))
          .map((sequence) => structuredClone(sequence)),
      }
    }
    if (text.includes('FROM control.agent_proxy_endpoints')) {
      const requested = new Set(params[0] || [])
      return {
        rows: [...state.proxyEndpoints.values()]
          .filter((endpoint) => requested.has(endpoint.proxy_key))
          .map((endpoint) => structuredClone(endpoint)),
      }
    }
    if (text.includes('SELECT revision FROM control.agent_consumer_bindings')) {
      return { rows: state.bindingRevision ? [{ revision: state.bindingRevision }] : [] }
    }
    if (text.includes('FROM control.agent_llm_sequences')) {
      if (!state.llmSequence || params[0] !== state.llmSequence.sequence_key) return { rows: [] }
      if (text.includes('SELECT revision, kind')) {
        return { rows: [{ revision: state.llmSequence.revision, kind: state.llmSequence.kind }] }
      }
      return { rows: [structuredClone(state.llmSequence)] }
    }
    if (text.startsWith('INSERT INTO control.agent_llm_sequences')) {
      state.sequenceWrites += 1
      state.llmSequence = {
        ...state.llmSequence,
        sequence_key: params[0], display_name: params[1], kind: params[2],
        provider_ids: params[3], enabled: params[4], provider_revision: params[5],
        revision: Number(state.llmSequence?.revision || 0) + 1,
      }
      return { rows: [structuredClone(state.llmSequence)] }
    }
    if (text.startsWith('INSERT INTO control.agent_consumer_bindings')) {
      state.bindingWrites += 1
      state.bindingRevision += 1
      return { rows: [{
        consumer_key: params[0], kind: params[1], sequence_key: params[2],
        revision: state.bindingRevision, updated_by: params[3],
        updated_at: '2026-08-29T00:00:00.000Z',
      }] }
    }
    throw new Error(`Unhandled verification SQL: ${text}`)
  }
  const client = { query, release() {} }
  return { state, store: new AgentControlStore({ async connect() { return client } }) }
}

function verificationFor(state, control = {}) {
  const providerRow = state.providerSetting.providers[0]
  return {
    settingsRevision: state.providerSetting.revision,
    proxyFingerprints: new Map([[
      providerRow.id,
      providerProxyRouteFingerprint(providerRow, {
        globalProxySequenceKey: state.globalSequenceKey,
        proxySequences: [],
        proxyEndpoints: [],
        ...control,
      }),
    ]]),
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

test('migration 042 tombstones only implicit compatibility defaults and preserves CAS history', async () => {
  const sql = await readFile(new URL('../../migrations/042_agent_explicit_llm_defaults.sql', import.meta.url), 'utf8')
  assert.match(sql, /ALTER COLUMN sequence_key DROP NOT NULL/)
  assert.match(sql, /SET sequence_key = NULL/)
  assert.match(sql, /revision = revision \+ 1/)
  assert.match(sql, /updated_by = 'environment-bootstrap'/)
  assert.match(sql, /consumer_key = 'hub\.chat\.default'[\s\S]*sequence_key = 'mx-default-chat'/)
  assert.match(sql, /consumer_key = 'hub\.embedding\.default'[\s\S]*sequence_key = 'mx-default-embedding'/)
  assert.doesNotMatch(sql, /DELETE FROM control\.agent_consumer_bindings/i)
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:core|ingest)\./i)
})

test('Proxy endpoint deletion enforces revision CAS and refuses Sequence references', async () => {
  const referenced = proxyControlHarness({ endpointReferences: ['agent-egress', 'backup-egress'] })
  await assert.rejects(
    () => referenced.store.deleteProxyEndpoint('host-7890', { expectedRevision: 2 }),
    (error) => error?.status === 409
      && error?.code === 'agent_proxy_endpoint_in_use'
      && error?.details?.sequenceKeys.join(',') === 'agent-egress,backup-egress',
  )
  assert.equal(referenced.state.deletedEndpoint, false)

  const stale = proxyControlHarness()
  await assert.rejects(
    () => stale.store.deleteProxyEndpoint('host-7890', { expectedRevision: 1 }),
    (error) => error?.status === 409
      && error?.code === 'proxy_revision_conflict'
      && error?.details?.currentRevision === 2,
  )
  assert.equal(stale.state.deletedEndpoint, false)

  const available = proxyControlHarness()
  const deleted = await available.store.deleteProxyEndpoint('host-7890', { expectedRevision: 2 })
  assert.equal(deleted.proxyKey, 'host-7890')
  assert.equal(deleted.revision, 2)
  assert.equal(available.state.deletedEndpoint, true)
  await assert.rejects(
    () => available.store.deleteProxyEndpoint('host-7890', { expectedRevision: 2 }),
    (error) => error?.status === 404 && error?.code === 'agent_proxy_endpoint_not_found',
  )
})

test('Proxy endpoint cannot be disabled while any Sequence still references it', async () => {
  const referenced = proxyControlHarness({ endpointReferences: ['agent-egress', 'backup-egress'] })
  await assert.rejects(
    () => referenced.store.saveProxyEndpoint('host-7890', {
      expectedRevision: 2,
      displayName: 'Host 7890',
      proxyUrl: 'http://127.0.0.1:7890',
      enabled: false,
    }),
    (error) => error?.status === 409
      && error?.code === 'agent_proxy_endpoint_in_use'
      && error?.details?.sequenceKeys.join(',') === 'agent-egress,backup-egress',
  )
  assert.equal(referenced.state.endpoint.enabled, true)
})

test('Proxy Sequence deletion refuses global and Provider bindings before deleting', async () => {
  const global = proxyControlHarness({ globalSequenceKey: 'agent-egress' })
  await assert.rejects(
    () => global.store.deleteProxySequence('agent-egress', { expectedRevision: 3 }),
    (error) => error?.status === 409
      && error?.code === 'agent_proxy_sequence_in_use'
      && error?.details?.global === true,
  )
  assert.equal(global.state.deletedSequence, false)

  const providerBound = proxyControlHarness({
    providerSettings: [{
      kind: 'chat',
      providers: [{ id: 'primary', proxySequenceKey: 'agent-egress' }],
    }],
  })
  await assert.rejects(
    () => providerBound.store.deleteProxySequence('agent-egress', { expectedRevision: 3 }),
    (error) => error?.status === 409
      && error?.code === 'agent_proxy_sequence_in_use'
      && error?.details?.providers?.[0]?.providerId === 'primary',
  )
  assert.equal(providerBound.state.deletedSequence, false)

  const available = proxyControlHarness()
  const deleted = await available.store.deleteProxySequence('agent-egress', { expectedRevision: 3 })
  assert.equal(deleted.sequenceKey, 'agent-egress')
  assert.equal(deleted.revision, 3)
  assert.equal(available.state.deletedSequence, true)
  await assert.rejects(
    () => available.store.deleteProxySequence('agent-egress', { expectedRevision: 3 }),
    (error) => error?.status === 404 && error?.code === 'agent_proxy_sequence_not_found',
  )
})

test('Proxy Sequence cannot transition from enabled to disabled while bound', async () => {
  const disable = {
    expectedRevision: 3,
    displayName: 'Agent egress',
    proxyKeys: ['host-7890'],
    directFallback: false,
    enabled: false,
  }
  const global = proxyControlHarness({ globalSequenceKey: 'agent-egress' })
  await assert.rejects(
    () => global.store.saveProxySequence('agent-egress', disable),
    (error) => error?.status === 409
      && error?.code === 'agent_proxy_sequence_in_use'
      && error?.details?.global === true,
  )
  assert.equal(global.state.sequence.enabled, true)

  const providerBound = proxyControlHarness({
    providerSettings: [{
      kind: 'chat',
      providers: [{ id: 'primary', proxySequenceKey: 'agent-egress' }],
    }],
  })
  await assert.rejects(
    () => providerBound.store.saveProxySequence('agent-egress', disable),
    (error) => error?.status === 409
      && error?.code === 'agent_proxy_sequence_in_use'
      && error?.details?.providers?.[0]?.providerId === 'primary',
  )
  assert.equal(providerBound.state.sequence.enabled, true)

  const available = proxyControlHarness()
  const saved = await available.store.saveProxySequence('agent-egress', disable)
  assert.equal(saved.enabled, false)
  assert.equal(saved.revision, 4)
  const globalAdvisory = available.state.queries.findIndex(({ params }) => (
    params[0] === 'mx-insight-agent:proxy-settings:global'
  ))
  const globalLock = available.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_proxy_settings') && text.includes('FOR SHARE')
  ))
  const providerLock = available.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_provider_settings') && text.includes('FOR SHARE')
  ))
  const sequenceAdvisory = available.state.queries.findIndex(({ params }) => (
    params[0] === 'mx-insight-agent:proxy-sequence:agent-egress'
  ))
  const sequenceLock = available.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_proxy_sequences') && text.includes('FOR UPDATE')
  ))
  assert.ok(globalAdvisory >= 0 && globalAdvisory < globalLock)
  assert.ok(globalLock < providerLock)
  assert.ok(providerLock < sequenceAdvisory)
  assert.ok(sequenceAdvisory < sequenceLock)
})

test('bootstrap refreshes only Compatibility Sequence candidates and never creates a default binding', async () => {
  const queries = []
  const client = {
    async query(sql, params = []) {
      queries.push({ text: sql.replace(/\s+/g, ' ').trim(), params })
      return { rows: [] }
    },
    release() {},
  }
  const store = new AgentControlStore({ async connect() { return client } })
  await store.ensureBootstrapSequence({
    kind: 'chat', providerIds: ['primary', 'fallback'], providerRevision: 4,
  })
  const upsert = queries.find(({ text }) => text.startsWith('INSERT INTO control.agent_llm_sequences'))
  assert.match(upsert.text, /ON CONFLICT \(sequence_key\) DO UPDATE SET/)
  assert.match(upsert.text, /provider_ids = EXCLUDED\.provider_ids/)
  assert.match(upsert.text, /provider_revision = EXCLUDED\.provider_revision/)
  assert.match(upsert.text, /revision = control\.agent_llm_sequences\.revision \+ 1/)
  assert.match(upsert.text, /WHERE control\.agent_llm_sequences\.source = 'bootstrap'/)
  assert.match(upsert.text, /IS DISTINCT FROM/)
  assert.equal(upsert.params[1], 'MX Compatibility Chat')
  assert.equal(queries.some(({ text }) => text.includes('INSERT INTO control.agent_consumer_bindings')), false)
})

test('runtime control snapshots distinguish a governed empty state from a missing migration', async () => {
  const normalClient = {
    async query(sql) {
      const text = sql.replace(/\s+/g, ' ').trim()
      if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] }
      if (text.includes('FROM control.agent_proxy_settings')) {
        return { rows: [{ global_sequence_key: null, revision: 0, updated_by: null, updated_at: null }] }
      }
      return { rows: [] }
    },
    release() {},
  }
  const normal = await new AgentControlStore({ async connect() { return normalClient } })
    .loadRuntimeSnapshot('chat')
  assert.equal(normal.controlAvailable, true)
  assert.equal(normal.defaultBinding, null)

  const missingClient = {
    async query(sql) {
      const text = sql.replace(/\s+/g, ' ').trim()
      if (text.startsWith('BEGIN') || text === 'ROLLBACK') return { rows: [] }
      const error = new Error('relation does not exist')
      error.code = '42P01'
      throw error
    },
    release() {},
  }
  const missing = await new AgentControlStore({ async connect() { return missingClient } })
    .loadRuntimeSnapshot('chat')
  assert.equal(missing.controlAvailable, false)
  assert.equal(missing.defaultBinding, null)
})

test('clearing an LLM default writes a nullable binding tombstone under revision CAS', async () => {
  const queries = []
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim()
      queries.push({ text, params })
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
        || text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('SELECT revision FROM control.agent_consumer_bindings')) {
        return { rows: [{ revision: 4 }] }
      }
      if (text.startsWith('INSERT INTO control.agent_consumer_bindings')) {
        return { rows: [{
          consumer_key: params[0], kind: params[1], sequence_key: params[2],
          revision: 5, updated_by: params[3], updated_at: '2026-08-29T00:00:00.000Z',
        }] }
      }
      throw new Error(`Unexpected default-clear SQL: ${text}`)
    },
    release() {},
  }
  const store = new AgentControlStore({ async connect() { return client } })
  const cleared = await store.setDefaultSequence('chat', null, { expectedRevision: 4 })
  assert.equal(cleared.sequenceKey, null)
  assert.equal(cleared.revision, 5)
  assert.equal(
    queries.some(({ text }) => text.includes('FROM control.agent_llm_sequences')),
    false,
    'clearing must not validate an arbitrary Sequence',
  )
  const write = queries.find(({ text }) => text.startsWith('INSERT INTO control.agent_consumer_bindings'))
  assert.deepEqual(write.params.slice(0, 3), ['hub.chat.default', 'chat', null])
})

test('Sequence save and default binding atomically reject a route changed after verification', async () => {
  const harness = sequenceVerificationHarness()
  const directProof = verificationFor(harness.state)
  harness.state.globalSequenceKey = 'agent-egress'

  await assert.rejects(
    () => harness.store.saveSequence('candidate', {
      expectedRevision: 1,
      displayName: 'Candidate',
      kind: 'chat',
      providerIds: ['primary'],
      enabled: true,
    }, {
      providerRevision: 2,
      verification: directProof,
    }),
    (error) => error?.status === 409 && error?.code === 'agent_provider_verification_stale',
  )
  assert.equal(harness.state.sequenceWrites, 0)

  await assert.rejects(
    () => harness.store.setDefaultSequence('chat', 'candidate', {
      expectedRevision: 0,
      expectedSequenceRevision: 1,
      verification: directProof,
    }),
    (error) => error?.status === 409 && error?.code === 'agent_provider_verification_stale',
  )
  assert.equal(harness.state.bindingWrites, 0)

  const proxyProof = verificationFor(harness.state, {
    proxySequences: [{
      sequenceKey: 'agent-egress', proxyKeys: ['host-7890'],
      directFallback: false, enabled: true,
    }],
    proxyEndpoints: [{
      proxyKey: 'host-7890', proxyUrl: 'http://127.0.0.1:7890', enabled: true,
    }],
  })
  const proxyTransactionStart = harness.state.queries.length
  const saved = await harness.store.saveSequence('candidate', {
    expectedRevision: 1,
    displayName: 'Candidate',
    kind: 'chat',
    providerIds: ['primary'],
    enabled: true,
  }, {
    providerRevision: 2,
    verification: proxyProof,
  })
  assert.equal(saved.revision, 2)

  harness.state.llmSequence = {
    ...harness.state.llmSequence,
    provider_ids: [],
    revision: 3,
  }
  await assert.rejects(
    () => harness.store.setDefaultSequence('chat', 'candidate', {
      expectedRevision: 0,
      expectedSequenceRevision: saved.revision,
      verification: proxyProof,
    }),
    (error) => error?.status === 409 && error?.code === 'sequence_verification_stale',
  )
  assert.equal(harness.state.bindingWrites, 0)
  harness.state.llmSequence = {
    ...harness.state.llmSequence,
    provider_ids: ['primary'],
    revision: 4,
  }

  const binding = await harness.store.setDefaultSequence('chat', 'candidate', {
    expectedRevision: 0,
    expectedSequenceRevision: harness.state.llmSequence.revision,
    verification: proxyProof,
  })
  assert.equal(binding.sequenceKey, 'candidate')
  assert.equal(harness.state.sequenceWrites, 1)
  assert.equal(harness.state.bindingWrites, 1)

  const proxyTransactionQueries = harness.state.queries.slice(proxyTransactionStart)
  const firstGlobalLock = proxyTransactionQueries.findIndex(({ params }) => (
    params[0] === 'mx-insight-agent:proxy-settings:global'
  ))
  const firstProviderLock = proxyTransactionQueries.findIndex(({ text }) => (
    text.includes('FROM control.agent_provider_settings') && text.includes('FOR SHARE')
  ))
  const firstProxySequenceLock = proxyTransactionQueries.findIndex(({ text }) => (
    text.includes('FROM control.agent_proxy_sequences') && text.includes('FOR SHARE')
  ))
  const firstEndpointLock = proxyTransactionQueries.findIndex(({ text }) => (
    text.includes('FROM control.agent_proxy_endpoints') && text.includes('FOR SHARE')
  ))
  const firstSequenceWrite = proxyTransactionQueries.findIndex(({ text }) => (
    text.startsWith('INSERT INTO control.agent_llm_sequences')
  ))
  assert.ok(firstGlobalLock >= 0 && firstGlobalLock < firstProviderLock)
  assert.ok(firstProviderLock < firstProxySequenceLock)
  assert.ok(firstProxySequenceLock < firstEndpointLock)
  assert.ok(firstEndpointLock < firstSequenceWrite)
})

test('Provider writes lock and validate Proxy Sequences in their persistence transaction', async () => {
  const harness = databaseHarness()
  harness.state.proxySequences.set('agent-egress', {
    sequence_key: 'agent-egress', enabled: true, proxy_keys: ['host-7890'],
  })
  harness.state.proxyEndpoints.set('host-7890', {
    proxy_key: 'host-7890', enabled: true,
  })
  const store = new AgentSettingsStore(harness.pool)
  await store.updateSetting('chat', {
    expectedRevision: 0,
    source: 'database',
    providers: [provider({ authMode: 'none', proxySequenceKey: 'agent-egress' })],
  })
  const providerLock = harness.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_provider_settings') && text.includes('FOR UPDATE')
  ))
  const proxyLock = harness.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_proxy_sequences') && text.includes('FOR SHARE')
  ))
  const endpointLock = harness.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_proxy_endpoints') && text.includes('FOR SHARE')
  ))
  const providerWrite = harness.state.queries.findIndex(({ text, params }) => (
    text.startsWith('INSERT INTO control.agent_provider_settings') && params.length > 1
  ))
  assert.ok(providerLock >= 0 && providerLock < proxyLock)
  assert.ok(proxyLock < endpointLock)
  assert.ok(endpointLock < providerWrite)

  const disabledEndpoint = databaseHarness()
  disabledEndpoint.state.proxySequences.set('agent-egress', {
    sequence_key: 'agent-egress', enabled: true, proxy_keys: ['host-7890'],
  })
  disabledEndpoint.state.proxyEndpoints.set('host-7890', {
    proxy_key: 'host-7890', enabled: false,
  })
  await assert.rejects(
    () => new AgentSettingsStore(disabledEndpoint.pool).updateSetting('chat', {
      expectedRevision: 0,
      source: 'database',
      providers: [provider({ authMode: 'none', proxySequenceKey: 'agent-egress' })],
    }),
    (error) => error?.status === 400
      && error?.code === 'invalid_provider_settings'
      && /no enabled endpoint/.test(error?.message),
  )
  assert.equal(disabledEndpoint.state.settings.get('chat').revision, 0)

  const missingMigration = databaseHarness()
  missingMigration.state.proxyMigrationMissing = true
  await assert.rejects(
    () => new AgentSettingsStore(missingMigration.pool).updateSetting('chat', {
      expectedRevision: 0,
      source: 'database',
      providers: [provider({ authMode: 'none', proxySequenceKey: 'agent-egress' })],
    }),
    (error) => error?.status === 503 && error?.code === 'agent_control_unavailable',
  )
  assert.equal(missingMigration.state.settings.get('chat').revision, 0)
})

test('Provider catalog replacement cannot delete an ID referenced by an LLM Sequence', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('chat', row('chat', {
    source: 'database',
    revision: 1,
    providers: [
      provider({ id: 'primary', authMode: 'none', priority: 0 }),
      provider({ id: 'fallback', authMode: 'none', priority: 1 }),
    ],
  }))
  harness.state.llmSequences.set('production-chat', {
    sequence_key: 'production-chat',
    kind: 'chat',
    provider_ids: ['primary'],
  })
  const store = new AgentSettingsStore(harness.pool)

  await assert.rejects(
    () => store.updateSetting('chat', {
      expectedRevision: 1,
      source: 'database',
      providers: [provider({ id: 'fallback', authMode: 'none' })],
    }),
    (error) => error?.status === 409
      && error?.code === 'agent_provider_in_use'
      && error?.details?.providerIds?.includes('primary')
      && error?.details?.sequenceKeys?.includes('production-chat'),
  )
  assert.equal(harness.state.settings.get('chat').revision, 1)

  const providerLock = harness.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_provider_settings') && text.includes('FOR UPDATE')
  ))
  const sequenceLock = harness.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_llm_sequences') && text.includes('FOR SHARE')
  ))
  assert.ok(providerLock >= 0 && providerLock < sequenceLock)

  const saved = await store.updateSetting('chat', {
    expectedRevision: 1,
    source: 'database',
    providers: [provider({ id: 'primary', authMode: 'none' })],
  })
  assert.deepEqual(saved.providers.map((entry) => entry.id), ['primary'])
})

test('Proxy Sequence pre-validation locks and requires an enabled endpoint', async () => {
  const available = databaseHarness()
  available.state.proxySequences.set('agent-egress', {
    sequence_key: 'agent-egress', enabled: true, proxy_keys: ['host-7890'],
  })
  available.state.proxyEndpoints.set('host-7890', {
    proxy_key: 'host-7890', enabled: true,
  })
  await new AgentControlStore(available.pool).validateProxySequenceKeys(['agent-egress'])
  const sequenceLock = available.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_proxy_sequences') && text.includes('FOR SHARE')
  ))
  const endpointLock = available.state.queries.findIndex(({ text }) => (
    text.includes('FROM control.agent_proxy_endpoints') && text.includes('FOR SHARE')
  ))
  assert.ok(sequenceLock >= 0 && sequenceLock < endpointLock)

  const disabled = databaseHarness()
  disabled.state.proxySequences.set('agent-egress', {
    sequence_key: 'agent-egress', enabled: true, proxy_keys: ['host-7890'],
  })
  disabled.state.proxyEndpoints.set('host-7890', {
    proxy_key: 'host-7890', enabled: false,
  })
  await assert.rejects(
    () => new AgentControlStore(disabled.pool).validateProxySequenceKeys(['agent-egress']),
    (error) => error?.status === 400
      && error?.code === 'invalid_provider_settings'
      && /no enabled endpoint/.test(error?.message),
  )
})

test('new Proxy Sequences and global bindings require a real endpoint', async () => {
  const pool = { async connect() { throw new Error('validation should happen before connecting') } }
  const store = new AgentControlStore(pool)
  await assert.rejects(
    () => store.saveProxySequence('direct-only', {
      expectedRevision: 0,
      displayName: 'Direct only',
      proxyKeys: [],
      directFallback: true,
      enabled: true,
    }),
    (error) => error?.status === 400 && error?.code === 'invalid_agent_proxy',
  )

  const globalClient = {
    async query(sql) {
      const text = sql.replace(/\s+/g, ' ').trim()
      if (text === 'BEGIN' || text === 'ROLLBACK'
        || text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('FROM control.agent_proxy_settings') && text.includes('FOR UPDATE')) {
        return { rows: [{ revision: 0 }] }
      }
      if (text.includes('FROM control.agent_proxy_sequences') && text.includes('FOR SHARE')) {
        return { rows: [{ enabled: true, proxy_keys: [] }] }
      }
      throw new Error(`Unhandled global Proxy test SQL: ${text}`)
    },
    release() {},
  }
  await assert.rejects(
    () => new AgentControlStore({ async connect() { return globalClient } })
      .setGlobalProxySequence('direct-only', { expectedRevision: 0 }),
    (error) => error?.status === 400 && error?.code === 'invalid_agent_proxy',
  )

  const disabledEndpointClient = {
    async query(sql) {
      const text = sql.replace(/\s+/g, ' ').trim()
      if (text === 'BEGIN' || text === 'ROLLBACK'
        || text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('FROM control.agent_proxy_settings') && text.includes('FOR UPDATE')) {
        return { rows: [{ revision: 0 }] }
      }
      if (text.includes('FROM control.agent_proxy_sequences') && text.includes('FOR SHARE')) {
        return { rows: [{ sequence_key: 'disabled-route', enabled: true, proxy_keys: ['host-7890'] }] }
      }
      if (text.includes('FROM control.agent_proxy_endpoints') && text.includes('FOR SHARE')) {
        return { rows: [] }
      }
      throw new Error(`Unhandled disabled endpoint binding SQL: ${text}`)
    },
    release() {},
  }
  await assert.rejects(
    () => new AgentControlStore({ async connect() { return disabledEndpointClient } })
      .setGlobalProxySequence('disabled-route', { expectedRevision: 0 }),
    (error) => error?.status === 400
      && error?.code === 'invalid_agent_proxy'
      && /no enabled endpoint/.test(error?.message),
  )
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

test('AgentRuntime routes an explicit default and fails every stale binding closed regardless of source', async () => {
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
        controlAvailable: true,
        sequences: [], defaultBinding: null, proxyEndpoints: [], proxySequences: [],
        globalProxySequenceKey: null, proxyRevision: 0,
      }
      return {
        controlAvailable: true,
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
  await assert.rejects(
    async () => runtime.complete([{ role: 'user', content: 'hello' }]),
    (error) => error?.code === 'agent_sequence_unavailable',
  )
  assert.deepEqual(seen, ['sequence-only.invalid'])
  runtime.close()
})

test('governed runtimes without a default never promote the first Provider from the catalog', async () => {
  let fetchCalls = 0
  const settingsStore = {
    async loadSetting(kind) {
      return kind === 'chat'
        ? row('chat', {
            source: 'database', revision: 1,
            providers: [provider({
              id: 'catalog-first', baseUrl: 'https://catalog-first.invalid/v1', authMode: 'none',
            })],
          })
        : row('embedding')
    },
    async loadCredentialsInternal() { return new Map() },
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() {
      return {
        controlAvailable: true,
        sequences: [], defaultBinding: null, proxyEndpoints: [], proxySequences: [],
        globalProxySequenceKey: null, proxyRevision: 0,
      }
    },
  }
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore,
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('the catalog must not be called without an explicit default')
    },
  }).start()

  await assert.rejects(
    async () => runtime.complete([{ role: 'user', content: 'hello' }]),
    (error) => error?.status === 503 && error?.code === 'agent_sequence_unavailable',
  )
  const profile = await runtime.suggestFileProfile({ columns: ['id', 'title'] })
  assert.equal(profile.origin, 'inferred')
  assert.equal(await runtime.classifyRecord({ record: { id: '1' }, categories: ['news'] }), null)
  assert.equal(fetchCalls, 0)
  runtime.close()
})

test('AgentRuntime clears a default into a revisioned tombstone and applies it fail-closed', async () => {
  let binding = {
    consumerKey: 'hub.chat.default', kind: 'chat', sequenceKey: 'selected', revision: 3,
  }
  const settingsStore = {
    async loadSetting(kind) {
      return kind === 'chat'
        ? row('chat', {
            source: 'database', revision: 1,
            providers: [provider({ authMode: 'none' })],
          })
        : row('embedding')
    },
    async loadCredentialsInternal() { return new Map() },
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() {
      return {
        controlAvailable: true,
        sequences: [{
          sequenceKey: 'selected', displayName: 'Selected', kind: 'chat',
          providerIds: ['primary'], enabled: true, source: 'database',
          providerRevision: 1, revision: 2,
        }],
        defaultBinding: structuredClone(binding),
        proxyEndpoints: [], proxySequences: [], globalProxySequenceKey: null, proxyRevision: 0,
      }
    },
    async setDefaultSequence(kind, sequenceKey, input) {
      assert.equal(kind, 'chat')
      assert.equal(sequenceKey, null)
      assert.equal(input.expectedRevision, 3)
      binding = { ...binding, sequenceKey: null, revision: 4 }
      return structuredClone(binding)
    },
  }
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore,
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  const cleared = await runtime.clearDefaultSequence('chat', { expectedRevision: 3 })
  assert.equal(cleared.binding.sequenceKey, null)
  assert.equal(cleared.binding.revision, 4)
  assert.equal(cleared.runtimeApplied, true)
  await assert.rejects(
    async () => runtime.complete([{ role: 'user', content: 'hello' }]),
    (error) => error?.code === 'agent_sequence_unavailable',
  )
  runtime.close()
})

test('a missing control migration keeps the legacy ordered Provider catalog compatible', async () => {
  const seen = []
  const settingsStore = {
    async loadSetting(kind) {
      return kind === 'chat'
        ? row('chat', {
            source: 'database', revision: 1,
            providers: [provider({
              id: 'legacy-first', baseUrl: 'https://legacy-first.invalid/v1', authMode: 'none',
            })],
          })
        : row('embedding')
    },
    async loadCredentialsInternal() { return new Map() },
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() {
      return {
        controlAvailable: false,
        sequences: [], defaultBinding: null, proxyEndpoints: [], proxySequences: [],
        globalProxySequenceKey: null, proxyRevision: 0,
      }
    },
  }
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore,
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    fetchImpl: async (url) => {
      seen.push(new URL(url).hostname)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'legacy OK' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  }).start()

  const result = await runtime.complete([{ role: 'user', content: 'hello' }])
  assert.equal(result.provider, 'legacy-first')
  assert.equal(result.sequenceKey, null)
  assert.deepEqual(seen, ['legacy-first.invalid'])
  runtime.close()
})

test('embedding availability requires a governed default while explicit Sequence tests remain usable', async () => {
  let fetchCalls = 0
  const settingsStore = {
    async loadSetting(kind) {
      return kind === 'embedding'
        ? row('embedding', {
            source: 'database', revision: 1,
            providers: [provider({
              id: 'embedding-candidate', baseUrl: 'https://embedding-candidate.invalid/v1',
              model: 'embedding-model', dimensions: 3, authMode: 'none',
            })],
            lockedEmbeddingModel: 'embedding-model',
            lockedEmbeddingDimensions: 3,
          })
        : row('chat')
    },
    async loadCredentialsInternal() { return new Map() },
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot(kind) {
      return {
        controlAvailable: true,
        sequences: kind === 'embedding' ? [{
          sequenceKey: 'embedding-candidate-sequence', displayName: 'Embedding candidate',
          kind: 'embedding', providerIds: ['embedding-candidate'], enabled: true,
          source: 'database', providerRevision: 1, revision: 2,
        }] : [],
        defaultBinding: null,
        proxyEndpoints: [], proxySequences: [], globalProxySequenceKey: null, proxyRevision: 0,
      }
    },
  }
  const runtime = await new AgentRuntime({
    config: config({
      agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false },
      embedding: { model: 'embedding-model', dimensions: 3 },
    }),
    settingsStore,
    controlStore,
    managedKinds: ['embedding'],
    logger: quiet,
    refreshIntervalMs: 0,
    fetchImpl: async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  }).start()

  assert.equal(runtime.embeddings.available, false)
  await assert.rejects(
    async () => runtime.embed(['ordinary embedding']),
    (error) => error?.status === 503 && error?.code === 'agent_sequence_unavailable',
  )
  assert.equal(fetchCalls, 0)
  const probe = await runtime.testSequence('embedding-candidate-sequence', {
    kind: 'embedding', expectedRevision: 2,
  })
  assert.equal(probe.providerId, 'embedding-candidate')
  assert.equal(probe.dimensions, 3)
  assert.equal(fetchCalls, 1)
  runtime.close()
})

test('an explicitly bound Proxy Sequence with no enabled endpoint fails closed', async () => {
  let fetchCalls = 0
  const settingsStore = {
    async loadSetting(kind) {
      return kind === 'chat'
        ? row('chat', {
            source: 'database', revision: 1,
            providers: [provider({ authMode: 'none' })],
          })
        : row('embedding')
    },
    async loadCredentialsInternal() { return new Map() },
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() {
      return {
        controlAvailable: true,
        sequences: [{
          sequenceKey: 'chat-default', displayName: 'Chat default', kind: 'chat',
          providerIds: ['primary'], enabled: true, source: 'database',
          providerRevision: 1, revision: 1,
        }],
        defaultBinding: {
          consumerKey: 'hub.chat.default', kind: 'chat',
          sequenceKey: 'chat-default', revision: 1,
        },
        proxyEndpoints: [{
          proxyKey: 'host-7890', displayName: 'Host 7890',
          proxyUrl: 'http://127.0.0.1:7890', enabled: false, revision: 2,
        }],
        proxySequences: [{
          sequenceKey: 'agent-egress', displayName: 'Agent egress',
          proxyKeys: ['host-7890'], directFallback: true, enabled: true, revision: 3,
        }],
        globalProxySequenceKey: 'agent-egress',
        proxyRevision: 1,
      }
    },
  }
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore,
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('direct transport must not be attempted')
    },
  }).start()

  await assert.rejects(
    () => runtime.complete([{ role: 'user', content: 'hello' }]),
    (error) => error?.status === 503
      && error?.code === 'agent_providers_unavailable'
      && error?.attempts?.[0]?.error === 'transport failure',
  )
  assert.equal(fetchCalls, 0)
  runtime.close()
})

test('Sequence say-hi refreshes current state and enforces Sequence revision CAS', async () => {
  let failReads = false
  let fetchCalls = 0
  let requestBody = null
  const snapshot = {
    controlAvailable: true,
    sequences: [{
      sequenceKey: 'say-hi', displayName: 'Say hi', kind: 'chat',
      providerIds: ['primary'], enabled: true, source: 'database',
      providerRevision: 1, revision: 2,
    }],
    defaultBinding: null,
    proxyEndpoints: [], proxySequences: [], globalProxySequenceKey: null, proxyRevision: 0,
  }
  const settingsStore = {
    async loadSetting(kind) {
      if (failReads) throw new Error('database unavailable')
      return kind === 'chat'
        ? row('chat', {
            source: 'database', revision: 1,
            providers: [provider({ authMode: 'none' })],
          })
        : row('embedding')
    },
    async loadCredentialsInternal() { return new Map() },
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() {
      if (failReads) throw new Error('database unavailable')
      return snapshot
    },
  }
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore,
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    fetchImpl: async (_url, options) => {
      fetchCalls += 1
      requestBody = JSON.parse(options.body)
      return new Response(JSON.stringify({
        choices: requestBody.max_tokens < 1_024
          ? [{
              finish_reason: 'length',
              message: { content: null, reasoning_content: 'Still reasoning' },
            }]
          : [{ message: { content: 'Hi from the current Sequence.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }).start()

  await assert.rejects(
    () => runtime.testSequence('say-hi', { kind: 'chat', expectedRevision: 1 }),
    (error) => error?.status === 409
      && error?.code === 'sequence_revision_conflict'
      && error?.details?.currentRevision === 2,
  )
  assert.equal(fetchCalls, 0)
  const passed = await runtime.testSequence('say-hi', { kind: 'chat', expectedRevision: 2 })
  assert.equal(passed.sample, 'Hi from the current Sequence.')
  assert.equal(requestBody.max_tokens, 1_024)
  assert.equal(fetchCalls, 1)

  failReads = true
  await assert.rejects(
    () => runtime.testSequence('say-hi', { kind: 'chat', expectedRevision: 2 }),
    (error) => error?.status === 503 && error?.code === 'agent_settings_refresh_failed',
  )
  assert.equal(fetchCalls, 1, 'a failed refresh must not test the last-known-good router')
  runtime.close()
})

test('AgentRuntime imports a legacy environment Provider and creates only a Compatibility Sequence candidate', async () => {
  const harness = databaseHarness()
  const bootstraps = []
  const controlStore = {
    async loadRuntimeSnapshot() {
      return {
        controlAvailable: true,
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
  await assert.rejects(
    async () => runtime.complete([{ role: 'user', content: 'hello' }]),
    (error) => error?.code === 'agent_sequence_unavailable',
  )
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

test('Provider probe evidence follows only its effective Proxy route', async () => {
  const harness = databaseHarness()
  harness.state.settings.set('chat', row('chat', {
    source: 'database', revision: 2,
    providers: [provider({ authMode: 'none' })],
  }))
  const now = Date.parse('2026-08-29T00:00:00.000Z')
  const providerTests = []
  const snapshot = {
    controlAvailable: true,
    sequences: [], defaultBinding: null,
    proxyEndpoints: [], proxySequences: [],
    globalProxySequenceKey: null, proxyRevision: 0,
  }
  let mutateEffectiveRouteOnEvidenceRead = false
  let restoreDirectDuringProbe = false
  let savedSequences = 0
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() { return structuredClone(snapshot) },
    async listPublicControl() {
      const latestTests = [...new Map(providerTests.map((entry) => [
        `${entry.kind}:${entry.providerId}`,
        entry,
      ])).values()]
      const result = {
        sequences: structuredClone(snapshot.sequences),
        bindings: [],
        providerTests: structuredClone(latestTests),
        proxy: {},
      }
      if (mutateEffectiveRouteOnEvidenceRead) {
        mutateEffectiveRouteOnEvidenceRead = false
        snapshot.proxyEndpoints = [{
          proxyKey: 'host-7890', displayName: 'Host 7890',
          proxyUrl: 'http://127.0.0.1:7890', enabled: true, revision: 1,
        }]
        snapshot.proxySequences = [{
          sequenceKey: 'agent-egress', displayName: 'Agent egress',
          proxyKeys: ['host-7890'], directFallback: false, enabled: true, revision: 1,
        }]
        snapshot.globalProxySequenceKey = 'agent-egress'
        snapshot.proxyRevision = 1
      }
      return result
    },
    async recordProbe(input) {
      providerTests.push({ ...structuredClone(input), testedAt: new Date(now).toISOString() })
    },
    async saveSequence(sequenceKey, input, metadata) {
      savedSequences += 1
      const existing = snapshot.sequences.find((sequence) => sequence.sequenceKey === sequenceKey)
      const saved = {
        sequenceKey,
        displayName: input.displayName,
        kind: input.kind,
        providerIds: [...input.providerIds],
        enabled: input.enabled,
        source: 'database',
        providerRevision: metadata.providerRevision,
        revision: (existing?.revision || 0) + 1,
      }
      snapshot.sequences = [
        ...snapshot.sequences.filter((sequence) => sequence.sequenceKey !== sequenceKey),
        saved,
      ]
      return structuredClone(saved)
    },
  }
  let fetchCalls = 0
  const dispatchers = []
  const runtime = await new AgentRuntime({
    config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
    settingsStore: new AgentSettingsStore(harness.pool),
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
    probeCooldownMs: 0,
    nowFn: () => now,
    fetchImpl: async (_url, options) => {
      fetchCalls += 1
      dispatchers.push(Boolean(options.dispatcher))
      if (restoreDirectDuringProbe) {
        restoreDirectDuringProbe = false
        snapshot.globalProxySequenceKey = null
        snapshot.proxyRevision += 1
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  }).start()

  await runtime.testProvider({ kind: 'chat', providerId: 'primary' })
  assert.equal(fetchCalls, 1)
  assert.deepEqual(dispatchers, [false])
  const directFingerprint = providerTests[0].proxyFingerprint

  snapshot.proxySequences = [{
    sequenceKey: 'unused-empty', displayName: 'Unused empty',
    proxyKeys: [], directFallback: true, enabled: true, revision: 1,
  }]
  await runtime.refresh({ force: true })
  await runtime.saveSequence('candidate', {
    expectedRevision: 0,
    displayName: 'Candidate',
    kind: 'chat',
    providerIds: ['primary'],
    enabled: true,
  })
  assert.equal(fetchCalls, 1, 'an unbound Proxy catalog row must not invalidate direct evidence')
  assert.equal(savedSequences, 1)

  mutateEffectiveRouteOnEvidenceRead = true
  await assert.rejects(
    () => runtime.saveSequence('candidate', {
      expectedRevision: 1,
      displayName: 'Candidate',
      kind: 'chat',
      providerIds: ['primary'],
      enabled: true,
    }),
    (error) => error?.status === 409 && error?.code === 'agent_provider_verification_stale',
  )
  assert.equal(fetchCalls, 1, 'a route change during verification must not use stale evidence')
  assert.equal(savedSequences, 1, 'a route change during verification must stop before saving')

  await runtime.saveSequence('candidate', {
    expectedRevision: 1,
    displayName: 'Candidate',
    kind: 'chat',
    providerIds: ['primary'],
    enabled: true,
  })
  assert.equal(fetchCalls, 2, 'changing the effective route must trigger a new exact probe')
  assert.equal(savedSequences, 2)
  assert.deepEqual(dispatchers, [false, true])
  assert.notEqual(providerTests.at(-1).proxyFingerprint, directFingerprint)

  snapshot.globalProxySequenceKey = null
  snapshot.proxyRevision += 1
  providerTests.length = 0
  await runtime.refresh({ force: true })
  mutateEffectiveRouteOnEvidenceRead = true
  restoreDirectDuringProbe = true
  await assert.rejects(
    () => runtime.saveSequence('candidate', {
      expectedRevision: 2,
      displayName: 'Candidate',
      kind: 'chat',
      providerIds: ['primary'],
      enabled: true,
    }),
    (error) => error?.status === 409 && error?.code === 'agent_provider_verification_stale',
  )
  assert.equal(snapshot.globalProxySequenceKey, null, 'the ABA route must end at its original direct state')
  assert.equal(fetchCalls, 3, 'the intermediate proxy route must actually be probed')
  assert.equal(dispatchers.at(-1), true)
  assert.equal(savedSequences, 2, 'ABA evidence must not reach Sequence persistence')
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
  const providerTests = []
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
      return { sequences: snapshot.sequences, bindings: [snapshot.defaultBinding], providerTests, proxy: {} }
    },
    async recordProbe(input) {
      providerTests.splice(0, providerTests.length, {
        ...input,
        testedAt: new Date().toISOString(),
      })
    },
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

test('post-delete refresh failure fails managed Agent capabilities closed', async (t) => {
  for (const operation of ['endpoint', 'sequence']) {
    await t.test(operation, async () => {
      let failControlReads = false
      const snapshot = {
        sequences: [], defaultBinding: null,
        proxyEndpoints: [{
          proxyKey: 'host-7890', displayName: 'Host 7890',
          proxyUrl: 'http://127.0.0.1:7890', enabled: true, revision: 1,
        }],
        proxySequences: [{
          sequenceKey: 'agent-egress', displayName: 'Agent egress',
          proxyKeys: ['host-7890'], directFallback: true, enabled: true, revision: 1,
        }],
        globalProxySequenceKey: null,
        proxyRevision: 0,
      }
      const controlStore = {
        async ensureBootstrapSequence() {},
        async loadRuntimeSnapshot() {
          if (failControlReads) throw new Error('control snapshot unavailable after delete')
          return snapshot
        },
        async deleteProxyEndpoint(key, input) {
          assert.equal(key, 'host-7890')
          assert.deepEqual(input, { expectedRevision: 1 })
          failControlReads = true
          return snapshot.proxyEndpoints[0]
        },
        async deleteProxySequence(key, input) {
          assert.equal(key, 'agent-egress')
          assert.deepEqual(input, { expectedRevision: 1 })
          failControlReads = true
          return snapshot.proxySequences[0]
        },
      }
      const settingsStore = {
        async loadSetting(kind) {
          return kind === 'chat'
            ? row('chat', {
                source: 'database', revision: 1,
                providers: [provider({ authMode: 'none' })],
              })
            : row('embedding')
        },
        async loadCredentialsInternal() { return new Map() },
      }
      const runtime = await new AgentRuntime({
        config: config({ agent: { chatProviders: null, embeddingProviders: null, autoMigrate: false } }),
        settingsStore,
        controlStore,
        managedKinds: ['chat'],
        logger: quiet,
        refreshIntervalMs: 0,
      }).start()
      assert.equal(runtime.status().chat.length, 1)

      const result = operation === 'endpoint'
        ? await runtime.deleteProxyEndpoint('host-7890', { expectedRevision: 1 })
        : await runtime.deleteProxySequence('agent-egress', { expectedRevision: 1 })
      assert.equal(result.runtimeApplied, false)
      assert.deepEqual(runtime.status().chat, [])
      runtime.close()
    })
  }
})

test('Proxy Sequence deletion and disabling refuse an environment Provider reference', async () => {
  let deleteCalls = 0
  let saveCalls = 0
  const snapshot = {
    sequences: [], defaultBinding: null,
    proxyEndpoints: [{
      proxyKey: 'host-7890', displayName: 'Host 7890',
      proxyUrl: 'http://127.0.0.1:7890', enabled: true, revision: 1,
    }],
    proxySequences: [{
      sequenceKey: 'agent-egress', displayName: 'Agent egress',
      proxyKeys: ['host-7890'], directFallback: false, enabled: true, revision: 1,
    }],
    globalProxySequenceKey: null,
    proxyRevision: 0,
  }
  const controlStore = {
    async ensureBootstrapSequence() {},
    async loadRuntimeSnapshot() { return snapshot },
    async deleteProxySequence() { deleteCalls += 1 },
    async saveProxySequence() { saveCalls += 1 },
  }
  const settingsStore = {
    async loadSetting(kind) { return row(kind) },
    async loadCredentialsInternal() { return new Map() },
  }
  const runtime = await new AgentRuntime({
    config: config({
      agent: {
        chatProviders: JSON.stringify([provider({
          authMode: 'none',
          proxySequenceKey: 'agent-egress',
        })]),
        embeddingProviders: null,
        autoMigrate: false,
      },
    }),
    settingsStore,
    controlStore,
    managedKinds: ['chat'],
    logger: quiet,
    refreshIntervalMs: 0,
  }).start()

  await assert.rejects(
    () => runtime.saveProxySequence('agent-egress', {
      expectedRevision: 1,
      displayName: 'Agent egress',
      proxyKeys: ['host-7890'],
      directFallback: false,
      enabled: false,
    }),
    (error) => error?.status === 409
      && error?.code === 'agent_proxy_sequence_in_use'
      && error?.details?.providers?.[0]?.providerId === 'primary',
  )
  assert.equal(saveCalls, 0)

  await assert.rejects(
    () => runtime.deleteProxySequence('agent-egress', { expectedRevision: 1 }),
    (error) => error?.status === 409
      && error?.code === 'agent_proxy_sequence_in_use'
      && error?.details?.providers?.[0]?.providerId === 'primary',
  )
  assert.equal(deleteCalls, 0)
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

test('Agent default clear and Proxy DELETE routes require admin and preserve deferred runtime status', async () => {
  const calls = []
  const agent = {
    available: true,
    status: () => ({ chat: [], embeddings: [], embeddingDimensions: null, settings: {} }),
    async testSequence(sequenceKey, body) {
      calls.push({ type: 'say-hi', sequenceKey, body })
      return { ok: true, sequenceKey }
    },
    async clearDefaultSequence(kind, body) {
      calls.push({ type: 'clear-default', kind, body })
      return {
        binding: { consumerKey: `hub.${kind}.default`, kind, sequenceKey: null, revision: body.expectedRevision + 1 },
        runtimeApplied: false,
      }
    },
    async deleteProxyEndpoint(proxyKey, body) {
      calls.push({ type: 'endpoint', proxyKey, body })
      return { proxyKey, revision: body.expectedRevision, runtimeApplied: true }
    },
    async deleteProxySequence(sequenceKey, body) {
      calls.push({ type: 'sequence', sequenceKey, body })
      return { sequenceKey, revision: body.expectedRevision, runtimeApplied: false }
    },
  }
  const app = createApp({
    service: {},
    store: { async ping() { return true } },
    adapter: { async dependencies() { return { status: 'up' } } },
    agent,
    adminToken: 'admin-token-for-proxy-delete',
    logger: quiet,
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const root = `http://127.0.0.1:${server.address().port}/internal/v1/admin/agent/proxies`
    const sayHi = await fetch(
      `http://127.0.0.1:${server.address().port}/internal/v1/admin/agent/sequences/say-hi/test`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mx-insight-admin-token': 'admin-token-for-proxy-delete',
        },
        body: JSON.stringify({ kind: 'chat', expectedRevision: 7 }),
      },
    )
    assert.equal(sayHi.status, 200)
    const clearDefault = await fetch(
      `http://127.0.0.1:${server.address().port}/internal/v1/admin/agent/sequences/default`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-mx-insight-admin-token': 'admin-token-for-proxy-delete',
        },
        body: JSON.stringify({ kind: 'chat', expectedRevision: 7 }),
      },
    )
    assert.equal(clearDefault.status, 202)
    assert.equal((await clearDefault.json()).data.binding.sequenceKey, null)
    const denied = await fetch(`${root}/endpoints/host-7890`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2 }),
    })
    assert.equal(denied.status, 401)
    assert.equal(calls.length, 2)

    const endpoint = await fetch(`${root}/endpoints/host-7890`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-mx-insight-admin-token': 'admin-token-for-proxy-delete',
      },
      body: JSON.stringify({ expectedRevision: 2 }),
    })
    assert.equal(endpoint.status, 200)

    const sequence = await fetch(`${root}/sequences/agent-egress`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-mx-insight-admin-token': 'admin-token-for-proxy-delete',
      },
      body: JSON.stringify({ expectedRevision: 3 }),
    })
    assert.equal(sequence.status, 202)
    assert.equal((await sequence.json()).data.runtimeApplied, false)
    assert.deepEqual(calls, [
      { type: 'say-hi', sequenceKey: 'say-hi', body: { kind: 'chat', expectedRevision: 7 } },
      { type: 'clear-default', kind: 'chat', body: { kind: 'chat', expectedRevision: 7 } },
      { type: 'endpoint', proxyKey: 'host-7890', body: { expectedRevision: 2 } },
      { type: 'sequence', sequenceKey: 'agent-egress', body: { expectedRevision: 3 } },
    ])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
