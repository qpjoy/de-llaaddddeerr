import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCredentials } from '../scripts/runtime-credentials-preflight.mjs';
const encode = x => Buffer.from(x).toString('base64');
const desired = { pepper: 'test-only-retained-pepper', password: '' };
const product = { data: { password: encode('TestPassword'), username: encode('mx_insight_hub'), database: encode('mx_insight_hub') } };
const hub = { data: { MX_INSIGHT_API_KEY_PEPPER: encode(desired.pepper), DATABASE_URL: encode('postgres://mx_insight_hub:TestPassword@mx-common-postgres.mx-common.svc.cluster.local:5432/mx_insight_hub') } };
test('accepts first installation and matching retained credentials without printing their values', () => {
  validateCredentials(null, null, desired);
  validateCredentials(hub, product, desired);
  validateCredentials(hub, product, { ...desired, password: 'TestPassword' });
});
for (const [label, h, p, d, match] of [
  ['Hub Secret lost', null, product, desired, /Hub Secret is missing/],
  ['product Secret lost', hub, null, desired, /product database Secret is missing/],
  ['changed pepper', hub, product, { pepper: 'wrong' }, /pepper differs/],
  ['changed pinned password', hub, product, { ...desired, password: 'AnotherPassword' }, /cannot rotate/],
  ['credentials disagree', hub, { data: { ...product.data, password: encode('AnotherPassword') } }, desired, /credentials disagree/],
  ['wrong database host', { data: { ...hub.data, DATABASE_URL: encode('postgres://mx_insight_hub:TestPassword@other/mx_insight_hub') } }, product, desired, /credentials disagree/],
]) test(`rejects ${label} with a value-free diagnostic`, () => {
  let error; try { validateCredentials(h, p, d); } catch (e) { error = e; }
  assert.ok(error); assert.match(error.message, match);
  for (const value of ['TestPassword', 'AnotherPassword', desired.pepper, 'postgres://']) assert.ok(!error.message.includes(value));
});

const manage = fileURLToPath(new URL('../scripts/manage.sh', import.meta.url));
function bash(script, environment = {}) { return spawnSync('bash', ['-c', `source "$1"\n${script}`, 'fixture', manage], { encoding: 'utf8', env: { ...process.env, ...environment } }); }

test('normal deploy refuses a degraded dependency before product provisioning', () => {
  const r = bash(`
say() { echo "$*"; }; bash() { return 1; }
ensure_hub_database() { echo UNEXPECTED_PROVISION; }; discover_launcher_url() { echo UNEXPECTED_LAUNCHER; }
unset MX_INSIGHT_REQUIRE_SEARCH
ensure_shared_data_plane`);
  assert.notEqual(r.status, 0); assert.match(r.stderr + r.stdout, /unhealthy/);
  assert.doesNotMatch(r.stderr + r.stdout, /UNEXPECTED/);
});

test('explicit degraded mode still cannot bypass storage-identity refusal', () => {
  const r = bash(`
say() { echo "$*"; }; bash() { return 78; }
ensure_hub_database() { echo UNEXPECTED_PROVISION; }
MX_INSIGHT_REQUIRE_SEARCH=0
ensure_shared_data_plane`);
  assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /UNEXPECTED/); assert.match(r.stderr + r.stdout, /storage identity/);
});

test('workers paused by incident recovery resume at versioned replica counts', () => {
  const r = bash('kubectl() { echo "$*"; }; restore_worker_replicas');
  assert.equal(r.status, 0, r.stderr);
  const commands = r.stdout.trim().split('\n'); assert.equal(commands.length, 4);
  for (const [file, name] of [['32-projector', 'projector'], ['33-ingest', 'ingest'], ['34-classifier', 'classifier'], ['35-retrieval', 'retrieval']]) {
    const yaml = fs.readFileSync(new URL(`../deploy/k8s/internal/${file}.yaml`, import.meta.url), 'utf8');
    const replicas = yaml.match(/^  replicas: (\d+)$/m)[1];
    assert.ok(commands.includes(`-n mx-insight-hub scale deployment/mx-insight-hub-${name} --replicas=${replicas}`));
  }
  assert.doesNotMatch(r.stdout, /launcher|reindex|vector/i);
});

