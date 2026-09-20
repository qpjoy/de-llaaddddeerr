import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { volumes, postgresIdentifier, preflight } from '../scripts/storage-preflight.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mx-common-storage-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = path.join(root, 'receipt.json');
  const control = Buffer.alloc(8192);
  control.writeBigUInt64LE(7671038612254789664n); control.writeUInt32LE(1300, 8);
  for (const suffix of ['postgres/data/pgdata/global', 'postgres/data/pgdata/base', 'elasticsearch/data/_state', 'elasticsearch/snapshots']) fs.mkdirSync(`${root}/${suffix}`, { recursive: true });
  fs.writeFileSync(`${root}/postgres/data/pgdata/PG_VERSION`, '16\n');
  fs.writeFileSync(`${root}/postgres/data/pgdata/global/pg_control`, control);
  const resources = new Map();
  for (const [pv, pvc, suffix] of volumes) {
    resources.set(`pv:${pv}`, { metadata: { name: pv }, spec: { hostPath: { path: `${root}/${suffix}`, type: 'Directory' }, persistentVolumeReclaimPolicy: 'Retain', claimRef: { namespace: 'mx-common', name: pvc, uid: pvc } }, status: { phase: 'Bound' } });
    resources.set(`pvc:${pvc}`, { metadata: { name: pvc, namespace: 'mx-common', uid: pvc }, spec: { storageClassName: '', volumeName: pv }, status: { phase: 'Bound' } });
  }
  resources.set('secret:mx-common-secrets', { data: { 'postgres-password': 'fixture' } });
  resources.set('statefulset:mx-common-postgres', { spec: { template: { spec: { containers: [{ name: 'postgres', command: ['sh', '-c', 'pg_controldata 7671038612254789664'] }] } } } });
  const context = { mount: { target: '/data', uuid: 'test-fs-uuid' }, calls: [], resources };
  context.command = (cmd, args) => {
    context.calls.push([cmd, ...args]);
    if (cmd === 'findmnt') return JSON.stringify({ filesystems: [context.mount] });
    assert.equal(cmd, 'kubectl');
    const offset = args.indexOf('get'); assert.ok(offset >= 0, 'preflight may only read Kubernetes');
    const [kind, name] = args.slice(offset + 1);
    if (kind === 'nodes') return JSON.stringify({ items: [{ metadata: { labels: { 'kubernetes.io/hostname': os.hostname() } }, status: { addresses: [] } }] });
    return JSON.stringify(resources.get(`${kind}:${name}`) ?? null).replace(/^null$/, '');
  };
  const run = () => preflight(root, receipt, { platform: 'linux', command: context.command });
  return { root, receipt, context, run, control };
}

test('enrolls retained bindings including omitted PV class, remains idempotent across restart', t => {
  const f = fixture(t);
  const before = fs.readFileSync(`${f.root}/postgres/data/pgdata/global/pg_control`);
  const first = f.run(); assert.equal(first.identifier, '7671038612254789664');
  assert.equal(first.mode, 'local'); assert.equal(fs.statSync(f.receipt).mode & 0o777, 0o600);
  assert.deepEqual(f.run(), first);
  assert.deepEqual(fs.readFileSync(`${f.root}/postgres/data/pgdata/global/pg_control`), before);
});

for (const [name, mutate, message] of [
  ['PV metadata lost', f => f.context.resources.delete('pv:mx-common-postgres-data'), /metadata missing/],
  ['wrong path', f => { f.context.resources.get('pv:mx-common-postgres-data').spec.hostPath.path = '/empty/postgres/data'; }, /host path/],
  ['wrong claim UID', f => { f.context.resources.get('pv:mx-common-postgres-data').spec.claimRef.uid = 'other'; }, /claim identity/],
  ['PVC default class ambiguity', f => { delete f.context.resources.get('pvc:data-mx-common-postgres-0').spec.storageClassName; }, /explicit static/],
  ['terminating volume', f => { f.context.resources.get('pv:mx-common-postgres-data').metadata.deletionTimestamp = 'now'; }, /terminating/],
  ['Released volume', f => { f.context.resources.get('pv:mx-common-postgres-data').status.phase = 'Released'; }, /not Bound/],
  ['superuser Secret lost', f => f.context.resources.delete('secret:mx-common-secrets'), /Secret missing/],
  ['PostgreSQL data missing', f => fs.unlinkSync(`${f.root}/postgres/data/pgdata/PG_VERSION`), /ENOENT/],
  ['Elasticsearch data missing', f => fs.rmdirSync(`${f.root}/elasticsearch/data/_state`), /metadata missing/],
  ['different existing guard', f => { f.context.resources.get('statefulset:mx-common-postgres').spec.template.spec.containers[0].command = ['pg_controldata other']; }, /different database/],
]) test(`rejects ${name} before recording or starting any workload`, t => {
  const f = fixture(t); mutate(f); assert.throws(f.run, message); assert.equal(fs.existsSync(f.receipt), false);
});

test('filesystem or database swap cannot overwrite a previously recorded identity', t => {
  const f = fixture(t); f.run(); const saved = fs.readFileSync(f.receipt, 'utf8');
  f.context.mount.uuid = 'replacement'; assert.throws(f.run, /filesystemUUID/);
  f.context.mount.uuid = 'test-fs-uuid'; f.context.mount.target = '/'; assert.throws(f.run, /mountTarget/);
  f.context.mount.target = '/data';
  f.control.writeBigUInt64LE(7671038612254789665n); fs.writeFileSync(`${f.root}/postgres/data/pgdata/global/pg_control`, f.control);
  f.context.resources.delete('statefulset:mx-common-postgres'); assert.throws(f.run, /identifier/);
  assert.equal(fs.readFileSync(f.receipt, 'utf8'), saved);
});

