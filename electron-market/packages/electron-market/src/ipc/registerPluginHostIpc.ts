import type { IpcMain } from 'electron';

import type { PluginRegistry } from '../registry/PluginRegistry';
import type { MarketplaceClient } from '../registry/MarketplaceClient';
import type { PluginStore } from '../store/PluginStore';
import type { PluginRuntime } from '../runtime/PluginRuntime';
import { readSyncStatus, type RemoteSyncJob } from '../sync/RemoteSyncJob';
import type { AuthService } from '../sync/AuthService';

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
    return {
      ...result.index,
      source: result.source,
      remoteFetchedAt: result.remoteFetchedAt,
      remoteError: result.remoteError
    };
  });
  ipc.handle('plugin-host:install', async (_e, payload: { id: string; version: string }) => {
    const entry = await deps.marketplace.resolve(payload.id);
    if (!entry) throw new Error(`Unknown plugin: ${payload.id}`);
    return deps.store.install({ id: entry.id, npm: entry.npm, version: payload.version ?? entry.latest });
  });
  ipc.handle(
    'plugin-host:install-local',
    (_e, payload: { id: string; npm: string; source: { type: 'tarball' | 'local-dir'; path: string } }) =>
      deps.store.installFrom(payload)
  );
  ipc.handle('plugin-host:uninstall', async (_e, id: string) => {
    // Drop the live instance first so the plugin's `close()` runs and frees
    // ports + IPC handlers BEFORE the install dir is removed.
    await deps.runtime.deactivate(id).catch(() => undefined);
    await deps.store.uninstall(id);
  });
  ipc.handle('plugin-host:grant', (_e, payload: { id: string; permissions: string[] }) => {
    deps.registry.grant(payload.id, payload.permissions as never);
    deps.registry.setState(payload.id, 'installed');
  });
  ipc.handle('plugin-host:activate', (_e, id: string) => deps.runtime.activate(id));
  ipc.handle('plugin-host:deactivate', (_e, id: string) => deps.runtime.deactivate(id));
  ipc.handle('plugin-host:logs', (_e, id: string) => deps.registry.recentLogs(id));

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
