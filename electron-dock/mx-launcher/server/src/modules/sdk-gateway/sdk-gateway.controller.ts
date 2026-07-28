import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Ip,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException
} from '@nestjs/common';

import { authenticationRateLimitBucketKey } from '../../lib/auth-rate-limit.js';
import { asRecord, nullableString, stringArray } from '../../lib/http.js';
import { assertInternalOpsToken, INTERNAL_OPS_TOKEN_HEADER } from '../../lib/internal-ops-auth.js';
import { userMatchesLogin } from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { CreateServiceAccountInput, CreateUserInput, SdkGatewayAccessInput } from '../../types.js';
import { toPrincipalInput, toTokenInput } from '../user-center/user-center.controller.js';
import { FeishuAuthService } from './feishu-auth.service.js';

const USER_ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const SERVICE_ACCOUNT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const OAUTH_RATE_LIMIT_WINDOW_SECONDS = 5 * 60;
const PASSWORD_SOURCE_ATTEMPT_LIMIT = 60;
const PASSWORD_SUBJECT_ATTEMPT_LIMIT = 25;
const PASSWORD_SOURCE_SUBJECT_ATTEMPT_LIMIT = 10;
const SERVICE_SOURCE_ATTEMPT_LIMIT = 30;
const SERVICE_SUBJECT_ATTEMPT_LIMIT = 25;
const SERVICE_SOURCE_SUBJECT_ATTEMPT_LIMIT = 10;

@Controller()
export class SdkGatewayController {
  constructor(
    @Inject(PLATFORM_STORE) private readonly store: PlatformStore,
    private readonly feishuAuth: FeishuAuthService
  ) {}

  @Get('internal/v1/sdk/gateway/manifest')
  async manifest() {
    return { gateway: await this.store.sdkGatewayManifest() };
  }

