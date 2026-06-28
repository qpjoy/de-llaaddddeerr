import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type ElectronLauncherNetworkPhase = 'bootstrap' | 'connected' | 'disconnected' | 'unknown';
export type ElectronLauncherIpClassification =
  | 'expected-internal-target'
  | 'internal-overlay'
  | 'v1-hdo-overlay'
  | 'proxy-fake-ip'
  | 'loopback'
  | 'private'
  | 'public'
  | 'invalid';

export type ElectronLauncherHostResolutionState =
  | 'expected-internal'
  | 'internal-overlay'
  | 'v1-hdo-overlay'
  | 'proxy-fake-ip'
  | 'public'
  | 'private'
  | 'loopback'
  | 'unresolved'
  | 'invalid-host';

export type ElectronLauncherHostResolutionSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface ElectronLauncherAddressDiagnostic {
  address: string;
  classification: ElectronLauncherIpClassification;
}

export interface ElectronLauncherHostResolutionDiagnostics {
  host: string | null;
  phase: ElectronLauncherNetworkPhase;
  addresses: ElectronLauncherAddressDiagnostic[];
  state: ElectronLauncherHostResolutionState;
  severity: ElectronLauncherHostResolutionSeverity;
  ok: boolean;
  message: string;
  expectedInternalTargets: string[];
  internalCidrs: string[];
  v1HdoCidrs: string[];
  proxyFakeIpCidrs: string[];
  error?: string | null;
  updatedAt: string;
}

export interface ElectronLauncherHostResolutionDiagnosticInput {
  host?: string | null;
  phase?: ElectronLauncherNetworkPhase | null;
  expectedInternalTargets?: Array<string | null | undefined> | null;
  internalCidrs?: Array<string | null | undefined> | null;
  v1HdoCidrs?: Array<string | null | undefined> | null;
  proxyFakeIpCidrs?: Array<string | null | undefined> | null;
  lookup?: ((host: string) => Promise<Array<string | { address?: string | null; family?: number | null }>>) | null;
}

const DEFAULT_INTERNAL_CIDRS = ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16'];
const DEFAULT_V1_HDO_CIDRS = ['100.88.0.0/16', '100.89.0.0/16', '100.90.0.0/16', '100.91.0.0/16'];
const DEFAULT_PROXY_FAKE_IP_CIDRS = ['198.18.0.0/15'];
const PRIVATE_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16'
];
const LOOPBACK_CIDRS = ['127.0.0.0/8'];

export async function diagnoseLauncherHostResolution(
  input: ElectronLauncherHostResolutionDiagnosticInput
): Promise<ElectronLauncherHostResolutionDiagnostics> {
  const host = normalizeHost(input.host);
  const phase = normalizePhase(input.phase);
  const expectedInternalTargets = normalizeIpv4List(input.expectedInternalTargets);
  const internalCidrs = normalizeCidrList(input.internalCidrs, DEFAULT_INTERNAL_CIDRS);
  const v1HdoCidrs = normalizeCidrList(input.v1HdoCidrs, DEFAULT_V1_HDO_CIDRS);
  const proxyFakeIpCidrs = normalizeCidrList(input.proxyFakeIpCidrs, DEFAULT_PROXY_FAKE_IP_CIDRS);

  if (!host) {
    return resolutionResult({
      host: null,
      phase,
      addresses: [],
      state: 'invalid-host',
      expectedInternalTargets,
      internalCidrs,
      v1HdoCidrs,
      proxyFakeIpCidrs,
      error: 'host is empty'
    });
  }

  try {
    const records = isIP(host) === 4
      ? [host]
      : await resolveHostAddresses(host, input.lookup);
    const addresses = uniqueStrings(records)
      .filter((address) => isIP(address) === 4)
      .map((address) => ({
        address,
        classification: classifyLauncherIpv4Address(address, {
          expectedInternalTargets,
          internalCidrs,
          v1HdoCidrs,
          proxyFakeIpCidrs
        })
      }));
    return resolutionResult({
      host,
      phase,
      addresses,
      state: resolutionState(addresses),
      expectedInternalTargets,
      internalCidrs,
      v1HdoCidrs,
      proxyFakeIpCidrs
    });
  } catch (err) {
    return resolutionResult({
      host,
      phase,
      addresses: [],
      state: 'unresolved',
      expectedInternalTargets,
      internalCidrs,
      v1HdoCidrs,
      proxyFakeIpCidrs,
      error: errorMessage(err)
    });
  }
}

