import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, appendFileSync, readlinkSync, statSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { defaultServiceProfile } from '../../desktop/service-operations-catalog.js';
import { installOperations, parseInstallOptions } from './service-operations-install.mjs';

function fixture(t, { siblings = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-executor-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'workspace');
  for (const name of siblings ? ['mx-launcher', 'mx-insight-hub', 'mx-base'] : ['mx-launcher']) {
    mkdirSync(join(workspace, name, 'scripts'), { recursive: true }); writeFileSync(join(workspace, name, 'scripts/manage.sh'), '#!/bin/bash\n');
  }
  const source = join(dir, 'source/server/scripts'); mkdirSync(source, { recursive: true }); mkdirSync(join(dir, 'source/desktop'), { recursive: true });
  cpSync(new URL('./service-operations-agent.mjs', import.meta.url), join(source, 'service-operations-agent.mjs'));
  cpSync(new URL('../../desktop/service-operations-catalog.js', import.meta.url), join(dir, 'source/desktop/service-operations-catalog.js'));
  mkdirSync(join(dir, 'source/scripts'), { recursive: true });
  for (const name of ['identity-console', 'identity-app', 'identity-profile', 'identity-public-profile', 'identity-app-profile']) {
    cpSync(new URL(`../../scripts/${name}.mjs`, import.meta.url), join(dir, `source/scripts/${name}.mjs`));
  }
  const paths = Object.fromEntries(['root', 'configuration', 'stateDir', 'units'].map(key => [key, join(dir, key)]));
  let active = false, busy = false, healthy = true, failSecret = false, current = null, boots = 0;
  const calls = [], requests = [], logs = [];
  const installedVersion = () => JSON.parse(readFileSync(join(paths.root, 'current/release.json'), 'utf8')).runtimeVersion;
  const start = () => { active = true; current = { runtimeVersion: installedVersion(), bootId: String(++boots), updateRequested: null, inFlight: 0, submitting: false }; };
  const dependencies = { paths, source, log: message => logs.push(message), readyTimeout: 1, pollInterval: 1,
    command(program, args, extra = {}) {
      calls.push({ program, args, input: extra.input });
      if (program === process.execPath) return execFileSync(program, args);
      if (program === 'systemctl') {
        if (args[0] === 'is-active' && !active) throw new Error('inactive');
        if (args[0] === 'start') start();
      }
      if (program === 'kubectl' && extra.input && JSON.parse(extra.input).kind === 'Secret' && failSecret) throw new Error(extra.input);
    },
    async request(config, token, path, body) {
      requests.push({ path, body });
      assert.equal(token, readFileSync(join(paths.configuration, 'token'), 'utf8'));
      if (!healthy) throw new Error('offline');
      if (path === 'lifecycle/update') {
        current.updateRequested = body.runtimeVersion;
        current.inFlight = busy ? 1 : 0;
        const result = { ...current };
        if (!busy && !existsSync(join(paths.stateDir, 'active.lock'))) start();
        return result;
      }
      return { ...current };
    }
  };
  return { dir, workspace, paths, source, calls, requests, logs, dependencies,
    install: options => installOperations({ workspace, defaultBind: '192.168.1.2', connect: true, ...options }, dependencies),
    setBusy(value) { busy = value; }, setHealthy(value) { healthy = value; }, failSecret() { failSecret = true; }, finishUpdate: start,
    upgrade() { appendFileSync(join(source, 'service-operations-agent.mjs'), '\n// updated fixture version\n'); }
  };
}

test('first deploy installs available services; repeats preserve secrets, custom config, task data and process', async t => {
  const f = fixture(t);
  const first = await f.install({ port: '19300' });
  assert.equal(first.config.instances.length, 1);
  assert.equal(first.config.port, 19300);
  const token = readFileSync(join(f.paths.configuration, 'token'), 'utf8');
  assert.equal(token.length, 64); assert.equal(statSync(join(f.paths.configuration, 'token')).mode & 0o777, 0o600);
  const configPath = join(f.paths.configuration, 'config.json');
  const config = JSON.parse(readFileSync(configPath)); config.instances[0].profile.proxyPort = '8899';
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(f.paths.stateDir, 'persisted-task'), 'retain');
  const before = readFileSync(configPath, 'utf8');
  const repeat = await f.install({ defaultBind: '192.168.9.9' });
  assert.equal(repeat.version, first.version); assert.equal(repeat.deferred, false);
  assert.equal(readFileSync(configPath, 'utf8'), before);
  assert.equal(readFileSync(join(f.paths.configuration, 'token'), 'utf8'), token);
  assert.equal(readFileSync(join(f.paths.stateDir, 'persisted-task'), 'utf8'), 'retain');
  assert.equal(f.calls.filter(c => c.program === 'systemctl' && c.args[0] === 'start').length, 1);
  assert.equal(f.calls.filter(c => c.program === 'systemctl' && c.args[0] === 'daemon-reload').length, 2);
  assert.equal(f.requests.filter(c => c.path === 'lifecycle/update').length, 0);
  assert.ok(f.calls.every(c => !['restart', 'stop'].includes(c.args[0])));
  const manifests = f.calls.filter(c => c.program === 'kubectl').map(c => JSON.parse(c.input));
  assert.deepEqual(manifests.map(m => m.kind), ['Namespace', 'Secret', 'Namespace', 'Secret']);
  assert.equal(manifests[1].stringData.MX_SERVICE_OPERATIONS_URL, 'http://192.168.1.2:19300');
  assert.ok(!JSON.stringify(f.logs).includes(token));
});

