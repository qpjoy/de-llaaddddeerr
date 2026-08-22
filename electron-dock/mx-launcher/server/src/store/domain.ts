import { Buffer } from 'node:buffer';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type {
  AnonymousEnrollment,
  AppCenterAccessDecision,
  AppCenterAccessInput,
  AppCenterAccessPolicy,
  AppCenterApp,
  AppCenterAppManifest,
  AppCenterAppInput,
  AppCenterInstallation,
  AppCenterInstallationInput,
  AppCenterInstallationQuery,
  AppCenterInstallationStatus,
  AppOnboardingDefaults,
  AppOnboardingDefaultsInput,
  AppOnboardingTemplate,
  AwxProviderConfig,
  AwxProviderConfigInput,
  AwxProviderKind,
  AwxProviderStatus,
  ConfigSecretExposure,
  ConfigSecretReference,
  ConfigSecretReferenceInput,
  ConfigSecretRotationMode,
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
  DnsReverseProxyRouteInput,
  DnsZoneRecord,
  DnsZoneSnapshot,
  GatewayConfigMapApplyInput,
  GatewayConfigMapManifest,
  GatewayConfigMapSyncInput,
  GatewayConfigMapSyncResult,
  GatewayRuntimeBackend,
  GatewayRuntimeConfig,
  GatewayRuntimeConfigInput,
  ImportUserCenterUserRow,
  ImportUserCenterUsersInput,
  IssueServiceAccountCredentialInput,
  IssueTokenInput,
  LauncherAnonymousEnrollmentPolicy,
  LauncherAnonymousUiVisibility,
  LauncherLeaseProfile,
  LauncherNetworkLease,
  LauncherNetworkLeaseInput,
  LauncherNetworkLeaseReleaseInput,
  LauncherNetworkMihomoSite,
  LauncherNetworkMihomoSiteInput,
  LauncherProductNetwork,
  LauncherProductNetworkInput,
  LauncherProductUserAccessInput,
  LauncherProductMode,
  LauncherNetworkScope,
  LauncherProductUpdatePolicy,
  LauncherNetworkReachabilityPlan,
  LauncherNetworkSnapshot,
  LauncherNetworkTopology,
  MihomoSubscriptionRender,
  PermissionGrant,
  PrincipalContext,
  PrincipalContextInput,
  ReleaseActivationMode,
  ReleaseArtifactKind,
  ReleaseArtifactRef,
  ReleaseDeliveryMode,
  PlatformPrincipal,
  ReleasePolicyDecision,
  ReleaseManagementPlan,
  ReleaseManagementPlanInput,
  ReleaseManagementPlanPatchInput,
  ReleaseRolloutStrategy,
  RuntimeConfig,
  RuntimeFeaturePolicy,
  RuntimeFeaturePolicyInput,
  RuntimeFeaturePolicyMode,
  RuntimeFeaturePolicyScopeKind,
  SecretProviderAuthMode,
  SecretProviderConfig,
  SecretProviderConfigInput,
  SecretProviderKind,
  SecretProviderStatus,
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
  SiteSlotInternalServicePeerObservation,
  SiteSlotInternalServicePeerObservationInput,
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
  UserCenterServiceAccountCredential,
  UserCenterServiceAccountCredentialStatus,
  UserCenterIssuedServiceAccountCredential,
  UserCenterTenant,
  UserCenterTokenRecord,
  UserCenterUser,
  UserCenterUserIdentity,
  UserCenterAppAccess,
  UserCenterUserCredential,
  UserCenterUserCredentialSummary,
  UserCenterUserProfile,
  UserH2oRuntimeProfile,
  UserH2oRuntimeProfileInput,
  UserH2oSubscription,
  UserOverseaEntitlement,
  UserOverseaEntitlementMigrationInput,
  UserOverseaEntitlementMigrationChange,
  UserOverseaEntitlementMigrationResult,
  UserOverseaEntitlementRolloutInput,
  UserOverseaEntitlementRolloutResult,
  UserOverseaSubscriptionRender,
  TestStep,
  TestGateVerdict,
  TestRun,
  UpdatePolicyKind
} from '../types.js';

export const GATEWAY_RUNTIME_CONFIG_ID = 'gateway_runtime_default';
export const APP_CENTER_RUNTIME_CONTRACT_VERSION = '0.1';
export const APP_CENTER_LAUNCHER_PROTOCOL_VERSION = '2';
export const APP_CENTER_BROKER_ABI_VERSION = '2';

export const USER_OVERSEA_SUBSCRIPTION_SCOPE = 'oversea.subscription.ensure';

/**
 * Public subscription links are a separate credential class from login tokens.
 *
 * A Clash client cannot send an Authorization header, so the credential has to
 * live in the URL. That makes it long-lived and copy-pasteable, which is exactly
 * why it must NOT be a login token: this audience+scope pair can only render one
 * user's oversea subscription, and revoking it never touches their session.
 */
export const USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE = 'mx-oversea-subscription';
export const USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE = 'oversea.subscription.read';
/** Clash keeps this bearer-in-path URL as durable client configuration; new links last 3650 days. */
export const USER_OVERSEA_SUBSCRIPTION_LINK_TTL_SECONDS = 3650 * 24 * 60 * 60;

export function userOverseaSubscriptionLinkPath(token: string): string {
  return `/internal/v1/oversea-subscriptions/${encodeURIComponent(token)}.yaml`;
}

/**
 * The token is the whole credential, so it must survive a round trip through a
 * URL path segment without needing escaping. `mx-v1-` + base64url satisfies that.
 */
export function isUserOverseaSubscriptionLinkToken(value: string): boolean {
  return /^mx-v1-[A-Za-z0-9_-]{16,}$/.test(value);
}

const USER_SCOPES = [
  'auth.read',
  'appcenter.read',
  'permission.request',
  'network.dns.policy',
  'observability.write',
  USER_OVERSEA_SUBSCRIPTION_SCOPE
];

const GUEST_SCOPES = ['auth.read', 'network.dns.policy'];

export const LAUNCHER_NETWORK_LEASE_TTL_DAYS = 180;
export const LAUNCHER_NETWORK_LEASE_TTL_MS = LAUNCHER_NETWORK_LEASE_TTL_DAYS * 24 * 60 * 60 * 1000;

const HYSTERIA2_ACCESS_PORT = 51288;
const HYSTERIA2_ACCESS_PORTS = String(HYSTERIA2_ACCESS_PORT);
const HYSTERIA2_EXPORT_FALLBACK_PORT = 3434;
const HYSTERIA2_CLIENT_DOWNLOAD = '30 Mbps';
const HYSTERIA2_CLIENT_UPLOAD = '30 Mbps';
export const SYSTEM_SUBSCRIPTION_CLIENT_BANDWIDTH = '50 Mbps';
const HYSTERIA2_CLIENT_ALPN = 'h3';
const HYSTERIA2_CLIENT_DNS = ['223.5.5.5', '119.29.29.29', '1.1.1.1', '8.8.8.8'];
/** 健康探测必须是「墙外可达且国内不可达」的地址，否则节点挂了探测仍然算通过。 */
const OVERSEA_HEALTH_CHECK_URL = 'http://www.gstatic.com/generate_204';
const OVERSEA_HEALTH_CHECK_INTERVAL_SECONDS = 300;
const OVERSEA_AUTO_GROUP = 'Oversea-Auto';
const OVERSEA_SELECT_GROUP = 'Oversea';
export const SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID = 'subscriptions';
export const SYSTEM_SUBSCRIPTION_MIXED_PORT = 7788;
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

const USER_PASSWORD_SCRYPT = {
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 64
};

