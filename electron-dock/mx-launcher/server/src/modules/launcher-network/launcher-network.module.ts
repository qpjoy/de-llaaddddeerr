import { Module } from '@nestjs/common';

import { LauncherNetworkController } from './launcher-network.controller.js';

@Module({
  controllers: [LauncherNetworkController]
})
export class LauncherNetworkModule {}
