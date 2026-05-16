export type RuntimeMode = 'system-tun' | 'app-global' | 'app-rule';

export interface SubscriptionRecord {
  id: number;
  name: string;
  url: string;
  username: string;
  password: string;
  localPath: string | null;
  content: string | null;
  active: boolean;
  lastUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DomainRule {
  id: number;
  kind: 'allow' | 'block';
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
  running: boolean;
  pid: number | null;
  mode: RuntimeMode;
  tunInstalled: boolean;
  ports: {
    admin: number;
    controller: number;
    mixed: number;
    dns: number;
  };
  activeSubscription: SubscriptionRecord | null;
  corePath: string | null;
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

export interface TunnelBridge {
  snapshot(): Promise<TunnelSnapshot>;
  createSubscription(input: { name: string; url: string; username?: string; password?: string }): Promise<SubscriptionRecord>;
  editSubscription(input: { id: number; name: string; url: string; username?: string; password?: string }): Promise<SubscriptionRecord>;
  deleteSubscription(id: number): Promise<void>;
  setActiveSubscription(id: number): Promise<SubscriptionRecord>;
  updateSubscription(id: number): Promise<SubscriptionRecord>;
  updateActiveSubscription(): Promise<SubscriptionRecord>;
  setMode(mode: RuntimeMode): Promise<void>;
  setCorePath(corePath: string): Promise<void>;
  setLocalPorts(ports: { mixed?: number; dns?: number }): Promise<void>;
  installTun(): Promise<void>;
  uninstallTun(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  openAdmin(): Promise<void>;
  openTestWindow(url: string): Promise<void>;
  addRule(input: { kind: 'allow' | 'block'; domain: string }): Promise<DomainRule>;
  removeRule(id: number): Promise<void>;
  addPreset(preset: 'google' | 'youtube' | 'x' | 'telegram'): Promise<DomainRule[]>;
  removePreset(preset: 'google' | 'youtube' | 'x' | 'telegram'): Promise<number>;
}

declare global {
  interface Window {
    tunnel: TunnelBridge;
  }
}
