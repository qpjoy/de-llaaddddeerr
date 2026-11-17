'use strict';

function normalizeUiEntryMode(value) {
  return value === 'legacy' || value === 'mincave' ? value : null;
}

function hasMincaveWindowBounds(runtime) {
  const bounds = runtime?.window?.bounds?.mincave;
  if (!bounds || typeof bounds !== 'object') return false;
  const { x, y, width, height } = Object.fromEntries(
    ['x', 'y', 'width', 'height'].map(key => [key, Math.round(Number(bounds[key]))])
  );
  return [x, y, width, height].every(Number.isFinite)
    && width >= 320 && height >= 420 && width <= 10000 && height <= 10000;
}

// This selects a UI only. Neither the marker nor old window bounds authorize
// MinCave access, a login, or a network connection.
function selectUiEntryMode({ requestedMode, persistedRuntime }) {
  const explicit = normalizeUiEntryMode(requestedMode);
  if (explicit) return explicit;
  const persisted = normalizeUiEntryMode(persistedRuntime?.uiMode);
  if (persisted) return persisted;
  // A legacy password session may have opened MinCave once before entry
  // migration was introduced. Its window bounds must not lock out that login.
  const auth = persistedRuntime?.auth;
  if (auth?.provider === 'password'
    || (auth == null && persistedRuntime?.identity?.provider === 'password')) return 'legacy';
  if (hasMincaveWindowBounds(persistedRuntime)) return 'mincave';
  return 'legacy';
}

module.exports = { normalizeUiEntryMode, selectUiEntryMode };
