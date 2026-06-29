import { BadRequestException, Body, Controller, Get, Inject, Post, UnauthorizedException } from '@nestjs/common';

import { asRecord, nullableString, stringArray } from '../../lib/http.js';
import { userMatchesLogin } from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { CreateServiceAccountInput, CreateUserInput, SdkGatewayAccessInput } from '../../types.js';
import { toPrincipalInput, toTokenInput } from '../user-center/user-center.controller.js';

@Controller()
export class SdkGatewayController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('internal/v1/sdk/gateway/manifest')
  async manifest() {
    return { gateway: await this.store.sdkGatewayManifest() };
  }

  @Post('internal/v1/sdk/identity/introspect')
  async introspect(@Body() rawBody: unknown) {
    return { introspection: await this.store.introspectToken(toTokenInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/sdk/oauth/token')
  async token(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const grantType = nullableString(body.grant_type) ?? nullableString(body.grantType) ?? 'password';
    if (grantType !== 'password' && grantType !== 'client_credentials') {
      throw new BadRequestException('Unsupported OAuth grant_type');
    }
    if (grantType === 'client_credentials') {
      return this.issueServiceAccountToken(body);
    }
    return this.issueUserToken(body);
  }

  @Post('internal/v1/sdk/identity/context')
  async context(@Body() rawBody: unknown) {
    return { context: await this.store.resolvePrincipalContext(toPrincipalInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/sdk/gateway/access/evaluate')
  async access(@Body() rawBody: unknown) {
    return { decision: await this.store.evaluateSdkGatewayAccess(toAccessInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/sdk/roles')
  async roles() {
    return { roles: await this.store.listUserCenterRoles() };
  }

  @Get('internal/v1/sdk/users')
  async users() {
    return { users: await this.store.listUserCenterUsers() };
  }

  @Post('internal/v1/sdk/users')
  async createUser(@Body() rawBody: unknown) {
    return { user: await this.store.createUserCenterUser(toCreateUserInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/sdk/service-accounts')
  async serviceAccounts() {
    return { serviceAccounts: await this.store.listUserCenterServiceAccounts() };
  }

  @Post('internal/v1/sdk/service-accounts')
  async createServiceAccount(@Body() rawBody: unknown) {
    return {
      serviceAccount: await this.store.createUserCenterServiceAccount(toCreateServiceAccountInput(asRecord(rawBody)))
    };
  }

  @Post('internal/v1/sdk/permissions/requests')
  async requestPermission(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      grant: await this.store.requestPermission({
        appId: nullableString(body.appId) ?? 'h2o',
        installId: nullableString(body.installId),
        userId: nullableString(body.userId),
        sourceAppId: nullableString(body.sourceAppId) ?? nullableString(body.source_app_id),
        requestedBy: nullableString(body.requestedBy) ?? 'sdk-gateway',
        scopes: stringArray(body.scopes),
        requestId: nullableString(body.requestId) ?? undefined
      })
    };
  }

  private async issueUserToken(body: Record<string, unknown>) {
    const username = nullableString(body.username) ?? nullableString(body.account) ?? nullableString(body.email);
    const password = nullableString(body.password);
    if (!username || !password) throw new UnauthorizedException('username and password are required');
    const users = await this.store.listUserCenterUsers();
    const user = users.find((item) => item.status === 'active' && userMatchesLogin(item, username));
    if (!user) throw new UnauthorizedException('User Center account is not active');
    const verification = await this.store.verifyUserCenterPassword({
      userId: user.userId,
      password,
      requestId: nullableString(body.requestId)
    });
    if (!verification.ok) throw new UnauthorizedException('invalid credentials');
    const issued = await this.store.issueUserCenterToken({
      subjectKind: 'user',
      subjectId: user.userId,
      audience: nullableString(body.audience) ?? 'mx-sdk',
      scopes: oauthScopes(body.scope, body.scopes),
      ttlSeconds: numberValue(body.expires_in) ?? numberValue(body.ttlSeconds) ?? 3600,
      requestId: nullableString(body.requestId)
    });
    const introspection = await this.store.introspectToken({
      token: issued.token,
      audience: issued.record.audience,
      requestId: nullableString(body.requestId)
    });
    return { token: oauthTokenResponse(issued, introspection) };
  }

  private async issueServiceAccountToken(body: Record<string, unknown>) {
    const clientId = nullableString(body.client_id) ?? nullableString(body.clientId);
    const clientSecret = nullableString(body.client_secret) ?? nullableString(body.clientSecret);
    if (!clientId || !clientSecret) throw new UnauthorizedException('client_id and client_secret are required');
    const serviceAccounts = await this.store.listUserCenterServiceAccounts();
    const serviceAccount = serviceAccounts.find((item) => item.status === 'active' && item.serviceAccountId === clientId);
    if (!serviceAccount) throw new UnauthorizedException('service account is not active');
    const issued = await this.store.issueUserCenterToken({
      subjectKind: 'service-account',
      subjectId: serviceAccount.serviceAccountId,
      audience: nullableString(body.audience) ?? 'mx-sdk',
      scopes: oauthScopes(body.scope, body.scopes),
      ttlSeconds: numberValue(body.expires_in) ?? numberValue(body.ttlSeconds) ?? 3600,
      requestId: nullableString(body.requestId)
    });
    const introspection = await this.store.introspectToken({
      token: issued.token,
      audience: issued.record.audience,
      requestId: nullableString(body.requestId)
    });
    return { token: oauthTokenResponse(issued, introspection) };
  }
}

function toAccessInput(body: Record<string, unknown>): SdkGatewayAccessInput {
  return {
    token: nullableString(body.token),
    audience: nullableString(body.audience),
    routeId: nullableString(body.routeId) ?? 'sdk.identity.context',
    appId: nullableString(body.appId),
    sourceAppId: nullableString(body.sourceAppId) ?? nullableString(body.source_app_id),
    requestId: nullableString(body.requestId)
  };
}

function toCreateUserInput(body: Record<string, unknown>): CreateUserInput {
  return {
    userId: nullableString(body.userId),
    account: nullableString(body.account),
    username: nullableString(body.username) ?? nullableString(body.user_name),
    email: nullableString(body.email),
    displayName: nullableString(body.displayName),
    password: nullableString(body.password),
    roleIds: stringArray(body.roleIds),
    orgIds: stringArray(body.orgIds),
    appAccess: asRecord(body.appAccess),
    homeAppId: nullableString(body.homeAppId),
    registeredByAppId: nullableString(body.registeredByAppId) ?? nullableString(body.sourceAppId),
    allowedAppIds: stringArray(body.allowedAppIds),
    deniedAppIds: stringArray(body.deniedAppIds),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toCreateServiceAccountInput(body: Record<string, unknown>): CreateServiceAccountInput {
  return {
    serviceAccountId: nullableString(body.serviceAccountId),
    displayName: nullableString(body.displayName),
    roleIds: stringArray(body.roleIds),
    scopes: stringArray(body.scopes),
    requestId: nullableString(body.requestId)
  };
}

function oauthScopes(scope: unknown, scopes: unknown): string[] {
  if (Array.isArray(scopes)) return scopes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (typeof scope === 'string') return scope.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function numberValue(value: unknown): number | null {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(raw) ? Math.max(60, Math.floor(raw)) : null;
}

function oauthTokenResponse(
  issued: { token: string; record: { audience: string; scopes: string[]; expiresAt: string; issuer: string } },
  introspection: { subject: string | null; principal: unknown }
) {
  const expiresMs = Date.parse(issued.record.expiresAt) - Date.now();
  return {
    access_token: issued.token,
    token_type: 'Bearer',
    issued_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    expires_in: Math.max(0, Math.floor(expiresMs / 1000)),
    scope: issued.record.scopes.join(' '),
    issuer: issued.record.issuer,
    audience: issued.record.audience,
    subject: introspection.subject,
    principal: introspection.principal,
    expires_at: issued.record.expiresAt
  };
}
