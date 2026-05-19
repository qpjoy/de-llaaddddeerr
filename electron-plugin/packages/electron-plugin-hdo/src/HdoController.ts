import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  HdoDeviceRegistrationInput,
  HdoNodeInput,
  HdoPluginSettings,
  HdoRateLimitInput,
  HdoServiceInput,
  HdoSnapshot
} from './types';

interface MarketplaceDbLike {
  getActiveSession?(): {
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: string | null;
    user: Record<string, unknown> | null;
  } | null;
}

export interface HdoControllerContext {
  userDataDir: string;
  marketServerBaseUrl?: string | null;
  marketplaceDb?: MarketplaceDbLike;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

export class HdoController {
  private readonly settingsPath: string;
  private settings: HdoPluginSettings;
  private lastError: string | null = null;

  constructor(private readonly ctx: HdoControllerContext) {
    mkdirSync(ctx.userDataDir, { recursive: true });
    this.settingsPath = join(ctx.userDataDir, 'hdo-settings.json');
    this.settings = this.loadSettings();
  }

  getSettings(): HdoPluginSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<HdoPluginSettings>): HdoPluginSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      hdoControlBaseUrl:
        patch.hdoControlBaseUrl === undefined
          ? this.settings.hdoControlBaseUrl
          : normalizeBaseUrl(patch.hdoControlBaseUrl),
      updatedAt: new Date().toISOString()
    };
    this.saveSettings();
    return this.getSettings();
  }

  async snapshot(): Promise<HdoSnapshot> {
    const session = this.sessionSnapshot();
    let readiness: unknown | null = null;
    let devices: unknown[] = [];
    let admin: HdoSnapshot['admin'] = null;
    this.lastError = null;

    if (this.serverBaseUrl() && session.hasAccessToken) {
      try {
        const [readinessResult, devicesResult] = await Promise.all([
          this.apiGet('/api/v1/hdo/readiness'),
          this.apiGet('/api/v1/hdo/devices')
        ]);
        readiness = readinessResult;
        devices = Array.isArray(devicesResult) ? devicesResult : [];
      } catch (err) {
        this.lastError = errorMessage(err);
      }

      try {
        const [nodes, services, profiles, rateLimits] = await Promise.all([
          this.apiGet('/api/v1/hdo/admin/nodes'),
          this.apiGet('/api/v1/hdo/admin/services'),
          this.apiGet('/api/v1/hdo/admin/profiles'),
          this.apiGet('/api/v1/hdo/admin/rate-limits')
        ]);
        admin = {
          nodes: Array.isArray(nodes) ? nodes : [],
          services: Array.isArray(services) ? services : [],
          profiles: Array.isArray(profiles) ? profiles : [],
          rateLimits: Array.isArray(rateLimits) ? rateLimits : []
        };
      } catch {
        admin = null;
      }
    }

    return {
      serverBaseUrl: this.serverBaseUrl(),
      marketServerBaseUrl: this.ctx.marketServerBaseUrl ?? null,
      settings: this.getSettings(),
      session,
      readiness,
      devices,
      admin,
      lastError: this.lastError
    };
  }

  async registerDevice(input: HdoDeviceRegistrationInput): Promise<unknown> {
    const body = {
      id: input.id || this.settings.deviceId || `hdo-dev-${randomUUID()}`,
      label: input.label || this.settings.deviceLabel || defaultDeviceLabel(),
      platform: input.platform || this.settings.devicePlatform || process.platform,
      publicKey: input.publicKey || null,
      overlayIp: input.overlayIp || null,
      metadata: input.metadata ?? {
        source: '@qpjoy/electron-plugin-hdo',
        arch: process.arch
      }
    };
    const device = await this.apiPost('/api/v1/hdo/devices/register', body);
    const deviceId = stringField(device, 'id') ?? body.id;
    this.updateSettings({
      deviceId,
      deviceLabel: body.label,
      devicePlatform: body.platform
    });
    return device;
  }

  async refreshManifest(deviceId?: string | null): Promise<Record<string, unknown>> {
    const id = deviceId || this.settings.deviceId;
    if (!id) throw new Error('deviceId required');
    const manifest = await this.apiGet(`/api/v1/hdo/manifest/${encodeURIComponent(id)}`);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest response is not an object');
    }
    this.updateSettings({ lastManifest: manifest as Record<string, unknown> });
    return manifest as Record<string, unknown>;
  }

  async refreshSubscription(deviceId?: string | null): Promise<string> {
    const id = deviceId || this.settings.deviceId;
    if (!id) throw new Error('deviceId required');
    const content = await this.apiText(
      `/api/v1/hdo/subscriptions/${encodeURIComponent(id)}/mihomo.yaml`
    );
    this.updateSettings({ lastSubscription: content });
    return content;
  }

  async upsertNode(input: HdoNodeInput): Promise<unknown> {
    return this.apiPost('/api/v1/hdo/admin/nodes', input);
  }

  async heartbeatNode(id: string): Promise<unknown> {
    return this.apiPost(`/api/v1/hdo/admin/nodes/${encodeURIComponent(id)}/heartbeat`, {
      status: 'online'
    });
  }

  async upsertService(input: HdoServiceInput): Promise<unknown> {
    return this.apiPost('/api/v1/hdo/admin/services', input);
  }

  async upsertRateLimit(input: HdoRateLimitInput): Promise<unknown> {
    return this.apiPost('/api/v1/hdo/admin/rate-limits', input);
  }

  installCommands(): { domestic: string; home: string; oversea: string } {
    const base = this.serverBaseUrl() ?? 'https://your-domestic-server';
    return {
      domestic: [
        `./scripts/manage.sh hdo setup-domestic --server-url ${shellQuote(base)} --public-host <domestic-domain-or-ip>`,
        'sudo ./scripts/manage.sh hdo apply-domestic'
      ].join('\n'),
      home: `./scripts/manage.sh hdo add-home --name home-main --server-url ${shellQuote(base)}`,
      oversea: `./scripts/manage.sh hdo setup-oversea-egress --server-url ${shellQuote(base)}`
    };
  }

  private serverBaseUrl(): string | null {
    return this.settings.hdoControlBaseUrl || this.ctx.marketServerBaseUrl || null;
  }

  private sessionSnapshot() {
    const session = this.ctx.marketplaceDb?.getActiveSession?.() ?? null;
    return {
      loggedIn: Boolean(session?.user && session.accessToken),
      user: session?.user ?? null,
      hasAccessToken: Boolean(session?.accessToken)
    };
  }

  private accessToken(): string {
    const token = this.ctx.marketplaceDb?.getActiveSession?.()?.accessToken;
    if (!token) throw new Error('请先在插件市场登录 / 注册');
    return token;
  }

  private async apiGet(path: string): Promise<unknown> {
    return this.apiJson(path, { method: 'GET' });
  }

  private async apiPost(path: string, body: unknown): Promise<unknown> {
    return this.apiJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
  }

  private async apiJson(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(errorFromResponse(parsed) || `${res.status} ${res.statusText}`);
    }
    return parsed;
  }

  private async apiText(path: string): Promise<string> {
    const res = await this.fetch(path, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `${res.status} ${res.statusText}`);
    return text;
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const base = this.serverBaseUrl();
    if (!base) {
      throw new Error('未配置 HDO 控制面 URL');
    }
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.accessToken()}`);
    return fetch(new URL(path, base).toString(), {
      ...init,
      headers
    });
  }

  private loadSettings(): HdoPluginSettings {
    if (!existsSync(this.settingsPath)) {
      return {
        hdoControlBaseUrl: normalizeBaseUrl(process.env.QPJOY_HDO_SERVER) ?? null,
        deviceId: null,
        deviceLabel: defaultDeviceLabel(),
        devicePlatform: process.platform,
        lastManifest: null,
        lastSubscription: null,
        updatedAt: null
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as HdoPluginSettings;
      return {
        ...parsed,
        hdoControlBaseUrl: normalizeBaseUrl(parsed.hdoControlBaseUrl) ?? null
      };
    } catch (err) {
      this.ctx.log.warn('failed to read HDO settings, using defaults', {
        error: errorMessage(err)
      });
      return {
        hdoControlBaseUrl: null,
        deviceId: null,
        deviceLabel: defaultDeviceLabel(),
        devicePlatform: process.platform,
        lastManifest: null,
        lastSubscription: null,
        updatedAt: null
      };
    }
  }

  private saveSettings(): void {
    writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2) + '\n', {
      mode: 0o600
    });
  }
}

function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '0' || trimmed === 'false') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function defaultDeviceLabel(): string {
  return `HDO ${process.platform}-${process.arch}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorFromResponse(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
    return String((value as { error: unknown }).error);
  }
  return null;
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw ? raw : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
