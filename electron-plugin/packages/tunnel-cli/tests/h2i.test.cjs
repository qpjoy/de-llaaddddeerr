const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { afterEach, test } = require('node:test');

const cli = resolve(__dirname, '../dist/index.js');
const tempRoots = [];
const systemFiles = [];
const systemDirectories = [];

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
  while (systemFiles.length) rmSync(systemFiles.pop(), { force: true });
  while (systemDirectories.length) rmSync(systemDirectories.pop(), { recursive: true, force: true });
});

test('account enroll uses OAuth, capability-bound V2 session, and Domestic peer sync', async () => {
  const observed = [];
  const server = await startMockServer({ identityKind: 'user', observed });
  try {
    const paths = testPaths('account');
    const accountArgs = [
      'h2i',
      'enroll',
      '--bootstrap-url',
      server.baseUrl,
      '--username',
      'user@example.com',
      '--dns',
      '--state-file',
      paths.state,
      '--config-path',
      paths.config,
      '--install-dir',
      paths.bin,
      '--no-start',
    ];
    const result = await runCli(accountArgs, {
      H2I_PASSWORD: 'test-password',
      pathPrefix: paths.bin,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /MX H2I V2 enrollment complete/);
    assert.deepEqual(observed.map((row) => row.path), [
      '/bootstrap-healthz',
      '/internal/v1/sdk/oauth/token',
      '/internal/v1/launcher-network/enrollments',
      '/internal/v1/launcher-network/snapshots',
      '/internal/v1/launcher-network/leases/lease-user/domestic-peer/sync',
    ]);

    const oauth = observed[1];
    assert.equal(oauth.body.grant_type, 'password');
    assert.equal(oauth.body.audience, 'mx-sdk');
    assert.equal(oauth.body.username, 'user@example.com');
    assert.equal(oauth.body.password, 'test-password');

    const enroll = observed[2];
    assert.equal(enroll.headers.authorization, 'Bearer account-token');
    assert.equal(enroll.body.identityKind, 'user');
    assert.equal(enroll.body.leaseProfile, 'employee');
    assert.match(enroll.headers['x-mx-new-lease-capability'], /^mxlc1\.[A-Za-z0-9_-]{43}$/);
    assert.match(enroll.headers['x-mx-lease-capability'], /^mxlc1\.[A-Za-z0-9_-]{43}$/);

    const snapshot = observed[3];
    assert.equal(snapshot.headers.authorization, 'Bearer account-token');
    assert.equal(
      snapshot.headers['x-mx-lease-capability'],
      enroll.headers['x-mx-new-lease-capability'],
    );
    assert.equal(snapshot.body.leaseId, 'lease-user');
    assert.equal(snapshot.body.publicKey, enroll.body.publicKey);

    const sync = observed[4];
    assert.equal(sync.headers.authorization, 'Bearer account-token');
    assert.equal(
      sync.headers['x-mx-lease-capability'],
      enroll.headers['x-mx-new-lease-capability'],
    );

    assertSafeStateAndConfig(paths, {
      identityKind: 'user',
      leaseId: 'lease-user',
      leaseIp: '10.89.0.10',
      capability: enroll.headers['x-mx-new-lease-capability'],
      publicKey: enroll.body.publicKey,
      dns: true,
    });

    const renewed = await runCli(accountArgs, {
      H2I_PASSWORD: 'test-password',
      pathPrefix: paths.bin,
    });
    assert.equal(renewed.code, 0, renewed.stderr);
    const renewalEnroll = observed[7];
    const renewedCapability = renewalEnroll.headers['x-mx-new-lease-capability'];
    assert.notEqual(renewedCapability, enroll.headers['x-mx-new-lease-capability']);
    assert.deepEqual(
      new Set(renewalEnroll.headers['x-mx-lease-capability'].split(',')),
      new Set([enroll.headers['x-mx-new-lease-capability'], renewedCapability]),
    );
    assert.equal(renewalEnroll.body.publicKey, enroll.body.publicKey);
    assert.equal(observed[8].headers['x-mx-lease-capability'], renewedCapability);
    assert.equal(observed[9].headers['x-mx-lease-capability'], renewedCapability);
    assertSafeStateAndConfig(paths, {
      identityKind: 'user',
      leaseId: 'lease-user',
      leaseIp: '10.89.0.10',
      capability: renewedCapability,
      publicKey: enroll.body.publicKey,
      dns: true,
    });
  } finally {
    await server.close();
  }
});

test('anonymous enroll omits bearer authentication and still syncs the same lease IP/key', async () => {
  const observed = [];
  const server = await startMockServer({ identityKind: 'anonymous', observed });
  try {
    const paths = testPaths('anonymous');
    const result = await runCli([
      'h2i',
      'enroll',
      '--bootstrap-url',
      server.baseUrl,
      '--anonymous',
      '--state-file',
      paths.state,
      '--config-path',
      paths.config,
      '--install-dir',
      paths.bin,
      '--no-start',
    ], { pathPrefix: paths.bin });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(observed.map((row) => row.path), [
      '/bootstrap-healthz',
      '/internal/v1/launcher-network/enrollments',
      '/internal/v1/launcher-network/snapshots',
      '/internal/v1/launcher-network/leases/lease-anonymous/domestic-peer/sync',
    ]);
    for (const request of observed) assert.equal(request.headers.authorization, undefined);

    const enroll = observed[1];
    assert.equal(enroll.body.identityKind, 'anonymous');
    assert.equal(enroll.body.leaseProfile, 'anonymous');
    const snapshot = observed[2];
    const sync = observed[3];
    assert.equal(snapshot.headers['x-mx-lease-capability'], enroll.headers['x-mx-new-lease-capability']);
    assert.equal(sync.headers['x-mx-lease-capability'], enroll.headers['x-mx-new-lease-capability']);
    assert.equal(snapshot.body.publicKey, enroll.body.publicKey);

    assertSafeStateAndConfig(paths, {
      identityKind: 'anonymous',
      leaseId: 'lease-anonymous',
      leaseIp: '10.89.100.10',
      capability: enroll.headers['x-mx-new-lease-capability'],
      publicKey: enroll.body.publicKey,
      dns: false,
    });
  } finally {
    await server.close();
  }
});

test('rejects route-plan config injection before writing WireGuard config', async () => {
  const observed = [];
  const server = await startMockServer({
    identityKind: 'anonymous',
    observed,
    snapshotMutator: (value) => {
      value.topology.product.dnsServer = '10.88.0.1\nPostUp = touch /tmp/h2i-pwned';
    },
  });
  try {
    const paths = testPaths('injection');
    const result = await runCli([
      'h2i',
      'enroll',
      '--bootstrap-url',
      server.baseUrl,
      '--anonymous',
      '--dns',
      '--state-file',
      paths.state,
      '--config-path',
      paths.config,
      '--install-dir',
      paths.bin,
      '--no-start',
    ], { pathPrefix: paths.bin });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /control characters/i);
    assert.equal(existsSync(paths.config), false);
  } finally {
    await server.close();
  }
});

