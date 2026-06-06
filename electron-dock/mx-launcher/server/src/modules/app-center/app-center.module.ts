import { Module } from '@nestjs/common';

import { AppCenterController } from './app-center.controller.js';

@Module({
  controllers: [AppCenterController]
})
export class AppCenterModule {}
