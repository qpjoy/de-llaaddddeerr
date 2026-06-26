import type { ObservabilitySink, RuntimeConfig, SiteRole, StoreDriver } from './types.js';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function storeDriverFromEnv(): StoreDriver {
  return process.env.INTERNAL_STORE_DRIVER === 'postgres' ? 'postgres' : 'memory';
}

function siteRoleFromEnv(): SiteRole {
  const raw = process.env.MX_SITE_ROLE;
  if (raw === 'domestic' || raw === 'oversea' || raw === 'h-endpoint-dev') return raw;
  return 'internal';
}

function gatewayApplyBackendFromEnv(): RuntimeConfig['gatewayApplyBackend'] {
  return process.env.GATEWAY_APPLY_BACKEND?.trim() === 'host-nginx' ? 'host-nginx' : 'k8s';
}

function enabledModulesFromEnv(siteRole: SiteRole): string[] {
  const raw = process.env.MX_ENABLED_MODULES;
  if (raw?.trim()) {
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (siteRole === 'domestic') {
    return ['edge-api', 'relay-facade', 'h2i-proxy', 'snapshot-cache', 'observability-forwarder'];
  }
  if (siteRole === 'oversea') {
    return ['access-node', 'site-agent', 'runner-worker', 'observability-forwarder'];
  }
  if (siteRole === 'h-endpoint-dev') {
    return ['launcher-dev-api', 'observability-forwarder'];
  }
  return [
    'iam',
    'app-center',
    'config-center',
    'deploy-center',
    'release-center',
    'artifact-center',
    'runner-controller',
    'test-center',
    'audit-center',
    'observability',
    'sdk-gateway',
    'launcher-network-control',
    'hdi-compat',
    'dns-control',
    'edge-sync'
  ];
}

function parseSinks(): ObservabilitySink[] {
  const raw = process.env.OBSERVABILITY_SINKS;
  if (!raw?.trim()) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ObservabilitySink => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      return typeof row.kind === 'string'
        && typeof row.environment === 'string'
        && typeof row.url === 'string';
    });
  } catch {
    return [];
  }
}

export function loadConfig(): RuntimeConfig {
  const siteRole = siteRoleFromEnv();
  return {
    environment: process.env.MX_ENVIRONMENT ?? 'shadow',
    siteId: process.env.MX_SITE_ID ?? 'internal-main',
    siteRole,
    enabledModules: enabledModulesFromEnv(siteRole),
    host: process.env.HOST ?? '0.0.0.0',
    port: intFromEnv('PORT', 18090),
    publicBaseUrl: process.env.MX_PUBLIC_BASE_URL ?? 'https://shadow-d.example.com',
    internalBaseUrl: process.env.MX_INTERNAL_BASE_URL ?? 'https://10.70.0.2:8443',
    storeDriver: storeDriverFromEnv(),
    databaseUrl: process.env.DATABASE_URL ?? null,
    observabilitySinks: parseSinks(),
    runnerDryRunDefault: boolFromEnv('RUNNER_DRY_RUN_DEFAULT', true),
    siteSlotRunnerRemoteExecutionEnabled: boolFromEnv('SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED', false),
    coreDnsK8sApplyEnabled: boolFromEnv('COREDNS_K8S_APPLY_ENABLED', false),
    coreDnsK8sAllowedNamespace: process.env.COREDNS_K8S_ALLOWED_NAMESPACE ?? 'mx-dns',
    coreDnsK8sAllowedConfigMapName: process.env.COREDNS_K8S_ALLOWED_CONFIGMAP_NAME ?? 'coredns',
    gatewayK8sApplyEnabled: boolFromEnv('GATEWAY_K8S_APPLY_ENABLED', false),
    gatewayK8sAllowedNamespace: process.env.GATEWAY_K8S_ALLOWED_NAMESPACE ?? 'mx-internal-shadow',
    gatewayK8sAllowedConfigMapName: process.env.GATEWAY_K8S_ALLOWED_CONFIGMAP_NAME ?? 'mx-internal-gateway-caddy',
    gatewayApplyBackend: gatewayApplyBackendFromEnv(),
    gatewayHostNginxApplyEnabled: boolFromEnv('GATEWAY_HOST_NGINX_APPLY_ENABLED', false),
    gatewayHostNginxConfigPath: process.env.GATEWAY_HOST_NGINX_CONFIG_PATH
      ?? '/etc/nginx/conf.d/mx-gateway.generated.conf',
    gatewayHostNginxInternalApiUpstream: process.env.GATEWAY_HOST_NGINX_INTERNAL_API_UPSTREAM?.trim() || null,
    gatewayAppPort: intFromEnv('GATEWAY_APP_PORT', 80),
    siteSlotSshKeyRoot: process.env.MX_SITE_SLOT_SSH_KEY_DIR ?? 'artifacts/ssh'
  };
}
