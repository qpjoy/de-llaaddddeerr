import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildHdoRouteProbe,
  excludeLocalRoutesFromAllowedIps,
  generateWireGuardKeyPairWithCli,
  getWireGuardTunnelStatus,
  HDO_MESH_DEFAULTS,
  HDO_MESH_ROUTE_CIDRS,
  localCidrsForAllowedIpExclusion,
  renderHdoClientWireGuardConfig,
  resolveWireGuardConnectionRuntime,
  resolveWireGuardRuntime,
  setWireGuardTunnelState,
  shellQuote
} from '@qpjoy/electron-core-wireguard';

import type {
  HdoDeviceRegistrationInput,
  HdoLocalPluginState,
  HdoNodeInput,
  HdoPluginSettings,
  HdoRateLimitInput,
  HdoServiceInput,
  HdoSnapshot
} from './types';

interface MarketplaceDbLike {
  getActiveSession?(): {
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: string | null;
    user: Record<string, unknown> | null;
  } | null;
  setSession?(session: {
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: string | null;
    user: Record<string, unknown> | null;
  }): void;
  clearSession?(): void;
  listInstalled?(): unknown[];
}

interface PluginManagerLike {
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
}

interface HdoDeviceTaskRecord {
  id: string;
  deviceId: string | null;
  pluginId: string | null;
  kind: string;
  status: string;
  payload: Record<string, unknown> | null;
}

interface HdoTaskRunSummary {
  attempted: number;
  done: number;
  failed: number;
  skipped: number;
  results: Array<Record<string, unknown>>;
}

export interface HdoControllerContext {
  userDataDir: string;
  marketServerBaseUrl?: string | null;
  bundledWireGuardDir?: string | null;
  marketplaceDb?: MarketplaceDbLike;
  pluginManager?: PluginManagerLike;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

export class HdoController {
  private readonly settingsPath: string;
  private settings: HdoPluginSettings;
  private lastError: string | null = null;
  private taskRunner: Promise<HdoTaskRunSummary> | null = null;

  constructor(private readonly ctx: HdoControllerContext) {
    mkdirSync(ctx.userDataDir, { recursive: true });
    this.settingsPath = join(ctx.userDataDir, 'hdo-settings.json');
    this.settings = this.loadSettings();
  }

