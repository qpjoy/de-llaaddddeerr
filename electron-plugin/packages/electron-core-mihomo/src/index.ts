import { parse, stringify } from 'yaml';

export type MihomoRuntimeMode = 'system-tun' | 'app-global' | 'app-rule';

export type MihomoTunStack = 'system' | 'gvisor' | 'mixed';

export type MihomoDnsMode = 'fake-ip' | 'redir-host';

/**
 * `system-fakeip` 曾经是独立模式，现在折叠成 `system-tun` + `dnsMode: 'fake-ip'`，
 * 和 Clash 一致：虚拟网卡是模式，fake-ip / redir-host 是模式之外的独立开关。
 */
export function normalizeRuntimeMode(value: string | null | undefined): MihomoRuntimeMode {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'rule') return 'app-rule';
  if (text === 'global' || text === 'direct') return 'app-global';
  if (text === 'tun' || text === 'system-fakeip' || text === 'system-redir') return 'system-tun';
  return text === 'app-rule' || text === 'system-tun' ? text : 'app-global';
}

export function normalizeDnsMode(value: string | null | undefined): MihomoDnsMode {
  const text = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
  return text === 'redir-host' || text === 'redir' || text === 'real-ip' ? 'redir-host' : 'fake-ip';
}

/**
 * 默认 `system`：直接用内核 TCP 栈，吞吐和内存都最好，也是遇到问题时最容易
 * 判断"是不是协议栈的锅"的基线。出问题的升级路径是 system -> mixed -> gvisor。
 */
export function normalizeTunStack(value: string | null | undefined): MihomoTunStack {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'gvisor' || text === 'mixed' ? text : 'system';
}

export type MihomoDomainRuleKind = 'allow' | 'block';

export interface MihomoPorts {
  admin: number;
  controller: number;
  mixed: number;
  dns: number;
}

export interface MihomoRuntimeSettings {
  mode: MihomoRuntimeMode;
  ports: MihomoPorts;
  controllerSecret: string;
  tunInstalled: boolean;
  /** DNS 解析策略，独立于 mode，默认 fake-ip。 */
  dnsMode?: MihomoDnsMode | null;
  /** 虚拟网卡协议栈，仅在 system-tun 生效，默认 system。 */
  tunStack?: MihomoTunStack | null;
  /**
   * strict-route：用防火墙规则把绕过 TUN 的流量也抓回来。防泄漏更强，但会和
   * 其它 VPN / 外部 Clash 抢路由，所以默认关。与协议栈无关。
   */
  strictRoute?: boolean | null;
  /** 国内直连（GEOSITE/GEOIP CN -> DIRECT），默认开。关掉表示国内域名也走代理。 */
  cnDirect?: boolean | null;
}

export interface MihomoDomainRule {
  id?: number;
  kind: MihomoDomainRuleKind;
  domain: string;
  source?: string;
  enabled: boolean;
}

export interface MihomoMeshServiceRoute {
  name: string;
  targetHost: string;
  targetPort: number;
  protocol?: 'tcp' | 'udp' | 'http' | 'https';
  domains?: string[];
  routeTo?: string;
}

export interface MihomoRouteProfile {
  id: string;
  name: string;
  mode: 'proxy' | 'direct' | 'mesh' | 'reject';
  domains?: string[];
  cidrs?: string[];
  ports?: number[];
  target?: string;
}

export interface RenderRuntimeConfigInput {
  baseYaml: string;
  settings: MihomoRuntimeSettings;
  rules: MihomoDomainRule[];
  geoxUrl?: Record<string, string>;
  useGeoRules?: boolean;
  meshServices?: MihomoMeshServiceRoute[];
  /**
   * 控制面保护域名/网段：无论什么模式都强制 DIRECT，并从 fake-ip 池里排除。
   * launcher 用它来保证 WireGuard endpoint、Domestic bootstrap、Internal API
   * 在虚拟网卡模式下不会被自己的隧道劫持。
   */
  directDomains?: string[];
  directIps?: string[];
  /** 额外的 fake-ip 排除域名（默认排除项之外）。 */
  fakeIpFilter?: string[];
  /**
   * 用户选中的出海节点名。规则永远指向 select 组而不是具体节点，
   * 换节点只改组内顺序 / 运行时选择，不需要重写任何一条规则。
   */
  selectedNode?: string | null;
  /** 覆盖平台判断（`auto-redirect` 只有 Linux 支持）。默认取 `process.platform`。 */
  platform?: string;
}

