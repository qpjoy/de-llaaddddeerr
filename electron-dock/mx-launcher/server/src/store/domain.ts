import { createHash } from 'node:crypto';

import type {
  AnonymousEnrollment,
  AppCenterApp,
  ConfigSnapshot,
  DnsPolicy,
  DnsQueryInput,
  DnsResolutionDecision,
  DnsReverseProxyRoute,
  PrincipalContext,
  PrincipalContextInput,
  PlatformPrincipal,
  ReleasePolicyDecision,
  RuntimeConfig,
  SdkGatewayManifest,
  TokenIntrospectionInput,
  TokenIntrospectionResult,
  TestStep,
  UpdatePolicyKind
} from '../types.js';

const USER_SCOPES = [
  'auth.read',
  'appcenter.read',
  'permission.request',
  'network.dns.policy',
  'observability.write'
];

const GUEST_SCOPES = ['auth.read', 'network.dns.policy'];

const SERVICE_ACCOUNT_SCOPES = [
  'sdk.identity.read',
  'sdk.dns.evaluate',
  'sdk.audit.write',
  'sdk.observability.write',
  'sdk.release.read'
];

export function builtinAppCenterApps(): AppCenterApp[] {
  return [
    {
      appId: 'h2o',
      displayName: 'H2O',
      builtin: true,
      version: '0.1.0',
      category: 'network',
      description: 'Clash-like AppCenter network app powered by Launcher Network.',
      channels: ['shadow', 'beta', 'stable'],
      permissions: [
        'auth.read',
        'network.hdi.status',
        'network.proxy.app',
        'network.proxy.global',
        'network.tun.request',
        'network.dns.policy',
        'network.pac.policy',
        'observability.write'
      ],
      requiredCapabilities: ['launcher-network', 'app-center-runtime'],
      updatePolicy: 'app-managed',
      entrypoints: {
        desktop: 'app://h2o/index.html',
        settings: 'app://h2o/settings.html'
      },
      protocol: {
        appCenter: '1.0',
        launcher: '1.0'
      }
    }
  ];
}

export function builtinDnsPolicies(config: RuntimeConfig): DnsPolicy[] {
  const now = new Date().toISOString();
  return [
    {
      policyId: 'dns_default_internal_split',
      environment: config.environment,
      siteId: config.siteId,
      name: 'Default Internal Split DNS',
      version: 1,
      enabled: true,
      priority: 100,
      owners: ['launcher-network', 'h2o', 'sdk-gateway'],
      whitelist: {
        exactDomains: ['internal.mx', 'gateway.internal.mx'],
        suffixes: ['.internal.mx', '.corp.mx', '.h2i.mx']
      },
      internal: {
        authority: 'internal-coredns',
        serviceDns: 'mx-internal-coredns.mx-dns.svc.cluster.local',
        h2iRequired: true
      },
      fallbackOrder: ['system-dns', 'system-proxy', 'h2o-proxy', 'direct'],
      proxyHints: {
        pacPriority: ['launcher-network', 'app-center-policy', 'system-proxy', 'h2o', 'direct'],
        allowSystemProxyFallback: true
      },
      createdAt: now,
      updatedAt: now
    }
  ];
}

export function builtinDnsReverseProxyRoutes(config: RuntimeConfig): DnsReverseProxyRoute[] {
  const now = new Date().toISOString();
  return [
    {
      routeId: 'rp_gateway_internal_mx',
      environment: config.environment,
      host: 'gateway.internal.mx',
      targetUrl: config.internalBaseUrl,
      enabled: true,
      tlsMode: 'internal',
      authRequired: true,
      createdAt: now,
      updatedAt: now
    }
  ];
}

export function evaluateDnsPolicy(
  policy: DnsPolicy,
  routes: DnsReverseProxyRoute[],
  input: DnsQueryInput
): DnsResolutionDecision {
  const normalizedDomain = normalizeDomain(input.domain);
  const matched = matchesDnsWhitelist(policy, normalizedDomain);
  const reverseProxyRoute = routes.find((route) => route.enabled && normalizeDomain(route.host) === normalizedDomain) ?? null;
  if (matched) {
    return {
      domain: input.domain,
      normalizedDomain,
      matched: true,
      policyId: policy.policyId,
      route: 'internal-dns',
      resolver: 'internal-coredns',
      fallbackOrder: policy.fallbackOrder,
      reverseProxyRoute,
      reason: reverseProxyRoute
        ? 'domain matches split DNS whitelist and has an Internal reverse proxy route'
        : 'domain matches split DNS whitelist'
    };
  }
  return {
    domain: input.domain,
    normalizedDomain,
    matched: false,
    policyId: policy.policyId,
    route: 'fallback',
    resolver: policy.fallbackOrder[0] ?? 'system-dns',
    fallbackOrder: policy.fallbackOrder,
    reverseProxyRoute: null,
    reason: 'domain does not match split DNS whitelist'
  };
}

