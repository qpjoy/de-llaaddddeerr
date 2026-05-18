/**
 * Storage entry point. Reads `DATABASE_URL` once at boot:
 *   - present  → Postgres, runs migrations, swaps in pg implementations
 *   - absent   → JSON file backend under `data/auth/`
 *
 * Everything else in the server imports `storage` from here and never
 * cares about the backend.
 */
import { jsonStorage } from './json/index.js';
import { pgStorage } from './pg/index.js';
import { initPg } from './pg/pool.js';
import type { Storage } from './storage-types.js';

let active: Storage = jsonStorage;
let inited = false;

/**
 * Must be called once at server startup before any route hits storage.
 * Idempotent: calling twice is a no-op.
 */
export async function initStorage(): Promise<Storage> {
  if (inited) return active;
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    await initPg(url);
    active = pgStorage;
    // eslint-disable-next-line no-console
    console.log('[storage] using Postgres backend');
  } else {
    // eslint-disable-next-line no-console
    console.log('[storage] using JSON file backend (no DATABASE_URL set)');
  }
  inited = true;
  return active;
}

export function getStorage(): Storage {
  return active;
}

/**
 * Convenience proxies so existing code keeps working. The proxy resolves
 * to whichever backend `initStorage` selected.
 */
export const usersStore = new Proxy({} as Storage['users'], {
  get: (_t, prop) => Reflect.get(active.users, prop, active.users)
});
export const refreshStore = new Proxy({} as Storage['refresh'], {
  get: (_t, prop) => Reflect.get(active.refresh, prop, active.refresh)
});
export const entitlementsStore = new Proxy({} as Storage['entitlements'], {
  get: (_t, prop) => Reflect.get(active.entitlements, prop, active.entitlements)
});
export const codesStore = new Proxy({} as Storage['codes'], {
  get: (_t, prop) => Reflect.get(active.codes, prop, active.codes)
});
export const auditStore = new Proxy({} as Storage['audit'], {
  get: (_t, prop) => Reflect.get(active.audit, prop, active.audit)
});
export const gameScoresStore = new Proxy({} as Storage['gameScores'], {
  get: (_t, prop) => Reflect.get(active.gameScores, prop, active.gameScores)
});

export type { Storage } from './storage-types.js';
export * from './storage-types.js';