export interface MihomoProxyNode {
  name: string;
  type: string | null;
  server: string | null;
  port: number | null;
}

export interface RenderedRuntimeConfig {
  yaml: string;
  proxyPolicyName: string;
}

type MihomoConfig = Record<string, unknown>;

export const DEFAULT_GEOX_URL = {
  geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
  geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
  mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb'
};

export const PRIVATE_DIRECT_RULES = [
  'DOMAIN-SUFFIX,local,DIRECT',
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
  'IP-CIDR6,::1/128,DIRECT,no-resolve',
  'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
  'IP-CIDR6,fe80::/10,DIRECT,no-resolve'
];

/**
 * fake-ip 默认排除项。局域网发现、抓包代理、captive portal、时间同步这些
 * 拿到 198.18.x 的假地址会直接坏掉，必须回退到真实解析。
 */
export const DEFAULT_FAKE_IP_FILTER = [
  '*.lan',
  '*.local',
  '*.localdomain',
  '*.home.arpa',
  'localhost.ptlogin2.qq.com',
  '+.msftconnecttest.com',
  '+.msftncsi.com',
  'captive.apple.com',
  'time.*.com',
  'time.*.gov',
  'ntp.*.com',
  '+.pool.ntp.org',
  '+.in-addr.arpa',
  '+.ip6.arpa'
];

export const BOOTSTRAP_CN_DIRECT_RULES = [
  'DOMAIN-SUFFIX,cn,DIRECT',
  'DOMAIN-SUFFIX,中国,DIRECT',
  'DOMAIN-SUFFIX,baidu.com,DIRECT',
  'DOMAIN-SUFFIX,bdstatic.com,DIRECT',
  'DOMAIN-SUFFIX,qq.com,DIRECT',
  'DOMAIN-SUFFIX,weixin.qq.com,DIRECT',
  'DOMAIN-SUFFIX,alicdn.com,DIRECT',
  'DOMAIN-SUFFIX,taobao.com,DIRECT',
  'DOMAIN-SUFFIX,tmall.com,DIRECT',
  'DOMAIN-SUFFIX,alipay.com,DIRECT',
  'DOMAIN-SUFFIX,aliyun.com,DIRECT',
  'DOMAIN-SUFFIX,jd.com,DIRECT',
  'DOMAIN-SUFFIX,mi.com,DIRECT',
  'DOMAIN-SUFFIX,bilibili.com,DIRECT',
  'DOMAIN-SUFFIX,douyin.com,DIRECT',
  'DOMAIN-SUFFIX,bytedance.com,DIRECT'
];

export function validateSubscriptionYaml(content: string): void {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    throw new Error('subscription yaml is invalid');
  }

  if (!isRecord(parsed)) {
    throw new Error('subscription yaml is invalid');
  }

  if (
    !Array.isArray(parsed.proxies)
    && !Array.isArray(parsed['proxy-groups'])
    && !isRecord(parsed['proxy-providers'])
  ) {
    throw new Error('subscription yaml has no proxy definitions');
  }
}

/** 虚拟网卡模式会拉起 TUN 设备，需要管理员授权。 */
export function isTunRuntimeMode(mode: string): boolean {
  return normalizeRuntimeMode(mode) === 'system-tun';
}

/** 全局出海语义：黑名单之外都走代理（app-global 和 system-tun）。 */
export function isGlobalRuntimeMode(mode: string): boolean {
  const normalized = normalizeRuntimeMode(mode);
  return normalized === 'app-global' || normalized === 'system-tun';
}

