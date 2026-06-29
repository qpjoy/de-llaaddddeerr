export interface LuopanRuntimeConfig {
  baseUrl: string;
  productId: string;
  mode: 'standalone';
  sdkTestMode: boolean;
  deviceLabel: string;
}

export interface LuopanRuntimeConnection {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  leaseIp: string | null;
  serviceVip: string | null;
  dnsServer: string | null;
  routeCidrs: string[];
  snapshotDigest: string | null;
  message: string | null;
  updatedAt: string | null;
}

export interface LuopanRuntimeState {
  appId: string;
  displayName: string;
  packageName: string;
  launcherMode: 'standalone';
  installId: string;
  deviceId: string;
  config: LuopanRuntimeConfig;
  connection: LuopanRuntimeConnection;
  events: string[];
}

export interface LuopanLauncherApi {
  getRuntime(): Promise<LuopanRuntimeState>;
  saveConfig(input: Partial<LuopanRuntimeConfig>): Promise<LuopanRuntimeState>;
  connectTestMode(): Promise<LuopanRuntimeState>;
  refreshSnapshot(): Promise<LuopanRuntimeState>;
  resetSession(): Promise<LuopanRuntimeState>;
  openAdmin(): Promise<void>;
  openInternalEntry(): Promise<void>;
  onRuntime(listener: (state: LuopanRuntimeState) => void): () => void;
}

declare global {
  interface Window {
    luopanLauncher?: LuopanLauncherApi;
  }
}
