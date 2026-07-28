import type { ElectronLauncherStandaloneDataPlaneDiagnostics } from '@qpjoy/electron-launcher';

export interface LuopanRuntimeConfig {
  baseUrl: string;
  bootstrapUrls: string[];
  productId: string;
  mode: 'standalone';
  sdkTestMode: boolean;
  deviceLabel: string;
}

export interface LuopanRuntimeIdentity {
  kind: 'anonymous' | 'user';
  userId: string | null;
  displayName: string | null;
  account: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  loginAt: string | null;
  tokenPresent: boolean;
}

export interface LuopanRuntimeConnection {
  status: 'idle' | 'connecting' | 'lease-active' | 'data-plane-pending' | 'network-ready' | 'error';
  bootstrapBaseUrl: string | null;
  leaseIp: string | null;
  serviceVip: string | null;
  dnsServer: string | null;
  routeCidrs: string[];
  snapshotDigest: string | null;
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics | null;
  message: string | null;
  updatedAt: string | null;
}

export type LuopanOverseaStatus =
  | 'waiting-login'
  | 'waiting-internal'
  | 'ensuring'
  | 'pending-sync'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopped'
  | 'error';

export type LuopanOverseaMode = 'app-global' | 'app-rule';

export interface LuopanOverseaTunnelEvent {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface LuopanOverseaRuntime {
  status: LuopanOverseaStatus;
  autoConnect: boolean;
  mode: LuopanOverseaMode;
  userId: string | null;
  entitlementId: string | null;
  subscriptionPath: string | null;
  subscriptionName: string | null;
  siteIds: string[];
  syncStatus: string | null;
  nodeCount: number;
  ensuredAt: string | null;
  startedAt: string | null;
  lastTestUrl: string;
  lastTestAt: string | null;
  lastProxyDecision: string | null;
  message: string;
  tunnel: {
    running: boolean;
    health: { ok: boolean; level: 'ok' | 'warning' | 'error'; message: string | null };
    mode: LuopanOverseaMode;
    ports: { admin: number; controller: number; mixed: number; dns: number };
    engine: {
      target: string;
      available: boolean;
      source: 'custom' | 'installed' | 'bundled' | 'missing';
    };
    activeSubscription: { id: number; name: string; lastUpdatedAt: string | null } | null;
    events: LuopanOverseaTunnelEvent[];
  };
}

export interface LuopanRuntimeUpdateArtifact {
  artifactId: string;
  kind: string;
  artifactClass: string;
  version: string;
  activation: string;
  autoApply: boolean;
  sizeBytes: number | null;
}

export interface LuopanRuntimeUpdateExecution {
  artifactId: string;
  artifactClass: string;
  phase: string;
  activated: boolean;
  deferredReason: string | null;
  error: string | null;
}

export interface LuopanRuntimeUpdate {
  status: 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'blocked' | 'failed';
  checkedAt: string | null;
  currentVersion: string;
  targetVersion: string | null;
  releaseId: string | null;
  releaseNotes: string | null;
  matchedBy: string | null;
  featureFlags: string[];
  artifacts: LuopanRuntimeUpdateArtifact[];
  execution: LuopanRuntimeUpdateExecution[];
  message: string | null;
}

export interface LuopanRuntimeState {
  appId: string;
  displayName: string;
  packageName: string;
  launcherMode: 'standalone';
  installId: string;
  deviceId: string;
  config: LuopanRuntimeConfig;
  identity: LuopanRuntimeIdentity;
  connection: LuopanRuntimeConnection;
  oversea: LuopanOverseaRuntime;
  update: LuopanRuntimeUpdate;
  events: string[];
}

export interface LuopanLauncherApi {
  getRuntime(): Promise<LuopanRuntimeState>;
  saveConfig(input: Partial<LuopanRuntimeConfig>): Promise<LuopanRuntimeState>;
  login(input: { account: string; password: string }): Promise<LuopanRuntimeState>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<LuopanRuntimeState>;
  logout(): Promise<LuopanRuntimeState>;
  connectTestMode(): Promise<LuopanRuntimeState>;
  connectInternal(): Promise<LuopanRuntimeState>;
  applyDataPlane(): Promise<LuopanRuntimeState>;
  disconnectDataPlane(): Promise<LuopanRuntimeState>;
  refreshSnapshot(): Promise<LuopanRuntimeState>;
  resetSession(): Promise<LuopanRuntimeState>;
  refreshOverseaSubscription(): Promise<LuopanRuntimeState>;
  startOversea(): Promise<LuopanRuntimeState>;
  stopOversea(): Promise<LuopanRuntimeState>;
  setOverseaMode(mode: LuopanOverseaMode): Promise<LuopanRuntimeState>;
  setOverseaAutoConnect(enabled: boolean): Promise<LuopanRuntimeState>;
  openOverseaTestWindow(input: { url: string }): Promise<LuopanRuntimeState>;
  checkUpdates(): Promise<LuopanRuntimeState>;
  applyUpdate(): Promise<LuopanRuntimeState>;
  openStagedInstaller(): Promise<LuopanRuntimeState>;
  rollbackUpdateSlot(slot: 'config' | 'renderer'): Promise<LuopanRuntimeState>;
  openAdmin(): Promise<void>;
  openInternalEntry(): Promise<void>;
  onRuntime(listener: (state: LuopanRuntimeState) => void): () => void;
}

declare global {
  interface Window {
    luopanLauncher?: LuopanLauncherApi;
  }
}
