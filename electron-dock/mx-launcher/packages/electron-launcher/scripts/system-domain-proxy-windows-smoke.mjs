import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const testDir = mkdtempSync(join(tmpdir(), 'mx-system-domain-proxy-windows-'));
const binDir = join(testDir, 'bin');
const windowsDir = join(testDir, 'windows');
const powerShellDir = join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0');
const registryPath = join(testDir, 'registry.json');
const notifyLogPath = join(testDir, 'proxy-notify.log');
const windowsCommandMockRunnerPath = join(testDir, 'windows-command-mock-runner.cjs');
const windowsCommandMockLoaderPath = join(testDir, 'windows-command-mock-loader.mjs');
mkdirSync(binDir);
mkdirSync(powerShellDir, { recursive: true });

writeFileSync(join(binDir, 'reg.exe'), 'intercepted by windows-command-mock-loader.mjs\n');
writeFileSync(join(powerShellDir, 'powershell.exe'), 'intercepted by windows-command-mock-loader.mjs\n');
writeFileSync(windowsCommandMockRunnerPath, `
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');
const command = basename(String(process.argv[2] || '')).toLowerCase();
const args = process.argv.slice(3);
if (command === 'powershell.exe') {
  const { appendFileSync } = require('node:fs');
  const commandIndex = args.findIndex((arg) => String(arg).toLowerCase() === '-command');
  const powerShellCommand = commandIndex >= 0 ? String(args[commandIndex + 1] || '') : '';
  if (/@['"][^\\r\\n]/.test(powerShellCommand)) {
    process.stderr.write('UnexpectedCharactersAfterHereStringHeader\\n');
    process.exit(1);
  }
  if (!powerShellCommand.includes('$sig = \\'[DllImport("wininet.dll", SetLastError=true)]')) {
    process.stderr.write('WinINet signature must use a PowerShell 5.1-safe string literal\\n');
    process.exit(1);
  }
  if (process.env.MX_TEST_PROXY_NOTIFY_LOG) {
    appendFileSync(process.env.MX_TEST_PROXY_NOTIFY_LOG, 'notify\\n');
  }
  if (process.env.MX_TEST_PROXY_NOTIFY_FAILURE === '1') {
    process.stderr.write('InternetSetOption failed\\n');
    process.exit(5);
  }
  process.exit(0);
}
if (command !== 'reg.exe') {
  process.stderr.write('Unexpected mocked Windows command: ' + command + '\\n');
  process.exit(1);
}
const registryPath = process.env.MX_TEST_WINDOWS_REGISTRY;
const state = existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : {};
const operation = String(args[0] || '').toLowerCase();
const valueIndex = args.indexOf('/v');
const name = valueIndex >= 0 ? args[valueIndex + 1] : '';
if (operation === 'query') {
  if (process.env.MX_TEST_REG_QUERY_FAILURE === 'all'
    || (process.env.MX_TEST_REG_QUERY_FAILURE === 'ProxyServer'
      && (valueIndex < 0 || name === 'ProxyServer'))) {
    process.stderr.write('ERROR: Access is denied.\\n');
    process.exit(5);
  }
  if (valueIndex < 0) {
    process.stdout.write('HKEY_CURRENT_USER\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Internet Settings\\n');
    for (const [rowName, row] of Object.entries(state)) {
      process.stdout.write('    ' + rowName + '    ' + row.type + '    ' + row.value + '\\n');
    }
    process.exit(0);
  }
  const row = state[name];
  if (!row) process.exit(1);
  process.stdout.write('HKEY_CURRENT_USER\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Internet Settings\\n'
    + '    ' + name + '    ' + row.type + '    ' + row.value + '\\n');
  process.exit(0);
}
if (operation === 'add') {
  if (process.env.MX_TEST_REG_WRITE_FAILURE === 'add-before'
    || process.env.MX_TEST_REG_WRITE_FAILURE === 'add-before:' + name) {
    process.stderr.write('ERROR: Access is denied.\\n');
    process.exit(5);
  }
  const typeIndex = args.indexOf('/t');
  const dataIndex = args.indexOf('/d');
  state[name] = {
    type: typeIndex >= 0 ? args[typeIndex + 1] : 'REG_SZ',
    value: dataIndex >= 0 ? args[dataIndex + 1] : ''
  };
  writeFileSync(registryPath, JSON.stringify(state));
  if (process.env.MX_TEST_REG_WRITE_FAILURE === 'add-after') {
    process.stderr.write('ERROR: reg.exe reported failure after commit.\\n');
    process.exit(5);
  }
  process.exit(0);
}
if (operation === 'delete') {
  if (process.env.MX_TEST_REG_WRITE_FAILURE === 'delete-before') {
    process.stderr.write('ERROR: Access is denied.\\n');
    process.exit(5);
  }
  if (!state[name]) process.exit(1);
  delete state[name];
  writeFileSync(registryPath, JSON.stringify(state));
  if (process.env.MX_TEST_REG_WRITE_FAILURE === 'delete-after') {
    process.stderr.write('ERROR: reg.exe reported failure after commit.\\n');
    process.exit(5);
  }
  process.exit(0);
}
process.exit(1);
`);
writeFileSync(windowsCommandMockLoaderPath, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const originalExecFile = childProcess.execFile;
const runnerPath = process.env.MX_TEST_WINDOWS_COMMAND_RUNNER;
childProcess.execFile = function(command, args, options, callback) {
  const name = basename(String(command)).toLowerCase();
  if (runnerPath && (name === 'reg.exe' || name === 'powershell.exe')) {
    return originalExecFile(
      process.execPath,
      [runnerPath, String(command), ...(args || [])],
      options,
      callback
    );
  }
  return originalExecFile(command, args, options, callback);
};
syncBuiltinESMExports();
`);

process.env.MX_TEST_WINDOWS_REGISTRY = registryPath;
process.env.MX_TEST_PROXY_NOTIFY_LOG = notifyLogPath;
process.env.MX_TEST_WINDOWS_COMMAND_RUNNER = windowsCommandMockRunnerPath;
process.env.MX_TEST_WINDOWS_COMMAND_LOADER = pathToFileURL(windowsCommandMockLoaderPath).href;
process.env.LOCALAPPDATA = join(testDir, 'local-app-data');
process.env.SystemRoot = windowsDir;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH || ''}`;
Object.defineProperty(process, 'platform', { value: 'win32' });

await import(process.env.MX_TEST_WINDOWS_COMMAND_LOADER);
const {
  buildElectronLauncherDnsRelayFallbackResponse,
  createElectronLauncherSystemDomainProxy,
  renderElectronLauncherPacScript
} = await import('../dist/system-domain-proxy.js');
const { windowsPowerShellCommand } = await import('../dist/windows-command.js');
const systemDomainProxyModuleUrl = new URL('../dist/system-domain-proxy.js', import.meta.url).href;

assert.equal(
  windowsPowerShellCommand(),
  join(powerShellDir, 'powershell.exe'),
  'PowerShell must resolve from System32 even when its directory is absent from PATH'
);
const sysnativePowerShellDir = join(windowsDir, 'Sysnative', 'WindowsPowerShell', 'v1.0');
mkdirSync(sysnativePowerShellDir, { recursive: true });
writeExecutable(join(sysnativePowerShellDir, 'powershell.exe'), '#!/usr/bin/env node\nprocess.exit(0);\n');
assert.equal(
  windowsPowerShellCommand(),
  join(sysnativePowerShellDir, 'powershell.exe'),
  'Sysnative must win for a 32-bit process on 64-bit Windows'
);
rmSync(join(windowsDir, 'Sysnative'), { recursive: true, force: true });

const oldClash = windowsProxyState('http://clash.invalid/old.pac', '127.0.0.1:7890', '<local>;old.test');
const newClash = windowsProxyState('http://clash.invalid/new.pac', '127.0.0.1:7891', '<local>;new.test');
const tunOwner = {
  ProxyEnable: { type: 'REG_DWORD', value: '0' },
  ProxyServer: { type: 'REG_SZ', value: '127.0.0.1:7890' },
  ProxyOverride: { type: 'REG_SZ', value: '<local>;old.test' },
  AutoDetect: { type: 'REG_DWORD', value: '0' }
};
const productPacUrl = 'http://127.0.0.1:2053/proxy.pac';

try {
  const deadGatePid = nonexistentPid();
  const currentUserGatePath = join(
    process.env.LOCALAPPDATA,
    'QPJoy',
    'MXLauncher',
    'network',
    'windows-system-domain-proxy-owner-v1.json'
  );
  const currentUserGateQueuePath = `${currentUserGatePath}.queue`;
  mkdirSync(currentUserGateQueuePath, { recursive: true });
  writeFileSync(currentUserGatePath, JSON.stringify({
    version: 1,
    pid: deadGatePid,
    token: 'dead-legacy-owner',
    statePath: join(testDir, 'dead-legacy-owner-state.json'),
    createdAt: new Date().toISOString()
  }));
  writeFileSync(join(currentUserGateQueuePath, `${deadGatePid}-dead-queue-owner.json`), JSON.stringify({
    version: 1,
    pid: deadGatePid,
    token: 'dead-queue-owner',
    ticket: 1,
    choosing: false,
    metadata: { statePath: join(testDir, 'dead-queue-owner-state.json') },
    createdAt: new Date().toISOString()
  }));
  const gateRaceReleasePath = join(testDir, 'release-current-user-gate-race');
  const gateRaceChildren = Array.from({ length: 8 }, (_, index) => startGateRaceChild({
    moduleUrl: systemDomainProxyModuleUrl,
    userDataDir: join(testDir, `gate-race-${index}`),
    pacUrl: `http://127.0.0.1:${22000 + index}/race-${index}.pac`,
    releasePath: gateRaceReleasePath
  }));
  writeRegistry(tunOwner);
  let gateRaceOutcomes;
  try {
    gateRaceOutcomes = await Promise.all(gateRaceChildren.map((child) => child.outcome));
    assert.equal(
      gateRaceOutcomes.filter((outcome) => outcome.ok === true).length,
      1,
      `exactly one process may recover and own the current-user PAC gate: ${JSON.stringify(gateRaceOutcomes)}`
    );
    assert.equal(
      gateRaceOutcomes.filter((outcome) => outcome.ok === false).length,
      gateRaceChildren.length - 1
    );
  } finally {
    writeFileSync(gateRaceReleasePath, 'release');
    await Promise.all(gateRaceChildren.map((child) => child.exit));
  }
  assert.deepEqual(
    readRegistry(),
    tunOwner,
    'the sole PAC gate winner must restore the pre-race WinINet state'
  );
  assert.equal(existsSync(currentUserGatePath), false, 'the dead legacy gate must be retired');
  assert.deepEqual(
    readFileNames(currentUserGateQueuePath),
    [],
    'released queue candidates must not linger in the stable queue directory'
  );

  const occupiedWindowsEdge = await listenLoopback();
  const prepareFailureRecoveryPort = await unusedLoopbackPort();
  try {
    await withManager('cross-process-edge-rejected', tunOwner, async (manager, userDataDir) => {
      await assert.rejects(
        manager.apply(browserPolicy(occupiedWindowsEdge.port, 443)),
        /already owned by another process/,
        'Windows must fail closed instead of attaching to an application-process local edge'
      );
      assert.deepEqual(readRegistry(), tunOwner);
      assert.equal(
        existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
        false,
        'a rejected second Windows owner must not leave pending PAC state'
      );

      const recoveryUserDataDir = join(testDir, 'prepare-failure-gate-recovery');
      const recoveryStatePath = join(recoveryUserDataDir, 'recovery-state.json');
      const recovery = createElectronLauncherSystemDomainProxy({
        userDataDir: recoveryUserDataDir,
        statePath: recoveryStatePath,
        pacPort: prepareFailureRecoveryPort,
        log: { warn() {} }
      });
      try {
        const recovered = await recovery.apply(browserPolicy(prepareFailureRecoveryPort, 443));
        assert.equal(
          readRegistry().AutoConfigURL?.value,
          recovered.pacUrl,
          'a prepare/bind failure must release the current-user gate for the next manager'
        );
        await recovery.disable('prepare-failure-gate-recovery-smoke');
      } finally {
        await recovery.close();
      }
    }, { pacPort: occupiedWindowsEdge.port });
  } finally {
    await closeServer(occupiedWindowsEdge.server);
  }

  const ownerEdgePort = await unusedLoopbackPort();
  const localLoserEdgePort = await unusedLoopbackPort();
  const explicitLoserPacPort = await unusedLoopbackPort();
  const ownerUserDataDir = join(testDir, 'current-user-gate-owner');
  const localLoserUserDataDir = join(testDir, 'current-user-gate-local-loser');
  const explicitLoserUserDataDir = join(testDir, 'current-user-gate-explicit-loser');
  const ownerStatePath = join(ownerUserDataDir, 'owner-state.json');
  const localLoserStatePath = join(localLoserUserDataDir, 'local-loser-state.json');
  const explicitLoserStatePath = join(explicitLoserUserDataDir, 'explicit-loser-state.json');
  const owner = createElectronLauncherSystemDomainProxy({
    userDataDir: ownerUserDataDir,
    statePath: ownerStatePath,
    pacPort: ownerEdgePort,
    log: { warn() {} }
  });
  const localLoser = createElectronLauncherSystemDomainProxy({
    userDataDir: localLoserUserDataDir,
    statePath: localLoserStatePath,
    pacPort: localLoserEdgePort,
    log: { warn() {} }
  });
  const explicitLoser = createElectronLauncherSystemDomainProxy({
    userDataDir: explicitLoserUserDataDir,
    statePath: explicitLoserStatePath,
    pacPort: explicitLoserPacPort,
    log: { warn() {} }
  });
  writeRegistry(tunOwner);
  try {
    const owned = await owner.apply(browserPolicy(ownerEdgePort, 443));
    const ownerRegistry = readRegistry();
    const ownerState = readFileSync(ownerStatePath, 'utf8');

    await assert.rejects(
      localLoser.apply(browserPolicy(localLoserEdgePort, 443)),
      /owns current-user AutoConfigURL/,
      'a second Windows manager with a different PAC port/state path must fail before mutation'
    );
    assert.deepEqual(readRegistry(), ownerRegistry);
    assert.equal(existsSync(localLoserStatePath), false, 'the local-PAC loser must not create state');
    assert.equal(readFileSync(ownerStatePath, 'utf8'), ownerState, 'the loser must not rewrite owner state');

    await assert.rejects(
      explicitLoser.apply(policy({
        pacUrl: `http://127.0.0.1:${explicitLoserPacPort}/foreign.pac`
      })),
      /owns current-user AutoConfigURL/,
      'an explicit PAC URL must not bypass the Windows current-user ownership gate'
    );
    assert.deepEqual(readRegistry(), ownerRegistry);
    assert.equal(existsSync(explicitLoserStatePath), false, 'the explicit-PAC loser must not create state');
    assert.equal(readFileSync(ownerStatePath, 'utf8'), ownerState, 'the explicit loser must not rewrite owner state');

    const release = await fetch(
      `http://127.0.0.1:${ownerEdgePort}/__electron-launcher/domain-proxy/release`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerId: 'foreign-owner' })
      }
    );
    assert.equal(release.status, 409, 'Windows /shared/release must reject application-process sharing');
    assert.equal(readRegistry().AutoConfigURL?.value, owned.pacUrl);
    await owner.disable('current-user-gate-owner-smoke');
  } finally {
    await Promise.all([
      owner.close(),
      localLoser.close(),
      explicitLoser.close()
    ]);
  }

  const applyRaceTakeover = windowsProxyState(
    'http://external-owner-b.invalid/proxy.pac',
    '127.0.0.1:7891',
    '<local>;owner-b.test'
  );
  let applyRaceTakeoverObserved = false;
  const applyRacePreviousPac = await listenPac(
    "function FindProxyForURL() { return 'DIRECT'; }",
    () => {
      applyRaceTakeoverObserved = true;
      writeRegistry(applyRaceTakeover);
    }
  );
  const applyRaceInitialOwner = {
    ...windowsProxyState(
      applyRacePreviousPac.url,
      '127.0.0.1:7890',
      '<local>;owner-a.test'
    ),
    ProxyEnable: { type: 'REG_DWORD', value: '0' }
  };
  const applyRaceEdgePort = await unusedLoopbackPort();
  try {
    await withManager('apply-cas-race', applyRaceInitialOwner, async (manager, userDataDir) => {
      const notificationsBeforeApply = proxyNotificationCount();
      await assert.rejects(
        manager.apply(browserPolicy(applyRaceEdgePort, 443)),
        /proxy settings changed while MX-H2I was preparing its PAC/,
        'an external WinINet owner change during PAC negotiation must fail before registry mutation'
      );
      assert.equal(applyRaceTakeoverObserved, true, 'the smoke must exercise the capture-to-apply window');
      assert.deepEqual(
        readRegistry(),
        applyRaceTakeover,
        'apply CAS must preserve the external PAC and ProxyEnable owner that won the negotiation window'
      );
      assert.equal(
        existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
        false,
        'apply CAS rejection must not commit final or pending product state'
      );
      assert.equal(
        proxyNotificationCount(),
        notificationsBeforeApply,
        'apply CAS rejection must happen before the registry write and WinINet notification'
      );
    }, { pacPort: applyRaceEdgePort });
  } finally {
    await closeServer(applyRacePreviousPac.server);
  }

  const liveStaticHttpProxy = await listenLoopback();
  const liveStaticHttpsProxy = await listenLoopback();
  const refreshedStaticHttpsProxy = await listenLoopback();
  const browserUpstream = await listenLoopback();
  const browserEdgePort = await unusedLoopbackPort();
  try {
    const staticClash = windowsProxyState(
      'http://clash.invalid/unused-while-static.pac',
      `http=127.0.0.1:${liveStaticHttpProxy.port};https=127.0.0.1:${liveStaticHttpsProxy.port}`,
      '<local>;*.static.test'
    );
    delete staticClash.AutoConfigURL;
    await withManager('browser-static-fallback', staticClash, async (manager) => {
      const applied = await manager.apply(browserPolicy(browserEdgePort, browserUpstream.port));
      assert.equal(
        applied.fallbackProxy,
        `PROXY 127.0.0.1:${liveStaticHttpsProxy.port}`,
        'a currently listening Clash static proxy must remain the public fallback'
      );
      assert.equal(
        readRegistry().ProxyEnable?.value,
        '1',
        'MX PAC must preserve the active manual proxy bit for non-PAC applications'
      );
      assert.deepEqual(
        readRegistry().ProxyServer,
        staticClash.ProxyServer,
        'MX PAC must not change the active Clash ProxyServer'
      );
      const pac = await fetchText(applied.pacUrl);
      assert.equal(
        evaluatePac(pac, 'https://internal.example.test/', 'internal.example.test'),
        `PROXY 127.0.0.1:${browserEdgePort}`,
        'the Internal exact host must use the MX local edge'
      );
      assert.equal(
        evaluatePac(pac, 'https://child.internal.example.test/', 'child.internal.example.test'),
        `PROXY 127.0.0.1:${browserEdgePort}`,
        'an Internal suffix host must use the MX local edge'
      );
      assert.equal(
        evaluatePac(pac, 'https://public.example.test/', 'public.example.test'),
        `PROXY 127.0.0.1:${liveStaticHttpsProxy.port}; DIRECT`,
        'HTTPS traffic must retain the live Clash HTTPS listener'
      );
      assert.equal(
        evaluatePac(pac, 'http://127.0.0.1:17891/oauth/feishu/callback', '127.0.0.1'),
        'DIRECT',
        'the Feishu loopback callback must never enter the inherited static proxy'
      );
      assert.equal(
        evaluatePac(pac, 'http://[::1]:17891/oauth/feishu/callback', '::1'),
        'DIRECT',
        'the IPv6 loopback callback must never enter the inherited static proxy'
      );
      assert.equal(
        evaluatePac(pac, 'http://public.example.test/', 'public.example.test'),
        `PROXY 127.0.0.1:${liveStaticHttpProxy.port}; DIRECT`,
        'HTTP traffic must retain the live Clash HTTP listener'
      );
      assert.equal(
        evaluatePac(pac, 'https://skip.static.test/', 'skip.static.test'),
        'DIRECT',
        'the previous static ProxyOverride must remain a browser bypass'
      );
      assert.equal(
        evaluatePac(pac, 'https://printer/', 'printer'),
        'DIRECT',
        'the previous <local> static bypass must remain direct'
      );
      const refreshedStaticClash = {
        ...readRegistry(),
        ProxyServer: {
          type: 'REG_SZ',
          value: `http=127.0.0.1:${liveStaticHttpProxy.port};https=127.0.0.1:${refreshedStaticHttpsProxy.port}`
        },
        ProxyOverride: { type: 'REG_SZ', value: '<local>;*.refreshed.test' }
      };
      writeRegistry(refreshedStaticClash);
      const refreshed = await manager.refreshWindowsContinuation('static-hot-update-smoke');
      assert.equal(refreshed.changed, true);
      const refreshedPac = await fetchText(applied.pacUrl);
      assert.equal(
        evaluatePac(refreshedPac, 'https://public.example.test/', 'public.example.test'),
        `PROXY 127.0.0.1:${refreshedStaticHttpsProxy.port}; DIRECT`,
        'a same-owner ProxyServer hot update must refresh PAC without rewriting WinINet ownership'
      );
      assert.equal(
        evaluatePac(refreshedPac, 'https://skip.refreshed.test/', 'skip.refreshed.test'),
        'DIRECT',
        'a same-owner ProxyOverride hot update must refresh the local PAC'
      );
      const tunTransition = {
        ...refreshedStaticClash,
        ProxyEnable: { type: 'REG_DWORD', value: '0' }
      };
      writeRegistry(tunTransition);
      const tunRefreshed = await manager.refreshWindowsContinuation('static-to-tun-smoke');
      assert.equal(tunRefreshed.changed, true);
      const tunPac = await fetchText(applied.pacUrl);
      assert.equal(
        evaluatePac(tunPac, 'https://public.example.test/', 'public.example.test'),
        'DIRECT',
        'turning off the current static proxy must switch unmatched PAC traffic to DIRECT'
      );
      const browser = await manager.probeBrowserAccess({
        host: 'internal.example.test',
        port: browserUpstream.port
      });
      assert.equal(browser.ready, true, JSON.stringify(browser));
      assert.equal(browser.pacApplied, true);
      assert.equal(browser.proxyReachable, true);
      await manager.disable('browser-static-fallback-smoke');
      const expected = { ...tunTransition };
      delete expected.AutoConfigURL;
      assert.deepEqual(readRegistry(), expected, 'disconnect must retain the latest Clash owner fields');
    }, { pacPort: browserEdgePort });
  } finally {
    await Promise.all([
      closeServer(liveStaticHttpProxy.server),
      closeServer(liveStaticHttpsProxy.server),
      closeServer(refreshedStaticHttpsProxy.server),
      closeServer(browserUpstream.server)
    ]);
  }

  const continuationProxy = await listenLoopback();
  const continuationEdgePort = await unusedLoopbackPort();
  try {
    await withManager('continuation-notify-retry', tunOwner, async (manager, userDataDir) => {
      const applied = await manager.apply(browserPolicy(continuationEdgePort, 443));
      writeRegistry(windowsProxyState(
        applied.pacUrl,
        `127.0.0.1:${continuationProxy.port}`,
        '<local>;continuation.test'
      ));

      process.env.MX_TEST_PROXY_NOTIFY_FAILURE = '1';
      const failedNotify = await manager.refreshWindowsContinuation('notify-pending-smoke');
      delete process.env.MX_TEST_PROXY_NOTIFY_FAILURE;
      assert.equal(failedNotify.changed, true);
      assert.equal(failedNotify.pending, true);
      assert.match(failedNotify.error || '', /InternetSetOption failed/);
      const pendingStatePath = join(userDataDir, 'electron-launcher-system-domain-proxy.json');
      assert.equal(
        JSON.parse(readFileSync(pendingStatePath, 'utf8')).continuationNotifyPending,
        true,
        'a failed continuation notification must persist a retry marker'
      );

      const notificationsBeforeRetry = proxyNotificationCount();
      const retried = await manager.refreshWindowsContinuation('notify-retry-smoke');
      assert.equal(retried.changed, false, 'the retry must not require another continuation content change');
      assert.equal(retried.pending, false);
      assert.equal(retried.actual?.continuationRefresh, 'notification-retried');
      assert.ok(
        proxyNotificationCount() > notificationsBeforeRetry,
        'an unchanged refresh must retry the pending WinINet notification'
      );
      assert.equal(
        JSON.parse(readFileSync(pendingStatePath, 'utf8')).continuationNotifyPending,
        undefined,
        'the retry marker must only clear after notification succeeds'
      );
      await manager.disable('continuation-notify-retry-smoke');
    }, { pacPort: continuationEdgePort });
  } finally {
    await closeServer(continuationProxy.server);
  }

  const mixedPublicDns = await listenDnsARecords(['127.0.0.2', '116.62.51.154']);
  const mixedFakeIpDns = await listenDnsARecords(['127.0.0.3', '198.18.0.7']);
  const internalDns = await listenDnsA('127.0.0.1');
  const internalDnsUpstream = await listenLoopback();
  const internalDnsEdgePort = await unusedLoopbackPort();
  try {
    const dnsServers = [mixedPublicDns, mixedFakeIpDns, internalDns]
      .map((server) => `127.0.0.1:${server.port}`);
    await withManager('browser-internal-dns-authority', tunOwner, async (manager) => {
      await manager.apply(browserDnsPolicy(internalDnsEdgePort, dnsServers));
      const browser = await manager.probeBrowserAccess({
        host: 'internal.example.test',
        port: internalDnsUpstream.port
      });
      assert.equal(
        browser.ready,
        true,
        `the local edge must reject mixed private+public/fake-IP answers and continue to Internal DNS: ${JSON.stringify(browser)}`
      );

      const resolver = new Resolver();
      resolver.setServers([`127.0.0.1:${internalDnsEdgePort}`]);
      assert.deepEqual(
        await resolver.resolve4('internal.example.test'),
        ['127.0.0.1'],
        'the local DNS relay must return the later private/overlay answer'
      );
      assert.ok(
        mixedPublicDns.queries >= 2,
        'a resolver mixing private and public A records must be consulted and rejected as a whole'
      );
      assert.ok(
        mixedFakeIpDns.queries >= 2,
        'a resolver mixing private and Clash fake-IP A records must be consulted and rejected as a whole'
      );
      assert.ok(internalDns.queries >= 2, 'the Internal resolver must be reached after both rejected answers');
      await manager.disable('browser-internal-dns-authority-smoke');
    }, { pacPort: internalDnsEdgePort });
  } finally {
    await Promise.all([
      closeServer(mixedPublicDns.server),
      closeServer(mixedFakeIpDns.server),
      closeServer(internalDns.server),
      closeServer(internalDnsUpstream.server)
    ]);
  }

  const previousPac = await listenPac(`function FindProxyForURL(url, host) {
  if (host === 'direct.public.test') return 'DIRECT';
  return 'PROXY 127.0.0.1:7899; DIRECT';
}`);
  const wrappedBrowserUpstream = await listenLoopback();
  const wrappedEdgePort = await unusedLoopbackPort();
  try {
    const pacClash = {
      AutoConfigURL: { type: 'REG_SZ', value: previousPac.url },
      // Chromium gives automatic settings precedence when both PAC and manual
      // proxy fields are present. The continuation must therefore wrap PAC.
      ProxyEnable: { type: 'REG_DWORD', value: '1' },
      ProxyServer: { type: 'REG_SZ', value: '127.0.0.1:7899' },
      ProxyOverride: { type: 'REG_SZ', value: '<local>;pac.test' },
      AutoDetect: { type: 'REG_DWORD', value: '0' }
    };
    await withManager('browser-wrapped-pac', pacClash, async (manager) => {
      const applied = await manager.apply(browserPolicy(wrappedEdgePort, wrappedBrowserUpstream.port));
      assert.equal(applied.fallbackPacUrl, previousPac.url);
      const pac = await fetchText(applied.pacUrl);
      assert.equal(
        evaluatePac(pac, 'https://internal.example.test/', 'internal.example.test'),
        `PROXY 127.0.0.1:${wrappedEdgePort}`,
        'MX Internal routing must take precedence over the previous PAC'
      );
      assert.equal(
        evaluatePac(pac, 'https://direct.public.test/', 'direct.public.test'),
        'DIRECT',
        'the wrapped PAC must preserve a public DIRECT decision'
      );
      assert.equal(
        evaluatePac(pac, 'https://proxy.public.test/', 'proxy.public.test'),
        'PROXY 127.0.0.1:7899; DIRECT',
        'the wrapped PAC must preserve a public PROXY decision'
      );
      assert.equal(
        evaluatePac(pac, 'http://localhost:17891/oauth/feishu/callback', 'localhost'),
        'DIRECT',
        'the Feishu loopback callback must take precedence over the wrapped PAC'
      );
      previousPac.setSource(`function FindProxyForURL(url, host) {
  if (host === 'updated.public.test') return 'PROXY 127.0.0.1:7900; DIRECT';
  return 'DIRECT';
}`);
      const refreshed = await manager.refreshWindowsContinuation('pac-hot-update-smoke');
      assert.equal(refreshed.changed, true);
      const refreshedPac = await fetchText(applied.pacUrl);
      assert.equal(
        evaluatePac(refreshedPac, 'https://updated.public.test/', 'updated.public.test'),
        'PROXY 127.0.0.1:7900; DIRECT',
        'a PAC update at the same external URL must refresh the local wrapper'
      );
      const browser = await manager.probeBrowserAccess({
        host: 'internal.example.test',
        port: wrappedBrowserUpstream.port
      });
      assert.equal(browser.ready, true, JSON.stringify(browser));
      await manager.disable('browser-wrapped-pac-smoke');
      assert.deepEqual(readRegistry(), pacClash, 'disconnect must restore the previous PAC owner');
    }, { pacPort: wrappedEdgePort });
  } finally {
    await Promise.all([
      closeServer(previousPac.server),
      closeServer(wrappedBrowserUpstream.server)
    ]);
  }

  const disconnectPac = await listenPac("function FindProxyForURL() { return 'DIRECT'; }");
  const disconnectStaticProxy = await listenLoopback();
  const disconnectEdgePort = await unusedLoopbackPort();
  const disconnectOwner = {
    AutoConfigURL: { type: 'REG_SZ', value: disconnectPac.url },
    ProxyEnable: { type: 'REG_DWORD', value: '1' },
    ProxyServer: { type: 'REG_SZ', value: `127.0.0.1:${disconnectStaticProxy.port}` },
    ProxyOverride: { type: 'REG_SZ', value: '<local>;disconnect.test' },
    AutoDetect: { type: 'REG_DWORD', value: '0' }
  };
  await withManager('disconnect-dead-owner', disconnectOwner, async (manager) => {
    await manager.apply(browserPolicy(disconnectEdgePort, 443));
    await Promise.all([
      closeServer(disconnectPac.server),
      closeServer(disconnectStaticProxy.server)
    ]);
    const restored = await manager.disable('disconnect-dead-owner-smoke');
    assert.equal(restored.stalePreviousPacSkipped, true);
    assert.equal(restored.stalePreviousProxySkipped, true);
    const expected = { ...disconnectOwner };
    delete expected.AutoConfigURL;
    assert.deepEqual(
      readRegistry(),
      expected,
      'normal disconnect must not re-enable a Clash PAC/static listener that stopped during the connection'
    );
  }, { pacPort: disconnectEdgePort });

  const unreadablePacPort = await unusedLoopbackPort();
  const unreadablePacOwner = {
    AutoConfigURL: { type: 'REG_SZ', value: `http://127.0.0.1:${unreadablePacPort}/proxy.pac` },
    ProxyEnable: { type: 'REG_DWORD', value: '0' },
    AutoDetect: { type: 'REG_DWORD', value: '0' }
  };
  const unusedEdgePort = await unusedLoopbackPort();
  const stalePacWarnings = [];
  await withManager('browser-unreadable-pac', unreadablePacOwner, async (manager, userDataDir) => {
    const applied = await manager.apply(browserPolicy(unusedEdgePort, 443));
    assert.equal(applied.applied, true);
    assert.equal(applied.fallbackPacUrl, null);
    assert.equal(
      readRegistry().AutoConfigURL?.value,
      `http://127.0.0.1:${unusedEdgePort}/proxy.pac`,
      'a dead loopback PAC must not block the MX-H2I browser path'
    );
    const pac = await fetchText(applied.pacUrl);
    assert.equal(
      evaluatePac(pac, 'https://public.example.test/', 'public.example.test'),
      'DIRECT',
      'public traffic must use DIRECT when the only previous PAC owner is already dead'
    );
    await manager.disable('browser-unreadable-pac-smoke');
    const expected = { ...unreadablePacOwner };
    delete expected.AutoConfigURL;
    assert.deepEqual(
      readRegistry(),
      expected,
      'disconnect must not restore the dead loopback PAC'
    );
    assert.equal(
      existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
      false
    );
  }, {
    pacPort: unusedEdgePort,
    log: { warn(message) { stalePacWarnings.push(String(message)); } }
  });
  assert.ok(
    stalePacWarnings.some((message) => message.includes('ignored stale Windows PAC')),
    'dead PAC recovery must remain visible in diagnostics'
  );

  const delayedPacPort = await unusedLoopbackPort();
  const delayedPacUrl = `http://127.0.0.1:${delayedPacPort}/proxy.pac`;
  const delayedPacOwner = {
    AutoConfigURL: { type: 'REG_SZ', value: delayedPacUrl },
    ProxyEnable: { type: 'REG_DWORD', value: '0' },
    AutoDetect: { type: 'REG_DWORD', value: '0' }
  };
  const delayedPacStart = new Promise((resolve, reject) => {
    setTimeout(() => {
      void listenPac("function FindProxyForURL() { return 'DIRECT'; }", null, delayedPacPort)
        .then(resolve, reject);
    }, 650);
  });
  let delayedPac = null;
  try {
    await withManager('browser-delayed-live-pac', delayedPacOwner, async (manager) => {
      const applied = await manager.apply(browserPolicy(unusedEdgePort, 443));
      assert.equal(
        applied.fallbackPacUrl,
        delayedPacUrl,
        'a previous PAC that starts during the Windows login grace period must be preserved'
      );
      await manager.disable('browser-delayed-live-pac-smoke');
      assert.deepEqual(
        readRegistry(),
        delayedPacOwner,
        'disconnect must restore a previous PAC that became live during startup'
      );
    }, { pacPort: unusedEdgePort });
    delayedPac = await delayedPacStart;
  } finally {
    delayedPac ||= await delayedPacStart.catch(() => null);
    if (delayedPac?.server) await closeServer(delayedPac.server);
  }

  const invalidPac = await listenPac('var proxyConfigurationIsInvalid = true;');
  const invalidPacOwner = {
    AutoConfigURL: { type: 'REG_SZ', value: invalidPac.url },
    ProxyEnable: { type: 'REG_DWORD', value: '0' },
    AutoDetect: { type: 'REG_DWORD', value: '0' }
  };
  try {
    await withManager('browser-invalid-live-pac', invalidPacOwner, async (manager, userDataDir) => {
      await assert.rejects(
        manager.apply(browserPolicy(unusedEdgePort, 443)),
        /does not define FindProxyForURL/,
        'a reachable but invalid previous PAC must still fail closed'
      );
      assert.deepEqual(readRegistry(), invalidPacOwner);
      assert.equal(
        existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
        false,
        'failed live PAC coordination must not leave pending product state'
      );
    }, { pacPort: unusedEdgePort });
  } finally {
    await closeServer(invalidPac.server);
  }

  await withManager('fallback', oldClash, async (manager) => {
    const direct = await manager.apply(policy());
    const directPac = renderElectronLauncherPacScript({
      domains: ['internal.example.test'],
      matchMode: 'direct'
    });
    assert.equal(direct.fallbackProxy, null, 'Windows must not inherit the old static proxy');
    assert.doesNotMatch(directPac, /127\.0\.0\.1:7890/, 'unmatched Windows traffic must remain DIRECT');
    assert.match(
      directPac,
      /\n  return "DIRECT";\n}\n\nfunction isIpv4Literal/,
      'the generated PAC must return DIRECT for unmatched Windows traffic'
    );

    const explicit = await manager.apply(policy({ fallbackProxy: '127.0.0.1:7890' }));
    const explicitPac = renderElectronLauncherPacScript({
      domains: ['internal.example.test'],
      matchMode: 'direct',
      fallbackProxy: {
        address: '127.0.0.1:7890',
        directive: 'PROXY 127.0.0.1:7890'
      }
    });
    assert.equal(explicit.fallbackProxy, 'PROXY 127.0.0.1:7890');
    assert.match(
      explicitPac,
      /return "PROXY 127\.0\.0\.1:7890; DIRECT";/,
      'an explicit fallbackProxy must still chain the proxy'
    );
    await manager.disable('fallback-smoke');
  });

  await withManager('reapply', oldClash, async (manager) => {
    await manager.apply(policy());
    writeRegistry(newClash);
    await manager.apply(policy());
    await manager.disable('reapply-smoke');
    assert.deepEqual(
      readRegistry(),
      newClash,
      'reapply must restore the external proxy snapshot that replaced this product PAC'
    );
  });

  await withManager('restore-cas', oldClash, async (manager) => {
    await manager.apply(policy());
    writeRegistry(newClash);
    await manager.disable('restore-cas-smoke');
    assert.deepEqual(
      readRegistry(),
      newClash,
      'restore must not write registry values after an external PAC takes ownership'
    );
  });

  await withManager('static-proxy-takeover', tunOwner, async (manager) => {
    await manager.apply(policy());
    const staticProxyTakeover = {
      ...newClash,
      AutoConfigURL: { type: 'REG_SZ', value: productPacUrl }
    };
    writeRegistry(staticProxyTakeover);

    const verified = await manager.statusVerified();
    assert.equal(
      verified.applied,
      true,
      'manual ProxyEnable changes must not invalidate an MX-owned AutoConfigURL'
    );
    assert.deepEqual(verified.actual?.pac, {
      applied: true,
      platform: 'win32',
      pacUrl: productPacUrl,
      autoConfigUrl: {
        exists: true,
        name: 'AutoConfigURL',
        type: 'REG_SZ',
        value: productPacUrl
      },
      proxyEnable: {
        exists: true,
        name: 'ProxyEnable',
        type: 'REG_DWORD',
        value: '1'
      },
      proxyServer: {
        exists: true,
        name: 'ProxyServer',
        type: 'REG_SZ',
        value: '127.0.0.1:7891'
      },
      proxyOverride: {
        exists: true,
        name: 'ProxyOverride',
        type: 'REG_SZ',
        value: '<local>;new.test'
      },
      autoDetect: {
        exists: true,
        name: 'AutoDetect',
        type: 'REG_DWORD',
        value: '0'
      }
    });

    await manager.disable('static-proxy-takeover-smoke');
    const expected = { ...newClash };
    delete expected.AutoConfigURL;
    assert.deepEqual(
      readRegistry(),
      expected,
      'restore must only remove its PAC and preserve the active Clash static proxy'
    );
  });

  await withManager('static-proxy-reapply', tunOwner, async (manager) => {
    await manager.apply(policy());
    const staticProxyTakeover = {
      ...newClash,
      AutoConfigURL: { type: 'REG_SZ', value: productPacUrl }
    };
    writeRegistry(staticProxyTakeover);
    await manager.apply(policy());
    await manager.disable('static-proxy-reapply-smoke');
    const expected = { ...newClash };
    delete expected.AutoConfigURL;
    assert.deepEqual(
      readRegistry(),
      expected,
      'manual reapply must snapshot the live Clash static proxy without retaining this product PAC'
    );
  });

  await withManager('foreign-fields-change', oldClash, async (manager) => {
    await manager.apply(policy());
    const whileApplied = readRegistry();
    writeRegistry({
      ...whileApplied,
      ProxyServer: newClash.ProxyServer,
      ProxyOverride: newClash.ProxyOverride,
      AutoDetect: { type: 'REG_DWORD', value: '1' }
    });
    await manager.disable('foreign-fields-change-smoke');
    assert.deepEqual(
      readRegistry(),
      {
        ...oldClash,
        ProxyServer: newClash.ProxyServer,
        ProxyOverride: newClash.ProxyOverride,
        AutoDetect: { type: 'REG_DWORD', value: '1' }
      },
      'restore must not roll back WinINet fields that this product never wrote'
    );
  });

  const deadPacPort = await unusedLoopbackPort();
  const deadProxyPort = await unusedLoopbackPort();
  const deadLoopback = windowsProxyState(
    `http://127.0.0.1:${deadPacPort}/old.pac`,
    `127.0.0.1:${deadProxyPort}`,
    '<local>;dead.test'
  );
  await withStaleManager('stale-dead-loopback', deadLoopback, async (manager) => {
    const restored = await manager.restoreStale('stale-dead-loopback-smoke');
    assert.equal(restored.stalePreviousPacSkipped, true);
    assert.equal(restored.stalePreviousProxySkipped, true);
    const expected = { ...deadLoopback };
    delete expected.AutoConfigURL;
    assert.deepEqual(
      readRegistry(),
      expected,
      'stale restore must not re-enable dead loopback PAC or static-proxy listeners'
    );
  });

  const livePac = await listenLoopback();
  const liveProxy = await listenLoopback();
  try {
    const liveLoopback = windowsProxyState(
      `http://127.0.0.1:${livePac.port}/old.pac`,
      `127.0.0.1:${liveProxy.port}`,
      '<local>;live.test'
    );
    await withStaleManager('stale-live-loopback', liveLoopback, async (manager) => {
      const restored = await manager.restoreStale('stale-live-loopback-smoke');
      assert.equal(restored.stalePreviousPacSkipped, false);
      assert.equal(restored.stalePreviousProxySkipped, false);
      assert.deepEqual(
        readRegistry(),
        liveLoopback,
        'stale restore must preserve reachable loopback PAC and static-proxy listeners'
      );
    });
  } finally {
    await Promise.all([closeServer(livePac.server), closeServer(liveProxy.server)]);
  }

  await withStaleManager('stale-query-failure', oldClash, async (manager, userDataDir) => {
    process.env.MX_TEST_REG_QUERY_FAILURE = 'all';
    try {
      await assert.rejects(
        manager.restoreStale('stale-query-failure-smoke'),
        /Access is denied/,
        'an unreadable registry must not be treated as an absent PAC owner'
      );
    } finally {
      delete process.env.MX_TEST_REG_QUERY_FAILURE;
    }
    assert.equal(readRegistry().AutoConfigURL?.value, productPacUrl);
    assert.equal(
      existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
      true,
      'failed stale restore must retain state for a later retry'
    );
  });

  await withStaleManager('stale-proxy-server-query-failure', oldClash, async (manager, userDataDir) => {
    process.env.MX_TEST_REG_QUERY_FAILURE = 'ProxyServer';
    try {
      await assert.rejects(
        manager.restoreStale('stale-proxy-server-query-failure-smoke'),
        /Access is denied/,
        'an unreadable current ProxyServer must abort stale restore'
      );
    } finally {
      delete process.env.MX_TEST_REG_QUERY_FAILURE;
    }
    assert.equal(readRegistry().AutoConfigURL?.value, productPacUrl);
    assert.equal(
      existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
      true,
      'ProxyServer read failure must retain state and the local PAC for retry'
    );
  });

  await withManager('add-write-denied', oldClash, async (manager, userDataDir) => {
    process.env.MX_TEST_REG_WRITE_FAILURE = 'add-before';
    try {
      await assert.rejects(
        manager.apply(policy()),
        /Access is denied/,
        'a denied registry add must fail when read-back does not match'
      );
    } finally {
      delete process.env.MX_TEST_REG_WRITE_FAILURE;
    }
    assert.deepEqual(readRegistry(), oldClash);
    assert.equal(
      existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
      false,
      'a denied registry add with a successful rollback must clear pending state'
    );
  });

  await withManager('proxy-notify-failure', oldClash, async (manager, userDataDir) => {
    process.env.MX_TEST_PROXY_NOTIFY_FAILURE = '1';
    try {
      await assert.rejects(
        manager.apply(policy()),
        /InternetSetOption failed/,
        'a failed WinINet change notification must fail closed'
      );
    } finally {
      delete process.env.MX_TEST_PROXY_NOTIFY_FAILURE;
    }
    assert.deepEqual(
      readRegistry(),
      oldClash,
      'a failed WinINet notification must roll the registry back to its previous owner'
    );
    assert.equal(
      existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
      true,
      'a failed WinINet notification during both apply and rollback must retain state for repair'
    );
    await manager.disable('proxy-notify-failure-repair');
    assert.equal(existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')), false);
  });

  await withManager('add-committed-error', oldClash, async (manager) => {
    process.env.MX_TEST_REG_WRITE_FAILURE = 'add-after';
    try {
      const applied = await manager.apply(policy());
      assert.equal(applied.applied, true);
      assert.equal(readRegistry().AutoConfigURL?.value, productPacUrl);
      assert.equal(readRegistry().ProxyEnable?.value, '1');
    } finally {
      delete process.env.MX_TEST_REG_WRITE_FAILURE;
    }
    await manager.disable('add-committed-error-smoke');
  });

  const noProxyOwner = {
    ProxyServer: { type: 'REG_SZ', value: '127.0.0.1:7890' },
    ProxyOverride: { type: 'REG_SZ', value: '<local>;none.test' },
    AutoDetect: { type: 'REG_DWORD', value: '0' }
  };
  const orphanPacPort = await unusedLoopbackPort();
  const orphanRegistry = {
    ...noProxyOwner,
    AutoConfigURL: { type: 'REG_SZ', value: `http://127.0.0.1:${orphanPacPort}/proxy.pac` },
    ProxyEnable: { type: 'REG_DWORD', value: '0' }
  };
  await withManager('corrupt-state-orphan-pac', orphanRegistry, async (manager, userDataDir) => {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json'), '{corrupt');
    const restored = await manager.restoreStale('corrupt-state-orphan-pac-smoke');
    assert.equal(restored.actual?.orphanWindowsPac, true);
    const expected = { ...orphanRegistry };
    delete expected.AutoConfigURL;
    assert.deepEqual(
      readRegistry(),
      expected,
      'startup must remove a dead product PAC even when its state file is corrupt'
    );
  }, { pacPort: orphanPacPort });

  await withStaleManager('delete-write-denied', noProxyOwner, async (manager, userDataDir) => {
    process.env.MX_TEST_REG_WRITE_FAILURE = 'delete-before';
    try {
      await assert.rejects(
        manager.restoreStale('delete-write-denied-smoke'),
        /Access is denied/,
        'a denied registry delete must fail when read-back still finds the PAC'
      );
    } finally {
      delete process.env.MX_TEST_REG_WRITE_FAILURE;
    }
    assert.equal(readRegistry().AutoConfigURL?.value, productPacUrl);
    assert.equal(
      existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
      true,
      'a denied registry delete must retain stale state for repair'
    );
  });

  await withStaleManager('delete-committed-error', noProxyOwner, async (manager, userDataDir) => {
    process.env.MX_TEST_REG_WRITE_FAILURE = 'delete-after';
    let restored;
    try {
      restored = await manager.restoreStale('delete-committed-error-smoke');
    } finally {
      delete process.env.MX_TEST_REG_WRITE_FAILURE;
    }
    assert.equal(restored.restored, true);
    assert.equal(readRegistry().AutoConfigURL, undefined);
    assert.equal(readRegistry().ProxyEnable, undefined);
    assert.equal(
      existsSync(join(userDataDir, 'electron-launcher-system-domain-proxy.json')),
      false,
      'a delete that committed before its error may complete stale restore'
    );
  });

  console.log(
    'Windows system-domain-proxy smoke passed: current-user owner gate, browser CONNECT, mixed-answer DNS rejection, pending notification retry, Clash continuation, apply/restore CAS, and stale recovery.'
  );
} finally {
  rmSync(testDir, { recursive: true, force: true });
}

function policy(extra = {}) {
  return {
    enabled: true,
    domains: ['internal.example.test'],
    pacUrl: productPacUrl,
    matchMode: 'direct',
    systemResolver: 'off',
    ...extra
  };
}

function nonexistentPid() {
  for (const pid of [999999, 888888, 777777, 666666]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return pid;
    }
  }
  throw new Error('Could not find a deterministic non-existent PID for the gate recovery smoke.');
}

