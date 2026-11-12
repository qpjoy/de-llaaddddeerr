import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { activeMinCaveMember, mincaveRole, type MinCaveMember } from './mincave-access.js';
import type { UserCenterUser } from '../types.js';

export const MINCAVE_CATEGORIES = ['中台应用', '产品应用', '管理后台', '员工福利'] as const;
export interface MinCaveApplication {
  id: string;
  name: string;
  url: string;
  category: string;
  published: boolean;
  icon: string;
  color: string;
}
export interface MinCavePolicy {
  id: string;
  name: string;
  department: string;
  appIds: string[];
  action: 'allow' | 'deny';
  enabled: boolean;
}
export interface MinCaveWorkspace {
  revision: number;
  applications: MinCaveApplication[];
  policies: MinCavePolicy[];
}
export interface MinCaveWorkspaceChange {
  actorId: string;
  tenantKey: string;
  revision: number;
  kind: 'application' | 'policy';
  id?: string;
  value: Record<string, unknown>;
}
export function defaultMinCaveWorkspace(): MinCaveWorkspace {
  return {
    revision: 0,
    policies: [],
    applications: [
      {
        id: 'web-delta',
        name: 'Delta',
        url: 'http://delta.mxinfo-inc.cn/web/data-hub',
        category: '中台应用',
        icon: 'triangle',
        color: 'purple',
        published: true,
      },
      {
        id: 'web-hub',
        name: 'Hub',
        url: 'https://hub.minsight-ai.com/admin/?admin=1#/dataport/support',
        category: '中台应用',
        icon: 'layers',
        color: 'blue',
        published: true,
      },
      {
        id: 'web-night-all',
        name: 'Night-All',
        url: 'http://10.88.88.88:13141/console/platform',
        category: '中台应用',
        icon: 'moon',
        color: 'indigo',
        published: true,
      },
      {
        id: 'web-compass',
        name: 'Compass',
        url: 'http://10.88.88.88:55855/',
        category: '产品应用',
        icon: 'compass',
        color: 'mint',
        published: true,
      },
      {
        id: 'web-argus',
        name: 'Argus',
        url: 'https://inhouse.arguseek.com/research/new',
        category: '产品应用',
        icon: 'search',
        color: 'blue',
        published: true,
      },
      {
        id: 'web-compass-admin',
        name: 'Compass管理后台',
        url: 'http://10.88.88.88:55866/admin',
        category: '管理后台',
        icon: 'shield',
        color: 'purple',
        published: true,
      },
    ],
  };
}
const fail = (message: string): never => {
  throw new BadRequestException(message);
};
function label(value: unknown, max: number, name: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return fail(`${name}格式不正确。`);
  return value.trim();
}
export function mincaveWorkspaceChange(
  body: unknown,
): Omit<MinCaveWorkspaceChange, 'actorId' | 'tenantKey'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('管理信息不完整。');
  const b = body as Record<string, unknown>;
  if (
    Object.keys(b).some((key) => !['revision', 'kind', 'id', 'value'].includes(key)) ||
    !Number.isSafeInteger(b.revision) ||
    Number(b.revision) < 0 ||
    (b.kind !== 'application' && b.kind !== 'policy') ||
    (b.id !== undefined && (typeof b.id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(b.id))) ||
    !b.value ||
    typeof b.value !== 'object' ||
    Array.isArray(b.value)
  )
    return fail('管理信息不完整。');
  return {
    revision: b.revision as number,
    kind: b.kind as 'application' | 'policy',
    ...(b.id ? { id: b.id as string } : {}),
    value: b.value as Record<string, unknown>,
  };
}
export function changeMinCaveWorkspace(
  previous: MinCaveWorkspace,
  input: MinCaveWorkspaceChange,
  users: UserCenterUser[],
  members: MinCaveMember[],
): MinCaveWorkspace {
  const actor = users.find((row) => row.userId === input.actorId);
  const member = members.find(
    (row) => row.userId === input.actorId && row.tenantKey === input.tenantKey,
  );
  if (!member || !activeMinCaveMember(actor, member) || mincaveRole(actor) !== 'admin')
    throw new ForbiddenException('暂无 MinCave 管理权限。');
  // Validate again at the persistence boundary; callers cannot bypass field restrictions.
  mincaveWorkspaceChange({
    revision: input.revision,
    kind: input.kind,
    ...(input.id ? { id: input.id } : {}),
    value: input.value,
  });
  if (previous.revision !== input.revision)
    throw new ConflictException('内容已被其他管理员修改，请刷新后重试。');
  const next = structuredClone(previous);
  const v = input.value;
  const list = input.kind === 'application' ? next.applications : next.policies;
  const existing = input.id ? list.find((row) => row.id === input.id) : undefined;
  if (input.id && !existing) throw new NotFoundException('管理记录不存在。');
  if (!input.id && list.length >= 200) return fail('记录数量已达上限。');
  const id = input.id || `${input.kind === 'application' ? 'web' : 'policy'}-${randomUUID()}`;
  if (input.kind === 'application') {
    if (
      Object.keys(v).some((key) => !['name', 'url', 'category', 'published'].includes(key)) ||
      typeof v.published !== 'boolean' ||
      !MINCAVE_CATEGORIES.includes(v.category as (typeof MINCAVE_CATEGORIES)[number])
    )
      return fail('应用信息不完整。');
    const url = label(v.url, 2048, '应用地址');
    try {
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        /\s/.test(url)
      )
        return fail('应用地址仅支持 HTTP 或 HTTPS，且不能包含账号密码。');
    } catch {
      return fail('应用地址格式不正确。');
    }
    const app: MinCaveApplication = {
      id,
      name: label(v.name, 50, '应用名称'),
      url,
      category: v.category as string,
      published: v.published,
      icon: (existing as MinCaveApplication)?.icon || 'apps',
      color: (existing as MinCaveApplication)?.color || 'purple',
    };
    next.applications = existing
      ? next.applications.map((row) => (row.id === id ? app : row))
      : [...next.applications, app];
  } else {
    if (
      Object.keys(v).some(
        (key) => !['name', 'department', 'appIds', 'action', 'enabled'].includes(key),
      ) ||
      typeof v.enabled !== 'boolean' ||
      (v.action !== 'allow' && v.action !== 'deny') ||
      !Array.isArray(v.appIds) ||
      !v.appIds.length ||
      v.appIds.length > 200 ||
      v.appIds.some(
        (id) => typeof id !== 'string' || !next.applications.some((app) => app.id === id),
      )
    )
      return fail('请选择有效的应用和策略动作。');
    const policy: MinCavePolicy = {
      id,
      name: label(v.name, 40, '策略名称'),
      department: label(v.department, 200, '适用部门'),
      appIds: [...new Set(v.appIds as string[])],
      action: v.action as 'allow' | 'deny',
      enabled: v.enabled,
    };
    if (
      policy.department !== '*' &&
      !users.some(
        (user) =>
          user.profile.department === policy.department &&
          members.some((row) => row.userId === user.userId && row.tenantKey === input.tenantKey),
      )
    )
      return fail('请选择 MinCave 成员所在的部门。');
    next.policies = existing
      ? next.policies.map((row) => (row.id === id ? policy : row))
      : [...next.policies, policy];
  }
  next.revision++;
  return next;
}
// Controls MinCave web entries. Business systems and network services retain their own authorization.
export function mincaveApplications(
  workspace: MinCaveWorkspace,
  department: string,
): MinCaveApplication[] {
  return workspace.applications.filter((app) => {
    if (!app.published) return false;
    const rules = workspace.policies.filter((rule) => rule.enabled && rule.appIds.includes(app.id));
    const matches = (rule: MinCavePolicy) =>
      rule.department === '*' || rule.department === department;
    if (rules.some((rule) => rule.action === 'deny' && matches(rule))) return false;
    const allows = rules.filter((rule) => rule.action === 'allow');
    return !allows.length || allows.some(matches);
  });
}
