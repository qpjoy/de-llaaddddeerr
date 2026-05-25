/**
 * Plugin adapter for @qpjoy/electron-market.
 *
 * The same package keeps working as a standalone npm dependency (use
 * `createElectronTunnel(...)` directly). When loaded through the plugin
 * host, this default export is what gets invoked instead — wrapping the
 * exact same runtime behind the standard plugin contract.
 *
 * No new state is introduced here: the underlying MihomoManager owns its
 * own SQLite + admin server, so this adapter is a ~30-line shim.
 */
import type { App, IpcMain, Session } from 'electron';

import { createElectronTunnel, type ElectronTunnelHandle } from './createElectronTunnel';

/**
 * Subset of the SDK types — re-declared structurally so this file does not
 * take a build-time dependency on `@qpjoy/electron-plugin-sdk`. (Tunnel still ships
 * fine when installed without the plugin host present.)
 */
interface PluginHostBridge {
  app: App;
  ipcMain: IpcMain;
  session: Session;
}
// `expose` is intentionally permissive — plugin authors are expected to
// pass functions with concrete parameter types, not `(...args: unknown[])`.
// The runtime erases the signature; only the method names matter to callers.
type ExposedApi = Record<string, (...args: any[]) => any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface PluginContextLike<S> {
  host: PluginHostBridge;
  settings: { get(): S };
  log: { info(m: string, meta?: Record<string, unknown>): void };
  expose(api: ExposedApi): void;
}

export interface TunnelPluginSettings {
  adminPort?: number;
  controllerPort?: number;
  mixedPort?: number;
  dnsPort?: number;
  bundledEngineDir?: string;
}

const tunnelPlugin = {
  async activate(ctx: PluginContextLike<TunnelPluginSettings>): Promise<() => void> {
    const settings = ctx.settings.get() ?? {};
    const handle: ElectronTunnelHandle = createElectronTunnel(
      { app: ctx.host.app, ipcMain: ctx.host.ipcMain, session: ctx.host.session },
      {
        adminPort: settings.adminPort ?? 23456,
        controllerPort: settings.controllerPort ?? 23457,
        mixedPort: settings.mixedPort ?? 23458,
        dnsPort: settings.dnsPort ?? 1053,
        bundledEngineDir: settings.bundledEngineDir
      }
    );

    // Expose an RPC surface so the host (and other plugins) can drive the
    // tunnel without poking at internals. Anything not on this list is
    // intentionally private — bump the surface explicitly when needed.
    ctx.expose({
      status: () => handle.status(),
      policySnapshot: () => ({
        status: handle.status(),
        rules: handle.manager.listRules()
      }),
      snapshot: () => handle.manager.snapshot(),
      applyProxy: () => handle.applyProxy(),
      createSubscription: async (input) => {
        const subscription = await handle.manager.createSubscription(input);
        if (subscription.active) await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
        return subscription;
      },
      editSubscription: async (input) => {
        const subscription = await handle.manager.editSubscription(input);
        if (subscription.active) await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
        return subscription;
      },
      deleteSubscription: async (id: number) => {
        handle.manager.deleteSubscription(id);
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
      },
      setActiveSubscription: async (id: number) => {
        const subscription = handle.manager.setActiveSubscription(id);
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
        return subscription;
      },
      updateSubscription: async (id: number) => {
        const subscription = await handle.manager.updateSubscription(id);
        if (subscription.active) await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
        return subscription;
      },
      updateActiveSubscription: async () => {
        const subscription = await handle.manager.updateActiveSubscription();
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
        return subscription;
      },
      setMode: async (mode) => {
        const changed = handle.manager.setMode(mode);
        if (changed) await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
      },
      installTun: async () => {
        handle.manager.installTunFeature();
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
      },
      uninstallTun: async () => {
        handle.manager.uninstallTunFeature();
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
      },
      setCorePath: (corePath: string) => handle.manager.setCorePath(corePath),
      setLocalPorts: async (ports) => {
        await handle.manager.setLocalPorts(ports);
        await handle.applyProxy();
      },
      start: async () => {
        await handle.manager.start();
        await handle.applyProxy();
      },
      stop: async () => {
        await handle.manager.stop();
        await handle.applyProxy();
      },
      restart: async () => {
        await handle.manager.restart();
        await handle.applyProxy();
      },
      applyManagedConfig: async (input) => {
        const result = await handle.manager.applyManagedConfig(input);
        await handle.applyProxy();
        return result;
      },
      addDomainRule: async (kind: 'allow' | 'block', domain: string) => {
        const rule = handle.manager.addDomainRule(kind, domain);
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
        return rule;
      },
      removeDomainRule: async (id: number) => {
        handle.manager.removeDomainRule(id);
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
      },
      addPreset: async (preset: string) => {
        const rules = handle.manager.addPreset(preset as never);
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
        return rules;
      },
      removePreset: async (preset: string) => {
        const count = handle.manager.removePreset(preset as never);
        await handle.manager.applyRuntimeConfigChange();
        await handle.applyProxy();
        return count;
      },
      onEvent: (listener: () => void) => {
        handle.manager.on('event', listener);
        return () => handle.manager.off('event', listener);
      }
    });

    ctx.log.info('tunnel activated', {
      ports: handle.status().ports,
      mode: handle.status().mode
    });

    // The disposer is awaited by PluginRuntime.deactivate, and handle.close()
    // is async — port 23456 + tunnel:* IPC handlers must be released before
    // the next activate (upgrade/reseed) runs.
    return async () => {
      await handle.close();
    };
  }
};

export default tunnelPlugin;
