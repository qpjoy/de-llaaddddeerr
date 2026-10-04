import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createOperationsAgent, redactOutput } from './service-operations-agent.mjs';
import { defaultServiceProfile } from '../../desktop/service-operations-catalog.js';

const token = 'test-operations-token-'.repeat(3);
async function fixture(t, runCommand, script = '#!/bin/bash\nprintf "fixture\\n"\n', lifecycleOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mx-operations-test-'));
  const workspace = join(dir, 'workspace');
  for (const name of ['mx-launcher', 'mx-insight-hub', 'mx-base', 'mx-base/mx-pay']) {
    await mkdir(join(workspace, name, 'scripts'), { recursive: true });
    await writeFile(join(workspace, name, 'scripts/manage.sh'), script);
  }
  const git = args => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
  git(['init', '--quiet']); git(['add', '.']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture']);
  const config = { host: 'fixture-only', instances: ['launcher', 'hub', 'embedding', 'ocr', 'pay'].map(service => ({
    id: service, service, profile: { ...defaultServiceProfile(service, workspace), tmpDir: dir }
  })) };
  const stateDir = join(dir, 'state');
  let server;
  const start = async () => {
    server = await createOperationsAgent({ config, stateDir, token, runCommand, ...lifecycleOptions });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  };
  await start();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const request = async (path, body, authorization = token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'x-mx-operations-token': authorization, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  };
  const plan = async (service = 'launcher', action = 'status', profile) => {
    const response = await request('plans', { instanceId: service, action, ...(profile ? { profile } : {}) });
    assert.equal(response.status, 200, response.data.message); return response.data;
  };
  return { dir, workspace, stateDir, config, request, plan, git, restart: async () => { await new Promise(resolve => server.close(resolve)); await start(); } };
}
async function complete(f, id) {
  for (let index = 0; index < 100; index++) {
    const response = await f.request(`operations/${id}`);
    if (!['queued', 'running'].includes(response.data.operation?.status)) return response.data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fixture task did not complete');
}

test('identity registration uses authenticated fixed endpoints and blocks writes during tasks or updates', async t => {
  let saves = 0, reads = 0, finish;
  const identityConsole = {
    overview: async () => { reads++; return { configured: true, entries: [] }; },
    validate: async input => ({ appId: input.appId }),
    save: async () => { saves++; return { saved: true }; }
  };
  const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }), undefined, { identityConsole, onUpdateReady: () => {} });
  assert.equal((await f.request('identity', undefined, '')).status, 401); assert.equal(reads, 0);
  assert.equal((await f.request('identity/applications', { appId: 'mx-pay' }, '')).status, 401); assert.equal(saves, 0);
  assert.equal((await f.request('identity')).data.instanceId, 'launcher');
  assert.deepEqual((await f.request('identity/validate', { appId: 'mx-pay' })).data, { application: { appId: 'mx-pay' } });
  assert.equal((await f.request('identity/applications', { appId: 'mx-pay' })).status, 200); assert.equal(saves, 1);
  const plan = await f.plan('launcher', 'deploy');
  await f.request('execute', { planId: plan.id, acknowledged: true });
  assert.equal((await f.request('identity/applications', { appId: 'mx-other' })).status, 409);
  for (let i = 0; !finish && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  finish({ code: null, uncertain: true }); await complete(f, plan.id);
  assert.equal((await f.request('identity/applications', { appId: 'mx-other' })).status, 409);
  await f.request('reconcile', { operationId: plan.id, note: '测试任务已核实并解除阻塞。' });
  await f.request('lifecycle/update', { runtimeVersion: 'b'.repeat(64) });
  assert.equal((await f.request('identity/applications', { appId: 'mx-other' })).status, 409);
  assert.equal(saves, 1);
});

