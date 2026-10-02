import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  pruneElectronLauncherStandaloneOwnershipClaims as prune,
  claimElectronLauncherStandaloneOwnershipClaim as claim,
  readElectronLauncherStandaloneOwnershipState as readState,
  upsertElectronLauncherStandaloneOwnershipClaim as upsert
} from '../../../packages/electron-launcher/dist/standalone-data-plane.js';

const require = createRequire(import.meta.url);
const { inspectOrRepairWindowsOwnership, windowsOwnershipProofScript } = require('../src/windows-ownership-recovery.cjs');
const currentOwnerId = 'mx-h2i:current';
const old = {
  ownerId: 'mx-h2i:old', productId: 'mx-h2i', instanceId: 'old',
  state: 'active', leaseIp: '10.89.50.14', routeCidrs: ['10.89.0.0/16'],
  metadata: { dataPlaneOwner: true }, updatedAt: '2026-09-23T02:44:41.185Z'
};
const current = { ...old, ownerId: currentOwnerId, instanceId: 'current', leaseIp: '10.89.50.15' };
const luopan = { ...old, ownerId: 'luopan:compass', productId: 'luopan', instanceId: 'compass', leaseIp: '10.91.0.35', routeCidrs: ['10.91.0.0/16'] };
const stopped = { observed: true, currentProcessFound: true, otherProcessIds: [], serviceStates: [], adapterNames: [], addresses: [] };
const directory = mkdtempSync(join(tmpdir(), 'mx-ownership-recovery-'));
const file = join(directory, 'standalone-ownership.json');
const seed = () => writeFileSync(file, JSON.stringify({ version: 1, claims: [old, current, luopan] }));
let proof = stopped;
let probes = 0;
const run = (extra = {}) => inspectOrRepairWindowsOwnership({
  platform: 'win32', currentOwnerId, claims: readState(file).claims, repair: true,
  probe: () => { probes++; return proof; },
  prune: (input) => prune({ ...input, statePath: file }), ...extra
});

