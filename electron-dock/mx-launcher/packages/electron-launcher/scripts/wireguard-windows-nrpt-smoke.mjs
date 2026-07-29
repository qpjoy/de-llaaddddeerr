import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  launcherWindowsWireGuardCleanupReady,
  launcherWindowsWireGuardTunnelCleanupReady,
  validateLauncherWindowsNrptDesiredState
} from '../dist/wireguard.js';

const wireguardBundle = readFileSync(
  fileURLToPath(new URL('../dist/wireguard.js', import.meta.url)),
  'utf8'
);
assert.doesNotMatch(
  wireguardBundle,
  /@\{;/,
  'Windows PowerShell route probe must not collapse hashtable literals into "@{;"'
);

const baseStatus = {
  supported: true,
  configured: true,
  ready: true,
  source: 'live-powershell',
  state: 'ready',
  tunnelName: 'mx-h2i',
  comment: 'MX-H2I / QPJoy MX-H2I mx-h2i',
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  globalReady: true,
  globalRestorePending: false,
  pendingGlobalOwners: ['MX-H2I / QPJoy MX-H2I mx-h2i'],
  totalOwnedRuleCount: 2,
  unexpectedOwnedNamespaces: [],
  legacyMigrationAuthorized: false,
  legacyAmbiguousRuleCount: 0,
  legacyAmbiguousNamespaces: [],
  namespaces: [
    {
      namespace: 'mxinfo-inc.cn',
      expectedNameServers: ['10.88.88.88'],
      installedNameServers: ['10.88.88.88'],
      ownedRuleCount: 1,
      legacyAmbiguousRuleCount: 0,
      foreignOwners: [],
      ready: true
    },
    {
      namespace: '.mxinfo-inc.cn',
      expectedNameServers: ['10.88.88.88'],
      installedNameServers: ['10.88.88.88'],
      ownedRuleCount: 1,
      legacyAmbiguousRuleCount: 0,
      foreignOwners: [],
      ready: true
    }
  ],
  missingNamespaces: [],
  mismatchedNamespaces: [],
  error: null
};

const desired = {
  dnsDomains: ['mxinfo-inc.cn'],
  dnsServer: '10.88.88.88:53'
};
const ready = validateLauncherWindowsNrptDesiredState(baseStatus, desired);
assert.equal(ready.ready, true);
assert.equal(ready.profileDesiredStateMismatch, false);

const partialProfile = validateLauncherWindowsNrptDesiredState({
  ...baseStatus,
  namespaces: baseStatus.namespaces.slice(0, 1)
}, desired);
assert.equal(partialProfile.ready, false);
assert.equal(partialProfile.state, 'rules-missing');
assert.equal(partialProfile.profileMissingSplitDns, true);
assert.deepEqual(partialProfile.profileMissingNamespaces, ['.mxinfo-inc.cn']);

const staleDnsProfile = validateLauncherWindowsNrptDesiredState(baseStatus, {
  ...desired,
  dnsServer: '10.88.0.1'
});
assert.equal(staleDnsProfile.ready, false);
assert.equal(staleDnsProfile.state, 'name-server-mismatch');
assert.equal(staleDnsProfile.profileMissingSplitDns, true);
assert.deepEqual(
  staleDnsProfile.profileMismatchedNamespaces,
  ['mxinfo-inc.cn', '.mxinfo-inc.cn']
);

const stoppedButInstalled = {
  ok: true,
  active: false,
  serviceState: 'STOPPED',
  routes: [],
  ifconfig: null
};
assert.equal(
  launcherWindowsWireGuardTunnelCleanupReady(stoppedButInstalled),
  false,
  'a STOPPED but installed WireGuard service is not cleanup-ready'
);
assert.equal(
  launcherWindowsWireGuardTunnelCleanupReady({
    ...stoppedButInstalled,
    serviceState: null
  }),
  false,
  'an inconclusive service probe must not be treated as cleanup-ready'
);
assert.equal(
  launcherWindowsWireGuardTunnelCleanupReady({
    ...stoppedButInstalled,
    serviceState: 'NOT_FOUND'
  }),
  true,
  'an explicit service-not-found result is cleanup-ready'
);
assert.equal(
  launcherWindowsWireGuardTunnelCleanupReady({
    ...stoppedButInstalled,
    serviceState: null,
    routes: ['10.0.0.0/8']
  }),
  false,
  'remaining routes block cleanup when route evidence is available'
);
assert.equal(
  launcherWindowsWireGuardTunnelCleanupReady({
    ...stoppedButInstalled,
    serviceState: null,
    ifconfig: 'adapter still present'
  }),
  false,
  'a remaining interface blocks cleanup when interface evidence is available'
);

const absentTunnel = {
  ...stoppedButInstalled,
  serviceState: 'NOT_FOUND'
};
const cleanNrpt = {
  ...baseStatus,
  configured: false,
  ready: true,
  state: 'not-configured',
  globalRestorePending: false,
  pendingGlobalOwners: [],
  totalOwnedRuleCount: 0,
  unexpectedOwnedNamespaces: [],
  legacyAmbiguousRuleCount: 0,
  legacyAmbiguousNamespaces: [],
  namespaces: baseStatus.namespaces.map((namespace) => ({
    ...namespace,
    installedNameServers: [],
    ownedRuleCount: 0,
    legacyAmbiguousRuleCount: 0,
    ready: false
  })),
  missingNamespaces: baseStatus.namespaces.map((namespace) => namespace.namespace)
};
assert.equal(
  launcherWindowsWireGuardCleanupReady(absentTunnel, cleanNrpt),
  true,
  'an absent service plus zero owned/ambiguous NRPT state is cleanup-ready'
);
for (const dirtyNrpt of [
  { ...cleanNrpt, totalOwnedRuleCount: 1 },
  { ...cleanNrpt, unexpectedOwnedNamespaces: ['legacy.mxinfo-inc.cn'] },
  { ...cleanNrpt, legacyAmbiguousRuleCount: 1 },
  { ...cleanNrpt, globalRestorePending: true },
  { ...cleanNrpt, state: 'probe-failed' }
]) {
  assert.equal(
    launcherWindowsWireGuardCleanupReady(absentTunnel, dirtyNrpt),
    false,
    'owned, ambiguous, pending, or unreadable NRPT state must block cleanup'
  );
}

console.log('launcher Windows NRPT desired-state smoke passed');
