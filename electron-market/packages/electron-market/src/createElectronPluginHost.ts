import { existsSync, readFileSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import type { App, IpcMain, Session } from 'electron';

import type { Permission } from '@qpjoy/electron-plugin-sdk';
import { MarketplaceDB, resolveMarketplaceDbPath } from '@qpjoy/marketplace-db';

import { PluginRegistry } from './registry/PluginRegistry';
import { MarketplaceClient } from './registry/MarketplaceClient';
import { PluginStore, type PluginSource } from './store/PluginStore';
import { PluginRuntime } from './runtime/PluginRuntime';
import { AdminServer } from './admin/AdminServer';
import { registerPluginHostIpc } from './ipc/registerPluginHostIpc';
import { RemoteClient } from './sync/RemoteClient';
import { RemoteSyncJob } from './sync/RemoteSyncJob';
import { AuthService } from './sync/AuthService';

/**
 * Built-in marketplace server endpoints.
 *
 * Consumer apps that install `@qpjoy/electron-market` from npm should never
 * have to think about these — the package picks the right one based on
 * `app.isPackaged`. Pass `serverBaseUrl: null` to `createElectronPluginHost`
 * for explicit offline mode.
 *
 * **Maintainer note**: when the production deployment goes live, swap the
 * placeholder `PROD_MARKET_SERVER` for the real VPS URL and publish a
 * patch release. Until then packaged apps default to offline + seed data.
 */
const DEV_MARKET_SERVER = 'http://127.0.0.1:8080';
/**
 * Production marketplace URL. Intentionally `null` until a real
 * deployment exists — that way:
 *
 *   - A packaged consumer app that doesn't override this defaults to
 *     **offline mode**: bundled seed-index drives the marketplace cards,
 *     no failed network calls to a placeholder domain on every boot.
 *   - When you do have a prod server, either:
 *       a. set it permanently here and republish electron-market, or
 *       b. host apps pass `serverBaseUrl: 'https://your-server'` to
 *          `createElectronMarket(...)`, or
 *       c. end users flip it on at runtime via the SPA's Settings page
 *          (persisted to `meta_kv['settings.marketServer']`).
 */
const PROD_MARKET_SERVER: string | null = null;

/**
 * `meta_kv` key holding the user-set marketplace URL override. Written
 * by the SPA's Settings page; read here at host startup. Empty / missing
 * means "no override — fall back to the built-in default".
 *
 * Exported so the admin server and the SPA composable can use the same
 * key without drift.
 */
export const META_KEY_MARKET_SERVER = 'settings.marketServer';

export type MarketServerSource = 'explicit' | 'env' | 'meta' | 'default-dev' | 'default-prod' | 'offline';

export interface ResolvedMarketServer {
  /** The URL we'll actually use, or null for offline mode. */
  url: string | null;
  /** Which input layer won. */
  source: MarketServerSource;
}

/**
 * Resolves the marketplace server URL. Priority order:
 *
 *   1. `options.serverBaseUrl` explicitly passed by the caller. Pass `null`
 *      or empty string here for offline-only mode.
 *   2. `process.env.QPJOY_MARKET_SERVER` — undocumented escape hatch for
 *      QPJoy-team development workflows (e.g. pointing at a staging URL
 *      from the shell without code edits).
 *   3. `meta_kv['settings.marketServer']` — runtime override the user can
 *      flip from the SPA Settings page. Survives restarts; lets us swap
 *      between multiple deployments (staging / prod / self-hosted) and
 *      lets end-users point at their own backend without a new release.
 *   4. Built-in defaults: dev gets local docker, packaged gets prod.
 *
 * Returns `{ url: null, source: 'offline' }` when offline mode should be used.
 */
export function resolveMarketServer(
  explicit: string | null | undefined,
  isPackaged: boolean,
  metaOverride: string | null
): ResolvedMarketServer {
  if (explicit !== undefined) {
    if (!explicit) return { url: null, source: 'offline' };
    const trimmed = explicit.trim().replace(/\/+$/, '');
    return trimmed ? { url: trimmed, source: 'explicit' } : { url: null, source: 'offline' };
  }
  const envOverride = process.env.QPJOY_MARKET_SERVER;
  if (envOverride !== undefined) {
    const trimmed = envOverride.trim();
    if (!trimmed || trimmed === '0' || trimmed === 'false') return { url: null, source: 'offline' };
    return { url: trimmed.replace(/\/+$/, ''), source: 'env' };
  }
  if (metaOverride) {
    const trimmed = metaOverride.trim();
    if (trimmed === '0' || trimmed === 'false' || trimmed === '') {
      return { url: null, source: 'offline' };
    }
    return { url: trimmed.replace(/\/+$/, ''), source: 'meta' };
  }
  if (isPackaged) {
    return PROD_MARKET_SERVER
      ? { url: PROD_MARKET_SERVER, source: 'default-prod' }
      : { url: null, source: 'offline' };
  }
  return { url: DEV_MARKET_SERVER, source: 'default-dev' };
}

/** Exposed so the admin layer can render "default" / "current" hints. */
export const MARKET_SERVER_DEFAULTS = {
  dev: DEV_MARKET_SERVER,
  prod: PROD_MARKET_SERVER
} as const;

/**
 * Description of a plugin that the host wants to make sure is present on
 * disk before the marketplace ever does a network call.
 *
 * The classic case is `@qpjoy/electron-plugin-tunnel` itself: the user might not
 * have any outbound connectivity yet, so we install the tunnel offline from
 * a bundled tarball / dir, activate it, and *then* the marketplace can
 * download anything else through the tunnel.
 *
 * Seeds are idempotent: if a matching record already exists in the registry
 * at the same-or-newer version, nothing happens. Optional `autoGrant`
 * pre-approves permissions so the seed boots straight into `active` —
 * useful for first-party seeds shipped with your installer.
 */
export interface SeedPlugin {
  id: string;
  npm: string;
  source: PluginSource;
  autoGrant?: Permission[] | 'manifest';
  autoActivate?: boolean;
}

export interface CreateElectronPluginHostOptions {
  /** Override userData if needed (defaults to `app.getPath('userData')`). */
  userDataPath?: string;
  /** Admin panel port. Defaults to 23455. */
  adminPort?: number;
  /**
   * Legacy single-file remote index URL (kept for back-compat).
   * If set, the in-memory `MarketplaceClient` will use it for the
   * never-500 fallback. Prefer `serverBaseUrl` for the full Phase 4 sync.
   */
  marketplaceUrl?: string;
  /**
   * Marketplace server URL.
   *
   * Most consumers should leave this **unset** — the package bakes in the
   * right default for dev (`http://127.0.0.1:8080`) and production (the
   * official VPS) based on `app.isPackaged`.
   *
   * Set to `null` (or empty string) for offline-only mode.
   * Set to a custom URL to point at a different deployment.
   */
  serverBaseUrl?: string | null;
  /** How often to sync (ms). 0 = startup only. Default 10 min. */
  syncIntervalMs?: number;
  /** If false, do not start the admin server automatically. */
  startAdminServer?: boolean;
  /** If false, do not auto-activate plugins with `onStartup`. */
  autoActivate?: boolean;
  /**
   * Plugins to ensure are installed before any marketplace traffic happens.
   * Run sequentially in the order given. Failures are logged but never abort
   * host startup — the marketplace stays usable even if a seed fails.
   */
  seedPlugins?: SeedPlugin[];
}

export interface ElectronPluginHostHandle {
  registry: PluginRegistry;
  marketplace: MarketplaceClient;
  store: PluginStore;
  runtime: PluginRuntime;
  admin: AdminServer;
  /** Null if `serverBaseUrl` wasn't provided. */
  remoteSync: RemoteSyncJob | null;
  /** Null if `serverBaseUrl` wasn't provided. */
  auth: AuthService | null;
  /** Plugin ids that were configured as seeds. Used by the UI to render
   * "重新预装" instead of "安装" for them. */
  seedIds: string[];
  /** Force-reseed a single plugin (must be in `seedIds`). */
  reseed(id: string): Promise<void>;
  /** Upgrade an installed plugin to a target version (defaults to latest). */
  upgrade(id: string, version?: string): Promise<void>;
  /**
   * Resolves after the seed install + `activateAllOnStartup` pass has run.
   * Wire your IPC handlers behind this if they need the seeded plugins to
   * be active before responding.
   */
  ready: Promise<void>;
  close(): Promise<void>;
}

export function createElectronPluginHost(
  host: { app: App; ipcMain: IpcMain; session: Session },
  options: CreateElectronPluginHostOptions = {}
): ElectronPluginHostHandle {
  const userDataPath = options.userDataPath ?? host.app.getPath('userData');
  const pluginsRoot = join(userDataPath, 'plugins');
  const dbPath = resolveMarketplaceDbPath(userDataPath);
  const adminPort = options.adminPort ?? 23455;

  // Open the shared marketplace DB exactly once for the host. If a standalone
  // plugin (e.g. tunnel) already opened it earlier in this process, our DB
  // instance can still coexist — better-sqlite3 + WAL handles it.
  const marketplaceDb = MarketplaceDB.open(dbPath);
  const registry = new PluginRegistry(marketplaceDb);

  // First-run / never-synced seeding: if no marketplace entries exist yet,
  // populate from the package-bundled `seed-index.json`. That way the UI is
  // never empty even on an air-gapped device.
  mergeBundledMarketplaceSeed(marketplaceDb);
  const store = new PluginStore({ pluginsRoot, registry });
  // No default URL — without an explicit `marketplaceUrl` we serve only the
  // bundled seed. That keeps the app fully usable offline; consumers opt
  // into network traffic by providing a URL.
  const marketplace = new MarketplaceClient({
    indexUrl: options.marketplaceUrl
  });
  const runtime = new PluginRuntime({
    host,
    registry,
    pluginsRoot
  });

  // Resolve the marketplace server URL once, applying built-in defaults so
  // consumers don't have to think about this. `null` means offline. The
  // user-set override from `meta_kv` (managed by the SPA Settings page)
  // wins over built-in defaults but loses to explicit caller / env values.
  const metaOverride = marketplaceDb.getMeta(META_KEY_MARKET_SERVER);
  const resolved = resolveMarketServer(
    options.serverBaseUrl,
    host.app.isPackaged,
    metaOverride
  );
  const serverBaseUrl = resolved.url;
  if (resolved.source === 'meta') {
    // eslint-disable-next-line no-console
    console.log(
      `[electron-market] using marketplace URL from user settings: ${serverBaseUrl}`
    );
  }

  // Phase 4 remote sync + Phase 5 auth. Only spun up when a server URL is
  // resolved (either via caller / env override or via the package default).
  let remoteClient: RemoteClient | null = null;
  let auth: AuthService | null = null;
  let remoteSync: RemoteSyncJob | null = null;
  if (serverBaseUrl) {
    remoteClient = new RemoteClient({
      baseUrl: serverBaseUrl,
      getAccessToken: () => marketplaceDb.getActiveSession()?.accessToken ?? null,
      getRefreshToken: () => marketplaceDb.getActiveSession()?.refreshToken ?? null,
      onTokensRefreshed: (tokens) => {
        const session = marketplaceDb.getActiveSession();
        if (!session) return;
        marketplaceDb.setSession({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.accessExpiresAt,
          user: session.user
        });
      },
      onAuthExpired: () => marketplaceDb.clearSession()
    });
    auth = new AuthService({ db: marketplaceDb, client: remoteClient });
    remoteSync = new RemoteSyncJob({
      db: marketplaceDb,
      client: remoteClient,
      intervalMs: options.syncIntervalMs
    });
  }

  const seedIds = (options.seedPlugins ?? []).map((s) => s.id);

  const admin = new AdminServer({
    port: adminPort,
    registry,
    marketplace,
    store,
    runtime,
    remoteSync,
    auth,
    seedIds,
    reseed: reseedOne,
    upgrade: upgradePlugin,
    serverBaseUrl,
    serverBaseUrlSource: resolved.source,
    explicitServerBaseUrl: options.serverBaseUrl !== undefined,
    isPackaged: host.app.isPackaged
  });

  if (options.startAdminServer !== false) {
    admin.start();
  }

  registerPluginHostIpc(host.ipcMain, {
    registry,
    marketplace,
    store,
    runtime,
    remoteSync,
    auth,
    seedIds,
    reseed: reseedOne,
    upgrade: upgradePlugin,
    serverBaseUrl
  });

  // ── Seed bookkeeping ────────────────────────────────────────────────
  //
  // We track whether a seed was ever installed via a meta_kv key:
  //   seed.<id>.installed_at
  //
  // Decision matrix at startup (force=false):
  //
  //   record exists, state ∈ {installed, active, awaitingGrant, disabled}
  //     → already there, skip
  //   record exists, state = errored
  //     → re-seed (recover)
  //   no record + no marker
  //     → first-ever seed, run it
  //   no record + marker present
  //     → user explicitly uninstalled previously, respect that, skip
  //
  // Force mode (the "重新预装" button) always runs and refreshes the marker.
  function seedMarkerKey(id: string): string {
    return `seed.${id}.installed_at`;
  }

  /**
   * Sanity check for an existing seeded install: do we still have a
   * `node_modules/<npm>/package.json` reachable through the install path?
   *
   * This catches the "stale install" failure mode common when an app's
   * `userData` survives across redeploys:
   *
   *   - Dev built a packaged app → packaged ran with the same userData →
   *     dev later rebuilt the workspace and ran `pnpm dev` again → the seed
   *     install symlink still points at the workspace path that worked at
   *     install time, but the workspace's node_modules have been re-laid-out
   *     by pnpm (or contain a different ABI's native module).
   *
   * Detecting unreachable installs lets us silently re-seed instead of
   * leaving the user staring at a red "出错" state until they manually
   * trigger "重新预装". Cheap: just one existsSync per seed.
   */
  function seedInstallReachable(record: { installPath: string; npm: string }): boolean {
    try {
      const pkgJson = join(record.installPath, 'node_modules', record.npm, 'package.json');
      // existsSync follows symlinks — returns false on broken / unresolvable
      // chains. Exactly what we want.
      return existsSync(pkgJson);
    } catch {
      return false;
    }
  }

  async function runSeed(seed: SeedPlugin, opts: { force?: boolean } = {}): Promise<void> {
    try {
      const existing = registry.get(seed.id);

      // Backfill: if there's an existing install but no marker yet (legacy
      // user from before this change), set the marker so a future uninstall
      // is persistently respected.
      if (existing && !marketplaceDb.getMeta(seedMarkerKey(seed.id))) {
        marketplaceDb.setMeta(seedMarkerKey(seed.id), new Date().toISOString());
      }

      if (!opts.force) {
        if (existing && existing.state !== 'errored' && seedInstallReachable(existing)) {
          // Already installed, healthy, and the files are still reachable —
          // nothing to do.
          return;
        }
        if (existing && existing.state !== 'errored' && !seedInstallReachable(existing)) {
          // State says "active" but the install is gone (dev/packaged userData
          // crossover, deleted source workspace, etc.). Fall through to re-seed.
          registry.log(seed.id, 'warn', 'seed install unreachable — re-seeding', {
            installPath: existing.installPath
          });
        }
        if (!existing && marketplaceDb.getMeta(seedMarkerKey(seed.id))) {
          // No record but we've seeded this id before → user uninstalled.
          // Don't auto-reinstall. They can hit "重新预装" if they want it back.
          registry.log(seed.id, 'info', 'seed skipped: user previously uninstalled', {
            source: seed.source.type
          });
          return;
        }
      }

      if (existing && existsSync(existing.installPath)) {
        await rm(existing.installPath, { recursive: true, force: true });
      }
      if (existing) registry.remove(seed.id);

      // FK guard: `installed_plugins.marketplace_entry_id` references
      // `marketplace_entries(id)`. A seed bundled locally that isn't yet in
      // the marketplace catalogue (not in seed-index, not yet on the server)
      // would otherwise blow up with `SQLITE_CONSTRAINT_FOREIGNKEY` at install
      // time. Write a minimal placeholder row first; the merge from bundled
      // seed-index / next server sync will enrich it.
      if (!marketplaceDb.getEntry(seed.id)) {
        marketplaceDb.bulkUpsertEntries([
          {
            id: seed.id,
            npm: seed.npm,
            name: seed.id,
            description: null,
            latestVersion: '0.0.0', // overwritten by manifest version below
            manifestUrl: null,
            tarballUrl: null,
            homepage: null,
            author: null,
            category: null,
            verified: false,
            bootstrap: false,
            visibility: 'public',
            specVersion: 1,
            metadata: null,
            source: 'seed',
            fetchedAt: null
          }
        ]);
      }

      const manifest = await store.installFrom({
        id: seed.id,
        npm: seed.npm,
        source: seed.source
      });

      // Now we have real manifest data — backfill the catalogue row so the
      // marketplace card shows the right name / version / description.
      const currentEntry = marketplaceDb.getEntry(seed.id);
      if (currentEntry && (currentEntry.name === seed.id || currentEntry.latestVersion === '0.0.0')) {
        marketplaceDb.bulkUpsertEntries([
          {
            ...currentEntry,
            name: manifest.name || seed.id,
            description: manifest.description ?? currentEntry.description ?? null,
            latestVersion: manifest.version,
            homepage: manifest.homepage ?? currentEntry.homepage ?? null
          }
        ]);
      }
      const grants =
        seed.autoGrant === 'manifest'
          ? manifest.permissions
          : seed.autoGrant ?? [];
      if (grants.length > 0) {
        registry.grant(seed.id, grants);
        registry.setState(seed.id, 'installed');
      }

      // Mark "we have seeded this id" so future boots respect uninstalls.
      marketplaceDb.setMeta(seedMarkerKey(seed.id), new Date().toISOString());

      registry.log(seed.id, 'info', 'seed installed', {
        source: seed.source.type,
        version: manifest.version,
        reseeded: Boolean(existing),
        forced: Boolean(opts.force)
      });

      // On a forced reseed we ALSO re-activate so the user doesn't need
      // a separate click — that's the point of "重新预装".
      if (opts.force && manifest.activationEvents.includes('onStartup')) {
        await runtime.activate(seed.id).catch((err) => {
          registry.log(seed.id, 'error', 'reseed activation failed', {
            error: String(err)
          });
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[electron-market] seed "${seed.id}" failed:`, err);
      registry.log(seed.id, 'error', 'seed install failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      if (opts.force) throw err; // surface to the SPA toast on manual reseed
    }
  }

  async function reseedOne(id: string): Promise<void> {
    const seed = options.seedPlugins?.find((s) => s.id === id);
    if (!seed) {
      throw new Error(`no seed config for plugin "${id}"`);
    }
    await runSeed(seed, { force: true });
  }

  /**
   * Upgrade an installed plugin to a different version from the marketplace.
   * Wraps the deactivate → install → activate dance so the SPA can call
   * this with a single click and not have to manage the lifecycle itself.
   *
   * The version arg is optional: if omitted, the latest entry in the
   * marketplace cache is used (set by `RemoteSyncJob`).
   */
  async function upgradePlugin(id: string, version?: string): Promise<void> {
    const existing = registry.get(id);
    if (!existing) throw new Error(`not installed: ${id}`);

    // Resolve target version from the marketplace if not specified.
    let target = version;
    const entry = marketplaceDb.getEntry(id);
    if (!target) {
      if (!entry) throw new Error(`no marketplace entry for ${id}`);
      target = entry.latestVersion;
    }
    if (target === existing.version) {
      registry.log(id, 'info', 'upgrade skipped: already on target version', { version: target });
      return;
    }

    const wasActive = existing.state === 'active';
    if (wasActive) {
      await runtime.deactivate(id).catch(() => undefined);
    }

    await store.upgrade(id, {
      type: 'registry',
      version: target,
      tarballUrl: entry && target === entry.latestVersion ? entry.tarballUrl : null
    });

    // Re-activate if we tore it down AND grants survived; if the new
    // manifest demanded new permissions we leave it `awaitingGrant`.
    const after = registry.get(id);
    if (wasActive && after?.state === 'installed') {
      await runtime.activate(id);
    }

    registry.log(id, 'info', 'upgrade complete', {
      from: existing.version,
      to: target
    });
  }

  // Seed → then auto-activate. Both are best-effort; failures get logged
  // to the per-plugin log table (or stderr if no record exists yet).
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  queueMicrotask(async () => {
    if (options.seedPlugins?.length) {
      for (const seed of options.seedPlugins) {
        await runSeed(seed);
      }
    }

    if (options.autoActivate !== false) {
      await runtime.activateAllOnStartup().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[electron-market] startup activation failed', err);
      });
    }

    // Kick off remote sync *after* activation so a slow server can't block
    // user-visible boot. The job runs immediately then schedules itself.
    remoteSync?.start();

    resolveReady();
  });

  return {
    registry,
    marketplace,
    store,
    runtime,
    admin,
    remoteSync,
    auth,
    seedIds,
    reseed: reseedOne,
    upgrade: upgradePlugin,
    ready,
    async close() {
      remoteSync?.stop();
      admin.stop();
      await runtime.deactivateAll();
      registry.close();
      marketplaceDb.close();
    }
  };
}

/**
 * Merge the bundled seed JSON (`dist/seed-index.json`) into `marketplace_entries`.
 * Previously this only ran on a totally empty DB ("seed if empty"). That was
 * wrong: any new entry the host package ships in a later release would never
 * land on existing installs — and seeded plugins whose marketplace_entries row
 * never got created would 100% fail on install with a FK constraint violation.
 *
 * Now we **merge** every boot:
 *   - Bundled entries not yet in the DB → inserted with `source: 'seed'`.
 *   - Bundled entries already present (most likely from a previous boot or
 *     from a server sync) → left alone, since the live server / a fresher
 *     seed has authoritative version data we don't want to clobber.
 *
 * Cheap (one query + N upserts; N is typically <10). Idempotent.
 */
function mergeBundledMarketplaceSeed(db: MarketplaceDB): void {
  const seedPath = resolve(__dirname, 'seed-index.json');
  if (!existsSync(seedPath)) return;

  let entries: Array<{
    id: string;
    npm: string;
    name: string;
    description?: string;
    latest: string;
    manifestUrl?: string;
    tarballUrl?: string;
    homepage?: string;
    author?: string;
    category?: string;
    verified?: boolean;
    bootstrap?: boolean;
    visibility?: 'public' | 'free' | 'paid' | 'private';
    specVersion?: number;
    metadata?: Record<string, unknown> | null;
  }> = [];

  try {
    const raw = readFileSync(seedPath, 'utf8');
    const index = JSON.parse(raw) as { entries?: typeof entries };
    entries = index.entries ?? [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[electron-market] failed to parse bundled seed-index.json:', err);
    return;
  }

  // Only insert entries that don't already have a row — never overwrite live
  // data (a server sync may have refreshed `latestVersion` since this build).
  const existingIds = new Set(db.listEntries().map((e) => e.id));
  const toInsert = entries.filter((e) => !existingIds.has(e.id));
  if (toInsert.length === 0) return;

  try {
    db.bulkUpsertEntries(
      toInsert.map((e) => ({
        id: e.id,
        npm: e.npm,
        name: e.name,
        description: e.description ?? null,
        latestVersion: e.latest,
        manifestUrl: e.manifestUrl ?? null,
        tarballUrl: e.tarballUrl ?? null,
        homepage: e.homepage ?? null,
        author: e.author ?? null,
        category: e.category ?? null,
        verified: Boolean(e.verified),
        bootstrap: Boolean(e.bootstrap),
        visibility: e.visibility ?? 'public',
        specVersion: e.specVersion ?? 1,
        metadata: e.metadata ?? null,
        source: 'seed',
        fetchedAt: null
      }))
    );
    // eslint-disable-next-line no-console
    console.log(
      `[electron-market] merged ${toInsert.length} bundled marketplace entries: ${toInsert.map((e) => e.id).join(', ')}`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[electron-market] failed to merge bundled marketplace entries:', err);
  }
}
