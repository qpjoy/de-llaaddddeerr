import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'
import { MemoryStore } from '../server/store/memory.mjs'
import {
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  hashPassword,
  normalizeAccount,
  requireAccount,
  verifyPassword,
} from '../server/identity/local-accounts.mjs'

// Rig's own accounts, over real HTTP against the memory store, with no
// Launcher configured: the product has to be usable with nothing else running.

const ADMIN_TOKEN = 'test-admin-token'
let base
let runtime

const api = async (method, path, { body, token = ADMIN_TOKEN, cookie } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
}

const login = (username, password) =>
  api('POST', '/api/v1/auth/login', { token: null, body: { username, password } })

before(async () => {
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_ADMIN_TOKEN: ADMIN_TOKEN,
    MXT_PORT: '0',
    MXT_ARTIFACTS_DIR: '/data/artifacts',
  })
  assert.equal(config.launcher.baseUrl, null, 'these tests run without any Launcher')
  runtime = await start(config, { schedule: false })
  base = `http://127.0.0.1:${runtime.port}`
})

after(async () => {
  await runtime.close()
})

test('passwords are stored as scrypt hashes and verified in constant form', async () => {
  const encoded = await hashPassword('correct horse battery')
  assert.match(encoded, /^scrypt\$16384\$8\$1\$/u)
  assert.ok(!encoded.includes('correct horse'))
  assert.equal(await verifyPassword('correct horse battery', encoded), true)
  assert.equal(await verifyPassword('correct horse batterx', encoded), false)
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false)
  assert.equal(await verifyPassword('anything', 'scrypt$1$1$1$AA$AA'), false)
})

test('account names are canonical and admin is reserved', () => {
  assert.equal(normalizeAccount('  Alice.Wang '), 'alice.wang')
  assert.equal(normalizeAccount('a'), null)
  assert.equal(normalizeAccount('../etc'), null)
  assert.equal(normalizeAccount('local:alice'), null)
  assert.throws(() => requireAccount('admin'), (error) => error.code === 'reserved_account')
})

test('an admin creates an account and the member signs in without any other system', async () => {
  const created = await api('POST', '/api/v1/members', {
    body: { account: 'Alice', displayName: '测试 Alice', role: 'operator' },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.member.principalId, 'local:alice')
  assert.equal(created.body.member.role, 'operator')
  assert.equal(created.body.member.local.mustChangePassword, true)
  assert.equal(typeof created.body.initialPassword, 'string')
  assert.ok(!JSON.stringify(created.body.member).includes('passwordHash'))

  const signedIn = await login('alice', created.body.initialPassword)
  assert.equal(signedIn.status, 200)
  assert.match(signedIn.body.token, /^rig_s1_/u)
  assert.equal(signedIn.body.member.kind, 'local')
  assert.equal(signedIn.body.member.mustChangePassword, true)
  assert.match(signedIn.headers.get('set-cookie'), /Max-Age=43200/u)

  const me = await api('GET', '/api/v1/auth/me', { token: signedIn.body.token })
  assert.equal(me.status, 200)
  assert.equal(me.body.member.kind, 'local')
  assert.equal(me.body.member.id, 'local:alice')
  assert.equal(me.body.member.role, 'operator')

  // The session cookie authenticates the same way as the bearer token.
  const cookie = signedIn.headers.get('set-cookie').split(';')[0]
  assert.equal((await api('GET', '/api/v1/auth/me', { token: null, cookie })).status, 200)

  // Operator, not admin: the account grants exactly its role.
  assert.equal((await api('GET', '/api/v1/members', { token: signedIn.body.token })).status, 403)

  const listed = await api('GET', '/api/v1/members')
  const alice = listed.body.members.find((member) => member.principalId === 'local:alice')
  assert.equal(alice.source, 'local')
  assert.equal(alice.local.account, 'alice')
  assert.equal(listed.body.federated, false)

  const duplicate = await api('POST', '/api/v1/members', { body: { account: 'alice', role: 'viewer' } })
  assert.equal(duplicate.status, 409)
})

test('wrong passwords and unknown accounts get the same answer', async () => {
  await api('POST', '/api/v1/members', { body: { account: 'bob', role: 'viewer', password: 'bob-password-1' } })
  const wrong = await login('bob', 'not-the-password')
  const unknown = await login('nobody', 'not-the-password')
  assert.equal(wrong.status, 401)
  assert.equal(unknown.status, 401)
  assert.equal(wrong.body.error.code, unknown.body.error.code)
  assert.equal(wrong.body.error.message, unknown.body.error.message)
  assert.equal((await login('bob', 'bob-password-1')).status, 200)
})

test('repeated failures lock the account for a while', async () => {
  await api('POST', '/api/v1/members', { body: { account: 'carol', role: 'viewer', password: 'carol-password-1' } })
  for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) {
    assert.equal((await login('carol', 'wrong-password-x')).status, 401)
  }
  const locked = await login('carol', 'carol-password-1')
  assert.equal(locked.status, 429)
  assert.equal(locked.body.error.code, 'account_locked')
  assert.ok(LOCKOUT_MS >= 60_000)
})

