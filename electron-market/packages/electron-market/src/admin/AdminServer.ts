import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { parse as parseUrl } from 'url';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname, join, normalize, resolve } from 'path';
import { shell } from 'electron';

import type { MarketplaceEntry as DbEntry } from '@qpjoy/marketplace-db';

import type { PluginRegistry } from '../registry/PluginRegistry';
import type { MarketplaceClient } from '../registry/MarketplaceClient';
import type { PluginStore } from '../store/PluginStore';
import type { PluginRuntime } from '../runtime/PluginRuntime';
import type { MarketplaceEntry as LegacyEntry } from '../types';
import { readSyncStatus, type RemoteSyncJob } from '../sync/RemoteSyncJob';
import type { AuthService } from '../sync/AuthService';
import { adminHtml } from './admin-ui';
import {
  META_KEY_MARKET_SERVER,
  MARKET_SERVER_DEFAULTS,
  resolveMarketServer,
  type MarketServerSource
} from '../createElectronPluginHost';

/** Map the DB row shape back to the legacy entry shape the admin UI expects. */
function toLegacyEntry(row: DbEntry): LegacyEntry & { visibility?: string } {
  return {
    id: row.id,
    npm: row.npm,
    name: row.name,
    description: row.description ?? '',
    versions: [row.latestVersion],
    latest: row.latestVersion,
    manifestUrl: row.manifestUrl ?? '',
    tarballUrl: row.tarballUrl ?? undefined,
    homepage: row.homepage ?? undefined,
    verified: row.verified,
    bootstrap: row.bootstrap,
    visibility: row.visibility
  };
}

/**
 * Where the built Quasar SPA lives on disk. The host package's build step
 * copies `packages/admin-ui/dist/` into `packages/electron-market/dist/admin-ui/`,
 * so when the package is published, `__dirname/../admin-ui/index.html` exists.
 *
 * When the SPA dist is missing (e.g. someone is running the host straight
 * from a half-built workspace), we fall back to the inline placeholder HTML
 * so the panel is still usable.
 */
