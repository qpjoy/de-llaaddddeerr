import type {
  AwxProviderCheckEndpoint,
  AwxProviderCheckInput,
  AwxProviderCheckResult,
  AwxProviderConfig,
  SiteSlotKind
} from '../../types.js';

type AwxListResponse = {
  count?: unknown;
  results?: unknown;
};

export async function checkAwxProvider(
  provider: AwxProviderConfig,
  input: AwxProviderCheckInput
): Promise<AwxProviderCheckResult> {
  const checkedAt = new Date().toISOString();
  const targetKind = awxCheckKind(input.kind, provider.defaultKind);
  const inventory = `${provider.inventoryPrefix}-${provider.environment}-${targetKind}`;
  const jobTemplate = `${provider.jobTemplatePrefix}-${targetKind}-worker-v1`;
  const warnings = [...provider.warnings];
  const requestTimeoutSeconds = input.requestTimeoutSeconds && input.requestTimeoutSeconds > 0
    ? Math.min(Math.floor(input.requestTimeoutSeconds), 300)
    : provider.requestTimeoutSeconds;
  if (provider.status === 'paused') warnings.push('paused: provider is not selected for new awx-shadow evidence');
  if (provider.verifyTls === false) warnings.push('verifyTls=false is recorded; this readonly check still uses platform TLS trust');
  if (!provider.baseUrl) {
    return {
      providerId: provider.providerId,
      checkedAt,
      mode: 'awx-api-readonly',
      status: 'blocked',
      baseUrl: null,
      organization: provider.organization,
      project: provider.project,
      inventory,
      jobTemplate,
      targetKind,
      endpoints: [],
      failures: ['baseUrl is required before AWX API readonly checks can run'],
      warnings,
      nextActions: ['set-awx-base-url', 'rerun-awx-provider-check']
    };
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  const token = input.token?.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  const endpointSpecs = [
    { name: 'ping', path: '/api/v2/ping/', expectedName: null },
    { name: 'organization', path: `/api/v2/organizations/?name=${encodeURIComponent(provider.organization)}`, expectedName: provider.organization },
    { name: 'project', path: `/api/v2/projects/?name=${encodeURIComponent(provider.project)}`, expectedName: provider.project },
    { name: 'inventory', path: `/api/v2/inventories/?name=${encodeURIComponent(inventory)}`, expectedName: inventory },
    { name: 'job-template', path: `/api/v2/job_templates/?name=${encodeURIComponent(jobTemplate)}`, expectedName: jobTemplate }
  ];

  const endpoints: AwxProviderCheckEndpoint[] = [];
  for (const spec of endpointSpecs) {
    endpoints.push(await checkEndpoint(provider.baseUrl, spec.name, spec.path, spec.expectedName, headers, requestTimeoutSeconds));
  }

  const failures = endpoints
    .filter((endpoint) => endpoint.status === 'failed')
    .map((endpoint) => `${endpoint.name}: ${endpoint.message}`);
  const missing = endpoints
    .filter((endpoint) => endpoint.status === 'blocked')
    .map((endpoint) => `${endpoint.name}: ${endpoint.message}`);
  const status = failures.length > 0 ? 'failed' : missing.length > 0 ? 'blocked' : 'passed';
  return {
    providerId: provider.providerId,
    checkedAt,
    mode: 'awx-api-readonly',
    status,
    baseUrl: provider.baseUrl,
    organization: provider.organization,
    project: provider.project,
    inventory,
    jobTemplate,
    targetKind,
    endpoints,
    failures: [...failures, ...missing],
    warnings,
    nextActions: status === 'passed'
      ? ['enable-awx-api-launch-shadow', 'map-awx-events-to-worker-report']
      : ['fix-awx-provider-config', 'sync-awx-inventory-project-template', 'rerun-awx-provider-check']
  };
}

async function checkEndpoint(
  baseUrl: string,
  name: string,
  path: string,
  expectedName: string | null,
  headers: Record<string, string>,
  timeoutSeconds: number
): Promise<AwxProviderCheckEndpoint> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let httpStatus: number | null = null;
  try {
    const response = await fetch(new URL(path, normalizedAwxBaseUrl(baseUrl)), {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    httpStatus = response.status;
    const text = await response.text();
    const json = parseJsonObject(text);
    const count = name === 'ping' ? (response.ok ? 1 : 0) : numericCount(json);
    const matchedNames = matchedResultNames(json);
    const status = response.ok
      ? expectedName && (count ?? 0) < 1 ? 'blocked' : 'passed'
      : 'failed';
    return {
      name,
      method: 'GET',
      path,
      status,
      httpStatus,
      durationMs: Date.now() - started,
      count: name === 'ping' ? null : count,
      matchedNames,
      message: endpointMessage(name, response.status, status, expectedName, count)
    };
  } catch (error) {
    return {
      name,
      method: 'GET',
      path,
      status: 'failed',
      httpStatus,
      durationMs: Date.now() - started,
      count: null,
      matchedNames: [],
      message: error instanceof Error ? error.message : 'AWX request failed'
    };
  } finally {
    clearTimeout(timeout);
  }
}

function endpointMessage(
  name: string,
  httpStatus: number,
  status: AwxProviderCheckEndpoint['status'],
  expectedName: string | null,
  count: number | null
): string {
  if (status === 'failed') return `AWX ${name} returned HTTP ${httpStatus}`;
  if (status === 'blocked') return `${expectedName || name} was not found`;
  return (count ?? 0) > 0 || name === 'ping' ? 'ready' : 'passed';
}

function parseJsonObject(text: string): AwxListResponse {
  try {
    const value = text ? JSON.parse(text) : {};
    return value && typeof value === 'object' ? value as AwxListResponse : {};
  } catch {
    return {};
  }
}

function numericCount(value: AwxListResponse): number {
  return typeof value.count === 'number' && Number.isFinite(value.count) ? value.count : 0;
}

function matchedResultNames(value: AwxListResponse): string[] {
  return Array.isArray(value.results)
    ? value.results
      .map((item) => item && typeof item === 'object' && 'name' in item ? String((item as { name?: unknown }).name ?? '') : '')
      .filter(Boolean)
    : [];
}

function normalizedAwxBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function awxCheckKind(inputKind: AwxProviderCheckInput['kind'], defaultKind: AwxProviderConfig['defaultKind']): SiteSlotKind {
  if (inputKind === 'domestic' || inputKind === 'oversea') return inputKind;
  return defaultKind === 'domestic' ? 'domestic' : 'oversea';
}
