import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPaymentConsole } from '../server/console.mjs'
import { consolePrincipal, validateConsoleAccess } from '../server/console-config.mjs'

const identity = { issuer: 'https://auth.example/identity', subject: 'person', clientId: 'mx-pay-web', displayName: '<script>test</script>', mxIdentity: { principal: { scopes: ['mx:admin'] } } }
const grant = { issuer: identity.issuer, subject: identity.subject, clientId: identity.clientId, appId: 'mx-insight-hub', environment: 'test', role: 'viewer' }
test('console local grants require issuer + subject + client, explicit app/environment and no inherited Auth roles', () => {
  assert.deepEqual(consolePrincipal(identity, []).grants, [])
  for (const entry of [{ ...grant, issuer: 'https://other.example/identity' }, { ...grant, subject: 'other' }, { ...grant, clientId: 'hub' }]) {
    assert.deepEqual(consolePrincipal(identity, [entry]).grants, [])
  }
  for (const entry of [{ ...grant, appId: '*' }, { ...grant, environment: '*' }, { ...grant, role: 'admin' }, { ...grant, secret: 'forbidden' }]) {
    assert.throws(() => validateConsoleAccess([entry]))
  }
  assert.throws(() => validateConsoleAccess([grant, grant]))
})

test('HTTP console scopes reads, strips payer/checkout data, rejects money writes and never accepts machine bearer alone', async t => {
  let principal = null, reads = 0
  const server = createServer(createPaymentConsole({ settings: { origin: 'https://pay.example' }, sessionPool: { query: async () => ({ rows: [] }) },
    sso: { handle: async () => false, principal: async () => principal },
    service: { list: async (actor, query) => {
      reads++; assert.deepEqual(actor, { appId: 'mx-insight-hub', environment: 'test', scopes: ['orders.read'] })
      assert.equal(query.has('appId'), false)
      return { items: [{ id: 'payment', businessOrderId: 'business', amountMinor: 500, currency: 'CNY', status: 'paid',
        checkout: { token: 'private-checkout' }, submission: { payerName: 'private-payer' }, receipt: { tradeNo: 'private-receipt' } }], page: 1, hasMore: false }
    } }, logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}`, path = '/console/v1/orders?appId=mx-insight-hub&environment=test'
  assert.equal((await fetch(`${base}${path}`, { headers: { authorization: 'Bearer machine-secret' } })).status, 401)
  principal = consolePrincipal(identity, [])
  assert.equal((await fetch(`${base}${path}`)).status, 403)
  principal = consolePrincipal(identity, [grant])
  assert.equal((await fetch(`${base}${path.replace('test','live')}`)).status, 403)
  assert.equal((await fetch(`${base}${path.replace('mx-insight-hub','other')}`)).status, 403)
  assert.equal((await fetch(`${base}${path}&appId=other`)).status, 400)
  assert.equal((await fetch(`${base}${path}`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/v1/orders`)).status, 404)
  const response = await fetch(`${base}${path}`), text = await response.text()
  assert.equal(response.status, 200); assert.equal(reads, 1)
  assert.doesNotMatch(text, /private-|checkout|receipt|submission/)
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  principal = consolePrincipal(identity, [])
  assert.equal((await fetch(`${base}${path}`)).status, 403, 'removing a grant takes effect without replacing session identity')
})
