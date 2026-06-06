import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { IdentityLinkRequest } from '../../types.js';

@Controller()
export class EnrollmentsController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Post('internal/v1/enrollments/anonymous')
  async enrollAnonymous(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return this.store.enrollAnonymous({
      productId: nullableString(body.productId) ?? undefined,
      siteId: nullableString(body.siteId) ?? undefined,
      installId: nullableString(body.installId) ?? undefined,
      deviceId: nullableString(body.deviceId) ?? undefined,
      deviceLabel: nullableString(body.deviceLabel) ?? undefined,
      platform: nullableString(body.platform) ?? undefined,
      publicKey: nullableString(body.publicKey) ?? undefined,
      relayMode: nullableString(body.relayMode) ?? undefined,
      requestId: nullableString(body.requestId) ?? undefined
    });
  }

  @Post('internal/v1/identity/link')
  async linkIdentity(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const input: IdentityLinkRequest = {
      installId: requiredString(body.installId, 'installId'),
      userId: requiredString(body.userId, 'userId'),
      requestId: nullableString(body.requestId) ?? undefined,
      authProvider: nullableString(body.authProvider) ?? undefined
    };
    return this.store.linkIdentity(input);
  }

  @Get('internal/v1/config/snapshots/:installId')
  async getSnapshot(@Param('installId') installId: string) {
    const snapshot = await this.store.getSnapshot(installId);
    if (!snapshot) throw new NotFoundException('Config snapshot not found');
    return { snapshot };
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw new BadRequestException(`${name} is required`);
}