test('rejects interface names that systemd would escape to a different unit instance', async () => {
  const paths = testPaths('interface-systemd-escape');
  const result = await runCli([
    'h2i',
    'enroll',
    '--bootstrap-url',
    'https://h2i.example.com',
    '--anonymous',
    '--interface',
    'mx+h2i',
    '--state-file',
    paths.state,
    '--config-path',
    join(paths.root, 'mx+h2i.conf'),
    '--install-dir',
    paths.bin,
    '--no-start',
  ], { pathPrefix: paths.bin });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid WireGuard interface name/i);
});

test('rejects a lease whose product does not match the requested V2 session', async () => {
  const observed = [];
  const server = await startMockServer({
    identityKind: 'anonymous',
    observed,
    leaseMutator: (value) => { value.productId = 'another-product'; },
  });
  try {
    const paths = testPaths('contract');
    const result = await runCli([
      'h2i',
      'enroll',
      '--bootstrap-url',
      server.baseUrl,
      '--anonymous',
      '--state-file',
      paths.state,
      '--config-path',
      paths.config,
      '--install-dir',
      paths.bin,
      '--no-start',
    ], { pathPrefix: paths.bin });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /session contract mismatch for lease\.productId/i);
    assert.equal(existsSync(paths.config), false);
  } finally {
    await server.close();
  }
});

test('a pre-network bootstrap failure does not permanently bind the attempted identity', async () => {
  const paths = testPaths('pre-network-retry');
  const failed = await runCli([
    'h2i',
    'enroll',
    '--bootstrap-url',
    'http://127.0.0.1:1',
    '--username',
    'mistyped@example.com',
    '--state-file',
    paths.state,
    '--config-path',
    paths.config,
    '--install-dir',
    paths.bin,
    '--no-start',
  ], { H2I_PASSWORD: 'wrong-login', pathPrefix: paths.bin });
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(readFileSync(paths.state, 'utf8')).enrollmentAttemptedAt, undefined);

  const observed = [];
  const server = await startMockServer({ identityKind: 'anonymous', observed });
  try {
    const retried = await runCli([
      'h2i',
      'enroll',
      '--bootstrap-url',
      server.baseUrl,
      '--anonymous',
      '--state-file',
      paths.state,
      '--config-path',
      paths.config,
      '--install-dir',
      paths.bin,
      '--no-start',
    ], { pathPrefix: paths.bin });
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(JSON.parse(readFileSync(paths.state, 'utf8')).identityKind, 'anonymous');
  } finally {
    await server.close();
  }
});

