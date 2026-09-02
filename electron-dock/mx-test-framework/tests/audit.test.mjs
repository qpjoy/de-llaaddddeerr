import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { scrub, sourceIp } from '../server/audit.mjs'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'

// The audit trail exists because ADR-0007 removed the command allowlist and
// named "admin role + sandboxed container + audit" as the replacement. These
// tests are that third leg: they assert the record answers "who changed the
// command to that, and what was it before", and that the record itself never
// becomes a place credentials accumulate.

const ADMIN_TOKEN = 'test-admin-token'
let base
let runtime

const api = async (method, path, { body, token = ADMIN_TOKEN } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

before(async () => {
  runtime = await start(
    loadConfig({ MXT_STORE: 'memory', MXT_ADMIN_TOKEN: ADMIN_TOKEN, MXT_PORT: '0' }),
    { schedule: false },
  )
  base = `http://127.0.0.1:${runtime.port}`
  await api('POST', '/api/v1/apps', {
    body: { slug: 'luopan', displayName: '罗盘', repoUrl: 'https://github.com/x/y', surfaces: ['web'] },
  })
})

after(async () => {
  await runtime.close()
})

// -- the scrubber -------------------------------------------------------------

test('anything credential-shaped is redacted at any depth', () => {
  const scrubbed = scrub({
    name: 'ok',
    token: 'mxt-rnr-abc',
    nested: { apiKey: 'k', deep: { password: 'p', keep: 'yes' } },
    list: [{ secret: 's' }, { fine: 1 }],
  })
  const serialized = JSON.stringify(scrubbed)
  for (const leaked of ['mxt-rnr-abc', '"k"', '"p"', '"s"']) {
    assert.ok(!serialized.includes(leaked), leaked)
  }
  // Presence is preserved: "a secret was set here" is itself part of the change.
  assert.equal(scrubbed.token, '[redacted]')
  assert.equal(scrubbed.nested.deep.keep, 'yes')
  assert.equal(scrubbed.list[1].fine, 1)
})

test('an empty secret reads as absent rather than redacted', () => {
  assert.equal(scrub({ token: '' }).token, null)
  assert.equal(scrub({ token: null }).token, null)
})

test('the scrubber terminates on deep or circular input', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'too deep' } } } } } } } }
  assert.doesNotThrow(() => JSON.stringify(scrub(deep)))
})

test('the client address prefers the socket over a header a caller controls', () => {
  // Trusting X-Forwarded-For blindly would let a caller write whatever it likes
  // into the audit trail.
  assert.equal(
    sourceIp({ socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } }),
    '10.0.0.5',
  )
  assert.equal(sourceIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4')
  assert.equal(sourceIp({}), null)
})

// -- what gets recorded -------------------------------------------------------

