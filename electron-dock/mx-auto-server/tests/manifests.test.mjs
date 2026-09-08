import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

test('runtime manifests stay in the independent mx-auto namespace', async () => {
  for (const path of [
    'deploy/k8s/internal/05-serviceaccount.yaml',
    'deploy/k8s/internal/08-resource-policy.yaml',
    'deploy/k8s/internal/10-artifacts-pvc.yaml',
    'deploy/k8s/internal/15-postgres.yaml',
    'deploy/k8s/internal/20-migration-job.yaml',
    'deploy/k8s/internal/30-server.yaml',
    'deploy/k8s/internal/35-nodeport.yaml',
    'deploy/k8s/internal/40-network-policy.yaml'
  ]) {
    const manifest = await read(path)
    assert.match(manifest, /namespace: mx-auto/u, path)
    assert.doesNotMatch(manifest, /namespace: mx-test-framework/u, path)
  }
})

test('only the server persistence boundary keeps the V0 namespace-local claim alias', async () => {
  const pvc = await read('deploy/k8s/internal/10-artifacts-pvc.yaml')
  const server = await read('deploy/k8s/internal/30-server.yaml')
  assert.match(pvc, /name: mx-test-framework-artifacts/u)
  assert.match(server, /claimName: mx-test-framework-artifacts/u)
  assert.match(pvc, /v0-kernel-pvc-alias/u)
})

test('namespace and containers have enforceable CPU, memory and ephemeral-storage budgets', async () => {
  const policy = await read('deploy/k8s/internal/08-resource-policy.yaml')
  assert.match(policy, /kind: ResourceQuota/u)
  assert.match(policy, /kind: LimitRange/u)
  assert.match(policy, /limits\.cpu: "4"/u)
  assert.match(policy, /limits\.memory: 10Gi/u)
  assert.match(policy, /limits\.ephemeral-storage: 16Gi/u)
  assert.match(policy, /MX_AUTO_MAX_CONCURRENT_SERVER_RUNS: "1"/u)
  assert.match(policy, /MX_AUTO_ARTIFACT_MAX_TOTAL_BYTES: "21474836480"/u)
  assert.match(policy, /MX_AUTO_ARTIFACT_MAX_TOTAL_ENTRIES: "100000"/u)
  assert.match(policy, /MX_AUTO_ARTIFACT_MIN_FREE_BYTES: "5368709120"/u)
  assert.match(policy, /MX_AUTO_ARTIFACT_MIN_FREE_INODES: "10000"/u)

  for (const [path, resourceEntries] of [
    ['deploy/k8s/internal/15-postgres.yaml', 4],
    ['deploy/k8s/internal/20-migration-job.yaml', 2],
    ['deploy/k8s/internal/30-server.yaml', 4]
  ]) {
    const manifest = await read(path)
    assert.match(manifest, /requests:[\s\S]*cpu:[\s\S]*memory:[\s\S]*ephemeral-storage:/u, path)
    assert.match(manifest, /limits:[\s\S]*cpu:[\s\S]*memory:[\s\S]*ephemeral-storage:/u, path)
    assert.match(manifest, /readOnlyRootFilesystem: true/u, path)
    assert.equal((manifest.match(/ephemeral-storage:/gu) ?? []).length, resourceEntries, path)
  }
})

test('server egress contains DNS, database, Launcher and Kubernetes API ports', async () => {
  const policy = await read('deploy/k8s/internal/40-network-policy.yaml')
  for (const port of ['53', '80', '443', '5432', '6443', '18090']) {
    assert.match(policy, new RegExp(`port: ${port}\\b`, 'u'), `missing egress port ${port}`)
  }
  const serverPolicy = policy.split('---')[0]
  assert.match(serverPolicy, /egress:/u)
  assert.match(serverPolicy, /port: 6443/u)
  assert.match(serverPolicy, /port: 18090/u)
})

test('runner Jobs are isolated from private and cluster networks', async () => {
  const policy = await read('deploy/k8s/internal/40-network-policy.yaml')
  assert.match(policy, /name: mx-auto-runner/u)
  assert.match(policy, /app\.kubernetes\.io\/component: runner/u)
  assert.match(policy, /ingress: \[\]/u)
  for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
    assert.match(policy, new RegExp(range.replaceAll('.', '\\.').replace('/', '\\/'), 'u'))
  }
  assert.match(policy, /app\.kubernetes\.io\/name: mx-auto-server/u)
})

test('server rollout is tied to rendered Secret content', async () => {
  const server = await read('deploy/k8s/internal/30-server.yaml')
  assert.match(server, /mx-auto\.qpjoy\.dev\/secret-checksum: __MX_AUTO_SECRET_CHECKSUM__/u)
  assert.match(server, /mx-auto\.qpjoy\.dev\/resource-policy-checksum: __MX_AUTO_RESOURCE_POLICY_CHECKSUM__/u)
  const migration = await read('deploy/k8s/internal/20-migration-job.yaml')
  assert.doesNotMatch(`${server}\n${migration}`, /mx-auto-server:latest/u)
  assert.match(`${server}\n${migration}`, /mx-auto\.invalid\/mx-auto-server:managed-image-required/u)
  assert.match(`${server}\n${migration}`, /imagePullPolicy: IfNotPresent/u)
})

test('server receives bounded Launcher identity settings from managed configuration', async () => {
  const server = await read('deploy/k8s/internal/30-server.yaml')
  for (const name of [
    'MX_AUTO_LAUNCHER_NEGATIVE_CACHE_TTL_MS',
    'MX_AUTO_LAUNCHER_INTROSPECTION_WINDOW_MS',
    'MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS',
    'MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT',
    'MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE',
    'MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE',
    'MX_AUTO_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS',
    'MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS',
    'MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT',
    'MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE',
    'MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE'
  ]) {
    assert.match(server, new RegExp(`name: ${name}\\b[\\s\\S]*?key: ${name}\\b`, 'u'), name)
  }
})

test('server receives the optional HTTP cookie override from its managed Secret', async () => {
  const server = await read('deploy/k8s/internal/30-server.yaml')
  assert.match(
    server,
    /name: MX_AUTO_INSECURE_COOKIES\b[\s\S]*?key: MX_AUTO_INSECURE_COOKIES\b[\s\S]*?optional: true/u
  )
})

test('the single-node NodePort preserves direct peer addresses without a CIDR allowlist', async () => {
  const service = await read('deploy/k8s/internal/35-nodeport.yaml')
  assert.match(service, /externalTrafficPolicy: Local/u)
  assert.doesNotMatch(service, /loadBalancerSourceRanges|sourceRanges|cidr:/iu)
})

test('wrapper does not import an MX-H2I implementation path', async () => {
  const entry = await read('server/legacy.mjs')
  assert.doesNotMatch(entry, /mx-h2i/iu)
  assert.equal(resolve(root.pathname).endsWith('/mx-auto-server'), true)
})
