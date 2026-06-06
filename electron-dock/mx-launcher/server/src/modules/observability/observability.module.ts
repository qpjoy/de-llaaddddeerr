import { Module } from '@nestjs/common';

import { ObservabilityController } from './observability.controller.js';

@Module({
  controllers: [ObservabilityController]
})
export class ObservabilityModule {}
