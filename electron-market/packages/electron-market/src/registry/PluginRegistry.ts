import type { Permission } from '@qpjoy/electron-plugin-sdk';
import {
  MarketplaceDB,
  type InstalledPlugin,
  type InstallSource,
  type PluginManifest
} from '@qpjoy/marketplace-db';

import type { InstalledPluginRecord, PluginState } from '../types';

/**
 * Adapter over `@qpjoy/marketplace-db` that preserves the existing
 * `PluginRegistry` surface used elsewhere in the host. The DB itself is
 * the source of truth; this class just maps DTOs to the legacy field
 * names so the rest of the codebase keeps working.
 *
 * Multiple consumers may construct a registry against the same DB path —
 * marketplace-db opens with WAL + busy_timeout so concurrent writes from
 * (say) the standalone tunnel and the plugin host don't collide.
 */
export class PluginRegistry {
  private readonly db: MarketplaceDB;
  /** True if this registry owns the underlying DB (it should close it). */
  private readonly ownsDb: boolean;

  constructor(dbOrPath: MarketplaceDB | string) {
    if (typeof dbOrPath === 'string') {
      this.db = MarketplaceDB.open(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
  }

  /** Direct access for advanced consumers (admin/marketplace sync). */
  marketplaceDb(): MarketplaceDB {
    return this.db;
  }

  list(): InstalledPluginRecord[] {
    return this.db.listInstalled().map(toLegacyRecord);
  }

  get(id: string): InstalledPluginRecord | null {
    const row = this.db.getInstalled(id);
    return row ? toLegacyRecord(row) : null;
  }

  upsert(
    record: Omit<InstalledPluginRecord, 'installedAt' | 'updatedAt'>,
    installSource: InstallSource = 'registry'
  ): void {
    this.db.upsertInstalled({
      id: record.id,
      npm: record.npm,
      version: record.version,
      installPath: record.installPath,
      installSource,
      manifest: record.manifest as PluginManifest,
      grantedPermissions: record.grantedPermissions,
      state: record.state,
      errorMessage: record.errorMessage,
      marketplaceEntryId: record.id        // by convention, plugin id == entry id
    });
  }

  setState(id: string, state: PluginState, errorMessage: string | null = null): void {
    this.db.setInstalledState(id, state, errorMessage);
  }

  grant(id: string, permissions: Permission[]): void {
    this.db.grant(id, permissions);
  }

  remove(id: string): void {
    this.db.removeInstalled(id);
  }

  log(
    pluginId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>
  ): void {
    this.db.log(pluginId, level, message, meta);
  }

  recentLogs(pluginId: string, limit = 200) {
    return this.db.recentLogs(pluginId, limit).map((row) => ({
      id: row.id,
      level: row.level,
      message: row.message,
      meta: row.meta,
      createdAt: row.createdAt
    }));
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

function toLegacyRecord(row: InstalledPlugin): InstalledPluginRecord {
  return {
    id: row.id,
    npm: row.npm,
    version: row.version,
    installPath: row.installPath,
    manifest: row.manifest as InstalledPluginRecord['manifest'],
    grantedPermissions: row.grantedPermissions as Permission[],
    state: row.state,
    errorMessage: row.errorMessage,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt
  };
}
