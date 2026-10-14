import { Module } from '@nestjs/common';

import { UserCenterController } from './user-center.controller.js';
import { RegistrationController } from '../../registration/controller.js';
import { DataportAccountsController } from '../../registration/dataport-accounts.js';

@Module({
  controllers: [UserCenterController, RegistrationController, DataportAccountsController]
})
export class UserCenterModule {}
