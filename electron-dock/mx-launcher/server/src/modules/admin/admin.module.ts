import { Module } from '@nestjs/common';

import { AdminController } from './admin.controller.js';

@Module({
  controllers: [AdminController]
})
export class AdminModule {}
