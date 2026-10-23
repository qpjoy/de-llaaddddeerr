import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url));
const imageId = `sha256:${'a'.repeat(64)}`;
const otherId = `sha256:${'b'.repeat(64)}`;
const liveImage = 'registry.example.test/team/hanlp:retained';

// All runtime tools are shell functions. Unexpected commands fail closed, so
// these deployment regressions cannot contact the developer's Docker/K8s.
function run(t, script, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-hanlp-recovery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = path.join(root, 'events');
  fs.writeFileSync(events, '');
  const env = {
    ...process.env,
    MX_COMMON_HANLP_IMAGE: 'environment-image:must-not-be-used',
    FIXTURE_ROOT: root,
    FIXTURE_EVENTS: events,
    FIXTURE_SPEC: [liveImage, liveImage, 'Never', 'Never', imageId, 'internal-node'].join('\t'),
    FIXTURE_DOCKER_ID: imageId,
    FIXTURE_PRESENT: '0',
    FIXTURE_DOCKER_STATUS: '0',
    FIXTURE_IMPORT_STATUS: '0',
    FIXTURE_LOCAL_STATUS: '0',
    FIXTURE_DISK_STATUS: '0',
    FIXTURE_LOCAL_NODE: 'internal-node',
    FIXTURE_DEPLOYED: '1',
    FIXTURE_SCALED: '0',
    ...options,
  };
  const result = spawnSync('bash', ['-c', `
source "$1"
eval "$(declare -f import_hanlp_image | sed '1s/import_hanlp_image/actual_import_hanlp_image/')"
audit() { printf '%s\\n' "$*" >>"$FIXTURE_EVENTS"; }
need() { audit "need $*"; }
kubectl() {
  audit "kubectl $*"
  case "$*" in
    *'get deployment mx-common-hanlp --ignore-not-found -o name')
      [ "$FIXTURE_DEPLOYED" = 0 ] || printf '%s\\n' deployment.apps/mx-common-hanlp ;;
    *'get deployment mx-common-hanlp '*jsonpath*) printf '%s\\n' "$FIXTURE_SPEC" ;;
    *'scale deployment.apps/mx-common-hanlp --replicas=1') FIXTURE_SCALED=1 ;;
    *) printf 'UNEXPECTED kubectl %s\\n' "$*" >&2; return 93 ;;
  esac
}
containerd_has_image() { audit "image-present $*"; [ "$FIXTURE_PRESENT" = 1 ]; }
docker() {
  audit "docker $*"
  case "$*" in
    'image inspect --format {{.Id}} '*) printf '%s\\n' "$FIXTURE_DOCKER_ID"; return "$FIXTURE_DOCKER_STATUS" ;;
    *) printf 'UNEXPECTED docker %s\\n' "$*" >&2; return 93 ;;
  esac
}
require_local_single_k8s_node() {
  audit local-node
  MX_COMMON_HANLP_NODE_NAME="$FIXTURE_LOCAL_NODE"
  return "$FIXTURE_LOCAL_STATUS"
}
require_hanlp_disk_capacity() { audit disk-capacity; return "$FIXTURE_DISK_STATUS"; }
import_hanlp_image() { audit "import $HANLP_IMAGE $MX_COMMON_HANLP_IMAGE_ID"; return "$FIXTURE_IMPORT_STATUS"; }
build_hanlp_image() { audit UNEXPECTED-build; return 93; }
common_ctr() { audit UNEXPECTED-containerd; return 93; }
ctr() { audit UNEXPECTED-ctr; return 93; }
sudo() { audit UNEXPECTED-sudo; return 93; }
hanlp_is_healthy() { audit health; }
${script}
`, 'fixture', manage], { encoding: 'utf8', env, timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message);
  result.events = fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${result.events.join('\n')}`, /UNEXPECTED/);
  assert.ok(!result.events.some(event => /^(docker (pull|build)|kubectl .* (apply|delete|patch)|UNEXPECTED)/.test(event)), result.events.join('\n'));
  return result;
}

function spec(overrides = {}) {
  const values = { image: liveImage, seed: liveImage, policy: 'Never', seedPolicy: 'Never', id: imageId, node: 'internal-node', ...overrides };
  return [values.image, values.seed, values.policy, values.seedPolicy, values.id, values.node].join('\t');
}

test('restores the retained custom image from matching Docker cache without changing caller image settings', t => {
  const r = run(t, `restore_existing_hanlp_image
printf 'caller-image=%s\\n' "$HANLP_IMAGE"`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.events.includes(`import ${liveImage} ${imageId}`));
  assert.ok(r.events.includes(`docker image inspect --format {{.Id}} ${liveImage}`));
  assert.ok(r.events.indexOf('local-node') < r.events.indexOf(`import ${liveImage} ${imageId}`));
  assert.ok(r.events.indexOf('disk-capacity') < r.events.indexOf(`import ${liveImage} ${imageId}`));
  assert.match(r.stdout, /caller-image=environment-image:must-not-be-used/);
});

test('equivalent short and canonical image references can share the recorded image identity', t => {
  const r = run(t, 'restore_existing_hanlp_image', {
    FIXTURE_SPEC: spec({ image: 'mx-common-hanlp:local', seed: 'docker.io/library/mx-common-hanlp:local' }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.events.includes(`import mx-common-hanlp:local ${imageId}`));
});

test('an existing runtime image needs no Docker cache or local-node recovery', t => {
  const r = run(t, 'restore_existing_hanlp_image', { FIXTURE_PRESENT: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.events.some(event => /^(need |docker |local-node|import )/.test(event)), r.events.join('\n'));
});

test('registry-managed deployments retain their ordinary pull lifecycle', t => {
  const r = run(t, 'restore_existing_hanlp_image', {
    FIXTURE_SPEC: spec({ policy: 'IfNotPresent', seedPolicy: 'Always', id: '', node: '' }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.events.some(event => /^(image-present |docker |local-node|import )/.test(event)), r.events.join('\n'));
});

for (const [name, options] of [
  ['missing Docker cache', { FIXTURE_DOCKER_ID: '', FIXTURE_DOCKER_STATUS: '1' }],
  ['Docker cache with different content', { FIXTURE_DOCKER_ID: otherId }],
  ['missing recorded image ID', { FIXTURE_SPEC: spec({ id: '' }) }],
  ['unmanaged recorded image ID', { FIXTURE_SPEC: spec({ id: 'unmanaged' }) }],
  ['different seed image', { FIXTURE_SPEC: spec({ seed: 'registry.example.test/team/other:retained' }) }],
  ['mixed local and registry pull policies', { FIXTURE_SPEC: spec({ seedPolicy: 'IfNotPresent' }) }],
  ['missing pinned node', { FIXTURE_SPEC: spec({ node: '' }) }],
  ['deployment pinned to another node', { FIXTURE_LOCAL_NODE: 'other-node' }],
  ['remote or multi-node Kubernetes context', { FIXTURE_LOCAL_STATUS: '1' }],
  ['insufficient disk capacity', { FIXTURE_DISK_STATUS: '1' }],
]) test(`refuses ${name} without importing or mutating workloads`, t => {
  const r = run(t, 'restore_existing_hanlp_image', options);
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(!r.events.some(event => /^(import |kubectl .* scale )/.test(event)), r.events.join('\n'));
});

test('failed import propagates failure instead of reporting recovery', t => {
  const r = run(t, 'restore_existing_hanlp_image', { FIXTURE_IMPORT_STATUS: '1' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(r.events.includes(`import ${liveImage} ${imageId}`));
});

for (const mode of ['failed-export', 'changed-tag']) {
  test(`archive import rejects ${mode} before containerd and removes its temporary archive`, t => {
    const r = run(t, `
MX_COMMON_HANLP_IMAGE_ID="$FIXTURE_DOCKER_ID"
mktemp() { command mktemp "$FIXTURE_ROOT/archive.XXXXXX"; }
docker() {
  audit "docker $*"
  case "$*" in
    'image save -o '*) printf partial-archive >"$4"; ${mode === 'failed-export' ? 'return 1' : 'return 0'} ;;
    'image inspect --format {{.Id}} '*) printf '%s\\n' '${otherId}' ;;
    *) audit UNEXPECTED-docker; return 93 ;;
  esac
}
actual_import_hanlp_image
`);
    assert.notEqual(r.status, 0, r.stdout);
    assert.ok(r.events.some(event => event.startsWith('docker image save -o ')));
    const archiveEvent = r.events.find(event => event.startsWith('docker image save -o '));
    const archive = archiveEvent.slice('docker image save -o '.length).split(' ')[0];
    assert.deepEqual(fs.readdirSync(path.dirname(archive)), ['events'], 'no temporary archive or orphan remains');
    if (mode === 'failed-export') assert.ok(!r.events.some(event => event.startsWith('docker image inspect ')));
  });
}

test('ensure does not install HanLP when the deployment is absent', t => {
  const r = run(t, `workload_ready() { audit UNEXPECTED-ready; return 1; }
