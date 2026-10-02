import { Module } from '@nestjs/common';

import { AdminController } from './admin.controller.js';
import { ServiceOperationsController } from './service-operations.controller.js';

@Module({
  controllers: [AdminController, ServiceOperationsController]
})
export class AdminModule {}
