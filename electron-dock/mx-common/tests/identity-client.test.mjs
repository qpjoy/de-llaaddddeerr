import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdentityAccountClient } from '../src/identity/client.mjs'

test('server SDK pins issuer, uses POST, never sends credentials in a URL and disables redirects', async () => {
  let request
  const client = createIdentityAccountClient({ issuer: 'https://identity.example.test/identity', clientId: 'product-a', clientSecret: 'server-only', fetch: async (url, options) => {
    request = { url, ...options }; return Response.json({ ok: true })
  } })
  assert.deepEqual(await client('login', { flow: 'test-flow', password: 'private-password' }), { ok: true })
  assert.equal(request.url.href, 'https://identity.example.test/identity/app-account')
  assert.equal(request.redirect, 'error'); assert.equal(request.method, 'POST')
  assert.equal(Buffer.from(request.headers.authorization.slice(6), 'base64').toString(), 'product-a:server-only')
  assert.equal(JSON.parse(request.body).input.password, 'private-password')
  assert.throws(() => createIdentityAccountClient({ issuer: 'http://identity.example.test', clientId: 'a', clientSecret: 'b' }))
})

test('expired transactions and policy changes remain visible to application adapters', async () => {
  const client = createIdentityAccountClient({ issuer: 'https://identity.example.test/identity', clientId: 'a', clientSecret: 'b', fetch: async () => Response.json({ message: '登录已超时，请重新开始。', code: 'flow_expired' }, { status: 410 }) })
  await assert.rejects(client('options', { flow: 'expired' }), error => error.status === 410 && error.code === 'flow_expired')
})
