export type ElectronLauncherOverseaEnsureStatus = 'ready' | 'pending-runtime-sync' | 'blocked';

export interface EnsureElectronLauncherUserOverseaSubscriptionInput {
  baseUrl: string;
  userId: string;
  accessToken: string;
  tokenType?: string;
  siteIds?: string[];
  requestedBy?: string;
  requestId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ElectronLauncherUserOverseaSubscription {
  path: string;
  contentType: string | null;
  generatedAt: string | null;
  yamlBytes: number;
  yaml: string;
}

export interface ElectronLauncherUserOverseaEnsureResult {
  ready: boolean;
  status: ElectronLauncherOverseaEnsureStatus;
  reason: string;
  generatedAt: string | null;
  entitlementId: string | null;
  entitlementStatus: string | null;
  siteIds: string[];
  syncStatus: string | null;
  subscription: ElectronLauncherUserOverseaSubscription | null;
}

/**
 * Exchanges a logged-in Launcher user session for an Internal-issued Oversea
 * subscription. The bearer token is used only for the request and is never
 * copied into the returned subscription URL or YAML metadata.
 */
export async function ensureElectronLauncherUserOverseaSubscription(
  input: EnsureElectronLauncherUserOverseaSubscriptionInput
): Promise<ElectronLauncherUserOverseaEnsureResult> {
  const baseUrl = requiredBaseUrl(input.baseUrl);
  const userId = requiredText(input.userId, 'userId');
  const accessToken = requiredText(input.accessToken, 'accessToken');
  const tokenType = input.tokenType?.trim() || 'Bearer';
  const requestId = input.requestId?.trim() || `launcher-oversea-${Date.now()}`;
  const siteIds = uniqueStrings(input.siteIds ?? []);
  const pathName = `/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/ensure-subscription`;
  const headers = {
    Accept: 'application/json',
    Authorization: `${tokenType} ${accessToken}`,
    'Content-Type': 'application/json'
  };
  const payload = await requestJson(joinUrl(baseUrl, pathName), {
    method: 'POST',
    signal: input.signal,
    headers,
    body: JSON.stringify({
      ...(siteIds.length > 0 ? { siteIds } : {}),
      syncRuntime: true,
      confirmRemoteExecution: true,
      includeYaml: true,
      requestedBy: input.requestedBy?.trim() || 'electron-launcher-oversea',
      requestId
    })
  }, input.timeoutMs ?? 195_000);

  const ensure = recordValue(payload.ensure);
  const entitlement = recordValue(payload.entitlement);
  const sync = recordValue(payload.sync);
  const responseUserId = textValue(entitlement.userId);
  if (responseUserId !== userId) {
    throw new Error(`Oversea entitlement user mismatch: expected ${userId}, received ${responseUserId || 'missing'}`);
  }

  const status = overseaEnsureStatus(ensure.status);
  const ready = ensure.ready === true && status === 'ready';
  const subscriptionRecord = recordValue(payload.subscription);
  const subscriptionPath = textValue(subscriptionRecord.path);
  let yaml = nonEmptyText(subscriptionRecord.yaml);
  if (ready && subscriptionPath && !yaml) {
    yaml = await requestText(joinUrl(baseUrl, subscriptionPath), {
      signal: input.signal,
      headers: {
        Accept: 'text/yaml, text/plain, */*',
        Authorization: `${tokenType} ${accessToken}`
      }
    }, input.timeoutMs ?? 195_000);
  }

  const subscription = subscriptionPath && yaml
    ? {
        path: subscriptionPath,
        contentType: textValue(subscriptionRecord.contentType),
        generatedAt: textValue(subscriptionRecord.generatedAt),
        yamlBytes: positiveNumber(subscriptionRecord.yamlBytes) ?? Buffer.byteLength(yaml, 'utf8'),
        yaml
      }
    : null;

  return {
    ready,
    status,
    reason: textValue(ensure.reason) || 'Internal did not return an Oversea ensure reason.',
    generatedAt: textValue(ensure.generatedAt),
    entitlementId: textValue(entitlement.entitlementId),
    entitlementStatus: textValue(entitlement.status),
    siteIds: uniqueStrings(arrayValue(entitlement.siteIds)),
    syncStatus: textValue(sync.status),
    subscription
  };
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
  const { response, text } = await requestAndReadText(url, init, timeoutMs);
  const payload = text ? safeJson(text) : null;
  if (!response.ok) {
    const record = recordValue(payload);
    throw new Error(`Oversea ensure failed: HTTP ${response.status} ${textValue(record.message) || text || response.statusText}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Oversea ensure returned an invalid JSON payload.');
  }
  return payload as Record<string, unknown>;
}

async function requestText(url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  const { response, text } = await requestAndReadText(url, init, timeoutMs);
  if (!response.ok) {
    throw new Error(`Oversea subscription fetch failed: HTTP ${response.status} ${text || response.statusText}`);
  }
  if (!text.trim()) throw new Error('Oversea subscription fetch returned an empty body.');
  return text;
}

async function requestAndReadText(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

function requiredBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) throw new Error('Oversea Internal baseUrl must use http or https.');
  return normalized;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Oversea ${label} is required.`);
  return normalized;
}

function joinUrl(baseUrl: string, pathName: string): string {
  const base = new URL(`${baseUrl.replace(/\/+$/, '')}/`);
  const target = new URL(pathName, base);
  if (target.origin !== base.origin) {
    throw new Error('Oversea subscription path must stay on the authenticated Internal origin.');
  }
  return target.toString();
}

function overseaEnsureStatus(value: unknown): ElectronLauncherOverseaEnsureStatus {
  if (value === 'ready' || value === 'pending-runtime-sync') return value;
  return 'blocked';
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
