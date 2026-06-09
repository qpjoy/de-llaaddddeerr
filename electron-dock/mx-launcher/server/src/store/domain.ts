import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  AnonymousEnrollment,
  AppCenterApp,
  ConfigPolicySnapshot,
  ConfigPolicySnapshotInput,
  ConfigSnapshot,
  CoreDnsConfigMapManifest,
  CoreDnsConfigMapApplyInput,
  CoreDnsConfigMapSyncInput,
  CoreDnsConfigMapSyncResult,
  CreateServiceAccountInput,
  CreateUserInput,
  DnsPolicy,
  DnsQueryInput,
  DnsResolutionDecision,
  DnsReverseProxyRoute,
  DnsZoneRecord,
  DnsZoneSnapshot,
  IssueTokenInput,
  LauncherNetworkSnapshot,
  PrincipalContext,
  PrincipalContextInput,
  PlatformPrincipal,
  ReleasePolicyDecision,
  ReleaseManagementPlan,
  ReleaseManagementPlanInput,
  RuntimeConfig,
  RuntimeFeaturePolicy,
  RuntimeFeaturePolicyInput,
  RuntimeFeaturePolicyMode,
  RuntimeFeaturePolicyScopeKind,
  SdkGatewayAccessDecision,
  SdkGatewayManifest,
  SiteSlotExecutionInput,
  SiteSlotExecutionRun,
  SiteSlotKind,
  SiteSlotNetworkMode,
  SiteSlotPlan,
  SiteSlotPlanInput,
  SiteSlotRunnerSession,
  SiteSlotRunnerStartInput,
  SiteSlotSshProfile,
  SiteSlotSshProfileInput,
  SiteSlotRollbackExecution,
  SiteSlotRollbackExecutionInput,
  SiteSlotRollbackPlan,
  SiteSlotRollbackReport,
  SiteSlotRollbackReportInput,
  SiteSlotRollbackReportStatus,
  SiteSlotWorkerJob,
  SiteSlotWorkerJobInput,
  SiteSlotWorkerReport,
  SiteSlotWorkerReportInput,
  SiteSlotWorkerReportStatus,
  TokenIntrospectionInput,
  TokenIntrospectionResult,
  UserCenterBootstrapResult,
  UserCenterIssuedToken,
  UserCenterOrg,
  UserCenterRole,
  UserCenterServiceAccount,
  UserCenterTenant,
  UserCenterTokenRecord,
  UserCenterUser,
  TestStep,
  TestGateVerdict,
  TestRun,
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
  'sdk.config.snapshot',
  'sdk.dns.evaluate',
  'sdk.audit.write',
  'sdk.observability.write',
  'sdk.release.read'
];

const ADMIN_SCOPES = [...new Set([
  ...USER_SCOPES,
  ...SERVICE_ACCOUNT_SCOPES,
  'admin.dashboard.read',
  'rbac.manage',
  'release.manage',
  'site-slot.manage',
  'site-slot.execute',
  'dns.manage'
])];

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function builtinUserCenterRoles(now = new Date().toISOString()): UserCenterRole[] {
  return [
    {
      roleId: 'mx-admin',
      displayName: 'MX Admin',
      scopes: ADMIN_SCOPES,
      createdAt: now
    },
    {
      roleId: 'mx-user',
      displayName: 'MX User',
      scopes: USER_SCOPES,
      createdAt: now
    },
    {
      roleId: 'mx-service-account',
      displayName: 'MX Service Account',
      scopes: SERVICE_ACCOUNT_SCOPES,
      createdAt: now
    },
    {
      roleId: 'mx-guest',
      displayName: 'MX Guest',
      scopes: GUEST_SCOPES,
      createdAt: now
    }
  ];
}

export function builtinUserCenterTenant(now = new Date().toISOString()): UserCenterTenant {
  return {
    tenantId: 'tenant_default',
    displayName: 'Default Tenant',
    status: 'active',
    createdAt: now
  };
}

export function builtinUserCenterOrg(now = new Date().toISOString()): UserCenterOrg {
  return {
    orgId: 'org_default',
    tenantId: 'tenant_default',
    displayName: 'Default Organization',
    status: 'active',
    createdAt: now
  };
}

export function createUserCenterUser(input: CreateUserInput, now = new Date().toISOString()): UserCenterUser {
  const email = input.email?.trim() || 'demo-user@mx.local';
  const userId = input.userId?.trim() || `usr_${email.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
  return {
    userId,
    tenantId: 'tenant_default',
    orgIds: input.orgIds?.length ? input.orgIds : ['org_default'],
    email,
    displayName: input.displayName?.trim() || email,
    roleIds: input.roleIds?.length ? input.roleIds : ['mx-user'],
    status: 'active',
    createdAt: now
  };
}

export function createUserCenterServiceAccount(
  input: CreateServiceAccountInput,
  now = new Date().toISOString()
): UserCenterServiceAccount {
  const serviceAccountId = input.serviceAccountId?.trim() || 'svc_sdk_gateway';
  return {
    serviceAccountId,
    tenantId: 'tenant_default',
    displayName: input.displayName?.trim() || serviceAccountId,
    roleIds: input.roleIds?.length ? input.roleIds : ['mx-service-account'],
    scopes: input.scopes ?? [],
    status: 'active',
    createdAt: now
  };
}

export function createUserCenterTokenRecord(
  config: RuntimeConfig,
  input: IssueTokenInput,
  token: string,
  now = new Date()
): UserCenterIssuedToken {
  const issuedAt = now.toISOString();
  const ttlMs = Math.max(60, input.ttlSeconds ?? 3600) * 1000;
  const record: UserCenterTokenRecord = {
    tokenId: `tok_${hashToken(`${token}:${issuedAt}`).slice(0, 24)}`,
    tokenHash: hashToken(token),
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    audience: input.audience?.trim() || 'mx-sdk',
    scopes: input.scopes ?? [],
    issuer: `mx-user-center:${config.environment}`,
    issuedAt,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    revokedAt: null
  };
  return { token, record };
}

export function createUserPrincipalFromRecord(user: UserCenterUser, roles: UserCenterRole[]): PlatformPrincipal {
  return {
    principalId: `user:${user.userId}`,
    kind: 'user',
    tenantId: user.tenantId,
    orgIds: user.orgIds,
    displayName: user.displayName,
    userId: user.userId,
    anonymousPrincipalId: null,
    serviceAccountId: null,
    roles: user.roleIds,
    scopes: roleScopes(user.roleIds, roles)
  };
}

export function createServiceAccountPrincipalFromRecord(
  serviceAccount: UserCenterServiceAccount,
  roles: UserCenterRole[]
): PlatformPrincipal {
  return {
    principalId: `service-account:${serviceAccount.serviceAccountId}`,
    kind: 'service-account',
    tenantId: serviceAccount.tenantId,
    orgIds: ['org_default'],
    displayName: serviceAccount.displayName,
    userId: null,
    anonymousPrincipalId: null,
    serviceAccountId: serviceAccount.serviceAccountId,
    roles: serviceAccount.roleIds,
    scopes: [...new Set([...roleScopes(serviceAccount.roleIds, roles), ...serviceAccount.scopes])]
  };
}

export function createBootstrapResult(
  roles: UserCenterRole[],
  users: UserCenterUser[],
  serviceAccounts: UserCenterServiceAccount[]
): UserCenterBootstrapResult {
  return {
    tenant: builtinUserCenterTenant(),
    org: builtinUserCenterOrg(),
    roles,
    users,
    serviceAccounts
  };
}

export function introspectUserCenterToken(
  config: RuntimeConfig,
  input: TokenIntrospectionInput,
  record: UserCenterTokenRecord | null,
  principal: PlatformPrincipal | null
): TokenIntrospectionResult | null {
  if (!record) return null;
  const audience = input.audience?.trim() || record.audience;
  if (record.revokedAt) {
    return inactiveToken(record.issuer, audience, 'token has been revoked');
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    return inactiveToken(record.issuer, audience, 'token has expired');
  }
  if (record.audience !== audience) {
    return inactiveToken(record.issuer, audience, 'token audience does not match');
  }
  if (!principal) {
    return inactiveToken(record.issuer, audience, 'token subject is not active');
  }
  const scopes = record.scopes.length > 0
    ? record.scopes.filter((scope) => principal.scopes.includes(scope))
    : principal.scopes;
  return {
    active: true,
    tokenKind: record.subjectKind === 'service-account' ? 'service-token' : 'jwt',
    issuer: record.issuer || `mx-user-center:${config.environment}`,
    audience,
    subject: principal.principalId,
    principal: {
      ...principal,
      scopes
    },
    scopes,
    expiresAt: record.expiresAt,
    reason: 'token accepted by User Center V1 record'
  };
}

export function evaluateSdkGatewayRoute(principal: PlatformPrincipal | null, routeId: string): SdkGatewayAccessDecision {
  const requiredAnyScopes = gatewayRouteRequiredScopes(routeId);
  if (!principal) {
    return {
      routeId,
      allowed: false,
      principal: null,
      matchedScopes: [],
      missingScopes: requiredAnyScopes,
      reason: 'token is inactive or principal is missing'
    };
  }
  const matchedScopes = requiredAnyScopes.filter((scope) => principal.scopes.includes(scope));
  const allowed = requiredAnyScopes.length === 0 ? principal.kind !== 'unknown' : matchedScopes.length > 0;
  return {
    routeId,
    allowed,
    principal,
    matchedScopes,
    missingScopes: allowed ? [] : requiredAnyScopes,
    reason: allowed ? 'principal has a scope accepted by SDK Gateway route' : 'principal lacks required SDK Gateway route scope'
  };
}

function roleScopes(roleIds: string[], roles: UserCenterRole[]): string[] {
  const scopes = roleIds.flatMap((roleId) => roles.find((role) => role.roleId === roleId)?.scopes ?? []);
  return [...new Set(scopes)];
}

function gatewayRouteRequiredScopes(routeId: string): string[] {
  if (routeId === 'sdk.gateway.access.evaluate') return ['sdk.identity.read'];
  if (routeId === 'sdk.config.snapshot') return ['sdk.config.snapshot', 'sdk.identity.read', 'auth.read'];
  if (routeId.startsWith('sdk.identity.')) return ['sdk.identity.read', 'auth.read'];
  if (routeId.startsWith('sdk.dns.')) return ['sdk.dns.evaluate', 'network.dns.policy'];
  if (routeId === 'sdk.audit.write') return ['sdk.audit.write'];
  if (routeId === 'sdk.observability.logs') return ['sdk.observability.write', 'observability.write'];
  return [];
}

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

export function buildDnsZoneSnapshot(
  config: RuntimeConfig,
  input: {
    snapshotId: string;
    version: number;
    policy: DnsPolicy;
    reverseProxyRoutes: DnsReverseProxyRoute[];
    requestId?: string | null;
  }
): DnsZoneSnapshot {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);
  const targetServiceDns = hostFromUrl(config.internalBaseUrl) || input.policy.internal.serviceDns;
  const zoneNames = dnsPolicyZoneNames(input.policy);
  const records = dnsZoneRecords(input.policy, input.reverseProxyRoutes, targetServiceDns);
  const serverBlocks = zoneNames.map((zone) => ({
    zone,
    text: corefileServerBlock(zone, records, targetServiceDns)
  }));
  const unsigned = {
    snapshotId: input.snapshotId,
    environment: config.environment,
    siteId: config.siteId,
    policyId: input.policy.policyId,
    version: input.version,
    authority: 'internal-coredns' as const,
    zoneNames,
    serviceDns: input.policy.internal.serviceDns,
    records,
    reverseProxyRoutes: input.reverseProxyRoutes,
    fallbackOrder: input.policy.fallbackOrder,
    corefile: {
      targetServiceDns,
      serverBlocks,
      combined: serverBlocks.map((block) => block.text).join('\n\n')
    },
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  const digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  return {
    ...unsigned,
    signatures: {
      algorithm: 'sha256-dev-digest',
      digest,
      issuer: 'mx-dns-control-shadow'
    }
  };
}

export function renderCoreDnsConfigMap(
  snapshot: DnsZoneSnapshot,
  input: CoreDnsConfigMapSyncInput,
  syncId: string
): CoreDnsConfigMapSyncResult {
  const namespace = input.namespace?.trim() || 'mx-dns';
  const configMapName = input.configMapName?.trim() || 'coredns';
  const mode = input.mode === 'shadow-apply' ? 'shadow-apply' : 'dry-run';
  const issuedAt = new Date().toISOString();
  const labels = {
    'app.kubernetes.io/name': 'coredns',
    'app.kubernetes.io/part-of': 'mx-3ks',
    'mx.qpjoy.com/component': 'dns-control',
    'mx.qpjoy.com/environment': snapshot.environment
  };
  const annotations = {
    'mx.qpjoy.com/dns-zone-snapshot-id': snapshot.snapshotId,
    'mx.qpjoy.com/dns-zone-policy-id': snapshot.policyId,
    'mx.qpjoy.com/dns-zone-digest': snapshot.signatures.digest,
    'mx.qpjoy.com/sync-id': syncId
  };
  const snapshotMetadata = JSON.stringify({
    snapshotId: snapshot.snapshotId,
    policyId: snapshot.policyId,
    digest: snapshot.signatures.digest,
    zoneNames: snapshot.zoneNames,
    records: snapshot.records,
    reverseProxyRoutes: snapshot.reverseProxyRoutes,
    fallbackOrder: snapshot.fallbackOrder,
    issuedAt: snapshot.issuedAt,
    expiresAt: snapshot.expiresAt
  }, null, 2);
  const manifest: CoreDnsConfigMapManifest = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName,
      namespace,
      labels,
      annotations
    },
    data: {
      Corefile: snapshot.corefile.combined,
      'mx-zone-snapshot.json': snapshotMetadata
    },
    yaml: renderConfigMapYaml(configMapName, namespace, labels, annotations, snapshot.corefile.combined, snapshotMetadata)
  };
  return {
    syncId,
    mode,
    status: mode === 'shadow-apply' ? 'recorded' : 'rendered',
    applied: false,
    snapshotId: snapshot.snapshotId,
    namespace,
    configMapName,
    manifest,
    issuedAt,
    message: mode === 'shadow-apply'
      ? 'shadow apply recorded; no Kubernetes API mutation was performed'
      : 'dry-run render only; no Kubernetes API mutation was performed'
  };
}

export function evaluateCoreDnsConfigMapApplyGate(
  config: RuntimeConfig,
  sync: CoreDnsConfigMapSyncResult,
  input: CoreDnsConfigMapApplyInput
): { allowed: boolean; serverDryRun: boolean; blockedReason: string | null } {
  const serverDryRun = input.serverDryRun !== false;
  if (!config.coreDnsK8sApplyEnabled) {
    return {
      allowed: false,
      serverDryRun,
      blockedReason: 'COREDNS_K8S_APPLY_ENABLED is not enabled'
    };
  }
  if (input.confirmApply !== true) {
    return {
      allowed: false,
      serverDryRun,
      blockedReason: 'confirmApply=true is required before Kubernetes mutation'
    };
  }
  if (
    sync.namespace !== config.coreDnsK8sAllowedNamespace
    || sync.configMapName !== config.coreDnsK8sAllowedConfigMapName
  ) {
    return {
      allowed: false,
      serverDryRun,
      blockedReason: `target ${sync.namespace}/${sync.configMapName} is outside the allowed CoreDNS target`
    };
  }
  return { allowed: true, serverDryRun, blockedReason: null };
}

function renderConfigMapYaml(
  name: string,
  namespace: string,
  labels: Record<string, string>,
  annotations: Record<string, string>,
  corefile: string,
  snapshotMetadata: string
): string {
  return [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    '  labels:',
    ...yamlStringMap(labels, 4),
    '  annotations:',
    ...yamlStringMap(annotations, 4),
    'data:',
    '  Corefile: |',
    ...indentBlock(corefile, 4),
    '  mx-zone-snapshot.json: |',
    ...indentBlock(snapshotMetadata, 4)
  ].join('\n');
}

function yamlStringMap(map: Record<string, string>, spaces: number): string[] {
  const prefix = ' '.repeat(spaces);
  return Object.entries(map).map(([key, value]) => `${prefix}${key}: ${JSON.stringify(value)}`);
}

function indentBlock(value: string, spaces: number): string[] {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`);
}

