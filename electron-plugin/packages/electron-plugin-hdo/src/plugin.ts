import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { powerMonitor, type App, type IpcMain, type Session } from 'electron';

import { HdoAdminServer } from './admin/AdminServer';
import { HdoController } from './HdoController';
import type {
  HdoDeviceRegistrationInput,
  HdoNodeInput,
  HdoPublishedServiceInput,
  HdoRateLimitInput,
  HdoServiceInput
} from './types';

interface PluginHostBridge {
  app: App;
  ipcMain: IpcMain;
  session: Session;
  marketplaceDb?: {
    raw(): unknown;
    getMeta?(key: string): string | null;
    setMeta?(key: string, value: string): void;
    getActiveSession?(): {
      accessToken: string | null;
      refreshToken: string | null;
      expiresAt: string | null;
      user: Record<string, unknown> | null;
    } | null;
    listInstalled?(): unknown[];
  };
  pluginManager?: {
    install?(input: {
      id?: string | null;
      npm?: string | null;
      version?: string | null;
      tarballUrl?: string | null;
      autoGrant?: boolean | 'manifest' | string[] | null;
      activate?: boolean | null;
    }): Promise<unknown>;
    uninstall?(id: string): Promise<unknown>;
    activate?(id: string): Promise<unknown>;
    deactivate?(id: string): Promise<unknown>;
    upgrade?(id: string, version?: string | null): Promise<unknown>;
    listInstalled?(): unknown[];
  };
  serverBaseUrl?: string | null;
}

type ExposedApi = Record<string, (...args: any[]) => any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface PluginContextLike<S> {
  host: PluginHostBridge;
  userDataDir: string;
  settings: { get(): S };
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  expose(api: ExposedApi): void;
}

export interface HdoPluginRuntimeSettings {
  adminPort?: number;
}

