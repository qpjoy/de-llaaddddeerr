import { Global, Module } from '@nestjs/common';

import { loadConfig } from './config.js';
import { createPlatformStore } from './store/factory.js';
import { PLATFORM_STORE, RUNTIME_CONFIG } from './tokens.js';
import type { RuntimeConfig } from './types.js';

const runtimeConfig = loadConfig();

@Global()
@Module({
  providers: [
    { provide: RUNTIME_CONFIG, useValue: runtimeConfig },
    {
      provide: PLATFORM_STORE,
      useFactory: (config: RuntimeConfig) => createPlatformStore(config),
      inject: [RUNTIME_CONFIG]
    }
  ],
  exports: [RUNTIME_CONFIG, PLATFORM_STORE]
})
export class SharedModule {}
