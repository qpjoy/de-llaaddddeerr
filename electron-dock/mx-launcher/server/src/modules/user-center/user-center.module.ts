import { Module } from '@nestjs/common';

import { UserCenterController } from './user-center.controller.js';
import { RegistrationController } from '../../registration/controller.js';

@Module({
  controllers: [UserCenterController, RegistrationController]
})
export class UserCenterModule {}
