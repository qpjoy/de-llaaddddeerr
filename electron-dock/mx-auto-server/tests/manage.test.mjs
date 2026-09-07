import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manage = new URL('../scripts/manage.sh', import.meta.url).pathname
const migration = new URL('../deploy/k8s/internal/20-migration-job.yaml', import.meta.url).pathname
const deployment = new URL('../deploy/k8s/internal/30-server.yaml', import.meta.url).pathname

function shell(source) {
  return spawnSync('bash', ['-c', source, 'mx-auto-test', manage, migration, deployment], {
    encoding: 'utf8',
    env: { ...process.env, MX_AUTO_MANAGE_SOURCE_ONLY: '1' }
  })
}

test('only immutable registry digests are accepted as explicit images', () => {
  const valid = shell('source "$1"; validate_explicit_image "registry.test/mx-auto@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
  assert.equal(valid.status, 0, valid.stderr)

  for (const image of ['mx-auto-server:latest', 'registry.test/mx-auto:v1']) {
    const invalid = shell(`source "$1"; validate_explicit_image "${image}"`)
    assert.notEqual(invalid.status, 0, image)
    assert.match(invalid.stderr, /immutable registry digest/u)
  }
})

test('image resolution supports desktop and kind but fails closed for an unconfigured remote context', () => {
  for (const context of ['docker-desktop', 'rancher-desktop', 'kind-autotest']) {
    const local = shell(`
      source "$1"
      kubectl() { printf '${context}\\n'; }
      build_local_image() { IMAGE='mx-auto-server:local-content'; }
      unset MX_AUTO_IMAGE
      resolve_image
      test "$IMAGE" = 'mx-auto-server:local-content'
    `)
    assert.equal(local.status, 0, `${context}: ${local.stderr}`)
  }

  const remote = shell(`
    source "$1"
    kubectl() { printf 'production-cluster\\n'; }
    unset MX_AUTO_IMAGE
    resolve_image
  `)
  assert.notEqual(remote.status, 0)
  assert.match(remote.stderr, /set MX_AUTO_IMAGE to a pullable digest/u)
})

test('kind does not advertise an unmapped NodePort as a public URL', () => {
  const result = shell(`
    source "$1"
    kubectl() { printf 'kind-autotest\\n'; }
    unset MX_AUTO_PUBLIC_URL
    resolve_public_url
    test -z "$MX_AUTO_PUBLIC_URL"
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('manifest rendering replaces image and Secret checksum before apply', () => {
  const result = shell(`
    source "$1"
    IMAGE="registry.test/mx-auto@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    SECRET_CHECKSUM="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    RESOURCE_POLICY_CHECKSUM="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    render_file "$2"
    render_file "$3"
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /mx-auto\.invalid\/mx-auto-server:managed-image-required|__MX_AUTO_(?:SECRET|RESOURCE_POLICY)_CHECKSUM__/u)
  assert.match(result.stdout, /registry\.test\/mx-auto@sha256:b{64}/u)
  assert.match(result.stdout, /imagePullPolicy: IfNotPresent/u)
  assert.match(result.stdout, /mx-auto\.qpjoy\.dev\/secret-checksum: c{64}/u)
  assert.match(result.stdout, /mx-auto\.qpjoy\.dev\/resource-policy-checksum: d{64}/u)
})

test('hostPath preflight accepts one node and rejects a multi-node cluster', () => {
  const one = shell('source "$1"; kubectl() { printf "node/only\\n"; }; preflight_hostpath_cluster')
  assert.equal(one.status, 0, one.stderr)

  const many = shell('source "$1"; kubectl() { printf "node/a\\nnode/b\\n"; }; preflight_hostpath_cluster')
  assert.notEqual(many.status, 0)
  assert.match(many.stderr, /requires exactly one Kubernetes node; found 2/u)
})

test('an existing password is authoritative and a different configured value is refused', () => {
  const same = shell(`
    source "$1"
    read_secret() { printf 'live-password'; }
    MX_AUTO_POSTGRES_PASSWORD=''
    resolve_database
    test "$MX_AUTO_POSTGRES_PASSWORD" = 'live-password'
  `)
  assert.equal(same.status, 0, same.stderr)

  const changed = shell(`
    source "$1"
    read_secret() { printf 'live-password'; }
    MX_AUTO_POSTGRES_PASSWORD='different-password'
    resolve_database
  `)
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /ordinary deploy cannot rotate MX_AUTO_POSTGRES_PASSWORD/u)
})

test('an existing encryption key cannot be silently replaced', () => {
  const changed = shell(`
    source "$1"
    read_secret() { printf 'live-key'; }
    MX_AUTO_SECRET_KEY='different-key'
    resolve_secret_key
  `)
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /ordinary deploy cannot rotate MX_AUTO_SECRET_KEY/u)
})

test('deploy explicitly restores the server after down', async () => {
  const source = await readFile(manage, 'utf8')
  assert.match(source, /scale deployment\/mx-auto-server --replicas=1/u)
})
