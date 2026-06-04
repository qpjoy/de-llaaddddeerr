import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildHdoRouteProbe,
  excludeLocalRoutesFromAllowedIps,
  generateWireGuardKeyPairWithCli,
  getDarwinWireGuardLaunchDaemonStatus,
  getWireGuardTunnelStatus,
  HDO_MESH_DEFAULTS,
  HDO_MESH_ROUTE_CIDRS,
  installDarwinWireGuardLaunchDaemon,
  localCidrsForAllowedIpExclusion,
  normalizeCidr,
  repairWireGuardTunnelRoutes,
  renderHdoClientWireGuardConfig,
  resolveWireGuardConnectionRuntime,
  resolveWireGuardRuntime,
  setWireGuardTunnelState,
  shellQuote,
  uninstallDarwinWireGuardLaunchDaemon
} from './wireguard-core';
import {
  HdoSessionDomainProxy,
  type HdoDomainBinding,
  type HdoSessionLike
} from './domainProxy';

import type {
  HdoDeviceRegistrationInput,
  HdoLocalPluginState,
  HdoNetworkLeaseSettings,
  HdoNetworkLeasesSettings,
  HdoNodeInput,
  HdoPluginSettings,
  HdoRelayMode,
  HdoPublishedServiceInput,
  HdoRateLimitInput,
  HdoServiceInput,
  HdoSnapshot
} from './types';

type WireGuardPeerAction = 'up' | 'down' | 'restart';
type WireGuardPeerConnectInput = {
  action?: 'up' | 'down' | 'restart' | null;
  skipIfActive?: boolean | null;
  fallbackToAppManaged?: boolean | null;
};
type WireGuardConnectionRuntime = ReturnType<typeof resolveWireGuardConnectionRuntime>;
type HdoEventListener = (event: Record<string, unknown>) => void;
type HdoNetworkLeaseMode = 'anonymous' | 'account';

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

type WireGuardRecoveryInput =
  | string
  | null
  | {
      reason?: string | null;
      allowPrivileged?: boolean | null;
    };

export interface HdoControllerContext {
  userDataDir: string;
  marketServerBaseUrl?: string | null;
  bundledWireGuardDir?: string | null;
  session?: HdoSessionLike | null;
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
  private wireGuardRecovery: Promise<Record<string, unknown>> | null = null;
  private readonly domainProxy: HdoSessionDomainProxy | null = null;
  private readonly eventListeners = new Set<HdoEventListener>();
  private lastPresenceReportAt = 0;
  private lastPresenceStatus: HdoDeviceRegistrationInput['status'] | null = null;

  constructor(private readonly ctx: HdoControllerContext) {
    mkdirSync(ctx.userDataDir, { recursive: true });
    this.settingsPath = join(ctx.userDataDir, 'hdo-settings.json');
    this.settings = this.loadSettings();
    this.domainProxy = ctx.session
      ? new HdoSessionDomainProxy(ctx.session, {
          warn: (msg, meta) => ctx.log.warn(msg, meta)
        })
      : null;
  }

  getSettings(): HdoPluginSettings {
    this.ensureSettingsForCurrentSession();
    return { ...this.settings };
  }