test('adding payment to an existing executor preserves credentials and profiles and requests a drained reload', async t => {
  const f = fixture(t);
  const first = await f.install();
  const token = readFileSync(join(f.paths.configuration, 'token'), 'utf8');
  mkdirSync(join(f.workspace, 'mx-base/mx-pay/scripts'), { recursive: true });
  writeFileSync(join(f.workspace, 'mx-base/mx-pay/scripts/manage.sh'), '#!/bin/bash\n');
  const second = await f.install();
  assert.notEqual(second.version, first.version);
  assert.deepEqual(second.config.instances.map(i => i.service), ['launcher','pay']);
  assert.deepEqual(second.config.instances[0], first.config.instances[0]);
  assert.equal(readFileSync(join(f.paths.configuration, 'token'), 'utf8'), token);
  assert.equal(f.requests.filter(r => r.path === 'lifecycle/update').length, 1);
  await f.install();
  assert.equal(f.requests.filter(r => r.path === 'lifecycle/update').length, 1);
});

test('idle upgrades stage immutable code and use cooperative update; self-deploy defers and repeats safely', async t => {
  const f = fixture(t, { siblings: true });
  const first = await f.install(); assert.equal(first.config.instances.length, 4);
  const old = readlinkSync(join(f.paths.root, 'current'));
  f.upgrade(); const second = await f.install();
  assert.notEqual(first.version, second.version); assert.equal(second.deferred, false);
  assert.ok(existsSync(old)); assert.equal(f.requests.filter(r => r.path === 'lifecycle/update').length, 1);
  f.upgrade(); f.setBusy(true);
  const third = await f.install(); assert.equal(third.deferred, true);
  const repeat = await f.install(); assert.equal(repeat.version, third.version); assert.equal(repeat.deferred, true);
  assert.equal(f.calls.filter(c => c.program === 'systemctl' && c.args[0] === 'start').length, 1);
  assert.ok(f.calls.every(c => !['restart', 'stop'].includes(c.args[0])));
  f.setBusy(false); f.finishUpdate(); assert.equal((await f.install()).deferred, false);
});

test('uncertain task prevents activation; existing connection and credentials never silently change', async t => {
  const f = fixture(t); await f.install();
  mkdirSync(join(f.paths.stateDir, 'active.lock')); writeFileSync(join(f.paths.stateDir, 'active.lock/owner.json'), '{"id":"unfinished"}');
  f.upgrade(); assert.equal((await f.install()).deferred, true);
  assert.equal(readFileSync(join(f.paths.stateDir, 'active.lock/owner.json'), 'utf8'), '{"id":"unfinished"}');
  await assert.rejects(f.install({ bind: '192.168.1.8' }), /已有 bind/);
  await assert.rejects(f.install({ port: '19555' }), /已有 port/);
  rmSync(join(f.paths.configuration, 'token'));
  await assert.rejects(f.install(), /丢失 token/); assert.ok(!existsSync(join(f.paths.configuration, 'token')));
});

test('failed health never force-restarts the old service; Secret errors do not expose credentials', async t => {
  const f = fixture(t); await f.install();
  const old = readlinkSync(join(f.paths.root, 'current'));
  f.upgrade(); f.setHealthy(false);
  await assert.rejects(f.install(), /保留其运行状态/);
  assert.equal(readlinkSync(join(f.paths.root, 'current')), old);
  assert.ok(!existsSync(join(f.paths.root, 'install.lock')));
  f.setHealthy(true); f.failSecret();
  await assert.rejects(f.install(), error => {
    assert.match(error.message, /Secret 登记失败/);
    assert.ok(!error.message.includes(readFileSync(join(f.paths.configuration, 'token'), 'utf8'))); return true;
  });
  assert.ok(f.calls.every(c => !['restart', 'stop'].includes(c.args[0])));
});

test('first startup must become authenticated and ready before any Kubernetes registration', async t => {
  const f = fixture(t); f.setHealthy(false);
  await assert.rejects(f.install(), /未在等待期内就绪/);
  assert.ok(!f.calls.some(c => c.program === 'kubectl'));
  assert.ok(!existsSync(join(f.paths.root, 'install.lock')));
});

