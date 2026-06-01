import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import type { Permission } from '@qpjoy/electron-plugin-sdk';
import type { MarketplaceDB, PluginManifest } from '@qpjoy/marketplace-db';

import type { PluginRegistry } from '../registry/PluginRegistry';
import type { PluginRuntime } from '../runtime/PluginRuntime';
import type { PluginSource, PluginStore } from '../store/PluginStore';
import type { InstalledPluginRecord } from '../types';
import {
  RemoteClient,
  type ClientPluginState,
  type UpdateAction,
  type UpdateReportStatus
} from './RemoteClient';

const META_CLIENT_INSTALL_ID = 'client.installId';
const META_RESTART_REQUIRED = 'updates.restartRequired';

function hostMarketVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function delayMs(base: number, jitter: number): number {
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(60_000, base + offset);
}

export interface UpdateAgentOptions {
  db: MarketplaceDB;
  client: RemoteClient;
  registry: PluginRegistry;
  store: PluginStore;
  runtime: PluginRuntime;
  app: {
    getName(): string;
    getVersion(): string;
    isPackaged: boolean;
  };
  intervalMs?: number;
  jitterMs?: number;
  onResult?: (result: UpdateRunResult) => void;
}

export interface UpdateRunResult {
  outcome: 'ok' | 'skipped' | 'failed';
  startedAt: string;
  finishedAt: string;
  actionsSeen: number;
  actionsApplied: number;
  actionsFailed: number;
  error: string | null;
}

