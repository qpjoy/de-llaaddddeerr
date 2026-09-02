import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'
import {
  decryptSecret,
  encryptSecret,
  loadSecretKey,
  redactValues,
  resolveSuiteSecrets,
  secretName,
} from '../server/secrets.mjs'

const ADMIN_TOKEN = 'test-admin-token'
const KEY_HEX = 'a'.repeat(64)
const KEY = Buffer.from(KEY_HEX, 'hex')
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
    loadConfig({
      MXT_STORE: 'memory',
      MXT_ADMIN_TOKEN: ADMIN_TOKEN,
      MXT_PORT: '0',
      MXT_SECRET_KEY: KEY_HEX,
    }),
    { schedule: false },
  )
  base = `http://127.0.0.1:${runtime.port}`
  await api('POST', '/api/v1/apps', {
    body: { slug: 'luopan', displayName: '罗盘', surfaces: ['web'] },
  })
})

after(async () => {
  await runtime.close()
})

// -- encryption ---------------------------------------------------------------

test('a value survives a round trip', () => {
  const record = encryptSecret(KEY, 'hunter2-correct-horse')
  assert.equal(decryptSecret(KEY, record), 'hunter2-correct-horse')
  // The ciphertext must not contain the plaintext in any obvious form.
  assert.ok(!record.ciphertext.includes('hunter2'))
})

test('the same value encrypts differently every time', () => {
  // A deterministic ciphertext would let anyone with the table see which
  // accounts share a password.
  const a = encryptSecret(KEY, 'same')
  const b = encryptSecret(KEY, 'same')
  assert.notEqual(a.ciphertext, b.ciphertext)
  assert.notEqual(a.iv, b.iv)
})

test('a tampered row fails loudly instead of decrypting to garbage', () => {
  // GCM authenticates. Without that, a modified row would yield plausible bytes
  // that get injected into a test as a password.
  const record = encryptSecret(KEY, 'value-to-protect')
  const tampered = { ...record, ciphertext: Buffer.from('tampered value here').toString('base64') }
  assert.throws(() => decryptSecret(KEY, tampered))
  const wrongKey = Buffer.from('b'.repeat(64), 'hex')
  assert.throws(() => decryptSecret(wrongKey, record))
})

test('a malformed key is rejected at load, not at first use', () => {
  assert.equal(loadSecretKey({}), null)
  assert.throws(() => loadSecretKey({ MXT_SECRET_KEY: 'too-short' }), /64 位十六进制/u)
  assert.equal(loadSecretKey({ MXT_SECRET_KEY: KEY_HEX }).length, 32)
})

test('names must be usable as environment variables', () => {
  assert.equal(secretName('LUOPAN_TEST_PASSWORD'), 'LUOPAN_TEST_PASSWORD')
  for (const bad of ['lowercase', '1LEADING_DIGIT', 'HAS-DASH', 'HAS SPACE', 'X']) {
    assert.throws(() => secretName(bad), /大写字母/u, bad)
  }
})

// -- the write-only boundary --------------------------------------------------

test('a stored secret can never be read back out', async () => {
  const put = await api('PUT', '/api/v1/apps/luopan/secrets/LUOPAN_TEST_PASSWORD', {
    body: { value: 'super-secret-password', description: '只读测试账号' },
  })
  assert.equal(put.status, 204)

  const listed = await api('GET', '/api/v1/apps/luopan/secrets')
  assert.equal(listed.body.secrets.length, 1)
  assert.equal(listed.body.secrets[0].name, 'LUOPAN_TEST_PASSWORD')
  // Names and descriptions, never values. Anyone who needs the value has it;
  // anyone who does not should not be able to get it back out of the platform.
  assert.ok(!JSON.stringify(listed.body).includes('super-secret-password'))
})

test('setting a secret twice updates rather than duplicating', async () => {
  await api('PUT', '/api/v1/apps/luopan/secrets/ROTATING', { body: { value: 'first-value-x' } })
  await api('PUT', '/api/v1/apps/luopan/secrets/ROTATING', { body: { value: 'second-value-x' } })
  const listed = await api('GET', '/api/v1/apps/luopan/secrets')
  assert.equal(listed.body.secrets.filter((entry) => entry.name === 'ROTATING').length, 1)
  const stored = (await runtime.store.listSecrets((await runtime.store.getAppBySlug('luopan')).id)).find(
    (entry) => entry.name === 'ROTATING',
  )
  assert.equal(decryptSecret(KEY, stored), 'second-value-x')
})

test('the audit trail records the change without the value', async () => {
  const audit = await api('GET', '/api/v1/audit?resource=secret')
  assert.ok(audit.body.events.length > 0)
  assert.ok(!JSON.stringify(audit.body.events).includes('super-secret-password'))
  assert.equal(audit.body.events.at(-1).action, 'secret.put')
})

// -- what a suite gets --------------------------------------------------------

test('a suite gets exactly what it declared and nothing else', async () => {
  const store = runtime.store
  const app = await store.getAppBySlug('luopan')
  const resolved = await resolveSuiteSecrets({
    store,
    key: KEY,
    suite: { secretRefs: ['LUOPAN_TEST_PASSWORD'] },
    appId: app.id,
  })
  assert.deepEqual(Object.keys(resolved), ['LUOPAN_TEST_PASSWORD'])
  assert.equal(resolved.LUOPAN_TEST_PASSWORD, 'super-secret-password')
})

test('a suite declaring nothing gets nothing', async () => {
  const app = await runtime.store.getAppBySlug('luopan')
  assert.deepEqual(
    await resolveSuiteSecrets({ store: runtime.store, key: KEY, suite: { secretRefs: [] }, appId: app.id }),
    {},
  )
})