export function classifyLauncherIpv4Address(
  address: string,
  options: {
    expectedInternalTargets?: Array<string | null | undefined> | null;
    internalCidrs?: Array<string | null | undefined> | null;
    v1HdoCidrs?: Array<string | null | undefined> | null;
    proxyFakeIpCidrs?: Array<string | null | undefined> | null;
  } = {}
): ElectronLauncherIpClassification {
  if (isIP(address) !== 4) return 'invalid';
  const expectedInternalTargets = normalizeIpv4List(options.expectedInternalTargets);
  const internalCidrs = normalizeCidrList(options.internalCidrs, DEFAULT_INTERNAL_CIDRS);
  const v1HdoCidrs = normalizeCidrList(options.v1HdoCidrs, DEFAULT_V1_HDO_CIDRS);
  const proxyFakeIpCidrs = normalizeCidrList(options.proxyFakeIpCidrs, DEFAULT_PROXY_FAKE_IP_CIDRS);
  if (expectedInternalTargets.includes(address)) return 'expected-internal-target';
  if (cidrsContainIp(proxyFakeIpCidrs, address)) return 'proxy-fake-ip';
  if (cidrsContainIp(LOOPBACK_CIDRS, address)) return 'loopback';
  if (cidrsContainIp(v1HdoCidrs, address)) return 'v1-hdo-overlay';
  if (cidrsContainIp(internalCidrs, address)) return 'internal-overlay';
  if (cidrsContainIp(PRIVATE_CIDRS, address)) return 'private';
  return 'public';
}

function resolutionResult(input: {
  host: string | null;
  phase: ElectronLauncherNetworkPhase;
  addresses: ElectronLauncherAddressDiagnostic[];
  state: ElectronLauncherHostResolutionState;
  expectedInternalTargets: string[];
  internalCidrs: string[];
  v1HdoCidrs: string[];
  proxyFakeIpCidrs: string[];
  error?: string | null;
}): ElectronLauncherHostResolutionDiagnostics {
  const { severity, ok, message } = evaluateResolution(input);
  return {
    host: input.host,
    phase: input.phase,
    addresses: input.addresses,
    state: input.state,
    severity,
    ok,
    message,
    expectedInternalTargets: input.expectedInternalTargets,
    internalCidrs: input.internalCidrs,
    v1HdoCidrs: input.v1HdoCidrs,
    proxyFakeIpCidrs: input.proxyFakeIpCidrs,
    error: input.error ?? null,
    updatedAt: new Date().toISOString()
  };
}

function evaluateResolution(input: {
  host: string | null;
  phase: ElectronLauncherNetworkPhase;
  addresses: ElectronLauncherAddressDiagnostic[];
  state: ElectronLauncherHostResolutionState;
  error?: string | null;
}): { severity: ElectronLauncherHostResolutionSeverity; ok: boolean; message: string } {
  const host = input.host || 'host';
  if (input.state === 'invalid-host') {
    return { severity: 'warning', ok: false, message: '未配置可诊断的 bootstrap 域名。' };
  }
  if (input.state === 'unresolved') {
    const suffix = input.error ? `：${input.error}` : '。';
    if (input.phase === 'connected') {
      return { severity: 'error', ok: false, message: `${host} 在 V2 connected 状态下未解析${suffix}` };
    }
    return { severity: 'warning', ok: false, message: `${host} 当前未解析${suffix}` };
  }
  if (input.phase === 'connected') {
    if (input.state === 'expected-internal' || input.state === 'internal-overlay') {
      return { severity: 'ok', ok: true, message: `${host} 已由 V2 split DNS 指向 Internal。` };
    }
    if (input.state === 'proxy-fake-ip') {
      return { severity: 'error', ok: false, message: `${host} 仍命中 Clash/mihomo fake-ip；V2 split DNS 尚未接管该域名。` };
    }
    if (input.state === 'public') {
      return { severity: 'error', ok: false, message: `${host} 仍走外部 DNS；V2 split DNS 尚未接管该域名。` };
    }
    if (input.state === 'v1-hdo-overlay') {
      return { severity: 'warning', ok: false, message: `${host} 当前落在 V1 HDO 网段；V2 connected 状态应切到 10.* Internal。` };
    }
    return { severity: 'warning', ok: false, message: `${host} 当前解析到 ${input.state}，不是 V2 Internal 目标。` };
  }
  if (input.phase === 'bootstrap') {
    if (input.state === 'proxy-fake-ip') {
      return { severity: 'info', ok: true, message: `${host} bootstrap 当前由系统代理/TUN fake-ip 接管，这只能作为外部可达路径，不是 V2 ready 证明。` };
    }
    if (input.state === 'public') {
      return { severity: 'ok', ok: true, message: `${host} bootstrap 当前走外部 DNS，可用于连接前发现 Domestic/Internal 入口。` };
    }
    if (input.state === 'expected-internal' || input.state === 'internal-overlay') {
      return { severity: 'info', ok: true, message: `${host} bootstrap 当前解析到 Internal；这通常依赖 V1 DNS 或保留 overlay。` };
    }
    return { severity: 'info', ok: true, message: `${host} bootstrap 当前解析到 ${input.state}。` };
  }
  if (input.phase === 'disconnected') {
    if (input.state === 'public' || input.state === 'proxy-fake-ip') {
      return { severity: 'ok', ok: true, message: `${host} disconnected 状态已回到系统/外部解析路径。` };
    }
    return { severity: 'warning', ok: true, message: `${host} disconnected 状态仍解析到 ${input.state}；如果未开启 V1/V2/代理，可能存在残留 resolver 或 DNS cache。` };
  }
  return { severity: 'info', ok: true, message: `${host} 当前解析状态为 ${input.state}。` };
}