export const USER_CENTER_SERVICE_ACCOUNT_SECRET_PREFIX = 'mxsa1.';
const USER_CENTER_SERVICE_ACCOUNT_SECRET_BYTES = 32;
const USER_CENTER_SERVICE_ACCOUNT_SECRET_MIN_LENGTH = 32;
const USER_CENTER_SERVICE_ACCOUNT_SECRET_MAX_LENGTH = 4096;

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
      roleId: 'mx-release-publisher',
      displayName: 'MX Release Publisher',
      scopes: ['sdk.release.read', 'sdk.release.publish'],
      createdAt: now
    },
    {
      roleId: 'mx-release-approver',
      displayName: 'MX Release Approver',
      scopes: ['sdk.release.read', 'sdk.release.approve'],
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

export function createUserCenterUser(
  input: CreateUserInput,
  previous: UserCenterUser | null = null,
  credential: UserCenterUserCredentialSummary | null = null,
  now = new Date().toISOString()
): UserCenterUser {
  const account = userAccountForInput(input, previous);
  const userId = input.userId?.trim() || previous?.userId || `usr_${safeIdPart(account).toLowerCase()}`;
  const email = nullableTrimmed(input.email) ?? previous?.email ?? (account.includes('@') ? account : null);
  const displayName = input.displayName?.trim()
    || previous?.displayName
    || input.username?.trim()
    || input.account?.trim()
    || account;
  const profile = mergeUserProfile(previous?.profile, input);
  const credentialSummary = credential ?? previous?.credential ?? emptyUserCredentialSummary();
  return {
    userId,
    tenantId: 'tenant_default',
    orgIds: input.orgIds?.length ? input.orgIds : ['org_default'],
    email,
    account,
    displayName,
    roleIds: input.roleIds?.length ? input.roleIds : ['mx-user'],
    status: input.status === 'disabled' ? 'disabled' : previous?.status ?? 'active',
    profile,
    credential: {
      ...credentialSummary,
      providers: [...new Set([
        ...credentialSummary.providers,
        ...(profile.externalIds.feishuSubject ? ['feishu'] : [])
      ])]
    },
    appAccess: mergeUserAppAccess(previous?.appAccess, input),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
}

export function emptyUserCredentialSummary(): UserCenterUserCredentialSummary {
  return {
    hasPassword: false,
    passwordUpdatedAt: null,
    providers: []
  };
}

export function userCredentialSummary(
  credential: UserCenterUserCredential | null,
  externalIds: Record<string, string> = {}
): UserCenterUserCredentialSummary {
  const providers = [
    ...(credential ? [credential.kind] : []),
    ...(externalIds.feishuSubject ? ['feishu'] : [])
  ];
  return {
    hasPassword: Boolean(credential),
    passwordUpdatedAt: credential?.updatedAt ?? null,
    providers: [...new Set(providers)]
  };
}

export function emptyUserAppAccess(): UserCenterAppAccess {
  return {
    homeAppId: null,
    registeredByAppId: null,
    allowedAppIds: [],
    deniedAppIds: []
  };
}

export function userCenterUserIdentity(user: UserCenterUser): UserCenterUserIdentity {
  const appAccess = user.appAccess ?? emptyUserAppAccess();
  return {
    userId: user.userId,
    account: user.account,
    displayName: user.displayName,
    status: user.status,
    appAccess: {
      homeAppId: appAccess.homeAppId ?? null,
      registeredByAppId: appAccess.registeredByAppId ?? null,
      allowedAppIds: [...(appAccess.allowedAppIds ?? [])],
      deniedAppIds: [...(appAccess.deniedAppIds ?? [])]
    },
    updatedAt: user.updatedAt
  };
}

export class LauncherProductUserAccessDeniedError extends Error {
  readonly code = 'launcher_product_user_access_denied';

  constructor(readonly productId: string, readonly userId: string) {
    super(`User ${userId} is blocked from launcher product ${productId}`);
    this.name = 'LauncherProductUserAccessDeniedError';
  }
}

export function launcherProductUserAccessBlocked(
  user: Pick<UserCenterUser, 'appAccess'> | null | undefined,
  productId: string
): boolean {
  if (!user) return false;
  const normalizedProductId = normalizeLauncherNetworkProductId(productId);
  return (user.appAccess?.deniedAppIds ?? [])
    .map((item) => normalizeLauncherNetworkProductId(item))
    .includes(normalizedProductId);
}

export function assertLauncherProductUserAccess(
  user: Pick<UserCenterUser, 'userId' | 'appAccess'> | null | undefined,
  productId: string
): void {
  if (user && launcherProductUserAccessBlocked(user, productId)) {
    throw new LauncherProductUserAccessDeniedError(
      normalizeLauncherNetworkProductId(productId),
      user.userId
    );
  }
}

export function updateLauncherProductUserAccess(
  user: UserCenterUser,
  input: Pick<LauncherProductUserAccessInput, 'productId' | 'blocked'>,
  now = new Date().toISOString()
): { user: UserCenterUser; changed: boolean; productId: string } {
  const productId = normalizeLauncherNetworkProductId(input.productId);
  const previousDeniedAppIds = uniqueAppIds(user.appAccess?.deniedAppIds ?? []);
  const wasBlocked = previousDeniedAppIds.includes(productId);
  const deniedAppIds = input.blocked
    ? uniqueAppIds([...previousDeniedAppIds, productId])
    : previousDeniedAppIds.filter((appId) => appId !== productId);
  const changed = wasBlocked !== input.blocked;
  return {
    productId,
    changed,
    user: changed
      ? {
          ...user,
          appAccess: {
            ...(user.appAccess ?? emptyUserAppAccess()),
            deniedAppIds
          },
          updatedAt: now
        }
      : user
  };
}

export function createUserCenterUserCredential(
  userId: string,
  password: string,
  input: Pick<CreateUserInput, 'requestedBy' | 'requestId'> = {},
  previous: UserCenterUserCredential | null = null,
  now = new Date().toISOString()
): UserCenterUserCredential {
  const plain = password.trim();
  if (!plain) throw new Error('password is required');
  if (plain.length > 200) throw new Error('password is too long');
  const requestedBy = input.requestedBy?.trim() || 'user-center';
  return {
    credentialId: `cred_${userId}_local_password`,
    userId,
    kind: 'local-password',
    passwordHash: hashUserCenterPassword(plain),
    createdBy: previous?.createdBy ?? requestedBy,
    createdAt: previous?.createdAt ?? now,
    updatedBy: requestedBy,
    updatedAt: now
  };
}

export function verifyUserCenterCredential(password: string, credential: UserCenterUserCredential | null): boolean {
  if (!credential || credential.kind !== 'local-password') return false;
  return verifyUserCenterPasswordHash(password, credential.passwordHash);
}

export function userMatchesLogin(user: UserCenterUser, login: string): boolean {
  const normalized = normalizeUserLogin(login);
  if (!normalized) return false;
  return userLoginValues(user).some((value) => normalizeUserLogin(value) === normalized);
}

/** Resolve password-grant identities by exact case and fail closed on duplicate aliases. */
export function resolveUserCenterUserForLogin(
  users: readonly UserCenterUser[],
  login: string
): UserCenterUser | null {
  const exact = exactUserLogin(login);
  if (!exact) return null;
  const exactMatches = users.filter((user) => (
    userLoginValues(user).some((value) => exactUserLogin(value) === exact)
  ));
  return exactMatches.length === 1 ? exactMatches[0] ?? null : null;
}

export function userCenterDeleteProtectionReason(user: UserCenterUser, users: UserCenterUser[]): string | null {
  if (user.userId === 'usr_demo_admin' || user.userId === 'usr_demo_user') {
    return `Built-in bootstrap user cannot be deleted: ${user.userId}`;
  }
  if (user.status === 'active' && user.roleIds.includes('mx-admin')) {
    const activeAdmins = users.filter((candidate) => (
      candidate.status === 'active' && candidate.roleIds.includes('mx-admin')
    ));
    if (activeAdmins.length <= 1) return 'The last active mx-admin user cannot be deleted';
  }
  return null;
}

export function normalizeImportUserCenterRow(
  row: ImportUserCenterUserRow,
  input: Pick<ImportUserCenterUsersInput, 'defaultRoleIds' | 'defaultOrgIds' | 'defaultHomeAppId' | 'defaultRegisteredByAppId' | 'defaultAllowedAppIds' | 'defaultOverseaSiteIds' | 'provisionOversea' | 'requestedBy' | 'requestId'>
): CreateUserInput {
  const account = nullableTrimmed(row.account)
    ?? nullableTrimmed(row.username)
    ?? nullableTrimmed(row.user_name)
    ?? nullableTrimmed(row.email)
    ?? (row.id === undefined || row.id === null ? null : String(row.id));
  if (!account) throw new Error('account is required');
  const legacyId = row.id === undefined || row.id === null ? null : String(row.id);
  return {
    userId: row.userId ?? null,
    account,
    username: nullableTrimmed(row.username) ?? nullableTrimmed(row.user_name) ?? account,
    email: row.email ?? null,
    displayName: nullableTrimmed(row.displayName) ?? nullableTrimmed(row.display_name) ?? nullableTrimmed(row.user_name) ?? account,
    password: row.password ?? null,
    roleIds: input.defaultRoleIds?.length ? input.defaultRoleIds : ['mx-user'],
    orgIds: input.defaultOrgIds?.length ? input.defaultOrgIds : ['org_default'],
    profile: row.profile ?? null,
    attributes: row.attributes ?? null,
    externalIds: {
      ...(row.externalIds ?? {}),
      ...(legacyId ? { legacyUserId: legacyId } : {}),
      ...(nullableTrimmed(row.user_name) ? { legacyUserName: nullableTrimmed(row.user_name) as string } : {})
    },
    appAccess: row.appAccess ?? null,
    homeAppId: nullableTrimmed(row.homeAppId) ?? input.defaultHomeAppId ?? null,
    registeredByAppId: nullableTrimmed(row.registeredByAppId) ?? input.defaultRegisteredByAppId ?? null,
    allowedAppIds: row.allowedAppIds ?? input.defaultAllowedAppIds ?? null,
    deniedAppIds: row.deniedAppIds ?? null,
    defaultOverseaSiteIds: input.defaultOverseaSiteIds ?? null,
    provisionOversea: input.provisionOversea ?? null,
    requestedBy: input.requestedBy ?? 'user-import',
    requestId: input.requestId ?? null
  };
}

function userAccountForInput(input: CreateUserInput, previous: UserCenterUser | null): string {
  return nullableTrimmed(input.account)
    ?? nullableTrimmed(input.username)
    ?? nullableTrimmed(input.email)
    ?? previous?.account
    ?? previous?.email
    ?? previous?.userId
    ?? 'demo-user';
}

function mergeUserProfile(previous: UserCenterUserProfile | null | undefined, input: CreateUserInput): UserCenterUserProfile {
  const profile = input.profile ?? {};
  const previousExternalIds = previous?.externalIds ?? {};
  return {
    title: nullableTrimmed(profile.title) ?? previous?.title ?? null,
    department: nullableTrimmed(profile.department) ?? previous?.department ?? null,
    location: nullableTrimmed(profile.location) ?? previous?.location ?? null,
    address: nullableTrimmed(profile.address) ?? previous?.address ?? null,
    phone: nullableTrimmed(profile.phone) ?? previous?.phone ?? null,
    tags: uniqueStrings([
      ...(previous?.tags ?? []),
      ...(Array.isArray(profile.tags) ? profile.tags : [])
    ]),
    attributes: {
      ...(previous?.attributes ?? {}),
      ...recordValue(input.attributes),
      ...recordValue(profile.attributes)
    },
    externalIds: stringRecordValue({
      ...previousExternalIds,
      ...recordValue(input.externalIds),
      ...recordValue(profile.externalIds)
    })
  };
}

function mergeUserAppAccess(previous: UserCenterAppAccess | null | undefined, input: CreateUserInput): UserCenterAppAccess {
  const access = input.appAccess ?? {};
  return {
    homeAppId: normalizeOptionalAppId(input.homeAppId ?? access.homeAppId) ?? previous?.homeAppId ?? null,
    registeredByAppId: normalizeOptionalAppId(input.registeredByAppId ?? access.registeredByAppId) ?? previous?.registeredByAppId ?? null,
    allowedAppIds: uniqueAppIds([
      ...(previous?.allowedAppIds ?? []),
      ...appIdList(input.allowedAppIds),
      ...appIdList(access.allowedAppIds)
    ]),
    deniedAppIds: uniqueAppIds([
      ...(previous?.deniedAppIds ?? []),
      ...appIdList(input.deniedAppIds),
      ...appIdList(access.deniedAppIds)
    ])
  };
}

function hashUserCenterPassword(password: string): string {
  return hashScryptValue(password);
}

function verifyUserCenterPasswordHash(password: string, encoded: string): boolean {
  return verifyScryptValue(password, encoded);
}

function hashScryptValue(value: string): string {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(value, salt, USER_PASSWORD_SCRYPT.keyLength, {
    N: USER_PASSWORD_SCRYPT.N,
    r: USER_PASSWORD_SCRYPT.r,
    p: USER_PASSWORD_SCRYPT.p
  }).toString('base64url');
  return `scrypt$N=${USER_PASSWORD_SCRYPT.N},r=${USER_PASSWORD_SCRYPT.r},p=${USER_PASSWORD_SCRYPT.p}$${salt}$${hash}`;
}

function verifyScryptValue(value: string, encoded: string): boolean {
  try {
    const parts = encoded.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const params = Object.fromEntries(parts[1].split(',').map((item) => {
      const [key, parameterValue] = item.split('=');
      return [key, Number(parameterValue)];
    }));
    const salt = parts[2];
    const expected = Buffer.from(parts[3], 'base64url');
    if (!salt || !expected.length) return false;
    const actual = scryptSync(value, salt, expected.length, {
      N: Number(params.N) || USER_PASSWORD_SCRYPT.N,
      r: Number(params.r) || USER_PASSWORD_SCRYPT.r,
      p: Number(params.p) || USER_PASSWORD_SCRYPT.p
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateUserCenterServiceAccountSecret(clientSecret: string): void {
  if (typeof clientSecret !== 'string' || !clientSecret) {
    throw new Error('clientSecret is required');
  }
  if (clientSecret.length < USER_CENTER_SERVICE_ACCOUNT_SECRET_MIN_LENGTH) {
    throw new Error(`clientSecret must contain at least ${USER_CENTER_SERVICE_ACCOUNT_SECRET_MIN_LENGTH} characters`);
  }
  if (clientSecret.length > USER_CENTER_SERVICE_ACCOUNT_SECRET_MAX_LENGTH) {
    throw new Error(`clientSecret must contain at most ${USER_CENTER_SERVICE_ACCOUNT_SECRET_MAX_LENGTH} characters`);
  }
  if (/[\r\n\0]/.test(clientSecret)) {
    throw new Error('clientSecret must be a single-line value');
  }
}

function nullableTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function userLoginValues(user: UserCenterUser): unknown[] {
  return [
    user.userId,
    user.account,
    user.email,
    user.displayName,
    user.profile?.externalIds?.legacyUserId,
    user.profile?.externalIds?.legacyId
  ];
}

function exactUserLogin(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUserLogin(value: unknown): string {
  return exactUserLogin(value).toLowerCase();
}

function normalizeOptionalAppId(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? safeIdPart(raw).toLowerCase() : null;
}

function appIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueAppIds(value)
    : typeof value === 'string'
      ? uniqueAppIds(value.split(/[,;\n]/))
      : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringRecordValue(value: Record<string, unknown>): Record<string, string> {
  return Object.entries(value).reduce<Record<string, string>>((next, [key, raw]) => {
    const text = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw);
    if (key && text) next[key] = text;
    return next;
  }, {});
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function uniqueAppIds(values: unknown[]): string[] {
  return [...new Set(values.map(normalizeOptionalAppId).filter((value): value is string => Boolean(value)))];
}

export function createUserCenterServiceAccount(
  input: CreateServiceAccountInput,
  now = new Date().toISOString()
): UserCenterServiceAccount {
  const serviceAccountId = input.serviceAccountId?.trim() || '';
  if (!serviceAccountId) throw new Error('serviceAccountId is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(serviceAccountId)) {
    throw new Error(
      'serviceAccountId must be 1-160 characters and match [A-Za-z0-9][A-Za-z0-9_.:-]*'
    );
  }
  return {
    serviceAccountId,
    tenantId: 'tenant_default',
    displayName: input.displayName?.trim() || serviceAccountId,
    roleIds: input.roleIds?.length ? input.roleIds : ['mx-service-account'],
    scopes: input.scopes ?? [],
    allowedProductIds: uniqueAppIds(input.allowedProductIds ?? []),
    status: 'active',
    createdAt: now
  };
}

export function appReleasePublisherServiceAccountId(appId: string): string {
  const normalized = appId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'app';
  const suffix = '_release_publisher';
  const maxAppIdLength = 160 - 'svc_'.length - suffix.length;
  const bounded = normalized.length <= maxAppIdLength
    ? normalized
    : `${normalized.slice(0, maxAppIdLength - 13)}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
  return `svc_${bounded}${suffix}`;
}

export function generateUserCenterServiceAccountSecret(): string {
  return `${USER_CENTER_SERVICE_ACCOUNT_SECRET_PREFIX}${randomBytes(USER_CENTER_SERVICE_ACCOUNT_SECRET_BYTES).toString('base64url')}`;
}

export function userCenterServiceAccountCredentialId(serviceAccountId: string): string {
  const normalizedServiceAccountId = serviceAccountId.trim();
  if (!normalizedServiceAccountId) throw new Error('serviceAccountId is required');
  return `sacred_${createHash('sha256').update(normalizedServiceAccountId).digest('hex').slice(0, 32)}`;
}

export function hashUserCenterServiceAccountSecret(clientSecret: string): string {
  validateUserCenterServiceAccountSecret(clientSecret);
  return hashScryptValue(clientSecret);
}

export function verifyUserCenterServiceAccountSecret(
  clientSecret: string,
  credential: UserCenterServiceAccountCredential | null
): boolean {
  if (
    !credential
    || credential.kind !== 'client-secret'
    || typeof clientSecret !== 'string'
    || clientSecret.length < USER_CENTER_SERVICE_ACCOUNT_SECRET_MIN_LENGTH
    || clientSecret.length > USER_CENTER_SERVICE_ACCOUNT_SECRET_MAX_LENGTH
    || /[\r\n]/.test(clientSecret)
  ) {
    return false;
  }
  return verifyScryptValue(clientSecret, credential.clientSecretHash);
}

export function createUserCenterServiceAccountCredential(
  serviceAccountId: string,
  clientSecret: string,
  input: Pick<IssueServiceAccountCredentialInput, 'requestedBy'> & {
    source?: UserCenterServiceAccountCredential['source'];
  } = {},
  previous: UserCenterServiceAccountCredential | null = null,
  now = new Date().toISOString()
): UserCenterServiceAccountCredential {
  const normalizedServiceAccountId = serviceAccountId.trim();
  if (!normalizedServiceAccountId) throw new Error('serviceAccountId is required');
  const requestedBy = input.requestedBy?.trim() || 'user-center';
  return {
    credentialId: previous?.credentialId ?? userCenterServiceAccountCredentialId(normalizedServiceAccountId),
    serviceAccountId: normalizedServiceAccountId,
    kind: 'client-secret',
    clientSecretHash: hashUserCenterServiceAccountSecret(clientSecret),
    version: (previous?.version ?? 0) + 1,
    source: input.source ?? 'issued',
    createdBy: previous?.createdBy ?? requestedBy,
    createdAt: previous?.createdAt ?? now,
    updatedBy: requestedBy,
    updatedAt: now
  };
}

export function summarizeUserCenterServiceAccountCredential(
  credential: UserCenterServiceAccountCredential
): UserCenterServiceAccountCredentialStatus {
  return {
    credentialId: credential.credentialId,
    serviceAccountId: credential.serviceAccountId,
    version: credential.version,
    source: credential.source,
    issuedAt: credential.updatedAt,
    updatedAt: credential.updatedAt
  };
}

export function issueUserCenterServiceAccountCredential(
  input: IssueServiceAccountCredentialInput,
  previous: UserCenterServiceAccountCredential | null = null,
  now = new Date().toISOString()
): {
  credential: UserCenterServiceAccountCredential;
  issued: UserCenterIssuedServiceAccountCredential;
} {
  const serviceAccountId = input.serviceAccountId?.trim();
  if (!serviceAccountId) throw new Error('serviceAccountId is required');
  if (previous && input.rotate !== true) {
    throw new Error(`Service account credential already exists: ${serviceAccountId}`);
  }
  const clientSecret = generateUserCenterServiceAccountSecret();
  const credential = createUserCenterServiceAccountCredential(
    serviceAccountId,
    clientSecret,
    input,
    previous,
    now
  );
  return {
    credential,
    issued: {
      clientId: serviceAccountId,
      clientSecret,
      credential: summarizeUserCenterServiceAccountCredential(credential)
    }
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
    authProvider: input.authProvider?.trim() || null,
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
    authProvider: record.authProvider ?? null,
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
      appAccess: null,
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
    appAccess: null,
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
  if (routeId === 'sdk.roles.list' || routeId === 'sdk.users.list') {
    return ['sdk.user.read', 'rbac.manage'];
  }
  if (routeId === 'sdk.users.password.self') return ['auth.read'];
  if (
    routeId === 'sdk.users.create'
    || routeId === 'sdk.users.password.update'
  ) {
    return ['sdk.user.write', 'rbac.manage'];
  }
  if (routeId === 'sdk.permissions.request') return ['sdk.permission.request', 'permission.request'];
  if (routeId.startsWith('sdk.dns.')) return ['sdk.dns.evaluate', 'network.dns.policy'];
  if (routeId === 'sdk.audit.write') return ['sdk.audit.write'];
  if (routeId === 'sdk.observability.logs') return ['sdk.observability.write', 'observability.write'];
  if (
    routeId === 'sdk.releases.list'
    || routeId === 'sdk.releases.get'
    || routeId === 'sdk.release_artifacts.get'
  ) {
    return ['sdk.release.read', 'sdk.release.publish', 'sdk.release.approve', 'release.manage'];
  }
  if (routeId === 'sdk.release_artifacts.upload' || routeId === 'sdk.releases.create') {
    return ['sdk.release.publish', 'release.manage'];
  }
  if (routeId === 'sdk.releases.gate') return ['sdk.release.approve', 'release.manage'];
  return [];
}

export const MX_H2I_PRODUCT_ID = 'mx-h2i';

/**
 * 平台默认出海站点的候选顺序：mx-h2i 优先，其余产品按原顺序兜底。
 *
 * `explicit` 表示这条默认值是人改过的（不是 builtin seed），只有 explicit 的才能
 * 覆盖「按在役站点自动挑一个」的降级逻辑——所以 admin 在后台设过默认节点之后，
 * 它必须稳定胜出，而不是取决于产品列表的排序。
 */
export function orderDefaultOverseaSiteCandidates(
  products: Array<Pick<LauncherProductNetwork, 'productId' | 'defaultOverseaSiteId' | 'createdBy' | 'updatedBy'>>
): Array<{ siteId: string; explicit: boolean }> {
  return products
    .slice()
    .sort((a, b) => Number(b.productId === MX_H2I_PRODUCT_ID) - Number(a.productId === MX_H2I_PRODUCT_ID))
    .map((product) => ({
      siteId: product.defaultOverseaSiteId,
      explicit: product.updatedBy !== 'builtin' || product.createdBy !== 'builtin'
    }))
    .filter((item) => item.siteId);
}

/**
 * `Oversea` 是 `type: select` 组，Clash/mihomo 在用户没手动选过时**默认用列表里的第一个**
 * ——没有测速、没有自动挑选。而节点顺序原来等于 `entitlement.siteIds` 的字母序，
 * 也就是说「默认走哪台机器」是被站点名的字母顺序决定的，纯属巧合。
 *
 * 这里把平台默认站点排到第一位，其余保持原顺序：默认流量可控，同时组内其它节点仍在，
 * 用户手动切换过的选择也不会被覆盖（那是客户端侧记住的）。
 */
export function orderOverseaSubscriptionEntries<T extends { site: { siteId: string } }>(
  entries: T[],
  preferredSiteId: string | null
): T[] {
  const preferred = String(preferredSiteId || '').trim();
  if (!preferred) return entries;
  return entries
    .slice()
    .sort((a, b) => Number(b.site.siteId === preferred) - Number(a.site.siteId === preferred));
}

/**
 * 批量迁移的「只算不写」部分：给定一批 entitlement，算出每个人迁移后的站点集合。
 *
 * 拆成纯函数是为了让 dry-run 和真正执行走同一段逻辑——预览里看到的 after，就是
 * confirm 之后会写进去的值，不会出现两套算法对不上的情况。
 */
export function planUserOverseaEntitlementMigration(
  entitlements: Array<Pick<UserOverseaEntitlement, 'userId' | 'siteIds'>>,
  input: { fromSiteId: string; toSiteId: string; mode: 'replace' | 'add'; userIds?: string[] | null }
): Array<{ userId: string; before: string[]; after: string[] }> {
  const scope = new Set((input.userIds ?? []).map((item) => String(item || '').trim()).filter(Boolean));
  const plans: Array<{ userId: string; before: string[]; after: string[] }> = [];
  for (const entitlement of entitlements) {
    if (scope.size > 0 && !scope.has(entitlement.userId)) continue;
    const before = [...new Set(entitlement.siteIds.map((item) => String(item || '').trim()).filter(Boolean))].sort();
    if (!before.includes(input.fromSiteId)) continue;
    const kept = input.mode === 'replace'
      ? before.filter((siteId) => siteId !== input.fromSiteId)
      : before;
    const after = [...new Set([...kept, input.toSiteId])].sort();
    if (after.length === before.length && after.every((siteId, index) => siteId === before[index])) continue;
    plans.push({ userId: entitlement.userId, before, after });
  }
  return plans;
}

export function assertUserOverseaMigrationInput(
  input: UserOverseaEntitlementMigrationInput
): { fromSiteId: string; toSiteId: string; mode: 'replace' | 'add'; userIds: string[] | null } {
  const fromSiteId = input.fromSiteId?.trim() ?? '';
  const toSiteId = input.toSiteId?.trim() ?? '';
  if (!fromSiteId) throw new Error('fromSiteId is required');
  if (!toSiteId) throw new Error('toSiteId is required');
  if (fromSiteId === toSiteId) throw new Error('fromSiteId and toSiteId must differ');
  return {
    fromSiteId,
    toSiteId,
    mode: input.mode === 'add' ? 'add' : 'replace',
    userIds: input.userIds?.length ? input.userIds : null
  };
}

export function buildUserOverseaMigrationResult(
  plan: { fromSiteId: string; toSiteId: string; mode: 'replace' | 'add' },
  applied: boolean,
  scanned: number,
  changes: UserOverseaEntitlementMigrationChange[],
  now = new Date().toISOString()
): UserOverseaEntitlementMigrationResult {
  return {
    fromSiteId: plan.fromSiteId,
    toSiteId: plan.toSiteId,
    mode: plan.mode,
    applied,
    scanned,
    matched: changes.length,
    changed: changes.filter((change) => change.status === 'migrated').length,
    failed: changes.filter((change) => change.status === 'failed').length,
    changes,
    generatedAt: now
  };
}

export function assertUserOverseaRolloutInput(
  input: UserOverseaEntitlementRolloutInput
): { toSiteId: string; userIds: string[] | null } {
  const toSiteId = input.toSiteId?.trim() ?? '';
  if (!toSiteId) throw new Error('toSiteId is required');
  const userIds = [...new Set((input.userIds ?? []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (input.confirm === true && userIds.length === 0) {
    throw new Error('Apply requires the non-empty userIds frozen by Preview');
  }
  return { toSiteId, userIds: userIds.length ? userIds : null };
}

export function planUserOverseaEntitlementRollout(
  users: Array<Pick<UserCenterUser, 'userId' | 'account' | 'roleIds' | 'status'>>,
  entitlements: Array<Pick<UserOverseaEntitlement, 'userId' | 'siteIds'>>,
  input: { toSiteId: string; userIds?: string[] | null }
): Array<{ userId: string; account: string; before: string[]; after: string[] }> {
  const scope = new Set((input.userIds ?? []).map((item) => String(item || '').trim()).filter(Boolean));
  const entitlementsByUserId = new Map(entitlements.map((entitlement) => [entitlement.userId, entitlement]));
  return users.flatMap((user) => {
    if (user.status !== 'active' || user.roleIds.includes('mx-service-account')) return [];
    if (scope.size > 0 && !scope.has(user.userId)) return [];
    const before = [...new Set((entitlementsByUserId.get(user.userId)?.siteIds ?? [])
      .map((item) => String(item || '').trim())
      .filter(Boolean))].sort();
    if (before.includes(input.toSiteId)) return [];
    return [{
      userId: user.userId,
      account: user.account,
      before,
      after: [...before, input.toSiteId].sort()
    }];
  });
}

export function buildUserOverseaRolloutResult(
  toSiteId: string,
  applied: boolean,
  scanned: number,
  changes: UserOverseaEntitlementMigrationChange[],
  now = new Date().toISOString()
): UserOverseaEntitlementRolloutResult {
  return {
    toSiteId,
    applied,
    scanned,
    matched: changes.length,
    changed: changes.filter((change) => change.status === 'migrated').length,
    skipped: changes.filter((change) => change.status === 'skipped').length,
    failed: changes.filter((change) => change.status === 'failed').length,
    changes,
    generatedAt: now
  };
}

export const APP_CENTER_PRODUCT_ID = 'appcenter';
export const MX_INSIGHT_HUB_APP_ID = 'mx-insight-hub';
export const LAUNCHER_FOUNDATION_PRODUCT_ID = 'launcher';
export const MX_DEFAULT_APP_DNS_ZONE = 'mxinfo-inc.cn';
const MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST = 'h2i.minsight-ai.com';
const MX_LEGACY_PUBLIC_BOOTSTRAP_HOST = 'h2i.mxinfo-inc.cn';

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

export function launcherNetworkSdkTestModeAllowed(
  config: RuntimeConfig,
  input: LauncherNetworkLeaseInput
): boolean {
  if (config.launcherNetworkSdkTestModeEnabled !== true) return false;
  if (booleanish(input.sdkTestMode)) return true;
  const requestedBy = input.requestedBy?.trim().toLowerCase() || '';
  return [
    'sdk-test-mode',
    'launcher-sdk-test',
    'launcher-network-sdk-test',
    'standalone-sdk-test',
    'embed-sdk-test'
  ].includes(requestedBy);
}

export function launcherNetworkAppIdForLeaseInput(
  input: LauncherNetworkLeaseInput,
  requestedProduct: LauncherProductNetwork
): string {
  return normalizeLauncherNetworkProductId(input.appId || input.productId || requestedProduct.productId);
}

export function assertLauncherNetworkLeaseEntitlement(
  input: LauncherNetworkLeaseInput,
  requestedProduct: LauncherProductNetwork,
  leaseProduct: LauncherProductNetwork,
  app: AppCenterApp | null
): void {
  if (requestedProduct.enabled === false) {
    throw new Error(`Launcher product ${requestedProduct.productId} is disabled`);
  }
  if (leaseProduct.enabled === false) {
    throw new Error(`Launcher standalone channel ${leaseProduct.productId} is disabled`);
  }
  const appId = launcherNetworkAppIdForLeaseInput(input, requestedProduct);
  if (!app) {
    throw new Error(`Launcher app ${appId} is not registered in AppCenter`);
  }
  if (app.enabled === false) {
    throw new Error(`Launcher app ${app.appId} is disabled`);
  }
  const appProductId = normalizeLauncherNetworkProductId(app.productNetworkId || app.appId);
  if (appProductId !== requestedProduct.productId) {
    throw new Error(`Launcher app ${app.appId} is bound to ${appProductId}, not ${requestedProduct.productId}`);
  }
  const appMode = launcherProductMode(app.launcherMode ?? requestedProduct.mode);
  if (appMode !== requestedProduct.mode) {
    throw new Error(`Launcher app ${app.appId} mode ${appMode} does not match product mode ${requestedProduct.mode}`);
  }
  if (requestedProduct.mode === 'embed') {
    const channelId = launcherNetworkLeaseProductId(app.standaloneChannelProductId || requestedProduct.standaloneChannelProductId);
    if (channelId !== leaseProduct.productId) {
      throw new Error(`Launcher app ${app.appId} is bound to channel ${channelId}, not ${leaseProduct.productId}`);
    }
  }
  const required = requestedProduct.mode === 'standalone'
    ? ['launcher-network', 'launcher-standalone']
    : ['launcher-network', 'launcher-embed-sdk'];
  const capabilities = new Set(app.requiredCapabilities || []);
  const missing = required.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) {
    throw new Error(`Launcher app ${app.appId} lacks required capabilities: ${missing.join(', ')}`);
  }
}

export class LauncherAnonymousEnrollmentPolicyError extends Error {
  readonly code: 'launcher_anonymous_enrollment_draining' | 'launcher_anonymous_enrollment_disabled';

  constructor(
    code: 'launcher_anonymous_enrollment_draining' | 'launcher_anonymous_enrollment_disabled',
    productId: string
  ) {
    super(
      code === 'launcher_anonymous_enrollment_draining'
        ? `Launcher product ${productId} is draining anonymous enrollment; only an authorized active lease may renew`
        : `Launcher product ${productId} has disabled anonymous enrollment`
    );
    this.name = 'LauncherAnonymousEnrollmentPolicyError';
    this.code = code;
  }
}

/**
 * Enforce anonymous admission separately from the general app entitlement so
 * employee/Feishu leases never share this gate. `anonymousRenewalLeaseId` is a
 * server-derived proof; a public request body's value must never be forwarded.
 */
export function assertLauncherAnonymousEnrollmentPolicy(
  input: LauncherNetworkLeaseInput,
  requestedProduct: LauncherProductNetwork,
  previous: LauncherNetworkLease | null,
  now = new Date()
): void {
  const identityKind = launcherNetworkIdentityKind(input.identityKind, input.userId);
  if (identityKind !== 'anonymous') return;
  const policy = launcherAnonymousEnrollmentPolicy(requestedProduct.anonymousEnrollmentPolicy);
  if (policy === 'enabled') return;
  if (policy === 'disabled') {
    throw new LauncherAnonymousEnrollmentPolicyError(
      'launcher_anonymous_enrollment_disabled',
      requestedProduct.productId
    );
  }
  const authorizedRenewalLeaseId = input.anonymousRenewalLeaseId?.trim() || '';
  if (
    previous
    && authorizedRenewalLeaseId === previous.leaseId
    && launcherNetworkLeaseIsActive(previous, now)
  ) {
    return;
  }
  throw new LauncherAnonymousEnrollmentPolicyError(
    'launcher_anonymous_enrollment_draining',
    requestedProduct.productId
  );
}

function booleanish(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
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

function appCenterManifestRecord(value: AppCenterAppInput['manifest']): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {};
}

function appCenterManifestString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function appCenterManifestNestedString(value: Record<string, unknown>, section: string, key: string): string | null {
  const row = value[section];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const raw = (row as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function defaultAppPackageName(appId: string): string {
  if (appId === MX_H2I_PRODUCT_ID) return '@qpjoy/mx-h2i-demo';
  if (appId === APP_CENTER_PRODUCT_ID) return '@qpjoy/electron-launcher-appcenter';
  // Luopan predates packageName persistence in AppCenter. Keep the historical
  // package identity server-side so old registrations can join the current
  // release identity flow without changing their network productId.
  if (appId === 'luopan') return '@qpjoy/luopan-demo';
  return `@qpjoy/electron-launcher-app-${safeIdPart(appId).toLowerCase() || 'app'}`;
}

function buildAppCenterManifest(input: {
  appId: string;
  productId: string;
  displayName: string;
  fullName: string | null;
  packageName: string | null;
  version: string;
  category: string;
  description: string;
  launcherMode: LauncherProductMode;
  standaloneChannelProductId: string | null;
  requiredCapabilities: string[];
  runtimeContractVersion: string | null;
  manifest: Record<string, unknown>;
  previous: AppCenterAppManifest | null | undefined;
}): AppCenterAppManifest {
  const previous = input.previous ?? null;
  const protocolVersion = appCenterManifestString(input.manifest, 'protocolVersion')
    || previous?.protocolVersion
    || APP_CENTER_LAUNCHER_PROTOCOL_VERSION;
  const sdkAbiVersion = appCenterManifestString(input.manifest, 'sdkAbiVersion')
    || previous?.sdkAbiVersion
    || APP_CENTER_BROKER_ABI_VERSION;
  const runtimeContractVersion = input.runtimeContractVersion
    || appCenterManifestString(input.manifest, 'runtimeContractVersion')
    || previous?.runtimeContractVersion
    || (input.launcherMode === 'embed' ? APP_CENTER_RUNTIME_CONTRACT_VERSION : undefined);
  const networkScope: LauncherNetworkScope = input.launcherMode === 'standalone' ? 'owner' : 'broker-session';
  const serviceVip = appCenterManifestNestedString(input.manifest, 'network', 'serviceVip')
    || previous?.network?.serviceVip
    || null;
  return {
    appId: input.appId,
    productId: input.productId,
    displayName: input.fullName || input.displayName,
    description: input.description,
    packageName: input.packageName || undefined,
    category: input.category,
    launcherMode: input.launcherMode,
    sdkVersion: appCenterManifestString(input.manifest, 'sdkVersion') || previous?.sdkVersion,
    appVersion: appCenterManifestString(input.manifest, 'appVersion') || previous?.appVersion || input.version,
    sdkAbiVersion,
    protocolVersion,
    runtimeContractVersion,
    requiredCapabilities: input.requiredCapabilities,
    network: {
      scope: networkScope,
      serviceVip
    },
    ...(input.launcherMode === 'standalone'
      ? {
          standalone: {
            ownsNetwork: true as const,
            brokerEnabled: true
          }
        }
      : {
          embed: {
            standaloneChannelProductId: input.standaloneChannelProductId || MX_H2I_PRODUCT_ID,
            launchWithoutBroker: previous?.embed?.launchWithoutBroker === 'prompt-open-standalone'
              || appCenterManifestNestedString(input.manifest, 'embed', 'launchWithoutBroker') === 'prompt-open-standalone'
              ? 'prompt-open-standalone' as const
              : 'blocked' as const
          }
        })
  };
}

export function buildAppCenterApp(
  input: AppCenterAppInput,
  previous: AppCenterApp | null = null
): AppCenterApp {
  const rawManifest = appCenterManifestRecord(input.manifest);
  const appId = safeIdPart(String(input.appId || appCenterManifestString(rawManifest, 'appId') || previous?.appId || 'app').trim()).toLowerCase();
  const launcherMode = launcherProductMode(input.launcherMode ?? appCenterManifestString(rawManifest, 'launcherMode') ?? previous?.launcherMode ?? (appId === MX_H2I_PRODUCT_ID ? 'standalone' : 'embed'));
  const productNetworkId = normalizeLauncherNetworkProductId(input.productNetworkId || previous?.productNetworkId || appId);
  const standaloneChannelProductId = launcherMode === 'standalone'
    ? productNetworkId
    : launcherNetworkLeaseProductId(
      input.standaloneChannelProductId
      || appCenterManifestNestedString(rawManifest, 'embed', 'standaloneChannelProductId')
      || appCenterManifestString(rawManifest, 'standaloneChannelProductId')
      || previous?.standaloneChannelProductId
      || MX_H2I_PRODUCT_ID
    );
  const builtin = typeof input.builtin === 'boolean' ? input.builtin : previous?.builtin ?? false;
  const displayName = input.displayName?.trim()
    || appCenterManifestString(rawManifest, 'displayName')
    || previous?.displayName
    || launcherProductDisplayName(appId);
  const fullName = input.fullName?.trim()
    || appCenterManifestString(rawManifest, 'fullName')
    || previous?.fullName
    || null;
  const packageName = input.packageName?.trim()
    || appCenterManifestString(rawManifest, 'packageName')
    || previous?.packageName
    || defaultAppPackageName(appId);
  const version = input.version?.trim()
    || appCenterManifestString(rawManifest, 'appVersion')
    || previous?.version
    || '0.1.0';
  const category = input.category?.trim()
    || appCenterManifestString(rawManifest, 'category')
    || previous?.category
    || 'custom';
  const description = input.description?.trim()
    || appCenterManifestString(rawManifest, 'description')
    || previous?.description
    || 'Launcher powered application.';
  const permissions = appCenterStringList(input.permissions, previous?.permissions ?? ['auth.read']);
  const requiredCapabilities = appCenterStringList(
    input.requiredCapabilities,
    previous?.requiredCapabilities ?? (launcherMode === 'standalone'
      ? ['launcher-network', 'launcher-standalone']
      : ['launcher-network', 'launcher-embed-sdk'])
  );
  const runtimeContractVersion = input.runtimeContractVersion?.trim()
    || appCenterManifestString(rawManifest, 'runtimeContractVersion')
    || previous?.runtimeContractVersion
    || (launcherMode === 'embed' ? APP_CENTER_RUNTIME_CONTRACT_VERSION : null);
  const manifest = buildAppCenterManifest({
    appId,
    productId: productNetworkId,
    displayName,
    fullName,
    packageName,
    version,
    category,
    description,
    launcherMode,
    standaloneChannelProductId,
    requiredCapabilities,
    runtimeContractVersion,
    manifest: rawManifest,
    previous: previous?.manifest
  });
  return {
    appId,
    displayName,
    fullName,
    builtin,
    systemOwned: typeof input.systemOwned === 'boolean' ? input.systemOwned : previous?.systemOwned ?? builtin,
    packageName,
    version,
    category,
    description,
    launcherMode,
    standaloneChannelProductId,
    productNetworkId,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : previous?.enabled ?? true,
    channels: appCenterStringList(input.channels, previous?.channels ?? ['shadow', 'beta', 'stable']),
    permissions,
    requiredCapabilities,
    runtimeContractVersion,
    manifest,
    accessPolicy: normalizeAppCenterAccessPolicy(appId, launcherMode, input.accessPolicy, previous?.accessPolicy),
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

export function buildAppCenterInstallation(
  input: AppCenterInstallationInput,
  app: AppCenterApp | null,
  previous: AppCenterInstallation | null = null,
  now = new Date().toISOString()
): AppCenterInstallation {
  const appId = normalizeOptionalAppId(input.appId) || app?.appId || previous?.appId || 'app';
  const installId = nullableTrimmed(input.installId) ?? previous?.installId ?? null;
  const deviceId = nullableTrimmed(input.deviceId) ?? previous?.deviceId ?? null;
  const userId = nullableTrimmed(input.userId) ?? previous?.userId ?? null;
  const sourceAppId = normalizeOptionalAppId(input.sourceAppId) ?? previous?.sourceAppId ?? null;
  const scopeId = installId || deviceId || userId || sourceAppId || 'global';
  const installationId = previous?.installationId || `appinst_${safeIdPart(appId).toLowerCase()}_${safeIdPart(scopeId).toLowerCase()}`;
  const manifest = appCenterInstallationManifest(input.manifest, app, previous);
  const status = appCenterInstallationStatus(
    input.status,
    previous?.status ?? (input.installedVersion ? 'installed' : 'not-installed')
  );
  return {
    installationId,
    appId,
    installId,
    deviceId,
    userId,
    sourceAppId,
    packageName: nullableTrimmed(input.packageName) || app?.packageName || previous?.packageName || null,
    installedVersion: nullableTrimmed(input.installedVersion) ?? previous?.installedVersion ?? null,
    latestVersion: nullableTrimmed(input.latestVersion) || app?.version || previous?.latestVersion || null,
    status,
    runtimeState: nullableTrimmed(input.runtimeState) ?? previous?.runtimeState ?? null,
    installSource: nullableTrimmed(input.installSource) ?? previous?.installSource ?? null,
    installPath: nullableTrimmed(input.installPath) ?? previous?.installPath ?? null,
    manifest,
    manifestDigest: nullableTrimmed(input.manifestDigest) ?? previous?.manifestDigest ?? (manifest ? shortDigest(JSON.stringify(manifest)) : null),
    installedAt: nullableTrimmed(input.installedAt) ?? previous?.installedAt ?? null,
    lastSeenAt: nullableTrimmed(input.lastSeenAt) || now,
    errorMessage: nullableTrimmed(input.errorMessage) ?? previous?.errorMessage ?? null,
    metadata: {
      ...(previous?.metadata ?? {}),
      ...recordValue(input.metadata)
    },
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
}

export function appCenterInstallationMatchesQuery(
  installation: AppCenterInstallation,
  input: AppCenterInstallationQuery = {}
): boolean {
  const appId = normalizeOptionalAppId(input.appId);
  if (appId && installation.appId !== appId) return false;
  const sourceAppId = normalizeOptionalAppId(input.sourceAppId);
  if (sourceAppId && installation.sourceAppId !== sourceAppId) return false;
  const installId = nullableTrimmed(input.installId);
  if (installId && installation.installId !== installId) return false;
  const deviceId = nullableTrimmed(input.deviceId);
  if (deviceId && installation.deviceId !== deviceId) return false;
  const userId = nullableTrimmed(input.userId);
  if (userId && installation.userId !== userId) return false;
  const packageName = nullableTrimmed(input.packageName);
  if (packageName && installation.packageName !== packageName) return false;
  return true;
}

function appCenterInstallationManifest(
  input: AppCenterInstallationInput['manifest'],
  app: AppCenterApp | null,
  previous: AppCenterInstallation | null
): AppCenterAppManifest | Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) return { ...input } as Record<string, unknown>;
  if (app?.manifest) return app.manifest;
  return previous?.manifest ?? null;
}

function appCenterInstallationStatus(
  value: AppCenterInstallationInput['status'],
  fallback: AppCenterInstallationStatus
): AppCenterInstallationStatus {
  switch (String(value || '').trim()) {
    case 'available':
    case 'not-installed':
    case 'installing':
    case 'installed':
    case 'enabled':
    case 'ready':
    case 'running':
    case 'error':
    case 'disabled':
      return String(value).trim() as AppCenterInstallationStatus;
    default:
      return fallback;
  }
}

function normalizeAppCenterAccessPolicy(
  appId: string,
  launcherMode: LauncherProductMode,
  input: Partial<AppCenterAccessPolicy> | null | undefined,
  previous: AppCenterAccessPolicy | null | undefined
): AppCenterAccessPolicy {
  const defaultDecision = accessDefaultDecision(input?.defaultDecision ?? previous?.defaultDecision)
    ?? defaultAppAccessDecision(appId, launcherMode);
  return {
    defaultDecision,
    allowAdmin: typeof input?.allowAdmin === 'boolean' ? input.allowAdmin : previous?.allowAdmin ?? true,
    allowRoles: uniqueStrings([...(previous?.allowRoles ?? []), ...appIdPolicyList(input?.allowRoles)]),
    allowUserIds: uniqueStrings([...(previous?.allowUserIds ?? []), ...appIdPolicyList(input?.allowUserIds)]),
    allowOrgIds: uniqueStrings([...(previous?.allowOrgIds ?? []), ...appIdPolicyList(input?.allowOrgIds)]),
    allowRegisteredByAppIds: uniqueAppIds([
      ...(previous?.allowRegisteredByAppIds ?? []),
      ...appIdPolicyList(input?.allowRegisteredByAppIds)
    ]),
    allowHomeAppIds: uniqueAppIds([
      ...(previous?.allowHomeAppIds ?? []),
      ...appIdPolicyList(input?.allowHomeAppIds)
    ]),
    requirePermissionGrant: typeof input?.requirePermissionGrant === 'boolean'
      ? input.requirePermissionGrant
      : previous?.requirePermissionGrant ?? defaultDecision === 'private'
  };
}

function accessDefaultDecision(value: unknown): AppCenterAccessPolicy['defaultDecision'] | null {
  return value === 'public' || value === 'authenticated' || value === 'private' ? value : null;
}

function defaultAppAccessDecision(appId: string, launcherMode: LauncherProductMode): AppCenterAccessPolicy['defaultDecision'] {
  if (appId === MX_H2I_PRODUCT_ID || appId === APP_CENTER_PRODUCT_ID) return 'public';
  if (appId === 'h2o') return 'private';
  return launcherMode === 'standalone' ? 'private' : 'private';
}

function appIdPolicyList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : typeof value === 'string'
      ? value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)
      : [];
}

export function evaluateAppCenterAccess(
  app: AppCenterApp | null,
  input: AppCenterAccessInput,
  principal: PlatformPrincipal | null,
  user: UserCenterUser | null,
  grants: PermissionGrant[] = []
): AppCenterAccessDecision {
  const appId = app?.appId ?? normalizeOptionalAppId(input.appId) ?? 'unknown';
  const policy = app?.accessPolicy ?? normalizeAppCenterAccessPolicy(appId, 'embed', null, null);
  if (!app) {
    return appAccessDecision(appId, policy, principal, false, false, 'app is not registered', [], ['app-center-app']);
  }
  if (app.enabled === false && input.includeDisabled !== true) {
    return appAccessDecision(appId, policy, principal, false, false, 'app is disabled', [], ['enabled-app']);
  }
  if (policy.allowAdmin !== false && principal?.roles.includes('mx-admin')) {
    return appAccessDecision(appId, policy, principal, true, true, 'admin role can access all applications', ['role:mx-admin'], []);
  }
  const userAppAccess = user?.appAccess ?? emptyUserAppAccess();
  if (userAppAccess.deniedAppIds.includes(appId)) {
    return appAccessDecision(appId, policy, principal, false, false, 'user is explicitly denied for this application', [], [`user-deny:${appId}`]);
  }
  if (policy.defaultDecision === 'public') {
    return appAccessDecision(appId, policy, principal, true, true, 'application is public', ['policy:public'], []);
  }
  if (!principal || principal.kind === 'unknown' || principal.kind === 'anonymous') {
    return appAccessDecision(appId, policy, principal, false, false, 'application requires an authenticated user', [], ['authenticated-user']);
  }
  const matched = [
    ...principal.roles.filter((roleId) => policy.allowRoles.includes(roleId)).map((roleId) => `role:${roleId}`),
    ...principal.orgIds.filter((orgId) => policy.allowOrgIds.includes(orgId)).map((orgId) => `org:${orgId}`),
    ...(principal.userId && policy.allowUserIds.includes(principal.userId) ? [`user:${principal.userId}`] : []),
    ...(userAppAccess.allowedAppIds.includes(appId) ? [`user-app:${appId}`] : []),
    ...(userAppAccess.homeAppId && policy.allowHomeAppIds.includes(userAppAccess.homeAppId) ? [`home-app:${userAppAccess.homeAppId}`] : []),
    ...(userAppAccess.registeredByAppId && policy.allowRegisteredByAppIds.includes(userAppAccess.registeredByAppId)
      ? [`registered-by:${userAppAccess.registeredByAppId}`]
      : []),
    ...(input.sourceAppId && policy.allowRegisteredByAppIds.includes(input.sourceAppId) ? [`source-app:${input.sourceAppId}`] : [])
  ];
  const grantMatched = policy.requirePermissionGrant && grants.some((grant) => (
    grant.appId === appId
    && grant.userId === principal.userId
    && (grant.decision === 'granted' || grant.decision === 'partial')
    && grant.allowedScopes.length > 0
  ));
  if (grantMatched) matched.push(`permission-grant:${appId}`);
  if (policy.defaultDecision === 'authenticated' || matched.length > 0) {
    return appAccessDecision(
      appId,
      policy,
      principal,
      true,
      true,
      matched.length ? 'principal matched application access policy' : 'authenticated users may access this application',
      matched.length ? matched : ['policy:authenticated'],
      []
    );
  }
  return appAccessDecision(
    appId,
    policy,
    principal,
    false,
    input.includeHidden === true,
    'application is private and no user/app grant matched',
    [],
    ['app-access-grant']
  );
}

function appAccessDecision(
  appId: string,
  policy: AppCenterAccessPolicy,
  principal: PlatformPrincipal | null,
  allowed: boolean,
  visible: boolean,
  reason: string,
  matched: string[],
  missing: string[]
): AppCenterAccessDecision {
  return { appId, allowed, visible, reason, matched, missing, principal, policy };
}

export function buildAppOnboardingTemplates(): AppOnboardingTemplate[] {
  return [
    {
      templateId: 'standalone-service',
      label: 'Standalone business app',
      detail: 'Create an independent Launcher channel, ProductNetwork, DNS route, and gateway upstream.',
      launcherMode: 'standalone',
      category: 'custom',
      dnsRouteEnabled: true
    },
    {
      templateId: 'luopan',
      label: 'Luopan',
      detail: 'Luopan AI intelligence system; defaults to an independent product network and luopan domain entry.',
      appId: 'luopan',
      displayName: 'Luopan',
      category: 'custom',
      description: '罗盘AI情报系统',
      launcherMode: 'standalone',
      dnsRouteEnabled: true
    },
    {
      templateId: 'embed-runtime',
      label: 'Embed runtime app',
      detail: 'Reuse the selected MX-H2I standalone channel without another local TUN/WG/DNS owner.',
      launcherMode: 'embed',
      category: 'platform',
      dnsRouteEnabled: true
    },
    {
      templateId: 'custom',
      label: 'Custom / imported manifest',
      detail: 'Keep caller supplied fields; suitable for SDK manifest or k8s admin backfill.',
      dnsRouteEnabled: false
    }
  ];
}

export function buildAppOnboardingDefaults(
  config: RuntimeConfig,
  input: AppOnboardingDefaultsInput,
  products: LauncherProductNetwork[] = [],
  routes: DnsReverseProxyRoute[] = []
): AppOnboardingDefaults {
  const manifest = appCenterManifestRecord(input.manifest);
  const template = buildAppOnboardingTemplates().find((item) => item.templateId === (input.templateId?.trim() || manifestString(manifest, 'templateId')))
    ?? buildAppOnboardingTemplates()[0];
  const appId = safeIdPart(input.appId?.trim()
    || manifestString(manifest, 'appId')
    || manifestString(manifest, 'productId')
    || template.appId
    || 'app').toLowerCase();
  const launcherMode = launcherProductMode(input.launcherMode ?? manifestString(manifest, 'launcherMode') ?? template.launcherMode ?? 'standalone');
  const displayName = input.displayName?.trim()
    || manifestString(manifest, 'displayName')
    || manifestString(manifest, 'name')
    || template.displayName
    || launcherProductDisplayName(appId);
  const packageName = input.packageName?.trim()
    || manifestString(manifest, 'packageName')
    || manifestString(manifest, 'npm')
    || defaultAppPackageName(appId);
  const category = input.category?.trim() || manifestString(manifest, 'category') || template.category || 'custom';
  const description = input.description?.trim()
    || manifestString(manifest, 'description')
    || template.description
    || (launcherMode === 'standalone'
      ? `${displayName} owns a Launcher standalone channel and can receive Internal network leases.`
      : `${displayName} runs through the MX-H2I Launcher channel without owning another local tunnel.`);
  const standaloneChannelProductId = launcherMode === 'standalone'
    ? appId
    : launcherNetworkLeaseProductId(input.standaloneChannelProductId || manifestString(manifest, 'standaloneChannelProductId') || MX_H2I_PRODUCT_ID);
  const previousProduct = products.find((product) => product.productId === appId) ?? null;
  const productIndex = previousProduct?.productIndex ?? nextAppOnboardingProductIndex(products, appId, launcherMode);
  const productNetwork = buildLauncherProductNetwork(config, {
    productId: appId,
    displayName,
    mode: launcherMode,
    networkScope: launcherMode === 'standalone' ? 'owner' : 'broker-session',
    standaloneChannelProductId,
    productIndex,
    updatePolicy: launcherMode === 'standalone' ? 'app-managed' : 'launcher-managed',
    requestedBy: input.requestedBy || 'app-onboarding-defaults'
  }, previousProduct);
  const dnsHost = normalizeDomain(input.dnsHost?.trim() || manifestString(manifest, 'dnsHost') || `${appId}.${MX_DEFAULT_APP_DNS_ZONE}`);
  const existingRoute = routes.find((route) => normalizeDomain(route.host) === dnsHost || route.routeId === `rp_${dnsHost}`) ?? null;
  const capabilities = appOnboardingCapabilities(appId, launcherMode, category);
  const permissions = appOnboardingPermissions(launcherMode, category);
  const appUpdatePolicy: AppOnboardingDefaults['app']['updatePolicy'] = appId === MX_H2I_PRODUCT_ID || launcherMode === 'embed'
    ? 'platform-ui'
    : 'app-managed';
  const runtimeContractVersion = launcherMode === 'embed'
    ? appCenterManifestString(manifest, 'runtimeContractVersion') || APP_CENTER_RUNTIME_CONTRACT_VERSION
    : null;
  const appManifest = buildAppCenterManifest({
    appId,
    productId: appId,
    displayName,
    fullName: appCenterManifestString(manifest, 'fullName'),
    packageName,
    version: '0.1.0',
    category,
    description,
    launcherMode,
    standaloneChannelProductId,
    requiredCapabilities: capabilities,
    runtimeContractVersion,
    manifest,
    previous: null
  });
  const dnsRoute = {
    routeId: existingRoute?.routeId || `rp_${dnsHost}`,
    host: existingRoute?.host || dnsHost,
    dnsTarget: existingRoute?.dnsTarget || productNetwork.internalControlIp,
    targetUrl: existingRoute?.targetUrl || input.targetUrl?.trim() || manifestString(manifest, 'targetUrl') || manifestString(manifest, 'upstreamUrl') || 'http://127.0.0.1:8080',
    enabled: true,
    tlsMode: existingRoute?.tlsMode || 'internal',
    authRequired: existingRoute?.authRequired ?? true,
    requestedBy: input.requestedBy || 'app-onboarding-defaults'
  };
  return {
    template,
    app: {
      appId,
      displayName,
      category,
      description,
      packageName,
      launcherMode,
      standaloneChannelProductId,
      productNetworkId: appId,
      enabled: true,
      channels: ['shadow', 'beta', 'stable'],
      permissions,
      requiredCapabilities: capabilities,
      runtimeContractVersion,
      manifest: appManifest,
      updatePolicy: appUpdatePolicy,
      entrypoints: {
        desktop: `app://${appId}/index.html`,
        settings: `app://${appId}/settings.html`
      },
      protocol: {
        appCenter: '1.0',
        launcher: '1.0'
      },
      requestedBy: input.requestedBy || 'app-onboarding-defaults'
    },
    productNetwork: {
      productId: productNetwork.productId,
      displayName: productNetwork.displayName,
      mode: productNetwork.mode,
      networkScope: productNetwork.networkScope,
      standaloneChannelProductId: productNetwork.standaloneChannelProductId,
      productIndex: productNetwork.productIndex,
      internalControlIp: productNetwork.internalControlIp,
      domesticGatewayIp: productNetwork.domesticGatewayIp,
      dnsServer: productNetwork.dnsServer,
      serviceVip: productNetwork.serviceVip,
      userCidr: productNetwork.userCidr,
      feishuCidr: productNetwork.feishuCidr,
      anonymousCidr: productNetwork.anonymousCidr,
      userLeaseStart: productNetwork.userLeaseStart,
      userLeaseEnd: productNetwork.userLeaseEnd,
      feishuLeaseStart: productNetwork.feishuLeaseStart,
      feishuLeaseEnd: productNetwork.feishuLeaseEnd,
      anonymousLeaseStart: productNetwork.anonymousLeaseStart,
      anonymousLeaseEnd: productNetwork.anonymousLeaseEnd,
      defaultDomesticSiteId: productNetwork.defaultDomesticSiteId,
      defaultOverseaSiteId: productNetwork.defaultOverseaSiteId,
      updatePolicy: productNetwork.updatePolicy,
      rateLimitProfile: productNetwork.rateLimitProfile,
      dnsPolicyId: productNetwork.dnsPolicyId,
      licensePolicyId: productNetwork.licensePolicyId,
      enabled: productNetwork.enabled,
      requestedBy: input.requestedBy || 'app-onboarding-defaults'
    },
    dnsRoute,
    operatorSteps: [
      {
        stepId: 'app-center',
        label: 'Register AppCenter app',
        detail: 'Writes app identity, Launcher mode, capabilities, permissions, and release defaults.',
        writesTo: 'app-center-app'
      },
      {
        stepId: 'product-network',
        label: launcherMode === 'standalone' ? 'Create ProductNetwork' : 'Bind standalone channel',
        detail: launcherMode === 'standalone'
          ? 'Allocates service VIP and client lease ranges for this app.'
          : 'Reuses the selected standalone channel without a new local network owner.',
        writesTo: 'launcher-product-network'
      },
      {
        stepId: 'dns-route',
        label: 'Create DNS route',
        detail: 'Writes CoreDNS target and Internal gateway upstream for the app domain.',
        writesTo: 'dns-reverse-proxy-route'
      }
    ]
  };
}

function nextAppOnboardingProductIndex(
  products: LauncherProductNetwork[],
  productId: string,
  launcherMode: LauncherProductMode
): number {
  if (launcherMode !== 'standalone') return Math.max(0, products.filter((product) => product.mode === 'embed').length);
  if (launcherNetworkProductIsStandaloneDefault(productId)) return 0;
  const used = new Set(products
    .filter((product) => product.mode === 'standalone')
    .filter((product) => product.productId !== productId)
    .filter((product) => !launcherNetworkProductIsStandaloneDefault(product.productId))
    .map((product) => product.productIndex)
    .filter((index) => Number.isInteger(index) && index > 0));
  for (let candidate = 1; candidate <= 164; candidate += 1) {
    if (!used.has(candidate)) return candidate;
  }
  return 1;
}

function appOnboardingCapabilities(appId: string, launcherMode: LauncherProductMode, category: string): string[] {
  const capabilities = launcherMode === 'standalone'
    ? ['launcher-network', 'launcher-standalone']
    : ['launcher-network', 'launcher-embed-sdk'];
  if (launcherMode === 'standalone' && (category === 'vpn' || appId === MX_H2I_PRODUCT_ID)) capabilities.push('wireguard-peer');
  if (category === 'platform' || category === 'network' || appId === APP_CENTER_PRODUCT_ID) capabilities.push('app-center-runtime');
  return [...new Set(capabilities)];
}

function appOnboardingPermissions(launcherMode: LauncherProductMode, category: string): string[] {
  const permissions = ['auth.read'];
  if (launcherMode === 'standalone') {
    permissions.push('network.tun.request', 'network.dns.policy', 'observability.write');
    if (category === 'vpn') permissions.push('network.wg.peer');
  } else {
    permissions.push('appcenter.read', 'permission.request', 'observability.write');
    if (category === 'network') permissions.push('network.dns.policy');
  }
  return [...new Set(permissions)];
}

function manifestString(manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
      packageName: '@qpjoy/mx-h2i-demo',
      version: '0.1.0',
      category: 'vpn',
      description: 'VPN product that owns the Launcher standalone channel and peer leases.',
      launcherMode: 'standalone',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: MX_H2I_PRODUCT_ID,
      permissions: ['auth.read', 'network.tun.request', 'network.wg.peer', 'network.dns.policy', 'observability.write'],
      requiredCapabilities: ['launcher-network', 'launcher-standalone', 'wireguard-peer'],
      accessPolicy: {
        defaultDecision: 'public',
        allowAdmin: true,
        allowRoles: [],
        allowUserIds: [],
        allowOrgIds: [],
        allowRegisteredByAppIds: [],
        allowHomeAppIds: [],
        requirePermissionGrant: false
      },
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
      packageName: '@qpjoy/electron-launcher-appcenter',
      version: '0.1.0',
      category: 'platform',
      description: 'Application catalog and runtime access surface, embedded through MX-H2I launcher channel.',
      launcherMode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: APP_CENTER_PRODUCT_ID,
      permissions: ['auth.read', 'appcenter.read', 'permission.request', 'observability.write'],
      requiredCapabilities: ['app-center-runtime', 'launcher-embed-sdk'],
      accessPolicy: {
        defaultDecision: 'public',
        allowAdmin: true,
        allowRoles: [],
        allowUserIds: [],
        allowOrgIds: [],
        allowRegisteredByAppIds: [MX_H2I_PRODUCT_ID],
        allowHomeAppIds: [MX_H2I_PRODUCT_ID],
        requirePermissionGrant: false
      },
      updatePolicy: 'platform-ui',
      entrypoints: {
        desktop: 'app://appcenter/index.html',
        settings: 'app://appcenter/settings.html'
      }
    }),
    buildAppCenterApp({
      appId: 'h2o',
      displayName: 'H2O',
      fullName: 'Home To Oversea',
      builtin: true,
      systemOwned: true,
      packageName: '@qpjoy/electron-launcher-app-h2o',
      version: '0.1.0',
      category: 'network',
      description: 'AppCenter built-in Home To Oversea network plugin for proxy mode, PAC, Split DNS, and Internal/oversea status.',
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
      requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime'],
      runtimeContractVersion: APP_CENTER_RUNTIME_CONTRACT_VERSION,
      accessPolicy: {
        defaultDecision: 'private',
        allowAdmin: true,
        allowRoles: [],
        allowUserIds: [],
        allowOrgIds: [],
        allowRegisteredByAppIds: [MX_H2I_PRODUCT_ID],
        allowHomeAppIds: [MX_H2I_PRODUCT_ID],
        requirePermissionGrant: true
      },
      updatePolicy: 'app-managed',
      entrypoints: {
        desktop: 'app://h2o/index.html',
        settings: 'app://h2o/settings.html'
      }
    }),
    buildAppCenterApp({
      appId: MX_INSIGHT_HUB_APP_ID,
      displayName: 'MX Insight Hub',
      fullName: 'MX Insight Hub Data API Control Plane',
      builtin: true,
      systemOwned: true,
      packageName: '@qpjoy/mx-insight-hub',
      version: '0.1.0',
      category: 'data-intelligence',
      description: 'Governed data API, tenant, API key, quota, usage, and Data Agent control plane.',
      launcherMode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: MX_INSIGHT_HUB_APP_ID,
      permissions: ['auth.read', 'appcenter.read', 'permission.request', 'observability.write'],
      requiredCapabilities: ['launcher-embed-sdk', 'app-center-runtime', 'data-api-gateway'],
      runtimeContractVersion: APP_CENTER_RUNTIME_CONTRACT_VERSION,
      accessPolicy: {
        defaultDecision: 'private',
        allowAdmin: true,
        allowRoles: ['admin'],
        allowUserIds: [],
        allowOrgIds: [],
        allowRegisteredByAppIds: [MX_H2I_PRODUCT_ID],
        allowHomeAppIds: [MX_H2I_PRODUCT_ID],
        requirePermissionGrant: true
      },
      updatePolicy: 'app-managed',
      entrypoints: insightHubAdminEntrypoints()
    }),
    buildAppCenterApp({
      appId: 'luopan',
      displayName: 'Luopan',
      fullName: 'Luopan AI Intelligence Console',
      builtin: true,
      systemOwned: true,
      packageName: '@qpjoy/luopan-demo',
      version: '0.1.0',
      category: 'intelligence',
      description: 'Standalone Luopan launcher demo for Internal, User Center, Release Center, and Home To Oversea validation.',
      launcherMode: 'standalone',
      standaloneChannelProductId: 'luopan',
      productNetworkId: 'luopan',
      permissions: [
        'auth.read',
        'network.tun.request',
        'network.wg.peer',
        'network.proxy.app',
        'network.dns.policy',
        'observability.write'
      ],
      requiredCapabilities: ['launcher-network', 'launcher-standalone', 'wireguard-peer'],
      accessPolicy: {
        defaultDecision: 'public',
        allowAdmin: true,
        allowRoles: [],
        allowUserIds: [],
        allowOrgIds: [],
        allowRegisteredByAppIds: [],
        allowHomeAppIds: [],
        requirePermissionGrant: false
      },
      updatePolicy: 'launcher-managed',
      entrypoints: {
        desktop: 'app://luopan/index.html',
        settings: 'app://luopan/settings.html'
      }
    })
  ];
}

function insightHubAdminEntrypoints(): Record<string, string> {
  const raw = process.env.MX_INSIGHT_HUB_ADMIN_ENTRYPOINT?.trim();
  if (!raw) return {};
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return {};
    return { admin: url.href };
  } catch {
    return {};
  }
}

