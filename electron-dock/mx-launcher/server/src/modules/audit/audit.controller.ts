import { Body, Controller, Inject, Post } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { AuditEventInput } from '../../types.js';

@Controller()
export class AuditController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Post('internal/v1/audit/events')
  async recordAudit(@Body() rawBody: unknown) {
    const event = await this.store.recordAudit(toAuditInput(asRecord(rawBody)));
    return { event };
  }
}

function toAuditInput(body: Record<string, unknown>): AuditEventInput {
  return {
    // Never accept provenance from the request body. SDK-ingested audit records are
    // useful for diagnostics but are not trusted server evidence.
    provenance: 'client',
    eventType: nullableString(body.eventType) ?? undefined,
    actorKind: nullableString(body.actorKind) ?? undefined,
    userId: nullableString(body.userId),
    anonymousPrincipalId: nullableString(body.anonymousPrincipalId),
    installId: nullableString(body.installId),
    deviceId: nullableString(body.deviceId),
    productId: nullableString(body.productId),
    siteId: nullableString(body.siteId),
    requestId: nullableString(body.requestId),
    traceId: nullableString(body.traceId),
    overlayIp: nullableString(body.overlayIp),
    configSnapshotId: nullableString(body.configSnapshotId),
    metadata: asRecord(body.metadata)
  };
}
