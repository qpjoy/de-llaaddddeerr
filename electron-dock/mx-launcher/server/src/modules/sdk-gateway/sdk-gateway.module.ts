import { Module } from '@nestjs/common';

import { SdkGatewayController } from './sdk-gateway.controller.js';

@Module({
  controllers: [SdkGatewayController]
})
export class SdkGatewayModule {}
