import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
async function client() {
  const source = (await readFile(new URL('../../src/api.js', import.meta.url), 'utf8'))
    .replaceAll('import.meta.env', '({})')
    .replace(/from '([^']+)'/g, (_match, path) => `from ${JSON.stringify(new URL(path, new URL('../../src/api.js', import.meta.url)).href)}`)
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
test('product management reads scoped prices and saves the complete provider revision with Admin identity', async t => {
  const { adminApi } = await client()
  const calls = [], controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json({ data: { revision: 2 } }) })
  await adminApi.productManagement('synthetic-admin', { path: '/data-products/enterprise', consumerId: 'consumer' }, { signal: controller.signal })
  await adminApi.externalPlatformAdmission('synthetic-admin', 'qixin')
  const body = { expectedRevision: 1, reason: 'Reviewed capacity', limits: { maxConcurrency: 5, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, maxWaitMs: 10000, maxPending: 32 } }
  await adminApi.saveExternalPlatformAdmission('synthetic-admin', 'qixin', body)
  assert.equal(calls.length, 3)
  const url = new URL(calls[0].url, 'http://local.invalid')
  assert.equal(url.pathname, '/internal/v1/admin/data-products/management')
  assert.equal(url.searchParams.get('path'), '/data-products/enterprise')
  assert.equal(url.searchParams.get('consumerId'), 'consumer')
  assert.equal(calls[0].options.signal, controller.signal)
  assert.equal(calls[1].url, '/internal/v1/admin/external-platforms/qixin/admission-policy')
  assert.equal(calls[1].options.method, 'GET')
  assert.equal(calls[2].url, calls[1].url)
  assert.equal(calls[2].options.method, 'PUT')
  assert.deepEqual(JSON.parse(calls[2].options.body), body)
  for (const call of calls) { assert.equal(call.options.headers['x-mx-insight-admin-token'], 'synthetic-admin'); assert.equal(call.options.headers.authorization, undefined) }
})
test('provider configuration conflicts and uncertain network outcomes do not automatically write again', async t => {
  const { adminApi } = await client()
  let calls = 0
  const body = { expectedRevision: 2, reason: 'Test only', limits: {} }
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { code: 'external_platform_admission_changed', message: 'Configuration changed' } }, { status: 409 }) })
  await assert.rejects(adminApi.saveExternalPlatformAdmission('synthetic-admin', 'qixin', body), error => error.status === 409 && error.code === 'external_platform_admission_changed')
  assert.equal(calls, 1)
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('Connection interrupted') })
  await assert.rejects(adminApi.saveExternalPlatformAdmission('synthetic-admin', 'qixin', body), /Connection interrupted/)
  assert.equal(calls, 2)
})