test('refuses to overwrite an existing WireGuard config not owned by H2I state', async () => {
  const observed = [];
  const server = await startMockServer({ identityKind: 'anonymous', observed });
  try {
    const paths = testPaths('existing-config');
    const existing = '[Interface]\nPrivateKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=\n';
    writeFileSync(paths.config, existing, { mode: 0o600 });
    const result = await runCli([
      'h2i',
      'enroll',
      '--bootstrap-url',
      server.baseUrl,
      '--anonymous',
      '--state-file',
      paths.state,
      '--config-path',
      paths.config,
      '--install-dir',
      paths.bin,
      '--no-start',
    ], { pathPrefix: paths.bin });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to overwrite an existing WireGuard config/i);
    assert.equal(readFileSync(paths.config, 'utf8'), existing);
    assert.deepEqual(observed, []);
  } finally {
    await server.close();
  }
});

test('serializes concurrent enroll attempts for the same state and config', async () => {
  const observed = [];
  const server = await startMockServer({
    identityKind: 'anonymous',
    observed,
    syncDelayMs: 1_000,
  });
  try {
    const paths = testPaths('concurrent');
    const args = anonymousArgs(server.baseUrl, paths);
    const firstPromise = runCli(args, { pathPrefix: paths.bin });
    await waitForObservedPath(observed, '/domestic-peer/sync');
    const second = await runCli(args, { pathPrefix: paths.bin });
    const first = await firstPromise;

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already locked/i);
    assert.equal(observed.filter((row) => row.path === '/bootstrap-healthz').length, 1);
  } finally {
    await server.close();
  }
});

test('serializes the same WireGuard interface across different state/config directories', async () => {
  const observed = [];
  const server = await startMockServer({
    identityKind: 'anonymous',
    observed,
    syncDelayMs: 1_000,
  });
  try {
    const pathsA = testPaths('interface-lock-a');
    const pathsB = testPaths('interface-lock-b');
    const interfaceName = 'mxlocktest';
    pathsA.config = join(pathsA.root, `${interfaceName}.conf`);
    pathsB.config = join(pathsB.root, `${interfaceName}.conf`);
    const argsA = [...anonymousArgs(server.baseUrl, pathsA), '--interface', interfaceName];
    const argsB = [...anonymousArgs(server.baseUrl, pathsB), '--interface', interfaceName];
    const firstPromise = runCli(argsA, {
      pathPrefix: pathsA.bin,
      H2I_TEST_INTERFACE: interfaceName,
    });
    await waitForObservedPath(observed, '/domestic-peer/sync');
    const second = await runCli(argsB, {
      pathPrefix: pathsB.bin,
      H2I_TEST_INTERFACE: interfaceName,
    });
    const first = await firstPromise;

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /WireGuard interface mxlocktest is already locked/i);
    assert.equal(observed.filter((row) => row.path === '/bootstrap-healthz').length, 1);
  } finally {
    await server.close();
  }
});

test('detects a WireGuard config replacement during peer sync before atomic write', async () => {
  const observed = [];
  const server = await startMockServer({
    identityKind: 'anonymous',
    observed,
    syncDelayMs: 500,
  });
  try {
    const paths = testPaths('config-race');
    const enrollment = runCli(anonymousArgs(server.baseUrl, paths), { pathPrefix: paths.bin });
    await waitForObservedPath(observed, '/domestic-peer/sync');
    const external = '[Interface]\nPrivateKey = CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=\n';
    writeFileSync(paths.config, external, { mode: 0o600 });
    const result = await enrollment;

    assert.equal(result.code, 1);
    assert.match(result.stderr, /config changed during H2I enrollment/i);
    assert.equal(readFileSync(paths.config, 'utf8'), external);
  } finally {
    await server.close();
  }
});

test('inherits a bound Feishu lease profile and rejects profile changes', async () => {
  const observed = [];
  const server = await startMockServer({
    identityKind: 'user',
    leaseProfile: 'feishu',
    observed,
  });
  try {
    const paths = testPaths('feishu-profile');
    const baseArgs = [
      'h2i',
      'enroll',
      '--bootstrap-url',
      server.baseUrl,
      '--state-file',
      paths.state,
      '--config-path',
      paths.config,
      '--install-dir',
      paths.bin,
      '--no-start',
    ];
    const environment = {
      H2I_ACCESS_TOKEN: 'feishu-token',
      H2I_USER_ID: 'usr-account',
      pathPrefix: paths.bin,
    };
    const first = await runCli([...baseArgs, '--lease-profile', 'feishu'], environment);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(observed[1].body.leaseProfile, 'feishu');

    const renewed = await runCli(baseArgs, environment);
    assert.equal(renewed.code, 0, renewed.stderr);
    assert.equal(observed[5].body.leaseProfile, 'feishu');
    const beforeRejectedChange = observed.length;

    const changed = await runCli([...baseArgs, '--lease-profile', 'employee'], environment);
    assert.equal(changed.code, 1);
    assert.match(changed.stderr, /changing the H2I lease profile/i);
    assert.equal(observed.length, beforeRejectedChange);
  } finally {
    await server.close();
  }
});