export function builtinLauncherProductNetworks(config: RuntimeConfig): LauncherProductNetwork[] {
  const now = new Date().toISOString();
  return [
    buildLauncherProductNetwork(config, {
      productId: MX_H2I_PRODUCT_ID,
      displayName: 'MX-H2I',
      mode: 'standalone',
      networkScope: 'owner',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productIndex: 0,
      serviceVip: '10.88.100.1',
      userCidr: '10.89.0.0/16',
      feishuCidr: '10.89.0.0/16',
      anonymousCidr: '10.89.0.0/16',
      userLeaseStart: '10.89.0.1',
      userLeaseEnd: '10.89.49.254',
      feishuLeaseStart: '10.89.50.1',
      feishuLeaseEnd: '10.89.99.254',
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
      networkScope: 'broker-session',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productIndex: 1,
      serviceVip: '10.88.100.9',
      userCidr: '10.92.0.0/16',
      feishuCidr: '10.92.0.0/16',
      anonymousCidr: '10.92.0.0/16',
      userLeaseStart: '10.92.0.1',
      userLeaseEnd: '10.92.49.254',
      feishuLeaseStart: '10.92.50.1',
      feishuLeaseEnd: '10.92.99.254',
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
      networkScope: 'broker-session',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productIndex: 2,
      serviceVip: '10.88.100.10',
      userCidr: '10.90.0.0/16',
      feishuCidr: '10.90.0.0/16',
      anonymousCidr: '10.90.0.0/16',
      userLeaseStart: '10.90.0.1',
      userLeaseEnd: '10.90.49.254',
      feishuLeaseStart: '10.90.50.1',
      feishuLeaseEnd: '10.90.99.254',
      anonymousLeaseStart: '10.90.100.1',
      anonymousLeaseEnd: '10.90.254.254',
      updatePolicy: 'launcher-managed',
      rateLimitProfile: 'product-default',
      dnsPolicyId: 'internal-default',
      licensePolicyId: 'h2o-default',
      requestedBy: 'builtin'
    }, null, now),
    buildLauncherProductNetwork(config, {
      productId: 'luopan',
      displayName: 'Luopan',
      mode: 'standalone',
      networkScope: 'owner',
      standaloneChannelProductId: 'luopan',
      productIndex: 3,
      serviceVip: '10.88.100.3',
      userCidr: '10.91.0.0/16',
      feishuCidr: '10.91.0.0/16',
      anonymousCidr: '10.91.0.0/16',
      userLeaseStart: '10.91.0.1',
      userLeaseEnd: '10.91.49.254',
      feishuLeaseStart: '10.91.50.1',
      feishuLeaseEnd: '10.91.99.254',
      anonymousLeaseStart: '10.91.100.1',
      anonymousLeaseEnd: '10.91.254.254',
      updatePolicy: 'launcher-managed',
      rateLimitProfile: 'standalone-default',
      dnsPolicyId: 'internal-default',
      licensePolicyId: 'appcenter-default',
      requestedBy: 'builtin'
    }, null, now)
  ];
}

