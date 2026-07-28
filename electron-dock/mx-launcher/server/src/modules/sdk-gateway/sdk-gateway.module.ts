import { Module } from '@nestjs/common';

import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE, RUNTIME_CONFIG } from '../../tokens.js';
import type { RuntimeConfig } from '../../types.js';
import { FeishuAuthService } from './feishu-auth.service.js';
import { SdkGatewayController } from './sdk-gateway.controller.js';

@Module({
  controllers: [SdkGatewayController],
  providers: [
    {
      provide: FeishuAuthService,
      useFactory: (config: RuntimeConfig, store: PlatformStore) => new FeishuAuthService(config, store),
      inject: [RUNTIME_CONFIG, PLATFORM_STORE]
    }
  ]
})
export class SdkGatewayModule {}
