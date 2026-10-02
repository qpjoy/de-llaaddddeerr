import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MissionStore } from '../packages/runtime/store.mjs'
import { MissionSync, compactForSync } from '../packages/runtime/sync.mjs'
import { RigError } from '../packages/contracts/index.mjs'
import { start } from '../apps/server/index.mjs'

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test('a synced record leaves the transcript behind and trims to fit', () => {
  const row = {
    id: randomUUID(),
    goal: 'g',
    mode: 'agent',
    status: 'completed',
    createdAt: new Date().toISOString(),
    messages: [{ role: 'user', content: 'secret prompt' }],
    graph: { next: null },
    evidence: [{ tool: 'x', summary: 'raw' }],
    stream: { text: 'draft' },
    events: Array.from({ length: 40 }, (_, i) => ({
      at: new Date().toISOString(),
      kind: 'tool_result',
      message: `result ${i}`,
      data: { result: 'x'.repeat(4000) }
    }))
  }
  const whole = compactForSync(row)
  for (const field of ['messages', 'graph', 'evidence', 'stream'])
    assert.equal(whole[field], undefined)
  assert.equal(whole.truncated, undefined)
  assert.equal(whole.events.length, 40)

  const trimmed = compactForSync(row, 60_000)
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 60_000)
  assert.equal(trimmed.truncated, true)
  // Oldest data goes first; the latest results are what someone reads.
  assert.deepEqual(trimmed.events[0].data, { truncated: true })
  assert.equal(trimmed.events.at(-1).data.result.length, 4000)
  assert.equal(row.events[0].data.result.length, 4000, 'the local record is untouched')
})

async function syncFixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-sync-'))
  const sent = []
  const client = {
    async request(path, body) {
      assert.equal(path, '/api/rig/v1/missions:sync')
      sent.push(body.missions.map((row) => ({ id: row.id, status: row.status })))
      return respond(body)
    }
  }
  let sync
  const store = await new MissionStore(join(root, 'missions'), {
    onSaved: (row) => sync?.markDirty(row.id)
  }).init()
  sync = await new MissionSync({ store, client, file: join(root, 'sync-state.json') }).init()
  t.after(() => sync.close(100))
  return { root, store, sync, sent, client }
}

test('saves are batched out, and a failure is retried rather than lost', async (t) => {
  let fail = true
  const f = await syncFixture(t, () => {
    if (fail) throw new RigError('service_error', 'down', 503)
    return { synced: 1 }
  })
  const row = await f.store.create('alice', { goal: 'g', mode: 'agent' })
  row.status = 'completed'
  await f.store.save(row)
  await f.sync.flush()
  assert.equal(f.sent.length, 1)
  assert.ok(f.sync.dirty.has(row.id), 'still owed after a failed send')
  fail = false
  await f.sync.flush()
  assert.equal(f.sync.dirty.size, 0)
  assert.equal(f.sent.at(-1)[0].status, 'completed')

  // Restart: only what changed since the last confirmed send goes again.
  const again = await new MissionSync({
    store: f.store,
    client: f.client,
    file: join(f.root, 'sync-state.json')
  }).init()
  assert.equal(again.dirty.size, 0)
  row.status = 'blocked'
  await f.store.save(row)
  const third = await new MissionSync({
    store: f.store,
    client: f.client,
    file: join(f.root, 'sync-state.json')
  }).init()
  assert.ok(third.dirty.has(row.id))
  await third.close(100)
  await again.close(100)
})

test('a service without the sync route turns syncing off quietly', async (t) => {
  const f = await syncFixture(t, () => {
    throw new RigError('not_found', '接口不存在', 404)
  })
  await f.store.create('alice', { goal: 'g', mode: 'agent' })
  await f.sync.flush()
  assert.equal(f.sync.disabled, true)
  await f.store.create('alice', { goal: 'h', mode: 'agent' })
  await settle()
  assert.equal(f.sent.length, 1, 'nothing more is attempted')
})

async function server(t) {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-sync-api-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'sync-admin-token',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body, token = 'sync-admin-token') => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  return { runtime, api }
}

const desktopRow = (overrides = {}) => ({
  id: randomUUID(),
  owner: 'someone-else',
  goal: '桌面巡检',
  mode: 'agent',
  status: 'awaiting_approval',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  pending: { approvalId: randomUUID(), name: 'browser_click', args: { ref: 'e1' } },
  events: [],
  ...overrides
})

test('the service keeps what a desktop ran, readable and never executable', async (t) => {
  const { api } = await server(t)
  const row = desktopRow()
  const synced = await api('/api/rig/v1/missions:sync', { missions: [row] })
  assert.equal(synced.status, 200, JSON.stringify(synced.body))
  assert.equal(synced.body.synced, 1)

  const listed = (await api('/api/rig/v1/missions')).body.missions.find((m) => m.id === row.id)
  assert.equal(listed.surface, 'desktop')
  assert.equal(listed.owner, 'service-admin', 'the owner is the caller, not the record')
  assert.equal(listed.pending, null, 'no approval can be taken from the copy')

  for (const [action, body] of [
    ['approve', { approvalId: row.pending.approvalId, approved: true }],
    ['cancel', {}],
    ['followup', { goal: '继续' }]
  ]) {
    const refused = await api(`/api/rig/v1/missions/${row.id}/${action}`, body)
    assert.equal(refused.status, 409, action)
    assert.equal(refused.body.error.code, 'desktop_mission')
  }

  // An older snapshot never replaces a newer one.
  const newer = {
    ...row,
    status: 'completed',
    updatedAt: new Date(Date.now() + 1000).toISOString()
  }
  await api('/api/rig/v1/missions:sync', { missions: [newer] })
  await api('/api/rig/v1/missions:sync', { missions: [{ ...row, status: 'running' }] })
  const latest = (await api('/api/rig/v1/missions')).body.missions.find((m) => m.id === row.id)
  assert.equal(latest.status, 'completed')
})

test('a desktop cannot overwrite a server mission by reusing its id', async (t) => {
  const { api } = await server(t)
  const own = await api('/api/rig/v1/missions', { mode: 'agent', goal: '服务端任务' })
  assert.equal(own.status, 201)
  const id = own.body.mission.id
  const hijack = await api('/api/rig/v1/missions:sync', {
    missions: [desktopRow({ id, goal: '冒名', status: 'completed' })]
  })
  assert.equal(hijack.body.synced, 0)
  const kept = (await api('/api/rig/v1/missions')).body.missions.find((m) => m.id === id)
  assert.equal(kept.goal, '服务端任务')
  assert.notEqual(kept.surface, 'desktop')

  const malformed = await api('/api/rig/v1/missions:sync', {
    missions: [{ ...desktopRow(), status: 'hacked' }]
  })
  assert.equal(malformed.status, 400)
})
