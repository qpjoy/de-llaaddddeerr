import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const smokeScript = fileURLToPath(new URL('../../scripts/smoke.mjs', import.meta.url))
const ecommerceSearchPath = '/api/v1/data/ecommerce/products/search'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

async function runSmoke(environment) {
  const child = spawn(process.execPath, [smokeScript], {
    env: {
      ...process.env,
      MX_SMOKE_DATA: '0',
      MX_INSIGHT_ADMIN_TOKEN: 'smoke-admin-token',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const [code] = await once(child, 'close')
  return { code, stdout, stderr }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

test('smoke checks the configured Public ecommerce route with an exact side-effect-free OPTIONS 204', async () => {
  const adminRequests = []
  const publicRequests = []
  let publicStatus = 204
  const adminServer = createServer((request, response) => {
    adminRequests.push({ method: request.method, url: request.url, headers: request.headers })
    if (request.method === 'GET' && request.url === '/health/live') {
      sendJson(response, 200, { data: { status: 'live' } })
      return
    }
    if (request.method === 'GET' && request.url === '/internal/v1/admin/dashboard') {
      sendJson(response, 200, { data: {} })
      return
    }
    sendJson(response, 500, { error: { code: 'unexpected_admin_request' } })
  })
  const publicServer = createServer((request, response) => {
    publicRequests.push({ method: request.method, url: request.url, headers: request.headers })
    if (request.method !== 'OPTIONS' || request.url !== ecommerceSearchPath) {
      sendJson(response, 500, { error: { code: 'unexpected_public_request' } })
      return
    }
    if (publicStatus === 204) {
      response.writeHead(204)
      response.end()
      return
    }
    sendJson(response, publicStatus, { error: { code: 'wrong_listener' } })
  })
  const [adminBase, publicBase] = await Promise.all([
    listen(adminServer),
    listen(publicServer),
  ])

  try {
    const passed = await runSmoke({
      MX_SMOKE_BASE_URL: adminBase,
      MX_SMOKE_PUBLIC_BASE_URL: `${publicBase}/`,
    })
    assert.equal(passed.code, 0, passed.stderr)
    assert.match(passed.stdout, /MX Insight Hub smoke passed/u)
    assert.deepEqual(
      adminRequests.map(({ method, url }) => ({ method, url })),
      [
        { method: 'GET', url: '/health/live' },
        { method: 'GET', url: '/internal/v1/admin/dashboard' },
      ],
    )
    assert.equal(adminRequests[1].headers['x-mx-insight-admin-token'], 'smoke-admin-token')
    assert.deepEqual(
      publicRequests.map(({ method, url }) => ({ method, url })),
      [{ method: 'OPTIONS', url: ecommerceSearchPath }],
    )
    assert.equal(publicRequests[0].headers.authorization, undefined)
    assert.equal(publicRequests[0].headers['x-api-key'], undefined)
    assert.equal(publicRequests[0].headers['content-length'], undefined)
    assert.equal(publicRequests[0].headers['content-type'], undefined)
    assert.equal(publicRequests[0].headers['access-control-request-method'], 'POST')

    adminRequests.length = 0
    publicRequests.length = 0
    publicStatus = 200
    const rejected = await runSmoke({
      MX_SMOKE_BASE_URL: adminBase,
      MX_SMOKE_PUBLIC_BASE_URL: publicBase,
    })
    assert.notEqual(rejected.code, 0)
    assert.match(rejected.stderr, /expected HTTP 204, got 200/u)
    assert.deepEqual(
      publicRequests.map(({ method, url }) => ({ method, url })),
      [{ method: 'OPTIONS', url: ecommerceSearchPath }],
    )
  } finally {
    adminServer.closeAllConnections?.()
    publicServer.closeAllConnections?.()
    await Promise.all([
      new Promise((resolve) => adminServer.close(resolve)),
      new Promise((resolve) => publicServer.close(resolve)),
    ])
  }
})
