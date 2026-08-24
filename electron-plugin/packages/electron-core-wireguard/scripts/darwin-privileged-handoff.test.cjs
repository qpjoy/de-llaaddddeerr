const assert = require('node:assert/strict');
const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const core = require('../dist/index.js');
const source = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');

function functionSource(name, nextDeclaration) {
  const start = source.indexOf(`export async function ${name}`);
  const end = source.indexOf(nextDeclaration, start + 1);
  assert.notEqual(start, -1, `${name} source must exist`);
  assert.notEqual(end, -1, `${nextDeclaration} boundary must exist`);
  return source.slice(start, end);
}

function darwinRuntime() {
  const tool = (name, command) => ({
    target: `darwin-arm64:${name}`,
    name,
    available: true,
    source: 'bundled',
    command,
    bundledPath: command,
    installedPath: null,
    systemPath: null,
    error: null
  });
  return {
    target: 'darwin-arm64',
    platform: 'darwin',
    available: true,
    method: 'darwin-userspace',
    wg: tool('wg', '/usr/bin/true'),
    wgQuick: null,
    wireGuardGo: tool('wireguard-go', '/usr/bin/true'),
    bash: null,
    windowsWireGuard: null,
    warnings: [],
    error: null
  };
}

function writeProfile(path) {
  writeFileSync(path, [
    '[Interface]',
    'PrivateKey = test-private-key',
    'Address = 10.89.50.2/32',
    '',
    '[Peer]',
    'PublicKey = test-public-key',
    'AllowedIPs = 10.88.0.0/16',
    'Endpoint = 127.0.0.1:51820',
    ''
  ].join('\n'));
}

test('Darwin privileged hooks are the final synchronous gate before osascript', () => {
  const repairSource = functionSource('repairWireGuardTunnelRoutes', 'export function getDarwinWireGuardLaunchDaemonStatus');
  const installSource = functionSource('installDarwinWireGuardLaunchDaemon', 'async function waitForDarwinLaunchDaemonReady');
  const adjacentHandoff = /beforeDarwinPrivilegedCommand\?\.\(\);\s*try\s*\{\s*const result = await execFileAsync\('osascript'/;
  assert.match(repairSource, adjacentHandoff);
  assert.match(installSource, adjacentHandoff);
});

test('install handoff propagates superseded and distinguishes command start from user authorization cancel', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'wireguard-handoff-'));
  const binDir = join(tempDir, 'bin');
  const configPath = join(tempDir, 'mx-h2i.conf');
  const markerPath = join(tempDir, 'osascript-ran');
  const osascriptPath = join(binDir, 'osascript');
  const previousPath = process.env.PATH;
  const previousError = process.env.MX_TEST_OSASCRIPT_ERROR;
  const previousMarker = process.env.MX_TEST_OSASCRIPT_MARKER;
  try {
    require('node:fs').mkdirSync(binDir, { recursive: true });
    writeProfile(configPath);
    writeFileSync(osascriptPath, [
      '#!/bin/sh',
      'printf "%s\\n" "$MX_TEST_OSASCRIPT_ERROR" >&2',
      'printf "ran\\n" > "$MX_TEST_OSASCRIPT_MARKER"',
      'exit 1',
      ''
    ].join('\n'));
    chmodSync(osascriptPath, 0o755);
    process.env.PATH = `${binDir}:${previousPath || ''}`;
    process.env.MX_TEST_OSASCRIPT_MARKER = markerPath;

    const runtime = darwinRuntime();
    const serviceIdentity = {
      displayName: 'WireGuard handoff test',
      darwinLaunchDaemonLabelPrefix: 'com.qpjoy.test.wireguard',
      darwinSupportRoot: join(tempDir, 'support'),
      darwinLogDir: join(tempDir, 'logs')
    };
    const superseded = new Error('network transition superseded');
    superseded.code = 'MX_NETWORK_TRANSITION_SUPERSEDED';
    let hookCalls = 0;
    await assert.rejects(
      core.installDarwinWireGuardLaunchDaemon({
        runtime,
        configPath,
        serviceIdentity,
        beforeDarwinPrivilegedCommand() {
          hookCalls += 1;
          throw superseded;
        }
      }),
      (err) => err === superseded
    );
    assert.equal(hookCalls, 1);
    assert.equal(existsSync(markerPath), false, 'a throwing handoff must prevent osascript execution');

    let missingHookCalls = 0;
    const preflight = await core.installDarwinWireGuardLaunchDaemon({
      runtime,
      configPath: join(tempDir, 'missing.conf'),
      serviceIdentity,
      beforeDarwinPrivilegedCommand() {
        missingHookCalls += 1;
      }
    });
    assert.equal(missingHookCalls, 0);
    assert.equal(preflight.privilegedExecution, 'not-started');

    process.env.MX_TEST_OSASCRIPT_ERROR = 'route helper cancelled while applying routes';
    const childFailure = await core.installDarwinWireGuardLaunchDaemon({
      runtime,
      configPath,
      serviceIdentity,
      beforeDarwinPrivilegedCommand() {
        hookCalls += 1;
      }
    });
    assert.equal(childFailure.authorizationCanceled, false);
    assert.equal(childFailure.privilegedExecution, 'started');

    process.env.MX_TEST_OSASCRIPT_ERROR = 'execution error: User canceled.';
    const unstructuredCancellationText = await core.installDarwinWireGuardLaunchDaemon({
      runtime,
      configPath,
      serviceIdentity
    });
    assert.equal(unstructuredCancellationText.authorizationCanceled, false);
    assert.equal(unstructuredCancellationText.privilegedExecution, 'started');

    process.env.MX_TEST_OSASCRIPT_ERROR = 'execution error: User canceled. (-128)';
    const authorizationCanceled = await core.installDarwinWireGuardLaunchDaemon({
      runtime,
      configPath,
      serviceIdentity
    });
    assert.equal(authorizationCanceled.authorizationCanceled, true);
    assert.equal(authorizationCanceled.privilegedExecution, 'authorization-canceled');

    process.env.MX_TEST_OSASCRIPT_ERROR = 'daemon cleanup cancelled by child command';
    const uninstallChildFailure = await core.uninstallDarwinWireGuardLaunchDaemon({
      runtime,
      configPath,
      serviceIdentity
    });
    assert.equal(uninstallChildFailure.authorizationCanceled, false);
    assert.equal(uninstallChildFailure.privilegedExecution, 'started');

    process.env.MX_TEST_OSASCRIPT_ERROR = 'execution error: User canceled. (-128)';
    const uninstallAuthorizationCanceled = await core.uninstallDarwinWireGuardLaunchDaemon({
      runtime,
      configPath,
      serviceIdentity
    });
    assert.equal(uninstallAuthorizationCanceled.authorizationCanceled, true);
    assert.equal(uninstallAuthorizationCanceled.privilegedExecution, 'authorization-canceled');
  } finally {
    process.env.PATH = previousPath;
    if (previousError === undefined) delete process.env.MX_TEST_OSASCRIPT_ERROR;
    else process.env.MX_TEST_OSASCRIPT_ERROR = previousError;
    if (previousMarker === undefined) delete process.env.MX_TEST_OSASCRIPT_MARKER;
    else process.env.MX_TEST_OSASCRIPT_MARKER = previousMarker;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