  @Post('internal/v1/sdk/identity/introspect')
  async introspect(@Body() rawBody: unknown) {
    return { introspection: await this.store.introspectToken(toTokenInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/sdk/oauth/token')
  async token(
    @Body() rawBody: unknown,
    @Ip() sourceIp?: string,
    @Headers('x-mx-forwarded-by') forwardedBy?: string
  ) {
    const body = asRecord(rawBody);
    const grantType = nullableString(body.grant_type) ?? nullableString(body.grantType) ?? 'password';
    if (grantType !== 'password' && grantType !== 'client_credentials') {
      throw new BadRequestException('Unsupported OAuth grant_type');
    }
    if (grantType === 'client_credentials') {
      if (forwardedBy?.trim().toLowerCase() === 'domestic-edge') {
        throw new UnauthorizedException('client_credentials is restricted to the Internal control plane');
      }
      return this.issueServiceAccountToken(body, sourceIp);
    }
    return this.issueUserToken(body, sourceIp);
  }

  @Get('internal/v1/sdk/oauth/feishu/config')
  feishuConfig() {
    return { config: this.feishuAuth.publicConfig() };
  }

  @Post('internal/v1/sdk/oauth/feishu/authorize')
  async feishuAuthorize(@Body() rawBody: unknown, @Ip() sourceIp?: string) {
    const body = asRecord(rawBody);
    return this.feishuAuth.authorize({
      redirectUri: exactString(body.redirectUri),
      state: exactString(body.state),
      codeChallenge: exactString(body.codeChallenge),
      sourceKey: sourceIp
    });
  }

  @Post('internal/v1/sdk/oauth/feishu/token')
  async feishuToken(@Body() rawBody: unknown, @Ip() sourceIp?: string) {
    const body = asRecord(rawBody);
    const result = await this.feishuAuth.exchange({
      code: exactString(body.code),
      redirectUri: exactString(body.redirectUri),
      codeVerifier: exactString(body.codeVerifier),
      exchangeHandle: exactString(body.exchangeHandle),
      audience: nullableString(body.audience),
      scopes: oauthScopes(body.scope, undefined),
      requestId: nullableString(body.requestId),
      sourceKey: sourceIp
    });
    return { token: oauthTokenResponse(result.issued, result.introspection) };
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
  async roles(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return { roles: await this.store.listUserCenterRoles() };
  }

  @Get('internal/v1/sdk/users')
  async users(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return { users: await this.store.listUserCenterUsers() };
  }

  @Post('internal/v1/sdk/users')
  async createUser(
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
    return { user: await this.store.createUserCenterUser(toCreateUserInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/sdk/users/me/password')
  async updateOwnPassword(
    @Headers('authorization') authorization: string | undefined,
    @Ip() sourceIp: string | undefined,
    @Body() rawBody: unknown
  ) {
    const body = asRecord(rawBody);
    const currentPassword = nullableString(body.currentPassword);
    const newPassword = nullableString(body.newPassword);
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('currentPassword and newPassword are required');
    }
    const auth = await this.assertActiveSdkBearer(
      authorization,
      nullableString(body.requestId)
    );
    const principal = auth.principal;
    if (auth.tokenKind !== 'jwt' || principal.kind !== 'user' || !principal.userId) {
      throw new ForbiddenException('Only an authenticated user can change their own password');
    }
    await this.assertOAuthAttemptRateLimit({
      grantType: 'password-change',
      sourceIp,
      subject: principal.userId,
      sourceLimit: PASSWORD_SOURCE_ATTEMPT_LIMIT,
      subjectLimit: PASSWORD_SUBJECT_ATTEMPT_LIMIT,
      sourceSubjectLimit: PASSWORD_SOURCE_SUBJECT_ATTEMPT_LIMIT
    });
    const verification = await this.store.verifyUserCenterPassword({
      userId: principal.userId,
      password: currentPassword,
      requestId: nullableString(body.requestId)
    });
    if (!verification.ok) throw new UnauthorizedException('current password is invalid');
    try {
      return {
        password: await this.store.updateUserCenterPassword({
          userId: principal.userId,
          password: newPassword,
          requestedBy: principal.principalId,
          requestId: nullableString(body.requestId)
        })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('User not found:')) throw new NotFoundException(message);
      throw new BadRequestException(message);
    }
  }

  @Post('internal/v1/sdk/users/:userId/password')
  async updateUserPassword(
    @Param('userId') userId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() rawBody: unknown
  ) {
    const body = asRecord(rawBody);
    const principal = await this.assertSdkUserWriteAuthorization(
      authorization,
      nullableString(body.requestId)
    );
    try {
      return {
        password: await this.store.updateUserCenterPassword({
          userId,
          password: nullableString(body.password),
          requestedBy: principal.principalId,
          requestId: nullableString(body.requestId)
        })
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('User not found:')) throw new NotFoundException(message);
      throw new BadRequestException(message);
    }
  }

  @Get('internal/v1/sdk/service-accounts')
  async serviceAccounts(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return { serviceAccounts: await this.store.listUserCenterServiceAccounts() };
  }

  @Post('internal/v1/sdk/service-accounts')
  async createServiceAccount(
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() rawBody: unknown
  ) {
    assertInternalOpsToken(opsToken);
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

  private async issueUserToken(body: Record<string, unknown>, sourceIp?: string) {
    const username = nullableString(body.username) ?? nullableString(body.account) ?? nullableString(body.email);
    const password = nullableString(body.password);
    if (!username || !password) throw new UnauthorizedException('username and password are required');
    const users = await this.store.listUserCenterUsers();
    const user = users.find((item) => userMatchesLogin(item, username));
    await this.assertOAuthAttemptRateLimit({
      grantType: 'password',
      sourceIp,
      subject: user?.userId ?? username,
      sourceLimit: PASSWORD_SOURCE_ATTEMPT_LIMIT,
      subjectLimit: PASSWORD_SUBJECT_ATTEMPT_LIMIT,
      sourceSubjectLimit: PASSWORD_SOURCE_SUBJECT_ATTEMPT_LIMIT
    });
    if (!user || user.status !== 'active') throw new UnauthorizedException('invalid credentials');
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
      authProvider: 'local-password',
      ttlSeconds: Math.min(
        numberValue(body.expires_in) ?? numberValue(body.ttlSeconds) ?? USER_ACCESS_TOKEN_TTL_SECONDS,
        USER_ACCESS_TOKEN_TTL_SECONDS
      ),
      requestId: nullableString(body.requestId)
    });
    const introspection = await this.store.introspectToken({
      token: issued.token,
      audience: issued.record.audience,
      requestId: nullableString(body.requestId)
    });
    return { token: oauthTokenResponse(issued, introspection) };
  }

  private async issueServiceAccountToken(body: Record<string, unknown>, sourceIp?: string) {
    const clientId = nullableString(body.client_id) ?? nullableString(body.clientId);
    const clientSecret = nullableString(body.client_secret) ?? nullableString(body.clientSecret);
    if (!clientId || !clientSecret) throw new UnauthorizedException('client_id and client_secret are required');
    await this.assertOAuthAttemptRateLimit({
      grantType: 'client-credentials',
      sourceIp,
      subject: clientId,
      sourceLimit: SERVICE_SOURCE_ATTEMPT_LIMIT,
      subjectLimit: SERVICE_SUBJECT_ATTEMPT_LIMIT,
      sourceSubjectLimit: SERVICE_SOURCE_SUBJECT_ATTEMPT_LIMIT
    });
    assertInternalOpsToken(clientSecret);
    const serviceAccounts = await this.store.listUserCenterServiceAccounts();
    const serviceAccount = serviceAccounts.find((item) => item.status === 'active' && item.serviceAccountId === clientId);
    if (!serviceAccount) throw new UnauthorizedException('service account is not active');
    const issued = await this.store.issueUserCenterToken({
      subjectKind: 'service-account',
      subjectId: serviceAccount.serviceAccountId,
      audience: nullableString(body.audience) ?? 'mx-sdk',
      scopes: oauthScopes(body.scope, body.scopes),
      ttlSeconds: numberValue(body.expires_in)
        ?? numberValue(body.ttlSeconds)
        ?? SERVICE_ACCOUNT_ACCESS_TOKEN_TTL_SECONDS,
      requestId: nullableString(body.requestId)
    });
    const introspection = await this.store.introspectToken({
      token: issued.token,
      audience: issued.record.audience,
      requestId: nullableString(body.requestId)
    });
    return { token: oauthTokenResponse(issued, introspection) };
  }

  private async assertSdkUserWriteAuthorization(authorization?: string, requestId?: string | null) {
    const auth = await this.assertActiveSdkBearer(authorization, requestId);
    if (!auth.scopes.some((scope) => scope === 'sdk.user.write' || scope === 'rbac.manage')) {
      throw new ForbiddenException('missing scope: sdk.user.write or rbac.manage');
    }
    return auth.principal;
  }

  private async assertActiveSdkBearer(authorization?: string, requestId?: string | null) {
    const token = bearerToken(authorization);
    if (!token) throw new UnauthorizedException('Bearer access token is required');
    if (token.startsWith('mx-shadow-')) {
      throw new UnauthorizedException('Shadow tokens cannot update User Center passwords');
    }
    const auth = await this.store.introspectToken({
      token,
      audience: 'mx-sdk',
      requestId: requestId ?? undefined
    });
    if (!auth.active || !auth.principal || (auth.tokenKind !== 'jwt' && auth.tokenKind !== 'service-token')) {
      throw new UnauthorizedException('Bearer access token is not active');
    }
    return { ...auth, principal: auth.principal };
  }

  private async assertOAuthAttemptRateLimit(input: {
    grantType: 'password' | 'client-credentials' | 'password-change';
    sourceIp?: string;
    subject: string;
    sourceLimit: number;
    subjectLimit: number;
    sourceSubjectLimit: number;
  }): Promise<void> {
    const source = input.sourceIp?.trim() || 'unknown-source';
    const subject = input.subject.trim().toLowerCase() || 'unknown-subject';
    const decisions = await this.store.consumeAuthenticationRateLimits([
      {
        bucketKey: authenticationRateLimitBucketKey(`${input.grantType}-source`, source),
        limit: input.sourceLimit,
        windowSeconds: OAUTH_RATE_LIMIT_WINDOW_SECONDS
      },
      {
        bucketKey: authenticationRateLimitBucketKey(`${input.grantType}-subject`, subject),
        limit: input.subjectLimit,
        windowSeconds: OAUTH_RATE_LIMIT_WINDOW_SECONDS
      },
      {
        bucketKey: authenticationRateLimitBucketKey(
          `${input.grantType}-source-subject`,
          `${source}\n${subject}`
        ),
        limit: input.sourceSubjectLimit,
        windowSeconds: OAUTH_RATE_LIMIT_WINDOW_SECONDS
      }
    ]);
    const denied = decisions.filter((decision) => !decision.allowed);
    if (denied.length === 0) return;
    throw new HttpException({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: 'Too many authentication attempts',
      retryAfterSeconds: Math.max(...denied.map((decision) => decision.retryAfterSeconds))
    }, HttpStatus.TOO_MANY_REQUESTS);
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

function exactString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bearerToken(authorization?: string): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function oauthTokenResponse(
  issued: { token: string; record: { audience: string; scopes: string[]; expiresAt: string; issuer: string } },
  introspection: { subject: string | null; principal: unknown; authProvider?: string | null }
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
    auth_provider: introspection.authProvider ?? null,
    expires_at: issued.record.expiresAt
  };
}
