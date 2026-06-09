import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE, RUNTIME_CONFIG } from '../../tokens.js';
import type {
  ConfigPolicySnapshotInput,
  RuntimeConfig,
  RuntimeFeaturePolicy,
  RuntimeFeaturePolicyInput,
  SiteSlotSshProfile,
  SiteSlotSshProfileBootstrapInput,
  SiteSlotSshProfileInput
} from '../../types.js';
import { prepareSiteSlotSshProfileBootstrap } from './ssh-profile-bootstrap.js';
import { SSH_READONLY_PROBE_FEATURE_KEY, buildSshProfileReadinessProbe } from './ssh-profile-readiness.js';

@Controller()
export class ConfigCenterController {
  constructor(
    @Inject(PLATFORM_STORE) private readonly store: PlatformStore,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig
  ) {}

  @Get('internal/v1/config-center/capabilities')
  async capabilities() {
    return {
      authority: 'config-center',
      capabilities: [
        'policy-snapshot.issue',
        'policy-snapshot.sign',
        'launcher-network.aggregate',
        'dns-policy.aggregate',
        'release-policy.aggregate',
        'site-slot-ssh-profile.manage',
        'site-slot-ssh-profile.bootstrap',
        'runtime-feature-policy.manage'
      ]
    };
  }

  @Get('internal/v1/config-center/runtime-feature-policies')
  async listRuntimeFeaturePolicies(@Query('featureKey') featureKey?: string) {
    return { policies: await this.store.listRuntimeFeaturePolicies(featureKey?.trim() || null) };
  }

