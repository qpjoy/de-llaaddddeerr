import { Body, Controller, Get, Inject, Post } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { PrincipalContextInput, TokenIntrospectionInput } from '../../types.js';

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
