import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'

const ADMIN_TOKEN = 'onboarding-service-admin-token'
const OPERATOR_TOKEN = 'launcher-operator-token'
let artifactsRoot
let baseUrl
let runtime
let adminCookie
let launcherCalls = 0

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function call(method, path, { body, token, cookie = adminCookie } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  else if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    setCookie: response.headers.get('set-cookie'),
  }
}

before(async () => {
  artifactsRoot = await mkdtemp(join(tmpdir(), 'mxt-onboarding-'))
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_ADMIN_TOKEN: ADMIN_TOKEN,
    MXT_LAUNCHER_URL: 'http://launcher.test',
    MXT_LAUNCHER_AUDIENCE: 'mx-sdk',
    MXT_PORT: '0',
    MXT_ARTIFACTS_DIR: artifactsRoot,
    MXT_INSECURE_COOKIES: 'true',
  })
  config.launcher.fetchImpl = async (url, init) => {
    launcherCalls += 1
    assert.match(url, /\/internal\/v1\/sdk\/identity\/introspect$/u)
    assert.equal(JSON.parse(init.body).token, OPERATOR_TOKEN)
    return json({
      introspection: {
        active: true,
        audience: 'mx-sdk',
        subject: 'user:operator-1',
        principal: { principalId: 'operator-1', displayName: 'Operator One' },
      },
    })
  }
  runtime = await start(config, { schedule: false })
  baseUrl = `http://127.0.0.1:${runtime.port}`
  await runtime.store.upsertMember({
    principalId: 'operator-1',
    displayName: 'Operator One',
    launcherSub: 'user:operator-1',
    role: 'operator',
  })
})

after(async () => {
  if (runtime) await runtime.close()
  if (artifactsRoot) await rm(artifactsRoot, { recursive: true, force: true })
})

test('service admin can sign into the Web UI while Launcher is enabled', async () => {
  const beforeCalls = launcherCalls
  const login = await call('POST', '/api/v1/auth/login', {
    body: { username: 'admin', password: ADMIN_TOKEN },
    cookie: null,
  })
  assert.equal(login.status, 200)
  assert.equal(login.body.member.principalId, 'service-admin')
  assert.equal(login.body.member.role, 'admin')
  assert.match(login.setCookie, /HttpOnly/u)
  assert.equal(launcherCalls, beforeCalls, 'service token must never be sent to Launcher')
  adminCookie = login.setCookie.split(';')[0]

  const me = await call('GET', '/api/v1/auth/me')
  assert.equal(me.status, 200)
  assert.equal(me.body.member.id, 'service-admin')
  assert.equal(me.body.member.role, 'admin')
})

test('a test engineer cannot register or reconcile product templates', async () => {
  const response = await call('POST', '/api/v1/onboarding/compass:reconcile', {
    body: {},
    token: OPERATOR_TOKEN,
    cookie: null,
  })
  assert.equal(response.status, 403)
  assert.equal(launcherCalls, 1)
})

test('Admin onboarding creates the Compass Web configuration without starting a run', async () => {
  const response = await call('POST', '/api/v1/onboarding/compass:reconcile', { body: {} })
  assert.equal(response.status, 200)
  assert.equal(response.body.electronConfigured, false)
  assert.equal(response.body.summary.created.length, 5)
  assert.match(response.body.message, /未启动测试/u)

  const apps = await runtime.store.listApps()
  const app = apps.find((entry) => entry.slug === 'luopan')
  assert.ok(app)
  assert.equal(app.repoUrl, 'https://github.com/mingxiinfo/po-frontend')
  assert.equal(app.defaultBranch, 'public')
  assert.deepEqual((await runtime.store.listSuites(app.id)).map((entry) => entry.slug), [
    'web-demo',
    'web-functional',
  ])
  assert.equal((await runtime.store.listTasks({ appId: app.id })).length, 2)
  assert.equal((await runtime.store.listRuns({ appId: app.id })).length, 0)
})

