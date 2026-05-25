export type RuntimeMode = 'system-tun' | 'app-global' | 'app-rule';

export type DomainRuleKind = 'allow' | 'block';

export interface TunnelPorts {
  admin: number;
  controller: number;
  mixed: number;
  dns: number;
}

export interface RuntimeSettings {
  id: number;
  mode: RuntimeMode;
  ports: TunnelPorts;
  adminUser: string;
  adminPasswordHash: string;
  controllerSecret: string;
  corePath: string | null;
  tunInstalled: boolean;
  activeSubscriptionId: number | null;
  updatedAt: string;
}

export interface SubscriptionInput {
  name: string;
  url: string;
  username?: string;
  password?: string;
}

export interface SubscriptionUpdateInput extends SubscriptionInput {
  id: number;
}

export interface ManagedTunnelConfigInput {
  subscription?: SubscriptionInput | null;
  mode?: RuntimeMode | null;
  autoStart?: boolean | null;
  autoUpdate?: boolean | null;
  rules?: {
    allowlist?: string[];
    blocklist?: string[];
  } | null;
  source?: string | null;
}

export interface ManagedTunnelConfigResult {
  status: TunnelStatus;
  subscription: SubscriptionRecord | null;
  rules: DomainRule[];
  started: boolean;
}

export interface SubscriptionRecord extends Required<SubscriptionInput> {
  id: number;
  localPath: string | null;
  content: string | null;
  active: boolean;
  lastUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DomainRule {
  id: number;
  kind: DomainRuleKind;
  domain: string;
  source: string;
  enabled: boolean;
  createdAt: string;
}

export interface EventRecord {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface TunnelStatus {
  platform: NodeJS.Platform;
  running: boolean;
  pid: number | null;
  mode: RuntimeMode;
  tunInstalled: boolean;
  health: {
    ok: boolean;
    level: 'ok' | 'warning' | 'error';
    message: string | null;
  };
  ports: TunnelPorts;
  activeSubscription: SubscriptionRecord | null;
  corePath: string | null;
  engine: {
    target: string;
    available: boolean;
    source: 'custom' | 'installed' | 'bundled' | 'missing';
    customPath: string | null;
    installedPath: string | null;
    bundledPath: string | null;
  };
  adminUrl: string;
  controllerUrl: string;
}

export interface TrafficSummary {
  available: boolean;
  connections: number;
  uploadTotal: number;
  downloadTotal: number;
}

export interface TunnelSnapshot {
  status: TunnelStatus;
  subscriptions: SubscriptionRecord[];
  rules: DomainRule[];
  events: EventRecord[];
  traffic: TrafficSummary;
}

export interface TunnelManagerOptions {
  appName?: string;
  userDataPath: string;
  bundledEngineDir?: string;
  /** @deprecated Use bundledEngineDir. */
  bundledCoreDir?: string;
  adminPort?: number;
  controllerPort?: number;
  mixedPort?: number;
  dnsPort?: number;
}

export interface RenderRuntimeConfigInput {
  baseYaml: string;
  settings: RuntimeSettings;
  rules: DomainRule[];
}

export interface RenderedRuntimeConfig {
  yaml: string;
  proxyPolicyName: string;
}

export interface MihomoApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
}