test('renews a password-bound account with a direct access token', async () => {
  const observed = [];
  const server = await startMockServer({ identityKind: 'user', observed });
  try {
    const paths = testPaths('password-to-token');
    const baseArgs = [
      'h2i',
      'enroll',
      '--bootstrap-url',
      server.baseUrl,
      '--state-file',
      paths.state,
      '--config-path',
      paths.config,
      '--install-dir',
      paths.bin,
      '--no-start',
    ];
    const first = await runCli([...baseArgs, '--username', 'user@example.com'], {
      H2I_PASSWORD: 'test-password',
      pathPrefix: paths.bin,
    });
    assert.equal(first.code, 0, first.stderr);

    const beforeRenewal = observed.length;
    const renewed = await runCli(baseArgs, {
      H2I_ACCESS_TOKEN: 'replacement-token',
      pathPrefix: paths.bin,
    });
    assert.equal(renewed.code, 0, renewed.stderr);
    const renewal = observed.slice(beforeRenewal);
    assert.deepEqual(renewal.map((row) => row.path), [
      '/bootstrap-healthz',
      '/internal/v1/launcher-network/enrollments',
      '/internal/v1/launcher-network/snapshots',
      '/internal/v1/launcher-network/leases/lease-user/domestic-peer/sync',
    ]);
    assert.equal(renewal[1].headers.authorization, 'Bearer replacement-token');
    assert.equal(renewal[1].body.userId, 'usr-account');
  } finally {
    await server.close();
  }
});

