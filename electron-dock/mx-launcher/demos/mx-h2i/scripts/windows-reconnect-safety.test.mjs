import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS,
  retainedGuestRecoveryDecision,
  shouldRepairDarwinRetainedOwnership,
  wireGuardRecoveryGate,
  wireGuardRecoveryTurn
} = require('../src/network-recovery-policy.cjs');
const {
  postConnectDataPlaneReady,
  standaloneOwnershipReady,
  windowsBrowserFallbackState,
  windowsBrowserPromotionPrerequisitesReady,
  windowsLocalEdgePrerequisitesReady,
  windowsSplitDnsPathReady,
  windowsSystemDnsDataPlaneReady
} = require('../src/windows-network-readiness.cjs');

const clashTunDnsDegradedConnection = {
  health: {
    wireGuard: 'ready',
    internalApi: 'ready'
  },
  diagnostics: {
    windowsNrpt: { ready: true },
    windowsDnsResolution: {
      ready: false,
      addresses: ['116.62.51.154']
    },
    standaloneOwnershipRegistry: { ok: true }
  }
};
assert.equal(
  windowsLocalEdgePrerequisitesReady(clashTunDnsDegradedConnection),
  true,
  'WG, Internal API and NRPT are sufficient to start the Windows PAC/local edge'
);
assert.equal(
  windowsSystemDnsDataPlaneReady(clashTunDnsDegradedConnection),
  false,
  'a public or Clash fake-IP system DNS answer remains explicitly degraded'
);
assert.equal(
  standaloneOwnershipReady(clashTunDnsDegradedConnection),
  true,
  'the persisted cross-process ownership claim is still a hard readiness gate'
);
assert.equal(
  windowsBrowserPromotionPrerequisitesReady(clashTunDnsDegradedConnection),
  true,
  'browser fallback promotion requires both local-edge prerequisites and ownership'
);
assert.equal(
  windowsBrowserPromotionPrerequisitesReady({
    ...clashTunDnsDegradedConnection,
    diagnostics: {
      ...clashTunDnsDegradedConnection.diagnostics,
      standaloneOwnershipRegistry: { ok: false, error: 'ownership-conflict' }
    }
  }),
  false,
  'a verified PAC path must not bypass an MX-H2I/Luopan ownership conflict'
);
assert.equal(
  postConnectDataPlaneReady({
    platform: 'win32',
    wireGuardReady: false,
    connection: clashTunDnsDegradedConnection
  }),
  true,
  'Windows may continue to the PAC proof when only system DNS is degraded'
);
const ownershipConflictConnection = {
  ...clashTunDnsDegradedConnection,
  diagnostics: {
    ...clashTunDnsDegradedConnection.diagnostics,
    standaloneOwnershipRegistry: { ok: false, error: 'ownership-conflict' }
  }
};
assert.equal(
  postConnectDataPlaneReady({
    platform: 'win32',
    wireGuardReady: false,
    connection: ownershipConflictConnection
  }),
  false,
  'system-DNS fallback must not start or retain PAC when ownership is conflicted'
);
assert.deepEqual(
  windowsBrowserFallbackState({
    connection: clashTunDnsDegradedConnection,
    browserReady: true,
    connected: true
  }),
  {
    active: true,
    browserReady: true,
    systemDnsReady: false,
    nonPacProgramsReady: false,
    reason: 'system DNS did not resolve the Internal target; verified PAC/local edge carries browser traffic'
  },
  'Clash TUN may leave the verified browser path active while non-PAC DNS stays degraded'
);
assert.equal(
  windowsBrowserFallbackState({
    connection: {
      ...clashTunDnsDegradedConnection,
      diagnostics: {
        ...clashTunDnsDegradedConnection.diagnostics,
        windowsDnsResolution: { ready: true, addresses: ['10.88.88.88'] }
      }
    },
    browserReady: true,
    connected: true
  }).active,
  false,
  'switching away from Clash DNS must clear the fallback even when PAC status is unchanged'
);
assert.equal(
  windowsSplitDnsPathReady({
    nrptReady: true,
    systemDnsReady: false,
    browserReady: true
  }),
  true,
  'a verified PAC/local-edge browser path breaks the Clash TUN DNS deadlock'
);
assert.equal(
  windowsSplitDnsPathReady({
    nrptReady: true,
    systemDnsReady: false,
    browserReady: false
  }),
  false,
  'NRPT metadata alone must never be reported as a ready browser path'
);

