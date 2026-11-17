import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { normalizeUiEntryMode, selectUiEntryMode } = require('../src/ui-entry-policy.cjs');
const source = await readFile(new URL('../src/main-runtime.cjs', import.meta.url), 'utf8');
const mincaveWindow = { bounds: { mincave: { x: -1200, y: 80, width: 1120, height: 760 } } };
const selectExisting = (persistedRuntime, requestedMode) => selectUiEntryMode({
  persistedRuntime, requestedMode
});

function functionSource(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, name);
  const rest = source.slice(match.index + 1);
  const next = rest.search(/\n(?:async )?function /);
  return source.slice(match.index, next < 0 ? undefined : match.index + 1 + next);
}

test('existing MX-H2I clients keep their login flow regardless of authentication state', () => {
  for (const auth of [
    { provider: 'password', accessToken: 'existing-token' },
    { provider: 'feishu', encryptedAccessToken: 'encrypted-token' },
    { expiresAt: '2000-01-01T00:00:00Z' },
    null
  ]) {
    const persistedRuntime = { auth, connection: { state: 'connected', leaseId: 'existing-lease' } };
    const original = structuredClone(persistedRuntime);
    assert.equal(selectExisting(persistedRuntime), 'legacy');
    assert.deepEqual(persistedRuntime, original);
  }
  assert.equal(selectExisting({}), 'legacy');
  assert.equal(selectUiEntryMode({}), 'legacy');
  assert.equal(selectUiEntryMode({ requestedMode: 'mincave' }), 'mincave');
  assert.equal(selectUiEntryMode({ requestedMode: 'invalid' }), 'legacy');
});

test('persisted entry survives logout and takes priority over historical window bounds', () => {
  for (const uiMode of ['legacy', 'mincave']) {
    const loggedOut = { uiMode, auth: null, identity: null, connection: { state: 'idle' }, window: mincaveWindow };
    assert.equal(selectExisting(loggedOut), uiMode);
    assert.equal(selectExisting(JSON.parse(JSON.stringify(loggedOut))), uiMode);
  }
});

test('unmarked MinCave clients are recognized only by valid prior MinCave bounds', () => {
  assert.equal(selectExisting({ window: mincaveWindow }), 'mincave');
  for (const bounds of [null, {}, { width: 1120, height: 760 },
    { x: 0, y: 0, width: 0, height: 760 }, { x: 0, y: 0, width: 1120, height: 10001 },
    { x: 'invalid', y: 0, width: 1120, height: 760 }]) {
    assert.equal(selectExisting({ window: { bounds: { mincave: bounds } } }), 'legacy');
  }
});

test('only explicit supported environment values override a persisted entry', () => {
  assert.equal(selectExisting({ uiMode: 'mincave' }, 'legacy'), 'legacy');
  assert.equal(selectExisting({ uiMode: 'legacy' }, 'mincave'), 'mincave');
  for (const invalid of [undefined, '', 'auto', 'true', 'MINCAVE']) {
    assert.equal(selectExisting({ uiMode: 'legacy' }, invalid), 'legacy');
    assert.equal(selectExisting({ uiMode: 'mincave' }, invalid), 'mincave');
    assert.equal(normalizeUiEntryMode(invalid), null);
  }
});

test('a prior MinCave window does not lock legacy password users out of their login flow', () => {
  for (const auth of [
    { provider: 'password', encryptedAccessToken: 'ciphertext' },
    { provider: 'password' },
    null
  ]) {
    const runtime = { auth, identity: { provider: 'password' }, window: mincaveWindow };
    assert.equal(selectExisting(runtime), 'legacy');
    assert.equal(selectExisting(runtime, 'mincave'), 'mincave');
    assert.equal(selectExisting({ ...runtime, uiMode: 'mincave' }), 'mincave');
  }
  assert.equal(selectExisting({ identity: { provider: 'password' }, window: mincaveWindow }), 'legacy');
  assert.equal(selectExisting({
    auth: { provider: 'feishu', encryptedAccessToken: 'ciphertext' },
    identity: { provider: 'password' },
    window: mincaveWindow
  }), 'mincave');
});

async function loadStoredRuntime({ contents, error, requestedMode, decrypt } = {}) {
  const context = vm.createContext({
    fs: { readFile: async () => { if (error) throw error; return contents; } },
    runtimePath: () => '/fixture/mx-h2i-runtime.json',
    process: { env: { MX_H2I_UI: requestedMode } },
    selectUiEntryMode,
    unprotectPersistedRuntime: decrypt || (value => value),
    normalizeRuntime: async value => ({ ...value }),
    loadPersistedH2oRuntime: async () => null,
    mergePersistedH2oRuntime: value => value,
    maybeSnapshotAppsState: async () => {}
  });
  vm.runInContext(functionSource('loadRuntime'), context);
  return context.loadRuntime();
}

test('fresh, corrupt and unreadable state all require an explicit MinCave opt-in', async () => {
  for (const error of [{ code: 'EACCES' }, { code: 'EIO' }, new Error('read failed')]) {
    assert.equal((await loadStoredRuntime({ error })).uiMode, 'legacy');
  }
  assert.equal((await loadStoredRuntime({ contents: '{invalid json' })).uiMode, 'legacy');
  assert.equal((await loadStoredRuntime({ contents: 'null' })).uiMode, 'legacy');
  assert.equal((await loadStoredRuntime({ error: { code: 'ENOENT' } })).uiMode, 'legacy');
  assert.equal((await loadStoredRuntime({ error: { code: 'ENOENT' }, requestedMode: 'mincave' })).uiMode, 'mincave');
  assert.equal((await loadStoredRuntime({ error: { code: 'EACCES' }, requestedMode: 'mincave' })).uiMode, 'mincave');
});

