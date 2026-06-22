import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  AnonymousEnrollment,
  AppCenterApp,
  AppCenterAppInput,
  AwxProviderConfig,
  AwxProviderConfigInput,
  AwxProviderKind,
  AwxProviderStatus,
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
  LauncherNetworkLease,
  LauncherNetworkLeaseInput,
  LauncherNetworkLeaseReleaseInput,
  LauncherNetworkMihomoSite,
  LauncherNetworkMihomoSiteInput,
  LauncherProductNetwork,
  LauncherProductNetworkInput,
  LauncherProductMode,
  LauncherProductUpdatePolicy,
  LauncherNetworkReachabilityPlan,
  LauncherNetworkSnapshot,
  LauncherNetworkTopology,
  MihomoSubscriptionRender,
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
  SiteSlotAccessAccount,
  SiteSlotAccessAccountIssueInput,
  SiteSlotAccessAccountRole,
  SiteSlotKind,
  SiteSlotNetworkMode,
  SiteSlotOverseaRuntimeConfig,
  SiteSlotPlan,
  SiteSlotPlanInput,
  SiteSlotDomesticRuntimeConfig,
  SiteSlotDomesticRuntimeConfigInput,
  SiteSlotDomesticWireGuardSecret,
  SiteSlotDomesticWireGuardSecretInput,
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
  UserOverseaEntitlement,
  UserOverseaSubscriptionRender,
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

export const LAUNCHER_NETWORK_LEASE_TTL_DAYS = 180;
export const LAUNCHER_NETWORK_LEASE_TTL_MS = LAUNCHER_NETWORK_LEASE_TTL_DAYS * 24 * 60 * 60 * 1000;

const HYSTERIA2_ACCESS_PORT = 51288;
const HYSTERIA2_ACCESS_PORTS = String(HYSTERIA2_ACCESS_PORT);
const HYSTERIA2_EXPORT_FALLBACK_PORT = 3434;
const HYSTERIA2_CLIENT_DOWNLOAD = '30 Mbps';
const HYSTERIA2_CLIENT_UPLOAD = '30 Mbps';
const HYSTERIA2_CLIENT_ALPN = 'h3';
const HYSTERIA2_CLIENT_DNS = ['223.5.5.5', '119.29.29.29', '1.1.1.1', '8.8.8.8'];
const HYSTERIA2_LOCAL_DIRECT_RULES = [
  'DOMAIN-SUFFIX,local,DIRECT',
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
  'IP-CIDR6,::1/128,DIRECT,no-resolve',
  'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
  'IP-CIDR6,fe80::/10,DIRECT,no-resolve'
];

const SERVICE_ACCOUNT_SCOPES = [
  'sdk.identity.read',
  'sdk.user.read',
  'sdk.user.write',
  'sdk.permission.request',
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
  if (routeId === 'sdk.roles.list' || routeId === 'sdk.users.list' || routeId === 'sdk.service_accounts.list') {
    return ['sdk.user.read', 'rbac.manage'];
  }
  if (routeId === 'sdk.users.create' || routeId === 'sdk.service_accounts.create') return ['sdk.user.write', 'rbac.manage'];
  if (routeId === 'sdk.permissions.request') return ['sdk.permission.request', 'permission.request'];
  if (routeId.startsWith('sdk.dns.')) return ['sdk.dns.evaluate', 'network.dns.policy'];
  if (routeId === 'sdk.audit.write') return ['sdk.audit.write'];
  if (routeId === 'sdk.observability.logs') return ['sdk.observability.write', 'observability.write'];
  return [];
}

export const MX_H2I_PRODUCT_ID = 'mx-h2i';
export const APP_CENTER_PRODUCT_ID = 'appcenter';
export const LAUNCHER_FOUNDATION_PRODUCT_ID = 'launcher';

export function normalizeLauncherNetworkProductId(value?: string | null): string {
  const normalized = safeIdPart(value?.trim() || MX_H2I_PRODUCT_ID).toLowerCase();
  return normalized || MX_H2I_PRODUCT_ID;
}

export function launcherNetworkProductIsStandaloneDefault(productId: string): boolean {
  return productId === MX_H2I_PRODUCT_ID || productId === LAUNCHER_FOUNDATION_PRODUCT_ID;
}

export function launcherNetworkLeaseProductId(productId?: string | null): string {
  const normalized = normalizeLauncherNetworkProductId(productId);
  return normalized === LAUNCHER_FOUNDATION_PRODUCT_ID ? MX_H2I_PRODUCT_ID : normalized;
}

function appCenterStringList(value: AppCenterAppInput['channels'], fallback: string[]): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : fallback;
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))];
}

function appCenterRecordMap(value: AppCenterAppInput['entrypoints'], fallback: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
  return Object.entries(value).reduce<Record<string, string>>((next, [key, raw]) => {
    const normalizedKey = safeIdPart(key).toLowerCase();
    const text = String(raw || '').trim();
    if (normalizedKey && text) next[normalizedKey] = text;
    return next;
  }, {});
}

export function buildAppCenterApp(
  input: AppCenterAppInput,
  previous: AppCenterApp | null = null
): AppCenterApp {
  const appId = safeIdPart(String(input.appId || previous?.appId || 'app').trim()).toLowerCase();
  const launcherMode = launcherProductMode(input.launcherMode ?? previous?.launcherMode ?? (appId === MX_H2I_PRODUCT_ID ? 'standalone' : 'embed'));
  const productNetworkId = normalizeLauncherNetworkProductId(input.productNetworkId || previous?.productNetworkId || appId);
  const standaloneChannelProductId = launcherMode === 'standalone'
    ? productNetworkId
    : launcherNetworkLeaseProductId(input.standaloneChannelProductId || previous?.standaloneChannelProductId || MX_H2I_PRODUCT_ID);
  const builtin = typeof input.builtin === 'boolean' ? input.builtin : previous?.builtin ?? false;
  return {
    appId,
    displayName: input.displayName?.trim() || previous?.displayName || launcherProductDisplayName(appId),
    builtin,
    systemOwned: typeof input.systemOwned === 'boolean' ? input.systemOwned : previous?.systemOwned ?? builtin,
    version: input.version?.trim() || previous?.version || '0.1.0',
    category: input.category?.trim() || previous?.category || 'custom',
    description: input.description?.trim() || previous?.description || 'Launcher powered application.',
    launcherMode,
    standaloneChannelProductId,
    productNetworkId,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : previous?.enabled ?? true,
    channels: appCenterStringList(input.channels, previous?.channels ?? ['shadow', 'beta', 'stable']),
    permissions: appCenterStringList(input.permissions, previous?.permissions ?? ['auth.read']),
    requiredCapabilities: appCenterStringList(
      input.requiredCapabilities,
      previous?.requiredCapabilities ?? (launcherMode === 'standalone'
        ? ['launcher-network', 'launcher-standalone']
        : ['launcher-network', 'launcher-embed-sdk'])
    ),
    updatePolicy: normalizeUpdatePolicy(String(input.updatePolicy || previous?.updatePolicy || 'app-managed')),
    entrypoints: appCenterRecordMap(input.entrypoints, previous?.entrypoints ?? {
      desktop: `app://${appId}/index.html`,
      settings: `app://${appId}/settings.html`
    }),
    protocol: {
      appCenter: input.protocol?.appCenter?.trim() || previous?.protocol?.appCenter || '1.0',
      launcher: input.protocol?.launcher?.trim() || previous?.protocol?.launcher || '1.0'
    }
  };
}

function launcherProductDisplayName(productId: string): string {
  if (productId === MX_H2I_PRODUCT_ID) return 'MX-H2I';
  if (productId === APP_CENTER_PRODUCT_ID) return 'AppCenter';
  if (productId === 'h2o') return 'H2O';
  return productId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || productId;
}

export function builtinAppCenterApps(): AppCenterApp[] {
  return [
    buildAppCenterApp({
      appId: MX_H2I_PRODUCT_ID,
      displayName: 'MX-H2I',
      builtin: true,
      systemOwned: true,
      version: '0.1.0',
      category: 'vpn',
      description: 'VPN product that owns the Launcher standalone channel and peer leases.',
      launcherMode: 'standalone',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: MX_H2I_PRODUCT_ID,
      permissions: ['auth.read', 'network.tun.request', 'network.wg.peer', 'network.dns.policy', 'observability.write'],
      requiredCapabilities: ['launcher-network', 'launcher-standalone', 'wireguard-peer'],
      updatePolicy: 'mandatory-app',
      entrypoints: {
        desktop: 'app://mx-h2i/index.html',
        settings: 'app://mx-h2i/settings.html'
      }
    }),
    buildAppCenterApp({
      appId: APP_CENTER_PRODUCT_ID,
      displayName: 'AppCenter',
      builtin: true,
      systemOwned: true,
      version: '0.1.0',
      category: 'platform',
      description: 'Application catalog and runtime access surface, embedded through MX-H2I launcher channel.',
      launcherMode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: APP_CENTER_PRODUCT_ID,
      permissions: ['auth.read', 'appcenter.read', 'permission.request', 'observability.write'],
      requiredCapabilities: ['app-center-runtime', 'launcher-embed-sdk'],
      updatePolicy: 'platform-ui',
      entrypoints: {
        desktop: 'app://appcenter/index.html',
        settings: 'app://appcenter/settings.html'
      }
    }),
    buildAppCenterApp({
      appId: 'h2o',
      displayName: 'H2O',
      builtin: true,
      systemOwned: true,
      version: '0.1.0',
      category: 'network',
      description: 'Network, split DNS, PAC, and Internal service access through MX-H2I launcher channel.',
      launcherMode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: 'h2o',
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
      requiredCapabilities: ['launcher-network', 'launcher-embed-sdk', 'app-center-runtime'],
      updatePolicy: 'app-managed',
      entrypoints: {
        desktop: 'app://h2o/index.html',
        settings: 'app://h2o/settings.html'
      }
    })
  ];
}

export function builtinLauncherProductNetworks(config: RuntimeConfig): LauncherProductNetwork[] {
  const now = new Date().toISOString();
  return [
    buildLauncherProductNetwork(config, {
      productId: MX_H2I_PRODUCT_ID,
      displayName: 'MX-H2I',
      mode: 'standalone',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productIndex: 0,
      serviceVip: '10.88.100.1',
      userCidr: '10.89.0.0/16',
      anonymousCidr: '10.89.0.0/16',
      userLeaseStart: '10.89.0.1',
      userLeaseEnd: '10.89.99.254',
      anonymousLeaseStart: '10.89.100.1',
      anonymousLeaseEnd: '10.89.254.254',
      updatePolicy: 'launcher-managed',
      rateLimitProfile: 'standalone-default',
      dnsPolicyId: 'internal-default',
      licensePolicyId: 'appcenter-default',
      requestedBy: 'builtin'
    }, null, now),
    buildLauncherProductNetwork(config, {
      productId: APP_CENTER_PRODUCT_ID,
      displayName: 'AppCenter',
      mode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productIndex: 1,
      serviceVip: '10.88.100.9',
      userCidr: '10.92.0.0/16',
      anonymousCidr: '10.92.0.0/16',
      userLeaseStart: '10.92.0.1',
      userLeaseEnd: '10.92.99.254',
      anonymousLeaseStart: '10.92.100.1',
      anonymousLeaseEnd: '10.92.254.254',
      updatePolicy: 'launcher-managed',
      rateLimitProfile: 'product-default',
      dnsPolicyId: 'internal-default',
      licensePolicyId: 'appcenter-default',
      requestedBy: 'builtin'
    }, null, now),
    buildLauncherProductNetwork(config, {
      productId: 'h2o',
      displayName: 'H2O',
      mode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productIndex: 2,
      serviceVip: '10.88.100.10',
      userCidr: '10.90.0.0/16',
      anonymousCidr: '10.90.0.0/16',
      userLeaseStart: '10.90.0.1',
      userLeaseEnd: '10.90.99.254',
      anonymousLeaseStart: '10.90.100.1',
      anonymousLeaseEnd: '10.90.254.254',
      updatePolicy: 'launcher-managed',
      rateLimitProfile: 'product-default',
      dnsPolicyId: 'internal-default',
      licensePolicyId: 'h2o-default',
      requestedBy: 'builtin'
    }, null, now)
  ];
}

export function buildLauncherProductNetwork(
  config: RuntimeConfig,
  input: LauncherProductNetworkInput,
  previous: LauncherProductNetwork | null,
  now = new Date().toISOString()
): LauncherProductNetwork {
  const productId = normalizeLauncherNetworkProductId(input.productId?.trim() || previous?.productId);
  const mode = launcherProductMode(input.mode ?? previous?.mode ?? (launcherNetworkProductIsStandaloneDefault(productId) ? 'standalone' : 'embed'));
  const productIndex = Number.isFinite(input.productIndex ?? NaN)
    ? Math.max(0, Math.floor(Number(input.productIndex)))
    : previous?.productIndex ?? (mode === 'standalone' ? 0 : 0);
  const defaults = defaultLauncherProductNetworkShape(productId, mode, productIndex);
  const rawStandaloneChannel = mode === 'standalone'
    ? productId
    : input.standaloneChannelProductId?.trim() || previous?.standaloneChannelProductId || MX_H2I_PRODUCT_ID;
  const standaloneChannelProductId = launcherNetworkLeaseProductId(rawStandaloneChannel || (mode === 'standalone' ? productId : MX_H2I_PRODUCT_ID));
  const updatedBy = input.requestedBy?.trim() || 'config-center';
  return {
    productId,
    displayName: input.displayName?.trim() || previous?.displayName || defaults.displayName,
    mode,
    standaloneChannelProductId,
    productIndex,
    fabricCidr: '10.88.0.0/16',
    internalControlIp: '10.88.88.88',
    serviceVip: validIpv4OrFallback(input.serviceVip, previous?.serviceVip || defaults.serviceVip),
    userCidr: input.userCidr?.trim() || previous?.userCidr || defaults.userCidr,
    anonymousCidr: input.anonymousCidr?.trim() || previous?.anonymousCidr || defaults.anonymousCidr,
    userLeaseStart: validIpv4OrFallback(input.userLeaseStart, previous?.userLeaseStart || defaults.userLeaseStart),
    userLeaseEnd: validIpv4OrFallback(input.userLeaseEnd, previous?.userLeaseEnd || defaults.userLeaseEnd),
    anonymousLeaseStart: validIpv4OrFallback(input.anonymousLeaseStart, previous?.anonymousLeaseStart || defaults.anonymousLeaseStart),
    anonymousLeaseEnd: validIpv4OrFallback(input.anonymousLeaseEnd, previous?.anonymousLeaseEnd || defaults.anonymousLeaseEnd),
    defaultDomesticSiteId: input.defaultDomesticSiteId?.trim() || previous?.defaultDomesticSiteId || 'domestic-main',
    defaultOverseaSiteId: input.defaultOverseaSiteId?.trim() || previous?.defaultOverseaSiteId || 'oversea-main',
    updatePolicy: launcherProductUpdatePolicy(input.updatePolicy ?? previous?.updatePolicy),
    rateLimitProfile: input.rateLimitProfile?.trim() || previous?.rateLimitProfile || defaults.rateLimitProfile,
    dnsPolicyId: input.dnsPolicyId?.trim() || previous?.dnsPolicyId || 'internal-default',
    licensePolicyId: input.licensePolicyId?.trim() || previous?.licensePolicyId || `${productId}-default`,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : previous?.enabled ?? true,
    notes: launcherProductNetworkNotes(mode),
    createdBy: previous?.createdBy ?? updatedBy,
    createdAt: previous?.createdAt ?? now,
    updatedBy,
    updatedAt: now
  };
}

export function launcherLeaseIpForProduct(
  product: LauncherProductNetwork,
  identityKind: 'user' | 'anonymous',
  sequence: number
): string {
  return leaseIpFromRange(
    identityKind === 'user' ? product.userLeaseStart : product.anonymousLeaseStart,
    identityKind === 'user' ? product.userLeaseEnd : product.anonymousLeaseEnd,
    sequence
  );
}