test('both deploy entry points check credential continuity before touching shared services', () => {
  const source = fs.readFileSync(manage, 'utf8');
  const ops = source.slice(source.indexOf('ops_action()'));
  for (const action of ['deploy', 'apply']) {
    const body = ops.split(`    ${action})\n`)[1].split('      ;;')[0];
    assert.ok(body.indexOf('runtime-credentials-preflight.mjs') < body.indexOf('ensure_shared_data_plane'));
    assert.ok(body.indexOf('validate_existing_runtime_secret') < body.indexOf('ensure_shared_data_plane'));
  }
});

test('a persisted Launcher sync flag cannot make independent Hub recovery roll the login plane', () => {
  for (const explicit of ['', '0', '1']) {
    const result = bash(`
${explicit ? `export MX_INSIGHT_SYNC_LAUNCHER=${explicit}` : 'unset MX_INSIGHT_SYNC_LAUNCHER'}
load_env_file() { MX_INSIGHT_SYNC_LAUNCHER=1; export MX_INSIGHT_SYNC_LAUNCHER; }
need() { :; }; kubectl() { printf '%s' "$MX_INSIGHT_SYNC_LAUNCHER"; }
ops_action internal-production status`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, explicit === '1' ? '11' : '00');
  }
});

test('rebooted deploy lock is reclaimed despite PID reuse, while active same-boot/recovery owners stay protected', async t => {
  const os = await import('node:os'); const path = await import('node:path');
  for (const previous of ['old-boot', 'current-boot', 'legacy']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-hub-lock-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const lock = path.join(root, 'internal-production-deploy.lock'); fs.mkdirSync(lock);
    // A real live PID simulates both PID reuse and an active recovery process.
    fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
    if (previous !== 'legacy') fs.writeFileSync(path.join(lock, 'boot-id'), `${previous}\n`);
    const result = bash(`
RUNTIME_DIR="$MX_TEST_LOCK_ROOT"
deployment_boot_id() { echo current-boot; }
acquire_deploy_lock`, { MX_TEST_LOCK_ROOT: root });
    assert.equal(result.status, previous === 'old-boot' ? 0 : 1, result.stderr);
    if (previous === 'old-boot') {
      assert.equal(fs.readFileSync(path.join(lock, 'boot-id'), 'utf8'), 'current-boot\n');
      assert.notEqual(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(process.pid));
    } else assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(process.pid));
  }
});

test('successful deploy obeys dependency order; a failed credential gate cannot start services', () => {
  for (const reject of [false, true]) {
    const result = bash(`
load_env_file() { :; }; need() { :; }; require_production_env() { MX_INSIGHT_API_KEY_PEPPER=fixture; }
require_single_k8s_node() { :; }; init_deploy_runtime() { :; }; acquire_deploy_lock() { :; }
validate_existing_runtime_secret() { echo OLD_SECRET; }
node() { echo CREDENTIAL_GATE; ${reject ? 'return 78' : ':'}; }
ensure_shared_data_plane() { echo COMMON_READY; }
disable_projector_startup_rebuild_for_deploy() { echo INCREMENTAL_ONLY; }
build_and_import_image() { echo BUILD; }; apply_k8s() { echo HUB_READY; }
k8s_smoke() { echo API_CHECK; }; ensure_default_api_key() { :; }; seed_default_price_books() { :; }; print_deploy_summary() { :; }
unset MX_INSIGHT_REQUIRE_SEARCH
ops_action internal-production deploy`);
    assert.equal(result.status, reject ? 78 : 0, result.stderr);
    if (reject) assert.equal(result.stdout, 'OLD_SECRET\nCREDENTIAL_GATE\n');
    else assert.match(result.stdout, /^OLD_SECRET\nCREDENTIAL_GATE\nCOMMON_READY\nINCREMENTAL_ONLY\nBUILD\nHUB_READY\nAPI_CHECK\n.*all six Hub workloads are ready/);
  }
});
