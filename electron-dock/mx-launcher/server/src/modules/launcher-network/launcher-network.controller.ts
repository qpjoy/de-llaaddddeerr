import { Body, Controller, Inject, Post } from '@nestjs/common';

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
        userId: nullableString(body.userId),
        appId: nullableString(body.appId) ?? 'h2o',
        requestId: nullableString(body.requestId) ?? undefined
      })
    };
  }
}