function previousLauncherFeishuPoolFallback(
  previous: LauncherProductNetwork | null
): {
  userCidr: string;
  feishuCidr: string;
  userLeaseStart: string;
  userLeaseEnd: string;
  feishuLeaseStart: string;
  feishuLeaseEnd: string;
} | null {
  if (!previous) return null;
  if (previous.feishuLeaseStart && previous.feishuLeaseEnd) {
    const previousRanges = {
      userLeaseStart: previous.userLeaseStart,
      userLeaseEnd: previous.userLeaseEnd,
      feishuLeaseStart: previous.feishuLeaseStart,
      feishuLeaseEnd: previous.feishuLeaseEnd,
      anonymousLeaseStart: previous.anonymousLeaseStart,
      anonymousLeaseEnd: previous.anonymousLeaseEnd
    };
    try {
      assertDisjointLauncherLeaseRanges(previousRanges);
      return {
        userCidr: previous.userCidr,
        feishuCidr: previous.feishuCidr || previous.userCidr,
        userLeaseStart: previous.userLeaseStart,
        userLeaseEnd: previous.userLeaseEnd,
        feishuLeaseStart: previous.feishuLeaseStart,
        feishuLeaseEnd: previous.feishuLeaseEnd
      };
    } catch {
      // A partially written Feishu pool may still overlap the legacy employee pool.
    }
  }
  const userStart = ipv4ToNumber(previous.userLeaseStart);
  const userEnd = ipv4ToNumber(previous.userLeaseEnd);
  const anonymousStart = ipv4ToNumber(previous.anonymousLeaseStart);
  const userCidrBounds = ipv4CidrBounds(previous.userCidr);
  if (
    userStart == null
    || userEnd == null
    || anonymousStart == null
    || !userCidrBounds
    || userStart < userCidrBounds.start
    || userEnd > userCidrBounds.end
    || Math.floor(userStart / 65536) !== Math.floor(userEnd / 65536)
    || (userStart & 255) !== 1
    || (userEnd & 255) !== 254
  ) {
    return null;
  }
  const firstThirdOctet = (userStart >>> 8) & 255;
  const lastThirdOctet = (userEnd >>> 8) & 255;
  const blockCount = lastThirdOctet - firstThirdOctet + 1;
  if (blockCount < 2) return null;
  const feishuFirstThirdOctet = firstThirdOctet + Math.floor(blockCount / 2);
  const prefix = Math.floor(userStart / 65536) * 65536;
  const migratedRanges = {
    userLeaseStart: previous.userLeaseStart,
    userLeaseEnd: numberToIpv4(prefix + ((feishuFirstThirdOctet - 1) * 256) + 254),
    feishuLeaseStart: numberToIpv4(prefix + (feishuFirstThirdOctet * 256) + 1),
    feishuLeaseEnd: previous.userLeaseEnd,
    anonymousLeaseStart: previous.anonymousLeaseStart,
    anonymousLeaseEnd: previous.anonymousLeaseEnd
  };
  try {
    assertDisjointLauncherLeaseRanges(migratedRanges);
  } catch {
    return null;
  }
  return {
    userCidr: previous.userCidr,
    feishuCidr: previous.userCidr,
    userLeaseStart: migratedRanges.userLeaseStart,
    userLeaseEnd: migratedRanges.userLeaseEnd,
    feishuLeaseStart: migratedRanges.feishuLeaseStart,
    feishuLeaseEnd: migratedRanges.feishuLeaseEnd
  };
}

export function buildLauncherProductNetwork(
  config: RuntimeConfig,
  input: LauncherProductNetworkInput,
  previous: LauncherProductNetwork | null,
  now = new Date().toISOString()
): LauncherProductNetwork {
  const productId = normalizeLauncherNetworkProductId(input.productId?.trim() || previous?.productId);
  const mode = launcherProductMode(input.mode ?? previous?.mode ?? (launcherNetworkProductIsStandaloneDefault(productId) ? 'standalone' : 'embed'));
  const networkScope = launcherNetworkScope(input.networkScope ?? previous?.networkScope, mode);
  const productIndex = Number.isFinite(input.productIndex ?? NaN)
    ? Math.max(0, Math.floor(Number(input.productIndex)))
    : previous?.productIndex ?? (mode === 'standalone' ? 0 : 0);
  const defaults = defaultLauncherProductNetworkShape(productId, mode, productIndex);
  const rawStandaloneChannel = mode === 'standalone'
    ? productId
    : input.standaloneChannelProductId?.trim() || previous?.standaloneChannelProductId || MX_H2I_PRODUCT_ID;
  const standaloneChannelProductId = launcherNetworkLeaseProductId(rawStandaloneChannel || (mode === 'standalone' ? productId : MX_H2I_PRODUCT_ID));
  const updatedBy = input.requestedBy?.trim() || 'config-center';
  const serviceVip = validIpv4OrFallback(input.serviceVip, previous?.serviceVip || defaults.serviceVip);
  const legacyFoundation = launcherNetworkProductUsesLegacyFoundation(productId);
  const inputInternalControlIp = legacyFoundation ? null : input.internalControlIp;
  const inputDomesticGatewayIp = legacyFoundation ? null : input.domesticGatewayIp;
  const inputDnsServer = legacyFoundation ? null : input.dnsServer;
  const previousInternalControlIp = legacyFoundation ? null : previous?.internalControlIp;
  const previousDomesticGatewayIp = legacyFoundation ? null : previous?.domesticGatewayIp;
  const previousDnsServer = legacyFoundation ? null : previous?.dnsServer;
  const internalControlFallback = legacyFoundation ? defaults.internalControlIp || serviceVip : serviceVip;
  const domesticGatewayFallback = legacyFoundation ? defaults.domesticGatewayIp || internalControlFallback : internalControlFallback;
  const dnsServerFallback = legacyFoundation ? defaults.dnsServer || internalControlFallback : internalControlFallback;
  const internalControlIp = validIpv4OrFallback(inputInternalControlIp, previousInternalControlIp || internalControlFallback);
  const domesticGatewayIp = validIpv4OrFallback(inputDomesticGatewayIp, previousDomesticGatewayIp || domesticGatewayFallback);
  const dnsServer = validIpv4OrFallback(inputDnsServer, previousDnsServer || dnsServerFallback);
  const previousHasCompleteFeishuPool = Boolean(
    previous?.feishuCidr
    && previous?.feishuLeaseStart
    && previous?.feishuLeaseEnd
  );
  const previousFeishuPoolFallback = previousHasCompleteFeishuPool
    ? null
    : previousLauncherFeishuPoolFallback(previous);
  const leaseRanges = {
    userLeaseStart: validIpv4OrFallback(
      input.userLeaseStart,
      (
        previousHasCompleteFeishuPool
          ? previous?.userLeaseStart
          : previousFeishuPoolFallback?.userLeaseStart
      ) || defaults.userLeaseStart
    ),
    userLeaseEnd: validIpv4OrFallback(
      input.userLeaseEnd,
      (
        previousHasCompleteFeishuPool
          ? previous?.userLeaseEnd
          : previousFeishuPoolFallback?.userLeaseEnd
      ) || defaults.userLeaseEnd
    ),
    feishuLeaseStart: validIpv4OrFallback(
      input.feishuLeaseStart,
      (
        previousHasCompleteFeishuPool
          ? previous?.feishuLeaseStart
          : previousFeishuPoolFallback?.feishuLeaseStart
      ) || defaults.feishuLeaseStart
    ),
    feishuLeaseEnd: validIpv4OrFallback(
      input.feishuLeaseEnd,
      (
        previousHasCompleteFeishuPool
          ? previous?.feishuLeaseEnd
          : previousFeishuPoolFallback?.feishuLeaseEnd
      ) || defaults.feishuLeaseEnd
    ),
    anonymousLeaseStart: validIpv4OrFallback(
      input.anonymousLeaseStart,
      previous?.anonymousLeaseStart || defaults.anonymousLeaseStart
    ),
    anonymousLeaseEnd: validIpv4OrFallback(
      input.anonymousLeaseEnd,
      previous?.anonymousLeaseEnd || defaults.anonymousLeaseEnd
    )
  };
  assertDisjointLauncherLeaseRanges(leaseRanges);
  const leaseCidrs = {
    userCidr: input.userCidr?.trim()
      || (
        previousHasCompleteFeishuPool
          ? previous?.userCidr
          : previousFeishuPoolFallback?.userCidr
      )
      || defaults.userCidr,
    feishuCidr: input.feishuCidr?.trim()
      || (
        previousHasCompleteFeishuPool
          ? previous?.feishuCidr
          : previousFeishuPoolFallback?.feishuCidr
      )
      || defaults.feishuCidr,
    anonymousCidr: input.anonymousCidr?.trim() || previous?.anonymousCidr || defaults.anonymousCidr
  };
  assertLauncherLeaseRangesWithinCidrs(leaseCidrs, leaseRanges);
  return {
    productId,
    displayName: input.displayName?.trim() || previous?.displayName || defaults.displayName,
    mode,
    networkScope,
    standaloneChannelProductId,
    productIndex,
    fabricCidr: '10.88.0.0/16',
    internalControlIp,
    domesticGatewayIp,
    dnsServer,
    serviceVip,
    ...leaseCidrs,
    ...leaseRanges,
    defaultDomesticSiteId: input.defaultDomesticSiteId?.trim() || previous?.defaultDomesticSiteId || 'domestic-main',
    defaultOverseaSiteId: input.defaultOverseaSiteId?.trim() || previous?.defaultOverseaSiteId || 'oversea-main',
    updatePolicy: launcherProductUpdatePolicy(input.updatePolicy ?? previous?.updatePolicy),
    rateLimitProfile: input.rateLimitProfile?.trim() || previous?.rateLimitProfile || defaults.rateLimitProfile,
    dnsPolicyId: input.dnsPolicyId?.trim() || previous?.dnsPolicyId || 'internal-default',
    licensePolicyId: input.licensePolicyId?.trim() || previous?.licensePolicyId || `${productId}-default`,
    anonymousEnrollmentPolicy: launcherAnonymousEnrollmentPolicy(
      input.anonymousEnrollmentPolicy ?? previous?.anonymousEnrollmentPolicy
    ),
    anonymousUiVisibility: launcherAnonymousUiVisibility(
      input.anonymousUiVisibility ?? previous?.anonymousUiVisibility,
      productId
    ),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : previous?.enabled ?? true,
    notes: launcherProductNetworkNotes(mode, networkScope),
    createdBy: previous?.createdBy ?? updatedBy,
    createdAt: previous?.createdAt ?? now,
    updatedBy,
    updatedAt: now
  };
}

export function launcherLeaseIpForProduct(
  product: LauncherProductNetwork,
  leaseProfile: LauncherLeaseProfile,
  sequence: number
): string {
  const range = launcherLeaseRangeForProduct(product, leaseProfile);
  return leaseIpFromRange(
    range.start,
    range.end,
    sequence
  );
}

export function launcherNetworkLeaseMatchesProfile(
  product: LauncherProductNetwork,
  leaseProfile: LauncherLeaseProfile,
  lease: LauncherNetworkLease
): boolean {
  try {
    return launcherLeaseIpForProduct(product, leaseProfile, lease.sequence) === lease.leaseIp;
  } catch {
    return false;
  }
}

export function nextAvailableLauncherNetworkLeaseSequence(
  product: LauncherProductNetwork,
  leaseProfile: LauncherLeaseProfile,
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
    const leaseIp = launcherLeaseIpForProduct(product, leaseProfile, sequence);
    if (!activeIps.has(leaseIp)) return sequence;
  }
  throw new Error(`Launcher network lease range exhausted: ${product.productId}:${leaseProfile}`);
}

export function launcherNetworkLeaseKey(input: LauncherNetworkLeaseInput, product: LauncherProductNetwork): string {
  const identityKind = launcherNetworkIdentityKind(input.identityKind, input.userId);
  const leaseProfile = launcherNetworkLeaseProfile(input.leaseProfile, identityKind);
  const mode = launcherProductMode(input.mode ?? product.mode);
  const principal = launcherNetworkLeasePrincipal(input, identityKind);
  const keyParts = [
    product.productId,
    mode,
    identityKind,
    leaseProfile,
    principal
  ];
  const replacementForLeaseId = input.replacementForLeaseId?.trim();
  if (replacementForLeaseId) keyParts.push(`replacement:${replacementForLeaseId}`);
  return keyParts.join(':');
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
  const leaseProfile = launcherNetworkLeaseProfile(input.leaseProfile, identityKind);
  const launcherMode = launcherProductMode(input.mode ?? product.mode);
  const leaseKey = launcherNetworkLeaseKey({ ...input, identityKind, leaseProfile, mode: launcherMode }, product);
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
    appId: input.appId?.trim() || previous?.appId || product.productId,
    productId: product.productId,
    launcherMode,
    identityKind,
    leaseProfile,
    sequence: previous?.sequence ?? Math.max(1, Math.floor(sequence)),
    installId,
    deviceId,
    siteId: input.siteId?.trim() || previous?.siteId || product.defaultDomesticSiteId,
    userId,
    cidr: launcherLeaseCidrForProduct(product, leaseProfile),
    leaseIp: previous?.leaseIp ?? launcherLeaseIpForProduct(product, leaseProfile, sequence),
    serviceVip: product.serviceVip,
    internalControlIp: product.internalControlIp,
    domesticGatewayIp: product.domesticGatewayIp,
    domesticSiteId: product.defaultDomesticSiteId,
    overseaSiteId: product.defaultOverseaSiteId,
    publicKey: input.publicKey?.trim() || previous?.publicKey || null,
    deviceLabel: input.deviceLabel?.trim() || previous?.deviceLabel || null,
    platform: input.platform?.trim() || previous?.platform || null,
    deviceModel: input.deviceModel?.trim() || previous?.deviceModel || null,
    osVersion: input.osVersion?.trim() || previous?.osVersion || null,
    appVersion: input.appVersion?.trim() || previous?.appVersion || null,
    sourceIp: input.sourceIp?.trim() || previous?.sourceIp || null,
    status: 'active',
    expiresAt,
    releasedAt: null,
    capabilityDigest: input.capabilityDigest?.trim() || previous?.capabilityDigest || null,
    capabilityVersion: input.capabilityVersion ?? previous?.capabilityVersion ?? null,
    capabilityExpiresAt: input.capabilityExpiresAt?.trim() || previous?.capabilityExpiresAt || expiresAt,
    generation: Number.isSafeInteger(input.generation) && Number(input.generation) > 0
      ? Number(input.generation)
      : previous?.generation ?? 0,
    replacementForLeaseId: input.replacementForLeaseId?.trim() || previous?.replacementForLeaseId || null,
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
        suffixes: ['.mx.cn', '.mxinfo-inc.cn', '.internal.mx', '.corp.mx', '.h2i.mx']
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
      dnsTarget: '10.88.88.88',
      targetUrl: config.internalBaseUrl,
      enabled: true,
      tlsMode: 'internal',
      authRequired: true,
      createdAt: now,
      updatedAt: now
    }
  ];
}