test('CLI options are strict and preserve omitted bind/port on repeat deploy', () => {
  assert.deepEqual(parseInstallOptions(['--workspace', '/project', '--default-bind', '192.168.1.2', '--connect-k8s']), { workspace: '/project', defaultBind: '192.168.1.2', connect: true });
  assert.throws(() => parseInstallOptions(['--random']), /Usage/);
});

test('real executor starts through release symlink and exits only after its self-deploy result is durable', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-executor-self-update-'));
  const workspace = join(dir, 'workspace'); const launcher = join(workspace, 'mx-launcher');
  mkdirSync(join(launcher, 'scripts'), { recursive: true });
  writeFileSync(join(launcher, 'scripts/manage.sh'), `#!/bin/bash
marker="${dir}/finish"
printf started > "${dir}/started"
for ((i=0;i<500;i++)); do
  if [ -f "$marker" ]; then echo self-deploy-complete; exit 0; fi
  sleep 0.02
done
exit 1
`);
  const git = args => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
  git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid.test', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture']);
  for (const version of ['a', 'b']) {
    const release = join(dir, version); mkdirSync(join(release, 'server/scripts'), { recursive: true }); mkdirSync(join(release, 'desktop'));
    cpSync(new URL('./service-operations-agent.mjs', import.meta.url), join(release, 'server/scripts/service-operations-agent.mjs'));
    cpSync(new URL('../../desktop/service-operations-catalog.js', import.meta.url), join(release, 'desktop/service-operations-catalog.js'));
    mkdirSync(join(release, 'scripts'));
    for (const name of ['identity-console', 'identity-app', 'identity-profile', 'identity-public-profile', 'identity-app-profile']) {
      cpSync(new URL(`../../scripts/${name}.mjs`, import.meta.url), join(release, `scripts/${name}.mjs`));
    }
    writeFileSync(join(release, 'package.json'), '{"type":"module"}'); writeFileSync(join(release, 'release.json'), JSON.stringify({ runtimeVersion: version.repeat(64) }));
  }
  symlinkSync(join(dir, 'a'), join(dir, 'current'));
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const token = 'temporary-test-token-'.repeat(3); writeFileSync(join(dir, 'token'), token);
  const stateDir = join(dir, 'state');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ bind: '127.0.0.1', port, host: 'fixture', stateDir, tokenFile: join(dir, 'token'),
    instances: [{ id: 'launcher', service: 'launcher', profile: { ...defaultServiceProfile('launcher', workspace), tmpDir: dir } }] }));
  const children = [];
  const start = () => {
    const child = spawn(process.execPath, [join(dir, 'current/server/scripts/service-operations-agent.mjs'), join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.output = ''; child.stdout.on('data', b => { child.output += b; }); child.stderr.on('data', b => { child.output += b; }); children.push(child); return child;
  };
  t.after(async () => {
    writeFileSync(join(dir, 'finish'), 'done');
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); }
    rmSync(dir, { recursive: true, force: true });
  });
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-mx-operations-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(1000) });
    const result = await response.json(); assert.equal(response.status, 200, result.message); return result;
  };
  async function ready(version, child) {
    for (let i = 0; i < 100; i++) {
      try { if ((await request('lifecycle')).runtimeVersion === version.repeat(64)) return; } catch { /* Starting. */ }
      if (child.exitCode !== null) throw new Error(child.output);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`executor did not start: ${child.output}`);
  }
  const old = start(); await ready('a', old);
  const plan = await request('plans', { instanceId: 'launcher', action: 'deploy' });
  await request('execute', { planId: plan.id, acknowledged: true });
  for (let i = 0; !existsSync(join(dir, 'started')) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(join(dir, 'started')));
  symlinkSync(join(dir, 'b'), join(dir, 'next')); renameSync(join(dir, 'next'), join(dir, 'current'));
  const pending = await request('lifecycle/update', { runtimeVersion: 'b'.repeat(64) }); assert.equal(pending.inFlight, 1);
  await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(old.exitCode, null);
  assert.equal((await request(`operations/${plan.id}`)).operation.status, 'running');
  const closed = once(old, 'close'); writeFileSync(join(dir, 'finish'), 'done');
  const [code, signal] = await closed; assert.equal(code, 75, old.output); assert.equal(signal, null);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'operations', plan.id + '.json'))).status, 'succeeded');
  assert.match(readFileSync(join(stateDir, 'operations', plan.id + '.log'), 'utf8'), /self-deploy-complete/);
  assert.ok(!existsSync(join(stateDir, 'active.lock')));
  const next = start(); await ready('b', next);
  const history = await request(`operations/${plan.id}`); assert.equal(history.operation.status, 'succeeded');
  assert.equal((await request('execute', { planId: plan.id, acknowledged: true })).id, plan.id);
  assert.equal((await request('lifecycle')).inFlight, 0, 'old deployment must not replay');
});