assert.equal(
  wireGuardRecoveryGate({
    connectOperationCount: 1,
    foreground: true,
    lastFailureAt: Date.now()
  }),
  null,
  'the foreground reconnect may repair inside its own connect operation and bypass background cooldown'
);
assert.equal(
  wireGuardRecoveryGate({ connectOperationCount: 1, foreground: false }),
  'connect-in-flight',
  'background recovery must not race a foreground connect'
);
assert.equal(
  wireGuardRecoveryGate({ connectOperationCount: 2, foreground: true }),
  'connect-in-flight',
  'overlapping foreground connects must not both mutate WireGuard'
);
assert.equal(
  wireGuardRecoveryGate({
    foreground: false,
    lastFailureAt: 10_000,
    now: 10_001
  }),
  'failure-cooldown',
  'background recovery must retain the failure cooldown'
);
assert.equal(
  retainedGuestRecoveryDecision({ ready: true, liveWireGuardActive: true }),
  'recovered',
  'a fully ready live probe preserves the repaired connection'
);
assert.equal(
  retainedGuestRecoveryDecision({ ready: false, liveWireGuardActive: true }),
  'preserve',
  'a not-ready but live active tunnel is preserved for non-destructive repair'
);
assert.equal(
  retainedGuestRecoveryDecision({ ready: false, liveWireGuardActive: false }),
  'fresh-connect',
  'a fresh live inactive result must override stale cached active state'
);
const retainedDataPlaneProof = {
  ownershipReady: false,
  tunnelReady: true,
  routeReady: true,
  internalApiReady: true,
  splitDnsReady: true
};
assert.equal(
  shouldRepairDarwinRetainedOwnership({
    ...retainedDataPlaneProof,
    platform: 'darwin'
  }),
  true,
  'macOS upgrades must reconstruct a missing ownership claim from a fully proven retained tunnel'
);
assert.equal(
  shouldRepairDarwinRetainedOwnership({
    ...retainedDataPlaneProof,
    platform: 'win32'
  }),
  false,
  'macOS retained-ownership migration must not alter the Windows recovery path'
);
assert.equal(
  shouldRepairDarwinRetainedOwnership({
    ...retainedDataPlaneProof,
    platform: 'darwin',
    routeReady: false
  }),
  false,
  'a retained tunnel must not claim ownership without complete route and Internal API proof'
);
assert.ok(
  DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS > 90_000,
  'the client must outlive the server default SSH connect plus execution timeout'
);
let finishBackgroundRecovery;
const backgroundRecovery = new Promise((resolve) => {
  finishBackgroundRecovery = resolve;
});
const reusedTurn = await wireGuardRecoveryTurn(backgroundRecovery, false);
assert.equal(reusedTurn.action, 'reuse');
assert.equal(reusedTurn.recovery, backgroundRecovery);
let foregroundTurnCompleted = false;
const foregroundTurn = wireGuardRecoveryTurn(backgroundRecovery, true).then((turn) => {
  foregroundTurnCompleted = true;
  return turn;
});
await Promise.resolve();
assert.equal(
  foregroundTurnCompleted,
  false,
  'foreground recovery must wait while the background recovery is pending'
);
finishBackgroundRecovery();
const nextTurn = await foregroundTurn;
assert.deepEqual(
  nextTurn,
  { action: 'start', waited: true, recovery: null },
  'foreground recovery must receive a fresh turn after the background recovery settles'
);

