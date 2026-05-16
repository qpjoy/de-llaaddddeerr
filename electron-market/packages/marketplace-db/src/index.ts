export { MarketplaceDB } from './MarketplaceDB';
export type { OpenOptions } from './MarketplaceDB';

export { Migrator } from './Migrator';
export type { Migration, MigrationStatus, ValidationReport } from './Migrator';

export { bundledMigrations } from './migrations';

export * from './types';

/** Canonical path *within* an app's userData. */
export const MARKETPLACE_DB_RELATIVE_PATH = 'qpjoy-plugin-host/marketplace.db';

/**
 * Compose the canonical marketplace DB path from an Electron app's userData
 * directory. Both `@qpjoy/electron-market` and `@qpjoy/electron-tunnel`
 * (standalone) call this so they hit the same file.
 */
export function resolveMarketplaceDbPath(userDataPath: string): string {
  // Avoid `path.join` here to keep this file dep-free; userDataPath is
  // always absolute and platform-correct.
  const sep = userDataPath.includes('\\') && !userDataPath.includes('/') ? '\\' : '/';
  const trimmed = userDataPath.endsWith(sep)
    ? userDataPath.slice(0, -1)
    : userDataPath;
  return `${trimmed}${sep}${MARKETPLACE_DB_RELATIVE_PATH.replace(/\//g, sep)}`;
}