resume_existing_hanlp`, { FIXTURE_DEPLOYED: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.events.length, 1);
  assert.match(r.events[0], /get deployment mx-common-hanlp --ignore-not-found -o name$/);
});

test('healthy HanLP bypasses image recovery and still checks health', t => {
  const r = run(t, `workload_ready() { audit ready; return 0; }
wait_ready() { audit "wait $*"; }
resume_existing_hanlp`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.events.includes('health'));
  assert.ok(!r.events.some(event => /^(image-present |docker |import |local-node)/.test(event)), r.events.join('\n'));
  assert.ok(!r.events.some(event => event.includes('jsonpath')), r.events.join('\n'));
});

test('a stopped deployment is scaled before readiness inspection and missing-image restoration', t => {
  // Kubernetes rollout status accepts a zero-replica deployment. Only the
  // post-scale check can show that the resumed Pod needs its missing image.
  const r = run(t, `workload_ready() { audit "ready-after-scale=$FIXTURE_SCALED"; [ "$FIXTURE_SCALED" = 0 ]; }
wait_ready() { audit "wait $*"; }
resume_existing_hanlp`);
  assert.equal(r.status, 0, r.stderr);
  const imported = r.events.indexOf(`import ${liveImage} ${imageId}`);
  const scaled = r.events.findIndex(event => event.includes('scale deployment.apps/mx-common-hanlp'));
  const checked = r.events.indexOf('ready-after-scale=1');
  assert.ok(scaled >= 0 && checked > scaled && imported > checked, r.events.join('\n'));
  assert.ok(r.events.includes('wait deployment mx-common-hanlp required 60'));
  assert.ok(r.events.includes('health'));
});

test('failed image recovery stops resume before readiness wait or health requests', t => {
  const r = run(t, `workload_ready() { return 1; }
