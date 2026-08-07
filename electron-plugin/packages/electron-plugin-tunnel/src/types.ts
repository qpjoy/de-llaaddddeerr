/**
 * - `app-rule`   App 模式：只有白名单域名走代理，其余 REJECT。
 * - `app-global` 全局模式：黑名单之外都走代理，只影响挂到本地 mixed-port 的应用（默认）。
 * - `system-tun` 虚拟网卡：接管整机流量，含外部浏览器。
 *
 * fake-ip / redir-host、TUN 协议栈和 cn-direct 是模式之外的独立开关
 * （见 `RuntimeTuning`），和 Clash 的设置分层一致。
 */
export type RuntimeMode = 'system-tun' | 'app-global' | 'app-rule';

export type DnsMode = 'fake-ip' | 'redir-host';

export type TunStack = 'system' | 'gvisor' | 'mixed';

export interface RuntimeTuning {
  /** fake-ip 更快且不泄漏 DNS；redir-host 解析真实 IP，兼容需要真实地址的应用。 */
  dnsMode: DnsMode;
  /**
   * TUN 协议栈。遇到兼容性问题的升级路径是 system -> mixed -> gvisor：
   * system 用内核 TCP 栈最快，mixed 只把 UDP 挪到 gvisor，gvisor 全用户态最稳。
   */
  tunStack: TunStack;
  /** strict-route 防泄漏。会和其它 VPN 抢路由，默认关；与协议栈无关。 */
  strictRoute: boolean;
  /** 国内直连。关掉表示国内域名也走代理。 */
  cnDirect: boolean;
}

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
  /**
   * Already-authenticated subscription YAML supplied by the host. This lets
   * an Electron app exchange a short-lived bearer token for YAML without
   * persisting that token in a subscription URL or in the tunnel database.
   */
  subscriptionContent?: string | null;
  mode?: RuntimeMode | null;
  /** Defaults to true for managed backend profiles. Pass false to only save config. */
  autoStart?: boolean | null;
  /**
   * Managed backend pulls must not surprise users with OS privilege prompts.
   * Pass true only from an explicit user action that is allowed to start
   * system TUN immediately.
   */
  allowSystemTunPrivilege?: boolean | null;
  autoUpdate?: boolean | null;
  rules?: {
    allowlist?: string[];
    blocklist?: string[];
  } | null;
  /** Clash-style knobs that are independent of `mode`. Omitted fields keep their stored value. */
  tuning?: Partial<RuntimeTuning> | null;
  /** Oversea node to route through. Must be one of the active subscription's proxies. */
  selectedNode?: string | null;
  /**
   * Control-plane endpoints that must stay outside the tunnel in every mode:
   * the host app's own bootstrap API, relay endpoints and internal services.
   * Without these, virtual-NIC modes hijack the traffic the app needs to keep
   * its own session alive.
   */
  guard?: {
    directDomains?: string[];
    directIps?: string[];
    fakeIpFilter?: string[];
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
  tuning: RuntimeTuning;
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
