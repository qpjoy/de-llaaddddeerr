import { Injectable } from '@nestjs/common';

const DEFAULT_ADMIN_URL = 'http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151';
const DEFAULT_TIMEOUT_MS = 2_500;
const ADMIN_TOKEN_HEADER = 'x-mx-insight-admin-token';

type FetchImplementation = typeof fetch;

interface InsightHubClientOptions {
  adminUrl?: string;
  adminToken?: string;
  timeoutMs?: number;
  fetchImplementation?: FetchImplementation;
  now?: () => number;
}

export interface InsightHubCheck {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}

interface InsightHubHttpResult extends InsightHubCheck {
  data: unknown | null;
}

export interface InsightHubOverview {
  status: 'online' | 'offline';
  checkedAt: string;
  adminUrl: string;
  ready: InsightHubCheck;
  dashboard: InsightHubCheck;
  metrics: {
    tenants: number | null;
    consumers: number | null;
    activeApiKeys: number | null;
    requests: number | null;
    units: number | null;
    averageUpstreamLatencyMs: number | null;
  };
  message: string;
}

@Injectable()
export class InsightHubClient {
  overview(): Promise<InsightHubOverview> {
    return fetchInsightHubOverview();
  }
}

export async function fetchInsightHubOverview(
  options: InsightHubClientOptions = {}
): Promise<InsightHubOverview> {
  const now = options.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();
  const rawAdminUrl = options.adminUrl ?? process.env.MX_INSIGHT_HUB_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  const adminToken = options.adminToken ?? process.env.MX_INSIGHT_HUB_ADMIN_TOKEN?.trim() ?? '';
  const timeoutMs = normalizeTimeout(options.timeoutMs ?? Number(process.env.MX_INSIGHT_HUB_ADMIN_TIMEOUT_MS));
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;

  let adminUrl: string;
  try {
    adminUrl = normalizeAdminUrl(rawAdminUrl);
  } catch (error) {
    return offlineOverview(checkedAt, '', errorMessage(error));
  }

  if (!adminToken) {
    return offlineOverview(checkedAt, adminUrl, 'MX_INSIGHT_HUB_ADMIN_TOKEN is not configured');
  }

  const [ready, dashboard] = await Promise.all([
    requestJson({
      fetchImplementation,
      url: `${adminUrl}/health/ready`,
      timeoutMs,
      now
    }),
    requestJson({
      fetchImplementation,
      url: `${adminUrl}/internal/v1/admin/dashboard`,
      timeoutMs,
      now,
      headers: { [ADMIN_TOKEN_HEADER]: adminToken }
    })
  ]);
  const online = ready.ok && dashboard.ok;

  return {
    status: online ? 'online' : 'offline',
    checkedAt,
    adminUrl,
    ready: publicCheck(ready),
    dashboard: publicCheck(dashboard),
    metrics: dashboardMetrics(dashboard.data),
    message: online
      ? 'MX Insight Hub is ready.'
      : [...new Set([ready.error, dashboard.error].filter(Boolean))].join(' / ') || 'MX Insight Hub is unavailable.'
  };
}

async function requestJson(input: {
  fetchImplementation: FetchImplementation;
  url: string;
  timeoutMs: number;
  now: () => number;
  headers?: Record<string, string>;
}): Promise<InsightHubHttpResult> {
  const startedAt = input.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImplementation(input.url, {
      headers: input.headers,
      signal: controller.signal,
      redirect: 'error'
    });
    const data = await response.json().catch(() => null);
    const ok = response.ok && data !== null;
    return {
      ok,
      statusCode: response.status,
      latencyMs: Math.max(0, input.now() - startedAt),
      data,
      error: ok ? null : response.ok ? 'Response was not valid JSON' : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Math.max(0, input.now() - startedAt),
      data: null,
      error: error instanceof Error && error.name === 'AbortError'
        ? `Timed out after ${input.timeoutMs}ms`
        : errorMessage(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAdminUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('MX_INSIGHT_HUB_ADMIN_URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('MX_INSIGHT_HUB_ADMIN_URL must not contain credentials, query, or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 250), 10_000);
}

function offlineOverview(checkedAt: string, adminUrl: string, message: string): InsightHubOverview {
  const check = (error: string): InsightHubCheck => ({
    ok: false,
    statusCode: null,
    latencyMs: 0,
    error
  });
  return {
    status: 'offline',
    checkedAt,
    adminUrl,
    ready: check(message),
    dashboard: check(message),
    metrics: emptyMetrics(),
    message
  };
}

function publicCheck(result: InsightHubHttpResult): InsightHubCheck {
  return {
    ok: result.ok,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    error: result.error
  };
}

function dashboardMetrics(payload: unknown): InsightHubOverview['metrics'] {
  const envelope = asRecord(payload);
  const data = asRecord(envelope.data ?? payload);
  return {
    tenants: numberOrNull(data.tenants),
    consumers: numberOrNull(data.consumers),
    activeApiKeys: numberOrNull(data.activeApiKeys),
    requests: numberOrNull(data.requests),
    units: numberOrNull(data.units),
    averageUpstreamLatencyMs: numberOrNull(data.averageUpstreamLatencyMs)
  };
}

function emptyMetrics(): InsightHubOverview['metrics'] {
  return {
    tenants: null,
    consumers: null,
    activeApiKeys: null,
    requests: null,
    units: null,
    averageUpstreamLatencyMs: null
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
