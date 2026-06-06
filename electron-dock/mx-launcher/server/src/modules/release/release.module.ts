import { Module } from '@nestjs/common';

import { ReleaseController } from './release.controller.js';

@Module({
  controllers: [ReleaseController]
})
export class ReleaseModule {}
