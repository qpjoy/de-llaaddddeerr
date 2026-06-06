import { Module } from '@nestjs/common';

import { PlatformController } from './platform.controller.js';

@Module({
  controllers: [PlatformController]
})
export class PlatformModule {}
