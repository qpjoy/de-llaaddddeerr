import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { ReleaseReportInput } from '../../types.js';

@Controller()
export class ReleaseController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('internal/v1/release/tasks')
  async tasks(@Query('installId') installId?: string) {
    return { tasks: installId ? await this.store.listTasks(installId) : [] };
  }

  @Post('internal/v1/release/reports')
  async report(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const input: ReleaseReportInput = {
      taskId: nullableString(body.taskId) ?? undefined,
      installId: nullableString(body.installId) ?? undefined,
      status: nullableString(body.status) ?? undefined,
      error: nullableString(body.error),
      metadata: asRecord(body.metadata)
    };
    return { auditEvent: await this.store.recordReleaseReport(input) };
  }

  @Post('internal/v1/releases/policy/evaluate')
  async evaluatePolicy(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      decision: await this.store.evaluateReleaseUpdate({
        componentKind: nullableString(body.componentKind) ?? 'app-managed',
        componentId: nullableString(body.componentId) ?? 'h2o',
        currentVersion: nullableString(body.currentVersion) ?? '0.0.0',
        targetVersion: nullableString(body.targetVersion) ?? '0.0.0',
        channel: nullableString(body.channel) ?? 'shadow',
        installId: nullableString(body.installId),
        userId: nullableString(body.userId)
      })
    };
  }
}