test('self-update drains accepted commands and persists results before switching; repeated task queries remain available', async t => {
  let finish, finishRead, switches = 0;
  const f = await fixture(t, spec => new Promise(resolve => { if (spec.action === 'deploy') finish = resolve; else finishRead = resolve; }), undefined, {
    runtimeVersion: 'a'.repeat(64), onUpdateReady: async () => {
      const result = JSON.parse(await readFile(join(f.stateDir, 'operations', plan.id + '.json')));
      assert.equal(result.status, 'succeeded'); switches++;
    }
  });
  const plan = await f.plan('launcher', 'deploy');
  await f.request('execute', { planId: plan.id, acknowledged: true });
  const read = await f.plan('ocr', 'status'); await f.request('execute', { planId: read.id });
  const next = await f.plan('hub', 'status');
  for (let i = 0; (!finish || !finishRead) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.request('lifecycle/update', { runtimeVersion: 'b'.repeat(64) }, '')).status, 401);
  const update = await f.request('lifecycle/update', { runtimeVersion: 'b'.repeat(64) });
  assert.equal(update.status, 200); assert.equal(update.data.inFlight, 2);
  assert.equal((await f.request('lifecycle/update', { runtimeVersion: 'b'.repeat(64) })).status, 200);
  assert.equal((await f.request('lifecycle/update', { runtimeVersion: 'c'.repeat(64) })).status, 409);
  assert.equal((await f.request('execute', { planId: next.id })).status, 409);
  assert.equal((await f.request('execute', { planId: plan.id, acknowledged: true })).data.id, plan.id);
  finish({ code: 0 }); await complete(f, plan.id);
  await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(switches, 0, 'read subprocess still running');
  finishRead({ code: 0 }); await complete(f, read.id);
  for (let i = 0; !switches && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(switches, 1); assert.equal((await f.request('lifecycle')).data.updating, true);
});

test('pending update preserves uncertain task lock until reconciliation and invalidates old-version plans', async t => {
  let switches = 0;
  const lifecycleOptions = { runtimeVersion: 'a'.repeat(64), onUpdateReady: () => { switches++; } };
  const f = await fixture(t, async () => ({ code: null, uncertain: true }), undefined, lifecycleOptions);
  const oldPlan = await f.plan('ocr', 'status');
  const plan = await f.plan('launcher', 'deploy');
  await f.request('execute', { planId: plan.id, acknowledged: true }); await complete(f, plan.id);
  await f.request('lifecycle/update', { runtimeVersion: 'b'.repeat(64) });
  await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(switches, 0);
  await f.request('reconcile', { operationId: plan.id, note: '已核对测试任务实际状态，记录完成。' });
  for (let i = 0; !switches && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(switches, 1);
  lifecycleOptions.runtimeVersion = 'b'.repeat(64); await f.restart();
  const stale = await f.request('execute', { planId: oldPlan.id }); assert.equal(stale.status, 409); assert.match(stale.data.message, /版本已变化/);
  assert.equal((await f.request(`operations/${plan.id}`)).data.operation.status, 'reconciled');
});

test('auth, saved profiles, source pinning, execution idempotency and persistent logs', async t => {
  let executions = 0;
  const f = await fixture(t, async (spec, log) => { executions++; log('API_KEY=secret-test\n'); log('fixture complete\n'); return { code: 0 }; });
  assert.equal((await f.request('instances', undefined, '')).status, 401);
  const inventory = await f.request('instances'); assert.equal(inventory.data.instances.length, 5);
  const profile = { ...f.config.instances[0].profile, proxyPort: '7890' };
  assert.equal((await f.request('profiles', { instanceId: 'launcher', profile })).status, 200);
  const plan = await f.plan('launcher', 'status');
  assert.match(plan.revision, /^[a-f0-9]{40}$/);
  const first = await f.request('execute', { planId: plan.id }); assert.equal(first.status, 200);
  const result = await complete(f, plan.id);
  assert.equal(result.operation.status, 'succeeded'); assert.match(result.log, /REDACTED/); assert.doesNotMatch(result.log, /secret-test/);
  const repeat = await f.request('execute', { planId: plan.id }); assert.equal(repeat.data.id, plan.id); assert.equal(executions, 1);
  await f.restart();
  assert.equal((await f.request(`operations/${plan.id}`)).data.operation.status, 'succeeded');
  assert.equal((await f.request('instances')).data.instances[0].profile.proxyPort, '7890');
});

test('wrong target, code drift, dirty releases, config drift and expired plans cannot execute', async t => {
  let executions = 0; const f = await fixture(t, async () => { executions++; return { code: 0 }; });
  const wrong = await f.request('plans', { instanceId: 'launcher', action: 'status', profile: { ...f.config.instances[0].profile, cwd: join(f.workspace, 'mx-base') } });
  assert.equal(wrong.status, 400);
  const plan = await f.plan();
  await writeFile(join(f.workspace, 'untracked.txt'), 'changed');
  assert.equal((await f.request('execute', { planId: plan.id })).status, 409);
  assert.equal((await f.request('plans', { instanceId: 'launcher', action: 'deploy' })).status, 400);
  await rm(join(f.workspace, 'untracked.txt'));
  const script = join(f.workspace, 'mx-launcher/scripts/manage.sh');
  const originalScript = await readFile(script);
  await writeFile(script, '#!/bin/bash\necho first-change\n');
  const dirtyRead = await f.plan();
  await writeFile(script, '#!/bin/bash\necho second-change\n');
  assert.equal((await f.request('execute', { planId: dirtyRead.id })).status, 409);
  await writeFile(script, originalScript);
  await mkdir(join(f.workspace, 'mx-launcher/server'), { recursive: true });
  await writeFile(join(f.workspace, '.gitignore'), '*/server/.env\n'); f.git(['add', '.gitignore']); f.git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'ignore local config']);
  const beforeConfig = await f.plan();
  await writeFile(join(f.workspace, 'mx-launcher/server/.env'), 'FAKE_SECRET=changed\n');
  assert.equal((await f.request('execute', { planId: beforeConfig.id })).status, 409);
  const expired = await f.plan();
  const path = join(f.stateDir, 'plans', `${expired.id}.json`); const data = JSON.parse(await readFile(path)); data.expiresAt = new Date(0).toISOString(); await writeFile(path, JSON.stringify(data));
  assert.equal((await f.request('execute', { planId: expired.id })).status, 409);
  assert.equal(executions, 0);
});