test('changing a password keeps this session and ends the others', async () => {
  await api('POST', '/api/v1/members', { body: { account: 'dave', role: 'viewer', password: 'dave-password-1' } })
  const first = (await login('dave', 'dave-password-1')).body.token
  const second = (await login('dave', 'dave-password-1')).body.token

  const weak = await api('POST', '/api/v1/auth/password', {
    token: first,
    body: { current: 'dave-password-1', next: 'short' },
  })
  assert.equal(weak.status, 400)
  const wrongCurrent = await api('POST', '/api/v1/auth/password', {
    token: first,
    body: { current: 'not-current-1', next: 'dave-password-2' },
  })
  assert.equal(wrongCurrent.status, 401)

  const changed = await api('POST', '/api/v1/auth/password', {
    token: first,
    body: { current: 'dave-password-1', next: 'dave-password-2' },
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.revokedSessions, 1)
  assert.equal(changed.body.local.mustChangePassword, false)
  assert.equal((await api('GET', '/api/v1/auth/me', { token: first })).status, 200)
  assert.equal((await api('GET', '/api/v1/auth/me', { token: second })).status, 401)
  assert.equal((await login('dave', 'dave-password-1')).status, 401)
  assert.equal((await login('dave', 'dave-password-2')).status, 200)

  // The service admin token is not a Rig account and has no password here.
  const service = await api('POST', '/api/v1/auth/password', {
    body: { current: ADMIN_TOKEN, next: 'whatever-password' },
  })
  assert.equal(service.status, 409)
})

test('logout, reset and disable all end sessions on the server', async () => {
  await api('POST', '/api/v1/members', { body: { account: 'erin', role: 'viewer', password: 'erin-password-1' } })
  const loggedOut = (await login('erin', 'erin-password-1')).body.token
  assert.equal((await api('POST', '/api/v1/auth/logout', { token: loggedOut })).status, 200)
  assert.equal((await api('GET', '/api/v1/auth/me', { token: loggedOut })).status, 401)

  const beforeReset = (await login('erin', 'erin-password-1')).body.token
  const reset = await api('POST', '/api/v1/members/local:erin:resetPassword')
  assert.equal(reset.status, 200)
  assert.equal(reset.body.revokedSessions, 1)
  assert.equal((await api('GET', '/api/v1/auth/me', { token: beforeReset })).status, 401)
  assert.equal((await login('erin', 'erin-password-1')).status, 401)
  const afterReset = (await login('erin', reset.body.initialPassword)).body.token
  assert.equal((await api('GET', '/api/v1/auth/me', { token: afterReset })).status, 200)

  const disabled = await api('PATCH', `/api/v1/members/${encodeURIComponent('local:erin')}`, {
    body: { disabled: true },
  })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.member.local.disabled, true)
  assert.equal((await api('GET', '/api/v1/auth/me', { token: afterReset })).status, 401)
  const refused = await login('erin', reset.body.initialPassword)
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error.code, 'member_disabled')

  await api('PATCH', '/api/v1/members/local:erin', { body: { disabled: false } })
  assert.equal((await login('erin', reset.body.initialPassword)).status, 200)

  const unknownField = await api('PATCH', '/api/v1/members/local:erin', { body: { password: 'x' } })
  assert.equal(unknownField.status, 400)
})

test('an expired session is refused', async () => {
  const store = new MemoryStore()
  const { createIdentity } = await import('../server/identity/index.mjs')
  const identity = createIdentity({
    store,
    config: { launcher: {}, adminToken: null, defaultMemberRole: 'viewer', sessionTtlMs: 1 },
    logger: null,
  })
  await identity.createLocalMember({ account: 'frank', role: 'viewer', password: 'frank-password-1' })
  const { token } = await identity.login({ username: 'frank', password: 'frank-password-1' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(identity.resolve(token), (error) => error.status === 401)
})

test('role changes and account administration are audited without secrets', async () => {
  const { body } = await api('GET', '/api/v1/audit?limit=100')
  const actions = body.events.map((event) => event.action)
  for (const action of ['member.local_create', 'member.password_change', 'member.password_reset', 'member.disable']) {
    assert.ok(actions.includes(action), `missing audit ${action}`)
  }
  const serialized = JSON.stringify(body.events)
  assert.ok(!serialized.includes('password-1'))
  assert.ok(!serialized.includes('scrypt$'))
})
