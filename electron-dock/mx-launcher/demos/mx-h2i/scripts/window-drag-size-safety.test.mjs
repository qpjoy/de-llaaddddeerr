import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Windows moves the launcher window by re-applying bounds on every pointer or
// animation frame. `BrowserWindow.setPosition()` keeps the caller's x/y but
// re-sends the size Electron reads back from the OS, and on a fractional-DPI
// display that pixel -> DIP -> pixel round trip rounds outward. Every frame
// therefore handed the window one more physical pixel, so a left/right drag
// visibly widened it (and, depending on where the window sat, made it taller),
// and each dock/reveal animation ratcheted the persisted bounds further.
// macOS has no such round trip, which is why it never reproduced.
const source = readFileSync(
  fileURLToPath(new URL('../src/main-runtime.cjs', import.meta.url)),
  'utf8'
);

function functionBody(name, endMarker) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in main-runtime`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${name} must be followed by ${endMarker}`);
  return source.slice(start, end);
}

assert.match(
  source,
  /function moveWindowKeepingSize\(x, y, size\)[\s\S]*?mainWindow\.setBounds\(\{ x, y, width, height \}, false\)/,
  'the Windows move helper must re-apply a pinned size instead of letting Electron re-read it'
);

const moveHandler = source.slice(
  source.indexOf("ipcMain.handle('mx-h2i:move-window-by'"),
  source.indexOf("ipcMain.handle('mx-h2i:finish-window-drag'")
);
assert.ok(moveHandler.length > 0, 'the move-window-by handler must exist');
assert.doesNotMatch(
  moveHandler,
  /mainWindow\.setPosition\(/,
  'pointer-driven moves must never call setPosition, which re-sends a DPI-rounded size'
);
assert.match(
  moveHandler,
  /moveWindowKeepingSize\(nextBounds\.x, nextBounds\.y, windowsDrag \? activeWindowDrag : null\)/,
  'a Windows drag must move with its drag-start size pinned'
);

const scheduleCorrection = functionBody(
  'scheduleWindowDragSizeCorrection',
  'function applyWindowDragSizeSnapshot'
);
assert.match(
  scheduleCorrection,
  /elapsed >= WINDOW_DRAG_SIZE_THROTTLE_MS/,
  'the size correction must fire on the leading edge, not only after the pointer stops'
);
assert.match(
  scheduleCorrection,
  /if \(windowDragSizeBatchTimer\) return;/,
  'a pending trailing correction must not be pushed further out by continued movement'
);
assert.doesNotMatch(
  scheduleCorrection,
  /clearTimeout\(windowDragSizeBatchTimer\)/,
  'a trailing-only debounce would never correct the window during a continuous drag'
);

const applySnapshot = functionBody(
  'applyWindowDragSizeSnapshot',
  'function finishWindowDragSnapshot'
);
assert.match(
  applySnapshot,
  /const force = options\.force === true;[\s\S]*?if \(force \|\| current\.width !== target\.width/,
  'the release path must be able to re-assert the size even when DIP width reads unchanged'
);
assert.match(
  applySnapshot,
  /lastVisibleBounds = \{ \.\.\.restored, width: target\.width, height: target\.height \}/,
  'the remembered bounds must carry the pinned size, not the grown readback'
);

assert.match(
  source,
  /const bounds = applyWindowDragSizeSnapshot\(\{ force: true \}\);/,
  'releasing a drag must restore the drag-start size unconditionally'
);
assert.match(
  source,
  /function windowDragPinnedSize\(bounds\)[\s\S]*?defaultWindowBoundsForMode\('launcher', bounds\)/,
  'a drag must pin the canonical launcher size so it cannot inherit earlier growth'
);
assert.match(
  source,
  /\.\.\.bounds,\s*\.\.\.windowDragPinnedSize\(bounds\)/,
  'the drag snapshot must apply the pinned size over the observed bounds'
);

const animate = functionBody('animateWindow', 'function recoverTopWindowAnimation');
assert.match(
  animate,
  /moveWindowKeepingSize\(x, y, to\)/,
  'equal-size animation frames must pin the planned size instead of calling setPosition'
);
assert.match(
  animate,
  /if \(!from \|\| !to\)/,
  'non-finite animation bounds must be rejected before Electron throws a conversion TypeError'
);

assert.doesNotMatch(
  source,
  /lastVisibleBounds = mainWindow\.getBounds\(\);\s*\}\);/,
  'an animation must not record the grown Windows readback as the remembered bounds'
);
assert.match(
  source,
  /function animatedVisibleBounds\(planned\)[\s\S]*?width: size\.width, height: size\.height/,
  'post-animation bounds must keep the planned size and take only the observed position'
);

console.log('Window drag and animation size safety tests passed');