test('a bound state rejects bootstrap origin changes before sending credentials or capability', async () => {
  const observedA = [];
  const observedB = [];
  const serverA = await startMockServer({ identityKind: 'anonymous', observed: observedA });
  const serverB = await startMockServer({ identityKind: 'anonymous', observed: observedB });
  try {
    const paths = testPaths('bootstrap-origin');
    const first = await runCli(anonymousArgs(serverA.baseUrl, paths), { pathPrefix: paths.bin });
    assert.equal(first.code, 0, first.stderr);

    const changed = await runCli(anonymousArgs(serverB.baseUrl, paths), { pathPrefix: paths.bin });
    assert.equal(changed.code, 1);
    assert.match(changed.stderr, /changing the H2I bootstrap origin/i);
    assert.deepEqual(observedB, []);
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test('Linux systemd start uses a per-interface unit and down proves the interface stopped', {
  skip: process.env.H2I_SYSTEMD_INTEGRATION !== '1',
}, async () => {
  const observed = [];
  const server = await startMockServer({
    identityKind: 'anonymous',
    observed,
    internalControlIp: '127.0.0.1',
    routeCidrs: ['127.0.0.0/8', '10.89.0.0/16'],
  });
  try {
    const interfaceName = `mxit${process.pid}`.slice(0, 15);
    const paths = systemdTestPaths('systemd-start');
    const configPath = `/etc/wireguard/${interfaceName}.conf`;
    const unitPath = `/etc/systemd/system/qpjoy-h2i@${interfaceName}.service`;
    systemFiles.push(configPath, unitPath);
    const environment = systemdTestEnvironment(paths, interfaceName);
    const enrolled = await runCli(systemdEnrollArgs(server.baseUrl, paths, interfaceName), environment);

    assert.equal(enrolled.code, 0, enrolled.stderr);
    assert.equal(existsSync(configPath), true);
    assert.equal(existsSync(unitPath), true);
    assert.match(readFileSync(unitPath, 'utf8'), /Managed by qp-tunnel-cli h2i/);
    assert.equal(existsSync(join(paths.runtime, 'tunnel-active')), true);
    assert.equal(existsSync(join(paths.runtime, 'service-active')), true);
    assert.equal(existsSync(join(paths.runtime, 'enabled')), true);

    const down = await runCli(['h2i', 'down', '--state-file', paths.state], environment);
    assert.equal(down.code, 0, down.stderr);
    assert.equal(existsSync(join(paths.runtime, 'tunnel-active')), false);
    assert.equal(existsSync(join(paths.runtime, 'service-active')), false);
    assert.equal(existsSync(join(paths.runtime, 'enabled')), false);
    assert.equal(existsSync(join(paths.runtime, 'enabled-runtime')), false);
  } finally {
    await server.close();
  }
});

test('Linux start rollback stops the new tunnel before restoring staged config and unit state', {
  skip: process.env.H2I_SYSTEMD_INTEGRATION !== '1',
}, async () => {
  const observed = [];
  let snapshotCount = 0;
  const server = await startMockServer({
    identityKind: 'anonymous',
    observed,
    internalControlIp: '127.0.0.1',
    routeCidrs: ['127.0.0.0/8', '10.89.0.0/16'],
    snapshotMutator: (value) => {
      snapshotCount += 1;
      if (snapshotCount === 2) {
        value.topology.relayPlan.domesticRelay.publicEndpoint = '198.51.100.11:51280';
      }
    },
  });
  try {
    const interfaceName = `mxrb${process.pid}`.slice(0, 15);
    const paths = systemdTestPaths('systemd-rollback');
    const configPath = `/etc/wireguard/${interfaceName}.conf`;
    const unitPath = `/etc/systemd/system/qpjoy-h2i@${interfaceName}.service`;
    systemFiles.push(configPath, unitPath);
    const environment = systemdTestEnvironment(paths, interfaceName);
    const args = systemdEnrollArgs(server.baseUrl, paths, interfaceName);
    const staged = await runCli([...args, '--no-start'], environment);
    assert.equal(staged.code, 0, staged.stderr);
    const stagedConfig = readFileSync(configPath, 'utf8');
    assert.match(stagedConfig, /198\.51\.100\.10:51280/);
    assert.equal(existsSync(unitPath), false);

    const failed = await runCli(args, { ...environment, H2I_TEST_FAIL_ENABLE: '1' });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /systemctl enable .* failed/i);
    assert.equal(readFileSync(configPath, 'utf8'), stagedConfig);
    assert.equal(existsSync(unitPath), false);
    assert.equal(existsSync(join(paths.runtime, 'tunnel-active')), false);
    assert.equal(existsSync(join(paths.runtime, 'service-active')), false);
    assert.equal(existsSync(join(paths.runtime, 'enabled')), false);
    assert.equal(existsSync(join(paths.runtime, 'enabled-runtime')), false);
    assert.equal(
      JSON.parse(readFileSync(paths.state, 'utf8')).routePlan.domesticRelayEndpoint,
      '198.51.100.10:51280',
    );
  } finally {
    await server.close();
  }
});

test('Linux rollback preserves a manually active tunnel with an inactive runtime-enabled service', {
  skip: process.env.H2I_SYSTEMD_INTEGRATION !== '1',
}, async () => {
  const observed = [];
  let snapshotCount = 0;
  const server = await startMockServer({
    identityKind: 'anonymous',
    observed,
    internalControlIp: '127.0.0.1',
    routeCidrs: ['127.0.0.0/8', '10.89.0.0/16'],
    snapshotMutator: (value) => {
      snapshotCount += 1;
      if (snapshotCount === 2) {
        value.topology.relayPlan.domesticRelay.publicEndpoint = '198.51.100.11:51280';
      }
    },
  });
  try {
    const interfaceName = `mxpm${process.pid}`.slice(0, 15);
    const paths = systemdTestPaths('systemd-prior-manual');
    const configPath = `/etc/wireguard/${interfaceName}.conf`;
    const unitPath = `/etc/systemd/system/qpjoy-h2i@${interfaceName}.service`;
    systemFiles.push(configPath, unitPath);
    const environment = systemdTestEnvironment(paths, interfaceName);
    const args = systemdEnrollArgs(server.baseUrl, paths, interfaceName);
    const staged = await runCli([...args, '--no-start'], environment);
    assert.equal(staged.code, 0, staged.stderr);
    const priorConfig = readFileSync(configPath, 'utf8');
    const priorUnit = '# Managed by qp-tunnel-cli h2i\n# prior runtime-enabled unit\n';
    writeFileSync(unitPath, priorUnit, { mode: 0o644 });
    writeFileSync(join(paths.runtime, 'tunnel-active'), '');
    writeFileSync(join(paths.runtime, 'enabled-runtime'), '');

    const failed = await runCli(args, { ...environment, H2I_TEST_FAIL_ENABLE: '1' });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /systemctl enable .* failed/i);
    assert.equal(readFileSync(configPath, 'utf8'), priorConfig);
    assert.equal(readFileSync(unitPath, 'utf8'), priorUnit);
    assert.equal(existsSync(join(paths.runtime, 'tunnel-active')), true);
    assert.equal(existsSync(join(paths.runtime, 'service-active')), false);
    assert.equal(existsSync(join(paths.runtime, 'enabled')), false);
    assert.equal(existsSync(join(paths.runtime, 'enabled-runtime')), true);
  } finally {
    await server.close();
  }
});

function anonymousArgs(baseUrl, paths) {
  return [
    'h2i',
    'enroll',
    '--bootstrap-url',
    baseUrl,
    '--anonymous',
    '--state-file',
    paths.state,
    '--config-path',
    paths.config,
    '--install-dir',
    paths.bin,
    '--no-start',
  ];
}

async function waitForObservedPath(observed, suffix, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observed.some((row) => row.path.endsWith(suffix))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`Timed out waiting for observed request ending in ${suffix}`);
}