export function nextAvailableLauncherNetworkLeaseSequence(
  product: LauncherProductNetwork,
  identityKind: 'user' | 'anonymous',
  leases: LauncherNetworkLease[],
  now = new Date()
): number {
  const activeIps = new Set(
    leases
      .filter((lease) => lease.productId === product.productId)
      .filter((lease) => launcherNetworkLeaseIsActive(lease, now))
      .map((lease) => lease.leaseIp)
  );
  for (let sequence = 1; sequence < 65535; sequence += 1) {
    const leaseIp = launcherLeaseIpForProduct(product, identityKind, sequence);
    if (!activeIps.has(leaseIp)) return sequence;
  }
  throw new Error(`Launcher network lease range exhausted: ${product.productId}:${identityKind}`);
}

export function launcherNetworkLeaseKey(input: LauncherNetworkLeaseInput, product: LauncherProductNetwork): string {
  const identityKind = launcherNetworkIdentityKind(input.identityKind, input.userId);
  const mode = launcherProductMode(input.mode ?? product.mode);
  const principal = launcherNetworkLeasePrincipal(input, identityKind);
  return [
    product.productId,
    mode,
    identityKind,
    principal
  ].join(':');
}

export function launcherNetworkLeaseId(leaseKey: string): string {
  return `lnlease_${createHash('sha256').update(leaseKey).digest('hex').slice(0, 24)}`;
}

export function launcherNetworkLeaseIsActive(lease: LauncherNetworkLease, now = new Date()): boolean {
  if (lease.status !== 'active') return false;
  const expiresAt = Date.parse(lease.expiresAt || '');
  if (Number.isFinite(expiresAt)) return expiresAt > now.getTime();
  const updatedAt = Date.parse(lease.updatedAt || lease.createdAt || '');
  return Number.isFinite(updatedAt) ? updatedAt + LAUNCHER_NETWORK_LEASE_TTL_MS > now.getTime() : true;
}

export function releaseLauncherNetworkLease(
  lease: LauncherNetworkLease,
  input: LauncherNetworkLeaseReleaseInput = {},
  now = new Date().toISOString()
): LauncherNetworkLease {
  const updatedBy = input.requestedBy?.trim() || 'launcher-network';
  return {
    ...lease,
    status: 'released',
    expiresAt: now,
    releasedAt: now,
    updatedBy,
    updatedAt: now
  };
}

