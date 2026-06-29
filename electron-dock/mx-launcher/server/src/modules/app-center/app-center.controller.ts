import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { AppCenterAppInput, AppOnboardingDefaultsInput } from '../../types.js';

@Controller('internal/v1/app-center')
export class AppCenterController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('apps')
  async listApps(
    @Query('userId') userId?: string,
    @Query('sourceAppId') sourceAppId?: string,
    @Query('includeHidden') includeHidden?: string,
    @Query('includeDisabled') includeDisabled?: string
  ) {
    return {
      apps: await this.store.listAppCenterApps({
        userId: nullableQuery(userId),
        sourceAppId: nullableQuery(sourceAppId),
        includeHidden: booleanQuery(includeHidden),
        includeDisabled: booleanQuery(includeDisabled)
      })
    };
  }

  @Get('onboarding/defaults')
  async onboardingTemplates() {
    return { templates: await this.store.listAppOnboardingTemplates() };
  }

  @Post('onboarding/defaults')
  async onboardingDefaults(@Body() body: AppOnboardingDefaultsInput) {
    return { defaults: await this.store.getAppOnboardingDefaults(body || {}) };
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

function nullableQuery(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanQuery(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  return value === '1' || value.toLowerCase() === 'true';
}
