import assert from 'node:assert/strict'
import test from 'node:test'
import { mapExternalEnvironment } from '../server/env.mjs'
import { resolveKernelRoot } from '../server/legacy.mjs'

test('MX_AUTO variables override the corresponding V0 kernel variables', () => {
  const target = { MXT_PORT: '1', MXT_LAUNCHER_AUDIENCE: 'stale' }
  mapExternalEnvironment(
    {
      MX_AUTO_PORT: '8790',
      MX_AUTO_ADMIN_TOKEN: 'secret',
      MX_AUTO_LAUNCHER_AUDIENCE: 'mx-sdk',
      MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS: '42',
      MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS: '7',
      MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE: '5'
    },
    target
  )
  assert.equal(target.MXT_PORT, '8790')
  assert.equal(target.MXT_ADMIN_TOKEN, 'secret')
  assert.equal(target.MXT_LAUNCHER_AUDIENCE, 'mx-sdk')
  assert.equal(target.MXT_LAUNCHER_INTROSPECTION_MAX_STARTS, '42')
  assert.equal(target.MXT_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS, '7')
  assert.equal(target.MXT_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE, '5')
})

test('resource and artifact budgets cross the V0 boundary without legacy leakage', () => {
  const target = {
    MXT_MAX_CONCURRENT_SERVER_RUNS: '99',
    MXT_ARTIFACT_MAX_TOTAL_BYTES: '999'
  }
  mapExternalEnvironment(
    {
      MX_AUTO_MAX_CONCURRENT_SERVER_RUNS: '1',
      MX_AUTO_RUNNER_CPU_LIMIT: '2',
      MX_AUTO_RUNNER_EPHEMERAL_STORAGE_LIMIT: '14Gi',
      MX_AUTO_ARTIFACT_MAX_TOTAL_BYTES: '21474836480',
      MX_AUTO_ARTIFACT_MAX_TOTAL_ENTRIES: '100000',
      MX_AUTO_ARTIFACT_MIN_FREE_BYTES: '5368709120',
      MX_AUTO_ARTIFACT_MIN_FREE_INODES: '10000'
    },
    target
  )
  assert.equal(target.MXT_MAX_CONCURRENT_SERVER_RUNS, '1')
  assert.equal(target.MXT_RUNNER_CPU_LIMIT, '2')
  assert.equal(target.MXT_RUNNER_EPHEMERAL_STORAGE_LIMIT, '14Gi')
  assert.equal(target.MXT_ARTIFACT_MAX_TOTAL_BYTES, '21474836480')
  assert.equal(target.MXT_ARTIFACT_MAX_TOTAL_ENTRIES, '100000')
  assert.equal(target.MXT_ARTIFACT_MIN_FREE_BYTES, '5368709120')
  assert.equal(target.MXT_ARTIFACT_MIN_FREE_INODES, '10000')
})

test('safe mx-auto defaults are applied at the compatibility boundary', () => {
  const target = { MXT_NAMESPACE: 'mx-test-framework', MXT_ADMIN_TOKEN: 'legacy-secret' }
  mapExternalEnvironment({}, target)
  assert.equal(target.MXT_NAMESPACE, 'mx-auto')
  assert.equal(target.MXT_SELF_URL, 'http://mx-auto-server')
  assert.equal(target.MXT_LAUNCHER_AUDIENCE, 'mx-sdk')
  assert.equal(target.MXT_LAUNCHER_NEGATIVE_CACHE_TTL_MS, '3000')
  assert.equal(target.MXT_LAUNCHER_INTROSPECTION_WINDOW_MS, '10000')
  assert.equal(target.MXT_LAUNCHER_INTROSPECTION_MAX_STARTS, '30')
  assert.equal(target.MXT_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT, '8')
  assert.equal(target.MXT_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE, '6')
  assert.equal(target.MXT_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE, '2')
  assert.equal(target.MXT_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS, '10000')
  assert.equal(target.MXT_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS, '10')
  assert.equal(target.MXT_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT, '4')
  assert.equal(target.MXT_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE, '3')
  assert.equal(target.MXT_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE, '1')
  assert.equal(target.MXT_GIT_TOKEN_SECRET, 'mx-auto-secrets')
  assert.equal(target.MXT_GIT_TOKEN_SECRET_KEY, 'MX_AUTO_GIT_TOKEN')
  assert.equal(target.MXT_ADMIN_TOKEN, undefined)
})

test('kernel root can be redirected without changing the preserved source tree', () => {
  assert.equal(resolveKernelRoot({ MX_AUTO_KERNEL_ROOT: '/tmp/mx-auto-kernel' }), '/tmp/mx-auto-kernel')
})
