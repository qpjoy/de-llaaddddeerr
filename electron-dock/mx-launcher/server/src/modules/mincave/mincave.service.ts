import { mincaveApplications, mincaveWorkspaceChange } from '../../lib/mincave-workspace.js';
import { mincaveSessionDevice } from '../../lib/mincave-devices.js';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { activeMinCaveMember, mincaveRole, type MinCaveMember } from '../../lib/mincave-access.js';
import { passwordSessionActive } from '../../lib/web-session-security.js';
import type { PlatformStore } from '../../store/platform-store.js';
import type { RuntimeConfig, UserCenterUser } from '../../types.js';

export class MinCaveService {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: PlatformStore,
  ) {}
  private async identity(authorization?: string) {
    if (
      !this.config.mincaveFeishuTenantKey ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(this.config.mincaveFeishuTenantKey)
    )
      throw new ServiceUnavailableException({
        code: 'mincave_unavailable',
        message: 'MinCave 服务暂不可用。',
      });
    if (!authorization || !/^Bearer [^\s]{1,4096}$/.test(authorization))
      throw new UnauthorizedException({
        code: 'feishu_login_required',
        message: '请使用飞书重新登录。',
      });
    const auth = await this.store.introspectToken({
      token: authorization.slice(7),
      audience: 'mx-sdk',
    });
    if (
      !auth.active ||
      auth.tokenKind !== 'jwt' ||
      auth.authProvider !== 'feishu' ||
      auth.appId !== 'mx-h2i' ||
      !auth.scopes.includes('auth.read') ||
      auth.principal?.kind !== 'user' ||
      !auth.principal.userId ||
      !auth.verifiedFeishuIdentity ||
      !auth.issuedAt ||
      !Number.isFinite(Date.parse(auth.issuedAt))
    ) {
      throw new UnauthorizedException({
        code: 'feishu_login_required',
        message: '请使用飞书重新登录。',
      });
    }
    const proof = auth.verifiedFeishuIdentity;
    if (proof.tenantKey !== this.config.mincaveFeishuTenantKey) {
      throw new ForbiddenException({
        code: 'enterprise_not_allowed',
        message: '仅明悉科技企业成员可使用 MinCave。',
      });
    }
    const user = await this.store.getUserCenterUser(auth.principal.userId);
    if (
      !user ||
      user.status !== 'active' ||
      user.appAccess.deniedAppIds.includes('mx-h2i') ||
      user.profile.externalIds.feishuSubject !== proof.subject ||
      !passwordSessionActive(user, Date.parse(auth.issuedAt) / 1000)
    ) {
      throw new ForbiddenException({
        code: 'mincave_access_denied',
        message: '当前账号无 MinCave 使用权限。',
      });
    }
    return { user, proof };
  }
  async session(authorization?: string, body?: unknown) {
    const device = mincaveSessionDevice(body);
    const { user, proof } = await this.identity(authorization);
    const result = await this.store.admitMinCaveMember({
      userId: user.userId,
      tenantKey: proof.tenantKey,
      feishuSubject: proof.subject,
    });
    if (device) await this.store.recordMinCaveDevice(user.userId, device);
    const role = mincaveRole(result.user)!;
    return {
      allowed: true,
      role,
      canManage: role === 'admin',
      companyName: '明悉科技',
      userId: user.userId,
      applications: mincaveApplications(await this.store.getMinCaveWorkspace(proof.tenantKey), result.user.profile.department || '', result.member.appIds),
    };
  }
  async devices(authorization?: string) {
    const { user, proof } = await this.identity(authorization);
    const member = (await this.store.listMinCaveMembers()).find(row =>
      row.userId === user.userId && row.tenantKey === proof.tenantKey);
    if (!member || !activeMinCaveMember(user, member))
      throw new ForbiddenException({ code: 'mincave_access_denied', message: '当前账号无 MinCave 使用权限。' });
    const devices = await this.store.listMinCaveDevices(user.userId);
    return { userId: user.userId, devices: devices.map(({ userId: _owner, ...device }) => device) };
  }
  private async administrator(authorization?: string) {
    const identity = await this.identity(authorization);
    const member = (await this.store.listMinCaveMembers()).find(
      (row) => row.userId === identity.user.userId && row.tenantKey === identity.proof.tenantKey,
    );
    if (
      !member ||
      !activeMinCaveMember(identity.user, member) ||
      mincaveRole(identity.user) !== 'admin'
    ) {
      throw new ForbiddenException({
        code: 'management_forbidden',
        message: '暂无 MinCave 管理权限。',
      });
    }
    return identity;
  }
  private project(user: UserCenterUser, member: MinCaveMember) {
    return {
      id: user.userId,
      name: user.displayName,
      department: user.profile.department || '',
      role: mincaveRole(user),
      enabled: activeMinCaveMember(user, member),
      accountActive:
        user.status === 'active' &&
        !user.appAccess.deniedAppIds.includes('mx-h2i') &&
        user.profile.externalIds.feishuSubject === member.feishuSubject,
      firstSeenAt: member.firstSeenAt,
      lastSeenAt: member.lastSeenAt,
    };
  }
  async members(authorization?: string) {
    const { user, proof } = await this.administrator(authorization);
    const members = (await this.store.listMinCaveMembers()).filter(
      (row) => row.tenantKey === proof.tenantKey,
    );
    const workspace = await this.store.getMinCaveWorkspace(proof.tenantKey);
    const rows = await Promise.all(
      members.map(async (member) => {
        const target = await this.store.getUserCenterUser(member.userId);
        if (!target) return null;
        const devices = await this.store.listMinCaveDevices(member.userId);
        return {
          ...this.project(target, member),
          devices: devices.map(device => ({ name: device.deviceLabel || (device.platform === 'darwin' ? 'Mac 设备' : device.platform === 'win32' ? 'Windows 设备' : '未命名设备'), platform: device.platform })),
          appIds: member.appIds ?? workspace.applications.map(app => app.id),
          effectiveAppIds: activeMinCaveMember(target, member) ? mincaveApplications(workspace, target.profile.department || '', member.appIds).map(app => app.id) : [],
        };
      }),
    );
    return { administratorId: user.userId, members: rows.filter((row) => row !== null), workspace, memberPermissions: true };
  }

  async updateWorkspace(authorization: string | undefined, body: unknown) {
    const { user, proof } = await this.administrator(authorization);
    const change = mincaveWorkspaceChange(body);
    await this.store.updateMinCaveWorkspace({ ...change, actorId: user.userId, tenantKey: proof.tenantKey });
    return { saved: true };
  }

  async update(authorization: string | undefined, userId: string, body: unknown) {
    const { user, proof } = await this.administrator(authorization);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('成员信息不完整。');
    const value = body as Record<string, unknown>;
    if (
      (value.role !== 'admin' && value.role !== 'employee') ||
      typeof value.enabled !== 'boolean' ||
      Object.keys(value).some((key) => !['role', 'enabled', 'appIds'].includes(key)) ||
      (value.appIds !== undefined && (!Array.isArray(value.appIds) || value.appIds.length > 200 || value.appIds.some(id => typeof id !== 'string')))
    )
      throw new BadRequestException('只能修改 MinCave 角色、使用权限和应用授权。');
    await this.store.updateMinCaveMember({
      actorId: user.userId,
      tenantKey: proof.tenantKey,
      userId,
      role: value.role as 'admin' | 'employee',
      enabled: value.enabled,
      ...(value.appIds !== undefined ? { appIds: value.appIds as string[] } : {}),
    });
    return { saved: true };
  }
}
