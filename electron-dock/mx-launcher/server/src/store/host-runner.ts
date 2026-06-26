import type { RuntimeConfig } from '../types.js';

export interface HostRunnerGatewayNginxApplyPayload {
  configPath: string;
  nginxConfig: string;
  routesMetadata: string;
  serverDryRun: boolean;
  requestId?: string | null;
}

export interface HostRunnerApplyOutcome {
  status: 'server-dry-run' | 'applied' | 'failed';
  applied: boolean;
  resourceVersion: string | null;
  message: string;
}

export async function applyGatewayNginxConfigToHostRunner(
  config: RuntimeConfig,
  payload: HostRunnerGatewayNginxApplyPayload
): Promise<HostRunnerApplyOutcome> {
  const baseUrls = hostRunnerUrlCandidates();
  if (baseUrls.length === 0) {
    return {
      status: 'failed',
      applied: false,
      resourceVersion: null,
      message: 'MX_INTERNAL_HOST_RUNNER_URL is not configured'
    };
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.MX_INTERNAL_HOST_RUNNER_TOKEN?.trim();
  if (token) headers['x-mx-host-runner-token'] = token;

  const body = JSON.stringify({
    configPath: payload.configPath || config.gatewayHostNginxConfigPath,
    nginxConfig: payload.nginxConfig,
    routesMetadata: payload.routesMetadata,
    serverDryRun: payload.serverDryRun,
    requestId: payload.requestId ?? null
  });
  const errors: string[] = [];
  for (const baseUrl of baseUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(`${baseUrl}/gateway/nginx/apply`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
      const text = await response.text();
      let parsed: unknown = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${baseUrl}/gateway/nginx/apply: ${text.slice(0, 500)}`);
      }
      return normalizeHostRunnerNginxApply(parsed);
    } catch (error) {
      errors.push(`${baseUrl}/gateway/nginx/apply ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status: 'failed',
    applied: false,
    resourceVersion: null,
    message: errors.join('; ')
  };
}

function normalizeHostRunnerNginxApply(payload: unknown): HostRunnerApplyOutcome {
  const row = asRecord(payload);
  const apply = asRecord(row.gatewayNginxApply ?? row.applyResult ?? row);
  const rawStatus = String(apply.status ?? '').trim();
  const status: HostRunnerApplyOutcome['status'] = rawStatus === 'applied'
    ? 'applied'
    : rawStatus === 'server-dry-run'
      ? 'server-dry-run'
      : 'failed';
  return {
    status,
    applied: status === 'applied',
    resourceVersion: null,
    message: stringValue(apply.message)
      || stringValue(apply.stderr)
      || stringValue(apply.stdout)
      || (status === 'failed' ? 'host-runner nginx apply failed' : 'host-runner nginx apply completed')
  };
}

function hostRunnerUrlCandidates(): string[] {
  return uniqueStrings([
    nativeHostRunnerUrl(),
    explicitHostRunnerUrl(),
    gatewayHostNginxK8sRunnerEnabled() ? k8sHostRunnerUrl() : null
  ].filter((item): item is string => Boolean(item)));
}

function explicitHostRunnerUrl(): string | null {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_URL ?? process.env.MX_INTERNAL_SERVICE_PEER_HOST_RUNNER_URL;
  return raw?.trim() ? raw.trim().replace(/\/+$/, '') : null;
}

function nativeHostRunnerUrl(): string | null {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_NATIVE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  if (!process.env.KUBERNETES_SERVICE_HOST) return null;
  const port = hostRunnerPort();
  return `http://host.docker.internal:${port}`;
}

function gatewayHostNginxK8sRunnerEnabled(): boolean {
  const raw = process.env.GATEWAY_HOST_NGINX_K8S_RUNNER_ENABLED;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function k8sHostRunnerUrl(): string | null {
  if (!process.env.KUBERNETES_SERVICE_HOST) return null;
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_K8S_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  const name = process.env.MX_INTERNAL_HOST_RUNNER_K8S_NAME?.trim() || 'mx-internal-host-runner';
  const namespace = process.env.MX_INTERNAL_HOST_RUNNER_K8S_NAMESPACE?.trim()
    || process.env.POD_NAMESPACE?.trim()
    || 'mx-internal-shadow';
  return `http://${name}.${namespace}.svc.cluster.local:${hostRunnerPort()}`;
}

function hostRunnerPort(): number {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_PORT?.trim()
    || process.env.MX_INTERNAL_HOST_RUNNER_K8S_PORT?.trim()
    || '19190';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 19190;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
