import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manage = new URL('../scripts/manage.sh', import.meta.url).pathname
const migration = new URL('../deploy/k8s/internal/20-migration-job.yaml', import.meta.url).pathname
const deployment = new URL('../deploy/k8s/internal/30-server.yaml', import.meta.url).pathname
const envExample = new URL('../.env.example', import.meta.url)

function shell(source) {
  return spawnSync('bash', ['-c', source, 'mx-auto-test', manage, migration, deployment], {
    encoding: 'utf8',
    env: { ...process.env, MX_AUTO_MANAGE_SOURCE_ONLY: '1' }
  })
}

test('the standard deployment example has no active env requirements', async () => {
  const source = await readFile(envExample, 'utf8')
  assert.doesNotMatch(source, /^[A-Za-z_][A-Za-z0-9_]*=/mu)
})

test('only immutable registry digests are accepted as explicit images', () => {
  const valid = shell('source "$1"; validate_explicit_image "registry.test/mx-auto@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
  assert.equal(valid.status, 0, valid.stderr)

  for (const image of ['mx-auto-server:latest', 'registry.test/mx-auto:v1']) {
    const invalid = shell(`source "$1"; validate_explicit_image "${image}"`)
    assert.notEqual(invalid.status, 0, image)
    assert.match(invalid.stderr, /immutable registry digest/u)
  }
})

test('an explicit immutable image bypasses all local build and runtime discovery', () => {
  const digest = `registry.test/mx-auto@sha256:${'a'.repeat(64)}`
  const result = shell(`
    source "$1"
    kubectl() {
      test "$*" = 'config current-context'
      printf 'production-cluster\\n'
    }
    build_local_image() { return 97; }
    cluster_container_runtime() { return 98; }
    MX_AUTO_IMAGE='${digest}'
    resolve_image
    test "$IMAGE" = '${digest}'
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('image resolution builds locally for desktop and loads kind', () => {
  for (const context of ['docker-desktop', 'rancher-desktop', 'kind-autotest']) {
    const local = shell(`
      source "$1"
      kubectl() { printf '${context}\\n'; }
      build_local_image() {
        test "$#" = 0
        IMAGE='mx-auto.local/mx-auto-server:local-sha256-content'
      }
      load_kind_image() { KIND_LOADED=1; }
      unset MX_AUTO_IMAGE
      resolve_image
      test "$IMAGE" = 'mx-auto.local/mx-auto-server:local-sha256-content'
      ${context === 'kind-autotest' ? 'test "$KIND_LOADED" = 1' : 'test -z "${KIND_LOADED:-}"'}
    `)
    assert.equal(local.status, 0, `${context}: ${local.stderr}`)
  }
})

test('image resolution auto-imports into a local single-node containerd cluster', () => {
  const result = shell(`
    source "$1"
    kubectl() { printf 'production-cluster\\n'; }
    cluster_container_runtime() { printf 'containerd://1.7.0\\n'; }
    require_local_kubernetes_node() { :; }
    prepare_containerd_import() { :; }
    build_local_image() {
      test "$#" = 1
      test "$1" = host
      IMAGE='mx-auto.local/mx-auto-server:local-sha256-content'
    }
    import_containerd_image() {
      test "$1" = 'mx-auto.local/mx-auto-server:local-sha256-content'
      IMPORTED=1
    }
    unset MX_AUTO_IMAGE
    resolve_image
    test "$IMPORTED" = 1
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('image resolution fails closed when the selected cluster cannot consume a local image', () => {
  const unsupportedRuntime = shell(`
    source "$1"
    kubectl() { printf 'production-cluster\\n'; }
    cluster_container_runtime() { printf 'cri-o://1.30.0\\n'; }
    unset MX_AUTO_IMAGE
    resolve_image
  `)
  assert.notEqual(unsupportedRuntime.status, 0)
  assert.match(unsupportedRuntime.stderr, /cannot automatically import.*cri-o/u)

  const remoteNode = shell(`
    source "$1"
    kubectl() { printf 'production-cluster\\n'; }
    cluster_container_runtime() { printf 'containerd://1.7.0\\n'; }
    require_local_kubernetes_node() { die 'kubectl points at a different host'; }
    unset MX_AUTO_IMAGE
    resolve_image
  `)
  assert.notEqual(remoteNode.status, 0)
  assert.match(remoteNode.stderr, /different host/u)
})

test('local image name contains the complete Docker image id', () => {
  const hash = 'c'.repeat(64)
  const result = shell(`
    source "$1"
    docker() {
      case "$1" in
        build | tag) return 0 ;;
        image)
          case "$2" in
            inspect) printf 'sha256:${hash}\\n' ;;
            rm) return 0 ;;
          esac
          ;;
        *) return 1 ;;
      esac
    }
    build_local_image
    test "$IMAGE" = 'mx-auto.local/mx-auto-server:local-sha256-${hash}'
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('local image build applies host networking only when requested', () => {
  const hash = 'b'.repeat(64)
  const result = shell(`
    source "$1"
    docker() {
      case "$1" in
        build)
          BUILD_ARGS="$*"
          return 0
          ;;
        tag) return 0 ;;
        image)
          case "$2" in
            inspect) printf 'sha256:${hash}\\n' ;;
            rm) return 0 ;;
          esac
          ;;
        *) return 1 ;;
      esac
    }
    build_local_image
    [[ " $BUILD_ARGS " != *' --network host '* ]]
    build_local_image host
    [[ " $BUILD_ARGS " == *' --network host '* ]]
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('containerd import refreshes even an existing ref so missing content can self-heal', () => {
  const result = shell(`
    source "$1"
    containerd_image_ref_present() { return 0; }
    docker() { printf 'docker-save-called\\n'; }
    run_ctr() { :; }
    import_containerd_image 'mx-auto.local/mx-auto-server:local-sha256-${'d'.repeat(64)}'
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /docker-save-called/u)
})

test('containerd import verifies that Kubernetes can resolve the exact image ref', () => {
  const image = `mx-auto.local/mx-auto-server:local-sha256-${'e'.repeat(64)}`
  const result = shell(`
    source "$1"
    containerd_image_ref_present() { return 1; }
    docker() { return 0; }
    run_ctr() { return 0; }
    import_containerd_image '${image}'
  `)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /import completed but .* is missing/u)
})

test('local containerd import proves that kubectl targets the current host', () => {
  const local = shell(`
    source "$1"
    kubectl() {
      if [ "$1 $2" = 'get nodes' ]; then printf 'node-a\\n'; return; fi
      if [ "$1 $2 $3" = 'get node node-a' ]; then printf 'node-a\\n10.20.30.40\\n'; return; fi
      return 1
    }
    hostname() {
      case "\${1:-}" in
        -I) printf '10.20.30.40 ' ;;
        *) printf 'node-a\\n' ;;
      esac
    }
    ip() { return 0; }
    require_local_kubernetes_node
  `)
  assert.equal(local.status, 0, local.stderr)

  const remote = shell(`
    source "$1"
    kubectl() {
      if [ "$1 $2" = 'get nodes' ]; then printf 'node-a\\n'; return; fi
      if [ "$1 $2 $3" = 'get node node-a' ]; then printf 'node-a\\n10.20.30.40\\n'; return; fi
      return 1
    }
    hostname() {
      case "\${1:-}" in
        -I) printf '10.99.99.99 ' ;;
        *) printf 'node-a\\n' ;;
      esac
    }
    ip() { return 0; }
    require_local_kubernetes_node
  `)
  assert.notEqual(remote.status, 0)
  assert.match(remote.stderr, /this host is not that node/u)

  const hostnameFallback = shell(`
    source "$1"
    kubectl() {
      if [ "$1 $2" = 'get nodes' ]; then printf 'node-a\\n'; return; fi
      if [ "$1 $2 $3" = 'get node node-a' ]; then printf 'node-a\\n'; return; fi
      return 1
    }
    hostname() {
      case "\${1:-}" in
        -I) : ;;
        *) printf 'node-a\\n' ;;
      esac
    }
    ip() { :; }
    require_local_kubernetes_node
  `)
  assert.equal(hostnameFallback.status, 0, hostnameFallback.stderr)
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

test('Launcher URL preserves an explicit override', () => {
  const result = shell(`
    source "$1"
    kubectl() { return 1; }
    MX_AUTO_LAUNCHER_URL='http://launcher.example:18090'
    resolve_launcher_url
    test "$MX_AUTO_LAUNCHER_URL" = 'http://launcher.example:18090'
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('Launcher URL discovers the canonical same-cluster Service', () => {
  const result = shell(`
    source "$1"
    kubectl() {
      test "$*" = '-n mx-internal-shadow get service mx-launcher-internal --ignore-not-found -o jsonpath={.metadata.name}{"\\t"}{.spec.ports[?(@.name=="http")].port}'
      printf 'mx-launcher-internal\\t18090'
    }
    unset MX_AUTO_LAUNCHER_URL
    resolve_launcher_url
    test "$MX_AUTO_LAUNCHER_URL" = 'http://mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090'
  `)
  assert.equal(result.status, 0, result.stderr)
})