async function resolveHostAddresses(
  host: string,
  customLookup?: ElectronLauncherHostResolutionDiagnosticInput['lookup']
): Promise<string[]> {
  const records = customLookup
    ? await customLookup(host)
    : await dnsLookup(host, { all: true, family: 4 });
  return records
    .map((record) => typeof record === 'string' ? record : record.address || '')
    .map((address) => address.trim())
    .filter(Boolean);
}

function resolutionState(addresses: ElectronLauncherAddressDiagnostic[]): ElectronLauncherHostResolutionState {
  if (addresses.length === 0) return 'unresolved';
  const classes = addresses.map((row) => row.classification);
  if (classes.includes('expected-internal-target')) return 'expected-internal';
  if (classes.includes('internal-overlay')) return 'internal-overlay';
  if (classes.includes('v1-hdo-overlay')) return 'v1-hdo-overlay';
  if (classes.includes('proxy-fake-ip')) return 'proxy-fake-ip';
  if (classes.includes('public')) return 'public';
  if (classes.includes('private')) return 'private';
  if (classes.includes('loopback')) return 'loopback';
  return 'unresolved';
}

function normalizePhase(value: unknown): ElectronLauncherNetworkPhase {
  if (value === 'bootstrap' || value === 'connected' || value === 'disconnected') return value;
  return 'unknown';
}

function normalizeHost(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }
  return text.replace(/:\d{1,5}$/, '').toLowerCase();
}

function normalizeIpv4List(values: Array<string | null | undefined> | null | undefined): string[] {
  return uniqueStrings((values ?? [])
    .map((value) => String(value || '').trim())
    .filter((value) => isIP(value) === 4));
}

function normalizeCidrList(
  values: Array<string | null | undefined> | null | undefined,
  fallback: string[]
): string[] {
  const normalized = (values?.length ? values : fallback)
    .map((value) => String(value || '').trim())
    .filter((value) => parseCidr(value) !== null);
  return uniqueStrings(normalized);
}

function cidrsContainIp(cidrs: string[], ip: string): boolean {
  return cidrs.some((cidr) => cidrContainsIp(cidr, ip));
}

function cidrContainsIp(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  const target = ipv4ToInt(ip);
  if (!parsed || target === null) return false;
  const mask = parsed.prefix === 0 ? 0 : (0xffffffff << (32 - parsed.prefix)) >>> 0;
  return (target & mask) === (parsed.base & mask);
}

function parseCidr(value: string): { base: number; prefix: number } | null {
  const [ip, prefixText] = value.split('/');
  const base = ipv4ToInt(ip);
  const prefix = Number(prefixText);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { base, prefix };
}

function ipv4ToInt(value: string | null | undefined): number | null {
  const text = value?.trim();
  if (!text || isIP(text) !== 4) return null;
  const parts = text.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index, rows) => value && rows.indexOf(value) === index);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}