export function renderRuntimeConfig(input: RenderRuntimeConfigInput): RenderedRuntimeConfig {
  const parsed = parse(input.baseYaml) as unknown;
  const config: MihomoConfig = isRecord(parsed) ? parsed : {};
  const proxyPolicyName = findProxyPolicyName(config);
  const useGeoRules = input.useGeoRules !== false;
  const mode = normalizeRuntimeMode(input.settings.mode);
  const dnsMode = normalizeDnsMode(input.settings.dnsMode);
  const tunStack = normalizeTunStack(input.settings.tunStack);
  const strictRoute = input.settings.strictRoute === true;
  const cnDirect = input.settings.cnDirect !== false;
  const directDomains = normalizeList(input.directDomains);
  const directIps = normalizeList(input.directIps);

  ensureProxyGroup(config, proxyPolicyName);
  applySelectedNode(config, proxyPolicyName, input.selectedNode);

  config['mixed-port'] = input.settings.ports.mixed;
  config['allow-lan'] = false;
  config.ipv6 = false;
  config.mode = 'rule';
  config['log-level'] = 'info';
  config['external-controller'] = `127.0.0.1:${input.settings.ports.controller}`;
  config.secret = input.settings.controllerSecret;
  if (useGeoRules) {
    config['geodata-mode'] = true;
    config['geo-auto-update'] = true;
    config['geo-update-interval'] = 24;
    config['geox-url'] = input.geoxUrl ?? DEFAULT_GEOX_URL;
  } else {
    delete config['geodata-mode'];
    delete config['geo-auto-update'];
    delete config['geo-update-interval'];
    delete config['geox-url'];
  }
  config.dns = {
    ...(isRecord(config.dns) ? config.dns : {}),
    ...dnsOverlay({
      dnsPort: input.settings.ports.dns,
      useGeoRules,
      listenHost: isTunRuntimeMode(mode) ? '0.0.0.0' : '127.0.0.1',
      dnsMode,
      fakeIpFilter: [...DEFAULT_FAKE_IP_FILTER, ...directDomains, ...normalizeList(input.fakeIpFilter)],
      directDomains
    })
  };
  if (!useGeoRules && isRecord(config.dns)) {
    delete config.dns.fallback;
    delete config.dns['fallback-filter'];
  }
  config.tun = tunOverlay({
    enable: isTunRuntimeMode(mode) && input.settings.tunInstalled,
    stack: tunStack,
    strictRoute,
    platform: input.platform ?? process.platform
  });
  config.rules = buildRules({
    mode,
    proxyPolicyName,
    rules: input.rules,
    meshServices: input.meshServices ?? [],
    useGeoRules,
    cnDirect,
    directDomains,
    directIps
  });

  return {
    yaml: stringify(config, { lineWidth: 0 }),
    proxyPolicyName
  };
}

/**
 * 订阅里可选的出海节点。只列真实 proxies，不含 proxy-groups —— 组是策略，
 * 节点才是用户要切换的东西。
 */
export function proxyNodes(configYaml: string): MihomoProxyNode[] {
  const parsed = parse(configYaml) as unknown;
  if (!isRecord(parsed)) return [];
  const proxies = Array.isArray(parsed.proxies) ? parsed.proxies : [];
  return proxies.filter(isRecord).flatMap((proxy) => {
    const name = typeof proxy.name === 'string' ? proxy.name.trim() : '';
    if (!name) return [];
    return [{
      name,
      type: typeof proxy.type === 'string' ? proxy.type : null,
      server: typeof proxy.server === 'string' ? proxy.server : null,
      port: typeof proxy.port === 'number' ? proxy.port : null
    }];
  });
}

/**
 * 渲染后 config 里承载 MATCH 的 select 组名。注意不要和 `proxyPolicyNames`
 * 混淆——那个返回的是组里的**成员**列表。
 */
export function proxyPolicyGroupName(configYaml: string): string | null {
  const parsed = parse(configYaml) as unknown;
  if (!isRecord(parsed)) return null;
  const groups = Array.isArray(parsed['proxy-groups']) ? parsed['proxy-groups'] : [];
  for (const group of groups) {
    if (isRecord(group) && typeof group.name === 'string' && group.name.trim()) return group.name;
  }
  return null;
}

export function proxyPolicyNames(configYaml: string): string[] {
  const parsed = parse(configYaml) as unknown;
  if (!isRecord(parsed)) {
    return [];
  }
  return stringArray((parsed['proxy-groups'] as Record<string, unknown>[] | undefined)?.[0]?.proxies);
}

