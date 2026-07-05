import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import { asRecord, nullableString, stringArray } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import type { ReleaseManagementE2eResult, ReleaseManagementPlanInput, ReleaseReportInput } from '../../types.js';

@Controller()
export class ReleaseController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('internal/v1/release/tasks')
  async tasks(@Query('installId') installId?: string) {
    return { tasks: installId ? await this.store.listTasks(installId) : [] };
  }

  @Post('internal/v1/release/reports')
  async report(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const input: ReleaseReportInput = {
      taskId: nullableString(body.taskId) ?? undefined,
      installId: nullableString(body.installId) ?? undefined,
      status: nullableString(body.status) ?? undefined,
      error: nullableString(body.error),
      metadata: asRecord(body.metadata)
    };
    return { auditEvent: await this.store.recordReleaseReport(input) };
  }

  @Post('internal/v1/releases/policy/evaluate')
  async evaluatePolicy(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      decision: await this.store.evaluateReleaseUpdate({
        componentKind: nullableString(body.componentKind) ?? 'app-managed',
        componentId: nullableString(body.componentId) ?? 'h2o',
        currentVersion: nullableString(body.currentVersion) ?? '0.0.0',
        targetVersion: nullableString(body.targetVersion) ?? '0.0.0',
        channel: nullableString(body.channel) ?? 'shadow',
        installId: nullableString(body.installId),
        userId: nullableString(body.userId)
      })
    };
  }

  @Get('internal/v1/release-management/plans')
  async listManagementPlans() {
    return { plans: await this.store.listReleaseManagementPlans() };
  }

  @Post('internal/v1/release-management/plans')
  async createManagementPlan(@Body() rawBody: unknown) {
    return { plan: await this.store.createReleaseManagementPlan(toReleaseManagementPlanInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/release-management/plans/:planId')
  async getManagementPlan(@Param('planId') planId: string) {
    const plan = await this.store.getReleaseManagementPlan(planId);
    if (!plan) throw new NotFoundException('Release management plan not found');
    return { plan };
  }
}

function toReleaseManagementPlanInput(body: Record<string, unknown>): ReleaseManagementPlanInput {
  return {
    releaseId: nullableString(body.releaseId),
    channel: nullableString(body.channel),
    installId: nullableString(body.installId),
    userId: nullableString(body.userId),
    productId: nullableString(body.productId),
    appId: nullableString(body.appId),
    launcherComponentId: nullableString(body.launcherComponentId),
    appComponentId: nullableString(body.appComponentId),
    launcherUpdatePolicy: nullableString(body.launcherUpdatePolicy),
    appUpdatePolicy: nullableString(body.appUpdatePolicy),
    launcherCurrentVersion: nullableString(body.launcherCurrentVersion),
    launcherTargetVersion: nullableString(body.launcherTargetVersion),
    appCurrentVersion: nullableString(body.appCurrentVersion),
    appTargetVersion: nullableString(body.appTargetVersion),
    artifactKind: nullableString(body.artifactKind),
    artifactVersion: nullableString(body.artifactVersion),
    artifactUrl: nullableString(body.artifactUrl),
    artifactDigest: nullableString(body.artifactDigest),
    artifactSignature: nullableString(body.artifactSignature),
    activationMode: nullableString(body.activationMode),
    rolloutStrategy: nullableString(body.rolloutStrategy),
    rolloutPercentage: nullableNumber(body.rolloutPercentage),
    rolloutSegment: nullableString(body.rolloutSegment),
    rolloutRings: stringArray(body.rolloutRings),
    featureKeys: stringArray(body.featureKeys),
    suiteId: nullableString(body.suiteId),
    topology: nullableString(body.topology),
    sites: stringArray(body.sites),
    e2eResult: releaseManagementE2eResult(body.e2eResult),
    createdBy: nullableString(body.createdBy),
    requestId: nullableString(body.requestId)
  };
}

function releaseManagementE2eResult(value: unknown): ReleaseManagementE2eResult | null {
  if (value === 'passed' || value === 'failed' || value === 'blocked' || value === 'running') return value;
  return null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