test('entry selection precedes credential normalization and preserves existing connection data', async () => {
  const stored = {
    auth: { provider: 'password', encryptedAccessToken: 'ciphertext' },
    installation: { installId: 'existing-installation' },
    connection: { state: 'connected', leaseId: 'existing-lease', localIp: '10.89.0.21' }
  };
  const loaded = await loadStoredRuntime({ contents: JSON.stringify(stored) });
  assert.equal(loaded.uiMode, 'legacy');
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.auth)), stored.auth);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.connection)), stored.connection);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.installation)), stored.installation);
  const unavailableCredentials = await loadStoredRuntime({
    contents: JSON.stringify(stored), decrypt: value => ({ ...value, auth: null })
  });
  assert.equal(unavailableCredentials.uiMode, 'legacy');
  const signedOut = { ...loaded, auth: null, connection: { state: 'idle' } };
  assert.equal((await loadStoredRuntime({ contents: JSON.stringify(signedOut) })).uiMode, 'legacy');
});

test('runtime normalization keeps the UI marker without creating authentication or authorization', async () => {
  const identity = value => value;
  const context = vm.createContext({
    normalizeUiEntryMode,
    normalizeConfig: identity, reconcileRuntimeUpdateWithInstalledVersion: identity,
    currentReleaseVersion: () => '2.1.20', normalizeInstallation: identity,
    normalizeAuth: value => value || null, normalizeConnection: identity,
    normalizeCredentialStorageFailure: identity, normalizeLeaseCapabilities: identity,
    normalizePendingNetworkHandover: identity, normalizeIdentity: identity,
    normalizeApps: identity, normalizeUpdate: identity,
    launcherContract: async () => ({}), normalizeLauncherProductPresentation: identity,
    normalizeWindowState: identity, normalizeNetworkModeEvent: identity,
    defaultActivity: () => [], nowIso: () => '2026-11-17T00:00:00Z'
  });
  vm.runInContext(functionSource('normalizeRuntime'), context);
  vm.runInContext(functionSource('persistableRuntime'), context);
  for (const uiMode of ['legacy', 'mincave']) {
    const normalized = await context.normalizeRuntime({ uiMode });
    assert.equal(normalized.uiMode, uiMode);
    assert.equal(normalized.auth, null);
    assert.equal(context.persistableRuntime(normalized).uiMode, uiMode);
  }
  assert.equal((await context.normalizeRuntime({})).uiMode, null);
});

test('startup selects legacy before MinCave admission and keeps legacy network recovery available', async () => {
  const start = source.indexOf('if (gotSingleInstanceLock) {');
  const end = source.indexOf('\n// Closes the installer loop', start);
  assert.ok(start >= 0 && end > start);
  for (const uiMode of ['legacy', 'mincave']) {
    const calls = [];
    let startup;
    const oldRuntime = { uiMode, auth: { provider: 'password', accessToken: 'existing-token' }, connection: { state: 'connected' } };
    const context = vm.createContext({
      gotSingleInstanceLock: true, MINCAVE_UI_ENABLED: false, runtime: null,
      app: { whenReady: () => ({ then: callback => { startup = callback; } }), getVersion: () => '2.1.20', getPath: () => '/fixture', isPackaged: true },
      loadRuntime: async () => oldRuntime,
      createMincaveAdminBridge: () => {
        calls.push('mincave-admission');
        return { refresh: async () => ({}), snapshot: () => ({ status: 'unavailable' }) };
      },
      process: { platform: 'win32', arch: 'x64', env: {} }, currentReleaseVersion: () => '2.1.20',
      queueDiagnosticLog() {}, initializeSystemDomainProxy: async () => {},
      reconcileCredentialStorageFailureAfterStartup: async () => ({}),
      reconcileExistingWireGuardAfterStartup: async () => { calls.push('legacy-recovery'); },
      reconcilePendingNetworkHandoverAfterStartup: async () => {}, settleAnonymousLoginDisabledAfterStartup: async () => {},
      refreshSystemDomainProxyForRuntime: async () => {}, startSystemDomainProxyRefreshWatcher() {},
      scheduleNetworkEnvironmentDiagnostics() {}, NETWORK_DIAGNOSTIC_LOOKUP_TIMEOUT_MS: 1,
      registerIpc() {}, setInterval: () => ({ unref() {} }), createTray() {}, createMainWindow() {},
      refreshLauncherProductPresentation() {}, restoreH2oRuntimeAfterStartup: async () => {},
      reportInstallCompletionAndAdoptPendingUpdates: async () => {}, startTopRevealWatcher() {},
      startWireGuardRecoveryWatcher() {}, startNetworkChangeWatcher() {},
      confirmElectronLauncherAsarLaunch() {}, PRODUCT_ID: 'mx-h2i'
    });
    vm.runInContext(source.slice(start, end), context);
    await startup();
    assert.equal(context.MINCAVE_UI_ENABLED, uiMode === 'mincave');
    assert.deepEqual(calls, uiMode === 'legacy' ? ['legacy-recovery'] : ['mincave-admission']);
    assert.equal(context.runtime.auth, oldRuntime.auth);
    assert.equal(context.runtime.connection, oldRuntime.connection);
  }
});