export function buildDnsReverseProxyRoute(
  config: RuntimeConfig,
  input: DnsReverseProxyRouteInput,
  previous: DnsReverseProxyRoute | null,
  now = new Date().toISOString()
): DnsReverseProxyRoute {
  const host = normalizeDomain(input.host?.trim() || previous?.host || '');
  if (!host) throw new Error('DNS route host is required');
  const targetUrl = normalizeOptionalTargetUrl(input, previous);
  const dnsTarget = normalizeDnsRouteTarget(input.dnsTarget || previous?.dnsTarget || '10.88.88.88');
  if (!dnsTarget) throw new Error('DNS route dnsTarget is required');
  const tlsMode = dnsReverseProxyTlsMode(input.tlsMode ?? previous?.tlsMode);
  return {
    routeId: input.routeId?.trim() || previous?.routeId || `rp_${safeIdPart(host)}`,
    environment: config.environment,
    host,
    dnsTarget,
    targetUrl,
    enabled: input.enabled ?? previous?.enabled ?? true,
    tlsMode,
    authRequired: input.authRequired ?? previous?.authRequired ?? true,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
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
  const zoneNames = dnsPolicyZoneNames(input.policy, input.reverseProxyRoutes);
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
    yaml: renderConfigMapYaml(configMapName, namespace, labels, annotations, {
      Corefile: snapshot.corefile.combined,
      'mx-zone-snapshot.json': snapshotMetadata
    })
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

export function builtinGatewayRuntimeConfig(
  config: RuntimeConfig,
  now: string = new Date().toISOString(),
  actor = 'runtime-default'
): GatewayRuntimeConfig {
  return {
    configId: GATEWAY_RUNTIME_CONFIG_ID,
    environment: config.environment,
    siteId: config.siteId,
    backend: config.gatewayApplyBackend,
    hostNginxApplyEnabled: config.gatewayHostNginxApplyEnabled,
    hostNginxConfigPath: config.gatewayHostNginxConfigPath,
    hostNginxInternalApiUpstream: config.gatewayHostNginxInternalApiUpstream,
    gatewayAppPort: config.gatewayAppPort,
    createdBy: actor,
    createdAt: now,
    updatedBy: actor,
    updatedAt: now,
    requestId: null
  };
}

export function buildGatewayRuntimeConfig(
  config: RuntimeConfig,
  input: GatewayRuntimeConfigInput,
  previous: GatewayRuntimeConfig | null,
  now: string = new Date().toISOString()
): GatewayRuntimeConfig {
  const updatedBy = input.requestedBy?.trim() || previous?.updatedBy || 'config-center';
  const base = previous ?? builtinGatewayRuntimeConfig(config, now, updatedBy);
  const backend = gatewayRuntimeBackend(input.backend) ?? base.backend;
  return {
    ...base,
    environment: config.environment,
    siteId: config.siteId,
    backend,
    hostNginxApplyEnabled: config.gatewayHostNginxApplyEnabled || backend === 'host-nginx',
    hostNginxConfigPath: input.hostNginxConfigPath?.trim()
      || base.hostNginxConfigPath
      || config.gatewayHostNginxConfigPath,
    hostNginxInternalApiUpstream: gatewayRuntimeOptionalString(
      input.hostNginxInternalApiUpstream,
      base.hostNginxInternalApiUpstream ?? config.gatewayHostNginxInternalApiUpstream
    ),
    gatewayAppPort: Number.isFinite(config.gatewayAppPort) ? config.gatewayAppPort : base.gatewayAppPort,
    createdBy: previous?.createdBy || base.createdBy || updatedBy,
    createdAt: previous?.createdAt || base.createdAt || now,
    updatedBy,
    updatedAt: now,
    requestId: input.requestId?.trim() || null
  };
}

export function gatewayRuntimeConfigRequestInput<T extends GatewayConfigMapSyncInput>(
  input: T,
  runtime: GatewayRuntimeConfig
): T {
  return {
    ...input,
    gatewayApplyBackend: input.gatewayApplyBackend ?? runtime.backend,
    gatewayHostNginxConfigPath: input.gatewayHostNginxConfigPath ?? runtime.hostNginxConfigPath,
    gatewayHostNginxInternalApiUpstream: input.gatewayHostNginxInternalApiUpstream
      ?? runtime.hostNginxInternalApiUpstream
  } as T;
}

function gatewayRuntimeBackend(value: GatewayRuntimeConfigInput['backend']): GatewayRuntimeBackend | null {
  return value === 'host-nginx' || value === 'k8s' ? value : null;
}

function gatewayRuntimeOptionalString(value: string | null | undefined, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  return fallback;
}

export function renderGatewayConfigMap(
  config: RuntimeConfig,
  routes: DnsReverseProxyRoute[],
  input: GatewayConfigMapSyncInput,
  syncId: string
): GatewayConfigMapSyncResult {
  const gatewayConfig = gatewayRuntimeConfigForInput(config, input);
  const namespace = input.namespace?.trim() || 'mx-internal-shadow';
  const configMapName = input.configMapName?.trim() || 'mx-internal-gateway-caddy';
  const mode = input.mode === 'shadow-apply' ? 'shadow-apply' : 'dry-run';
  const issuedAt = new Date().toISOString();
  const gatewayRoutes = enabledGatewayRoutes(routes);
  const labels = {
    'app.kubernetes.io/name': 'mx-internal-gateway',
    'app.kubernetes.io/part-of': 'mx-3ks',
    'mx.qpjoy.com/component': 'internal-gateway',
    'mx.qpjoy.com/environment': config.environment
  };
  const digestPayload = JSON.stringify(gatewayRoutes.map((route) => ({
    routeId: route.routeId,
    host: route.host,
    dnsTarget: route.dnsTarget,
    targetUrl: route.targetUrl,
    tlsMode: route.tlsMode,
    authRequired: route.authRequired
  })));
  const digest = createHash('sha256').update(digestPayload).digest('hex');
  const annotations = {
    'mx.qpjoy.com/gateway-route-digest': digest,
    'mx.qpjoy.com/sync-id': syncId
  };
  const routesMetadata = JSON.stringify({
    environment: gatewayConfig.environment,
    siteId: gatewayConfig.siteId,
    gatewayApplyBackend: gatewayConfig.gatewayApplyBackend,
    gatewayHostNginxConfigPath: gatewayConfig.gatewayHostNginxConfigPath,
    gatewayPort: gatewayConfig.gatewayAppPort,
    routeCount: gatewayRoutes.length,
    routes: gatewayRoutes.map((route) => ({
      routeId: route.routeId,
      host: route.host,
      dnsTarget: route.dnsTarget,
      targetUrl: route.targetUrl,
      tlsMode: route.tlsMode,
      authRequired: route.authRequired,
      updatedAt: route.updatedAt
    })),
    issuedAt,
    digest
  }, null, 2);
  const caddyfile = renderGatewayCaddyfile(gatewayConfig, gatewayRoutes);
  const nginxConfig = renderGatewayNginxConfig(gatewayConfig, gatewayRoutes);
  const manifest: GatewayConfigMapManifest = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName,
      namespace,
      labels,
      annotations
    },
    data: {
      Caddyfile: caddyfile,
      'nginx.conf': nginxConfig,
      'mx-gateway-routes.json': routesMetadata
    },
    yaml: renderConfigMapYaml(configMapName, namespace, labels, annotations, {
      Caddyfile: caddyfile,
      'nginx.conf': nginxConfig,
      'mx-gateway-routes.json': routesMetadata
    })
  };
  return {
    syncId,
    mode,
    status: mode === 'shadow-apply' ? 'recorded' : 'rendered',
    applied: false,
    namespace,
    configMapName,
    routeCount: gatewayRoutes.length,
    manifest,
    issuedAt,
    message: mode === 'shadow-apply'
      ? 'shadow apply recorded; no Kubernetes API mutation was performed'
      : 'dry-run render only; no Kubernetes API mutation was performed'
  };
}