async function startMockServer({
  identityKind,
  leaseProfile = identityKind === 'user' ? 'employee' : 'anonymous',
  observed,
  snapshotMutator,
  leaseMutator,
  syncDelayMs = 0,
  internalControlIp = '10.88.88.88',
  internalBaseUrl,
  routeCidrs = ['10.88.0.0/16', '10.89.0.0/16'],
  healthStatus = 200,
}) {
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    observed.push({
      path: request.url,
      method: request.method,
      headers: request.headers,
      body,
    });

    if (request.url === '/bootstrap-healthz') return json(response, 200, { ok: true });
    if (request.url === '/healthz') return json(response, healthStatus, { ok: healthStatus < 400 });
    if (request.url === '/internal/v1/sdk/oauth/token') {
      return json(response, 200, {
        token: {
          access_token: 'account-token',
          token_type: 'Bearer',
          audience: 'mx-sdk',
          subject: 'user:usr-account',
          auth_provider: 'local-password',
          principal: { kind: 'user', userId: 'usr-account', email: 'user@example.com' },
        },
      });
    }
    if (request.url === '/internal/v1/launcher-network/enrollments') {
      const capability = request.headers['x-mx-new-lease-capability'];
      const user = identityKind === 'user';
      const lease = {
          leaseId: `lease-${identityKind}`,
          leaseKey: `mx-h2i:${identityKind}`,
          capability,
          environment: 'test',
          productId: 'mx-h2i',
          launcherMode: 'standalone',
          identityKind,
          leaseProfile,
          sequence: 10,
          installId: body.installId,
          deviceId: body.deviceId,
          siteId: 'domestic-main',
          userId: user ? 'usr-account' : null,
          cidr: '10.89.0.0/16',
          leaseIp: user ? '10.89.0.10' : '10.89.100.10',
          serviceVip: '10.88.100.1',
          internalControlIp: '10.88.88.88',
          domesticGatewayIp: '10.88.0.1',
          domesticSiteId: 'domestic-main',
          overseaSiteId: 'oversea-main',
          publicKey: body.publicKey,
          status: 'active',
          expiresAt: '2027-01-01T00:00:00.000Z',
      };
      if (leaseMutator) leaseMutator(lease);
      return json(response, 200, { lease });
    }
    if (request.url === '/internal/v1/launcher-network/snapshots') {
      const user = identityKind === 'user';
      const leaseIp = user ? '10.89.0.10' : '10.89.100.10';
      const value = snapshot({
        identityKind,
        leaseProfile,
        leaseIp,
        publicKey: body.publicKey,
        installId: body.installId,
        deviceId: body.deviceId,
        internalControlIp,
        internalBaseUrl: internalBaseUrl ?? (
          internalControlIp === '127.0.0.1'
            ? `http://127.0.0.1:${server.address().port}`
            : 'http://10.88.88.88:18090'
        ),
        routeCidrs,
      });
      if (snapshotMutator) snapshotMutator(value);
      return json(response, 200, { snapshot: value });
    }
    if (request.url === `/internal/v1/launcher-network/leases/lease-${identityKind}/domestic-peer/sync`) {
      if (syncDelayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, syncDelayMs));
      return json(response, 200, {
        domesticPeerSync: {
          status: 'passed',
          execution: 'executed',
          checkedAt: '2026-08-04T00:00:00.000Z',
          failures: [],
        },
      });
    }
    return json(response, 404, { message: `unexpected path ${request.url}` });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