function readFileNames(directoryPath) {
  return existsSync(directoryPath) ? readdirSync(directoryPath).sort() : [];
}

function startGateRaceChild({ moduleUrl, userDataDir, pacUrl, releasePath }) {
  const source = `
const [moduleUrl, userDataDir, pacUrl, releasePath] = process.argv.slice(1);
const { existsSync } = await import('node:fs');
Object.defineProperty(process, 'platform', { value: 'win32' });
await import(process.env.MX_TEST_WINDOWS_COMMAND_LOADER);
const { createElectronLauncherSystemDomainProxy } = await import(moduleUrl);
const manager = createElectronLauncherSystemDomainProxy({
  userDataDir,
  log: { warn() {} }
});
try {
  await manager.apply({
    enabled: true,
    domains: ['internal.example.test'],
    pacUrl,
    matchMode: 'direct',
    systemResolver: 'off'
  });
  process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, pacUrl }) + '\\n');
  while (!existsSync(releasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await manager.disable('gate-race-release');
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    pid: process.pid,
    error: error instanceof Error ? error.message : String(error)
  }) + '\\n');
} finally {
  await manager.close();
}
`;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    source,
    moduleUrl,
    userDataDir,
    pacUrl,
    releasePath
  ], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let outcomeSettled = false;
  let resolveOutcome;
  let rejectOutcome;
  const outcome = new Promise((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const newline = stdout.indexOf('\n');
    if (newline < 0 || outcomeSettled) return;
    outcomeSettled = true;
    try {
      resolveOutcome(JSON.parse(stdout.slice(0, newline)));
    } catch (error) {
      rejectOutcome(error);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!outcomeSettled) {
        outcomeSettled = true;
        rejectOutcome(new Error(`gate race child exited before reporting: code=${code} signal=${signal || 'none'} ${stderr}`));
      }
      if (code === 0) resolve();
      else reject(new Error(`gate race child failed: code=${code} signal=${signal || 'none'} ${stderr}`));
    });
  });
  return { outcome, exit };
}

