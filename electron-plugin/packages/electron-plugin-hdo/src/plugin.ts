import type { App, IpcMain, Session } from 'electron';

import { HdoAdminServer } from './admin/AdminServer';
import { HdoController } from './HdoController';
import type {
  HdoDeviceRegistrationInput,
  HdoNodeInput,
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
      marketplaceDb: ctx.host.marketplaceDb,
      log: ctx.log
    });
    const admin = new HdoAdminServer(controller, {
      port: runtimeSettings.adminPort ?? 23459
    });
    admin.start();

    ctx.expose({
      snapshot: () => controller.snapshot(),
      updateSettings: (patch: Record<string, unknown>) => controller.updateSettings(patch),
      registerDevice: (input: HdoDeviceRegistrationInput) => controller.registerDevice(input),
      refreshManifest: (deviceId?: string | null) => controller.refreshManifest(deviceId),
      refreshSubscription: (deviceId?: string | null) => controller.refreshSubscription(deviceId),
      upsertNode: (input: HdoNodeInput) => controller.upsertNode(input),
      upsertService: (input: HdoServiceInput) => controller.upsertService(input),
      upsertRateLimit: (input: HdoRateLimitInput) => controller.upsertRateLimit(input)
    });

    ctx.log.info('hdo activated', {
      adminPort: runtimeSettings.adminPort ?? 23459,
      marketServerBaseUrl: ctx.host.serverBaseUrl ?? null
    });

    return async () => {
      await admin.stop();
    };
  }
};

export default hdoPlugin;
