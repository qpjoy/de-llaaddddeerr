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
  async session(authorization?: string) {
    const { user, proof } = await this.identity(authorization);
    const result = await this.store.admitMinCaveMember({
      userId: user.userId,
      tenantKey: proof.tenantKey,
      feishuSubject: proof.subject,
    });
    const role = mincaveRole(result.user)!;
    return {
      allowed: true,
      role,
      canManage: role === 'admin',
      companyName: '明悉科技',
      userId: user.userId,
    };
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
    const rows = await Promise.all(
      members.map(async (member) => {
        const target = await this.store.getUserCenterUser(member.userId);
        return target ? this.project(target, member) : null;
      }),
    );
    return { administratorId: user.userId, members: rows.filter((row) => row !== null) };
  }

  async update(authorization: string | undefined, userId: string, body: unknown) {
    const { user, proof } = await this.administrator(authorization);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('成员信息不完整。');
    const value = body as Record<string, unknown>;
    if (
      !['admin', 'employee'].includes(String(value.role)) ||
      typeof value.enabled !== 'boolean' ||
      Object.keys(value).some((key) => !['role', 'enabled'].includes(key))
    )
      throw new BadRequestException('只能修改 MinCave 角色和使用权限。');
    await this.store.updateMinCaveMember({
      actorId: user.userId,
      tenantKey: proof.tenantKey,
      userId,
      role: value.role as 'admin' | 'employee',
      enabled: value.enabled,
    });
    return { saved: true };
  }
}
