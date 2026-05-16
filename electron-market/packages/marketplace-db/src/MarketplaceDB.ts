import { mkdirSync } from 'fs';
import { dirname } from 'path';
import Database from 'better-sqlite3';

import { Migrator, type Migration } from './Migrator';
import { bundledMigrations } from './migrations';
import type {
  AuthSession,
  EntrySource,
  InstalledPlugin,
  InstallSource,
  LogLevel,
  MarketplaceEntry,
  MarketplaceVersion,
  PluginLogEntry,
  PluginManifest,
  PluginState,
  RemoteSyncState,
  SyncScope,
  Visibility
} from './types';

export interface OpenOptions {
  /** Apply pending migrations automatically. Default: true. */
  autoMigrate?: boolean;
  /** Override the migration list — used by tests + remote injection. */
  migrations?: Migration[];
  /** SQLite busy timeout (ms). Default 5000. */
  busyTimeoutMs?: number;
  /** Whether to enable WAL. Default true. */
  wal?: boolean;
}

/**
 * Facade over the marketplace SQLite. Single source of truth shared by:
 *
 *  - `@qpjoy/electron-market` — its `PluginRegistry` delegates here
 *  - `@qpjoy/electron-tunnel` (standalone) — self-registers a row in
 *    `installed_plugins` so the marketplace knows about it before
 *    electron-market is ever loaded
 *
 * The DB lives at `<userData>/qpjoy-plugin-host/marketplace.db`. Per-app
 * (Electron's userData is per-app); WAL + busy_timeout lets multiple
 * processes inside the same app coordinate writes safely.
 */
export class MarketplaceDB {
  private readonly db: Database.Database;
  public readonly migrator: Migrator;

  constructor(path: string, opts: OpenOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    if (opts.wal !== false) this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    this.migrator = new Migrator(this.db, opts.migrations ?? bundledMigrations);
    if (opts.autoMigrate !== false) {
      this.migrator.up();
    }
  }

  static open(path: string, opts: OpenOptions = {}): MarketplaceDB {
    return new MarketplaceDB(path, opts);
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Marketplace entries                                                    */
  /* ────────────────────────────────────────────────────────────────────── */

  upsertEntry(entry: Partial<MarketplaceEntry> & Pick<MarketplaceEntry, 'id' | 'npm' | 'name' | 'latestVersion'>): void {
    this.db
      .prepare(
        `
        INSERT INTO marketplace_entries (
          id, npm, name, description, latest_version, manifest_url, tarball_url,
          homepage, author, category, verified, bootstrap, visibility, spec_version,
          metadata_json, source, fetched_at
        ) VALUES (
          @id, @npm, @name, @description, @latest_version, @manifest_url, @tarball_url,
          @homepage, @author, @category, @verified, @bootstrap, @visibility, @spec_version,
          @metadata_json, @source, @fetched_at
        )
        ON CONFLICT(id) DO UPDATE SET
          npm = excluded.npm,
          name = excluded.name,
          description = excluded.description,
          latest_version = excluded.latest_version,
          manifest_url = excluded.manifest_url,
          tarball_url = excluded.tarball_url,
          homepage = excluded.homepage,
          author = excluded.author,
          category = excluded.category,
          verified = excluded.verified,
          bootstrap = excluded.bootstrap,
          visibility = excluded.visibility,
          spec_version = excluded.spec_version,
          metadata_json = excluded.metadata_json,
          source = excluded.source,
          fetched_at = excluded.fetched_at,
          updated_at = datetime('now')
      `
      )
      .run({
        id: entry.id,
        npm: entry.npm,
        name: entry.name,
        description: entry.description ?? null,
        latest_version: entry.latestVersion,
        manifest_url: entry.manifestUrl ?? null,
        tarball_url: entry.tarballUrl ?? null,
        homepage: entry.homepage ?? null,
        author: entry.author ?? null,
        category: entry.category ?? null,
        verified: entry.verified ? 1 : 0,
        bootstrap: entry.bootstrap ? 1 : 0,
        visibility: (entry.visibility ?? 'public') as Visibility,
        spec_version: entry.specVersion ?? 1,
        metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null,
        source: (entry.source ?? 'remote') as EntrySource,
        fetched_at: entry.fetchedAt ?? null
      });
  }

  bulkUpsertEntries(entries: Array<Parameters<MarketplaceDB['upsertEntry']>[0]>): void {
    const tx = this.db.transaction((items: typeof entries) => {
      for (const e of items) this.upsertEntry(e);
    });
    tx(entries);
  }

  listEntries(filter?: { visibility?: Visibility; category?: string }): MarketplaceEntry[] {
    let sql = `SELECT * FROM marketplace_entries`;
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.visibility) {
      where.push(`visibility = ?`);
      args.push(filter.visibility);
    }
    if (filter?.category) {
      where.push(`category = ?`);
      args.push(filter.category);
    }
    if (where.length > 0) sql += ` WHERE ` + where.join(' AND ');
    sql += ` ORDER BY name ASC`;
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  }