const STATIC_ROOT = resolve(__dirname, '..', 'admin-ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

export interface AdminServerOptions {
  port: number;
  registry: PluginRegistry;
  marketplace: MarketplaceClient;
  store: PluginStore;
  runtime: PluginRuntime;
  /** Null when no remote server is configured. */
  remoteSync: RemoteSyncJob | null;
  auth: AuthService | null;
  /** Plugin ids that the host has a seed config for (i.e. can re-bootstrap locally). */
  seedIds: string[];
  reseed: (id: string) => Promise<void>;
  upgrade: (id: string, version?: string) => Promise<void>;
  serverBaseUrl: string | null;
  /** Which input layer produced `serverBaseUrl`. Used by the settings page
   * to render a "currently coming from env / explicit / meta / default" badge
   * so users understand whether their override is actually in effect. */
  serverBaseUrlSource: MarketServerSource;
  /** Whether the explicit `options.serverBaseUrl` was set by the caller
   * (and therefore meta_kv overrides will be ignored until restart with
   * a different option). Disables the settings UI in that case. */
  explicitServerBaseUrl: boolean;
  /** Same `app.isPackaged` we used at startup — needed to recompute the
   * effective URL after a settings write so we can echo it back. */
  isPackaged: boolean;
}

/**
 * Minimal HTTP API + single-page UI on http://127.0.0.1:<port>.
 *
 * Routes:
 *   GET  /                              → admin SPA
 *   GET  /api/plugins                   → installed plugins
 *   GET  /api/marketplace               → marketplace index
 *   POST /api/plugins/install           → { id, version }
 *   POST /api/plugins/:id/uninstall
 *   POST /api/plugins/:id/grant         → { permissions: Permission[] }
 *   POST /api/plugins/:id/activate
 *   POST /api/plugins/:id/deactivate
 *   GET  /api/plugins/:id/logs
 *
 * Bound to 127.0.0.1 only. Auth is intentionally omitted in this skeleton;
 * the production version reuses the same bearer-token pattern as
 * `@qpjoy/electron-tunnel`'s AdminServer.
 */
export class AdminServer {
  private server: Server | null = null;

  constructor(private readonly opts: AdminServerOptions) {}

  start(): void {
    if (this.server) return;
    this.server = createServer((req, res) => this.handle(req, res).catch((err) => {
      this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }));
    this.server.listen(this.opts.port, '127.0.0.1');
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = parseUrl(req.url ?? '/', true);
    const method = req.method ?? 'GET';

    // Static assets / SPA index.
    if (method === 'GET' && pathname && !pathname.startsWith('/api/')) {
      if (this.serveStatic(pathname, res)) return;
    }

    if (method === 'GET' && pathname === '/api/plugins') {
      return this.json(res, 200, this.opts.registry.list());
    }
    if (method === 'GET' && pathname === '/api/marketplace') {
      // Marketplace state is now sourced from the DB (seeded at first run +
      // refreshed by remote sync). The MarketplaceClient is still consulted
      // to surface "we tried to refresh and here's what happened" metadata.
      const result = await this.opts.marketplace.fetch();
      const dbEntries = this.opts.registry.marketplaceDb().listEntries();
      return this.json(res, 200, {
        generatedAt: result.index.generatedAt,
        // Prefer DB rows (richer / persisted); fall back to in-memory client
        // payload if the DB hasn't been migrated yet for some reason.
        entries: dbEntries.length > 0
          ? dbEntries.map(toLegacyEntry)
          : result.index.entries,
        source: result.source,
        remoteFetchedAt: result.remoteFetchedAt,
        remoteError: result.remoteError
      });
    }
    if (method === 'POST' && pathname === '/api/plugins/install') {
      const body = (await this.readJson(req)) as { id: string; version?: string };
      const entry = await this.opts.marketplace.resolve(body.id);
      if (!entry) return this.json(res, 404, { error: 'unknown plugin id' });
      const manifest = await this.opts.store.install({
        id: entry.id,
        npm: entry.npm,
        version: body.version ?? entry.latest
      });
      return this.json(res, 200, manifest);
    }

    // Offline / out-of-band install path. Useful before the network is up:
    //   POST /api/plugins/install-local
    //   { id, npm, source: { type: 'tarball' | 'local-dir', path } }
    if (method === 'POST' && pathname === '/api/plugins/install-local') {
      const body = (await this.readJson(req)) as {
        id: string;
        npm: string;
        source: { type: 'tarball' | 'local-dir'; path: string };
      };
      const manifest = await this.opts.store.installFrom({
        id: body.id,
        npm: body.npm,
        source: body.source
      });
      return this.json(res, 200, manifest);
    }

    const grantMatch = pathname?.match(/^\/api\/plugins\/([^/]+)\/grant$/);
    if (method === 'POST' && grantMatch) {
      const body = (await this.readJson(req)) as { permissions: string[] };
      this.opts.registry.grant(grantMatch[1], body.permissions as never);
      this.opts.registry.setState(grantMatch[1], 'installed');
      return this.json(res, 200, { ok: true });
    }

    const lifecycleMatch = pathname?.match(/^\/api\/plugins\/([^/]+)\/(activate|deactivate|uninstall)$/);
    if (method === 'POST' && lifecycleMatch) {
      const id = lifecycleMatch[1];
      const action = lifecycleMatch[2] as 'activate' | 'deactivate' | 'uninstall';
      if (action === 'activate') {
        await this.opts.runtime.activate(id);
      } else if (action === 'deactivate') {
        await this.opts.runtime.deactivate(id);
      } else {
        // Uninstall MUST drop the live instance first so ports + IPC
        // handlers + child processes are released before we delete the
        // install dir. Otherwise a follow-up reseed/install would hit
        // EADDRINUSE / "second handler" errors.
        await this.opts.runtime.deactivate(id).catch(() => undefined);
        await this.opts.store.uninstall(id);
      }
      return this.json(res, 200, { ok: true });
    }

    // Seed-only: which plugin ids does the host have local seed sources for?
    if (method === 'GET' && pathname === '/api/seed-config') {
      return this.json(res, 200, { seedIds: this.opts.seedIds });
    }

    // Force a re-bootstrap of a plugin from its locally-configured seed
    // source. Used by the marketplace card's "重新预装" button when an
    // uninstalled bootstrap plugin can't be re-fetched via npm because the
    // published package lacks `qpjoyPlugin` (or the host is offline).
    const reseedMatch = pathname?.match(/^\/api\/plugins\/([^/]+)\/reseed$/);
    if (method === 'POST' && reseedMatch) {
      try {
        await this.opts.reseed(reseedMatch[1]);
        return this.json(res, 200, { ok: true });
      } catch (err) {
        return this.json(res, 400, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Upgrade an installed plugin: deactivate → re-install at the target
    // version (defaults to marketplace latest) → reactivate.
    const upgradeMatch = pathname?.match(/^\/api\/plugins\/([^/]+)\/upgrade$/);
    if (method === 'POST' && upgradeMatch) {
      const body = (await this.readJson(req)) as { version?: string };
      try {
        await this.opts.upgrade(upgradeMatch[1], body.version);
        return this.json(res, 200, { ok: true });
      } catch (err) {
        return this.json(res, 400, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const logsMatch = pathname?.match(/^\/api\/plugins\/([^/]+)\/logs$/);
    if (method === 'GET' && logsMatch) {
      return this.json(res, 200, this.opts.registry.recentLogs(logsMatch[1]));
    }

    // Generic RPC into a plugin's `ctx.expose(...)` surface. Lets the SPA
    // drive plugin-specific actions (e.g. NotYet's ball visibility toggle)
    // without each plugin needing its own bespoke HTTP route.
    //
    //   POST /api/plugins/<id>/rpc
    //   { "method": "setVisible", "args": [false] }
    //
    // Returns whatever the exposed method returns (JSON-serialized).
    // Errors:
    //   404 — plugin not running / no exposed surface
    //   400 — method missing or argument validation fails inside the plugin
    const rpcMatch = pathname?.match(/^\/api\/plugins\/([^/]+)\/rpc$/);
    if (method === 'POST' && rpcMatch) {
      const id = rpcMatch[1];
      const body = (await this.readJson(req)) as { method?: string; args?: unknown[] };
      if (!body.method || typeof body.method !== 'string') {
        return this.json(res, 400, { error: 'method (string) is required' });
      }
      const exposed = this.opts.runtime.getExposed(id);
      if (!exposed) {
        return this.json(res, 404, { error: `plugin "${id}" is not active or did not expose any methods` });
      }
      const fn = exposed[body.method];
      if (typeof fn !== 'function') {
        return this.json(res, 404, { error: `plugin "${id}" did not expose "${body.method}"` });
      }
      const args = Array.isArray(body.args) ? body.args : [];
      try {
        const result = await fn(...args);
        return this.json(res, 200, { ok: true, result: result ?? null });
      } catch (err) {
        return this.json(res, 400, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // ── Open external URL via the system default browser ───────────────
    //
    // The SPA cannot rely on `target="_blank"` for plugin homepages: the
    // Electron BrowserWindow that handles `window.open` inherits the host
    // app's session (proxy, cookies, etc.). For a marketing "go to project
    // homepage" link we want the user's actual browser, not a sandboxed
    // Electron window. `shell.openExternal` hands the URL off to the OS,
    // bypassing Electron entirely.
    //
    // For safety: only http(s) URLs are allowed. file:// and custom schemes
    // would be a code-execution vector via shell.openExternal.
    if (method === 'POST' && pathname === '/api/open-external') {
      const body = (await this.readJson(req)) as { url?: string };
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!url || !/^https?:\/\//i.test(url)) {
        return this.json(res, 400, {
          error: 'url must be an http:// or https:// URL'
        });
      }
      try {
        await shell.openExternal(url);
        return this.json(res, 200, { ok: true });
      } catch (err) {
        return this.json(res, 500, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // ── Settings: marketplace server URL ──────────────────────────────
    //
    // GET  /api/settings/market-server      → current resolution + override
    // PUT  /api/settings/market-server      → { url: string | null }
    //
    // Writes are persisted to meta_kv so they survive restarts. Hot-swapping
    // the live RemoteClient is intentionally not supported: it would mean
    // re-creating the sync job + auth service + invalidating any in-flight
    // token refresh, which is more risk than it's worth. We just persist
    // and tell the SPA to prompt the user to restart.
    if (pathname === '/api/settings/market-server') {
      const db = this.opts.registry.marketplaceDb();
      if (method === 'GET') {
        const userOverride = db.getMeta(META_KEY_MARKET_SERVER);
        // Recompute as if we were starting fresh, so the UI shows what would
        // win on next restart (e.g. after the user just cleared the override).
        const wouldResolve = resolveMarketServer(
          this.opts.explicitServerBaseUrl ? (this.opts.serverBaseUrl ?? '') : undefined,
          this.opts.isPackaged,
          userOverride
        );
        return this.json(res, 200, {
          effective: {
            url: this.opts.serverBaseUrl,
            source: this.opts.serverBaseUrlSource
          },
          nextRestart: wouldResolve,
          userOverride,
          explicitLocked: this.opts.explicitServerBaseUrl,
          envLocked: process.env.QPJOY_MARKET_SERVER !== undefined,
          defaults: MARKET_SERVER_DEFAULTS,
          isPackaged: this.opts.isPackaged
        });
      }
      if (method === 'PUT') {
        if (this.opts.explicitServerBaseUrl) {
          return this.json(res, 400, {
            error: 'marketplace URL is locked by the host app (explicit serverBaseUrl option)'
          });
        }
        const body = (await this.readJson(req)) as { url?: string | null };
        const incoming = body.url;
        if (incoming === null || incoming === '' || incoming === undefined) {
          // Clear override → fall back to env / built-in default.
          db.setMeta(META_KEY_MARKET_SERVER, '');
        } else {
          if (typeof incoming !== 'string') {
            return this.json(res, 400, { error: 'url must be a string or null' });
          }
          const trimmed = incoming.trim();
          if (trimmed && !/^https?:\/\//i.test(trimmed)) {
            return this.json(res, 400, { error: 'url must start with http:// or https://' });
          }
          db.setMeta(META_KEY_MARKET_SERVER, trimmed.replace(/\/+$/, ''));
        }
        const userOverride = db.getMeta(META_KEY_MARKET_SERVER);
        const wouldResolve = resolveMarketServer(undefined, this.opts.isPackaged, userOverride);
        return this.json(res, 200, {
          ok: true,
          userOverride,
          nextRestart: wouldResolve,
          restartRequired: wouldResolve.url !== this.opts.serverBaseUrl
        });
      }
    }

    // Sync status / manual trigger.
    if (method === 'GET' && pathname === '/api/sync') {
      const status = readSyncStatus(
        this.opts.registry.marketplaceDb(),
        this.opts.serverBaseUrl
      );
      return this.json(res, 200, status);
    }
    if (method === 'POST' && pathname === '/api/sync') {
      if (!this.opts.remoteSync) {
        return this.json(res, 400, { error: 'remote sync not configured (set serverBaseUrl)' });
      }
      const result = await this.opts.remoteSync.run('manual');
      return this.json(res, 200, result);
    }

    // Auth relay — same shape as electron-server but proxied so the
    // SPA only ever talks to its same-origin host, and tokens land in
    // marketplace-db where everything else can read them.
    if (method === 'GET' && pathname === '/api/auth/state') {
      if (!this.opts.auth) {
        return this.json(res, 200, { user: null, configured: false });
      }
      const state = this.opts.auth.state();
      return this.json(res, 200, { ...state, configured: true });
    }
    if (method === 'POST' && pathname === '/api/auth/login') {
      if (!this.opts.auth) return this.json(res, 400, { error: 'auth not configured' });
      const body = (await this.readJson(req)) as { identifier?: string; password?: string };
      if (!body.identifier || !body.password) {
        return this.json(res, 400, { error: 'identifier and password required' });
      }
      try {
        const state = await this.opts.auth.login(body.identifier, body.password);
        return this.json(res, 200, state);
      } catch (err) {
        return this.json(res, 401, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (method === 'POST' && pathname === '/api/auth/register') {
      if (!this.opts.auth) return this.json(res, 400, { error: 'auth not configured' });
      const body = (await this.readJson(req)) as Record<string, string>;
      if (!body.password) return this.json(res, 400, { error: 'password required' });
      try {
        const state = await this.opts.auth.register({
          username: body.username,
          email: body.email,
          phone: body.phone,
          password: body.password,
          displayName: body.displayName,
          verificationCode: body.verificationCode
        });
        return this.json(res, 200, state);
      } catch (err) {
        return this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (method === 'POST' && pathname === '/api/auth/logout') {
      if (!this.opts.auth) return this.json(res, 400, { error: 'auth not configured' });
      await this.opts.auth.clearSession();
      return this.json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/api/auth/code') {
      if (!this.opts.auth) return this.json(res, 400, { error: 'auth not configured' });
      const body = (await this.readJson(req)) as {
        channel?: 'email' | 'sms';
        destination?: string;
        purpose?: 'register' | 'login' | 'reset';
      };
      if (!body.channel || !body.destination || !body.purpose) {
        return this.json(res, 400, { error: 'channel, destination, purpose required' });
      }
      try {
        const out = await this.opts.auth.requestCode({
          channel: body.channel,
          destination: body.destination,
          purpose: body.purpose
        });
        return this.json(res, 200, out);
      } catch (err) {
        return this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.json(res, 404, { error: 'not found', path: pathname });
  }

  /**
   * Serve a file from the built admin SPA. Returns true if a response was
   * sent. Falls back to the placeholder HTML when the dist hasn't been
   * built — that way smoke tests and bare `pnpm typecheck` flows keep
   * working without insisting on a Vue build.
   */
  private serveStatic(pathname: string, res: ServerResponse): boolean {
    if (!existsSync(STATIC_ROOT)) {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(adminHtml());
        return true;
      }
      return false;
    }

    // Normalize and lock to STATIC_ROOT — refuse path traversal.
    const clean = normalize(pathname).replace(/^\/+/, '');
    const candidate = clean === '' || clean === '/' ? 'index.html' : clean;
    const filePath = join(STATIC_ROOT, candidate);
    if (!filePath.startsWith(STATIC_ROOT)) {
      res.writeHead(403);
      res.end();
      return true;
    }

    // SPA fallback: any non-asset route returns index.html so vue-router
    // (hash mode) still bootstraps correctly.
    const target = existsSync(filePath) && statSync(filePath).isFile()
      ? filePath
      : join(STATIC_ROOT, 'index.html');

    const mime = MIME[extname(target)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
    createReadStream(target).pipe(res);
    return true;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(data);
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }
}
