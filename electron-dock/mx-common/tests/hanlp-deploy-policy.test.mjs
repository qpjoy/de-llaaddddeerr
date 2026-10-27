import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url));
const imageId = `sha256:${'a'.repeat(64)}`;
const ready = { status: 'ready', pool: { workers: 5, liveWorkers: 5 } };

// This fake applies the rendered template to a local file, not a cluster. It
// models template equality only; real Kubernetes rollout behavior is not tested.
const kubectlFixture = String.raw`
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const audit = event => fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(event) + '\n');
const stateFile = process.env.FIXTURE_STATE;
audit({ command: 'kubectl', args: args.slice(0, 10) });
if (args[0] === 'apply' && args[1] === '-f' && args.length === 3) {
  const source = fs.readFileSync(args[2] === '-' ? 0 : args[2], 'utf8');
  const document = source.split(/^---\s*$/m).find(value => /^kind: Deployment$/m.test(value));
  if (!document) process.exit(0);
  if (!/^  name: mx-common-hanlp$/m.test(document)) throw Error('Unexpected Deployment');
  const lines = document.slice(document.indexOf('  template:\n')).split('\n');
  const template = lines.filter(line => line.trim() && !line.trimStart().startsWith('#')).join('\n');
  const capEntry = /^(\s*)- name: MAX_CONCURRENT_INFERENCES\n\1  value: "([^"\n]*)"$/m;
  const cap = template.match(capEntry)?.[2] ?? null;
  const previous = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : { template: process.env.FIXTURE_INITIAL === 'old-image' ? template.replace(process.env.FIXTURE_IMAGE_ID, 'sha256:old-image') : template, changes: 0 };
  const changed = previous.template !== template;
  const state = { template, cap, changes: previous.changes + Number(changed) };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  audit({ command: 'apply-hanlp', cap, changed, changes: state.changes,
    images: [...template.matchAll(/^\s+image: (.+)$/gm)].map(match => match[1]) });
  process.exit(0);
}
const expected = ['-n', 'mx-common', '--request-timeout=15s', 'exec', 'deployment/mx-common-hanlp', '-c', 'hanlp', '--', 'python', '-c'];
if (args.length === expected.length + 1 && expected.every((value, index) => args[index] === value)) {
  const cap = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).cap : JSON.parse(process.env.FIXTURE_CAP);
  const env = { ...process.env };
  delete env.MAX_CONCURRENT_INFERENCES;
  if (cap !== null) env.MAX_CONCURRENT_INFERENCES = cap;
  const result = spawnSync('python3', ['-I', '-B', process.env.FIXTURE_PYTHON, args[10]], { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  audit({ command: 'policy', status: result.status });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 93);
}
throw Error('UNEXPECTED kubectl command');
`;

// Execute the production inline Python with a fake HTTP response. Replacing
// socket creation also prevents a future probe change from reaching a network.
const pythonFixture = String.raw`
import io, json, os, socket, sys, urllib.request
def forbidden(*args, **kwargs):
    raise AssertionError('UNEXPECTED network access')
socket.socket = forbidden
class Response(io.BytesIO):
    status = 200
    def getcode(self):
        return self.status
def urlopen(url, timeout=None):
    assert url == 'http://127.0.0.1:8000/health'
    assert timeout is not None and 0 < timeout <= 15
    return Response(os.environ['FIXTURE_HEALTH'].encode())
urllib.request.urlopen = urlopen
exec(compile(sys.argv[1], '<production-hanlp-policy>', 'exec'))
`;

