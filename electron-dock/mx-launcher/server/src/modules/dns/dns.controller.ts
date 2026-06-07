import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';

@Controller()
export class DnsController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('internal/v1/dns/policies')
  async listPolicies() {
    return { policies: await this.store.listDnsPolicies() };
  }

  @Get('internal/v1/dns/policies/effective')
  async effectivePolicy(@Query('appId') appId?: string) {
    return { policy: await this.store.getEffectiveDnsPolicy(appId ?? null) };
  }

  @Post('internal/v1/dns/evaluate')
  async evaluate(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return { decision: await this.store.evaluateDnsQuery(toDnsInput(body)) };
  }

  @Get('internal/v1/dns/reverse-proxy/routes')
  async reverseProxyRoutes() {
    return { routes: await this.store.listDnsReverseProxyRoutes() };
  }

  @Get('internal/v1/sdk/dns/policy')
  async sdkPolicy(@Query('appId') appId?: string) {
    return { policy: await this.store.getEffectiveDnsPolicy(appId ?? 'sdk-gateway') };
  }

  @Post('internal/v1/sdk/dns/evaluate')
  async sdkEvaluate(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      decision: await this.store.evaluateDnsQuery({
        ...toDnsInput(body),
        appId: nullableString(body.appId) ?? 'sdk-gateway'
      })
    };
  }
}

function toDnsInput(body: Record<string, unknown>) {
  return {
    domain: nullableString(body.domain) ?? '',
    appId: nullableString(body.appId),
    installId: nullableString(body.installId),
    userId: nullableString(body.userId),
    requestId: nullableString(body.requestId)
  };
}