  @Post('internal/v1/config-center/runtime-feature-policies')
  async upsertRuntimeFeaturePolicy(@Body() rawBody: unknown) {
    return { policy: await this.store.upsertRuntimeFeaturePolicy(toRuntimeFeaturePolicyInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/config-center/runtime-feature-policies/:policyId')
  async getRuntimeFeaturePolicy(@Param('policyId') policyId: string) {
    const policy = await this.store.getRuntimeFeaturePolicy(policyId);
    if (!policy) throw new NotFoundException('Runtime feature policy not found');
    return { policy };
  }

  @Get('internal/v1/config-center/site-slot-ssh-profiles')
  async listSiteSlotSshProfiles() {
    return { profiles: await this.store.listSiteSlotSshProfiles() };
  }

  @Get('internal/v1/config-center/site-slot-ssh-profiles/site/:siteId')
  async getSiteSlotSshProfileForSite(@Param('siteId') siteId: string) {
    const profile = await this.store.getSiteSlotSshProfileForSite(siteId);
    if (!profile) throw new NotFoundException('Site slot SSH profile not found for site');
    return { profile };
  }

  @Get('internal/v1/config-center/site-slot-ssh-profiles/:profileId')
  async getSiteSlotSshProfile(@Param('profileId') profileId: string) {
    const profile = await this.store.getSiteSlotSshProfile(profileId);
    if (!profile) throw new NotFoundException('Site slot SSH profile not found');
    return { profile };
  }

  @Post('internal/v1/config-center/site-slot-ssh-profiles')
  async upsertSiteSlotSshProfile(@Body() rawBody: unknown) {
    return { profile: await this.store.upsertSiteSlotSshProfile(toSshProfileInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/config-center/site-slot-ssh-profiles/bootstrap')
  async bootstrapSiteSlotSshProfile(@Body() rawBody: unknown) {
    const { profileInput, bootstrap } = await prepareSiteSlotSshProfileBootstrap(
      this.config,
      toSshProfileBootstrapInput(asRecord(rawBody))
    );
    return {
      profile: await this.store.upsertSiteSlotSshProfile(profileInput),
      bootstrap
    };
  }

  @Post('internal/v1/config-center/site-slot-ssh-profiles/:profileId/readiness-probe')
  async probeSiteSlotSshProfileReadiness(@Param('profileId') profileId: string, @Body() rawBody: unknown) {
    const profile = await this.store.getSiteSlotSshProfile(profileId);
    if (!profile) throw new NotFoundException('Site slot SSH profile not found');
    const body = asRecord(rawBody);
    const policies = await this.store.listRuntimeFeaturePolicies(SSH_READONLY_PROBE_FEATURE_KEY);
    return {
      readiness: await buildSshProfileReadinessProbe(
        profile,
        {
          confirmReadOnlyProbe: booleanValue(body.confirmReadOnlyProbe),
          executeReadOnlyProbe: booleanValue(body.executeReadOnlyProbe),
          requestedBy: nullableString(body.requestedBy),
          requestId: nullableString(body.requestId)
        },
        resolveRuntimeFeaturePolicy(profile, policies)
      )
    };
  }

  @Post('internal/v1/config-center/snapshots/effective')
  async createEffectiveSnapshot(@Body() rawBody: unknown) {
    return { snapshot: await this.store.createConfigPolicySnapshot(toSnapshotInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/config-center/snapshots/:snapshotId')
  async getSnapshot(@Param('snapshotId') snapshotId: string) {
    const snapshot = await this.store.getConfigPolicySnapshot(snapshotId);
    if (!snapshot) throw new NotFoundException('Config policy snapshot not found');
    return { snapshot };
  }

  @Post('internal/v1/sdk/config/snapshot')
  async sdkSnapshot(@Body() rawBody: unknown) {
    return { snapshot: await this.store.createConfigPolicySnapshot(toSnapshotInput(asRecord(rawBody))) };
  }
}

function toSnapshotInput(body: Record<string, unknown>): ConfigPolicySnapshotInput {
  return {
    installId: nullableString(body.installId),
    deviceId: nullableString(body.deviceId),
    appId: nullableString(body.appId),
    productId: nullableString(body.productId),
    channel: nullableString(body.channel),
    userId: nullableString(body.userId),
    token: nullableString(body.token),
    audience: nullableString(body.audience),
    requestId: nullableString(body.requestId)
  };
}

function toSshProfileInput(body: Record<string, unknown>): SiteSlotSshProfileInput {
  return {
    profileId: nullableString(body.profileId),
    siteId: nullableString(body.siteId),
    kind: nullableString(body.kind) as SiteSlotSshProfileInput['kind'],
    host: nullableString(body.host),
    sshUser: nullableString(body.sshUser),
    sshPort: numberOrNull(body.sshPort),
    identityFile: nullableString(body.identityFile),
    knownHostsFile: nullableString(body.knownHostsFile),
    hostKeyAlias: nullableString(body.hostKeyAlias),
    strictHostKeyChecking: nullableString(body.strictHostKeyChecking),
    connectTimeoutSeconds: numberOrNull(body.connectTimeoutSeconds),
    batchMode: nullableString(body.batchMode),
    status: nullableString(body.status),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toSshProfileBootstrapInput(body: Record<string, unknown>): SiteSlotSshProfileBootstrapInput {
  return {
    profileId: nullableString(body.profileId),
    siteId: nullableString(body.siteId),
    kind: nullableString(body.kind) as SiteSlotSshProfileBootstrapInput['kind'],
    host: nullableString(body.host),
    sshUser: nullableString(body.sshUser),
    sshPort: numberOrNull(body.sshPort),
    password: nullableString(body.password),
    hostKeyAlias: nullableString(body.hostKeyAlias),
    connectTimeoutSeconds: numberOrNull(body.connectTimeoutSeconds),
    rotateKey: booleanOrNull(body.rotateKey),
    scanHostKey: booleanOrNull(body.scanHostKey),
    executeBootstrap: booleanOrNull(body.executeBootstrap),
    confirmBootstrap: booleanOrNull(body.confirmBootstrap),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toRuntimeFeaturePolicyInput(body: Record<string, unknown>): RuntimeFeaturePolicyInput {
  return {
    featureKey: nullableString(body.featureKey),
    scopeKind: nullableString(body.scopeKind),
    scopeId: nullableString(body.scopeId),
    enabled: booleanOrNull(body.enabled),
    mode: nullableString(body.mode),
    expiresAt: nullableString(body.expiresAt),
    requiresApproval: booleanOrNull(body.requiresApproval),
    reason: nullableString(body.reason),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function resolveRuntimeFeaturePolicy(
  profile: SiteSlotSshProfile,
  policies: RuntimeFeaturePolicy[]
): RuntimeFeaturePolicy | null {
  return policies.find((policy) => policy.scopeKind === 'profile' && policy.scopeId === profile.profileId)
    ?? policies.find((policy) => policy.scopeKind === 'site' && policy.scopeId === profile.siteId)
    ?? policies.find((policy) => policy.scopeKind === 'global')
    ?? null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return null;
}
