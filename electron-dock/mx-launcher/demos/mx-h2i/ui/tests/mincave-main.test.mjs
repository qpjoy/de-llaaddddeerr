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
    windowsNetworkServiceForRuntime: () => null,
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
    windowsNetworkServiceForRuntime: () => null,
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

test('native macOS titlebar is enabled only for MinCave while legacy and other platforms stay frameless', () => {
  const start = source.indexOf('function createMainWindow()');
  const end = source.indexOf('\nfunction registerIpc()', start);
  assert.ok(start > 0 && end > start);
  for (const [platform, enabled, native] of [['darwin', true, true], ['darwin', false, false], ['win32', true, false], ['linux', true, false]]) {
    let options;
    class Window {
      constructor(value) { options = value; this.webContents = { setWindowOpenHandler() {} }; }
      removeMenu() {}
      on() {}
      once() {}
      loadFile() {}
      getBounds() { return { width: 1120, height: 760 }; }
    }
    const context = vm.createContext({
      BrowserWindow: Window, MINCAVE_UI_ENABLED: enabled, process: { platform }, mainWindow: null,
      windowBoundsForMode: () => ({ width: 1120, height: 760 }),
      windowMinimumSizeForMode: () => ({ width: 520, height: 480 }),
      productIconPath: () => '/test/icon', attachWindowBoundsTracking() {}, rememberWindowBoundsForMode() {},
      path: { join: (...parts) => parts.join('/') }, __dirname: '/test',
    });
    vm.runInContext(source.slice(start, end) + '\ncreateMainWindow();', context);
    assert.equal(options.frame, native, `${platform}/${enabled}`);
    assert.equal(options.titleBarStyle, native ? 'hiddenInset' : undefined);
    assert.equal(options.resizable, enabled);
    assert.equal(options.webPreferences.contextIsolation, true);
    assert.equal(options.webPreferences.nodeIntegration, false);
  }
});

test('Windows service readiness follows enterprise admission and blocks the lease when unavailable or cancelled', async () => {
  const events = [];
  const context = vm.createContext({
    MINCAVE_UI_ENABLED: true, activeForegroundNetworkOperation: {},
    mincaveBridge: { checkLogin: async () => { events.push('admitted'); } },
    assertForegroundNetworkOperationCurrent: (_, phase) => { events.push(phase); },
    windowsNetworkServiceForRuntime: () => ({ ensureAvailable: async () => { events.push('service'); throw new Error('full installer required'); } }),
    connectLauncherNetwork: async () => { events.push('lease'); },
    isLauncherPublicKeyConflictError: () => false,
  });
  vm.runInContext(functionSource('connectLauncherNetworkWithLocalIdentityRepair'), context);
  const input = {identityKind:'user',userId:'employee',accessToken:'proof',authProvider:'feishu'};
  await assert.rejects(context.connectLauncherNetworkWithLocalIdentityRepair(input), /full installer/);
  assert.deepEqual(events,['admitted','mincave-connection-admitted','service']);
  events.length=0;
  context.windowsNetworkServiceForRuntime = () => ({ ensureAvailable: async () => { events.push('service'); } });
  context.assertForegroundNetworkOperationCurrent = (_,phase) => { if(phase==='mincave-windows-service-ready')throw Error('cancelled'); };
  await assert.rejects(context.connectLauncherNetworkWithLocalIdentityRepair(input), /cancelled/);
  assert.equal(events.includes('lease'),false);
  context.assertForegroundNetworkOperationCurrent = () => {};
  await context.connectLauncherNetworkWithLocalIdentityRepair(input);
  assert.equal(events.at(-1),'lease');
});
