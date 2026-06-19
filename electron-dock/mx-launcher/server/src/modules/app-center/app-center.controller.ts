import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';

import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { AppCenterAppInput } from '../../types.js';

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

  @Post('apps')
  async createApp(@Body() body: AppCenterAppInput) {
    return { app: await this.store.upsertAppCenterApp(body || {}) };
  }

  @Post('apps/:appId')
  async upsertApp(@Param('appId') appId: string, @Body() body: AppCenterAppInput) {
    return { app: await this.store.upsertAppCenterApp({ ...(body || {}), appId }) };
  }

  @Delete('apps/:appId')
  async deleteApp(@Param('appId') appId: string) {
    try {
      const deleted = await this.store.deleteAppCenterApp(appId);
      if (!deleted) throw new NotFoundException('AppCenter app not found');
      return { deleted: true };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException(error instanceof Error ? error.message : 'AppCenter app cannot be deleted');
    }
  }
}