interface BuildRulesInput {
  mode: string;
  proxyPolicyName: string;
  rules: MihomoDomainRule[];
  meshServices: MihomoMeshServiceRoute[];
  useGeoRules: boolean;
  cnDirect: boolean;
  directDomains: string[];
  directIps: string[];
}

function buildRules(input: BuildRulesInput): string[] {
  const { mode, proxyPolicyName, useGeoRules } = input;
  const enabled = input.rules.filter((rule) => rule.enabled);
  const blockRules = enabled.filter((rule) => rule.kind === 'block').map((rule) => domainRule(rule.domain, 'REJECT'));
  const allowRules = enabled.filter((rule) => rule.kind === 'allow').map((rule) => domainRule(rule.domain, proxyPolicyName));
  // 关掉 cn-direct 表示国内域名也走代理；控制面直连规则不受影响，
  // 否则连不上 Domestic 就没法拿订阅。
  const cnDirectRules = !input.cnDirect
    ? []
    : useGeoRules
      ? ['GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT']
      : BOOTSTRAP_CN_DIRECT_RULES;
  const meshRules = input.meshServices.flatMap((service) => {
    const target = service.routeTo || 'DIRECT';
    const domainRules = (service.domains ?? []).map((domain) => domainRule(domain, target));
    const hostRules = isIpv4(service.targetHost)
      ? [`IP-CIDR,${service.targetHost}/32,${target},no-resolve`]
      : [];
    return [...domainRules, ...hostRules];
  });
  // 控制面保护规则排在最前面：虚拟网卡接管全局流量后，launcher 自己的
  // WireGuard endpoint / Domestic bootstrap / Internal API 必须留在隧道外，
  // 否则会出现 "先断自己的网再连出海" 的死锁。
  const controlPlaneRules = [
    ...input.directIps.map((cidr) => ipDirectRule(cidr)),
    ...input.directDomains.map((domain) => domainRule(domain, 'DIRECT'))
  ].filter((rule): rule is string => Boolean(rule));

  if (isGlobalRuntimeMode(mode)) {
    return [
      ...PRIVATE_DIRECT_RULES,
      ...controlPlaneRules,
      ...meshRules,
      ...blockRules,
      ...cnDirectRules,
      `MATCH,${proxyPolicyName}`
    ];
  }

  return [
    ...PRIVATE_DIRECT_RULES,
    ...controlPlaneRules,
    ...meshRules,
    ...blockRules,
    ...allowRules,
    ...cnDirectRules,
    'MATCH,REJECT'
  ];
}

function ipDirectRule(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (text.includes(':')) {
    return `IP-CIDR6,${text.includes('/') ? text : `${text}/128`},DIRECT,no-resolve`;
  }
  const cidr = text.includes('/') ? text : `${text}/32`;
  return isIpv4(cidr.split('/')[0]) ? `IP-CIDR,${cidr},DIRECT,no-resolve` : null;
}

function normalizeList(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text) seen.add(text);
  }
  return [...seen];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * 规则始终指向一个 select 组，而不是某个具体节点。
 * 订阅自带 proxy-groups 就沿用它的第一个组；否则合成一个 `PROXY` 组把所有
 * 节点装进去 —— 这样换节点只是改组内选择，不需要重写任何一条规则，
 * 也让 external-controller 能在不重启核心的情况下即时切换。
 */
function findProxyPolicyName(config: MihomoConfig): string {
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  for (const group of groups) {
    if (isRecord(group) && typeof group.name === 'string' && group.name.trim()) {
      return group.name;
    }
  }
  return 'PROXY';
}

function ensureProxyGroup(config: MihomoConfig, proxyPolicyName: string): void {
  if (proxyPolicyName !== 'PROXY') {
    return;
  }

  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] as unknown[] : [];
  if (groups.some((group) => isRecord(group) && group.name === 'PROXY')) {
    return;
  }

  const proxyNames = proxyNodeNames(config);
  if (proxyNames.length === 0) {
    return;
  }

  config['proxy-groups'] = [
    {
      name: 'PROXY',
      type: 'select',
      proxies: proxyNames
    },
    ...groups
  ];
}

