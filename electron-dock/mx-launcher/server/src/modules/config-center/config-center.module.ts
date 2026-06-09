import { Module } from '@nestjs/common';

import { ConfigCenterController } from './config-center.controller.js';

@Module({
  controllers: [ConfigCenterController]
})
export class ConfigCenterModule {}
