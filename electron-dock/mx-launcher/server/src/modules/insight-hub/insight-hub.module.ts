import { Module } from '@nestjs/common';

import { InsightHubClient } from './insight-hub.client.js';
import { InsightHubController } from './insight-hub.controller.js';

@Module({
  controllers: [InsightHubController],
  providers: [InsightHubClient]
})
export class InsightHubModule {}
