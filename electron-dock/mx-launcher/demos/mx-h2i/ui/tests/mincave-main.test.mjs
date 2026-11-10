import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../../src/main-runtime.cjs', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
test('MinCave refuses unverified new connections before any lease or system mutation', async () => {
  let connects = 0;
  let checks = 0;
  const context = vm.createContext({
    MINCAVE_UI_ENABLED: true,
    activeForegroundNetworkOperation: null,
    mincaveBridge: {
      checkLogin: async () => {
        checks++;
        throw new Error('not admitted');
      },
    },
    connectLauncherNetwork: async () => {
      connects++;
    },
    isLauncherPublicKeyConflictError: () => false,
  });
  vm.runInContext(functionSource('connectLauncherNetworkWithLocalIdentityRepair'), context);
  await assert.rejects(
    context.connectLauncherNetworkWithLocalIdentityRepair({ identityKind: 'anonymous' }),
  );
  assert.equal(checks, 0);
  await assert.rejects(
    context.connectLauncherNetworkWithLocalIdentityRepair({
      identityKind: 'user',
      userId: 'employee',
      accessToken: 'proof',
      authProvider: 'feishu',
    }),
  );
  assert.equal(checks, 1);
  assert.equal(connects, 0);
  context.mincaveBridge.checkLogin = async () => {
    checks++;
  };
  await context.connectLauncherNetworkWithLocalIdentityRepair({
    identityKind: 'user',
    userId: 'employee',
    accessToken: 'proof',
    authProvider: 'feishu',
  });
  assert.equal(connects, 1);
});
test('cancelling a connection during its admission check prevents the lease request', async () => {
  let connects = 0;
  const context = vm.createContext({
    MINCAVE_UI_ENABLED: true,
    activeForegroundNetworkOperation: {},
    mincaveBridge: { checkLogin: async () => {} },
    assertForegroundNetworkOperationCurrent: () => {
      throw new Error('cancelled');
    },
    connectLauncherNetwork: async () => {
      connects++;
    },
  });
  vm.runInContext(functionSource('connectLauncherNetworkWithLocalIdentityRepair'), context);
  await assert.rejects(
    context.connectLauncherNetworkWithLocalIdentityRepair({
      identityKind: 'user',
      userId: 'employee',
      accessToken: 'proof',
      authProvider: 'feishu',
    }),
  );
  assert.equal(connects, 0);
});
test('unavailable MinCave authorization never triggers a background recovery or privileged repair', async () => {
  const context = vm.createContext({
    MINCAVE_UI_ENABLED: true,
    runtime: { auth: { accessToken: 'proof' } },
    mincaveBridge: {
      snapshot: () => ({ status: 'unavailable' }),
      refresh: async () => ({ status: 'unavailable' }),
      checkLogin: async () => {
        throw new Error('service unavailable');
      },
    },
  });
  vm.runInContext(functionSource('recoverWireGuardForRuntime'), context);
  vm.runInContext(functionSource('repairSystemNetworkForRuntime'), context);
  const result = await context.recoverWireGuardForRuntime('interval');
  assert.equal(result.skipped, true);
  await assert.rejects(context.repairSystemNetworkForRuntime('manual-repair'));
});