export function createSdkGatewayManifest(config: RuntimeConfig): SdkGatewayManifest {
  const routes = [
    {
      routeId: 'sdk.identity.introspect',
      path: '/internal/v1/sdk/identity/introspect',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Stable SDK-facing token introspection contract backed by User Center.'
    },
    {
      routeId: 'sdk.identity.context',
      path: '/internal/v1/sdk/identity/context',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Resolves user, anonymous install, or service-account context for callers.'
    },
    {
      routeId: 'sdk.dns.policy',
      path: '/internal/v1/sdk/dns/policy',
      upstreamModule: 'dns-control',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Reads effective split DNS policy for external systems and SDKs.'
    },
    {
      routeId: 'sdk.dns.evaluate',
      path: '/internal/v1/sdk/dns/evaluate',
      upstreamModule: 'dns-control',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Evaluates split DNS, fallback, and Internal reverse-proxy decisions.'
    },
    {
      routeId: 'sdk.audit.write',
      path: '/internal/v1/audit/events',
      upstreamModule: 'audit-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Writes normalized audit events from Launcher, AppCenter, and peer systems.'
    },
    {
      routeId: 'sdk.observability.logs',
      path: '/internal/v1/observability/logs',
      upstreamModule: 'observability',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Ingests normalized logs before they are forwarded to configured sinks.'
    }
  ];
  return {
    gatewayId: `sdk-gateway:${config.siteId}`,
    environment: config.environment,
    siteId: config.siteId,
    authority: 'sdk-gateway',
    authAuthority: 'user-center',
    basePath: '/internal/v1/sdk',
    modules: config.enabledModules,
    routes,
    sdk: {
      audience: 'mx-sdk',
      tokenIntrospectionUrl: '/internal/v1/sdk/identity/introspect',
      principalContextUrl: '/internal/v1/sdk/identity/context',
      dnsPolicyUrl: '/internal/v1/sdk/dns/policy',
      dnsEvaluateUrl: '/internal/v1/sdk/dns/evaluate',
      auditUrl: '/internal/v1/audit/events',
      observabilityLogsUrl: '/internal/v1/observability/logs'
    }
  };
}