test('lost all PVs does not become fresh install when retained credentials or files exist', t => {
  const f = fixture(t);
  for (const [pv, pvc] of volumes) { f.context.resources.delete(`pv:${pv}`); f.context.resources.delete(`pvc:${pvc}`); }
  assert.throws(f.run, /retained PostgreSQL/);
  fs.rmSync(`${f.root}/postgres`, { recursive: true });
  fs.rmSync(`${f.root}/elasticsearch/data`, { recursive: true });
  f.context.resources.set('secret:mx-insight-hub-secrets', { data: {} });
  assert.throws(f.run, /retained Hub credentials/);
});

test('PG16 identity reader rejects version, size and endian mismatches', t => {
  const f = fixture(t);
  assert.throws(() => postgresIdentifier(f.control, '15'), /PG16/);
  assert.throws(() => postgresIdentifier(f.control.subarray(0, 100), '16'), /PG16/);
  assert.throws(() => postgresIdentifier(f.control, '16', 'BE'), /byte order/);
});

const common = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url));
function bash(script) { return spawnSync('bash', ['-c', `source "$1"\n${script}`, 'fixture', common], { encoding: 'utf8' }); }

test('ensure storage refusal happens before sysctl, image import, Secret or workload mutation', () => {
  const result = bash(`
need() { :; }; resolve_host_data_root() { :; }
storage_preflight() { storage_guard_failed "fixture disk unavailable"; }
kubectl() { echo UNEXPECTED; }; ensure_vm_max_map_count() { echo UNEXPECTED; }
report_image_readiness() { echo UNEXPECTED; }; ensure_secret() { echo UNEXPECTED; }
cmd_ensure`);
  assert.equal(result.status, 78); assert.doesNotMatch(result.stdout, /UNEXPECTED/);
});

test('stopped dependencies are explicitly resumed before successful ensure', () => {
  const result = bash(`
need() { :; }; resolve_host_data_root() { :; }; storage_preflight() { MX_COMMON_STORAGE_MODE=local; }
es_is_healthy() { return 0; }; ensure_vm_max_map_count() { :; }; check_storage_headroom() { :; }; report_capacity() { :; }
report_image_readiness() { :; }; ensure_secret() { :; }; ensure_storage() { :; }; apply_manifests() { :; }
allow_client_namespace() { :; }; ensure_elasticsearch_disk_policy() { :; }; ensure_snapshot_policy() { :; }; health_json() { echo '{}'; }
kubectl() { echo "KUBE $*" >&2; if [[ "$*" == *'get deployment mx-common-hanlp'* ]]; then echo deployment.apps/mx-common-hanlp; fi; }
wait_ready() { echo "READY $*"; }; hanlp_is_healthy() { :; }
cmd_ensure`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /scale statefulset\/mx-common-postgres statefulset\/mx-common-elasticsearch deployment\/mx-common-redis --replicas=1/);
  assert.match(result.stderr, /scale deployment.apps\/mx-common-hanlp --replicas=1/);
  assert.match(result.stdout, /READY deployment mx-common-hanlp/);
});

test('preload imports cached Docker image without network pull and catches pipeline failure', () => {
  for (const failed of [false, true]) {
    const result = bash(`
need() { :; }; images_in_use() { echo image:test; }; id() { echo 0; }
containerd_has_image() { [ -e "$MX_FIXTURE_IMPORT" ]; }
docker() { echo "DOCKER $*" >&2; case "$*" in 'image inspect image:test') return 0;; 'image save image:test') echo IMAGE;; *) return 9;; esac; }
ctr() { cat >/dev/null; ${failed ? 'return 1' : 'touch "$MX_FIXTURE_IMPORT"'}; }
MX_FIXTURE_IMPORT="$(mktemp)"; rm "$MX_FIXTURE_IMPORT"; trap 'rm -f "$MX_FIXTURE_IMPORT"' EXIT
cmd_preload`);
    assert.equal(result.status, failed ? 1 : 0, result.stderr);
    assert.doesNotMatch(result.stderr, /DOCKER pull/);
    if (failed) assert.doesNotMatch(result.stdout, /all shared data-plane images are present/);
  }
});

test('rendered PostgreSQL guard passes original server arguments and refuses a missing identity', t => {
  const f = fixture(t);
  const rendered = execFileSync('bash', ['-c', 'source "$1"; MX_COMMON_EXPECTED_PG_SYSTEM_ID=7671038612254789664; render_manifest "$K8S_DIR/common/10-postgres.yaml"', 'test', common], { encoding: 'utf8' });
  const script = rendered.split('            - |\n')[1].split('            - mx-common-postgres')[0].replace(/^              /gm, '');
  const result = spawnSync('sh', ['-ec', script, 'mx-common-postgres', '-c', 'shared_buffers=2GB'], { encoding: 'utf8', env: { ...process.env, PGDATA: `${f.root}/missing` } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /initialization refused/);
  fs.mkdirSync(`${f.root}/bin`);
  fs.writeFileSync(`${f.root}/bin/pg_controldata`, '#!/bin/sh\necho "Database system identifier: 7671038612254789664"\n', { mode: 0o700 });
  fs.writeFileSync(`${f.root}/bin/docker-entrypoint.sh`, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const valid = spawnSync('sh', ['-ec', script, 'mx-common-postgres', '-c', 'shared_buffers=2GB'], { encoding: 'utf8', env: { ...process.env, PATH: `${f.root}/bin:${process.env.PATH}`, PGDATA: `${f.root}/postgres/data/pgdata` } });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, 'postgres\n-c\nshared_buffers=2GB\n');
});