function browserPolicy(edgePort, targetPort) {
  return {
    enabled: true,
    domains: ['internal.example.test'],
    proxy: `127.0.0.1:${edgePort}`,
    pacPort: edgePort,
    matchMode: 'proxy',
    systemResolver: 'off',
    dnsFallbackTarget: '127.0.0.1',
    reverseProxyRoutes: [{
      host: 'internal.example.test',
      targetUrl: `https://127.0.0.1:${targetPort}`,
      tlsMode: 'passthrough',
      enabled: true
    }]
  };
}

function browserDnsPolicy(edgePort, dnsServers) {
  return {
    enabled: true,
    domains: ['internal.example.test'],
    proxy: `127.0.0.1:${edgePort}`,
    pacPort: edgePort,
    matchMode: 'proxy',
    systemResolver: 'off',
    dnsServers,
    dnsFallbackTarget: '10.88.88.88'
  };
}

function windowsProxyState(autoConfigUrl, proxyServer, proxyOverride) {
  return {
    AutoConfigURL: { type: 'REG_SZ', value: autoConfigUrl },
    ProxyEnable: { type: 'REG_DWORD', value: '1' },
    ProxyServer: { type: 'REG_SZ', value: proxyServer },
    ProxyOverride: { type: 'REG_SZ', value: proxyOverride },
    AutoDetect: { type: 'REG_DWORD', value: '0' }
  };
}