export function evaluateGatewayConfigMapApplyGate(
  config: RuntimeConfig,
  sync: GatewayConfigMapSyncResult,
  input: GatewayConfigMapApplyInput
): { allowed: boolean; serverDryRun: boolean; blockedReason: string | null } {
  const gatewayConfig = gatewayRuntimeConfigForInput(config, input);
  const serverDryRun = input.serverDryRun !== false;
  if (gatewayConfig.gatewayApplyBackend === 'host-nginx') {
    if (!gatewayConfig.gatewayHostNginxApplyEnabled) {
      return {
        allowed: false,
        serverDryRun,
        blockedReason: 'GATEWAY_HOST_NGINX_APPLY_ENABLED is not enabled'
      };
    }
    if (input.confirmApply !== true) {
      return {
        allowed: false,
        serverDryRun,
        blockedReason: 'confirmApply=true is required before host nginx mutation'
      };
    }
    return { allowed: true, serverDryRun, blockedReason: null };
  }
  if (!gatewayConfig.gatewayK8sApplyEnabled) {
    return {
      allowed: false,
      serverDryRun,
      blockedReason: 'GATEWAY_K8S_APPLY_ENABLED is not enabled'
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
    sync.namespace !== gatewayConfig.gatewayK8sAllowedNamespace
    || sync.configMapName !== gatewayConfig.gatewayK8sAllowedConfigMapName
  ) {
    return {
      allowed: false,
      serverDryRun,
      blockedReason: `target ${sync.namespace}/${sync.configMapName} is outside the allowed Internal gateway target`
    };
  }
  return { allowed: true, serverDryRun, blockedReason: null };
}

export function gatewayRuntimeConfigForInput(
  config: RuntimeConfig,
  input: Pick<GatewayConfigMapSyncInput, 'gatewayApplyBackend' | 'gatewayHostNginxConfigPath' | 'gatewayHostNginxInternalApiUpstream'>
): RuntimeConfig {
  const requestedBackend = input.gatewayApplyBackend === 'host-nginx' || input.gatewayApplyBackend === 'k8s'
    ? input.gatewayApplyBackend
    : null;
  return {
    ...config,
    gatewayApplyBackend: requestedBackend ?? config.gatewayApplyBackend,
    gatewayHostNginxApplyEnabled: config.gatewayHostNginxApplyEnabled || requestedBackend === 'host-nginx',
    gatewayHostNginxConfigPath: input.gatewayHostNginxConfigPath?.trim()
      || config.gatewayHostNginxConfigPath,
    gatewayHostNginxInternalApiUpstream: input.gatewayHostNginxInternalApiUpstream?.trim()
      || config.gatewayHostNginxInternalApiUpstream
  };
}

function renderGatewayCaddyfile(config: RuntimeConfig, routes: DnsReverseProxyRoute[]): string {
  const appPort = Number.isFinite(config.gatewayAppPort) ? config.gatewayAppPort : 80;
  const appPorts = [...new Set([appPort, 8008])].filter((port) => port > 0 && port <= 65535);
  return [
    '{',
    '  admin off',
    '  auto_https off',
    '}',
    '',
    ':18090 {',
    '  bind 0.0.0.0',
    '  encode zstd gzip',
    '  header {',
    '    X-MX-Gateway internal-k8s-host-gateway',
    '  }',
    '  @domesticEdge {',
    '    remote_ip 10.88.0.1',
    '    header X-MX-Forwarded-By domestic-edge',
    '  }',
    '  handle @domesticEdge {',
    '    reverse_proxy mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090 {',
    '      header_up X-Forwarded-For {http.request.header.X-Forwarded-For}',
    '    }',
    '  }',
    '  handle {',
    '    reverse_proxy mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090 {',
    '      header_up X-Forwarded-For {remote_host}',
    '      header_up -X-MX-Forwarded-By',
    '    }',
    '  }',
    '}',
    '',
    ...appPorts.flatMap((port) => gatewayAppServerBlock(port, routes, port === appPort ? 'internal-app-gateway' : 'internal-app-gateway-fallback'))
  ].join('\n');
}

export function renderGatewayNginxConfig(config: RuntimeConfig, routes: DnsReverseProxyRoute[]): string {
  const appPort = Number.isFinite(config.gatewayAppPort) ? config.gatewayAppPort : 80;
  const appPorts = [...new Set([appPort])].filter((port) => port > 0 && port <= 65535);
  const internalApiUpstream = nginxUpstreamOrigin(config.gatewayHostNginxInternalApiUpstream);
  return [
    '# MX-H2I generated host nginx gateway include.',
    '# This file is intended to be included from nginx http {} context.',
    'map $http_upgrade $mx_gateway_connection_upgrade {',
    '  default upgrade;',
    "  '' close;",
    '}',
    '',
    ...(internalApiUpstream ? nginxInternalApiServerBlock(internalApiUpstream) : []),
    ...appPorts.flatMap((port) => nginxAppServerBlocks(config, port, routes))
  ].join('\n');
}

function nginxInternalApiServerBlock(upstream: string): string[] {
  return [
    'server {',
    '  listen 18090;',
    '  server_name internal.mx gateway.internal.mx;',
    '  add_header X-MX-Gateway internal-host-nginx-api always;',
    '  location / {',
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-Host $host;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header Upgrade $http_upgrade;',
    '    proxy_set_header Connection $mx_gateway_connection_upgrade;',
    `    proxy_pass ${upstream};`,
    '  }',
    '}',
    ''
  ];
}

function nginxAppServerBlocks(config: RuntimeConfig, port: number, routes: DnsReverseProxyRoute[]): string[] {
  const routeBlocks = routes.flatMap((route) => nginxRouteServerBlock(config, port, route));
  return [
    ...routeBlocks,
    'server {',
    `  listen ${port};`,
    '  server_name _;',
    '  add_header X-MX-Gateway internal-host-nginx always;',
    '  return 404 "MX Internal gateway route not found\\n";',
    '}',
    ''
  ];
}

function nginxRouteServerBlock(config: RuntimeConfig, port: number, route: DnsReverseProxyRoute): string[] {
  const upstream = nginxRouteUpstreamOrigin(config, route.targetUrl);
  if (!upstream) return [];
  return [
    'server {',
    `  listen ${port};`,
    `  server_name ${route.host};`,
    '  add_header X-MX-Gateway internal-host-nginx always;',
    '  location / {',
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-Host $host;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    `    proxy_set_header X-MX-Route-Id ${JSON.stringify(route.routeId)};`,
    '    proxy_set_header Upgrade $http_upgrade;',
    '    proxy_set_header Connection $mx_gateway_connection_upgrade;',
    ...(upstream.startsWith('https://') ? [
      '    proxy_ssl_server_name on;',
      '    proxy_ssl_name $proxy_host;'
    ] : []),
    `    proxy_pass ${upstream};`,
    '  }',
    '}',
    ''
  ];
}

function nginxUpstreamOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function nginxRouteUpstreamOrigin(config: RuntimeConfig, value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host === 'mx-launcher-internal.mx-internal-shadow.svc.cluster.local') {
      return nginxUpstreamOrigin(config.gatewayHostNginxInternalApiUpstream)
        ?? `${url.protocol}//127.0.0.1:${url.port || '18090'}`;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function gatewayAppServerBlock(port: number, routes: DnsReverseProxyRoute[], gatewayName: string): string[] {
  const block = [
    `:${port} {`,
    '  bind 0.0.0.0',
    '  encode zstd gzip',
    '  header {',
    `    X-MX-Gateway ${gatewayName}`,
    '  }',
    ...gatewayRouteBlocks(routes, `p${port}`),
    '  handle {',
    '    respond "MX Internal gateway route not found\\n" 404',
    '  }',
    '}',
    ''
  ];
  if (port !== 80) return block;
  return [
    '# mx-gateway-optional-port-80:start',
    ...block,
    '# mx-gateway-optional-port-80:end',
    ''
  ];
}

function gatewayRouteBlocks(routes: DnsReverseProxyRoute[], prefix: string): string[] {
  return routes.flatMap((route) => {
    const upstream = gatewayUpstreamUrl(route);
    if (!upstream) return [];
    const matcher = `${prefix}_route_${safeIdPart(route.routeId).replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const upstreamOrigin = `${upstream.protocol}//${upstream.host}`;
    return [
      `  @${matcher} host ${route.host}`,
      `  handle @${matcher} {`,
      `    reverse_proxy ${upstreamOrigin} {`,
      `      header_up X-Forwarded-Host {http.request.host}`,
      `      header_up X-Forwarded-Proto {http.request.scheme}`,
      `      header_up X-MX-Route-Id ${route.routeId}`,
      `    }`,
      `  }`,
      ''
    ];
  });
}

function enabledGatewayRoutes(routes: DnsReverseProxyRoute[]): DnsReverseProxyRoute[] {
  return routes
    .filter((route) => route.enabled !== false && gatewayUpstreamUrl(route))
    .sort((a, b) => a.host.localeCompare(b.host));
}

function gatewayUpstreamUrl(route: DnsReverseProxyRoute): URL | null {
  if (!route.targetUrl?.trim()) return null;
  try {
    const url = new URL(route.targetUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function renderConfigMapYaml(
  name: string,
  namespace: string,
  labels: Record<string, string>,
  annotations: Record<string, string>,
  data: Record<string, string>
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
    ...Object.entries(data).flatMap(([key, value]) => [
      `  ${key}: |`,
      ...indentBlock(value, 4)
    ])
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

function dnsPolicyZoneNames(policy: DnsPolicy, routes: DnsReverseProxyRoute[] = []): string[] {
  const suffixZones = policy.whitelist.suffixes.map((suffix) => normalizeDomain(suffix).replace(/^\./, ''));
  const exactZones = policy.whitelist.exactDomains
    .map(normalizeDomain)
    .filter((domain) => !suffixZones.some((suffix) => domain.endsWith(`.${suffix}`)));
  const routeZones = routes
    .filter((route) => route.enabled !== false)
    .map((route) => dnsRouteZoneName(route.host))
    .filter(Boolean);
  return [...new Set([...suffixZones, ...exactZones, ...routeZones])].sort();
}

function dnsRouteZoneName(host: string): string {
  const domain = normalizeDomain(host);
  if (!domain) return '';
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 2) return domain;
  return labels.slice(1).join('.');
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
    const target = normalizeDnsRouteTarget(route.dnsTarget) || hostFromUrl(route.targetUrl || '') || targetServiceDns;
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

function normalizeDnsRouteTarget(value: string | null | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return '';
  const host = hostFromUrl(candidate).replace(/^([^:/]+):\d+$/, '$1');
  return isIpv4(host) ? host : normalizeDomain(host);
}

function normalizeOptionalTargetUrl(input: DnsReverseProxyRouteInput, previous: DnsReverseProxyRoute | null): string | null {
  if (Object.prototype.hasOwnProperty.call(input, 'targetUrl')) {
    return input.targetUrl?.trim() || null;
  }
  return previous?.targetUrl || null;
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
    .filter((cidr) => /^10\.\d{1,3}\.0\.0\/16$/.test(cidr) || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}\/32$/.test(cidr));
  return [...new Set(cidrs.length ? cidrs : ['10.89.0.0/16', '10.90.0.0/16'])];
}

function launcherProductMode(value: LauncherProductNetworkInput['mode']): LauncherProductMode {
  return value === 'standalone' ? 'standalone' : 'embed';
}

export function launcherAnonymousEnrollmentPolicy(
  value: LauncherProductNetworkInput['anonymousEnrollmentPolicy']
): LauncherAnonymousEnrollmentPolicy {
  if (value === 'drain' || value === 'disabled') return value;
  return 'enabled';
}

export function launcherAnonymousUiVisibility(
  value: LauncherProductNetworkInput['anonymousUiVisibility'],
  productId: string
): LauncherAnonymousUiVisibility {
  if (value === 'primary' || value === 'advanced' || value === 'hidden') return value;
  return productId === MX_H2I_PRODUCT_ID ? 'advanced' : 'primary';
}

function launcherNetworkScope(
  _value: LauncherProductNetworkInput['networkScope'],
  mode: LauncherProductMode
): 'owner' | 'broker-session' {
  if (mode === 'standalone') return 'owner';
  return 'broker-session';
}

function launcherNetworkIdentityKind(value: LauncherNetworkLeaseInput['identityKind'], userId?: string | null): 'user' | 'anonymous' {
  if (value === 'user' || userId?.trim()) return 'user';
  return 'anonymous';
}

export function launcherNetworkLeaseProfile(
  value: LauncherNetworkLeaseInput['leaseProfile'],
  identityKind: 'user' | 'anonymous'
): LauncherLeaseProfile {
  if (identityKind === 'anonymous') return 'anonymous';
  return value === 'feishu' ? 'feishu' : 'employee';
}

function launcherLeaseRangeForProduct(
  product: LauncherProductNetwork,
  leaseProfile: LauncherLeaseProfile
): { start: string; end: string } {
  if (leaseProfile === 'feishu') {
    return {
      start: product.feishuLeaseStart,
      end: product.feishuLeaseEnd
    };
  }
  if (leaseProfile === 'employee') {
    return {
      start: product.userLeaseStart,
      end: product.userLeaseEnd
    };
  }
  return {
    start: product.anonymousLeaseStart,
    end: product.anonymousLeaseEnd
  };
}

function assertDisjointLauncherLeaseRanges(ranges: {
  userLeaseStart: string;
  userLeaseEnd: string;
  feishuLeaseStart: string;
  feishuLeaseEnd: string;
  anonymousLeaseStart: string;
  anonymousLeaseEnd: string;
}): void {
  const userStart = ipv4ToNumber(ranges.userLeaseStart);
  const userEnd = ipv4ToNumber(ranges.userLeaseEnd);
  const feishuStart = ipv4ToNumber(ranges.feishuLeaseStart);
  const feishuEnd = ipv4ToNumber(ranges.feishuLeaseEnd);
  const anonymousStart = ipv4ToNumber(ranges.anonymousLeaseStart);
  const anonymousEnd = ipv4ToNumber(ranges.anonymousLeaseEnd);
  if (
    userStart == null
    || userEnd == null
    || feishuStart == null
    || feishuEnd == null
    || anonymousStart == null
    || anonymousEnd == null
    || userStart > userEnd
    || feishuStart > feishuEnd
    || anonymousStart > anonymousEnd
  ) {
    throw new Error('Launcher lease profile ranges must use valid ascending IPv4 addresses');
  }
  if (userEnd >= feishuStart || feishuEnd >= anonymousStart) {
    throw new Error('Launcher employee, Feishu, and anonymous lease ranges must not overlap');
  }
}

export function assertLauncherProductLeaseIsolation(
  candidate: LauncherProductNetwork,
  existingProducts: LauncherProductNetwork[]
): void {
  if (candidate.mode !== 'standalone' || candidate.enabled === false) return;
  const candidateRanges = launcherProductLeaseRanges(candidate);
  for (const existing of existingProducts) {
    if (
      existing.productId === candidate.productId
      || existing.mode !== 'standalone'
      || existing.enabled === false
    ) {
      continue;
    }
    for (const candidateRange of candidateRanges) {
      for (const existingRange of launcherProductLeaseRanges(existing)) {
        if (candidateRange.start <= existingRange.end && existingRange.start <= candidateRange.end) {
          throw new Error(
            `Launcher product ${candidate.productId} lease range overlaps ${existing.productId}`
          );
        }
      }
    }
  }
}

function launcherProductLeaseRanges(
  product: LauncherProductNetwork
): Array<{ start: number; end: number }> {
  return [
    [product.userLeaseStart, product.userLeaseEnd],
    [product.feishuLeaseStart, product.feishuLeaseEnd],
    [product.anonymousLeaseStart, product.anonymousLeaseEnd]
  ].map(([startIp, endIp]) => {
    const start = ipv4ToNumber(startIp);
    const end = ipv4ToNumber(endIp);
    if (start == null || end == null || start > end) {
      throw new Error(`Launcher product ${product.productId} has an invalid lease range`);
    }
    return { start, end };
  });
}

function assertLauncherLeaseRangesWithinCidrs(
  cidrs: {
    userCidr: string;
    feishuCidr: string;
    anonymousCidr: string;
  },
  ranges: {
    userLeaseStart: string;
    userLeaseEnd: string;
    feishuLeaseStart: string;
    feishuLeaseEnd: string;
    anonymousLeaseStart: string;
    anonymousLeaseEnd: string;
  }
): void {
  const profiles = [
    ['employee', cidrs.userCidr, ranges.userLeaseStart, ranges.userLeaseEnd],
    ['Feishu', cidrs.feishuCidr, ranges.feishuLeaseStart, ranges.feishuLeaseEnd],
    ['anonymous', cidrs.anonymousCidr, ranges.anonymousLeaseStart, ranges.anonymousLeaseEnd]
  ] as const;
  for (const [profile, cidr, startIp, endIp] of profiles) {
    const bounds = ipv4CidrBounds(cidr);
    const start = ipv4ToNumber(startIp);
    const end = ipv4ToNumber(endIp);
    if (
      !bounds
      || start == null
      || end == null
      || start < bounds.start
      || end > bounds.end
    ) {
      throw new Error(`Launcher ${profile} lease range must be contained by its IPv4 CIDR`);
    }
  }
}

function ipv4CidrBounds(value: string): { start: number; end: number } | null {
  const [addressText, prefixText, ...extra] = value.split('/');
  if (extra.length || !addressText || !prefixText) return null;
  const address = ipv4ToNumber(addressText);
  const prefix = Number(prefixText);
  if (address == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(address / size) * size;
  if (address !== start) return null;
  return {
    start,
    end: start + size - 1
  };
}

function launcherLeaseCidrForProduct(
  product: LauncherProductNetwork,
  leaseProfile: LauncherLeaseProfile
): string {
  if (leaseProfile === 'feishu') return product.feishuCidr;
  return leaseProfile === 'employee' ? product.userCidr : product.anonymousCidr;
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
    const serviceVip = `10.88.100.${serviceOffset}`;
    return {
      displayName: productId === MX_H2I_PRODUCT_ID ? 'MX-H2I' : productId === LAUNCHER_FOUNDATION_PRODUCT_ID ? 'Launcher Foundation' : productId,
      serviceVip,
      internalControlIp: launcherNetworkProductUsesLegacyFoundation(productId) ? '10.88.88.88' : serviceVip,
      domesticGatewayIp: launcherNetworkProductUsesLegacyFoundation(productId) ? '10.88.0.1' : serviceVip,
      dnsServer: launcherNetworkProductUsesLegacyFoundation(productId) ? '10.88.0.1' : serviceVip,
      userCidr: `10.${secondOctet}.0.0/16`,
      feishuCidr: `10.${secondOctet}.0.0/16`,
      anonymousCidr: `10.${secondOctet}.0.0/16`,
      userLeaseStart: `10.${secondOctet}.0.1`,
      userLeaseEnd: `10.${secondOctet}.49.254`,
      feishuLeaseStart: `10.${secondOctet}.50.1`,
      feishuLeaseEnd: `10.${secondOctet}.99.254`,
      anonymousLeaseStart: `10.${secondOctet}.100.1`,
      anonymousLeaseEnd: `10.${secondOctet}.254.254`,
      rateLimitProfile: 'standalone-default'
    };
  }
  const index = Math.max(0, Math.min(99, Math.floor(productIndex)));
  const secondOctet = productId === APP_CENTER_PRODUCT_ID
    ? 92
    : productId === 'h2o'
      ? 90
      : 90 + index;
  const serviceOffset = 10 + (index % 200);
  const serviceVip = `10.88.100.${serviceOffset}`;
  return {
    displayName: productId.toUpperCase(),
    serviceVip,
    internalControlIp: serviceVip,
    domesticGatewayIp: serviceVip,
    dnsServer: serviceVip,
    userCidr: `10.${secondOctet}.0.0/16`,
    feishuCidr: `10.${secondOctet}.0.0/16`,
    anonymousCidr: `10.${secondOctet}.0.0/16`,
    userLeaseStart: `10.${secondOctet}.0.1`,
    userLeaseEnd: `10.${secondOctet}.49.254`,
    feishuLeaseStart: `10.${secondOctet}.50.1`,
    feishuLeaseEnd: `10.${secondOctet}.99.254`,
    anonymousLeaseStart: `10.${secondOctet}.100.1`,
    anonymousLeaseEnd: `10.${secondOctet}.254.254`,
    rateLimitProfile: 'product-default'
  };
}

function launcherNetworkProductUsesLegacyFoundation(productId: string): boolean {
  return productId === MX_H2I_PRODUCT_ID || productId === LAUNCHER_FOUNDATION_PRODUCT_ID;
}

function launcherProductNetworkNotes(mode: LauncherProductMode, networkScope: 'owner' | 'broker-session'): string[] {
  return mode === 'standalone' || networkScope === 'owner'
    ? [
        'Launcher standalone mode owns a product-scoped peer lease CIDR and product service VIP.',
        'Control, DNS, reverse-proxy, user, permission, and release decisions are materialized behind the product VIP instead of shared 10.88.0.1/10.88.88.88 client routes.'
      ]
    : [
        'Launcher embed mode does not allocate its own WireGuard peer or runtime lease IP.',
        'Embed apps consume user, permission, network, release, and update state through the selected standalone broker session.'
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
      routeId: 'sdk.oauth.feishu.config',
      path: '/internal/v1/sdk/oauth/feishu/config',
      upstreamModule: 'sdk-gateway',
      audience: 'mx-sdk',
      authRequired: false,
      description: 'Reports whether Feishu OAuth is safely configured for MX-H2I.'
    },
    {
      routeId: 'sdk.oauth.feishu.authorize',
      path: '/internal/v1/sdk/oauth/feishu/authorize',
      upstreamModule: 'sdk-gateway',
      audience: 'mx-sdk',
      authRequired: false,
      description: 'Builds an allowlisted Feishu authorization URL for a PKCE login attempt.'
    },
    {
      routeId: 'sdk.oauth.feishu.token',
      path: '/internal/v1/sdk/oauth/feishu/token',
      upstreamModule: 'sdk-gateway',
      audience: 'mx-sdk',
      authRequired: false,
      description: 'Exchanges a one-time Feishu authorization code for an MX User Center token.'
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
      routeId: 'sdk.users.password.self',
      path: '/internal/v1/sdk/users/me/password',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Verifies the current local password, updates it, and revokes the signed-in user’s active tokens.'
    },
    {
      routeId: 'sdk.users.password.update',
      path: '/internal/v1/sdk/users/{userId}/password',
      upstreamModule: 'user-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Updates a User Center local password and revokes the user’s active tokens.'
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
      routeId: 'sdk.releases.list',
      path: '/internal/v1/sdk/releases',
      upstreamModule: 'release-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Lists product-scoped Release Center plans visible to the calling service account.'
    },
    {
      routeId: 'sdk.releases.create',
      path: '/internal/v1/sdk/releases',
      upstreamModule: 'release-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Creates a gated product release from an artifact previously uploaded by the same product publisher.'
    },
    {
      routeId: 'sdk.releases.get',
      path: '/internal/v1/sdk/releases/{planId}',
      upstreamModule: 'release-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Reads one product-scoped Release Center plan.'
    },
    {
      routeId: 'sdk.releases.gate',
      path: '/internal/v1/sdk/releases/{planId}/gate',
      upstreamModule: 'release-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Records an approval result for a product-scoped Release Center plan.'
    },
    {
      routeId: 'sdk.release_artifacts.upload',
      path: '/internal/v1/sdk/releases/artifacts',
      upstreamModule: 'release-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Uploads a product-scoped release artifact as a raw binary stream.'
    },
    {
      routeId: 'sdk.release_artifacts.get',
      path: '/internal/v1/sdk/releases/artifacts/{artifactId}',
      upstreamModule: 'release-center',
      audience: 'mx-sdk',
      authRequired: true,
      description: 'Reads metadata for a product-scoped release artifact.'
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
      feishuConfigUrl: '/internal/v1/sdk/oauth/feishu/config',
      feishuAuthorizeUrl: '/internal/v1/sdk/oauth/feishu/authorize',
      feishuTokenUrl: '/internal/v1/sdk/oauth/feishu/token',
      tokenIntrospectionUrl: '/internal/v1/sdk/identity/introspect',
      principalContextUrl: '/internal/v1/sdk/identity/context',
      rolesUrl: '/internal/v1/sdk/roles',
      usersUrl: '/internal/v1/sdk/users',
      selfPasswordUrl: '/internal/v1/sdk/users/me/password',
      userPasswordUrl: '/internal/v1/sdk/users/{userId}/password',
      serviceAccountsUrl: '/internal/v1/sdk/service-accounts',
      permissionsRequestUrl: '/internal/v1/sdk/permissions/requests',
      configSnapshotUrl: '/internal/v1/sdk/config/snapshot',
      dnsPolicyUrl: '/internal/v1/sdk/dns/policy',
      dnsEvaluateUrl: '/internal/v1/sdk/dns/evaluate',
      dnsZoneUrl: '/internal/v1/sdk/dns/zone',
      dnsCoreDnsConfigMapUrl: '/internal/v1/sdk/dns/coredns-configmap',
      auditUrl: '/internal/v1/audit/events',
      observabilityLogsUrl: '/internal/v1/observability/logs',
      documentationUrl: '/docs/api/',
      openApiUrl: '/docs/api/openapi.json',
      markdownUrl: '/docs/api/mx-launcher-api.md'
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

function dnsReverseProxyTlsMode(value: DnsReverseProxyRoute['tlsMode'] | null | undefined): DnsReverseProxyRoute['tlsMode'] {
  if (value === 'passthrough' || value === 'edge-terminated') return value;
  return 'internal';
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
    leaseCidr?: string | null;
    leaseProfile?: LauncherLeaseProfile | null;
    product: LauncherProductNetwork;
    domesticSiteId?: string | null;
    overseaSiteId?: string | null;
    publicKey?: string | null;
  }
): LauncherNetworkTopology {
  const product = input.product;
  const internalBaseUrl = launcherProductInternalBaseUrl(config, product);
  const domesticSiteId = input.domesticSiteId?.trim() || product.defaultDomesticSiteId;
  const overseaSiteId = input.overseaSiteId?.trim() || product.defaultOverseaSiteId;
  const cidr = input.leaseCidr?.trim()
    || (input.leaseProfile === 'feishu'
      ? product.feishuCidr
      : input.mode === 'user' ? product.userCidr : product.anonymousCidr);
  const publicKey = input.publicKey?.trim() || null;
  const subscriptionBaseUrl = `${internalBaseUrl}/internal/v1/site-slots/${overseaSiteId}/subscriptions/hysteria2`;
  const productRouteCidrs = uniqueStrings([
    product.userCidr,
    product.feishuCidr,
    product.anonymousCidr,
    `${product.serviceVip}/32`,
    `${product.internalControlIp}/32`,
    `${product.domesticGatewayIp}/32`,
    `${product.dnsServer}/32`
  ]);
  return {
    model: 'internal-authority-domestic-relay-oversea-access-v1',
    product: {
      productId: product.productId,
      displayName: product.displayName,
      mode: product.mode,
      serviceVip: product.serviceVip,
      internalControlIp: product.internalControlIp,
      domesticGatewayIp: product.domesticGatewayIp,
      dnsServer: product.dnsServer,
      userCidr: product.userCidr,
      feishuCidr: product.feishuCidr,
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
      gatewayIp: product.domesticGatewayIp,
      overlayCidrs: productRouteCidrs,
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
        purpose: 'make Internal reachable and materialize product-scoped control, DNS, proxy, and service VIP addresses'
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
        allowedIps: uniqueStrings([
          '10.88.88.88/32',
          `${product.internalControlIp}/32`,
          `${product.serviceVip}/32`,
          `${product.domesticGatewayIp}/32`,
          `${product.dnsServer}/32`
        ]),
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
        allowedIps: productRouteCidrs,
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
        internalCidrs: productRouteCidrs,
        dnsServer: product.dnsServer,
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

function launcherProductInternalBaseUrl(config: RuntimeConfig, product: LauncherProductNetwork): string {
  const fallbackPort = '18090';
  try {
    const parsed = new URL(config.internalBaseUrl);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : fallbackPort);
    return `${parsed.protocol}//${product.internalControlIp}${port ? `:${port}` : ''}`;
  } catch {
    return `http://${product.internalControlIp}:${fallbackPort}`;
  }
}

export function createConfigPolicySnapshot(
  config: RuntimeConfig,
  input: ConfigPolicySnapshotInput,
  parts: {
    snapshotId: string;
    version: number;
    app: AppCenterApp | null;
    appAccess: AppCenterAccessDecision | null;
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
        appAccess: parts.appAccess,
        defaultDecision: parts.app?.accessPolicy.defaultDecision === 'public'
          ? 'public-app' as const
          : parts.appAccess && !parts.appAccess.allowed
            ? 'denied-by-app-policy' as const
          : parts.appAccess?.allowed
            ? 'allowed-by-app-policy' as const
            : parts.app
              ? 'denied-by-app-policy' as const
              : 'requires-appcenter-grant' as const
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
    || value === 'feature-flag'
    || value === 'renderer-ui'
    || value === 'launcher-npm'
    || value === 'launcher-asar'
    || value === 'app-asar'
    || value === 'appcenter-app'
    || value === 'app-installer'
    || value === 'mx-h2i-installer'
    || value === 'native-helper'
  ) {
    return value;
  }
  return 'app-managed';
}

export function normalizeReleaseArtifactKind(value: unknown): ReleaseArtifactKind {
  if (
    value === 'config-snapshot'
    || value === 'feature-flag'
    || value === 'renderer-ui'
    || value === 'launcher-npm'
    || value === 'launcher-asar'
    || value === 'app-asar'
    || value === 'appcenter-app'
    || value === 'app-installer'
    || value === 'mx-h2i-installer'
    || value === 'native-helper'
  ) {
    return value;
  }
  return 'renderer-ui';
}

export function normalizeReleaseActivationMode(value: unknown): ReleaseActivationMode {
  if (
    value === 'hot-auto'
    || value === 'hot-manual'
    || value === 'restart-auto'
    || value === 'restart-manual'
    || value === 'installer-manual'
  ) {
    return value;
  }
  return 'hot-auto';
}

export function normalizeReleaseRolloutStrategy(value: unknown): ReleaseRolloutStrategy {
  if (
    value === 'all'
    || value === 'canary'
    || value === 'gray'
    || value === 'manual-ring'
    || value === 'feature-flag'
  ) {
    return value;
  }
  return 'gray';
}

function releaseActivationForArtifact(kind: ReleaseArtifactKind, requested?: ReleaseActivationMode | null): ReleaseActivationMode {
  if (requested) return requested;
  if (kind === 'app-installer' || kind === 'mx-h2i-installer') return 'installer-manual';
  if (kind === 'native-helper') return 'restart-manual';
  if (kind === 'launcher-asar' || kind === 'app-asar') return 'restart-auto';
  return 'hot-auto';
}

function releaseArtifactSource(kind: ReleaseArtifactKind): ReleaseArtifactRef['source'] {
  if (kind === 'config-snapshot' || kind === 'feature-flag') return 'config-center';
  if (kind === 'launcher-npm') return 'npm-sync';
  if (kind === 'renderer-ui' || kind === 'launcher-asar' || kind === 'app-asar' || kind === 'appcenter-app') return 'ci-artifact';
  return 'manual-upload';
}

function releaseActivationNeedsRestart(mode: ReleaseActivationMode): boolean {
  return mode === 'restart-auto' || mode === 'restart-manual' || mode === 'installer-manual';
}

function releaseArtifactKindForPolicy(kind: UpdatePolicyKind): ReleaseArtifactKind {
  if (
    kind === 'config-snapshot'
    || kind === 'feature-flag'
    || kind === 'renderer-ui'
    || kind === 'launcher-npm'
    || kind === 'launcher-asar'
    || kind === 'app-asar'
    || kind === 'appcenter-app'
    || kind === 'app-installer'
    || kind === 'mx-h2i-installer'
    || kind === 'native-helper'
  ) {
    return kind;
  }
  if (kind === 'platform-ui') return 'renderer-ui';
  if (kind === 'platform-critical') return 'launcher-asar';
  return 'appcenter-app';
}

function buildReleaseArtifactRef(
  input: ReleaseManagementPlanInput,
  decision: ReleasePolicyDecision,
  role: 'launcher' | 'app',
  releaseId: string
): ReleaseArtifactRef | null {
  if (!decision.updateAvailable) return null;
  const requestedKind = role === 'launcher' && input.artifactKind
    ? normalizeReleaseArtifactKind(input.artifactKind)
    : null;
  const kind = requestedKind ?? releaseArtifactKindForPolicy(decision.componentKind);
  const requestedActivation = role === 'launcher' && input.activationMode
    ? normalizeReleaseActivationMode(input.activationMode)
    : null;
  const activation = releaseActivationForArtifact(kind, requestedActivation);
  const version = role === 'launcher'
    ? input.artifactVersion?.trim() || decision.targetVersion
    : decision.targetVersion;
  const artifactId = `artifact_${safeIdPart(releaseId)}_${safeIdPart(role)}_${safeIdPart(kind)}_${safeIdPart(version)}`;
  return {
    artifactId,
    kind,
    componentId: decision.componentId,
    version,
    source: releaseArtifactSource(kind),
    url: role === 'launcher' ? input.artifactUrl?.trim() || null : null,
    digest: role === 'launcher' ? input.artifactDigest?.trim() || null : null,
    signature: role === 'launcher' ? input.artifactSignature?.trim() || null : null,
    sizeBytes: role === 'launcher' && typeof input.artifactSizeBytes === 'number' && Number.isFinite(input.artifactSizeBytes)
      ? input.artifactSizeBytes
      : null,
    platform: role === 'launcher' ? input.artifactPlatform?.trim() || null : null,
    arch: role === 'launcher' ? input.artifactArch?.trim() || null : null,
    fileName: role === 'launcher' ? input.artifactFileName?.trim() || null : null,
    activation,
    autoApply: decision.updateMode === 'automatic' && activation !== 'installer-manual',
    restartRequired: releaseActivationNeedsRestart(activation),
    requiredAppRestart: activation === 'restart-auto' || activation === 'restart-manual' || activation === 'installer-manual',
    notes: [
      decision.reason,
      activation === 'installer-manual'
        ? 'full installer download is explicit and restarts after user confirmation'
        : 'staged update reports status back to Internal Release Center'
    ]
  };
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
  if (kind === 'renderer-ui' || kind === 'launcher-npm' || kind === 'launcher-asar' || kind === 'app-asar') {
    return {
      updateMode: 'automatic',
      canSkip: false,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: `${kind} updates are staged by Internal Release Center and applied automatically after gate`
    };
  }
  if (kind === 'feature-flag') {
    return {
      updateMode: 'automatic',
      canSkip: false,
      canDefer: false,
      requiresGate: false,
      rollbackRequired: true,
      reason: 'feature flags are hot-applied from signed Internal config snapshots'
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
  if (kind === 'app-installer') {
    return {
      updateMode: 'mandatory',
      canSkip: false,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'standalone launcher updates require a signed full installer and explicit user confirmation'
    };
  }
  if (kind === 'mx-h2i-installer') {
    return {
      updateMode: 'mandatory',
      canSkip: false,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'MX-H2I major updates require a signed full installer and explicit user confirmation'
    };
  }
  if (kind === 'native-helper') {
    return {
      updateMode: 'mandatory',
      canSkip: false,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'native helper updates are privileged and gated before activation'
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
  if (kind === 'appcenter-app') {
    return {
      updateMode: 'manual',
      canSkip: true,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'AppCenter app updates follow app-scoped rollout and rollback policy'
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
  const hasUpdate = parts.launcherDecision.updateAvailable || parts.appDecision.updateAvailable;
  const decisions = buildReleaseManagementDecisions(parts.launcherDecision, parts.appDecision, parts.gate);
  const artifacts = [
    buildReleaseArtifactRef(input, parts.launcherDecision, 'launcher', parts.releaseId),
    buildReleaseArtifactRef(input, parts.appDecision, 'app', parts.releaseId)
  ].filter((artifact): artifact is ReleaseArtifactRef => Boolean(artifact));
  const rolloutStrategy = normalizeReleaseRolloutStrategy(input.rolloutStrategy);
  const rolloutPercentage = typeof input.rolloutPercentage === 'number' && Number.isFinite(input.rolloutPercentage)
    ? Math.max(0, Math.min(100, input.rolloutPercentage))
    : rolloutStrategy === 'all' ? 100 : 10;
  const activationModes = artifacts.map((artifact) => artifact.activation);
  const majorUpdateRequiresInstaller = artifacts.some((artifact) => artifact.activation === 'installer-manual');
  const deliveryMode = normalizeReleaseDeliveryMode(input.deliveryMode, {
    allowSilent: !majorUpdateRequiresInstaller,
    fallback: 'prompt-download-restart'
  });
  return {
    planId: parts.planId,
    releaseId: parts.releaseId,
    productId: input.productId?.trim() || input.launcherComponentId?.trim() || input.appId?.trim() || 'mx-h2i',
    environment: config.environment,
    channel: input.channel?.trim() || 'shadow',
    installId: input.installId ?? null,
    userId: input.userId ?? null,
    createdBy: input.createdBy?.trim() || 'release-admin-shadow',
    requestId: input.requestId?.trim() || null,
    publisherRequestFingerprint: input.publisherRequestFingerprint?.trim() || null,
    components: {
      launcher: parts.launcherDecision,
      app: parts.appDecision
    },
    artifacts,
    rollout: {
      strategy: rolloutStrategy,
      percentage: rolloutPercentage,
      segmentId: input.rolloutSegment?.trim() || `${input.channel?.trim() || 'shadow'}-${rolloutStrategy}`,
      rings: input.rolloutRings?.length ? input.rolloutRings : ['internal-dogfood', 'canary', 'stable'],
      featureKeys: input.featureKeys ?? [],
      channels: [input.channel?.trim() || 'shadow'],
      audience: {
        installIds: uniqueAudienceIds([input.installId, ...(input.targetInstallIds ?? [])]),
        userIds: uniqueAudienceIds([input.userId, ...(input.targetUserIds ?? [])]),
        siteIds: input.sites ?? []
      },
      allowAutoPromote: rolloutStrategy !== 'manual-ring' && parts.gate.verdict === 'passed',
      canaryMetricGate: 'release.e2e.passed && update.error_rate < 0.02'
    },
    activation: {
      checkSource: 'internal-postgres',
      hotUpdateAuto: artifacts.some((artifact) => artifact.autoApply && !artifact.restartRequired),
      hotUpdateToast: artifacts.some((artifact) => artifact.autoApply),
      majorUpdateRequiresInstaller,
      restartAfterApply: activationModes.includes('restart-auto') || activationModes.includes('installer-manual'),
      manualConfirmRequired: majorUpdateRequiresInstaller || activationModes.includes('restart-manual'),
      connectionSafeMode: true
    },
    releaseNotes: input.releaseNotes?.trim() || null,
    deliveryMode,
    test: {
      suiteId: parts.testRun.suiteId,
      topology: parts.testRun.topology,
      sites: parts.testRun.sites,
      run: parts.testRun,
      gate: parts.gate
    },
    decisions: {
      ...decisions
    },
    createdAt: parts.createdAt
  };
}

export function updateReleaseManagementPlanMetadata(
  plan: ReleaseManagementPlan,
  input: ReleaseManagementPlanPatchInput,
  updatedAt = new Date().toISOString()
): ReleaseManagementPlan {
  const rollout = plan.rollout ?? {
    strategy: 'all',
    percentage: 100,
    segmentId: `${plan.channel}-all`,
    rings: [],
    featureKeys: [],
    channels: [plan.channel],
    audience: {
      installIds: [],
      userIds: [],
      siteIds: []
    },
    allowAutoPromote: false,
    canaryMetricGate: 'release-e2e'
  };
  const audience = rollout.audience ?? {
    installIds: [],
    userIds: [],
    siteIds: []
  };
  const channel = input.channel?.trim() || plan.channel;
  const strategy = input.rolloutStrategy === undefined
    ? rollout.strategy
    : normalizeReleaseRolloutStrategy(input.rolloutStrategy);
  const percentage = input.rolloutPercentage === undefined || input.rolloutPercentage === null
    ? rollout.percentage
    : Math.max(0, Math.min(100, input.rolloutPercentage));
  const installerOnlyDelivery = plan.artifacts.some((artifact) => artifact.activation === 'installer-manual');
  const deliveryMode = input.deliveryMode === undefined
    ? plan.deliveryMode ?? 'prompt-download-restart'
    : normalizeReleaseDeliveryMode(input.deliveryMode, {
        allowSilent: !installerOnlyDelivery,
        fallback: 'prompt-download-restart'
      });
  return {
    ...plan,
    channel,
    releaseNotes: input.releaseNotes === undefined
      ? plan.releaseNotes
      : input.releaseNotes?.trim() || null,
    deliveryMode,
    rollout: {
      ...rollout,
      strategy,
      percentage,
      segmentId: input.rolloutSegment === undefined
        ? rollout.segmentId
        : input.rolloutSegment?.trim() || `${channel}-${strategy}`,
      rings: input.rolloutRings === undefined ? rollout.rings : input.rolloutRings,
      featureKeys: input.featureKeys === undefined ? rollout.featureKeys : input.featureKeys,
      channels: [channel],
      audience: {
        ...audience,
        installIds: input.targetInstallIds === undefined
          ? audience.installIds
          : uniqueAudienceIds(input.targetInstallIds),
        userIds: input.targetUserIds === undefined
          ? audience.userIds
          : uniqueAudienceIds(input.targetUserIds)
      },
      allowAutoPromote: strategy !== 'manual-ring' && plan.test.gate.verdict === 'passed'
    },
    updatedAt,
    updatedBy: input.updatedBy?.trim() || null
  };
}

function normalizeReleaseDeliveryMode(
  value: ReleaseDeliveryMode | string | null | undefined,
  options: { allowSilent: boolean; fallback: ReleaseDeliveryMode }
): ReleaseDeliveryMode {
  if (value === 'manual-download') return 'manual-download';
  if (value === 'silent-download-next-start' && options.allowSilent) return 'silent-download-next-start';
  if (value === 'prompt-download-restart') return 'prompt-download-restart';
  return options.fallback;
}

function uniqueAudienceIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value)))];
}

export function buildReleaseManagementDecisions(
  launcherDecision: ReleasePolicyDecision,
  appDecision: ReleasePolicyDecision,
  gate: TestGateVerdict
): ReleaseManagementPlan['decisions'] {
  const requiresApproval = launcherDecision.requiresGate
    || appDecision.requiresGate
    || launcherDecision.updateMode === 'mandatory'
    || appDecision.updateMode === 'mandatory';
  const hasUpdate = launcherDecision.updateAvailable || appDecision.updateAvailable;
  const readyToPromote = gate.verdict === 'passed' && hasUpdate;
  const rollbackRequired = launcherDecision.rollbackRequired || appDecision.rollbackRequired;
  const nextActions: string[] = [];
  if (gate.verdict !== 'passed') {
    nextActions.push('complete-required-e2e-gate');
  }
  if (requiresApproval) {
    nextActions.push('request-release-approval');
  }
  if (readyToPromote) {
    nextActions.push('open-canary-or-shadow-rollout');
  }
  if (rollbackRequired) {
    nextActions.push('prepare-rollback-slot');
  }
  return {
    readyToPromote,
    requiresApproval,
    canaryAllowed: readyToPromote,
    rollbackRequired,
    nextActions
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
    ? input.domesticRuntimeConfig ?? buildSiteSlotDomesticRuntimeConfig(config, { siteId }, null, createdAt)
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
      : previous?.internalDirectEnabled ?? true;
  const material = {
    domesticRelayPrivateKey: input.domesticRelayPrivateKey?.trim() || previous?.domesticRelayPrivateKey || null,
    domesticRelayPublicKey: input.domesticRelayPublicKey?.trim() || previous?.domesticRelayPublicKey || null,
    internalServicePrivateKey: input.internalServicePrivateKey?.trim() || previous?.internalServicePrivateKey || null,
    internalServicePublicKey: input.internalServicePublicKey?.trim() || previous?.internalServicePublicKey || null
  };
  const missingSecretInputs = [
    validWireGuardKeyMaterial(material.domesticRelayPrivateKey) ? null : 'MX_DOMESTIC_RELAY_PRIVATE_KEY',
    validWireGuardKeyMaterial(material.domesticRelayPublicKey) ? null : 'MX_DOMESTIC_RELAY_PUBLIC_KEY',
    validWireGuardKeyMaterial(material.internalServicePrivateKey) ? null : 'MX_INTERNAL_SERVICE_PRIVATE_KEY',
    validWireGuardKeyMaterial(material.internalServicePublicKey) ? null : 'MX_INTERNAL_SERVICE_PUBLIC_KEY',
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

export function buildSiteSlotInternalServicePeerObservation(
  input: SiteSlotInternalServicePeerObservationInput,
  now = new Date().toISOString()
): SiteSlotInternalServicePeerObservation {
  const siteId = input.siteId.trim();
  const planId = input.planId.trim();
  const materialDigest = input.materialDigest.trim();
  if (!siteId || !planId || !materialDigest) {
    throw new Error('siteId, planId, and materialDigest are required for Internal service peer observations');
  }
  const checkedAt = input.checkedAt?.trim() || null;
  const checkedAtMs = checkedAt ? Date.parse(checkedAt) : NaN;
  return {
    observationId: `internalpeerobs_${safeIdPart(planId)}`,
    siteId,
    planId,
    materialDigest,
    workerReportId: input.workerReportId?.trim() || null,
    status: input.status,
    sourceAction: input.sourceAction,
    blockedReasons: uniqueStrings(input.blockedReasons ?? []).slice(0, 20).map((reason) => reason.slice(0, 600)),
    checkedAt: Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : null,
    recordedBy: input.requestedBy?.trim() || 'admin-action',
    recordedAt: now
  };
}

function validWireGuardKeyMaterial(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.trim());
}

export function buildSiteSlotDomesticRuntimeConfig(
  config: RuntimeConfig,
  input: SiteSlotDomesticRuntimeConfigInput,
  previous: SiteSlotDomesticRuntimeConfig | null,
  now = new Date().toISOString()
): SiteSlotDomesticRuntimeConfig {
  const siteId = input.siteId?.trim() || previous?.siteId || 'domestic-main';
  const status = input.status === 'paused' ? 'paused' : 'active';
  const requestedEdgeBind = input.edgeBind?.trim() || previous?.edge.bind || '127.0.0.1';
  const edgeBind = validIpv4Address(requestedEdgeBind) ? requestedEdgeBind : '127.0.0.1';
  const edgePort = positivePort(input.edgePort, previous?.edge.port, 18090);
  const bootstrapProtocol = normalizeProtocol(input.bootstrapProtocol || previousBootstrapProtocol(previous) || 'https');
  const requestedBootstrapHost = input.bootstrapHost?.trim()
    || previousBootstrapHost(previous)
    || MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST;
  const normalizedBootstrapHost = normalizePublicTlsDnsHostname(requestedBootstrapHost);
  const usesLegacyBootstrapHost = normalizedBootstrapHost === MX_LEGACY_PUBLIC_BOOTSTRAP_HOST;
  const bootstrapHost = usesLegacyBootstrapHost
    ? MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST
    : normalizedBootstrapHost || MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST;
  const bootstrapPort = positivePort(input.bootstrapPort, previousBootstrapPort(previous), 443);
  const requestedPublicGatewayNetwork = input.publicGatewayNetwork?.trim()
    || previous?.env.MX_DOMESTIC_PUBLIC_GATEWAY_NETWORK
    || 'compass-gateway_default';
  const publicGatewayNetwork = validDockerNetworkName(requestedPublicGatewayNetwork)
    ? requestedPublicGatewayNetwork
    : 'compass-gateway_default';
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
    bootstrapHost,
    bootstrapPort,
    publicGatewayNetwork,
    dnsBind,
    dnsPort
  });
  const warnings = [
    ...(status === 'paused' ? ['blocked: Domestic runtime config is paused'] : []),
    ...(!isHttpUrl(internalApi) ? [`blocked: internalApiUpstream must be http(s): ${internalApi}`] : []),
    ...(!isHttpUrl(internalH2i) ? [`blocked: internalH2iUpstream must be http(s): ${internalH2i}`] : []),
    ...(bootstrapProtocol !== 'https' ? ['blocked: public bootstrapProtocol must be https'] : []),
    ...(!normalizedBootstrapHost
      ? [`blocked: bootstrapHost must be one ASCII DNS hostname, not an IP, URL, port, or Caddyfile fragment: ${JSON.stringify(requestedBootstrapHost.slice(0, 120))}`]
      : []),
    ...(usesLegacyBootstrapHost
      ? [`legacy-public-bootstrap-host: migrated ${MX_LEGACY_PUBLIC_BOOTSTRAP_HOST} to ${MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST}`]
      : []),
    ...(!validDockerNetworkName(requestedPublicGatewayNetwork)
      ? [`blocked: publicGatewayNetwork must be one Docker network name: ${JSON.stringify(requestedPublicGatewayNetwork.slice(0, 120))}`]
      : []),
    ...(!validIpv4Address(requestedEdgeBind)
      ? [`blocked: edgeBind must be one IPv4 address: ${JSON.stringify(requestedEdgeBind.slice(0, 64))}`]
      : []),
    ...(bootstrapPort !== 443 ? [`blocked: public bootstrapPort must be 443 for ACME and desktop trust; received ${bootstrapPort}`] : []),
    ...(edgePort === 80 || edgePort === 443 ? [`blocked: legacy edgePort ${edgePort} conflicts with the public HTTP/HTTPS listeners`] : []),
    ...(edgeBind === '0.0.0.0' ? ['public-bind: Domestic edge listens on all interfaces; protect with cloud firewall/security group'] : []),
    ...(dnsBind === '0.0.0.0' ? [`dns-public-bind: Domestic DNS edge listens on UDP/TCP ${dnsPort}; restrict sources with firewall/security group`] : []),
    ...(dnsBind === '10.88.0.1' ? ['dns-wg-only: Domestic DNS edge is bound to WireGuard; clients cannot use it before WG is up'] : []),
    ...(bootstrapHost === MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST
      ? [`tls-domain: ensure public DNS points ${MX_DEFAULT_PUBLIC_BOOTSTRAP_HOST} to this Domestic host before apply`]
      : [])
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
  bootstrapHost: string;
  bootstrapPort: number;
  publicGatewayNetwork: string;
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
    MX_DOMESTIC_BOOTSTRAP_HOST: input.bootstrapHost,
    MX_DOMESTIC_PUBLIC_GATEWAY_NETWORK: input.publicGatewayNetwork,
    MX_DOMESTIC_HTTPS_BIND: '0.0.0.0',
    MX_DOMESTIC_HTTPS_PORT: String(input.bootstrapPort),
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

function normalizePublicTlsDnsHostname(value: string | null | undefined): string | null {
  const hostname = value?.trim().toLowerCase().replace(/\.$/, '') || '';
  if (!hostname || hostname.length > 253 || isIpv4(hostname)) return null;
  const labels = hostname.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) return null;
  return hostname;
}

function validIpv4Address(value: string | null | undefined): boolean {
  const parts = String(value || '').split('.');
  return parts.length === 4 && parts.every((part) => (
    /^(?:0|[1-9]\d{0,2})$/.test(part)
    && Number(part) >= 0
    && Number(part) <= 255
  ));
}

function validDockerNetworkName(value: string | null | undefined): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(value || '');
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

export function buildSecretProviderConfig(
  config: RuntimeConfig,
  input: SecretProviderConfigInput,
  previous: SecretProviderConfig | null,
  now = new Date().toISOString()
): SecretProviderConfig {
  const kind = secretProviderKind(input.kind ?? previous?.kind);
  const providerId = input.providerId?.trim() || previous?.providerId || `secretprov_${safeIdPart(kind)}`;
  const status = secretProviderStatus(input.status ?? previous?.status);
  const endpoint = input.endpoint?.trim() || previous?.endpoint || null;
  const region = input.region?.trim() || previous?.region || null;
  const authMode = secretProviderAuthMode(input.authMode ?? previous?.authMode, kind);
  const warnings: string[] = [];
  if (kind === 'alibaba-kms' && !region) warnings.push('missing: region is required before Alibaba KMS materialization');
  if (kind === 'vault' && !endpoint) warnings.push('missing: endpoint is required before Vault materialization');
  if (status === 'paused') warnings.push('paused: provider cannot materialize new secret versions');
  return {
    providerId,
    name: input.name?.trim() || previous?.name || defaultSecretProviderName(kind),
    kind,
    environment: config.environment,
    status,
    endpoint,
    region,
    authMode,
    source: 'config-center',
    capabilities: secretProviderCapabilities(kind),
    warnings,
    createdBy: previous?.createdBy || input.requestedBy?.trim() || 'config-center',
    createdAt: previous?.createdAt || now,
    updatedBy: input.requestedBy?.trim() || previous?.updatedBy || 'config-center',
    updatedAt: now
  };
}

export function buildConfigSecretReference(
  config: RuntimeConfig,
  input: ConfigSecretReferenceInput,
  previous: ConfigSecretReference | null,
  providerExists = true,
  now = new Date().toISOString()
): ConfigSecretReference {
  const providerId = required(
    input.providerId?.trim() || previous?.providerId || null,
    'providerId is required'
  );
  const remoteRef = required(
    input.remoteRef?.trim() || previous?.remoteRef || null,
    'remoteRef is required'
  );
  const consumerIds = configSecretConsumerIds(input.consumerIds, previous?.consumerIds);
  const status = input.status
    ? input.status === 'paused' ? 'paused' : 'active'
    : previous?.status ?? 'active';
  const exposure = configSecretExposure(input.exposure ?? previous?.exposure);
  const warnings: string[] = [];
  if (!providerExists) warnings.push(`provider-not-found: ${providerId}`);
  if (consumerIds.length === 0) warnings.push('missing: at least one consumerId is required before materialization');
  if (status === 'paused') warnings.push('paused: reference is not available to consumers');
  return {
    secretRefId: input.secretRefId?.trim() || previous?.secretRefId || `secretref_${safeIdPart(remoteRef)}`,
    name: input.name?.trim() || previous?.name || remoteRef,
    providerId,
    remoteRef,
    environment: config.environment,
    status,
    productId: input.productId?.trim() || previous?.productId || null,
    appId: input.appId?.trim() || previous?.appId || null,
    consumerIds,
    exposure,
    versionStage: input.versionStage?.trim() || previous?.versionStage || 'ACSCurrent',
    rotationMode: configSecretRotationMode(input.rotationMode ?? previous?.rotationMode),
    target: {
      namespace: input.targetNamespace?.trim() || previous?.target.namespace || 'mx-internal-shadow',
      secretName: input.targetSecretName?.trim() || previous?.target.secretName || 'mx-app-secrets'
    },
    source: 'config-center',
    containsSecretMaterial: false,
    warnings,
    createdBy: previous?.createdBy || input.requestedBy?.trim() || 'config-center',
    createdAt: previous?.createdAt || now,
    updatedBy: input.requestedBy?.trim() || previous?.updatedBy || 'config-center',
    updatedAt: now
  };
}

export function builtinSecretProviderConfigs(config: RuntimeConfig): SecretProviderConfig[] {
  return [buildSecretProviderConfig(config, {
    providerId: 'secretprov_kubernetes_runtime',
    name: 'Kubernetes Runtime Secret',
    kind: 'kubernetes',
    status: 'active',
    authMode: 'native-secret',
    requestedBy: 'builtin'
  }, null)];
}

export function builtinConfigSecretReferences(config: RuntimeConfig): ConfigSecretReference[] {
  return [
    buildConfigSecretReference(config, {
      secretRefId: 'secretref_release_oss',
      name: 'Release Center OSS',
      providerId: 'secretprov_kubernetes_runtime',
      remoteRef: 'mx-release-oss',
      status: 'active',
      consumerIds: ['release-center'],
      exposure: 'signed-url',
      versionStage: 'runtime',
      rotationMode: 'manual',
      targetNamespace: 'mx-internal-shadow',
      targetSecretName: 'mx-release-oss',
      requestedBy: 'builtin'
    }, null),
    buildConfigSecretReference(config, {
      secretRefId: 'secretref_sdk_service_account_credentials',
      name: 'Legacy SDK Service Account Credential Import',
      providerId: 'secretprov_kubernetes_runtime',
      remoteRef: 'mx-sdk-service-account-secrets',
      status: 'paused',
      consumerIds: ['sdk-gateway-migration'],
      exposure: 'internal-only',
      versionStage: 'legacy-migration',
      rotationMode: 'manual',
      targetNamespace: 'mx-internal-shadow',
      targetSecretName: 'mx-sdk-service-account-secrets',
      requestedBy: 'builtin'
    }, null)
  ];
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
      redactOutput: siteSlotWorkerStepRedactOutput(step)
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

function siteSlotWorkerStepRedactOutput(step: SiteSlotRunnerSession['stepResults'][number]): boolean {
  const command = step.command;
  if (step.sourceId.startsWith('verify-domestic-egress.')) return false;
  if (command.includes('subscription') || command.includes('tunnel-state.json') || command.includes('DATABASE_URL')) return true;
  return /(^|[^A-Za-z0-9_])(?:authToken|AUTH_TOKEN|accessToken|ACCESS_TOKEN|token|TOKEN)(?:=|:)/.test(command);
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
  const overseaAccessStackStateDir = '/opt/mx/state/hysteria2-access-stack';
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
  const switchCurrentSymlink = (releaseDir: string, currentDir: string) => {
    const legacyCurrentDir = `${currentDir}.legacy-${releaseRevision}`;
    return [
      `if test -d ${currentDir} && ! test -L ${currentDir}; then`,
      `if test -e ${legacyCurrentDir} || test -L ${legacyCurrentDir}; then echo "blocked: legacy current directory backup already exists: ${legacyCurrentDir}" >&2; exit 1; fi;`,
      `mv ${currentDir} ${legacyCurrentDir};`,
      'fi;',
      `ln -sfnT ${releaseDir} ${currentDir}`
    ].join(' ');
  };
  const prepareOverseaAccessStackState = [
    `install -d -m 0700 ${overseaAccessStackStateDir} ${overseaAccessStackStateDir}/data ${overseaAccessStackStateDir}/config`,
    `if ! test -e ${overseaAccessStackStateDir}/.initialized; then if test -f ${overseaAccessStackCurrentDir}/.env && ! test -L ${overseaAccessStackCurrentDir}/.env; then cp -a ${overseaAccessStackCurrentDir}/.env ${overseaAccessStackStateDir}/.env; fi; if test -d ${overseaAccessStackCurrentDir}/data && ! test -L ${overseaAccessStackCurrentDir}/data; then cp -a ${overseaAccessStackCurrentDir}/data/. ${overseaAccessStackStateDir}/data/; fi; if test -d ${overseaAccessStackCurrentDir}/config && ! test -L ${overseaAccessStackCurrentDir}/config; then cp -a ${overseaAccessStackCurrentDir}/config/. ${overseaAccessStackStateDir}/config/; fi; touch ${overseaAccessStackStateDir}/.initialized; chmod 0600 ${overseaAccessStackStateDir}/.initialized; fi`,
    `if ! test -f ${overseaAccessStackStateDir}/.env; then cp ${overseaAccessStackReleaseDir}/.env.example ${overseaAccessStackStateDir}/.env; fi`,
    `chmod 0600 ${overseaAccessStackStateDir}/.env`,
    `rm -rf ${overseaAccessStackReleaseDir}/data ${overseaAccessStackReleaseDir}/config`,
    `rm -f ${overseaAccessStackReleaseDir}/.env`,
    `ln -sfnT ${overseaAccessStackStateDir}/data ${overseaAccessStackReleaseDir}/data`,
    `ln -sfnT ${overseaAccessStackStateDir}/config ${overseaAccessStackReleaseDir}/config`,
    `ln -sfnT ${overseaAccessStackStateDir}/.env ${overseaAccessStackReleaseDir}/.env`
  ].join('; ');
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
  const overseaSystemSubscriptionAccountName = systemSubscriptionAccessAccountName(overseaSiteId);
  const domesticBootstrapSubscriptionUrl = `${overseaSubscriptionBaseUrl}/${overseaDomesticAccountName}.yaml`;
  const domesticTunnelInstallWrapperCommand = `printf "%s\\n" "#!/usr/bin/env sh" "exec ${domesticTunnelCliCurrentDir}/bin/qp-tunnel-cli \\"\\$@\\"" > /usr/local/bin/qp-tunnel-cli && chmod 0755 /usr/local/bin/qp-tunnel-cli`;
  const qpTunnelCliVersionProbe = (command: string) => `${command} --version 2>/dev/null || ${command} version 2>/dev/null || ${command} -v 2>/dev/null || ${command} help 2>/dev/null | sed -n "1p" || echo unknown`;
  const qpTunnelCliRequiredHelpNeedle = 'MIHOMO_TUN_ROUTE_EXCLUDE_ADDRESS';
  const qpTunnelCliFeatureProbe = (command: string) => `${command} help 2>/dev/null | grep -q "${qpTunnelCliRequiredHelpNeedle}"`;
  const domesticTunnelInitialCliRefreshCommand = `if command -v npm >/dev/null 2>&1; then echo "attempt pre-egress npm install @qpjoy/tunnel-cli@latest"; if command -v timeout >/dev/null 2>&1; then timeout 45 npm i -g @qpjoy/tunnel-cli@latest --force || echo "warning: pre-egress npm refresh failed; using Internal-pushed fallback"; else npm i -g @qpjoy/tunnel-cli@latest --force || echo "warning: pre-egress npm refresh failed; using Internal-pushed fallback"; fi; else echo "node/npm absent before egress; using Internal-pushed fallback"; fi`;
  const domesticTunnelSelectCliCommand = `if command -v qp-tunnel-cli >/dev/null 2>&1 && ${qpTunnelCliFeatureProbe('qp-tunnel-cli')}; then QP_TUNNEL_CLI="$(command -v qp-tunnel-cli)"; QP_TUNNEL_CLI_KIND=global-qp-tunnel-cli; else echo "global qp-tunnel-cli missing or lacks ${qpTunnelCliRequiredHelpNeedle}; using Internal-pushed fallback"; ${domesticTunnelInstallWrapperCommand}; QP_TUNNEL_CLI="$INTERNAL_QP_TUNNEL_CLI"; QP_TUNNEL_CLI_KIND=internal-pushed-fallback; fi`;
  const domesticTunnelModeCommand = '{ QP_TUNNEL_MODE=${QP_TUNNEL_MODE:-egress-on}; case "$QP_TUNNEL_MODE" in server|server-on|egress|egress-on) if "$QP_TUNNEL_CLI" help 2>/dev/null | grep -q "egress-on"; then "$QP_TUNNEL_CLI" egress-on; elif "$QP_TUNNEL_CLI" help 2>/dev/null | grep -q "server-on"; then echo "warning: selected tunnel cli lacks egress-on; falling back to server-on"; "$QP_TUNNEL_CLI" server-on; else echo "blocked: selected tunnel cli does not support egress-on/server-on"; exit 1; fi ;; tun|tun-on) if "$QP_TUNNEL_CLI" help 2>/dev/null | grep -q "tun-on"; then "$QP_TUNNEL_CLI" tun-on; else echo "blocked: selected tunnel cli does not support tun-on"; exit 1; fi ;; *) echo "blocked: unsupported QP_TUNNEL_MODE=$QP_TUNNEL_MODE"; exit 1 ;; esac; }';
  const domesticTunnelPostEgressRefreshCommand = `if test -f /etc/profile.d/mihomo-client-proxy.sh; then . /etc/profile.d/mihomo-client-proxy.sh || true; fi; echo "Internal-pushed qp-tunnel-cli fallback version: $(${qpTunnelCliVersionProbe('"$INTERNAL_QP_TUNNEL_CLI"')})"; if command -v npm >/dev/null 2>&1; then if npm i -g @qpjoy/tunnel-cli@latest --force; then echo "npm-installed qp-tunnel-cli version: $(${qpTunnelCliVersionProbe('qp-tunnel-cli')})"; if ${qpTunnelCliFeatureProbe('qp-tunnel-cli')}; then qp-tunnel-cli install-script || true; qp-tunnel-cli egress-on || qp-tunnel-cli server-on || true; qp-tunnel-cli status || echo "warning: @qpjoy/tunnel-cli npm refresh status failed after egress-on; keep Internal fallback"; else echo "warning: npm-installed qp-tunnel-cli lacks ${qpTunnelCliRequiredHelpNeedle}; restoring Internal-pushed fallback"; ${domesticTunnelInstallWrapperCommand}; echo "restored Internal-pushed qp-tunnel-cli version: $(${qpTunnelCliVersionProbe('qp-tunnel-cli')})"; fi; else echo "warning: @qpjoy/tunnel-cli@latest npm refresh skipped after egress-on; keep Internal fallback"; ${domesticTunnelInstallWrapperCommand}; echo "restored Internal-pushed qp-tunnel-cli version: $(${qpTunnelCliVersionProbe('qp-tunnel-cli')})"; fi; else echo "node/npm absent; keep Internal fallback until next refresh"; fi`;
  const domesticEgressProxyReadinessCommand = [
    'set -eu',
    'if test -f /etc/profile.d/mihomo-client-proxy.sh; then . /etc/profile.d/mihomo-client-proxy.sh || true; fi',
    'echo "diagnostics: qp-tunnel-cli"',
    `if command -v qp-tunnel-cli >/dev/null 2>&1; then echo "qp-tunnel-cli version: $(${qpTunnelCliVersionProbe('qp-tunnel-cli')})"; qp-tunnel-cli status || true; else echo "blocked: qp-tunnel-cli missing after Domestic egress bootstrap"; exit 1; fi`,
    'if command -v systemctl >/dev/null 2>&1; then systemctl is-active --quiet mihomo-client || { systemctl status mihomo-client --no-pager -l || true; echo "blocked: mihomo-client service is not active after egress-on"; exit 1; }; fi',
    'if command -v ss >/dev/null 2>&1; then ss -ltnp 2>/dev/null | grep ":7788" || true; fi',
    'if command -v curl >/dev/null 2>&1; then curl -fsSIL --http1.1 --max-time 20 --proxy http://127.0.0.1:7788 https://www.gstatic.com/generate_204 >/tmp/mx-egress-probe.headers || { echo "blocked: generic HTTPS is not reachable through local egress proxy"; curl -Iv --http1.1 --max-time 20 --proxy http://127.0.0.1:7788 https://www.gstatic.com/generate_204 || true; if command -v journalctl >/dev/null 2>&1; then journalctl -u mihomo-client -n 80 --no-pager -l || true; fi; exit 1; }; sed -n "1,6p" /tmp/mx-egress-probe.headers; curl -sSI --http1.1 --max-time 20 --proxy http://127.0.0.1:7788 "https://auth.docker.io/token?service=registry.docker.io" >/tmp/mx-docker-auth-probe.headers || { echo "blocked: Docker auth endpoint is not reachable through local egress proxy"; curl -Iv --http1.1 --max-time 20 --proxy http://127.0.0.1:7788 "https://auth.docker.io/token?service=registry.docker.io" || true; if command -v journalctl >/dev/null 2>&1; then journalctl -u mihomo-client -n 80 --no-pager -l || true; fi; exit 1; }; sed -n "1,6p" /tmp/mx-docker-auth-probe.headers; curl -sSI --http1.1 --max-time 20 --proxy http://127.0.0.1:7788 https://registry-1.docker.io/v2/ >/tmp/mx-registry-probe.headers || { echo "blocked: Docker registry is not reachable through local egress proxy"; curl -Iv --http1.1 --max-time 20 --proxy http://127.0.0.1:7788 https://registry-1.docker.io/v2/ || true; if command -v journalctl >/dev/null 2>&1; then journalctl -u mihomo-client -n 80 --no-pager -l || true; fi; exit 1; }; sed -n "1,6p" /tmp/mx-registry-probe.headers; else echo "warning: curl missing; skip registry proxy probe"; fi',
    'if command -v systemctl >/dev/null 2>&1; then systemctl show docker -p Environment || true; fi',
    'if command -v docker >/dev/null 2>&1; then docker info >/dev/null; fi'
  ].join('; ');
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
    'if command -v systemctl >/dev/null 2>&1; then systemctl enable mihomo-client >/dev/null 2>&1 || true; fi',
    domesticTunnelInitialCliRefreshCommand,
    domesticTunnelSelectCliCommand,
    `echo "qp-tunnel-cli selected: $QP_TUNNEL_CLI_KIND $QP_TUNNEL_CLI version=$(${qpTunnelCliVersionProbe('"$QP_TUNNEL_CLI"')})"`,
    'test -s "$BOOTSTRAP_SUBSCRIPTION_FILE" || { echo "blocked: local bootstrap subscription file is required before WG relay/Internal URL is reachable: $BOOTSTRAP_SUBSCRIPTION_FILE"; exit 1; }',
    'SUBSCRIPTION_ARGS="--file $BOOTSTRAP_SUBSCRIPTION_FILE"',
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
    'if command -v curl >/dev/null 2>&1; then curl -I --max-time 15 --proxy http://127.0.0.1:7788 https://registry-1.docker.io/v2/ || true; fi;',
    'exit 1;',
    'fi;',
    'fi;',
    'done;',
    'fi;',
    // `--force-recreate` is required, not defensive: the push above swaps the
    // /opt/mx/current/<kind> symlink to a fresh release directory, but compose only
    // sees the unchanged `./<file>` mount string, reports "Running", and leaves the
    // container bound to the previous release's inode. Without this the bundle lands
    // on disk while the service keeps serving the old config -- a silent no-op that
    // looks like a successful deploy. Domestic gets the same treatment inside
    // manage.sh's start_domestic_edge, so a manual `./manage.sh up` behaves too.
    kind === 'domestic'
      ? 'test -x ./manage.sh || { echo "blocked: Domestic service bundle is missing executable manage.sh"; exit 1; }; ./manage.sh up;'
      : 'docker compose up -d --force-recreate;',
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
    `HY2_SYSTEM_SUBSCRIPTION_ACCOUNT=${overseaSystemSubscriptionAccountName}`,
    `HY2_SYSTEM_SUBSCRIPTION_BASIC_USER=${SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID}`,
    `HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT=${SYSTEM_SUBSCRIPTION_MIXED_PORT}`
  ];
  const overseaManagedEnvKeys = overseaEnvLines.map((line) => line.slice(0, line.indexOf('=')));
  const overseaManagedEnvPattern = overseaManagedEnvKeys.join('|');
  const overseaEnvWriteCommand = [
    `env_file=${overseaAccessStackStateDir}/.env`,
    'test -f "$env_file"',
    'tmp_file="$(mktemp "${env_file}.internal.XXXXXX")"',
    `sed -E "/^(${overseaManagedEnvPattern})=/d" "$env_file" > "$tmp_file"`,
    `printf "%s\\n" ${overseaEnvLines.map(shellDoubleQuote).join(' ')} >> "$tmp_file"`,
    'chmod 0600 "$tmp_file"',
    'mv -f "$tmp_file" "$env_file"'
  ].join(' && ');
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
        systemSubscription: username === overseaSystemSubscriptionAccountName,
        upRate: overseaAccessAccountMaterial.get(safeAccountName(username))?.upRate
          || (username === overseaSystemSubscriptionAccountName ? SYSTEM_SUBSCRIPTION_CLIENT_BANDWIDTH : HYSTERIA2_CLIENT_UPLOAD),
        downRate: overseaAccessAccountMaterial.get(safeAccountName(username))?.downRate
          || (username === overseaSystemSubscriptionAccountName ? SYSTEM_SUBSCRIPTION_CLIENT_BANDWIDTH : HYSTERIA2_CLIENT_DOWNLOAD)
      }))
  });
  const overseaTunnelStateBase64 = Buffer.from(overseaTunnelStateJson, 'utf8').toString('base64');
  const overseaSystemSubscriptionToken = overseaAccessAccountMaterial
    .get(safeAccountName(overseaSystemSubscriptionAccountName))?.authToken ?? null;
  const overseaSystemSubscriptionCredentialMarker = overseaSystemSubscriptionToken
    ? `Verify system-subscription-credential-sha256=${hashToken(overseaSystemSubscriptionToken)}`
    : 'Verify system-subscription-credential-sha256=missing';
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
        ssh(`tar -xzf ${incomingDir}/${domesticTunnelCliBundleName} -C ${domesticTunnelCliReleaseDir} && ${switchCurrentSymlink(domesticTunnelCliReleaseDir, domesticTunnelCliCurrentDir)}`),
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
  if (kind === 'domestic' && mode === 'oversea-assisted') {
    phases.push({
      phaseId: 'verify-domestic-egress',
      title: 'Verify Domestic egress proxy before Docker services',
      mode: 'remote-ssh',
      target: 'domestic',
      required: true,
      commands: [
        ssh(domesticEgressProxyReadinessCommand)
      ],
      notes: [
        'Stop before Docker Compose if Domestic cannot reach Docker Hub through the local egress-on proxy.',
        'A failure here means Domestic SSH and artifact push worked, but the Oversea subscription/proxy path is not ready for Docker image pulls.'
      ]
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
        ssh(`set -eu; tar -xzf ${incomingDir}/${overseaAccessStackBundleName} -C ${overseaAccessStackReleaseDir}; ${prepareOverseaAccessStackState}; ${switchCurrentSymlink(overseaAccessStackReleaseDir, overseaAccessStackCurrentDir)}`),
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
          ssh(`umask 077 && printf "%s" ${overseaTunnelStateBase64} | base64 -d > /opt/mx/site-agent/.tunnel-state.json.tmp && chmod 600 /opt/mx/site-agent/.tunnel-state.json.tmp && mv -f /opt/mx/site-agent/.tunnel-state.json.tmp /opt/mx/site-agent/tunnel-state.json`),
          ssh(`cd ${overseaAccessStackCurrentDir} && ./manage.sh reconcile-from-json --state-file /opt/mx/site-agent/tunnel-state.json --mode hysteria2-only`),
          overseaRegistrationCommand,
          ssh(`cd ${overseaAccessStackCurrentDir} && ./manage.sh sync-internal-defaults && ./manage.sh docker-status && ./manage.sh check-system-subscription && curl -fsS http://127.0.0.1:${overseaExportPort}/healthz`),
          overseaSystemSubscriptionCredentialMarker,
          ssh(`cd ${overseaAccessStackCurrentDir} && ./manage.sh status | grep -E "^TLS fingerprint: ([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$"`)
        ],
        notes: [
          'Oversea runs hysteria2 only; Internal runs mihomo and stores subscription/account material.',
          `Port ${overseaExportPort} on Oversea is a protected delivery/health/evidence outlet for one exact system YAML path, clients.csv, and healthz; Internal remains the subscription authority.`,
          'The final read-only fingerprint probe reports only public TLS certificate metadata; credential-bearing verification output remains redacted.',
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
        ssh(`install -d -m 0700 /etc/wireguard && install -d -m 0755 ${slotReleaseDir}`),
        rsyncOverSsh(domesticWireGuardConfig, '/etc/wireguard/mx-domestic.conf'),
        rsyncOverSsh(domesticRelayEnv, `${slotReleaseDir}/mx-domestic-relay.env`),
        ssh(domesticLegacyWireGuardCompatCommand),
        ssh('if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi; chmod 600 /etc/wireguard/mx-domestic.conf; if command -v systemctl >/dev/null 2>&1; then systemctl enable wg-quick@mx-domestic >/dev/null 2>&1 || true; systemctl restart wg-quick@mx-domestic; else wg-quick down mx-domestic >/dev/null 2>&1 || true; wg-quick up mx-domestic; fi; ip -4 addr replace 10.88.0.1/16 dev mx-domestic; ip link set up dev mx-domestic; sysctl -w net.ipv4.ip_forward=1; if command -v iptables >/dev/null 2>&1; then iptables -C FORWARD -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -i mx-domestic -o mx-domestic -j ACCEPT; if iptables -S DOCKER-USER >/dev/null 2>&1; then iptables -C DOCKER-USER -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -i mx-domestic -o mx-domestic -j ACCEPT; fi; for dns_port in 53 50053; do iptables -C INPUT -i mx-domestic -p udp --dport "$dns_port" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i mx-domestic -p udp --dport "$dns_port" -j ACCEPT; iptables -C INPUT -i mx-domestic -p tcp --dport "$dns_port" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i mx-domestic -p tcp --dport "$dns_port" -j ACCEPT; done; fi; for route_cidr in 10.89.0.0/16 10.90.0.0/16; do ip route replace "$route_cidr" dev mx-domestic; done; ip -4 address show dev mx-domestic; ip route get 10.89.100.1 || true')
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
          ? ssh(`tar -xzf ${incomingDir}/${slotServiceBundleName} -C ${slotReleaseDir} && ${switchCurrentSymlink(slotReleaseDir, slotCurrentDir)} && ${overseaSlotServiceEnvWriteCommand} && cd ${slotCurrentDir} && ${startSlotServicesCommand}`)
          : ssh(`tar -xzf ${incomingDir}/${slotServiceBundleName} -C ${slotReleaseDir} && ${switchCurrentSymlink(slotReleaseDir, slotCurrentDir)} && ${domesticEnvWriteCommand} && cd ${slotCurrentDir} && ${startSlotServicesCommand}`)
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

function secretProviderKind(value: SecretProviderConfigInput['kind']): SecretProviderKind {
  if (value === 'alibaba-kms' || value === 'vault') return value;
  return 'kubernetes';
}

function secretProviderStatus(value: SecretProviderConfigInput['status']): SecretProviderStatus {
  return value === 'paused' ? 'paused' : 'active';
}

function secretProviderAuthMode(
  value: SecretProviderConfigInput['authMode'],
  kind: SecretProviderKind
): SecretProviderAuthMode {
  if (
    value === 'native-secret'
    || value === 'ecs-ram-role'
    || value === 'rrsa'
    || value === 'application-access-point'
    || value === 'token'
  ) return value;
  if (kind === 'alibaba-kms') return 'ecs-ram-role';
  if (kind === 'vault') return 'token';
  return 'native-secret';
}

function defaultSecretProviderName(kind: SecretProviderKind): string {
  if (kind === 'alibaba-kms') return 'Alibaba KMS Secrets Manager';
  if (kind === 'vault') return 'HashiCorp Vault';
  return 'Kubernetes Secret';
}

function secretProviderCapabilities(kind: SecretProviderKind): SecretProviderConfig['capabilities'] {
  if (kind === 'kubernetes') return ['reference', 'kubernetes-materialization'];
  return ['reference', 'version', 'rotation', 'kubernetes-materialization'];
}

function configSecretConsumerIds(
  value: ConfigSecretReferenceInput['consumerIds'],
  previous: string[] | undefined
): string[] {
  if (Array.isArray(value)) return uniqueStrings(value);
  if (typeof value === 'string') return uniqueStrings(value.split(/[,;\n]/));
  return previous ? [...previous] : [];
}

function configSecretExposure(value: ConfigSecretReferenceInput['exposure']): ConfigSecretExposure {
  if (value === 'signed-url' || value === 'temporary-sts') return value;
  return 'internal-only';
}

function configSecretRotationMode(value: ConfigSecretReferenceInput['rotationMode']): ConfigSecretRotationMode {
  return value === 'provider-managed' ? 'provider-managed' : 'manual';
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
    systemSubscriptionAccessAccountName(siteId),
    ...Array.from({ length: 9 }, (_, index) => `${prefix}-internal${String(index + 1).padStart(2, '0')}`)
  ];
}

export function systemSubscriptionAccessAccountName(siteId: string): string {
  const suffix = `-${SYSTEM_SUBSCRIPTIONS_SERVICE_ACCOUNT_ID}`;
  // The Oversea materializer and Caddy path allow at most 64 characters. Keep
  // the semantic suffix intact so the runtime can identify this account, even
  // when an operator chose an unusually long site id.
  const prefix = safeAccountPrefix(siteId).slice(0, 64 - suffix.length).replace(/[-.]+$/g, '') || 'oversea';
  return `${prefix}${suffix}`;
}

export function isSystemSubscriptionAccessAccount(
  account: Pick<SiteSlotAccessAccount, 'siteId' | 'username'>
): boolean {
  return account.username === systemSubscriptionAccessAccountName(account.siteId);
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
    // upsert 不改归档状态：重新配置一台已归档机器的 host/端口不应该悄悄让它复活，
    // 复活必须走显式的 unarchive。
    status: previous?.status === 'archived' ? 'archived' : 'active',
    archivedAt: previous?.archivedAt ?? null,
    archivedBy: previous?.archivedBy ?? null,
    createdBy: previous?.createdBy ?? input.requestedBy ?? 'internal',
    createdAt: previous?.createdAt ?? now,
    updatedBy: input.requestedBy ?? previous?.updatedBy ?? 'internal',
    updatedAt: now
  };
}

export function normalizeLauncherNetworkMihomoSite(site: LauncherNetworkMihomoSite): LauncherNetworkMihomoSite {
  const tlsFingerprint = normalizeTlsFingerprint(site.tlsFingerprint);
  const serverPorts = normalizeHysteria2ServerPorts(site.serverPorts).normalized;
  // 归档字段是后加的，历史记录里没有；缺省按 active 读，避免老站点被当成已归档。
  const status = site.status === 'archived' ? 'archived' : 'active';
  const archivedAt = site.archivedAt ?? null;
  const archivedBy = site.archivedBy ?? null;
  if (
    site.serverPorts === serverPorts
    && site.tlsFingerprint === tlsFingerprint
    && site.status === status
    && site.archivedAt === archivedAt
    && site.archivedBy === archivedBy
  ) return site;
  return { ...site, serverPorts, tlsFingerprint, status, archivedAt, archivedBy };
}

export function applyLauncherNetworkMihomoSiteArchive(
  site: LauncherNetworkMihomoSite,
  archived: boolean,
  requestedBy: string,
  now = new Date().toISOString()
): LauncherNetworkMihomoSite {
  return {
    ...site,
    status: archived ? 'archived' : 'active',
    archivedAt: archived ? site.archivedAt ?? now : null,
    archivedBy: archived ? site.archivedBy ?? requestedBy : null,
    updatedBy: requestedBy,
    updatedAt: now
  };
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
  const operatorAccounts = accounts.filter((account) => account.role === 'operator');
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
      hEndpoint: hEndpointAccounts.length,
      operator: operatorAccounts.length
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
    'mixed-port: 7788',
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

/**
 * Canonical Internal mirror of the system YAML written by the Oversea access
 * stack. Keep this separate from the ordinary 30 Mbps user renderer: the
 * system account is unmetered and its 50 Mbps values are client hints only.
 */
export function renderSystemHysteria2MihomoSubscription(
  site: LauncherNetworkMihomoSite,
  account: SiteSlotAccessAccount,
  now = new Date().toISOString()
): MihomoSubscriptionRender {
  if (!isSystemSubscriptionAccessAccount(account)) {
    throw new Error('Canonical system subscription account required');
  }
  if (!site.publicHost || !site.tlsFingerprint) {
    throw new Error('Ready Oversea host and TLS fingerprint required');
  }
  const proxyName = `peer_${account.username}`;
  const lines = [
    `# Generated from the Internal-issued ${account.username} access account.`,
    '# Unmetered traffic quota; 50 Mbps values are client bandwidth hints.',
    `mixed-port: ${SYSTEM_SUBSCRIPTION_MIXED_PORT}`,
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'geodata-mode: true',
    'geo-auto-update: true',
    'geo-update-interval: 24',
    '',
    'proxies:',
    `  - name: ${yamlQuote(proxyName)}`,
    '    type: hysteria2',
    `    server: ${yamlQuote(site.publicHost)}`,
    `    port: ${firstHysteriaPort(site.serverPorts)}`,
    `    password: ${yamlQuote(account.authToken)}`,
    `    down: ${yamlQuote(SYSTEM_SUBSCRIPTION_CLIENT_BANDWIDTH)}`,
    `    up: ${yamlQuote(SYSTEM_SUBSCRIPTION_CLIENT_BANDWIDTH)}`,
    '    skip-cert-verify: true',
    `    fingerprint: ${yamlQuote(site.tlsFingerprint)}`,
    '    alpn:',
    `      - ${HYSTERIA2_CLIENT_ALPN}`,
    '    dns:',
    ...HYSTERIA2_CLIENT_DNS.map((server) => `      - ${yamlQuote(server)}`),
    '',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - ${yamlQuote(proxyName)}`,
    '      - DIRECT',
    '',
    'rules:',
    ...HYSTERIA2_LOCAL_DIRECT_RULES.map((rule) => `  - ${rule}`),
    '  - GEOSITE,CN,DIRECT',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,PROXY',
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
  const subject = user.account || user.email || user.userId;
  return safeAccountName(`${siteId}-${subject}`).slice(0, 80);
}

export function userOverseaEntitlementId(userId: string): string {
  return `useroversea_${safeAccountName(userId)}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function userH2oRuntimeProfileId(userId: string, appId = 'h2o'): string {
  return `userh2o_${safeAccountName(appId)}_${safeAccountName(userId)}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function buildUserH2oRuntimeProfile(
  input: UserH2oRuntimeProfileInput,
  previous: UserH2oRuntimeProfile | null = null,
  now = new Date().toISOString()
): UserH2oRuntimeProfile {
  const userId = nullableTrimmed(input.userId) ?? previous?.userId;
  if (!userId) throw new Error('userId is required for H2O runtime profile');
  const appId = safeIdPart(nullableTrimmed(input.appId) ?? previous?.appId ?? 'h2o').toLowerCase();
  const hasSubscriptionInput = input.subscriptions !== undefined && input.subscriptions !== null;
  const subscriptions = normalizeUserH2oSubscriptions(hasSubscriptionInput ? input.subscriptions : previous?.subscriptions ?? []);
  const activeInput = input.activeSubscription
    ? normalizeUserH2oSubscription(input.activeSubscription)
    : null;
  const activeSubscriptionId = nullableTrimmed(input.activeSubscriptionId)
    ?? activeInput?.id
    ?? (hasSubscriptionInput ? null : previous?.activeSubscriptionId)
    ?? subscriptions[0]?.id
    ?? null;
  const activeSubscription = (activeSubscriptionId
    ? subscriptions.find((subscription) => subscription.id === activeSubscriptionId)
    : null)
    ?? (activeInput && subscriptions.some((subscription) => subscription.id === activeInput.id) ? activeInput : null)
    ?? subscriptions[0]
    ?? null;
  return {
    profileId: previous?.profileId ?? userH2oRuntimeProfileId(userId, appId),
    userId,
    appId,
    mode: normalizeUserH2oMode(input.mode ?? previous?.mode),
    activeSubscriptionId: activeSubscription?.id ?? activeSubscriptionId,
    activeSubscription,
    subscriptions,
    ports: normalizeUserH2oPorts(input.ports ?? previous?.ports),
    rules: Array.isArray(input.rules) ? input.rules.map(recordValue) : previous?.rules ?? [],
    createdBy: previous?.createdBy ?? nullableTrimmed(input.requestedBy) ?? 'mx-h2i-h2o',
    createdAt: previous?.createdAt ?? now,
    updatedBy: nullableTrimmed(input.requestedBy) ?? 'mx-h2i-h2o',
    updatedAt: now,
    requestId: nullableTrimmed(input.requestId)
  };
}

function normalizeUserH2oSubscriptions(value: unknown): UserH2oSubscription[] {
  const rows = Array.isArray(value) ? value : [];
  const byId = new Map<string, UserH2oSubscription>();
  for (const row of rows) {
    const subscription = normalizeUserH2oSubscription(row);
    if (subscription) byId.set(subscription.id, subscription);
  }
  return [...byId.values()].slice(0, 24);
}

function normalizeUserH2oSubscription(value: unknown): UserH2oSubscription | null {
  const row = recordValue(value);
  const rawUrl = nullableTrimmed(row.url);
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
  const id = safeIdPart(nullableTrimmed(row.id) ?? `custom-${createHash('sha1').update(rawUrl).digest('hex').slice(0, 12)}`).toLowerCase();
  const source = nullableTrimmed(row.source) ?? 'custom';
  return {
    id,
    name: nullableTrimmed(row.name) ?? rawUrl,
    url: rawUrl,
    nodes: normalizeNonNegativeInteger(row.nodes, 0),
    latencyMs: normalizeNonNegativeInteger(row.latencyMs, 0),
    status: nullableTrimmed(row.status) ?? 'ready',
    source,
    requiresUser: row.requiresUser === true ? true : false,
    assignable: row.assignable !== false,
    entitlementId: nullableTrimmed(row.entitlementId),
    siteIds: uniqueStrings(Array.isArray(row.siteIds) ? row.siteIds : []),
    syncStatus: nullableTrimmed(row.syncStatus),
    errorMessage: nullableTrimmed(row.errorMessage),
    yamlBytes: normalizeNonNegativeInteger(row.yamlBytes, 0),
    auth: normalizeUserH2oSubscriptionAuth(row.auth),
    headers: stringRecordValue(recordValue(row.headers)),
    pinnedAt: nullableTrimmed(row.pinnedAt),
    lastUpdatedAt: nullableTrimmed(row.lastUpdatedAt) ?? new Date().toISOString()
  };
}

function normalizeUserH2oSubscriptionAuth(value: unknown): UserH2oSubscription['auth'] {
  const row = recordValue(value);
  if (nullableTrimmed(row.type) === 'basic') {
    return {
      type: 'basic',
      username: nullableTrimmed(row.username),
      password: nullableTrimmed(row.password)
    };
  }
  return { type: 'none', username: null, password: null };
}

function normalizeUserH2oPorts(value: unknown): Record<string, number> {
  const row = recordValue(value);
  return {
    mixed: normalizePortNumber(row.mixed, 23458),
    dns: normalizePortNumber(row.dns, 1053),
    controller: normalizePortNumber(row.controller, 23457),
    admin: normalizePortNumber(row.admin, 23456)
  };
}

function normalizeUserH2oMode(value: unknown): string {
  const text = nullableTrimmed(value)?.toLowerCase();
  if (text === 'rule') return 'app-rule';
  if (text === 'global' || text === 'direct') return 'app-global';
  if (text === 'tun') return 'system-tun';
  return text && ['app-rule', 'app-global', 'system-tun'].includes(text) ? text : 'app-global';
}

function normalizePortNumber(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

/**
 * 多节点时先给一个 `fallback` 组：它按列表顺序健康探测，当前节点不通就自动顺延到下一个，
 * 不需要用户手动切。`Oversea` 仍然是 select 组，只是把 Auto 放在第一位——
 * 没手动选过就是「自动按顺序」，想固定某台机器仍然可以在组里点它。
 *
 * 单节点时不生成 Auto 组：一个节点没有可顺延的对象，多一层只会让 UI 里多一个假选项。
 */
function overseaProxyGroupLines(proxyNames: string[]): string[] {
  const autoGroup = proxyNames.length > 1
    ? [
        `  - name: ${OVERSEA_AUTO_GROUP}`,
        '    type: fallback',
        `    url: ${yamlQuote(OVERSEA_HEALTH_CHECK_URL)}`,
        `    interval: ${OVERSEA_HEALTH_CHECK_INTERVAL_SECONDS}`,
        '    proxies:',
        ...proxyNames.map((proxyName) => `      - ${yamlQuote(proxyName)}`)
      ]
    : [];
  return [
    ...autoGroup,
    `  - name: ${OVERSEA_SELECT_GROUP}`,
    '    type: select',
    '    proxies:',
    ...(autoGroup.length ? [`      - ${yamlQuote(OVERSEA_AUTO_GROUP)}`] : []),
    ...proxyNames.map((proxyName) => `      - ${yamlQuote(proxyName)}`),
    '      - DIRECT'
  ];
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
    `# user=${user.userId} account=${user.account} email=${user.email ?? '-'}`,
    `# entitlement=${entitlement.entitlementId} sites=${entitlement.siteIds.join(',')}`,
    '# Reachability: this Internal subscription URL requires Domestic WG relay/H2I before H endpoints can fetch it.',
    'mixed-port: 7788',
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
    ...overseaProxyGroupLines(proxyNames),
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

export function canonicalSiteSlotAccessAccountName(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'account';
}

function safeAccountName(value: string): string {
  return canonicalSiteSlotAccessAccountName(value);
}

function inferAccessAccountRole(siteId: string, username: string): SiteSlotAccessAccountRole {
  const prefix = safeAccountPrefix(siteId);
  if (username === `${prefix}-internal`) return 'internal';
  if (username === `${prefix}-domestic`) return 'domestic';
  if (username === systemSubscriptionAccessAccountName(siteId)) return 'operator';
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

export function tlsFingerprintFromSiteSlotOutput(value: string | null | undefined): string | null {
  const text = value ?? '';
  const match = text.match(/(?:TLS\s+)?fingerprint:\s*["']?([0-9a-f]{2}(?::[0-9a-f]{2}){15,})["']?/i);
  return match ? normalizeTlsFingerprint(match[1]) : null;
}

export function siteSlotWorkerReportTlsFingerprint(report: Pick<SiteSlotWorkerReport, 'message' | 'stepReports'>): string | null {
  const chunks = [
    report.message,
    ...report.stepReports.flatMap((step) => [step.stdout, step.stderr])
  ];
  for (const chunk of chunks) {
    const fingerprint = tlsFingerprintFromSiteSlotOutput(chunk);
    if (fingerprint) return fingerprint;
  }
  return null;
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
