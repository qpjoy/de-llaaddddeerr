import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

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

  @Post('internal/v1/dns/zones/build')
  async buildZone(@Body() rawBody: unknown) {
    return { snapshot: await this.store.buildDnsZoneSnapshot(toDnsZoneInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/dns/zones/:snapshotId')
  async getZone(@Param('snapshotId') snapshotId: string) {
    const snapshot = await this.store.getDnsZoneSnapshot(snapshotId);
    if (!snapshot) throw new NotFoundException('DNS zone snapshot not found');
    return { snapshot };
  }

  @Post('internal/v1/dns/coredns/configmap/sync')
  async syncCoreDnsConfigMap(@Body() rawBody: unknown) {
    return { result: await this.store.syncCoreDnsConfigMap(toCoreDnsSyncInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/dns/coredns/configmap/apply')
  async applyCoreDnsConfigMap(@Body() rawBody: unknown) {
    return { result: await this.store.applyCoreDnsConfigMap(toCoreDnsApplyInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/sdk/dns/policy')
  async sdkPolicy(@Query('appId') appId?: string) {
    return { policy: await this.store.getEffectiveDnsPolicy(appId ?? 'sdk-gateway') };
  }

  @Post('internal/v1/sdk/dns/zone')
  async sdkZone(@Body() rawBody: unknown) {
    return { snapshot: await this.store.buildDnsZoneSnapshot(toDnsZoneInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/sdk/dns/coredns-configmap')
  async sdkCoreDnsConfigMap(@Body() rawBody: unknown) {
    return { result: await this.store.syncCoreDnsConfigMap(toCoreDnsSyncInput(asRecord(rawBody))) };
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

function toCoreDnsSyncInput(body: Record<string, unknown>) {
  const mode = nullableString(body.mode);
  return {
    ...toDnsZoneInput(body),
    snapshotId: nullableString(body.snapshotId),
    namespace: nullableString(body.namespace),
    configMapName: nullableString(body.configMapName),
    mode: mode === 'shadow-apply' ? 'shadow-apply' as const : 'dry-run' as const,
    requestId: nullableString(body.requestId)
  };
}

function toCoreDnsApplyInput(body: Record<string, unknown>) {
  return {
    ...toCoreDnsSyncInput(body),
    confirmApply: booleanValue(body.confirmApply),
    serverDryRun: booleanValue(body.serverDryRun),
    actor: nullableString(body.actor)
  };
}

function toDnsZoneInput(body: Record<string, unknown>) {
  return {
    policyId: nullableString(body.policyId),
    appId: nullableString(body.appId),
    requestId: nullableString(body.requestId)
  };
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return null;
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
