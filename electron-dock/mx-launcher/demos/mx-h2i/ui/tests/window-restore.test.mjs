import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { mincaveWindowBounds, mincaveWindowMinimum } = require('../../src/mincave-window-policy.cjs');
const source = await readFile(new URL('../../src/main-runtime.cjs', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

function harness({ minimized = true, maximized = false, fullscreen = false, enabled = true,
  normal = { x: 120, y: 100, width: 1120, height: 760 },
  workArea = { x: 0, y: 25, width: 1600, height: 1000 } } = {}) {
  const legacy = { x: 10, y: 25, width: 462, height: 760 };
  const calls = [];
  let nativeBounds = { ...normal };
  const window = {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isMaximized: () => maximized,
    isFullScreen: () => fullscreen,
    // Native normal bounds remain available while the minimized readback is transient.
    getBounds: () => minimized ? { x: 0, y: 0, width: 0, height: 0 } : { ...nativeBounds },
    getNormalBounds: () => ({ ...nativeBounds }),
    minimize() { minimized = true; },
    restore() { calls.push('restore'); minimized = false; },
    show() { calls.push('show'); minimized = false; },
    focus() { calls.push('focus'); },
    setBounds(value) { calls.push(['bounds', { ...value }]); nativeBounds = { ...value }; },
    setMinimumSize() {},
    setResizable() {},
  };
  const context = vm.createContext({
    MINCAVE_UI_ENABLED: enabled, mainWindow: window, currentWindowMode: 'launcher',
    runtime: { window: { mode: 'launcher', bounds: { launcher: legacy,
      mincave: { x: 120, y: 100, width: 1120, height: 760 } } } },
    // A stale legacy drag snapshot must never size the MinCave workbench.
    lastVisibleBounds: legacy, windowBoundsTrackingSuppressed: false,
    activeWindowDrag: null, isTopHidden: false, isTopDocked: false,
    isTopHideAnimating: false, topDockHidePending: false, topAnimationTimer: null,
    topDockHoldUntil: 0, topDockLeaveStartedAt: 0, needsRevealZoneReentry: false,
    mincaveWindowBounds, mincaveWindowMinimum,
    electronScreen: { getDisplayMatching: () => ({ workArea }), getPrimaryDisplay: () => ({ workArea }) },
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    defaultWindowBoundsForMode: () => ({ ...legacy }),
    dockActivationDistance: () => 24,
    createMainWindow() { assert.fail('existing window must be reused'); },
  });
  for (const name of ['normalizeWindowBounds', 'normalizeWindowState', 'rememberWindowBoundsForMode',
    'windowBoundsForMode', 'windowMinimumSizeForMode', 'constrainWindowBounds',
    'setWindowBoundsWithoutTracking', 'sameBounds', 'applyWindowModeChrome',
    'shouldPersistWindowBounds', 'showMainWindow']) {
    vm.runInContext(functionSource(name), context);
  }
  return { context, calls, window, show: () => context.showMainWindow(), bounds: () => ({ ...nativeBounds }) };
}

test('Dock reopen preserves MinCave normal bounds despite legacy bounds and minimized readback', () => {
  const h = harness();
  for (let attempt = 0; attempt < 3; attempt++) {
    h.window.minimize();
    h.show();
    assert.deepEqual(h.bounds(), { x: 120, y: 100, width: 1120, height: 760 });
    assert.deepEqual(plain(h.context.runtime.window.bounds.mincave), h.bounds());
    assert.equal(h.context.runtime.window.bounds.launcher.width, 462);
  }
  assert.equal(h.calls[0], 'restore');
  assert.equal(h.calls.filter((call) => call === 'restore').length, 3);
});

test('reopening an already visible MinCave window preserves an unsaved user resize and position', () => {
  const normal = { x: 170, y: 140, width: 1280, height: 820 };
  const h = harness({ minimized: false, normal });
  h.show();
  assert.deepEqual(h.bounds(), normal);
  assert.deepEqual(plain(h.context.runtime.window.bounds.mincave), normal);
  assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === 'bounds'), false);
});

test('reopening maximized or fullscreen MinCave does not resize or persist special-state bounds', () => {
  for (const state of [{ maximized: true }, { fullscreen: true }]) {
    const h = harness({ minimized: false, ...state });
    const before = plain(h.context.runtime.window);
    h.show();
    assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === 'bounds'), false);
    assert.deepEqual(plain(h.context.runtime.window), before);
    assert.equal(h.context.shouldPersistWindowBounds(), false);
  }
});

test('MinCave restoration clamps normal bounds to the current display work area', () => {
  const h = harness({ workArea: { x: 0, y: 25, width: 900, height: 650 } });
  h.show();
  assert.deepEqual(h.bounds(), { x: 0, y: 25, width: 900, height: 650 });
});

test('legacy launcher reopening keeps the existing narrow-window and top-edge behavior', () => {
  const h = harness({ enabled: false });
  h.show();
  assert.deepEqual(h.bounds(), { x: 10, y: 67, width: 462, height: 760 });
});