const hdoPlugin = {
  async activate(ctx: PluginContextLike<HdoPluginRuntimeSettings>): Promise<() => Promise<void>> {
    const runtimeSettings = ctx.settings.get() ?? {};
    const controller = new HdoController({
      userDataDir: ctx.userDataDir,
      marketServerBaseUrl: ctx.host.serverBaseUrl ?? null,
      bundledWireGuardDir: defaultBundledWireGuardDir(),
      session: ctx.host.session,
      marketplaceDb: ctx.host.marketplaceDb,
      pluginManager: ctx.host.pluginManager,
      log: ctx.log
    });
    const admin = new HdoAdminServer(controller, {
      port: runtimeSettings.adminPort ?? 23459
    });
    admin.start();
    const presenceTimer = setInterval(() => {
      const settings = controller.getSettings();
      if (settings.anonymous?.mode === 'anonymous' && !settings.sessionUserId) return;
      const status = controller.wireGuardStatus();
      void controller.reportDevicePresence(status && status.active === true ? 'online' : 'offline', {
        throttleMs: 10 * 60 * 1000
      }).catch((err) => {
        ctx.log.warn('failed to report HDO presence heartbeat', {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }, 10 * 60 * 1000);
    presenceTimer.unref?.();
    let lastWireGuardRecoveryFailureAt = 0;
    const recoveryTimers: Array<ReturnType<typeof setTimeout>> = [];
    const recoverWireGuard = (reason: string) => {
      if (lastWireGuardRecoveryFailureAt && Date.now() - lastWireGuardRecoveryFailureAt < 5 * 60 * 1000) {
        return;
      }
      void controller.recoverWireGuardPeer({ reason, allowPrivileged: false }).catch((err) => {
        lastWireGuardRecoveryFailureAt = Date.now();
        ctx.log.warn('failed to recover HDO WireGuard desired state', {
          reason,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    };
    const scheduleWireGuardRecovery = (reason: string, delays = [2500, 12_000, 25_000]) => {
      delays.forEach((delay) => {
        const timer = setTimeout(() => recoverWireGuard(reason), delay);
        timer.unref?.();
        recoveryTimers.push(timer);
      });
    };
    scheduleWireGuardRecovery('plugin-activate', [2500, 12_000]);
    const wireGuardRecoveryTimer = setInterval(() => recoverWireGuard('interval'), 45_000);
    wireGuardRecoveryTimer.unref?.();
    const onPowerResume = () => scheduleWireGuardRecovery('power-resume');
    const onUnlockScreen = () => scheduleWireGuardRecovery('unlock-screen', [1500, 10_000, 25_000]);
    powerMonitor.on('resume', onPowerResume);
    powerMonitor.on('unlock-screen', onUnlockScreen);

    ctx.expose({
      snapshot: () => controller.snapshot(),
      updateSettings: (patch: Record<string, unknown>) => controller.updateSettings(patch),
      registerDevice: (input: HdoDeviceRegistrationInput) => controller.registerDevice(input),
      reportPluginStates: (deviceId?: string | null) => controller.reportPluginStates(deviceId),
      anonymousConnect: (input?: {
        serverUrl?: string | null;
        appId?: string | null;
        installId?: string | null;
        deviceLabel?: string | null;
        platform?: string | null;
        rotate?: boolean | null;
        autoConnect?: boolean | null;
      }) => controller.anonymousConnect(input),
      prepareWireGuardPeer: (input?: { rotate?: boolean | null }) => controller.prepareWireGuardPeer(input),
      connectWireGuardPeer: (input?: { action?: 'up' | 'down' | 'restart' | null }) => controller.connectWireGuardPeer(input),
      applyDomainProxyFromManifest: (manifest?: Record<string, unknown> | null) =>
        controller.applyDomainProxyFromManifest(manifest),
      prepareDomainProxyFromManifest: (manifest?: Record<string, unknown> | null) =>
        controller.prepareDomainProxyFromManifest(manifest),
      recoverWireGuardPeer: (reason?: string | null) =>
        controller.recoverWireGuardPeer({ reason: reason || 'api', allowPrivileged: true }),
      installWireGuardLaunchDaemon: () => controller.installWireGuardLaunchDaemon(),
      uninstallWireGuardLaunchDaemon: (input?: { stopTunnel?: boolean | null }) => controller.uninstallWireGuardLaunchDaemon(input),
      executePendingTasks: () => controller.executePendingTasks(),
      refreshManifest: (deviceId?: string | null) => controller.refreshManifest(deviceId),
      refreshSubscription: (deviceId?: string | null) => controller.refreshSubscription(deviceId),
      upsertNode: (input: HdoNodeInput) => controller.upsertNode(input),
      upsertService: (input: HdoServiceInput) => controller.upsertService(input),
      publishService: (input: HdoPublishedServiceInput) => controller.publishService(input),
      upsertRateLimit: (input: HdoRateLimitInput) => controller.upsertRateLimit(input)
    });

    ctx.log.info('hdo activated', {
      adminPort: runtimeSettings.adminPort ?? 23459,
      marketServerBaseUrl: ctx.host.serverBaseUrl ?? null
    });

    return async () => {
      clearInterval(presenceTimer);
      clearInterval(wireGuardRecoveryTimer);
      recoveryTimers.forEach((timer) => clearTimeout(timer));
      powerMonitor.off('resume', onPowerResume);
      powerMonitor.off('unlock-screen', onUnlockScreen);
      await controller.shutdown().catch((err) => {
        ctx.log.warn('failed to shutdown HDO WireGuard', {
          error: err instanceof Error ? err.message : String(err)
        });
      });
      await controller.reportDevicePresence('offline').catch(() => undefined);
      await admin.stop();
    };
  }
};

export default hdoPlugin;

function defaultBundledWireGuardDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.cwd();
  const packageDir = typeof __dirname === 'undefined' ? process.cwd() : __dirname;
  const candidates = [
    join(resourcesPath, 'qpjoy-wireguard-engine'),
    join(resourcesPath, 'wireguard'),
    resolve(packageDir, '../resources/wireguard'),
    resolve(process.cwd(), 'resources/qpjoy-wireguard-engine'),
    resolve(process.cwd(), 'resources/wireguard')
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
