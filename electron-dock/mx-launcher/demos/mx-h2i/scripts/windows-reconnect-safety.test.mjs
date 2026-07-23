import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  retainedGuestRecoveryDecision,
  wireGuardRecoveryGate,
  wireGuardRecoveryTurn
} = require('../src/network-recovery-policy.cjs');

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

console.log('Windows retained-tunnel reconnect safety tests passed');
