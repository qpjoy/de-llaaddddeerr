import { spawn as childSpawn } from 'child_process';
import { mkdirSync, readFileSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import type { App, IpcMain, Session } from 'electron';

import type {
  PluginContext,
  PluginDispose,
  PluginModule,
  Permission
} from '@qpjoy/electron-plugin-sdk';
import type { MarketplaceDB } from '@qpjoy/marketplace-db';
import { PermissionDeniedError } from '@qpjoy/electron-plugin-sdk';

import type { PluginRegistry } from '../registry/PluginRegistry';
import type { InstalledPluginRecord } from '../types';
import { MARKETPLACE_SELF_PLUGIN_ID } from '../constants';
import { PermissionGate } from './PermissionGate';
import type { PolicyDecision } from './TunnelPolicyGuard';

interface PluginRuntimeOptions {
  host: { app: App; ipcMain: IpcMain; session: Session };
  marketplaceDb: MarketplaceDB;
  registry: PluginRegistry;
  pluginsRoot: string;
  serverBaseUrl?: string | null;
  pluginManager?: NonNullable<PluginContext['host']['pluginManager']>;
}

interface LiveInstance {
  record: InstalledPluginRecord;
  dispose: PluginDispose | null;
  exposed: Record<string, (...args: unknown[]) => unknown>;
  settings: Map<string, unknown>;
}

/**
 * Activates / deactivates plugin modules. Each plugin runs *in-process* but
 * receives a `PluginContext` whose dangerous methods are gated by the
 * permissions the user has granted in the registry.
 *
 * Out-of-process / vm isolation is a future hardening step (see PLUGIN_SPEC).
 */
export class PluginRuntime {
  private live = new Map<string, LiveInstance>();
  private networkPolicy: ((url: string) => Promise<PolicyDecision>) | null = null;

  constructor(private readonly opts: PluginRuntimeOptions) {}

  setNetworkPolicyEvaluator(evaluate: ((url: string) => Promise<PolicyDecision>) | null): void {
    this.networkPolicy = evaluate;
  }

  async activateAllOnStartup(): Promise<void> {
    for (const record of this.opts.registry.list()) {
      if (record.state === 'disabled' || record.state === 'awaitingGrant') continue;
      if (!record.manifest.activationEvents.includes('onStartup')) continue;
      await this.activate(record.id).catch((err) => {
        this.opts.registry.log(record.id, 'error', 'startup activation failed', {
          error: String(err)
        });
      });
    }
  }

  async activate(id: string): Promise<void> {
    const record = this.opts.registry.get(id);
    if (!record) throw new Error(`Plugin not installed: ${id}`);
    if (id === MARKETPLACE_SELF_PLUGIN_ID) {
      this.opts.registry.setState(id, 'active', null);
      return;
    }
    if (this.live.has(id)) return;
    try {
      this.assertInstallHealthy(record);
    } catch (err) {
      this.opts.registry.setState(id, 'errored', err instanceof Error ? err.message : String(err));
      throw err;
    }

    const missing = PermissionGate.missing(record.manifest.permissions, record.grantedPermissions);
    if (missing.length > 0) {
      this.opts.registry.setState(id, 'awaitingGrant', `missing: ${missing.join(', ')}`);
      throw new PermissionDeniedError(missing[0]);
    }

    const ctx = this.buildContext(record);
    const mod = this.loadModule(record);

    // Pre-insert the live entry BEFORE calling activate so `ctx.expose(...)`
    // — which the plugin typically calls *during* its activate body — has
    // a slot to write into. If activate throws we roll it back below.
    this.live.set(id, {
      record,
      dispose: null,
      exposed: {},
      settings: new Map()
    });

    try {
      const dispose = (await mod.activate(ctx as PluginContext)) ?? null;
      const inst = this.live.get(id);
      if (inst) {
        inst.dispose = typeof dispose === 'function' ? dispose : null;
      }
      this.opts.registry.setState(id, 'active', null);
    } catch (err) {
      this.live.delete(id);
      this.opts.registry.setState(id, 'errored', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async deactivate(id: string): Promise<void> {
    if (id === MARKETPLACE_SELF_PLUGIN_ID) {
      this.opts.registry.setState(id, 'active', null);
      return;
    }
    const inst = this.live.get(id);
    if (!inst) return;
    try {
      if (inst.dispose) await inst.dispose();
    } finally {
      this.live.delete(id);
      this.opts.registry.setState(id, 'installed');
    }
  }

  async deactivateAll(): Promise<void> {
    for (const id of Array.from(this.live.keys())) {
      await this.deactivate(id).catch(() => undefined);
    }
  }

  /**
   * Host-side accessor: read the methods an active plugin exposed via
   * `ctx.expose(...)`. Returns `null` if the plugin isn't active. This
   * bypasses the cross-plugin permission check on purpose — the host owns
   * the runtime and may always inspect what its plugins published.
   */
  getExposed(id: string): Record<string, (...args: unknown[]) => unknown> | null {
    const inst = this.live.get(id);
    return inst ? inst.exposed : null;
  }

  isActive(id: string): boolean {
    return this.live.has(id);
  }

  /** Cross-plugin RPC. Both sides need `ipc:cross`. */
  async call(callerId: string, targetId: string, method: string, ...args: unknown[]): Promise<unknown> {
    const caller = this.opts.registry.get(callerId);
    const target = this.live.get(targetId);
    if (!caller || !target) throw new Error(`No such plugin: ${targetId}`);
    if (!caller.grantedPermissions.includes('ipc:cross')) {
      throw new PermissionDeniedError('ipc:cross');
    }
    if (!target.record.grantedPermissions.includes('ipc:cross')) {
      throw new PermissionDeniedError('ipc:cross');
    }
    const fn = target.exposed[method];
    if (!fn) throw new Error(`Plugin ${targetId} did not expose ${method}`);
    return fn(...args);
  }

  /* ─── internals ─────────────────────────────────────────────────────── */

  private loadModule(record: InstalledPluginRecord): PluginModule {
    // Each plugin's `node_modules/<npm>/<entry>` is resolved relative to its
    // own install dir; require() respects that automatically because we
    // build an absolute path.
    const pkgJsonPath = join(record.installPath, 'node_modules', record.npm, 'package.json');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require(pkgJsonPath) as { qpjoyPlugin: { entry: string } };
    const entry = join(record.installPath, 'node_modules', record.npm, pkg.qpjoyPlugin.entry);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(entry) as { default?: PluginModule } | PluginModule;
    const resolved = 'default' in (mod as object) && (mod as { default?: PluginModule }).default
      ? (mod as { default: PluginModule }).default
      : (mod as PluginModule);
    if (typeof resolved.activate !== 'function') {
      throw new Error(`Plugin ${record.id} entry has no activate()`);
    }
    return resolved;
  }

  private assertInstallHealthy(record: InstalledPluginRecord): void {
    try {
      const packageDir = realpathSync(join(record.installPath, 'node_modules', record.npm));
      const pkgJsonPath = join(packageDir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const requireFromPlugin = createRequire(pkgJsonPath);
      const missing: string[] = [];
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        try {
          requireFromPlugin.resolve(dep);
        } catch {
          missing.push(dep);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `插件安装不完整，缺少依赖：${missing.join(', ')}。请重新预装或卸载后重新安装 ${record.manifest.name}。`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('插件安装不完整')) throw err;
      throw new Error(`插件安装不完整，无法读取 ${record.npm}：${message}`);
    }
  }

  private buildContext(record: InstalledPluginRecord): PluginContext {
    const gate = new PermissionGate(new Set(record.grantedPermissions));
    const userDataDir = join(this.opts.pluginsRoot, '..', 'plugin-data', record.id);
    mkdirSync(userDataDir, { recursive: true });

    const settingsBag: { current: Record<string, unknown> } = { current: {} };
    const listeners = new Set<(next: unknown) => void>();

    const ctx: PluginContext = {
      manifest: record.manifest,
      host: {
        app: this.opts.host.app,
        ipcMain: this.opts.host.ipcMain,
        session: this.opts.host.session,
        marketplaceDb: this.opts.marketplaceDb,
        serverBaseUrl: this.opts.serverBaseUrl ?? null,
        pluginManager: this.opts.pluginManager
          ? {
              listInstalled: () => this.opts.pluginManager?.listInstalled?.() ?? [],
              install: async (input) => {
                gate.require('marketplace:plugins');
                return this.opts.pluginManager?.install?.(input);
              },
              uninstall: async (id) => {
                gate.require('marketplace:plugins');
                return this.opts.pluginManager?.uninstall?.(id);
              },
              activate: async (id) => {
                gate.require('marketplace:plugins');
                return this.opts.pluginManager?.activate?.(id);
              },
              deactivate: async (id) => {
                gate.require('marketplace:plugins');
                return this.opts.pluginManager?.deactivate?.(id);
              },
              upgrade: async (id, version) => {
                gate.require('marketplace:plugins');
                return this.opts.pluginManager?.upgrade?.(id, version);
              }
            }
          : undefined,
        applyProxy: async () => {
          gate.require('system:proxy');
          // No-op here; real impl coordinates with whichever plugin owns proxy.
        }
      },
      userDataDir,
      settings: {
        get: () => settingsBag.current as never,
        set: (next) => {
          settingsBag.current = { ...settingsBag.current, ...(next as Record<string, unknown>) };
          for (const l of listeners) l(settingsBag.current);
        },
        onChange: (listener) => {
          listeners.add(listener as (next: unknown) => void);
          return () => listeners.delete(listener as (next: unknown) => void);
        }
      },
      onConfigChange: (listener) => {
        listeners.add(listener as (next: unknown) => void);
        return () => listeners.delete(listener as (next: unknown) => void);
      },
      expose: (api) => {
        const inst = this.live.get(record.id);
        if (inst) inst.exposed = { ...inst.exposed, ...api };
      },
      call: (pluginId, method, ...args) => this.call(record.id, pluginId, method, ...args) as Promise<never>,
      spawn: (bin, args, opts) => {
        gate.require(`system:exec:${bin}` as Permission);
        return childSpawn(bin, args, { cwd: opts?.cwd, stdio: 'pipe' });
      },
      fetch: async (url, init) => {
        const host = new URL(url).host;
        gate.require(`net:fetch:${host}` as Permission);
        const decision = this.networkPolicy ? await this.networkPolicy(url) : null;
        if (decision && !decision.allowed) {
          throw new Error(`Tunnel policy blocked ${url}: ${decision.reason}`);
        }
        return fetch(url, init);
      },
      log: {
        info: (msg, meta) => this.opts.registry.log(record.id, 'info', msg, meta),
        warn: (msg, meta) => this.opts.registry.log(record.id, 'warn', msg, meta),
        error: (msg, meta) => this.opts.registry.log(record.id, 'error', msg, meta)
      }
    };
    return ctx;
  }
}
