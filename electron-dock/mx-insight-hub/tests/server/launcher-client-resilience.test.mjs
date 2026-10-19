// Launcher introspection under load or outage: one call per token at a time,
// and a short, bounded bridge only when Launcher itself is unavailable.

import assert from 'node:assert/strict'
import test from 'node:test'
import { LauncherIdentityClient } from '../../server/identity/index.mjs'

const AUDIENCE = 'insight-hub'
const active = (subject) => ({ introspection: { active: true, audience: AUDIENCE, subject,
  principal: { principalId: subject, kind: 'user', userId: subject } } })
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' } })

function client(fetchImpl, options = {}) {
  return new LauncherIdentityClient({ baseUrl: 'http://launcher.invalid', audience: AUDIENCE,
    logger: { warn() {} }, fetchImpl, ...options })
}

test('concurrent requests with one token share a single Launcher call', async () => {
  let calls = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const subject = client(async (_url, init) => {
    calls += 1
    await gate
    return json(active(JSON.parse(init.body).token))
  })
  const same = Array.from({ length: 5 }, () => subject.introspect('token-a'))
  const other = subject.introspect('token-b')
  while (calls < 2) await new Promise(setImmediate)
  release()
  const results = await Promise.all([...same, other])
  assert.equal(calls, 2)
  assert.ok(results.slice(0, 5).every(result => result.subject === 'token-a'))
  assert.equal(results[5].subject, 'token-b')
  // Settled and cached: no further call inside the TTL.
  await subject.introspect('token-a')
  assert.equal(calls, 2)
})

for (const [name, outage] of [
  ['unreachable', async () => { throw new Error('ECONNREFUSED') }],
  ['answering 5xx', async () => json({}, 503)],
]) test(`a recently confirmed token bridges a Launcher that is ${name}, only within the grace`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  let fetchImpl = async () => json(active('usr_alice'))
  const subject = client((...args) => fetchImpl(...args))
  assert.equal((await subject.introspect('token-a')).subject, 'usr_alice')
  fetchImpl = outage
  t.mock.timers.setTime(1_000_000 + 60_000)
  assert.equal((await subject.introspect('token-a')).subject, 'usr_alice')
  await assert.rejects(subject.introspect('never-confirmed'), { code: 'launcher_unavailable' })
  t.mock.timers.setTime(1_000_000 + 30_000 + 120_000)
  await assert.rejects(subject.introspect('token-a'), { code: 'launcher_unavailable' })
})

test('an explicit rejection removes the bridge for that token', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 })
  let fetchImpl = async () => json(active('usr_alice'))
  const subject = client((...args) => fetchImpl(...args))
  await subject.introspect('token-a')
  t.mock.timers.setTime(2_000_000 + 40_000)
  fetchImpl = async () => json({ introspection: { active: false, reason: 'revoked' } })
  assert.equal(await subject.introspect('token-a'), null)
  fetchImpl = async () => { throw new Error('ECONNREFUSED') }
  await assert.rejects(subject.introspect('token-a'), { code: 'launcher_unavailable' })
})

test('invalidate() is not undone by a call that was already in flight', async () => {
  let calls = 0, release, started
  const gate = new Promise(resolve => { release = resolve })
  const fetching = new Promise(resolve => { started = resolve })
  const subject = client(async () => {
    calls += 1
    if (calls === 1) { started(); await gate }
    return json(active('usr_alice'))
  })
  const running = subject.introspect('token-a')
  await fetching
  subject.invalidate()
  release()
  assert.equal((await running).subject, 'usr_alice')
  await subject.introspect('token-a')
  assert.equal(calls, 2)
})

test('a zero TTL disables both the cache and the outage bridge', async () => {
  let calls = 0, down = false
  const subject = client(async () => { calls += 1; if (down) throw new Error('ECONNREFUSED'); return json(active('usr_alice')) },
    { cacheTtlMs: 0 })
  await subject.introspect('token-a')
  await subject.introspect('token-a')
  assert.equal(calls, 2)
  down = true
  await assert.rejects(subject.introspect('token-a'), { code: 'launcher_unavailable' })
})
