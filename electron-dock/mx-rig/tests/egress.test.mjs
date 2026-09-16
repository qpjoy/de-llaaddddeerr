import test from 'node:test'
import assert from 'node:assert/strict'
import { observeEgress, proxyHonored, redactProxy } from '../apps/server/egress.mjs'

test('proxy credentials are never returned, but their presence is', () => {
  const withAuth = redactProxy('http://tunnel:s3cr3t@127.0.0.1:7788')
  assert.equal(withAuth.credentials, true)
  assert.ok(!withAuth.value.includes('s3cr3t'))
  assert.ok(withAuth.value.includes('127.0.0.1:7788'))
  assert.deepEqual(redactProxy('http://127.0.0.1:7788'), {
    value: 'http://127.0.0.1:7788',
    credentials: false
  })
  // Not a URL, but still carrying a credential — report the shape, not the text.
  const bare = redactProxy('tunnel:s3cr3t@proxy.internal:7788')
  assert.equal(bare.credentials, true)
  assert.ok(!bare.value.includes('s3cr3t'))
  assert.deepEqual(redactProxy(''), { value: '', credentials: false })
})

test('a proxy variable that the runtime ignores is not reported as effective', () => {
  assert.equal(proxyHonored({}, 'v22.21.1').honored, false)
  assert.equal(proxyHonored({ NODE_USE_ENV_PROXY: '1' }, 'v22.21.1').honored, false)
  assert.equal(proxyHonored({}, 'v24.3.0').honored, false)
  assert.equal(proxyHonored({ NODE_USE_ENV_PROXY: '1' }, 'v24.3.0').honored, true)
})

test('egress observation reads both spellings and stays read-only', () => {
  const observed = observeEgress({
    env: {
      HTTP_PROXY: 'http://user:pw@127.0.0.1:7788',
      https_proxy: 'http://127.0.0.1:7788',
      NO_PROXY: 'localhost,.mxinfo-inc.cn'
    },
    nodeVersion: 'v22.21.1',
    platform: 'linux',
    hostname: 'mx-internal-server'
  })
  assert.equal(observed.configured, true)
  assert.equal(observed.effective, 'direct')
  assert.equal(observed.sourceKind, 'process-env')
  const http = observed.variables.find((entry) => entry.name === 'HTTP_PROXY')
  assert.equal(http.credentials, true)
  assert.ok(!JSON.stringify(observed).includes('pw@'))
  const https = observed.variables.find((entry) => entry.name === 'HTTPS_PROXY')
  assert.equal(https.source, 'https_proxy')
  assert.equal(observed.variables.find((entry) => entry.name === 'ALL_PROXY').set, false)
  assert.equal(
    observed.variables.find((entry) => entry.name === 'NO_PROXY').value.includes('mxinfo-inc.cn'),
    true
  )
  assert.equal(observeEgress({ env: {}, nodeVersion: 'v22.21.1' }).configured, false)
})
