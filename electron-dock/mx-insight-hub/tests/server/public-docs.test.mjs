import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'

const FORBIDDEN_PUBLIC_DOC_DETAILS = /x-mx-insight-admin-token|adminToken|launcherSession|businessId|availabilityMode|dsnEnv|password|\/internal\/|tikhub|rapidapi|justone/i

async function withServer(listenerMode, run) {
  const app = createApp({
    service: {},
    store: {},
    adapter: {},
    listenerMode,
    logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('public listener serves self-contained public API documentation', async () => {
  await withServer('public', async (baseUrl) => {
    const response = await fetch(`${baseUrl}/docs`)
    const html = await response.text()

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/html/)
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    assert.match(html, /MX Insight Hub/)
    assert.match(html, /\/api\/v1\/data\/search/)
    assert.match(html, /\/api\/v1\/data\/telegram\/search/)
    assert.match(html, /\/api\/v1\/data\/telegram\/messages/)
    assert.match(html, /\/api\/v1\/data\/capabilities/)
    assert.match(html, /\/api\/v1\/requests\/\{requestId\}/)
    assert.match(html, /\/api\/v1\/usage/)
    assert.match(html, /Idempotency-Key/)
    assert.match(html, /nextCursor/)
    assert.doesNotMatch(html, /<script\b/i)
    assert.doesNotMatch(html, /https?:\/\/(?:cdn|unpkg|jsdelivr)\./i)
    assert.doesNotMatch(html, FORBIDDEN_PUBLIC_DOC_DETAILS)
    assert.doesNotMatch(html, /mih_(?:live|test)_[A-Za-z0-9_-]+/i)
  })
})

test('public OpenAPI document contains only implemented public data paths', async () => {
  await withServer('public', async (baseUrl) => {
    const response = await fetch(`${baseUrl}/docs/openapi.json`)
    const document = await response.json()
    const paths = Object.keys(document.paths)

    assert.equal(response.status, 200)
    assert.equal(document.openapi, '3.1.0')
    assert.deepEqual(paths.sort(), [
      '/data/capabilities',
      '/data/search',
      '/data/telegram/chats',
      '/data/telegram/entities/search',
      '/data/telegram/messages',
      '/data/telegram/search',
      '/requests/{requestId}',
      '/usage',
    ])
    assert.deepEqual(Object.keys(document.components.securitySchemes).sort(), ['apiKeyHeader', 'bearerKey'])

    const serialized = JSON.stringify(document)
    assert.doesNotMatch(serialized, FORBIDDEN_PUBLIC_DOC_DETAILS)
    assert.doesNotMatch(serialized, /mih_(?:live|test)_[A-Za-z0-9_-]+/i)
    assert.match(serialized, /Idempotency-Key/)
    assert.match(serialized, /opaque nextCursor/i)
  })
})

test('admin-only listener does not expose public documentation', async () => {
  await withServer('admin', async (baseUrl) => {
    for (const path of ['/docs', '/docs/openapi.json']) {
      const response = await fetch(`${baseUrl}${path}`)
      const payload = await response.json()
      assert.equal(response.status, 404)
      assert.equal(payload.error.code, 'not_found')
    }
  })
})
