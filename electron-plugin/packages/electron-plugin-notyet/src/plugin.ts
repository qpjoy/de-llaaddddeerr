/**
 * Plugin adapter for @qpjoy/electron-market.
 *
 * Standalone usage (rare for this package — it's primarily a marketplace
 * plugin) goes through `dist/index.js` instead, which re-exports the same
 * `createOverlayManager(...)` factory.
 *
 * The marketplace runtime calls our default export's `activate(ctx)`,
 * passing the host's `app / ipcMain / session` plus a per-plugin
 * `userDataDir`. We spin up the overlay manager, expose a tiny RPC surface
 * (so the admin panel can flip ball visibility), and return an async
 * disposer that the runtime awaits during deactivate / uninstall.
 */
import path from 'node:path';
import type { App, IpcMain, Session } from 'electron';

import {
  createOverlayManager,
  type OverlayManagerHandle
} from './overlay/createOverlayManager';

interface PluginHostBridge {
  app: App;
  ipcMain: IpcMain;
  session: Session;
}

// Mirrors the SDK's ExposedApi shape without a build-time dep on plugin-sdk
// (this package can be installed without the marketplace host present).
type ExposedApi = Record<string, (...args: any[]) => any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface PluginContextLike<S> {
  manifest: { id: string; version: string };
  host: PluginHostBridge;
  userDataDir: string;
  settings: { get(): S };
  log: {
    info(m: string, meta?: Record<string, unknown>): void;
    warn(m: string, meta?: Record<string, unknown>): void;
    error(m: string, meta?: Record<string, unknown>): void;
  };
  expose(api: ExposedApi): void;
}

export interface NotyetPluginSettings {
  /** Override the chat URL (default: https://www.notyet.chat). */
  chatUrl?: string;
}

const DEFAULT_CHAT_URL = 'https://www.notyet.chat';

const notyetPlugin = {
  async activate(
    ctx: PluginContextLike<NotyetPluginSettings>
  ): Promise<() => Promise<void>> {
    const settings = ctx.settings.get() ?? {};
    const chatUrl = (settings.chatUrl ?? DEFAULT_CHAT_URL).replace(/\/+$/, '');

    // Assets live next to this compiled file (`dist/assets/`). See
    // `scripts/copy-assets.mjs` for the build-time copy step.
    const assetsDir = path.join(__dirname, 'assets');

    const handle: OverlayManagerHandle = createOverlayManager({
      app: ctx.host.app,
      ipcMain: ctx.host.ipcMain,
      chatUrl,
      assetsDir,
      userDataDir: ctx.userDataDir,
      log: ctx.log
    });

    ctx.expose({
      /** Returns whether the ball is currently visible. */
      isVisible: () => handle.isVisible(),
      /** Show / hide the ball across all windows; persisted across restarts. */
      setVisible: (v: boolean) => handle.setVisible(v),
      /** Open the chat cover over the focused window. */
      openChat: () => handle.openChat(),
      /** Close the chat cover over the focused window (no-op if none). */
      closeChat: () => handle.closeChat()
    });

    ctx.log.info('notyet ball activated', {
      chatUrl,
      pluginVersion: ctx.manifest.version
    });

    return async () => {
      await handle.close();
    };
  }
};

export default notyetPlugin;