test('missing Launcher Service leaves identity integration disabled without failing deploy', () => {
  const result = shell(`
    source "$1"
    kubectl() { return 0; }
    unset MX_AUTO_LAUNCHER_URL
    resolve_launcher_url
    test -z "$MX_AUTO_LAUNCHER_URL"
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Launcher account login stays disabled/u)
})

test('Launcher discovery does not turn an API failure into disabled user login', () => {
  const result = shell(`
    source "$1"
    kubectl() { return 1; }
    unset MX_AUTO_LAUNCHER_URL
    resolve_launcher_url
  `)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cannot query the canonical Launcher Service/u)
})

test('Launcher discovery rejects a Service that breaks the named-port contract', () => {
  const result = shell(`
    source "$1"
    kubectl() { printf 'mx-launcher-internal\\t'; }
    unset MX_AUTO_LAUNCHER_URL
    resolve_launcher_url
  `)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /has no numeric port named http/u)
})

test('cookie policy override is stored and participates in the rollout checksum', () => {
  const result = shell(`
    source "$1"
    b64() { cat; }
    kubectl() {
      local manifest
      manifest="$(cat)"
      [[ "$manifest" == *'MX_AUTO_INSECURE_COOKIES: "false"'* ]]
    }
    unset MX_AUTO_INSECURE_COOKIES
    compute_secret_checksum
    blank_checksum="$SECRET_CHECKSUM"
    MX_AUTO_INSECURE_COOKIES=false
    apply_secret
    compute_secret_checksum
    test "$blank_checksum" != "$SECRET_CHECKSUM"
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

test('the Kubernetes admin token is generated once and then read from the managed Secret', () => {
  const generatedToken = 'f'.repeat(64)
  const generated = shell(`
    source "$1"
    read_secret() { :; }
    kube() { return 1; }
    openssl() {
      test "$*" = 'rand -hex 32'
      printf '${generatedToken}\n'
    }
    unset MX_AUTO_ADMIN_TOKEN
    resolve_admin_token
    test "$MX_AUTO_ADMIN_TOKEN" = '${generatedToken}'
  `)
  assert.equal(generated.status, 0, generated.stderr)
  assert.match(generated.stdout, /generated the service admin token/u)

  const preserved = shell(`
    source "$1"
    read_secret() {
      test "$1" = 'MX_AUTO_ADMIN_TOKEN'
      printf 'live-admin-token'
    }
    unset MX_AUTO_ADMIN_TOKEN
    resolve_admin_token
    test "$MX_AUTO_ADMIN_TOKEN" = 'live-admin-token'
  `)
  assert.equal(preserved.status, 0, preserved.stderr)
})

test('a legacy change-me token is replaced instead of becoming a known admin credential', () => {
  const replacement = 'a'.repeat(64)
  const result = shell(`
    source "$1"
    read_secret() { printf 'change-me'; }
    openssl() { printf '${replacement}\\n'; }
    MX_AUTO_ADMIN_TOKEN='change-me'
    resolve_admin_token
    test "$MX_AUTO_ADMIN_TOKEN" = '${replacement}'
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /replacing the legacy placeholder/u)

  const beforeDeploy = shell(`
    source "$1"
    read_secret() { printf 'change-me'; }
    unset MX_AUTO_ADMIN_TOKEN
    load_admin_token
  `)
  assert.notEqual(beforeDeploy.status, 0)
  assert.match(beforeDeploy.stderr, /run deploy once to replace it/u)

  const afterDeploy = shell(`
    source "$1"
    read_secret() { printf '${replacement}'; }
    MX_AUTO_ADMIN_TOKEN='change-me'
    load_admin_token
    test "$MX_AUTO_ADMIN_TOKEN" = '${replacement}'
  `)
  assert.equal(afterDeploy.status, 0, afterDeploy.stderr)
})

test('Secret reads fail closed on Kubernetes API errors', () => {
  const result = shell(`
    source "$1"
    kube() { return 1; }
    read_secret MX_AUTO_ADMIN_TOKEN
  `)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cannot read MX_AUTO_ADMIN_TOKEN/u)
})

test('preserved database secrets are not regenerated when PVC lookup fails', () => {
  const result = shell(`
    source "$1"
    read_secret() { :; }
    kube() { return 1; }
    openssl() { return 97; }
    unset MX_AUTO_SECRET_KEY
    resolve_secret_key
  `)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cannot query mx-auto\/mx-auto-postgres-data/u)

  const firstInstall = shell(`
    source "$1"
    read_secret() { :; }
    kube() { return 0; }
    openssl() { printf 'first-install-key'; }
    unset MX_AUTO_SECRET_KEY
    resolve_secret_key
    test "$MX_AUTO_SECRET_KEY" = 'first-install-key'
  `)
  assert.equal(firstInstall.status, 0, firstInstall.stderr)
})

test('admin-token reads the generated credential without requiring an env file', () => {
  const result = shell(`
    source "$1"
    need() { :; }
    load_env() { :; }
    read_secret() { printf 'live-admin-token'; }
    unset MX_AUTO_ADMIN_TOKEN
    cmd_admin_token
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'live-admin-token')
})

test('admin-token refuses a stale env override instead of printing unusable credentials', () => {
  const result = shell(`
    source "$1"
    read_secret() { printf 'live-admin-token'; }
    MX_AUTO_ADMIN_TOKEN='stale-admin-token'
    load_admin_token
  `)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match the managed Secret/u)
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