async function withManager(name, initialRegistry, run, options = {}) {
  writeRegistry(initialRegistry);
  const manager = createElectronLauncherSystemDomainProxy({
    userDataDir: join(testDir, name),
    log: { warn() {} },
    ...options
  });
  try {
    await run(manager, join(testDir, name));
  } finally {
    delete process.env.MX_TEST_REG_WRITE_FAILURE;
    delete process.env.MX_TEST_PROXY_NOTIFY_FAILURE;
    await manager.close();
  }
}

async function withStaleManager(name, initialRegistry, run) {
  const userDataDir = join(testDir, name);
  writeRegistry(initialRegistry);
  const first = createElectronLauncherSystemDomainProxy({
    userDataDir,
    log: { warn() {} }
  });
  await first.apply(policy());
  await first.close();

  const restarted = createElectronLauncherSystemDomainProxy({
    userDataDir,
    log: { warn() {} }
  });
  try {
    await run(restarted, userDataDir);
  } finally {
    delete process.env.MX_TEST_REG_QUERY_FAILURE;
    delete process.env.MX_TEST_REG_WRITE_FAILURE;
    await restarted.close();
  }
}

async function listenPac(source, onRequest = null, port = 0) {
  let currentSource = source;
  const server = createHttpServer((_req, res) => {
    if (onRequest) onRequest();
    res.writeHead(200, {
      'Content-Type': 'application/x-ns-proxy-autoconfig',
      'Content-Length': String(Buffer.byteLength(currentSource, 'utf8'))
    });
    res.end(currentSource);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/proxy.pac`,
    setSource(nextSource) {
      currentSource = String(nextSource);
    }
  };
}

async function listenLoopback() {
  const server = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

async function listenDnsA(address) {
  return listenDnsARecords([address]);
}

async function listenDnsARecords(addresses) {
  let queries = 0;
  const server = createSocket('udp4');
  server.on('message', (query, remote) => {
    queries += 1;
    const response = dnsARecordsResponse(query, addresses);
    server.send(response, remote.port, remote.address);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.bind(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = server.address();
  assert.ok(bound && typeof bound === 'object');
  return {
    server,
    port: bound.port,
    get queries() {
      return queries;
    }
  };
}

function dnsARecordsResponse(query, addresses) {
  const normalized = addresses.map(String);
  assert.ok(normalized.length > 0);
  const first = buildElectronLauncherDnsRelayFallbackResponse(query, normalized[0]);
  if (normalized.length === 1) return first;
  const extra = Buffer.alloc((normalized.length - 1) * 16);
  let offset = 0;
  for (const address of normalized.slice(1)) {
    const octets = address.split('.').map(Number);
    assert.equal(octets.length, 4);
    extra.writeUInt16BE(0xc00c, offset);
    extra.writeUInt16BE(1, offset + 2);
    extra.writeUInt16BE(1, offset + 4);
    extra.writeUInt32BE(30, offset + 6);
    extra.writeUInt16BE(4, offset + 10);
    for (let index = 0; index < octets.length; index += 1) {
      extra[offset + 12 + index] = octets[index];
    }
    offset += 16;
  }
  const response = Buffer.concat([first, extra]);
  response.writeUInt16BE(normalized.length, 6);
  return response;
}

async function fetchText(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

function evaluatePac(source, url, host) {
  const context = {
    isInNet() {
      return false;
    },
    shExpMatch(value, pattern) {
      const expression = String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      return new RegExp(`^${expression}$`).test(String(value));
    }
  };
  runInNewContext(source, context);
  assert.equal(typeof context.FindProxyForURL, 'function');
  return context.FindProxyForURL(url, host);
}

async function unusedLoopbackPort() {
  const listener = await listenLoopback();
  await closeServer(listener.server);
  return listener.port;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function writeRegistry(value) {
  writeFileSync(registryPath, JSON.stringify(value));
}

function readRegistry() {
  return JSON.parse(readFileSync(registryPath, 'utf8'));
}

function proxyNotificationCount() {
  if (!existsSync(notifyLogPath)) return 0;
  return readFileSync(notifyLogPath, 'utf8').split(/\r?\n/).filter(Boolean).length;
}

function writeExecutable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}