function snapshot({
  identityKind,
  leaseProfile,
  leaseIp,
  publicKey,
  installId,
  deviceId,
  internalControlIp,
  internalBaseUrl,
  routeCidrs,
}) {
  return {
    snapshotId: `snapshot-${identityKind}`,
    environment: 'test',
    appId: 'mx-h2i',
    installId,
    deviceId,
    userId: identityKind === 'user' ? 'usr-account' : null,
    mode: identityKind === 'user' ? 'user' : 'guest',
    overlayPolicy: {
      productId: 'mx-h2i',
      launcherMode: 'standalone',
      identityKind,
      leaseProfile,
      cidr: '10.89.0.0/16',
      leaseIp,
      relayMode: 'h2i',
    },
    topology: {
      product: {
        productId: 'mx-h2i',
        serviceVip: '10.88.100.1',
        internalControlIp,
        domesticGatewayIp: '10.88.0.1',
        dnsServer: '10.88.0.1',
        updatePolicy: 'launcher-managed',
        rateLimitProfile: 'default',
        dnsPolicyId: 'internal-default',
        licensePolicyId: 'default',
      },
      domestic: { siteId: 'domestic-main', gatewayIp: '10.88.0.1' },
      internal: {
        siteId: 'internal-main',
        baseUrl: internalBaseUrl,
        relayPeer: { fixedIp: internalControlIp },
      },
      oversea: { siteId: 'oversea-main' },
      relayPlan: {
        domesticRelay: {
          siteId: 'domestic-main',
          publicEndpoint: '198.51.100.10:51280',
          publicKey: 'L+V9o0fNYkMVKNqsX7spBzD/9oSvxM/C7ZCZX1jLO3Q=',
        },
        refreshHint: {
          publicEndpoint: '198.51.100.10:51280',
          materialDigest: 'material-digest',
          secretUpdatedAt: '2026-08-04T00:00:00.000Z',
        },
        homePeer: {
          publicKey,
          allowedIps: routeCidrs,
        },
        routes: {
          internalCidrs: routeCidrs,
          dnsServer: '10.88.0.1',
        },
      },
    },
    dns: { authority: 'internal-coredns', matchDomains: ['internal.test'], fallback: 'system' },
    signatures: { algorithm: 'sha256', digest: `digest-${identityKind}`, issuer: 'internal' },
    issuedAt: '2026-08-04T00:00:00.000Z',
  };
}

function testPaths(label) {
  const root = mkdtempSync(join(tmpdir(), `qp-h2i-${label}-`));
  tempRoots.push(root);
  const trustedRootFixture = process.platform === 'linux'
    && typeof process.getuid === 'function'
    && process.getuid() === 0;
  const bin = trustedRootFixture
    ? mkdtempSync('/opt/qpjoy-h2i-test-')
    : join(root, 'bin');
  if (trustedRootFixture) systemDirectories.push(bin);
  const wg = join(bin, 'wg');
  const ip = join(bin, 'ip');
  mkdirSync(bin, { recursive: true });
  writeFileSync(wg, `#!/bin/sh
case "$1" in
  --version) printf '%s\n' 'wireguard-tools v1.0.20210914' ;;
  genkey) printf '%s\\n' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' ;;
  pubkey) cat >/dev/null; printf '%s\\n' 'L+V9o0fNYkMVKNqsX7spBzD/9oSvxM/C7ZCZX1jLO3Q=' ;;
  *) exit 1 ;;
esac
`);
  chmodSync(wg, 0o755);
  writeFileSync(ip, `#!/bin/sh
iface="\${H2I_TEST_INTERFACE:-mx-h2i}"
printf '%s\n' "10.88.0.0/16 dev $iface" "10.89.0.0/16 dev $iface"
`);
  chmodSync(ip, 0o755);
  return {
    root,
    bin,
    state: join(root, 'client.json'),
    config: join(root, 'mx-h2i.conf'),
  };
}

