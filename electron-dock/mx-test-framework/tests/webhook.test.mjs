import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test, { after, before } from 'node:test'

import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'
import { parsePush, taskBranch, verifySignature } from '../server/webhooks.mjs'

// The webhook endpoint is the only unauthenticated route in the platform, so
// these tests are written from that starting point: the request is hostile
// until the signature says otherwise, and even then the payload is a hint about
// *which* task to run, never an instruction about *what* to run.

const ADMIN_TOKEN = 'test-admin-token'
const KEY_HEX = 'c'.repeat(64)
const HOOK_SECRET = 'webhook-shared-secret'
const SHA = '1'.repeat(40)
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

/** Deliver a payload the way GitHub would. */
const deliver = async (payload, { event = 'push', secret = HOOK_SECRET, app = 'luopan' } = {}) => {
  const raw = JSON.stringify(payload)
  const response = await fetch(`${base}/webhooks/v1/git/${app}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const pushPayload = (branch, gitSha) => ({
  ref: `refs/heads/${branch}`,
  after: gitSha,
  pusher: { name: 'someone' },
  head_commit: { message: 'fix: 修复登录跳转\n\n详细说明' },
  repository: { clone_url: 'https://github.com/attacker/evil' },
})

before(async () => {
  runtime = await start(
    loadConfig({
      MXT_STORE: 'memory',
      MXT_ADMIN_TOKEN: ADMIN_TOKEN,
      MXT_PORT: '0',
      MXT_SECRET_KEY: KEY_HEX,
      MXT_PUBLIC_URL: 'http://mxt.internal:30879',
    }),
    { schedule: false },
  )
  base = `http://127.0.0.1:${runtime.port}`

  await api('POST', '/api/v1/apps', {
    body: {
      slug: 'luopan',
      displayName: '罗盘',
      repoUrl: 'https://github.com/mingxiinfo/po-frontend',
      defaultBranch: 'public',
      surfaces: ['web'],
    },
  })
  await api('POST', '/api/v1/apps/luopan/suites', {
    body: {
      slug: 'web',
      displayName: 'web',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'server',
      targetMode: 'self',
      command: ['pnpm', 'e2e:local'],
    },
  })
  await api('PUT', '/api/v1/apps/luopan/webhook-secret', { body: { secret: HOOK_SECRET } })
})

after(async () => {
  await runtime.close()
})

async function webhookTask(name) {
  const created = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'luopan',
      suite: 'web',
      name,
      profile: 'mock',
      track: 'functional',
      schedule: { kind: 'webhook' },
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return created.body.task
}

// -- the signature is the authentication --------------------------------------