const source = readFileSync(
  fileURLToPath(new URL('../src/main.cjs', import.meta.url)),
  'utf8'
);
assert.match(
  source,
  /shouldRepairDarwinRetainedOwnership\(\{[\s\S]*?upsertStandaloneOwnershipForRoutePlan\([\s\S]*?'darwin-retained-data-plane-recovery'/,
  'a proven retained macOS tunnel must atomically reconstruct its ownership claim'
);
assert.match(
  source,
  /async function syncDomesticPeerForLease\([\s\S]*?timeoutMs: DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS/,
  'Domestic peer sync must use the deadline that covers the server SSH operation'
);
assert.match(
  source,
  /owners:\s*Array\.isArray\(registry\.owners\)[\s\S]*?owner\?\.ownerId/,
  'ownership diagnostics must preserve owner objects instead of stringifying them'
);
assert.match(
  source,
  /function systemDomainProxyRuntimeEligible\(\)[\s\S]*?windowsBrowserPromotionPrerequisitesReady\(connection\)/,
  'the PAC/local-edge runtime must not bypass the cross-process ownership gate'
);
assert.match(
  source,
  /browserFallbackChanged[\s\S]*?reason !== 'interval'[\s\S]*?\|\| browserFallbackChanged/,
  'an unchanged PAC signature must still persist Clash TUN system-DNS fallback transitions'
);
const handlerStart = source.indexOf("ipcMain.handle('mx-h2i:connect-guest'");
const handlerEnd = source.indexOf("ipcMain.handle('mx-h2i:login-employee'", handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'guest connect handler must exist');

const handler = source.slice(handlerStart, handlerEnd);
assert.match(
  handler,
  /retainedConnectionWasProbed = guestProbe\.ready;/,
  'a failed live probe must remain eligible for retained-tunnel repair'
);
assert.match(
  source,
  /recoverWireGuardForRuntime\(reason, \{[\s\S]*?allowPrivileged: options\.allowPrivileged === true,[\s\S]*?foreground: true[\s\S]*?\}\);/,
  'pre-bootstrap retained repair must identify itself as the foreground connect operation'
);
assert.match(
  source,
  /if \(wireGuardRecoveryInFlight\) \{[\s\S]*?wireGuardRecoveryTurn\([\s\S]*?if \(recoveryTurn\.action === 'reuse'\) return recoveryTurn\.recovery;[\s\S]*?recoveryGate = currentRecoveryGate\(\);/,
  'foreground repair must wait for a background probe and then start its own privileged recovery'
);
assert.match(
  handler,
  /visit-connect-recovered-guard',[\s\S]*allowRecoverableState: true/,
  'reconnect must refresh live tunnel state after retained repair'
);
assert.match(
  handler,
  /retainedRecovery\?\.authorizationCanceled === true[\s\S]*reason: 'authorization-canceled'[\s\S]*return visibleRuntime\(\);/,
  'canceling retained repair must return without a second UAC attempt'
);

const recoveryIndex = handler.indexOf("recoverRetainedWireGuardBeforeBootstrap('guest-pre-bootstrap'");
const preserveIndex = handler.indexOf("reason: 'retained-tunnel-repair-pending'");
const freshConnectIndex = handler.indexOf("setConnecting('guest')");
assert.ok(recoveryIndex >= 0, 'guest reconnect must attempt retained repair');
assert.ok(
  recoveryIndex < preserveIndex && preserveIndex < freshConnectIndex,
  'active-tunnel preservation must run after repair but before fresh connect/restart'
);
assert.match(
  handler.slice(recoveryIndex, freshConnectIndex),
  /liveWireGuardActive: recoveredGuestProbe\?\.result\?\.wireGuard\?\.active === true[\s\S]*recoveredGuestDecision === 'preserve'[\s\S]*reason: 'retained-tunnel-repair-pending'[\s\S]*return visibleRuntime\(\);/,
  'only a fresh live active result may preserve a not-ready tunnel instead of restarting it'
);

assert.match(
  source,
  /Resolve-DnsName -Name \$name -Server \$server -Type A -DnsOnly -NoHostsFile -ErrorAction Stop/,
  'Windows split-DNS diagnostics must query the Internal DNS server directly'
);
assert.match(
  source,
  /Resolve-DnsName -Name \$name -Type A -DnsOnly -NoHostsFile -ErrorAction Stop/,
  'Windows split-DNS diagnostics must also exercise the default NRPT-aware resolver'
);
assert.match(
  source,
  /const \[directDns, nrpt\] = await Promise\.all\(\[/,
  'direct DNS and default NRPT resolution must run independently in parallel'
);
assert.match(
  source,
  /async function probeWindowsResolveDnsNameLayer\(input\)[\s\S]*?\{ timeoutMs: 3500 \}/,
  'each Windows DNS proof layer must have its own bounded PowerShell timeout'
);
assert.doesNotMatch(
  source,
  /\$directDns = [\s\S]*?\$nrpt = [\s\S]*?ConvertTo-Json/,
  'a timeout in the default resolver must not discard a completed direct-DNS result'
);
assert.match(
  source,
  /proofLayers:\s*await collectWindowsDnsProofLayers\([\s\S]*?directDns[\s\S]*?nrpt[\s\S]*?nodeGetaddrinfo/,
  'Windows split-DNS proof must distinguish direct DNS, NRPT and Node getaddrinfo layers'
);
assert.match(
  source,
  /ready:\s*windowsNrptReadyForConnection\(windowsNrpt\)\s*&&\s*result\?\.ok === true/,
  'direct DNS success alone must not lower the existing NRPT plus Node readiness gate'
);
assert.doesNotMatch(
  source,
  /Get-DnsClient(?:NrptGlobal|GlobalSetting)\s*\|\s*Select-Object\s+\*/,
  'the Windows diagnostic export must not serialize unbounded CIM metadata'
);
assert.match(
  source,
  /Get-DnsClientNrptGlobal \| Select-Object -Property EnableDAForAllNetworks,QueryPolicy,SecureNameQueryFallback -First 1/,
  'the Windows diagnostic export must select only the NRPT global fields it uses'
);
assert.match(
  source,
  /Get-DnsClientGlobalSetting \| Select-Object -Property SuffixSearchList,UseDevolution,DevolutionLevel -First 1/,
  'the Windows diagnostic export must select only bounded DNS global fields'
);
assert.match(
  source,
  /\$result \| ConvertTo-Json -Depth 5 -Compress/,
  'the Windows diagnostic export must emit bounded compact JSON'
);

console.log('Windows retained-tunnel reconnect safety tests passed');
