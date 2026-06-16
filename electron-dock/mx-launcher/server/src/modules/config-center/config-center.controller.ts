import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE, RUNTIME_CONFIG } from '../../tokens.js';
import type {
  AwxProviderCheckInput,
  AwxProviderConfigInput,
  AwxProviderSyncPlanInput,
  ConfigPolicySnapshotInput,
  RuntimeConfig,
  RuntimeFeaturePolicy,
  RuntimeFeaturePolicyInput,
  SiteSlotKind,
  SiteSlotDomesticWireGuardSecret,
  SiteSlotDomesticWireGuardSecretInput,
  SiteSlotSshProfile,
  SiteSlotSshProfileBootstrapInput,
  SiteSlotSshProfileInput
} from '../../types.js';
import { checkAwxProvider } from './awx-provider-check.js';
import { buildAwxProviderSyncPlan } from './awx-provider-sync-plan.js';
import { prepareSiteSlotSshProfileBootstrap } from './ssh-profile-bootstrap.js';
import { SSH_READONLY_PROBE_FEATURE_KEY, buildSshProfileReadinessProbe } from './ssh-profile-readiness.js';
import { generateWireGuardKeyPair } from './wireguard-keys.js';

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
        'awx-provider.manage',
        'awx-provider.check',
        'awx-provider.sync-plan',
        'site-slot-ssh-profile.manage',
        'site-slot-ssh-profile.bootstrap',
        'domestic-wg-secret.manage',
        'domestic-wg-secret.generate',
        'domestic-wg-secret.materializer-env',
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

  @Get('internal/v1/config-center/awx-providers')
  async listAwxProviderConfigs(@Query('kind') rawKind?: string) {
    return { providers: await this.store.listAwxProviderConfigs(toAwxProviderKind(rawKind)) };
  }

  @Post('internal/v1/config-center/awx-providers')
  async upsertAwxProviderConfig(@Body() rawBody: unknown) {
    return { provider: await this.store.upsertAwxProviderConfig(toAwxProviderConfigInput(asRecord(rawBody))) };
  }

  @Post('internal/v1/config-center/awx-providers/:providerId/check')
  async checkAwxProviderConfig(@Param('providerId') providerId: string, @Body() rawBody: unknown) {
    const provider = await this.store.getAwxProviderConfig(providerId);
    if (!provider) throw new NotFoundException('AWX provider config not found');
    const input = toAwxProviderCheckInput(asRecord(rawBody));
    const check = await checkAwxProvider(provider, input);
    await this.store.recordAudit({
      eventType: 'config.awx_provider.checked',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        providerId: provider.providerId,
        status: check.status,
        baseUrl: check.baseUrl,
        targetKind: check.targetKind,
        inventory: check.inventory,
        jobTemplate: check.jobTemplate,
        failures: check.failures,
        endpoints: check.endpoints.map((endpoint) => ({
          name: endpoint.name,
          status: endpoint.status,
          httpStatus: endpoint.httpStatus,
          count: endpoint.count
        }))
      }
    });
    return { check };
  }

  @Post('internal/v1/config-center/awx-providers/:providerId/sync-plan')
  async planAwxProviderSync(@Param('providerId') providerId: string, @Body() rawBody: unknown) {
    const provider = await this.store.getAwxProviderConfig(providerId);
    if (!provider) throw new NotFoundException('AWX provider config not found');
    const input = toAwxProviderSyncPlanInput(asRecord(rawBody));
    const syncPlan = buildAwxProviderSyncPlan(provider, input);
    await this.store.recordAudit({
      eventType: 'config.awx_provider.sync_plan_created',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        providerId: provider.providerId,
        status: syncPlan.status,
        targetKind: syncPlan.targetKind,
        inventory: syncPlan.inventory,
        inventoryHost: syncPlan.inventoryHost,
        credential: syncPlan.credential,
        jobTemplate: syncPlan.jobTemplate,
        blockedReasons: syncPlan.blockedReasons
      }
    });
    return { syncPlan };
  }

  @Get('internal/v1/config-center/awx-providers/:providerId')
  async getAwxProviderConfig(@Param('providerId') providerId: string) {
    const provider = await this.store.getAwxProviderConfig(providerId);
    if (!provider) throw new NotFoundException('AWX provider config not found');
    return { provider };
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

  @Get('internal/v1/config-center/domestic-wg-secrets')
  async listDomesticWireGuardSecrets() {
    const secrets = await this.store.listSiteSlotDomesticWireGuardSecrets();
    return { secrets: secrets.map(redactDomesticWireGuardSecret) };
  }

  @Get('internal/v1/config-center/domestic-wg-secrets/:siteId')
  async getDomesticWireGuardSecret(@Param('siteId') siteId: string) {
    const secret = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
    if (!secret) throw new NotFoundException('Domestic WireGuard secret not found');
    return { secret: redactDomesticWireGuardSecret(secret) };
  }

  @Post('internal/v1/config-center/domestic-wg-secrets')
  async upsertDomesticWireGuardSecret(@Body() rawBody: unknown) {
    const secret = await this.store.upsertSiteSlotDomesticWireGuardSecret(toDomesticWireGuardSecretInput(asRecord(rawBody)));
    return { secret: redactDomesticWireGuardSecret(secret) };
  }

  @Post('internal/v1/config-center/domestic-wg-secrets/:siteId/generate')
  async generateDomesticWireGuardSecret(@Param('siteId') siteId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const previous = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
    const generated = toGeneratedDomesticWireGuardSecretInput(siteId, previous, body);
    const secret = await this.store.upsertSiteSlotDomesticWireGuardSecret(generated.input);
    await this.store.recordAudit({
      eventType: 'config.domestic_wg_secret.generated',
      actorKind: 'config-center',
      requestId: generated.input.requestId ?? null,
      metadata: {
        secretId: secret.secretId,
        siteId: secret.siteId,
        publicEndpoint: secret.publicEndpoint,
        generated: generated.generated,
        rotate: generated.rotate,
        endpointChanged: generated.endpointChanged,
        materialDigest: secret.fingerprints.materialDigest
      }
    });
    return {
      secret: redactDomesticWireGuardSecret(secret),
      generation: {
        status: secret.readiness.missingSecretInputs.length === 0 ? 'ready' : 'blocked',
        boundary: 'internal-generated-domestic-wg-secret',
        siteId: secret.siteId,
        secretId: secret.secretId,
        publicEndpoint: secret.publicEndpoint,
        generated: generated.generated,
        rotate: generated.rotate,
        endpointChanged: generated.endpointChanged,
        previousMaterialDigest: generated.previousMaterialDigest,
        materialDigest: secret.fingerprints.materialDigest,
        clientRefresh: {
          mode: 'snapshot-digest',
          changed: generated.previousMaterialDigest !== secret.fingerprints.materialDigest,
          previousMaterialDigest: generated.previousMaterialDigest,
          materialDigest: secret.fingerprints.materialDigest
        },
        nextActions: secret.readiness.missingSecretInputs.length === 0
          ? ['materialize-domestic-ready-artifacts', 'publish-config-snapshot-for-client-refresh']
          : ['provide-missing-domestic-wg-inputs']
      }
    };
  }

  @Post('internal/v1/config-center/domestic-wg-secrets/:siteId/materializer-env')
  async domesticWireGuardSecretMaterializerEnv(@Param('siteId') siteId: string, @Body() rawBody: unknown) {
    const secret = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
    if (!secret) throw new NotFoundException('Domestic WireGuard secret not found');
    return {
      export: domesticWireGuardSecretExport(secret, asRecord(rawBody))
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
    sshConfigFile: nullableString(body.sshConfigFile),
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

function toDomesticWireGuardSecretInput(body: Record<string, unknown>): SiteSlotDomesticWireGuardSecretInput {
  return {
    siteId: nullableString(body.siteId),
    status: nullableString(body.status),
    publicEndpoint: nullableString(body.publicEndpoint),
    listenPort: numberOrNull(body.listenPort),
    domesticGatewayIp: nullableString(body.domesticGatewayIp),
    domesticGatewayCidr: nullableString(body.domesticGatewayCidr),
    productRelayCidrs: cidrListValue(body.productRelayCidrs),
    userRelayCidr: nullableString(body.userRelayCidr),
    internalServiceIp: nullableString(body.internalServiceIp),
    internalServiceCidr: nullableString(body.internalServiceCidr),
    guestRelayCidr: nullableString(body.guestRelayCidr),
    domesticRelayPrivateKey: nullableString(body.domesticRelayPrivateKey),
    domesticRelayPublicKey: nullableString(body.domesticRelayPublicKey),
    internalServicePrivateKey: nullableString(body.internalServicePrivateKey),
    internalServicePublicKey: nullableString(body.internalServicePublicKey),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toGeneratedDomesticWireGuardSecretInput(
  siteId: string,
  previous: SiteSlotDomesticWireGuardSecret | null,
  body: Record<string, unknown>
) {
  const rotateAll = booleanValue(body.rotateKey) || booleanValue(body.rotateAll);
  const rotateRelayKey = rotateAll || booleanValue(body.rotateRelayKey);
  const rotateInternalServiceKey = rotateAll || booleanValue(body.rotateInternalServiceKey);
  const relayMissing = !previous?.domesticRelayPrivateKey || !previous.domesticRelayPublicKey;
  const internalMissing = !previous?.internalServicePrivateKey || !previous.internalServicePublicKey;
  const relayPair = relayMissing || rotateRelayKey ? generateWireGuardKeyPair() : null;
  const internalPair = internalMissing || rotateInternalServiceKey ? generateWireGuardKeyPair() : null;
  const publicEndpoint = nullableString(body.publicEndpoint) ?? nullableString(body.endpoint) ?? previous?.publicEndpoint ?? null;
  const input: SiteSlotDomesticWireGuardSecretInput = {
    siteId,
    status: nullableString(body.status) ?? previous?.status ?? 'active',
    publicEndpoint,
    listenPort: numberOrNull(body.listenPort) ?? previous?.listenPort ?? 51820,
    domesticGatewayIp: nullableString(body.domesticGatewayIp) ?? previous?.domesticGatewayIp ?? '10.88.0.1',
    domesticGatewayCidr: nullableString(body.domesticGatewayCidr) ?? previous?.domesticGatewayCidr ?? '10.88.0.0/16',
    productRelayCidrs: cidrListValue(body.productRelayCidrs) ?? previous?.productRelayCidrs ?? ['10.89.0.0/16', '10.90.0.0/16'],
    userRelayCidr: nullableString(body.userRelayCidr) ?? previous?.userRelayCidr ?? '10.89.0.0/16',
    internalServiceIp: nullableString(body.internalServiceIp) ?? previous?.internalServiceIp ?? '10.88.88.88',
    internalServiceCidr: nullableString(body.internalServiceCidr) ?? previous?.internalServiceCidr ?? '10.88.0.0/16',
    guestRelayCidr: nullableString(body.guestRelayCidr) ?? previous?.guestRelayCidr ?? '10.90.0.0/16',
    domesticRelayPrivateKey: relayPair?.privateKey ?? previous?.domesticRelayPrivateKey ?? null,
    domesticRelayPublicKey: relayPair?.publicKey ?? previous?.domesticRelayPublicKey ?? null,
    internalServicePrivateKey: internalPair?.privateKey ?? previous?.internalServicePrivateKey ?? null,
    internalServicePublicKey: internalPair?.publicKey ?? previous?.internalServicePublicKey ?? null,
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
  return {
    input,
    generated: {
      domesticRelayKeyPair: Boolean(relayPair),
      internalServiceKeyPair: Boolean(internalPair)
    },
    rotate: {
      domesticRelayKeyPair: rotateRelayKey,
      internalServiceKeyPair: rotateInternalServiceKey
    },
    endpointChanged: Boolean(previous && publicEndpoint && previous.publicEndpoint !== publicEndpoint),
    previousMaterialDigest: previous?.fingerprints.materialDigest ?? null
  };
}

function redactDomesticWireGuardSecret(secret: SiteSlotDomesticWireGuardSecret) {
  return {
    secretId: secret.secretId,
    siteId: secret.siteId,
    kind: secret.kind,
    environment: secret.environment,
    status: secret.status,
    publicEndpoint: secret.publicEndpoint,
    listenPort: secret.listenPort,
    domesticGatewayIp: secret.domesticGatewayIp,
    domesticGatewayCidr: secret.domesticGatewayCidr,
    productRelayCidrs: domesticSecretProductRelayCidrs(secret),
    userRelayCidr: secret.userRelayCidr,
    internalServiceIp: secret.internalServiceIp,
    internalServiceCidr: secret.internalServiceCidr,
    guestRelayCidr: secret.guestRelayCidr,
    material: {
      domesticRelayPrivateKey: secret.domesticRelayPrivateKey ? 'configured' : 'missing',
      domesticRelayPublicKey: secret.domesticRelayPublicKey ? 'configured' : 'missing',
      internalServicePrivateKey: secret.internalServicePrivateKey ? 'configured' : 'missing',
      internalServicePublicKey: secret.internalServicePublicKey ? 'configured' : 'missing'
    },
    fingerprints: secret.fingerprints,
    readiness: secret.readiness,
    createdBy: secret.createdBy,
    createdAt: secret.createdAt,
    updatedBy: secret.updatedBy,
    updatedAt: secret.updatedAt
  };
}

function domesticWireGuardSecretExport(secret: SiteSlotDomesticWireGuardSecret, body: Record<string, unknown>) {
  const confirmSecretExport = booleanValue(body.confirmSecretExport);
  const envGate = process.env.SITE_SLOT_DOMESTIC_WG_SECRET_EXPORT_ENABLED === '1';
  const blockedReasons = [
    ...(confirmSecretExport ? [] : ['confirmSecretExport=true is required before exporting Domestic WG materializer env']),
    ...(envGate ? [] : ['SITE_SLOT_DOMESTIC_WG_SECRET_EXPORT_ENABLED=1 is required on Internal']),
    ...(secret.status === 'active' ? [] : [`Domestic WG secret is ${secret.status}`]),
    ...secret.readiness.missingSecretInputs.map((input) => `missing secret input: ${input}`)
  ];
  const ready = blockedReasons.length === 0;
  return {
    status: ready ? 'ready' : 'blocked',
    boundary: 'internal-secret-export-materializer-env',
    siteId: secret.siteId,
    secretId: secret.secretId,
    confirmSecretExport,
    envGate: envGate ? 'passed' : 'blocked',
    blockedReasons,
    redactedEnvKeys: secret.readiness.materializerEnvKeys,
    env: ready ? domesticWireGuardMaterializerEnv(secret) : {}
  };
}

function domesticWireGuardMaterializerEnv(secret: SiteSlotDomesticWireGuardSecret): Record<string, string> {
  return {
    MX_DOMESTIC_RELAY_PRIVATE_KEY: secret.domesticRelayPrivateKey ?? '',
    MX_DOMESTIC_RELAY_PUBLIC_KEY: secret.domesticRelayPublicKey ?? '',
    MX_INTERNAL_SERVICE_PRIVATE_KEY: secret.internalServicePrivateKey ?? '',
    MX_INTERNAL_SERVICE_PUBLIC_KEY: secret.internalServicePublicKey ?? '',
    MX_DOMESTIC_PUBLIC_ENDPOINT: secret.publicEndpoint ?? '',
    MX_WG_LISTEN_PORT: String(secret.listenPort),
    MX_DOMESTIC_GATEWAY_IP: secret.domesticGatewayIp,
    MX_DOMESTIC_GATEWAY_CIDR: secret.domesticGatewayCidr,
    MX_PRODUCT_RELAY_CIDRS: domesticSecretProductRelayCidrs(secret).join(','),
    MX_USER_RELAY_CIDR: secret.userRelayCidr,
    MX_INTERNAL_SERVICE_IP: secret.internalServiceIp,
    MX_INTERNAL_SERVICE_CIDR: secret.internalServiceCidr,
    MX_GUEST_RELAY_CIDR: secret.guestRelayCidr
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

function toAwxProviderConfigInput(body: Record<string, unknown>): AwxProviderConfigInput {
  return {
    providerId: nullableString(body.providerId),
    name: nullableString(body.name),
    status: nullableString(body.status),
    baseUrl: nullableString(body.baseUrl),
    organization: nullableString(body.organization),
    project: nullableString(body.project),
    inventoryPrefix: nullableString(body.inventoryPrefix),
    credentialPrefix: nullableString(body.credentialPrefix),
    jobTemplatePrefix: nullableString(body.jobTemplatePrefix),
    defaultKind: nullableString(body.defaultKind),
    verifyTls: booleanOrNull(body.verifyTls),
    requestTimeoutSeconds: numberOrNull(body.requestTimeoutSeconds),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toAwxProviderCheckInput(body: Record<string, unknown>): AwxProviderCheckInput {
  return {
    kind: nullableString(body.kind),
    token: nullableString(body.token),
    requestTimeoutSeconds: numberOrNull(body.requestTimeoutSeconds),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toAwxProviderSyncPlanInput(body: Record<string, unknown>): AwxProviderSyncPlanInput {
  return {
    kind: nullableString(body.kind),
    siteId: nullableString(body.siteId),
    host: nullableString(body.host),
    sshUser: nullableString(body.sshUser),
    sshPort: numberOrNull(body.sshPort),
    sshProfileId: nullableString(body.sshProfileId),
    planId: nullableString(body.planId),
    jobId: nullableString(body.jobId),
    sessionId: nullableString(body.sessionId),
    runId: nullableString(body.runId),
    requestId: nullableString(body.requestId)
  };
}

function toAwxProviderKind(value: unknown): SiteSlotKind | 'all' | null {
  const kind = typeof value === 'string' ? value.trim() : '';
  if (kind === 'domestic' || kind === 'oversea' || kind === 'all') return kind;
  return null;
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

function cidrListValue(value: unknown): string[] | null {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const cidrs = values
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item) => item.length > 0);
  return cidrs.length ? [...new Set(cidrs)] : null;
}

function domesticSecretProductRelayCidrs(secret: SiteSlotDomesticWireGuardSecret): string[] {
  const cidrs = secret.productRelayCidrs?.length
    ? secret.productRelayCidrs
    : [secret.userRelayCidr, secret.internalServiceCidr, secret.guestRelayCidr];
  return [...new Set(cidrs.filter((cidr) => Boolean(cidr)))];
}
