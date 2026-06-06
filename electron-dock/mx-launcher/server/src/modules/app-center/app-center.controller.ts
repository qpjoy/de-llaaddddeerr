import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';

import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';

@Controller('internal/v1/app-center')
export class AppCenterController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('apps')
  async listApps() {
    return { apps: await this.store.listAppCenterApps() };
  }

  @Get('apps/:appId')
  async getApp(@Param('appId') appId: string) {
    const app = await this.store.getAppCenterApp(appId);
    if (!app) throw new NotFoundException('AppCenter app not found');
    return { app };
  }
}
