import { createHash } from 'node:crypto';
import type { AuditEventInput, LauncherNetworkLease, SetLuopanUserControlsInput, UserAppUpdatePolicy, UserCenterUser } from '../types.js';

export class UserAppUpdatePolicyInputError extends Error {}
export class UserAppUpdatePolicyUserNotFoundError extends Error {}
export class UserAppUpdatePolicyConflictError extends Error {
  readonly code = 'user_app_update_policy_conflict';
  constructor(readonly revision: number) {
    super('罗盘控制策略已变化，请刷新后重新保存。');
  }
}

export function userAppUpdatePolicyId(appId: string, userId: string): string {
  if (!/^[-a-z0-9]{1,80}$/.test(appId) || typeof userId !== 'string' || !userId.trim() || userId !== userId.trim()) {
    throw new UserAppUpdatePolicyInputError('A canonical appId and userId are required');
  }
  return createHash('sha256').update(JSON.stringify([appId, userId])).digest('hex');
}

export function defaultUserAppUpdatePolicy(appId: string, userId: string): UserAppUpdatePolicy {
  return { appId, userId, updatesBlocked: false, reason: null, revision: 0, updatedBy: null, updatedAt: null };
}

export function preserveLuopanLoginAccess(user: UserCenterUser, previous: UserCenterUser | null | undefined): UserCenterUser {
  if (!previous) return user;
  const deniedAppIds = user.appAccess.deniedAppIds.filter(appId => appId !== 'luopan');
  if (previous.appAccess.deniedAppIds.includes('luopan')) deniedAppIds.push('luopan');
  return { ...user, appAccess: { ...user.appAccess, deniedAppIds } };
}

export function prepareLuopanUserControls(
  input: SetLuopanUserControlsInput,
  user: UserCenterUser | null | undefined,
  previous: UserAppUpdatePolicy | null,
  now = new Date().toISOString()
) {
  userAppUpdatePolicyId('luopan', input.userId);
  if (typeof input.updatesBlocked !== 'boolean' || (input.loginBlocked !== undefined && typeof input.loginBlocked !== 'boolean')) {
    throw new UserAppUpdatePolicyInputError('updatesBlocked and optional loginBlocked must be booleans');
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new UserAppUpdatePolicyInputError('expectedRevision must be a non-negative integer');
  }
  if (input.reason != null && (typeof input.reason !== 'string' || input.reason.length > 1000)) {
    throw new UserAppUpdatePolicyInputError('reason must be a string of at most 1000 characters');
  }
  if (!user) throw new UserAppUpdatePolicyUserNotFoundError(`User not found: ${input.userId}`);
  const revision = previous?.revision ?? 0;
  if (input.expectedRevision !== revision) throw new UserAppUpdatePolicyConflictError(revision);
  const policy: UserAppUpdatePolicy = {
    appId: 'luopan', userId: user.userId, updatesBlocked: input.updatesBlocked,
    reason: input.reason === undefined ? previous?.reason ?? null : input.reason?.trim() || null,
    revision: revision + 1, updatedBy: input.requestedBy?.trim() || 'internal-ops', updatedAt: now
  };
  const wasLoginBlocked = user.appAccess.deniedAppIds.includes('luopan');
  const loginBlocked = input.loginBlocked ?? wasLoginBlocked;
  const updatedUser = loginBlocked === wasLoginBlocked ? user : {
    ...user,
    appAccess: {
      ...user.appAccess,
      deniedAppIds: loginBlocked
        ? [...user.appAccess.deniedAppIds, 'luopan']
        : user.appAccess.deniedAppIds.filter(appId => appId !== 'luopan')
    },
    updatedAt: now
  };
  const audit: AuditEventInput = {
    eventType: 'release.user_app_update_policy.updated', actorKind: 'user-center',
    userId: user.userId, productId: 'luopan', requestId: input.requestId ?? null,
    metadata: {
      requestedBy: policy.updatedBy, reason: policy.reason, revision: policy.revision,
      updatesBlockedBefore: previous?.updatesBlocked ?? false, updatesBlocked: policy.updatesBlocked,
      loginBlockedBefore: wasLoginBlocked, loginBlocked, loginChanged: loginBlocked !== wasLoginBlocked,
      tokensRevoked: 0, networkModified: false
    }
  };
  return { policy, loginBlocked, updatedUser, audit };
}

/** A submitted Java/business userId is never evidence of a Launcher identity. */
export function luopanIdentifiedInstallUsers(leases: LauncherNetworkLease[], now = Date.now()): Map<string, string> {
  const usersByInstall = new Map<string, Set<string>>();
  const anonymousInstalls = new Set<string>();
  for (const lease of leases) {
    if (lease.productId !== 'luopan' || lease.status !== 'active'
      || !lease.installId || !(Date.parse(lease.expiresAt) > now)) continue;
    if (lease.identityKind !== 'user' || !lease.userId) {
      anonymousInstalls.add(lease.installId);
      continue;
    }
    const users = usersByInstall.get(lease.installId) ?? new Set<string>();
    users.add(lease.userId);
    usersByInstall.set(lease.installId, users);
  }
  return new Map([...usersByInstall].flatMap(([installId, users]) => users.size === 1 && !anonymousInstalls.has(installId)
    ? [[installId, [...users][0]!] as const] : []));
}