  getSettings(): HdoPluginSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<HdoPluginSettings>): HdoPluginSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      hdoControlBaseUrl:
        patch.hdoControlBaseUrl === undefined
          ? this.settings.hdoControlBaseUrl
          : normalizeBaseUrl(patch.hdoControlBaseUrl),
      updatedAt: new Date().toISOString()
    };
    this.saveSettings();
    return this.getSettings();
  }

  async snapshot(): Promise<HdoSnapshot> {
    const session = this.sessionSnapshot();
    let readiness: unknown | null = null;
    let devices: unknown[] = [];
    let deviceTasks: unknown[] = [];
    let admin: HdoSnapshot['admin'] = null;
    const wireGuardStatus = this.wireGuardStatus();
    const localPlugins = this.localPluginStates();
    this.lastError = null;

    if (this.serverBaseUrl() && session.hasAccessToken) {
      try {
        const [readinessResult, devicesResult] = await Promise.all([
          this.apiGet('/api/v1/hdo/readiness'),
          this.apiGet('/api/v1/hdo/devices')
        ]);
        readiness = readinessResult;
        devices = Array.isArray(devicesResult) ? devicesResult : [];
        const deviceId = this.settings.deviceId || stringField(devices[0], 'id');
        if (deviceId) {
          await this.reportPluginStates(deviceId).catch((err) => {
            this.ctx.log.warn('failed to report HDO plugin states', {
              error: errorMessage(err)
            });
          });
        }
        const tasksResult = await this.apiGet('/api/v1/hdo/device-tasks?status=pending');
        deviceTasks = Array.isArray(tasksResult) ? tasksResult : [];
        if (this.settings.autoRunDeviceTasks !== false && deviceTasks.length > 0) {
          this.runTasksInBackground(deviceTasks, deviceId);
        }
      } catch (err) {
        this.lastError = errorMessage(err);
      }

      try {
        const overview = await this.apiGet('/api/v1/hdo/admin/overview');
        if (overview && typeof overview === 'object' && !Array.isArray(overview)) {
          const data = overview as Record<string, unknown>;
          admin = {
            users: arrayField(data.users),
            meshGroups: arrayField(data.meshGroups),
            memberships: arrayField(data.memberships),
            nodes: arrayField(data.nodes),
            devices: arrayField(data.devices),
            services: arrayField(data.services),
            profiles: arrayField(data.profiles),
            rateLimits: arrayField(data.rateLimits),
            pluginStates: arrayField(data.pluginStates),
            tasks: arrayField(data.tasks)
          };
        }
      } catch {
        try {
          const [nodes, services, profiles, rateLimits] = await Promise.all([
            this.apiGet('/api/v1/hdo/admin/nodes'),
            this.apiGet('/api/v1/hdo/admin/services'),
            this.apiGet('/api/v1/hdo/admin/profiles'),
            this.apiGet('/api/v1/hdo/admin/rate-limits')
          ]);
          admin = {
            nodes: Array.isArray(nodes) ? nodes : [],
            services: Array.isArray(services) ? services : [],
            profiles: Array.isArray(profiles) ? profiles : [],
            rateLimits: Array.isArray(rateLimits) ? rateLimits : []
          };
        } catch {
          admin = null;
        }
      }
    }

    return {
      serverBaseUrl: this.serverBaseUrl(),
      marketServerBaseUrl: this.ctx.marketServerBaseUrl ?? null,
      settings: this.getSettings(),
      session,
      readiness,
      devices,
      deviceTasks,
      localPlugins,
      wireGuardStatus,
      taskRunnerBusy: Boolean(this.taskRunner),
      admin,
      lastError: this.lastError
    };
  }

  async registerDevice(input: HdoDeviceRegistrationInput): Promise<unknown> {
    const body = {
      id: input.id || this.settings.deviceId || `hdo-dev-${randomUUID()}`,
      label: input.label || this.settings.deviceLabel || defaultDeviceLabel(),
      platform: input.platform || this.settings.devicePlatform || process.platform,
      publicKey: input.publicKey || null,
      overlayIp: input.overlayIp || null,
      metadata: input.metadata ?? {
        source: '@qpjoy/electron-plugin-hdo',
        arch: process.arch
      },
      plugins: this.localPluginStates()
    };
    const device = await this.apiPost('/api/v1/hdo/devices/register', body);
    const deviceId = stringField(device, 'id') ?? body.id;
    this.updateSettings({
      deviceId,
      deviceLabel: body.label,
      devicePlatform: body.platform
    });
    return device;
  }

  async reportPluginStates(deviceId?: string | null): Promise<unknown[]> {
    const id = deviceId || this.settings.deviceId;
    if (!id) return [];
    const result = await this.apiPost(`/api/v1/hdo/devices/${encodeURIComponent(id)}/plugin-states`, {
      plugins: this.localPluginStates()
    });
    return Array.isArray(result) ? result : [];
  }

  async executePendingTasks(): Promise<HdoTaskRunSummary> {
    if (this.taskRunner) return this.taskRunner;
    this.taskRunner = this.executePendingTasksInner().finally(() => {
      this.taskRunner = null;
    });
    return this.taskRunner;
  }

  async refreshManifest(deviceId?: string | null): Promise<Record<string, unknown>> {
    const id = deviceId || this.settings.deviceId;
    if (!id) throw new Error('deviceId required');
    const manifest = await this.apiGet(`/api/v1/hdo/manifest/${encodeURIComponent(id)}`);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest response is not an object');
    }
    this.updateSettings({ lastManifest: manifest as Record<string, unknown> });
    return manifest as Record<string, unknown>;
  }

  async refreshSubscription(deviceId?: string | null): Promise<string> {
    const id = deviceId || this.settings.deviceId;
    if (!id) throw new Error('deviceId required');
    const content = await this.apiText(
      `/api/v1/hdo/subscriptions/${encodeURIComponent(id)}/mihomo.yaml`
    );
    this.updateSettings({ lastSubscription: content });
    return content;
  }

  async prepareWireGuardPeer(input: { rotate?: boolean | null } = {}): Promise<Record<string, unknown>> {
    const routeProbe = buildHdoRouteProbe();
    const now = new Date().toISOString();
    const previous = this.settings.wireGuardPeer ?? {};
    let privateKey = stringValue(previous.privateKey);
    let publicKey = stringValue(previous.publicKey);
    let keySource = 'existing';
    const runtime = resolveWireGuardRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: false
    });

    if (input.rotate || !privateKey || !publicKey) {
      if (!runtime.command) {
        const lastError =
          `当前 HDO 插件包缺少适配 ${runtime.target} 的 WireGuard CLI 引擎；需要随插件安装对应的 @qpjoy/electron-core-wireguard-engine-${runtime.target}，或把 wg 放入插件资源目录。`;
        const peer = {
          ...previous,
          routeProbe,
          canUseDefaultMesh: routeProbe.canUseDefaultMesh,
          lastError,
          updatedAt: now
        };
        this.updateSettings({ wireGuardPeer: peer });
        return {
          ok: false,
          reason: 'bundled-wireguard-cli-missing',
          message: lastError,
          runtime,
          routeProbe,
          peer: publicWireGuardPeer(peer)
        };
      }

      try {
        const pair = generateWireGuardKeyPairWithCli(runtime.command);
        privateKey = pair.privateKey;
        publicKey = pair.publicKey;
        keySource = runtime.source;
      } catch (err) {
        const lastError =
          `内置 WireGuard CLI 无法生成密钥：${errorMessage(err)}。请重新安装包含 ${runtime.target} 引擎资源的 HDO 包。`;
        const peer = {
          ...previous,
          routeProbe,
          canUseDefaultMesh: routeProbe.canUseDefaultMesh,
          lastError,
          updatedAt: now
        };
        this.updateSettings({ wireGuardPeer: peer });
        return {
          ok: false,
          reason: 'bundled-wireguard-cli-failed',
          message: lastError,
          runtime,
          routeProbe,
          peer: publicWireGuardPeer(peer)
        };
      }
    }

    const device = await this.registerDevice({
      id: this.settings.deviceId,
      label: this.settings.deviceLabel,
      publicKey,
      metadata: {
        source: '@qpjoy/electron-plugin-hdo',
        arch: process.arch,
        wireGuard: {
          publicKey,
          routeProbe,
          keySource,
          updatedAt: now
        }
      }
    });
    const overlayIp = stringField(device, 'overlayIp') ?? stringValue(previous.overlayIp);
    let manifest: Record<string, unknown> | null = null;
    let config: string | null = null;
    let configPath: string | null = null;
    let lastError: string | null = null;

    try {
      manifest = await this.refreshManifest(stringField(device, 'id') ?? this.settings.deviceId);
      const domestic = domesticWireGuardFromManifest(manifest);
      if (!overlayIp) {
        lastError = '服务端尚未给当前设备分配 overlay IP。';
      } else if (!domestic.publicKey || !domestic.endpoint) {
        lastError =
          'manifest 中缺少 domestic WireGuard 公钥或 endpoint；请在服务器 HDO 管理页给 domestic 节点 metadata.wireGuard 填入 publicKey/listenPort。';
      } else {
        const exclusionCidrs = localCidrsForAllowedIpExclusion(routeProbe, domestic.routeCidrs);
        let allowedIps = excludeLocalRoutesFromAllowedIps(
          domestic.routeCidrs,
          exclusionCidrs
        );
        if (allowedIps.length === 0 && process.platform === 'win32') {
          allowedIps = domestic.routeCidrs;
        } else if (allowedIps.length === 0) {
          throw new Error('服务端下发的 WireGuard AllowedIPs 与本机路由完全重叠，已拒绝生成会覆盖本地网络的配置。');
        }
        config = renderHdoClientWireGuardConfig({
          privateKey,
          address: wireGuardAddress(overlayIp),
          domesticPublicKey: domestic.publicKey,
          domesticEndpoint: domestic.endpoint,
          allowedIps,
          persistentKeepalive: 25
        });
        configPath = this.writeWireGuardProfile(config);
      }
    } catch (err) {
      lastError = errorMessage(err);
    }

    const peer = {
      privateKey,
      publicKey,
      overlayIp,
      address: overlayIp ? wireGuardAddress(overlayIp) : null,
      config,
      configPath,
      allowedIps: config ? wireGuardAllowedIps(config) : null,
      routeProbe,
      canUseDefaultMesh: routeProbe.canUseDefaultMesh,
      lastError,
      updatedAt: now
    };
    this.updateSettings({ wireGuardPeer: peer });
    return {
      ok: Boolean(config),
      message: config ? '已生成本机 WireGuard peer 与客户端配置。' : lastError,
      routeProbe,
      device,
      manifest,
      peer: publicWireGuardPeer(peer),
      config
    };
  }

  async openWireGuardProfile(): Promise<Record<string, unknown>> {
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) {
      throw new Error('WireGuard 配置文件不存在，请先点击“连接 / 更新 HDO”或“生成 / 更新本机 Peer”。');
    }

    if (process.platform === 'darwin') {
      await execFileAsync('open', ['-a', 'WireGuard']);
      await execFileAsync('open', ['-R', configPath]).catch(() => undefined);
      await copyTextToClipboard(configPath).catch(() => undefined);
      return {
        ok: true,
        mode: 'macos-wireguard-app',
        configPath,
        message:
          '已打开 macOS WireGuard App，并在 Finder 里定位配置文件；配置路径也已复制到剪贴板。请在 WireGuard 中导入该 conf 后启用。'
      };
    }

    if (process.platform === 'win32') {
      await execFileAsync('explorer.exe', [`/select,${configPath}`]).catch(() => undefined);
      return {
        ok: true,
        mode: 'windows-reveal-config',
        configPath,
        message: '已在 Explorer 中定位 WireGuard 配置文件。'
      };
    }

    await execFileAsync('xdg-open', [dirname(configPath)]).catch(() => undefined);
    return {
      ok: true,
      mode: 'linux-reveal-config',
      configPath,
      message: '已尝试打开配置文件目录。'
    };
  }

  async connectWireGuardPeer(input: { action?: 'up' | 'down' | null } = {}): Promise<Record<string, unknown>> {
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) {
      throw new Error('WireGuard 配置文件不存在，请先点击“连接 / 更新 HDO”或“生成 / 更新本机 Peer”。');
    }
    const action = input.action === 'down' ? 'down' : 'up';
    const runtime = resolveWireGuardConnectionRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: true
    });
    const result = await setWireGuardTunnelState({
      runtime,
      configPath,
      action
    });
    return {
      ...result,
      message: result.message,
      runtime: publicWireGuardRuntime(result.runtime)
    };
  }

  wireGuardStatus(): Record<string, unknown> | null {
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) return null;
    const runtime = resolveWireGuardConnectionRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: true
    });
    try {
      const status = getWireGuardTunnelStatus({ runtime, configPath });
      return {
        ...status,
        runtime: publicWireGuardRuntime(status.runtime)
      };
    } catch (err) {
      return {
        ok: false,
        active: false,
        configPath,
        error: errorMessage(err),
        runtime: publicWireGuardRuntime(runtime)
      };
    }
  }

  async upsertNode(input: HdoNodeInput): Promise<unknown> {
    return this.apiPost('/api/v1/hdo/admin/nodes', input);
  }

  async heartbeatNode(id: string): Promise<unknown> {
    return this.apiPost(`/api/v1/hdo/admin/nodes/${encodeURIComponent(id)}/heartbeat`, {
      status: 'online'
    });
  }

  async upsertService(input: HdoServiceInput): Promise<unknown> {
    return this.apiPost('/api/v1/hdo/admin/services', input);
  }

  async upsertRateLimit(input: HdoRateLimitInput): Promise<unknown> {
    return this.apiPost('/api/v1/hdo/admin/rate-limits', input);
  }

  installCommands(): { domestic: string; home: string; oversea: string } {
    const base = this.serverBaseUrl() ?? 'https://your-domestic-server';
    return {
      domestic: [
        './scripts/manage.sh deploy hdo',
        '# Non-interactive fallback:',
        `./scripts/manage.sh deploy hdo --yes --server-url ${shellQuote(base)} --public-host <domestic-domain-or-ip> --port ${HDO_MESH_DEFAULTS.defaultListenPort}`
      ].join('\n'),
      home: `./scripts/manage.sh hdo add-home --name home-main --server-url ${shellQuote(base)}`,
      oversea: `./scripts/manage.sh hdo setup-oversea-egress --server-url ${shellQuote(base)}`
    };
  }

  private serverBaseUrl(): string | null {
    return this.settings.hdoControlBaseUrl || this.ctx.marketServerBaseUrl || null;
  }

  private sessionSnapshot() {
    const session = this.ctx.marketplaceDb?.getActiveSession?.() ?? null;
    return {
      loggedIn: Boolean(session?.user && session.accessToken),
      user: session?.user ?? null,
      hasAccessToken: Boolean(session?.accessToken)
    };
  }

  private localPluginStates(): HdoLocalPluginState[] {
    const rows = this.ctx.marketplaceDb?.listInstalled?.() ?? [];
    return rows
      .map((row) => normalizeInstalledPlugin(row))
      .filter((row): row is HdoLocalPluginState => Boolean(row));
  }

  private runTasksInBackground(tasks: unknown[], deviceId?: string | null): void {
    if (this.taskRunner) return;
    if (!tasks.some((task) => this.canRunTask(task, deviceId))) return;
    this.taskRunner = this.executePendingTasksInner()
      .catch((err) => {
        this.ctx.log.warn('HDO task runner failed', { error: errorMessage(err) });
        return {
          attempted: 0,
          done: 0,
          failed: 1,
          skipped: 0,
          results: [{ ok: false, error: errorMessage(err) }]
        };
      })
      .finally(() => {
        this.taskRunner = null;
      });
  }

  private async executePendingTasksInner(): Promise<HdoTaskRunSummary> {
    const deviceId = this.settings.deviceId;
    const tasksRaw = await this.apiGet('/api/v1/hdo/device-tasks?status=pending');
    const tasks = Array.isArray(tasksRaw) ? tasksRaw : [];
    const summary: HdoTaskRunSummary = {
      attempted: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      results: []
    };

    for (const task of tasks) {
      const row = taskRecord(task);
      if (!row || !this.canRunTask(row, deviceId)) {
        summary.skipped += 1;
        continue;
      }

      summary.attempted += 1;
      let claimed: HdoDeviceTaskRecord | null = null;
      try {
        const claimedRaw = await this.apiPost(`/api/v1/hdo/device-tasks/${encodeURIComponent(row.id)}/claim`, {
          deviceId: deviceId ?? null
        });
        claimed = taskRecord(claimedRaw);
        if (!claimed) throw new Error('invalid claim response');
      } catch (err) {
        summary.skipped += 1;
        summary.results.push({
          id: row.id,
          kind: row.kind,
          ok: false,
          skipped: true,
          error: errorMessage(err)
        });
        continue;
      }

      try {
        const result = await this.executeClaimedTask(claimed);
        await this.apiPost(`/api/v1/hdo/device-tasks/${encodeURIComponent(claimed.id)}/complete`, {
          status: 'done',
          result
        });
        summary.done += 1;
        summary.results.push({ id: claimed.id, kind: claimed.kind, ok: true, result });
      } catch (err) {
        const result = { error: errorMessage(err) };
        await this.apiPost(`/api/v1/hdo/device-tasks/${encodeURIComponent(claimed.id)}/complete`, {
          status: 'failed',
          result
        }).catch((completeErr) => {
          this.ctx.log.warn('failed to complete HDO task', {
            taskId: claimed?.id,
            error: errorMessage(completeErr)
          });
        });
        summary.failed += 1;
        summary.results.push({
          id: claimed.id,
          kind: claimed.kind,
          ok: false,
          error: result.error
        });
      }
    }

    await this.reportPluginStates(deviceId).catch(() => undefined);
    this.updateSettings({
      lastTaskRun: {
        ...summary,
        ranAt: new Date().toISOString()
      }
    });
    return summary;
  }

  private canRunTask(task: unknown, deviceId?: string | null): boolean {
    const row = taskRecord(task);
    if (!row || row.status !== 'pending') return false;
    return !row.deviceId || !deviceId || row.deviceId === deviceId;
  }

  private async executeClaimedTask(task: HdoDeviceTaskRecord): Promise<Record<string, unknown>> {
    const manager = this.ctx.pluginManager;
    if (!manager) throw new Error('当前插件市场 host 不支持 HDO 远程任务执行');
    const payload = task.payload ?? {};
    const pluginId = stringValue(payload.id) ?? stringValue(payload.pluginId) ?? task.pluginId;
    const npm = stringValue(payload.npm) ?? (pluginId?.startsWith('@') ? pluginId : null);

    switch (task.kind) {
      case 'install-plugin': {
        const installed = await manager.install?.({
          id: npm ? stringValue(payload.id) : pluginId,
          npm,
          version: stringValue(payload.version),
          tarballUrl: stringValue(payload.tarballUrl),
          autoGrant: normalizeAutoGrant(payload.autoGrant ?? payload.grant),
          activate: booleanValue(payload.activate) ?? false
        });
        if (!installed) throw new Error('host pluginManager.install unavailable');
        return { installed };
      }
      case 'uninstall-plugin': {
        const id = requireTaskPluginId(pluginId, task.kind);
        const result = await manager.uninstall?.(id);
        if (!result) throw new Error('host pluginManager.uninstall unavailable');
        return { uninstalled: id, result };
      }
      case 'activate-plugin': {
        const id = requireTaskPluginId(pluginId, task.kind);
        const result = await manager.activate?.(id);
        if (!result) throw new Error('host pluginManager.activate unavailable');
        return { activated: id, result };
      }
      case 'deactivate-plugin': {
        const id = requireTaskPluginId(pluginId, task.kind);
        const result = await manager.deactivate?.(id);
        if (!result) throw new Error('host pluginManager.deactivate unavailable');
        return { deactivated: id, result };
      }
      case 'apply-hdo-profile': {
        const activeProfileId = stringValue(payload.profileId) ?? stringValue(payload.activeProfileId);
        this.updateSettings({ activeProfileId });
        return { activeProfileId };
      }
      default:
        throw new Error(`unsupported HDO task kind: ${task.kind}`);
    }
  }

  private async accessToken(): Promise<string> {
    const session = this.ctx.marketplaceDb?.getActiveSession?.() ?? null;
    if (session?.refreshToken && tokenNeedsRefresh(session.expiresAt)) {
      await this.refreshAccessToken(session.refreshToken);
    }
    const token = this.ctx.marketplaceDb?.getActiveSession?.()?.accessToken;
    if (!token) throw new Error('请先在插件市场登录 / 注册');
    return token;
  }

  private async apiGet(path: string): Promise<unknown> {
    return this.apiJson(path, { method: 'GET' });
  }

  private async apiPost(path: string, body: unknown): Promise<unknown> {
    return this.apiJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
  }

  private async apiJson(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(errorFromResponse(parsed) || `${res.status} ${res.statusText}`);
    }
    return parsed;
  }

  private async apiText(path: string): Promise<string> {
    const res = await this.fetch(path, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `${res.status} ${res.statusText}`);
    return text;
  }

  private async fetch(path: string, init: RequestInit, retried = false): Promise<Response> {
    const base = this.serverBaseUrl();
    if (!base) {
      throw new Error('未配置 HDO 控制面 URL');
    }
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await this.accessToken()}`);
    const res = await fetch(new URL(path, base).toString(), {
      ...init,
      headers
    });
    if (res.status === 401 && !retried) {
      const refreshToken = this.ctx.marketplaceDb?.getActiveSession?.()?.refreshToken;
      if (refreshToken && (await this.refreshAccessToken(refreshToken).catch(() => false))) {
        return this.fetch(path, init, true);
      }
    }
    return res;
  }

  private async refreshAccessToken(refreshToken: string): Promise<boolean> {
    const base = this.serverBaseUrl();
    if (!base) return false;
    const res = await fetch(new URL('/api/v1/auth/refresh', base).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) this.ctx.marketplaceDb?.clearSession?.();
      return false;
    }
    const tokens = (await res.json()) as {
      accessToken?: string;
      refreshToken?: string;
      accessExpiresAt?: string;
      refreshExpiresAt?: string;
    };
    if (!tokens.accessToken || !tokens.refreshToken || !tokens.accessExpiresAt) return false;
    const session = this.ctx.marketplaceDb?.getActiveSession?.() ?? null;
    this.ctx.marketplaceDb?.setSession?.({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.accessExpiresAt,
      user: session?.user
        ? { ...session.user, refreshExpiresAt: tokens.refreshExpiresAt ?? null }
        : null
    });
    return true;
  }

  private loadSettings(): HdoPluginSettings {
    if (!existsSync(this.settingsPath)) {
      return {
        hdoControlBaseUrl: normalizeBaseUrl(process.env.QPJOY_HDO_SERVER) ?? null,
        deviceId: null,
        deviceLabel: defaultDeviceLabel(),
        devicePlatform: process.platform,
        autoRunDeviceTasks: true,
        activeProfileId: null,
        wireGuardPeer: null,
        lastTaskRun: null,
        lastManifest: null,
        lastSubscription: null,
        updatedAt: null
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as HdoPluginSettings;
      return {
        ...parsed,
        hdoControlBaseUrl: normalizeBaseUrl(parsed.hdoControlBaseUrl) ?? null,
        wireGuardPeer: parsed.wireGuardPeer ?? null,
        autoRunDeviceTasks: parsed.autoRunDeviceTasks ?? true,
        activeProfileId: parsed.activeProfileId ?? null,
        lastTaskRun: parsed.lastTaskRun ?? null
      };
    } catch (err) {
      this.ctx.log.warn('failed to read HDO settings, using defaults', {
        error: errorMessage(err)
      });
      return {
        hdoControlBaseUrl: null,
        deviceId: null,
        deviceLabel: defaultDeviceLabel(),
        devicePlatform: process.platform,
        autoRunDeviceTasks: true,
        activeProfileId: null,
        wireGuardPeer: null,
        lastTaskRun: null,
        lastManifest: null,
        lastSubscription: null,
        updatedAt: null
      };
    }
  }

  private saveSettings(): void {
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2) + '\n', {
      mode: 0o600
    });
  }

  private writeWireGuardProfile(config: string): string {
    const dir = join(this.ctx.userDataDir, 'wireguard');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'hdo-client.conf');
    writeFileSync(configPath, config, { mode: 0o600 });
    return configPath;
  }
}

function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '0' || trimmed === 'false') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function defaultDeviceLabel(): string {
  return `HDO ${process.platform}-${process.arch}`;
}

function tokenNeedsRefresh(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs - Date.now() <= 60_000;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function copyTextToClipboard(value: string): Promise<void> {
  return execFileAsync('osascript', ['-e', `set the clipboard to ${appleScriptString(value)}`]);
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function errorFromResponse(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
    return String((value as { error: unknown }).error);
  }
  return null;
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw ? raw : null;
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function taskRecord(value: unknown): HdoDeviceTaskRecord | null {
  const row = plainObject(value);
  if (!row) return null;
  const id = stringValue(row.id);
  const kind = stringValue(row.kind);
  const status = stringValue(row.status);
  if (!id || !kind || !status) return null;
  return {
    id,
    kind,
    status,
    deviceId: stringValue(row.deviceId),
    pluginId: stringValue(row.pluginId),
    payload: plainObject(row.payload)
  };
}

function normalizeAutoGrant(value: unknown): boolean | 'manifest' | string[] | null {
  if (value === true || value === 'manifest') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
  }
  return null;
}

function requireTaskPluginId(value: string | null, kind: string): string {
  if (!value) throw new Error(`${kind} requires pluginId`);
  return value;
}

function publicWireGuardPeer(value: Record<string, unknown>): Record<string, unknown> {
  const { privateKey: _privateKey, ...safe } = value;
  return safe;
}

function publicWireGuardRuntime(value: unknown): Record<string, unknown> {
  const runtime = plainObject(value);
  return runtime ? { ...runtime } : {};
}

function domesticWireGuardFromManifest(manifest: Record<string, unknown>): {
  publicKey: string | null;
  endpoint: string | null;
  routeCidrs: string[];
} {
  const wireGuard = plainObject(manifest.wireGuard);
  const domestic = plainObject(wireGuard?.domestic);
  const publicKey = stringValue(domestic?.publicKey);
  const endpointFromManifest = stringValue(domestic?.endpoint);
  const host = stringValue(domestic?.endpointHost);
  const port = numberValue(domestic?.listenPort);
  return {
    publicKey,
    endpoint: endpointFromManifest ?? (host && port ? `${host}:${port}` : null),
    routeCidrs: stringArray(wireGuard?.routeCidrs).length
      ? stringArray(wireGuard?.routeCidrs)
      : HDO_MESH_ROUTE_CIDRS
  };
}

function wireGuardAddress(value: string): string {
  return value.includes('/') ? value : `${value}/32`;
}

function wireGuardAllowedIps(config: string): string[] {
  const line = config
    .split(/\r?\n/)
    .find((row) => row.trim().toLowerCase().startsWith('allowedips'));
  if (!line) return [];
  return line
    .replace(/^[^=]+=/, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
}

function normalizeInstalledPlugin(value: unknown): HdoLocalPluginState | null {
  const row = plainObject(value);
  if (!row) return null;
  const manifest = plainObject(row.manifest);
  const pluginId = stringField(row, 'id') || stringField(row, 'pluginId') || stringField(manifest, 'id');
  if (!pluginId) return null;
  return {
    pluginId,
    npm: stringField(row, 'npm'),
    name: stringField(manifest, 'name') || stringField(row, 'name'),
    version: stringField(row, 'version') || stringField(manifest, 'version'),
    state: stringField(row, 'state') || 'unknown',
    manifest,
    health: {
      errorMessage: stringField(row, 'errorMessage'),
      updatedAt: stringField(row, 'updatedAt'),
      installedAt: stringField(row, 'installedAt')
    }
  };
}
