import { Body, Controller, Get, Inject, Post } from '@nestjs/common';

import { asRecord, nullableString, stringArray } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type {
  CreateServiceAccountInput,
  CreateUserInput,
  IssueTokenInput,
  PrincipalContextInput,
  TokenIntrospectionInput
} from '../../types.js';

@Controller()
export class UserCenterController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('internal/v1/user-center/capabilities')
  async capabilities() {
    return {
      authority: 'user-center',
      capabilities: [
        'oauth.authority',
        'jwt.introspection',
        'principal.context',
        'rbac.policy',
        'service-account'
      ],
      sdkGateway: await this.store.sdkGatewayManifest()
    };
  }

  @Post('internal/v1/user-center/bootstrap')
  async bootstrap() {
    return { userCenter: await this.store.bootstrapUserCenter() };
  }

  @Get('internal/v1/user-center/roles')
  async roles() {
    return { roles: await this.store.listUserCenterRoles() };
  }

  @Get('internal/v1/user-center/users')
  async users() {
    return { users: await this.store.listUserCenterUsers() };
  }

  @Post('internal/v1/user-center/users')
  async createUser(@Body() rawBody: unknown) {
    return { user: await this.store.createUserCenterUser(toCreateUserInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/user-center/service-accounts')
  async serviceAccounts() {
    return { serviceAccounts: await this.store.listUserCenterServiceAccounts() };
  }

  @Post('internal/v1/user-center/service-accounts')
  async createServiceAccount(@Body() rawBody: unknown) {
    return {
      serviceAccount: await this.store.createUserCenterServiceAccount(toCreateServiceAccountInput(asRecord(rawBody)))
    };
  }

  @Post('internal/v1/user-center/tokens/issue')
  async issueToken(@Body() rawBody: unknown) {
    return { issued: await this.store.issueUserCenterToken(toIssueTokenInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/user-center/token/introspect')
  async introspect(@Body() rawBody: unknown) {
    return { introspection: await this.store.introspectToken(toTokenInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/user-center/principal/resolve')
  async resolvePrincipal(@Body() rawBody: unknown) {
    return { context: await this.store.resolvePrincipalContext(toPrincipalInput(asRecord(rawBody))) };
  }
}

export function toTokenInput(body: Record<string, unknown>): TokenIntrospectionInput {
  return {
    token: nullableString(body.token),
    audience: nullableString(body.audience),
    requestId: nullableString(body.requestId)
  };
}

function toCreateUserInput(body: Record<string, unknown>): CreateUserInput {
  return {
    userId: nullableString(body.userId),
    email: nullableString(body.email),
    displayName: nullableString(body.displayName),
    roleIds: stringArray(body.roleIds),
    orgIds: stringArray(body.orgIds),
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

function toIssueTokenInput(body: Record<string, unknown>): IssueTokenInput {
  const subjectKind = nullableString(body.subjectKind);
  return {
    subjectKind: subjectKind === 'user' ? 'user' : 'service-account',
    subjectId: nullableString(body.subjectId) ?? 'svc_sdk_gateway',
    audience: nullableString(body.audience),
    scopes: stringArray(body.scopes),
    ttlSeconds: numberValue(body.ttlSeconds),
    requestId: nullableString(body.requestId)
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toPrincipalInput(body: Record<string, unknown>): PrincipalContextInput {
  return {
    token: nullableString(body.token),
    audience: nullableString(body.audience),
    userId: nullableString(body.userId),
    anonymousPrincipalId: nullableString(body.anonymousPrincipalId),
    serviceAccountId: nullableString(body.serviceAccountId),
    installId: nullableString(body.installId),
    requestId: nullableString(body.requestId)
  };
}