test('payment plans bind private SSO/access and target configuration and never return secret contents', async t => {
  let executions = 0;
  const f = await fixture(t, async () => { executions++; return { code: 0 }; });
  const pay = join(f.workspace, 'mx-base/mx-pay');
  await writeFile(join(f.workspace, '.gitignore'), 'mx-base/mx-pay/secrets/\nmx-base/mx-pay/.deploy/\n');
  f.git(['add', '.gitignore']); f.git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'ignore private payment config']);
  await mkdir(join(pay, 'secrets/console'), { recursive: true });
  await mkdir(join(pay, '.deploy'));
  await writeFile(join(pay, 'secrets/console/profile.json'), JSON.stringify({ clientSecret: 'private-payment-client-secret' }));
  await writeFile(join(pay, 'secrets/console/access.json'), '[]');
  const plan = await f.plan('pay', 'deploy');
  assert.doesNotMatch(JSON.stringify(plan), /private-payment-client-secret/);
  await writeFile(join(pay, 'secrets/console/access.json'), '[{"subject":"changed"}]');
  const denied = await f.request('execute', { planId: plan.id, acknowledged: true });
  assert.equal(denied.status, 409); assert.match(denied.data.message, /配置或凭据已变化/);
  const targetPlan = await f.plan('pay', 'deploy');
  await writeFile(join(pay, '.deploy/target.json'), '{"context":"different"}');
  assert.equal((await f.request('execute', { planId: targetPlan.id, acknowledged: true })).status, 409);
  const topologyPlan = await f.plan('pay', 'deploy');
  await writeFile(join(pay, '.deploy/topology.json'), '{"mode":"single-node","node":"replacement"}');
  assert.equal((await f.request('execute', { planId: topologyPlan.id, acknowledged: true })).status, 409);
  assert.equal(executions, 0);
});

