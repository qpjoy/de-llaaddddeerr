import { Body, Controller, Get, Inject, Post } from '@nestjs/common';

import { asRecord } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { LogEntryInput } from '../../types.js';

@Controller()
export class ObservabilityController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Post('internal/v1/observability/logs')
  async recordLogs(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const entries = Array.isArray(body.entries)
      ? body.entries.map((entry) => asRecord(entry) as LogEntryInput)
      : [body as LogEntryInput];
    return this.store.recordLogs(entries);
  }

  @Get('internal/v1/observability/sinks')
  async sinks() {
    return { sinks: await this.store.observabilitySinks() };
  }
}