export function introspectShadowToken(
  config: RuntimeConfig,
  input: TokenIntrospectionInput
): TokenIntrospectionResult {
  const token = input.token?.trim() ?? '';
  const audience = input.audience?.trim() || 'mx-sdk';
  const issuer = `mx-user-center:${config.environment}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  if (!token) {
    return inactiveToken(issuer, audience, 'token is missing');
  }
  if (token.startsWith('mx-shadow-user:')) {
    const userId = token.slice('mx-shadow-user:'.length).trim();
    if (!userId) return inactiveToken(issuer, audience, 'shadow user token subject is missing');
    const principal = createUserPrincipal(userId);
    return {
      active: true,
      tokenKind: 'shadow-token',
      issuer,
      audience,
      subject: principal.principalId,
      principal,
      scopes: principal.scopes,
      expiresAt,
      reason: 'shadow user token accepted by User Center V0'
    };
  }
  if (token.startsWith('mx-shadow-service:')) {
    const serviceAccountId = token.slice('mx-shadow-service:'.length).trim();
    if (!serviceAccountId) return inactiveToken(issuer, audience, 'shadow service token subject is missing');
    const principal = createServiceAccountPrincipal(serviceAccountId);
    return {
      active: true,
      tokenKind: 'service-token',
      issuer,
      audience,
      subject: principal.principalId,
      principal,
      scopes: principal.scopes,
      expiresAt,
      reason: 'shadow service account token accepted by User Center V0'
    };
  }
  if (token.startsWith('mx-shadow-anon:')) {
    const anonymousPrincipalId = token.slice('mx-shadow-anon:'.length).trim();
    if (!anonymousPrincipalId) return inactiveToken(issuer, audience, 'shadow anonymous token subject is missing');
    const principal = createAnonymousPrincipal(anonymousPrincipalId);
    return {
      active: true,
      tokenKind: 'shadow-token',
      issuer,
      audience,
      subject: principal.principalId,
      principal,
      scopes: principal.scopes,
      expiresAt,
      reason: 'shadow anonymous token accepted by User Center V0'
    };
  }
  return inactiveToken(issuer, audience, 'token format is not recognized by User Center V0');
}

export function resolvePrincipalContext(
  config: RuntimeConfig,
  input: PrincipalContextInput,
  enrollment: AnonymousEnrollment | null
): PrincipalContext {
  const auth = introspectShadowToken(config, {
    token: input.token,
    audience: input.audience,
    requestId: input.requestId
  });
  const boundUserId = input.userId ?? enrollment?.userId ?? null;
  const anonymousPrincipalId = input.anonymousPrincipalId ?? enrollment?.anonymousPrincipalId ?? null;
  let principal = auth.principal;
  let source: PrincipalContext['source'] = auth.active ? 'token' : 'unknown';

  if (!principal && boundUserId) {
    principal = createUserPrincipal(boundUserId);
    source = 'identity-binding';
  }
  if (!principal && input.serviceAccountId) {
    principal = createServiceAccountPrincipal(input.serviceAccountId);
    source = 'service-account';
  }
  if (!principal && anonymousPrincipalId) {
    principal = createAnonymousPrincipal(anonymousPrincipalId);
    source = 'anonymous';
  }
  if (!principal) {
    principal = createUnknownPrincipal();
  }

  const allowedRoutes = createSdkGatewayManifest(config).routes
    .filter((route) => principalAllowsGatewayRoute(principal, route.routeId))
    .map((route) => route.routeId);
  return {
    principal,
    auth,
    bindings: {
      installId: enrollment?.installId ?? input.installId ?? null,
      deviceId: enrollment?.deviceId ?? null,
      anonymousPrincipalId,
      linkedUserId: enrollment?.userId ?? boundUserId
    },
    gateway: {
      authority: 'sdk-gateway',
      canUseSdkGateway: principal.kind !== 'unknown',
      allowedRoutes
    },
    source
  };
}

function inactiveToken(issuer: string, audience: string | null, reason: string): TokenIntrospectionResult {
  return {
    active: false,
    tokenKind: 'unknown',
    issuer,
    audience,
    subject: null,
    principal: null,
    scopes: [],
    expiresAt: null,
    reason
  };
}

function createUserPrincipal(userId: string): PlatformPrincipal {
  return {
    principalId: `user:${userId}`,
    kind: 'user',
    tenantId: 'tenant_default',
    orgIds: ['org_default'],
    displayName: userId,
    userId,
    anonymousPrincipalId: null,
    serviceAccountId: null,
    roles: ['mx-user'],
    scopes: USER_SCOPES
  };
}

function createAnonymousPrincipal(anonymousPrincipalId: string): PlatformPrincipal {
  return {
    principalId: `anonymous:${anonymousPrincipalId}`,
    kind: 'anonymous',
    tenantId: 'tenant_default',
    orgIds: [],
    displayName: 'Anonymous Install',
    userId: null,
    anonymousPrincipalId,
    serviceAccountId: null,
    roles: ['mx-guest'],
    scopes: GUEST_SCOPES
  };
}

function createServiceAccountPrincipal(serviceAccountId: string): PlatformPrincipal {
  return {
    principalId: `service-account:${serviceAccountId}`,
    kind: 'service-account',
    tenantId: 'tenant_default',
    orgIds: ['org_default'],
    displayName: serviceAccountId,
    userId: null,
    anonymousPrincipalId: null,
    serviceAccountId,
    roles: ['mx-service-account'],
    scopes: SERVICE_ACCOUNT_SCOPES
  };
}

function createUnknownPrincipal(): PlatformPrincipal {
  return {
    principalId: 'unknown',
    kind: 'unknown',
    tenantId: 'tenant_default',
    orgIds: [],
    displayName: 'Unknown Principal',
    userId: null,
    anonymousPrincipalId: null,
    serviceAccountId: null,
    roles: [],
    scopes: []
  };
}

function principalAllowsGatewayRoute(principal: PlatformPrincipal, routeId: string): boolean {
  if (principal.kind === 'unknown') return false;
  if (routeId.startsWith('sdk.identity.')) return principal.scopes.includes('sdk.identity.read') || principal.scopes.includes('auth.read');
  if (routeId.startsWith('sdk.dns.')) return principal.scopes.includes('sdk.dns.evaluate') || principal.scopes.includes('network.dns.policy');
  if (routeId === 'sdk.audit.write') return principal.scopes.includes('sdk.audit.write');
  if (routeId === 'sdk.observability.logs') return principal.scopes.includes('sdk.observability.write') || principal.scopes.includes('observability.write');
  return false;
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

function matchesDnsWhitelist(policy: DnsPolicy, normalizedDomain: string): boolean {
  if (!policy.enabled || !normalizedDomain) return false;
  if (policy.whitelist.exactDomains.map(normalizeDomain).includes(normalizedDomain)) return true;
  return policy.whitelist.suffixes.some((suffix) => {
    const normalizedSuffix = normalizeDomain(suffix).replace(/^\./, '');
    return normalizedDomain === normalizedSuffix || normalizedDomain.endsWith(`.${normalizedSuffix}`);
  });
}

export function createConfigSnapshot(
  config: RuntimeConfig,
  enrollment: AnonymousEnrollment,
  snapshotId: string,
  version: number,
  defaultMode: 'visitor' | 'employee'
): ConfigSnapshot {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 6 * 60 * 60 * 1000);
  const unsigned = {
    environment: config.environment,
    siteId: enrollment.siteId,
    productId: enrollment.productId,
    installId: enrollment.installId,
    deviceId: enrollment.deviceId,
    anonymousPrincipalId: enrollment.anonymousPrincipalId,
    userId: enrollment.userId,
    version,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    config: {
      serverBaseUrl: config.publicBaseUrl,
      defaultMode,
      relayMode: enrollment.relayMode,
      overlayIp: enrollment.overlayIp
    }
  };
  const digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  return {
    snapshotId,
    ...unsigned,
    endpoints: {
      publicBaseUrl: config.publicBaseUrl,
      internalBaseUrl: config.internalBaseUrl,
      preferredAfterRelay: 'internal',
      fallbackOrder: ['domestic', 'internal']
    },
    observability: {
      level: 'info',
      sinks: config.observabilitySinks
    },
    release: {
      channel: config.environment === 'shadow' ? 'shadow' : 'stable',
      tasksUrl: '/internal/v1/release/tasks'
    },
    resources: [],
    signatures: {
      algorithm: 'sha256-dev-digest',
      digest,
      issuer: 'mx-launcher-server-shadow'
    }
  };
}

export function normalizeUpdatePolicy(value: string): UpdatePolicyKind {
  if (
    value === 'platform-critical'
    || value === 'platform-ui'
    || value === 'app-managed'
    || value === 'mandatory-app'
    || value === 'config-snapshot'
  ) {
    return value;
  }
  return 'app-managed';
}

export function releasePolicyByKind(
  kind: UpdatePolicyKind
): Omit<ReleasePolicyDecision, 'componentKind' | 'componentId' | 'currentVersion' | 'targetVersion' | 'updateAvailable'> {
  if (kind === 'platform-critical') {
    return {
      updateMode: 'mandatory',
      canSkip: false,
      canDefer: false,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'platform-critical updates are mandatory and gated'
    };
  }
  if (kind === 'platform-ui') {
    return {
      updateMode: 'automatic',
      canSkip: false,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'platform UI updates are automatic with maintenance-window deferral'
    };
  }
  if (kind === 'mandatory-app') {
    return {
      updateMode: 'mandatory',
      canSkip: false,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'app update is marked mandatory'
    };
  }
  if (kind === 'config-snapshot') {
    return {
      updateMode: 'automatic',
      canSkip: false,
      canDefer: false,
      requiresGate: false,
      rollbackRequired: true,
      reason: 'config snapshots are signed and automatically applied'
    };
  }
  return {
    updateMode: 'manual',
    canSkip: true,
    canDefer: true,
    requiresGate: false,
    rollbackRequired: true,
    reason: 'app-managed updates can be skipped by user or policy'
  };
}

export function normalizeTestStatus(value: string): TestStep['status'] {
  if (value === 'failed' || value === 'blocked') return value;
  return 'passed';
}

export function required<T>(value: T | null, message: string): T {
  if (value) return value;
  throw new Error(message);
}
