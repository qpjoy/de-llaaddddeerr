import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../../server/app.mjs'
import { runtimeVisibleProjection } from '../../server/runtime-visibility.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ADMIN_TOKEN = 'runtime-admin-token-with-enough-entropy'
const LAUNCHER_TOKEN = 'launcher-runtime-session'
const PRIVATE_DETAIL = 'Night-All via TikHub at http://provider.internal/api/v1/health'

async function withRuntimeServer(operation, { adapterDependencies = null } = {}) {
  const app = createApp({
    service: {},
    store: { async ping() {} },
    adapter: {
      dependencies: adapterDependencies || (async () => {
        assert.fail('Runtime and health endpoints must not probe Night-All')
      }),
    },
    adminToken: ADMIN_TOKEN,
    identity: {
      enabled: true,
      async resolve(token) {
        if (token !== LAUNCHER_TOKEN) return null
        return {
          kind: 'launcher-user',
          memberId: 'member-runtime',
          displayName: 'Runtime tenant',
          platformAdmin: false,
          tenantIds: ['tenant-runtime'],
          capabilities: ['usage.read'],
          memberships: [],
        }
      },
    },
    listenerMode: 'combined',
    logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await operation(baseUrl)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { 'x-mx-insight-admin-token': token } : {},
  })
  return { response, payload: await response.json() }
}

function assertProviderNeutral(value) {
  const serialized = JSON.stringify(value)
  assert.doesNotMatch(serialized, /night[\s._-]*all|tik[\s._-]*hub|justone/iu)
  assert.doesNotMatch(serialized, /https?:\/\/|\/api\/v1\/|provider\.internal/iu)
  assert.doesNotMatch(serialized, /"(?:detail|endpoint|provider(?:Key)?)"/iu)
  const dependencies = value.dependencies ?? value
  assert.equal(Object.hasOwn(dependencies?.dataService || {}, 'detail'), false)
  assert.equal(Object.hasOwn(dependencies?.store || {}, 'detail'), false)
}

test('safe Runtime readiness treats external data services as diagnostic-only dependencies', () => {
  const dependencies = {
    store: { status: 'up' },
    nightAll: { status: 'down', detail: PRIVATE_DETAIL },
  }

  const admin = runtimeVisibleProjection({ listenerMode: 'admin', dependencies })
  const combined = runtimeVisibleProjection({ listenerMode: 'combined', dependencies })

  assert.equal(admin.status.ready, 'ready')
  assert.equal(combined.status.ready, 'ready')
  assert.equal(combined.dependencies.dataService.status, 'down')
  assertProviderNeutral(admin)
  assertProviderNeutral(combined)
})

test('Runtime reports unprobed provider-neutral data service state and forces launcher sessions safe', async () => {
  await withRuntimeServer(async (baseUrl) => {
    const raw = await call(baseUrl, '/internal/v1/admin/runtime', ADMIN_TOKEN)
    assert.equal(raw.response.status, 200)
    assert.equal(raw.payload.data.listenerMode, 'combined')
    assert.deepEqual(raw.payload.data.dependencies, {
      store: { status: 'up' },
      dataService: { status: 'unknown' },
    })

    const adminSafe = await call(baseUrl, '/internal/v1/admin/runtime?presentation=safe', ADMIN_TOKEN)
    assert.equal(adminSafe.response.status, 200)
    assert.deepEqual(adminSafe.payload.data, {
      status: { live: 'live', ready: 'ready' },
      dependencies: {
        store: { status: 'up' },
        dataService: { status: 'unknown' },
      },
    })
    assertProviderNeutral(adminSafe.payload.data)

    const tenantDefault = await call(baseUrl, '/internal/v1/admin/runtime', LAUNCHER_TOKEN)
    assert.equal(tenantDefault.response.status, 200)
    assert.deepEqual(tenantDefault.payload.data, adminSafe.payload.data)
    assertProviderNeutral(tenantDefault.payload.data)

    const tenantRawAttempt = await call(baseUrl, '/internal/v1/admin/runtime?presentation=raw', LAUNCHER_TOKEN)
    assert.equal(tenantRawAttempt.response.status, 400)
    assert.equal(tenantRawAttempt.payload.error.code, 'invalid_runtime_presentation')
  })
})

test('unauthenticated dependency health does not probe optional external data services', async () => {
  let optionalProbeCalls = 0
  await withRuntimeServer(async (baseUrl) => {
    const dependencies = await call(baseUrl, '/health/dependencies')
    assert.equal(dependencies.response.status, 200)
    assertProviderNeutral(dependencies.payload.data)
    assert.deepEqual(dependencies.payload.data, {
      store: { status: 'up' },
      dataService: { status: 'unknown' },
    })

    const ready = await call(baseUrl, '/health/ready')
    assert.equal(ready.response.status, 200)
    assert.equal(ready.payload.data.status, 'ready')
    assert.deepEqual(ready.payload.data.dependencies, { store: { status: 'up' } })
    assertProviderNeutral({ dependencies: ready.payload.data.dependencies })
    assert.equal(optionalProbeCalls, 0)
  }, {
    adapterDependencies: async () => {
      optionalProbeCalls += 1
      return { status: 'down', detail: PRIVATE_DETAIL }
    },
  })
})

test('readiness never starts the optional data-service probe', async () => {
  let optionalProbeCalls = 0
  await withRuntimeServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health/ready`, {
      signal: AbortSignal.timeout(1_000),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(payload.data, {
      status: 'ready',
      dependencies: { store: { status: 'up' } },
    })
    assert.equal(optionalProbeCalls, 0)
  }, {
    adapterDependencies: async () => {
      optionalProbeCalls += 1
      return new Promise(() => {})
    },
  })
})

test('Runtime UI requests only the safe presentation and uses provider-neutral copy', async () => {
  const [apiSource, pagesSource] = await Promise.all([
    readFile(join(ROOT, 'src/api.js'), 'utf8'),
    readFile(join(ROOT, 'src/pages.jsx'), 'utf8'),
  ])
  const runtimeMethod = apiSource.match(/runtime:\s*\(token\)[\s\S]*?\n\s*\),\n\}/u)?.[0] || ''
  const runtimePage = pagesSource.slice(pagesSource.indexOf('export function RuntimePage'))

  assert.match(runtimeMethod, /\$\{ADMIN_ROOT\}\/runtime/u)
  assert.match(runtimeMethod, /presentation:\s*'safe'/u)
  assert.doesNotMatch(runtimeMethod, /health\/dependencies|health\/ready/u)
  assert.match(runtimePage, /dependencies\.dataService/u)
  assert.match(runtimePage, /runtime\.status\?\.ready/u)
  assert.match(runtimePage, /Hub 统一交付数据能力/u)
  assert.match(runtimePage, /使用受保护的 Hub 会话/u)
  assert.doesNotMatch(runtimePage, /Night-All|nightAll|TikHub|tikhub|JustOne/u)
})