  getEntry(id: string): MarketplaceEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM marketplace_entries WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : null;
  }

  removeEntry(id: string): void {
    this.db.prepare(`DELETE FROM marketplace_entries WHERE id = ?`).run(id);
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Versions                                                               */
  /* ────────────────────────────────────────────────────────────────────── */

  upsertVersion(v: Partial<MarketplaceVersion> & Pick<MarketplaceVersion, 'entryId' | 'version'>): void {
    this.db
      .prepare(
        `
        INSERT INTO marketplace_versions (
          entry_id, version, changelog, released_at, min_host_version, max_host_version,
          deprecated, yanked, manifest_checksum, tarball_checksum
        ) VALUES (
          @entry_id, @version, @changelog, @released_at, @min_host_version, @max_host_version,
          @deprecated, @yanked, @manifest_checksum, @tarball_checksum
        )
        ON CONFLICT(entry_id, version) DO UPDATE SET
          changelog = excluded.changelog,
          released_at = excluded.released_at,
          min_host_version = excluded.min_host_version,
          max_host_version = excluded.max_host_version,
          deprecated = excluded.deprecated,
          yanked = excluded.yanked,
          manifest_checksum = excluded.manifest_checksum,
          tarball_checksum = excluded.tarball_checksum
      `
      )
      .run({
        entry_id: v.entryId,
        version: v.version,
        changelog: v.changelog ?? null,
        released_at: v.releasedAt ?? null,
        min_host_version: v.minHostVersion ?? null,
        max_host_version: v.maxHostVersion ?? null,
        deprecated: v.deprecated ? 1 : 0,
        yanked: v.yanked ? 1 : 0,
        manifest_checksum: v.manifestChecksum ?? null,
        tarball_checksum: v.tarballChecksum ?? null
      });
  }

  listVersions(entryId: string): MarketplaceVersion[] {
    const rows = this.db
      .prepare(`SELECT * FROM marketplace_versions WHERE entry_id = ? ORDER BY released_at DESC`)
      .all(entryId) as Array<Record<string, unknown>>;
    return rows.map(rowToVersion);
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Installed plugins                                                      */
  /* ────────────────────────────────────────────────────────────────────── */

  upsertInstalled(input: Omit<InstalledPlugin, 'installedAt' | 'updatedAt'>): void {
    this.db
      .prepare(
        `
        INSERT INTO installed_plugins (
          id, npm, version, install_path, install_source, manifest_json,
          granted_permissions_json, state, error_message, marketplace_entry_id
        ) VALUES (
          @id, @npm, @version, @install_path, @install_source, @manifest_json,
          @granted_permissions_json, @state, @error_message, @marketplace_entry_id
        )
        ON CONFLICT(id) DO UPDATE SET
          npm = excluded.npm,
          version = excluded.version,
          install_path = excluded.install_path,
          install_source = excluded.install_source,
          manifest_json = excluded.manifest_json,
          granted_permissions_json = excluded.granted_permissions_json,
          state = excluded.state,
          error_message = excluded.error_message,
          marketplace_entry_id = excluded.marketplace_entry_id,
          updated_at = datetime('now')
      `
      )
      .run({
        id: input.id,
        npm: input.npm,
        version: input.version,
        install_path: input.installPath,
        install_source: input.installSource as InstallSource,
        manifest_json: JSON.stringify(input.manifest),
        granted_permissions_json: JSON.stringify(input.grantedPermissions),
        state: input.state,
        error_message: input.errorMessage,
        marketplace_entry_id: input.marketplaceEntryId
      });
  }

  listInstalled(): InstalledPlugin[] {
    const rows = this.db
      .prepare(`SELECT * FROM installed_plugins ORDER BY installed_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToInstalled);
  }

  getInstalled(id: string): InstalledPlugin | null {
    const row = this.db
      .prepare(`SELECT * FROM installed_plugins WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToInstalled(row) : null;
  }

  setInstalledState(id: string, state: PluginState, errorMessage: string | null = null): void {
    this.db
      .prepare(
        `UPDATE installed_plugins SET state = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(state, errorMessage, id);
  }

  grant(id: string, permissions: string[]): void {
    this.db
      .prepare(
        `UPDATE installed_plugins SET granted_permissions_json = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(JSON.stringify(permissions), id);
  }

  removeInstalled(id: string): void {
    this.db.prepare(`DELETE FROM installed_plugins WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM plugin_logs WHERE plugin_id = ?`).run(id);
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Logs                                                                   */
  /* ────────────────────────────────────────────────────────────────────── */

  log(
    pluginId: string,
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
    correlationId?: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO plugin_logs (plugin_id, level, message, meta_json, correlation_id) VALUES (?, ?, ?, ?, ?)`
      )
      .run(pluginId, level, message, meta ? JSON.stringify(meta) : null, correlationId ?? null);
  }

  recentLogs(pluginId: string, limit = 200): PluginLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, plugin_id, level, message, meta_json, correlation_id, created_at
         FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(pluginId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      pluginId: String(r.plugin_id),
      level: r.level as LogLevel,
      message: String(r.message),
      meta: r.meta_json ? (JSON.parse(String(r.meta_json)) as Record<string, unknown>) : null,
      correlationId: r.correlation_id ? String(r.correlation_id) : null,
      createdAt: String(r.created_at)
    }));
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Sync state + meta KV                                                   */
  /* ────────────────────────────────────────────────────────────────────── */

  getSync(scope: SyncScope): RemoteSyncState | null {
    const row = this.db
      .prepare(`SELECT * FROM remote_sync WHERE scope = ?`)
      .get(scope) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      scope,
      lastRelease: row.last_release ? String(row.last_release) : null,
      lastFetchedAt: row.last_fetched_at ? String(row.last_fetched_at) : null,
      nextCheckAt: row.next_check_at ? String(row.next_check_at) : null,
      failureCount: Number(row.failure_count ?? 0),
      lastError: row.last_error ? String(row.last_error) : null,
      data: row.data_json ? (JSON.parse(String(row.data_json)) as Record<string, unknown>) : null
    };
  }

  setSync(scope: SyncScope, patch: Partial<Omit<RemoteSyncState, 'scope'>>): void {
    const current = this.getSync(scope);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `
        INSERT INTO remote_sync (scope, last_release, last_fetched_at, next_check_at, failure_count, last_error, data_json)
        VALUES (@scope, @last_release, @last_fetched_at, @next_check_at, @failure_count, @last_error, @data_json)
        ON CONFLICT(scope) DO UPDATE SET
          last_release = excluded.last_release,
          last_fetched_at = excluded.last_fetched_at,
          next_check_at = excluded.next_check_at,
          failure_count = excluded.failure_count,
          last_error = excluded.last_error,
          data_json = excluded.data_json
      `
      )
      .run({
        scope,
        last_release: next.lastRelease ?? null,
        last_fetched_at: next.lastFetchedAt ?? null,
        next_check_at: next.nextCheckAt ?? null,
        failure_count: next.failureCount ?? 0,
        last_error: next.lastError ?? null,
        data_json: next.data ? JSON.stringify(next.data) : null
      });
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta_kv WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta_kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .run(key, value);
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Auth session                                                           */
  /* ────────────────────────────────────────────────────────────────────── */

  getActiveSession(): AuthSession | null {
    const row = this.db
      .prepare(`SELECT * FROM auth_session ORDER BY id DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      accessToken: row.access_token ? String(row.access_token) : null,
      refreshToken: row.refresh_token ? String(row.refresh_token) : null,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      user: row.user_json ? (JSON.parse(String(row.user_json)) as Record<string, unknown>) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  setSession(s: Omit<AuthSession, 'id' | 'createdAt' | 'updatedAt'>): void {
    this.db
      .prepare(`DELETE FROM auth_session`)
      .run();
    this.db
      .prepare(
        `INSERT INTO auth_session (access_token, refresh_token, expires_at, user_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        s.accessToken,
        s.refreshToken,
        s.expiresAt,
        s.user ? JSON.stringify(s.user) : null
      );
  }

  clearSession(): void {
    this.db.prepare(`DELETE FROM auth_session`).run();
  }

  /* ────────────────────────────────────────────────────────────────────── */
  /* Lifecycle                                                              */
  /* ────────────────────────────────────────────────────────────────────── */

  raw(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Row → DTO mappers                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

function rowToEntry(r: Record<string, unknown>): MarketplaceEntry {
  return {
    id: String(r.id),
    npm: String(r.npm),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    latestVersion: String(r.latest_version),
    manifestUrl: r.manifest_url ? String(r.manifest_url) : null,
    tarballUrl: r.tarball_url ? String(r.tarball_url) : null,
    homepage: r.homepage ? String(r.homepage) : null,
    author: r.author ? String(r.author) : null,
    category: r.category ? String(r.category) : null,
    verified: Number(r.verified ?? 0) === 1,
    bootstrap: Number(r.bootstrap ?? 0) === 1,
    visibility: String(r.visibility ?? 'public') as Visibility,
    specVersion: Number(r.spec_version ?? 1),
    metadata: r.metadata_json ? (JSON.parse(String(r.metadata_json)) as Record<string, unknown>) : null,
    source: String(r.source ?? 'remote') as EntrySource,
    fetchedAt: r.fetched_at ? String(r.fetched_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  };
}

function rowToVersion(r: Record<string, unknown>): MarketplaceVersion {
  return {
    entryId: String(r.entry_id),
    version: String(r.version),
    changelog: r.changelog ? String(r.changelog) : null,
    releasedAt: r.released_at ? String(r.released_at) : null,
    minHostVersion: r.min_host_version ? String(r.min_host_version) : null,
    maxHostVersion: r.max_host_version ? String(r.max_host_version) : null,
    deprecated: Number(r.deprecated ?? 0) === 1,
    yanked: Number(r.yanked ?? 0) === 1,
    manifestChecksum: r.manifest_checksum ? String(r.manifest_checksum) : null,
    tarballChecksum: r.tarball_checksum ? String(r.tarball_checksum) : null
  };
}

function rowToInstalled(r: Record<string, unknown>): InstalledPlugin {
  return {
    id: String(r.id),
    npm: String(r.npm),
    version: String(r.version),
    installPath: String(r.install_path),
    installSource: String(r.install_source) as InstallSource,
    manifest: JSON.parse(String(r.manifest_json)) as PluginManifest,
    grantedPermissions: JSON.parse(String(r.granted_permissions_json)) as string[],
    state: String(r.state) as PluginState,
    errorMessage: r.error_message ? String(r.error_message) : null,
    marketplaceEntryId: r.marketplace_entry_id ? String(r.marketplace_entry_id) : null,
    installedAt: String(r.installed_at),
    updatedAt: String(r.updated_at)
  };
}