  onEvent(listener: HdoEventListener): () => void {
    if (typeof listener !== 'function') {
      throw new Error('HDO event listener must be a function');
    }
    this.eventListeners.add(listener);
    try {
      listener(this.publicStateEvent('snapshot', { initial: true }));
    } catch (err) {
      this.ctx.log.warn('HDO event listener failed', {
        event: 'snapshot',
        error: errorMessage(err)
      });
    }
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  updateSettings(patch: Partial<HdoPluginSettings>): HdoPluginSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      relayMode:
        patch.relayMode === undefined
          ? normalizeRelayMode(this.settings.relayMode)
          : normalizeRelayMode(patch.relayMode),
      hdoControlBaseUrl:
        patch.hdoControlBaseUrl === undefined
          ? this.settings.hdoControlBaseUrl
          : normalizeBaseUrl(patch.hdoControlBaseUrl),
      updatedAt: new Date().toISOString()
    };
    this.saveSettings();
    const next = this.getSettings();
    this.emitEvent('settings-updated');
    return next;
  }

  async snapshot(): Promise<HdoSnapshot> {
    this.ensureSettingsForCurrentSession();
    const session = this.sessionSnapshot();
    let readiness: unknown | null = null;
    let devices: unknown[] = [];
    let deviceTasks: unknown[] = [];
    let admin: HdoSnapshot['admin'] = null;
    const wireGuardStatus = this.wireGuardStatus();
    const wireGuardDaemonStatus = this.wireGuardLaunchDaemonStatus();
    const localPlugins = this.localPluginStates();
    this.lastError = null;

    const usingAnonymousNetwork = this.isAnonymousNetworkActive();
    if (this.serverBaseUrl() && session.hasAccessToken) {
      try {
        const [readinessResult, devicesResult] = await Promise.all([
          this.apiGet('/api/v1/hdo/readiness'),
          this.apiGet('/api/v1/hdo/devices')
        ]);
        readiness = readinessResult;
        devices = Array.isArray(devicesResult) ? devicesResult : [];
        const deviceId = usingAnonymousNetwork ? null : (this.settings.deviceId || stringField(devices[0], 'id'));
        if (deviceId) {
          await this.reportPluginStates(deviceId).catch((err) => {
            this.ctx.log.warn('failed to report HDO plugin states', {
              error: errorMessage(err)
            });
          });
          void this.reportDevicePresence(wireGuardStatus && wireGuardStatus.active === true ? 'online' : 'offline', {
            throttleMs: 10 * 60 * 1000
          }).catch((err) => {
            this.ctx.log.warn('failed to report HDO device presence', {
              error: errorMessage(err)
            });
          });
        }
        if (!usingAnonymousNetwork) {
          const tasksResult = await this.apiGet('/api/v1/hdo/device-tasks?status=pending');
          deviceTasks = Array.isArray(tasksResult) ? tasksResult : [];
          if (this.settings.autoRunDeviceTasks !== false && deviceTasks.length > 0) {
            this.runTasksInBackground(deviceTasks, deviceId);
          }
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
      wireGuardDaemonStatus,
      taskRunnerBusy: Boolean(this.taskRunner),
      admin,
      lastError: this.lastError
    };
  }

  async registerDevice(input: HdoDeviceRegistrationInput): Promise<unknown> {
    this.ensureSettingsForCurrentSession();
    const body = {
      id: input.id || this.settings.deviceId || `hdo-dev-${randomUUID()}`,
      label: input.label || this.settings.deviceLabel || defaultDeviceLabel(),
      platform: input.platform || this.settings.devicePlatform || process.platform,
      publicKey: input.publicKey || null,
      overlayIp: input.overlayIp || null,
      metadata: input.metadata ?? {
        source: '@qpjoy/electron-plugin-hdo',
        arch: process.arch,
        wireGuard: wireGuardPreferenceMetadata(this.settings.relayMode)
      },
      status: input.status,
      plugins: this.localPluginStates()
    };
    let device: unknown;
    let submittedDeviceId = body.id;
    try {
      device = await this.apiPost('/api/v1/hdo/devices/register', body);
    } catch (err) {
      if (!isDeviceOwnershipError(err)) throw err;
      const retryBody = {
        ...body,
        id: `hdo-dev-${randomUUID()}`,
        overlayIp: null
      };
      submittedDeviceId = retryBody.id;
      this.ctx.log.warn('HDO device id belongs to another user; retrying with a fresh device id', {
        staleDeviceId: body.id,
        nextDeviceId: retryBody.id
      });
      device = await this.apiPost('/api/v1/hdo/devices/register', retryBody);
    }
    const deviceId = stringField(device, 'id') ?? submittedDeviceId;
    this.updateSettings({
      deviceId,
      deviceLabel: body.label,
      devicePlatform: body.platform
    });
    return device;
  }

  async reportPluginStates(deviceId?: string | null): Promise<unknown[]> {
    this.ensureSettingsForCurrentSession();
    const id = deviceId || this.settings.deviceId;
    if (!id) return [];
    const result = await this.apiPost(`/api/v1/hdo/devices/${encodeURIComponent(id)}/plugin-states`, {
      plugins: this.localPluginStates()
    });
    return Array.isArray(result) ? result : [];
  }

  async reportDevicePresence(
    status: HdoDeviceRegistrationInput['status'],
    options: { throttleMs?: number } = {}
  ): Promise<unknown | null> {
    if (!status) return null;
    this.ensureSettingsForCurrentSession();
    if (this.isAnonymousNetworkActive()) return null;
    const now = Date.now();
    const throttleMs = options.throttleMs ?? 0;
    if (
      throttleMs > 0 &&
      this.lastPresenceStatus === status &&
      now - this.lastPresenceReportAt < throttleMs
    ) {
      return null;
    }
    const peer = this.settings.wireGuardPeer ?? {};
    const result = await this.registerDevice({
      id: this.settings.deviceId,
      label: this.settings.deviceLabel,
      platform: this.settings.devicePlatform,
      publicKey: stringValue(peer.publicKey),
      overlayIp: stringValue(peer.overlayIp),
      status,
      metadata: {
        source: '@qpjoy/electron-plugin-hdo',
        arch: process.arch,
        wireGuard: {
          publicKey: stringValue(peer.publicKey),
          ...wireGuardPreferenceMetadata(this.settings.relayMode)
        },
        presence: {
          status,
          reportedAt: new Date(now).toISOString()
        }
      }
    });
    this.lastPresenceStatus = status;
    this.lastPresenceReportAt = now;
    return result;
  }

  private async reportAnonymousH2iDirectReady(input: {
    appId: string;
    installId: string;
    deviceLabel: string;
    platform: string;
    publicKey: string;
    overlayIp: string;
    relayMode: HdoRelayMode;
    candidateIps: string[];
  }): Promise<Record<string, unknown>> {
    const readyIps = await this.probeH2iDirectReadyIps(input.candidateIps);
    if (readyIps.length === 0) {
      return {
        ok: false,
        skipped: true,
        reason: 'h2i-direct-probe-failed',
        candidateIps: input.candidateIps
      };
    }
    const bootstrap = await this.apiPostPublic('/api/v1/hdo/anonymous/bootstrap', {
      appId: input.appId,
      installId: input.installId,
      deviceLabel: input.deviceLabel,
      platform: input.platform,
      publicKey: input.publicKey,
      overlayIp: input.overlayIp,
      relayMode: input.relayMode,
      preferDirectPeers: input.relayMode !== 'mesh-hdi',
      h2iDirectReady: true,
      h2iDirectReadyIps: readyIps
    });
    const manifest = plainObject(plainObject(bootstrap)?.manifest);
    if (manifest) this.updateSettings({ lastManifest: manifest });
    return {
      ok: true,
      mode: 'anonymous',
      readyIps,
      bootstrap
    };
  }

  private async reportAccountH2iDirectReady(): Promise<Record<string, unknown>> {
    const peer = this.settings.wireGuardPeer ?? {};
    const candidateIps = stringArray(peer.h2iDirectCandidateIps);
    if (candidateIps.length === 0) {
      return { ok: false, skipped: true, reason: 'no-h2i-direct-candidates' };
    }
    const publicKey = stringValue(peer.publicKey);
    const overlayIp = accountOverlayIp(peer.overlayIp);
    if (!publicKey || !overlayIp) {
      return { ok: false, skipped: true, reason: 'missing-account-peer' };
    }
    const readyIps = await this.probeH2iDirectReadyIps(candidateIps);
    if (readyIps.length === 0) {
      return {
        ok: false,
        skipped: true,
        reason: 'h2i-direct-probe-failed',
        candidateIps
      };
    }
    const device = await this.registerDevice({
      id: this.settings.deviceId,
      label: this.settings.deviceLabel,
      platform: this.settings.devicePlatform,
      publicKey,
      overlayIp,
      status: 'online',
      metadata: {
        source: '@qpjoy/electron-plugin-hdo',
        arch: process.arch,
        wireGuard: {
          publicKey,
          h2iDirectReady: true,
          h2iDirectReadyIps: readyIps,
          ...wireGuardPreferenceMetadata(this.settings.relayMode),
          updatedAt: new Date().toISOString()
        }
      }
    });
    return {
      ok: true,
      mode: 'account',
      readyIps,
      device
    };
  }

  private async probeH2iDirectReadyIps(candidateIps: string[]): Promise<string[]> {
    const ready: string[] = [];
    for (const ip of uniqueStrings(candidateIps.map((value) => normalizeOverlayIp(value)).filter((value): value is string => Boolean(value)))) {
      if (await pingOverlayIp(ip, 1800)) ready.push(ip);
    }
    return ready;
  }

  async anonymousConnect(input: {
    serverUrl?: string | null;
    appId?: string | null;
    installId?: string | null;
    deviceLabel?: string | null;
    platform?: string | null;
    relayMode?: HdoRelayMode | 'mesh-server' | 'mesh-service-p2p' | 'mesh-p2p' | null;
    rotate?: boolean | null;
    autoConnect?: boolean | null;
  } = {}): Promise<Record<string, unknown>> {
    const baseUrl = normalizeBaseUrl(input.serverUrl);
    const relayMode =
      input.relayMode === undefined
        ? 'mesh-h2i'
        : normalizeRelayMode(input.relayMode);
    if (baseUrl) {
      this.updateSettings({ hdoControlBaseUrl: baseUrl, relayMode });
    } else if (input.relayMode !== undefined) {
      this.updateSettings({ relayMode });
    }

    this.rememberCurrentNetworkLease();
    this.restoreNetworkLease('anonymous');

    const routeProbe = buildHdoRouteProbe();
    const now = new Date().toISOString();
    const previous = this.settings.wireGuardPeer ?? {};
    const anonymous = plainObject(this.settings.anonymous);
    const appId = stringValue(input.appId) ?? stringValue(anonymous?.appId) ?? 'electron-app';
    let installId = stringValue(input.installId) ?? stringValue(anonymous?.installId) ?? randomUUID();
    const deviceLabel = stringValue(input.deviceLabel) ?? this.settings.deviceLabel ?? defaultDeviceLabel();
    let privateKey = stringValue(previous.privateKey);
    let publicKey = stringValue(previous.publicKey);
    const switchingFromAccountPeer =
      Boolean(privateKey || publicKey) &&
      !isAnonymousDeviceId(this.settings.deviceId) &&
      plainObject(this.settings.anonymous)?.mode !== 'anonymous';
    const runtime = resolveWireGuardRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: false
    });

    if (input.rotate || switchingFromAccountPeer || !privateKey || !publicKey) {
      if (!runtime.command) {
        const lastError =
          `当前 HDO 插件包缺少适配 ${runtime.target} 的 WireGuard CLI 引擎；需要随插件安装对应的 @qpjoy/electron-core-wireguard-engine-${runtime.target}。`;
        const peer = {
          ...previous,
          routeProbe,
          canUseDefaultMesh: routeProbe.canUseDefaultMesh,
          lastError,
          updatedAt: now
        };
        this.updateSettings({
          anonymous: { ...anonymous, mode: 'anonymous', appId, installId, updatedAt: now },
          wireGuardPeer: peer
        });
        this.rememberNetworkLease('anonymous');
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
        this.updateSettings({
          anonymous: { ...anonymous, mode: 'anonymous', appId, installId, updatedAt: now },
          wireGuardPeer: peer
        });
        this.rememberNetworkLease('anonymous');
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

    let bootstrap = await this.apiPostPublic('/api/v1/hdo/anonymous/bootstrap', {
      appId,
      installId,
      deviceLabel,
      platform: stringValue(input.platform) ?? this.settings.devicePlatform ?? process.platform,
      publicKey,
      overlayIp: anonymousOverlayIp(previous.overlayIp) ?? undefined,
      relayMode,
      preferDirectPeers: relayMode !== 'mesh-hdi',
      h2iDirectReady: false,
      h2iDirectReadyIps: []
    });
    let bootstrapRow = plainObject(bootstrap);
    let manifest = plainObject(bootstrapRow?.manifest);
    let device = plainObject(bootstrapRow?.device);
    if (!manifest || !device) {
      throw new Error('anonymous bootstrap response is invalid');
    }

    let serverOverlayIp = stringField(device, 'overlayIp');
    let rejectedAnonymousOverlayIp: string | null = null;
    if (serverOverlayIp && !isAnonymousOverlayIp(serverOverlayIp)) {
      rejectedAnonymousOverlayIp = serverOverlayIp;
      installId = randomUUID();
      if (runtime.command) {
        try {
          const pair = generateWireGuardKeyPairWithCli(runtime.command);
          privateKey = pair.privateKey;
          publicKey = pair.publicKey;
        } catch (err) {
          this.ctx.log.warn('failed to rotate anonymous WireGuard key after invalid overlay lease', {
            overlayIp: serverOverlayIp,
            error: errorMessage(err)
          });
        }
      }
      bootstrap = await this.apiPostPublic('/api/v1/hdo/anonymous/bootstrap', {
        appId,
        installId,
        deviceLabel,
        platform: stringValue(input.platform) ?? this.settings.devicePlatform ?? process.platform,
        publicKey,
        relayMode,
        preferDirectPeers: relayMode !== 'mesh-hdi',
        h2iDirectReady: false,
        h2iDirectReadyIps: []
      });
      bootstrapRow = plainObject(bootstrap);
      manifest = plainObject(bootstrapRow?.manifest);
      device = plainObject(bootstrapRow?.device);
      if (!manifest || !device) {
        throw new Error('anonymous bootstrap retry response is invalid');
      }
      serverOverlayIp = stringField(device, 'overlayIp');
      if (serverOverlayIp && !isAnonymousOverlayIp(serverOverlayIp)) {
        rejectedAnonymousOverlayIp = serverOverlayIp;
      }
    }
    const overlayIp = serverOverlayIp && isAnonymousOverlayIp(serverOverlayIp) ? serverOverlayIp : null;
    let config: string | null = null;
    let configPath: string | null = null;
    let lastError: string | null = null;
    let h2iDirectCandidateIps: string[] = [];
    let dnsServers: string[] = [];
    let dnsDomains: string[] = [];
    try {
      const domestic = domesticWireGuardFromManifest(manifest);
      if (!manifestHasMeshLicense(manifest)) {
        lastError = '匿名 mesh 尚未启用。';
      } else if (rejectedAnonymousOverlayIp && !overlayIp) {
        lastError = `服务端返回了非匿名网段 ${rejectedAnonymousOverlayIp}，已拒绝作为匿名线路使用；请重新同步服务端 HDO 配置后再连接。`;
      } else if (!overlayIp) {
        lastError = '服务端尚未给当前匿名设备分配 overlay IP。';
      } else if (!domestic.publicKey || !domestic.endpoint) {
        lastError =
          'manifest 中缺少 domestic WireGuard 公钥或 endpoint；请在服务器 HDO 管理页给 domestic 节点 metadata.wireGuard 填入 publicKey/listenPort。';
      } else {
        const directPeers = directPeersFromManifest(manifest, overlayIp);
        const clientDirectPeers = clientDirectPeersForPlatform(relayMode, directPeers);
        h2iDirectCandidateIps = directPeerOverlayIps(clientDirectPeers);
        dnsServers = wireGuardDnsServersForPlatform(manifest);
        dnsDomains = wireGuardDnsDomainsForPlatform(manifest);
        const routeCidrs = uniqueStrings([
          ...domestic.routeCidrs,
          ...manifestOverlayRouteCidrs(manifest, overlayIp),
          ...wireGuardDnsRouteCidrs(dnsServers),
          ...windowsH2iDirectPeerAllowedIps(relayMode, directPeers)
        ]);
        const exclusionCidrs = localCidrsForAllowedIpExclusion(routeProbe, routeCidrs);
        let allowedIps = excludeLocalRoutesFromAllowedIps(routeCidrs, exclusionCidrs);
        if (allowedIps.length === 0 && process.platform === 'win32') {
          allowedIps = routeCidrs;
        } else if (allowedIps.length === 0) {
          throw new Error('服务端下发的 WireGuard AllowedIPs 与本机路由完全重叠，已拒绝生成会覆盖本地网络的配置。');
        }
        config = renderHdoClientWireGuardConfig({
          privateKey,
          address: wireGuardAddress(overlayIp),
          domesticPublicKey: domestic.publicKey,
          domesticEndpoint: domestic.endpoint,
          allowedIps,
          dns: dnsServers,
          dnsDomains,
          directPeers: clientDirectPeers,
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
      dns: dnsServers.length ? dnsServers : null,
      dnsDomains: dnsDomains.length ? dnsDomains : null,
      h2iDirectCandidateIps,
      routeProbe,
      canUseDefaultMesh: routeProbe.canUseDefaultMesh,
      lastError,
      updatedAt: now
    };
    this.updateSettings({
      anonymous: {
        ...anonymous,
        mode: 'anonymous',
        appId,
        installId,
        updatedAt: now
      },
      deviceId: stringField(device, 'id') ?? this.settings.deviceId,
      deviceLabel,
      devicePlatform: stringValue(input.platform) ?? this.settings.devicePlatform ?? process.platform,
      wireGuardPeer: peer,
      lastManifest: manifest
    });
    this.rememberNetworkLease('anonymous');
    const domainProxy = await this.applyDomainProxyFromManifest(manifest);
    let connected: Record<string, unknown> | null = null;
    let wireGuardStatus: Record<string, unknown> | null = null;
    let h2iDirectReady: Record<string, unknown> | null = null;
    if (config && input.autoConnect !== false) {
      connected = await this.connectWireGuardPeer({
        action: 'restart',
        skipIfActive: false,
        fallbackToAppManaged: false
      }).catch((err) => ({
        ok: false,
        error: errorMessage(err)
      }));
      wireGuardStatus = await this.waitForWireGuardState(true, 32, 650);
      if (wireGuardStatus?.active === true && overlayIp && h2iDirectCandidateIps.length > 0) {
        h2iDirectReady = await this.reportAnonymousH2iDirectReady({
          appId,
          installId,
          deviceLabel,
          platform: stringValue(input.platform) ?? this.settings.devicePlatform ?? process.platform,
          publicKey,
          overlayIp,
          relayMode,
          candidateIps: h2iDirectCandidateIps
        }).catch((err) => ({
          ok: false,
          error: errorMessage(err)
        }));
      }
    }
    this.emitEvent('relay-connected', {
      mode: 'anonymous',
      ok: Boolean(config),
      autoConnect: input.autoConnect !== false,
      wireGuardActive: wireGuardStatus?.active === true
    });

    return {
      ok: Boolean(config),
      mode: 'anonymous',
      message: config ? '已获取匿名 HDO 配置。' : lastError,
      bootstrap,
      manifest,
      domainProxy,
      connected,
      wireGuardStatus,
      h2iDirectReady,
      peer: publicWireGuardPeer(peer),
      config
    };
  }

  async login(input: {
    serverUrl?: string | null;
    identifier?: string | null;
    password?: string | null;
  }): Promise<Record<string, unknown>> {
    const baseUrl = normalizeBaseUrl(input.serverUrl);
    if (baseUrl) {
      this.updateSettings({ hdoControlBaseUrl: baseUrl });
    }
    const identifier = stringValue(input.identifier);
    const password = stringValue(input.password);
    if (!identifier || !password) {
      throw new Error('账号和密码必填');
    }
    if (!this.ctx.marketplaceDb?.setSession) {
      throw new Error('当前 host 无法保存插件市场登录态');
    }
    const out = plainObject(await this.apiPostPublic('/api/v1/auth/login', { identifier, password }));
    const user = plainObject(out?.user);
    const tokens = plainObject(out?.tokens);
    const accessToken = stringField(tokens, 'accessToken');
    const refreshToken = stringField(tokens, 'refreshToken');
    const accessExpiresAt = stringField(tokens, 'accessExpiresAt');
    if (!user || !accessToken || !refreshToken || !accessExpiresAt) {
      throw new Error('登录响应缺少 token 或用户信息');
    }
    const refreshExpiresAt = stringField(tokens, 'refreshExpiresAt');
    this.ctx.marketplaceDb.setSession({
      accessToken,
      refreshToken,
      expiresAt: accessExpiresAt,
      user: {
        ...user,
        refreshExpiresAt
      }
    });
    this.ensureSettingsForCurrentSession();
    return {
      ok: true,
      user,
      accessExpiresAt,
      refreshExpiresAt
    };
  }

  async accountConnect(input: {
    serverUrl?: string | null;
    identifier?: string | null;
    password?: string | null;
    relayMode?: HdoRelayMode | 'mesh-server' | 'mesh-service-p2p' | 'mesh-p2p' | null;
    rotate?: boolean | null;
    autoConnect?: boolean | null;
  } = {}): Promise<Record<string, unknown>> {
    const baseUrl = normalizeBaseUrl(input.serverUrl);
    const relayMode =
      input.relayMode === undefined
        ? normalizeRelayMode(this.settings.relayMode)
        : normalizeRelayMode(input.relayMode);
    if (baseUrl) {
      this.updateSettings({ hdoControlBaseUrl: baseUrl, relayMode });
    } else if (input.relayMode !== undefined) {
      this.updateSettings({ relayMode });
    }

    const identifier = stringValue(input.identifier);
    const password = stringValue(input.password);
    let auth: Record<string, unknown> | null = null;
    if (identifier || password) {
      if (!identifier || !password) {
        throw new Error('账号和密码必须一起填写，或先在插件市场登录');
      }
      auth = await this.login({ serverUrl: baseUrl, identifier, password });
    } else {
      this.ensureSettingsForCurrentSession();
    }

    this.rememberCurrentNetworkLease();
    this.restoreNetworkLease('account');

    const wasAnonymousPeer =
      plainObject(this.settings.anonymous)?.mode === 'anonymous' ||
      isAnonymousDeviceId(this.settings.deviceId) ||
      isAnonymousOverlayIp(this.settings.wireGuardPeer?.overlayIp);
    this.updateSettings({
      anonymous: null,
      deviceId: wasAnonymousPeer ? null : this.settings.deviceId
    });
    const prepared = await this.prepareWireGuardPeer({
      rotate: input.rotate === true || wasAnonymousPeer
    });
    const preparedRow = plainObject(prepared);
    this.rememberNetworkLease('account');
    const manifest = plainObject(preparedRow?.manifest);
    const domainProxy = await this.applyDomainProxyFromManifest(manifest);
    let subscription: Record<string, unknown> | null = null;
    let connected: Record<string, unknown> | null = null;
    let wireGuardStatus: Record<string, unknown> | null = null;
    let h2iDirectReady: Record<string, unknown> | null = null;

    if (preparedRow?.ok === true) {
      subscription = await this.refreshSubscription().then(
        (content) => ({ ok: true, bytes: Buffer.byteLength(content, 'utf8') }),
        (err) => ({ ok: false, error: errorMessage(err) })
      );
      if (input.autoConnect !== false) {
        const preparedPeer = plainObject(preparedRow.peer);
        connected = await this.connectWireGuardPeer({
          action: 'restart',
          skipIfActive: false,
          fallbackToAppManaged: false
        }).catch((err) => ({
          ok: false,
          error: errorMessage(err)
        }));
        wireGuardStatus = await this.waitForWireGuardState(true, 32, 650);
        if (!wireGuardStatus && preparedPeer?.overlayIp) {
          wireGuardStatus = this.wireGuardStatus();
        }
        if (wireGuardStatus?.active === true) {
          h2iDirectReady = await this.reportAccountH2iDirectReady().catch((err) => ({
            ok: false,
            error: errorMessage(err)
          }));
        }
      }
    }
    this.emitEvent('relay-connected', {
      mode: 'account',
      ok: preparedRow?.ok === true,
      autoConnect: input.autoConnect !== false,
      wireGuardActive: wireGuardStatus?.active === true
    });

    return {
      ok: preparedRow?.ok === true,
      mode: 'account',
      auth,
      prepared,
      domainProxy,
      subscription,
      connected,
      wireGuardStatus,
      h2iDirectReady
    };
  }

  async executePendingTasks(): Promise<HdoTaskRunSummary> {
    if (this.taskRunner) return this.taskRunner;
    this.taskRunner = this.executePendingTasksInner().finally(() => {
      this.taskRunner = null;
    });
    return this.taskRunner;
  }

  async refreshManifest(deviceId?: string | null): Promise<Record<string, unknown>> {
    this.ensureSettingsForCurrentSession();
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
    this.ensureSettingsForCurrentSession();
    const id = deviceId || this.settings.deviceId;
    if (!id) throw new Error('deviceId required');
    const content = await this.apiText(
      `/api/v1/hdo/subscriptions/${encodeURIComponent(id)}/mihomo.yaml`
    );
    this.updateSettings({ lastSubscription: content });
    return content;
  }

  async prepareWireGuardPeer(input: { rotate?: boolean | null } = {}): Promise<Record<string, unknown>> {
    this.ensureSettingsForCurrentSession();
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
      overlayIp: accountOverlayIp(previous.overlayIp),
      metadata: {
        source: '@qpjoy/electron-plugin-hdo',
        arch: process.arch,
        wireGuard: {
          publicKey,
          h2iDirectReady: false,
          h2iDirectReadyIps: [],
          routeProbe,
          keySource,
          ...wireGuardPreferenceMetadata(this.settings.relayMode),
          updatedAt: now
        }
      }
    });
    const overlayIp = stringField(device, 'overlayIp') ?? stringValue(previous.overlayIp);
    let manifest: Record<string, unknown> | null = null;
    let config: string | null = null;
    let configPath: string | null = null;
    let lastError: string | null = null;
    let h2iDirectCandidateIps: string[] = [];
    let dnsServers: string[] = [];
    let dnsDomains: string[] = [];

    try {
      manifest = await this.refreshManifest(stringField(device, 'id') ?? this.settings.deviceId);
      const domestic = domesticWireGuardFromManifest(manifest);
      if (!manifestHasMeshLicense(manifest)) {
        lastError = '当前用户还没有 active mesh 许可；请管理员在服务器 HDO 控制面把该用户加入启用中的 mesh 组，然后重新连接 / 更新 HDO。';
      } else if (!overlayIp) {
        lastError = '服务端尚未给当前设备分配 overlay IP。';
      } else if (!domestic.publicKey || !domestic.endpoint) {
        lastError =
          'manifest 中缺少 domestic WireGuard 公钥或 endpoint；请在服务器 HDO 管理页给 domestic 节点 metadata.wireGuard 填入 publicKey/listenPort。';
      } else {
        const activeRelayMode = normalizeRelayMode(this.settings.relayMode);
        const directPeers = directPeersFromManifest(manifest, overlayIp);
        const clientDirectPeers = clientDirectPeersForPlatform(activeRelayMode, directPeers);
        h2iDirectCandidateIps = directPeerOverlayIps(clientDirectPeers);
        dnsServers = wireGuardDnsServersForPlatform(manifest);
        dnsDomains = wireGuardDnsDomainsForPlatform(manifest);
        const routeCidrs = uniqueStrings([
          ...domestic.routeCidrs,
          ...manifestOverlayRouteCidrs(manifest, overlayIp),
          ...wireGuardDnsRouteCidrs(dnsServers),
          ...windowsH2iDirectPeerAllowedIps(activeRelayMode, directPeers)
        ]);
        const exclusionCidrs = localCidrsForAllowedIpExclusion(routeProbe, routeCidrs);
        let allowedIps = excludeLocalRoutesFromAllowedIps(
          routeCidrs,
          exclusionCidrs
        );
        if (allowedIps.length === 0 && process.platform === 'win32') {
          allowedIps = routeCidrs;
        } else if (allowedIps.length === 0) {
          throw new Error('服务端下发的 WireGuard AllowedIPs 与本机路由完全重叠，已拒绝生成会覆盖本地网络的配置。');
        }
        config = renderHdoClientWireGuardConfig({
          privateKey,
          address: wireGuardAddress(overlayIp),
          domesticPublicKey: domestic.publicKey,
          domesticEndpoint: domestic.endpoint,
          allowedIps,
          dns: dnsServers,
          dnsDomains,
          directPeers: clientDirectPeers,
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
      dns: dnsServers.length ? dnsServers : null,
      dnsDomains: dnsDomains.length ? dnsDomains : null,
      h2iDirectCandidateIps,
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

  async connectWireGuardPeer(input: WireGuardPeerConnectInput = {}): Promise<Record<string, unknown>> {
    this.ensureSettingsForCurrentSession();
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) {
      throw new Error('WireGuard 配置文件不存在，请先点击“连接 / 更新 HDO”或“生成 / 更新本机 Peer”。');
    }
    const action: WireGuardPeerAction = input.action === 'down' ? 'down' : (input.action === 'restart' ? 'restart' : 'up');
    const runtime = resolveWireGuardConnectionRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: true
    });
    if (input.skipIfActive === true && action === 'up') {
      const status = safeWireGuardStatus(runtime, configPath);
      if (status?.active === true && arrayField(status.missingRoutes).length === 0) {
        this.rememberWireGuardDesiredActive(true);
        this.reportPresenceInBackground('online');
        return {
          ok: true,
          skipped: true,
          reason: 'already-active',
          action,
          message: 'WireGuard peer 已在运行，配置未变化。',
          status,
          runtime: publicWireGuardRuntime(runtime)
        };
      }
    }

    const result = runtime.platform === 'darwin'
      ? await this.connectWireGuardPeerDarwin(action, runtime, configPath, input)
      : (runtime.platform === 'win32'
          ? await this.connectWireGuardPeerWindows(action, runtime, configPath)
          : await this.connectWireGuardPeerWgQuick(action, runtime, configPath));
    this.emitEvent('wireguard-status-changed', {
      action,
      ok: result.ok !== false,
      message: stringValue(result.message)
    });
    return result;
  }

  private async connectWireGuardPeerDarwin(
    action: WireGuardPeerAction,
    runtime: WireGuardConnectionRuntime,
    configPath: string,
    input: WireGuardPeerConnectInput = {}
  ): Promise<Record<string, unknown>> {
    if (action === 'down') {
      const daemonStatus = getDarwinWireGuardLaunchDaemonStatus({ runtime, configPath });
      if (hasWireGuardLaunchDaemon(daemonStatus)) {
        const daemon = await this.uninstallWireGuardLaunchDaemon({ stopTunnel: false, rememberDisabled: false });
        if (daemon.ok) {
          this.rememberWireGuardDesiredActive(false);
          this.reportPresenceInBackground('offline');
        }
        return {
          ...daemon,
          action,
          mode: runtime.method,
          message: daemon.ok ? '已停止 WireGuard peer。' : daemon.message,
          runtime: publicWireGuardRuntime(runtime),
          launchDaemon: daemon
        };
      }
    }
    if (
      action !== 'down' &&
      runtime.platform === 'darwin' &&
      runtime.method === 'darwin-userspace' &&
      this.settings.wireGuardLaunchDaemonEnabled !== false
    ) {
      const daemon = await this.installWireGuardLaunchDaemon();
      if (daemon.ok) {
        this.rememberWireGuardDesiredActive(true);
        this.reportPresenceInBackground('online');
        return {
          ...daemon,
          action,
          mode: runtime.method,
          message: action === 'restart'
            ? '已安装系统守护并更新启动 WireGuard peer。'
            : '已安装系统守护并启动 WireGuard peer。',
          runtime: publicWireGuardRuntime(runtime),
          launchDaemon: daemon
        };
      }
      if (isAuthorizationCancelledMessage(daemon.message)) {
        return {
          ...daemon,
          action,
          mode: runtime.method,
          runtime: publicWireGuardRuntime(runtime),
          launchDaemon: daemon
        };
      }
      if (input.fallbackToAppManaged === false) {
        return {
          ...daemon,
          action,
          mode: runtime.method,
          runtime: publicWireGuardRuntime(runtime),
          launchDaemon: daemon
        };
      }
      this.ctx.log.warn('HDO WireGuard LaunchDaemon install failed; falling back to app-managed tunnel', {
        message: daemon.message,
        command: daemon.command
      });
    }
    if (action === 'up' && runtime.platform === 'darwin' && runtime.method === 'darwin-userspace') {
      const restarted = await setWireGuardTunnelState({
        runtime,
        configPath,
        action: 'restart'
      });
      if (restarted.ok) {
        this.rememberWireGuardDesiredActive(true);
        this.reportPresenceInBackground('online');
      }
      return {
        ...restarted,
        action,
        message: restarted.ok ? '已启动 WireGuard peer。' : restarted.message,
        runtime: publicWireGuardRuntime(restarted.runtime)
      };
    }
    if (action === 'restart' && runtime.platform === 'darwin' && runtime.method === 'darwin-userspace') {
      const restarted = await setWireGuardTunnelState({
        runtime,
        configPath,
        action
      });
      if (restarted.ok) {
        this.rememberWireGuardDesiredActive(true);
        this.reportPresenceInBackground('online');
      }
      return {
        ...restarted,
        message: restarted.ok ? '已更新并启动 WireGuard peer。' : restarted.message,
        runtime: publicWireGuardRuntime(restarted.runtime)
      };
    }
    return this.connectWireGuardPeerWgQuick(action, runtime, configPath);
  }

  private async connectWireGuardPeerWindows(
    action: WireGuardPeerAction,
    runtime: WireGuardConnectionRuntime,
    configPath: string
  ): Promise<Record<string, unknown>> {
    const result = await setWireGuardTunnelState({
      runtime,
      configPath,
      action
    });
    if (result.ok) {
      this.rememberWireGuardDesiredActive(action !== 'down');
      this.reportPresenceInBackground(action === 'down' ? 'offline' : 'online');
    }
    return {
      ...result,
      message: result.ok && action === 'restart' ? '已更新并启动 WireGuard peer。' : result.message,
      runtime: publicWireGuardRuntime(result.runtime)
    };
  }

  private async connectWireGuardPeerWgQuick(
    action: WireGuardPeerAction,
    runtime: WireGuardConnectionRuntime,
    configPath: string
  ): Promise<Record<string, unknown>> {
    if (action === 'restart') {
      const status = safeWireGuardStatus(runtime, configPath);
      if (status?.active) {
        const stopped = await setWireGuardTunnelState({
          runtime,
          configPath,
          action: 'down'
        });
        if (!stopped.ok) {
          return {
            ...stopped,
            action,
            runtime: publicWireGuardRuntime(stopped.runtime)
          };
        }
      }
      const restarted = await setWireGuardTunnelState({
        runtime,
        configPath,
        action: 'up'
      });
      if (restarted.ok) {
        this.rememberWireGuardDesiredActive(true);
        this.reportPresenceInBackground('online');
      }
      return {
        ...restarted,
        action,
        message: restarted.ok ? '已更新并启动 WireGuard peer。' : restarted.message,
        runtime: publicWireGuardRuntime(restarted.runtime)
      };
    }

    const result = await setWireGuardTunnelState({
      runtime,
      configPath,
      action
    });
    if (result.ok) {
      this.rememberWireGuardDesiredActive(action !== 'down');
      this.reportPresenceInBackground(action === 'down' ? 'offline' : 'online');
    }
    return {
      ...result,
      message: result.message,
      runtime: publicWireGuardRuntime(result.runtime)
    };
  }

  private async waitForWireGuardState(
    active: boolean,
    attempts = 12,
    delayMs = 550
  ): Promise<Record<string, unknown> | null> {
    let latest: Record<string, unknown> | null = null;
    for (let i = 0; i < attempts; i += 1) {
      await sleep(i === 0 ? 250 : delayMs);
      latest = this.wireGuardStatus();
      if (latest && Boolean(latest.active) === active) return latest;
    }
    return latest;
  }

  async recoverWireGuardPeer(input: WireGuardRecoveryInput = {}): Promise<Record<string, unknown>> {
    if (this.wireGuardRecovery) return this.wireGuardRecovery;
    const { reason, allowPrivileged } = this.normalizeWireGuardRecoveryInput(input);
    this.wireGuardRecovery = this.recoverWireGuardPeerInner(reason, allowPrivileged).finally(() => {
      this.wireGuardRecovery = null;
    });
    return this.wireGuardRecovery;
  }

  private normalizeWireGuardRecoveryInput(input: WireGuardRecoveryInput): { reason: string; allowPrivileged: boolean } {
    if (typeof input === 'string') {
      return { reason: input || 'manual', allowPrivileged: false };
    }
    if (!input) {
      return { reason: 'manual', allowPrivileged: false };
    }
    return {
      reason: input.reason || 'manual',
      allowPrivileged: input.allowPrivileged === true
    };
  }

  private async recoverWireGuardPeerInner(reason: string, allowPrivileged: boolean): Promise<Record<string, unknown>> {
    this.ensureSettingsForCurrentSession();
    if (this.settings.wireGuardAutoRecover === false) {
      return { ok: true, skipped: true, reason: 'auto-recover-disabled' };
    }
    if (this.settings.wireGuardDesiredActive !== true) {
      return { ok: true, skipped: true, reason: 'desired-inactive' };
    }
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) {
      return { ok: false, skipped: true, reason: 'missing-config', message: 'WireGuard 配置文件不存在。' };
    }

    const status = this.wireGuardStatus();
    const active = status?.active === true;
    const missingRoutes = arrayField(status?.missingRoutes);
    if (active && missingRoutes.length === 0) {
      return { ok: true, skipped: true, reason: 'already-active', status };
    }
    if (!allowPrivileged) {
      return {
        ok: true,
        skipped: true,
        reason: 'privileged-recovery-disabled',
        recoveryReason: reason,
        active,
        missingRoutes,
        status
      };
    }

    if (process.platform === 'darwin' && this.settings.wireGuardLaunchDaemonEnabled !== false) {
      const daemonStatus = this.wireGuardLaunchDaemonStatus();
      if (daemonStatus?.supported === true && daemonStatus.running !== true) {
        const daemon = await this.installWireGuardLaunchDaemon();
        if (daemon.ok || isAuthorizationCancelledMessage(daemon.message)) {
          return {
            ...daemon,
            action: 'launchdaemon-recover',
            reason
          };
        }
      }
    }

    this.ctx.log.warn('recovering HDO WireGuard desired state', {
      reason,
      active,
      missingRoutes
    });

    if (active && missingRoutes.length > 0) {
      const repaired = await this.repairWireGuardRoutes();
      return {
        ...repaired,
        action: 'repair-routes',
        reason
      };
    }

    const connected = await this.connectWireGuardPeer({ action: 'up' });
    return {
      ...connected,
      action: 'recover-up',
      reason
    };
  }

  async repairWireGuardRoutes(): Promise<Record<string, unknown>> {
    this.ensureSettingsForCurrentSession();
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) {
      throw new Error('WireGuard 配置文件不存在，请先点击“连接 / 更新 HDO”或“生成 / 更新本机 Peer”。');
    }
    const runtime = resolveWireGuardConnectionRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: true
    });
    const result = await repairWireGuardTunnelRoutes({ runtime, configPath });
    const payload = {
      ...result,
      runtime: publicWireGuardRuntime(result.runtime)
    };
    this.emitEvent('wireguard-status-changed', {
      action: 'repair-routes',
      ok: payload.ok !== false,
      message: stringValue(payload.message)
    });
    return payload;
  }

  async applyDomainProxyFromManifest(manifestInput?: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const manifest = manifestInput ?? this.settings.lastManifest ?? null;
    const bindings = manifest ? domainBindingsFromManifest(manifest) : [];
    if (!this.domainProxy) {
      return {
        enabled: false,
        unavailable: true,
        domains: bindings.map((binding) => binding.domain)
      };
    }
    const result = await this.domainProxy.apply(bindings);
    this.updateSettings({
      domainProxy: {
        ...result,
        updatedAt: new Date().toISOString()
      }
    });
    return result;
  }

  async prepareDomainProxyFromManifest(manifestInput?: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const manifest = manifestInput ?? this.settings.lastManifest ?? null;
    const bindings = manifest ? domainBindingsFromManifest(manifest) : [];
    if (!this.domainProxy) {
      return {
        enabled: false,
        unavailable: true,
        domains: bindings.map((binding) => binding.domain)
      };
    }
    return this.domainProxy.prepare(bindings);
  }

  wireGuardLaunchDaemonStatus(): Record<string, unknown> | null {
    this.ensureSettingsForCurrentSession();
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) return null;
    const runtime = resolveWireGuardConnectionRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: true
    });
    return {
      ...getDarwinWireGuardLaunchDaemonStatus({ runtime, configPath }),
      runtime: publicWireGuardRuntime(runtime)
    };
  }

  async installWireGuardLaunchDaemon(): Promise<Record<string, unknown>> {
    this.ensureSettingsForCurrentSession();
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) {
      throw new Error('WireGuard 配置文件不存在，请先点击“连接 / 更新 HDO”或“生成 / 更新本机 Peer”。');
    }
    const runtime = resolveWireGuardConnectionRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: true
    });
    const result = await installDarwinWireGuardLaunchDaemon({ runtime, configPath });
    if (result.ok) {
      this.updateSettings({
        wireGuardDesiredActive: true,
        wireGuardLaunchDaemonEnabled: true
      });
      this.reportPresenceInBackground('online');
    }
    const payload = {
      ...result,
      runtime: publicWireGuardRuntime(result.runtime)
    };
    this.emitEvent('wireguard-status-changed', {
      action: 'launchdaemon-install',
      ok: payload.ok !== false,
      message: stringValue(payload.message)
    });
    return payload;
  }

  async uninstallWireGuardLaunchDaemon(
    input: { stopTunnel?: boolean | null; rememberDisabled?: boolean | null } = {}
  ): Promise<Record<string, unknown>> {
    this.ensureSettingsForCurrentSession();
    const peer = this.settings.wireGuardPeer;
    const configPath = stringValue(peer?.configPath);
    if (!configPath || !existsSync(configPath)) {
      return { ok: true, skipped: true, reason: 'missing-config' };
    }
    const runtime = resolveWireGuardConnectionRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: true
    });
    const daemonStatus = getDarwinWireGuardLaunchDaemonStatus({ runtime, configPath });
    const hadDaemon = hasWireGuardLaunchDaemon(daemonStatus);
    const result = hadDaemon
      ? await uninstallDarwinWireGuardLaunchDaemon({ runtime, configPath })
      : {
          ...daemonStatus,
          ok: true,
          skipped: true,
          reason: 'launchdaemon-not-installed',
          message: 'HDO WireGuard 系统守护未安装。'
        };
    if (input.rememberDisabled !== false) {
      this.updateSettings({ wireGuardLaunchDaemonEnabled: false });
    }
    const launchDaemonStoppedTunnel = hadDaemon && result.ok && runtime.platform === 'darwin' && runtime.method === 'darwin-userspace';
    if (input.stopTunnel !== false && !launchDaemonStoppedTunnel) {
      await setWireGuardTunnelState({ runtime, configPath, action: 'down' }).catch((err) => {
        this.ctx.log.warn('failed to stop HDO WireGuard after LaunchDaemon uninstall', {
          error: errorMessage(err)
        });
      });
      this.rememberWireGuardDesiredActive(false);
      this.reportPresenceInBackground('offline');
    }
    const payload = {
      ...result,
      runtime: publicWireGuardRuntime(result.runtime)
    };
    this.emitEvent('wireguard-status-changed', {
      action: 'launchdaemon-uninstall',
      ok: payload.ok !== false,
      message: stringValue(payload.message)
    });
    return payload;
  }

  async shutdown(): Promise<void> {
    await this.domainProxy?.close().catch((err) => {
      this.ctx.log.warn('failed to stop HDO session domain proxy', {
        error: errorMessage(err)
      });
    });
    const configPath = this.shutdownWireGuardConfigPath();
    if (!configPath || !existsSync(configPath)) return;
    if (this.settings.wireGuardDesiredActive === true && this.settings.wireGuardLaunchDaemonEnabled !== false) {
      const daemon = this.wireGuardLaunchDaemonStatus();
      if (daemon && (daemon.installed === true || daemon.loaded === true)) return;
    }
    const runtime = resolveWireGuardConnectionRuntime({
      installDir: join(this.ctx.userDataDir, 'bin'),
      bundledDir: this.ctx.bundledWireGuardDir,
      allowSystemFallback: true
    });
    if (!runtime.available) {
      this.ctx.log.warn('skip HDO WireGuard shutdown because runtime is unavailable', {
        error: runtime.error ?? runtime.warnings[0] ?? null
      });
      return;
    }
    const status = safeWireGuardStatus(runtime, configPath);
    if (!status?.active) return;
    const result = await setWireGuardTunnelState({
      runtime,
      configPath,
      action: 'down'
    });
    if (!result.ok) {
      this.ctx.log.warn('failed to stop HDO WireGuard during plugin shutdown', {
        message: result.message,
        command: result.command,
        routeLogPath: result.routeLogPath ?? null
      });
    }
  }

  private reportPresenceInBackground(status: HdoDeviceRegistrationInput['status']): void {
    if (!this.currentSessionUserId() && this.settings.anonymous?.mode === 'anonymous') return;
    void this.reportDevicePresence(status).catch((err) => {
      this.ctx.log.warn('failed to report HDO device presence', {
        error: errorMessage(err)
      });
    });
  }

  private rememberWireGuardDesiredActive(active: boolean): void {
    if (this.settings.wireGuardDesiredActive === active) return;
    this.updateSettings({ wireGuardDesiredActive: active });
  }

  private rememberCurrentNetworkLease(): void {
    const mode = this.currentNetworkLeaseMode();
    if (mode) this.rememberNetworkLease(mode);
  }

  private rememberNetworkLease(mode: HdoNetworkLeaseMode): void {
    const peer = this.settings.wireGuardPeer ?? null;
    const anonymous = mode === 'anonymous' ? this.settings.anonymous ?? null : null;
    if (!this.settings.deviceId && !peer?.publicKey && !peer?.overlayIp && !anonymous?.installId) return;
    const now = new Date().toISOString();
    const lease: HdoNetworkLeaseSettings = {
      deviceId: this.settings.deviceId ?? null,
      sessionUserId: mode === 'account'
        ? this.settings.sessionUserId ?? this.currentSessionUserId()
        : null,
      anonymous,
      wireGuardPeer: peer ? { ...peer } : null,
      updatedAt: now
    };
    this.writeNetworkLease(mode, lease);
  }

  private restoreNetworkLease(mode: HdoNetworkLeaseMode): HdoNetworkLeaseSettings | null {
    const lease = this.networkLease(mode);
    if (!lease) return null;
    const patch: Partial<HdoPluginSettings> = {};
    if (lease.deviceId) patch.deviceId = lease.deviceId;
    if (lease.wireGuardPeer) patch.wireGuardPeer = { ...lease.wireGuardPeer };
    if (mode === 'anonymous') {
      patch.anonymous = lease.anonymous ?? this.settings.anonymous ?? null;
    } else {
      patch.anonymous = null;
      patch.sessionUserId = this.currentSessionUserId() ?? lease.sessionUserId ?? this.settings.sessionUserId ?? null;
    }
    this.updateSettings(patch);
    return lease;
  }

  private networkLease(mode: HdoNetworkLeaseMode): HdoNetworkLeaseSettings | null {
    const leases = plainObject(this.settings.networkLeases) as HdoNetworkLeasesSettings | null;
    if (!leases) return null;
    if (mode === 'anonymous') {
      return plainObject(leases.anonymous) as HdoNetworkLeaseSettings | null;
    }
    const currentUserId = this.currentSessionUserId() ?? this.settings.sessionUserId ?? null;
    const accounts = plainObject(leases.accounts) as Record<string, HdoNetworkLeaseSettings | null> | null;
    const scoped = currentUserId ? plainObject(accounts?.[currentUserId]) : null;
    if (scoped) return scoped as HdoNetworkLeaseSettings;
    const fallback = plainObject(leases.account) as HdoNetworkLeaseSettings | null;
    if (!fallback) return null;
    const leaseUserId = stringValue(fallback.sessionUserId);
    if (currentUserId && leaseUserId && leaseUserId !== currentUserId) return null;
    return fallback;
  }

  private writeNetworkLease(mode: HdoNetworkLeaseMode, lease: HdoNetworkLeaseSettings): void {
    const leases = (plainObject(this.settings.networkLeases) ?? {}) as HdoNetworkLeasesSettings;
    const accounts = (plainObject(leases.accounts) ?? {}) as Record<string, HdoNetworkLeaseSettings | null>;
    const nextLeases: HdoNetworkLeasesSettings = {
      ...leases,
      [mode]: lease,
      accounts
    };
    if (mode === 'account' && lease.sessionUserId) {
      nextLeases.accounts = {
        ...accounts,
        [lease.sessionUserId]: lease
      };
    }
    this.settings = {
      ...this.settings,
      networkLeases: nextLeases,
      updatedAt: new Date().toISOString()
    };
    this.saveSettings();
  }

  private currentNetworkLeaseMode(): HdoNetworkLeaseMode | null {
    const peer = this.settings.wireGuardPeer;
    if (
      this.isAnonymousNetworkActive()
    ) {
      return 'anonymous';
    }
    if (this.settings.deviceId || peer?.publicKey || peer?.overlayIp) return 'account';
    return null;
  }

  private isAnonymousNetworkActive(): boolean {
    const peer = this.settings.wireGuardPeer;
    return plainObject(this.settings.anonymous)?.mode === 'anonymous'
      || isAnonymousDeviceId(this.settings.deviceId)
      || isAnonymousOverlayIp(peer?.overlayIp);
  }

  private emitEvent(type: string, detail: Record<string, unknown> = {}): void {
    if (this.eventListeners.size === 0) return;
    const event = this.publicStateEvent(type, detail);
    for (const listener of Array.from(this.eventListeners)) {
      try {
        listener(event);
      } catch (err) {
        this.ctx.log.warn('HDO event listener failed', {
          event: type,
          error: errorMessage(err)
        });
      }
    }
  }

  private publicStateEvent(type: string, detail: Record<string, unknown> = {}): Record<string, unknown> {
    const settings = this.settings;
    const peer = plainObject(settings.wireGuardPeer);
    return {
      type,
      at: new Date().toISOString(),
      serverBaseUrl: this.serverBaseUrl(),
      relayMode: normalizeRelayMode(settings.relayMode),
      deviceId: settings.deviceId ?? null,
      deviceLabel: settings.deviceLabel ?? null,
      anonymous: publicAnonymousSettings(settings.anonymous),
      domainProxy: settings.domainProxy ?? null,
      wireGuardDesiredActive: settings.wireGuardDesiredActive === true,
      wireGuardPeer: peer ? publicEventWireGuardPeer(peer) : null,
      detail,
      lastError: this.lastError || stringValue(peer?.lastError)
    };
  }

  wireGuardStatus(): Record<string, unknown> | null {
    this.ensureSettingsForCurrentSession();
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

  async publishService(input: HdoPublishedServiceInput): Promise<unknown> {
    this.ensureSettingsForCurrentSession();
    const deviceId = this.settings.deviceId;
    if (!deviceId) {
      throw new Error('Register this device before publishing a service');
    }
    return this.apiPost(`/api/v1/hdo/devices/${encodeURIComponent(deviceId)}/services`, input);
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
      case 'notify': {
        const notification = {
          title: stringValue(payload.title) ?? 'HDO 通知',
          body: stringValue(payload.body) ?? stringValue(payload.message) ?? '',
          level: stringValue(payload.level) ?? 'info',
          meshGroupId: stringValue(payload.meshGroupId),
          taskId: task.id,
          receivedAt: new Date().toISOString()
        };
        this.updateSettings({ lastNotification: notification });
        this.ctx.log.info(notification.title, {
          body: notification.body,
          level: notification.level,
          meshGroupId: notification.meshGroupId ?? null
        });
        return notification;
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

  private async apiPostPublic(path: string, body: unknown): Promise<unknown> {
    return this.apiJsonPublic(path, {
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

  private async apiJsonPublic(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetchPublic(path, init);
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

  private async fetchPublic(path: string, init: RequestInit): Promise<Response> {
    const base = this.serverBaseUrl();
    if (!base) {
      throw new Error('未配置 HDO 控制面 URL');
    }
    return fetch(new URL(path, base).toString(), init);
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

  private ensureSettingsForCurrentSession(): void {
    const currentUserId = this.currentSessionUserId();
    if (!currentUserId) return;

    const previousUserId =
      this.settings.sessionUserId ?? stringField(plainObject(this.settings.lastManifest)?.device, 'userId');
    if (previousUserId && previousUserId !== currentUserId) {
      this.rememberCurrentNetworkLease();
      this.settings = {
        ...this.settings,
        sessionUserId: currentUserId,
        deviceId: null,
        wireGuardPeer: null,
        wireGuardDesiredActive: false,
        wireGuardLaunchDaemonEnabled: process.platform === 'darwin',
        activeProfileId: null,
        lastManifest: null,
        lastSubscription: null,
        anonymous: null,
        domainProxy: null,
        updatedAt: new Date().toISOString()
      };
      this.saveSettings();
      this.ctx.log.info('reset HDO local device settings after account switch', {
        previousUserId,
        currentUserId
      });
      return;
    }

    if (this.settings.sessionUserId !== currentUserId) {
      this.settings = {
        ...this.settings,
        sessionUserId: currentUserId,
        updatedAt: new Date().toISOString()
      };
      this.saveSettings();
    }
  }

  private currentSessionUserId(): string | null {
    const user = this.ctx.marketplaceDb?.getActiveSession?.()?.user;
    return stringField(user, 'id') ?? stringField(user, 'userId') ?? stringField(user, 'sub');
  }

  private loadSettings(): HdoPluginSettings {
    if (!existsSync(this.settingsPath)) {
      return {
        hdoControlBaseUrl: normalizeBaseUrl(process.env.QPJOY_HDO_SERVER) ?? null,
        relayMode: 'mesh-hdi',
        sessionUserId: null,
        deviceId: null,
        deviceLabel: defaultDeviceLabel(),
        devicePlatform: process.platform,
        wireGuardDesiredActive: false,
        wireGuardLaunchDaemonEnabled: process.platform === 'darwin',
        wireGuardAutoRecover: true,
        autoRunDeviceTasks: true,
        activeProfileId: null,
        wireGuardPeer: null,
        lastTaskRun: null,
        lastNotification: null,
        lastManifest: null,
        lastSubscription: null,
        anonymous: null,
        domainProxy: null,
        networkLeases: null,
        updatedAt: null
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as HdoPluginSettings;
      return {
        ...parsed,
        hdoControlBaseUrl: normalizeBaseUrl(parsed.hdoControlBaseUrl) ?? null,
        relayMode: normalizeRelayMode(parsed.relayMode),
        sessionUserId: parsed.sessionUserId ?? null,
        wireGuardPeer: parsed.wireGuardPeer ?? null,
        wireGuardDesiredActive: parsed.wireGuardDesiredActive ?? false,
        wireGuardAutoRecover: parsed.wireGuardAutoRecover ?? true,
        wireGuardLaunchDaemonEnabled: parsed.wireGuardLaunchDaemonEnabled ?? (process.platform === 'darwin'),
        autoRunDeviceTasks: parsed.autoRunDeviceTasks ?? true,
        activeProfileId: parsed.activeProfileId ?? null,
        anonymous: parsed.anonymous ?? null,
        domainProxy: parsed.domainProxy ?? null,
        networkLeases: parsed.networkLeases ?? null,
        lastTaskRun: parsed.lastTaskRun ?? null,
        lastNotification: parsed.lastNotification ?? null
      };
    } catch (err) {
      this.ctx.log.warn('failed to read HDO settings, using defaults', {
        error: errorMessage(err)
      });
      return {
        hdoControlBaseUrl: null,
        relayMode: 'mesh-hdi',
        sessionUserId: null,
        deviceId: null,
        deviceLabel: defaultDeviceLabel(),
        devicePlatform: process.platform,
        wireGuardDesiredActive: false,
        wireGuardLaunchDaemonEnabled: process.platform === 'darwin',
        wireGuardAutoRecover: true,
        autoRunDeviceTasks: true,
        activeProfileId: null,
        wireGuardPeer: null,
        lastTaskRun: null,
        lastNotification: null,
        lastManifest: null,
        lastSubscription: null,
        anonymous: null,
        domainProxy: null,
        networkLeases: null,
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

  private shutdownWireGuardConfigPath(): string | null {
    const configured = stringValue(this.settings.wireGuardPeer?.configPath);
    if (configured) return configured;
    const fallback = join(this.ctx.userDataDir, 'wireguard', 'hdo-client.conf');
    return existsSync(fallback) ? fallback : null;
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

function isDeviceOwnershipError(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes('device id already belongs to another user');
}

function isAnonymousDeviceId(value: unknown): boolean {
  return stringValue(value)?.startsWith('hdo-anon-') === true;
}

function isAnonymousOverlayIp(value: unknown): boolean {
  return stringValue(value)?.startsWith('100.91.') === true;
}

function anonymousOverlayIp(value: unknown): string | null {
  const overlayIp = stringValue(value);
  return overlayIp && isAnonymousOverlayIp(overlayIp) ? overlayIp : null;
}

function accountOverlayIp(value: unknown): string | null {
  const overlayIp = stringValue(value);
  return overlayIp && !isAnonymousOverlayIp(overlayIp) ? overlayIp : null;
}

function normalizeOverlayIp(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  return text.split('/')[0] || null;
}

function normalizeRelayMode(value: unknown): HdoRelayMode {
  if (value === 'mesh-h2i' || value === 'mesh-service-p2p') return 'mesh-h2i';
  if (value === 'mesh-h2h' || value === 'mesh-p2p') return 'mesh-h2h';
  return 'mesh-hdi';
}

function wireGuardPreferenceMetadata(value: unknown): Record<string, unknown> {
  const relayMode = normalizeRelayMode(value);
  return {
    relayMode,
    preferDirectPeers: relayMode !== 'mesh-hdi'
  };
}

function isAuthorizationCancelledMessage(value: unknown): boolean {
  const text = String(value ?? '');
  return text.includes('已取消 WireGuard 管理员授权')
    || text.includes('用户已取消')
    || text.includes('(-128)')
    || /user canceled/i.test(text)
    || /cancelled/i.test(text);
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pingOverlayIp(host: string, timeoutMs: number): Promise<boolean> {
  const command = process.platform === 'win32'
    ? 'ping.exe'
    : (process.platform === 'darwin' ? '/sbin/ping' : 'ping');
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(timeoutMs), host]
    : (process.platform === 'darwin'
        ? ['-c', '1', '-W', String(timeoutMs), host]
        : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host]);
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs + 800, windowsHide: true }, (err) => {
      resolve(!err);
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

function publicEventWireGuardPeer(value: Record<string, unknown>): Record<string, unknown> {
  return {
    publicKey: stringValue(value.publicKey),
    overlayIp: stringValue(value.overlayIp),
    address: stringValue(value.address),
    allowedIps: Array.isArray(value.allowedIps) ? value.allowedIps : null,
    dns: Array.isArray(value.dns) ? value.dns : null,
    configReady: Boolean(value.config && value.configPath),
    canUseDefaultMesh: value.canUseDefaultMesh === true,
    lastError: stringValue(value.lastError),
    updatedAt: stringValue(value.updatedAt)
  };
}

function publicAnonymousSettings(value: unknown): Record<string, unknown> | null {
  const row = plainObject(value);
  if (!row || row.mode !== 'anonymous') return null;
  return {
    mode: 'anonymous',
    appId: stringValue(row.appId),
    installId: stringValue(row.installId),
    updatedAt: stringValue(row.updatedAt)
  };
}

function publicWireGuardRuntime(value: unknown): Record<string, unknown> {
  const runtime = plainObject(value);
  return runtime ? { ...runtime } : {};
}

function hasWireGuardLaunchDaemon(status: { installed?: boolean; loaded?: boolean; running?: boolean } | null): boolean {
  return Boolean(status && (status.installed === true || status.loaded === true || status.running === true));
}

function safeWireGuardStatus(
  runtime: ReturnType<typeof resolveWireGuardConnectionRuntime>,
  configPath: string
): ReturnType<typeof getWireGuardTunnelStatus> | null {
  try {
    return getWireGuardTunnelStatus({ runtime, configPath });
  } catch {
    return null;
  }
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

function wireGuardDnsServersForPlatform(manifest: Record<string, unknown>): string[] {
  if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin') return [];
  const wireGuard = plainObject(manifest.wireGuard);
  const domestic = plainObject(wireGuard?.domestic);
  return normalizeWireGuardDnsServers([
    ...dnsServerValues(wireGuard?.dnsServers),
    ...dnsServerValues(wireGuard?.dns),
    stringValue(wireGuard?.dnsServer),
    ...dnsServerValues(domestic?.dnsServers),
    ...dnsServerValues(domestic?.dns),
    stringValue(domestic?.dnsServer)
  ]);
}

function wireGuardDnsDomainsForPlatform(manifest: Record<string, unknown>): string[] {
  if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin') return [];
  return uniqueStrings(
    domainBindingsFromManifest(manifest)
      .map((binding) => normalizeWireGuardDnsDomain(binding.domain))
      .filter((domain): domain is string => Boolean(domain))
  );
}

function dnsServerValues(value: unknown): string[] {
  if (Array.isArray(value)) return stringArray(value);
  const text = stringValue(value);
  return text ? text.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeWireGuardDnsServers(values: Array<string | null>): string[] {
  return uniqueStrings(
    values
      .map((value) => normalizeWireGuardDnsServer(value))
      .filter((value): value is string => Boolean(value))
  );
}

function normalizeWireGuardDnsServer(value: string | null): string | null {
  const text = value?.trim();
  if (!text || /[\s,/]/.test(text) || /^[a-z][a-z\d+.-]*:\/\//i.test(text)) return null;
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) return null;
  return text;
}

function normalizeWireGuardDnsDomain(value: string | null): string | null {
  const text = value?.trim().toLowerCase().replace(/\.+$/, '');
  if (!text || text.length > 253 || text.includes('..')) return null;
  const labels = text.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  return text;
}

function wireGuardDnsRouteCidrs(dnsServers: string[]): string[] {
  return uniqueStrings(
    dnsServers
      .map((server) => normalizeOverlayIp(server))
      .filter((server): server is string => Boolean(server && server.startsWith('100.')))
      .map((server) => normalizeCidr(`${server}/32`) ?? `${server}/32`)
  );
}

function manifestOverlayRouteCidrs(manifest: Record<string, unknown>, ownOverlayIp: string | null): string[] {
  const out: string[] = [];
  const ownIp = stringValue(ownOverlayIp);
  const addOverlayIp = (value: unknown) => {
    const ip = stringValue(value);
    if (!ip || ip === ownIp || !ip.startsWith('100.')) return;
    const normalized = normalizeCidr(`${ip}/32`);
    if (normalized) out.push(normalized);
  };

  const wireGuard = plainObject(manifest.wireGuard);
  addOverlayIp(plainObject(wireGuard?.domestic)?.overlayIp);
  arrayField(manifest.nodes).forEach((item) => addOverlayIp(plainObject(item)?.overlayIp));
  arrayField(manifest.devices).forEach((item) => addOverlayIp(plainObject(item)?.overlayIp));
  arrayField(manifest.services).forEach((item) => addOverlayIp(plainObject(item)?.targetHost));
  return uniqueStrings(out);
}

function directPeersFromManifest(manifest: Record<string, unknown>, ownOverlayIp: string | null): Array<{
  name: string;
  publicKey: string;
  allowedIps: string[];
  endpoint: string | null;
  persistentKeepalive: number;
}> {
  const wireGuard = plainObject(manifest.wireGuard);
  const ownIp = stringValue(ownOverlayIp);
  return arrayField(wireGuard?.directPeers).flatMap((item) => {
    const row = plainObject(item);
    const publicKey = stringValue(row?.publicKey);
    const overlayIp = stringValue(row?.overlayIp);
    if (!publicKey || !overlayIp || overlayIp === ownIp) return [];
    const allowedIps = stringArray(row?.allowedIps);
    return [{
      name: `HDO Direct ${stringValue(row?.label) ?? stringValue(row?.id) ?? overlayIp}`,
      publicKey,
      allowedIps: allowedIps.length ? allowedIps : [`${overlayIp}/32`],
      endpoint: stringValue(row?.endpoint),
      persistentKeepalive: 25
    }];
  });
}

type HdoClientDirectPeer = ReturnType<typeof directPeersFromManifest>[number];

function directPeerOverlayIps(directPeers: HdoClientDirectPeer[]): string[] {
  return uniqueStrings(
    directPeers
      .filter((peer) => Boolean(peer.endpoint))
      .flatMap((peer) => peer.allowedIps)
      .map((cidr) => normalizeOverlayIp(normalizeCidr(cidr) ?? cidr))
      .filter((ip): ip is string => Boolean(ip && ip.startsWith('100.')))
  );
}

function clientDirectPeersForPlatform(
  relayMode: HdoRelayMode,
  directPeers: HdoClientDirectPeer[]
): HdoClientDirectPeer[] {
  if (relayMode === 'mesh-hdi') return [];
  if (process.platform === 'win32' && relayMode === 'mesh-h2i') {
    return directPeers.filter((peer) => Boolean(peer.endpoint));
  }
  return directPeers;
}

function windowsH2iDirectPeerAllowedIps(
  relayMode: HdoRelayMode,
  directPeers: HdoClientDirectPeer[]
): string[] {
  if (process.platform !== 'win32' || relayMode !== 'mesh-h2i') return [];
  return uniqueStrings(
    directPeers
      .filter((peer) => !peer.endpoint)
      .flatMap((peer) => peer.allowedIps)
      .map((cidr) => normalizeCidr(cidr) ?? cidr)
      .filter((cidr) => cidr.includes('/'))
  );
}

function domainBindingsFromManifest(manifest: Record<string, unknown>): HdoDomainBinding[] {
  const dnsRecords = arrayField(manifest.dnsRecords);
  const services = arrayField(manifest.services);
  const out: HdoDomainBinding[] = [];
  const seen = new Set<string>();
  for (const item of dnsRecords) {
    const record = plainObject(item);
    if (!record || record.enabled === false) continue;
    const domain = stringValue(record.domain);
    const targetHost = stringValue(record.targetHost);
    if (!domain || !targetHost || seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      domain,
      targetHost,
      targetPort: null,
      protocol: 'dns'
    });
  }
  for (const item of services) {
    const service = plainObject(item);
    if (!service) continue;
    const targetHost = stringValue(service.targetHost);
    if (!targetHost) continue;
    const targetPort = numberValue(service.targetPort);
    const protocol = stringValue(service.protocol);
    for (const domain of stringArray(service.domains)) {
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({
        domain,
        targetHost,
        targetPort,
        protocol
      });
    }
  }
  return out;
}

function manifestHasMeshLicense(manifest: Record<string, unknown>): boolean {
  const license = plainObject(manifest.license);
  return license?.active === true;
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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
