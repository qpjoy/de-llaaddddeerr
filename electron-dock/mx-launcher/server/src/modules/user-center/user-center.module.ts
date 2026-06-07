import { Module } from '@nestjs/common';

import { UserCenterController } from './user-center.controller.js';

@Module({
  controllers: [UserCenterController]
})
export class UserCenterModule {}
