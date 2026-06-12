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
        requestId: nullableString(body.requestId) ?? undefined
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