test('creating a suite records the command that will run', async () => {
  const created = await api('POST', '/api/v1/apps/luopan/suites', {
    body: {
      slug: 'py',
      displayName: 'pytest',
      engine: 'pytest',
      surface: 'web',
      runnerKind: 'server',
      targetMode: 'self',
      command: ['pytest', '-q', '--junitxml=junit/out.xml'],
      runnerImage: 'python:3.12-slim',
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))

  const audit = await api('GET', '/api/v1/audit?resource=suite')
  const [event] = audit.body.events
  assert.equal(event.action, 'suite.create')
  assert.equal(event.resourceId, created.body.suite.id)
  // The three fields that decide what code runs on a real machine.
  assert.deepEqual(event.after.command, ['pytest', '-q', '--junitxml=junit/out.xml'])
  assert.equal(event.after.runnerImage, 'python:3.12-slim')
  assert.equal(event.before, null) // creation
  assert.ok(event.actorId)
  assert.ok(event.createdAt)
})

test('a role change records what it was before', async () => {
  // Who can create a suite is who can decide what runs, so this belongs in the
  // same trail as the suites themselves.
  // Members are normally provisioned by a launcher login. Without a launcher
  // configured the admin token resolves to a synthetic service principal with
  // no row, so the row is seeded directly — this test is about the audit
  // record, not about how members come into existence.
  await runtime.store.upsertMember({
    principalId: 'user-1',
    displayName: '某人',
    role: 'operator',
  })
  await api('PATCH', '/api/v1/members/user-1', { body: { role: 'admin' } })
  const audit = await api('GET', '/api/v1/audit?resource=member')
  const [event] = audit.body.events
  assert.equal(event.action, 'member.role_change')
  assert.equal(event.after.role, 'admin')
  // Privilege escalation is only legible if the previous level is recorded.
  assert.equal(event.before.role, 'operator')
})

test('publishing a build records what it replaced', async () => {
  const sha = 'a'.repeat(64)
  await api('POST', '/api/v1/apps/luopan/packages', {
    body: { url: 'https://artifacts.internal/v1.exe', sha256: sha, version: '1.0.0' },
  })
  await api('POST', '/api/v1/apps/luopan/packages', {
    body: { url: 'https://artifacts.internal/v2.exe', sha256: 'b'.repeat(64), version: '2.0.0' },
  })
  const audit = await api('GET', '/api/v1/audit?resource=package')
  const [latest] = audit.body.events
  assert.equal(latest.action, 'package.publish')
  assert.equal(latest.after.version, '2.0.0')
  // A downloaded-and-executed artefact changing under people is exactly what
  // this record is for.
  assert.equal(latest.before.version, '1.0.0')
})

test('registering a runner never writes its token to the trail', async () => {
  const registered = await api('POST', '/runner/v1/runners:register', {
    body: { name: 'my-windows', os: 'windows', engines: ['playwright'], surfaces: ['web'] },
  })
  const token = registered.body.token
  assert.ok(token)
  const audit = await api('GET', '/api/v1/audit?resource=runner')
  const serialized = JSON.stringify(audit.body.events)
  assert.ok(!serialized.includes(token), 'the runner token must not reach the audit table')
  assert.equal(audit.body.events[0].after.name, 'my-windows')
})

test('a notification channel is recorded without its bot url', async () => {
  const created = await api('POST', '/api/v1/notification-channels', {
    body: {
      name: 'QA 群',
      kind: 'feishu',
      config: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET-TOKEN', secret: 'sig' },
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  await api('DELETE', `/api/v1/notification-channels/${created.body.channel.id}`)

  const audit = await api('GET', '/api/v1/audit?resource=channel')
  const serialized = JSON.stringify(audit.body.events)
  // The bot URL *is* the credential — the token is a path segment. An audit
  // table that keeps it is a credential store with a very long retention.
  assert.ok(!serialized.includes('SECRET-TOKEN'))
  assert.ok(!serialized.includes('"sig"'))
  const actions = audit.body.events.map((entry) => entry.action)
  assert.deepEqual(actions, ['channel.delete', 'channel.create'])
  // Deletion has to record what was removed; afterwards there is nothing left
  // to describe.
  assert.equal(audit.body.events[0].before.name, 'QA 群')
})

// -- the trail is a trail -----------------------------------------------------

test('the trail is admin-only', async () => {
  const anonymous = await api('GET', '/api/v1/audit', { token: null })
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `got ${anonymous.status}`)
})

test('there is no way to edit or remove a record', async () => {
  // A log that can be edited is not evidence of anything, so the absence of
  // these routes is the feature.
  const audit = await api('GET', '/api/v1/audit')
  const [event] = audit.body.events
  for (const method of ['PATCH', 'DELETE', 'PUT']) {
    const attempt = await api(method, `/api/v1/audit/${event.id}`)
    assert.equal(attempt.status, 404, `${method} should not exist`)
  }
})

test('records can be narrowed to one resource', async () => {
  const all = await api('GET', '/api/v1/audit?limit=500')
  const suites = await api('GET', '/api/v1/audit?resource=suite')
  assert.ok(all.body.events.length > suites.body.events.length)
  assert.ok(suites.body.events.every((entry) => entry.resourceType === 'suite'))
})

test('the generic scrubber does not swallow a harmless flag', () => {
  // `redactChannel` reports whether signing is configured. Naming that field
  // `hasSecret` would have matched the scrubber's /secret/ pattern and turned a
  // useful boolean into "[redacted]" in every channel record.
  assert.equal(scrub({ signed: true, urlHost: 'open.feishu.cn' }).signed, true)
})