export class UpdateAgent {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly opts: UpdateAgentOptions) {}

  start(): void {
    this.stopped = false;
    this.schedule(8_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async run(reason: 'startup' | 'interval' | 'manual' = 'manual'): Promise<UpdateRunResult> {
    if (this.running) {
      return {
        outcome: 'skipped',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        actionsSeen: 0,
        actionsApplied: 0,
        actionsFailed: 0,
        error: 'another update check is already in flight'
      };
    }

    this.running = true;
    const startedAt = new Date().toISOString();
    const result: UpdateRunResult = {
      outcome: 'ok',
      startedAt,
      finishedAt: '',
      actionsSeen: 0,
      actionsApplied: 0,
      actionsFailed: 0,
      error: null
    };

    try {
      const installId = this.ensureInstallId();
      const response = await this.opts.client.checkUpdates({
        installId,
        deviceId: this.opts.db.getMeta('client.deviceId'),
        platform: process.platform,
        arch: process.arch,
        capabilities: [
          'updates:v1',
          'plugin:apply-version',
          'plugin:rollback',
          'restart:plugin'
        ],
        app: {
          name: this.opts.app.getName(),
          version: this.opts.app.getVersion(),
          isPackaged: this.opts.app.isPackaged
        },
        market: {
          version: hostMarketVersion()
        },
        plugins: this.pluginStates()
      });

      result.actionsSeen = response.actions.length;
      for (const action of response.actions) {
        const status = await this.handleAction(action, installId, reason);
        if (status === 'applied') result.actionsApplied += 1;
        if (status === 'failed') result.actionsFailed += 1;
      }
    } catch (err) {
      result.outcome = 'failed';
      result.error = err instanceof Error ? err.message : String(err);
    } finally {
      result.finishedAt = new Date().toISOString();
      this.running = false;
      this.opts.onResult?.(result);
      if (!this.stopped) this.schedule(delayMs(this.opts.intervalMs ?? 10 * 60_000, this.opts.jitterMs ?? 30_000));
    }

    return result;
  }

  private schedule(delay: number): void {
    if (this.stopped || this.opts.intervalMs === 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.run('interval');
    }, delay);
  }

  private ensureInstallId(): string {
    const existing = this.opts.db.getMeta(META_CLIENT_INSTALL_ID);
    if (existing) return existing;
    const id = randomUUID();
    this.opts.db.setMeta(META_CLIENT_INSTALL_ID, id);
    return id;
  }

  private pluginStates(): ClientPluginState[] {
    return this.opts.registry.list().map((plugin) => ({
      id: plugin.id,
      npm: plugin.npm,
      name: plugin.manifest.name ?? null,
      version: plugin.version,
      state: plugin.state,
      manifest: plugin.manifest as unknown as Record<string, unknown>
    }));
  }

  private async handleAction(
    action: UpdateAction,
    installId: string,
    reason: string
  ): Promise<UpdateReportStatus> {
    if (action.mode === 'manual' || action.mode === 'notify') {
      await this.report(action, installId, 'seen', null, { reason });
      return 'seen';
    }

    if (action.targetKind === 'market') {
      this.markRestartRequired(action, 'market self update requires host app restart');
      await this.report(action, installId, 'restart_required', null, { reason });
      return 'restart_required';
    }

    const id = action.pluginId ?? action.targetId;
    const existing = this.opts.registry.get(id);
    if (!existing && action.mode !== 'force' && action.mode !== 'silent') {
      await this.report(action, installId, 'skipped', 'plugin is not installed', { reason });
      return 'skipped';
    }

    if (existing?.state === 'active' && (action.restartPolicy === 'app' || action.restartPolicy === 'system')) {
      this.markRestartRequired(action, `restart policy is ${action.restartPolicy}`);
      await this.report(action, installId, 'restart_required', null, { reason });
      return 'restart_required';
    }

    try {
      const wasActive = existing?.state === 'active';
      if (wasActive) {
        await this.opts.runtime.deactivate(id).catch(() => undefined);
      }

      const manifest = existing
        ? await this.opts.store.upgrade(id, this.sourceFor(action))
        : await this.opts.store.installFrom({
            id,
            npm: this.requiredNpm(action),
            source: this.sourceFor(action)
          });

      this.applyAutoGrant(id, manifest, action.autoGrant);
      const after = this.opts.registry.get(id);
      const shouldActivate =
        (wasActive && after?.state === 'installed') ||
        (action.autoActivate && after?.state === 'installed');
      if (shouldActivate) {
        await this.opts.runtime.activate(id);
      }

      const finalRecord = this.opts.registry.get(id);
      if (finalRecord?.state === 'awaitingGrant') {
        await this.report(action, installId, 'awaiting_grant', null, { reason });
        return 'awaiting_grant';
      }
      await this.report(action, installId, 'applied', null, { reason });
      this.opts.registry.log(id, 'info', 'release policy applied', {
        planId: action.planId,
        from: action.fromVersion,
        to: action.toVersion,
        mode: action.mode
      });
      return 'applied';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.report(action, installId, 'failed', message, { reason });
      this.opts.registry.log(id, 'error', 'release policy failed', {
        planId: action.planId,
        to: action.toVersion,
        error: message
      });
      return 'failed';
    }
  }

  private sourceFor(action: UpdateAction): PluginSource {
    return {
      type: 'registry',
      version: action.toVersion,
      tarballUrl: action.tarballUrl
    };
  }

  private requiredNpm(action: UpdateAction): string {
    if (!action.npm) {
      throw new Error(`release action for ${action.targetId} did not include npm package name`);
    }
    return action.npm;
  }

  private applyAutoGrant(
    id: string,
    manifest: PluginManifest,
    autoGrant: boolean | 'manifest' | string[] | null
  ): void {
    const permissions =
      autoGrant === true || autoGrant === 'manifest'
        ? manifest.permissions
        : Array.isArray(autoGrant)
        ? autoGrant
        : [];
    if (permissions.length === 0) return;
    this.opts.registry.grant(id, permissions as Permission[]);
    this.opts.registry.setState(id, 'installed');
  }

  private markRestartRequired(action: UpdateAction, reason: string): void {
    this.opts.db.setMeta(
      META_RESTART_REQUIRED,
      JSON.stringify({
        planId: action.planId,
        targetKind: action.targetKind,
        targetId: action.targetId,
        toVersion: action.toVersion,
        restartPolicy: action.restartPolicy,
        reason,
        updatedAt: new Date().toISOString()
      })
    );
  }

  private async report(
    action: UpdateAction,
    installId: string,
    status: UpdateReportStatus,
    error: string | null,
    metadata: Record<string, unknown> | null
  ): Promise<void> {
    await this.opts.client.reportUpdate({
      planId: action.planId,
      actionId: action.actionId,
      targetId: action.targetId,
      targetKind: action.targetKind,
      installId,
      fromVersion: action.fromVersion,
      toVersion: action.toVersion,
      status,
      error,
      metadata
    });
  }
}
