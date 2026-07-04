import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { AppCenterApp, AppCenterAppInput, AppCenterInstallation, AppCenterInstallationInput, AppOnboardingDefaultsInput } from '../../types.js';

@Controller('internal/v1/app-center')
export class AppCenterController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('apps')
  async listApps(
    @Query('userId') userId?: string,
    @Query('sourceAppId') sourceAppId?: string,
    @Query('installId') installId?: string,
    @Query('deviceId') deviceId?: string,
    @Query('includeHidden') includeHidden?: string,
    @Query('includeDisabled') includeDisabled?: string
  ) {
    const accessContext = {
      userId: nullableQuery(userId),
      sourceAppId: nullableQuery(sourceAppId),
      includeHidden: booleanQuery(includeHidden),
      includeDisabled: booleanQuery(includeDisabled)
    };
    const apps = await this.store.listAppCenterApps(accessContext);
    const installationQuery = {
      appId: null,
      userId: accessContext.userId,
      sourceAppId: accessContext.sourceAppId,
      installId: nullableQuery(installId),
      deviceId: nullableQuery(deviceId)
    };
    const installations = installationQuery.installId || installationQuery.deviceId || installationQuery.userId
      ? await this.store.listAppCenterInstallations(installationQuery)
      : [];
    return {
      apps: attachInstallations(apps, installations)
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

  @Get('installations')
  async listInstallations(
    @Query('appId') appId?: string,
    @Query('userId') userId?: string,
    @Query('sourceAppId') sourceAppId?: string,
    @Query('installId') installId?: string,
    @Query('deviceId') deviceId?: string,
    @Query('packageName') packageName?: string
  ) {
    return {
      installations: await this.store.listAppCenterInstallations({
        appId: nullableQuery(appId),
        userId: nullableQuery(userId),
        sourceAppId: nullableQuery(sourceAppId),
        installId: nullableQuery(installId),
        deviceId: nullableQuery(deviceId),
        packageName: nullableQuery(packageName)
      })
    };
  }

  @Post('apps/:appId/installations')
  async reportInstallation(@Param('appId') appId: string, @Body() body: AppCenterInstallationInput) {
    try {
      return { installation: await this.store.upsertAppCenterInstallation({ ...(body || {}), appId }) };
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'AppCenter installation cannot be recorded');
    }
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

function attachInstallations(apps: AppCenterApp[], installations: AppCenterInstallation[]) {
  const byAppId = new Map<string, AppCenterInstallation>();
  for (const installation of installations) {
    if (!byAppId.has(installation.appId)) byAppId.set(installation.appId, installation);
  }
  return apps.map((app) => {
    const installation = byAppId.get(app.appId);
    if (!installation) return app;
    return {
      ...app,
      latestVersion: installation.latestVersion || app.version,
      installed: installationIsInstalled(installation),
      installedVersion: installation.installedVersion,
      installedAt: installation.installedAt,
      installSource: installation.installSource,
      installPath: installation.installPath,
      runtimeState: installation.runtimeState,
      status: installation.status,
      errorMessage: installation.errorMessage,
      installation
    };
  });
}

function installationIsInstalled(installation: AppCenterInstallation): boolean {
  return ['installed', 'enabled', 'ready', 'running'].includes(installation.status) || Boolean(installation.installedVersion);
}