try {
  seed();
  const initial = readFileSync(file, 'utf8');
  assert.equal(run({ repair: false }).status, 'eligible');
  assert.equal(readFileSync(file, 'utf8'), initial, 'diagnosis never writes');
  for (const [patch, expected] of [
    [{ platform: 'darwin' }, 'unsupported'],
    [{ connected: true }, 'connection-active'],
    [{ busy: true }, 'operation-in-flight']
  ]) {
    probes = 0;
    assert.equal(run(patch).status, expected);
    assert.equal(probes, 0, 'healthy/busy/non-Windows paths do not probe or mutate');
  }
  for (const [patch, expected] of [
    [{ observed: false }, 'probe-failed'],
    [{ currentProcessFound: false }, 'probe-failed'],
    [{ addresses: null }, 'probe-failed'],
    [{ otherProcessIds: [5628] }, 'other-instance-running'],
    [{ serviceStates: ['Running'] }, 'tunnel-active'],
    [{ serviceStates: ['Start Pending'] }, 'tunnel-active'],
    [{ adapterNames: ['mx-h2i'] }, 'interface-present'],
    [{ addresses: ['10.89.50.14'] }, 'interface-present']
  ]) {
    proof = { ...stopped, ...patch };
    assert.equal(run().status, expected);
    assert.equal(readFileSync(file, 'utf8'), initial);
  }
  proof = stopped;
  assert.equal(run({ probe: () => { throw new Error('ETIMEDOUT'); } }).repaired, false);
  assert.equal(readFileSync(file, 'utf8'), initial);
  assert.equal(run({ prune: undefined }).status, 'base-update-required');

  let calls = 0;
  assert.equal(run({ probe: () => ++calls === 1 ? stopped : { ...stopped, serviceStates: ['Running'] } }).status, 'inactive-proof-lost');
  assert.equal(calls, 2, 'the live proof must be repeated inside the registry lock');
  assert.equal(readFileSync(file, 'utf8'), initial);
  assert.equal(readdirSync(directory).some((name) => name.endsWith('.bak')), false);

  const staleSnapshot = readState(file).claims;
  upsert({ ...old, updatedAt: '2026-09-30T08:00:00Z' }, file);
  const changed = readFileSync(file, 'utf8');
  assert.equal(run({ claims: staleSnapshot }).status, 'claim-snapshot-changed');
  assert.equal(readFileSync(file, 'utf8'), changed, 'concurrent owner updates survive');

  seed();
  for (const bad of [current, luopan]) {
    assert.equal(prune({ productId: 'mx-h2i', currentOwnerId, expectedClaims: [bad], verifyInactive: () => true, statePath: file }).repaired, false);
  }
  const repaired = run();
  assert.equal(repaired.status, 'repaired');
  assert.deepEqual(repaired.removedOwnerIds, [old.ownerId]);
  assert.deepEqual(JSON.parse(readFileSync(repaired.backupPath, 'utf8')).claims, [old, current, luopan]);
  assert.deepEqual(readState(file).claims, [current, luopan], 'preserve current identity and Luopan byte-for-byte as objects');
  assert.equal(run().status, 'no-candidates', 'repair is idempotent');

  seed();
  writeFileSync(file, '{broken');
  assert.throws(() => prune({ productId: 'mx-h2i', currentOwnerId, expectedClaims: [old], verifyInactive: () => true, statePath: file }));
  assert.equal(readFileSync(file, 'utf8'), '{broken', 'invalid registry must not be reset');

  // Exercise the real runtime adapter without starting Electron, connecting,
  // or modifying credentials. Both the automatic and manual routes use it.
  seed();
  const source = readFileSync(new URL('../src/main-runtime.cjs', import.meta.url), 'utf8');
  const start = source.indexOf('function runWindowsOwnershipRecovery(');
  const end = source.indexOf('async function darwinOwnershipSupersessionProof', start);
  const auth = { accessToken: 'test-token' };
  const installation = { installId: 'current', keyPair: { privateKey: 'test-key' } };
  const pending = { transitionId: 'keep-pending' };
  const context = vm.createContext({
    runtime: { auth, installation, networkHandover: pending, leaseCapabilities: { test: 'capability' }, connection: { state: 'lease-only' } },
    process: { platform: 'win32' }, wireGuardDisconnectInFlight: false,
    wireGuardConnectOperations: new Set(), wireGuardRecoveryInFlight: null,
    activeForegroundNetworkOperation: null, networkRecoveryPaused: false,
    lastWindowsOwnershipRepair: null,
    standaloneOwnershipOwnerId: () => currentOwnerId,
    nowIso: () => '2026-09-30T08:00:00Z', queueDiagnosticLog: () => {},
    inspectOrRepairWindowsOwnership: (input) => inspectOrRepairWindowsOwnership({ ...input, probe: () => stopped }),
    mod: {
      readElectronLauncherStandaloneOwnershipState: () => readState(file),
      pruneElectronLauncherStandaloneOwnershipClaims: (input) => prune({ ...input, statePath: file })
    }
  });
  vm.runInContext(source.slice(start, end), context);
  const beforeIdentity = JSON.stringify({ auth, installation, pending, capabilities: context.runtime.leaseCapabilities });
  assert.equal(vm.runInContext("runWindowsOwnershipRecovery(mod, 'manual-ownership-repair', true).repaired", context), true);
  assert.equal(context.networkRecoveryPaused, true, 'do not auto-restart the retired profile after manual cleanup');
  assert.equal(JSON.stringify({ auth: context.runtime.auth, installation: context.runtime.installation, pending: context.runtime.networkHandover, capabilities: context.runtime.leaseCapabilities }), beforeIdentity);
  seed();
  context.networkRecoveryPaused = false;
  context.runtime.connection.state = 'connecting';
  context.wireGuardConnectOperations.add({});
  assert.equal(vm.runInContext("runWindowsOwnershipRecovery(mod, 'connect-preflight', true).repaired", context), true);
  assert.equal(context.networkRecoveryPaused, false, 'the authorized connect continues after safe pruning');

  seed();
  context.importInstalledPackage = async () => context.mod;
  context.mod.claimElectronLauncherStandaloneOwnershipClaim = (row) => claim(row, { statePath: file });
  context.mxH2iStandaloneOwnershipClaim = () => current;
  context.compactStandaloneOwnershipState = (row) => ({ ok: row.claimed, claims: row.claims });
  context.errorMessage = (err) => err.message;
  vm.runInContext(source.slice(source.indexOf('async function upsertStandaloneOwnershipForRoutePlan('), source.indexOf('async function windowsOwnershipRecoveryForRuntime(')), context);
  const preflight = await vm.runInContext("upsertStandaloneOwnershipForRoutePlan({}, {}, 'connect-preflight')", context);
  assert.equal(preflight.ok, true, 'a failed preflight retries its real atomic claim after pruning');
  assert.deepEqual(preflight.windowsOwnershipRecovery.removedOwnerIds, [old.ownerId]);
  assert.deepEqual(readState(file).claims.map((row) => row.ownerId).sort(), [current.ownerId, luopan.ownerId].sort());

  // A live old instance must keep blocking registration; no backup or retry
  // may turn it into a successful connection.
  seed();
  context.inspectOrRepairWindowsOwnership = (input) => inspectOrRepairWindowsOwnership({ ...input, probe: () => ({ ...stopped, otherProcessIds: [9999] }) });
  assert.equal((await vm.runInContext("upsertStandaloneOwnershipForRoutePlan({}, {}, 'connect-preflight')", context)).ok, false);
  assert.deepEqual(readState(file).claims, [old, current, luopan]);

  const rotation = source.slice(source.indexOf('async function rotateLocalLauncherIdentity('), source.indexOf('async function rotateLocalLauncherIdentity(') + 1500);
  assert.match(rotation, /ownershipInstanceId: stableOwnershipInstanceId\(current\) \|\| installId/);
  const script = windowsOwnershipProofScript([old], 123, 'C:\\MX\\mx-h2i.exe');
  assert.match(script, /Get-CimInstance Win32_Process -ErrorAction Stop/);
  assert.match(script, /Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop/);
  assert.match(script, /\$oldIps -contains \$_.IPAddress/);
  assert.doesNotMatch(script, /Remove-|Stop-|Set-Net|SilentlyContinue/);
  console.log('Windows ownership recovery: guards, locked recheck, backup, concurrency, idempotence and credential preservation passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