function run(t, script, { initial = 'current-image', health = ready, cap = null, smokeStatus = 0, waitStatus = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-hanlp-policy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = path.join(root, 'events.jsonl');
  const state = path.join(root, 'state.json');
  fs.writeFileSync(events, '');
  fs.writeFileSync(path.join(root, 'kubectl.cjs'), kubectlFixture);
  fs.writeFileSync(path.join(root, 'policy.py'), pythonFixture);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['kubectl', 'docker', 'ctr', 'sudo']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nprintf "UNEXPECTED runtime tool\\n" >&2\nexit 93\n', { mode: 0o755 });
  }
  const result = spawnSync('bash', ['-c', `
source "$1"
audit() { printf '{"command":"%s"}\\n' "$1" >>"$FIXTURE_EVENTS"; }
need() { :; }
kubectl() { "$FIXTURE_NODE" "$FIXTURE_ROOT/kubectl.cjs" "$@"; }
docker() { audit UNEXPECTED-docker; return 93; }
ctr() { audit UNEXPECTED-ctr; return 93; }
sudo() { audit UNEXPECTED-sudo; return 93; }
resolve_host_data_root() { :; }
require_local_single_k8s_node() { MX_COMMON_HANLP_NODE_NAME=fixture-node; }
report_capacity() { :; }
require_hanlp_disk_capacity() { :; }
build_hanlp_image() { audit build; MX_COMMON_HANLP_IMAGE_ID="$FIXTURE_IMAGE_ID"; }
import_hanlp_image() { audit import; }
ensure_hanlp_storage() { :; }
allow_hostnetwork_clients() { :; }
allow_client_namespace() { :; }
wait_ready() { audit wait; return "$FIXTURE_WAIT_STATUS"; }
diagnose_workload() { audit diagnose; }
hanlp_tokenize_smoke() { audit smoke; return "$FIXTURE_SMOKE_STATUS"; }
${script}
`, 'fixture', manage], {
    encoding: 'utf8', timeout: 10000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: root,
      FIXTURE_ROOT: root, FIXTURE_EVENTS: events, FIXTURE_STATE: state,
      FIXTURE_PYTHON: path.join(root, 'policy.py'), FIXTURE_NODE: process.execPath,
      FIXTURE_IMAGE_ID: imageId, FIXTURE_INITIAL: initial,
      FIXTURE_HEALTH: JSON.stringify(health), FIXTURE_CAP: JSON.stringify(cap),
      FIXTURE_SMOKE_STATUS: String(smokeStatus), FIXTURE_WAIT_STATUS: String(waitStatus),
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  result.events = fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  result.state = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : null;
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(result.events), /UNEXPECTED/);
  return result;
}

for (const initial of ['current-image', 'old-image']) {
  test(`two deploys retain runtime parallelism without redundant template changes from ${initial} state`, t => {
    const result = run(t, 'cmd_deploy_hanlp\ncmd_deploy_hanlp', { initial });
    assert.equal(result.status, 0, result.stderr);
    const applies = result.events.filter(event => event.command === 'apply-hanlp');
    assert.deepEqual(applies.map(event => event.cap), ['5', '5']);
    assert.deepEqual(applies.map(event => event.changed), [initial === 'old-image', false]);
    assert.equal(result.state.changes, initial === 'old-image' ? 1 : 0);
    assert.deepEqual(applies.map(event => event.images), [
      ['mx-common-hanlp:local', 'mx-common-hanlp:local'],
      ['mx-common-hanlp:local', 'mx-common-hanlp:local'],
    ]);
    assert.equal(result.events.filter(event => event.command === 'build').length, 2);
    assert.equal(result.events.filter(event => event.command === 'import').length, 2);
    assert.deepEqual(result.events.filter(event => ['wait', 'policy', 'smoke'].includes(event.command)).map(event => event.command),
      ['wait', 'policy', 'smoke', 'wait', 'policy', 'smoke']);
  });
}

test('a ready but incomplete worker pool fails deployment before the tokenize smoke', t => {
  const result = run(t, 'cmd_deploy_hanlp', { health: { status: 'ready', pool: { workers: 5, liveWorkers: 4 } } });
  assert.notEqual(result.status, 0);
  assert.equal(result.events.filter(event => event.command === 'policy').length, 1);
  assert.equal(result.events.some(event => event.command === 'smoke'), false);
  assert.doesNotMatch(result.stdout, /HanLP deployment ready:/);
});

for (const [name, options] of [
  ['invalid cap', { cap: 'invalid' }],
  ['zero cap', { cap: '0' }],
  ['five workers despite a single-worker cap', { cap: '1' }],
  ['undersized pool for the deployed cap', { cap: '5', health: { status: 'ready', pool: { workers: 1, liveWorkers: 1 } } }],
  ['dead worker', { health: { status: 'ready', pool: { workers: 1, liveWorkers: 0 } } }],
  ['boolean worker counts', { health: { status: 'ready', pool: { workers: true, liveWorkers: true } } }],
  ['non-ready model', { health: { status: 'loading', pool: { workers: 1, liveWorkers: 1 } } }],
  ['missing pool', { health: { status: 'ready' } }],
]) {
  test(`the actual worker-policy Python rejects ${name}`, t => {
    const result = run(t, 'hanlp_verify_worker_pool', options);
    assert.notEqual(result.status, 0);
    assert.equal(result.events.filter(event => event.command === 'policy').length, 1);
  });
}

for (const [name, options] of [
  ['five workers with automatic sizing', {}],
  ['five workers with an explicit cap', { cap: '5' }],
  ['an emergency single worker', { cap: '1', health: { status: 'ready', pool: { workers: 1, liveWorkers: 1 } } }],
]) {
  test(`the actual worker-policy Python accepts ${name}`, t => {
    const result = run(t, 'hanlp_verify_worker_pool', options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events.filter(event => event.command === 'policy').map(event => event.status), [0]);
  });
}

test('rollout readiness failure prevents the policy probe and smoke', t => {
  const result = run(t, 'cmd_deploy_hanlp', { waitStatus: 1 });
  assert.notEqual(result.status, 0);
  assert.equal(result.events.some(event => ['policy', 'smoke'].includes(event.command)), false);
});

test('tokenize contract failure prevents a successful deployment receipt', t => {
  const result = run(t, 'cmd_deploy_hanlp', { smokeStatus: 1 });
  assert.notEqual(result.status, 0);
  assert.equal(result.events.filter(event => event.command === 'policy').length, 1);
  assert.equal(result.events.filter(event => event.command === 'smoke').length, 1);
  assert.doesNotMatch(result.stdout, /HanLP deployment ready:/);
});
