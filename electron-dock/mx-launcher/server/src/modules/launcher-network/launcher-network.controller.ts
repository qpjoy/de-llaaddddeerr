import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';

@Controller('internal/v1/launcher-network')
export class LauncherNetworkController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Post('snapshots')
  async createSnapshot(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      snapshot: await this.store.createLauncherNetworkSnapshot({
        installId: nullableString(body.installId) ?? undefined,
        deviceId: nullableString(body.deviceId) ?? undefined,
        siteId: nullableString(body.siteId),
        userId: nullableString(body.userId),
        publicKey: nullableString(body.publicKey),
        appId: nullableString(body.appId) ?? 'h2o',
        launcherMode: launcherProductMode(nullableString(body.launcherMode)),
        requestId: nullableString(body.requestId) ?? undefined
      })
    };
  }

  @Post('enrollments')
  async enrollLease(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      lease: await this.store.enrollLauncherNetworkLease({
        productId: nullableString(body.productId),
        mode: nullableString(body.mode),
        identityKind: nullableString(body.identityKind),
        installId: nullableString(body.installId),
        deviceId: nullableString(body.deviceId),
        siteId: nullableString(body.siteId),
        userId: nullableString(body.userId),
        publicKey: nullableString(body.publicKey),
        deviceLabel: nullableString(body.deviceLabel),
        platform: nullableString(body.platform),
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }

  @Get('leases')
  async listLeases() {
    return {
      leases: await this.store.listLauncherNetworkLeases()
    };
  }

  @Get('leases/:leaseId')
  async getLease(@Param('leaseId') leaseId: string) {
    const lease = await this.store.getLauncherNetworkLease(leaseId);
    if (!lease) throw new NotFoundException('Launcher network lease not found');
    return { lease };
  }

  @Get('products')
  async listProductNetworks() {
    return {
      products: await this.store.listLauncherProductNetworks()
    };
  }

  @Get('products/:productId')
  async getProductNetwork(@Param('productId') productId: string) {
    const product = await this.store.getLauncherProductNetwork(productId);
    if (!product) throw new NotFoundException('Launcher product network not found');
    return { product };
  }

  @Post('products/:productId')
  async upsertProductNetwork(@Param('productId') productId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      product: await this.store.upsertLauncherProductNetwork({
        productId,
        displayName: nullableString(body.displayName),
        mode: nullableString(body.mode),
        productIndex: numberValue(body.productIndex),
        serviceVip: nullableString(body.serviceVip),
        userCidr: nullableString(body.userCidr),
        anonymousCidr: nullableString(body.anonymousCidr),
        userLeaseStart: nullableString(body.userLeaseStart),
        userLeaseEnd: nullableString(body.userLeaseEnd),
        anonymousLeaseStart: nullableString(body.anonymousLeaseStart),
        anonymousLeaseEnd: nullableString(body.anonymousLeaseEnd),
        defaultDomesticSiteId: nullableString(body.defaultDomesticSiteId),
        defaultOverseaSiteId: nullableString(body.defaultOverseaSiteId),
        updatePolicy: nullableString(body.updatePolicy),
        rateLimitProfile: nullableString(body.rateLimitProfile),
        dnsPolicyId: nullableString(body.dnsPolicyId),
        licensePolicyId: nullableString(body.licensePolicyId),
        enabled: typeof body.enabled === 'boolean' ? body.enabled : null,
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }

  @Get('mihomo/sites/:siteId')
  async getMihomoSite(@Param('siteId') siteId: string) {
    const site = await this.store.getLauncherNetworkMihomoSite(siteId);
    if (!site) throw new NotFoundException('Launcher Network mihomo site not found');
    return { site };
  }

  @Get('mihomo/sites/:siteId/reachability')
  async getMihomoSiteReachability(@Param('siteId') siteId: string) {
    const reachability = await this.store.getLauncherNetworkMihomoReachability(siteId);
    if (!reachability) throw new NotFoundException('Launcher Network mihomo reachability plan not found');
    return { reachability };
  }

  @Post('mihomo/sites/:siteId')
  async upsertMihomoSite(@Param('siteId') siteId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      site: await this.store.upsertLauncherNetworkMihomoSite({
        siteId,
        publicHost: nullableString(body.publicHost),
        serverPorts: nullableString(body.serverPorts),
        tlsFingerprint: nullableString(body.tlsFingerprint),
        subscriptionBaseUrl: nullableString(body.subscriptionBaseUrl),
        routingPolicy: nullableString(body.routingPolicy),
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }
}

function launcherProductMode(value: string | null): 'standalone' | 'embed' | null {
  if (value === 'standalone' || value === 'embed') return value;
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
