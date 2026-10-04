import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { SERVICE_CATALOG, defaultServiceProfile, buildServiceCommand, shellQuote } from '../service-operations-catalog.js';

test('all services use their real command families and isolate sibling deployments', () => {
  for (const [service, definition] of Object.entries(SERVICE_CATALOG)) {
    for (const action of Object.keys(definition.actions)) {
      const result = buildServiceCommand(service, action, defaultServiceProfile(service));
      assert.ok(result.command.startsWith('cd -- '));
      assert.ok(result.args.length > 0);
      assert.ok(!result.args.includes('--follow'), 'logs must terminate');
    }
  }
  const launcher = buildServiceCommand('launcher', 'deploy', { installRunner: false, tmpDir: '/tmp/data' });
  assert.equal(launcher.env.TMPDIR, '/tmp/data');
  assert.equal(launcher.env.MX_INTERNAL_PRODUCTION_NATIVE_HOST_RUNNER_INSTALL, '0');
  assert.equal(launcher.env.MX_INSIGHT_HUB_DEPLOY, '0');
  assert.equal(buildServiceCommand('hub', 'deploy', {}).env.MX_INSIGHT_SYNC_LAUNCHER, '0');
  const status = buildServiceCommand('launcher', 'status', {});
  assert.equal(status.env.MX_K8S_AUTO_REPAIR_KUBEADM_ENDPOINT, '0');
  assert.equal(status.env.MX_K8S_APISERVER_ADVERTISE_ADDRESS, undefined);
  assert.deepEqual(buildServiceCommand('hub', 'status', {}).args, ['scripts/manage.sh', 'ops', 'internal-production', 'status']);
  assert.throws(() => buildServiceCommand('hub', 'restart', {}), /不支持/);
  const pay = buildServiceCommand('pay', 'deploy', {});
  assert.deepEqual(pay.args, ['scripts/manage.sh', 'deploy']);
  assert.deepEqual(pay.env, {});
  assert.ok(pay.cwd.endsWith('/mx-base/mx-pay'));
  assert.deepEqual(buildServiceCommand('pay', 'logs', {}).args, ['scripts/manage.sh', 'logs']);
  assert.throws(() => buildServiceCommand('pay', 'stop', {}), /不支持/);
});

test('proxy controls and shared-GPU switch affect only applicable deployment commands', () => {
  const input = { proxyMode: 'custom', proxyHost: '192.168.1.2', proxyPort: '7999' };
  assert.equal(buildServiceCommand('embedding', 'deploy', input).env.MX_EMBEDDING_PROXY, 'http://192.168.1.2:7999');
  assert.ok(buildServiceCommand('embedding', 'deploy', input).args.includes('--keep-gpu'));
  assert.ok(!buildServiceCommand('embedding', 'deploy', { ...input, keepGpu: false }).args.includes('--keep-gpu'));
  assert.ok(!buildServiceCommand('embedding', 'restart', input).args.includes('--keep-gpu'));
  assert.equal(buildServiceCommand('ocr', 'deploy', input).env.PROXY, 'http://192.168.1.2:7999');
  assert.equal(buildServiceCommand('ocr', 'deploy', { proxyMode: 'direct' }).env.PROXY, '');
  assert.equal(buildServiceCommand('ocr', 'deploy', { proxyMode: 'saved' }).env.PROXY, undefined);
  assert.equal(buildServiceCommand('launcher', 'status', input).env.MX_LAUNCHER_BUILD_PROXY, undefined);
});

test('invalid input is rejected and shell metacharacters remain literal in quoted paths', () => {
  for (const input of [
    { cwd: '/srv/../etc' }, { tmpDir: '/' }, { proxyMode: 'custom', proxyPort: '99999' },
    { proxyMode: 'custom', proxyHost: 'user:pass@host' }, { hostname: '$(id)' },
    { advertiseAddress: '192.168.1.999' }, { installRunner: 'false' }, { extraArgs: '; id' },
    { cwd: '/srv/test\ninjected' }, { expectedRevision: 'main' }
  ]) assert.throws(() => buildServiceCommand('launcher', 'deploy', input));
  assert.throws(() => buildServiceCommand('embedding', 'deploy', { proxyMode: 'custom', proxyHost: '127.0.0.1' }), /容器可达/);
  const path = "/srv/MX's $(printf injected) `printf injected` folder";
  assert.equal(execFileSync('bash', ['-c', `printf '%s' ${shellQuote(path)}`], { encoding: 'utf8' }), path);
  const command = buildServiceCommand('launcher', 'deploy', { cwd: path }).command;
  assert.equal(execFileSync('bash', ['-n'], { input: command }).length, 0);
});
