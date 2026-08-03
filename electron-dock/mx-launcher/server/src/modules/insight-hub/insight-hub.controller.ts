import { Controller, Get, Headers, Header } from '@nestjs/common';

import {
  assertInternalOpsToken,
  INTERNAL_OPS_TOKEN_HEADER
} from '../../lib/internal-ops-auth.js';
import { InsightHubClient } from './insight-hub.client.js';

@Controller('internal/v1/insight-hub')
export class InsightHubController {
  constructor(private readonly client: InsightHubClient) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  async overview(@Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined) {
    assertInternalOpsToken(opsToken);
    return { insightHub: await this.client.overview() };
  }
}
