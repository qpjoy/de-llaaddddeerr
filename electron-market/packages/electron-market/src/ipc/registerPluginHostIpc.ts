import { Buffer } from 'node:buffer';

import type { IpcMain, Session } from 'electron';

import type { MarketplaceEntry as DbEntry } from '@qpjoy/marketplace-db';

import type { PluginRegistry } from '../registry/PluginRegistry';
import type { MarketplaceClient } from '../registry/MarketplaceClient';
import type { PluginStore } from '../store/PluginStore';
import type { PluginRuntime } from '../runtime/PluginRuntime';
import type { MarketplaceEntry as LegacyEntry } from '../types';
import { readSyncStatus, type RemoteSyncJob } from '../sync/RemoteSyncJob';
import type { AuthService } from '../sync/AuthService';
import { MARKETPLACE_SELF_PLUGIN_ID } from '../constants';
import { isUserInstallableMarketplaceEntry } from '../marketplaceFilters';

interface Deps {
  registry: PluginRegistry;
  marketplace: MarketplaceClient;
  store: PluginStore;
  runtime: PluginRuntime;
  remoteSync: RemoteSyncJob | null;
  auth: AuthService | null;
  seedIds: string[];
  reseed: (id: string) => Promise<void>;
  upgrade: (id: string, version?: string) => Promise<void>;
  serverBaseUrl: string | null;
  session: Session;
}

type TunnelRuntimeMode = 'app-rule' | 'app-global' | 'system-tun';

const TUNNEL_PLUGIN_ID = 'qpjoy.electron-tunnel';
const HDO_PLUGIN_ID = 'qpjoy.electron-plugin-hdo';

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
    category: row.category,
    verified: row.verified,
    bootstrap: row.bootstrap,
    metadata: row.metadata,
    visibility: row.visibility
  };
}

async function resolveMarketplaceEntry(
  deps: Deps,
  id: string
): Promise<(Pick<LegacyEntry, 'id' | 'npm' | 'latest'> & { tarballUrl?: string }) | null> {
  const dbEntry = deps.registry.marketplaceDb().getEntry(id);
  if (dbEntry && !isUserInstallableMarketplaceEntry(dbEntry)) return null;
  if (dbEntry) {
    return {
      id: dbEntry.id,
      npm: dbEntry.npm,
      latest: dbEntry.latestVersion,
      tarballUrl: dbEntry.tarballUrl ?? undefined
    };
  }

  const legacyEntry = await deps.marketplace.resolve(id);
  if (legacyEntry && !isUserInstallableMarketplaceEntry(legacyEntry)) return null;
  return legacyEntry
    ? {
        id: legacyEntry.id,
        npm: legacyEntry.npm,
        latest: legacyEntry.latest,
        tarballUrl: legacyEntry.tarballUrl
      }
    : null;
}

async function tunnelExposed(deps: Deps): Promise<Record<string, (...args: unknown[]) => unknown>> {
  let exposed = deps.runtime.getExposed(TUNNEL_PLUGIN_ID);
  if (!exposed && deps.registry.get(TUNNEL_PLUGIN_ID)) {
    await deps.runtime.activate(TUNNEL_PLUGIN_ID);
    exposed = deps.runtime.getExposed(TUNNEL_PLUGIN_ID);
  }
  if (!exposed) {
    throw new Error('Tunnel plugin is not active. Install and activate @qpjoy/electron-plugin-tunnel first.');
  }
  return exposed;
}

async function tunnelCall<T = unknown>(deps: Deps, method: string, ...args: unknown[]): Promise<T> {
  const exposed = await tunnelExposed(deps);
  const fn = exposed[method];
  if (typeof fn !== 'function') {
    throw new Error(`Tunnel plugin did not expose "${method}"`);
  }
  return await fn(...args) as T;
}

async function hdoExposed(deps: Deps): Promise<Record<string, (...args: unknown[]) => unknown>> {
  let exposed = deps.runtime.getExposed(HDO_PLUGIN_ID);
  if (!exposed && deps.registry.get(HDO_PLUGIN_ID)) {
    await deps.runtime.activate(HDO_PLUGIN_ID);
    exposed = deps.runtime.getExposed(HDO_PLUGIN_ID);
  }
  if (!exposed) {
    throw new Error('HDO plugin is not active. Install and activate @qpjoy/electron-plugin-hdo first.');
  }
  return exposed;
}