wait_ready() { audit UNEXPECTED-wait; }
resume_existing_hanlp`, { FIXTURE_DOCKER_ID: otherId });
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(!r.events.some(event => /^health$/.test(event)), r.events.join('\n'));
});

function waitScript(reason, readyAt = 999, grace = 60) {
  return `
SECONDS=0
WAIT_TIMEOUT=1200
sleep() { audit "sleep $*"; SECONDS=$((SECONDS + $1)); }
workload_ready() { [ "$SECONDS" -ge ${readyAt} ]; }
pod_terminal_reason() { printf '%s\\n' '${reason}'; }
pod_progress() { :; }
diagnose_workload() { audit diagnose; }
kubectl() { audit "kubectl $*"; printf '%s\\n' mx-common-hanlp:local; }
wait_ready deployment mx-common-hanlp required ${grace}
`;
}

test('freshly imported NeverPull image allows kubelet to retry a stale waiting status', t => {
  const r = run(t, waitScript('ErrImageNeverPull', 10));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.events.filter(event => event.startsWith('sleep ')).length, 2);
  assert.match(r.stdout, /mx-common-hanlp is ready/);
});

test('persistent NeverPull failure stops when recovery grace expires', t => {
  const r = run(t, waitScript('ErrImageNeverPull'));
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.events.filter(event => event.startsWith('sleep ')).length, 12);
  assert.match(r.stderr, /ErrImageNeverPull/);
});

for (const reason of ['ErrImagePull', 'ImagePullBackOff', 'CrashLoopBackOff', 'InvalidImageName', 'CreateContainerConfigError']) {
  test(`image recovery grace never conceals ${reason}`, t => {
    const r = run(t, waitScript(reason));
    assert.notEqual(r.status, 0, r.stdout);
    assert.ok(!r.events.some(event => event.startsWith('sleep ')), r.events.join('\n'));
    assert.match(r.stderr, new RegExp(reason));
  });
}

test('ordinary readiness waits retain immediate NeverPull failure without a recovery grace', t => {
  const r = run(t, waitScript('ErrImageNeverPull', 999, 0));
  assert.notEqual(r.status, 0, r.stdout);
  assert.ok(!r.events.some(event => event.startsWith('sleep ')), r.events.join('\n'));
});
