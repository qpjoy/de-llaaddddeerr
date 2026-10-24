import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { ensureElectronLauncherUserOverseaSubscription } from '../dist/oversea.js';

// The real ensure response shape from user-center: two synced sites and one
// retired site whose sync is held back by the remote-execution gate.
const payload = {
  ensure: { ready: false, status: 'pending-runtime-sync', reason: 'Subscription YAML is renderable, but 1 account(s) still require runtime sync.' },
  entitlement: { userId: 'usr_test', entitlementId: 'ent_1', status: 'active', siteIds: ['jp01', 'xjp01', 'oversea-main'] },
  sync: {
    status: 'blocked',
    reports: [
      { siteId: 'jp01', status: 'passed', exitCode: 0, command: 'secret-command', stdout: 'secret-stdout', stderr: '', diagnosis: null },
      { siteId: 'xjp01', status: 'failed', exitCode: 255, command: 'secret-command', stderr: 'secret-stderr',
        diagnosis: { category: 'ssh-auth', summary: 'SSH authentication failed' } },
      { siteId: 'oversea-main', status: 'blocked', exitCode: null, command: null, stderr: 'secret-gate-stderr',
        diagnosis: { category: 'gate', summary: 'active Oversea SSH profile is required',
          gateFailures: ['active Oversea SSH profile is required', 'SSH host is required'] } },
    ],
  },
  subscription: { path: '/internal/v1/user-center/users/usr_test/oversea/subscription.yaml', yaml: 'proxies: []\n' },
};

async function withServer(body, run) {
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('ensure reports each site sync so a client can name the site that blocks readiness', async () => {
  const result = await withServer(payload, (baseUrl) => ensureElectronLauncherUserOverseaSubscription({
    baseUrl, userId: 'usr_test', accessToken: 'test-token',
  }));
  assert.equal(result.ready, false);
  assert.equal(result.syncStatus, 'blocked');
  assert.deepEqual(result.syncSites, [
    { siteId: 'jp01', status: 'passed', category: null, summary: null, gateFailures: [], exitCode: 0 },
    { siteId: 'xjp01', status: 'failed', category: 'ssh-auth', summary: 'SSH authentication failed', gateFailures: [], exitCode: 255 },
    { siteId: 'oversea-main', status: 'blocked', category: 'gate', summary: 'active Oversea SSH profile is required',
      gateFailures: ['active Oversea SSH profile is required', 'SSH host is required'], exitCode: null },
  ]);
  assert.doesNotMatch(JSON.stringify(result.syncSites), /secret/, 'command, stdout and stderr stay on the server');
});

test('a response without sync reports yields no sites', async () => {
  const result = await withServer({ ...payload, sync: { status: 'skipped' } }, (baseUrl) =>
    ensureElectronLauncherUserOverseaSubscription({ baseUrl, userId: 'usr_test', accessToken: 'test-token' }));
  assert.deepEqual(result.syncSites, []);
});