async function hdoCall<T = unknown>(deps: Deps, method: string, ...args: unknown[]): Promise<T> {
  const exposed = await hdoExposed(deps);
  const fn = exposed[method];
  if (typeof fn !== 'function') {
    throw new Error(`HDO plugin did not expose "${method}"`);
  }
  return await fn(...args) as T;
}

async function startTunnelMode(deps: Deps, mode: TunnelRuntimeMode): Promise<unknown> {
  if (mode === 'system-tun') {
    await tunnelCall(deps, 'installTun');
  }
  await tunnelCall(deps, 'setMode', mode);
  await tunnelCall(deps, 'start');
  const status = await tunnelCall<Record<string, unknown>>(deps, 'status');
  return withSessionProxyMeta(status, await applyCoordinatedSessionProxy(deps, status));
}

async function stopTunnelMode(deps: Deps): Promise<unknown> {
  await tunnelCall(deps, 'stop');
  const status = await tunnelCall<Record<string, unknown>>(deps, 'status');
  return withSessionProxyMeta(status, await applyCoordinatedSessionProxy(deps, status));
}

async function applyCoordinatedSessionProxy(
  deps: Deps,
  tunnelStatus?: Record<string, unknown> | null
): Promise<Record<string, unknown> | null> {
  const hdo = await prepareHdoDomainProxy(deps);
  const hdoProxy = stringValue(hdo?.proxy);
  const hdoDomains = stringArray(hdo?.domains);
  if (!hdoProxy || hdoDomains.length === 0) return null;

  const running = tunnelStatus?.running === true;
  const mode = stringValue(tunnelStatus?.mode);
  const ports = plainObject(tunnelStatus?.ports);
  const mixed = numberValue(ports?.mixed);
  const tunnelProxy = running && mode !== 'system-tun' && mixed ? `127.0.0.1:${mixed}` : null;
  await deps.session.setProxy({
    mode: 'pac_script',
    pacScript: renderSessionProxyPacDataUrl({
      hdoProxy,
      hdoDomains,
      tunnelProxy
    })
  });
  await deps.session.forceReloadProxyConfig?.().catch(() => undefined);
  return {
    hdoDomainProxy: {
      proxy: hdoProxy,
      domains: hdoDomains
    },
    tunnelProxy,
    mode: tunnelProxy ? 'hdo-priority+tunnel' : 'hdo-priority'
  };
}

async function prepareHdoDomainProxy(deps: Deps): Promise<Record<string, unknown> | null> {
  const exposed = deps.runtime.getExposed(HDO_PLUGIN_ID);
  const fn = exposed?.prepareDomainProxyFromManifest;
  if (typeof fn !== 'function') return null;
  const result = await fn();
  return plainObject(result);
}

async function tunnelStatusIfActive(deps: Deps): Promise<Record<string, unknown> | null> {
  const exposed = deps.runtime.getExposed(TUNNEL_PLUGIN_ID);
  const fn = exposed?.status;
  if (typeof fn !== 'function') return null;
  return plainObject(await fn());
}

function withSessionProxyMeta(value: unknown, sessionProxy: Record<string, unknown> | null): unknown {
  if (!sessionProxy) return value;
  const row = plainObject(value);
  return row ? { ...row, sessionProxy } : { value, sessionProxy };
}

