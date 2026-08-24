import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  connectLauncherWireGuardPeer,
  resolveLauncherWireGuardRuntime,
  stopLauncherWireGuardPeer
} from '../dist/wireguard.js';

const packageDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = readFileSync(resolve(packageDir, 'src/wireguard.ts'), 'utf8');

function functionSource(name) {
  const declaration = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = declaration.exec(source);
  assert.ok(match, `${name} source must exist`);
  const parametersEnd = source.indexOf(')', match.index);
  const bodyStart = source.indexOf('{', parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`${name} source is incomplete`);
}

test('launcher forwards the optional Darwin privileged handoff to install and repair', () => {
  assert.match(
    source,
    /beforeDarwinPrivilegedCommand\?: \(\) => void;/,
    'existing callers must remain source-compatible because the handoff is optional'
  );
  assert.match(
    functionSource('connectLauncherWireGuardPeer'),
    /installDarwinWireGuardLaunchDaemon\([\s\S]*beforeDarwinPrivilegedCommand: input\.beforeDarwinPrivilegedCommand[\s\S]*privilegedExecution: launchDaemon\.privilegedExecution/
  );
  assert.match(
    functionSource('repairLauncherWireGuardPeerRoutes'),
    /repairWireGuardTunnelRoutes\([\s\S]*beforeDarwinPrivilegedCommand: input\.beforeDarwinPrivilegedCommand/
  );
  assert.match(
    functionSource('recoverLauncherWireGuardPeer'),
    /installDarwinWireGuardLaunchDaemon\([\s\S]*beforeDarwinPrivilegedCommand: input\.beforeDarwinPrivilegedCommand[\s\S]*privilegedExecution: launchDaemon\.privilegedExecution/
  );
});

test('Darwin stop with app-managed fallback disabled never starts a second privileged command', () => {
  const stopSource = functionSource('stopLauncherWireGuardPeer');
  assert.match(
    stopSource,
    /authorizationCanceled[\s\S]*privilegedExecution: launchDaemon\.privilegedExecution/,
    'LaunchDaemon uninstall must preserve structured authorization and execution metadata'
  );
  const guardIndex = stopSource.indexOf('if (input.fallbackToAppManaged === false)');
  const fallbackIndex = stopSource.indexOf('const tunnel = await setWireGuardTunnelState');
  assert.ok(guardIndex >= 0, 'the Darwin no-fallback guard must exist');
  assert.ok(fallbackIndex > guardIndex, 'the guard must return before app-managed down can run');
  assert.match(
    stopSource.slice(guardIndex, fallbackIndex),
    /safeWireGuardStatus[\s\S]*skipped: true[\s\S]*cleanupReady/,
    'the skipped result must include a live inactive proof instead of assuming cleanup'
  );
});

test('inactive Darwin stop skips app-managed osascript when fallback is disabled', {
  skip: process.platform !== 'darwin'
}, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'launcher-wireguard-stop-'));
  const userDataDir = join(tempDir, 'user-data');
  const installDir = join(tempDir, 'bin');
  const fakeBinDir = join(tempDir, 'fake-bin');
  const markerPath = join(tempDir, 'osascript-ran');
  const previousPath = process.env.PATH;
  try {
    mkdirSync(join(userDataDir, 'wireguard'), { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(join(installDir, 'wg'), 'unused');
    writeFileSync(join(installDir, 'wireguard-go'), 'unused');
    writeFileSync(join(installDir, 'wg-quick'), 'unused');
    const bundledBash = join(installDir, 'bash');
    writeFileSync(bundledBash, '#!/bin/sh\nprintf "GNU bash, version 5.2.0\\n"\n');
    chmodSync(bundledBash, 0o755);
    writeFileSync(join(userDataDir, 'wireguard', 'mx-h2i.conf'), [
      '[Interface]',
      'PrivateKey = test-private-key',
      'Address = 192.0.2.246/32',
      '',
      '[Peer]',
      'PublicKey = test-public-key',
      'AllowedIPs = 198.51.100.0/24',
      ''
    ].join('\n'));
    const fakeOsascript = join(fakeBinDir, 'osascript');
    writeFileSync(fakeOsascript, `#!/bin/sh\nprintf "ran\\n" > ${JSON.stringify(markerPath)}\nexit 1\n`);
    chmodSync(fakeOsascript, 0o755);
    process.env.PATH = `${fakeBinDir}:${previousPath || ''}`;

    const runtimeOptions = {
      userDataDir,
      installDir,
      profileName: 'mx-h2i.conf',
      allowSystemFallback: false,
      darwinLaunchDaemon: true,
      fallbackToAppManaged: false,
      darwinServiceIdentity: {
        darwinLaunchDaemonLabelPrefix: `com.qpjoy.test.${Date.now()}`,
        darwinSupportRoot: join(tempDir, 'support'),
        darwinLogDir: join(tempDir, 'logs')
      }
    };
    assert.equal(
      resolveLauncherWireGuardRuntime({ ...runtimeOptions, darwinLaunchDaemon: false }).method,
      'wg-quick',
      'the fixture must reproduce an upgraded machine with residual wg-quick and Bash 4+'
    );
    assert.equal(
      resolveLauncherWireGuardRuntime(runtimeOptions).method,
      'darwin-userspace',
      'an explicit LaunchDaemon runtime must override the residual wg-quick preference'
    );

    const result = await stopLauncherWireGuardPeer(runtimeOptions);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.skipped, true);
    assert.equal(result.cleanupReady, true);
    assert.equal(result.reason, 'darwin-wireguard-already-inactive');
    assert.equal(result.privilegedExecution, 'not-started');
    assert.equal(existsSync(markerPath), false);

    const superseded = new Error('network transition superseded');
    superseded.code = 'MX_NETWORK_TRANSITION_SUPERSEDED';
    let hookCalls = 0;
    await assert.rejects(connectLauncherWireGuardPeer({
      ...runtimeOptions,
      routePlan: {
        leaseIp: '192.0.2.246',
        routeCidrs: ['198.51.100.0/24'],
        domesticRelayEndpoint: '127.0.0.1:51820',
        domesticRelayPublicKey: 'test-public-key',
        h2iDirectEnabled: false,
        h2iDirectAllowedIps: [],
        internalControlIp: '198.51.100.10',
        internalBaseUrl: 'https://internal.test',
        domesticGatewayIp: '198.51.100.1',
        dnsServer: '198.51.100.53'
      },
      privateKey: 'test-private-key',
      beforeDarwinPrivilegedCommand() {
        hookCalls += 1;
        throw superseded;
      }
    }), (err) => err === superseded);
    assert.equal(hookCalls, 1);
    assert.equal(existsSync(markerPath), false, 'superseded connect must not execute osascript or fall back');
  } finally {
    process.env.PATH = previousPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('launcher trusts structured authorizationCanceled and otherwise only accepts AppleScript -128', () => {
  const classifier = functionSource('isDarwinAuthorizationCancelled');
  assert.match(classifier, /authorizationCanceled === true/);
  assert.match(classifier, /authorizationCanceled === false/);
  assert.match(classifier, /\\\(-128\\\)/);
  assert.doesNotMatch(classifier, /user cancel|用户.*取消|\/cancelled\//i);
});
