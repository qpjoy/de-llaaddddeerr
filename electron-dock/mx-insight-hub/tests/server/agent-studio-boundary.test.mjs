import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'agent-studio-boundary-admin-token'
const DRAFT_ID = '11111111-1111-4111-8111-111111111111'
const TEXT_EXTENSIONS = new Set(['.cjs', '.cmd', '.js', '.jsx', '.json', '.mjs', '.sh', '.ts', '.tsx'])

async function withServer(app, operation) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await operation(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function sourceFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

async function requestJson(baseUrl, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { response, payload: await response.json() }
}

test('Agent Studio Admin paths fail closed on the public listener before identity resolution', async () => {
  let identityCalls = 0
  const app = createApp({
    service: {},
    store: new MemoryStore(),
    adapter: {},
    adminToken: ADMIN_TOKEN,
    listenerMode: 'public',
    identity: {
      enabled: true,
      async resolve() {
        identityCalls += 1
        throw new Error('public listener must not resolve an Admin credential')
      },
    },
    logger: { error() {} },
  })

  await withServer(app, async (baseUrl) => {
    for (const [method, path] of [
      ['GET', '/internal/v1/admin/agent-studio/node-types'],
      ['GET', '/internal/v1/admin/agent-studio/projects'],
      ['POST', '/internal/v1/admin/agent-studio/projects'],
      ['PUT', '/internal/v1/admin/agent-studio/projects/example'],
      ['POST', '/internal/v1/admin/agent-studio/projects/example/drafts/draft-1/compile'],
    ]) {
      const response = await fetch(baseUrl + path, {
        method,
        headers: {
          'x-mx-insight-admin-token': ADMIN_TOKEN,
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(method === 'GET' ? {} : { body: '{}' }),
      })
      assert.equal(response.status, 404, `${method} ${path}`)
      assert.equal((await response.json()).error.code, 'not_found', `${method} ${path}`)
    }
  })

  assert.equal(identityCalls, 0)
})

test('Agent Studio enforces platform-admin reads and admin-token-only mutations', async () => {
  const identityCalls = []
  const storeCalls = []
  const platformToken = 'launcher-platform-admin-session'
  const scopedToken = 'launcher-scoped-session'
  const project = { agentKey: 'boundary-agent', displayName: 'Boundary Agent' }
  const draft = { agentKey: project.agentKey, draftId: DRAFT_ID, revision: 2 }
  const artifact = { artifactId: '22222222-2222-4222-8222-222222222222', ...draft }
  const agentStudio = {
    async listProjects() {
      storeCalls.push(['listProjects'])
      return [project]
    },
    async createProject(input, options) {
      storeCalls.push(['createProject', input, options])
      return { project, draft: null }
    },
    async updateProject(agentKey, input, options) {
      storeCalls.push(['updateProject', agentKey, input, options])
      return { ...project, revision: input.expectedRevision + 1, archived: input.archived ?? false }
    },
    async createDraft(agentKey, input, options) {
      storeCalls.push(['createDraft', agentKey, input, options])
      return draft
    },
    async updateDraft(agentKey, draftId, input, options) {
      storeCalls.push(['updateDraft', agentKey, draftId, input, options])
      return draft
    },
    async compileDraft(agentKey, draftId, input, options) {
      storeCalls.push(['compileDraft', agentKey, draftId, input, options])
      return artifact
    },
  }
  const principal = (platformAdmin) => ({
    kind: 'launcher-user',
    memberId: platformAdmin ? 'member-platform-admin' : 'member-scoped',
    displayName: platformAdmin ? 'Platform Admin' : 'Scoped User',
    platformAdmin,
    tenantIds: platformAdmin ? null : ['tenant-boundary'],
    // Deliberately grant the scoped user the route's UI capability: it still
    // must not become a platform reader or a Hub admin-token writer.
    capabilities: ['membership.write'],
    memberships: [],
  })
  const app = createApp({
    service: {},
    store: new MemoryStore(),
    adapter: {},
    adminToken: ADMIN_TOKEN,
    listenerMode: 'admin',
    agentStudio,
    identity: {
      enabled: true,
      async resolve(token) {
        identityCalls.push(token)
        if (token === platformToken) return principal(true)
        if (token === scopedToken) return principal(false)
        return null
      },
    },
    logger: { error() {} },
  })

  await withServer(app, async (baseUrl) => {
    const unauthenticated = await requestJson(
      baseUrl,
      '/internal/v1/admin/agent-studio/node-types',
    )
    assert.equal(unauthenticated.response.status, 401)
    assert.equal(unauthenticated.payload.error.code, 'admin_auth_required')

    const scopedRead = await requestJson(
      baseUrl,
      '/internal/v1/admin/agent-studio/node-types',
      { token: scopedToken },
    )
    assert.equal(scopedRead.response.status, 403)
    assert.equal(scopedRead.payload.error.code, 'platform_admin_required')

    const platformNodeTypes = await requestJson(
      baseUrl,
      '/internal/v1/admin/agent-studio/node-types',
      { token: platformToken },
    )
    assert.equal(platformNodeTypes.response.status, 200)
    assert.ok(Array.isArray(platformNodeTypes.payload.data.items))
    assert.ok(platformNodeTypes.payload.data.items.length > 0)

    const platformProjects = await requestJson(
      baseUrl,
      '/internal/v1/admin/agent-studio/projects',
      { token: platformToken },
    )
    assert.equal(platformProjects.response.status, 200)
    assert.deepEqual(platformProjects.payload.data, [project])

    for (const capability of ['evals', 'eval-suites']) {
      const unavailable = await requestJson(
        baseUrl,
        `/internal/v1/admin/agent-studio/${capability}`,
        { token: platformToken },
      )
      assert.equal(unavailable.response.status, 501, capability)
      assert.equal(unavailable.payload.error.code, 'agent_studio_phase_unavailable', capability)
    }

    const writeCases = [
      ['POST', '/internal/v1/admin/agent-studio/projects'],
      ['PUT', `/internal/v1/admin/agent-studio/projects/${project.agentKey}`],
      ['POST', `/internal/v1/admin/agent-studio/projects/${project.agentKey}/drafts`],
      ['PUT', `/internal/v1/admin/agent-studio/projects/${project.agentKey}/drafts/${DRAFT_ID}`],
      ['POST', `/internal/v1/admin/agent-studio/projects/${project.agentKey}/drafts/${DRAFT_ID}/compile`],
    ]
    for (const token of [platformToken, scopedToken]) {
      for (const [method, path] of writeCases) {
        const denied = await requestJson(baseUrl, path, { token, method, body: {} })
        assert.equal(denied.response.status, 403, `${method} ${path}`)
        assert.equal(denied.payload.error.code, 'admin_token_required', `${method} ${path}`)
      }
    }
    assert.deepEqual(storeCalls, [['listProjects']])

    const created = await requestJson(
      baseUrl,
      '/internal/v1/admin/agent-studio/projects',
      {
        token: ADMIN_TOKEN,
        method: 'POST',
        body: { agentKey: project.agentKey, displayName: project.displayName },
      },
    )
    assert.equal(created.response.status, 201)

    const managed = await requestJson(
      baseUrl,
      `/internal/v1/admin/agent-studio/projects/${project.agentKey}`,
      {
        token: ADMIN_TOKEN,
        method: 'PUT',
        body: { expectedRevision: 1, archived: true },
      },
    )
    assert.equal(managed.response.status, 200)
    assert.equal(managed.payload.data.archived, true)

    const drafted = await requestJson(
      baseUrl,
      `/internal/v1/admin/agent-studio/projects/${project.agentKey}/drafts`,
      { token: ADMIN_TOKEN, method: 'POST', body: { templateKey: 'starter-governed-agent' } },
    )
    assert.equal(drafted.response.status, 201)

    const updated = await requestJson(
      baseUrl,
      `/internal/v1/admin/agent-studio/projects/${project.agentKey}/drafts/${DRAFT_ID}`,
      { token: ADMIN_TOKEN, method: 'PUT', body: { expectedRevision: 1, definition: {} } },
    )
    assert.equal(updated.response.status, 200)

    const compiled = await requestJson(
      baseUrl,
      `/internal/v1/admin/agent-studio/projects/${project.agentKey}/drafts/${DRAFT_ID}/compile`,
      { token: ADMIN_TOKEN, method: 'POST', body: { expectedRevision: 2 } },
    )
    assert.equal(compiled.response.status, 201)
    assert.deepEqual(compiled.payload.data, artifact)
  })

  assert.ok(identityCalls.includes(platformToken))
  assert.ok(identityCalls.includes(scopedToken))
  assert.equal(identityCalls.includes(ADMIN_TOKEN), false)
  assert.deepEqual(storeCalls.map(([method]) => method), [
    'listProjects',
    'createProject',
    'updateProject',
    'createDraft',
    'updateDraft',
    'compileDraft',
  ])
  for (const call of storeCalls.slice(1)) {
    assert.equal(call.at(-1).updatedBy, 'admin-token')
  }
})

test('SessionGate and Launcher exchange/introspection keep the existing Hub contract', async () => {
  const [appSource, apiSource, launcherSource] = await Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../../server/identity/launcher-client.mjs', import.meta.url), 'utf8'),
  ])
  const sessionGate = appSource.slice(
    appSource.indexOf('function SessionGate('),
    appSource.indexOf('\nexport function App()'),
  )

  assert.match(appSource, /const SESSION_KEY = 'mx-insight-hub\.admin-token'/u)
  assert.match(sessionGate, /adminApi\.signInOptions\(\)\.then\(setOptions\)/u)
  assert.match(sessionGate, /signInWithLauncher\(\{[\s\S]*?username:[\s\S]*?password:/u)
  assert.doesNotMatch(sessionGate, /agent[- ]studio/iu)
  assert.match(appSource, /adminApi\.session\(token\)/u)
  assert.match(appSource, /adminApi\.session\(candidate\)/u)

  assert.match(apiSource, /fetch\(`\$\{API_BASE\}\$\{ADMIN_ROOT\}\/sign-in`/u)
  assert.match(apiSource, /session: \(token\) => request\(token, `\$\{ADMIN_ROOT\}\/session`\)/u)
  assert.match(launcherSource, /\/internal\/v1\/user-center\/token\/introspect/u)
  assert.match(launcherSource, /\/internal\/v1\/sdk\/oauth\/token/u)
  assert.match(launcherSource, /body: JSON\.stringify\(\{ token, audience: this\.audience \}\)/u)
  assert.match(launcherSource, /grant_type: 'password',[\s\S]*?audience: this\.audience/u)
  assert.doesNotMatch(launcherSource, /agent[- ]studio/iu)
})

test('Agent Studio UI reuses the platform-admin route gate and the shared Admin request client', async () => {
  const [appSource, apiSource] = await Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
  ])
  const route = appSource.match(/\{ path: '\/agent\/studio',[^\n]+\}/u)?.[0] || ''
  const api = apiSource.slice(
    apiSource.indexOf('  agentStudioNodeTypes:'),
    apiSource.indexOf('  updateAgentProviders:'),
  )

  assert.match(route, /platformAdmin: true/u)
  assert.doesNotMatch(route, /adminTokenOnly/u)
  assert.match(route, /capability: 'membership\.write'/u)
  assert.match(api, /agent-studio\/node-types/u)
  assert.match(api, /agent-studio\/projects/u)
  assert.match(api, /method: 'PUT'/u)
  assert.match(api, /\/compile`/u)
  assert.doesNotMatch(api, /fetch\(|sign-in|launcher/iu)
})

test('Agent Studio has no runtime hook in MX-H2I login/network or HDO/WireGuard code', async () => {
  const roots = [
    new URL('../../../mx-launcher/demos/mx-h2i/src/', import.meta.url),
    new URL('../../../mx-launcher/demos/mx-h2i/scripts/', import.meta.url),
    new URL('../../../../electron-plugin/packages/electron-core-wireguard/src/', import.meta.url),
    new URL('../../../../electron-plugin/packages/electron-plugin-hdo/src/', import.meta.url),
    new URL('../../../../electron-demo/hdo/src/', import.meta.url),
    new URL('../../../../electron-server/src/', import.meta.url),
  ].map(fileURLToPath)

  const matches = []
  for (const root of roots) {
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, 'utf8')
      if (/agent[- ]studio|\/agent\/studio/iu.test(source)) matches.push(path)
    }
  }
  assert.deepEqual(matches, [])
})