test('payment plan includes Launcher profiles that deploy may discover, even before the first local copy', async t => {
  let executions = 0;
  const f = await fixture(t, async () => { executions++; return { code: 0 }; });
  const pay = join(f.workspace, 'mx-base/mx-pay'), identityDir = join(f.dir, 'launcher-identity');
  await writeFile(join(pay, '.env'), `MX_PAY_LAUNCHER_IDENTITY_DIR=${identityDir}\n`);
  f.git(['add', '.']); f.git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture identity source']);
  const noProfile = await f.plan('pay', 'deploy');
  const source = join(identityDir, 'applications/public/mx-pay.json');
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, JSON.stringify({ clientSecret: 'discovered-private-client', sessionKey: 'discovered-private-session' }), { mode: 0o600 });
  const added = await f.request('execute', { planId: noProfile.id, acknowledged: true });
  assert.equal(added.status, 409); assert.match(added.data.message, /配置或凭据已变化/);
  const registered = await f.plan('pay', 'deploy');
  assert.doesNotMatch(JSON.stringify(registered), /discovered-private-client|discovered-private-session/);
  await writeFile(source, JSON.stringify({ clientSecret: 'changed-private-client' }));
  assert.equal((await f.request('execute', { planId: registered.id, acknowledged: true })).status, 409);
  assert.equal(executions, 0);
});

test('mutations require acknowledgement; one host lock blocks conflicting services', async t => {
  let finish;
  const f = await fixture(t, async spec => spec.service === 'launcher' ? new Promise(resolve => { finish = resolve; }) : { code: 0 });
  const plan = await f.plan('launcher', 'deploy');
  assert.equal((await f.request('execute', { planId: plan.id })).status, 400);
  assert.equal((await f.request('execute', { planId: plan.id, acknowledged: true })).status, 200);
  const other = await f.plan('ocr', 'restart');
  assert.equal((await f.request('execute', { planId: other.id, acknowledged: true })).status, 409);
  const readOnly = await f.plan('ocr', 'status');
  assert.equal((await f.request('execute', { planId: readOnly.id })).status, 200);
  await complete(f, readOnly.id);
  for (let index = 0; !finish && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 5));
  finish({ code: 0 }); await complete(f, plan.id);
});

test('uncertain execution remains blocked across executor restarts until explicit reconciliation', async t => {
  const f = await fixture(t, async () => ({ code: null, uncertain: true }));
  const plan = await f.plan('launcher', 'deploy'); await f.request('execute', { planId: plan.id, acknowledged: true });
  assert.equal((await complete(f, plan.id)).operation.status, 'needs_reconciliation');
  await f.restart();
  const next = await f.plan('ocr', 'restart'); assert.equal((await f.request('execute', { planId: next.id, acknowledged: true })).status, 409);
  assert.equal((await f.request('reconcile', { operationId: plan.id, note: '已核对临时测试进程结束，无生产操作。' })).data.status, 'reconciled');
  assert.equal((await f.request('execute', { planId: next.id, acknowledged: true })).status, 200); await complete(f, next.id);
});

test('logs redact credential assignments, bearer headers and URL credentials', () => {
  const output = redactOutput('TOKEN="abc def"\nAuthorization: Bearer abc.jwt\nhttps://name:pass@host/path?token=secret&ok=1\nknown-value', ['known-value']);
  assert.doesNotMatch(output, /abc def|abc.jwt|name:pass|token=secret|known-value/);
});

test('real child uses isolated environment and redacts split log lines', async t => {
  const saved = process.env.MX_K8S_APISERVER_ADVERTISE_ADDRESS;
  process.env.MX_K8S_APISERVER_ADVERTISE_ADDRESS = 'must-not-leak-into-status';
  t.after(() => { if (saved === undefined) delete process.env.MX_K8S_APISERVER_ADVERTISE_ADDRESS; else process.env.MX_K8S_APISERVER_ADVERTISE_ADDRESS = saved; });
  const script = '#!/bin/bash\nprintf "repair=%s hub=%s address=%s\\n" "${MX_K8S_AUTO_REPAIR_KUBEADM_ENDPOINT-unset}" "${MX_INSIGHT_HUB_DEPLOY-unset}" "${MX_K8S_APISERVER_ADVERTISE_ADDRESS-unset}"\nprintf "API_"\nprintf "KEY=fake-sensitive-value\\n"\n';
  const f = await fixture(t, undefined, script);
  const plan = await f.plan(); await f.request('execute', { planId: plan.id });
  const result = await complete(f, plan.id);
  assert.equal(result.operation.status, 'succeeded');
  assert.match(result.log, /repair=0 hub=0 address=unset/);
  assert.doesNotMatch(result.log, /fake-sensitive-value|must-not-leak/);
});

