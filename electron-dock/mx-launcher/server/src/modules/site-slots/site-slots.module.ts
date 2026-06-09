import { Module } from '@nestjs/common';

import { SiteSlotsController } from './site-slots.controller.js';

@Module({
  controllers: [SiteSlotsController]
})
export class SiteSlotsModule {}