test('a missing secret is an error, not an omission', async () => {
  // Starting a run without the password it asked for fails inside a login form,
  // and the report then says "element not found" instead of naming the cause.
  const app = await runtime.store.getAppBySlug('luopan')
  await assert.rejects(
    resolveSuiteSecrets({
      store: runtime.store,
      key: KEY,
      suite: { secretRefs: ['NOT_CONFIGURED'] },
      appId: app.id,
    }),
    /NOT_CONFIGURED/u,
  )
})

// -- delivery -----------------------------------------------------------------

test('secrets never appear in the Kubernetes Job manifest', async () => {
  // A manifest is readable by anyone who can run `kubectl get job -o yaml`.
  const { KubernetesDispatcher } = await import('../server/runner/dispatcher.mjs')
  const dispatcher = new KubernetesDispatcher({
    config: loadConfig({ MXT_STORE: 'memory', MXT_SECRET_KEY: KEY_HEX }),
    namespace: 'n',
  })
  const manifest = dispatcher.manifest({
    run: { id: 'trun_1' },
    suite: { slug: 's', engine: 'cypress', command: ['pnpm', 'e2e'], secretRefs: ['LUOPAN_TEST_PASSWORD'] },
    app: { slug: 'luopan' },
    env: {},
    runToken: 'mxt-run-x',
    apiBase: 'http://mxt',
  })
  const serialized = JSON.stringify(manifest)
  assert.ok(!serialized.includes('super-secret-password'))
  assert.ok(!serialized.includes('LUOPAN_TEST_PASSWORD'))
  // Instead the container fetches them with its run-scoped token.
  assert.match(manifest.spec.template.spec.containers[0].args[0], /runs\/\$MXT_RUN_ID\/secrets/u)
})

test('the container puts secrets in the test process env, not the shell env', async () => {
  const { KubernetesDispatcher } = await import('../server/runner/dispatcher.mjs')
  const script = new KubernetesDispatcher({
    config: loadConfig({ MXT_STORE: 'memory' }),
    namespace: 'n',
  }).script({ apiBase: 'http://mxt' })
  // curl writes to a file; the exec wrapper reads it, unlinks it, and merges it
  // into the child's env. /proc/<shell pid>/environ never holds a credential.
  assert.match(script, /-o \/tmp\/mxt-secrets\.json/u)
  assert.match(script, /fs\.unlinkSync\('\/tmp\/mxt-secrets\.json'\)/u)
  assert.ok(!/export .*MXT_SECRET/u.test(script), 'secrets must not be exported into the shell')
})

test('failing to fetch secrets blocks the run rather than running without them', async () => {
  const { KubernetesDispatcher } = await import('../server/runner/dispatcher.mjs')
  const script = new KubernetesDispatcher({
    config: loadConfig({ MXT_STORE: 'memory' }),
    namespace: 'n',
  }).script({ apiBase: 'http://mxt' })
  assert.match(script, /blocked "无法获取被测应用的密钥"/u)
})

// -- redaction by exact value -------------------------------------------------

test('an issued value is removed from results wherever it appears', () => {
  // The pattern-based redactor in core/redact.mjs cannot catch this, because
  // nothing about the text says "password".
  const text = 'login failed for user qa with super-secret-password at line 9'
  assert.equal(
    redactValues(text, ['super-secret-password']),
    'login failed for user qa with [REDACTED_SECRET] at line 9',
  )
})

test('very short values are left alone', () => {
  // Redacting every occurrence of a three-character password would corrupt
  // unrelated text and make the report unreadable — its own kind of failure.
  assert.equal(redactValues('the cat sat on the mat', ['cat']), 'the cat sat on the mat')
})

test('redaction handles absent input without throwing', () => {
  assert.equal(redactValues(null, ['x']), null)
  assert.equal(redactValues('', ['x']), '')
  assert.equal(redactValues('text', []), 'text')
})

test('a runner long-lived token cannot fetch credentials', async () => {
  // ADR-0005's argument is that a run-scoped, self-expiring token keeps the
  // blast radius at "this one execution". Accepting the runner's long-lived
  // token here would hand that back: a leaked runner token would be enough to
  // read the test account's password at any time.
  const registered = await api('POST', '/runner/v1/runners:register', {
    body: { name: 'r', os: 'linux', engines: ['cypress'], surfaces: ['web'] },
  })
  await api('POST', '/api/v1/apps/luopan/suites', {
    body: {
      slug: 'real',
      displayName: 'real',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'local',
      targetMode: 'self',
      command: ['pnpm', 'e2e'],
      secretRefs: ['LUOPAN_TEST_PASSWORD'],
    },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: { app: 'luopan', suite: 'real', name: 'real-run', profile: 'real', track: 'functional' },
  })
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  const claimed = await api('POST', '/runner/v1/runs:claim', { token: registered.body.token })

  const withRunToken = await api('GET', `/runner/v1/runs/${run.body.run.id}/secrets`, {
    token: claimed.body.runToken,
  })
  assert.equal(withRunToken.status, 200)
  assert.equal(withRunToken.body.secrets.LUOPAN_TEST_PASSWORD, 'super-secret-password')

  for (const token of [registered.body.token, ADMIN_TOKEN]) {
    const refused = await api('GET', `/runner/v1/runs/${run.body.run.id}/secrets`, { token })
    assert.equal(refused.status, 403, '只有本次执行的 run token 能取密钥')
  }
})