function dnsPolicyZoneNames(policy: DnsPolicy): string[] {
  const suffixZones = policy.whitelist.suffixes.map((suffix) => normalizeDomain(suffix).replace(/^\./, ''));
  const exactZones = policy.whitelist.exactDomains
    .map(normalizeDomain)
    .filter((domain) => !suffixZones.some((suffix) => domain.endsWith(`.${suffix}`)));
  return [...new Set([...suffixZones, ...exactZones])].sort();
}

function dnsZoneRecords(
  policy: DnsPolicy,
  routes: DnsReverseProxyRoute[],
  targetServiceDns: string
): DnsZoneRecord[] {
  const records = new Map<string, DnsZoneRecord>();
  for (const domain of policy.whitelist.exactDomains.map(normalizeDomain)) {
    records.set(domain, dnsRecordForTarget(domain, targetServiceDns, 'dns-policy'));
  }
  for (const route of routes.filter((row) => row.enabled)) {
    const host = normalizeDomain(route.host);
    const target = hostFromUrl(route.targetUrl) || targetServiceDns;
    records.set(host, dnsRecordForTarget(host, target, 'reverse-proxy-route'));
  }
  return [...records.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function dnsRecordForTarget(
  name: string,
  target: string,
  source: DnsZoneRecord['source']
): DnsZoneRecord {
  return {
    name,
    type: isIpv4(target) ? 'A' : 'CNAME',
    value: target,
    ttlSeconds: 30,
    source
  };
}

function corefileServerBlock(zone: string, records: DnsZoneRecord[], targetServiceDns: string): string {
  const rewrites = records
    .filter((record) => record.type === 'CNAME' && (record.name === zone || record.name.endsWith(`.${zone}`)))
    .map((record) => `  rewrite name exact ${record.name} ${record.value}`);
  const hosts = records
    .filter((record) => record.type === 'A' && (record.name === zone || record.name.endsWith(`.${zone}`)))
    .map((record) => `    ${record.value} ${record.name}`);
  const hostsBlock = hosts.length > 0
    ? ['  hosts {', ...hosts, '    fallthrough', '  }']
    : [];
  return [
    `${zone}:53 {`,
    '  errors',
    '  log',
    ...rewrites,
    ...hostsBlock,
    '  cache 30',
    '  forward . /etc/resolv.conf',
    '}'
  ].join('\n');
}

function hostFromUrl(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function isIpv4(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
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
      routeId: 'sdk.gateway.access.evaluate',
      path: '/internal/v1/sdk/gateway/access/evaluate',
      upstreamModule: 'sdk-gateway',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Evaluates whether a principal can call a SDK Gateway route.'
    },
    {
      routeId: 'sdk.config.snapshot',
      path: '/internal/v1/sdk/config/snapshot',
      upstreamModule: 'config-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Issues a signed policy snapshot that aggregates platform control-plane decisions.'
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
      routeId: 'sdk.dns.zone',
      path: '/internal/v1/sdk/dns/zone',
      upstreamModule: 'dns-control',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Builds a signed Internal CoreDNS zone snapshot from DNS policy.'
    },
    {
      routeId: 'sdk.dns.coredns-configmap',
      path: '/internal/v1/sdk/dns/coredns-configmap',
      upstreamModule: 'dns-control',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Renders or records a shadow sync for a CoreDNS ConfigMap manifest.'
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
      configSnapshotUrl: '/internal/v1/sdk/config/snapshot',
      dnsPolicyUrl: '/internal/v1/sdk/dns/policy',
      dnsEvaluateUrl: '/internal/v1/sdk/dns/evaluate',
      dnsZoneUrl: '/internal/v1/sdk/dns/zone',
      dnsCoreDnsConfigMapUrl: '/internal/v1/sdk/dns/coredns-configmap',
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
  enrollment: AnonymousEnrollment | null,
  authOverride?: TokenIntrospectionResult,
  principalOverride?: PlatformPrincipal | null
): PrincipalContext {
  const auth = authOverride ?? introspectShadowToken(config, {
    token: input.token,
    audience: input.audience,
    requestId: input.requestId
  });
  const boundUserId = input.userId ?? enrollment?.userId ?? null;
  const anonymousPrincipalId = input.anonymousPrincipalId ?? enrollment?.anonymousPrincipalId ?? null;
  let principal = auth.principal ?? principalOverride ?? null;
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
  return evaluateSdkGatewayRoute(principal, routeId).allowed;
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

export function createConfigPolicySnapshot(
  config: RuntimeConfig,
  input: ConfigPolicySnapshotInput,
  parts: {
    snapshotId: string;
    version: number;
    app: AppCenterApp | null;
    principal: PlatformPrincipal;
    enrollment: AnonymousEnrollment | null;
    launcherNetwork: LauncherNetworkSnapshot;
    dnsPolicy: DnsPolicy;
    reverseProxyRoutes: DnsReverseProxyRoute[];
    sdkGateway: SdkGatewayManifest;
    launcherRelease: ReleasePolicyDecision;
    appRelease: ReleasePolicyDecision;
  }
): ConfigPolicySnapshot {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);
  const appId = input.appId?.trim() || parts.app?.appId || 'h2o';
  const productId = input.productId?.trim() || parts.enrollment?.productId || appId;
  const unsigned = {
    snapshotId: parts.snapshotId,
    environment: config.environment,
    siteId: config.siteId,
    version: parts.version,
    productId,
    appId,
    channel: input.channel?.trim() || (config.environment === 'shadow' ? 'shadow' : 'stable'),
    installId: parts.enrollment?.installId ?? input.installId ?? null,
    deviceId: parts.enrollment?.deviceId ?? input.deviceId ?? null,
    anonymousPrincipalId: parts.enrollment?.anonymousPrincipalId ?? null,
    userId: parts.principal.userId ?? parts.enrollment?.userId ?? input.userId ?? null,
    principal: parts.principal,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    source: {
      configCenter: 'v1-shadow' as const,
      requestId: input.requestId ?? null
    },
    rollout: {
      segmentId: 'shadow-all',
      percentage: 100,
      reasons: ['shadow environment receives the full policy snapshot']
    },
    policies: {
      app: parts.app,
      permissionPolicy: {
        appId,
        declaredScopes: parts.app?.permissions ?? [],
        defaultDecision: 'requires-appcenter-grant' as const
      },
      launcherNetwork: parts.launcherNetwork,
      dns: {
        policy: parts.dnsPolicy,
        reverseProxyRoutes: parts.reverseProxyRoutes
      },
      sdkGateway: parts.sdkGateway,
      release: {
        launcher: parts.launcherRelease,
        app: parts.appRelease
      },
      observability: {
        level: 'info',
        sinks: config.observabilitySinks
      }
    }
  };
  const digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  return {
    ...unsigned,
    signatures: {
      algorithm: 'sha256-dev-digest',
      digest,
      issuer: 'mx-config-center-shadow'
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

export function buildReleaseManagementPlan(
  config: RuntimeConfig,
  input: ReleaseManagementPlanInput,
  parts: {
    planId: string;
    releaseId: string;
    launcherDecision: ReleasePolicyDecision;
    appDecision: ReleasePolicyDecision;
    testRun: TestRun;
    gate: TestGateVerdict;
    createdAt: string;
  }
): ReleaseManagementPlan {
  const requiresApproval = parts.launcherDecision.requiresGate
    || parts.appDecision.requiresGate
    || parts.launcherDecision.updateMode === 'mandatory'
    || parts.appDecision.updateMode === 'mandatory';
  const readyToPromote = parts.gate.verdict === 'passed'
    && parts.launcherDecision.updateAvailable
    && parts.appDecision.updateAvailable;
  const nextActions: string[] = [];
  if (parts.gate.verdict !== 'passed') {
    nextActions.push('complete-required-e2e-gate');
  }
  if (requiresApproval) {
    nextActions.push('request-release-approval');
  }
  if (readyToPromote) {
    nextActions.push('open-canary-or-shadow-rollout');
  }
  if (parts.launcherDecision.rollbackRequired || parts.appDecision.rollbackRequired) {
    nextActions.push('prepare-rollback-slot');
  }
  return {
    planId: parts.planId,
    releaseId: parts.releaseId,
    environment: config.environment,
    channel: input.channel?.trim() || 'shadow',
    installId: input.installId ?? null,
    userId: input.userId ?? null,
    createdBy: input.createdBy?.trim() || 'release-admin-shadow',
    components: {
      launcher: parts.launcherDecision,
      app: parts.appDecision
    },
    test: {
      suiteId: parts.testRun.suiteId,
      topology: parts.testRun.topology,
      sites: parts.testRun.sites,
      run: parts.testRun,
      gate: parts.gate
    },
    decisions: {
      readyToPromote,
      requiresApproval,
      canaryAllowed: readyToPromote,
      rollbackRequired: parts.launcherDecision.rollbackRequired || parts.appDecision.rollbackRequired,
      nextActions
    },
    createdAt: parts.createdAt
  };
}

export function buildSiteSlotPlan(
  config: RuntimeConfig,
  input: SiteSlotPlanInput,
  planId: string,
  createdAt = new Date().toISOString()
): SiteSlotPlan {
  const profile = input.sshProfile ?? null;
  const kind: SiteSlotKind = (input.kind ?? profile?.kind) === 'oversea' ? 'oversea' : 'domestic';
  const siteId = input.siteId?.trim() || profile?.siteId || `${kind}-main`;
  const profileMatches = Boolean(profile && profile.kind === kind && profile.siteId === siteId);
  const activeProfile = profileMatches && profile?.status === 'active' ? profile : null;
  const host = input.host?.trim() || activeProfile?.host || null;
  const sshUser = input.sshUser?.trim() || activeProfile?.sshUser || 'root';
  const sshPort = input.sshPort && input.sshPort > 0 ? input.sshPort : activeProfile?.sshPort ?? 22;
  const rootAccess = input.rootAccess === true || sshUser === 'root';
  const networkMode = siteSlotNetworkMode(kind, input);
  const requiresOversea = kind === 'domestic' && networkMode === 'oversea-assisted';
  const warnings = siteSlotWarnings(kind, input, profile, profileMatches, host, rootAccess, networkMode);
  const sshProfileId = input.sshProfileId?.trim() || profile?.profileId || null;
  const status = host && warnings.every((warning) => !warning.startsWith('blocked:'))
    ? 'ready-for-preflight'
    : warnings.some((warning) => warning.startsWith('blocked:')) ? 'blocked' : 'planned';
  const services = siteSlotServices(kind);
  return {
    planId,
    siteId,
    kind,
    environment: config.environment,
    status,
    host,
    ssh: {
      user: sshUser,
      port: sshPort,
      rootAccess,
      rootRequired: kind === 'domestic',
      profileId: sshProfileId,
      profileSource: profile ? 'config-center' : host ? 'request-body' : 'none',
      profileStatus: profile?.status ?? null,
      profileWarnings: profile?.warnings ?? []
    },
    network: {
      mode: networkMode,
      requiresOversea,
      overseaSiteId: input.overseaSiteId?.trim() || (requiresOversea ? 'oversea-main' : null),
      overseaHost: input.overseaHost?.trim() || null,
      qpTunnelCliMode: qpTunnelCliMode(kind, networkMode),
      notes: siteSlotNetworkNotes(kind, networkMode)
    },
    access: siteSlotAccess(kind),
    services,
    preflightChecks: siteSlotPreflightChecks(kind, input, host, sshUser, sshPort, networkMode),
    deploymentPhases: siteSlotDeploymentPhases(kind, input, host, sshUser, sshPort, networkMode),
    warnings,
    nextActions: siteSlotNextActions(kind, status, networkMode, input),
    createdBy: input.createdBy?.trim() || 'internal-admin-shadow',
    createdAt
  };
}

export function buildSiteSlotSshProfile(
  config: RuntimeConfig,
  input: SiteSlotSshProfileInput,
  previous: SiteSlotSshProfile | null,
  now = new Date().toISOString()
): SiteSlotSshProfile {
  const kind: SiteSlotKind = input.kind === 'oversea' ? 'oversea' : 'domestic';
  const siteId = input.siteId?.trim() || previous?.siteId || `${kind}-main`;
  const profileId = input.profileId?.trim() || previous?.profileId || `sshprof_${siteId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const sshPort = input.sshPort && input.sshPort > 0 ? Math.floor(input.sshPort) : previous?.sshPort ?? 22;
  const strictHostKeyChecking = siteSlotStrictHostKeyChecking(input.strictHostKeyChecking ?? previous?.strictHostKeyChecking);
  const connectTimeoutSeconds = input.connectTimeoutSeconds && input.connectTimeoutSeconds > 0
    ? Math.min(Math.floor(input.connectTimeoutSeconds), 120)
    : previous?.connectTimeoutSeconds ?? 10;
  const batchMode = input.batchMode === 'no' ? 'no' : previous?.batchMode ?? 'yes';
  const status = input.status === 'paused' ? 'paused' : 'active';
  const warnings: string[] = [];
  const identityFile = input.identityFile?.trim() || previous?.identityFile || null;
  const knownHostsFile = input.knownHostsFile?.trim() || previous?.knownHostsFile || null;
  const hostKeyAlias = input.hostKeyAlias?.trim() || previous?.hostKeyAlias || null;
  if (!identityFile) warnings.push('missing: identityFile is required before artifact-push-remote-ssh can execute');
  if (!knownHostsFile) warnings.push('missing: knownHostsFile is required before artifact-push-remote-ssh can verify host keys');
  if (!hostKeyAlias) warnings.push('recommended: hostKeyAlias pins the expected known_hosts entry for this slot');
  return {
    profileId,
    siteId,
    kind,
    environment: config.environment,
    host: input.host?.trim() || previous?.host || null,
    sshUser: input.sshUser?.trim() || previous?.sshUser || 'root',
    sshPort,
    identityFile,
    knownHostsFile,
    hostKeyAlias,
    strictHostKeyChecking,
    connectTimeoutSeconds,
    batchMode,
    status,
    source: 'config-center',
    warnings,
    createdBy: previous?.createdBy || input.requestedBy?.trim() || 'config-center',
    createdAt: previous?.createdAt || now,
    updatedBy: input.requestedBy?.trim() || previous?.updatedBy || 'config-center',
    updatedAt: now
  };
}

export function buildRuntimeFeaturePolicy(
  config: RuntimeConfig,
  input: RuntimeFeaturePolicyInput,
  previous: RuntimeFeaturePolicy | null,
  now = new Date().toISOString()
): RuntimeFeaturePolicy {
  const featureKey = input.featureKey?.trim() || previous?.featureKey || 'unknown.feature';
  const scopeKind = runtimeFeatureScopeKind(input.scopeKind ?? previous?.scopeKind);
  const scopeId = scopeKind === 'global' ? null : input.scopeId?.trim() || previous?.scopeId || null;
  const mode = runtimeFeatureMode(input.mode ?? previous?.mode);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : previous?.enabled ?? mode !== 'disabled';
  const expiresAt = input.expiresAt?.trim() || previous?.expiresAt || null;
  const requiresApproval = typeof input.requiresApproval === 'boolean' ? input.requiresApproval : previous?.requiresApproval ?? true;
  const reason = input.reason?.trim() || previous?.reason || null;
  return {
    policyId: runtimeFeaturePolicyId(featureKey, scopeKind, scopeId),
    featureKey,
    environment: config.environment,
    scopeKind,
    scopeId,
    enabled,
    mode: enabled ? mode : 'disabled',
    expiresAt,
    requiresApproval,
    reason,
    createdBy: previous?.createdBy || input.requestedBy?.trim() || 'config-center',
    createdAt: previous?.createdAt || now,
    updatedBy: input.requestedBy?.trim() || previous?.updatedBy || 'config-center',
    updatedAt: now
  };
}

export function buildSiteSlotExecutionRun(
  config: RuntimeConfig,
  plan: SiteSlotPlan,
  input: SiteSlotExecutionInput,
  runId: string,
  createdAt = new Date().toISOString()
): SiteSlotExecutionRun {
  const action = input.action === 'apply' ? 'apply' : 'preflight';
  const mode = siteSlotExecutionMode(input.mode, config);
  const confirmApply = input.confirmApply === true;
  const steps = action === 'apply' ? siteSlotApplySteps(plan) : siteSlotPreflightSteps(plan);
  const warnings = siteSlotExecutionWarnings(plan, action, mode, confirmApply);
  const status = siteSlotExecutionStatus(plan, action, mode, confirmApply, warnings);
  return {
    runId,
    planId: plan.planId,
    siteId: plan.siteId,
    kind: plan.kind,
    environment: plan.environment,
    action,
    mode,
    status,
    dryRun: true,
    confirmApply,
    remoteExecution: {
      supported: false,
      boundary: mode === 'ssh' ? 'future-ssh-runner' : 'manifest-only',
      reason: mode === 'ssh'
        ? 'Site Slot Executor V1 records an SSH execution intent but does not run remote commands yet.'
        : 'Site Slot Executor V1 emits an auditable command manifest for Admin/manual execution.'
    },
    gates: {
      planStatus: plan.status,
      applyConfirmed: action === 'preflight' || confirmApply,
      remoteExecutionSupported: false,
      requiredStepCount: steps.filter((step) => step.requiresRoot || step.expected.length > 0).length
    },
    warnings,
    steps,
    nextActions: siteSlotExecutionNextActions(plan, action, mode, status, confirmApply),
    createdBy: input.requestedBy?.trim() || plan.createdBy,
    createdAt
  };
}

export function buildSiteSlotRunnerSession(
  config: RuntimeConfig,
  execution: SiteSlotExecutionRun,
  input: SiteSlotRunnerStartInput,
  sessionId: string,
  startedAt = new Date().toISOString()
): SiteSlotRunnerSession {
  const mode = input.mode === 'remote-ssh' ? 'remote-ssh' : 'simulate';
  const confirmRemoteExecution = input.confirmRemoteExecution === true;
  const warnings = siteSlotRunnerWarnings(config, execution, mode, confirmRemoteExecution);
  const status = siteSlotRunnerStatus(execution, mode, warnings);
  const stepResults = siteSlotRunnerStepResults(execution, mode, status, startedAt);
  const finishedAt = status === 'queued' ? null : startedAt;
  return {
    sessionId,
    runId: execution.runId,
    planId: execution.planId,
    siteId: execution.siteId,
    kind: execution.kind,
    environment: execution.environment,
    mode,
    status,
    dryRun: mode === 'simulate',
    confirmRemoteExecution,
    gates: {
      executionStatus: execution.status,
      remoteExecutionEnabled: config.siteSlotRunnerRemoteExecutionEnabled,
      remoteExecutionConfirmed: confirmRemoteExecution,
      stepCount: execution.steps.length
    },
    warnings,
    stepResults,
    currentWorkerJobId: null,
    currentReportId: null,
    rollbackPlan: null,
    nextActions: siteSlotRunnerNextActions(status, mode),
    createdBy: input.requestedBy?.trim() || execution.createdBy,
    startedAt,
    finishedAt
  };
}

export function buildSiteSlotWorkerJob(
  session: SiteSlotRunnerSession,
  input: SiteSlotWorkerJobInput,
  jobId: string,
  createdAt = new Date().toISOString()
): SiteSlotWorkerJob {
  const workerKind = siteSlotWorkerKind(input.workerKind, session);
  const approvalRequired = session.mode === 'remote-ssh';
  const approvalId = input.approvalId?.trim() || null;
  const changeWindowRequired = session.mode === 'remote-ssh';
  const retryLimit = input.retryLimit && input.retryLimit > 0 ? Math.min(Math.floor(input.retryLimit), 5) : 1;
  const warnings = siteSlotWorkerJobWarnings(session, approvalRequired, approvalId);
  const status = warnings.some((warning) => warning.startsWith('blocked:')) ? 'blocked' : 'ready';
  return {
    jobId,
    contractVersion: 'site-slot-worker-v1',
    sessionId: session.sessionId,
    runId: session.runId,
    planId: session.planId,
    siteId: session.siteId,
    kind: session.kind,
    environment: session.environment,
    mode: session.mode,
    status,
    dryRun: session.dryRun,
    worker: {
      workerId: input.workerId?.trim() || `${workerKind}-${session.siteId}`,
      kind: workerKind
    },
    approval: {
      required: approvalRequired,
      approvalId,
      status: approvalRequired ? approvalId ? 'recorded' : 'missing' : 'not-required'
    },
    changeWindow: {
      start: input.changeWindowStart?.trim() || null,
      end: input.changeWindowEnd?.trim() || null,
      required: changeWindowRequired
    },
    retryPolicy: {
      maxAttempts: retryLimit,
      stopOnFailure: true
    },
    rollbackPolicy: {
      strategy: input.rollbackStrategy?.trim() || (session.kind === 'domestic' ? 'restore-previous-wireguard-and-compose' : 'restore-previous-access-stack'),
      requiredOnFailure: session.mode === 'remote-ssh'
    },
    steps: session.stepResults.map((step) => ({
      stepId: step.stepId,
      sourceId: step.sourceId,
      order: step.order,
      target: step.target,
      command: step.command,
      requiresRoot: step.command.includes('root@') || step.command.includes('/etc/wireguard') || step.command.includes('systemctl'),
      timeoutSeconds: step.command.startsWith('Check ') ? 30 : 300,
      stopOnFailure: true,
      redactOutput: step.command.includes('subscription') || step.command.includes('token') || step.command.includes('DATABASE_URL')
    })),
    warnings,
    currentReportId: null,
    rollbackPlan: null,
    updatedAt: null,
    nextActions: siteSlotWorkerJobNextActions(status, session.mode),
    createdBy: input.requestedBy?.trim() || session.createdBy,
    createdAt
  };
}

export function buildSiteSlotWorkerReport(
  job: SiteSlotWorkerJob,
  input: SiteSlotWorkerReportInput,
  reportId: string,
  createdAt = new Date().toISOString()
): SiteSlotWorkerReport {
  const status = siteSlotWorkerReportStatus(input.status);
  const rollbackPlan = buildSiteSlotRollbackPlan(job, status, reportId, createdAt);
  return {
    reportId,
    jobId: job.jobId,
    sessionId: job.sessionId,
    runId: job.runId,
    planId: job.planId,
    siteId: job.siteId,
    environment: job.environment,
    workerId: input.workerId?.trim() || job.worker.workerId,
    status,
    message: input.message?.trim() || null,
    stepReports: siteSlotWorkerStepReports(job, input.stepReports ?? [], status, createdAt),
    rollbackPlan,
    nextActions: siteSlotWorkerReportNextActions(status),
    createdAt
  };
}

export function applySiteSlotWorkerReportState(
  job: SiteSlotWorkerJob,
  session: SiteSlotRunnerSession,
  report: SiteSlotWorkerReport
): {
  job: SiteSlotWorkerJob;
  session: SiteSlotRunnerSession;
} {
  const jobStatus = siteSlotWorkerJobStatusFromReport(report);
  const sessionStatus = siteSlotRunnerSessionStatusFromReport(report);
  const nextJob: SiteSlotWorkerJob = {
    ...job,
    status: jobStatus,
    currentReportId: report.reportId,
    rollbackPlan: report.rollbackPlan,
    updatedAt: report.createdAt,
    nextActions: siteSlotWorkerJobStateNextActions(jobStatus)
  };
  const nextSession: SiteSlotRunnerSession = {
    ...session,
    status: sessionStatus,
    currentWorkerJobId: job.jobId,
    currentReportId: report.reportId,
    rollbackPlan: report.rollbackPlan,
    finishedAt: report.status === 'running' ? null : report.createdAt,
    nextActions: siteSlotRunnerStateNextActions(sessionStatus)
  };
  return { job: nextJob, session: nextSession };
}

export function buildSiteSlotRollbackExecution(
  report: SiteSlotWorkerReport,
  input: SiteSlotRollbackExecutionInput,
  rollbackExecutionId: string,
  createdAt = new Date().toISOString()
): SiteSlotRollbackExecution {
  const mode = input.mode === 'manual' ? 'manual' : 'simulate';
  const confirmRollback = input.confirmRollback === true;
  const warnings = siteSlotRollbackExecutionWarnings(report, confirmRollback);
  const status = warnings.some((warning) => warning.startsWith('blocked:')) ? 'blocked' : 'ready';
  return {
    rollbackExecutionId,
    contractVersion: 'site-slot-rollback-v1',
    rollbackPlanId: report.rollbackPlan?.rollbackPlanId ?? null,
    sourceReportId: report.reportId,
    jobId: report.jobId,
    sessionId: report.sessionId,
    runId: report.runId,
    planId: report.planId,
    siteId: report.siteId,
    environment: report.environment,
    mode,
    status,
    dryRun: mode === 'simulate',
    confirmRollback,
    rollbackPlan: report.rollbackPlan,
    gates: {
      workerReportStatus: report.status,
      rollbackPlanStatus: report.rollbackPlan?.status ?? null,
      rollbackRequired: report.rollbackPlan?.required ?? false,
      rollbackConfirmed: confirmRollback,
      stepCount: report.rollbackPlan?.steps.length ?? 0
    },
    warnings,
    stepResults: siteSlotRollbackExecutionStepResults(report, status),
    currentRollbackReportId: null,
    nextActions: siteSlotRollbackExecutionNextActions(status, mode, report.rollbackPlan?.required ?? false),
    createdBy: input.requestedBy?.trim() || report.workerId,
    createdAt,
    updatedAt: null
  };
}

export function buildSiteSlotRollbackReport(
  execution: SiteSlotRollbackExecution,
  input: SiteSlotRollbackReportInput,
  rollbackReportId: string,
  createdAt = new Date().toISOString()
): SiteSlotRollbackReport {
  const status = siteSlotRollbackReportStatus(input.status);
  return {
    rollbackReportId,
    rollbackExecutionId: execution.rollbackExecutionId,
    rollbackPlanId: execution.rollbackPlanId,
    sourceReportId: execution.sourceReportId,
    jobId: execution.jobId,
    sessionId: execution.sessionId,
    runId: execution.runId,
    planId: execution.planId,
    siteId: execution.siteId,
    environment: execution.environment,
    workerId: input.workerId?.trim() || execution.createdBy,
    status,
    message: input.message?.trim() || null,
    stepReports: siteSlotRollbackStepReports(execution, input.stepReports ?? [], status, createdAt),
    nextActions: siteSlotRollbackReportNextActions(status),
    createdAt
  };
}

export function applySiteSlotRollbackReportState(
  execution: SiteSlotRollbackExecution,
  report: SiteSlotRollbackReport
): SiteSlotRollbackExecution {
  const status = siteSlotRollbackExecutionStatusFromReport(report);
  return {
    ...execution,
    status,
    currentRollbackReportId: report.rollbackReportId,
    stepResults: siteSlotRollbackExecutionStepResultsFromReport(execution, report),
    updatedAt: report.createdAt,
    nextActions: siteSlotRollbackExecutionStateNextActions(status)
  };
}

function siteSlotWorkerKind(
  value: SiteSlotWorkerJobInput['workerKind'],
  session: SiteSlotRunnerSession
): SiteSlotWorkerJob['worker']['kind'] {
  if (value === 'internal-runner' || value === 'domestic-runner' || value === 'oversea-site-agent' || value === 'admin-manual') {
    return value;
  }
  if (session.mode === 'simulate') return 'internal-runner';
  return session.kind === 'oversea' ? 'oversea-site-agent' : 'domestic-runner';
}

function siteSlotWorkerJobWarnings(
  session: SiteSlotRunnerSession,
  approvalRequired: boolean,
  approvalId: string | null
): string[] {
  const warnings = [...session.warnings];
  if (session.status !== 'completed' && session.status !== 'queued') {
    warnings.push(`blocked: runner session must be completed or queued before creating a worker job; current status is ${session.status}`);
  }
  if (approvalRequired && !approvalId) {
    warnings.push('blocked: remote worker job requires approvalId');
  }
  return warnings;
}

function siteSlotWorkerJobNextActions(
  status: SiteSlotWorkerJob['status'],
  mode: SiteSlotRunnerSession['mode']
): string[] {
  if (status === 'blocked') return ['review-worker-job-gates', 'provide-approval-or-create-ready-runner-session'];
  if (mode === 'simulate') return ['submit-simulated-worker-report', 'review-contract-before-remote-worker'];
  return ['dispatch-to-site-agent-or-ssh-worker', 'stream-step-reports', 'watch-change-window'];
}

function siteSlotWorkerReportStatus(value: SiteSlotWorkerReportInput['status']): SiteSlotWorkerReportStatus {
  if (value === 'running' || value === 'passed' || value === 'failed' || value === 'blocked') return value;
  return 'running';
}

function siteSlotWorkerStepReports(
  job: SiteSlotWorkerJob,
  inputs: SiteSlotWorkerReportInput['stepReports'],
  defaultStatus: SiteSlotWorkerReportStatus,
  now: string
): SiteSlotWorkerReport['stepReports'] {
  const byStepId = new Map((inputs ?? []).map((step) => [step.stepId, step]));
  return job.steps.map((step) => {
    const input = step.stepId ? byStepId.get(step.stepId) : null;
    const status = siteSlotWorkerReportStatus(input?.status ?? defaultStatus);
    return {
      stepId: step.stepId,
      sourceId: step.sourceId,
      order: step.order,
      status,
      exitCode: input?.exitCode ?? (status === 'passed' ? 0 : null),
      stdout: input?.stdout ?? null,
      stderr: input?.stderr ?? null,
      startedAt: input?.startedAt ?? now,
      finishedAt: input?.finishedAt ?? (status === 'running' ? null : now),
      attempt: input?.attempt && input.attempt > 0 ? Math.floor(input.attempt) : 1
    };
  });
}

function siteSlotWorkerReportNextActions(status: SiteSlotWorkerReportStatus): string[] {
  if (status === 'running') return ['continue-streaming-step-reports'];
  if (status === 'passed') return ['record-slot-smoke-results', 'close-change-window', 'sync-observability-evidence'];
  if (status === 'failed') return ['stop-remaining-steps', 'preserve-logs', 'prepare-rollback-policy'];
  return ['review-blocker', 'hold-runner-session'];
}

function buildSiteSlotRollbackPlan(
  job: SiteSlotWorkerJob,
  status: SiteSlotWorkerReportStatus,
  reportId: string,
  createdAt: string
): SiteSlotRollbackPlan | null {
  if (status !== 'failed') return null;
  const strategy = job.rollbackPolicy.strategy;
  return {
    rollbackPlanId: `rollback_${reportId.replace(/^slotreport_/, '')}`,
    jobId: job.jobId,
    sessionId: job.sessionId,
    runId: job.runId,
    planId: job.planId,
    siteId: job.siteId,
    environment: job.environment,
    required: job.rollbackPolicy.requiredOnFailure,
    status: 'planned',
    reason: 'worker report failed',
    strategy,
    steps: [
      {
        stepId: 'rollback-collect-evidence',
        order: 1,
        target: job.kind,
        title: 'Collect failure evidence',
        command: `Preserve worker logs, step outputs, and current slot state for ${job.jobId}`,
        requiresApproval: false
      },
      {
        stepId: 'rollback-restore-previous-state',
        order: 2,
        target: job.kind,
        title: 'Restore previous slot state',
        command: `Apply rollback strategy: ${strategy}`,
        requiresApproval: job.rollbackPolicy.requiredOnFailure
      },
      {
        stepId: 'rollback-smoke',
        order: 3,
        target: job.kind,
        title: 'Run rollback smoke',
        command: 'Run slot smoke checks and record rollback evidence',
        requiresApproval: false
      }
    ],
    createdAt
  };
}

function siteSlotRollbackExecutionWarnings(
  report: SiteSlotWorkerReport,
  confirmRollback: boolean
): string[] {
  const warnings: string[] = [];
  if (report.status !== 'failed') {
    warnings.push(`blocked: rollback execution requires a failed worker report; current status is ${report.status}`);
  }
  if (!report.rollbackPlan) {
    warnings.push('blocked: worker report does not include a rollback plan');
  }
  if (report.rollbackPlan?.required && !confirmRollback) {
    warnings.push('blocked: rollback plan requires confirmRollback=true');
  }
  return warnings;
}

function siteSlotRollbackExecutionStepResults(
  report: SiteSlotWorkerReport,
  status: SiteSlotRollbackExecution['status']
): SiteSlotRollbackExecution['stepResults'] {
  return (report.rollbackPlan?.steps ?? []).map((step) => ({
    stepId: step.stepId,
    order: step.order,
    target: step.target,
    status: status === 'blocked' ? 'blocked' : 'pending',
    command: step.command,
    exitCode: null,
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null
  }));
}

function siteSlotRollbackExecutionNextActions(
  status: SiteSlotRollbackExecution['status'],
  mode: SiteSlotRollbackExecution['mode'],
  rollbackRequired: boolean
): string[] {
  if (status === 'blocked') {
    return rollbackRequired
      ? ['review-rollback-plan', 'rerun-rollback-with-confirmRollback-true']
      : ['review-worker-report', 'create-failed-worker-report-with-rollback-plan'];
  }
  if (mode === 'simulate') return ['submit-simulated-rollback-report', 'preserve-recovery-evidence'];
  return ['execute-rollback-steps', 'submit-rollback-report', 'preserve-recovery-evidence'];
}

function siteSlotRollbackReportStatus(value: SiteSlotRollbackReportInput['status']): SiteSlotRollbackReportStatus {
  if (value === 'running' || value === 'passed' || value === 'failed' || value === 'blocked') return value;
  return 'running';
}

function siteSlotRollbackStepReports(
  execution: SiteSlotRollbackExecution,
  inputs: SiteSlotRollbackReportInput['stepReports'],
  defaultStatus: SiteSlotRollbackReportStatus,
  now: string
): SiteSlotRollbackReport['stepReports'] {
  const byStepId = new Map((inputs ?? []).map((step) => [step.stepId, step]));
  return execution.stepResults.map((step) => {
    const input = step.stepId ? byStepId.get(step.stepId) : null;
    const status = siteSlotRollbackReportStatus(input?.status ?? defaultStatus);
    return {
      stepId: step.stepId,
      order: step.order,
      target: step.target,
      status,
      exitCode: input?.exitCode ?? (status === 'passed' ? 0 : null),
      stdout: input?.stdout ?? null,
      stderr: input?.stderr ?? null,
      startedAt: input?.startedAt ?? now,
      finishedAt: input?.finishedAt ?? (status === 'running' ? null : now),
      attempt: input?.attempt && input.attempt > 0 ? Math.floor(input.attempt) : 1
    };
  });
}

function siteSlotRollbackReportNextActions(status: SiteSlotRollbackReportStatus): string[] {
  if (status === 'running') return ['continue-rollback-steps'];
  if (status === 'passed') return ['record-rollback-smoke-results', 'close-rollback-window', 'sync-observability-evidence'];
  if (status === 'failed') return ['preserve-rollback-failure-evidence', 'escalate-site-recovery'];
  return ['review-rollback-blocker', 'hold-rollback-window'];
}

function siteSlotRollbackExecutionStatusFromReport(report: SiteSlotRollbackReport): SiteSlotRollbackExecution['status'] {
  if (report.status === 'blocked') return 'blocked';
  return report.status;
}

function siteSlotRollbackExecutionStepResultsFromReport(
  execution: SiteSlotRollbackExecution,
  report: SiteSlotRollbackReport
): SiteSlotRollbackExecution['stepResults'] {
  const byStepId = new Map(report.stepReports.map((step) => [step.stepId, step]));
  return execution.stepResults.map((step) => {
    const input = byStepId.get(step.stepId);
    if (!input) return step;
    return {
      ...step,
      status: input.status,
      exitCode: input.exitCode,
      output: input.stdout,
      error: input.stderr,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt
    };
  });
}

function siteSlotRollbackExecutionStateNextActions(status: SiteSlotRollbackExecution['status']): string[] {
  if (status === 'running') return ['continue-rollback-steps'];
  if (status === 'passed') return ['record-rollback-smoke-results', 'close-rollback-window', 'sync-observability-evidence'];
  if (status === 'failed') return ['preserve-rollback-failure-evidence', 'escalate-site-recovery'];
  if (status === 'blocked') return ['review-rollback-blocker'];
  return ['execute-rollback-steps', 'submit-rollback-report'];
}

function siteSlotWorkerJobStatusFromReport(report: SiteSlotWorkerReport): SiteSlotWorkerJob['status'] {
  if (report.status === 'failed' && report.rollbackPlan?.required) return 'rollback-required';
  if (report.status === 'failed') return 'failed';
  if (report.status === 'blocked') return 'blocked';
  return report.status;
}

function siteSlotRunnerSessionStatusFromReport(report: SiteSlotWorkerReport): SiteSlotRunnerSession['status'] {
  if (report.status === 'failed' && report.rollbackPlan?.required) return 'rollback-required';
  if (report.status === 'failed') return 'failed';
  if (report.status === 'blocked') return 'blocked';
  return report.status;
}

function siteSlotWorkerJobStateNextActions(status: SiteSlotWorkerJob['status']): string[] {
  if (status === 'running') return ['continue-streaming-step-reports'];
  if (status === 'passed') return ['record-slot-smoke-results', 'close-change-window', 'sync-observability-evidence'];
  if (status === 'rollback-required') return ['review-rollback-plan', 'approve-or-run-rollback', 'preserve-failure-evidence'];
  if (status === 'failed') return ['preserve-failure-evidence', 'review-failed-worker-job'];
  if (status === 'blocked') return ['review-worker-blocker', 'hold-change-window'];
  return ['dispatch-to-site-agent-or-ssh-worker'];
}

function siteSlotRunnerStateNextActions(status: SiteSlotRunnerSession['status']): string[] {
  if (status === 'running') return ['continue-streaming-step-reports'];
  if (status === 'passed') return ['record-slot-smoke-results', 'close-change-window'];
  if (status === 'rollback-required') return ['review-rollback-plan', 'approve-or-run-rollback'];
  if (status === 'failed') return ['preserve-failure-evidence', 'review-failed-runner-session'];
  if (status === 'blocked') return ['review-runner-blocker'];
  if (status === 'queued') return ['attach-runner-worker'];
  return ['review-simulated-steps', 'start-remote-runner-after-admin-approval'];
}

function siteSlotRunnerWarnings(
  config: RuntimeConfig,
  execution: SiteSlotExecutionRun,
  mode: SiteSlotRunnerSession['mode'],
  confirmRemoteExecution: boolean
): string[] {
  const warnings = [...execution.warnings];
  if (execution.status !== 'ready') {
    warnings.push(`blocked: execution must be ready before runner starts; current status is ${execution.status}`);
  }
  if (mode === 'remote-ssh' && !config.siteSlotRunnerRemoteExecutionEnabled) {
    warnings.push('blocked: SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED is disabled');
  }
  if (mode === 'remote-ssh' && !confirmRemoteExecution) {
    warnings.push('blocked: remote-ssh requires confirmRemoteExecution=true');
  }
  return warnings;
}

function siteSlotRunnerStatus(
  execution: SiteSlotExecutionRun,
  mode: SiteSlotRunnerSession['mode'],
  warnings: string[]
): SiteSlotRunnerSession['status'] {
  if (warnings.some((warning) => warning.startsWith('blocked:'))) return 'blocked';
  if (mode === 'remote-ssh') return 'queued';
  return execution.status === 'ready' ? 'completed' : 'blocked';
}

function siteSlotRunnerStepResults(
  execution: SiteSlotExecutionRun,
  mode: SiteSlotRunnerSession['mode'],
  status: SiteSlotRunnerSession['status'],
  now: string
): SiteSlotRunnerSession['stepResults'] {
  return execution.steps.map((step) => {
    if (status === 'completed' && mode === 'simulate') {
      return {
        stepId: step.stepId,
        sourceId: step.sourceId,
        order: step.order,
        target: step.target,
        status: 'simulated',
        command: step.command,
        exitCode: 0,
        output: `simulated: ${step.expected}`,
        error: null,
        startedAt: now,
        finishedAt: now
      };
    }
    if (status === 'queued') {
      return {
        stepId: step.stepId,
        sourceId: step.sourceId,
        order: step.order,
        target: step.target,
        status: 'pending',
        command: step.command,
        exitCode: null,
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null
      };
    }
    return {
      stepId: step.stepId,
      sourceId: step.sourceId,
      order: step.order,
      target: step.target,
      status: 'blocked',
      command: step.command,
      exitCode: null,
      output: null,
      error: 'runner gate blocked before this step started',
      startedAt: null,
      finishedAt: null
    };
  });
}

function siteSlotRunnerNextActions(
  status: SiteSlotRunnerSession['status'],
  mode: SiteSlotRunnerSession['mode']
): string[] {
  if (status === 'blocked') return ['review-runner-gates', 'fix-execution-or-enable-runner-remote-mode'];
  if (status === 'queued') return ['attach-runner-worker', 'stream-step-logs', 'record-step-results'];
  if (mode === 'simulate') return ['review-simulated-steps', 'start-remote-runner-after-admin-approval'];
  return ['record-step-results'];
}

function siteSlotExecutionMode(
  mode: SiteSlotExecutionInput['mode'],
  config: RuntimeConfig
): SiteSlotExecutionRun['mode'] {
  if (mode === 'manual' || mode === 'ssh' || mode === 'dry-run') return mode;
  return config.runnerDryRunDefault ? 'dry-run' : 'manual';
}

function siteSlotStrictHostKeyChecking(
  value: SiteSlotSshProfileInput['strictHostKeyChecking']
): SiteSlotSshProfile['strictHostKeyChecking'] {
  if (value === 'no' || value === 'ask' || value === 'accept-new') return value;
  return 'yes';
}

function siteSlotPreflightSteps(plan: SiteSlotPlan): SiteSlotExecutionRun['steps'] {
  return plan.preflightChecks.map((check, index) => ({
    stepId: `preflight-${index + 1}`,
    sourceId: check.checkId,
    title: check.title,
    target: plan.kind,
    order: index + 1,
    requiresRoot: check.requiresRoot,
    command: check.command,
    expected: check.expected,
    notes: [
      `severity=${check.severity}`,
      `stage=${check.stage}`,
      check.remediation
    ]
  }));
}

function siteSlotApplySteps(plan: SiteSlotPlan): SiteSlotExecutionRun['steps'] {
  const steps: SiteSlotExecutionRun['steps'] = [];
  for (const phase of plan.deploymentPhases) {
    for (const [commandIndex, command] of phase.commands.entries()) {
      steps.push({
        stepId: `apply-${steps.length + 1}`,
        sourceId: `${phase.phaseId}.${commandIndex + 1}`,
        title: phase.title,
        target: phase.target,
        order: steps.length + 1,
        requiresRoot: phase.target === 'domestic' && (
          phase.phaseId === 'bootstrap-domestic-egress'
          || phase.phaseId === 'install-host-wireguard'
          || command.includes('/etc/wireguard')
          || command.includes('systemctl')
        ),
        command,
        expected: phase.required ? 'Command completes before the next required deployment phase' : 'Optional phase may be skipped by policy',
        notes: [
          `phase=${phase.phaseId}`,
          `mode=${phase.mode}`,
          ...phase.notes
        ]
      });
    }
  }
  return steps;
}

function siteSlotExecutionWarnings(
  plan: SiteSlotPlan,
  action: SiteSlotExecutionRun['action'],
  mode: SiteSlotExecutionRun['mode'],
  confirmApply: boolean
): string[] {
  const warnings = [...plan.warnings];
  if (plan.status === 'blocked') warnings.push('blocked: site slot plan must be unblocked before execution');
  if (action === 'apply' && !confirmApply) warnings.push('blocked: apply requires confirmApply=true after preflight evidence is reviewed');
  if (mode === 'ssh') warnings.push('blocked: V1 does not execute SSH remotely; use the emitted manifest or connect a runner/Admin action');
  return warnings;
}

function siteSlotExecutionStatus(
  plan: SiteSlotPlan,
  action: SiteSlotExecutionRun['action'],
  mode: SiteSlotExecutionRun['mode'],
  confirmApply: boolean,
  warnings: string[]
): SiteSlotExecutionRun['status'] {
  if (warnings.some((warning) => warning.startsWith('blocked:'))) {
    return action === 'apply' && !confirmApply && plan.status !== 'blocked' && mode !== 'ssh'
      ? 'requires-confirmation'
      : 'blocked';
  }
  return 'ready';
}

function siteSlotExecutionNextActions(
  plan: SiteSlotPlan,
  action: SiteSlotExecutionRun['action'],
  mode: SiteSlotExecutionRun['mode'],
  status: SiteSlotExecutionRun['status'],
  confirmApply: boolean
): string[] {
  if (status === 'blocked') {
    if (plan.status === 'blocked') return ['resolve-site-slot-plan-blockers', 'recreate-or-update-slot-plan'];
    if (mode === 'ssh') return ['connect-site-slot-runner', 'rerun-as-dry-run-or-manual'];
    return ['review-blocking-warnings'];
  }
  if (status === 'requires-confirmation') {
    return ['review-preflight-evidence', 'rerun-apply-with-confirmApply-true'];
  }
  if (action === 'preflight') {
    return ['collect-preflight-evidence', 'create-apply-execution-after-review'];
  }
  if (confirmApply) {
    return ['execute-manifest-through-admin-or-runner', 'record-slot-smoke-results', 'sync-observability-evidence'];
  }
  return ['review-execution-manifest'];
}

function siteSlotNetworkMode(kind: SiteSlotKind, input: SiteSlotPlanInput): SiteSlotNetworkMode {
  if (kind === 'oversea') return 'direct';
  if (input.hasOutboundInternet === false && (input.overseaHost || input.overseaSiteId)) return 'oversea-assisted';
  if (input.hasOutboundInternet === false) return 'offline-manual';
  return 'direct';
}

function qpTunnelCliMode(kind: SiteSlotKind, mode: SiteSlotNetworkMode): SiteSlotPlan['network']['qpTunnelCliMode'] {
  if (kind === 'oversea') return 'server-on';
  if (mode === 'oversea-assisted') return 'server-on';
  if (mode === 'offline-manual') return 'manual';
  return 'not-required';
}

function siteSlotWarnings(
  kind: SiteSlotKind,
  input: SiteSlotPlanInput,
  profile: SiteSlotSshProfile | null,
  profileMatches: boolean,
  host: string | null,
  rootAccess: boolean,
  networkMode: SiteSlotNetworkMode
): string[] {
  const warnings: string[] = [];
  if (input.sshProfileError) warnings.push(`blocked: ${input.sshProfileError}`);
  if (profile && !profileMatches) {
    warnings.push(`blocked: SSH profile ${profile.profileId} targets ${profile.kind}/${profile.siteId}, not ${kind}/${input.siteId ?? `${kind}-main`}`);
  }
  if (profile && profileMatches && profile.status !== 'active') {
    warnings.push(`blocked: SSH profile ${profile.profileId} is ${profile.status}`);
  }
  if (profile && profileMatches) warnings.push(...profile.warnings);
  if (!host) warnings.push(`blocked: ${kind} host is required before remote preflight`);
  if (kind === 'domestic' && !rootAccess) warnings.push('blocked: domestic host WireGuard/systemd setup requires root access');
  if (input.hasDocker === false) warnings.push('warning: Docker is not confirmed; run the docker preflight check before deployment');
  if (networkMode === 'offline-manual') {
    warnings.push('blocked: domestic has no outbound internet and no Oversea bootstrap slot is configured');
  }
  if (kind === 'domestic' && input.hasOutboundInternet === false && networkMode === 'oversea-assisted') {
    warnings.push('warning: domestic outbound bootstrap depends on Oversea subscription and qp-tunnel-cli server-on');
    warnings.push('warning: materialize mx-domestic-qp-tunnel-cli-fallback before bootstrap because Domestic may not reach npm until Oversea egress is available');
  }
  return warnings;
}

function siteSlotServices(kind: SiteSlotKind): SiteSlotPlan['services'] {
  if (kind === 'oversea') {
    return {
      hostServices: ['Docker Engine bootstrap for hysteria2 access stack'],
      dockerStacks: ['docker/hysteria2-access-stack', 'mx-oversea-site-agent', 'mx-observability-forwarder'],
      dockerPreferred: true,
      hostServiceReason: 'Oversea is the external access slot. It runs Docker-managed hysteria2 and site-agent; mihomo, subscription storage, DNS authority, and routing policy stay on Internal.'
    };
  }
  return {
    hostServices: [
      'wireguard-tools',
      'wg-quick@mx-domestic',
      'systemd forwarding and firewall rules',
      '@qpjoy/tunnel-cli server-safe egress bootstrap'
    ],
    dockerStacks: ['mx-domestic-edge-api', 'mx-h2i-proxy', 'mx-snapshot-cache', 'mx-observability-forwarder'],
    dockerPreferred: true,
    hostServiceReason: 'Domestic has limited memory/disk but owns WireGuard relay and routing; network kernel pieces stay on the host, while API/cache/forwarder stay in Docker.'
  };
}

function siteSlotAccess(kind: SiteSlotKind): SiteSlotPlan['access'] {
  const reservedInternalCidrs = ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16', '10.91.0.0/16'];
  return {
    oversea: {
      role: kind === 'oversea' ? 'hysteria2-server' : 'not-required',
      components: kind === 'oversea'
        ? ['docker', 'hysteria2', 'site-agent', '@qpjoy/tunnel-cli registration']
        : ['hysteria2 endpoint consumed from Internal subscription store'],
      subscriptionSource: 'internal',
      tunnelCliRegistration: '@qpjoy/tunnel-cli'
    },
    internal: {
      mihomoDeployment: 'internal-managed',
      dnsAuthority: 'internal-coredns',
      wgRelayAccess: true,
      subscriptionStore: 'config-center',
      accountAuthority: 'internal',
      dnsPath: 'wg-relay-internal-dns',
      reservedInternalCidrs,
      domesticGatewayIp: '10.88.0.1'
    },
    hEndpoint: {
      bootstrapPath: ['WG relay', 'Internal DNS', 'Internal mihomo', 'Config Center subscription'],
      directPath: kind === 'oversea'
        ? ['Internal-issued hysteria2 account', 'Oversea hysteria2 UDP endpoint']
        : ['Internal policy', 'Domestic relay/proxy'],
      routingPolicy: 'cn-direct',
      internalOnlyRoutes: ['DNS through Internal', ...reservedInternalCidrs],
      externalPath: kind === 'oversea'
        ? ['Internal-issued subscription', 'Oversea hysteria2']
        : ['Internal-issued subscription', 'Domestic oversea-assisted egress']
    }
  };
}

function siteSlotNetworkNotes(kind: SiteSlotKind, mode: SiteSlotNetworkMode): string[] {
  if (kind === 'oversea') {
    return [
      'Oversea provides Docker-managed hysteria2 and site-agent capacity only.',
      'Internal owns mihomo, DNS authority, subscription storage, and initial account issuance.',
      'H endpoints keep cn-direct; only DNS plus 10.88.0.0/16, 10.89.0.0/16, 10.90.0.0/16, and 10.91.0.0/16 go through Internal/WG, while external traffic uses the Oversea hysteria2 subscription. Domestic defaults to 10.88.0.1.'
    ];
  }
  if (mode === 'oversea-assisted') {
    return [
      'Domestic cannot rely on direct outbound internet during bootstrap.',
      'Configure Oversea first, let Internal issue Domestic bootstrap account/subscription, then use @qpjoy/tunnel-cli server-on to register the machine without taking over inbound return routes.',
      'After Domestic can reach Internal, keep runtime traffic on policy-controlled H2I relay/proxy paths; reserve tun-on for non-public hosts or short break-glass sessions.'
    ];
  }
  if (mode === 'offline-manual') {
    return [
      'Domestic outbound internet is unavailable and no Oversea slot is configured.',
      'Prepare an offline bundle or configure Oversea before attempting remote deployment.'
    ];
  }
  return [
    'Domestic can bootstrap directly from Internal and public registries.',
    'Still keep Oversea as an optional slot for external egress and recovery.'
  ];
}

function siteSlotPreflightChecks(
  kind: SiteSlotKind,
  input: SiteSlotPlanInput,
  host: string | null,
  sshUser: string,
  sshPort: number,
  mode: SiteSlotNetworkMode
): SiteSlotPlan['preflightChecks'] {
  const remote = (command: string) => host ? `ssh -p ${sshPort} ${sshUser}@${host} '${command}'` : `ssh -p ${sshPort} ${sshUser}@<${kind}-host> '${command}'`;
  const checks: SiteSlotPlan['preflightChecks'] = [
    {
      checkId: `${kind}.ssh.root`,
      title: 'SSH and privilege check',
      stage: 'security',
      severity: kind === 'domestic' ? 'required' : 'recommended',
      requiresRoot: kind === 'domestic',
      command: remote('id -u && whoami && uname -a'),
      expected: kind === 'domestic' ? 'id -u returns 0 or sudo/root is available' : 'SSH works and user can run deployment commands',
      remediation: 'Add the Internal deploy key, confirm ssh port/security group, and grant temporary root or sudo for host-service steps.'
    },
    {
      checkId: `${kind}.capacity`,
      title: 'Capacity check',
      stage: 'remote',
      severity: 'required',
      requiresRoot: false,
      command: remote('free -m && df -h / /var/lib/docker 2>/dev/null || df -h /'),
      expected: 'Enough memory and disk for the selected slot profile',
      remediation: 'Use host WireGuard for Domestic, prune Docker images, or reduce optional services before deployment.'
    },
    {
      checkId: `${kind}.docker`,
      title: 'Docker check',
      stage: 'remote',
      severity: 'required',
      requiresRoot: false,
      command: remote('docker version && docker compose version'),
      expected: 'Docker Engine and docker compose are installed and usable',
      remediation: 'Install Docker first or use an offline Docker package bundle when outbound internet is unavailable.'
    }
  ];
  if (kind === 'domestic') {
    checks.push(
      {
        checkId: 'domestic.wireguard',
        title: 'WireGuard host service check',
        stage: 'remote',
        severity: 'required',
        requiresRoot: true,
        command: remote('command -v wg && command -v wg-quick && systemctl --version'),
        expected: 'wg, wg-quick, and systemd are available on the host',
        remediation: 'Install wireguard-tools on the host; do not run Domestic WireGuard only inside Docker for the main relay.'
      },
      {
        checkId: 'domestic.forwarding',
        title: 'Forwarding and firewall check',
        stage: 'network',
        severity: 'required',
        requiresRoot: true,
        command: remote('sysctl net.ipv4.ip_forward && (command -v nft || command -v iptables)'),
        expected: 'IPv4 forwarding and nftables/iptables are available',
        remediation: 'Enable forwarding and prepare explicit firewall rules before H2I relay traffic is accepted.'
      },
      {
        checkId: 'domestic.outbound',
        title: 'Outbound internet check',
        stage: 'network',
        severity: mode === 'direct' ? 'required' : 'recommended',
        requiresRoot: false,
        command: remote('curl -fsSI --max-time 8 https://registry-1.docker.io/v2/ || curl -fsSI --max-time 8 https://github.com/'),
        expected: mode === 'direct' ? 'Domestic can reach public registries or GitHub' : 'May fail until Oversea-assisted qp-tunnel-cli bootstrap is enabled',
        remediation: mode === 'oversea-assisted'
          ? 'Configure Oversea, consume the Internal-issued Oversea hysteria2 bootstrap subscription with @qpjoy/tunnel-cli, then run server-on before pulling images.'
          : 'Fix egress routing, DNS, firewall, or proxy before deployment.'
      },
      {
        checkId: 'domestic.qp-tunnel-cli',
        title: '@qpjoy/tunnel-cli check',
        stage: 'network',
        severity: mode === 'oversea-assisted' ? 'required' : 'optional',
        requiresRoot: mode === 'oversea-assisted',
        command: remote('command -v qp-tunnel-cli || command -v qpjoy-tunnel-cli || true'),
        expected: mode === 'oversea-assisted' ? 'qp-tunnel-cli is available for server-safe egress bootstrap' : 'Only required when Domestic cannot access outbound internet directly',
        remediation: 'Install @qpjoy/tunnel-cli from an Internal/offline bundle or scp a prebuilt binary before network bootstrap.'
      }
    );
  } else {
    checks.push({
      checkId: 'oversea.access-stack',
      title: 'Oversea access stack check',
      stage: 'remote',
      severity: 'required',
      requiresRoot: false,
      command: remote('test -d /opt/mx/current/hysteria2-access-stack || test -d /opt/mx/releases/oversea-access-stack || true'),
      expected: 'Reference hysteria2 access stack is present or can be pushed by Internal as a module artifact',
      remediation: 'Use Internal rsync/scp to push mx-oversea-access-stack.tar.gz, then run the stack preflight before exposing traffic.'
    });
  }
  if (input.internalBaseUrl) {
    checks.push({
      checkId: `${kind}.internal-reachability`,
      title: 'Internal reachability check',
      stage: 'network',
      severity: 'required',
      requiresRoot: false,
      command: remote(`curl -fsS --max-time 8 ${input.internalBaseUrl.replace(/'/g, '')}/healthz`),
      expected: 'Slot can reach Internal control-plane health endpoint',
      remediation: 'Allow outbound path to Internal, or route through Domestic/Oversea-assisted tunnel first.'
    });
  }
  return checks;
}

function siteSlotDeploymentPhases(
  kind: SiteSlotKind,
  input: SiteSlotPlanInput,
  host: string | null,
  sshUser: string,
  sshPort: number,
  mode: SiteSlotNetworkMode
): SiteSlotPlan['deploymentPhases'] {
  const target = host ?? `<${kind}-host>`;
  const artifactRoot = `./artifacts/site-slots/${kind}`;
  const incomingDir = '/opt/mx/incoming';
  const releaseRevision = '<release-revision>';
  const releaseRoot = '/opt/mx/releases';
  const currentRoot = '/opt/mx/current';
  const slotServiceBundleName = `mx-${kind}-services.tar.gz`;
  const slotServiceBundle = `${artifactRoot}/${slotServiceBundleName}`;
  const slotReleaseDir = `${releaseRoot}/${kind}/${releaseRevision}`;
  const slotCurrentDir = `${currentRoot}/${kind}`;
  const domesticTunnelCliBundleName = 'mx-domestic-qp-tunnel-cli-fallback.tar.gz';
  const domesticTunnelCliBundle = `${artifactRoot}/${domesticTunnelCliBundleName}`;
  const domesticTunnelCliReleaseDir = `${releaseRoot}/qp-tunnel-cli/${releaseRevision}`;
  const domesticTunnelCliCurrentDir = `${currentRoot}/qp-tunnel-cli`;
  const overseaAccessStackBundleName = 'mx-oversea-access-stack.tar.gz';
  const overseaAccessStackBundle = `${artifactRoot}/${overseaAccessStackBundleName}`;
  const overseaAccessStackReleaseDir = `${releaseRoot}/oversea-access-stack/${releaseRevision}`;
  const overseaAccessStackCurrentDir = `${currentRoot}/hysteria2-access-stack`;
  const domesticWireGuardConfig = `${artifactRoot}/mx-domestic-wg.conf`;
  const ssh = (command: string) => `ssh -p ${sshPort} ${sshUser}@${target} '${command}'`;
  const scp = (source: string, dest: string) => `scp -P ${sshPort} ${source} ${sshUser}@${target}:${dest}`;
  const scpRecursive = (source: string, dest: string) => `scp -r -P ${sshPort} ${source} ${sshUser}@${target}:${dest}`;
  const rsyncOverSsh = (source: string, dest: string, deleteStale = false) => {
    const flags = deleteStale ? '-az --delete' : '-az';
    return `if command -v rsync >/dev/null 2>&1; then rsync ${flags} -e 'ssh -p ${sshPort}' ${source} ${sshUser}@${target}:${dest}; else ${source.endsWith('/') ? scpRecursive(source, dest) : scp(source, dest)}; fi`;
  };
  const internalBaseUrl = input.internalBaseUrl ?? '<internal-base-url>';
  const internalMihomoBaseUrl = `${internalBaseUrl}/internal/v1/launcher-network/mihomo`;
  const overseaSubscriptionBaseUrl = `${internalBaseUrl}/internal/v1/site-slots/${input.siteId ?? 'oversea-main'}/subscriptions/hysteria2`;
  const overseaTunnelStateJson = JSON.stringify({
    revision: 'internal-shadow-1',
    node: {
      publicHost: target,
      serverPorts: '52120-52159'
    },
    policies: [
      {
        id: 'cn-direct',
        routingMode: 'cn-direct',
        isDefault: true,
        reservedInternalCidrs: ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16', '10.91.0.0/16'],
        domesticGatewayIp: '10.88.0.1',
        dnsPath: 'wg-relay-internal-dns'
      }
    ],
    accounts: [
      {
        id: 'internal-bootstrap',
        username: 'internal-bootstrap',
        authToken: '<hy2-internal-token-from-internal-secret>',
        status: 'active',
        policyId: 'cn-direct',
        upRate: '30 Mbps',
        downRate: '3 Mbps'
      },
      {
        id: 'domestic-bootstrap',
        username: 'domestic-bootstrap',
        authToken: '<hy2-domestic-token-from-internal-secret>',
        status: 'active',
        policyId: 'cn-direct',
        upRate: '30 Mbps',
        downRate: '3 Mbps'
      }
    ]
  });
  const overseaTunnelStateBase64 = Buffer.from(overseaTunnelStateJson, 'utf8').toString('base64');
  const phases: SiteSlotPlan['deploymentPhases'] = [
    {
      phaseId: 'register-slot',
      title: 'Register slot in Internal',
      mode: 'admin-action',
      target: 'internal',
      required: true,
      commands: [
        `POST /internal/v1/site-slots/plans siteId=${input.siteId ?? `${kind}-main`} kind=${kind}`,
        'Record host, ssh user, root policy, Docker status, outbound status, and Oversea dependency.'
      ],
      notes: ['Internal owns the slot truth; Domestic and Oversea are pluggable execution surfaces.']
    },
    {
      phaseId: 'package-slot-artifacts',
      title: `Materialize ${kind} deployment artifacts`,
      mode: 'admin-action',
      target: 'internal',
      required: true,
      commands: [
        kind === 'oversea'
          ? `Release Center materialize artifactSet=${kind} modules=hysteria2-access-stack,site-agent,runner-worker,observability-forwarder output=${artifactRoot}`
          : `Release Center materialize artifactSet=${kind} modules=wireguard-config,qp-tunnel-cli-offline-fallback,h2i-proxy,api-proxy,snapshot-cache,observability-forwarder output=${artifactRoot}`,
        kind === 'domestic'
          ? 'If @qpjoy/tunnel-cli was republished, refresh fallback first: bash scripts/manage.sh ops site-slot refresh-tunnel-cli latest'
          : 'Keep hysteria2 access-stack source under electron-dock/mx-launcher/site-slots/oversea/hysteria2-access-stack before materializing; mihomo is deployed by Internal, not by Oversea.',
        `Write ${artifactRoot}/manifest.json with sha256, target paths, rollback metadata, and source revision.`,
        'Exclude .git, docs, tests, local fixtures, node_modules, and unrelated workspace packages; never sync the repository root.'
      ],
      notes: ['Internal chooses the deployable module set per slot kind; Domestic and Oversea do not receive the same code bundle.']
    },
    {
      phaseId: 'remote-preflight',
      title: 'Run remote preflight',
      mode: 'remote-ssh',
      target: kind,
      required: true,
      commands: [
        ssh('id -u && uname -a && docker version && docker compose version'),
        kind === 'domestic' ? ssh('command -v wg && command -v wg-quick && sysctl net.ipv4.ip_forward') : ssh('docker compose version')
      ],
      notes: ['Do not mutate the host in preflight; collect evidence first.']
    }
  ];
  if (kind === 'domestic' && mode === 'oversea-assisted') {
    phases.push({
      phaseId: 'resolve-domestic-bootstrap-subscription',
      title: 'Resolve Domestic Oversea bootstrap subscription',
      mode: 'admin-action',
      target: 'internal',
      required: true,
      commands: [
        `Read domesticBootstrapSubscription from Internal Config Center for Oversea siteId=${input.overseaSiteId ?? '<oversea-site-id>'} host=${input.overseaHost ?? '<oversea-host>'}`,
        `Verify ${artifactRoot}/mx-domestic-qp-tunnel-cli-fallback.tar.gz exists in Internal before touching Domestic.`,
        'If subscription/account material is missing, stop here; do not ask Domestic to npm install or pull until Internal has issued the Oversea bootstrap account.'
      ],
      notes: ['Internal owns the bootstrap subscription, mihomo config, and fallback artifact before Domestic can recover outbound access.']
    });
    phases.push({
      phaseId: 'bootstrap-domestic-egress',
      title: 'Bootstrap Domestic outbound through Oversea',
      mode: 'artifact-push',
      target: 'domestic',
      required: true,
      commands: [
        ssh(`install -d -m 0755 ${incomingDir} ${currentRoot} ${domesticTunnelCliReleaseDir}`),
        rsyncOverSsh(domesticTunnelCliBundle, `${incomingDir}/`),
        ssh(`tar -xzf ${incomingDir}/${domesticTunnelCliBundleName} -C ${domesticTunnelCliReleaseDir} && ln -sfn ${domesticTunnelCliReleaseDir} ${domesticTunnelCliCurrentDir}`),
        ssh(`chmod +x ${domesticTunnelCliCurrentDir}/bin/qp-tunnel-cli && if command -v qp-tunnel-cli >/dev/null 2>&1; then QP_TUNNEL_CLI=qp-tunnel-cli; elif command -v npm >/dev/null 2>&1 && npm view @qpjoy/tunnel-cli version >/dev/null 2>&1; then npm i -g @qpjoy/tunnel-cli && QP_TUNNEL_CLI=qp-tunnel-cli; else QP_TUNNEL_CLI=${domesticTunnelCliCurrentDir}/bin/qp-tunnel-cli; fi; $QP_TUNNEL_CLI register --internal ${internalBaseUrl} --role domestic --site ${input.siteId ?? 'domestic-main'} --subscription <internal-issued-oversea-hysteria2-subscription> && $QP_TUNNEL_CLI server-on`)
      ],
      notes: ['Prefer npm i -g @qpjoy/tunnel-cli when the target can reach npm; keep the Internal-pushed fallback bundle for no-outbound Domestic bootstrap.']
    });
  }
  phases.push(
    {
      phaseId: kind === 'domestic' ? 'install-host-wireguard' : 'prepare-access-stack',
        title: kind === 'domestic' ? 'Install Domestic host WireGuard service' : 'Prepare Oversea Docker hysteria2 access stack',
      mode: 'artifact-push',
      target: kind,
      required: true,
      commands: kind === 'domestic'
        ? [
            ssh('install -d -m 0700 /etc/wireguard'),
            rsyncOverSsh(domesticWireGuardConfig, '/etc/wireguard/mx-domestic.conf'),
            ssh('systemctl enable --now wg-quick@mx-domestic')
          ]
        : [
            ssh(`install -d -m 0755 /opt/mx ${incomingDir} ${currentRoot} /opt/mx/site-agent ${overseaAccessStackReleaseDir}`),
            rsyncOverSsh(overseaAccessStackBundle, `${incomingDir}/`),
            ssh(`tar -xzf ${incomingDir}/${overseaAccessStackBundleName} -C ${overseaAccessStackReleaseDir} && ln -sfn ${overseaAccessStackReleaseDir} ${overseaAccessStackCurrentDir}`),
            ssh(`cd ${overseaAccessStackCurrentDir} && chmod +x manage.sh && test -f docker-compose.yml && test -f .env.example`)
          ],
      notes: kind === 'domestic'
        ? ['WireGuard/routing is host-level because Domestic is the relay path and has limited memory/disk.']
        : ['Internal pushes the access stack over rsync/OpenSSH and falls back to scp; the Oversea host does not clone or pull source code.']
    },
    ...(kind === 'oversea' ? [
      {
        phaseId: 'configure-oversea-access',
        title: 'Configure Oversea hysteria2 access',
        mode: 'remote-ssh' as const,
        target: kind,
        required: true,
        commands: [
          `POST /internal/v1/site-slots/${input.siteId ?? 'oversea-main'}/access-accounts issue=internal-bootstrap,domestic-bootstrap service=hysteria2 store=config-center`,
          `POST /internal/v1/launcher-network/mihomo/sites/${input.siteId ?? 'oversea-main'} mode=internal-managed source=${overseaSubscriptionBaseUrl}`,
          ssh(`if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi; docker version && docker compose version`),
          ssh(`cd ${overseaAccessStackCurrentDir} && cp -n .env.example .env && printf "\\nHY2_SERVER_HOST=${target}\\nHY2_TLS_SERVER_NAME=${target}\\nHY2_EXPORT_BASE_URL=${overseaSubscriptionBaseUrl}\\nHY2_INTERNAL_MIHOMO_BASE_URL=${internalMihomoBaseUrl}\\nHY2_INTERNAL_SUBSCRIPTION_STORE=config-center\\nHY2_MIHOMO_ROUTING_MODE=cn-direct\\nHY2_RESERVED_INTERNAL_CIDRS=10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16\\nHY2_DOMESTIC_GATEWAY_IP=10.88.0.1\\nHY2_USERS=internal-bootstrap,domestic-bootstrap\\nHY2_EXPORT_USER=<readonly-health-user-from-internal-secret>\\nHY2_EXPORT_PASSWORD_HASH=<caddy-bcrypt-hash-from-internal-secret>\\n" >> .env`),
          ssh(`printf "%s" ${overseaTunnelStateBase64} | base64 -d > /opt/mx/site-agent/tunnel-state.json`),
          ssh(`cd ${overseaAccessStackCurrentDir} && ./manage.sh reconcile-from-json --state-file /opt/mx/site-agent/tunnel-state.json --mode hysteria2-only`),
          ssh(`if command -v qp-tunnel-cli >/dev/null 2>&1; then QP_TUNNEL_CLI=qp-tunnel-cli; elif command -v npm >/dev/null 2>&1; then npm i -g @qpjoy/tunnel-cli && QP_TUNNEL_CLI=qp-tunnel-cli; else QP_TUNNEL_CLI=${overseaAccessStackCurrentDir}/bin/qp-tunnel-cli; fi; $QP_TUNNEL_CLI register --internal ${internalBaseUrl} --role oversea --site ${input.siteId ?? 'oversea-main'} --service hysteria2`),
          ssh(`cd ${overseaAccessStackCurrentDir} && ./manage.sh status && curl -fsS http://127.0.0.1:3434/healthz`)
        ],
        notes: [
          'Oversea runs hysteria2 only; Internal runs mihomo and stores subscription/account material.',
          'H endpoints use WG relay only for Internal DNS and reserved 10.88.0.0/16-10.91.0.0/16 routes; Domestic defaults to 10.88.0.1, cn-direct stays direct, and external traffic uses the Oversea hysteria2 subscription.'
        ]
      },
      {
        phaseId: 'publish-internal-subscription',
        title: 'Publish Internal subscription metadata',
        mode: 'admin-action' as const,
        target: 'internal' as const,
        required: true,
        commands: [
          `Record overseaSubscriptionBaseUrl=${overseaSubscriptionBaseUrl}`,
          `Record hEndpointBootstrapPath=WG relay for DNS and 10.88.0.0/16-10.91.0.0/16 -> Internal mihomo subscription -> cn-direct policy -> Oversea hysteria2 for external traffic`,
          `Record domesticBootstrapSubscription=${overseaSubscriptionBaseUrl}/domestic-bootstrap.yaml`,
          'Attach Internal subscription URL, account IDs, and tunnel-cli registration evidence to the worker report before Domestic oversea-assisted bootstrap.'
        ],
        notes: [
          'Internal remains the source of truth for which Domestic slots can consume this Oversea access site.',
          'Subscription auth is issued and rotated by Internal; Oversea receives only the hysteria2 runtime account material needed to serve traffic.'
        ]
      }
    ] : []),
    {
      phaseId: 'deploy-slot-services',
      title: `Deploy ${kind} Docker services`,
      mode: 'artifact-push',
      target: kind,
      required: true,
      commands: [
        ssh(`install -d -m 0755 ${incomingDir} ${currentRoot} ${slotReleaseDir}`),
        rsyncOverSsh(slotServiceBundle, `${incomingDir}/`),
        kind === 'oversea'
          ? ssh(`tar -xzf ${incomingDir}/${slotServiceBundleName} -C ${slotReleaseDir} && ln -sfn ${slotReleaseDir} ${slotCurrentDir} && printf "MX_SITE_ID=${input.siteId ?? 'oversea-main'}\\nMX_SITE_ROLE=oversea\\nMX_ENABLED_MODULES=access-node,site-agent,runner-worker,observability-forwarder\\nMX_INTERNAL_BASE_URL=${internalBaseUrl}\\nLOCAL_STACK_PATH=${overseaAccessStackCurrentDir}\\nMX_ACCESS_RUNTIME=hysteria2-only\\n" > ${slotCurrentDir}/.env && cd ${slotCurrentDir} && docker compose up -d`)
          : ssh(`tar -xzf ${incomingDir}/${slotServiceBundleName} -C ${slotReleaseDir} && ln -sfn ${slotReleaseDir} ${slotCurrentDir} && cd ${slotCurrentDir} && docker compose up -d`)
      ],
      notes: ['Internal pushes Release Center bundles; slot hosts run the unpacked bundle and do not pull code from git.']
    },
    {
      phaseId: 'sync-internal-config',
      title: 'Sync signed Internal config',
      mode: 'runner-job',
      target: kind,
      required: true,
      commands: [
        `POST /internal/v1/config-center/snapshots/effective siteId=${input.siteId ?? `${kind}-main`}`,
        ssh(`curl -fsS ${input.internalBaseUrl ?? '<internal-base-url>'}/healthz`)
      ],
      notes: ['Domestic/Oversea cache signed snapshots; they do not become config truth.']
    },
    {
      phaseId: 'slot-smoke',
      title: 'Run slot smoke checks',
      mode: 'runner-job',
      target: kind,
      required: true,
      commands: [
        kind === 'domestic'
          ? 'Check WireGuard handshake, H2I relay reachability, snapshot cache, and observability forwarding.'
          : 'Check hysteria2 endpoint, Internal mihomo subscription refresh, cn-direct policy, reserved Internal CIDRs, site-agent heartbeat, tunnel-cli registration, and H endpoint bootstrap path.'
      ],
      notes: ['Smoke evidence should feed Test Center and Release Management Plan before rollout expands.']
    }
  );
  return phases;
}

function siteSlotNextActions(
  kind: SiteSlotKind,
  status: SiteSlotPlan['status'],
  mode: SiteSlotNetworkMode,
  input: SiteSlotPlanInput
): string[] {
  const actions: string[] = [];
  if (status === 'blocked') actions.push('resolve-blocking-warnings');
  actions.push('materialize-slot-artifacts');
  actions.push('run-remote-preflight');
  if (kind === 'domestic' && mode !== 'direct') actions.push('configure-oversea-bootstrap');
  if (kind === 'oversea') actions.push('push-oversea-access-stack');
  if (kind === 'domestic') actions.push('install-host-wireguard-service');
  actions.push('push-slot-service-bundle', 'sync-signed-internal-config', 'run-slot-smoke');
  if (!input.internalBaseUrl) actions.push('set-internal-base-url-for-reachability-check');
  return actions;
}

function runtimeFeaturePolicyId(
  featureKey: string,
  scopeKind: RuntimeFeaturePolicyScopeKind,
  scopeId: string | null
): string {
  return `rtfp_${featureKey.replace(/[^a-zA-Z0-9._-]/g, '_')}_${scopeKind}_${(scopeId ?? 'global').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function runtimeFeatureScopeKind(value: RuntimeFeaturePolicyInput['scopeKind']): RuntimeFeaturePolicyScopeKind {
  if (value === 'site' || value === 'profile') return value;
  return 'global';
}

function runtimeFeatureMode(value: RuntimeFeaturePolicyInput['mode']): RuntimeFeaturePolicyMode {
  if (value === 'readonly-execute' || value === 'remote-execute' || value === 'plan-only' || value === 'disabled') return value;
  return 'plan-only';
}

export function normalizeTestStatus(value: string): TestStep['status'] {
  if (value === 'failed' || value === 'blocked') return value;
  return 'passed';
}

export function required<T>(value: T | null, message: string): T {
  if (value) return value;
  throw new Error(message);
}
