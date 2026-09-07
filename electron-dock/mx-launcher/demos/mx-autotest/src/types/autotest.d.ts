import type { ElectronLauncherStandaloneDataPlaneDiagnostics } from '@qpjoy/electron-launcher';

export type MxAutotestConnectionStatus =
  | 'idle'
  | 'resolving-bootstrap'
  | 'enrolling'
  | 'lease-active'
  | 'applying-data-plane'
  | 'data-plane-pending'
  | 'network-ready'
  | 'disconnecting'
  | 'error';

export interface MxAutotestRuntimeState {
  appId: 'mx-autotest';
  displayName: string;
  packageName: '@qpjoy/mx-autotest';
  launcherMode: 'standalone';
  networkScope: 'owner';
  installId: string;
  deviceId: string;
  credentialStorageReady: boolean;
  config: {
    productId: 'mx-autotest';
    mode: 'standalone';
    bootstrapUrls: string[];
    internalPort: number;
    platformServerUrl: string | null;
    sdkTestMode: boolean;
    deviceLabel: string;
  };
  identity: {
    kind: 'anonymous' | 'user';
    userId: string | null;
    displayName: string | null;
    account: string | null;
    scopes: string[];
    tokenExpiresAt: string | null;
    loginAt: string | null;
    tokenPresent: boolean;
  };
  connection: {
    status: MxAutotestConnectionStatus;
    bootstrapBaseUrl: string | null;
    internalBaseUrl: string | null;
    leaseId: string | null;
    leaseIp: string | null;
    serviceVip: string | null;
    routeCidrs: string[];
    snapshotDigest: string | null;
    dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics | null;
    message: string;
    updatedAt: string | null;
  };
  platform: {
    configured: boolean;
    baseUrl: string | null;
  };
  events: string[];
}

export interface MxAutotestDesktopApi {
  getRuntime(): Promise<MxAutotestRuntimeState>;
  connectInternal(): Promise<MxAutotestRuntimeState>;
  login(input: { account: string; password: string }): Promise<MxAutotestRuntimeState>;
  logout(): Promise<MxAutotestRuntimeState>;
  disconnect(): Promise<MxAutotestRuntimeState>;
  getPlatformSnapshot(): Promise<MxAutotestPlatformSnapshot>;
  runTask(input: {
    taskId: string;
    caseFilter?: string;
  }): Promise<unknown>;
  onRuntime(listener: (state: MxAutotestRuntimeState) => void): () => void;
}

export interface MxAutotestPlatformSnapshot {
  discovery: unknown;
  me: { member?: Record<string, unknown> };
  apps: { apps?: Array<Record<string, unknown>> };
  tasks: { tasks?: Array<Record<string, unknown>> };
  runs: { runs?: Array<Record<string, unknown>> };
  runners: { runners?: Array<Record<string, unknown>> };
}

declare global {
  interface Window {
    mxAutotest?: MxAutotestDesktopApi;
  }
}
