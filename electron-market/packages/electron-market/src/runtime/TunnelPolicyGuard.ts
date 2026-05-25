import { isIP } from 'node:net';
import type { Session } from 'electron';

import type { PluginRuntime } from './PluginRuntime';

const TUNNEL_PLUGIN_ID = 'qpjoy.electron-tunnel';
const HTTP_URLS = ['http://*/*', 'https://*/*'];
const CACHE_TTL_MS = 500;

type RuntimeMode = 'system-tun' | 'app-global' | 'app-rule';

interface DomainRule {
  kind: 'allow' | 'block';
  domain: string;
  enabled: boolean;
}

interface PolicySnapshot {
  status: { mode: RuntimeMode };
  rules: DomainRule[];
}

export interface TunnelPolicyGuardOptions {
  alwaysAllowHosts?: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  mode: RuntimeMode | 'none';
  reason: 'no-tunnel' | 'local' | 'allowed' | 'blocked' | 'not-allowlisted' | 'error';
  matchedDomain?: string;
}

type RequestCallback = (response: { cancel?: boolean; redirectURL?: string }) => void;

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
}

function hostnameFromUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  } catch {
    return null;
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || a === 0;
}

function isLocalHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'local' || hostname.endsWith('.local')) return true;
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true;
  if (isIP(hostname) === 4) return isPrivateIpv4(hostname);
  if (isIP(hostname) === 6) {
    return hostname === '::1'
      || hostname.startsWith('fe80:')
      || hostname.startsWith('fc')
      || hostname.startsWith('fd');
  }
  return false;
}

function renderBlockedPage(url: string, decision: PolicyDecision): string {
  const esc = (value: string) => value.replace(/[&<>"]/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] as string));
  const title = decision.reason === 'blocked'
    ? '访问已被 Tunnel 黑名单拦截'
    : '访问不在 Tunnel 白名单中';
  const hint = decision.reason === 'blocked'
    ? `命中黑名单：${decision.matchedDomain ?? '未知规则'}。请在 Tunnel 规则页调整后重试。`
    : '当前是 App 白名单模式。插件页面只能访问白名单域名；请在 Tunnel 规则页添加该域名，或切换到全局模式。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f172a; color: #e5eefb;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 40px; box-sizing: border-box; }
  .panel { max-width: 560px; border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 8px;
    background: rgba(15, 23, 42, 0.9); padding: 30px 32px; box-shadow: 0 18px 50px rgba(0,0,0,.28); }
  h1 { margin: 0 0 14px; font-size: 22px; color: #f8fafc; }
  p { margin: 0; line-height: 1.75; color: #cbd5e1; }
  code { display: block; margin-top: 18px; padding: 12px 14px; color: #93c5fd;
    background: rgba(30, 41, 59, 0.82); border-radius: 6px; overflow-wrap: anywhere; font-size: 13px; }
</style></head><body><div class="wrap"><div class="panel">
  <h1>${esc(title)}</h1>
  <p>${esc(hint)}</p>
  <code>${esc(url)}</code>
</div></div></body></html>`;
}

export class TunnelPolicyGuard {
  private snapshotCache: { value: PolicySnapshot | null; expiresAt: number } | null = null;
  private refreshInFlight: Promise<PolicySnapshot | null> | null = null;
  private started = false;

  constructor(
    private readonly session: Session,
    private readonly runtime: Pick<PluginRuntime, 'getExposed'>,
    private readonly options: TunnelPolicyGuardOptions = {}
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.session.webRequest.onBeforeRequest({ urls: HTTP_URLS }, (details, callback: RequestCallback) => {
      void this.evaluate(details.url)
        .then((decision) => {
          if (decision.allowed) {
            callback({});
            return;
          }
          const resourceType = (details as { resourceType?: string }).resourceType;
          if (resourceType === 'mainFrame') {
            callback({
              redirectURL: 'data:text/html;charset=utf-8,' + encodeURIComponent(renderBlockedPage(details.url, decision))
            });
            return;
          }
          callback({ cancel: true });
        })
        .catch(() => callback({}));
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.session.webRequest.onBeforeRequest({ urls: HTTP_URLS }, null as never);
  }

  async evaluate(rawUrl: string): Promise<PolicyDecision> {
    const hostname = hostnameFromUrl(rawUrl);
    if (!hostname || isLocalHostname(hostname)) {
      return { allowed: true, mode: 'none', reason: 'local' };
    }
    if (this.alwaysAllowed(hostname)) {
      return { allowed: true, mode: 'none', reason: 'allowed' };
    }

    const snapshot = await this.getSnapshot();
    if (!snapshot) {
      return { allowed: true, mode: 'none', reason: 'no-tunnel' };
    }

    const enabled = snapshot.rules.filter((rule) => rule.enabled);
    const block = enabled.find((rule) => rule.kind === 'block' && domainMatches(hostname, rule.domain));
    if (block) {
      return {
        allowed: false,
        mode: snapshot.status.mode,
        reason: 'blocked',
        matchedDomain: normalizeDomain(block.domain)
      };
    }

    if (snapshot.status.mode !== 'app-rule') {
      return { allowed: true, mode: snapshot.status.mode, reason: 'allowed' };
    }

    const allowRules = enabled.filter((rule) => rule.kind === 'allow');
    const allow = allowRules.find((rule) => domainMatches(hostname, rule.domain));
    if (allow) {
      return {
        allowed: true,
        mode: snapshot.status.mode,
        reason: 'allowed',
        matchedDomain: normalizeDomain(allow.domain)
      };
    }

    return { allowed: false, mode: snapshot.status.mode, reason: 'not-allowlisted' };
  }

  private async getSnapshot(): Promise<PolicySnapshot | null> {
    const now = Date.now();
    if (this.snapshotCache && this.snapshotCache.expiresAt > now) return this.snapshotCache.value;
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.fetchSnapshot()
      .then((value) => {
        this.snapshotCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });

    return this.refreshInFlight;
  }

  private async fetchSnapshot(): Promise<PolicySnapshot | null> {
    const exposed = this.runtime.getExposed(TUNNEL_PLUGIN_ID);
    if (!exposed) return null;

    const policySnapshot = exposed.policySnapshot;
    if (typeof policySnapshot === 'function') {
      const value = await policySnapshot();
      if (isPolicySnapshot(value)) return value;
    }

    const snapshot = exposed.snapshot;
    if (typeof snapshot === 'function') {
      const value = await snapshot();
      if (isPolicySnapshot(value)) return value;
    }

    return null;
  }

  private alwaysAllowed(hostname: string): boolean {
    return (this.options.alwaysAllowHosts ?? []).some((domain) => domainMatches(hostname, domain));
  }
}

function isPolicySnapshot(value: unknown): value is PolicySnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as { status?: unknown; rules?: unknown };
  const status = record.status as { mode?: unknown } | undefined;
  return Boolean(
    status
    && (status.mode === 'system-tun' || status.mode === 'app-global' || status.mode === 'app-rule')
    && Array.isArray(record.rules)
  );
}
