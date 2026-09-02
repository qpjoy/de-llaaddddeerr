import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'

// The handoff between building and testing, over real HTTP.
//
// Jenkins builds a desktop installer and publishes it here; MXT decides on its
// own schedule when to test it. The direction is the point: if publishing also
// started a run, mx-base would be on MXT's critical path.

const ADMIN_TOKEN = 'test-admin-token'
const SHA = 'a'.repeat(64)
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
    body: {
      slug: 'luopan',
      displayName: '罗盘',
      repoUrl: 'https://github.com/mingxiinfo/po-frontend',
      defaultBranch: 'public',
      surfaces: ['web', 'electron'],
    },
  })
  await api('POST', '/api/v1/apps/luopan/suites', {
    body: {
      slug: 'electron-smoke',
      displayName: 'Electron 冒烟',
      engine: 'playwright-electron',
      surface: 'electron',
      runnerKind: 'local',
      workingDir: 'po-frontend',
      targetMode: 'self',
      command: ['pnpm', 'e2e:electron'],
    },
  })
})

after(async () => {
  await runtime.close()
})

async function newElectronRun(name) {
  const task = await api('POST', '/api/v1/tasks', {
    body: { app: 'luopan', suite: 'electron-smoke', name, profile: 'mock', track: 'functional' },
  })
  assert.equal(task.status, 201, JSON.stringify(task.body))
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  assert.equal(run.status, 202)
  return run.body.run
}

test('a published build must carry a real checksum', async () => {
  // The runner downloads this onto someone's own machine and executes it.
  // "Trust the URL" is not an option, so a malformed digest is refused rather
  // than stored and skipped later.
  for (const sha256 of ['tooshort', '', 'z'.repeat(64), `${SHA}00`]) {
    const result = await api('POST', '/api/v1/apps/luopan/packages', {
      body: { url: 'https://artifacts.internal/x.exe', sha256 },
    })
    assert.equal(result.status, 400, `sha256=${sha256}`)
  }
})

test('a published build must have a clean URL', async () => {
  const result = await api('POST', '/api/v1/apps/luopan/packages', {
    body: { url: 'https://user:pass@artifacts.internal/x.exe', sha256: SHA },
  })
  assert.equal(result.status, 400)
})

test('publishing a build does not start a run', async () => {
  const before = await api('GET', '/api/v1/runs?app=luopan')
  const published = await api('POST', '/api/v1/apps/luopan/packages', {
    body: {
      url: 'https://artifacts.internal/Compass-Setup-2.0.1.exe',
      sha256: SHA,
      filename: 'Compass-Setup-2.0.1.exe',
      version: '2.0.1',
      gitSha: 'abc123def456',
    },
  })
  assert.equal(published.status, 201)
  const after_ = await api('GET', '/api/v1/runs?app=luopan')
  assert.equal(after_.body.runs.length, before.body.runs.length)
})

test('an electron run carries the build it was created for', async () => {
  const run = await newElectronRun('electron-a')
  assert.equal(run.appPackage.version, '2.0.1')
  assert.equal(run.appPackage.sha256, SHA)
  // The commit under test comes from the build, not from whatever the branch
  // tip happens to be when a machine finally picks the run up.
  assert.equal(run.sourceRef.gitSha, 'abc123def456')
})

test('a newer build does not rewrite a run that is already waiting', async () => {
  // A desktop run can sit in pending-runner for hours. If it resolved the
  // package at claim time it would silently become a run of a different build,
  // and the result would be attributed to the wrong commit.
  const waiting = await newElectronRun('electron-b')
  await api('POST', '/api/v1/apps/luopan/packages', {
    body: {
      url: 'https://artifacts.internal/Compass-Setup-2.0.2.exe',
      sha256: 'b'.repeat(64),
      version: '2.0.2',
      gitSha: 'ffff0000',
    },
  })
  const reread = await api('GET', `/api/v1/runs/${waiting.id}`)
  assert.equal(reread.body.run.appPackage.version, '2.0.1')
  // A run created after the publish gets the new one.
  const fresh = await newElectronRun('electron-c')
  assert.equal(fresh.appPackage.version, '2.0.2')
})

test('the claim hands a runner everything it needs to reproduce the run', async () => {
  const registered = await api('POST', '/runner/v1/runners:register', {
    body: {
      name: 'my-windows',
      os: 'windows',
      engines: ['playwright-electron'],
      surfaces: ['electron'],
    },
  })
  assert.equal(registered.status, 201, JSON.stringify(registered.body))
  const claimed = await api('POST', '/runner/v1/runs:claim', {
    token: registered.body.token,
  })
  assert.equal(claimed.status, 200)
  const { app, sourceRef, appPackage, suite, command } = claimed.body
  // Repository, ref, project root, command and build — without all five the
  // runner can only execute whatever a person left lying in a directory.
  assert.equal(app.repoUrl, 'https://github.com/mingxiinfo/po-frontend')
  assert.equal(sourceRef, 'public')
  assert.equal(suite.workingDir, 'po-frontend')
  assert.deepEqual(command, ['pnpm', 'e2e:electron'])
  assert.ok(appPackage.sha256)
})

test('a web run gets no package', async () => {
  await api('POST', '/api/v1/apps/luopan/suites', {
    body: {
      slug: 'web-only',
      displayName: 'Web',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'server',
      targetMode: 'self',
      command: ['pnpm', 'e2e:local'],
    },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: { app: 'luopan', suite: 'web-only', name: 'web-a', profile: 'mock', track: 'functional' },
  })
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  assert.equal(run.body.run.appPackage, null)
})