function systemdTestPaths(label) {
  const paths = testPaths(label);
  const runtime = join(paths.root, 'runtime');
  mkdirSync(runtime, { recursive: true });
  const wg = join(paths.bin, 'wg');
  const wgQuick = join(paths.bin, 'wg-quick');
  const systemctl = join(paths.bin, 'systemctl');
  const ip = join(paths.bin, 'ip');
  writeFileSync(wg, `#!/bin/sh
set -eu
state="$H2I_TEST_RUNTIME"
case "\${1:-}" in
  --version) printf '%s\n' 'wireguard-tools v1.0.20210914' ;;
  genkey) printf '%s\n' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' ;;
  pubkey) cat >/dev/null; printf '%s\n' 'L+V9o0fNYkMVKNqsX7spBzD/9oSvxM/C7ZCZX1jLO3Q=' ;;
  show)
    [ -f "$state/tunnel-active" ] || exit 1
    if [ "\${3:-}" = dump ]; then
      now="$(date +%s)"
      printf '%s\t%s\t%s\t%s\n' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' 'L+V9o0fNYkMVKNqsX7spBzD/9oSvxM/C7ZCZX1jLO3Q=' '51820' 'off'
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' 'L+V9o0fNYkMVKNqsX7spBzD/9oSvxM/C7ZCZX1jLO3Q=' '(none)' '198.51.100.10:51280' '127.0.0.0/8,10.89.0.0/16' "$now" '1' '1' '25'
    fi
    ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(wgQuick, `#!/bin/sh
set -eu
case "\${1:-}" in
  --version) exit 0 ;;
  up) touch "$H2I_TEST_RUNTIME/tunnel-active" ;;
  down) rm -f "$H2I_TEST_RUNTIME/tunnel-active" ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(systemctl, `#!/bin/sh
set -eu
state="$H2I_TEST_RUNTIME"
command="\${1:-}"
case "$command" in
  daemon-reload) exit 0 ;;
  restart) touch "$state/tunnel-active" "$state/service-active" ;;
  stop) rm -f "$state/tunnel-active" "$state/service-active" ;;
  enable)
    runtime=0
    case " $* " in *' --runtime '*) runtime=1 ;; esac
    [ "\${H2I_TEST_FAIL_ENABLE:-0}" != 1 ] || [ "$runtime" = 1 ] || exit 1
    if [ "$runtime" = 1 ]; then
      touch "$state/enabled-runtime"
    else
      touch "$state/enabled"
    fi
    ;;
  disable)
    runtime=0
    case " $* " in *' --runtime '*) runtime=1 ;; esac
    if [ "$runtime" = 1 ]; then
      rm -f "$state/enabled-runtime"
    else
      rm -f "$state/enabled"
    fi
    case " $* " in *' --now '*) rm -f "$state/tunnel-active" "$state/service-active" ;; esac
    ;;
  is-active)
    if [ -f "$state/service-active" ]; then printf '%s\n' active; exit 0; fi
    printf '%s\n' inactive
    exit 3
    ;;
  is-enabled)
    if [ -f "$state/enabled" ]; then printf '%s\n' enabled; exit 0; fi
    if [ -f "$state/enabled-runtime" ]; then printf '%s\n' enabled-runtime; exit 0; fi
    printf '%s\n' disabled
    exit 1
    ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(ip, `#!/bin/sh
printf '%s\n' "127.0.0.0/8 dev $H2I_TEST_INTERFACE" "10.89.0.0/16 dev $H2I_TEST_INTERFACE"
`);
  for (const file of [wg, wgQuick, systemctl, ip]) chmodSync(file, 0o755);
  return { ...paths, runtime };
}

function systemdEnrollArgs(baseUrl, paths, interfaceName) {
  return [
    'h2i',
    'enroll',
    '--bootstrap-url',
    baseUrl,
    '--anonymous',
    '--interface',
    interfaceName,
    '--state-file',
    paths.state,
    '--install-dir',
    paths.bin,
  ];
}

function systemdTestEnvironment(paths, interfaceName) {
  return {
    pathPrefix: paths.bin,
    H2I_TEST_RUNTIME: paths.runtime,
    H2I_TEST_INTERFACE: interfaceName,
  };
}

function assertSafeStateAndConfig(paths, expected) {
  const stateText = readFileSync(paths.state, 'utf8');
  const state = JSON.parse(stateText);
  assert.equal(statSync(paths.state).mode & 0o777, 0o600);
  assert.equal(state.identityKind, expected.identityKind);
  assert.equal(state.lease.leaseId, expected.leaseId);
  assert.equal(state.lease.leaseIp, expected.leaseIp);
  assert.equal(state.lease.capability, expected.capability);
  assert.equal(state.publicKey, expected.publicKey);
  assert.equal(state.pendingLeaseCapability, undefined);
  assert.equal(state.peerSync.status, 'passed');
  assert.doesNotMatch(stateText, /test-password|account-token/);

  const config = readFileSync(paths.config, 'utf8');
  assert.equal(statSync(paths.config).mode & 0o777, 0o600);
  assert.match(config, new RegExp(`Address = ${expected.leaseIp.replaceAll('.', '\\.')}\\/32`));
  assert.match(config, /Endpoint = 198\.51\.100\.10:51280/);
  const allowedIps = /^AllowedIPs = (.+)$/m.exec(config)?.[1].split(/,\s*/) ?? [];
  assert.ok(allowedIps.includes('10.88.0.0/16'));
  assert.ok(allowedIps.some((cidr) => cidrContainsIpv4(cidr, expected.leaseIp)));
  if (expected.dns) assert.match(config, /DNS = 10\.88\.0\.1/);
  else assert.doesNotMatch(config, /^DNS =/m);
  assert.doesNotMatch(config, /100\.89\./);
}

function cidrContainsIpv4(cidr, ip) {
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(network) & mask) === (ipv4Number(ip) & mask);
}

function ipv4Number(value) {
  return value.split('.').reduce((out, octet) => ((out << 8) | Number(octet)) >>> 0, 0);
}

async function runCli(args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        H2I_BOOTSTRAP_URL: '',
        H2I_USERNAME: '',
        H2I_PASSWORD: options.H2I_PASSWORD ?? '',
        H2I_ACCESS_TOKEN: options.H2I_ACCESS_TOKEN ?? '',
        H2I_USER_ID: options.H2I_USER_ID ?? '',
        H2I_TEST_RUNTIME: options.H2I_TEST_RUNTIME ?? '',
        H2I_TEST_INTERFACE: options.H2I_TEST_INTERFACE ?? '',
        H2I_TEST_FAIL_ENABLE: options.H2I_TEST_FAIL_ENABLE ?? '',
        PATH: options.pathPrefix
          ? `${options.pathPrefix}:${process.env.PATH ?? ''}`
          : process.env.PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}
