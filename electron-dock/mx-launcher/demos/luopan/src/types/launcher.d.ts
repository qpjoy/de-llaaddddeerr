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
  update: LuopanRuntimeUpdate;
  events: string[];
}

export interface LuopanLauncherApi {
  getRuntime(): Promise<LuopanRuntimeState>;
  saveConfig(input: Partial<LuopanRuntimeConfig>): Promise<LuopanRuntimeState>;
  login(input: { account: string; password: string }): Promise<LuopanRuntimeState>;
  logout(): Promise<LuopanRuntimeState>;
  connectTestMode(): Promise<LuopanRuntimeState>;
  connectInternal(): Promise<LuopanRuntimeState>;
  applyDataPlane(): Promise<LuopanRuntimeState>;
  disconnectDataPlane(): Promise<LuopanRuntimeState>;
  refreshSnapshot(): Promise<LuopanRuntimeState>;
  resetSession(): Promise<LuopanRuntimeState>;
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