export function buildLauncherNetworkLease(
  config: RuntimeConfig,
  input: LauncherNetworkLeaseInput,
  product: LauncherProductNetwork,
  sequence: number,
  previous: LauncherNetworkLease | null,
  now = new Date().toISOString()
): LauncherNetworkLease {
  const identityKind = launcherNetworkIdentityKind(input.identityKind, input.userId);
  const launcherMode = launcherProductMode(input.mode ?? product.mode);
  const leaseKey = launcherNetworkLeaseKey({ ...input, identityKind, mode: launcherMode }, product);
  const updatedBy = input.requestedBy?.trim() || 'launcher-network';
  const installId = input.installId?.trim() || previous?.installId || 'install-unknown';
  const deviceId = input.deviceId?.trim() || previous?.deviceId || 'device-unknown';
  const userId = identityKind === 'user' ? input.userId?.trim() || previous?.userId || null : null;
  const nowMs = Date.parse(now);
  const expiresAt = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + LAUNCHER_NETWORK_LEASE_TTL_MS).toISOString();
  return {
    leaseId: previous?.leaseId ?? launcherNetworkLeaseId(leaseKey),
    leaseKey,
    environment: config.environment,
    productId: product.productId,
    launcherMode,
    identityKind,
    sequence: previous?.sequence ?? Math.max(1, Math.floor(sequence)),
    installId,
    deviceId,
    siteId: input.siteId?.trim() || previous?.siteId || product.defaultDomesticSiteId,
    userId,
    cidr: identityKind === 'user' ? product.userCidr : product.anonymousCidr,
    leaseIp: previous?.leaseIp ?? launcherLeaseIpForProduct(product, identityKind, sequence),
    serviceVip: product.serviceVip,
    internalControlIp: product.internalControlIp,
    domesticGatewayIp: '10.88.0.1',
    domesticSiteId: product.defaultDomesticSiteId,
    overseaSiteId: product.defaultOverseaSiteId,
    publicKey: input.publicKey?.trim() || previous?.publicKey || null,
    deviceLabel: input.deviceLabel?.trim() || previous?.deviceLabel || null,
    platform: input.platform?.trim() || previous?.platform || null,
    status: 'active',
    expiresAt,
    releasedAt: null,
    createdBy: previous?.createdBy ?? updatedBy,
    createdAt: previous?.createdAt ?? now,
    updatedBy,
    updatedAt: now
  };
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
        exactDomains: [
          'internal.mx',
          'gateway.internal.mx',
          'dns.internal.mx',
          'host-runner.internal.mx',
          'service-peer.internal.mx',
          'domestic-relay.internal.mx'
        ],
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
  const records = dnsZoneRecords(config, input.policy, input.reverseProxyRoutes, targetServiceDns);
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
  config: RuntimeConfig,
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
  for (const record of internalDnsServiceRecords(config, policy)) {
    records.set(record.name, record);
  }
  return [...records.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function internalDnsServiceRecords(config: RuntimeConfig, policy: DnsPolicy): DnsZoneRecord[] {
  const internalServiceIp = '10.88.88.88';
  const domesticRelayIp = '10.88.0.1';
  const hostRunnerServiceDns = 'mx-internal-host-runner.mx-internal-shadow.svc.cluster.local';
  const coreDnsServiceDns = policy.internal.serviceDns || 'mx-internal-coredns.mx-dns.svc.cluster.local';
  const apiTarget = isClusterServiceHost(hostFromUrl(config.internalBaseUrl))
    ? internalServiceIp
    : hostFromUrl(config.internalBaseUrl) || internalServiceIp;
  return [
    dnsRecordForTarget('internal.mx', apiTarget, 'internal-service'),
    dnsRecordForTarget('gateway.internal.mx', apiTarget, 'internal-service'),
    dnsRecordForTarget('dns.internal.mx', coreDnsServiceDns, 'internal-service'),
    dnsRecordForTarget('host-runner.internal.mx', hostRunnerServiceDns, 'internal-service'),
    dnsRecordForTarget('service-peer.internal.mx', internalServiceIp, 'internal-service'),
    dnsRecordForTarget('domestic-relay.internal.mx', domesticRelayIp, 'internal-service')
  ];
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
    '  reload',
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

function isClusterServiceHost(value: string): boolean {
  return value.endsWith('.svc') || value.includes('.svc.cluster.local');
}

function validIpv4OrFallback(value: string | null | undefined, fallback: string): string {
  const candidate = value?.trim();
  return candidate && isIpv4(candidate) ? candidate : fallback;
}

function productRelayCidrs(input: string[] | null | undefined, previous: string[] | undefined): string[] {
  const candidates = input?.length ? input : previous?.length ? previous : ['10.89.0.0/16', '10.90.0.0/16'];
  const cidrs = candidates
    .map((cidr) => cidr.trim())
    .filter((cidr) => /^10\.\d{1,3}\.0\.0\/16$/.test(cidr));
  return [...new Set(cidrs.length ? cidrs : ['10.89.0.0/16', '10.90.0.0/16'])];
}

function launcherProductMode(value: LauncherProductNetworkInput['mode']): LauncherProductMode {
  return value === 'standalone' ? 'standalone' : 'embed';
}

function launcherNetworkIdentityKind(value: LauncherNetworkLeaseInput['identityKind'], userId?: string | null): 'user' | 'anonymous' {
  if (value === 'user' || userId?.trim()) return 'user';
  return 'anonymous';
}

function launcherNetworkLeasePrincipal(input: LauncherNetworkLeaseInput, identityKind: 'user' | 'anonymous'): string {
  const installPrincipal = input.installId?.trim() || input.deviceId?.trim() || 'unknown';
  if (identityKind === 'user') {
    return `account:${input.userId?.trim() || 'unknown'}:install:${installPrincipal}`;
  }
  return `install:${installPrincipal}`;
}

function launcherProductUpdatePolicy(value: LauncherProductNetworkInput['updatePolicy']): LauncherProductUpdatePolicy {
  if (value === 'app-managed' || value === 'host-managed') return value;
  return 'launcher-managed';
}

function defaultLauncherProductNetworkShape(productId: string, mode: LauncherProductMode, productIndex: number) {
  if (mode === 'standalone') {
    const index = Math.max(0, Math.min(164, Math.floor(productIndex)));
    const isMxH2i = launcherNetworkProductIsStandaloneDefault(productId);
    const secondOctet = isMxH2i ? 89 : 90 + index;
    const serviceOffset = isMxH2i ? 1 : 2 + (index % 198);
    return {
      displayName: productId === MX_H2I_PRODUCT_ID ? 'MX-H2I' : productId === LAUNCHER_FOUNDATION_PRODUCT_ID ? 'Launcher Foundation' : productId,
      serviceVip: `10.88.100.${serviceOffset}`,
      userCidr: `10.${secondOctet}.0.0/16`,
      anonymousCidr: `10.${secondOctet}.0.0/16`,
      userLeaseStart: `10.${secondOctet}.0.1`,
      userLeaseEnd: `10.${secondOctet}.99.254`,
      anonymousLeaseStart: `10.${secondOctet}.100.1`,
      anonymousLeaseEnd: `10.${secondOctet}.254.254`,
      rateLimitProfile: 'standalone-default'
    };
  }
  const index = Math.max(0, Math.min(99, Math.floor(productIndex)));
  const secondOctet = 90 + index;
  const serviceOffset = 10 + (index % 200);
  return {
    displayName: productId.toUpperCase(),
    serviceVip: `10.88.100.${serviceOffset}`,
    userCidr: `10.${secondOctet}.0.0/16`,
    anonymousCidr: `10.${secondOctet}.0.0/16`,
    userLeaseStart: `10.${secondOctet}.0.1`,
    userLeaseEnd: `10.${secondOctet}.99.254`,
    anonymousLeaseStart: `10.${secondOctet}.100.1`,
    anonymousLeaseEnd: `10.${secondOctet}.254.254`,
    rateLimitProfile: 'product-default'
  };
}

function launcherProductNetworkNotes(mode: LauncherProductMode): string[] {
  return mode === 'standalone'
    ? [
        'Launcher standalone mode owns the product peer lease and uses 10.89.0.1+ for signed-in users.',
        'Anonymous launcher standalone leases start at 10.89.100.1.'
      ]
    : [
        'Launcher embed mode does not allocate its own WG peer; it consumes the selected standalone channel context.',
        'The product service VIP stays in 10.88.100.0/24 and routes back to Internal 10.88.88.88 through Domestic relay.'
      ];
}

function leaseIpFromStart(startIp: string, sequence: number): string {
  const octets = startIp.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return startIp;
  const offset = Math.max(0, Math.floor(sequence) - 1);
  const base = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const next = (base + offset) >>> 0;
  return [
    (next >>> 24) & 255,
    (next >>> 16) & 255,
    (next >>> 8) & 255,
    next & 255
  ].join('.');
}

function leaseIpFromRange(startIp: string, endIp: string, sequence: number): string {
  const start = ipv4ToNumber(startIp);
  const end = ipv4ToNumber(endIp);
  if (start == null || end == null || end < start) return leaseIpFromStart(startIp, sequence);
  let seen = 0;
  const target = Math.max(1, Math.floor(sequence));
  for (let value = start; value <= end; value += 1) {
    const host = value & 255;
    if (host === 0 || host === 255) continue;
    seen += 1;
    if (seen === target) return numberToIpv4(value);
  }
  throw new Error(`Launcher network lease range exhausted: ${startIp}-${endIp}`);
}

function ipv4ToNumber(value: string): number | null {
  const octets = value.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function numberToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
}

export function createSdkGatewayManifest(config: RuntimeConfig): SdkGatewayManifest {
  const routes = [
    {
      routeId: 'sdk.oauth.token',
      path: '/internal/v1/sdk/oauth/token',
      upstreamModule: 'sdk-gateway',
      audience: 'mx-sdk',
      authRequired: false,
      description: 'OAuth-compatible token endpoint backed by User Center JWT records.'
    },
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
      routeId: 'sdk.roles.list',
      path: '/internal/v1/sdk/roles',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Lists User Center roles and their SDK/RBAC scopes.'
    },
    {
      routeId: 'sdk.users.list',
      path: '/internal/v1/sdk/users',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Lists active User Center users for trusted peer systems.'
    },
    {
      routeId: 'sdk.users.create',
      path: '/internal/v1/sdk/users',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Creates or upserts a User Center user through the SDK Gateway.'
    },
    {
      routeId: 'sdk.service_accounts.list',
      path: '/internal/v1/sdk/service-accounts',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Lists service accounts that can call SDK Gateway routes.'
    },
    {
      routeId: 'sdk.service_accounts.create',
      path: '/internal/v1/sdk/service-accounts',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Creates a service account and assigns SDK Gateway scopes.'
    },
    {
      routeId: 'sdk.permissions.request',
      path: '/internal/v1/sdk/permissions/requests',
      upstreamModule: 'permissions',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Requests app or install scoped permissions through the permission authority.'
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
      oauthTokenUrl: '/internal/v1/sdk/oauth/token',
      tokenIntrospectionUrl: '/internal/v1/sdk/identity/introspect',
      principalContextUrl: '/internal/v1/sdk/identity/context',
      rolesUrl: '/internal/v1/sdk/roles',
      usersUrl: '/internal/v1/sdk/users',
      serviceAccountsUrl: '/internal/v1/sdk/service-accounts',
      permissionsRequestUrl: '/internal/v1/sdk/permissions/requests',
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
  const launcherProduct = buildLauncherProductNetwork(config, {
    productId: enrollment.productId,
    mode: launcherNetworkProductIsStandaloneDefault(enrollment.productId) ? 'standalone' : 'embed'
  }, null);
  const launcherNetwork = buildLauncherNetworkTopology(config, {
    mode: enrollment.userId ? 'user' : 'guest',
    leaseIp: enrollment.overlayIp,
    product: launcherProduct,
    domesticSiteId: enrollment.siteId,
    publicKey: enrollment.publicKey
  });
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
      overlayIp: enrollment.overlayIp,
      launcherNetwork
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

export function buildLauncherNetworkTopology(
  config: RuntimeConfig,
  input: {
    mode: 'guest' | 'user';
    leaseIp: string;
    product: LauncherProductNetwork;
    domesticSiteId?: string | null;
    overseaSiteId?: string | null;
    publicKey?: string | null;
  }
): LauncherNetworkTopology {
  const internalBaseUrl = trimTrailingSlash(config.internalBaseUrl);
  const product = input.product;
  const domesticSiteId = input.domesticSiteId?.trim() || product.defaultDomesticSiteId;
  const overseaSiteId = input.overseaSiteId?.trim() || product.defaultOverseaSiteId;
  const cidr = input.mode === 'user' ? product.userCidr : product.anonymousCidr;
  const publicKey = input.publicKey?.trim() || null;
  const subscriptionBaseUrl = `${internalBaseUrl}/internal/v1/site-slots/${overseaSiteId}/subscriptions/hysteria2`;
  const internalCidrs = [...new Set(['10.88.0.0/16', product.userCidr, product.anonymousCidr])];
  return {
    model: 'internal-authority-domestic-relay-oversea-access-v1',
    product: {
      productId: product.productId,
      displayName: product.displayName,
      mode: product.mode,
      serviceVip: product.serviceVip,
      userCidr: product.userCidr,
      anonymousCidr: product.anonymousCidr,
      updatePolicy: product.updatePolicy,
      rateLimitProfile: product.rateLimitProfile,
      dnsPolicyId: product.dnsPolicyId,
      licensePolicyId: product.licensePolicyId
    },
    bootstrap: {
      order: [
        'deploy-oversea-access-if-domestic-needs-egress',
        'deploy-domestic-public-relay-foundation',
        'internal-joins-domestic-relay-as-service-peer',
        'home-enrolls-through-domestic-public-facade',
        'promote-home-to-domestic-wg-relay-primary'
      ],
      hdiWithoutRelay: 'bootstrap-proxy-only',
      steadyStateAccess: 'domestic-wg-relay-primary'
    },
    authority: {
      users: 'internal-user-center',
      config: 'internal-config-center',
      mihomo: 'internal-mihomo',
      dns: 'internal-coredns',
      release: 'internal-release-center'
    },
    homePath: {
      bootstrap: 'home-to-domestic-public-enroll-proxy',
      afterEnroll: 'home-to-domestic-wg-relay-to-internal',
      subscriptionFetch: 'home-through-domestic-h2i-to-internal-mihomo',
      overseaTraffic: 'home-direct-to-oversea-hysteria2'
    },
    homeLease: {
      mode: input.mode,
      ip: input.leaseIp,
      cidr
    },
    domestic: {
      siteId: domesticSiteId,
      role: 'relay-proxy-cache-forwarder',
      publicIpRequired: true,
      publicServices: ['api-facade', 'wg-relay', 'h2i-proxy', 'snapshot-cache', 'observability-forwarder'],
      gatewayIp: '10.88.0.1',
      overlayCidrs: internalCidrs,
      configSource: 'internal-signed-snapshot',
      storesAuthority: false,
      requiredFor: ['enroll-proxy', 'wg-relay', 'h2i-proxy', 'internal-dns', 'snapshot-cache']
    },
    internal: {
      siteId: config.siteId,
      publicIngress: false,
      baseUrl: internalBaseUrl,
      enrollUrl: `${internalBaseUrl}/internal/v1/enrollments/anonymous`,
      configSnapshotUrl: `${internalBaseUrl}/internal/v1/config/snapshots/{installId}`,
      mihomoSubscriptionBaseUrl: subscriptionBaseUrl,
      requiresEnrollLease: true,
      relayPeer: {
        required: true,
        fixedIp: '10.88.88.88',
        initiatedBy: 'internal-outbound-to-domestic-public-wg',
        purpose: 'make-internal-reachable-without-public-ip'
      }
    },
    oversea: {
      siteId: overseaSiteId,
      role: 'hysteria2-access-site',
      subscriptionAuthority: 'internal-mihomo',
      trafficPath: 'direct-after-subscription',
      healthEvidenceOutlet: {
        baseUrl: 'http://oversea.example.com:3434',
        healthPath: '/healthz',
        evidencePath: '/clients.csv',
        authority: 'internal-config-center',
        purpose: 'health-and-evidence'
      }
    },
    subscriptions: {
      mihomo: {
        authority: 'internal-config-center',
        siteId: overseaSiteId,
        baseUrl: subscriptionBaseUrl,
        fetchPath: `${subscriptionBaseUrl}/{username}.yaml`,
        reachableVia: ['domestic-wg-relay', 'h2i-proxy', 'internal-dns'],
        fallback: 'domestic-snapshot-cache'
      }
    },
    relayPlan: {
      authority: 'internal-config-center',
      domesticRelay: {
        siteId: domesticSiteId,
        interfaceName: 'mx-domestic',
        listenPort: 51280,
        gatewayIp: '10.88.0.1',
        publicEndpoint: null,
        publicKey: null,
        configArtifact: 'mx-domestic-wg-relay.conf',
        envArtifact: 'mx-domestic-relay.env'
      },
      refreshHint: {
        source: 'internal-domestic-wg-secret',
        mode: 'snapshot-digest',
        publicEndpoint: null,
        domesticRelayPublicKeyFingerprint: null,
        internalServicePublicKeyFingerprint: null,
        materialDigest: null,
        secretUpdatedAt: null
      },
      internalServicePeer: {
        role: 'internal-service',
        fixedIp: '10.88.88.88',
        allowedIps: ['10.88.88.88/32', `${product.serviceVip}/32`],
        configArtifact: 'mx-internal-service-peer.conf',
        privateKeyPlacement: 'internal-only',
        direction: 'internal-outbound-to-domestic-public-wg'
      },
      internalDirectPeer: {
        role: 'internal-direct-service',
        enabled: false,
        fixedIp: '10.88.88.88',
        endpoint: null,
        listenPort: 51280,
        publicKey: null,
        allowedIps: internalCidrs,
        configArtifact: 'mx-internal-service-peer.conf',
        peerMutation: 'append-home-peer-after-enroll',
        fallback: 'domestic-wg-relay'
      },
      homePeer: {
        role: input.mode,
        leaseIp: input.leaseIp,
        cidr,
        allowedIps: [`${input.leaseIp}/32`],
        publicKey,
        publicKeyStatus: publicKey ? 'ready-to-append' : 'pending-public-key',
        provisionedBy: 'internal-signed-relay-lease',
        domesticMutation: 'append-peer-after-enroll'
      },
      routes: {
        internalCidrs,
        dnsServer: '10.88.0.1',
        subscriptionReachability: 'domestic-wg-relay+h2i-proxy',
        externalTraffic: 'direct-to-oversea-hysteria2-after-subscription'
      },
      gates: {
        domesticConfigMustNotContainInternalPrivateKey: true,
        homePublicKeyRequiredForRealPeer: true,
        bootstrapFacadeOnlyBeforeLease: true,
        steadyStateRequiresDomesticRelay: true
      }
    },
    gates: {
      anonymousEnrollBeforeInternalReachability: true,
      domesticPublicFacadeOnlyBootstrapsEnroll: true,
      fixedInternalIpAfterEnroll: true,
      internalPublicIpRequired: false,
      internalMustJoinDomesticRelayBeforeHomeCanReachInternal: true,
      wgRelayBecomesPrimaryAfterEnroll: true,
      domesticMustNotOwnUsersOrSubscriptions: true,
      overseaMustNotOwnSubscriptionStore: true
    }
  };
}

export function attachDomesticWireGuardRefreshHint(
  topology: LauncherNetworkTopology,
  secret: SiteSlotDomesticWireGuardSecret | null
): LauncherNetworkTopology {
  return {
    ...topology,
    relayPlan: {
      ...topology.relayPlan,
      domesticRelay: {
        ...topology.relayPlan.domesticRelay,
        publicEndpoint: secret?.publicEndpoint ?? null,
        publicKey: secret?.domesticRelayPublicKey ?? null
      },
      internalDirectPeer: {
        ...topology.relayPlan.internalDirectPeer,
        enabled: secret?.internalDirectEnabled === true,
        endpoint: secret?.internalDirectEndpoint ?? null,
        listenPort: secret?.internalDirectListenPort ?? topology.relayPlan.internalDirectPeer.listenPort,
        publicKey: secret?.internalServicePublicKey ?? null
      },
      refreshHint: {
        source: 'internal-domestic-wg-secret',
        mode: 'snapshot-digest',
        publicEndpoint: secret?.publicEndpoint ?? null,
        domesticRelayPublicKeyFingerprint: secret?.fingerprints.domesticRelayPublicKey ?? null,
        internalServicePublicKeyFingerprint: secret?.fingerprints.internalServicePublicKey ?? null,
        materialDigest: secret?.fingerprints.materialDigest ?? null,
        secretUpdatedAt: secret?.updatedAt ?? null
      }
    }
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
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
  const baseWarnings = siteSlotWarnings(kind, input, profile, profileMatches, host, rootAccess, networkMode);
  const sshProfileId = input.sshProfileId?.trim() || profile?.profileId || null;
  const domesticRuntimeConfig = kind === 'domestic'
    ? input.domesticRuntimeConfig ?? buildSiteSlotDomesticRuntimeConfig(config, {
        siteId,
        bootstrapHost: bootstrapHostFromPlanHost(host)
      }, null, createdAt)
    : null;
  const hasOverseaCallbackInput = Object.prototype.hasOwnProperty.call(input, 'overseaCallbackBaseUrl');
  const runtimeInput = kind === 'oversea'
    ? {
        ...input,
        serverPorts: input.serverPorts ?? activeProfile?.serverPorts,
        exportPort: input.exportPort ?? activeProfile?.exportPort,
        workerInternalBaseUrl: input.workerInternalBaseUrl ?? activeProfile?.workerInternalBaseUrl ?? input.internalBaseUrl,
        overseaCallbackBaseUrl: hasOverseaCallbackInput
          ? input.overseaCallbackBaseUrl ?? null
          : activeProfile?.overseaCallbackBaseUrl ?? null
      }
    : input;
  const overseaRuntimeConfig = kind === 'oversea'
    ? buildSiteSlotOverseaRuntimeConfig(runtimeInput, host)
    : null;
  const warnings = [
    ...baseWarnings,
    ...(domesticRuntimeConfig?.warnings.map((warning) => warning.startsWith('blocked:')
      ? `blocked: domestic-runtime ${warning.slice('blocked:'.length).trim()}`
      : `domestic-runtime: ${warning}`
    ) ?? []),
    ...(overseaRuntimeConfig?.warnings.map((warning) => `oversea-runtime: ${warning}`) ?? [])
  ];
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
    runtime: {
      domestic: domesticRuntimeConfig,
      oversea: overseaRuntimeConfig
    },
    preflightChecks: siteSlotPreflightChecks(kind, runtimeInput, host, sshUser, sshPort, networkMode),
    deploymentPhases: siteSlotDeploymentPhases(kind, runtimeInput, host, sshUser, sshPort, networkMode, domesticRuntimeConfig, overseaRuntimeConfig),
    warnings,
    nextActions: siteSlotNextActions(kind, status, networkMode, runtimeInput),
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
    : previous?.connectTimeoutSeconds ?? 30;
  const batchMode = input.batchMode === 'no' ? 'no' : previous?.batchMode ?? 'yes';
  const status = input.status === 'paused' ? 'paused' : 'active';
  const warnings: string[] = [];
  const identityFile = input.identityFile?.trim() || previous?.identityFile || null;
  const knownHostsFile = input.knownHostsFile?.trim() || previous?.knownHostsFile || null;
  const sshConfigFile = input.sshConfigFile?.trim() || previous?.sshConfigFile || null;
  const hostKeyAlias = input.hostKeyAlias?.trim() || previous?.hostKeyAlias || null;
  const serverPorts = kind === 'oversea'
    ? normalizeHysteria2ServerPorts(input.serverPorts ?? previous?.serverPorts).normalized
    : null;
  const exportPort = kind === 'oversea'
    ? normalizeTcpPort(input.exportPort ?? previous?.exportPort, HYSTERIA2_EXPORT_FALLBACK_PORT)
    : null;
  const rawWorkerInternalBaseUrl = input.workerInternalBaseUrl ?? input.internalBaseUrl ?? previous?.workerInternalBaseUrl ?? null;
  const rawOverseaCallbackBaseUrl = input.overseaCallbackBaseUrl ?? null;
  const workerInternalBaseUrl = kind === 'oversea'
    ? normalizeOptionalInternalWorkerHttpUrl(rawWorkerInternalBaseUrl)
    : null;
  const overseaCallbackBaseUrl = kind === 'oversea'
    ? normalizeOptionalOverseaCallbackHttpUrl(rawOverseaCallbackBaseUrl)
    : null;
  if (kind === 'oversea' && input.serverPorts && serverPorts !== input.serverPorts.trim()) {
    warnings.push(`runtime: invalid Hysteria2 serverPorts "${input.serverPorts}", using ${serverPorts}`);
  }
  if (kind === 'oversea' && input.exportPort != null && exportPort !== input.exportPort) {
    warnings.push(`runtime: invalid health/evidence exportPort "${input.exportPort}", using ${exportPort}`);
  }
  if (kind === 'oversea' && rawWorkerInternalBaseUrl && isK8sServiceHttpUrl(rawWorkerInternalBaseUrl)) {
    warnings.push('runtime: Kubernetes service DNS workerInternalBaseUrl ignored; Internal-local worker URL will be used at execution time');
  }
  if (kind === 'oversea' && rawOverseaCallbackBaseUrl && isK8sServiceHttpUrl(rawOverseaCallbackBaseUrl)) {
    warnings.push('runtime: Kubernetes service DNS overseaCallbackBaseUrl ignored; push-only mode will be used');
  }
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
    sshConfigFile,
    hostKeyAlias,
    serverPorts,
    exportPort,
    workerInternalBaseUrl,
    overseaCallbackBaseUrl,
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

export function buildSiteSlotDomesticWireGuardSecret(
  config: RuntimeConfig,
  input: SiteSlotDomesticWireGuardSecretInput,
  previous: SiteSlotDomesticWireGuardSecret | null,
  now = new Date().toISOString()
): SiteSlotDomesticWireGuardSecret {
  const siteId = input.siteId?.trim() || previous?.siteId || 'domestic-main';
  const listenPort = input.listenPort && input.listenPort > 0 ? Math.floor(input.listenPort) : previous?.listenPort ?? 51280;
  const publicEndpoint = input.publicEndpoint?.trim() || previous?.publicEndpoint || null;
  const internalDirectListenPort = input.internalDirectListenPort && input.internalDirectListenPort > 0
    ? Math.floor(input.internalDirectListenPort)
    : previous?.internalDirectListenPort ?? 51280;
  const internalDirectEndpoint = input.internalDirectEndpoint?.trim() || previous?.internalDirectEndpoint || null;
  const internalDirectEnabled = input.internalDirectEnabled === true
    || input.internalDirectEnabled === false
      ? input.internalDirectEnabled
      : previous?.internalDirectEnabled ?? Boolean(internalDirectEndpoint);
  const material = {
    domesticRelayPrivateKey: input.domesticRelayPrivateKey?.trim() || previous?.domesticRelayPrivateKey || null,
    domesticRelayPublicKey: input.domesticRelayPublicKey?.trim() || previous?.domesticRelayPublicKey || null,
    internalServicePrivateKey: input.internalServicePrivateKey?.trim() || previous?.internalServicePrivateKey || null,
    internalServicePublicKey: input.internalServicePublicKey?.trim() || previous?.internalServicePublicKey || null
  };
  const missingSecretInputs = [
    material.domesticRelayPrivateKey ? null : 'MX_DOMESTIC_RELAY_PRIVATE_KEY',
    material.domesticRelayPublicKey ? null : 'MX_DOMESTIC_RELAY_PUBLIC_KEY',
    material.internalServicePrivateKey ? null : 'MX_INTERNAL_SERVICE_PRIVATE_KEY',
    material.internalServicePublicKey ? null : 'MX_INTERNAL_SERVICE_PUBLIC_KEY',
    publicEndpoint ? null : 'MX_DOMESTIC_PUBLIC_ENDPOINT'
  ].filter((value): value is string => Boolean(value));
  const normalizedProductRelayCidrs = productRelayCidrs(input.productRelayCidrs, previous?.productRelayCidrs);
  const updatedBy = input.requestedBy?.trim() || 'config-center';
  return {
    secretId: `domesticwg_${safeIdPart(siteId)}`,
    siteId,
    kind: 'domestic',
    environment: config.environment,
    status: input.status === 'paused' ? 'paused' : 'active',
    publicEndpoint,
    listenPort,
    internalDirectEnabled,
    internalDirectEndpoint,
    internalDirectListenPort,
    domesticGatewayIp: input.domesticGatewayIp?.trim() || previous?.domesticGatewayIp || '10.88.0.1',
    domesticGatewayCidr: input.domesticGatewayCidr?.trim() || previous?.domesticGatewayCidr || '10.88.0.0/16',
    productRelayCidrs: normalizedProductRelayCidrs,
    userRelayCidr: input.userRelayCidr?.trim() || previous?.userRelayCidr || '10.89.0.0/16',
    internalServiceIp: input.internalServiceIp?.trim() || previous?.internalServiceIp || '10.88.88.88',
    internalServiceCidr: input.internalServiceCidr?.trim() || previous?.internalServiceCidr || '10.88.0.0/16',
    guestRelayCidr: input.guestRelayCidr?.trim() || previous?.guestRelayCidr || '10.90.0.0/16',
    ...material,
    fingerprints: {
      domesticRelayPublicKey: material.domesticRelayPublicKey ? shortDigest(material.domesticRelayPublicKey) : null,
      internalServicePublicKey: material.internalServicePublicKey ? shortDigest(material.internalServicePublicKey) : null,
      materialDigest: shortDigest([
        siteId,
        publicEndpoint ?? '',
        String(listenPort),
        internalDirectEndpoint ?? '',
        String(internalDirectListenPort),
        String(internalDirectEnabled),
        material.domesticRelayPublicKey ?? '',
        material.internalServicePublicKey ?? '',
        normalizedProductRelayCidrs.join(',')
      ].join('|'))
    },
    readiness: {
      secretMaterial: missingSecretInputs.length === 0 ? 'injected' : 'placeholder',
      publicEndpointStatus: publicEndpoint ? 'ready' : 'placeholder',
      missingSecretInputs,
      materializerEnvKeys: [
        'MX_DOMESTIC_RELAY_PRIVATE_KEY',
        'MX_DOMESTIC_RELAY_PUBLIC_KEY',
        'MX_INTERNAL_SERVICE_PRIVATE_KEY',
        'MX_INTERNAL_SERVICE_PUBLIC_KEY',
        'MX_DOMESTIC_PUBLIC_ENDPOINT',
        'MX_INTERNAL_DIRECT_ENDPOINT',
        'MX_INTERNAL_DIRECT_LISTEN_PORT',
        'MX_INTERNAL_DIRECT_ENABLED',
        'MX_WG_LISTEN_PORT',
        'MX_DOMESTIC_GATEWAY_IP',
        'MX_DOMESTIC_GATEWAY_CIDR',
        'MX_PRODUCT_RELAY_CIDRS',
        'MX_USER_RELAY_CIDR',
        'MX_INTERNAL_SERVICE_IP',
        'MX_INTERNAL_SERVICE_CIDR',
        'MX_GUEST_RELAY_CIDR'
      ]
    },
    createdBy: previous?.createdBy ?? updatedBy,
    createdAt: previous?.createdAt ?? now,
    updatedBy,
    updatedAt: now
  };
}

export function buildSiteSlotDomesticRuntimeConfig(
  config: RuntimeConfig,
  input: SiteSlotDomesticRuntimeConfigInput,
  previous: SiteSlotDomesticRuntimeConfig | null,
  now = new Date().toISOString()
): SiteSlotDomesticRuntimeConfig {
  const siteId = input.siteId?.trim() || previous?.siteId || 'domestic-main';
  const status = input.status === 'paused' ? 'paused' : 'active';
  const edgeBind = input.edgeBind?.trim() || previous?.edge.bind || '0.0.0.0';
  const edgePort = positivePort(input.edgePort, previous?.edge.port, 18090);
  const bootstrapProtocol = normalizeProtocol(input.bootstrapProtocol || previousBootstrapProtocol(previous) || 'http');
  const bootstrapHost = input.bootstrapHost?.trim() || previousBootstrapHost(previous) || 'api.mxinfo-inc.cn';
  const bootstrapPort = positivePort(input.bootstrapPort, previousBootstrapPort(previous), edgePort);
  const internalBaseUrl = normalizeHttpUrl(input.internalBaseUrl || previous?.upstreams.internalBaseUrl || 'http://10.88.88.88:18090');
  const internalApi = normalizeHttpUrl(input.internalApiUpstream || previous?.upstreams.internalApi || internalBaseUrl);
  const internalH2i = normalizeHttpUrl(input.internalH2iUpstream || previous?.upstreams.internalH2i || internalBaseUrl);
  const dnsBind = input.dnsBind?.trim() || previous?.dns.bind || '10.88.0.1';
  const dnsPort = positivePort(input.dnsPort, previous?.dns.port, 53);
  const publicBaseUrl = `${bootstrapProtocol}://${bootstrapHost}${defaultPortForProtocol(bootstrapProtocol) === bootstrapPort ? '' : `:${bootstrapPort}`}`;
  const env = domesticRuntimeEnv({
    siteId,
    internalBaseUrl,
    internalApi,
    internalH2i,
    edgeBind,
    edgePort,
    dnsBind,
    dnsPort
  });
  const warnings = [
    ...(status === 'paused' ? ['blocked: Domestic runtime config is paused'] : []),
    ...(!isHttpUrl(internalApi) ? [`blocked: internalApiUpstream must be http(s): ${internalApi}`] : []),
    ...(!isHttpUrl(internalH2i) ? [`blocked: internalH2iUpstream must be http(s): ${internalH2i}`] : []),
    ...(edgeBind === '0.0.0.0' ? ['public-bind: Domestic edge listens on all interfaces; protect with cloud firewall/security group'] : []),
    ...(bootstrapHost === 'api.mxinfo-inc.cn' ? ['default-domain: update bootstrapHost when production DNS is ready'] : [])
  ];
  const digestSource = JSON.stringify({
    siteId,
    status,
    edgeBind,
    edgePort,
    publicBaseUrl,
    internalBaseUrl,
    internalApi,
    internalH2i,
    dnsBind,
    dnsPort,
    env
  });
  return {
    configId: `domesticruntime_${safeIdPart(siteId)}`,
    siteId,
    kind: 'domestic-runtime',
    environment: config.environment,
    status,
    edge: {
      bind: edgeBind,
      port: edgePort,
      publicBaseUrl
    },
    upstreams: {
      internalBaseUrl,
      internalApi,
      internalH2i
    },
    dns: {
      bind: dnsBind,
      port: dnsPort
    },
    env,
    warnings,
    fingerprints: {
      configDigest: shortDigest(digestSource)
    },
    createdBy: previous?.createdBy || input.requestedBy?.trim() || 'config-center',
    createdAt: previous?.createdAt || now,
    updatedBy: input.requestedBy?.trim() || previous?.updatedBy || 'config-center',
    updatedAt: now
  };
}

function domesticRuntimeEnv(input: {
  siteId: string;
  internalBaseUrl: string;
  internalApi: string;
  internalH2i: string;
  edgeBind: string;
  edgePort: number;
  dnsBind: string;
  dnsPort: number;
}): Record<string, string> {
  return {
    MX_SITE_ID: input.siteId,
    MX_SITE_ROLE: 'domestic',
    MX_INTERNAL_BASE_URL: input.internalBaseUrl,
    MX_INTERNAL_API_UPSTREAM: input.internalApi,
    MX_INTERNAL_H2I_UPSTREAM: input.internalH2i,
    MX_DOMESTIC_EDGE_BIND: input.edgeBind,
    MX_DOMESTIC_EDGE_PORT: String(input.edgePort),
    MX_DOMESTIC_DNS_BIND: input.dnsBind,
    MX_DOMESTIC_DNS_PORT: String(input.dnsPort)
  };
}

function positivePort(input: number | null | undefined, previous: number | undefined, fallback: number): number {
  const value = Number(input ?? previous ?? fallback);
  return Number.isFinite(value) && value > 0 && value <= 65535 ? Math.floor(value) : fallback;
}

function normalizeProtocol(value: string | null | undefined): 'http' | 'https' {
  return value?.replace(/:$/, '').toLowerCase() === 'https' ? 'https' : 'http';
}

function defaultPortForProtocol(protocol: 'http' | 'https'): number {
  return protocol === 'https' ? 443 : 80;
}

function previousBootstrapProtocol(previous: SiteSlotDomesticRuntimeConfig | null): string | null {
  if (!previous) return null;
  try {
    return new URL(previous.edge.publicBaseUrl).protocol.replace(/:$/, '');
  } catch {
    return null;
  }
}

function previousBootstrapHost(previous: SiteSlotDomesticRuntimeConfig | null): string | null {
  if (!previous) return null;
  try {
    return new URL(previous.edge.publicBaseUrl).hostname;
  } catch {
    return null;
  }
}

function previousBootstrapPort(previous: SiteSlotDomesticRuntimeConfig | null): number | undefined {
  if (!previous) return undefined;
  try {
    const parsed = new URL(previous.edge.publicBaseUrl);
    return parsed.port ? Number(parsed.port) : defaultPortForProtocol(normalizeProtocol(parsed.protocol));
  } catch {
    return undefined;
  }
}

function bootstrapHostFromPlanHost(host: string | null): string | null {
  const value = host?.trim();
  if (!value) return null;
  const normalized = value.includes('://') ? value : `http://${value}`;
  try {
    return new URL(normalized).hostname || null;
  } catch {
    const authority = value.split('/')[0] ?? value;
    const withoutUserInfo = authority.includes('@') ? authority.split('@').pop() ?? authority : authority;
    return withoutUserInfo.replace(/:\d+$/, '').trim() || null;
  }
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed || 'http://10.88.88.88:18090';
}

function normalizeOptionalHttpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '') || '';
  return trimmed || null;
}

function isK8sServiceHttpUrl(value: string | null | undefined): boolean {
  const normalized = normalizeOptionalHttpUrl(value);
  if (!normalized) return false;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return host.endsWith('.svc.cluster.local') || host.endsWith('.svc') || host.includes('.svc.');
  } catch {
    return false;
  }
}

function normalizeOptionalInternalWorkerHttpUrl(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalHttpUrl(value);
  return normalized && !isK8sServiceHttpUrl(normalized) ? normalized : null;
}

function normalizeOptionalOverseaCallbackHttpUrl(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalHttpUrl(value);
  return normalized && !isK8sServiceHttpUrl(normalized) ? normalized : null;
}

function siteSlotWorkerInternalBaseUrl(input: SiteSlotPlanInput): string | null {
  return normalizeOptionalInternalWorkerHttpUrl(input.workerInternalBaseUrl ?? input.internalBaseUrl ?? null);
}

function siteSlotOverseaCallbackBaseUrl(input: SiteSlotPlanInput): string | null {
  return normalizeOptionalOverseaCallbackHttpUrl(input.overseaCallbackBaseUrl ?? null);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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

export function buildAwxProviderConfig(
  config: RuntimeConfig,
  input: AwxProviderConfigInput,
  previous: AwxProviderConfig | null,
  now = new Date().toISOString()
): AwxProviderConfig {
  const defaultKind = awxProviderKind(input.defaultKind ?? previous?.defaultKind);
  const name = input.name?.trim() || previous?.name || defaultAwxProviderName(defaultKind);
  const providerId = input.providerId?.trim() || previous?.providerId || `awxprov_${safeIdPart(defaultKind)}`;
  const baseUrl = input.baseUrl?.trim() || previous?.baseUrl || null;
  const status = awxProviderStatus(input.status ?? previous?.status);
  const organization = input.organization?.trim() || previous?.organization || 'MX Internal';
  const project = input.project?.trim() || previous?.project || 'mx-launcher-site-slots';
  const inventoryPrefix = input.inventoryPrefix?.trim() || previous?.inventoryPrefix || 'mx';
  const credentialPrefix = input.credentialPrefix?.trim() || previous?.credentialPrefix || 'mx';
  const jobTemplatePrefix = input.jobTemplatePrefix?.trim() || previous?.jobTemplatePrefix || 'mx-site-slot';
  const verifyTls = typeof input.verifyTls === 'boolean' ? input.verifyTls : previous?.verifyTls ?? true;
  const requestTimeoutSeconds = input.requestTimeoutSeconds && input.requestTimeoutSeconds > 0
    ? Math.min(Math.floor(input.requestTimeoutSeconds), 300)
    : previous?.requestTimeoutSeconds ?? 30;
  const warnings: string[] = [];
  if (!baseUrl) warnings.push('missing: baseUrl is required before awx-api provider can launch jobs');
  if (status === 'paused') warnings.push('paused: provider will not be selected for new awx-shadow evidence');
  if (defaultKind === 'all') warnings.push('scope: provider applies to all site-slot kinds unless a kind-specific provider exists');
  return {
    providerId,
    name,
    environment: config.environment,
    status,
    baseUrl,
    organization,
    project,
    inventoryPrefix,
    credentialPrefix,
    jobTemplatePrefix,
    defaultKind,
    verifyTls,
    requestTimeoutSeconds,
    source: 'config-center',
    warnings,
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
  const mode = input.mode === 'remote-ssh'
    ? 'remote-ssh'
    : input.mode === 'awx-shadow'
      ? 'awx-shadow'
      : 'simulate';
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
    dryRun: mode !== 'remote-ssh',
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
  if (value === 'internal-runner' || value === 'domestic-runner' || value === 'oversea-site-agent' || value === 'awx-runner' || value === 'admin-manual') {
    return value;
  }
  if (session.mode === 'simulate') return 'internal-runner';
  if (session.mode === 'awx-shadow') return 'awx-runner';
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
  if (mode === 'awx-shadow') return ['dispatch-to-awx-shadow-provider', 'record-awx-task-events', 'review-awx-evidence'];
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
  if (mode === 'remote-ssh' || mode === 'awx-shadow') return 'queued';
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
  if (status === 'queued' && mode === 'awx-shadow') return ['attach-awx-shadow-worker', 'record-awx-shadow-events'];
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
          || phase.phaseId === 'activate-domestic-peer-center'
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

function buildSiteSlotOverseaRuntimeConfig(input: SiteSlotPlanInput, host: string | null): SiteSlotOverseaRuntimeConfig {
  const serverPorts = normalizeHysteria2ServerPorts(input.serverPorts);
  const exportPort = normalizeTcpPort(input.exportPort, HYSTERIA2_EXPORT_FALLBACK_PORT);
  const workerInternalBaseUrl = siteSlotWorkerInternalBaseUrl(input);
  const overseaCallbackBaseUrl = siteSlotOverseaCallbackBaseUrl(input);
  const warnings: string[] = [];
  if (input.serverPorts && serverPorts.normalized !== input.serverPorts.trim()) {
    warnings.push(`invalid Hysteria2 serverPorts "${input.serverPorts}", using ${serverPorts.normalized}`);
  }
  if (input.exportPort != null && exportPort !== input.exportPort) {
    warnings.push(`invalid health/evidence exportPort "${input.exportPort}", using ${exportPort}`);
  }
  return {
    serverPorts: serverPorts.normalized,
    firstServerPort: serverPorts.firstPort,
    exportPort,
    exportBaseUrl: host ? `http://${host}:${exportPort}` : null,
    workerInternalBaseUrl,
    overseaCallbackBaseUrl,
    callbackMode: overseaCallbackBaseUrl ? 'remote-callback' : 'push-only',
    warnings
  };
}

function normalizeHysteria2ServerPorts(value: string | null | undefined): { normalized: string; firstPort: number } {
  const raw = value?.trim() || HYSTERIA2_ACCESS_PORTS;
  const match = /^([0-9]{1,5})(?:-([0-9]{1,5}))?$/.exec(raw);
  if (!match) return { normalized: HYSTERIA2_ACCESS_PORTS, firstPort: HYSTERIA2_ACCESS_PORT };
  const firstPort = Number(match[1]);
  const lastPort = Number(match[2] ?? match[1]);
  if (!isValidPort(firstPort) || !isValidPort(lastPort) || firstPort > lastPort) {
    return { normalized: HYSTERIA2_ACCESS_PORTS, firstPort: HYSTERIA2_ACCESS_PORT };
  }
  return {
    normalized: match[2] ? `${firstPort}-${lastPort}` : String(firstPort),
    firstPort
  };
}

function normalizeTcpPort(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && isValidPort(value) ? value : fallback;
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function qpTunnelCliMode(kind: SiteSlotKind, mode: SiteSlotNetworkMode): SiteSlotPlan['network']['qpTunnelCliMode'] {
  if (kind === 'oversea') return 'server-on';
  if (mode === 'oversea-assisted') return 'egress-on';
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
    warnings.push('warning: domestic outbound bootstrap depends on Oversea subscription and qp-tunnel-cli hdo/egress-on');
    warnings.push('warning: materialize mx-domestic-qp-tunnel-cli-fallback before bootstrap because Domestic may have no node/npm or registry egress until egress-on is available');
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
        '@qpjoy/tunnel-cli hdo/egress-on outbound bootstrap'
      ],
    dockerStacks: ['mx-domestic-edge-api', 'mx-h2i-proxy', 'mx-snapshot-cache', 'mx-observability-forwarder'],
    dockerPreferred: true,
    hostServiceReason: 'Domestic has limited memory/disk but owns WireGuard relay and routing; network kernel pieces stay on the host, while API/cache/forwarder stay in Docker.'
  };
}

function siteSlotAccess(kind: SiteSlotKind): SiteSlotPlan['access'] {
  const reservedInternalCidrs = ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16'];
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
      'H endpoints keep cn-direct; only DNS plus reserved 10.88.0.0/16, 10.89.0.0/16, and configured product CIDRs such as 10.90.0.0/16 go through Internal/WG, while external traffic uses the Oversea hysteria2 subscription. Domestic defaults to 10.88.0.1.'
    ];
  }
  if (mode === 'oversea-assisted') {
    return [
      'Domestic cannot rely on direct outbound internet during bootstrap.',
      'Configure Oversea first, let Internal issue the Domestic bootstrap account/subscription, then push the Internal-materialized qp-tunnel-cli fallback and use hdo/egress-on so the host can pull Docker and service dependencies without taking over inbound return routes.',
      'After egress-on is up, optionally refresh the global @qpjoy/tunnel-cli with .npmrc/private registry access or a published npm tarball synced into Internal. Initial no-egress bootstrap must not depend on node/npm on Domestic.',
      'Keep egress-on as the Domestic default for public hosts. tun-on is persistent but should stay a non-public-host or break-glass mode because it proxies full host traffic and can break public service return paths.'
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
  const dockerReadonlyProbe = 'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>/dev/null || docker version; else echo "docker: missing"; fi; if docker compose version >/dev/null 2>&1; then docker compose version; else echo "docker compose: missing"; fi';
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
      command: remote(dockerReadonlyProbe),
      expected: kind === 'oversea'
        ? 'Docker Engine and docker compose are reported when present; missing Docker is acceptable before the Oversea installer step.'
        : 'Docker Engine and docker compose are installed and usable, or the missing state is recorded before install.',
      remediation: kind === 'oversea'
        ? 'Keep SSH reachable; the Oversea install stage will install Docker before starting hysteria2.'
        : 'Install Docker first or use an offline Docker package bundle when outbound internet is unavailable.'
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
        checkId: 'domestic.public-ingress-firewall',
        title: 'Public ingress firewall and security group check',
        stage: 'security',
        severity: 'required',
        requiresRoot: false,
        command: [
          `Operator evidence: allow UDP 51280 to ${host ?? '<domestic-public-host>'} for WireGuard relay.`,
          `Operator evidence: allow TCP 443 to ${host ?? '<domestic-public-host>'} for bootstrap/enroll/snapshot/H2I facade; TCP 80 is optional for ACME/redirect only.`,
          `Operator evidence: restrict TCP ${sshPort} SSH to Internal/admin source IPs and keep 3000/5432/18090/Docker daemon private.`
        ].join(' '),
        expected: 'Cloud security group and host firewall expose only the Domestic public relay/facade ports required by the plan',
        remediation: 'Open udp/51280 and tcp/443 on the public Domestic address, optionally tcp/80 for certificates, restrict ssh, and keep Internal/API/database ports private.'
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
          ? 'Configure Oversea, consume the Internal-issued Oversea hysteria2 bootstrap subscription with @qpjoy/tunnel-cli hdo/egress-on, then install Docker before starting Domestic services.'
          : 'Fix egress routing, DNS, firewall, or proxy before deployment.'
      },
      {
        checkId: 'domestic.qp-tunnel-cli',
        title: '@qpjoy/tunnel-cli check',
        stage: 'network',
        severity: mode === 'oversea-assisted' ? 'recommended' : 'optional',
        requiresRoot: false,
        command: remote('command -v qp-tunnel-cli || command -v qpjoy-tunnel-cli || { test -x /opt/mx/current/qp-tunnel-cli/bin/qp-tunnel-cli && echo /opt/mx/current/qp-tunnel-cli/bin/qp-tunnel-cli; } || echo "qp-tunnel-cli: will be pushed by Internal fallback"'),
        expected: mode === 'oversea-assisted' ? 'Global qp-tunnel-cli may be absent before artifact push; the Internal fallback provides hdo/egress-on outbound bootstrap, and tun-on is persistent but not the public Domestic default' : 'Only required when Domestic cannot access outbound internet directly',
        remediation: 'Refresh the Internal fallback from npm pack or --from-tarball, then materialize and push mx-domestic-qp-tunnel-cli-fallback.tar.gz before network bootstrap.'
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
  const workerInternalBaseUrl = siteSlotWorkerInternalBaseUrl(input);
  const overseaCallbackBaseUrl = siteSlotOverseaCallbackBaseUrl(input);
  if (workerInternalBaseUrl && kind === 'domestic') {
    checks.push({
      checkId: 'domestic.internal-after-relay',
      title: 'Internal after-relay reachability',
      stage: 'network',
      severity: 'recommended',
      requiresRoot: false,
      command: remote('echo "Internal has no public ingress; verify http://10.88.88.88:18090/healthz only after mx-domestic WireGuard relay is active"'),
      expected: 'Domestic does not require public Internal reachability before WG relay activation',
      remediation: 'Start the Internal service peer with mx-internal-service-peer.conf, then verify Domestic can reach Internal at 10.88.88.88:18090 through mx-domestic.'
    });
  } else if (kind === 'oversea' && overseaCallbackBaseUrl) {
    checks.push({
      checkId: 'oversea.internal-callback-reachability',
      title: 'Optional Internal callback reachability',
      stage: 'network',
      severity: 'optional',
      requiresRoot: false,
      command: remote(`curl -fsS --max-time 8 ${overseaCallbackBaseUrl.replace(/'/g, '')}/healthz || echo "warning: Internal callback URL is not reachable from Oversea; continuing in push-only mode"`),
      expected: 'Optional: Oversea can reach the callback URL if remote self-registration is enabled',
      remediation: 'Leave Oversea callback URL empty for Internal-pushed mode, or expose a trusted callback path through Domestic/WG/VPN.'
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
  mode: SiteSlotNetworkMode,
  domesticRuntimeConfig: SiteSlotDomesticRuntimeConfig | null,
  overseaRuntimeConfig: SiteSlotOverseaRuntimeConfig | null
): SiteSlotPlan['deploymentPhases'] {
  const target = host ?? `<${kind}-host>`;
  const artifactRoot = `./artifacts/site-slots/${kind}`;
  const incomingDir = '/opt/mx/incoming';
  const releaseRevision = '__release_revision__';
  const releaseRoot = '/opt/mx/releases';
  const currentRoot = '/opt/mx/current';
  const slotServiceBundleName = `mx-${kind}-services.tar.gz`;
  const slotServiceBundle = `${artifactRoot}/${slotServiceBundleName}`;
  const slotReleaseDir = `${releaseRoot}/${kind}/${releaseRevision}`;
  const slotCurrentDir = `${currentRoot}/${kind}`;
  const domesticEnvWriteCommand = domesticRuntimeConfig
    ? `printf "%s\\n" ${domesticRuntimeEnvLines(domesticRuntimeConfig).map(shellDoubleQuote).join(' ')} > ${slotCurrentDir}/.env`
    : `cp -n ${slotCurrentDir}/.env.example ${slotCurrentDir}/.env`;
  const domesticTunnelCliBundleName = 'mx-domestic-qp-tunnel-cli-fallback.tar.gz';
  const domesticTunnelCliBundle = `${artifactRoot}/${domesticTunnelCliBundleName}`;
  const domesticTunnelCliReleaseDir = `${releaseRoot}/qp-tunnel-cli/${releaseRevision}`;
  const domesticTunnelCliCurrentDir = `${currentRoot}/qp-tunnel-cli`;
  const overseaAccessStackBundleName = 'mx-oversea-access-stack.tar.gz';
  const overseaAccessStackBundle = `${artifactRoot}/${overseaAccessStackBundleName}`;
  const overseaAccessStackReleaseDir = `${releaseRoot}/oversea-access-stack/${releaseRevision}`;
  const overseaAccessStackCurrentDir = `${currentRoot}/hysteria2-access-stack`;
  const domesticWireGuardConfig = `${artifactRoot}/mx-domestic-wg-relay.conf`;
  const domesticRelayEnv = `${artifactRoot}/mx-domestic-relay.env`;
  const internalServicePeerConfig = `${artifactRoot}/mx-internal-service-peer.conf`;
  const domesticBootstrapSubscriptionName = 'mx-domestic-bootstrap-subscription.yaml';
  const domesticBootstrapSubscriptionArtifact = `${artifactRoot}/${domesticBootstrapSubscriptionName}`;
  const domesticBootstrapSubscriptionRemote = `${domesticTunnelCliCurrentDir}/domestic-bootstrap-subscription.yaml`;
  const ssh = (command: string) => `ssh -p ${sshPort} ${sshUser}@${target} '${command}'`;
  const dockerReadonlyProbe = 'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>/dev/null || docker version; else echo "docker: missing"; fi; if docker compose version >/dev/null 2>&1; then docker compose version; else echo "docker compose: missing"; fi';
  const scp = (source: string, dest: string) => `scp -P ${sshPort} ${source} ${sshUser}@${target}:${dest}`;
  const scpRecursive = (source: string, dest: string) => `scp -r -P ${sshPort} ${source} ${sshUser}@${target}:${dest}`;
  const rsyncOverSsh = (source: string, dest: string, deleteStale = false) => {
    const flags = deleteStale ? '-az --delete' : '-az';
    return `if command -v rsync >/dev/null 2>&1; then rsync ${flags} -e 'ssh -p ${sshPort}' ${source} ${sshUser}@${target}:${dest}; else ${source.endsWith('/') ? scpRecursive(source, dest) : scp(source, dest)}; fi`;
  };
  const workerInternalBaseUrl = siteSlotWorkerInternalBaseUrl(input) ?? '<worker-internal-base-url>';
  const overseaCallbackBaseUrl = kind === 'oversea'
    ? siteSlotOverseaCallbackBaseUrl(input)
    : workerInternalBaseUrl;
  const overseaCallbackMode = overseaCallbackBaseUrl ? 'remote-callback' : 'push-only';
  const internalMihomoBaseUrl = overseaCallbackBaseUrl
    ? `${overseaCallbackBaseUrl}/internal/v1/launcher-network/mihomo`
    : '';
  const overseaSiteId = kind === 'domestic'
    ? input.overseaSiteId?.trim() || 'oversea-main'
    : input.siteId?.trim() || 'oversea-main';
  const overseaSubscriptionBaseUrl = overseaCallbackBaseUrl
    ? `${overseaCallbackBaseUrl}/internal/v1/site-slots/${overseaSiteId}/subscriptions/hysteria2`
    : `internal-pushed://${overseaSiteId}/subscriptions/hysteria2`;
  const overseaServerPorts = overseaRuntimeConfig?.serverPorts ?? HYSTERIA2_ACCESS_PORTS;
  const overseaExportPort = overseaRuntimeConfig?.exportPort ?? HYSTERIA2_EXPORT_FALLBACK_PORT;
  const overseaExportBaseUrl = overseaRuntimeConfig?.exportBaseUrl ?? `http://${target}:${overseaExportPort}`;
  const overseaDefaultAccountNames = defaultSiteSlotAccessAccountNames(overseaSiteId);
  const overseaInternalAccountName = `${safeAccountPrefix(overseaSiteId)}-internal`;
  const overseaDomesticAccountName = `${safeAccountPrefix(overseaSiteId)}-domestic`;
  const domesticBootstrapSubscriptionUrl = `${overseaSubscriptionBaseUrl}/${overseaDomesticAccountName}.yaml`;
  const domesticTunnelInstallWrapperCommand = `printf "%s\\n" "#!/usr/bin/env sh" "exec ${domesticTunnelCliCurrentDir}/bin/qp-tunnel-cli \\"\\$@\\"" > /usr/local/bin/qp-tunnel-cli && chmod 0755 /usr/local/bin/qp-tunnel-cli`;
  const qpTunnelCliVersionProbe = (command: string) => `${command} --version 2>/dev/null || ${command} version 2>/dev/null || ${command} -v 2>/dev/null || ${command} help 2>/dev/null | sed -n "1p" || echo unknown`;
  const domesticTunnelModeCommand = '{ QP_TUNNEL_MODE=${QP_TUNNEL_MODE:-egress-on}; case "$QP_TUNNEL_MODE" in server|server-on|egress|egress-on) if "$QP_TUNNEL_CLI" help 2>/dev/null | grep -q "egress-on"; then "$QP_TUNNEL_CLI" egress-on; elif "$QP_TUNNEL_CLI" help 2>/dev/null | grep -q "server-on"; then echo "warning: selected tunnel cli lacks egress-on; falling back to server-on"; "$QP_TUNNEL_CLI" server-on; else echo "blocked: selected tunnel cli does not support egress-on/server-on"; exit 1; fi ;; tun|tun-on) if "$QP_TUNNEL_CLI" help 2>/dev/null | grep -q "tun-on"; then "$QP_TUNNEL_CLI" tun-on; else echo "blocked: selected tunnel cli does not support tun-on"; exit 1; fi ;; *) echo "blocked: unsupported QP_TUNNEL_MODE=$QP_TUNNEL_MODE"; exit 1 ;; esac; }';
  const domesticTunnelPostEgressRefreshCommand = `if test -f /etc/profile.d/mihomo-client-proxy.sh; then . /etc/profile.d/mihomo-client-proxy.sh || true; fi; echo "Internal-pushed qp-tunnel-cli fallback version: $(${qpTunnelCliVersionProbe('"$INTERNAL_QP_TUNNEL_CLI"')})"; if command -v npm >/dev/null 2>&1; then if npm i -g @qpjoy/tunnel-cli@latest --force; then echo "npm-installed qp-tunnel-cli version: $(${qpTunnelCliVersionProbe('qp-tunnel-cli')})"; if qp-tunnel-cli help 2>/dev/null | grep -q "egress-on"; then qp-tunnel-cli install-script || true; qp-tunnel-cli egress-on || qp-tunnel-cli server-on || true; qp-tunnel-cli status || echo "warning: @qpjoy/tunnel-cli npm refresh status failed after egress-on; keep Internal fallback"; else echo "warning: npm-installed qp-tunnel-cli lacks egress-on; restoring Internal-pushed fallback"; ${domesticTunnelInstallWrapperCommand}; echo "restored Internal-pushed qp-tunnel-cli version: $(${qpTunnelCliVersionProbe('qp-tunnel-cli')})"; fi; else echo "warning: @qpjoy/tunnel-cli@latest npm refresh skipped after egress-on; keep Internal fallback"; ${domesticTunnelInstallWrapperCommand}; echo "restored Internal-pushed qp-tunnel-cli version: $(${qpTunnelCliVersionProbe('qp-tunnel-cli')})"; fi; else echo "node/npm absent; keep Internal fallback until next refresh"; fi`;
  const domesticLegacyWireGuardCompatCommand = [
    'legacy_wg_detected=0; for legacy_wg_iface in hdo-home hdo-internal; do if systemctl is-active --quiet wg-quick@$legacy_wg_iface 2>/dev/null || systemctl is-enabled --quiet wg-quick@$legacy_wg_iface 2>/dev/null || ip link show $legacy_wg_iface >/dev/null 2>&1 || test -f /etc/wireguard/$legacy_wg_iface.conf; then legacy_wg_detected=1; fi; done; if test "$legacy_wg_detected" = "1"; then',
    'echo "legacy hdo-home/hdo-internal 100.* WireGuard detected; preserving V1 while mx-domestic 2.0 starts";',
    'echo "run bash scripts/manage.sh ops site-slot cleanup-v1-wireguard --apply when V1 is no longer needed";',
    'fi;',
    'if wg show 2>/dev/null | grep -q "100\\."; then echo "legacy 100.* WireGuard peers remain by design during V1/V2 compatibility"; fi'
  ].join(' ');
  const domesticTunnelBootstrapCommand = [
    'set -eu',
    `INTERNAL_QP_TUNNEL_CLI=${domesticTunnelCliCurrentDir}/bin/qp-tunnel-cli`,
    'QP_TUNNEL_CLI="$INTERNAL_QP_TUNNEL_CLI"',
    `BOOTSTRAP_SUBSCRIPTION_FILE=${domesticBootstrapSubscriptionRemote}`,
    'test -x "$INTERNAL_QP_TUNNEL_CLI" || { echo "blocked: Internal-pushed qp-tunnel-cli fallback is missing: $INTERNAL_QP_TUNNEL_CLI"; exit 1; }',
    'chmod +x "$INTERNAL_QP_TUNNEL_CLI"',
    `if test -f ${domesticTunnelCliCurrentDir}/package/resources/mihomo-client.sh; then install -m 0755 ${domesticTunnelCliCurrentDir}/package/resources/mihomo-client.sh /usr/local/bin/mihomo-client; fi`,
    domesticTunnelInstallWrapperCommand,
    'if command -v systemctl >/dev/null 2>&1; then systemctl enable mihomo-client >/dev/null 2>&1 || true; fi',
    'if test -x "$INTERNAL_QP_TUNNEL_CLI"; then QP_TUNNEL_CLI="$INTERNAL_QP_TUNNEL_CLI"; QP_TUNNEL_CLI_KIND=internal-pushed-fallback; elif command -v qp-tunnel-cli >/dev/null 2>&1; then QP_TUNNEL_CLI="$(command -v qp-tunnel-cli)"; QP_TUNNEL_CLI_KIND=global-qp-tunnel-cli; elif command -v mihomo-client >/dev/null 2>&1; then QP_TUNNEL_CLI="$(command -v mihomo-client)"; QP_TUNNEL_CLI_KIND=global-mihomo-client; else QP_TUNNEL_CLI_KIND=missing; fi',
    'echo "qp-tunnel-cli selected: $QP_TUNNEL_CLI_KIND $QP_TUNNEL_CLI"',
    `if test -s "$BOOTSTRAP_SUBSCRIPTION_FILE"; then SUBSCRIPTION_ARGS="--file $BOOTSTRAP_SUBSCRIPTION_FILE"; else echo "warning: local bootstrap subscription missing; falling back to URL ${domesticBootstrapSubscriptionUrl}"; SUBSCRIPTION_ARGS="--url ${domesticBootstrapSubscriptionUrl}"; fi`,
    'if test -x /usr/local/bin/mihomo && { systemctl cat mihomo-client >/dev/null 2>&1 || test -f /etc/mihomo-client/config.yaml; }; then echo "mihomo-client already installed; reuse resident client and refresh subscription"; if "$QP_TUNNEL_CLI" help 2>/dev/null | grep -q "update-subscription"; then if "$QP_TUNNEL_CLI" update-subscription $SUBSCRIPTION_ARGS; then echo "mihomo-client subscription refreshed"; else echo "warning: mihomo-client subscription refresh failed; reusing existing resident subscription for bootstrap"; fi; else echo "warning: selected tunnel cli lacks update-subscription; reusing existing resident subscription for bootstrap"; fi; else "$QP_TUNNEL_CLI" install $SUBSCRIPTION_ARGS; fi',
    domesticTunnelModeCommand,
    '$QP_TUNNEL_CLI status || echo "warning: tunnel cli status failed after enabling egress; continuing with service evidence"',
    domesticTunnelPostEgressRefreshCommand
  ].join('; ');
  const overseaInputAccessAccounts = (input.accessAccounts ?? [])
    .filter((account) => (
      Boolean(account.username)
      && Boolean(account.authToken)
      && (account.status == null || account.status === 'active')
    ));
  const overseaAccessAccountMaterial = new Map(
    overseaInputAccessAccounts.map((account) => [safeAccountName(account.username), account])
  );
  const overseaRuntimeAccountNames = [...new Set([
    ...overseaDefaultAccountNames,
    ...overseaInputAccessAccounts.map((account) => safeAccountName(account.username))
  ])];
  const overseaAccountMaterialCount = overseaRuntimeAccountNames
    .filter((username) => overseaAccessAccountMaterial.has(safeAccountName(username))).length;
  const overseaReservedInternalCidrs = ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16'];
  const overseaReservedInternalCidrsCsv = overseaReservedInternalCidrs.join(',');
  const startSlotServicesCommand = [
    'if grep -q "\\"placeholder\\": true" enabled-modules.json 2>/dev/null; then',
    'echo "slot services placeholder; no Docker services selected";',
    'else',
    'services="$(docker compose config --services)";',
    'if [ -n "$services" ]; then',
    'images="$(docker compose config --images 2>/dev/null || true)";',
    'if [ -n "$images" ]; then',
    'for image in $images; do',
    'if docker image inspect "$image" >/dev/null 2>&1; then',
    'echo "image ready: $image";',
    'else',
    'echo "pull missing compose image: $image";',
    'if ! docker pull "$image"; then',
    'echo "blocked: Docker cannot pull required compose image $image";',
    'echo "diagnostics: qp-tunnel-cli";',
    `if command -v qp-tunnel-cli >/dev/null 2>&1; then echo "qp-tunnel-cli version: $(${qpTunnelCliVersionProbe('qp-tunnel-cli')})"; qp-tunnel-cli status || true; else echo "qp-tunnel-cli: missing"; fi;`,
    'echo "diagnostics: docker proxy env";',
    'if command -v systemctl >/dev/null 2>&1; then systemctl show docker -p Environment || true; fi;',
    'echo "diagnostics: registry via local proxy";',
    'if command -v curl >/dev/null 2>&1; then curl -I --max-time 15 --proxy http://127.0.0.1:7890 https://registry-1.docker.io/v2/ || true; fi;',
    'exit 1;',
    'fi;',
    'fi;',
    'done;',
    'fi;',
    'docker compose up -d;',
    'else',
    'echo "slot services bundle has no Docker services selected";',
    'fi;',
    'fi'
  ].join(' ');
  const syncInternalConfigCommands = kind === 'oversea'
    ? [
      `POST /internal/v1/config-center/snapshots/effective siteId=${input.siteId ?? 'oversea-main'}`,
      `Record overseaConfigDelivery=internal-pushed siteId=${input.siteId ?? 'oversea-main'} workerInternalHealth=${workerInternalBaseUrl}/healthz overseaCallbackMode=${overseaCallbackMode} remoteCurl=skipped`
    ]
    : [
      `POST /internal/v1/config-center/snapshots/effective siteId=${input.siteId ?? 'domestic-main'}`,
      ssh('curl -fsS --max-time 8 http://10.88.88.88:18090/healthz || echo "warning: Internal is not reachable at 10.88.88.88:18090 yet; start/verify the Internal service peer after Domestic relay activation"')
    ];
  const overseaEnvLines = [
    'TZ=Asia/Shanghai',
    `HY2_SERVER_HOST=${target}`,
    `HY2_SERVER_PORTS=${overseaServerPorts}`,
    'HY2_HOP_INTERVAL_SECONDS=0',
    'HY2_STACK_SUBNET=10.254.0.0/24',
    'HY2_STACK_GATEWAY=10.254.0.1',
    `HY2_USERS=${overseaRuntimeAccountNames.join(',')}`,
    `HY2_PEER_DNS=${HYSTERIA2_CLIENT_DNS.join(',')}`,
    `HY2_INTERNAL_MIHOMO_BASE_URL=${internalMihomoBaseUrl}`,
    `HY2_INTERNAL_CALLBACK_MODE=${overseaCallbackMode}`,
    `HY2_INTERNAL_CALLBACK_BASE_URL=${overseaCallbackBaseUrl ?? ''}`,
    'HY2_INTERNAL_SUBSCRIPTION_STORE=config-center',
    'HY2_MIHOMO_ROUTING_MODE=cn-direct',
    `HY2_RESERVED_INTERNAL_CIDRS=${overseaReservedInternalCidrsCsv}`,
    'HY2_DOMESTIC_GATEWAY_IP=10.88.0.1',
    `HY2_TLS_SERVER_NAME=${target}`,
    'HY2_TLS_SELF_SIGNED_DAYS=3650',
    'HY2_TLS_SKIP_CERT_VERIFY=true',
    `HY2_SERVER_BANDWIDTH_DOWN="${HYSTERIA2_CLIENT_DOWNLOAD}"`,
    `HY2_SERVER_BANDWIDTH_UP="${HYSTERIA2_CLIENT_UPLOAD}"`,
    `HY2_DEFAULT_DOWN="${HYSTERIA2_CLIENT_DOWNLOAD}"`,
    `HY2_DEFAULT_UP="${HYSTERIA2_CLIENT_UPLOAD}"`,
    'HY2_MASQUERADE_URL=https://news.ycombinator.com/',
    'HY2_OBFS_PASSWORD=',
    'HY2_EXPORT_SITE_ADDRESS=:8080',
    `HY2_EXPORT_BASE_URL=${overseaExportBaseUrl}`,
    `HY2_EXPORT_FALLBACK_PORT=${overseaExportPort}`,
    'HY2_EXPORT_USER=download',
    'HY2_EXPORT_PASSWORD_HASH='
  ];
  const overseaEnvWriteCommand = `cd ${overseaAccessStackCurrentDir} && cp -n .env.example .env && printf "%s\\n" ${overseaEnvLines.map(shellDoubleQuote).join(' ')} >> .env`;
  const overseaTunnelStateJson = JSON.stringify({
    revision: 'internal-shadow-1',
    node: {
      publicHost: target,
      serverPorts: overseaServerPorts
    },
    internal: {
      callbackMode: overseaCallbackMode,
      callbackBaseUrl: overseaCallbackBaseUrl,
      workerBaseUrl: workerInternalBaseUrl
    },
    policies: [
      {
        id: 'cn-direct',
        routingMode: 'cn-direct',
        isDefault: true,
        reservedInternalCidrs: overseaReservedInternalCidrs,
        domesticGatewayIp: '10.88.0.1',
        dnsPath: 'wg-relay-internal-dns'
      }
    ],
    accounts: overseaRuntimeAccountNames.map((username) => ({
        id: username,
        username,
        authToken: overseaAccessAccountMaterial.get(safeAccountName(username))?.authToken ?? `<hy2-token:${username}:from-internal-config-center>`,
        status: 'active',
        policyId: 'cn-direct',
        upRate: overseaAccessAccountMaterial.get(safeAccountName(username))?.upRate || HYSTERIA2_CLIENT_UPLOAD,
        downRate: overseaAccessAccountMaterial.get(safeAccountName(username))?.downRate || HYSTERIA2_CLIENT_DOWNLOAD
      }))
  });
  const overseaTunnelStateBase64 = Buffer.from(overseaTunnelStateJson, 'utf8').toString('base64');
  const overseaRegistrationCommand = overseaCallbackBaseUrl
    ? ssh(`chmod +x ${overseaAccessStackCurrentDir}/bin/qp-tunnel-cli && ${overseaAccessStackCurrentDir}/bin/qp-tunnel-cli register --internal ${overseaCallbackBaseUrl} --role oversea --site ${input.siteId ?? 'oversea-main'} --service hysteria2`)
    : ssh(`install -d -m 0755 /opt/mx/site-agent && printf "%s\\n" "MX_INTERNAL_CALLBACK_MODE=push-only" "MX_SITE_ID=${input.siteId ?? 'oversea-main'}" "MX_SITE_ROLE=oversea" > /opt/mx/site-agent/registration.env && echo "oversea callback push-only; registration skipped"`);
  const overseaSlotServiceEnvLines = [
    `MX_SITE_ID=${input.siteId ?? 'oversea-main'}`,
    'MX_SITE_ROLE=oversea',
    'MX_ENABLED_MODULES=access-node,site-agent,runner-worker,observability-forwarder',
    `MX_INTERNAL_BASE_URL=${overseaCallbackBaseUrl ?? ''}`,
    `MX_INTERNAL_CALLBACK_MODE=${overseaCallbackMode}`,
    `MX_WORKER_INTERNAL_BASE_URL=${workerInternalBaseUrl}`,
    `LOCAL_STACK_PATH=${overseaAccessStackCurrentDir}`,
    'MX_ACCESS_RUNTIME=hysteria2-only'
  ];
  const overseaSlotServiceEnvWriteCommand = `printf "%s\\n" ${overseaSlotServiceEnvLines.map(shellDoubleQuote).join(' ')} > ${slotCurrentDir}/.env`;
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
          ? 'If @qpjoy/tunnel-cli was republished, refresh fallback in Internal before materializing: bash scripts/manage.sh ops site-slot refresh-tunnel-cli latest or bash scripts/manage.sh ops site-slot refresh-tunnel-cli --from-tarball <@qpjoy-tunnel-cli.tgz>'
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
        ssh(`id -u && uname -a && df -h / && ${dockerReadonlyProbe}`),
        kind === 'domestic'
          ? ssh('command -v wg && command -v wg-quick && sysctl net.ipv4.ip_forward')
          : ssh('test -d /opt/mx/current/hysteria2-access-stack || test -d /opt/mx/releases/oversea-access-stack || echo "oversea access stack: missing before install"')
      ],
      notes: ['Do not mutate the host in preflight; collect evidence first.']
    }
  ];
  if (kind === 'domestic') {
    phases.push({
      phaseId: 'prepare-domestic-relay-authority',
      title: 'Prepare Domestic public relay and Internal service peer',
      mode: 'admin-action',
      target: 'internal',
      required: true,
      commands: [
        'Allocate Domestic WG gateway=10.88.0.1 and fixed Internal service peer=10.88.88.88 in Internal Config Center.',
        `Render Domestic WG relay config ${domesticWireGuardConfig} with peer classes: internal-service=10.88.88.88/32, standalone=10.89.0.0/16, embed-products=10.90.0.0/16.`,
        `Render Internal service peer config ${internalServicePeerConfig}; never copy the Internal private key to Domestic.`,
        `Record Domestic public endpoint host=${target} and keep public API facade limited to enroll/bootstrap/cache.`,
        'Internal has no public ingress: Internal must initiate outbound WG to the Domestic public relay before Home can reach Internal services.',
        'After Home enrolls through Domestic facade, Launcher Network promotes Internal access to Domestic WG relay primary; public facade remains bootstrap/fallback only.'
      ],
      notes: [
        'There is no full HDI path without a relay when Internal has no public IP; before WG relay is ready, only enroll/bootstrap proxy is allowed.',
        'Domestic does not own users, subscriptions, DNS authority, or release truth. It only relays and caches Internal-signed snapshots.'
      ]
    });
    phases.push({
      phaseId: 'domestic-public-ingress-firewall',
      title: 'Confirm Domestic public ingress firewall',
      mode: 'manual',
      target: 'domestic',
      required: true,
      commands: [
        `Cloud/security group: allow UDP 51280 to ${target} for WireGuard relay traffic from Internal and H endpoints.`,
        `Cloud/security group: allow TCP 443 to ${target} for bootstrap/enroll/snapshot/H2I facade; TCP 80 is optional for ACME or HTTP redirect only.`,
        `Restrict TCP ${sshPort} SSH to Internal/admin source IPs; do not expose 3000, 5432, 18090, Docker daemon, or Internal-only service ports.`,
        `Record Domestic WG publicEndpoint=${target}:51280 in Internal Config Center before publishing launcher snapshots.`
      ],
      notes: [
        'This is operator/security-group evidence because the Domestic host cannot prove public cloud ingress rules from itself.',
        'WireGuard uses UDP 51280; TCP 443 is for the public facade, not for WG. Keep the facade limited to bootstrap/enroll/cache/H2I paths.'
      ]
    });
  }
  if (kind === 'domestic' && mode === 'oversea-assisted') {
    phases.push({
      phaseId: 'resolve-domestic-bootstrap-subscription',
      title: 'Resolve Domestic Oversea bootstrap subscription',
      mode: 'admin-action',
      target: 'internal',
      required: true,
      commands: [
        `Materialize domesticBootstrapSubscription=${domesticBootstrapSubscriptionUrl} into ${domesticBootstrapSubscriptionArtifact} from Internal Config Center for Oversea siteId=${overseaSiteId} host=${input.overseaHost ?? '<oversea-host>'}`,
        `Verify ${artifactRoot}/mx-domestic-qp-tunnel-cli-fallback.tar.gz exists in Internal before touching Domestic.`,
        `Verify ${domesticBootstrapSubscriptionArtifact} exists in Internal; Domestic cannot fetch Internal URLs until mx-domestic reaches 10.88.88.88.`,
        'If subscription/account material is missing, stop here; do not ask Domestic to install node/npm, run npm install, or pull public packages until Internal has issued the Oversea bootstrap account and fallback artifact.'
      ],
      notes: ['Internal owns the bootstrap subscription, mihomo config, and fallback artifact before Domestic can recover outbound access; .npmrc only helps Internal refresh or post-egress npm refresh, not the first no-egress bootstrap.']
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
        rsyncOverSsh(domesticBootstrapSubscriptionArtifact, `${domesticBootstrapSubscriptionRemote}`),
        ssh(domesticTunnelBootstrapCommand)
      ],
      notes: ['Prefer the Internal-pushed latest qp-tunnel-cli/mihomo-client wrapper on Domestic, upgrading any old manually installed script before enabling egress. Install or refresh the Internal-pushed local subscription file first; do not require Domestic to reach Internal before WG relay exists. Use the Internal-pushed fallback for first bootstrap because Domestic may not have node/npm or registry egress yet. After egress-on is available, a best-effort npm refresh can upgrade the global CLI. egress-on is the public Domestic default; tun-on is persistent but should remain break-glass because it can break public service return paths.']
    });
  }
  if (kind === 'domestic') {
    phases.push({
      phaseId: 'install-domestic-docker-runtime',
      title: 'Install Domestic Docker runtime',
      mode: 'artifact-push',
      target: 'domestic',
      required: true,
      commands: [
        ssh(overseaDockerInstallScript())
      ],
      notes: ['Run after the Oversea subscription proxy is available so Docker packages and images can resolve through egress-on when direct egress is unavailable.']
    });
  }
  phases.push(
    ...(kind === 'oversea' ? [{
      phaseId: 'prepare-access-stack',
      title: 'Prepare Oversea Docker hysteria2 access stack',
      mode: 'artifact-push' as const,
      target: kind,
      required: true,
      commands: [
        ssh(`install -d -m 0755 /opt/mx ${incomingDir} ${currentRoot} /opt/mx/site-agent ${overseaAccessStackReleaseDir}`),
        rsyncOverSsh(overseaAccessStackBundle, `${incomingDir}/`),
        ssh(`tar -xzf ${incomingDir}/${overseaAccessStackBundleName} -C ${overseaAccessStackReleaseDir} && ln -sfn ${overseaAccessStackReleaseDir} ${overseaAccessStackCurrentDir}`),
        ssh(`cd ${overseaAccessStackCurrentDir} && chmod +x manage.sh && test -f docker-compose.yml && test -f .env.example`)
      ],
      notes: ['Internal pushes the access stack over rsync/OpenSSH and falls back to scp; the Oversea host does not clone or pull source code.']
    }] : []),
    ...(kind === 'oversea' ? [
      {
        phaseId: 'configure-oversea-access',
        title: 'Configure Oversea hysteria2 access',
        mode: 'remote-ssh' as const,
        target: kind,
        required: true,
        commands: [
          `POST /internal/v1/site-slots/${overseaSiteId}/access-accounts issueDefaults=true service=hysteria2 serverPorts=${overseaServerPorts} store=config-center accounts=${overseaDefaultAccountNames.join(',')}`,
          `POST /internal/v1/launcher-network/mihomo/sites/${overseaSiteId} serverPorts=${overseaServerPorts} mode=internal-managed source=${overseaSubscriptionBaseUrl} reachability=internal-url-requires-domestic-wg-relay`,
          `Record overseaAccessAccountMaterial=internal-issued accounts=${overseaAccountMaterialCount}/${overseaRuntimeAccountNames.length} source=config-center`,
          ssh(overseaDockerInstallScript()),
          ssh(overseaEnvWriteCommand),
          ssh(`printf "%s" ${overseaTunnelStateBase64} | base64 -d > /opt/mx/site-agent/tunnel-state.json`),
          ssh(`cd ${overseaAccessStackCurrentDir} && ./manage.sh reconcile-from-json --state-file /opt/mx/site-agent/tunnel-state.json --mode hysteria2-only`),
          overseaRegistrationCommand,
          ssh(`cd ${overseaAccessStackCurrentDir} && ./manage.sh sync-internal-defaults && ./manage.sh docker-status && curl -fsS http://127.0.0.1:${overseaExportPort}/healthz`)
        ],
        notes: [
          'Oversea runs hysteria2 only; Internal runs mihomo and stores subscription/account material.',
          `Port ${overseaExportPort} on Oversea is a protected health/evidence outlet for clients.csv and healthz, not a subscription authority.`,
          'H endpoints use WG relay only for Internal DNS and reserved/product routes; Domestic defaults to 10.88.0.1, cn-direct stays direct, and external traffic uses the Oversea hysteria2 subscription.'
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
          `Record hEndpointBootstrapPath=WG relay for DNS and reserved/product CIDRs -> Internal mihomo subscription -> cn-direct policy -> Oversea hysteria2 for external traffic`,
          `Record internalBootstrapSubscription=${overseaSubscriptionBaseUrl}/${overseaInternalAccountName}.yaml`,
          `Record domesticBootstrapSubscription=${overseaSubscriptionBaseUrl}/${overseaDomesticAccountName}.yaml`,
          'Attach Internal subscription URL, account IDs, Domestic WG/H2I reachability note, and tunnel-cli registration evidence to the worker report before Domestic oversea-assisted bootstrap.'
        ],
        notes: [
          'Internal remains the source of truth for which Domestic slots can consume this Oversea access site.',
          'Subscription auth is issued and rotated by Internal; Oversea receives only the hysteria2 runtime account material needed to serve traffic.'
        ]
      }
    ] : []),
    ...(kind === 'domestic' ? [{
      phaseId: 'activate-domestic-peer-center',
      title: 'Activate Domestic WireGuard peer center',
      mode: 'artifact-push' as const,
      target: kind,
      required: true,
      commands: [
        ssh(`install -d -m 0700 /etc/wireguard && install -d -m 0755 ${slotCurrentDir}`),
        rsyncOverSsh(domesticWireGuardConfig, '/etc/wireguard/mx-domestic.conf'),
        rsyncOverSsh(domesticRelayEnv, `${slotCurrentDir}/mx-domestic-relay.env`),
        ssh(domesticLegacyWireGuardCompatCommand),
        ssh('if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi; chmod 600 /etc/wireguard/mx-domestic.conf; if command -v systemctl >/dev/null 2>&1; then systemctl enable wg-quick@mx-domestic >/dev/null 2>&1 || true; systemctl restart wg-quick@mx-domestic; else wg-quick down mx-domestic >/dev/null 2>&1 || true; wg-quick up mx-domestic; fi; ip -4 addr replace 10.88.0.1/16 dev mx-domestic; ip link set up dev mx-domestic; sysctl -w net.ipv4.ip_forward=1; if command -v iptables >/dev/null 2>&1; then iptables -C FORWARD -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -i mx-domestic -o mx-domestic -j ACCEPT; if iptables -S DOCKER-USER >/dev/null 2>&1; then iptables -C DOCKER-USER -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -i mx-domestic -o mx-domestic -j ACCEPT; fi; iptables -C INPUT -i mx-domestic -p udp --dport 53 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i mx-domestic -p udp --dport 53 -j ACCEPT; iptables -C INPUT -i mx-domestic -p tcp --dport 53 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i mx-domestic -p tcp --dport 53 -j ACCEPT; fi; for route_cidr in 10.89.0.0/16 10.90.0.0/16; do ip route replace "$route_cidr" dev mx-domestic; done; ip -4 address show dev mx-domestic; ip route get 10.89.100.1 || true')
      ],
      notes: ['WireGuard/routing is host-level and is activated before Docker edge services so Domestic can establish the 10.88.0.1 relay path even when registry egress is unhealthy. The 2.0 activation preserves legacy hdo-home/hdo-internal 100.* WireGuard state for V1/V2 compatibility; cleanup is an explicit manage.sh operation.']
    }] : []),
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
          ? ssh(`tar -xzf ${incomingDir}/${slotServiceBundleName} -C ${slotReleaseDir} && ln -sfn ${slotReleaseDir} ${slotCurrentDir} && ${overseaSlotServiceEnvWriteCommand} && cd ${slotCurrentDir} && ${startSlotServicesCommand}`)
          : ssh(`tar -xzf ${incomingDir}/${slotServiceBundleName} -C ${slotReleaseDir} && ln -sfn ${slotReleaseDir} ${slotCurrentDir} && ${domesticEnvWriteCommand} && cd ${slotCurrentDir} && ${startSlotServicesCommand}`)
      ],
      notes: [
        'Internal pushes Release Center bundles; slot hosts run the unpacked bundle and do not pull code from git.',
        ...(kind === 'domestic' ? ['Domestic .env is rendered from Internal Config Center runtime config on every deploy; operators should not edit it manually on the host.'] : [])
      ]
    },
    {
      phaseId: 'sync-internal-config',
      title: 'Sync signed Internal config',
      mode: 'runner-job',
      target: kind,
      required: true,
      commands: syncInternalConfigCommands,
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
  if (kind === 'domestic') actions.push('confirm-domestic-public-ingress-firewall');
  if (kind === 'domestic' && mode !== 'direct') actions.push('configure-oversea-bootstrap');
  if (kind === 'domestic') actions.push('activate-domestic-peer-center');
  if (kind === 'domestic') actions.push('install-docker-runtime');
  if (kind === 'oversea') actions.push('push-oversea-access-stack');
  actions.push('push-slot-service-bundle', 'sync-signed-internal-config', 'run-slot-smoke');
  if (kind === 'domestic' && !siteSlotWorkerInternalBaseUrl(input)) actions.push('set-internal-base-url-for-reachability-check');
  return actions;
}

function runtimeFeaturePolicyId(
  featureKey: string,
  scopeKind: RuntimeFeaturePolicyScopeKind,
  scopeId: string | null
): string {
  return `rtfp_${featureKey.replace(/[^a-zA-Z0-9._-]/g, '_')}_${scopeKind}_${(scopeId ?? 'global').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function defaultAwxProviderName(kind: AwxProviderKind): string {
  if (kind === 'domestic') return 'Domestic AWX Shadow';
  if (kind === 'oversea') return 'Oversea AWX Shadow';
  return 'Internal AWX Shadow';
}

function awxProviderKind(value: AwxProviderConfigInput['defaultKind']): AwxProviderKind {
  if (value === 'domestic' || value === 'oversea' || value === 'all') return value;
  return 'all';
}

function awxProviderStatus(value: AwxProviderConfigInput['status']): AwxProviderStatus {
  return value === 'paused' ? 'paused' : 'active';
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'default';
}

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function runtimeFeatureScopeKind(value: RuntimeFeaturePolicyInput['scopeKind']): RuntimeFeaturePolicyScopeKind {
  if (value === 'site' || value === 'profile') return value;
  return 'global';
}

function runtimeFeatureMode(value: RuntimeFeaturePolicyInput['mode']): RuntimeFeaturePolicyMode {
  if (value === 'readonly-execute' || value === 'remote-execute' || value === 'plan-only' || value === 'disabled') return value;
  return 'plan-only';
}

function overseaDockerInstallScript(): string {
  return [
    'set -eu',
    'printf "mx-docker-bootstrap\\n"',
    '. /etc/os-release 2>/dev/null || true',
    'echo "os=${ID:-unknown} version=${VERSION_ID:-unknown}"',
    'if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then echo "docker: present"; else if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y ca-certificates curl gnupg lsb-release; curl -fsSL https://get.docker.com | sh; elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates curl; curl -fsSL https://get.docker.com | sh; elif command -v yum >/dev/null 2>&1; then yum install -y ca-certificates curl; curl -fsSL https://get.docker.com | sh; elif command -v apk >/dev/null 2>&1; then apk add --no-cache docker docker-cli-compose; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install docker docker-compose || curl -fsSL https://get.docker.com | sh; else curl -fsSL https://get.docker.com | sh; fi; fi',
    'if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker || true; elif command -v service >/dev/null 2>&1; then service docker start || true; elif command -v rc-update >/dev/null 2>&1; then rc-update add docker default || true; service docker start || true; fi',
    'docker version',
    'docker compose version || docker-compose version'
  ].join('; ');
}

function domesticRuntimeEnvLines(config: SiteSlotDomesticRuntimeConfig): string[] {
  return Object.entries(config.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

export function defaultSiteSlotAccessAccountNames(siteId: string): string[] {
  const prefix = safeAccountPrefix(siteId);
  return [
    `${prefix}-internal`,
    `${prefix}-domestic`,
    ...Array.from({ length: 9 }, (_, index) => `${prefix}-internal${String(index + 1).padStart(2, '0')}`)
  ];
}

export function buildLauncherNetworkMihomoSite(
  config: RuntimeConfig,
  input: LauncherNetworkMihomoSiteInput,
  previous: LauncherNetworkMihomoSite | null,
  fallbackPublicHost: string | null,
  now = new Date().toISOString()
): LauncherNetworkMihomoSite {
  const siteId = input.siteId?.trim() || previous?.siteId || 'oversea-main';
  const publicHost = input.publicHost?.trim() || previous?.publicHost || fallbackPublicHost;
  const serverPorts = normalizeHysteria2ServerPorts(input.serverPorts ?? previous?.serverPorts).normalized;
  const tlsFingerprint = normalizeTlsFingerprint(input.tlsFingerprint) ?? normalizeTlsFingerprint(previous?.tlsFingerprint);
  const subscriptionBaseUrl = input.subscriptionBaseUrl?.trim()
    || previous?.subscriptionBaseUrl
    || `${config.internalBaseUrl.replace(/\/+$/, '')}/internal/v1/site-slots/${siteId}/subscriptions/hysteria2`;
  return {
    siteId,
    environment: config.environment,
    mode: 'internal-managed',
    source: 'site-slot-access-accounts',
    service: 'hysteria2',
    publicHost,
    serverPorts,
    tlsFingerprint,
    subscriptionBaseUrl,
    routingPolicy: 'cn-direct',
    reservedInternalCidrs: ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16'],
    domesticGatewayIp: '10.88.0.1',
    dnsPath: 'wg-relay-internal-dns',
    reachability: {
      internalUrlOnly: true,
      domesticWgRelayRequired: true,
      h2iRequired: true,
      notes: [
        'This Internal URL is authoritative but not directly reachable by H endpoints until Domestic WG relay and H2I/DNS are configured.',
        'H endpoints should reach Internal DNS and this mihomo subscription through Domestic WG relay; external traffic then uses the Oversea hysteria2 proxy.'
      ]
    },
    createdBy: previous?.createdBy ?? input.requestedBy ?? 'internal',
    createdAt: previous?.createdAt ?? now,
    updatedBy: input.requestedBy ?? previous?.updatedBy ?? 'internal',
    updatedAt: now
  };
}

export function normalizeLauncherNetworkMihomoSite(site: LauncherNetworkMihomoSite): LauncherNetworkMihomoSite {
  const tlsFingerprint = normalizeTlsFingerprint(site.tlsFingerprint);
  const serverPorts = normalizeHysteria2ServerPorts(site.serverPorts).normalized;
  if (site.serverPorts === serverPorts && site.tlsFingerprint === tlsFingerprint) return site;
  return { ...site, serverPorts, tlsFingerprint };
}

export function buildLauncherNetworkReachabilityPlan(
  site: LauncherNetworkMihomoSite,
  accounts: SiteSlotAccessAccount[],
  now = new Date().toISOString()
): LauncherNetworkReachabilityPlan {
  const internalAccounts = accounts.filter((account) => account.role === 'internal');
  const domesticAccounts = accounts.filter((account) => account.role === 'domestic');
  const reservedAccounts = accounts.filter((account) => account.role === 'internal-reserved');
  const hEndpointAccounts = accounts.filter((account) => account.role === 'h-endpoint');
  const hasBootstrapAccounts = internalAccounts.length > 0 && domesticAccounts.length > 0;
  const internalStageStatus = hasBootstrapAccounts ? 'ready' : 'blocked';
  return {
    siteId: site.siteId,
    environment: site.environment,
    verdict: hasBootstrapAccounts ? 'h-endpoint-blocked' : 'blocked',
    currentBoundary: 'internal-only',
    subscriptionBaseUrl: site.subscriptionBaseUrl,
    accountSummary: {
      total: accounts.length,
      internal: internalAccounts.length,
      domestic: domesticAccounts.length,
      internalReserved: reservedAccounts.length,
      hEndpoint: hEndpointAccounts.length
    },
    executionOrder: [
      'Internal issues hysteria2 accounts and publishes mihomo subscription YAML.',
      'Internal installs Docker and hysteria2-only access stack on Oversea by remote SSH.',
      'Internal records Oversea runtime evidence and tunnel-cli registration evidence.',
      'Internal uses the Domestic bootstrap account/subscription to bring up Domestic outbound bootstrap.',
      'Domestic brings up WG relay, H2I proxy, and Internal DNS reachability for H endpoints.',
      'H endpoint fetches the Internal mihomo subscription through Domestic WG/H2I, then connects directly to Oversea hysteria2 for external traffic.'
    ],
    gates: {
      domesticWgRelayRequired: true,
      h2iRequired: true,
      internalDnsRequired: true,
      mihomoAuthority: 'internal-config-center',
      overseaRuntime: 'hysteria2-only',
      domesticGatewayIp: site.domesticGatewayIp,
      reservedInternalCidrs: site.reservedInternalCidrs
    },
    stages: [
      {
        stageId: 'internal-subscription-authority',
        order: 1,
        owner: 'internal',
        title: 'Internal subscription/account authority',
        status: internalStageStatus,
        dependsOn: [],
        requiredEvidence: [
          'Config Center access account records exist for internal and domestic bootstrap users.',
          'GET subscription YAML returns cn-direct, reserved/product DIRECT rules, and hysteria2 proxy metadata.'
        ],
        notes: [
          'This is an Internal output only; it does not prove H endpoints can reach Internal yet.',
          'mihomo authority lives on Internal Config Center. Oversea does not host the subscription store.'
        ]
      },
      {
        stageId: 'oversea-hysteria2-runtime',
        order: 2,
        owner: 'oversea',
        title: 'Oversea Docker hysteria2 runtime',
        status: 'pending-evidence',
        dependsOn: ['internal-subscription-authority'],
        requiredEvidence: [
          'Remote SSH worker report shows docker version and docker compose are available.',
          'Oversea access stack status and hysteria2 healthz pass.',
          'Oversea registration evidence is attached: remote callback register when configured, otherwise Internal push-only registration metadata.'
        ],
        notes: [
          'Oversea should run hysteria2/site-agent only. It should not run Internal mihomo authority.',
          'This stage can make Oversea reachable by clients that already have a subscription, but it still does not expose the Internal subscription URL to H endpoints.'
        ]
      },
      {
        stageId: 'domestic-wg-relay',
        order: 3,
        owner: 'domestic',
        title: 'Domestic WG relay and 10.88.0.1 gateway',
        status: 'blocked',
        dependsOn: ['oversea-hysteria2-runtime'],
        requiredEvidence: [
          'Domestic WireGuard service is up and owns 10.88.0.1.',
          'WG handshake and route evidence exist for reserved/product CIDRs.',
          'Domestic outbound bootstrap consumed the Internal-issued Oversea domestic subscription.'
        ],
        notes: [
          'Until this stage is ready, H endpoints cannot reliably reach Internal DNS or Internal subscription URLs from outside.',
          'External Internet routing remains cn-direct plus Oversea subscription; WG is reserved for Internal DNS and internal CIDRs.'
        ]
      },
      {
        stageId: 'h2i-internal-dns',
        order: 4,
        owner: 'domestic',
        title: 'H2I proxy and Internal DNS path',
        status: 'blocked',
        dependsOn: ['domestic-wg-relay'],
        requiredEvidence: [
          'H2I proxy health passes from Domestic.',
          'Internal CoreDNS authority is reachable through Domestic relay.',
          'DNS evaluation for internal.mx/h2i.mx resolves through Internal CoreDNS.'
        ],
        notes: [
          'This is the gate that turns Internal-only subscription output into a fetchable H endpoint control-plane path.'
        ]
      },
      {
        stageId: 'h-endpoint-subscription-fetch',
        order: 5,
        owner: 'h-endpoint',
        title: 'H endpoint subscription fetch through Domestic',
        status: 'blocked',
        dependsOn: ['h2i-internal-dns'],
        requiredEvidence: [
          'Launcher Network can fetch the Internal mihomo subscription over the Domestic WG/H2I path.',
          'The fetched YAML includes cn-direct, reserved internal CIDRs, and Oversea hysteria2 proxy.'
        ],
        notes: [
          'This is the first point where H endpoint behavior is end-to-end rather than Internal-only.'
        ]
      },
      {
        stageId: 'h-endpoint-direct-oversea',
        order: 6,
        owner: 'h-endpoint',
        title: 'H endpoint direct Oversea hysteria2 traffic',
        status: 'blocked',
        dependsOn: ['h-endpoint-subscription-fetch'],
        requiredEvidence: [
          'H endpoint connects directly to Oversea hysteria2 for non-CN external traffic.',
          'CN traffic remains DIRECT and reserved/product routes remain internal.'
        ],
        notes: [
          'This validates the final runtime split: Domestic for Internal reachability, Oversea for external proxy path.'
        ]
      }
    ],
    nextActions: [
      'Attach remote Oversea worker evidence for Docker, hysteria2 health, and tunnel-cli registration.',
      'Create or reuse the Domestic slot plan with the Internal-issued domestic bootstrap subscription.',
      'Bring up Domestic WG relay/H2I/Internal DNS before treating H endpoint subscription fetch as passed.'
    ],
    generatedAt: now
  };
}

export function buildSiteSlotAccessAccount(
  config: RuntimeConfig,
  input: {
    siteId: string;
    username: string;
    authToken: string;
    requestedBy?: string | null;
  },
  previous: SiteSlotAccessAccount | null,
  now = new Date().toISOString()
): SiteSlotAccessAccount {
  const username = safeAccountName(input.username);
  const siteId = input.siteId.trim() || 'oversea-main';
  const authToken = previous?.authToken || input.authToken;
  const materialChanged = !previous || previous.authToken !== authToken || previous.status !== 'active';
  return {
    accountId: `slotacct_${siteId}_${username}`.replace(/[^a-zA-Z0-9._-]/g, '_'),
    siteId,
    environment: config.environment,
    service: 'hysteria2',
    username,
    role: inferAccessAccountRole(siteId, username),
    authToken,
    status: 'active',
    routingPolicy: 'cn-direct',
    subscriptionPath: `/internal/v1/site-slots/${siteId}/subscriptions/hysteria2/${username}.yaml`,
    createdBy: previous?.createdBy ?? input.requestedBy ?? 'internal',
    createdAt: previous?.createdAt ?? now,
    updatedBy: materialChanged ? input.requestedBy ?? previous?.updatedBy ?? 'internal' : previous?.updatedBy ?? 'internal',
    updatedAt: materialChanged ? now : previous?.updatedAt ?? now
  };
}

export function renderHysteria2MihomoSubscription(
  site: LauncherNetworkMihomoSite,
  account: SiteSlotAccessAccount,
  now = new Date().toISOString()
): MihomoSubscriptionRender {
  const proxyName = `${site.siteId}-hysteria2`;
  const firstPort = firstHysteriaPort(site.serverPorts);
  const server = site.publicHost || `${site.siteId}.oversea.invalid`;
  const proxyFingerprintLines = site.tlsFingerprint
    ? [`    fingerprint: ${yamlQuote(site.tlsFingerprint)}`]
    : [];
  const lines = [
    `# Generated by MX Launcher Internal at ${now}`,
    `# site=${site.siteId} account=${account.username}`,
    '# Reachability: this Internal subscription URL requires Domestic WG relay/H2I before H endpoints can fetch it.',
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'geodata-mode: true',
    'geo-auto-update: true',
    'geo-update-interval: 24',
    '',
    'dns:',
    '  enable: true',
    '  listen: 127.0.0.1:1053',
    '  enhanced-mode: fake-ip',
    '  nameserver:',
    ...HYSTERIA2_CLIENT_DNS.map((server) => `    - ${server}`),
    'proxies:',
    `  - name: ${yamlQuote(proxyName)}`,
    '    type: hysteria2',
    `    server: ${yamlQuote(server)}`,
    `    port: ${firstPort}`,
    `    password: ${yamlQuote(account.authToken)}`,
    `    down: ${yamlQuote(HYSTERIA2_CLIENT_DOWNLOAD)}`,
    `    up: ${yamlQuote(HYSTERIA2_CLIENT_UPLOAD)}`,
    `    sni: ${yamlQuote(site.publicHost || server)}`,
    '    skip-cert-verify: true',
    ...proxyFingerprintLines,
    '    alpn:',
    `      - ${HYSTERIA2_CLIENT_ALPN}`,
    'proxy-groups:',
    '  - name: Oversea',
    '    type: select',
    '    proxies:',
    `      - ${yamlQuote(proxyName)}`,
    '      - DIRECT',
    'rules:',
    ...HYSTERIA2_LOCAL_DIRECT_RULES.map((rule) => `  - ${rule}`),
    ...site.reservedInternalCidrs.map((cidr) => `  - IP-CIDR,${cidr},DIRECT,no-resolve`),
    '  - GEOSITE,CN,DIRECT',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,Oversea',
    ''
  ];
  return {
    siteId: site.siteId,
    username: account.username,
    accountId: account.accountId,
    contentType: 'text/yaml',
    yaml: lines.join('\n'),
    reachability: site.reachability,
    generatedAt: now
  };
}

export function userOverseaAccountName(user: UserCenterUser, siteId: string): string {
  const subject = user.email || user.userId;
  return safeAccountName(`${siteId}-${subject}`).slice(0, 80);
}

export function userOverseaEntitlementId(userId: string): string {
  return `useroversea_${safeAccountName(userId)}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function renderUserOverseaMihomoSubscription(
  user: UserCenterUser,
  entitlement: UserOverseaEntitlement,
  entries: Array<{ site: LauncherNetworkMihomoSite; account: SiteSlotAccessAccount }>,
  now = new Date().toISOString()
): UserOverseaSubscriptionRender {
  const activeEntries = entries.filter(({ account }) => account.status === 'active');
  const proxyNames = activeEntries.map(({ site }) => `${site.siteId}-hysteria2`);
  const reservedInternalCidrs = [...new Set(activeEntries.flatMap(({ site }) => site.reservedInternalCidrs))];
  const proxyLines = activeEntries.flatMap(({ site, account }) => {
    const proxyName = `${site.siteId}-hysteria2`;
    const server = site.publicHost || `${site.siteId}.oversea.invalid`;
    const proxyFingerprintLines = site.tlsFingerprint
      ? [`    fingerprint: ${yamlQuote(site.tlsFingerprint)}`]
      : [];
    return [
      `  - name: ${yamlQuote(proxyName)}`,
      '    type: hysteria2',
      `    server: ${yamlQuote(server)}`,
      `    port: ${firstHysteriaPort(site.serverPorts)}`,
      `    password: ${yamlQuote(account.authToken)}`,
      `    down: ${yamlQuote(HYSTERIA2_CLIENT_DOWNLOAD)}`,
      `    up: ${yamlQuote(HYSTERIA2_CLIENT_UPLOAD)}`,
      `    sni: ${yamlQuote(site.publicHost || server)}`,
      '    skip-cert-verify: true',
      ...proxyFingerprintLines,
      '    alpn:',
      `      - ${HYSTERIA2_CLIENT_ALPN}`
    ];
  });
  const lines = [
    `# Generated by MX Launcher Internal at ${now}`,
    `# user=${user.userId} email=${user.email}`,
    `# entitlement=${entitlement.entitlementId} sites=${entitlement.siteIds.join(',')}`,
    '# Reachability: this Internal subscription URL requires Domestic WG relay/H2I before H endpoints can fetch it.',
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'geodata-mode: true',
    'geo-auto-update: true',
    'geo-update-interval: 24',
    '',
    'dns:',
    '  enable: true',
    '  listen: 127.0.0.1:1053',
    '  enhanced-mode: fake-ip',
    '  nameserver:',
    ...HYSTERIA2_CLIENT_DNS.map((server) => `    - ${server}`),
    'proxies:',
    ...proxyLines,
    'proxy-groups:',
    '  - name: Oversea',
    '    type: select',
    '    proxies:',
    ...proxyNames.map((proxyName) => `      - ${yamlQuote(proxyName)}`),
    '      - DIRECT',
    'rules:',
    ...HYSTERIA2_LOCAL_DIRECT_RULES.map((rule) => `  - ${rule}`),
    ...reservedInternalCidrs.map((cidr) => `  - IP-CIDR,${cidr},DIRECT,no-resolve`),
    '  - GEOSITE,CN,DIRECT',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,Oversea',
    ''
  ];
  return {
    userId: user.userId,
    entitlementId: entitlement.entitlementId,
    contentType: 'text/yaml',
    yaml: lines.join('\n'),
    accounts: entitlement.accounts,
    generatedAt: now
  };
}

function safeAccountPrefix(siteId: string): string {
  return safeAccountName(siteId || 'oversea-main');
}

function safeAccountName(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'account';
}

function inferAccessAccountRole(siteId: string, username: string): SiteSlotAccessAccountRole {
  const prefix = safeAccountPrefix(siteId);
  if (username === `${prefix}-internal`) return 'internal';
  if (username === `${prefix}-domestic`) return 'domestic';
  if (username.startsWith(`${prefix}-internal`)) return 'internal-reserved';
  return 'h-endpoint';
}

function firstHysteriaPort(serverPorts: string): number {
  return normalizeHysteria2ServerPorts(serverPorts).firstPort;
}

function normalizeTlsFingerprint(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'unset' || trimmed === '-') return null;
  return trimmed.toUpperCase();
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

export function normalizeTestStatus(value: string): TestStep['status'] {
  if (value === 'failed' || value === 'blocked') return value;
  return 'passed';
}

export function required<T>(value: T | null, message: string): T {
  if (value) return value;
  throw new Error(message);
}