test('repeating Admin onboarding is idempotent', async () => {
  const response = await call('POST', '/api/v1/onboarding/compass:reconcile', {
    body: {
      webRepoUrl: 'https://example.test/a-different-compass.git',
      webBranch: 'main',
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.summary.created, [])
  assert.deepEqual(response.body.summary.updated, [])
  assert.equal(response.body.summary.warnings.length, 1)

  const app = await runtime.store.getAppBySlug('luopan')
  const suites = await runtime.store.listSuites(app.id)
  assert.equal(suites.length, 2)
  assert.ok(suites.every((suite) => suite.repoUrl === app.repoUrl))
  assert.ok(suites.every((suite) => suite.defaultBranch === app.defaultBranch))
  assert.equal((await runtime.store.listTasks({ appId: app.id })).length, 2)
  assert.equal((await runtime.store.listRuns({ appId: app.id })).length, 0)

  const audits = await runtime.store.listAuditEvents({
    resourceType: 'onboarding',
    appId: app.id,
  })
  const preservedSourceAudit = audits.find((entry) => entry.after?.summary?.warnings?.length === 1)
  assert.equal(preservedSourceAudit.after.webRepoUrl, app.repoUrl)
  assert.equal(preservedSourceAudit.after.webBranch, app.defaultBranch)
})

test('Admin can add the reviewed Electron QA source without exposing a command field', async () => {
  const response = await call('POST', '/api/v1/onboarding/compass:reconcile', {
    body: {
      electronQaRepoUrl: 'https://example.test/qa/compass-electron.git',
      electronBranch: 'main',
      electronWorkingDir: 'packs/compass-electron',
      electronOs: 'windows',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.electronConfigured, true)

  const app = await runtime.store.getAppBySlug('luopan')
  const suites = await runtime.store.listSuites(app.id)
  const electron = suites.find((entry) => entry.slug === 'compass-electron-smoke')
  assert.ok(electron)
  assert.deepEqual(electron.command, ['pnpm', 'test'])
  assert.equal(electron.workingDir, 'packs/compass-electron')
  assert.deepEqual(electron.requirements.os, ['windows'])
  assert.equal((await runtime.store.listTasks({ appId: app.id })).length, 4)
  assert.equal((await runtime.store.listCases(app.id)).filter((entry) => entry.caseId.startsWith('CPS-EL-')).length, 3)
  assert.equal((await runtime.store.listCatalogs(app.id))[0].surface, 'electron')
  assert.equal((await runtime.store.listRuns({ appId: app.id })).length, 0)

  const arbitrary = await call('POST', '/api/v1/onboarding/compass:reconcile', {
    body: { command: ['sh', '-c', 'anything'] },
  })
  assert.equal(arbitrary.status, 400)
})

test('Admin onboarding detects task conflicts before changing any suite', async () => {
  const app = await runtime.store.getAppBySlug('luopan')
  const suites = await runtime.store.listSuites(app.id)
  const electron = suites.find((entry) => entry.slug === 'compass-electron-smoke')
  const conflictingSuite = await runtime.store.createSuite({
    appId: app.id,
    slug: 'conflict-placeholder',
    displayName: 'Conflict placeholder',
    engine: 'playwright-electron',
    surface: 'electron',
    runnerKind: 'local',
    command: ['pnpm', 'test'],
  })
  const tasks = await runtime.store.listTasks({ appId: app.id })
  const bootstrap = tasks.find((entry) => entry.name === 'Compass Electron · 启动冒烟')
  const { id: bootstrapId, createdAt: _createdAt, lastRunId: _lastRunId, ...bootstrapDraft } = bootstrap
  await runtime.store.deleteTask(bootstrapId)
  await runtime.store.createTask({
    ...bootstrapDraft,
    suiteId: conflictingSuite.id,
  })

  const response = await call('POST', '/api/v1/onboarding/compass:reconcile', {
    body: {
      electronQaRepoUrl: 'https://example.test/qa/compass-electron.git',
      electronBranch: 'release-that-must-not-be-applied',
      electronWorkingDir: 'packs/compass-electron',
      electronOs: 'windows',
    },
  })
  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'onboarding_conflict')
  assert.equal((await runtime.store.getSuite(electron.id)).defaultBranch, 'main')
})
