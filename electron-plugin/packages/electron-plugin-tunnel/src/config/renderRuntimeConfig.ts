import { stringify, parse } from 'yaml';

import { GEOX_URL } from '../defaults';
import type { DomainRule, RenderRuntimeConfigInput, RenderedRuntimeConfig } from '../types';

type MihomoConfig = Record<string, unknown>;

const PRIVATE_DIRECT_RULES = [
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function findProxyPolicyName(config: MihomoConfig): string {
  const groups = Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [];
  for (const group of groups) {
    if (isRecord(group) && typeof group.name === 'string') {
      return group.name;
    }
  }

  const proxies = Array.isArray(config.proxies) ? config.proxies : [];
  for (const proxy of proxies) {
    if (isRecord(proxy) && typeof proxy.name === 'string') {
      return proxy.name;
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

  const proxies = Array.isArray(config.proxies) ? config.proxies : [];
  const proxyNames = proxies
    .filter(isRecord)
    .map((proxy) => proxy.name)
    .filter((name): name is string => typeof name === 'string');

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

function dnsOverlay(dnsPort: number): Record<string, unknown> {
  return {
    enable: true,
    listen: `0.0.0.0:${dnsPort}`,
    ipv6: false,
    'use-hosts': true,
    'use-system-hosts': true,
    'cache-algorithm': 'arc',
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'default-nameserver': ['223.5.5.5', '119.29.29.29', '1.1.1.1'],
    nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
    fallback: ['tls://1.1.1.1', 'tls://8.8.8.8'],
    'fallback-filter': {
      geoip: true,
      'geoip-code': 'CN',
      geosite: ['gfw']
    }
  };
}

function tunOverlay(enable: boolean): Record<string, unknown> {
  return {
    enable,
    stack: 'system',
    'auto-route': true,
    'auto-redirect': true,
    'auto-detect-interface': true,
    'strict-route': true,
    'dns-hijack': ['any:53', 'tcp://any:53']
  };
}

function domainRule(rule: DomainRule, target: string): string {
  return `DOMAIN-SUFFIX,${rule.domain},${target}`;
}

function buildRules(mode: string, proxyPolicyName: string, rules: DomainRule[]): string[] {
  const enabled = rules.filter((rule) => rule.enabled);
  const blockRules = enabled.filter((rule) => rule.kind === 'block').map((rule) => domainRule(rule, 'REJECT'));
  const allowRules = enabled.filter((rule) => rule.kind === 'allow').map((rule) => domainRule(rule, proxyPolicyName));

  if (mode === 'system-tun' || mode === 'app-global') {
    return [
      ...PRIVATE_DIRECT_RULES,
      ...blockRules,
      `MATCH,${proxyPolicyName}`
    ];
  }

  const appModeTail = allowRules.length > 0 ? 'MATCH,REJECT' : `MATCH,${proxyPolicyName}`;

  return [
    ...PRIVATE_DIRECT_RULES,
    ...blockRules,
    ...allowRules,
    'GEOSITE,CN,DIRECT',
    'GEOIP,CN,DIRECT',
    appModeTail
  ];
}

export function renderRuntimeConfig(input: RenderRuntimeConfigInput): RenderedRuntimeConfig {
  const parsed = parse(input.baseYaml) as unknown;
  const config: MihomoConfig = isRecord(parsed) ? parsed : {};
  const proxyPolicyName = findProxyPolicyName(config);

  ensureProxyGroup(config, proxyPolicyName);

  config['mixed-port'] = input.settings.ports.mixed;
  config['allow-lan'] = false;
  config.ipv6 = false;
  config.mode = 'rule';
  config['log-level'] = 'info';
  config['external-controller'] = `127.0.0.1:${input.settings.ports.controller}`;
  config.secret = input.settings.controllerSecret;
  config['geodata-mode'] = true;
  config['geo-auto-update'] = true;
  config['geo-update-interval'] = 24;
  config['geox-url'] = GEOX_URL;
  config.dns = {
    ...(isRecord(config.dns) ? config.dns : {}),
    ...dnsOverlay(input.settings.ports.dns)
  };
  config.tun = tunOverlay(input.settings.mode === 'system-tun' && input.settings.tunInstalled);
  config.rules = buildRules(input.settings.mode, proxyPolicyName, input.rules);

  return {
    yaml: stringify(config, { lineWidth: 0 }),
    proxyPolicyName
  };
}

export function proxyPolicyNames(configYaml: string): string[] {
  const parsed = parse(configYaml) as unknown;
  if (!isRecord(parsed)) {
    return [];
  }
  return stringArray((parsed['proxy-groups'] as Record<string, unknown>[] | undefined)?.[0]?.proxies);
}
