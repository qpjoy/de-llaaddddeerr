import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Header, Headers, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import { assertInternalOpsToken, INTERNAL_OPS_TOKEN_HEADER } from '../../lib/internal-ops-auth.js';
import { appReleasePublisherServiceAccountId, buildAppCenterApp } from '../../store/domain.js';
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
  @Header('Cache-Control', 'no-store')
  async createApp(
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() body: AppCenterAppInput
  ) {
    assertInternalOpsToken(opsToken);
    return this.upsertAppWithPublisher(body || {});
  }

  @Post('apps/:appId')
  @Header('Cache-Control', 'no-store')
  async upsertApp(
    @Param('appId') appId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined,
    @Body() body: AppCenterAppInput
  ) {
    assertInternalOpsToken(opsToken);
    return this.upsertAppWithPublisher({ ...(body || {}), appId });
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
  async deleteApp(
    @Param('appId') appId: string,
    @Headers(INTERNAL_OPS_TOKEN_HEADER) opsToken: string | undefined
  ) {
    assertInternalOpsToken(opsToken);
    try {
      const deleted = await this.store.deleteAppCenterApp(appId);
      if (!deleted) throw new NotFoundException('AppCenter app not found');
      return { deleted: true };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException(error instanceof Error ? error.message : 'AppCenter app cannot be deleted');
    }
  }

  private async upsertAppWithPublisher(input: AppCenterAppInput) {
    let app: AppCenterApp;
    try {
      const requestedAppId = input.appId?.trim() || '';
      const previous = requestedAppId ? await this.store.getAppCenterApp(requestedAppId) : null;
      const candidate = buildAppCenterApp(input, previous);
      const packageName = candidate.packageName?.trim().toLowerCase() || null;
      if (packageName) {
        const conflicting = (await this.store.listAppCenterApps({
          includeHidden: true,
          includeDisabled: true
        })).find((item) => (
          item.appId !== candidate.appId
          && buildAppCenterApp(item, item).packageName?.trim().toLowerCase() === packageName
        ));
        if (conflicting) {
          throw new ConflictException(
            `AppCenter packageName ${packageName} is already registered by ${conflicting.appId}`
          );
        }
      }
      app = await this.store.upsertAppCenterApp(input);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      const message = error instanceof Error ? error.message : 'AppCenter app cannot be saved';
      if (message.startsWith('Release publisher service account collision:')) {
        throw new ConflictException(message);
      }
      throw new BadRequestException(message);
    }
    if (app.enabled === false) {
      return { app, publisher: null };
    }
    const serviceAccountId = appReleasePublisherServiceAccountId(app.appId);
    const existing = (await this.store.listUserCenterServiceAccounts())
      .find((item) => item.serviceAccountId === serviceAccountId) ?? null;
    if (
      existing
      && (
        existing.allowedProductIds?.length !== 1
        || existing.allowedProductIds[0] !== app.appId
      )
    ) {
      throw new ConflictException(
        `Release Publisher service account ${serviceAccountId} is already bound to another product`
      );
    }
    const serviceAccount = existing ?? await this.store.createUserCenterServiceAccount({
      serviceAccountId,
      displayName: `${app.displayName} Release Publisher`,
      roleIds: ['mx-release-publisher'],
      scopes: ['sdk.release.read', 'sdk.release.publish'],
      allowedProductIds: [app.appId],
      requestId: input.requestedBy?.trim() || `app-center-publisher-${app.appId}`
    });
    const status = await this.store.getUserCenterServiceAccountCredential(serviceAccountId);
    let credential = null;
    if (!status) {
      try {
        credential = await this.store.issueUserCenterServiceAccountCredential({
          serviceAccountId,
          requestedBy: input.requestedBy?.trim() || 'app-center',
          requestId: `app-center-publisher-credential-${app.appId}`
        });
      } catch (error) {
        if (!serviceAccountCredentialAlreadyExists(error)) {
          throw error;
        }
      }
    }
    return {
      app,
      publisher: {
        serviceAccount,
        credential
      }
    };
  }
}

function serviceAccountCredentialAlreadyExists(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes('credential already exists');
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
