import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const manifest = readFileSync(new URL('../deploy/k8s/optional/11-postgres-loopback.yaml', import.meta.url), 'utf8')

test('local PostgreSQL relay stays on the database node and only accepts loopback connections', () => {
  assert.match(manifest, /hostNetwork: true/)
  assert.match(manifest, /dnsPolicy: ClusterFirstWithHostNet/)
  assert.match(manifest, /requiredDuringSchedulingIgnoredDuringExecution:[\s\S]*?app\.kubernetes\.io\/name: mx-common-postgres\n\s+topologyKey: kubernetes\.io\/hostname/)
  assert.match(manifest, /type: Recreate/)
  assert.match(manifest, /hostPort: 2345\n\s+hostIP: 127\.0\.0\.1/)
  const addresses = [...manifest.matchAll(/^\s*- (TCP4[^\s]+)$/gm)].map(match => match[1].split(','))
  assert.equal(addresses.length, 2)
  assert.equal(addresses[0][0], 'TCP4-LISTEN:2345')
  assert.ok(addresses[0].includes('bind=127.0.0.1'))
  assert.ok(addresses[0].includes('fork'))
  assert.ok(addresses[0].some(option => /^max-children=[1-9]\d*$/.test(option)))
  assert.equal(addresses[1][0], 'TCP4:mx-common-postgres.mx-common.svc.cluster.local:5432')
  assert.match(manifest, /automountServiceAccountToken: false/)
  assert.doesNotMatch(manifest, /\b(?:hostPath|secretKeyRef|volumeMounts):/)
})

test('readiness requires a listening socket on the exact development address', () => {
  const probe = manifest.match(/^\s+(netstat [^\n]+)$/m)?.[1]
  assert.ok(probe)
  const ready = (address, state) => spawnSync('sh', ['-c', `netstat() { printf '%s\\n' "$ROW"; }\n${probe}`], {
    env: { ...process.env, ROW: `tcp 0 0 ${address} 0.0.0.0:* ${state}` },
  }).status === 0
  assert.equal(ready('127.0.0.1:2345', 'LISTEN'), true)
  assert.equal(ready('127.0.0.1:23450', 'LISTEN'), false)
  assert.equal(ready('0.0.0.0:2345', 'LISTEN'), false)
  assert.equal(ready('127.0.0.1:2345', 'ESTABLISHED'), false)
})