test('an unsigned or wrongly signed delivery is refused', async () => {
  const raw = JSON.stringify(pushPayload('public', SHA))
  for (const headers of [
    { 'x-github-event': 'push' },
    { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=deadbeef' },
    { 'x-github-event': 'push', 'x-hub-signature-256': 'garbage' },
  ]) {
    const response = await fetch(`${base}/webhooks/v1/git/luopan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    })
    assert.equal(response.status, 401, JSON.stringify(headers))
  }
})

test('a delivery signed with the wrong secret is refused', async () => {
  const result = await deliver(pushPayload('public', SHA), { secret: 'not-the-secret' })
  assert.equal(result.status, 401)
})

test('an app with no secret configured refuses everything', async () => {
  // Fail closed. An unsigned endpoint is a public "run the registered jobs"
  // button, and a missing secret must be visible at configuration time rather
  // than silently permissive forever.
  await api('POST', '/api/v1/apps', {
    body: { slug: 'no-hook', displayName: 'x', surfaces: ['web'] },
  })
  const result = await deliver(pushPayload('main', SHA), { app: 'no-hook' })
  assert.equal(result.status, 401)
  assert.match(result.body.error.message, /未配置 webhook 密钥/u)
})

test('the signature is checked against the exact bytes sent', () => {
  // Parsing and re-serialising would verify a different string — key order,
  // whitespace, unicode escaping — and no real delivery would ever match.
  // Pretty-printed with a non-ASCII value: JSON.stringify would drop the
  // spacing and normalise the escaping, producing different bytes.
  const raw = Buffer.from(JSON.stringify({ a: 1, b: '中' }, null, 2))
  const signature = `sha256=${createHmac('sha256', 'k').update(raw).digest('hex')}`
  assert.equal(verifySignature({ body: raw, signature, secret: 'k' }), true)
  // Same object, different bytes — whitespace and escaping are not preserved.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString())))
  assert.notEqual(reserialised.toString(), raw.toString())
  assert.throws(() => verifySignature({ body: reserialised, signature, secret: 'k' }), /不匹配/u)
})

// -- unrelated events are ignored, not rejected --------------------------------

test('a ping is answered so the provider shows a green tick', async () => {
  const result = await deliver({ zen: 'hello' }, { event: 'ping' })
  assert.equal(result.status, 200)
  assert.equal(result.body.pong, true)
})

test('events nobody asked about are ignored quietly', async () => {
  // An endpoint that 4xx's on every star and comment turns the provider's UI
  // red and gets the whole hook switched off by whoever notices.
  for (const event of ['star', 'issue_comment', 'pull_request']) {
    const result = await deliver({ action: 'created' }, { event })
    assert.equal(result.status, 200, event)
    assert.equal(result.body.ignored, true)
  }
})

test('tag pushes and branch deletions produce nothing to test', () => {
  assert.equal(parsePush({ event: 'push', payload: { ref: 'refs/tags/v1', after: SHA } }), null)
  assert.equal(
    parsePush({ event: 'push', payload: { ref: 'refs/heads/main', after: '0'.repeat(40) } }),
    null,
  )
  assert.equal(parsePush({ event: 'push', payload: { ref: 'refs/heads/main', after: 'nope' } }), null)
})

// -- what actually fires -------------------------------------------------------

test('a push to the tested branch creates a run pinned to that commit', async () => {
  const task = await webhookTask('on-merge')
  const result = await deliver(pushPayload('public', SHA))
  assert.equal(result.status, 202)
  assert.equal(result.body.runs.length, 1)

  const run = await api('GET', `/api/v1/runs/${result.body.runs[0]}`)
  // The entire value of triggering on a push: this result belongs to exactly
  // that sha, not to whatever the branch tip becomes before a machine picks it
  // up.
  assert.equal(run.body.run.sourceRef.gitSha, SHA)
  assert.equal(run.body.run.sourceRef.ref, 'public')
  assert.equal(run.body.run.trigger, 'webhook')
  assert.equal(run.body.run.taskId, task.id)
})

test('a push to a branch the task does not test fires nothing', async () => {
  // A task that runs on a push to one branch while testing another is a trap,
  // so the two are the same value by construction.
  const result = await deliver(pushPayload('some-feature-branch', '2'.repeat(40)))
  assert.equal(result.status, 202)
  assert.deepEqual(result.body.runs, [])
})

test('manual and cron tasks do not react to pushes', async () => {
  await api('POST', '/api/v1/tasks', {
    body: {
      app: 'luopan',
      suite: 'web',
      name: 'nightly',
      profile: 'mock',
      track: 'functional',
      schedule: { kind: 'cron', cronExpr: '0 2 * * *' },
    },
  })
  const result = await deliver(pushPayload('public', '3'.repeat(40)))
  // Only the webhook task, not the cron one.
  assert.equal(result.body.runs.length, 1)
})

test('a retried delivery does not create a second run', async () => {
  // Providers retry, and the same sha can arrive twice by other routes too.
  const sha = '4'.repeat(40)
  const first = await deliver(pushPayload('public', sha))
  const second = await deliver(pushPayload('public', sha))
  assert.equal(first.body.runs.length, 1)
  assert.deepEqual(second.body.runs, [], '重复投递不该再建一次 run')
})

// -- the payload is never an instruction ---------------------------------------

test('the repository in the payload is never used', async () => {
  // A delivery naming another repo would otherwise be a way to make the
  // platform fetch and execute someone else's code. The signature makes that
  // unlikely; not reading the field makes it impossible.
  const sha = '5'.repeat(40)
  const result = await deliver({
    ...pushPayload('public', sha),
    repository: { clone_url: 'https://github.com/attacker/evil', full_name: 'attacker/evil' },
  })
  const run = await api('GET', `/api/v1/runs/${result.body.runs[0]}`)
  const app = await runtime.store.getApp(run.body.run.appId)
  assert.equal(app.repoUrl, 'https://github.com/mingxiinfo/po-frontend')
  assert.ok(!JSON.stringify(run.body.run).includes('attacker'))
})

test('the branch a task reacts to is the branch it would check out', () => {
  assert.equal(taskBranch({ suite: { defaultBranch: 'qa' }, app: { defaultBranch: 'public' } }), 'qa')
  assert.equal(taskBranch({ suite: {}, app: { defaultBranch: 'public' } }), 'public')
  assert.equal(taskBranch({ suite: {}, app: {} }), null)
})

// -- setup ergonomics ----------------------------------------------------------

test('setting the secret hands back the URL to paste into the provider', async () => {
  const result = await api('PUT', '/api/v1/apps/luopan/webhook-secret', {
    body: { secret: 'rotated-secret-value' },
  })
  assert.equal(result.body.url, 'http://mxt.internal:30879/webhooks/v1/git/luopan')
  // Rotating takes effect immediately; the old secret stops working.
  assert.equal((await deliver(pushPayload('public', '6'.repeat(40)))).status, 401)
  assert.equal(
    (await deliver(pushPayload('public', '6'.repeat(40)), { secret: 'rotated-secret-value' })).status,
    202,
  )
})

test('the secret never comes back out, and the audit records only that it was set', async () => {
  const audit = await api('GET', '/api/v1/audit?resource=app')
  const serialized = JSON.stringify(audit.body)
  assert.ok(!serialized.includes('rotated-secret-value'))
  assert.ok(!serialized.includes(HOOK_SECRET))
  const apps = await api('GET', '/api/v1/apps')
  assert.ok(!JSON.stringify(apps.body).includes('rotated-secret-value'))
})
