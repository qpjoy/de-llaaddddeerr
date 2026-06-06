import { Module } from '@nestjs/common';

import { PermissionsController } from './permissions.controller.js';

@Module({
  controllers: [PermissionsController]
})
export class PermissionsModule {}
