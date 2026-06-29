import { Body, Controller, Inject, Post } from '@nestjs/common';

import { asRecord, nullableString, stringArray } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';

@Controller('internal/v1/permissions')
export class PermissionsController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Post('requests')
  async requestPermission(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      grant: await this.store.requestPermission({
        appId: nullableString(body.appId) ?? 'h2o',
        installId: nullableString(body.installId),
        userId: nullableString(body.userId),
        sourceAppId: nullableString(body.sourceAppId) ?? nullableString(body.source_app_id),
        requestedBy: nullableString(body.requestedBy) ?? 'app-center',
        scopes: stringArray(body.scopes),
        requestId: nullableString(body.requestId) ?? undefined
      })
    };
  }
}