function proxyNodeNames(config: MihomoConfig): string[] {
  const proxies = Array.isArray(config.proxies) ? config.proxies : [];
  return proxies
    .filter(isRecord)
    .map((proxy) => proxy.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

interface DnsOverlayInput {
  dnsPort: number;
  useGeoRules: boolean;
  listenHost: string;
  dnsMode: MihomoDnsMode;
  fakeIpFilter: string[];
  directDomains: string[];
}

function dnsOverlay(input: DnsOverlayInput): Record<string, unknown> {
  const systemNameservers = ['223.5.5.5', '119.29.29.29', '1.1.1.1'];
  const overlay: Record<string, unknown> = {
    enable: true,
    listen: `${input.listenHost}:${input.dnsPort}`,
    ipv6: false,
    'use-hosts': true,
    'use-system-hosts': true,
    'cache-algorithm': 'arc',
    'enhanced-mode': input.dnsMode,
    'default-nameserver': systemNameservers,
    nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query']
  };
  if (input.dnsMode === 'fake-ip') {
    overlay['fake-ip-range'] = '198.18.0.1/16';
    overlay['fake-ip-filter'] = normalizeList(input.fakeIpFilter);
    overlay['fake-ip-filter-mode'] = 'blacklist';
  }
  // 控制面域名必须用明文 DNS 直接解析：DoH 本身要先能出网，
  // 在隧道还没起来时用 DoH 解析 bootstrap 域名会死锁。
  const directDomains = normalizeList(input.directDomains);
  if (directDomains.length) {
    overlay['nameserver-policy'] = Object.fromEntries(
      directDomains.map((domain) => [domain.startsWith('+.') || domain.startsWith('*') ? domain : `+.${domain}`, systemNameservers])
    );
  }
  if (input.useGeoRules) {
    overlay.fallback = ['tls://1.1.1.1', 'tls://8.8.8.8'];
    overlay['fallback-filter'] = {
      geoip: true,
      'geoip-code': 'CN',
      geosite: ['gfw']
    };
  } else {
    delete overlay.fallback;
    delete overlay['fallback-filter'];
  }
  return overlay;
}

interface TunOverlayInput {
  enable: boolean;
  stack: MihomoTunStack;
  strictRoute: boolean;
  platform: string;
}

function tunOverlay(input: TunOverlayInput): Record<string, unknown> {
  return {
    enable: input.enable,
    // system: 内核 TCP 栈，最快、内存最省。
    // mixed:  TCP 走内核栈、UDP 走 gvisor —— system 栈的 UDP 兼容性问题就靠它绕开。
    // gvisor: 全用户态栈，兼容性最好，代价是吞吐和内存。
    stack: input.stack,
    'auto-route': true,
    // auto-redirect 是 Linux 专属（nftables/iptables 重定向），其它平台没有对应实现。
    // 之前按协议栈决定是错的：它取决于平台，不取决于栈。
    'auto-redirect': input.platform === 'linux',
    'auto-detect-interface': true,
    // 同理，strict-route 是独立的防泄漏开关，各协议栈都支持，不该跟着栈走。
    'strict-route': input.strictRoute,
    'dns-hijack': ['any:53', 'tcp://any:53']
  };
}

function domainRule(domain: string, target: string): string {
  return `DOMAIN-SUFFIX,${domain},${target}`;
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      const n = Number(part);
      return /^\d+$/.test(part) && n >= 0 && n <= 255;
    })
  );
}

/**
 * mihomo 的 `select` 组在没有运行时选择记录时使用列表里的第一项，
 * 所以把选中的节点提到最前面就能在重启后保持用户的选择。
 * 运行中的即时切换仍然走 external-controller。
 */
function applySelectedNode(config: MihomoConfig, proxyPolicyName: string, selectedNode?: string | null): void {
  const selected = typeof selectedNode === 'string' ? selectedNode.trim() : '';
  if (!selected) return;
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] as unknown[] : [];
  config['proxy-groups'] = groups.map((group) => {
    if (!isRecord(group) || group.name !== proxyPolicyName) return group;
    const members = stringArray(group.proxies);
    if (!members.includes(selected)) return group;
    return { ...group, proxies: [selected, ...members.filter((name) => name !== selected)] };
  });
}