test('GPU approval never bypasses admission and OCR explicit proxy wins over saved config', async t => {
  const base = await mkdtemp(join(tmpdir(), 'mx-gpu-approval-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'scripts'), { recursive: true });
  await mkdir(join(base, 'mx-ocr/scripts'), { recursive: true });
  await writeFile(join(base, 'scripts/gpu-common.sh'), 'gpu_config() { MX_BASE_OCR_GPU=2; }\ngpu_admit() { echo "GPU_GUARD_CALLED" >&2; return 42; }\n');
  await writeFile(join(base, 'scripts/deploy-confirm.sh'), await readFile(new URL('../../../mx-base/scripts/deploy-confirm.sh', import.meta.url)));
  const script = join(base, 'mx-ocr/scripts/manage.sh');
  await writeFile(script, await readFile(new URL('../../../mx-base/mx-ocr/scripts/manage.sh', import.meta.url)));
  await writeFile(join(base, 'mx-ocr/.env'), 'PROXY=http://saved.invalid:7788\n');
  for (const proxy of ['http://override.invalid:7890', '']) {
    const result = execFileSync('bash', ['-c', 'source "$1" help >/dev/null; printf "%s" "$PROXY"', 'fixture', script], { env: { ...process.env, PROXY: proxy }, encoding: 'utf8' });
    assert.equal(result, proxy);
  }
  assert.throws(() => execFileSync('bash', [script, 'deploy'], { env: { ...process.env, MX_BASE_DEPLOY_APPROVAL: 'mx-ocr:10000000-0000-4000-8000-000000000001' }, stdio: ['pipe', 'pipe', 'pipe'] }), error => {
    assert.equal(error.status, 42); assert.match(error.stderr.toString(), /GPU_GUARD_CALLED/); return true;
  });
  const bin = join(base, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/bash\ncase "$1" in info) exit 0;; ps) echo mx-ocr-api;; stats) printf "%s\\n" "$*";; *) exit 1;; esac\n');
  await writeFile(join(bin, 'nvidia-smi'), '#!/bin/bash\necho fixture-gpu-stats\n');
  await chmod(join(bin, 'docker'), 0o700); await chmod(join(bin, 'nvidia-smi'), 0o700);
  const stats = execFileSync('bash', [script, 'stats'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.match(stats, /stats --no-stream mx-ocr-api/); assert.match(stats, /fixture-gpu-stats/);
});

test('GPU deployment machine approval is scoped and legacy interactive confirmation remains', () => {
  const path = new URL('../../../mx-base/scripts/deploy-confirm.sh', import.meta.url).pathname;
  const args = ['-c', 'source "$1"; confirm_deploy "$2"', 'fixture', path, 'mx-ocr'];
  const env = { ...process.env, MX_BASE_DEPLOY_APPROVAL: 'mx-ocr:10000000-0000-4000-8000-000000000001' };
  assert.doesNotThrow(() => execFileSync('bash', args, { env, stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.throws(() => execFileSync('bash', args, { env: { ...env, MX_BASE_DEPLOY_APPROVAL: 'mx-embedding:10000000-0000-4000-8000-000000000001' }, stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.throws(() => execFileSync('bash', args, { env: { ...env, MX_BASE_DEPLOY_APPROVAL: '' }, stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.doesNotThrow(() => execFileSync('bash', args, { env: { ...env, MX_BASE_DEPLOY_APPROVAL: '' }, input: 'yes\n', stdio: ['pipe', 'pipe', 'pipe'] }));
});
