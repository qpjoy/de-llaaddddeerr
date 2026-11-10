import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { RuntimeConfig, UserCenterUser } from '../types.js';

export const MINCAVE_ADMIN = 'mx-mincave-admin';
export const MINCAVE_EMPLOYEE = 'mx-mincave-employee';
export type MinCaveRole = 'admin' | 'employee';
export interface MinCaveMember {
  userId: string;
  tenantKey: string;
  feishuSubject: string;
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface MinCaveAdmission {
  userId: string;
  tenantKey: string;
  feishuSubject: string;
}
export interface MinCaveMemberChange {
  actorId: string;
  tenantKey: string;
  userId: string;
  role: MinCaveRole;
  enabled: boolean;
}
export function mincaveRole(user: UserCenterUser | undefined | null): MinCaveRole | null {
  if (user?.roleIds.includes(MINCAVE_ADMIN)) return 'admin';
  return user?.roleIds.includes(MINCAVE_EMPLOYEE) ? 'employee' : null;
}
export function activeMinCaveMember(user: UserCenterUser | undefined, member: MinCaveMember) {
  return (
    user?.status === 'active' &&
    Boolean(mincaveRole(user)) &&
    !user.appAccess.deniedAppIds.includes('mx-h2i') &&
    user.profile.externalIds.feishuSubject === member.feishuSubject
  );
}
// Shared by Launcher edits and MinCave edits; called under the account write lock in Postgres.
export function assertMinCaveTransition(
  previous: UserCenterUser | null,
  next: UserCenterUser | null,
  users: UserCenterUser[],
  members: MinCaveMember[],
) {
  if (next?.roleIds.includes(MINCAVE_ADMIN) && next.roleIds.includes(MINCAVE_EMPLOYEE)) {
    throw new ConflictException('MinCave 管理员和员工只能选择一种角色。');
  }
  const member = members.find((row) => row.userId === previous?.userId);
  if (
    !previous ||
    !member ||
    !activeMinCaveMember(previous, member) ||
    mincaveRole(previous) !== 'admin'
  )
    return;
  if (next && activeMinCaveMember(next, member) && mincaveRole(next) === 'admin') return;
  const replacement = members.some(
    (row) =>
      row.tenantKey === member.tenantKey &&
      row.userId !== previous.userId &&
      activeMinCaveMember(
        users.find((user) => user.userId === row.userId),
        row,
      ) &&
      mincaveRole(users.find((user) => user.userId === row.userId)) === 'admin',
  );
  if (!replacement) throw new ConflictException('请至少保留一位有效的 MinCave 管理员。');
}
export function admitMinCave(
  input: MinCaveAdmission,
  config: RuntimeConfig,
  users: UserCenterUser[],
  members: MinCaveMember[],
) {
  const user = users.find((row) => row.userId === input.userId);
  if (
    !config.mincaveFeishuTenantKey ||
    input.tenantKey !== config.mincaveFeishuTenantKey ||
    !user ||
    user.status !== 'active' ||
    user.appAccess.deniedAppIds.includes('mx-h2i') ||
    user.profile.externalIds.feishuSubject !== input.feishuSubject ||
    !input.feishuSubject.startsWith(`${input.tenantKey}:`)
  )
    throw new ForbiddenException('当前账号无 MinCave 使用权限。');
  const previous = members.find((row) => row.userId === input.userId);
  if (
    previous &&
    (previous.tenantKey !== input.tenantKey || previous.feishuSubject !== input.feishuSubject)
  ) {
    throw new ForbiddenException('飞书身份关联已变化，请联系管理员。');
  }
  const now = new Date().toISOString();
  const updated = !previous
    ? {
        ...user,
        roleIds:
          config.mincaveInitialAdminUserId === user.userId
            ? [
                ...user.roleIds.filter((role) => ![MINCAVE_ADMIN, MINCAVE_EMPLOYEE].includes(role)),
                MINCAVE_ADMIN,
              ]
            : mincaveRole(user)
              ? user.roleIds
              : [...user.roleIds, MINCAVE_EMPLOYEE],
        updatedAt: now,
      }
    : user;
  if (!mincaveRole(updated)) throw new ForbiddenException('MinCave 使用权限已被停用。');
  const member = { ...input, firstSeenAt: previous?.firstSeenAt || now, lastSeenAt: now };
  return { user: updated, member };
}
export function changeMinCaveMember(
  input: MinCaveMemberChange,
  users: UserCenterUser[],
  members: MinCaveMember[],
) {
  const actor = users.find((user) => user.userId === input.actorId);
  const actorMember = members.find(
    (row) => row.userId === input.actorId && row.tenantKey === input.tenantKey,
  );
  if (!actorMember || !activeMinCaveMember(actor, actorMember) || mincaveRole(actor) !== 'admin') {
    throw new ForbiddenException('暂无 MinCave 管理权限。');
  }
  const member = members.find(
    (row) => row.userId === input.userId && row.tenantKey === input.tenantKey,
  );
  const previous = users.find((user) => user.userId === input.userId);
  if (!member || !previous) throw new NotFoundException('MinCave 成员不存在。');
  if (
    input.enabled &&
    (previous.status !== 'active' ||
      previous.appAccess.deniedAppIds.includes('mx-h2i') ||
      previous.profile.externalIds.feishuSubject !== member.feishuSubject)
  ) {
    throw new ConflictException('此账号已被用户中心停用或身份关联已变化。');
  }
  const user = {
    ...previous,
    roleIds: [
      ...previous.roleIds.filter((role) => ![MINCAVE_ADMIN, MINCAVE_EMPLOYEE].includes(role)),
      ...(input.enabled ? [input.role === 'admin' ? MINCAVE_ADMIN : MINCAVE_EMPLOYEE] : []),
    ],
    updatedAt: new Date().toISOString(),
  };
  assertMinCaveTransition(previous, user, users, members);
  return user;
}