function renderSessionProxyPacDataUrl(input: {
  hdoProxy: string;
  hdoDomains: string[];
  tunnelProxy: string | null;
}): string {
  const hdoReturn = `PROXY ${input.hdoProxy}`;
  const tunnelReturn = input.tunnelProxy ? `PROXY ${input.tunnelProxy}` : 'DIRECT';
  const script = `
function FindProxyForURL(url, host) {
  var h = String(host || '').toLowerCase();
  var domains = ${JSON.stringify(input.hdoDomains)};
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (h === d || h.slice(-(d.length + 1)) === '.' + d) {
      return ${JSON.stringify(hdoReturn)};
    }
  }
  if (isPlainHostName(h) || h === 'localhost' || h === '127.0.0.1' || h === '::1') {
    return 'DIRECT';
  }
  if (/^100\\./.test(h)) {
    return 'DIRECT';
  }
  return ${JSON.stringify(tunnelReturn)};
}
`;
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script).toString('base64')}`;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Exposes the same surface as `AdminServer` but over IPC, so the host's own
 * renderer can build a native UI without going through localhost.
 *
 * Channel prefix: `plugin-host:*`
 */
export function registerPluginHostIpc(ipc: IpcMain, deps: Deps): void {
  ipc.handle('plugin-host:list', () => deps.registry.list());
  ipc.handle('plugin-host:marketplace', async () => {
    const result = await deps.marketplace.fetch();
    const dbEntries = deps.registry.marketplaceDb().listEntries();
    return {
      ...result.index,
      entries: (dbEntries.length > 0
        ? dbEntries.map(toLegacyEntry)
        : result.index.entries
      ).filter(isUserInstallableMarketplaceEntry),
      source: result.source,
      remoteFetchedAt: result.remoteFetchedAt,
      remoteError: result.remoteError
    };
  });
  ipc.handle('plugin-host:install', async (_e, payload: { id: string; version: string }) => {
    const entry = await resolveMarketplaceEntry(deps, payload.id);
    if (!entry) throw new Error(`Unknown plugin: ${payload.id}`);
    return deps.store.install({
      id: entry.id,
      npm: entry.npm,
      version: payload.version ?? entry.latest,
      tarballUrl: entry.tarballUrl
    });
  });
  ipc.handle('plugin-host:install-progress', (_e, id?: string) => deps.store.getInstallProgress(id));
  ipc.handle(
    'plugin-host:install-local',
    (_e, payload: { id: string; npm: string; source: { type: 'tarball' | 'local-dir'; path: string } }) =>
      deps.store.installFrom(payload)
  );
  ipc.handle('plugin-host:uninstall', async (_e, id: string) => {
    if (id === MARKETPLACE_SELF_PLUGIN_ID) {
      throw new Error('QPJoy Marketplace 是当前插件宿主，不能卸载。');
    }
    // Drop the live instance first so the plugin's `close()` runs and frees
    // ports + IPC handlers BEFORE the install dir is removed.
    await deps.runtime.deactivate(id).catch(() => undefined);
    await deps.store.uninstall(id);
  });
  ipc.handle('plugin-host:grant', (_e, payload: { id: string; permissions: string[] }) => {
    deps.registry.grant(payload.id, payload.permissions as never);
    deps.registry.setState(payload.id, 'installed');
  });
  ipc.handle('plugin-host:activate', async (_e, id: string) => {
    if (id === MARKETPLACE_SELF_PLUGIN_ID) {
      deps.registry.setState(id, 'active', null);
      return { ok: true, self: true };
    }
    await deps.runtime.activate(id);
    return { ok: true };
  });
  ipc.handle('plugin-host:deactivate', async (_e, id: string) => {
    if (id === MARKETPLACE_SELF_PLUGIN_ID) {
      deps.registry.setState(id, 'active', null);
      return { ok: true, self: true };
    }
    await deps.runtime.deactivate(id);
    return { ok: true };
  });
  ipc.handle('plugin-host:logs', (_e, id: string) => deps.registry.recentLogs(id));
  ipc.handle(
    'plugin-host:rpc',
    async (_e, payload: { id?: string; method?: string; args?: unknown[] }) => {
      if (!payload?.id || !payload.method) {
        throw new Error('id and method are required');
      }
      const exposed = deps.runtime.getExposed(payload.id);
      if (!exposed) {
        throw new Error(`plugin "${payload.id}" is not active or did not expose any methods`);
      }
      const fn = exposed[payload.method];
      if (typeof fn !== 'function') {
        throw new Error(`plugin "${payload.id}" did not expose "${payload.method}"`);
      }
      return fn(...(Array.isArray(payload.args) ? payload.args : []));
    }
  );

  // Host-app facade for the built-in Tunnel plugin. Consumer renderers can
  // invoke these through their preload instead of knowing Tunnel's admin port
  // or low-level RPC names. Only start_tun enters the OS privilege path.
  ipc.handle('market:tunnel:status', () => tunnelCall(deps, 'status'));
  ipc.handle('market:tunnel:start_app', () => startTunnelMode(deps, 'app-rule'));
  ipc.handle('market:tunnel:start_global', () => startTunnelMode(deps, 'app-global'));
  ipc.handle('market:tunnel:start_tun', () => startTunnelMode(deps, 'system-tun'));
  ipc.handle('market:tunnel:stop', () => stopTunnelMode(deps));
  ipc.handle('market:tunnel:set_mode', async (_e, mode: TunnelRuntimeMode) => {
    const result = await tunnelCall(deps, 'setMode', mode);
    const status = await tunnelStatusIfActive(deps);
    if (status?.running === true) {
      await applyCoordinatedSessionProxy(deps, status);
    }
    return result;
  });
  ipc.handle('market:tunnel:apply_managed_config', async (_e, input: Record<string, unknown> | null | undefined) => {
    const payload = input && typeof input === 'object' ? input : {};
    const result = await tunnelCall(deps, 'applyManagedConfig', {
      ...payload,
      allowSystemTunPrivilege: payload.allowSystemTunPrivilege === true
    });
    const status = await tunnelStatusIfActive(deps);
    if (status?.running === true) {
      await applyCoordinatedSessionProxy(deps, status);
    }
    return result;
  });

  // Host-app facade for the built-in HDO plugin. Anonymous connect is meant
  // for apps that need to enter the relay before their own backend login.
  ipc.handle('market:hdo:status', () => hdoCall(deps, 'snapshot'));
  ipc.handle('market:hdo:anonymous_connect', async (_e, input: Record<string, unknown> | null | undefined) => {
    const result = await hdoCall(deps, 'anonymousConnect', input ?? {});
    const status = await tunnelStatusIfActive(deps);
    if (status?.running !== true) return result;
    return withSessionProxyMeta(result, await applyCoordinatedSessionProxy(deps, status));
  });
  ipc.handle('market:hdo:prepare', (_e, input: Record<string, unknown> | null | undefined) =>
    hdoCall(deps, 'prepareWireGuardPeer', input ?? {})
  );
  ipc.handle('market:hdo:connect', (_e, input: Record<string, unknown> | null | undefined) =>
    hdoCall(deps, 'connectWireGuardPeer', input ?? { action: 'up' })
  );
  ipc.handle('market:hdo:stop', () => hdoCall(deps, 'connectWireGuardPeer', { action: 'down' }));
  ipc.handle('market:hdo:apply_domain_proxy', async (_e, manifest: Record<string, unknown> | null | undefined) => {
    const result = await hdoCall(deps, 'applyDomainProxyFromManifest', manifest ?? null);
    const status = await tunnelStatusIfActive(deps);
    if (status?.running !== true) return result;
    return withSessionProxyMeta(result, await applyCoordinatedSessionProxy(deps, status));
  });

  ipc.handle('plugin-host:sync-status', () =>
    readSyncStatus(deps.registry.marketplaceDb(), deps.serverBaseUrl)
  );
  ipc.handle('plugin-host:sync-now', async () => {
    if (!deps.remoteSync) {
      throw new Error('remote sync not configured (set serverBaseUrl)');
    }
    return deps.remoteSync.run('manual');
  });

  ipc.handle('plugin-host:auth-state', () => {
    if (!deps.auth) return { user: null, configured: false };
    return { ...deps.auth.state(), configured: true };
  });
  ipc.handle(
    'plugin-host:auth-login',
    async (_e, payload: { identifier: string; password: string }) => {
      if (!deps.auth) throw new Error('auth not configured');
      return deps.auth.login(payload.identifier, payload.password);
    }
  );
  ipc.handle('plugin-host:auth-register', async (_e, payload: Record<string, string>) => {
    if (!deps.auth) throw new Error('auth not configured');
    return deps.auth.register(payload as never);
  });
  ipc.handle('plugin-host:auth-logout', async () => {
    if (deps.auth) await deps.auth.clearSession();
    return { ok: true };
  });

  ipc.handle('plugin-host:seed-config', () => ({ seedIds: deps.seedIds }));
  ipc.handle('plugin-host:reseed', async (_e, id: string) => {
    await deps.reseed(id);
    return { ok: true };
  });
  ipc.handle(
    'plugin-host:upgrade',
    async (_e, payload: { id: string; version?: string }) => {
      await deps.upgrade(payload.id, payload.version);
      return { ok: true };
    }
  );
  ipc.handle(
    'plugin-host:auth-code',
    async (
      _e,
      payload: {
        channel: 'email' | 'sms';
        destination: string;
        purpose: 'register' | 'login' | 'reset';
      }
    ) => {
      if (!deps.auth) throw new Error('auth not configured');
      return deps.auth.requestCode(payload);
    }
  );
}
