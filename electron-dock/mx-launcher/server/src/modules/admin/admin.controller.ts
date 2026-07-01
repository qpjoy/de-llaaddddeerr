import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { hostname as osHostname, platform as osPlatform, release as osRelease } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import { asRecord } from '../../lib/http.js';
import { kubernetesRequest } from '../../store/kubernetes.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import { checkAwxProvider } from '../config-center/awx-provider-check.js';
import { buildAwxProviderSyncPlan } from '../config-center/awx-provider-sync-plan.js';
import { deriveWireGuardPublicKey, generateWireGuardKeyPair } from '../config-center/wireguard-keys.js';
import { buildSiteSlotRemoteSshGate, buildSiteSlotRemoteSshReadOnlyProbe, buildSiteSlotRemoteSshWorkerHandoff } from '../site-slots/remote-ssh-gate.js';
import { runAwxApiLaunch } from './awx-api-launch.js';
import { runAwxCredentialSync } from './awx-credential-sync.js';
import { runAwxObjectSync } from './awx-object-sync.js';
import {
  AWX_CREDENTIAL_SYNC_FEATURE_KEY,
  AWX_LAUNCH_FEATURE_KEY,
  AWX_OBJECT_SYNC_FEATURE_KEY
} from './awx-runtime-gates.js';
import {
  MX_DEFAULT_APP_DNS_ZONE,
  MX_H2I_PRODUCT_ID
} from '../../store/domain.js';
import type {
  AdminActionDescriptor,
  AdminActionPolicy,
  AdminDashboardSnapshot,
  AdminLauncherServiceVipSmoke,
  AdminLauncherServiceVipSmokeCheck,
  AdminLauncherServiceVipSmokeStatus,
  AdminPipelineHealth,
  AdminSiteSlotPipeline,
  AdminSiteSlotPipelineSummary,
  AdminTimelineEntry,
  AppCenterApp,
  AwxProviderCheckResult,
  AwxProviderConfig,
  DnsReverseProxyRoute,
  LauncherNetworkLease,
  LauncherProductNetwork,
  LauncherNetworkMihomoSite,
  PlatformPrincipal,
  ReleaseManagementPlan,
  RuntimeFeaturePolicy,
  SiteHeartbeat,
  SiteSlotAccessAccount,
  SiteSlotDomesticRuntimeConfig,
  SiteSlotDomesticRuntimeConfigInput,
  SiteSlotDomesticWireGuardSecret,
  SiteSlotDomesticWireGuardSecretInput,
  SiteSlotExecutionRun,
  SiteSlotExecutionMode,
  SiteSlotPlan,
  SiteSlotPlanAccessAccountInput,
  SiteSlotPlanInput,
  SiteSlotKind,
  SiteSlotRollbackExecution,
  SiteSlotRollbackExecutionMode,
  SiteSlotRollbackReport,
  SiteSlotRunnerSession,
  SiteSlotRunnerMode,
  SiteSlotSshProfile,
  SiteSlotWorkerJob,
  SiteSlotWorkerKind,
  SiteSlotWorkerReport,
  SiteSlotWorkerReportInput
} from '../../types.js';

const execFileAsync = promisify(execFile);
const INTERNAL_SERVICE_PEER_ID = 'mx-internal-service-peer';
const INTERNAL_SERVICE_PEER_INTERFACE = 'mx-internal-svc';

@Controller('internal/v1/admin')
export class AdminController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('dashboard')
  async dashboard(
    @Headers('authorization') authorization?: string,
    @Query('limit') rawLimit?: string,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ): Promise<AdminDashboardSnapshot> {
    const limit = numberValue(rawLimit, 10);
    const actionPolicy = await this.buildActionPolicy(authorization, rawToken, rawUserId);
    const [
      overview,
      sites,
      releasePlans,
      pipelines,
      awxProviders,
      runtimeFeaturePolicies,
      launcherApps,
      launcherProducts,
      launcherLeases,
      dnsRoutes,
      domesticSecrets
    ] = await Promise.all([
      this.store.overview(),
      this.store.listSites(),
      this.store.listReleaseManagementPlans(),
      this.buildSiteSlotPipelines(actionPolicy),
      this.store.listAwxProviderConfigs(),
      this.listAwxRuntimePolicies(),
      this.store.listAppCenterApps({ includeHidden: true, includeDisabled: true }),
      this.store.listLauncherProductNetworks(),
      this.store.listLauncherNetworkLeases(),
      this.store.listDnsReverseProxyRoutes(),
      this.store.listSiteSlotDomesticWireGuardSecrets()
    ]);
    const visiblePipelines = limitSiteSlotPipelines(pipelines, limit);
    const summaries = visiblePipelines.map((pipeline) => pipeline.summary);
    const launcherServiceVipSmokes = buildLauncherServiceVipSmokes({
      apps: launcherApps,
      products: launcherProducts,
      leases: launcherLeases,
      dnsRoutes,
      domesticSecrets,
      generatedAt: new Date().toISOString()
    });
    return {
      generatedAt: launcherServiceVipSmokes.generatedAt,
      overview: overview as unknown as Record<string, unknown>,
      actionPolicy,
      sites: sortSites(sites).slice(0, limit),
      latestReleasePlans: sortReleasePlans(releasePlans).slice(0, limit),
      siteSlotPipelines: summaries,
      awxProviders: sortAwxProviderConfigs(awxProviders).slice(0, limit),
      runtimeFeaturePolicies,
      launcherServiceVipSmokes: launcherServiceVipSmokes.smokes,
      nextActions: adminDashboardNextActions(summaries)
    };
  }

  @Post('launcher-service-vip-smokes/domestic-product-cidrs/sync')
  async syncLauncherServiceVipDomesticProductCidrs(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const siteId = stringValue(body.siteId) ?? 'domestic-main';
    const requestedBy = stringValue(body.requestedBy) ?? 'admin-ui';
    const requestId = stringValue(body.requestId) ?? `launcher-service-vip-cidr-sync-${Date.now()}`;
    const [products, previous] = await Promise.all([
      this.store.listLauncherProductNetworks(),
      this.store.getSiteSlotDomesticWireGuardSecret(siteId)
    ]);
    const plan = buildLauncherDomesticProductCidrSync(siteId, products, previous);
    if (plan.status === 'blocked' || !previous) {
      return {
        domesticProductCidrSync: plan,
        secret: previous ? redactAdminDomesticWireGuardSecret(previous) : null
      };
    }

    const secret = plan.addedProductRelayCidrs.length
      ? await this.store.upsertSiteSlotDomesticWireGuardSecret({
        siteId,
        productRelayCidrs: plan.productRelayCidrs,
        requestedBy,
        requestId
      })
      : previous;
    const result = {
      ...plan,
      status: 'passed' as const,
      changed: plan.addedProductRelayCidrs.length > 0,
      productRelayCidrs: domesticSecretProductRelayCidrsForSync(secret),
      materialDigest: secret.fingerprints.materialDigest,
      nextActions: plan.addedProductRelayCidrs.length
        ? [
          'Re-materialize Domestic WG artifact so productRelayCidrs enter the deployable config.',
          'Apply/restart the Domestic relay runtime and re-run Service VIP smoke.'
        ]
        : ['Domestic productRelayCidrs already cover registered standalone products.']
    };
    await this.store.recordAudit({
      eventType: 'launcher.service_vip.domestic_product_cidrs_synced',
      actorKind: 'admin-action',
      siteId,
      requestId,
      metadata: {
        requestedBy,
        previousProductRelayCidrs: plan.previousProductRelayCidrs,
        requiredProductRelayCidrs: plan.requiredProductRelayCidrs,
        addedProductRelayCidrs: plan.addedProductRelayCidrs,
        productRelayCidrs: result.productRelayCidrs,
        productIds: plan.products.map((product) => product.productId)
      }
    });
    return {
      domesticProductCidrSync: result,
      secret: redactAdminDomesticWireGuardSecret(secret)
    };
  }

  @Post('launcher-service-vip-smokes/reconcile')
  async reconcileLauncherServiceVip(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const siteId = stringValue(body.siteId) ?? 'domestic-main';
    const appId = stringValue(body.appId);
    const requestedBy = stringValue(body.requestedBy) ?? 'admin-ui';
    const requestId = stringValue(body.requestId) ?? `launcher-service-vip-reconcile-${Date.now()}`;
    const [products, previous] = await Promise.all([
      this.store.listLauncherProductNetworks(),
      this.store.getSiteSlotDomesticWireGuardSecret(siteId)
    ]);
    const syncPlan = buildLauncherDomesticProductCidrSync(siteId, products, previous);
    if (syncPlan.status === 'blocked' || !previous) {
      return {
        reconcile: launcherServiceVipReconcileResult({
          siteId,
          appId,
          sync: syncPlan,
          blockedReasons: syncPlan.blockedReasons
        }),
        domesticProductCidrSync: syncPlan,
        secret: previous ? redactAdminDomesticWireGuardSecret(previous) : null
      };
    }

    let secret = syncPlan.addedProductRelayCidrs.length
      ? await this.store.upsertSiteSlotDomesticWireGuardSecret({
        siteId,
        productRelayCidrs: syncPlan.productRelayCidrs,
        requestedBy,
        requestId: `${requestId}-cidr-sync`
      })
      : previous;
    const sync = {
      ...syncPlan,
      status: 'passed' as const,
      changed: syncPlan.addedProductRelayCidrs.length > 0,
      productRelayCidrs: domesticSecretProductRelayCidrsForSync(secret),
      materialDigest: secret.fingerprints.materialDigest,
      nextActions: syncPlan.addedProductRelayCidrs.length
        ? ['Domestic productRelayCidrs synced; continuing with artifact and runtime apply.']
        : ['Domestic productRelayCidrs already cover registered standalone products.']
    };
    const plan = stringValue(body.planId)
      ? await this.store.getSiteSlotPlan(stringValue(body.planId) ?? '')
      : await this.latestDomesticPlan(siteId);
    const materialize = await this.materializeDomesticWireGuard(siteId, plan, secret, {
      publicEndpoint: secret.publicEndpoint,
      listenPort: secret.listenPort,
      requestedBy,
      requestId: `${requestId}-materialize`
    });
    secret = materialize.secret ?? secret;
    const domesticRuntimeApply = booleanValue(body.applyDomesticRuntime) === false
      ? null
      : await this.adminDomesticRuntimeConfigApplyResult(siteId, {
        siteId,
        planId: plan?.planId ?? null,
        saveBeforeApply: false,
        confirmDomesticRuntimeApply: true,
        requestedBy,
        requestId: `${requestId}-domestic-runtime-apply`
      });
    const internalServicePeerApply = booleanValue(body.applyInternalServicePeer) === false
      ? null
      : await adminInternalServicePeerApplyResult(siteId, plan, secret, {
        siteId,
        planId: plan?.planId ?? null,
        confirmInternalServicePeerApply: true,
        requestedBy,
        requestId: `${requestId}-internal-service-peer-apply`
      }, this.store);
    const domesticPeerKeySync = booleanValue(body.syncDomesticPeerKey) === false
      ? null
      : await this.adminInternalServicePeerDomesticKeySyncResult(siteId, plan, secret, {
        siteId,
        planId: plan?.planId ?? null,
        confirmDomesticPeerKeySync: true,
        requestedBy,
        requestId: `${requestId}-domestic-peer-key-sync`
      });
    secret = await this.store.getSiteSlotDomesticWireGuardSecret(siteId) ?? secret;
    const reconcile = launcherServiceVipReconcileResult({
      siteId,
      appId,
      sync,
      materialize: materialize.result,
      domesticRuntimeApply,
      internalServicePeerApply,
      domesticPeerKeySync
    });
    await this.store.recordAudit({
      eventType: 'launcher.service_vip.reconciled',
      actorKind: 'admin-action',
      siteId,
      requestId,
      metadata: {
        requestedBy,
        appId: appId ?? null,
        planId: plan?.planId ?? null,
        status: reconcile.status,
        steps: reconcile.steps,
        productRelayCidrs: sync.productRelayCidrs
      }
    });
    return {
      reconcile,
      domesticProductCidrSync: sync,
      domesticWgMaterialize: materialize.result,
      domesticRuntimeApply,
      internalServicePeerApply,
      domesticPeerKeySync,
      secret: secret ? redactAdminDomesticWireGuardSecret(secret) : null
    };
  }

  @Get('actions')
  async actions(
    @Headers('authorization') authorization?: string,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ) {
    return {
      actionPolicy: await this.buildActionPolicy(authorization, rawToken, rawUserId)
    };
  }

  @Post('actions/execute')
  async executeAction(
    @Headers('authorization') authorization: string | undefined,
    @Body() rawBody: unknown,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ) {
    const actionPolicy = await this.buildActionPolicy(authorization, rawToken, rawUserId);
    const input = toAdminActionExecutionInput(asRecord(rawBody));
    const action = actionPolicy.actions.find((item) => item.actionId === input.actionId);
    if (!action) throw new BadRequestException('Admin action is not registered');
    if (!action.allowed) throw new ForbiddenException(action.reason);
    assertConfirmFields(action, input.body);
    const result = await this.dispatchAdminAction(action.actionId, input.path, {
      ...input.body,
      requestedBy: stringValue(input.body.requestedBy) ?? actionPolicy.principal.principalId
    });
    return {
      actionResult: {
        actionId: action.actionId,
        path: input.path,
        gate: action.gate,
        risk: action.risk,
        principalId: actionPolicy.principal.principalId,
        executedAt: new Date().toISOString()
      },
      ...result
    };
  }

  @Get('site-slots/pipelines')
  async siteSlotPipelines(
    @Headers('authorization') authorization?: string,
    @Query('limit') rawLimit?: string,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ) {
    const limit = numberValue(rawLimit, 20);
    const actionPolicy = await this.buildActionPolicy(authorization, rawToken, rawUserId);
    const pipelines = await this.buildSiteSlotPipelines(actionPolicy);
    return {
      actionPolicy,
      pipelines: limitSiteSlotPipelines(pipelines, limit).map((pipeline) => ({
        summary: pipeline.summary,
        timeline: pipeline.timeline
      }))
    };
  }

  @Get('site-slots/pipelines/:planId')
  async siteSlotPipeline(
    @Headers('authorization') authorization: string | undefined,
    @Param('planId') planId: string,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ) {
    const actionPolicy = await this.buildActionPolicy(authorization, rawToken, rawUserId);
    const pipelines = await this.buildSiteSlotPipelines(actionPolicy, planId);
    const pipeline = pipelines[0];
    if (!pipeline) throw new NotFoundException('Admin site slot pipeline not found');
    return { actionPolicy, pipeline };
  }

  @Get('oversea')
  async overseaControlOverview(
    @Headers('authorization') authorization?: string,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ) {
    const actionPolicy = await this.buildActionPolicy(authorization, rawToken, rawUserId);
    return this.buildOverseaOverview(actionPolicy);
  }

  @Post('oversea/:siteId/shadow-setup')
  async shadowSetupOverseaSite(
    @Headers('authorization') authorization: string | undefined,
    @Param('siteId') rawSiteId: string,
    @Body() rawBody: unknown,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ) {
    const actionPolicy = await this.buildActionPolicy(authorization, rawToken, rawUserId);
    assertPrincipalScope(actionPolicy, 'site-slot.manage');
    assertPrincipalScope(actionPolicy, 'site-slot.execute');
    const body = asRecord(rawBody);
    const siteId = sanitizeSiteId(rawSiteId, 'oversea-main');
    const requestedBy = stringValue(body.requestedBy) ?? actionPolicy.principal.principalId;
    const requestId = stringValue(body.requestId) ?? `admin-oversea-shadow-setup-${Date.now()}`;
    const workerInternalBaseUrl = workerInternalBaseUrlFromBody(body);
    const overseaCallbackBaseUrl = overseaCallbackBaseUrlFromBody(body);
    const requestServerPorts = stringValue(body.serverPorts);
    const requestExportPort = numberValueOrNull(body.exportPort);
    const profile = await this.store.upsertSiteSlotSshProfile({
      profileId: stringValue(body.sshProfileId) ?? stringValue(body.profileId),
      siteId,
      kind: 'oversea',
      host: stringValue(body.host),
      sshUser: stringValue(body.sshUser) ?? 'root',
      sshPort: numberValueOrNull(body.sshPort) ?? 22,
      identityFile: stringValue(body.identityFile),
      knownHostsFile: stringValue(body.knownHostsFile),
      sshConfigFile: stringValue(body.sshConfigFile),
      hostKeyAlias: stringValue(body.hostKeyAlias) ?? siteId,
      serverPorts: requestServerPorts,
      exportPort: requestExportPort,
      workerInternalBaseUrl,
      overseaCallbackBaseUrl,
      strictHostKeyChecking: stringValue(body.strictHostKeyChecking) ?? 'yes',
      connectTimeoutSeconds: numberValueOrNull(body.connectTimeoutSeconds) ?? 30,
      batchMode: stringValue(body.batchMode) ?? 'yes',
      status: 'active',
      requestedBy,
      requestId: `${requestId}-ssh-profile`
    });
    const serverPorts = requestServerPorts ?? profile.serverPorts;
    const exportPort = requestExportPort ?? profile.exportPort;
    const access = await this.store.issueSiteSlotAccessAccounts({
      siteId,
      service: 'hysteria2',
      issueDefaults: true,
      publicHost: profile.host,
      serverPorts,
      requestedBy,
      requestId: `${requestId}-internal-mihomo`
    });
    const planAccessAccounts = siteSlotPlanAccessAccountMaterial(await this.store.listSiteSlotAccessAccounts(siteId));
    const provider = await this.resolveAwxProviderConfig('oversea', stringValue(body.awxProviderId) ?? stringValue(body.providerId));
    const awxCheck = provider
      ? await checkAwxProvider(provider, {
        kind: 'oversea',
        token: stringValue(body.awxToken) ?? stringValue(body.token),
        requestTimeoutSeconds: numberValueOrNull(body.awxRequestTimeoutSeconds) ?? numberValueOrNull(body.requestTimeoutSeconds),
        requestedBy,
        requestId: `${requestId}-awx-check`
      })
      : null;
    const plan = await this.store.createSiteSlotPlan({
      siteId,
      kind: 'oversea',
      sshProfileId: profile.profileId,
      host: profile.host,
      sshUser: profile.sshUser,
      sshPort: profile.sshPort,
      rootAccess: profile.sshUser === 'root',
      hasDocker: true,
      hasOutboundInternet: true,
      serverPorts,
      exportPort,
      internalBaseUrl: workerInternalBaseUrl,
      workerInternalBaseUrl,
      overseaCallbackBaseUrl,
      accessAccounts: planAccessAccounts,
      createdBy: requestedBy,
      requestId: `${requestId}-plan`
    });
    const preflight = await this.store.createSiteSlotExecution({
      planId: plan.planId,
      action: 'preflight',
      mode: 'dry-run',
      confirmApply: null,
      requestedBy,
      requestId: `${requestId}-preflight`
    });
    const apply = await this.store.createSiteSlotExecution({
      planId: plan.planId,
      action: 'apply',
      mode: 'manual',
      confirmApply: true,
      requestedBy,
      requestId: `${requestId}-apply`
    });
    const session = await this.store.startSiteSlotRunnerSession({
      runId: apply.runId,
      mode: 'awx-shadow',
      confirmRemoteExecution: true,
      requestedBy,
      requestId: `${requestId}-runner`
    });
    const now = new Date();
    const job = await this.store.createSiteSlotWorkerJob({
      sessionId: session.sessionId,
      workerId: `worker-awx-shadow-${siteId}`,
      workerKind: 'awx-runner',
      approvalId: `shadow-setup-${siteId}`,
      changeWindowStart: now.toISOString(),
      changeWindowEnd: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      retryLimit: 1,
      rollbackStrategy: 'restore-previous-access-stack',
      requestedBy,
      requestId: `${requestId}-worker`
    });
    const awxShadowResult = job.status === 'ready'
      ? awxShadowStepReports(job, plan, profile, provider)
      : null;
    const report = awxShadowResult
      ? await this.store.recordSiteSlotWorkerReport({
        jobId: job.jobId,
        workerId: job.worker.workerId,
        status: awxShadowResult.status,
        message: `AWX shadow setup by admin-ui ${awxShadowResult.status}`,
        stepReports: awxShadowResult.stepReports,
        requestId: `${requestId}-report`
      })
      : null;
    const setup = overseaShadowSetupSummary(siteId, profile, access.site, provider, awxCheck, plan, preflight, apply, session, job, report);
    return {
      shadowSetup: setup,
      profile,
      mihomo: access.site,
      accessAccounts: access.accounts,
      awxProvider: provider,
      awxCheck,
      plan,
      preflight,
      apply,
      runnerSession: session,
      job,
      report,
      oversea: await this.buildOverseaOverview(actionPolicy, setup as unknown as Record<string, unknown>)
    };
  }

  @Post('oversea/:siteId/ensure')
  async ensureOverseaSite(
    @Headers('authorization') authorization: string | undefined,
    @Param('siteId') rawSiteId: string,
    @Body() rawBody: unknown,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ) {
    const actionPolicy = await this.buildActionPolicy(authorization, rawToken, rawUserId);
    assertPrincipalScope(actionPolicy, 'site-slot.execute');
    const body = asRecord(rawBody);
    const siteId = sanitizeSiteId(rawSiteId, 'oversea-main');
    const requestedBy = stringValue(body.requestedBy) ?? actionPolicy.principal.principalId;
    const requestId = stringValue(body.requestId) ?? `admin-oversea-ensure-${Date.now()}`;
    const requestWorkerInternalBaseUrl = stringValue(body.workerInternalBaseUrl) ?? stringValue(body.internalBaseUrl);
    const requestOverseaCallbackBaseUrlProvided = Object.prototype.hasOwnProperty.call(body, 'overseaCallbackBaseUrl');
    const requestOverseaCallbackBaseUrl = overseaCallbackBaseUrlFromBody(body);
    const executeRemote = booleanValue(body.executeRemote) === true;
    const confirmInstall = booleanValue(body.confirmInstall) === true;
    const force = booleanValue(body.force) === true;
    const requestServerPorts = stringValue(body.serverPorts);
    const requestExportPort = numberValueOrNull(body.exportPort);
    const ensureSteps: Array<Record<string, unknown>> = [];

    const profiles = await this.store.listSiteSlotSshProfiles();
    const profile = latestByUpdatedAt(profiles.filter((item) => item.kind === 'oversea' && item.siteId === siteId && item.status === 'active'));
    if (!profile) {
      const ensure = ensureBlocked(siteId, 'missing-ssh-profile', ['Create or bootstrap an Internal-managed SSH profile for this Oversea site.'], ensureSteps);
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }
    ensureSteps.push(overseaEnsureStep('ssh-profile', 'passed', profile.profileId, {
      host: profile.host,
      identityFile: profile.identityFile,
      knownHostsFile: profile.knownHostsFile,
      sshConfigFile: profile.sshConfigFile
    }));

    const profileFailures = sshProfileBlockingReasons(profile);
    if (profileFailures.length > 0) {
      const ensure = ensureBlocked(siteId, 'ssh-profile-not-ready', profileFailures, ensureSteps);
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }
    const serverPorts = requestServerPorts ?? profile.serverPorts;
    const exportPort = requestExportPort ?? profile.exportPort;
    const workerInternalBaseUrl = workerInternalBaseUrlFromSources(
      requestWorkerInternalBaseUrl,
      profile.workerInternalBaseUrl,
      process.env.MX_INTERNAL_BASE_URL
    );
    const overseaCallbackBaseUrl = requestOverseaCallbackBaseUrlProvided
      ? requestOverseaCallbackBaseUrl
      : normalizeOverseaCallbackBaseUrl(profile.overseaCallbackBaseUrl);

    const access = await this.store.issueSiteSlotAccessAccounts({
      siteId,
      service: 'hysteria2',
      issueDefaults: true,
      publicHost: profile.host,
      serverPorts,
      requestedBy,
      requestId
    });
    const planAccessAccounts = siteSlotPlanAccessAccountMaterial(await this.store.listSiteSlotAccessAccounts(siteId));
    ensureSteps.push(overseaEnsureStep('internal-mihomo', 'passed', access.site.siteId, {
      subscriptionBaseUrl: access.site.subscriptionBaseUrl,
      accounts: planAccessAccounts.length
    }));

    if (executeRemote && confirmInstall) {
      const artifactMaterialize = await this.materializeSiteSlotArtifactSet('oversea');
      ensureSteps.push(overseaEnsureStep('artifacts', artifactMaterialize.blockedReasons.length ? 'blocked' : 'passed', artifactMaterialize.manifest?.path ?? 'oversea', {
        execution: artifactMaterialize.execution,
        mode: artifactMaterialize.mode,
        sourceRoot: artifactMaterialize.sourceRoot,
        artifactBaseDir: artifactMaterialize.artifactBaseDir,
        modules: artifactMaterialize.manifest?.modules.map((module) => ({
          moduleId: module.moduleId,
          status: module.status,
          artifact: module.artifact
        })) ?? [],
        blockedReasons: artifactMaterialize.blockedReasons
      }));
      if (artifactMaterialize.blockedReasons.length > 0) {
        const ensure = ensureBlocked(siteId, 'artifact-materialize-failed', artifactMaterialize.blockedReasons, ensureSteps);
        return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
      }
    }

    let plan = await this.findReusableOverseaPlan(siteId, profile.profileId, serverPorts, exportPort, workerInternalBaseUrl, overseaCallbackBaseUrl);
    if (!plan || !reusableOverseaPlanIncludesAccounts(plan, planAccessAccounts)) {
      plan = await this.store.createSiteSlotPlan({
        siteId,
        kind: 'oversea',
        sshProfileId: profile.profileId,
        host: profile.host,
        sshUser: profile.sshUser,
        sshPort: profile.sshPort,
        rootAccess: profile.sshUser === 'root',
        hasDocker: true,
        hasOutboundInternet: true,
        serverPorts,
        exportPort,
        internalBaseUrl: workerInternalBaseUrl,
        workerInternalBaseUrl,
        overseaCallbackBaseUrl,
        accessAccounts: planAccessAccounts,
        createdBy: requestedBy,
        requestId
      });
    }
    ensureSteps.push(overseaEnsureStep('plan', 'passed', plan.planId, { status: plan.status }));

    const preflight = await this.ensureSiteSlotExecution(plan, 'preflight', requestedBy, `${requestId}-preflight`);
    ensureSteps.push(overseaEnsureStep('preflight', normalizeStageStatusForEnsure(preflight.status), preflight.runId, { status: preflight.status }));
    if (preflight.status !== 'ready') {
      const ensure = ensureBlocked(siteId, 'preflight-not-ready', preflight.warnings, ensureSteps, plan.planId);
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }

    const apply = await this.ensureSiteSlotExecution(plan, 'apply', requestedBy, `${requestId}-apply`);
    ensureSteps.push(overseaEnsureStep('apply', normalizeStageStatusForEnsure(apply.status), apply.runId, { status: apply.status, confirmApply: apply.confirmApply }));
    if (apply.status !== 'ready' || !apply.confirmApply) {
      const ensure = ensureBlocked(siteId, 'apply-not-confirmed', apply.warnings, ensureSteps, plan.planId);
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }

    const existingInstallReport = latestByCreatedAt((await this.store.listSiteSlotWorkerReports())
      .filter((report) => report.planId === plan.planId && report.status === 'passed' && workerReportHasRemoteExecution(report)));
    if (existingInstallReport && !force && !(executeRemote && confirmInstall)) {
      const ensure = {
        siteId,
        status: 'installed',
        blockedReasons: [],
        planId: plan.planId,
        jobId: existingInstallReport.jobId,
        reportId: existingInstallReport.reportId,
        steps: [
          ...ensureSteps,
          overseaEnsureStep('worker-report', 'passed', existingInstallReport.reportId, {
            status: existingInstallReport.status,
            mode: workerReportModes(existingInstallReport).join(' / ') || 'artifact-push-remote-ssh'
          })
        ],
        nextActions: ['sync-oversea-status', 'manage-internal-mihomo-subscriptions', 'prepare-domestic-wg-h2i-delivery'],
        generatedAt: new Date().toISOString()
      };
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }

    const session = await this.ensureRemoteRunnerSession(apply, requestedBy, `${requestId}-runner`);
    ensureSteps.push(overseaEnsureStep('remote-runner', normalizeStageStatusForEnsure(session.status), session.sessionId, {
      status: session.status,
      mode: session.mode,
      warnings: session.warnings
    }));
    if (session.status === 'blocked') {
      const ensure = ensureBlocked(siteId, 'remote-runner-blocked', session.warnings, ensureSteps, plan.planId);
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }

    const job = await this.ensureRemoteWorkerJob(session, requestedBy, `${requestId}-worker`);
    ensureSteps.push(overseaEnsureStep('worker-job', normalizeStageStatusForEnsure(job.status), job.jobId, {
      status: job.status,
      workerKind: job.worker.kind,
      warnings: job.warnings
    }));
    if (job.status === 'blocked') {
      const ensure = ensureBlocked(siteId, 'worker-job-blocked', job.warnings, ensureSteps, plan.planId, job.jobId);
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }

    const existingReport = latestByCreatedAt(await this.store.listSiteSlotWorkerReports(job.jobId));
    if (existingReport && !force) {
      const installed = workerReportHasRemoteExecution(existingReport);
      const ensure = {
        siteId,
        status: installed ? 'installed' : existingReport.status,
        blockedReasons: installed ? [] : [`existing worker report is ${existingReport.status}; use force=true to create a new worker run`],
        planId: plan.planId,
        jobId: job.jobId,
        reportId: existingReport.reportId,
        steps: [
          ...ensureSteps,
          overseaEnsureStep('worker-report', normalizeStageStatusForEnsure(existingReport.status), existingReport.reportId, {
            status: existingReport.status,
            mode: workerReportModes(existingReport).join(' / ') || 'unknown'
          })
        ],
        nextActions: installed ? ['sync-oversea-status', 'manage-internal-mihomo-subscriptions'] : ['review-worker-report', 'rerun-with-force-after-fix'],
        generatedAt: new Date().toISOString()
      };
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }

    if (!executeRemote || !confirmInstall) {
      const ensure = {
        siteId,
        status: 'ready-to-install',
        blockedReasons: executeRemote ? ['confirmInstall=true is required before remote SSH install'] : [],
        planId: plan.planId,
        jobId: job.jobId,
        reportId: null,
        steps: ensureSteps,
        nextActions: ['run-install-sync', 'or-review-advanced-audit-actions'],
        generatedAt: new Date().toISOString()
      };
      return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
    }

    const workerRun = await this.runRemoteSshWorker(job.jobId, profile.profileId, workerInternalBaseUrl, requestedBy, requestId);
    const latestReport = latestByCreatedAt(await this.store.listSiteSlotWorkerReports(job.jobId));
    const status = latestReport?.status ?? (workerRun.exitCode === 0 ? 'passed' : 'failed');
    const ensure = {
      siteId,
      status: latestReport && workerReportHasRemoteExecution(latestReport) && latestReport.status === 'passed'
        ? 'installed'
        : normalizeStageStatusForEnsure(status),
      blockedReasons: latestReport?.status === 'passed' ? [] : workerRun.stderr ? [workerRun.stderr.slice(0, 600)] : [],
      planId: plan.planId,
      jobId: job.jobId,
      reportId: latestReport?.reportId ?? null,
      workerRun,
      steps: [
        ...ensureSteps,
        overseaEnsureStep('remote-worker-run', normalizeStageStatusForEnsure(status), latestReport?.reportId ?? job.jobId, {
          exitCode: workerRun.exitCode,
          reportStatus: latestReport?.status ?? null,
          mode: latestReport ? workerReportModes(latestReport).join(' / ') : null
        })
      ],
      nextActions: latestReport?.status === 'passed'
        ? ['sync-oversea-status', 'manage-internal-mihomo-subscriptions', 'prepare-domestic-wg-h2i-delivery']
        : ['open-evidence-history', 'fix-remote-worker-failure', 'rerun-install-sync'],
      generatedAt: new Date().toISOString()
    };
    return { ensure, oversea: await this.buildOverseaOverview(actionPolicy, ensure) };
  }

  @Post('oversea/:siteId/terminal')
  async runOverseaTerminalCommand(
    @Headers('authorization') authorization: string | undefined,
    @Param('siteId') rawSiteId: string,
    @Body() rawBody: unknown,
    @Query('token') rawToken?: string,
    @Query('userId') rawUserId?: string
  ) {
    const actionPolicy = await this.buildActionPolicy(authorization, rawToken, rawUserId);
    assertPrincipalScope(actionPolicy, 'site-slot.execute');
    const body = asRecord(rawBody);
    const siteId = sanitizeSiteId(rawSiteId, 'oversea-main');
    const requestedBy = stringValue(body.requestedBy) ?? actionPolicy.principal.principalId;
    const requestId = stringValue(body.requestId) ?? `admin-oversea-terminal-${Date.now()}`;
    const command = stringValue(body.command) ?? '';
    const timeoutSeconds = terminalTimeoutSeconds(body.timeoutSeconds);
    const profiles = await this.store.listSiteSlotSshProfiles();
    const profile = latestByUpdatedAt(profiles.filter((item) => item.kind === 'oversea' && item.siteId === siteId && item.status === 'active'));
    const gateFailures = [
      ...(!profile ? ['active Oversea SSH profile is required'] : []),
      ...(process.env.SITE_SLOT_WORKER_REMOTE_SSH === '1' ? [] : ['SITE_SLOT_WORKER_REMOTE_SSH=1 is required before remote terminal execution']),
      ...(booleanValue(body.confirmRemoteExecution) === true ? [] : ['confirmRemoteExecution=true is required']),
      ...(booleanValue(body.confirmManualCommand) === true ? [] : ['confirmManualCommand=true is required']),
      ...(!command ? ['command is required'] : []),
      ...(command.length > 8000 ? ['command is too long; limit is 8000 characters'] : []),
      ...(profile?.host ? [] : ['SSH host is required']),
      ...(profile?.identityFile && !existsSync(profile.identityFile) ? [`SSH identity file does not exist: ${profile.identityFile}`] : []),
      ...(profile?.knownHostsFile && !existsSync(profile.knownHostsFile) ? [`SSH known_hosts file does not exist: ${profile.knownHostsFile}`] : []),
      ...(profile?.sshConfigFile && !existsSync(profile.sshConfigFile) ? [`SSH config file does not exist: ${profile.sshConfigFile}`] : [])
    ];
    const terminalBase = {
      terminalId: `oversea_terminal_${siteId}_${Date.now()}`,
      siteId,
      mode: 'remote-ssh-terminal',
      requestedBy,
      requestId,
      timeoutSeconds,
      command,
      sshProfile: profile ? {
        profileId: profile.profileId,
        host: profile.host,
        sshUser: profile.sshUser,
        sshPort: profile.sshPort,
        identityFile: profile.identityFile,
        knownHostsFile: profile.knownHostsFile,
        sshConfigFile: profile.sshConfigFile,
        hostKeyAlias: profile.hostKeyAlias
      } : null
    };
    if (gateFailures.length > 0 || !profile) {
      const terminal = {
        ...terminalBase,
        status: 'blocked',
        exitCode: null,
        stdout: '',
        stderr: gateFailures.join('\n'),
        gateFailures,
        startedAt: null,
        finishedAt: new Date().toISOString()
      };
      return { terminal, oversea: await this.buildOverseaOverview(actionPolicy) };
    }
    const startedAt = new Date().toISOString();
    try {
      const { stdout, stderr } = await execFileAsync('ssh', overseaTerminalSshArgv(profile, command), {
        timeout: timeoutSeconds * 1000,
        maxBuffer: 4 * 1024 * 1024
      });
      const terminal = {
        ...terminalBase,
        status: 'passed',
        exitCode: 0,
        stdout,
        stderr,
        gateFailures: [],
        startedAt,
        finishedAt: new Date().toISOString()
      };
      return { terminal, oversea: await this.buildOverseaOverview(actionPolicy) };
    } catch (error) {
      const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      const diagnosis = sshFailureDiagnosis(execError.stderr ?? execError.message, execError.code) as Record<string, unknown>;
      diagnosis.tcpProbe = await tcpConnectProbe(profile.host, profile.sshPort, effectiveSshConnectTimeoutSeconds(profile.connectTimeoutSeconds));
      const terminal = {
        ...terminalBase,
        status: 'failed',
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message,
        diagnosis,
        gateFailures: [],
        startedAt,
        finishedAt: new Date().toISOString()
      };
      return { terminal, oversea: await this.buildOverseaOverview(actionPolicy) };
    }
  }

  private async findReusableOverseaPlan(
    siteId: string,
    profileId: string,
    serverPorts: string | null,
    exportPort: number | null,
    workerInternalBaseUrl: string | null,
    overseaCallbackBaseUrl: string | null
  ): Promise<SiteSlotPlan | null> {
    const plans = await this.store.listSiteSlotPlans();
    return latestByCreatedAt(plans.filter((plan) => (
      plan.kind === 'oversea'
      && plan.siteId === siteId
      && plan.ssh.profileId === profileId
      && plan.status !== 'blocked'
      && reusableOverseaPlanContract(plan)
      && reusableOverseaPlanMatchesRuntime(plan, serverPorts, exportPort, workerInternalBaseUrl, overseaCallbackBaseUrl)
    )));
  }

  private async withDomesticBootstrapAccess(input: SiteSlotPlanInput): Promise<SiteSlotPlanInput> {
    const kind = input.kind === 'oversea' ? 'oversea' : 'domestic';
    if (kind !== 'domestic' || input.hasOutboundInternet === true) return input;
    const overseaSiteId = input.overseaSiteId?.trim() || 'oversea-main';
    if (input.accessAccounts?.length) return { ...input, overseaSiteId };

    await this.store.issueSiteSlotAccessAccounts({
      siteId: overseaSiteId,
      service: 'hysteria2',
      issueDefaults: true,
      publicHost: input.overseaHost ?? undefined,
      serverPorts: input.serverPorts,
      requestedBy: input.createdBy ?? 'admin-controller',
      requestId: `${input.requestId ?? 'admin-site-slot-plan'}-domestic-bootstrap`
    });
    const accounts = await this.store.listSiteSlotAccessAccounts(overseaSiteId);
    return {
      ...input,
      overseaSiteId,
      accessAccounts: siteSlotPlanAccessAccountMaterial(accounts)
    };
  }

  private async materializeDomesticBootstrapSubscription(plan: SiteSlotPlan): Promise<void> {
    if (plan.kind !== 'domestic' || plan.network.mode !== 'oversea-assisted' || !plan.network.overseaSiteId) return;
    let accounts = await this.store.listSiteSlotAccessAccounts(plan.network.overseaSiteId);
    if (!domesticBootstrapAccount(accounts) || !internalBootstrapAccount(accounts)) {
      await this.store.issueSiteSlotAccessAccounts({
        siteId: plan.network.overseaSiteId,
        service: 'hysteria2',
        issueDefaults: true,
        publicHost: plan.network.overseaHost ?? undefined,
        requestedBy: plan.createdBy || 'admin-controller',
        requestId: `${plan.planId}-domestic-bootstrap-sync`
      });
      accounts = await this.store.listSiteSlotAccessAccounts(plan.network.overseaSiteId);
    }
    await this.writeBootstrapSubscriptionArtifact(
      plan.network.overseaSiteId,
      domesticBootstrapAccount(accounts),
      'domestic/mx-domestic-bootstrap-subscription.yaml'
    );
    await this.writeBootstrapSubscriptionArtifact(
      plan.network.overseaSiteId,
      internalBootstrapAccount(accounts),
      'domestic/mx-internal-egress-subscription.yaml'
    );
  }

  private async writeBootstrapSubscriptionArtifact(
    siteId: string,
    account: SiteSlotAccessAccount | null,
    artifactPath: string
  ): Promise<void> {
    if (!account) return;
    const subscription = await this.store.renderHysteria2MihomoSubscription(siteId, account.username);
    if (!subscription) return;
    const filePath = resolve(resolveSiteSlotArtifactBaseDir(), artifactPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, subscription.yaml);
    chmodSync(filePath, 0o600);
  }

  private async ensureSiteSlotExecution(
    plan: SiteSlotPlan,
    action: 'preflight' | 'apply',
    requestedBy: string,
    requestId: string
  ): Promise<SiteSlotExecutionRun> {
    const executions = await this.store.listSiteSlotExecutions(plan.planId);
    const existing = latestByCreatedAt(executions.filter((execution) => (
      execution.action === action
      && execution.status === 'ready'
      && (action === 'preflight' || execution.confirmApply)
    )));
    if (existing) return existing;
    return this.store.createSiteSlotExecution({
      planId: plan.planId,
      action,
      mode: action === 'preflight' ? 'dry-run' : 'manual',
      confirmApply: action === 'apply' ? true : null,
      requestedBy,
      requestId
    });
  }

  private async ensureRemoteRunnerSession(
    execution: SiteSlotExecutionRun,
    requestedBy: string,
    requestId: string
  ): Promise<SiteSlotRunnerSession> {
    const sessions = await this.store.listSiteSlotRunnerSessions(execution.runId);
    const existing = latestByStartedAt(sessions.filter((session) => (
      session.mode === 'remote-ssh'
      && session.status === 'queued'
    )));
    if (existing) return existing;
    return this.store.startSiteSlotRunnerSession({
      runId: execution.runId,
      mode: 'remote-ssh',
      confirmRemoteExecution: true,
      requestedBy,
      requestId
    });
  }

  private async ensureRemoteWorkerJob(
    session: SiteSlotRunnerSession,
    requestedBy: string,
    requestId: string
  ): Promise<SiteSlotWorkerJob> {
    const jobs = await this.store.listSiteSlotWorkerJobs(session.sessionId);
    const reusable = latestByCreatedAt(jobs.filter((job) => job.status === 'ready' && !job.currentReportId));
    if (reusable) return reusable;
    const now = new Date();
    return this.store.createSiteSlotWorkerJob({
      sessionId: session.sessionId,
      workerId: `worker-admin-${session.siteId}`,
      workerKind: session.kind === 'oversea' ? 'oversea-site-agent' : 'domestic-runner',
      approvalId: `admin-ensure-${session.siteId}`,
      changeWindowStart: now.toISOString(),
      changeWindowEnd: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      retryLimit: 1,
      rollbackStrategy: session.kind === 'oversea' ? 'restore-previous-access-stack' : 'restore-previous-wireguard-and-compose',
      requestedBy,
      requestId
    });
  }

  private async runRemoteSshWorker(
    jobId: string,
    sshProfileId: string,
    internalBaseUrl: string,
    requestedBy: string,
    requestId: string
  ): Promise<{ status: 'completed' | 'failed'; exitCode: number | null; stdout: string; stderr: string; diagnosis?: ReturnType<typeof sshFailureDiagnosis> }> {
    const mxRoot = resolveMxLauncherRoot();
    const scriptPath = resolveSiteSlotWorkerRunScript(mxRoot);
    const workerBaseUrl = workerInternalBaseUrlFromSources(internalBaseUrl);
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, workerBaseUrl, jobId, 'artifact-push-remote-ssh'], {
        cwd: mxRoot,
        env: {
          ...process.env,
          MX_INTERNAL_BASE_URL: workerBaseUrl,
          SITE_SLOT_SSH_PROFILE_ID: sshProfileId,
          SITE_SLOT_WORKER_REMOTE_SSH: '1',
          SITE_SLOT_CONFIRM_REMOTE_EXECUTION: '1',
          SITE_SLOT_WORKER_ID: 'worker-admin-ensure',
          SITE_SLOT_WORKER_MESSAGE: 'site slot remote SSH worker by admin action',
          SITE_SLOT_WORKER_REQUEST_ID: requestId,
          SITE_SLOT_WORKER_REQUESTED_BY: requestedBy
        },
        timeout: 15 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024
      });
      return { status: 'completed', exitCode: 0, stdout, stderr };
    } catch (error) {
      const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      return {
        status: 'failed',
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message,
        diagnosis: sshFailureDiagnosis(execError.stderr ?? execError.message, execError.code)
      };
    }
  }

  private async buildOverseaOverview(actionPolicy: AdminActionPolicy, ensure?: Record<string, unknown>) {
    const [pipelines, profiles, plans] = await Promise.all([
      this.buildSiteSlotPipelines(actionPolicy),
      this.store.listSiteSlotSshProfiles(),
      this.store.listSiteSlotPlans()
    ]);
    const overseaPipelines = pipelines.filter((pipeline) => pipeline.summary.kind === 'oversea');
    const overseaProfiles = profiles.filter((profile) => profile.kind === 'oversea');
    const siteIds = uniqueStrings([
      ...overseaPipelines.map((pipeline) => pipeline.summary.siteId),
      ...overseaProfiles.map((profile) => profile.siteId),
      ...plans.filter((plan) => plan.kind === 'oversea').map((plan) => plan.siteId)
    ]);
    const sites = await Promise.all(siteIds.map(async (siteId) => this.buildOverseaSiteOverview(siteId, overseaProfiles, overseaPipelines)));
    const subscriptionCount = sites.reduce((sum, site) => sum + site.subscriptions.length, 0);
    return {
      generatedAt: new Date().toISOString(),
      actionPolicy,
      ensure: ensure ?? null,
      counts: {
        overseaSites: sites.length,
        installed: sites.filter((site) => site.status === 'installed').length,
        readyToInstall: sites.filter((site) => site.status === 'ready-to-install').length,
        blocked: sites.filter((site) => site.status === 'blocked' || site.status === 'failed').length,
        subscriptions: subscriptionCount
      },
      mihomo: {
        authority: 'internal-config-center',
        status: subscriptionCount > 0 ? 'ready' : 'not-configured',
        sites: sites.filter((site) => site.mihomoSite).length,
        subscriptions: subscriptionCount,
        routingPolicy: 'cn-direct',
        reservedInternalCidrs: ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16'],
        domesticGatewayIp: '10.88.0.1',
        deliveryBoundary: 'Internal publishes subscriptions; H endpoints need Domestic WG/H2I/DNS before they can fetch Internal mihomo.'
      },
      sites: sites.sort((left, right) => {
        const selectedSiteId = stringValue(ensure?.siteId);
        if (left.siteId === selectedSiteId) return -1;
        if (right.siteId === selectedSiteId) return 1;
        return right.updatedAt.localeCompare(left.updatedAt);
      })
    };
  }

  private async buildOverseaSiteOverview(
    siteId: string,
    profiles: SiteSlotSshProfile[],
    pipelines: AdminSiteSlotPipeline[]
  ) {
    const profile = latestByUpdatedAt(profiles.filter((item) => item.siteId === siteId && item.status === 'active'));
    const sitePipelines = pipelines.filter((pipeline) => pipeline.summary.siteId === siteId);
    const pipeline = chooseOverseaPipeline(sitePipelines);
    const latestReport = latestByCreatedAt(sitePipelines.flatMap((item) => item.workerReports));
    const latestJob = latestByCreatedAt(sitePipelines.flatMap((item) => item.workerJobs));
    const latestSession = latestByStartedAt(sitePipelines.flatMap((item) => item.runnerSessions));
    const accounts = await this.store.listSiteSlotAccessAccounts(siteId);
    const mihomoSite = await this.store.getLauncherNetworkMihomoSite(siteId);
    const reachability = await this.store.getLauncherNetworkMihomoReachability(siteId);
    const status = overseaSiteStatus(profile, pipeline, latestSession, latestJob, latestReport);
    const latestReportFailure = latestReport ? workerReportFailureSummary(latestReport) : null;
    const subscriptionBaseUrl = mihomoSite?.subscriptionBaseUrl ?? null;
    const planWorkerInternalBaseUrl = normalizeWorkerInternalBaseUrl(pipeline?.plan.runtime.oversea?.workerInternalBaseUrl);
    const planOverseaCallbackBaseUrl = normalizeOverseaCallbackBaseUrl(pipeline?.plan.runtime.oversea?.overseaCallbackBaseUrl);
    const profileWorkerInternalBaseUrl = normalizeWorkerInternalBaseUrl(profile?.workerInternalBaseUrl);
    const profileOverseaCallbackBaseUrl = normalizeOverseaCallbackBaseUrl(profile?.overseaCallbackBaseUrl);
    const runtimeOverseaCallbackBaseUrl = planOverseaCallbackBaseUrl ?? profileOverseaCallbackBaseUrl;
    return {
      siteId,
      kind: 'oversea' as const,
      status,
      updatedAt: latestReport?.createdAt ?? latestJob?.updatedAt ?? latestJob?.createdAt ?? pipeline?.summary.latestUpdatedAt ?? profile?.updatedAt ?? new Date(0).toISOString(),
      host: profile?.host ?? pipeline?.plan.host ?? null,
      sshProfile: profile ? {
        profileId: profile.profileId,
        host: profile.host,
        sshUser: profile.sshUser,
        sshPort: profile.sshPort,
        identityFile: profile.identityFile,
        knownHostsFile: profile.knownHostsFile,
        sshConfigFile: profile.sshConfigFile,
        hostKeyAlias: profile.hostKeyAlias,
        serverPorts: profile.serverPorts,
        exportPort: profile.exportPort,
        workerInternalBaseUrl: profileWorkerInternalBaseUrl,
        overseaCallbackBaseUrl: profileOverseaCallbackBaseUrl,
        status: profile.status,
        warnings: profile.warnings
      } : null,
      pipeline: pipeline ? {
        planId: pipeline.summary.planId,
        health: pipeline.summary.health,
        currentStage: pipeline.summary.currentStage,
        latestStatus: pipeline.summary.latestStatus,
        latestUpdatedAt: pipeline.summary.latestUpdatedAt,
        activeObjects: pipelineObjectCountForOverview(pipeline.summary),
        historyRuns: sitePipelines.length
      } : null,
      runtime: {
        docker: latestReport ? reportStepStatus(latestReport, 'remote-preflight') : null,
        hysteria2: latestReport && workerReportHasRemoteExecution(latestReport) && latestReport.status === 'passed' ? 'ready' : status === 'ready-to-install' ? 'pending-install' : 'unknown',
        siteAgent: latestReport && workerReportHasRemoteExecution(latestReport) && latestReport.status === 'passed' ? 'ready' : 'unknown',
        serverPorts: pipeline?.plan.runtime.oversea?.serverPorts ?? mihomoSite?.serverPorts ?? profile?.serverPorts ?? null,
        exportPort: pipeline?.plan.runtime.oversea?.exportPort ?? profile?.exportPort ?? null,
        exportBaseUrl: pipeline?.plan.runtime.oversea?.exportBaseUrl ?? null,
        workerInternalBaseUrl: planWorkerInternalBaseUrl ?? profileWorkerInternalBaseUrl,
        overseaCallbackBaseUrl: runtimeOverseaCallbackBaseUrl,
        callbackMode: pipeline?.plan.runtime.oversea?.callbackMode ?? (runtimeOverseaCallbackBaseUrl ? 'remote-callback' : 'push-only'),
        workerReportId: latestReport?.reportId ?? null,
        workerReportStatus: latestReport?.status ?? null,
        failure: latestReportFailure,
        evidenceMode: latestReport ? workerReportModes(latestReport) : []
      },
      mihomoSite,
      reachability,
      subscriptions: accounts.map((account) => ({
        accountId: account.accountId,
        username: account.username,
        role: account.role,
        status: account.status,
        routingPolicy: account.routingPolicy,
        subscriptionPath: account.subscriptionPath,
        subscriptionUrl: subscriptionBaseUrl ? `${subscriptionBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(account.username)}.yaml` : account.subscriptionPath,
        deliveryStatus: reachability?.currentBoundary === 'h-endpoint' ? 'deliverable-to-h-endpoint' : 'internal-published'
      })),
      services: [
        overseaServiceCard('SSH Key', profile && sshProfileBlockingReasons(profile).length === 0 ? 'ready' : 'blocked', profile?.identityFile ?? 'Internal-managed key file'),
        overseaServiceCard('Oversea Runtime', status === 'installed' ? 'ready' : status === 'ready-to-install' ? 'pending' : status, latestReportFailure?.message ?? latestReport?.reportId ?? 'Docker/hysteria2/site-agent worker evidence'),
        overseaServiceCard('Internal mihomo', mihomoSite ? 'ready' : 'pending', mihomoSite?.subscriptionBaseUrl ?? 'subscription authority not issued'),
        overseaServiceCard('H Delivery', reachability?.verdict === 'h-endpoint-ready' ? 'ready' : 'blocked', reachability?.currentBoundary ?? 'Domestic WG/H2I required')
      ],
      nextActions: overseaNextActions(status, profile, mihomoSite, reachability, latestReport)
    };
  }

  private async materializeDomesticWireGuard(
    siteId: string,
    plan: SiteSlotPlan | null,
    previous: SiteSlotDomesticWireGuardSecret | null,
    body: Record<string, unknown>
  ) {
    const requestedBy = stringValue(body.requestedBy) ?? 'admin-ui';
    const requestId = stringValue(body.requestId);
    const input = buildAdminDomesticWireGuardSecretInput(siteId, plan, previous, body, requestedBy, requestId);
    if (input.blockedReasons.length) {
      return {
        secret: previous,
        result: adminDomesticWireGuardMaterializeResult(siteId, previous, input, null, input.blockedReasons)
      };
    }
    const secret = await this.store.upsertSiteSlotDomesticWireGuardSecret(input.secretInput);
    if (secret.readiness.missingSecretInputs.length) {
      const blockedReasons = secret.readiness.missingSecretInputs.map((key) => `missing secret input: ${key}`);
      return {
        secret,
        result: adminDomesticWireGuardMaterializeResult(siteId, secret, input, null, blockedReasons)
      };
    }
    if (plan) await this.materializeDomesticBootstrapSubscription(plan);

    const mxRoot = resolveMxLauncherRoot();
    const scriptPath = [
      resolve(mxRoot, 'server/scripts/site-slot-artifact-materializer.mjs'),
      resolve(mxRoot, 'scripts/site-slot-artifact-materializer.mjs')
    ].find((candidate) => existsSync(candidate)) ?? resolve(mxRoot, 'server/scripts/site-slot-artifact-materializer.mjs');
    let execution: { exitCode: number; stdout: string; stderr: string } | null = null;
    const blockedReasons: string[] = [];
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, 'domestic'], {
        cwd: mxRoot,
        env: {
          ...process.env,
          SITE_SLOT_ARTIFACT_OUTPUT_DIR: resolveSiteSlotArtifactBaseDir(),
          ...domesticWireGuardMaterializerEnv(secret)
        },
        timeout: 60 * 1000,
        maxBuffer: 4 * 1024 * 1024
      });
      execution = { exitCode: 0, stdout, stderr };
    } catch (error) {
      const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      execution = {
        exitCode: typeof execError.code === 'number' ? execError.code : 1,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message
      };
      blockedReasons.push(`artifact materializer failed: ${execution.stderr || execution.exitCode}`);
    }

    const manifestFailures: string[] = [];
    const manifest = readArtifactManifest('domestic', resolveSiteSlotArtifactBaseDir(), manifestFailures);
    const module = manifest?.modules.find((item) => item.moduleId === 'wireguard-config') ?? null;
    if (manifestFailures.length) blockedReasons.push(...manifestFailures);
    if (module?.status !== 'ready') {
      blockedReasons.push(`wireguard-config artifact is ${module?.status ?? 'missing'}, expected ready`);
    }
    await this.store.recordAudit({
      eventType: 'site_slot.domestic_wg.materialized',
      actorKind: 'admin-action',
      requestId,
      metadata: {
        siteId,
        planId: plan?.planId ?? null,
        secretId: secret.secretId,
        rotate: input.rotate,
        generated: input.generated,
        endpointChanged: input.endpointChanged,
        materialDigest: secret.fingerprints.materialDigest,
        artifactStatus: module?.status ?? null,
        blockedReasons
      }
    });
    return {
      secret,
      result: adminDomesticWireGuardMaterializeResult(siteId, secret, input, {
        execution,
        manifest,
        module
      }, blockedReasons)
    };
  }

  private async materializeSiteSlotArtifactSet(kind: 'oversea' | 'domestic'): Promise<{
    execution: { exitCode: number; stdout: string; stderr: string } | null;
    manifest: ReturnType<typeof readArtifactManifest> | null;
    blockedReasons: string[];
    mode: 'materialized-from-source' | 'prebuilt-artifact';
    sourceRoot: string;
    artifactBaseDir: string;
  }> {
    const mxRoot = resolveMxLauncherRoot();
    const artifactBaseDir = resolveSiteSlotArtifactBaseDir();
    const sourceProbe = siteSlotArtifactSourceProbe(mxRoot, kind);
    let execution: { exitCode: number; stdout: string; stderr: string } | null = null;
    const blockedReasons: string[] = [];
    if (sourceProbe.ready) {
      const scriptPath = [
        resolve(mxRoot, 'server/scripts/site-slot-artifact-materializer.mjs'),
        resolve(mxRoot, 'scripts/site-slot-artifact-materializer.mjs')
      ].find((candidate) => existsSync(candidate)) ?? resolve(mxRoot, 'server/scripts/site-slot-artifact-materializer.mjs');
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, kind], {
          cwd: mxRoot,
          env: {
            ...process.env,
            SITE_SLOT_ARTIFACT_OUTPUT_DIR: artifactBaseDir
          },
          timeout: 60 * 1000,
          maxBuffer: 4 * 1024 * 1024
        });
        execution = { exitCode: 0, stdout, stderr };
      } catch (error) {
        const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
        execution = {
          exitCode: typeof execError.code === 'number' ? execError.code : 1,
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? execError.message
        };
        blockedReasons.push(`artifact materializer failed: ${execution.stderr || execution.exitCode}`);
      }
    }
    const manifestFailures: string[] = [];
    const manifest = readArtifactManifest(kind, artifactBaseDir, manifestFailures);
    if (manifestFailures.length) blockedReasons.push(...manifestFailures);
    const requiredModuleId = kind === 'oversea' ? 'hysteria2-access-stack' : 'qp-tunnel-cli';
    const module = manifest?.modules.find((item) => item.moduleId === requiredModuleId) ?? null;
    if (!sourceProbe.ready && module?.status !== 'ready') {
      blockedReasons.push(`artifact source missing in runtime image: ${sourceProbe.missing.join(', ')}; expected prebuilt ${requiredModuleId} artifact in ${resolve(artifactBaseDir, kind)}`);
    }
    if (module?.status !== 'ready') {
      blockedReasons.push(`${requiredModuleId} artifact is ${module?.status ?? 'missing'}, expected ready`);
    }
    return {
      execution,
      manifest,
      blockedReasons,
      mode: sourceProbe.ready ? 'materialized-from-source' : 'prebuilt-artifact',
      sourceRoot: sourceProbe.sourceRoot,
      artifactBaseDir
    };
  }

  private async adminInternalServicePeerDomesticKeySyncResult(
    siteId: string,
    plan: SiteSlotPlan | null,
    secret: SiteSlotDomesticWireGuardSecret | null,
    body: Record<string, unknown>
  ) {
    const requestedBy = stringValue(body.requestedBy) ?? 'admin-ui';
    const requestId = stringValue(body.requestId) ?? `admin-internal-service-peer-domestic-key-sync-${Date.now()}`;
    const confirm = booleanValue(body.confirmDomesticPeerKeySync) === true;
    const confirmAdoptRuntimeRelayKey = booleanValue(body.confirmAdoptDomesticRuntimeRelayPublicKey) === true;
    const beforeStatus = await adminInternalServicePeerRuntimeStatus(siteId, plan, secret, this.store);
    const explicitInternalPublicKey = stringValue(body.internalServicePublicKey);
    const internalPublicKey = explicitInternalPublicKey
      ?? internalServicePublicKeyFromRuntimeStatus(beforeStatus)
      ?? deriveWireGuardPublicKeyFromPrivate(secret?.internalServicePrivateKey)
      ?? secret?.internalServicePublicKey
      ?? null;
    const internalPublicKeySource = explicitInternalPublicKey
      ? 'request-body'
      : internalServicePublicKeyFromRuntimeStatus(beforeStatus)
        ? 'internal-host-runner'
        : deriveWireGuardPublicKeyFromPrivate(secret?.internalServicePrivateKey)
          ? 'internal-secret-private-key'
          : secret?.internalServicePublicKey
            ? 'internal-secret-public-key'
            : 'missing';
    const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
    const profileFailures = sshProfile ? sshProfileBlockingReasons(sshProfile) : [];
    const initialBlockedReasons = [
      ...(!confirm ? ['confirmDomesticPeerKeySync=true is required before syncing the Domestic WG peer'] : []),
      ...(secret ? [] : ['Domestic WG secret is missing; Materialize Domestic WG before syncing the peer key']),
      ...(plan ? [] : ['Domestic site plan is missing; select the Domestic relay plan before syncing the peer key']),
      ...(sshProfile ? [] : ['Domestic SSH profile is required before syncing the peer key']),
      ...profileFailures,
      ...(internalPublicKey ? [] : ['Internal service peer public key is missing; install or refresh the Internal host runner first']),
      ...(internalPublicKey && validWireGuardPublicKey(internalPublicKey) ? [] : internalPublicKey ? ['Internal service peer public key does not look like a base64 WireGuard public key'] : [])
    ];
    if (initialBlockedReasons.length > 0 || !secret || !sshProfile || !internalPublicKey) {
      return {
        syncId: `internal_service_peer_domestic_key_sync_${siteId}`,
        status: 'blocked',
        execution: 'not-started',
        mode: 'internal-service-peer-domestic-key-sync',
        siteId,
        planId: plan?.planId ?? stringValue(body.planId) ?? null,
        internal: {
          publicKey: internalPublicKey,
          publicKeySource: internalPublicKeySource,
          serviceIp: secret?.internalServiceIp ?? '10.88.88.88'
        },
        domestic: null,
        ssh: null,
        materialize: null,
        beforeStatus,
        afterStatus: beforeStatus,
        secret: secret ? redactAdminDomesticWireGuardSecret(secret) : null,
        warnings: [],
        blockedReasons: initialBlockedReasons,
        nextActions: ['fix-domestic-ssh-profile-or-internal-runtime-key', 'retry-sync-domestic-wg-key'],
        finishedAt: new Date().toISOString()
      };
    }

    const readScript = domesticRelayPublicKeyReadScript();
    const readStartedAt = new Date().toISOString();
    let readExecution;
    try {
      readExecution = await runSshScriptWithProfile(sshProfile, readScript, 30000);
    } catch (error) {
      readExecution = sshScriptFailure(error, readStartedAt);
    }
    const domesticPublicKey = stringValue(body.domesticRelayPublicKey)
      ?? domesticRelayPublicKeyFromReadOutput(readExecution.stdout)
      ?? null;
    const relayPublicKeyFromPrivate = deriveWireGuardPublicKeyFromPrivate(secret.domesticRelayPrivateKey);
    const runtimeRelayKeyDrift = Boolean(relayPublicKeyFromPrivate && domesticPublicKey && relayPublicKeyFromPrivate !== domesticPublicKey);
    const readBlockedReasons = [
      ...(readExecution.status === 'passed' ? [] : [`Domestic relay public key read failed: ${readExecution.stderr || readExecution.status}`]),
      ...(domesticPublicKey ? [] : ['Domestic relay public key could not be read from mx-domestic']),
      ...(domesticPublicKey && validWireGuardPublicKey(domesticPublicKey) ? [] : domesticPublicKey ? ['Domestic relay public key does not look like a base64 WireGuard public key'] : []),
      ...(runtimeRelayKeyDrift && !confirmAdoptRuntimeRelayKey ? ['Domestic runtime relay public key differs from the Config Center relay private key; confirmAdoptDomesticRuntimeRelayPublicKey=true is required before adopting the runtime key'] : [])
    ];
    if (readBlockedReasons.length > 0 || !domesticPublicKey) {
      return {
        syncId: `internal_service_peer_domestic_key_sync_${siteId}`,
        status: readExecution.status === 'passed' ? 'blocked' : 'failed',
        execution: readExecution.status === 'passed' ? 'not-started' : 'failed',
        mode: 'internal-service-peer-domestic-key-sync',
        siteId,
        planId: plan?.planId ?? stringValue(body.planId) ?? null,
        internal: {
          publicKey: internalPublicKey,
          publicKeySource: internalPublicKeySource,
          serviceIp: secret.internalServiceIp
        },
        domestic: {
          publicKey: domesticPublicKey,
          publicKeySource: stringValue(body.domesticRelayPublicKey) ? 'request-body' : 'remote-wg-show',
          relayPublicKeyFromConfigPrivate: relayPublicKeyFromPrivate,
          runtimeRelayKeyDrift,
          adoptedRuntimeRelayKey: false
        },
        ssh: {
          read: readExecution,
          sync: null
        },
        materialize: null,
        beforeStatus,
        afterStatus: beforeStatus,
        secret: redactAdminDomesticWireGuardSecret(secret),
        warnings: runtimeRelayKeyDrift ? ['Domestic runtime relay key differs from Config Center; avoid re-applying Domestic relay until the key is imported or rotated.'] : [],
        blockedReasons: readBlockedReasons,
        nextActions: runtimeRelayKeyDrift
          ? ['import-or-rotate-domestic-relay-key', 'or-confirm-runtime-key-adoption-for-dev-sync']
          : ['fix-domestic-wg-service', 'retry-sync-domestic-wg-key'],
        finishedAt: new Date().toISOString()
      };
    }

    const syncScript = domesticInternalServicePeerKeySyncScript(internalPublicKey, secret);
    const syncStartedAt = new Date().toISOString();
    let syncExecution;
    try {
      syncExecution = await runSshScriptWithProfile(sshProfile, syncScript, 45000);
    } catch (error) {
      syncExecution = sshScriptFailure(error, syncStartedAt);
    }
    if (syncExecution.status !== 'passed') {
      return {
        syncId: `internal_service_peer_domestic_key_sync_${siteId}`,
        status: 'failed',
        execution: 'failed',
        mode: 'internal-service-peer-domestic-key-sync',
        siteId,
        planId: plan?.planId ?? stringValue(body.planId) ?? null,
        internal: {
          publicKey: internalPublicKey,
          publicKeySource: internalPublicKeySource,
          serviceIp: secret.internalServiceIp
        },
        domestic: {
          publicKey: domesticPublicKey,
          publicKeySource: stringValue(body.domesticRelayPublicKey) ? 'request-body' : 'remote-wg-show',
          relayPublicKeyFromConfigPrivate: relayPublicKeyFromPrivate,
          runtimeRelayKeyDrift,
          adoptedRuntimeRelayKey: false
        },
        ssh: {
          read: readExecution,
          sync: syncExecution
        },
        materialize: null,
        beforeStatus,
        afterStatus: beforeStatus,
        secret: redactAdminDomesticWireGuardSecret(secret),
        warnings: [],
        blockedReasons: [`Domestic Internal peer key sync failed: ${syncExecution.stderr || syncExecution.status}`],
        nextActions: ['check-domestic-wg-service', 'retry-sync-domestic-wg-key'],
        finishedAt: new Date().toISOString()
      };
    }

    const syncedSecret = await this.store.upsertSiteSlotDomesticWireGuardSecret({
      siteId,
      domesticRelayPublicKey: domesticPublicKey,
      internalServicePublicKey: internalPublicKey,
      requestedBy,
      requestId
    });
    const materialize = await this.materializeDomesticWireGuard(siteId, plan, syncedSecret, {
      publicEndpoint: syncedSecret.publicEndpoint,
      listenPort: syncedSecret.listenPort,
      requestedBy,
      requestId: `${requestId}-materialize`
    });
    const afterStatus = await adminInternalServicePeerRuntimeStatus(siteId, plan, materialize.secret, this.store);
    const warnings = [
      ...(secret.internalServicePublicKey && secret.internalServicePublicKey !== internalPublicKey
        ? ['Config Center Internal service public key was updated from the active Internal runtime key.']
        : []),
      ...(secret.domesticRelayPublicKey && secret.domesticRelayPublicKey !== domesticPublicKey
        ? ['Config Center Domestic relay public key was updated from the active Domestic runtime key.']
        : []),
      ...(runtimeRelayKeyDrift
        ? ['Domestic runtime relay key differs from Config Center relay private key; future Domestic relay re-apply may rotate the relay unless the private key is imported or rotated deliberately.']
        : [])
    ];
    await this.store.recordAudit({
      eventType: 'site_slot.internal_service_peer.domestic_key_synced',
      actorKind: 'admin-action',
      requestId,
      metadata: {
        siteId,
        planId: plan?.planId ?? null,
        internalPublicKeySource,
        runtimeRelayKeyDrift,
        materializeStatus: materialize.result.status,
        syncStatus: syncExecution.status
      }
    });
    return {
      syncId: `internal_service_peer_domestic_key_sync_${siteId}`,
      status: materialize.result.status === 'passed' ? 'passed' : 'ready',
      execution: 'completed',
      mode: 'internal-service-peer-domestic-key-sync',
      siteId,
      planId: plan?.planId ?? stringValue(body.planId) ?? null,
      internal: {
        publicKey: internalPublicKey,
        publicKeySource: internalPublicKeySource,
        previousPublicKey: secret.internalServicePublicKey,
        serviceIp: secret.internalServiceIp
      },
      domestic: {
        publicKey: domesticPublicKey,
        publicKeySource: stringValue(body.domesticRelayPublicKey) ? 'request-body' : 'remote-wg-show',
        relayPublicKeyFromConfigPrivate: relayPublicKeyFromPrivate,
        runtimeRelayKeyDrift,
        adoptedRuntimeRelayKey: runtimeRelayKeyDrift
      },
      ssh: {
        read: readExecution,
        sync: syncExecution
      },
      materialize: materialize.result,
      beforeStatus,
      afterStatus,
      secret: materialize.secret ? redactAdminDomesticWireGuardSecret(materialize.secret) : redactAdminDomesticWireGuardSecret(syncedSecret),
      warnings,
      blockedReasons: materialize.result.status === 'passed' ? [] : materialize.result.blockedReasons ?? [],
      nextActions: [
        'click-install-restart-to-reload-internal-service-peer',
        'refresh-status-to-check-handshake',
        'run-domestic-relay-readonly-probe-after-handshake'
      ],
      finishedAt: new Date().toISOString()
    };
  }

  private async buildActionPolicy(authorization?: string, rawToken?: string, rawUserId?: string): Promise<AdminActionPolicy> {
    const token = bearerToken(authorization) ?? stringValue(rawToken);
    const userId = stringValue(rawUserId);
    if (!token && !userId) {
      const principal = shadowAdminPrincipal();
      return {
        authMode: 'shadow-rbac-v1',
        principal,
        warnings: ['shadow-default-admin: pass an Authorization bearer token or userId for real RBAC resolution'],
        actions: buildAdminActions(principal)
      };
    }
    const context = await this.store.resolvePrincipalContext({
      token,
      userId,
      audience: 'mx-admin',
      requestId: 'admin-action-policy'
    });
    return {
      authMode: 'shadow-rbac-v1',
      principal: context.principal,
      warnings: context.auth.active ? [] : [`auth: ${context.auth.reason}`],
      actions: buildAdminActions(context.principal)
    };
  }

  private async dispatchAdminAction(actionId: string, path: string, body: Record<string, unknown>) {
    if (actionId === 'site-slot.plan.create') {
      if (path !== '/internal/v1/site-slots/plans') throw new BadRequestException('Admin site-slot plan path is invalid');
      const input = await this.withDomesticBootstrapAccess(toSiteSlotPlanInput(body));
      const hostFailure = await this.domesticPlanHostValidationFailure(input);
      if (hostFailure) throw new BadRequestException(hostFailure);
      const plan = await this.store.createSiteSlotPlan(input);
      await this.materializeDomesticBootstrapSubscription(plan);
      return {
        plan
      };
    }
    if (actionId === 'site-slot.domestic-runtime-config.upsert') {
      if (path !== '/internal/v1/config-center/domestic-runtime-configs') {
        throw new BadRequestException('Admin Domestic runtime config path is invalid');
      }
      return {
        config: await this.store.upsertSiteSlotDomesticRuntimeConfig(toDomesticRuntimeConfigInput(body))
      };
    }
    if (actionId === 'site-slot.domestic-runtime-config.apply') {
      const match = matchPath(path, /^\/internal\/v1\/config-center\/domestic-runtime-configs\/([^/]+)\/apply$/);
      if (!match) throw new BadRequestException('Admin Domestic runtime apply path is invalid');
      return {
        apply: await this.adminDomesticRuntimeConfigApplyResult(match[1], body)
      };
    }
    if (actionId === 'site-slot.preflight.create' || actionId === 'site-slot.apply.confirm') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/plans\/([^/]+)\/(preflight|apply)$/);
      if (!match) throw new BadRequestException('Admin site-slot execution path is invalid');
      const action = match[2] === 'apply' ? 'apply' : 'preflight';
      return {
        execution: await this.store.createSiteSlotExecution({
          planId: match[1],
          action,
          mode: siteSlotExecutionMode(body.mode),
          confirmApply: booleanValue(body.confirmApply),
          requestedBy: stringValue(body.requestedBy),
          requestId: stringValue(body.requestId)
        })
      };
    }
    if (actionId === 'site-slot.runner.simulate' || actionId === 'site-slot.runner.remote-ssh' || actionId === 'site-slot.runner.awx-shadow') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/executions\/([^/]+)\/runner-sessions$/);
      if (!match) throw new BadRequestException('Admin site-slot runner path is invalid');
      return {
        session: await this.store.startSiteSlotRunnerSession({
          runId: match[1],
          mode: siteSlotRunnerMode(body.mode),
          confirmRemoteExecution: booleanValue(body.confirmRemoteExecution),
          requestedBy: stringValue(body.requestedBy),
          requestId: stringValue(body.requestId)
        })
      };
    }
    if (actionId === 'site-slot.worker-job.create') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/runner-sessions\/([^/]+)\/worker-jobs$/);
      if (!match) throw new BadRequestException('Admin site-slot worker job path is invalid');
      return {
        job: await this.store.createSiteSlotWorkerJob({
          sessionId: match[1],
          workerId: stringValue(body.workerId),
          workerKind: siteSlotWorkerKind(body.workerKind),
          approvalId: stringValue(body.approvalId),
          changeWindowStart: stringValue(body.changeWindowStart),
          changeWindowEnd: stringValue(body.changeWindowEnd),
          retryLimit: numberValueOrNull(body.retryLimit),
          rollbackStrategy: stringValue(body.rollbackStrategy),
          requestedBy: stringValue(body.requestedBy),
          requestId: stringValue(body.requestId)
        })
      };
    }
    if (actionId === 'site-slot.domestic-wg.materialize') {
      const match = matchPath(path, /^\/internal\/v1\/config-center\/domestic-wg-secrets\/([^/]+)\/materialize-ready$/);
      if (!match) throw new BadRequestException('Admin Domestic WG materialize path is invalid');
      const siteId = match[1];
      const plan = stringValue(body.planId) ? await this.store.getSiteSlotPlan(stringValue(body.planId) ?? '') : null;
      const previous = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
      const materialize = await this.materializeDomesticWireGuard(siteId, plan, previous, body);
      return {
        domesticWgMaterialize: materialize.result,
        secret: materialize.secret ? redactAdminDomesticWireGuardSecret(materialize.secret) : null
      };
    }
    if (actionId === 'site-slot.internal-service-peer.handoff') {
      const match = matchPath(path, /^\/internal\/v1\/config-center\/domestic-wg-secrets\/([^/]+)\/internal-service-peer-handoff$/);
      if (!match) throw new BadRequestException('Admin Internal service peer handoff path is invalid');
      const siteId = match[1];
      const secret = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
      const plan = stringValue(body.planId) ? await this.store.getSiteSlotPlan(stringValue(body.planId) ?? '') : null;
      return {
        internalServicePeerHandoff: adminInternalServicePeerHandoffResult(siteId, plan, secret, body),
        secret: secret ? redactAdminDomesticWireGuardSecret(secret) : null
      };
    }
    if (actionId === 'site-slot.internal-service-peer.status') {
      const match = matchPath(path, /^\/internal\/v1\/config-center\/domestic-wg-secrets\/([^/]+)\/internal-service-peer-status$/);
      if (!match) throw new BadRequestException('Admin Internal service peer status path is invalid');
      const siteId = match[1];
      const secret = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
      const plan = stringValue(body.planId) ? await this.store.getSiteSlotPlan(stringValue(body.planId) ?? '') : null;
      return {
        internalServicePeerRuntimeStatus: await adminInternalServicePeerRuntimeStatus(siteId, plan, secret, this.store),
        secret: secret ? redactAdminDomesticWireGuardSecret(secret) : null
      };
    }
    if (actionId === 'site-slot.internal-service-peer.host-runner.ensure') {
      const match = matchPath(path, /^\/internal\/v1\/config-center\/domestic-wg-secrets\/([^/]+)\/internal-service-peer-host-runner$/);
      if (!match) throw new BadRequestException('Admin Internal service peer host-runner path is invalid');
      const siteId = match[1];
      const secret = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
      const plan = stringValue(body.planId) ? await this.store.getSiteSlotPlan(stringValue(body.planId) ?? '') : null;
      const internalServicePeerHostRunnerEnsure = await adminInternalServicePeerHostRunnerEnsureResult(siteId, plan, secret, body, this.store);
      return {
        internalServicePeerHostRunnerEnsure,
        internalServicePeerRuntimeStatus: internalServicePeerHostRunnerEnsure.afterStatus ?? null,
        secret: secret ? redactAdminDomesticWireGuardSecret(secret) : null
      };
    }
    if (actionId === 'site-slot.internal-service-peer.apply') {
      const match = matchPath(path, /^\/internal\/v1\/config-center\/domestic-wg-secrets\/([^/]+)\/internal-service-peer-apply$/);
      if (!match) throw new BadRequestException('Admin Internal service peer apply path is invalid');
      const siteId = match[1];
      const secret = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
      const plan = stringValue(body.planId) ? await this.store.getSiteSlotPlan(stringValue(body.planId) ?? '') : null;
      const internalServicePeerApply = await adminInternalServicePeerApplyResult(siteId, plan, secret, body, this.store);
      return {
        internalServicePeerApply,
        internalServicePeerRuntimeStatus: internalServicePeerApply.afterStatus ?? internalServicePeerApply.beforeStatus,
        secret: secret ? redactAdminDomesticWireGuardSecret(secret) : null
      };
    }
    if (actionId === 'site-slot.internal-service-peer.sync-domestic-key') {
      const match = matchPath(path, /^\/internal\/v1\/config-center\/domestic-wg-secrets\/([^/]+)\/internal-service-peer-sync-domestic-key$/);
      if (!match) throw new BadRequestException('Admin Internal service peer Domestic key sync path is invalid');
      const siteId = match[1];
      const secret = await this.store.getSiteSlotDomesticWireGuardSecret(siteId);
      const plan = stringValue(body.planId) ? await this.store.getSiteSlotPlan(stringValue(body.planId) ?? '') : null;
      const internalServicePeerDomesticKeySync = await this.adminInternalServicePeerDomesticKeySyncResult(siteId, plan, secret, body);
      return {
        internalServicePeerDomesticKeySync,
        internalServicePeerRuntimeStatus: internalServicePeerDomesticKeySync.afterStatus ?? internalServicePeerDomesticKeySync.beforeStatus ?? null,
        secret: internalServicePeerDomesticKeySync.secret ?? (secret ? redactAdminDomesticWireGuardSecret(secret) : null)
      };
    }
    if (actionId === 'site-slot.domestic-relay-peer-append-ssh.prepare') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/executions\/([^/]+)\/prepare-domestic-relay-peer-append-ssh$/);
      if (!match) throw new BadRequestException('Admin Domestic relay peer append SSH prepare path is invalid');
      const execution = await this.store.getSiteSlotExecution(match[1]);
      if (!execution) throw new NotFoundException('Site slot execution not found');
      const plan = await this.store.getSiteSlotPlan(execution.planId);
      const initialPrepare = adminDomesticRelayPeerAppendSshPrepareResult(execution, plan, body);
      if (initialPrepare.status !== 'ready') return { relayPeerAppendSshPrepare: initialPrepare };
      const requestedBy = stringValue(body.requestedBy);
      const requestId = stringValue(body.requestId);
      const session = await this.store.startSiteSlotRunnerSession({
        runId: execution.runId,
        mode: 'remote-ssh',
        confirmRemoteExecution: true,
        requestedBy,
        requestId: requestId ? `${requestId}-runner` : 'admin-domestic-relay-peer-append-ssh-runner'
      });
      if (session.status !== 'queued') {
        return {
          relayPeerAppendSshPrepare: adminDomesticRelayPeerAppendSshPrepareResult(execution, plan, body, session),
          session
        };
      }
      const job = await this.store.createSiteSlotWorkerJob({
        sessionId: session.sessionId,
        workerId: stringValue(body.workerId) ?? `worker-domestic-relay-${execution.siteId}`,
        workerKind: siteSlotWorkerKind(body.workerKind) ?? 'domestic-runner',
        approvalId: stringValue(body.approvalId),
        changeWindowStart: stringValue(body.changeWindowStart),
        changeWindowEnd: stringValue(body.changeWindowEnd),
        retryLimit: numberValueOrNull(body.retryLimit) ?? 1,
        rollbackStrategy: stringValue(body.rollbackStrategy) ?? 'restore-domestic-wg-peer-before-append',
        requestedBy,
        requestId: requestId ? `${requestId}-worker-job` : 'admin-domestic-relay-peer-append-ssh-worker-job'
      });
      return {
        relayPeerAppendSshPrepare: adminDomesticRelayPeerAppendSshPrepareResult(execution, plan, body, session, job),
        session,
        job
      };
    }
    if (actionId === 'site-slot.domestic-relay-peer-append-awx.prepare') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/executions\/([^/]+)\/prepare-domestic-relay-peer-append-awx$/);
      if (!match) throw new BadRequestException('Admin Domestic relay peer append AWX prepare path is invalid');
      const execution = await this.store.getSiteSlotExecution(match[1]);
      if (!execution) throw new NotFoundException('Site slot execution not found');
      const plan = await this.store.getSiteSlotPlan(execution.planId);
      const initialPrepare = adminDomesticRelayPeerAppendAwxPrepareResult(execution, plan, body);
      if (initialPrepare.status !== 'ready') return { relayPeerAppendAwxPrepare: initialPrepare };
      const requestedBy = stringValue(body.requestedBy);
      const requestId = stringValue(body.requestId);
      const session = await this.store.startSiteSlotRunnerSession({
        runId: execution.runId,
        mode: 'awx-shadow',
        requestedBy,
        requestId: requestId ? `${requestId}-runner` : 'admin-domestic-relay-peer-append-awx-runner'
      });
      if (session.status !== 'queued') {
        return {
          relayPeerAppendAwxPrepare: adminDomesticRelayPeerAppendAwxPrepareResult(execution, plan, body, session),
          session
        };
      }
      const job = await this.store.createSiteSlotWorkerJob({
        sessionId: session.sessionId,
        workerId: stringValue(body.workerId) ?? `worker-awx-domestic-relay-${execution.siteId}`,
        workerKind: siteSlotWorkerKind(body.workerKind) ?? 'awx-runner',
        approvalId: stringValue(body.approvalId),
        changeWindowStart: stringValue(body.changeWindowStart),
        changeWindowEnd: stringValue(body.changeWindowEnd),
        retryLimit: numberValueOrNull(body.retryLimit) ?? 1,
        rollbackStrategy: stringValue(body.rollbackStrategy) ?? 'restore-domestic-wg-peer-before-append',
        requestedBy,
        requestId: requestId ? `${requestId}-worker-job` : 'admin-domestic-relay-peer-append-awx-worker-job'
      });
      return {
        relayPeerAppendAwxPrepare: adminDomesticRelayPeerAppendAwxPrepareResult(execution, plan, body, session, job),
        session,
        job
      };
    }
    if (actionId === 'site-slot.worker-run.remote-ssh-gate') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/remote-ssh-gate$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run remote SSH gate path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      return {
        gate: buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
          confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
          requestedBy: stringValue(body.requestedBy),
          requestId: stringValue(body.requestId)
        })
      };
    }
    if (actionId === 'site-slot.worker-run.remote-ssh-readonly-probe') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/remote-ssh-readonly-probe$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run remote SSH read-only probe path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
        confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
        requestedBy: stringValue(body.requestedBy),
        requestId: stringValue(body.requestId)
      });
      return {
        gate,
        readOnlyProbe: buildSiteSlotRemoteSshReadOnlyProbe(job, plan, sshProfile, gate, {
          confirmReadOnlyProbe: booleanValue(body.confirmReadOnlyProbe) === true
        })
      };
    }
    if (actionId === 'site-slot.worker-run.remote-ssh-execute') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-artifact-push-remote-ssh$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run remote SSH execute path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
        confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
        requestedBy: stringValue(body.requestedBy),
        requestId: stringValue(body.requestId)
      });
      const workerHandoff = buildSiteSlotRemoteSshWorkerHandoff(job, plan, gate, {
        workerInternalBaseUrl: stringValue(body.workerInternalBaseUrl) ?? stringValue(body.internalBaseUrl),
        confirmWorkerHandoff: booleanValue(body.confirmWorkerHandoff) === true
      });
      if (workerHandoff.status !== 'ready' || booleanValue(body.executeWorkerHandoff) !== true) {
        return {
          gate,
          workerHandoff
        };
      }
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const profileId = stringValue(workerHandoff.env?.SITE_SLOT_SSH_PROFILE_ID) ?? plan?.ssh.profileId;
      if (!profileId) throw new BadRequestException('Managed SSH profile is required before Remote SSH worker execution');
      const internalBaseUrl = stringValue(workerHandoff.env?.MX_WORKER_INTERNAL_BASE_URL)
        ?? stringValue(workerHandoff.env?.MX_INTERNAL_BASE_URL)
        ?? stringValue(body.workerInternalBaseUrl)
        ?? stringValue(body.internalBaseUrl);
      if (!internalBaseUrl) throw new BadRequestException('workerInternalBaseUrl is required before Remote SSH worker execution');
      const requestedBy = stringValue(body.requestedBy) ?? 'admin-ui';
      const requestId = stringValue(body.requestId) ?? 'admin-ui-worker-run-remote-ssh-execute';
      const workerExecution = await this.runRemoteSshWorker(job.jobId, profileId, internalBaseUrl, requestedBy, requestId);
      const latestReport = latestByCreatedAt(await this.store.listSiteSlotWorkerReports(job.jobId));
      const executionStatus = workerExecution.status === 'completed' && latestReport?.status === 'passed' ? 'executed' : workerExecution.status;
      return {
        gate,
        workerHandoff: {
          ...workerHandoff,
          execution: executionStatus,
          reportId: latestReport?.reportId ?? null,
          exitCode: workerExecution.exitCode
        },
        workerExecution,
        report: latestReport
      };
    }
    if (actionId === 'site-slot.worker-run.artifact-push-fake-transport') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-artifact-push-fake-transport$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run fake transport path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
        confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
        requestedBy: stringValue(body.requestedBy),
        requestId: stringValue(body.requestId)
      });
      const fakeTransport = adminFakeTransportResult(job, gate, booleanValue(body.confirmFakeTransport) === true);
      if (fakeTransport.status !== 'ready') return { gate, fakeTransport };
      const fakeTransportResult = artifactPushFakeTransportStepReports(job, plan, sshProfile);
      const report = await this.store.recordSiteSlotWorkerReport({
        jobId: job.jobId,
        workerId: stringValue(body.workerId) ?? job.worker.workerId,
        status: fakeTransportResult.status,
        message: stringValue(body.message) ?? `artifact-push fake transport by admin-ui ${fakeTransportResult.status}`,
        stepReports: fakeTransportResult.stepReports,
        requestId: stringValue(body.requestId)
      });
      return {
        gate,
        fakeTransport: {
          ...fakeTransport,
          status: report.status,
          execution: 'recorded',
          reportId: report.reportId
        },
        report
      };
    }
    if (actionId === 'site-slot.worker-run.artifact-push-remote-ssh-plan') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-artifact-push-remote-ssh-plan$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run remote SSH plan path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
        confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
        requestedBy: stringValue(body.requestedBy),
        requestId: stringValue(body.requestId)
      });
      const remoteSshPlan = adminRemoteSshPlanResult(job, gate, booleanValue(body.confirmPlanOnly) === true);
      if (remoteSshPlan.status !== 'ready') return { gate, remoteSshPlan };
      const remoteSshPlanResult = artifactPushRemoteSshPlanStepReports(job, plan, sshProfile);
      const report = await this.store.recordSiteSlotWorkerReport({
        jobId: job.jobId,
        workerId: stringValue(body.workerId) ?? job.worker.workerId,
        status: remoteSshPlanResult.status,
        message: stringValue(body.message) ?? `artifact-push remote SSH plan by admin-ui ${remoteSshPlanResult.status}`,
        stepReports: remoteSshPlanResult.stepReports,
        requestId: stringValue(body.requestId)
      });
      return {
        gate,
        remoteSshPlan: {
          ...remoteSshPlan,
          status: report.status,
          execution: 'recorded',
          reportId: report.reportId
        },
        report
      };
    }
    if (actionId === 'site-slot.worker-run.domestic-relay-peer-plan') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-domestic-relay-peer-plan$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run Domestic relay peer plan path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const relayPeerInput = await resolveDomesticRelayPeerInput(this.store, body);
      const relayPeerPlan = adminDomesticRelayPeerPlanResult(job, plan, body, relayPeerInput);
      if (relayPeerPlan.status !== 'ready') return { relayPeerPlan };
      const reportResult = domesticRelayPeerPlanStepReports(job, plan, body, relayPeerInput);
      const report = await this.store.recordSiteSlotWorkerReport({
        jobId: job.jobId,
        workerId: stringValue(body.workerId) ?? job.worker.workerId,
        status: reportResult.status,
        message: stringValue(body.message) ?? `Domestic relay peer plan by admin-ui ${reportResult.status}`,
        stepReports: reportResult.stepReports,
        requestId: stringValue(body.requestId)
      });
      return {
        relayPeerPlan: {
          ...relayPeerPlan,
          status: report.status,
          execution: 'recorded',
          reportId: report.reportId
        },
        report
      };
    }
    if (actionId === 'site-slot.worker-run.domestic-relay-readonly-probe') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/domestic-relay-readonly-probe$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run Domestic relay read-only probe path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const secret = plan?.siteId ? await this.store.getSiteSlotDomesticWireGuardSecret(plan.siteId) : null;
      return {
        relayReadOnlyProbe: adminDomesticRelayReadOnlyProbeResult(job, plan, body, secret)
      };
    }
    if (actionId === 'site-slot.worker-run.domestic-relay-peer-append') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/domestic-relay-peer-append$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run Domestic relay peer append path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const relayPeerInput = await resolveDomesticRelayPeerInput(this.store, body);
      return {
        relayPeerAppend: adminDomesticRelayPeerAppendResult(job, plan, body, relayPeerInput)
      };
    }
    if (actionId === 'site-slot.worker-run.domestic-relay-peer-append-ssh') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-domestic-relay-peer-append-ssh$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run Domestic relay peer append SSH path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
        confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
        requestedBy: stringValue(body.requestedBy),
        requestId: stringValue(body.requestId)
      });
      const relayPeerInput = await resolveDomesticRelayPeerInput(this.store, body);
      const relayPeerAppend = adminDomesticRelayPeerAppendResult(job, plan, body, relayPeerInput);
      const relayPeerAppendSsh = adminDomesticRelayPeerAppendSshResult(job, plan, sshProfile, gate, body, relayPeerAppend);
      if (relayPeerAppendSsh.status !== 'ready') return { gate, relayPeerAppend, relayPeerAppendSsh };
      const reportResult = await domesticRelayPeerAppendSshStepReports(job, plan, sshProfile, gate, body, relayPeerInput, relayPeerAppend);
      const report = await this.store.recordSiteSlotWorkerReport({
        jobId: job.jobId,
        workerId: stringValue(body.workerId) ?? job.worker.workerId,
        status: reportResult.status,
        message: stringValue(body.message) ?? `Domestic relay peer append SSH by admin-ui ${reportResult.status}`,
        stepReports: reportResult.stepReports,
        requestId: stringValue(body.requestId)
      });
      return {
        gate,
        relayPeerAppend,
        relayPeerAppendSsh: {
          ...relayPeerAppendSsh,
          status: report.status,
          execution: 'recorded',
          reportId: report.reportId
        },
        report
      };
    }
    if (actionId === 'site-slot.worker-run.awx-sync-plan') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/awx-sync-plan$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run AWX sync plan path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const plan = await this.store.getSiteSlotPlan(job.planId);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const awxProvider = await this.resolveAwxProviderConfig(job.kind, stringValue(body.awxProviderId) ?? stringValue(body.providerId));
      return {
        awxSyncPlan: buildAwxProviderSyncPlan(awxProvider, {
          kind: job.kind,
          siteId: job.siteId,
          host: plan?.host ?? sshProfile?.host ?? null,
          sshUser: plan?.ssh.user ?? sshProfile?.sshUser ?? null,
          sshPort: plan?.ssh.port ?? sshProfile?.sshPort ?? null,
          sshProfileId: sshProfile?.profileId ?? plan?.ssh.profileId ?? null,
          planId: job.planId,
          jobId: job.jobId,
          sessionId: job.sessionId,
          runId: job.runId,
          requestId: stringValue(body.requestId)
        })
      };
    }
    if (actionId === 'site-slot.worker-run.awx-credential-sync') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-awx-credential-sync$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run AWX credential sync path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const plan = await this.store.getSiteSlotPlan(job.planId);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const awxProvider = await this.resolveAwxProviderConfig(job.kind, stringValue(body.awxProviderId) ?? stringValue(body.providerId));
      const runtimePolicy = await this.resolveRuntimeFeaturePolicy(AWX_CREDENTIAL_SYNC_FEATURE_KEY);
      return runAwxCredentialSync(job, plan, sshProfile, awxProvider, {
        token: stringValue(body.awxToken) ?? stringValue(body.token),
        confirmAwxCredentialSync: booleanValue(body.confirmAwxCredentialSync) === true,
        timeoutSeconds: numberValueOrNull(body.timeoutSeconds),
        runtimePolicy,
        requestId: stringValue(body.requestId)
      });
    }
    if (actionId === 'site-slot.worker-run.awx-object-sync') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-awx-object-sync$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run AWX object sync path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const plan = await this.store.getSiteSlotPlan(job.planId);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const awxProvider = await this.resolveAwxProviderConfig(job.kind, stringValue(body.awxProviderId) ?? stringValue(body.providerId));
      const runtimePolicy = await this.resolveRuntimeFeaturePolicy(AWX_OBJECT_SYNC_FEATURE_KEY);
      return runAwxObjectSync(job, plan, sshProfile, awxProvider, {
        token: stringValue(body.awxToken) ?? stringValue(body.token),
        confirmAwxSync: booleanValue(body.confirmAwxSync) === true,
        timeoutSeconds: numberValueOrNull(body.timeoutSeconds),
        runtimePolicy,
        requestId: stringValue(body.requestId)
      });
    }
    if (actionId === 'site-slot.worker-run.awx-shadow') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-awx-shadow$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run AWX shadow path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const plan = await this.store.getSiteSlotPlan(job.planId);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const awxProvider = await this.resolveAwxProviderConfig(job.kind);
      const awxShadowResult = awxShadowStepReports(job, plan, sshProfile, awxProvider);
      const report = await this.store.recordSiteSlotWorkerReport({
        jobId: job.jobId,
        workerId: stringValue(body.workerId) ?? job.worker.workerId,
        status: awxShadowResult.status,
        message: stringValue(body.message) ?? `AWX shadow worker run by admin-ui ${awxShadowResult.status}`,
        stepReports: awxShadowResult.stepReports,
        requestId: stringValue(body.requestId)
      });
      return {
        awxShadow: {
          awxShadowId: `awx_shadow_${job.jobId}`,
          status: report.status,
          execution: 'recorded',
          boundary: 'awx-api-shadow-no-remote-mutation',
          provider: 'awx-shadow',
          providerId: awxProvider?.providerId ?? null,
          reportId: report.reportId,
          nextActions: ['map-awx-events-to-worker-report', 'replace-shadow-with-awx-api-provider']
        },
        report
      };
    }
    if (actionId === 'site-slot.worker-run.awx-launch') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-awx-launch$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run AWX launch path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const plan = await this.store.getSiteSlotPlan(job.planId);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const awxProvider = await this.resolveAwxProviderConfig(job.kind, stringValue(body.awxProviderId) ?? stringValue(body.providerId));
      const runtimePolicy = await this.resolveRuntimeFeaturePolicy(AWX_LAUNCH_FEATURE_KEY);
      const awxLaunchResult = await runAwxApiLaunch(job, plan, sshProfile, awxProvider, {
        token: stringValue(body.awxToken) ?? stringValue(body.token),
        confirmAwxLaunch: booleanValue(body.confirmAwxLaunch) === true,
        waitForCompletion: booleanValue(body.waitForCompletion) === true,
        timeoutSeconds: numberValueOrNull(body.timeoutSeconds),
        pollIntervalMs: numberValueOrNull(body.pollIntervalMs),
        runtimePolicy,
        requestId: stringValue(body.requestId)
      });
      const report = awxLaunchResult.reportResult
        ? await this.store.recordSiteSlotWorkerReport({
          jobId: job.jobId,
          workerId: stringValue(body.workerId) ?? job.worker.workerId,
          status: awxLaunchResult.reportResult.status,
          message: stringValue(body.message) ?? `AWX API launch by admin-ui ${awxLaunchResult.reportResult.status}`,
          stepReports: awxLaunchResult.reportResult.stepReports,
          requestId: stringValue(body.requestId)
        })
        : null;
      return {
        awxLaunch: {
          ...awxLaunchResult.awxLaunch,
          reportId: report?.reportId ?? null
        },
        report
      };
    }
    if (actionId === 'site-slot.worker-run.simulate' || actionId === 'site-slot.worker-run.artifact-push-dry-run') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-(simulate|artifact-push-dry-run)$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      if (job.currentReportId) throw new BadRequestException('Site slot worker job already has a report');
      if (job.status !== 'ready') throw new BadRequestException(`Site slot worker job is not ready: ${job.status}`);
      const dryRun = actionId === 'site-slot.worker-run.artifact-push-dry-run';
      const plan = await this.store.getSiteSlotPlan(job.planId);
      await this.assertDomesticWgReadyForWorkerJob(job, plan);
      const sshProfile = dryRun && plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const dryRunResult = dryRun ? artifactPushDryRunStepReports(job, plan, sshProfile) : null;
      return {
        report: await this.store.recordSiteSlotWorkerReport({
          jobId: job.jobId,
          workerId: stringValue(body.workerId) ?? job.worker.workerId,
          status: dryRunResult?.status ?? 'passed',
          message: stringValue(body.message) ?? (dryRun ? `artifact-push dry-run by admin-ui ${dryRunResult?.status ?? 'passed'}` : 'simulated worker run by admin-ui'),
          stepReports: dryRunResult?.stepReports ?? simulatedWorkerStepReports(job),
          requestId: stringValue(body.requestId)
        })
      };
    }
    if (actionId === 'site-slot.rollback.start') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-reports\/([^/]+)\/rollback-executions$/);
      if (!match) throw new BadRequestException('Admin site-slot rollback path is invalid');
      return {
        rollbackExecution: await this.store.createSiteSlotRollbackExecution({
          reportId: match[1],
          mode: siteSlotRollbackExecutionMode(body.mode),
          confirmRollback: booleanValue(body.confirmRollback),
          requestedBy: stringValue(body.requestedBy),
          requestId: stringValue(body.requestId)
        })
      };
    }
    throw new BadRequestException('Admin action is not executable in Action Execution V1');
  }

  private async domesticPlanHostValidationFailure(input: SiteSlotPlanInput): Promise<string | null> {
    const kind = input.kind === 'oversea' ? 'oversea' : 'domestic';
    if (kind !== 'domestic') return null;
    if (input.host?.trim()) return siteSlotPlanHostValidationFailure(kind, input.host);
    const profileId = input.sshProfileId?.trim();
    if (!profileId) return siteSlotPlanHostValidationFailure(kind, null);
    const profile = await this.store.getSiteSlotSshProfile(profileId);
    if (!profile) return null;
    return siteSlotPlanHostValidationFailure(kind, profile.host);
  }

  private async adminDomesticRuntimeConfigApplyResult(siteId: string, body: Record<string, unknown>) {
    const requestedBy = stringValue(body.requestedBy) ?? 'admin-ui';
    const requestId = stringValue(body.requestId) ?? `admin-domestic-runtime-apply-${Date.now()}`;
    const confirm = booleanValue(body.confirmDomesticRuntimeApply) === true;
    const shouldSave = booleanValue(body.saveBeforeApply) === true;
    const configInput = toDomesticRuntimeConfigInput({ ...body, siteId, requestedBy, requestId: `${requestId}-save` });
    const savedConfig = shouldSave
      ? await this.store.upsertSiteSlotDomesticRuntimeConfig(configInput)
      : await this.store.getSiteSlotDomesticRuntimeConfig(siteId);
    const config = savedConfig ?? await this.store.upsertSiteSlotDomesticRuntimeConfig({
      siteId,
      requestedBy,
      requestId: `${requestId}-seed`
    });
    const explicitPlanId = stringValue(body.planId);
    const explicitProfileId = stringValue(body.sshProfileId);
    const plan = explicitPlanId ? await this.store.getSiteSlotPlan(explicitPlanId) : await this.latestDomesticPlan(siteId);
    const profile = explicitProfileId
      ? await this.store.getSiteSlotSshProfile(explicitProfileId)
      : plan?.ssh.profileId
        ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId)
        : await this.store.getSiteSlotSshProfileForSite(siteId);
    const profileFailures = profile ? sshProfileBlockingReasons(profile) : [];
    const blockedReasons = [
      ...(!confirm ? ['confirmDomesticRuntimeApply=true is required before SSH apply/restart'] : []),
      ...(config.status === 'active' ? [] : [`Domestic runtime config is ${config.status}`]),
      ...blockedWarnings(config.warnings),
      ...(profile ? [] : ['Domestic SSH profile is required before applying runtime config']),
      ...profileFailures
    ];
    if (blockedReasons.length > 0 || !profile) {
      return {
        status: 'blocked',
        execution: 'not-started',
        mode: 'domestic-runtime-config-apply',
        siteId,
        planId: plan?.planId ?? explicitPlanId ?? null,
        config,
        sshProfileId: profile?.profileId ?? explicitProfileId ?? null,
        blockedReasons,
        warnings: config.warnings,
        nextActions: ['save-runtime-config', 'fix-domestic-ssh-profile', 'confirm-and-apply-runtime-config'],
        finishedAt: new Date().toISOString()
      };
    }

    const startedAt = new Date().toISOString();
    let execution;
    try {
      execution = await runSshScriptWithProfile(profile, domesticRuntimeConfigApplyScript(config), 90000);
    } catch (error) {
      execution = sshScriptFailure(error, startedAt);
    }
    const passed = execution.status === 'passed';
    await this.store.recordAudit({
      eventType: 'config.domestic_runtime_config.applied',
      actorKind: 'admin-action',
      requestId,
      metadata: {
        siteId,
        planId: plan?.planId ?? null,
        configId: config.configId,
        publicBaseUrl: config.edge.publicBaseUrl,
        internalApi: config.upstreams.internalApi,
        sshProfileId: profile.profileId,
        status: execution.status,
        exitCode: execution.exitCode
      }
    });
    return {
      status: passed ? 'passed' : 'failed',
      execution: passed ? 'completed' : 'failed',
      mode: 'domestic-runtime-config-apply',
      siteId,
      planId: plan?.planId ?? explicitPlanId ?? null,
      config,
      sshProfileId: profile.profileId,
      remote: execution,
      publicBootstrapUrl: config.edge.publicBaseUrl,
      blockedReasons: passed ? [] : [`Domestic runtime apply failed: ${execution.stderr || execution.status}`],
      warnings: config.warnings,
      nextActions: passed
        ? ['verify-domestic-bootstrap-healthz', 'restart-h-endpoint-or-refresh-bootstrap-snapshot']
        : ['check-domestic-ssh-and-docker-compose', 'retry-domestic-runtime-apply'],
      finishedAt: new Date().toISOString()
    };
  }

  private async latestDomesticPlan(siteId: string): Promise<SiteSlotPlan | null> {
    const plans = await this.store.listSiteSlotPlans();
    return latestByCreatedAt(plans.filter((plan) => plan.kind === 'domestic' && plan.siteId === siteId));
  }

  private async resolveAwxProviderConfig(kind: SiteSlotKind, providerId?: string | null): Promise<AwxProviderConfig | null> {
    if (providerId) {
      const provider = await this.store.getAwxProviderConfig(providerId);
      if (provider) return provider;
    }
    const providers = await this.store.listAwxProviderConfigs(kind);
    const matched = providers.find((provider) => provider.status === 'active' && provider.defaultKind === kind)
      ?? providers.find((provider) => provider.status === 'active' && provider.defaultKind === 'all')
      ?? null;
    if (matched) return matched;
    const activeProviders = (await this.store.listAwxProviderConfigs()).filter((provider) => provider.status === 'active');
    return activeProviders.length === 1 ? activeProviders[0] : null;
  }

  private async resolveRuntimeFeaturePolicy(featureKey: string): Promise<RuntimeFeaturePolicy | null> {
    const policies = await this.store.listRuntimeFeaturePolicies(featureKey);
    return policies.find((policy) => policy.scopeKind === 'global') ?? policies[0] ?? null;
  }

  private async listAwxRuntimePolicies(): Promise<RuntimeFeaturePolicy[]> {
    const policies = await Promise.all([
      this.store.listRuntimeFeaturePolicies(AWX_CREDENTIAL_SYNC_FEATURE_KEY),
      this.store.listRuntimeFeaturePolicies(AWX_OBJECT_SYNC_FEATURE_KEY),
      this.store.listRuntimeFeaturePolicies(AWX_LAUNCH_FEATURE_KEY)
    ]);
    return policies.flat();
  }

  private async assertDomesticWgReadyForWorkerJob(job: SiteSlotWorkerJob, plan: SiteSlotPlan | null): Promise<void> {
    if (job.kind !== 'domestic' && plan?.kind !== 'domestic') return;
    if (!plan) throw new BadRequestException('Site slot plan is required before Domestic worker execution');
    await this.materializeDomesticBootstrapSubscription(plan);
    const secret = await this.store.getSiteSlotDomesticWireGuardSecret(plan.siteId);
    if (domesticWireGuardMaterializeNeeded(plan, secret)) {
      throw new BadRequestException('Materialize Domestic WG before running Domestic worker job gates');
    }
  }

  private async buildSiteSlotPipelines(actionPolicy: AdminActionPolicy, planId?: string | null): Promise<AdminSiteSlotPipeline[]> {
    const [plans, executions, runnerSessions, workerJobs, workerReports, rollbackExecutions, rollbackReports, domesticWgSecrets] = await Promise.all([
      this.store.listSiteSlotPlans(),
      this.store.listSiteSlotExecutions(),
      this.store.listSiteSlotRunnerSessions(),
      this.store.listSiteSlotWorkerJobs(),
      this.store.listSiteSlotWorkerReports(),
      this.store.listSiteSlotRollbackExecutions(),
      this.store.listSiteSlotRollbackReports(),
      this.store.listSiteSlotDomesticWireGuardSecrets()
    ]);
    return plans
      .filter((plan) => !planId || plan.planId === planId)
      .map((plan) => buildPipeline(
        plan,
        executions.filter((execution) => execution.planId === plan.planId),
        runnerSessions.filter((session) => session.planId === plan.planId),
        workerJobs.filter((job) => job.planId === plan.planId),
        workerReports.filter((report) => report.planId === plan.planId),
        rollbackExecutions.filter((execution) => execution.planId === plan.planId),
        rollbackReports.filter((report) => report.planId === plan.planId),
        domesticWgSecrets.find((secret) => secret.siteId === plan.siteId) ?? null,
        actionPolicy
      ))
      .sort((a, b) => b.summary.latestUpdatedAt.localeCompare(a.summary.latestUpdatedAt));
  }
}

function buildPipeline(
  plan: SiteSlotPlan,
  executions: SiteSlotExecutionRun[],
  runnerSessions: SiteSlotRunnerSession[],
  workerJobs: SiteSlotWorkerJob[],
  workerReports: SiteSlotWorkerReport[],
  rollbackExecutions: SiteSlotRollbackExecution[],
  rollbackReports: SiteSlotRollbackReport[],
  domesticWgSecret: SiteSlotDomesticWireGuardSecret | null,
  actionPolicy: AdminActionPolicy
): AdminSiteSlotPipeline {
  const timeline = buildTimeline(plan, executions, runnerSessions, workerJobs, workerReports, rollbackExecutions, rollbackReports);
  const latest = timeline[timeline.length - 1] ?? null;
  const failureSummary = latestWorkerReportFailureSummary(workerReports);
  const domesticPostInstallGate = domesticPostInstallInternalGate(plan, workerReports, domesticWgSecret);
  const warnings = uniqueStrings([
    ...domesticPostInstallGate.warnings,
    ...plan.warnings,
    ...executions.flatMap((execution) => execution.warnings),
    ...runnerSessions.flatMap((session) => session.warnings),
    ...workerJobs.flatMap((job) => job.warnings),
    ...rollbackExecutions.flatMap((execution) => execution.warnings)
  ]);
  const nextActions = uniqueStrings([
    ...domesticPostInstallGate.nextActions,
    ...(latest?.nextActions.length ? latest.nextActions : plan.nextActions)
  ]);
  const health = pipelineHealth(plan, executions, runnerSessions, workerJobs, workerReports, rollbackExecutions, rollbackReports);
  const summary: AdminSiteSlotPipelineSummary = {
    planId: plan.planId,
    siteId: plan.siteId,
    kind: plan.kind,
    environment: plan.environment,
    status: plan.status,
    health: domesticPostInstallGate.blocked && health === 'passed' ? 'blocked' : health,
    currentStage: latest ? latest.kind : 'plan',
    latestStatus: latest ? latest.status : plan.status,
    latestUpdatedAt: latest ? latest.at : plan.createdAt,
    counts: {
      executions: executions.length,
      runnerSessions: runnerSessions.length,
      workerJobs: workerJobs.length,
      workerReports: workerReports.length,
      rollbackExecutions: rollbackExecutions.length,
      rollbackReports: rollbackReports.length
    },
    warnings,
    failureSummary,
    domesticWireGuard: domesticWireGuardPipelineSummary(domesticWgSecret),
    nextActions,
    actionHints: buildPipelineActionHints(actionPolicy, plan, executions, runnerSessions, workerJobs, workerReports, rollbackExecutions, domesticWgSecret, domesticPostInstallGate)
  };
  return {
    summary,
    plan,
    executions: sortByCreatedAt(executions),
    runnerSessions: sortByStartedAt(runnerSessions),
    workerJobs: sortByCreatedAt(workerJobs),
    workerReports: sortByCreatedAt(workerReports),
    rollbackExecutions: sortByCreatedAt(rollbackExecutions),
    rollbackReports: sortByCreatedAt(rollbackReports),
    timeline
  };
}

function domesticWireGuardPipelineSummary(secret: SiteSlotDomesticWireGuardSecret | null): AdminSiteSlotPipelineSummary['domesticWireGuard'] {
  if (!secret) return null;
  return {
    status: secret.status,
    publicEndpoint: secret.publicEndpoint,
    listenPort: secret.listenPort,
    internalDirectEnabled: secret.internalDirectEnabled,
    internalDirectEndpoint: secret.internalDirectEndpoint,
    internalDirectListenPort: secret.internalDirectListenPort,
    internalServiceIp: secret.internalServiceIp,
    materialDigest: secret.fingerprints.materialDigest,
    updatedAt: secret.updatedAt
  };
}

function limitSiteSlotPipelines(pipelines: AdminSiteSlotPipeline[], limit: number): AdminSiteSlotPipeline[] {
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return [];
  const selected: AdminSiteSlotPipeline[] = [];
  const selectedPlanIds = new Set<string>();
  const bySite = new Map<string, AdminSiteSlotPipeline[]>();
  for (const pipeline of pipelines) {
    const key = `${pipeline.summary.kind}:${pipeline.summary.siteId}`;
    const sitePipelines = bySite.get(key) ?? [];
    sitePipelines.push(pipeline);
    bySite.set(key, sitePipelines);
  }
  const representatives = [...bySite.values()]
    .map((sitePipelines) => chooseSiteSlotPipelineRepresentative(sitePipelines))
    .filter((pipeline): pipeline is AdminSiteSlotPipeline => Boolean(pipeline))
    .sort(compareSiteSlotPipelinesForList);
  for (const pipeline of representatives) {
    if (selected.length >= max) return selected;
    selected.push(pipeline);
    selectedPlanIds.add(pipeline.summary.planId);
  }
  for (const pipeline of pipelines) {
    if (selected.length >= max) break;
    if (selectedPlanIds.has(pipeline.summary.planId)) continue;
    selected.push(pipeline);
    selectedPlanIds.add(pipeline.summary.planId);
  }
  return selected;
}

function chooseSiteSlotPipelineRepresentative(pipelines: AdminSiteSlotPipeline[]): AdminSiteSlotPipeline | null {
  const nonRollback = pipelines.filter((pipeline) => {
    return pipeline.summary.health !== 'rollback' && !pipeline.summary.currentStage.startsWith('rollback-');
  });
  const candidates = nonRollback.length ? nonRollback : pipelines;
  return candidates
    .slice()
    .sort((left, right) => right.summary.latestUpdatedAt.localeCompare(left.summary.latestUpdatedAt))[0] ?? null;
}

function compareSiteSlotPipelinesForList(left: AdminSiteSlotPipeline, right: AdminSiteSlotPipeline): number {
  return siteSlotPipelineRepresentativeScore(right) - siteSlotPipelineRepresentativeScore(left)
    || right.summary.latestUpdatedAt.localeCompare(left.summary.latestUpdatedAt);
}

function siteSlotPipelineRepresentativeScore(pipeline: AdminSiteSlotPipeline): number {
  const healthScore = {
    running: 110,
    ready: 100,
    blocked: 90,
    planned: 80,
    passed: 70,
    rollback: 30,
    failed: 10
  }[pipeline.summary.health] ?? 0;
  const actionScore = pipeline.summary.actionHints.some((action) => action.allowed) ? 25 : 0;
  return healthScore + actionScore + pipelineOperationalScoreForOverview(pipeline);
}

function toAdminActionExecutionInput(body: Record<string, unknown>) {
  return {
    actionId: stringValue(body.actionId) ?? '',
    path: stringValue(body.path) ?? '',
    body: asRecord(body.body)
  };
}

function assertConfirmFields(action: AdminActionDescriptor, body: Record<string, unknown>): void {
  const missing = action.confirmFields.filter((field) => !confirmFieldSatisfied(body[field]));
  if (missing.length > 0) {
    throw new BadRequestException(`Admin action requires confirmation fields: ${missing.join(', ')}`);
  }
}

function confirmFieldSatisfied(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

function matchPath(path: string, pattern: RegExp): string[] | null {
  const match = path.match(pattern);
  if (!match) return null;
  return match.map((value, index) => index === 0 ? value : decodeURIComponent(value));
}

function siteSlotExecutionMode(value: unknown): SiteSlotExecutionMode | null {
  if (value === 'dry-run' || value === 'manual' || value === 'ssh') return value;
  return null;
}

function siteSlotRunnerMode(value: unknown): SiteSlotRunnerMode | null {
  if (value === 'simulate' || value === 'remote-ssh' || value === 'awx-shadow') return value;
  return null;
}

function siteSlotWorkerKind(value: unknown): SiteSlotWorkerKind | null {
  if (value === 'internal-runner' || value === 'domestic-runner' || value === 'oversea-site-agent' || value === 'awx-runner' || value === 'admin-manual') return value;
  return null;
}

function siteSlotRollbackExecutionMode(value: unknown): SiteSlotRollbackExecutionMode | null {
  if (value === 'simulate' || value === 'manual') return value;
  return null;
}

function siteSlotKind(value: unknown): SiteSlotPlanInput['kind'] | null {
  if (value === 'oversea' || value === 'domestic') return value;
  return null;
}

function toSiteSlotPlanInput(body: Record<string, unknown>): SiteSlotPlanInput {
  return {
    siteId: stringValue(body.siteId),
    kind: siteSlotKind(body.kind),
    sshProfileId: stringValue(body.sshProfileId),
    host: stringValue(body.host),
    sshUser: stringValue(body.sshUser),
    sshPort: numberValueOrNull(body.sshPort),
    rootAccess: booleanValue(body.rootAccess),
    hasDocker: booleanValue(body.hasDocker),
    hasOutboundInternet: booleanValue(body.hasOutboundInternet),
    overseaSiteId: stringValue(body.overseaSiteId),
    overseaHost: stringValue(body.overseaHost),
    serverPorts: stringValue(body.serverPorts),
    exportPort: numberValueOrNull(body.exportPort),
    internalBaseUrl: stringValue(body.internalBaseUrl),
    workerInternalBaseUrl: stringValue(body.workerInternalBaseUrl),
    overseaCallbackBaseUrl: stringValue(body.overseaCallbackBaseUrl),
    accessAccounts: siteSlotPlanAccessAccountsValue(body.accessAccounts),
    requestId: stringValue(body.requestId),
    createdBy: stringValue(body.createdBy)
  };
}

function toDomesticRuntimeConfigInput(body: Record<string, unknown>): SiteSlotDomesticRuntimeConfigInput {
  return {
    siteId: stringValue(body.siteId),
    status: stringValue(body.status),
    edgeBind: stringValue(body.edgeBind),
    edgePort: numberValueOrNull(body.edgePort),
    bootstrapProtocol: stringValue(body.bootstrapProtocol),
    bootstrapHost: stringValue(body.bootstrapHost),
    bootstrapPort: numberValueOrNull(body.bootstrapPort),
    internalBaseUrl: stringValue(body.internalBaseUrl),
    internalApiUpstream: stringValue(body.internalApiUpstream),
    internalH2iUpstream: stringValue(body.internalH2iUpstream),
    dnsBind: stringValue(body.dnsBind),
    dnsPort: numberValueOrNull(body.dnsPort),
    requestedBy: stringValue(body.requestedBy),
    requestId: stringValue(body.requestId)
  };
}

function siteSlotPlanHostValidationFailure(kind: SiteSlotPlanInput['kind'], host: string | null | undefined): string | null {
  if (kind !== 'domestic') return null;
  const normalized = normalizedPlanHost(host);
  if (!normalized) return 'Domestic plan requires a real public host or IP before WG materialization';
  if (isPlaceholderDomesticPlanHost(normalized)) {
    return `Domestic plan host "${host}" is a placeholder; use the real Domestic public IP or DNS name`;
  }
  return null;
}

function normalizedPlanHost(host: string | null | undefined): string | null {
  const value = host?.trim();
  if (!value) return null;
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split('/')[0] ?? withoutScheme;
  const withoutUserInfo = authority.includes('@') ? authority.split('@').pop() ?? authority : authority;
  if (withoutUserInfo.startsWith('[')) return withoutUserInfo.slice(1, withoutUserInfo.indexOf(']')).toLowerCase();
  return withoutUserInfo.replace(/:\d+$/, '').toLowerCase();
}

function isPlaceholderDomesticPlanHost(host: string): boolean {
  return (host.startsWith('<') && host.endsWith('>'))
    || host === 'host'
    || host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host.startsWith('127.')
    || host.endsWith('.localhost')
    || host.endsWith('.invalid')
    || host.endsWith('.test')
    || host.endsWith('.example.com')
    || host.endsWith('.example.net')
    || host.endsWith('.example.org');
}

function siteSlotPlanAccessAccountsValue(value: unknown): SiteSlotPlanInput['accessAccounts'] {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    const row = asRecord(item);
    return {
      username: stringValue(row.username) ?? '',
      authToken: stringValue(row.authToken) ?? '',
      status: stringValue(row.status),
      upRate: stringValue(row.upRate),
      downRate: stringValue(row.downRate)
    };
  }).filter((account) => account.username && account.authToken);
}

function siteSlotPlanAccessAccountMaterial(accounts: SiteSlotAccessAccount[]): SiteSlotPlanAccessAccountInput[] {
  return accounts
    .filter((account) => account.status === 'active')
    .map((account) => ({
      username: account.username,
      authToken: account.authToken,
      status: account.status,
      upRate: '30 Mbps',
      downRate: '30 Mbps'
    }));
}

function domesticBootstrapAccount(accounts: SiteSlotAccessAccount[]): SiteSlotAccessAccount | null {
  return accounts.find((account) => account.role === 'domestic')
    ?? accounts.find((account) => account.username.endsWith('-domestic'))
    ?? null;
}

function internalBootstrapAccount(accounts: SiteSlotAccessAccount[]): SiteSlotAccessAccount | null {
  return accounts.find((account) => account.role === 'internal')
    ?? accounts.find((account) => account.username.endsWith('-internal'))
    ?? null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return null;
}

function numberValueOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function simulatedWorkerStepReports(job: SiteSlotWorkerJob): NonNullable<SiteSlotWorkerReportInput['stepReports']> {
  const now = new Date().toISOString();
  return [...job.steps]
    .sort((left, right) => left.order - right.order)
    .map((step) => ({
      stepId: step.stepId,
      status: 'passed' as const,
      exitCode: 0,
      stdout: step.redactOutput ? '[redacted simulated output]' : `simulated command: ${step.command}`,
      stderr: null,
      startedAt: now,
      finishedAt: now,
      attempt: 1
    }));
}

function artifactPushDryRunStepReports(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
): {
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
} {
  const stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']> = [];
  let blockRemaining = false;
  for (const step of [...job.steps].sort((left, right) => left.order - right.order)) {
    if (blockRemaining) {
      const now = new Date().toISOString();
      stepReports.push({
        stepId: step.stepId,
        status: 'blocked',
        exitCode: null,
        stdout: null,
        stderr: 'blocked: previous artifact-push dry-run step failed',
        startedAt: now,
        finishedAt: now,
        attempt: 1
      });
      continue;
    }
    const report = artifactPushDryRunStepReport(job, step, plan, sshProfile);
    stepReports.push(report);
    if (report.status === 'failed' && step.stopOnFailure !== false) {
      blockRemaining = true;
    }
  }
  return {
    status: workerReportStatus(stepReports),
    stepReports
  };
}

function artifactPushDryRunStepReport(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
): NonNullable<SiteSlotWorkerReportInput['stepReports']>[number] {
  const startedAt = new Date().toISOString();
  const evidence = artifactPushDryRunEvidence(job, step, plan, sshProfile);
  const failed = evidence.failures.length > 0;
  return {
    stepId: step.stepId,
    status: failed ? 'failed' : 'passed',
    exitCode: failed ? 1 : 0,
    stdout: JSON.stringify(redactArtifactPushEvidence(step, evidence), null, 2),
    stderr: failed ? evidence.failures.join('\n') : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt: 1
  };
}

function artifactPushRemoteSshPlanStepReports(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
): {
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
} {
  const stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']> = [];
  let blockRemaining = false;
  for (const step of [...job.steps].sort((left, right) => left.order - right.order)) {
    if (blockRemaining) {
      const now = new Date().toISOString();
      stepReports.push({
        stepId: step.stepId,
        status: 'blocked',
        exitCode: null,
        stdout: null,
        stderr: 'blocked: previous artifact-push remote SSH plan step failed',
        startedAt: now,
        finishedAt: now,
        attempt: 1
      });
      continue;
    }
    const report = artifactPushRemoteSshPlanStepReport(job, step, plan, sshProfile);
    stepReports.push(report);
    if (report.status === 'failed' && step.stopOnFailure !== false) {
      blockRemaining = true;
    }
  }
  return {
    status: workerReportStatus(stepReports),
    stepReports
  };
}

function artifactPushRemoteSshPlanStepReport(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
): NonNullable<SiteSlotWorkerReportInput['stepReports']>[number] {
  const startedAt = new Date().toISOString();
  const evidence = artifactPushRemoteSshPlanEvidence(job, step, plan, sshProfile);
  const failed = evidence.failures.length > 0;
  return {
    stepId: step.stepId,
    status: failed ? 'failed' : 'passed',
    exitCode: failed ? 1 : 0,
    stdout: JSON.stringify(redactArtifactPushEvidence(step, evidence), null, 2),
    stderr: failed ? evidence.failures.join('\n') : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt: 1
  };
}

function domesticRelayPeerPlanStepReports(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  input = domesticRelayPeerInput(body)
): {
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
} {
  const steps = [...job.steps].sort((left, right) => left.order - right.order);
  const carrierStep = steps.find((step) => phaseIdFromSource(step.sourceId) === 'prepare-domestic-relay-authority')
    ?? steps.find((step) => phaseIdFromSource(step.sourceId) === 'activate-domestic-peer-center')
    ?? steps[0];
  const evidence = domesticRelayPeerPlanEvidence(job, carrierStep, plan, body, input);
  const stepReports = steps.map((step) => {
    const startedAt = new Date().toISOString();
    const isCarrier = step.stepId === carrierStep?.stepId;
    return {
      stepId: step.stepId,
      status: isCarrier ? evidence.failures.length > 0 ? 'failed' as const : 'passed' as const : 'passed' as const,
      exitCode: isCarrier ? evidence.failures.length > 0 ? 1 : 0 : 0,
      stdout: JSON.stringify(isCarrier ? evidence : domesticRelayPeerPlanSkippedEvidence(job, step, carrierStep?.stepId ?? null), null, 2),
      stderr: isCarrier && evidence.failures.length > 0 ? evidence.failures.join('\n') : null,
      startedAt,
      finishedAt: new Date().toISOString(),
      attempt: 1
    };
  });
  return {
    status: workerReportStatus(stepReports),
    stepReports
  };
}

function domesticRelayPeerPlanEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number] | undefined,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  input = domesticRelayPeerInput(body)
) {
  const allowedIp = input.leaseIp ? `${input.leaseIp}/32` : null;
  const plannedCommand = input.publicKey && allowedIp
    ? `wg set mx-domestic peer ${input.publicKey} allowed-ips ${allowedIp}`
    : null;
  const failures = domesticRelayPeerPlanFailures(job, plan, body, input);
  return {
    dryRun: true,
    mode: 'domestic-relay-peer-plan',
    execution: failures.length > 0 ? 'blocked' : 'planned',
    boundary: 'admin-domestic-relay-peer-plan-only',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sourceId: step?.sourceId ?? 'domestic-relay-peer-plan',
    phaseId: step ? phaseIdFromSource(step.sourceId) : 'domestic-relay-peer-plan',
    stepId: step?.stepId ?? 'domestic-relay-peer-plan',
    order: step?.order ?? 0,
    target: 'domestic',
    domesticRelay: {
      siteId: plan?.siteId ?? job.siteId,
      endpointHost: plan?.host ?? null,
      interfaceName: 'mx-domestic',
      listenPort: 51280,
      gatewayIp: '10.88.0.1',
      configPath: '/etc/wireguard/mx-domestic.conf',
      envArtifact: 'mx-domestic-relay.env'
    },
    internalServicePeer: {
      role: 'internal-service',
      fixedIp: '10.88.88.88',
      allowedIps: ['10.88.88.88/32'],
      configArtifact: 'mx-internal-service-peer.conf',
      privateKeyPlacement: 'internal-only',
      privateKeyCopiedToDomestic: false
    },
    homePeer: domesticRelayPeerHomePeer(input, {
      provisionedBy: 'internal-signed-relay-lease',
      domesticMutation: 'append-peer-after-enroll'
    }),
    planOnly: {
      enabled: true,
      commandExecuted: false,
      remoteMutation: false,
      reason: 'Admin records the Domestic WireGuard peer append plan before any SSH/AWX execution.'
    },
    plannedCommands: plannedCommand ? [
      plannedCommand,
      'wg show mx-domestic',
      'systemctl status wg-quick@mx-domestic --no-pager'
    ] : [],
    gates: {
      confirmRelayPeerPlan: booleanValue(body.confirmRelayPeerPlan) === true,
      publicKeyRequired: true,
      leaseIpMustBe10x: true,
      domesticOnly: true,
      internalPrivateKeyMustNotLeaveInternal: true,
      remoteMutationAllowed: false
    },
    notes: [
      'This action plans a Home peer append against the Domestic relay after enroll.',
      'It does not open SSH, call AWX, run wg, write /etc/wireguard, or mutate Domestic.',
      'The Internal service peer private key remains internal-only; Domestic receives only public peer material.'
    ],
    failures
  };
}

function domesticRelayPeerPlanSkippedEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  carrierStepId: string | null
) {
  return {
    dryRun: true,
    mode: 'domestic-relay-peer-plan',
    execution: 'skipped',
    boundary: 'admin-domestic-relay-peer-plan-only',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sourceId: step.sourceId,
    phaseId: phaseIdFromSource(step.sourceId),
    stepId: step.stepId,
    order: step.order,
    target: step.target,
    skipReason: `Domestic relay peer plan evidence is carried by ${carrierStepId ?? 'the first worker step'}.`,
    planOnly: {
      enabled: true,
      commandExecuted: false,
      remoteMutation: false
    }
  };
}

function artifactPushFakeTransportStepReports(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
): {
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
} {
  const stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']> = [];
  let blockRemaining = false;
  for (const step of [...job.steps].sort((left, right) => left.order - right.order)) {
    if (blockRemaining) {
      const now = new Date().toISOString();
      stepReports.push({
        stepId: step.stepId,
        status: 'blocked',
        exitCode: null,
        stdout: null,
        stderr: 'blocked: previous artifact-push fake transport step failed',
        startedAt: now,
        finishedAt: now,
        attempt: 1
      });
      continue;
    }
    const report = artifactPushFakeTransportStepReport(job, step, plan, sshProfile);
    stepReports.push(report);
    if (report.status === 'failed' && step.stopOnFailure !== false) {
      blockRemaining = true;
    }
  }
  return {
    status: workerReportStatus(stepReports),
    stepReports
  };
}

function artifactPushFakeTransportStepReport(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
): NonNullable<SiteSlotWorkerReportInput['stepReports']>[number] {
  const startedAt = new Date().toISOString();
  const evidence = artifactPushFakeTransportEvidence(job, step, plan, sshProfile);
  const failed = evidence.failures.length > 0;
  return {
    stepId: step.stepId,
    status: failed ? 'failed' : 'passed',
    exitCode: failed ? 1 : 0,
    stdout: JSON.stringify(redactArtifactPushEvidence(step, evidence), null, 2),
    stderr: failed ? evidence.failures.join('\n') : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt: 1
  };
}

function awxShadowStepReports(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  provider: AwxProviderConfig | null
): {
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
} {
  const stepReports = [...job.steps]
    .sort((left, right) => left.order - right.order)
    .map((step) => awxShadowStepReport(job, step, plan, sshProfile, provider));
  return {
    status: workerReportStatus(stepReports),
    stepReports
  };
}

function awxShadowStepReport(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  provider: AwxProviderConfig | null
): NonNullable<SiteSlotWorkerReportInput['stepReports']>[number] {
  const startedAt = new Date().toISOString();
  const evidence = awxShadowEvidence(job, step, plan, sshProfile, provider);
  const failed = evidence.failures.length > 0;
  return {
    stepId: step.stepId,
    status: failed ? 'failed' : 'passed',
    exitCode: failed ? 1 : 0,
    stdout: JSON.stringify(redactArtifactPushEvidence(step, evidence), null, 2),
    stderr: failed ? evidence.failures.join('\n') : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    attempt: 1
  };
}

function workerReportStatus(stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>): NonNullable<SiteSlotWorkerReportInput['status']> {
  if (stepReports.some((step) => step.status === 'failed')) return 'failed';
  if (stepReports.some((step) => step.status === 'blocked')) return 'blocked';
  return 'passed';
}

function artifactPushDryRunEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  options: { failOnTemplateArtifact?: boolean } = {}
) {
  const failures: string[] = [];
  const artifactBaseDir = resolveSiteSlotArtifactBaseDir();
  const artifactReferences = artifactReferenceValues(step.command).map((ref) => artifactReferenceEvidence(ref, artifactBaseDir, failures, {
    failOnTemplateArtifact: options.failOnTemplateArtifact === true
  }));
  return {
    dryRun: true,
    mode: 'artifact-push-dry-run',
    execution: 'not-executed',
    boundary: 'manifest-and-command-evidence-only',
    summaryLines: [
      'artifact-push dry-run: remote execution skipped',
      `target=${step.target}`,
      `requiresRoot=${step.requiresRoot ? 'yes' : 'no'}`,
      `timeoutSeconds=${step.timeoutSeconds}`
    ],
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sourceId: step.sourceId,
    phaseId: phaseIdFromSource(step.sourceId),
    stepId: step.stepId,
    order: step.order,
    target: step.target,
    requiresRoot: step.requiresRoot,
    commandKind: adminCommandKind(step.command),
    command: step.command,
    artifactBaseDir,
    artifactReferences,
    sshProfile: adminSshProfileEvidence(plan, sshProfile),
    transport: adminTransportEvidence(step.command),
    notes: [
      'This Admin dry-run validates Internal-side artifacts and emits deployment evidence.',
      'It does not open SSH, run rsync/scp, mutate Domestic, or mutate Oversea.'
    ],
    failures
  };
}

function artifactPushFakeTransportEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
) {
  const evidence = artifactPushDryRunEvidence(job, step, plan, sshProfile, { failOnTemplateArtifact: true });
  const commandKind = adminCommandKind(step.command);
  const executableRemoteCommand = executableAdminRemoteCommandKind(commandKind);
  return {
    ...evidence,
    dryRun: false,
    mode: 'artifact-push-fake-transport',
    execution: executableRemoteCommand ? 'fake-executed' : 'skipped',
    boundary: 'fake-transport-no-remote-mutation',
    summaryLines: [
      'artifact-push fake transport: remote command not executed',
      `target=${step.target}`,
      `requiresRoot=${step.requiresRoot ? 'yes' : 'no'}`,
      `timeoutSeconds=${step.timeoutSeconds}`
    ],
    effectiveCommand: step.command,
    fakeTransport: {
      enabled: true,
      commandExecuted: false,
      remoteMutation: false,
      reason: 'Admin fake transport records worker report evidence without opening SSH/rsync/scp.'
    },
    notes: [
      'This Admin fake transport exercises the remote SSH gate and records worker evidence.',
      'It does not open SSH, run rsync/scp, mutate Domestic, or mutate Oversea.'
    ]
  };
}

function artifactPushRemoteSshPlanEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null
) {
  const evidence = artifactPushDryRunEvidence(job, step, plan, sshProfile, { failOnTemplateArtifact: true });
  const commandKind = adminCommandKind(step.command);
  const executableRemoteCommand = executableAdminRemoteCommandKind(commandKind);
  return {
    ...evidence,
    dryRun: true,
    mode: 'artifact-push-remote-ssh-plan',
    execution: executableRemoteCommand ? 'planned' : 'skipped',
    boundary: 'remote-ssh-plan-only',
    summaryLines: [
      'artifact-push remote SSH plan: remote command not executed',
      `target=${step.target}`,
      `requiresRoot=${step.requiresRoot ? 'yes' : 'no'}`,
      `timeoutSeconds=${step.timeoutSeconds}`
    ],
    effectiveCommand: applyAdminSshProfile(step.command, sshProfile),
    executionResult: executableRemoteCommand ? {
      exitCode: 0,
      stdout: `plan-only recorded ${commandKind}: remote command was not executed`,
      stderr: ''
    } : undefined,
    planOnly: {
      enabled: true,
      commandExecuted: false,
      remoteMutation: false,
      reason: 'Admin remote SSH plan records the final SSH/rsync/scp command after gates and SSH profile expansion.'
    },
    notes: [
      'This Admin remote SSH plan exercises the remote SSH gate and records final command evidence.',
      'It does not open SSH, run rsync/scp, mutate Domestic, or mutate Oversea.'
    ]
  };
}

function awxShadowEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  provider: AwxProviderConfig | null
) {
  const evidence = artifactPushDryRunEvidence(job, step, plan, sshProfile, { failOnTemplateArtifact: true });
  const commandKind = adminCommandKind(step.command);
  const template = `${provider?.jobTemplatePrefix ?? 'mx-site-slot'}-${job.kind}-worker-v1`;
  const inventory = `${provider?.inventoryPrefix ?? 'mx'}-${job.environment}-${job.kind}`;
  const credential = sshProfile?.profileId
    ?? plan?.ssh.profileId
    ?? `${provider?.credentialPrefix ?? 'mx'}-${job.kind}-${job.siteId}-machine`;
  return {
    ...evidence,
    dryRun: true,
    mode: 'awx-shadow',
    execution: 'shadow-planned',
    boundary: 'awx-api-shadow-no-remote-mutation',
    summaryLines: [
      'AWX shadow: job template launch is recorded but not submitted',
      `target=${step.target}`,
      `requiresRoot=${step.requiresRoot ? 'yes' : 'no'}`,
      `timeoutSeconds=${step.timeoutSeconds}`
    ],
    awx: {
      provider: 'awx-shadow',
      providerId: provider?.providerId ?? null,
      providerStatus: provider?.status ?? 'env-default',
      providerWarnings: provider?.warnings ?? [],
      organization: provider?.organization ?? process.env.AWX_ORGANIZATION ?? 'MX Internal',
      baseUrl: provider?.baseUrl ?? process.env.AWX_BASE_URL ?? null,
      inventory,
      inventoryHost: job.siteId,
      credential,
      project: provider?.project ?? process.env.AWX_PROJECT ?? 'mx-launcher-site-slots',
      jobTemplate: template,
      verifyTls: provider?.verifyTls ?? true,
      requestTimeoutSeconds: provider?.requestTimeoutSeconds ?? 30,
      launchMode: 'shadow-only',
      request: {
        extraVars: {
          mx_plan_id: job.planId,
          mx_job_id: job.jobId,
          mx_site_id: job.siteId,
          mx_site_kind: job.kind,
          mx_step_id: step.stepId,
          mx_source_id: step.sourceId,
          mx_command_kind: commandKind
        },
        limit: job.siteId,
        diffMode: true,
        checkMode: true
      },
      event: {
        counter: step.order,
        event: 'runner_on_ok',
        task: step.sourceId,
        host: job.siteId,
        stdout: `awx shadow recorded ${commandKind}; no AWX job was launched`
      }
    },
    executionResult: {
      exitCode: 0,
      stdout: `awx shadow planned ${template} for ${job.siteId}`,
      stderr: ''
    },
    notes: [
      'This Admin action maps MX worker steps to AWX inventory, credential, job template, and task event evidence.',
      'It does not call the AWX API, open SSH, run rsync/scp, mutate Domestic, or mutate Oversea.',
      'The next provider phase can replace launchMode=shadow-only with an AWX API launch and stream job events back into this report shape.'
    ]
  };
}

function adminRemoteSshPlanResult(
  job: SiteSlotWorkerJob,
  gate: ReturnType<typeof buildSiteSlotRemoteSshGate>,
  confirmPlanOnly: boolean
) {
  const blockedReasons = [
    ...(gate.verdict === 'passed' ? [] : gate.gateFailures),
    ...(!confirmPlanOnly ? ['confirmPlanOnly=true is required before recording remote SSH plan evidence'] : [])
  ];
  return {
    remoteSshPlanId: `artifact_push_remote_ssh_plan_${job.jobId}`,
    status: blockedReasons.length > 0 ? 'blocked' : 'ready',
    execution: 'not-started',
    boundary: 'admin-remote-ssh-plan-only',
    mode: 'artifact-push-remote-ssh-plan',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    blockedReasons,
    notes: [
      'This Admin action records a worker report containing final remote command evidence only after the remote SSH gate passes.',
      'It does not open SSH or mutate Domestic/Oversea.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-remote-ssh-gates', 'rerun-remote-ssh-plan-after-gate']
      : ['record-remote-ssh-plan-worker-report', 'review-evidence-drawer']
  };
}

function adminDomesticRelayPeerPlanResult(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  input = domesticRelayPeerInput(body)
) {
  const blockedReasons = domesticRelayPeerPlanFailures(job, plan, body, input);
  return {
    relayPeerPlanId: `domestic_relay_peer_plan_${job.jobId}`,
    status: blockedReasons.length > 0 ? 'blocked' as const : 'ready' as const,
    execution: 'not-started',
    boundary: 'admin-domestic-relay-peer-plan-only',
    mode: 'domestic-relay-peer-plan',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    homePeer: domesticRelayPeerHomePeer(input),
    domesticRelay: {
      interfaceName: 'mx-domestic',
      listenPort: 51280,
      gatewayIp: '10.88.0.1',
      endpointHost: plan?.host ?? null
    },
    internalServicePeer: {
      fixedIp: '10.88.88.88',
      privateKeyPlacement: 'internal-only',
      privateKeyCopiedToDomestic: false
    },
    blockedReasons,
    notes: [
      'This Admin action records a plan-only worker report for appending a Home peer to the Domestic relay.',
      'It does not open SSH, call AWX, run wg, write /etc/wireguard, or mutate Domestic.',
      'Use it after Home enroll submits a WireGuard public key and before enabling real Domestic peer append execution.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-relay-peer-plan-input', 'rerun-domestic-relay-peer-plan']
      : ['record-relay-peer-plan-worker-report', 'review-evidence-drawer', 'prepare-readonly-wg-probe']
  };
}

function adminDomesticRelayReadOnlyProbeResult(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  secret: SiteSlotDomesticWireGuardSecret | null = null
) {
  const blockedReasons = domesticRelayReadOnlyProbeFailures(job, plan, body);
  return {
    probeId: `domestic_relay_readonly_probe_${job.jobId}`,
    status: blockedReasons.length > 0 ? 'blocked' as const : 'ready' as const,
    execution: 'not-started',
    boundary: 'readonly-ssh-handoff-only',
    mode: 'domestic-relay-readonly-probe',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    cwd: resolveMxLauncherRoot(),
    command: domesticRelayReadOnlyProbeCommand(plan, secret),
    env: {
      SITE_SLOT_READONLY_PROBE: '1',
      SITE_SLOT_DOMESTIC_RELAY_PROBE: '1',
      SITE_SLOT_SSH_PROFILE_ID: plan?.ssh.profileId ?? null
    },
    domesticRelay: {
      siteId: plan?.siteId ?? job.siteId,
      endpointHost: plan?.host ?? null,
      interfaceName: 'mx-domestic',
      listenPort: 51280,
      gatewayIp: '10.88.0.1',
      configPath: '/etc/wireguard/mx-domestic.conf',
      unit: 'wg-quick@mx-domestic'
    },
    readOnlyProbe: {
      commandExecuted: false,
      remoteMutation: false,
      checks: [
        'test -f /etc/wireguard/mx-domestic.conf',
        'test ! -f /etc/wireguard/mx-internal-service-peer.conf',
        'wg show mx-domestic',
        'wg show mx-domestic endpoints',
        'wg show mx-domestic latest-handshakes',
        'ip -4 address show dev mx-domestic',
        'mx-domestic has 10.88.0.1/16',
        'ip route get 10.88.88.88',
        'curl/wget http://10.88.88.88:18090/healthz',
        'systemctl status wg-quick@mx-domestic --no-pager'
      ]
    },
    h2iGate: {
      internalServiceIp: secret?.internalServiceIp ?? '10.88.88.88',
      internalServicePublicKey: secret?.internalServicePublicKey ? 'configured' : 'missing',
      requiresLatestHandshake: true,
      requiresInternalHealthz: true
    },
    gates: {
      confirmRelayReadOnlyProbe: booleanValue(body.confirmRelayReadOnlyProbe) === true,
      domesticOnly: true,
      remoteMutationAllowed: false,
      internalPrivateKeyMustNotExistOnDomestic: true
    },
    blockedReasons,
    notes: [
      'This Admin action returns a read-only SSH handoff command for Domestic relay status checks.',
      'It does not open SSH, run the command, write /etc/wireguard, append peers, or restart services.',
      'The probe fails if /etc/wireguard/mx-internal-service-peer.conf exists on Domestic.',
      'H2I is only ready after the Internal service peer has a latest handshake and Domestic can reach Internal healthz.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-domestic-relay-readonly-probe-gates', 'rerun-domestic-relay-readonly-probe']
      : ['run-readonly-probe-from-internal', 'review-wg-show-output', 'prepare-gated-peer-append']
  };
}

function adminDomesticRelayPeerAppendResult(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  input = domesticRelayPeerInput(body)
) {
  const blockedReasons = domesticRelayPeerAppendFailures(job, plan, body, input);
  return {
    appendId: `domestic_relay_peer_append_${job.jobId}`,
    status: blockedReasons.length > 0 ? 'blocked' as const : 'ready' as const,
    execution: 'not-started',
    boundary: 'gated-ssh-handoff-only',
    mode: 'domestic-relay-peer-append',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    cwd: resolveMxLauncherRoot(),
    command: domesticRelayPeerAppendCommand(plan, input),
    env: {
      SITE_SLOT_DOMESTIC_RELAY_APPEND: '1',
      SITE_SLOT_CONFIRM_RELAY_PEER_APPEND: '1',
      SITE_SLOT_SSH_PROFILE_ID: plan?.ssh.profileId ?? null
    },
    domesticRelay: {
      siteId: plan?.siteId ?? job.siteId,
      endpointHost: plan?.host ?? null,
      interfaceName: 'mx-domestic',
      listenPort: 51280,
      gatewayIp: '10.88.0.1',
      configPath: '/etc/wireguard/mx-domestic.conf',
      unit: 'wg-quick@mx-domestic'
    },
    homePeer: domesticRelayPeerHomePeer(input),
    handoff: {
      commandExecuted: false,
      remoteMutation: true,
      mutation: 'wg-set-peer-allowed-ips',
      reason: 'Admin returns the gated command only; Internal operator, SSH worker, or AWX must execute it after approval.'
    },
    gates: {
      confirmRelayPeerAppend: booleanValue(body.confirmRelayPeerAppend) === true,
      confirmRelayReadOnlyProbeReviewed: booleanValue(body.confirmRelayReadOnlyProbeReviewed) === true,
      confirmRelayPeerPlanReviewed: booleanValue(body.confirmRelayPeerPlanReviewed) === true,
      publicKeyRequired: true,
      leaseIpMustBe10x: true,
      domesticOnly: true,
      remoteMutationAllowedAfterHandoff: true,
      internalPrivateKeyMustNotExistOnDomestic: true
    },
    blockedReasons,
    notes: [
      'This Admin action returns a gated SSH handoff command that will append a Home peer when executed.',
      'The Admin API does not open SSH, call AWX, or run wg set.',
      'The command checks that Internal service peer private key material is not present on Domestic before mutating the relay.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-domestic-relay-peer-append-gates', 'review-readonly-probe-and-peer-plan']
      : ['execute-handoff-from-internal-or-awx', 'record-peer-append-evidence', 'run-post-append-readonly-probe']
  };
}

function adminDomesticRelayPeerAppendSshResult(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  gate: ReturnType<typeof buildSiteSlotRemoteSshGate>,
  body: Record<string, unknown>,
  relayPeerAppend: ReturnType<typeof adminDomesticRelayPeerAppendResult>
) {
  const blockedReasons = domesticRelayPeerAppendSshFailures(gate, body, relayPeerAppend, sshProfile);
  return {
    executionId: `domestic_relay_peer_append_ssh_${job.jobId}`,
    status: blockedReasons.length > 0 ? 'blocked' as const : 'ready' as const,
    execution: 'not-started',
    boundary: 'gated-ssh-worker',
    mode: 'domestic-relay-peer-append-ssh',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    command: relayPeerAppend.command,
    env: {
      SITE_SLOT_WORKER_REMOTE_SSH: '1',
      SITE_SLOT_CONFIRM_REMOTE_EXECUTION: '1',
      SITE_SLOT_DOMESTIC_RELAY_APPEND: '1',
      SITE_SLOT_CONFIRM_RELAY_PEER_APPEND_SSH: '1',
      SITE_SLOT_SSH_PROFILE_ID: plan?.ssh.profileId ?? null
    },
    sshProfile: adminSshProfileEvidence(plan, sshProfile),
    handoff: {
      commandExecuted: false,
      remoteMutation: true,
      mutation: 'wg-set-peer-allowed-ips',
      reason: 'Execution starts only when all remote SSH and Domestic relay append gates pass.'
    },
    gates: {
      remoteSshGate: gate.verdict,
      confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
      confirmRelayPeerAppendSsh: booleanValue(body.confirmRelayPeerAppendSsh) === true,
      confirmRelayPeerAppend: relayPeerAppend.gates.confirmRelayPeerAppend,
      confirmRelayReadOnlyProbeReviewed: relayPeerAppend.gates.confirmRelayReadOnlyProbeReviewed,
      confirmRelayPeerPlanReviewed: relayPeerAppend.gates.confirmRelayPeerPlanReviewed,
      environmentRemoteSsh: process.env.SITE_SLOT_WORKER_REMOTE_SSH === '1',
      environmentConfirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === '1'
    },
    blockedReasons,
    notes: [
      'This Admin action is the real SSH executor for Domestic relay peer append.',
      'It records a worker report only after all remote SSH and Domestic relay append gates pass.',
      'The command checks Domestic does not contain Internal service peer private key material before running wg set.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-domestic-relay-peer-append-ssh-gates', 'rerun-readonly-probe-and-peer-plan-review']
      : ['execute-domestic-relay-peer-append-ssh', 'record-post-append-readonly-probe']
  };
}

function adminDomesticRelayPeerAppendSshPrepareResult(
  execution: SiteSlotExecutionRun,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  session: SiteSlotRunnerSession | null = null,
  job: SiteSlotWorkerJob | null = null
) {
  const baseFailures = domesticRelayPeerAppendSshPrepareFailures(execution, plan, body);
  const runnerFailures = session && session.status !== 'queued'
    ? session.warnings.length ? session.warnings : [`remote SSH runner session is ${session.status}`]
    : [];
  const jobFailures = job && job.status !== 'ready'
    ? job.warnings.length ? job.warnings : [`remote SSH worker job is ${job.status}`]
    : [];
  const blockedReasons = uniqueStrings([...baseFailures, ...runnerFailures, ...jobFailures]);
  const status = blockedReasons.length > 0 ? 'blocked' as const : 'ready' as const;
  return {
    prepareId: `domestic_relay_peer_append_ssh_prepare_${execution.runId}`,
    status,
    execution: 'not-started',
    boundary: 'remote-ssh-runner-job-preparation',
    mode: 'domestic-relay-peer-append-ssh-prepare',
    runId: execution.runId,
    planId: execution.planId,
    siteId: execution.siteId,
    kind: execution.kind,
    sessionId: session?.sessionId ?? null,
    jobId: job?.jobId ?? null,
    runner: session ? {
      mode: session.mode,
      status: session.status,
      dryRun: session.dryRun,
      remoteExecutionEnabled: session.gates.remoteExecutionEnabled,
      remoteExecutionConfirmed: session.gates.remoteExecutionConfirmed,
      warnings: session.warnings
    } : null,
    workerJob: job ? {
      mode: job.mode,
      status: job.status,
      workerId: job.worker.workerId,
      workerKind: job.worker.kind,
      approvalStatus: job.approval.status,
      changeWindowStart: job.changeWindow.start,
      changeWindowEnd: job.changeWindow.end,
      rollbackStrategy: job.rollbackPolicy.strategy,
      warnings: job.warnings
    } : null,
    gates: {
      executionAction: execution.action,
      executionStatus: execution.status,
      applyConfirmed: execution.action === 'apply' && execution.confirmApply,
      domesticOnly: execution.kind === 'domestic' && plan?.kind === 'domestic',
      confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
      confirmRelayPeerAppendSshPrepare: booleanValue(body.confirmRelayPeerAppendSshPrepare) === true,
      approvalIdRequired: true,
      changeWindowRequired: true
    },
    blockedReasons,
    notes: [
      'This action prepares a Domestic remote-ssh runner session and worker job for peer append execution.',
      'It does not execute SSH, run wg set, or write a worker report.',
      'Use the returned jobId with site-slot.worker-run.domestic-relay-peer-append-ssh after read-only probe and peer plan evidence are reviewed.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-remote-runner-or-approval-gates', 'rerun-domestic-relay-peer-append-ssh-prepare']
      : ['run-domestic-relay-peer-append-ssh-gate', 'execute-domestic-relay-peer-append-ssh-after-review']
  };
}

function adminDomesticRelayPeerAppendAwxPrepareResult(
  execution: SiteSlotExecutionRun,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  session: SiteSlotRunnerSession | null = null,
  job: SiteSlotWorkerJob | null = null
) {
  const baseFailures = domesticRelayPeerAppendAwxPrepareFailures(execution, plan, body);
  const runnerFailures = session && session.status !== 'queued'
    ? session.warnings.length ? session.warnings : [`AWX runner session is ${session.status}`]
    : [];
  const jobFailures = job && job.status !== 'ready'
    ? job.warnings.length ? job.warnings : [`AWX worker job is ${job.status}`]
    : [];
  const blockedReasons = uniqueStrings([...baseFailures, ...runnerFailures, ...jobFailures]);
  const status = blockedReasons.length > 0 ? 'blocked' as const : 'ready' as const;
  return {
    prepareId: `domestic_relay_peer_append_awx_prepare_${execution.runId}`,
    status,
    execution: 'not-started',
    boundary: 'awx-runner-job-preparation',
    mode: 'domestic-relay-peer-append-awx-prepare',
    runId: execution.runId,
    planId: execution.planId,
    siteId: execution.siteId,
    kind: execution.kind,
    sessionId: session?.sessionId ?? null,
    jobId: job?.jobId ?? null,
    runner: session ? {
      mode: session.mode,
      status: session.status,
      dryRun: session.dryRun,
      remoteExecutionEnabled: session.gates.remoteExecutionEnabled,
      remoteExecutionConfirmed: session.gates.remoteExecutionConfirmed,
      warnings: session.warnings
    } : null,
    workerJob: job ? {
      mode: job.mode,
      status: job.status,
      workerId: job.worker.workerId,
      workerKind: job.worker.kind,
      approvalStatus: job.approval.status,
      changeWindowStart: job.changeWindow.start,
      changeWindowEnd: job.changeWindow.end,
      rollbackStrategy: job.rollbackPolicy.strategy,
      warnings: job.warnings
    } : null,
    gates: {
      executionAction: execution.action,
      executionStatus: execution.status,
      applyConfirmed: execution.action === 'apply' && execution.confirmApply,
      domesticOnly: execution.kind === 'domestic' && plan?.kind === 'domestic',
      confirmAwxLaunchPrepare: booleanValue(body.confirmAwxLaunchPrepare) === true,
      approvalIdOptional: true,
      changeWindowRecorded: Boolean(stringValue(body.changeWindowStart) && stringValue(body.changeWindowEnd))
    },
    blockedReasons,
    notes: [
      'This action prepares a Domestic AWX runner session and AWX worker job for relay peer append execution.',
      'It does not call AWX launch, open SSH, run wg set, or write a worker report.',
      'Use the returned jobId with Domestic read-only probe and peer append handoff first, then site-slot.worker-run.awx-sync-plan, site-slot.worker-run.awx-credential-sync, site-slot.worker-run.awx-object-sync, and site-slot.worker-run.awx-launch.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-awx-prepare-gates', 'rerun-domestic-relay-peer-append-awx-prepare']
      : ['run-domestic-relay-readonly-probe', 'review-domestic-relay-peer-append-handoff', 'plan-awx-object-sync', 'sync-awx-credential', 'sync-awx-objects', 'launch-awx-job-after-review']
  };
}

function domesticRelayPeerAppendAwxPrepareFailures(
  execution: SiteSlotExecutionRun,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>
): string[] {
  return [
    ...(execution.kind === 'domestic' ? [] : [`Domestic relay peer append AWX prepare requires a domestic execution, got ${execution.kind}`]),
    ...(execution.action === 'apply' ? [] : [`Domestic relay peer append AWX prepare requires an apply execution, got ${execution.action}`]),
    ...(execution.status === 'ready' ? [] : [`execution must be ready before Domestic relay peer append AWX prepare, got ${execution.status}`]),
    ...(execution.confirmApply ? [] : ['apply execution must be confirmed before Domestic relay peer append AWX prepare']),
    ...(plan ? [] : ['plan not found while preparing Domestic relay peer append AWX job']),
    ...(plan && plan.kind !== 'domestic' ? [`Domestic relay peer append AWX prepare requires a domestic plan, got ${plan.kind}`] : []),
    ...(booleanValue(body.confirmAwxLaunchPrepare) === true
      ? []
      : ['confirmAwxLaunchPrepare=true is required before creating Domestic relay append AWX job'])
  ];
}

function domesticRelayPeerAppendSshPrepareFailures(
  execution: SiteSlotExecutionRun,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>
): string[] {
  return [
    ...(execution.kind === 'domestic' ? [] : [`Domestic relay peer append prepare requires a domestic execution, got ${execution.kind}`]),
    ...(execution.action === 'apply' ? [] : [`Domestic relay peer append prepare requires an apply execution, got ${execution.action}`]),
    ...(execution.status === 'ready' ? [] : [`execution must be ready before Domestic relay peer append prepare, got ${execution.status}`]),
    ...(execution.confirmApply ? [] : ['apply execution must be confirmed before Domestic relay peer append prepare']),
    ...(plan ? [] : ['plan not found while preparing Domestic relay peer append SSH job']),
    ...(plan && plan.kind !== 'domestic' ? [`Domestic relay peer append prepare requires a domestic plan, got ${plan.kind}`] : []),
    ...(plan ? domesticRemoteSshReadinessFailures(plan) : []),
    ...(booleanValue(body.confirmRemoteExecution) === true
      ? []
      : ['confirmRemoteExecution=true is required before preparing Domestic relay peer append SSH job']),
    ...(booleanValue(body.confirmRelayPeerAppendSshPrepare) === true
      ? []
      : ['confirmRelayPeerAppendSshPrepare=true is required before creating Domestic relay append remote-ssh job']),
    ...(stringValue(body.approvalId) ? [] : ['approvalId is required before creating Domestic relay append remote-ssh job']),
    ...(stringValue(body.changeWindowStart) ? [] : ['changeWindowStart is required before creating Domestic relay append remote-ssh job']),
    ...(stringValue(body.changeWindowEnd) ? [] : ['changeWindowEnd is required before creating Domestic relay append remote-ssh job'])
  ];
}

function domesticRemoteSshReadinessFailures(plan: SiteSlotPlan): string[] {
  const profileWarnings = Array.isArray(plan.ssh?.profileWarnings) ? plan.ssh.profileWarnings : [];
  return [
    ...(plan.ssh?.profileId ? [] : ['link an Internal-managed SSH Profile before queueing Domestic Remote SSH']),
    ...(plan.host ? [] : ['set the Domestic host before queueing Domestic Remote SSH']),
    ...(plan.ssh?.profileStatus === 'paused' ? ['managed SSH Profile is paused'] : []),
    ...(domesticWireGuardArtifactReady() ? [] : ['materialize Internal WG secret/artifacts before queueing Domestic Remote SSH']),
    ...profileWarnings.map((warning) => `SSH Profile warning: ${warning}`)
  ];
}

function buildAdminDomesticWireGuardSecretInput(
  siteId: string,
  plan: SiteSlotPlan | null,
  previous: SiteSlotDomesticWireGuardSecret | null,
  body: Record<string, unknown>,
  requestedBy: string,
  requestId: string | null
) {
  const rotateAll = booleanValue(body.rotateKey) || booleanValue(body.rotateAll);
  const rotateRelayKey = rotateAll || booleanValue(body.rotateRelayKey);
  const rotateInternalServiceKey = rotateAll || booleanValue(body.rotateInternalServiceKey);
  const confirmRotate = booleanValue(body.confirmRotate);
  const listenPort = numberValueOrNull(body.listenPort) ?? previous?.listenPort ?? 51280;
  const planEndpoint = endpointFromPlanHost(plan, listenPort);
  const explicitEndpoint = stringValue(body.publicEndpoint) ?? stringValue(body.endpoint);
  const previousEndpoint = previous?.publicEndpoint;
  const publicEndpoint = explicitEndpoint
    ?? planEndpoint
    ?? previousEndpoint
    ?? null;
  const internalDirectEndpoint = stringValue(body.internalDirectEndpoint) ?? previous?.internalDirectEndpoint ?? null;
  const internalDirectEnabled = booleanValue(body.internalDirectEnabled) ?? previous?.internalDirectEnabled ?? true;
  const relayMissing = !validWireGuardPrivateKey(previous?.domesticRelayPrivateKey)
    || !validWireGuardPublicKey(previous?.domesticRelayPublicKey);
  const internalMissing = !validWireGuardPrivateKey(previous?.internalServicePrivateKey)
    || !validWireGuardPublicKey(previous?.internalServicePublicKey);
  const relayPair = relayMissing || rotateRelayKey ? generateWireGuardKeyPair() : null;
  const internalPair = internalMissing || rotateInternalServiceKey ? generateWireGuardKeyPair() : null;
  const secretInput: SiteSlotDomesticWireGuardSecretInput = {
    siteId,
    status: stringValue(body.status) ?? previous?.status ?? 'active',
    publicEndpoint,
    listenPort,
    internalDirectEnabled,
    internalDirectEndpoint,
    internalDirectListenPort: numberValueOrNull(body.internalDirectListenPort) ?? previous?.internalDirectListenPort ?? 51280,
    domesticGatewayIp: stringValue(body.domesticGatewayIp) ?? previous?.domesticGatewayIp ?? '10.88.0.1',
    domesticGatewayCidr: stringValue(body.domesticGatewayCidr) ?? previous?.domesticGatewayCidr ?? '10.88.0.0/16',
    productRelayCidrs: cidrListValue(body.productRelayCidrs) ?? previous?.productRelayCidrs ?? ['10.89.0.0/16', '10.90.0.0/16'],
    userRelayCidr: stringValue(body.userRelayCidr) ?? previous?.userRelayCidr ?? '10.89.0.0/16',
    internalServiceIp: stringValue(body.internalServiceIp) ?? previous?.internalServiceIp ?? '10.88.88.88',
    internalServiceCidr: stringValue(body.internalServiceCidr) ?? previous?.internalServiceCidr ?? '10.88.0.0/16',
    guestRelayCidr: stringValue(body.guestRelayCidr) ?? previous?.guestRelayCidr ?? '10.90.0.0/16',
    domesticRelayPrivateKey: relayPair?.privateKey ?? previous?.domesticRelayPrivateKey ?? null,
    domesticRelayPublicKey: relayPair?.publicKey ?? previous?.domesticRelayPublicKey ?? null,
    internalServicePrivateKey: internalPair?.privateKey ?? previous?.internalServicePrivateKey ?? null,
    internalServicePublicKey: internalPair?.publicKey ?? previous?.internalServicePublicKey ?? null,
    requestedBy,
    requestId
  };
  return {
    secretInput,
    generated: {
      domesticRelayKeyPair: Boolean(relayPair),
      internalServiceKeyPair: Boolean(internalPair)
    },
    rotate: {
      domesticRelayKeyPair: rotateRelayKey,
      internalServiceKeyPair: rotateInternalServiceKey
    },
    endpointChanged: Boolean(previous && publicEndpoint && previous.publicEndpoint !== publicEndpoint),
    previousMaterialDigest: previous?.fingerprints.materialDigest ?? null,
    blockedReasons: [
      ...(rotateRelayKey || rotateInternalServiceKey ? confirmRotate ? [] : ['confirmRotate=true is required before rotating Domestic WG keys'] : []),
      ...(publicEndpoint ? [] : ['publicEndpoint is required before materializing Domestic WG']),
      ...(publicEndpoint && domesticRelayEndpointBlockedReason(publicEndpoint) ? [domesticRelayEndpointBlockedReason(publicEndpoint) as string] : [])
    ]
  };
}

function endpointFromPlanHost(plan: SiteSlotPlan | null, listenPort: number): string | null {
  const host = plan?.host?.trim();
  if (!host) return null;
  return /:\d+$/.test(host) ? host : `${host}:${listenPort}`;
}

function domesticRelayEndpointBlockedReason(endpoint: string | null | undefined): string | null {
  const value = endpoint?.trim();
  if (!value) return 'Domestic public endpoint is missing';
  const host = value.replace(/^\[/, '').replace(/\]?:\d+$/, '').toLowerCase();
  if (!host || host === 'host') return `Domestic public endpoint is a placeholder: ${value}`;
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) {
    return `Domestic public endpoint must be reachable from the Internal runtime host: ${value}`;
  }
  if (
    host.endsWith('.example.com')
    || host.endsWith('.example.net')
    || host.endsWith('.example.org')
    || host.endsWith('.invalid')
    || host.endsWith('.test')
    || host.endsWith('.localhost')
  ) {
    return `Domestic public endpoint is a non-routable placeholder: ${value}`;
  }
  return null;
}

function domesticWireGuardMaterializerEnv(secret: SiteSlotDomesticWireGuardSecret): Record<string, string> {
  return {
    MX_DOMESTIC_RELAY_PRIVATE_KEY: secret.domesticRelayPrivateKey ?? '',
    MX_DOMESTIC_RELAY_PUBLIC_KEY: secret.domesticRelayPublicKey ?? '',
    MX_INTERNAL_SERVICE_PRIVATE_KEY: secret.internalServicePrivateKey ?? '',
    MX_INTERNAL_SERVICE_PUBLIC_KEY: secret.internalServicePublicKey ?? '',
    MX_DOMESTIC_PUBLIC_ENDPOINT: secret.publicEndpoint ?? '',
    MX_INTERNAL_DIRECT_ENABLED: secret.internalDirectEnabled ? '1' : '0',
    MX_INTERNAL_DIRECT_ENDPOINT: secret.internalDirectEndpoint ?? '',
    MX_INTERNAL_DIRECT_LISTEN_PORT: String(secret.internalDirectListenPort),
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

function adminDomesticWireGuardMaterializeResult(
  siteId: string,
  secret: SiteSlotDomesticWireGuardSecret | null,
  input: ReturnType<typeof buildAdminDomesticWireGuardSecretInput>,
  artifacts: {
    execution: { exitCode: number; stdout: string; stderr: string } | null;
    manifest: ReturnType<typeof readArtifactManifest> | null;
    module: NonNullable<ReturnType<typeof readArtifactManifest>>['modules'][number] | null;
  } | null,
  blockedReasons: string[]
) {
  const status = blockedReasons.length ? 'blocked' : 'passed';
  return {
    materializeId: `domestic_wg_materialize_${siteId}`,
    status,
    execution: artifacts?.execution ? artifacts.execution.exitCode === 0 ? 'completed' : 'failed' : blockedReasons.length ? 'blocked' : 'not-started',
    boundary: 'internal-domestic-wg-secret-materialize',
    siteId,
    secretId: secret?.secretId ?? null,
    publicEndpoint: secret?.publicEndpoint ?? input.secretInput.publicEndpoint ?? null,
    rotate: input.rotate,
    generated: input.generated,
    endpointChanged: input.endpointChanged,
    previousMaterialDigest: input.previousMaterialDigest,
    materialDigest: secret?.fingerprints.materialDigest ?? null,
    clientRefresh: {
      mode: 'snapshot-digest',
      changed: Boolean(secret && input.previousMaterialDigest !== secret.fingerprints.materialDigest),
      previousMaterialDigest: input.previousMaterialDigest,
      materialDigest: secret?.fingerprints.materialDigest ?? null
    },
    fingerprints: secret?.fingerprints ?? null,
    relay: secret ? {
      domesticGatewayIp: secret.domesticGatewayIp,
      domesticGatewayCidr: secret.domesticGatewayCidr,
      productRelayCidrs: domesticSecretProductRelayCidrs(secret),
      userRelayCidr: secret.userRelayCidr,
      internalServiceIp: secret.internalServiceIp,
      internalServiceCidr: secret.internalServiceCidr,
      guestRelayCidr: secret.guestRelayCidr
    } : null,
    artifact: artifacts?.module ? {
      moduleId: artifacts.module.moduleId,
      status: artifacts.module.status,
      targetPath: artifacts.module.targetPath,
      sha256: artifacts.module.sha256,
      manifestPath: artifacts.manifest?.path ?? null,
      releaseRevision: artifacts.manifest?.releaseRevision ?? null,
      metadata: artifacts.module.metadata
    } : null,
    stdout: artifacts?.execution?.stdout?.slice(-4000) ?? null,
    stderr: artifacts?.execution?.stderr?.slice(-4000) ?? null,
    blockedReasons,
    nextActions: status === 'passed'
      ? ['join-internal-service-peer', 'run-domestic-relay-readonly-probe', 'publish-config-snapshot-for-client-refresh']
      : ['fix-domestic-wg-materialize-inputs']
  };
}

function adminInternalServicePeerHandoffResult(
  siteId: string,
  plan: SiteSlotPlan | null,
  secret: SiteSlotDomesticWireGuardSecret | null,
  body: Record<string, unknown>
) {
  const paths = internalServicePeerArtifactPaths();
  const blockedReasons = internalServicePeerHandoffFailures(siteId, secret, paths, body, plan);
  const status = blockedReasons.length ? 'blocked' : 'ready';
  return {
    handoffId: `internal_service_peer_handoff_${siteId}`,
    status,
    execution: 'not-started',
    boundary: 'internal-service-peer-local-handoff-only',
    siteId,
    planId: plan?.planId ?? stringValue(body.planId) ?? null,
    cwd: resolveMxLauncherRoot(),
    command: internalServicePeerHandoffCommand(paths.applyScriptPath),
    env: {
      MX_INTERNAL_SERVICE_WG_INTERFACE: INTERNAL_SERVICE_PEER_INTERFACE,
      MX_INTERNAL_SERVICE_IP: secret?.internalServiceIp ?? '10.88.88.88',
      MX_DOMESTIC_GATEWAY_IP: secret?.domesticGatewayIp ?? '10.88.0.1'
    },
    config: {
      sourceConfigPath: paths.configPath,
      applyScriptPath: paths.applyScriptPath,
      targetConfigPath: `/etc/wireguard/${INTERNAL_SERVICE_PEER_INTERFACE}.conf`,
      privateKeyPlacement: 'internal-only',
      copiedToDomestic: false
    },
    localHelper: {
      statusCommand: 'bash scripts/manage.sh ops site-slot internal-service-peer-handoff status',
      printCommand: 'bash scripts/manage.sh ops site-slot internal-service-peer-handoff command',
      applyCommand: 'bash scripts/manage.sh ops site-slot internal-service-peer-handoff apply',
      requires: [
        'qp-tunnel-cli egress-on on the Internal runtime host for H2O/outbound bootstrap',
        'qp-tunnel-cli with @qpjoy/electron-core-wireguard on the Internal runtime host',
        'sudo privilege on the Internal runtime host'
      ],
      macosNote: 'macOS local dev validates @qpjoy/electron-core-wireguard for WG; qp-tunnel-cli egress-on is a Linux systemd server mode for Ubuntu production hosts.'
    },
    relay: secret ? {
      publicEndpoint: secret.publicEndpoint,
      listenPort: secret.listenPort,
      domesticGatewayIp: secret.domesticGatewayIp,
      domesticGatewayCidr: secret.domesticGatewayCidr,
      internalServiceIp: secret.internalServiceIp,
      internalServiceCidr: secret.internalServiceCidr,
      productRelayCidrs: domesticSecretProductRelayCidrs(secret)
    } : null,
    gates: {
      confirmInternalServicePeerHandoff: booleanValue(body.confirmInternalServicePeerHandoff) === true,
      internalOnly: true,
      remoteMutationAllowed: false,
      domesticRelayPrivateKeyCopiedToInternal: false,
      internalPrivateKeyMustNotMoveToDomestic: true
    },
    checks: [
      `install /etc/wireguard/${INTERNAL_SERVICE_PEER_INTERFACE}.conf on the Internal runtime host`,
      `systemctl restart wg-quick@${INTERNAL_SERVICE_PEER_INTERFACE}`,
      `wg show ${INTERNAL_SERVICE_PEER_INTERFACE} latest-handshakes`,
      'ip route get 10.88.0.1',
      'then run Domestic Relay Readonly Probe to verify Domestic -> 10.88.88.88 healthz'
    ],
    blockedReasons,
    notes: [
      'This Admin action returns a local Internal handoff command; the API does not run sudo, wg, systemctl, or mutate the host.',
      'The Internal peer config is rendered from the selected Domestic WG secret and synced to the Internal host runner before status/apply.',
      'If the API runs in a container, /app/artifacts is the container path; use scripts/manage.sh on the actual Internal runtime host or copy the artifact there first.',
      'Domestic should never receive mx-internal-service-peer.conf because it contains the Internal service private key.'
    ],
    nextActions: status === 'ready'
      ? ['execute-on-internal-runtime-host', 'run-domestic-relay-readonly-probe', 'verify-latest-handshake-and-healthz']
      : ['materialize-domestic-wg', 'fix-internal-service-peer-handoff-inputs']
  };
}

function internalServicePeerArtifactPaths() {
  const domesticArtifactRoot = resolve(resolveSiteSlotArtifactBaseDir(), 'domestic');
  return {
    artifactRoot: domesticArtifactRoot,
    configPath: resolve(domesticArtifactRoot, `${INTERNAL_SERVICE_PEER_ID}.conf`),
    applyScriptPath: resolve(domesticArtifactRoot, `${INTERNAL_SERVICE_PEER_ID}-apply.sh`),
    internalEgressSubscriptionPath: resolve(domesticArtifactRoot, 'mx-internal-egress-subscription.yaml')
  };
}

function internalServicePeerRouteCommands(prefix: 'PostUp' | 'PostDown', cidrs: string[], ignoreFailure = false): string[] {
  return cidrs.map((cidr) => {
    const command = prefix === 'PostDown'
      ? `ip route del ${cidr} dev %i`
      : `ip route replace ${cidr} dev %i`;
    return `${prefix} = ${ignoreFailure ? `${command} || true` : command}`;
  });
}

function internalServicePeerApplyScriptContent(): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    `IFACE="\${MX_INTERNAL_SERVICE_WG_INTERFACE:-${INTERNAL_SERVICE_PEER_INTERFACE}}"`,
    'CONFIG_SOURCE="${1:-$SCRIPT_DIR/mx-internal-service-peer.conf}"',
    'TARGET="/etc/wireguard/${IFACE}.conf"',
    'OS_NAME="$(uname -s)"',
    '',
    'if [ "${#IFACE}" -gt 15 ]; then',
    '  echo "blocked: WireGuard interface name must be 15 characters or fewer: $IFACE" >&2',
    '  exit 1',
    'fi',
    '',
    'if [ ! -f "$CONFIG_SOURCE" ]; then',
    '  echo "blocked: Internal service peer config not found: $CONFIG_SOURCE" >&2',
    '  exit 1',
    'fi',
    '',
    'PRIVATE_KEY="$(awk \'/^[[:space:]]*PrivateKey[[:space:]]*=/{sub(/^[^=]*=/, ""); print; exit}\' "$CONFIG_SOURCE" | sed \'s/^[[:space:]]*//;s/[[:space:]]*$//\')"',
    'if printf "%s" "$PRIVATE_KEY" | grep -q "[<>]"; then',
    '  echo "blocked: Internal service peer config still contains a placeholder private key: $CONFIG_SOURCE" >&2',
    '  exit 1',
    'fi',
    'if ! printf "%s" "$PRIVATE_KEY" | grep -Eq "^[A-Za-z0-9+/]{43}=$"; then',
    '  echo "blocked: Internal service peer private key is missing or invalid: $CONFIG_SOURCE" >&2',
    '  exit 1',
    'fi',
    '',
    'install -d -m 700 /etc/wireguard',
    '',
    'internal_route_cidrs() {',
    '  awk \'BEGIN { in_peer=0 } /^\\[Peer\\]/ { in_peer=1; next } /^\\[/ { in_peer=0 } in_peer && /^[[:space:]]*AllowedIPs[[:space:]]*=/ { sub(/^[^=]+=/, ""); print }\' "$CONFIG_SOURCE" \\',
    '    | tr "," "\\n" \\',
    '    | sed "s/^[[:space:]]*//;s/[[:space:]]*$//" \\',
    '    | grep -E "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/[0-9]+$" \\',
    '    | sort -u',
    '}',
    '',
    'if [ "$OS_NAME" = "Darwin" ]; then',
    '  awk \'!/^[[:space:]]*Post(Up|Down)[[:space:]]*=[[:space:]]*ip route / { print }\' "$CONFIG_SOURCE" > "$TARGET"',
    '  chmod 600 "$TARGET"',
    '  wg-quick down "$TARGET" >/dev/null 2>&1 || wg-quick down "$IFACE" >/dev/null 2>&1 || true',
    '  wg-quick up "$TARGET"',
    '  REAL_IFACE="$(route -n get 10.88.0.1 2>/dev/null | awk \'/interface:/{print $2; exit}\')"',
    '  if [ -z "$REAL_IFACE" ]; then',
    '    echo "blocked: unable to resolve Darwin WireGuard utun for 10.88.0.1" >&2',
    '    exit 1',
    '  fi',
    '  while IFS= read -r cidr; do',
    '    [ -n "$cidr" ] || continue',
    '    route -q -n delete -net "$cidr" >/dev/null 2>&1 || true',
    '    route -q -n add -net "$cidr" -interface "$REAL_IFACE" >/dev/null 2>&1 || route -q -n change -net "$cidr" -interface "$REAL_IFACE"',
    '  done < <(internal_route_cidrs)',
    '  wg show "$REAL_IFACE" || wg show "$IFACE" || true',
    '  route -n get 10.88.0.1 || true',
    '  route -n get 10.89.100.1 || true',
    '  exit 0',
    'fi',
    '',
    'install -m 600 -o root -g root "$CONFIG_SOURCE" "$TARGET"',
    '',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl enable --now "wg-quick@${IFACE}"',
    '  systemctl restart "wg-quick@${IFACE}"',
    'else',
    '  wg-quick down "$IFACE" >/dev/null 2>&1 || true',
    '  wg-quick up "$IFACE"',
    'fi',
    '',
    'wg show "$IFACE"',
    'wg show "$IFACE" latest-handshakes || true',
    'ip route get 10.88.0.1 || true',
    ''
  ].join('\n');
}

function internalServicePeerRenderedArtifacts(secret: SiteSlotDomesticWireGuardSecret | null): {
  configContent: string;
  applyScriptContent: string;
} | null {
  if (!secret?.internalServicePrivateKey || !secret.domesticRelayPublicKey || !secret.publicEndpoint) return null;
  const productRelayCidrs = domesticSecretProductRelayCidrs(secret);
  const internalRouteCidrs = uniqueStrings([`${secret.domesticGatewayIp}/32`, secret.domesticGatewayCidr, ...productRelayCidrs]);
  const internalServiceAllowedIps = domesticInternalServicePeerAllowedIps(secret);
  const configContent = [
    '# MX Internal service peer generated by MX Launcher.',
    '# Apply inside Internal runtime so Internal can reach Domestic relay without public ingress.',
    '[Interface]',
    `Address = ${internalServiceAllowedIps.join(', ')}`,
    `PrivateKey = ${secret.internalServicePrivateKey}`,
    ...(secret.internalDirectEnabled ? [`ListenPort = ${secret.internalDirectListenPort}`] : []),
    '# DNS is managed by Internal DNS/CoreDNS; keep wg-quick from mutating host resolv.conf.',
    'Table = off',
    ...internalServicePeerRouteCommands('PostUp', internalRouteCidrs),
    ...internalServicePeerRouteCommands('PostDown', internalRouteCidrs, true),
    '',
    '[Peer]',
    `PublicKey = ${secret.domesticRelayPublicKey}`,
    `Endpoint = ${secret.publicEndpoint}`,
    `AllowedIPs = ${internalRouteCidrs.join(',')}`,
    'PersistentKeepalive = 25',
    ''
  ].join('\n');
  return {
    configContent,
    applyScriptContent: internalServicePeerApplyScriptContent()
  };
}

function internalServicePeerHostRunnerUrl(): string | null {
  return internalServicePeerHostRunnerUrlCandidates()[0] ?? null;
}

function internalServicePeerHostRunnerUrlCandidates(): string[] {
  return uniqueStrings([
    internalServicePeerNativeHostRunnerUrl(),
    explicitInternalServicePeerHostRunnerUrl(),
    internalServicePeerK8sHostRunnerFallbackEnabled() ? internalServicePeerK8sHostRunnerUrl() : null
  ].filter((item): item is string => Boolean(item)));
}

function explicitInternalServicePeerHostRunnerUrl(): string | null {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_URL ?? process.env.MX_INTERNAL_SERVICE_PEER_HOST_RUNNER_URL;
  return raw?.trim() ? raw.trim().replace(/\/+$/, '') : null;
}

function internalServicePeerNativeHostRunnerUrl(): string | null {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_NATIVE_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  if (!process.env.KUBERNETES_SERVICE_HOST) return null;
  const port = internalServicePeerK8sHostRunnerPort();
  return `http://host.docker.internal:${port}`;
}

function internalServicePeerK8sHostRunnerFallbackEnabled(): boolean {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_K8S_FALLBACK_ENABLED;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function internalServicePeerK8sHostRunnerNamespace(): string {
  return process.env.MX_INTERNAL_HOST_RUNNER_K8S_NAMESPACE?.trim()
    || process.env.POD_NAMESPACE?.trim()
    || 'mx-internal-shadow';
}

function internalServicePeerK8sHostRunnerName(): string {
  return process.env.MX_INTERNAL_HOST_RUNNER_K8S_NAME?.trim() || 'mx-internal-host-runner';
}

function internalServicePeerK8sHostRunnerPort(): number {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_PORT?.trim()
    || process.env.MX_INTERNAL_HOST_RUNNER_K8S_PORT?.trim()
    || '19190';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 19190;
}

function internalServicePeerK8sHostRunnerUrl(): string | null {
  if (!process.env.KUBERNETES_SERVICE_HOST) return null;
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_K8S_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  const name = internalServicePeerK8sHostRunnerName();
  const namespace = internalServicePeerK8sHostRunnerNamespace();
  const port = internalServicePeerK8sHostRunnerPort();
  return `http://${name}.${namespace}.svc.cluster.local:${port}`;
}

function internalServicePeerHostRunnerEnsureEnabled(): boolean {
  const raw = process.env.MX_INTERNAL_HOST_RUNNER_K8S_ENSURE_ENABLED;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function internalServicePeerK8sHostRunnerEnsureAvailable(): boolean {
  return internalServicePeerHostRunnerEnsureEnabled() && internalServicePeerK8sHostRunnerFallbackEnabled();
}

function internalServicePeerNativeHostRunnerInstallCommand(): string {
  return 'bash scripts/manage.sh ops site-slot native-host-runner install 19190';
}

function internalServicePeerNativeHostRunnerStartCommand(): string {
  return 'bash scripts/manage.sh ops site-slot native-host-runner start 19190';
}

function internalServicePeerNativeHostRunnerStatusCommand(): string {
  return 'bash scripts/manage.sh ops site-slot native-host-runner status 19190';
}

function internalServicePeerLegacyHostRunnerStartCommand(): string {
  return 'MX_INTERNAL_HOST_RUNNER_HOST=0.0.0.0 bash scripts/manage.sh ops site-slot internal-service-peer-host-runner 19190';
}

function internalServicePeerRuntimeTarget(hostRunnerUrl: string | null, hostRunnerError: string | null) {
  const apiInKubernetes = Boolean(process.env.KUBERNETES_SERVICE_HOST);
  const hostRunnerCandidates = internalServicePeerHostRunnerUrlCandidates();
  const nativeUrl = internalServicePeerNativeHostRunnerUrl();
  const k8sUrl = internalServicePeerK8sHostRunnerUrl();
  return {
    mode: hostRunnerUrl && !hostRunnerError ? 'host-runner' : hostRunnerUrl && hostRunnerError ? 'host-runner-unreachable' : apiInKubernetes ? 'api-pod' : 'api-host',
    boundary: apiInKubernetes
      ? 'k8s-api-control-plane-prefers-native-host-runner'
      : 'api-process-local-runtime',
    apiRuntime: {
      hostname: osHostname(),
      platform: osPlatform(),
      release: osRelease(),
      inKubernetes: apiInKubernetes
    },
    hostRunner: {
      configured: Boolean(hostRunnerUrl),
      url: hostRunnerUrl,
      candidates: hostRunnerCandidates,
      error: hostRunnerError,
      preferredTarget: nativeUrl ? 'native-host-runner' : 'api-process',
      installCommand: internalServicePeerNativeHostRunnerInstallCommand(),
      startCommand: internalServicePeerNativeHostRunnerStartCommand(),
      statusCommand: internalServicePeerNativeHostRunnerStatusCommand(),
      legacyForegroundCommand: internalServicePeerLegacyHostRunnerStartCommand(),
      nativeUrlHint: nativeUrl ?? 'http://host.docker.internal:19190',
      k8sUrlHint: k8sUrl,
      k8sFallbackEnabled: internalServicePeerK8sHostRunnerFallbackEnabled(),
      k8sEnsureEnabled: internalServicePeerHostRunnerEnsureEnabled(),
      k8sEnsureAvailable: internalServicePeerK8sHostRunnerEnsureAvailable()
    }
  };
}

function notCheckedTool(command: string) {
  return {
    available: false,
    path: null,
    probe: 'not-checked',
    command
  };
}

function notCheckedCommand(command: string, args: string[] = []) {
  return {
    status: 'not-checked',
    command,
    args,
    exitCode: null,
    stdout: '',
    stderr: '',
    startedAt: null,
    finishedAt: null
  };
}

function adminInternalServicePeerHostRunnerUnavailableStatus(
  siteId: string,
  plan: SiteSlotPlan | null,
  secret: SiteSlotDomesticWireGuardSecret | null,
  paths: ReturnType<typeof internalServicePeerArtifactPaths>,
  hostRunnerUrl: string,
  hostRunnerError: string
) {
  const renderedArtifacts = internalServicePeerRenderedArtifacts(secret);
  const runtimeTarget = internalServicePeerRuntimeTarget(hostRunnerUrl, hostRunnerError);
  const domesticGatewayIp = secret?.domesticGatewayIp ?? '10.88.0.1';
  const internalServiceIp = secret?.internalServiceIp ?? '10.88.88.88';
  const userRelayProbeIp = '10.89.100.1';
  const blockedReasons = [
    'Internal service peer install must run on the Internal runtime host via host-runner',
    `Internal host runner is not reachable: ${hostRunnerError}`
  ];
  return {
    status: 'blocked',
    mode: 'internal-service-peer-host-runner-unreachable',
    siteId,
    planId: plan?.planId ?? null,
    host: {
      hostname: osHostname(),
      platform: osPlatform(),
      release: osRelease()
    },
    interfaceName: INTERNAL_SERVICE_PEER_INTERFACE,
    domesticGatewayIp,
    internalServiceIp,
    runtimeTarget,
    tools: {
      wg: notCheckedTool('wg'),
      wgQuick: notCheckedTool('wg-quick'),
      systemctl: notCheckedTool('systemctl'),
      ip: notCheckedTool('ip'),
      ping: notCheckedTool('ping'),
      qpTunnelCli: notCheckedTool('qp-tunnel-cli')
    },
    artifacts: {
      configPath: paths.configPath,
      configExists: Boolean(renderedArtifacts?.configContent || existsSync(paths.configPath)),
      applyScriptPath: paths.applyScriptPath,
      applyScriptExists: Boolean(renderedArtifacts?.applyScriptContent || existsSync(paths.applyScriptPath)),
      internalEgressSubscriptionPath: paths.internalEgressSubscriptionPath,
      internalEgressSubscriptionExists: existsSync(paths.internalEgressSubscriptionPath)
    },
    internalEgress: {
      status: 'not-checked',
      mode: 'qp-tunnel-cli-egress-on',
      supported: null,
      required: true,
      subscriptionPath: paths.internalEgressSubscriptionPath,
      subscriptionExists: existsSync(paths.internalEgressSubscriptionPath),
      summary: 'host-runner unreachable; Internal qp-tunnel-cli egress-on not checked',
      blockedReasons: []
    },
    interface: {
      name: INTERNAL_SERVICE_PEER_INTERFACE,
      wgShow: notCheckedCommand('wg', ['show', INTERNAL_SERVICE_PEER_INTERFACE]),
      latestHandshakes: notCheckedCommand('wg', ['show', INTERNAL_SERVICE_PEER_INTERFACE, 'latest-handshakes']),
      handshake: {
        status: 'not-checked',
        newest: {
          publicKey: null,
          timestamp: 0,
          at: null
        },
        peers: []
      }
    },
    link: {
      routeToDomestic: notCheckedCommand('route', ['get', domesticGatewayIp]),
      domesticGatewayPing: notCheckedCommand('ping', ['-c', '1', domesticGatewayIp]),
      internalHealthz: {
        status: 'not-checked',
        url: `http://${internalServiceIp}:18090/healthz`,
        httpStatus: null,
        durationMs: null
      },
      serviceVipHealthz: domesticInternalServicePeerServiceVipIps(secret).map((ip) => ({
        status: 'not-checked',
        url: `http://${ip}:18090/healthz`,
        httpStatus: null,
        durationMs: null
      }))
    },
    install: {
      available: false,
      applyCommand: 'bash scripts/manage.sh ops site-slot internal-service-peer-handoff apply',
      hostRunnerCommand: internalServicePeerNativeHostRunnerInstallCommand(),
      requires: [
        'Native Internal host-runner reachable from the Internal API pod',
        'qp-tunnel-cli egress-on on the Internal runtime host for H2O/outbound bootstrap',
        'qp-tunnel-cli with @qpjoy/electron-core-wireguard on the Internal runtime host',
        'sudo/root privilege on the Internal runtime host'
      ],
      blockedReasons
    },
    blockedReasons,
    checkedAt: new Date().toISOString()
  };
}

async function internalServicePeerHostRunnerPayload(
  siteId: string,
  plan: SiteSlotPlan | null,
  secret: SiteSlotDomesticWireGuardSecret | null,
  paths: ReturnType<typeof internalServicePeerArtifactPaths>,
  store: PlatformStore | null = null
) {
  const renderedArtifacts = internalServicePeerRenderedArtifacts(secret);
  const internalEgressSubscriptionContent = readTextFileIfExists(paths.internalEgressSubscriptionPath)
    ?? await internalServicePeerEgressSubscriptionContent(plan, store);
  return {
    siteId,
    planId: plan?.planId ?? null,
    interfaceName: INTERNAL_SERVICE_PEER_INTERFACE,
    domesticGatewayIp: secret?.domesticGatewayIp ?? '10.88.0.1',
    internalServiceIp: secret?.internalServiceIp ?? '10.88.88.88',
    apiRuntime: {
      hostname: osHostname(),
      platform: osPlatform(),
      release: osRelease(),
      inKubernetes: Boolean(process.env.KUBERNETES_SERVICE_HOST)
    },
    artifacts: {
      configPath: paths.configPath,
      configContent: renderedArtifacts?.configContent ?? readTextFileIfExists(paths.configPath),
      applyScriptPath: paths.applyScriptPath,
      applyScriptContent: renderedArtifacts?.applyScriptContent ?? readTextFileIfExists(paths.applyScriptPath),
      internalEgressSubscriptionPath: paths.internalEgressSubscriptionPath,
      internalEgressSubscriptionContent
    }
  };
}

async function internalServicePeerEgressSubscriptionContent(
  plan: SiteSlotPlan | null,
  store: PlatformStore | null
): Promise<string | null> {
  const overseaSiteId = plan?.network.mode === 'oversea-assisted'
    ? plan.network.overseaSiteId?.trim()
    : null;
  if (!overseaSiteId || !store) return null;
  const accounts = await store.listSiteSlotAccessAccounts(overseaSiteId);
  const account = accounts.find((item) => item.role === 'internal')
    ?? accounts.find((item) => item.username.endsWith('-internal'))
    ?? null;
  if (!account) return null;
  const subscription = await store.renderHysteria2MihomoSubscription(overseaSiteId, account.username);
  return subscription?.yaml ?? null;
}

function readTextFileIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

async function postInternalServicePeerHostRunner(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const baseUrls = internalServicePeerHostRunnerUrlCandidates();
  if (baseUrls.length === 0) throw new Error('MX_INTERNAL_HOST_RUNNER_URL is not configured');
  const timeoutMs = path.includes('/apply') ? 180000 : 12000;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.MX_INTERNAL_HOST_RUNNER_TOKEN?.trim();
  if (token) headers['x-mx-host-runner-token'] = token;
  const errors: string[] = [];
  for (const baseUrl of baseUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      let payload: unknown = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${baseUrl}${path}: ${text.slice(0, 500)}`);
      }
      return asRecord(payload);
    } catch (error) {
      errors.push(`${baseUrl}${path} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(errors.join('; '));
}

function internalServicePeerBlockedReasons(status: { blockedReasons?: unknown }): string[] {
  return Array.isArray(status.blockedReasons)
    ? status.blockedReasons.filter((item): item is string => typeof item === 'string')
    : [];
}

function internalServicePeerConfigFileFailures(path: string): string[] {
  const content = readTextFileIfExists(path);
  if (!content) return [];
  const failures: string[] = [];
  const privateKey = content.match(/^\s*PrivateKey\s*=\s*(\S+)\s*$/im)?.[1]?.trim() ?? '';
  if (/<internal-service-private-key-from-internal-secret>|<[^>\n]+>/.test(content)) {
    failures.push(`Internal service peer config still contains template placeholders: ${path}`);
  }
  if (!privateKey) {
    failures.push(`Internal service peer private key is missing: ${path}`);
  } else if (!validWireGuardPrivateKey(privateKey)) {
    failures.push(`Internal service peer private key is not a valid WireGuard key: ${path}`);
  }
  return failures;
}

function internalServicePeerHandoffFailures(
  siteId: string,
  secret: SiteSlotDomesticWireGuardSecret | null,
  paths: ReturnType<typeof internalServicePeerArtifactPaths>,
  body: Record<string, unknown>,
  plan: SiteSlotPlan | null = null,
  requireConfirm = true
): string[] {
  const failures: string[] = [];
  const renderedArtifacts = internalServicePeerRenderedArtifacts(secret);
  if (!secret) {
    failures.push(`Domestic WG secret is not materialized for site: ${siteId}`);
  } else {
    if (secret.status !== 'active') failures.push(`Domestic WG secret is not active: ${secret.status}`);
    if (secret.readiness.secretMaterial !== 'injected') failures.push('Domestic WG secret material is not injected');
    if (secret.readiness.publicEndpointStatus !== 'ready') failures.push('Domestic public endpoint is not ready');
    const endpointFailure = domesticRelayEndpointBlockedReason(secret.publicEndpoint);
    if (endpointFailure) failures.push(endpointFailure);
    if (secret.readiness.missingSecretInputs.length) {
      failures.push(`missing secret inputs: ${secret.readiness.missingSecretInputs.join(', ')}`);
    }
    if (!secret.internalServicePrivateKey || !secret.internalServicePublicKey) {
      failures.push('Internal service key pair is missing');
    }
    if (secret.internalServicePrivateKey && !validWireGuardPrivateKey(secret.internalServicePrivateKey)) {
      failures.push('Internal service private key is not a valid WireGuard key');
    }
    if (secret.internalServicePublicKey && !validWireGuardPublicKey(secret.internalServicePublicKey)) {
      failures.push('Internal service public key is not a valid WireGuard key');
    }
    if (!secret.domesticRelayPublicKey) {
      failures.push('Domestic relay public key is missing');
    }
    if (secret.domesticRelayPublicKey && !validWireGuardPublicKey(secret.domesticRelayPublicKey)) {
      failures.push('Domestic relay public key is not a valid WireGuard key');
    }
    const staleReason = plan ? domesticWireGuardStaleReason(plan, secret) : null;
    if (staleReason) failures.push(staleReason);
  }
  if (!domesticWireGuardArtifactReady(secret)) failures.push('Domestic WireGuard artifact manifest is not ready');
  if (!renderedArtifacts?.configContent && !existsSync(paths.configPath)) {
    failures.push(`Internal service peer config artifact is missing: ${paths.configPath}`);
  }
  if (!renderedArtifacts?.configContent) {
    failures.push(...internalServicePeerConfigFileFailures(paths.configPath));
  }
  if (!renderedArtifacts?.applyScriptContent && !existsSync(paths.applyScriptPath)) {
    failures.push(`Internal service peer apply script is missing: ${paths.applyScriptPath}`);
  }
  if (plan && plan.kind !== 'domestic') failures.push(`Internal service peer handoff requires a domestic plan, got ${plan.kind}`);
  if (requireConfirm && booleanValue(body.confirmInternalServicePeerHandoff) !== true) {
    failures.push('confirmInternalServicePeerHandoff=true is required before returning Internal service peer handoff');
  }
  return failures;
}

function internalServicePeerHandoffCommand(applyScriptPath: string): string {
  return `sudo env MX_INTERNAL_SERVICE_WG_INTERFACE=${INTERNAL_SERVICE_PEER_INTERFACE} bash ${shellQuote(applyScriptPath)}`;
}

async function adminInternalServicePeerRuntimeStatus(
  siteId: string,
  plan: SiteSlotPlan | null,
  secret: SiteSlotDomesticWireGuardSecret | null,
  store: PlatformStore | null = null,
  hostRunnerError: string | null = null
) {
  const paths = internalServicePeerArtifactPaths();
  const hostRunnerUrl = internalServicePeerHostRunnerUrl();
  if (hostRunnerUrl && !hostRunnerError) {
    try {
      const payload = await postInternalServicePeerHostRunner('/internal-service-peer/status', {
        ...await internalServicePeerHostRunnerPayload(siteId, plan, secret, paths, store),
        mode: 'status'
      });
      return asRecord(payload.runtimeStatus ?? payload);
    } catch (error) {
      return adminInternalServicePeerRuntimeStatus(siteId, plan, secret, store, error instanceof Error ? error.message : String(error));
    }
  }
  const interfaceName = INTERNAL_SERVICE_PEER_INTERFACE;
  const domesticGatewayIp = secret?.domesticGatewayIp ?? '10.88.0.1';
  const internalServiceIp = secret?.internalServiceIp ?? '10.88.88.88';
  const userRelayProbeIp = '10.89.100.1';
  const runtimeTarget = internalServicePeerRuntimeTarget(hostRunnerUrl, hostRunnerError);
  if (hostRunnerUrl && hostRunnerError && Boolean(process.env.KUBERNETES_SERVICE_HOST)) {
    return adminInternalServicePeerHostRunnerUnavailableStatus(siteId, plan, secret, paths, hostRunnerUrl, hostRunnerError);
  }
  const tools = {
    wg: await localCommandPath('wg'),
    wgQuick: await localCommandPath('wg-quick'),
    systemctl: await localCommandPath('systemctl'),
    ip: await localCommandPath('ip'),
    ping: await localCommandPath('ping'),
    qpTunnelCli: await localCommandPath('qp-tunnel-cli')
  };
  const artifacts = {
    configPath: paths.configPath,
    configExists: existsSync(paths.configPath),
    applyScriptPath: paths.applyScriptPath,
    applyScriptExists: existsSync(paths.applyScriptPath)
  };
  const wgShow = tools.wg.available
    ? await runLocalCommand(tools.wg.path ?? 'wg', ['show', interfaceName], 3000)
    : null;
  const latestHandshakes = tools.wg.available
    ? await runLocalCommand(tools.wg.path ?? 'wg', ['show', interfaceName, 'latest-handshakes'], 3000)
    : null;
  const routeToDomestic = tools.ip.available
    ? await runLocalCommand(tools.ip.path ?? 'ip', ['route', 'get', domesticGatewayIp], 3000)
    : await runLocalCommand('route', ['-n', 'get', domesticGatewayIp], 3000);
  const routeToUserRelay = tools.ip.available
    ? await runLocalCommand(tools.ip.path ?? 'ip', ['route', 'get', userRelayProbeIp], 3000)
    : await runLocalCommand('route', ['-n', 'get', userRelayProbeIp], 3000);
  const domesticGatewayPing = tools.ping.available
    ? await runLocalCommand(tools.ping.path ?? 'ping', ['-c', '1', domesticGatewayIp], 3000)
    : null;
  const internalHealthz = await httpHealthProbe(`http://${internalServiceIp}:18090/healthz`, 3000);
  const serviceVipHealthz = await Promise.all(
    domesticInternalServicePeerServiceVipIps(secret).map((ip) => httpHealthProbe(`http://${ip}:18090/healthz`, 3000))
  );
  const handshake = parseWireGuardLatestHandshake(latestHandshakes?.stdout ?? '');
  const domesticRouteInterface = routeProbeInterface(routeToDomestic.stdout);
  const userRelayRouteInterface = routeProbeInterface(routeToUserRelay.stdout);
  const userRelayRouteReady = routeToUserRelay.status === 'passed'
    && Boolean(domesticRouteInterface)
    && userRelayRouteInterface === domesticRouteInterface;
  const interfaceReady = wgShow?.status === 'passed';
  const linkReady = handshake.status === 'passed' || domesticGatewayPing?.status === 'passed';
  const healthReady = internalHealthz.status === 'passed'
    && serviceVipHealthz.every((probe) => probe.status === 'passed');
  const blockedReasons = [
    ...(runtimeTarget.mode === 'api-pod' ? ['Internal service peer install must run on the Internal runtime host; this API is running inside a k8s pod'] : []),
    ...(hostRunnerError ? [`Internal host runner is not reachable: ${hostRunnerError}`] : []),
    ...(!artifacts.configExists ? [`Internal service peer config artifact is missing: ${paths.configPath}`] : []),
    ...(!artifacts.applyScriptExists ? [`Internal service peer apply script is missing: ${paths.applyScriptPath}`] : []),
    ...(!tools.wg.available ? ['wg is missing on the current host'] : []),
    ...(!tools.wgQuick.available ? ['wg-quick is missing on the current host'] : []),
    ...(interfaceReady && linkReady && !userRelayRouteReady
      ? [`Internal return route to 10.89.0.0/16 is not on ${domesticRouteInterface ?? interfaceName}; route to ${userRelayProbeIp} is on ${userRelayRouteInterface ?? 'unknown'}`]
      : [])
  ];
  const status = blockedReasons.length > 0
    ? 'blocked'
    : interfaceReady && linkReady && healthReady
      ? 'passed'
      : interfaceReady
        ? 'ready'
        : 'blocked';
  return {
    status,
    mode: 'internal-service-peer-current-host-status',
    siteId,
    planId: plan?.planId ?? null,
    host: {
      hostname: osHostname(),
      platform: osPlatform(),
      release: osRelease()
    },
    interfaceName,
    domesticGatewayIp,
    internalServiceIp,
    runtimeTarget,
    tools,
    artifacts,
    interface: {
      name: interfaceName,
      wgShow,
      latestHandshakes,
      handshake
    },
    link: {
      routeToDomestic,
      routeToUserRelay,
      domesticGatewayPing,
      internalHealthz,
      serviceVipHealthz
    },
    install: {
      available: blockedReasons.length === 0,
      applyCommand: `bash scripts/manage.sh ops site-slot internal-service-peer-handoff apply`,
      hostRunnerCommand: internalServicePeerNativeHostRunnerInstallCommand(),
      requires: [
        'qp-tunnel-cli egress-on on the Internal runtime host for H2O/outbound bootstrap',
        'qp-tunnel-cli with @qpjoy/electron-core-wireguard on the Internal runtime host',
        'sudo/root privilege on the Internal runtime host'
      ],
      blockedReasons
    },
    blockedReasons,
    checkedAt: new Date().toISOString()
  };
}

function internalServicePeerHostRunnerImage(): string {
  return process.env.MX_INTERNAL_HOST_RUNNER_IMAGE?.trim()
    || process.env.MX_INTERNAL_IMAGE?.trim()
    || 'qpjoy/mx-launcher-server:shadow';
}

function internalServicePeerHostRunnerImagePullPolicy(): string {
  const explicit = process.env.MX_INTERNAL_HOST_RUNNER_IMAGE_PULL_POLICY?.trim();
  if (explicit) return explicit;
  const image = internalServicePeerHostRunnerImage();
  if (image === 'qpjoy/mx-launcher-server:shadow' || image === 'docker.io/qpjoy/mx-launcher-server:shadow') {
    return 'Never';
  }
  return 'IfNotPresent';
}

function internalServicePeerHostRunnerK8sObjects(namespace: string, name: string, port: number): Record<string, unknown>[] {
  const selectorLabels = {
    'app.kubernetes.io/name': name,
    'app.kubernetes.io/component': 'internal-host-runner'
  };
  const labels = {
    ...selectorLabels,
    'app.kubernetes.io/part-of': 'mx-3ks'
  };
  return [
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name,
        namespace,
        labels
      },
      spec: {
        type: 'ClusterIP',
        selector: selectorLabels,
        ports: [{
          name: 'http',
          port,
          targetPort: 'http'
        }]
      }
    },
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: {
        name,
        namespace,
        labels
      },
      spec: {
        selector: {
          matchLabels: selectorLabels
        },
        updateStrategy: {
          type: 'RollingUpdate'
        },
        template: {
          metadata: {
            labels
          },
          spec: {
            hostNetwork: true,
            dnsPolicy: 'ClusterFirstWithHostNet',
            automountServiceAccountToken: false,
            containers: [{
              name: 'host-runner',
              image: internalServicePeerHostRunnerImage(),
              imagePullPolicy: internalServicePeerHostRunnerImagePullPolicy(),
              command: ['sh', '-lc'],
              args: [`if [ -f server/scripts/internal-service-peer-host-runner.mjs ]; then node server/scripts/internal-service-peer-host-runner.mjs ${port}; else node scripts/internal-service-peer-host-runner.mjs ${port}; fi`],
              ports: [{
                name: 'http',
                containerPort: port,
                hostPort: port
              }],
              env: [
                { name: 'MX_INTERNAL_HOST_RUNNER_HOST', value: '0.0.0.0' },
                { name: 'MX_INTERNAL_HOST_RUNNER_PORT', value: String(port) },
                { name: 'MX_INTERNAL_SERVICE_ARTIFACT_DIR', value: '/var/lib/mx-launcher/internal-service-peer' },
                { name: 'MX_QP_TUNNEL_CLI_BUNDLE_DIR', value: '/var/lib/mx-launcher/internal-service-peer/qp-tunnel-cli-runtime' },
                { name: 'MX_QP_TUNNEL_CLI_FALLBACK_TAR', value: '/app/artifacts/site-slots/domestic/mx-domestic-qp-tunnel-cli-fallback.tar.gz' }
              ],
              securityContext: {
                privileged: true,
                capabilities: {
                  add: ['NET_ADMIN', 'SYS_MODULE']
                }
              },
              readinessProbe: {
                httpGet: {
                  path: '/healthz',
                  port: 'http'
                },
                initialDelaySeconds: 2,
                periodSeconds: 5,
                timeoutSeconds: 2,
                failureThreshold: 12
              },
              resources: {
                requests: {
                  cpu: '25m',
                  memory: '64Mi'
                },
                limits: {
                  cpu: '500m',
                  memory: '256Mi'
                }
              },
              volumeMounts: [
                {
                  name: 'runner-state',
                  mountPath: '/var/lib/mx-launcher/internal-service-peer'
                },
                {
                  name: 'wireguard-config',
                  mountPath: '/etc/wireguard'
                },
                {
                  name: 'tun-device',
                  mountPath: '/dev/net/tun'
                },
                {
                  name: 'kernel-modules',
                  mountPath: '/lib/modules',
                  readOnly: true
                }
              ]
            }],
            volumes: [
              {
                name: 'runner-state',
                hostPath: {
                  path: '/var/lib/mx-launcher/internal-service-peer',
                  type: 'DirectoryOrCreate'
                }
              },
              {
                name: 'wireguard-config',
                hostPath: {
                  path: '/etc/wireguard',
                  type: 'DirectoryOrCreate'
                }
              },
              {
                name: 'tun-device',
                hostPath: {
                  path: '/dev/net/tun',
                  type: 'CharDevice'
                }
              },
              {
                name: 'kernel-modules',
                hostPath: {
                  path: '/lib/modules',
                  type: 'DirectoryOrCreate'
                }
              }
            ]
          }
        }
      }
    }
  ];
}

function kubernetesObjectMetadata(object: Record<string, unknown>) {
  const metadata = asRecord(object.metadata);
  const name = stringValue(metadata.name);
  const namespace = stringValue(metadata.namespace);
  if (!name || !namespace) throw new Error('Kubernetes object metadata.name and metadata.namespace are required');
  return { name, namespace };
}

function kubernetesMetadataString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw ? raw : null;
}

function kubernetesObjectPaths(object: Record<string, unknown>) {
  const kind = stringValue(object.kind);
  const apiVersion = stringValue(object.apiVersion);
  const { name, namespace } = kubernetesObjectMetadata(object);
  if (apiVersion === 'v1' && kind === 'Service') {
    return {
      kind,
      name,
      namespace,
      resourcePath: `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
      createPath: `/api/v1/namespaces/${encodeURIComponent(namespace)}/services`
    };
  }
  if (apiVersion === 'apps/v1' && kind === 'DaemonSet') {
    return {
      kind,
      name,
      namespace,
      resourcePath: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/daemonsets/${encodeURIComponent(name)}`,
      createPath: `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/daemonsets`
    };
  }
  throw new Error(`Unsupported Kubernetes host-runner object: ${apiVersion || 'unknown'}/${kind || 'unknown'}`);
}

async function applyInternalServicePeerHostRunnerK8sObject(object: Record<string, unknown>) {
  const paths = kubernetesObjectPaths(object);
  const existing = await kubernetesRequest('GET', paths.resourcePath);
  if (existing.statusCode === 404) {
    const created = await kubernetesRequest('POST', paths.createPath, object);
    if (created.statusCode < 200 || created.statusCode >= 300) {
      return {
        status: 'failed',
        action: 'create',
        kind: paths.kind,
        name: paths.name,
        namespace: paths.namespace,
        resourceVersion: null,
        message: `HTTP ${created.statusCode} ${created.text}`
      };
    }
    return {
      status: 'created',
      action: 'create',
      kind: paths.kind,
      name: paths.name,
      namespace: paths.namespace,
      resourceVersion: kubernetesMetadataString(created.body, 'resourceVersion'),
      message: `${paths.kind} ${paths.namespace}/${paths.name} created`
    };
  }
  if (existing.statusCode < 200 || existing.statusCode >= 300) {
    return {
      status: 'failed',
      action: 'read',
      kind: paths.kind,
      name: paths.name,
      namespace: paths.namespace,
      resourceVersion: null,
      message: `HTTP ${existing.statusCode} ${existing.text}`
    };
  }
  const resourceVersion = kubernetesMetadataString(existing.body, 'resourceVersion');
  const metadata = asRecord(object.metadata);
  const desiredSpec = asRecord(object.spec);
  const existingSpec = asRecord(asRecord(existing.body).spec);
  const servicePreservedFields = ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy', 'internalTrafficPolicy'];
  const spec = paths.kind === 'Service'
    ? servicePreservedFields.reduce<Record<string, unknown>>((nextSpec, key) => ({
      ...nextSpec,
      ...(!(key in nextSpec) && existingSpec[key] !== undefined ? { [key]: existingSpec[key] } : {})
    }), { ...desiredSpec })
    : desiredSpec;
  const updated = await kubernetesRequest('PUT', paths.resourcePath, {
    ...object,
    metadata: {
      ...metadata,
      ...(resourceVersion ? { resourceVersion } : {})
    },
    spec
  });
  if (updated.statusCode < 200 || updated.statusCode >= 300) {
    return {
      status: 'failed',
      action: 'update',
      kind: paths.kind,
      name: paths.name,
      namespace: paths.namespace,
      resourceVersion,
      message: `HTTP ${updated.statusCode} ${updated.text}`
    };
  }
  return {
    status: 'updated',
    action: 'update',
    kind: paths.kind,
    name: paths.name,
    namespace: paths.namespace,
    resourceVersion: kubernetesMetadataString(updated.body, 'resourceVersion'),
    message: `${paths.kind} ${paths.namespace}/${paths.name} updated`
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function adminInternalServicePeerHostRunnerEnsureResult(
  siteId: string,
  plan: SiteSlotPlan | null,
  secret: SiteSlotDomesticWireGuardSecret | null,
  body: Record<string, unknown>,
  store: PlatformStore | null = null
) {
  const namespace = internalServicePeerK8sHostRunnerNamespace();
  const name = internalServicePeerK8sHostRunnerName();
  const port = internalServicePeerK8sHostRunnerPort();
  const runnerUrl = internalServicePeerK8sHostRunnerUrl();
  const confirm = booleanValue(body.confirmInternalHostRunnerEnsure) === true;
  const blockedReasons = [
    ...(!confirm ? ['confirmInternalHostRunnerEnsure=true is required before creating the k8s host-runner'] : []),
    ...(!process.env.KUBERNETES_SERVICE_HOST ? ['Internal host-runner ensure must run inside the Internal k8s API pod'] : []),
    ...(!internalServicePeerHostRunnerEnsureEnabled() ? ['MX_INTERNAL_HOST_RUNNER_K8S_ENSURE_ENABLED=true is required before creating the k8s host-runner fallback'] : []),
    ...(!internalServicePeerK8sHostRunnerFallbackEnabled() ? ['MX_INTERNAL_HOST_RUNNER_K8S_FALLBACK_ENABLED=true is required before creating the k8s host-runner fallback'] : [])
  ];
  if (blockedReasons.length > 0) {
    return {
      status: 'blocked',
      execution: 'not-started',
      mode: 'internal-service-peer-k8s-host-runner-ensure',
      siteId,
      planId: plan?.planId ?? stringValue(body.planId) ?? null,
      runnerUrl,
      namespace,
      name,
      objects: [],
      blockedReasons,
      nextActions: ['Install/start the native host runner on the Internal host, or explicitly enable k8s fallback for a container-only test'],
      afterStatus: null,
      finishedAt: new Date().toISOString()
    };
  }

  const objects = internalServicePeerHostRunnerK8sObjects(namespace, name, port);
  const results = [];
  for (const object of objects) {
    results.push(await applyInternalServicePeerHostRunnerK8sObject(object));
  }
  const failed = results.filter((item) => item.status === 'failed');
  if (failed.length > 0) {
    return {
      status: 'failed',
      execution: 'failed',
      mode: 'internal-service-peer-k8s-host-runner-ensure',
      siteId,
      planId: plan?.planId ?? stringValue(body.planId) ?? null,
      runnerUrl,
      namespace,
      name,
      objects: results,
      blockedReasons: failed.map((item) => item.message),
      nextActions: ['Check Internal API RBAC for services and daemonsets, then retry Ensure K8s Fallback'],
      afterStatus: null,
      finishedAt: new Date().toISOString()
    };
  }

  let afterStatus = await adminInternalServicePeerRuntimeStatus(siteId, plan, secret, store);
  for (let attempt = 0; internalPeerRuntimeHostRunnerOffline(afterStatus) && attempt < 5; attempt += 1) {
    await delay(1000);
    afterStatus = await adminInternalServicePeerRuntimeStatus(siteId, plan, secret, store);
  }
  const runnerReachable = !internalPeerRuntimeHostRunnerOffline(afterStatus);
  return {
    status: runnerReachable ? 'passed' : 'ready',
    execution: 'completed',
    mode: 'internal-service-peer-k8s-host-runner-ensure',
    siteId,
    planId: plan?.planId ?? stringValue(body.planId) ?? null,
    runnerUrl,
    namespace,
    name,
    image: internalServicePeerHostRunnerImage(),
    objects: results,
    blockedReasons: runnerReachable ? [] : internalServicePeerBlockedReasons(afterStatus),
    nextActions: runnerReachable
      ? ['Click Install / Restart to apply the Internal WG peer on the host runner']
      : ['Wait for the host-runner DaemonSet pod to become ready, then Refresh Status'],
    afterStatus,
    finishedAt: new Date().toISOString()
  };
}

function internalPeerRuntimeHostRunnerOffline(runtimeStatus: unknown): boolean {
  const runtimeTarget = asRecord(asRecord(runtimeStatus).runtimeTarget);
  const hostRunner = asRecord(runtimeTarget.hostRunner);
  return runtimeTarget.mode === 'host-runner-unreachable' || Boolean(hostRunner.error);
}

async function adminInternalServicePeerApplyResult(
  siteId: string,
  plan: SiteSlotPlan | null,
  secret: SiteSlotDomesticWireGuardSecret | null,
  body: Record<string, unknown>,
  store: PlatformStore | null = null
) {
  const paths = internalServicePeerArtifactPaths();
  const hostRunnerUrl = internalServicePeerHostRunnerUrl();
  if (hostRunnerUrl) {
    try {
      const payload = await postInternalServicePeerHostRunner('/internal-service-peer/apply', {
        ...await internalServicePeerHostRunnerPayload(siteId, plan, secret, paths, store),
        mode: 'apply',
        confirmInternalServicePeerApply: booleanValue(body.confirmInternalServicePeerApply) === true,
        requestedBy: stringValue(body.requestedBy) ?? 'admin-ui',
        requestId: stringValue(body.requestId) ?? `admin-internal-service-peer-apply-${Date.now()}`
      });
      return asRecord(payload.applyResult ?? payload.internalServicePeerApply ?? payload);
    } catch (error) {
      const beforeStatus = await adminInternalServicePeerRuntimeStatus(siteId, plan, secret, store, error instanceof Error ? error.message : String(error));
      const blockedReasons = Array.isArray(beforeStatus.blockedReasons)
        ? beforeStatus.blockedReasons.filter((item): item is string => typeof item === 'string')
        : ['Internal host runner is not reachable'];
      return {
        status: 'blocked',
        execution: 'not-started',
        mode: 'internal-service-peer-host-runner-apply',
        siteId,
        planId: plan?.planId ?? stringValue(body.planId) ?? null,
        command: null,
        exitCode: null,
        stdout: '',
        stderr: blockedReasons.join('\n'),
        beforeStatus,
        afterStatus: beforeStatus,
        blockedReasons,
        finishedAt: new Date().toISOString()
      };
    }
  }
  const beforeStatus = await adminInternalServicePeerRuntimeStatus(siteId, plan, secret, store);
  const confirm = booleanValue(body.confirmInternalServicePeerApply) === true;
  const blockedReasons = [
    ...(!confirm ? ['confirmInternalServicePeerApply=true is required before installing the service'] : []),
    ...internalServicePeerBlockedReasons(beforeStatus)
  ];
  if (blockedReasons.length > 0) {
    return {
      status: 'blocked',
      execution: 'not-started',
      mode: 'internal-service-peer-current-host-apply',
      siteId,
      planId: plan?.planId ?? stringValue(body.planId) ?? null,
      command: null,
      exitCode: null,
      stdout: '',
      stderr: blockedReasons.join('\n'),
      beforeStatus,
      afterStatus: beforeStatus,
      blockedReasons,
      finishedAt: new Date().toISOString()
    };
  }

  const interfaceName = INTERNAL_SERVICE_PEER_INTERFACE;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const command = isRoot ? 'env' : 'sudo';
  const args = isRoot
    ? [`MX_INTERNAL_SERVICE_WG_INTERFACE=${interfaceName}`, 'bash', paths.applyScriptPath, paths.configPath]
    : ['-n', 'env', `MX_INTERNAL_SERVICE_WG_INTERFACE=${interfaceName}`, 'bash', paths.applyScriptPath, paths.configPath];
  const execution = await runLocalCommand(command, args, 60000);
  const afterStatus = await adminInternalServicePeerRuntimeStatus(siteId, plan, secret, store);
  const status = execution.status === 'passed'
    ? afterStatus.status === 'passed' ? 'passed' : 'ready'
    : 'failed';
  return {
    status,
    execution: execution.status === 'passed' ? 'completed' : 'failed',
    mode: 'internal-service-peer-current-host-apply',
    siteId,
    planId: plan?.planId ?? stringValue(body.planId) ?? null,
    command: `${command} ${args.map(shellQuote).join(' ')}`,
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
    beforeStatus,
    afterStatus,
    blockedReasons: status === 'passed' ? [] : internalServicePeerBlockedReasons(afterStatus),
    finishedAt: new Date().toISOString()
  };
}

async function localCommandPath(command: string) {
  const result = await runLocalCommand('sh', ['-lc', `command -v ${command}`], 1000);
  const path = result.status === 'passed' ? result.stdout.trim().split(/\s+/)[0] ?? null : null;
  return {
    available: Boolean(path),
    path,
    probe: result.status
  };
}

async function runLocalCommand(command: string, args: string[], timeoutMs: number) {
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return {
      status: 'passed',
      command,
      args,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (error) {
    const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    return {
      status: execError.killed ? 'timeout' : execError.code === 'ENOENT' ? 'missing' : 'failed',
      command,
      args,
      exitCode: typeof execError.code === 'number' ? execError.code : null,
      stdout: (execError.stdout ?? '').trim(),
      stderr: (execError.stderr ?? execError.message).trim(),
      signal: execError.signal ?? null,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}

function routeProbeInterface(stdout: string | null | undefined): string | null {
  const text = typeof stdout === 'string' ? stdout : '';
  return text.match(/^\s*interface:\s*(\S+)/m)?.[1]
    ?? text.match(/\bdev\s+(\S+)/)?.[1]
    ?? null;
}

async function httpHealthProbe(url: string, timeoutMs: number) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return {
      status: response.ok ? 'passed' : 'failed',
      url,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      body: text.slice(0, 500)
    };
  } catch (error) {
    return {
      status: 'failed',
      url,
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseWireGuardLatestHandshake(stdout: string) {
  const rows = stdout.trim().split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const latest = rows.map((line) => {
    const [publicKey, rawTimestamp] = line.split(/\s+/);
    const timestamp = Number(rawTimestamp || 0);
    return {
      publicKey,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      at: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null
    };
  });
  const newest = latest.reduce((current, item) => item.timestamp > current.timestamp ? item : current, { publicKey: null as string | null, timestamp: 0, at: null as string | null });
  return {
    status: newest.timestamp > 0 ? 'passed' : rows.length > 0 ? 'blocked' : 'missing',
    newest,
    peers: latest
  };
}

function redactAdminDomesticWireGuardSecret(secret: SiteSlotDomesticWireGuardSecret) {
  return {
    secretId: secret.secretId,
    siteId: secret.siteId,
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
      domesticRelayPrivateKey: wireGuardKeyMaterialStatus(secret.domesticRelayPrivateKey),
      domesticRelayPublicKey: wireGuardKeyMaterialStatus(secret.domesticRelayPublicKey),
      internalServicePrivateKey: wireGuardKeyMaterialStatus(secret.internalServicePrivateKey),
      internalServicePublicKey: wireGuardKeyMaterialStatus(secret.internalServicePublicKey)
    },
    fingerprints: secret.fingerprints,
    readiness: secret.readiness,
    updatedAt: secret.updatedAt
  };
}

function domesticWireGuardArtifactReady(secret?: SiteSlotDomesticWireGuardSecret | null): boolean {
  const failures: string[] = [];
  const manifest = readArtifactManifest('domestic', resolveSiteSlotArtifactBaseDir(), failures);
  const module = manifest?.modules.find((item) => item.moduleId === 'wireguard-config') ?? null;
  return failures.length === 0 && module?.status === 'ready' && (!secret || domesticWireGuardArtifactMatchesSecret(module, secret));
}

function domesticWireGuardArtifactMatchesSecret(
  module: NonNullable<ReturnType<typeof readArtifactManifest>>['modules'][number],
  secret: SiteSlotDomesticWireGuardSecret
): boolean {
  const metadata = asRecord(module.metadata);
  const artifactEndpoint = stringValue(metadata.publicEndpoint);
  if (secret.publicEndpoint && artifactEndpoint !== secret.publicEndpoint) return false;
  const artifactCidrs = uniqueConfigStrings((Array.isArray(metadata.productRelayCidrs) ? metadata.productRelayCidrs : [])
    .filter((cidr): cidr is string => typeof cidr === 'string'));
  const secretCidrs = domesticSecretProductRelayCidrs(secret);
  return artifactCidrs.join(',') === secretCidrs.join(',');
}

function domesticRelayPeerAppendSshFailures(
  gate: ReturnType<typeof buildSiteSlotRemoteSshGate>,
  body: Record<string, unknown>,
  relayPeerAppend: ReturnType<typeof adminDomesticRelayPeerAppendResult>,
  sshProfile: SiteSlotSshProfile | null
): string[] {
  return [
    ...(gate.verdict === 'passed' ? [] : gate.gateFailures),
    ...relayPeerAppend.blockedReasons,
    ...(sshProfile ? [] : ['managed SSH profile is required before Domestic relay peer append SSH execution']),
    ...(booleanValue(body.confirmRelayPeerAppendSsh) === true
      ? []
      : ['confirmRelayPeerAppendSsh=true is required before executing Domestic relay peer append over SSH'])
  ];
}

async function domesticRelayPeerAppendSshStepReports(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  gate: ReturnType<typeof buildSiteSlotRemoteSshGate>,
  body: Record<string, unknown>,
  input = domesticRelayPeerInput(body),
  relayPeerAppend = adminDomesticRelayPeerAppendResult(job, plan, body, input)
): Promise<{
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
}> {
  const blockedReasons = domesticRelayPeerAppendSshFailures(gate, body, relayPeerAppend, sshProfile);
  const steps = [...job.steps].sort((left, right) => left.order - right.order);
  const carrierStep = steps.find((step) => phaseIdFromSource(step.sourceId) === 'prepare-domestic-relay-authority')
    ?? steps.find((step) => phaseIdFromSource(step.sourceId) === 'activate-domestic-peer-center')
    ?? steps[0];
  const startedAt = new Date().toISOString();
  let status: NonNullable<SiteSlotWorkerReportInput['status']> = blockedReasons.length > 0 ? 'blocked' : 'passed';
  let exitCode: number | null = blockedReasons.length > 0 ? null : 0;
  let execution = blockedReasons.length > 0 ? 'blocked' : 'executed';
  let executionResult: Record<string, unknown> | null = blockedReasons.length > 0
    ? null
    : { exitCode: 0, stdout: '', stderr: '' };

  if (blockedReasons.length === 0 && sshProfile) {
    try {
      const result = await execFileAsync('ssh', overseaTerminalSshArgv(sshProfile, domesticRelayPeerAppendScript(input)), {
        cwd: resolveMxLauncherRoot(),
        timeout: (sshProfile.connectTimeoutSeconds + 60) * 1000,
        maxBuffer: 4 * 1024 * 1024
      });
      executionResult = {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr
      };
    } catch (error) {
      const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      const diagnosis = sshFailureDiagnosis(execError.stderr ?? execError.message, execError.code) as Record<string, unknown>;
      diagnosis.tcpProbe = await tcpConnectProbe(sshProfile.host, sshProfile.sshPort, sshProfile.connectTimeoutSeconds);
      status = 'failed';
      exitCode = typeof execError.code === 'number' ? execError.code : null;
      execution = 'failed';
      executionResult = {
        exitCode,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message,
        diagnosis
      };
    }
  }

  const evidence = domesticRelayPeerAppendSshEvidence(job, carrierStep, plan, sshProfile, gate, body, input, {
    status,
    execution,
    exitCode,
    blockedReasons,
    executionResult
  });
  const stepReports = steps.map((step) => {
    const isCarrier = step.stepId === carrierStep?.stepId;
    const now = new Date().toISOString();
    return {
      stepId: step.stepId,
      status: isCarrier ? status : 'passed' as const,
      exitCode: isCarrier ? exitCode : 0,
      stdout: JSON.stringify(isCarrier ? evidence : domesticRelayPeerAppendSshSkippedEvidence(job, step, carrierStep?.stepId ?? null), null, 2),
      stderr: isCarrier && status !== 'passed' ? blockedReasons.join('\n') || stringValue(executionResult?.stderr) : null,
      startedAt: isCarrier ? startedAt : now,
      finishedAt: new Date().toISOString(),
      attempt: 1
    };
  });
  return {
    status: workerReportStatus(stepReports),
    stepReports
  };
}

function domesticRelayPeerAppendSshEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number] | undefined,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  gate: ReturnType<typeof buildSiteSlotRemoteSshGate>,
  body: Record<string, unknown>,
  input: DomesticRelayPeerInput,
  result: {
    status: NonNullable<SiteSlotWorkerReportInput['status']>;
    execution: string;
    exitCode: number | null;
    blockedReasons: string[];
    executionResult: Record<string, unknown> | null;
  }
) {
  return {
    dryRun: false,
    mode: 'domestic-relay-peer-append-ssh',
    execution: result.execution,
    boundary: 'gated-ssh-worker',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sourceId: step?.sourceId ?? 'domestic-relay-peer-append-ssh',
    phaseId: step ? phaseIdFromSource(step.sourceId) : 'domestic-relay-peer-append-ssh',
    stepId: step?.stepId ?? 'domestic-relay-peer-append-ssh',
    order: step?.order ?? 0,
    target: 'domestic',
    command: domesticRelayPeerAppendCommand(plan, input),
    sshProfile: adminSshProfileEvidence(plan, sshProfile),
    domesticRelay: {
      siteId: plan?.siteId ?? job.siteId,
      endpointHost: plan?.host ?? null,
      interfaceName: 'mx-domestic',
      listenPort: 51280,
      gatewayIp: '10.88.0.1',
      configPath: '/etc/wireguard/mx-domestic.conf',
      unit: 'wg-quick@mx-domestic'
    },
    homePeer: domesticRelayPeerHomePeer(input),
    handoff: {
      commandExecuted: result.execution === 'executed',
      remoteMutation: true,
      mutation: 'wg-set-peer-allowed-ips'
    },
    gates: {
      remoteSshGate: gate.verdict,
      confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
      confirmRelayPeerAppendSsh: booleanValue(body.confirmRelayPeerAppendSsh) === true,
      confirmRelayPeerAppend: booleanValue(body.confirmRelayPeerAppend) === true,
      confirmRelayReadOnlyProbeReviewed: booleanValue(body.confirmRelayReadOnlyProbeReviewed) === true,
      confirmRelayPeerPlanReviewed: booleanValue(body.confirmRelayPeerPlanReviewed) === true,
      internalPrivateKeyMustNotExistOnDomestic: true
    },
    gateFailures: result.blockedReasons,
    executionResult: result.executionResult,
    notes: [
      'This worker report is created only by the gated SSH executor.',
      'The remote command performs wg set and then wg show / wg-quick save when the host accepts it.',
      'If execution is blocked, no SSH connection was opened.'
    ]
  };
}

function domesticRelayPeerAppendSshSkippedEvidence(
  job: SiteSlotWorkerJob,
  step: SiteSlotWorkerJob['steps'][number],
  carrierStepId: string | null
) {
  return {
    dryRun: false,
    mode: 'domestic-relay-peer-append-ssh',
    execution: 'skipped',
    boundary: 'gated-ssh-worker',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    sourceId: step.sourceId,
    phaseId: phaseIdFromSource(step.sourceId),
    stepId: step.stepId,
    order: step.order,
    target: step.target,
    skipReason: `Domestic relay peer append SSH evidence is carried by ${carrierStepId ?? 'the first worker step'}.`,
    handoff: {
      commandExecuted: false,
      remoteMutation: false
    }
  };
}

type DomesticRelayPeerInput = {
  peerRole: 'guest' | 'user';
  leaseIp: string | null;
  publicKey: string | null;
  leaseId: string | null;
  leaseResolved: boolean;
  leaseError: string | null;
  productId: string | null;
  launcherMode: string | null;
  identityKind: string | null;
  leaseCidr: string | null;
  serviceVip: string | null;
  internalControlIp: string | null;
  domesticGatewayIp: string | null;
  publicKeySource: 'launcher-network-lease' | 'request-body' | 'missing';
  leaseIpSource: 'launcher-network-lease' | 'request-body' | 'missing';
  warnings: string[];
};

async function resolveDomesticRelayPeerInput(store: PlatformStore, body: Record<string, unknown>): Promise<DomesticRelayPeerInput> {
  const leaseId = stringValue(body.leaseId) ?? stringValue(body.launcherNetworkLeaseId);
  if (!leaseId || leaseId.includes('<')) return domesticRelayPeerInput(body);
  const lease = await store.getLauncherNetworkLease(leaseId);
  return domesticRelayPeerInput(body, lease, lease ? null : `Launcher Network lease not found: ${leaseId}`);
}

function domesticRelayPeerInput(
  body: Record<string, unknown>,
  lease: LauncherNetworkLease | null = null,
  leaseError: string | null = null
): DomesticRelayPeerInput {
  const requestedLeaseId = stringValue(body.leaseId) ?? stringValue(body.launcherNetworkLeaseId);
  const bodyLeaseIp = stringValue(body.leaseIp) ?? stringValue(body.ip);
  const bodyPublicKey = stringValue(body.publicKey);
  const leaseIp = lease?.leaseIp ?? bodyLeaseIp ?? null;
  const publicKey = lease?.publicKey ?? bodyPublicKey ?? null;
  const rawRole = stringValue(body.peerRole) ?? stringValue(body.role);
  const inferredRole = lease?.identityKind === 'user'
    ? 'user'
    : lease?.identityKind === 'anonymous'
      ? 'guest'
      : relayLeaseIdentityKind(leaseIp) ?? 'guest';
  const peerRole = rawRole === 'user' || rawRole === 'guest' ? rawRole : inferredRole;
  const warnings = [
    ...(lease && bodyLeaseIp && bodyLeaseIp !== lease.leaseIp ? [`request leaseIp ${bodyLeaseIp} ignored; Internal lease ${lease.leaseId} owns ${lease.leaseIp}`] : []),
    ...(lease?.publicKey && bodyPublicKey && bodyPublicKey !== lease.publicKey ? [`request publicKey ignored; Internal lease ${lease.leaseId} owns the peer public key`] : [])
  ];
  return {
    peerRole,
    leaseIp,
    publicKey,
    leaseId: requestedLeaseId ?? lease?.leaseId ?? null,
    leaseResolved: Boolean(lease),
    leaseError,
    productId: lease?.productId ?? stringValue(body.productId) ?? null,
    launcherMode: lease?.launcherMode ?? stringValue(body.launcherMode) ?? stringValue(body.mode) ?? null,
    identityKind: lease?.identityKind ?? null,
    leaseCidr: lease?.cidr ?? (leaseIp && validRelayLeaseIp(leaseIp) ? relayPeerCidr(peerRole, leaseIp) : null),
    serviceVip: lease?.serviceVip ?? null,
    internalControlIp: lease?.internalControlIp ?? null,
    domesticGatewayIp: lease?.domesticGatewayIp ?? null,
    publicKeySource: lease?.publicKey ? 'launcher-network-lease' : bodyPublicKey ? 'request-body' : 'missing',
    leaseIpSource: lease?.leaseIp ? 'launcher-network-lease' : bodyLeaseIp ? 'request-body' : 'missing',
    warnings
  };
}

function domesticRelayPeerHomePeer(input: DomesticRelayPeerInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const allowedIp = input.leaseIp ? `${input.leaseIp}/32` : null;
  return {
    role: input.peerRole,
    leaseId: input.leaseId,
    leaseResolved: input.leaseResolved,
    productId: input.productId,
    launcherMode: input.launcherMode,
    identityKind: input.identityKind,
    leaseIp: input.leaseIp,
    cidr: input.leaseCidr ?? relayPeerCidr(input.peerRole, input.leaseIp),
    serviceVip: input.serviceVip,
    internalControlIp: input.internalControlIp,
    domesticGatewayIp: input.domesticGatewayIp,
    allowedIps: allowedIp ? [allowedIp] : [],
    publicKey: input.publicKey,
    publicKeyStatus: input.publicKey ? 'ready-to-append' : 'pending-public-key',
    publicKeySource: input.publicKeySource,
    leaseIpSource: input.leaseIpSource,
    warnings: input.warnings,
    ...extra
  };
}

function domesticRelayPeerPlanFailures(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  input: DomesticRelayPeerInput = domesticRelayPeerInput(body)
): string[] {
  const failures: string[] = [];
  if (input.leaseError) failures.push(input.leaseError);
  if (job.status !== 'ready') failures.push(`worker job is not ready: ${job.status}`);
  if (job.currentReportId) failures.push(`worker job already has report: ${job.currentReportId}`);
  if (job.kind !== 'domestic') failures.push(`Domestic relay peer plan requires a domestic worker job, got ${job.kind}`);
  if (!plan) failures.push('plan not found while building Domestic relay peer plan');
  if (plan && plan.kind !== 'domestic') failures.push(`Domestic relay peer plan requires a domestic plan, got ${plan.kind}`);
  if (booleanValue(body.confirmRelayPeerPlan) !== true) {
    failures.push('confirmRelayPeerPlan=true is required before recording Domestic relay peer plan evidence');
  }
  if (!input.publicKey) {
    failures.push('Home WireGuard publicKey is required before Domestic peer append can be planned');
  } else if (!validWireGuardPublicKey(input.publicKey)) {
    failures.push('Home WireGuard publicKey does not look like a base64 WireGuard public key');
  }
  if (!input.leaseIp) {
    failures.push('Home relay leaseIp is required before Domestic peer append can be planned');
  } else if (!validRelayLeaseIp(input.leaseIp)) {
    failures.push('Home relay leaseIp must be in a product relay CIDR, with 10.88.0.0/16 reserved for relay fabric');
  } else if (input.peerRole === 'user' && relayLeaseIdentityKind(input.leaseIp) !== 'user') {
    failures.push('user relay peer must use the product login range (third octet 0-99)');
  } else if (input.peerRole === 'guest' && relayLeaseIdentityKind(input.leaseIp) !== 'guest') {
    failures.push('guest relay peer must use the product anonymous range (third octet 100-254)');
  }
  return failures;
}

function validWireGuardPublicKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.trim());
}

function validWireGuardPrivateKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.trim());
}

function wireGuardKeyMaterialStatus(value: string | null | undefined): 'configured' | 'invalid' | 'missing' {
  if (!value) return 'missing';
  return validWireGuardPrivateKey(value) ? 'configured' : 'invalid';
}

function validRelayLeaseIp(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    && octets[1] >= 89
    && octets[1] <= 254
    && octets[2] <= 254
    && octets[3] >= 1
    && octets[3] <= 254;
}

function relayLeaseIdentityKind(value: string | null | undefined): 'guest' | 'user' | null {
  if (!value || !validRelayLeaseIp(value)) return null;
  const thirdOctet = Number(value.split('.')[2]);
  return thirdOctet >= 100 ? 'guest' : 'user';
}

function relayPeerCidr(role: 'guest' | 'user', leaseIp?: string | null): string {
  if (leaseIp && validRelayLeaseIp(leaseIp)) {
    const [, secondOctet] = leaseIp.split('.');
    return `10.${secondOctet}.0.0/16`;
  }
  return role === 'user' ? '10.89.0.0/16' : '10.90.0.0/16';
}

function domesticRelayRouteCidrsForAllowedIp(allowedIp: string): string[] {
  const ip = allowedIp.split('/')[0] ?? '';
  const parts = ip.split('.').map((part) => Number(part));
  const derived = parts.length === 4 && parts[0] === 10 && Number.isInteger(parts[1]) && parts[1] >= 89 && parts[1] <= 254
    ? `10.${parts[1]}.0.0/16`
    : null;
  return uniqueStrings([derived, '10.89.0.0/16', '10.90.0.0/16'].filter((cidr): cidr is string => Boolean(cidr)));
}

function domesticRelayFirewallEnsureCommands(): string[] {
  return [
    'if command -v iptables >/dev/null 2>&1; then iptables -C FORWARD -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -i mx-domestic -o mx-domestic -j ACCEPT; if iptables -S DOCKER-USER >/dev/null 2>&1; then iptables -C DOCKER-USER -i mx-domestic -o mx-domestic -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER 1 -i mx-domestic -o mx-domestic -j ACCEPT; fi; iptables -C INPUT -i mx-domestic -p udp --dport 53 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i mx-domestic -p udp --dport 53 -j ACCEPT; iptables -C INPUT -i mx-domestic -p tcp --dport 53 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i mx-domestic -p tcp --dport 53 -j ACCEPT; fi'
  ];
}

function domesticRelayPeerAppendFailures(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  input: DomesticRelayPeerInput = domesticRelayPeerInput(body)
): string[] {
  return [
    ...domesticRelayPeerInputFailures(job, plan, input, 'Domestic relay peer append'),
    ...(booleanValue(body.confirmRelayPeerAppend) === true
      ? []
      : ['confirmRelayPeerAppend=true is required before returning Domestic relay peer append handoff']),
    ...(booleanValue(body.confirmRelayReadOnlyProbeReviewed) === true
      ? []
      : ['confirmRelayReadOnlyProbeReviewed=true is required before Domestic relay peer append handoff']),
    ...(booleanValue(body.confirmRelayPeerPlanReviewed) === true
      ? []
      : ['confirmRelayPeerPlanReviewed=true is required before Domestic relay peer append handoff'])
  ];
}

function domesticRelayPeerInputFailures(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  input: DomesticRelayPeerInput,
  label: string
): string[] {
  const failures: string[] = [];
  if (input.leaseError) failures.push(input.leaseError);
  if (job.status !== 'ready') failures.push(`worker job is not ready: ${job.status}`);
  if (job.currentReportId) failures.push(`worker job already has report: ${job.currentReportId}`);
  if (job.kind !== 'domestic') failures.push(`${label} requires a domestic worker job, got ${job.kind}`);
  if (!plan) failures.push(`plan not found while building ${label}`);
  if (plan && plan.kind !== 'domestic') failures.push(`${label} requires a domestic plan, got ${plan.kind}`);
  if (plan && !plan.host) failures.push('domestic host is required before relay peer handoff');
  if (!input.publicKey) {
    failures.push('Home WireGuard publicKey is required before Domestic peer append can be planned');
  } else if (!validWireGuardPublicKey(input.publicKey)) {
    failures.push('Home WireGuard publicKey does not look like a base64 WireGuard public key');
  }
  if (!input.leaseIp) {
    failures.push('Home relay leaseIp is required before Domestic peer append can be planned');
  } else if (!validRelayLeaseIp(input.leaseIp)) {
    failures.push('Home relay leaseIp must be in a product relay CIDR, with 10.88.0.0/16 reserved for relay fabric');
  } else if (input.peerRole === 'user' && relayLeaseIdentityKind(input.leaseIp) !== 'user') {
    failures.push('user relay peer must use the product login range (third octet 0-99)');
  } else if (input.peerRole === 'guest' && relayLeaseIdentityKind(input.leaseIp) !== 'guest') {
    failures.push('guest relay peer must use the product anonymous range (third octet 100-254)');
  }
  return failures;
}

function domesticRelayReadOnlyProbeFailures(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>
): string[] {
  return [
    ...(job.status !== 'ready' ? [`worker job is not ready: ${job.status}`] : []),
    ...(job.currentReportId ? [`worker job already has report: ${job.currentReportId}`] : []),
    ...(job.kind !== 'domestic' ? [`Domestic relay read-only probe requires a domestic worker job, got ${job.kind}`] : []),
    ...(plan ? [] : ['plan not found while building Domestic relay read-only probe']),
    ...(plan && plan.kind !== 'domestic' ? [`Domestic relay read-only probe requires a domestic plan, got ${plan.kind}`] : []),
    ...(plan?.host ? [] : ['domestic host is required before relay read-only probe handoff']),
    ...(booleanValue(body.confirmRelayReadOnlyProbe) === true
      ? []
      : ['confirmRelayReadOnlyProbe=true is required before returning Domestic relay read-only probe handoff'])
  ];
}

function domesticRelayReadOnlyProbeCommand(plan: SiteSlotPlan | null, secret: SiteSlotDomesticWireGuardSecret | null = null): string {
  const sshUser = plan?.ssh.user ?? 'root';
  const sshPort = plan?.ssh.port ?? 22;
  const host = plan?.host ?? '<domestic-host>';
  return `ssh -p ${sshPort} ${shellQuote(`${sshUser}@${host}`)} ${shellQuote(domesticRelayReadOnlyProbeScript(secret))}`;
}

function domesticRelayReadOnlyProbeScript(secret: SiteSlotDomesticWireGuardSecret | null = null): string {
  const internalPublicKey = secret?.internalServicePublicKey ?? '<internal-service-public-key>';
  const internalServiceIp = secret?.internalServiceIp ?? '10.88.88.88';
  const serviceVipIps = domesticInternalServicePeerServiceVipIps(secret);
  return [
    'set -eu',
    'printf "mx-domestic-relay-readonly-probe\\n"',
    `internal_peer=${shellQuote(internalPublicKey)}`,
    `internal_ip=${shellQuote(internalServiceIp)}`,
    `service_vip_ips=${shellQuote(serviceVipIps.join(' '))}`,
    'id -u',
    'hostname',
    'uname -a',
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic',
    'wg show mx-domestic endpoints || true',
    'wg show mx-domestic latest-handshakes || true',
    'if echo "$internal_peer" | grep -q "^<"; then echo "blocked: internal service public key is missing from Internal secret"; exit 1; fi',
    'handshake="$(wg show mx-domestic latest-handshakes | awk -v peer="$internal_peer" \'$1 == peer { print $2 }\')"',
    'if [ -z "$handshake" ] || [ "$handshake" = "0" ]; then echo "blocked: Internal service peer has no latest handshake"; exit 1; fi',
    'ip -4 address show dev mx-domestic',
    'ip -4 address show dev mx-domestic | grep -q "10\\.88\\.0\\.1/" || { echo "blocked: mx-domestic missing 10.88.0.1/16"; exit 1; }',
    'ip route get "$internal_ip"',
    'if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 5 "http://${internal_ip}:18090/healthz"; elif command -v wget >/dev/null 2>&1; then wget -qO- -T 5 "http://${internal_ip}:18090/healthz"; else echo "blocked: curl or wget is required for Internal healthz"; exit 1; fi',
    'for service_vip_ip in $service_vip_ips; do ip route get "$service_vip_ip"; if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 5 "http://${service_vip_ip}:18090/healthz"; elif command -v wget >/dev/null 2>&1; then wget -qO- -T 5 "http://${service_vip_ip}:18090/healthz"; fi; done',
    'systemctl status wg-quick@mx-domestic --no-pager 2>/dev/null || true'
  ].join('; ');
}

function domesticRelayPeerAppendCommand(
  plan: SiteSlotPlan | null,
  input: DomesticRelayPeerInput
): string {
  const sshUser = plan?.ssh.user ?? 'root';
  const sshPort = plan?.ssh.port ?? 22;
  const host = plan?.host ?? '<domestic-host>';
  return `ssh -p ${sshPort} ${shellQuote(`${sshUser}@${host}`)} ${shellQuote(domesticRelayPeerAppendScript(input))}`;
}

function domesticRelayPeerAppendScript(input: DomesticRelayPeerInput): string {
  const publicKey = input.publicKey ?? '<home-wg-public-key>';
  const allowedIp = input.leaseIp ? `${input.leaseIp}/32` : '<home-lease-ip>/32';
  const routeCidrs = domesticRelayRouteCidrsForAllowedIp(allowedIp);
  return [
    'set -eu',
    'printf "mx-domestic-relay-peer-append\\n"',
    `allowed_ip=${shellQuote(allowedIp)}`,
    `relay_route_cidrs=${shellQuote(routeCidrs.join(' '))}`,
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic >/dev/null',
    `wg set mx-domestic peer ${shellQuote(publicKey)} allowed-ips ${shellQuote(allowedIp)}`,
    'ip link set up dev mx-domestic',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null || true',
    ...domesticRelayFirewallEnsureCommands(),
    'for route_cidr in $relay_route_cidrs; do ip route replace "$route_cidr" dev mx-domestic; done',
    'ip route replace "$allowed_ip" dev mx-domestic || true',
    'wg show mx-domestic',
    'ip route get "${allowed_ip%/*}" || true',
    'if command -v wg-quick >/dev/null 2>&1; then wg-quick save mx-domestic || true; fi',
    'systemctl status wg-quick@mx-domestic --no-pager 2>/dev/null || true'
  ].join('; ');
}

function domesticRelayPublicKeyReadScript(): string {
  return [
    'set -eu',
    'printf "mx-domestic-relay-public-key-read\\n"',
    'test -f /etc/wireguard/mx-domestic.conf',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic >/dev/null',
    'printf "domestic_public_key=%s\\n" "$(wg show mx-domestic public-key)"',
    'wg show mx-domestic allowed-ips || true'
  ].join('; ');
}

function domesticInternalServicePeerKeySyncScript(internalPublicKey: string, secret: SiteSlotDomesticWireGuardSecret): string {
  const primaryAllowedIp = `${secret.internalServiceIp}/32`;
  const allowedIps = domesticInternalServicePeerAllowedIps(secret);
  const relayRouteCidrs = uniqueStrings([
    ...domesticRelayRouteCidrsForAllowedIp('10.89.100.1/32'),
    ...domesticSecretProductRelayCidrs(secret)
  ]);
  return [
    'set -eu',
    'printf "mx-domestic-internal-service-peer-key-sync\\n"',
    `relay_route_cidrs=${shellQuote(relayRouteCidrs.join(' '))}`,
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic >/dev/null',
    `internal_peer=${shellQuote(internalPublicKey)}`,
    `primary_allowed_ip=${shellQuote(primaryAllowedIp)}`,
    `allowed_ips=${shellQuote(allowedIps.join(','))}`,
    'stale_peers="$(wg show mx-domestic allowed-ips | awk -v keep="$internal_peer" -v ip="$primary_allowed_ip" \'$1 != keep { for (i = 2; i <= NF; i += 1) if ($i == ip) print $1 }\')"',
    'for peer in $stale_peers; do wg set mx-domestic peer "$peer" remove; done',
    'wg set mx-domestic peer "$internal_peer" allowed-ips "$allowed_ips"',
    'ip link set up dev mx-domestic',
    'sysctl -w net.ipv4.ip_forward=1 >/dev/null || true',
    ...domesticRelayFirewallEnsureCommands(),
    'for route_cidr in $relay_route_cidrs; do ip route replace "$route_cidr" dev mx-domestic; done',
    'printf "domestic_public_key=%s\\n" "$(wg show mx-domestic public-key)"',
    'printf "internal_peer=%s\\n" "$internal_peer"',
    'wg show mx-domestic allowed-ips',
    'if command -v wg-quick >/dev/null 2>&1; then wg-quick save mx-domestic || true; fi',
    'systemctl status wg-quick@mx-domestic --no-pager 2>/dev/null || true'
  ].join('; ');
}

function domesticRuntimeConfigApplyScript(config: SiteSlotDomesticRuntimeConfig): string {
  const envLines = Object.entries(config.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  const dnsPort = String(config.dns.port || 53);
  const caddyfileBase64 = Buffer.from(domesticServicesCaddyfileContent()).toString('base64');
  const dnsEdgeCorefileBase64 = Buffer.from(domesticDnsEdgeCorefileContent(config)).toString('base64');
  const dnsEdgeComposeBase64 = Buffer.from(domesticDnsEdgeComposeContent()).toString('base64');
  return [
    'set -eu',
    'printf "mx-domestic-runtime-config-apply\\n"',
    'stack_dir=/opt/mx/current/domestic',
    `dns_port=${shellQuote(dnsPort)}`,
    'test -d "$stack_dir" || { echo "blocked: Domestic edge stack is not installed at $stack_dir"; exit 1; }',
    'test -f "$stack_dir/manage.sh" || { echo "blocked: Domestic manage.sh is missing; run Install / Sync first"; exit 1; }',
    `printf "%s\\n" ${envLines.map(shellQuote).join(' ')} > "$stack_dir/.env.tmp"`,
    'mv "$stack_dir/.env.tmp" "$stack_dir/.env"',
    `if command -v base64 >/dev/null 2>&1; then printf "%s" ${shellQuote(caddyfileBase64)} | base64 -d > "$stack_dir/Caddyfile.tmp"; mv "$stack_dir/Caddyfile.tmp" "$stack_dir/Caddyfile"; else echo "blocked: base64 is required to refresh Domestic Caddyfile"; exit 1; fi`,
    'mkdir -p "$stack_dir/dns-edge"',
    `if command -v base64 >/dev/null 2>&1; then printf "%s" ${shellQuote(dnsEdgeCorefileBase64)} | base64 -d > "$stack_dir/dns-edge/Corefile.tmp"; mv "$stack_dir/dns-edge/Corefile.tmp" "$stack_dir/dns-edge/Corefile"; else echo "blocked: base64 is required to refresh Domestic DNS edge Corefile"; exit 1; fi`,
    `if command -v base64 >/dev/null 2>&1; then printf "%s" ${shellQuote(dnsEdgeComposeBase64)} | base64 -d > "$stack_dir/docker-compose.dns-edge.yml.tmp"; mv "$stack_dir/docker-compose.dns-edge.yml.tmp" "$stack_dir/docker-compose.dns-edge.yml"; else echo "blocked: base64 is required to refresh Domestic DNS edge compose"; exit 1; fi`,
    'if test -f "$stack_dir/docker-compose.yml"; then sed -i.bak -E \'s#^([[:space:]]*image:[[:space:]]*)caddy:2-alpine#\\1caddy:2.8.4-alpine#\' "$stack_dir/docker-compose.yml"; fi',
    'cd "$stack_dir"',
    'chmod +x ./manage.sh || true',
    'mx_dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"; else echo "blocked: docker compose is missing"; return 127; fi; }',
    'mx_dns_port_busy() { p="$1"; if command -v ss >/dev/null 2>&1 && ss -H -lntu 2>/dev/null | awk -v p=":$p" \'$5 ~ p "$" { found=1 } END { exit found ? 0 : 1 }\'; then return 0; fi; if command -v lsof >/dev/null 2>&1 && { lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk \'NR > 1 { found=1 } END { exit found ? 0 : 1 }\' || lsof -nP -iUDP:"$p" 2>/dev/null | awk \'NR > 1 { found=1 } END { exit found ? 0 : 1 }\'; }; then return 0; fi; return 1; }',
    './manage.sh up',
    'mx_dc --profile dns stop dns-forwarder >/dev/null 2>&1 || true',
    'dns_edge_container_id="$(mx_dc -f docker-compose.yml -f docker-compose.dns-edge.yml ps -q mx-domestic-dns-edge 2>/dev/null || true)"',
    'if [ -n "$dns_edge_container_id" ]; then echo "updating managed Domestic DNS edge on :$dns_port"; mx_dc -f docker-compose.yml -f docker-compose.dns-edge.yml up -d mx-domestic-dns-edge; elif mx_dns_port_busy "$dns_port"; then echo "Domestic DNS :$dns_port already has a listener; reusing existing V1/host DNS runtime"; else echo "starting managed Domestic DNS edge on :$dns_port"; mx_dc -f docker-compose.yml -f docker-compose.dns-edge.yml up -d mx-domestic-dns-edge; fi',
    'mx_dc -f docker-compose.yml -f docker-compose.dns-edge.yml ps mx-domestic-dns-edge || true',
    './manage.sh status || true',
    './manage.sh health'
  ].join('; ');
}

function domesticServicesCaddyfileContent(): string {
  return [
    '{',
    '  auto_https off',
    '}',
    '',
    ':8088 {',
    '  encode gzip',
    '  header {',
    '    X-MX-Site-Role domestic',
    '    X-MX-Domestic-Mode bootstrap-and-relay',
    '  }',
    '',
    '  @health path /healthz',
    '  respond @health "{\\"ok\\":true,\\"service\\":\\"mx-domestic-edge\\",\\"role\\":\\"domestic\\",\\"mode\\":\\"bootstrap-and-relay\\"}" 200',
    '',
    '  @bootstrapHealth path /bootstrap-healthz /internal-healthz',
    '  handle @bootstrapHealth {',
    '    rewrite * /healthz',
    '    reverse_proxy {$MX_INTERNAL_API_UPSTREAM:http://10.88.88.88:18090} {',
    '      header_up Host {upstream_hostport}',
    '      header_up X-Forwarded-Host {http.request.host}',
    '      header_up X-MX-Forwarded-By domestic-edge',
    '    }',
    '  }',
    '',
    '  handle_path /evidence/* {',
    '    root * /srv/mx/evidence',
    '    file_server browse',
    '  }',
    '',
    '  handle_path /snapshots/* {',
    '    root * /srv/mx/snapshots',
    '    file_server browse',
    '  }',
    '',
    '  handle_path /h2i/* {',
    '    reverse_proxy {$MX_INTERNAL_H2I_UPSTREAM:http://10.88.88.88:18090} {',
    '      header_up Host {upstream_hostport}',
    '      header_up X-Forwarded-Host {http.request.host}',
    '      header_up X-MX-Forwarded-By domestic-edge',
    '    }',
    '  }',
    '',
    '  handle_path /api/* {',
    '    reverse_proxy {$MX_INTERNAL_API_UPSTREAM:http://10.88.88.88:18090} {',
    '      header_up Host {upstream_hostport}',
    '      header_up X-Forwarded-Host {http.request.host}',
    '      header_up X-MX-Forwarded-By domestic-edge',
    '    }',
    '  }',
    '',
    '  handle /internal/* {',
    '    reverse_proxy {$MX_INTERNAL_API_UPSTREAM:http://10.88.88.88:18090} {',
    '      header_up Host {upstream_hostport}',
    '      header_up X-Forwarded-Host {http.request.host}',
    '      header_up X-MX-Forwarded-By domestic-edge',
    '    }',
    '  }',
    '',
    '  respond "mx-domestic-edge\\n" 200',
    '}',
    ''
  ].join('\n');
}

function domesticDnsEdgeCorefileContent(config: SiteSlotDomesticRuntimeConfig): string {
  const bind = coreDnsBindHost(config.dns.bind);
  const listenPort = config.dns.port || 53;
  return [
    `.:${listenPort} {`,
    `  bind ${bind}`,
    '  errors',
    '  cache 30',
    '  forward . 10.88.88.88:53',
    '  reload',
    '}',
    ''
  ].join('\n');
}

function domesticDnsEdgeComposeContent(): string {
  return [
    'services:',
    '  mx-domestic-dns-edge:',
    '    image: coredns/coredns:1.11.3',
    '    container_name: mx-domestic-dns-edge-v2',
    '    restart: unless-stopped',
    '    network_mode: host',
    '    command: ["-conf", "/Corefile"]',
    '    volumes:',
    '      - ./dns-edge/Corefile:/Corefile:ro',
    ''
  ].join('\n');
}

function coreDnsBindHost(value: string | null | undefined): string {
  const text = stringValue(value) || '0.0.0.0';
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(text) || text === 'localhost' ? text : '0.0.0.0';
}

async function runSshScriptWithProfile(profile: SiteSlotSshProfile, script: string, timeoutMs: number) {
  const startedAt = new Date().toISOString();
  const args = overseaTerminalSshArgv(profile, script);
  const { stdout, stderr } = await execFileAsync('ssh', args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024
  });
  return {
    status: 'passed',
    command: `ssh ${args.map(shellQuote).join(' ')}`,
    exitCode: 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

function sshScriptFailure(error: unknown, startedAt: string) {
  const execError = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
  return {
    status: execError.killed ? 'timeout' : execError.code === 'ENOENT' ? 'missing' : 'failed',
    command: null,
    exitCode: typeof execError.code === 'number' ? execError.code : null,
    stdout: (execError.stdout ?? '').trim(),
    stderr: (execError.stderr ?? execError.message).trim(),
    signal: execError.signal ?? null,
    startedAt,
    finishedAt: new Date().toISOString()
  };
}

function domesticRelayPublicKeyFromReadOutput(stdout: string | null | undefined): string | null {
  const text = stdout ?? '';
  const keyed = text.match(/(?:^|\n)domestic_public_key=([A-Za-z0-9+/=]{32,88})(?:\n|$)/);
  if (keyed?.[1] && validWireGuardPublicKey(keyed[1])) return keyed[1];
  return firstWireGuardPublicKey(text);
}

function internalServicePublicKeyFromRuntimeStatus(status: unknown): string | null {
  const interfacePublicKey = stringValue(asRecord(asRecord(status).interface).publicKey);
  if (interfacePublicKey && validWireGuardPublicKey(interfacePublicKey)) return interfacePublicKey;
  const corePublicKey = stringValue(asRecord(asRecord(status).wireGuardCore).publicKey);
  if (corePublicKey && validWireGuardPublicKey(corePublicKey)) return corePublicKey;
  const wgShow = asRecord(asRecord(asRecord(status).interface).wgShow);
  const stdout = stringValue(wgShow.stdout);
  const fromShow = interfacePublicKeyFromWireGuardShow(stdout);
  if (fromShow) return fromShow;
  const tunnel = asRecord(asRecord(status).wireGuardCore).tunnel;
  const tunnelRecord = asRecord(tunnel);
  return interfacePublicKeyFromWireGuardShow(stringValue(tunnelRecord.ifconfig) ?? '');
}

function interfacePublicKeyFromWireGuardShow(stdout: string | null | undefined): string | null {
  const match = (stdout ?? '').match(/public key:\s*([A-Za-z0-9+/=]{32,88})/);
  return match?.[1] && validWireGuardPublicKey(match[1]) ? match[1] : null;
}

function firstWireGuardPublicKey(stdout: string | null | undefined): string | null {
  const match = (stdout ?? '').match(/\b([A-Za-z0-9+/=]{32,88})\b/);
  return match?.[1] && validWireGuardPublicKey(match[1]) ? match[1] : null;
}

function deriveWireGuardPublicKeyFromPrivate(privateKey: string | null | undefined): string | null {
  if (!privateKey?.trim()) return null;
  try {
    const bytes = Buffer.from(privateKey.trim(), 'base64');
    if (bytes.length !== 32) return null;
    return deriveWireGuardPublicKey(bytes);
  } catch {
    return null;
  }
}

function adminFakeTransportResult(
  job: SiteSlotWorkerJob,
  gate: ReturnType<typeof buildSiteSlotRemoteSshGate>,
  confirmFakeTransport: boolean
) {
  const blockedReasons = [
    ...(gate.verdict === 'passed' ? [] : gate.gateFailures),
    ...(!confirmFakeTransport ? ['confirmFakeTransport=true is required before recording fake transport evidence'] : [])
  ];
  return {
    fakeTransportId: `artifact_push_fake_transport_${job.jobId}`,
    status: blockedReasons.length > 0 ? 'blocked' : 'ready',
    execution: 'not-started',
    boundary: 'admin-fake-transport-no-remote-mutation',
    mode: 'artifact-push-fake-transport',
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    blockedReasons,
    notes: [
      'This Admin action records worker report evidence only after the remote SSH gate passes.',
      'It does not open SSH or mutate Domestic/Oversea.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-remote-ssh-gates', 'rerun-fake-transport-after-gate']
      : ['record-fake-worker-report', 'review-evidence-drawer']
  };
}

function artifactReferenceEvidence(
  ref: string,
  artifactBaseDir: string,
  failures: string[],
  options: { failOnTemplateArtifact?: boolean } = {}
) {
  const resolvedPath = resolveArtifactReference(ref, artifactBaseDir);
  const exists = existsSync(resolvedPath);
  const kind = artifactKind(ref);
  const manifest = kind ? readArtifactManifest(kind, artifactBaseDir, failures) : null;
  const moduleMatch = artifactModuleMatch(manifest, resolvedPath, ref);
  const module = moduleMatch?.module ?? null;
  const manifestSelfReference = basename(resolvedPath) === 'manifest.json';
  const sha256 = exists ? sha256File(resolvedPath) : null;
  if (!exists) failures.push(`missing artifact: ${ref} -> ${resolvedPath}`);
  if (exists && !manifest) failures.push(`missing artifact manifest for ${ref}`);
  if (exists && manifest && !module && !manifestSelfReference) failures.push(`artifact not listed in manifest: ${ref}`);
  if (exists && moduleMatch?.primary && module?.sha256 && sha256 !== module.sha256) {
    failures.push(`artifact sha256 mismatch for ${ref}: expected ${module.sha256}, got ${sha256}`);
  }
  if (options.failOnTemplateArtifact === true && exists && module?.status === 'template' && !manifestSelfReference) {
    failures.push(`artifact module is template-only and cannot be remotely applied before Internal injection: ${module.moduleId}`);
  }
  return {
    ref,
    path: resolvedPath,
    exists,
    bytes: exists ? statSync(resolvedPath).size : null,
    sha256,
    manifest: manifest ? {
      path: manifest.path,
      releaseRevision: manifest.releaseRevision,
      kind: manifest.kind,
      sha256: manifest.sha256,
      sha256Status: manifest.sha256Status
    } : null,
    module: module ? {
      moduleId: module.moduleId,
      status: module.status,
      targetPath: module.targetPath,
      manifestSha256: module.sha256,
      sha256Status: moduleMatch?.primary ? module.sha256 === sha256 ? 'passed' : 'failed' : 'module-file',
      bytes: module.bytes,
      metadata: module.metadata
    } : null
  };
}

function artifactModuleMatch(
  manifest: ReturnType<typeof readArtifactManifest> | null,
  resolvedPath: string,
  ref: string
) {
  const resolvedBasename = basename(resolvedPath);
  const refRelative = ref.replace(/^\.\/artifacts\/site-slots\/[^/]+\//, '');
  for (const module of manifest?.modules ?? []) {
    const primaryBasename = basename(stringValue(module.artifactPath) ?? stringValue(module.artifact) ?? '');
    if (primaryBasename === resolvedBasename) return { module, primary: true };
    if (module.files.some((file) => file === refRelative || basename(file) === resolvedBasename)) {
      return { module, primary: false };
    }
  }
  return null;
}

function readArtifactManifest(kind: string, artifactBaseDir: string, failures: string[]) {
  const manifestPath = resolve(artifactBaseDir, kind, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifestRecord = parseJsonRecord(readFileSync(manifestPath, 'utf8'));
  if (!manifestRecord) {
    failures.push(`invalid artifact manifest: ${manifestPath}`);
    return null;
  }
  const modules = Array.isArray(manifestRecord.modules)
    ? manifestRecord.modules.map((item) => asRecord(item))
    : [];
  const manifestText = readFileSync(manifestPath, 'utf8');
  const actualSha = sha256Text(manifestText);
  const shaFilePath = `${manifestPath}.sha256`;
  const expectedSha = existsSync(shaFilePath)
    ? readFileSync(shaFilePath, 'utf8').trim().split(/\s+/)[0]
    : null;
  if (expectedSha && expectedSha !== actualSha) failures.push(`manifest sha256 mismatch: ${manifestPath}`);
  if (!expectedSha) failures.push(`missing manifest sha256 file: ${shaFilePath}`);
  return {
    path: manifestPath,
    releaseRevision: stringValue(manifestRecord.releaseRevision),
    kind: stringValue(manifestRecord.kind),
    sha256: actualSha,
    sha256Status: expectedSha ? expectedSha === actualSha ? 'passed' : 'failed' : 'missing-sha256-file',
    modules: modules.map((module) => ({
      moduleId: stringValue(module.moduleId),
      artifact: stringValue(module.artifact),
      artifactPath: stringValue(module.artifactPath),
      status: stringValue(module.status),
      targetPath: stringValue(module.targetPath),
      sha256: stringValue(module.sha256),
      bytes: typeof module.bytes === 'number' ? module.bytes : null,
      metadata: asRecord(module.metadata),
      files: Array.isArray(module.files)
        ? module.files.map((file) => stringValue(file)).filter((file): file is string => Boolean(file))
        : []
    }))
  };
}

function adminSshProfileEvidence(plan: SiteSlotPlan | null, profile: SiteSlotSshProfile | null) {
  const identityFileExists = profile?.identityFile ? existsSync(profile.identityFile) : null;
  const knownHostsFileExists = profile?.knownHostsFile ? existsSync(profile.knownHostsFile) : null;
  const sshConfigFileExists = profile?.sshConfigFile ? existsSync(profile.sshConfigFile) : null;
  const gateWarnings = [
    ...(plan ? [] : ['plan not found while building dry-run SSH evidence']),
    ...(plan?.ssh.profileStatus === 'paused' || profile?.status === 'paused' ? ['managed SSH profile is paused'] : []),
    ...(profile?.identityFile && identityFileExists === false ? [`SSH identity file does not exist: ${profile.identityFile}`] : []),
    ...(profile?.knownHostsFile && knownHostsFileExists === false ? [`SSH known_hosts file does not exist: ${profile.knownHostsFile}`] : []),
    ...(profile?.sshConfigFile && sshConfigFileExists === false ? [`SSH config file does not exist: ${profile.sshConfigFile}`] : [])
  ];
  return {
    gate: 'dry-run-warning-only',
    source: plan?.ssh.profileSource ?? 'none',
    profileId: plan?.ssh.profileId ?? profile?.profileId ?? null,
    profileStatus: plan?.ssh.profileStatus ?? profile?.status ?? null,
    profileWarnings: plan?.ssh.profileWarnings ?? profile?.warnings ?? [],
    host: profile?.host ?? plan?.host ?? null,
    sshUser: profile?.sshUser ?? plan?.ssh.user ?? null,
    sshPort: profile?.sshPort ?? plan?.ssh.port ?? null,
    identityFile: profile?.identityFile ?? null,
    identityFileExists,
    knownHostsFile: profile?.knownHostsFile ?? null,
    knownHostsFileExists,
    sshConfigFile: profile?.sshConfigFile ?? null,
    sshConfigFileExists,
    hostKeyAlias: profile?.hostKeyAlias ?? null,
    strictHostKeyChecking: profile?.strictHostKeyChecking ?? null,
    connectTimeoutSeconds: profile?.connectTimeoutSeconds ?? null,
    batchMode: profile?.batchMode ?? null,
    gateWarnings
  };
}

function resolveSiteSlotArtifactBaseDir(): string {
  if (process.env.SITE_SLOT_ARTIFACT_BASE_DIR) return resolve(process.env.SITE_SLOT_ARTIFACT_BASE_DIR);
  return resolve(resolveMxLauncherRoot(), 'artifacts/site-slots');
}

function resolveMxLauncherRoot(): string {
  const controllerDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MX_LAUNCHER_ROOT,
    resolve(process.cwd(), 'electron-dock/mx-launcher'),
    resolve(controllerDir, '../../../..'),
    resolve(controllerDir, '../../../../..'),
    process.cwd()
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(resolve(candidate, 'server/package.json')) && existsSync(resolve(candidate, 'scripts/manage.sh')))
    ?? candidates.find((candidate) => existsSync(resolve(candidate, 'artifacts/site-slots')))
    ?? process.cwd();
}

function siteSlotArtifactSourceProbe(mxRoot: string, kind: 'oversea' | 'domestic') {
  const sourceRoot = kind === 'oversea'
    ? resolve(mxRoot, 'site-slots/oversea/hysteria2-access-stack')
    : resolve(mxRoot, 'site-slots/domestic/qp-tunnel-cli');
  const requiredFiles = kind === 'oversea'
    ? [
      '.env.example',
      'Caddyfile',
      'docker-compose.yml',
      'manage.sh',
      'scripts/reconcile-tunnel-state.mjs'
    ]
    : [
      'package.json',
      'resources/mihomo-client.sh'
    ];
  const missing = requiredFiles
    .map((item) => resolve(sourceRoot, item))
    .filter((item) => !existsSync(item));
  return {
    sourceRoot,
    requiredFiles,
    missing,
    ready: missing.length === 0
  };
}

function resolveSiteSlotWorkerRunScript(mxRoot: string): string {
  const candidates = [
    process.env.SITE_SLOT_WORKER_RUN_SCRIPT,
    resolve(mxRoot, 'server/scripts/site-slot-worker-run.mjs'),
    resolve(mxRoot, 'scripts/site-slot-worker-run.mjs'),
    resolve(process.cwd(), 'scripts/site-slot-worker-run.mjs')
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? resolve(mxRoot, 'server/scripts/site-slot-worker-run.mjs');
}

function artifactReferenceValues(command: string): string[] {
  return Array.from(new Set((command.match(/\.\/artifacts\/site-slots\/[A-Za-z0-9._/-]+/g) ?? [])
    .map((value) => value.replace(/[;,'")]+$/g, ''))
    .filter((value) => basename(value).includes('.'))));
}

function resolveArtifactReference(ref: string, artifactBaseDir: string): string {
  const match = ref.match(/^\.\/artifacts\/site-slots\/([^/]+)\/(.+)$/);
  if (match) return resolve(artifactBaseDir, match[1], match[2]);
  return resolve(resolveMxLauncherRoot(), ref);
}

function artifactKind(ref: string): string | null {
  return ref.match(/^\.\/artifacts\/site-slots\/([^/]+)\//)?.[1] ?? null;
}

function phaseIdFromSource(sourceId: string): string {
  return sourceId.replace(/\.\d+$/, '');
}

function adminCommandKind(command: string): string {
  if (command.startsWith('POST ')) return 'admin-api-intent';
  if (command.startsWith('Release Center ')) return 'artifact-materialize-intent';
  if (command.startsWith('If @qpjoy/tunnel-cli ')) return 'artifact-refresh-intent';
  if (command.includes('rsync ') || command.includes('scp ')) return 'artifact-transport';
  if (command.startsWith('ssh ')) return 'remote-shell-intent';
  if (command.startsWith('Check ')) return 'manual-smoke-intent';
  return 'planned-command';
}

function executableAdminRemoteCommandKind(value: string): boolean {
  return value === 'artifact-transport' || value === 'remote-shell-intent';
}

function reusableOverseaPlanContract(plan: SiteSlotPlan): boolean {
  const commands = plan.deploymentPhases.flatMap((phase) => phase.commands ?? []);
  return (commands.some((command) => command.includes('/bin/qp-tunnel-cli register --internal'))
    || commands.some((command) => command.includes('oversea callback push-only; registration skipped')))
    && commands.some((command) => command.includes('./manage.sh sync-internal-defaults'))
    && commands.some((command) => command.includes('./manage.sh docker-status'))
    && commands.some((command) => command.includes('slot services placeholder; no Docker services selected'))
    && commands.some((command) => command.includes('overseaConfigDelivery=internal-pushed'))
    && commands.some((command) => command.includes('overseaAccessAccountMaterial=internal-issued accounts='));
}

function reusableOverseaPlanIncludesAccounts(plan: SiteSlotPlan, accounts: SiteSlotPlanAccessAccountInput[]): boolean {
  const commandText = plan.deploymentPhases.flatMap((phase) => phase.commands ?? []).join('\n');
  return accounts.every((account) => commandText.includes(account.username));
}

function reusableOverseaPlanMatchesRuntime(
  plan: SiteSlotPlan,
  serverPorts: string | null,
  exportPort: number | null,
  workerInternalBaseUrl: string | null,
  overseaCallbackBaseUrl: string | null
): boolean {
  const runtime = plan.runtime.oversea;
  if (serverPorts && runtime?.serverPorts !== serverPorts) return false;
  if (exportPort != null && runtime?.exportPort !== exportPort) return false;
  if (workerInternalBaseUrl && runtime?.workerInternalBaseUrl !== workerInternalBaseUrl) return false;
  if ((runtime?.overseaCallbackBaseUrl ?? null) !== (overseaCallbackBaseUrl ?? null)) return false;
  return true;
}

function applyAdminSshProfile(command: string, profile: SiteSlotSshProfile | null): string {
  const options = adminSshOptionFragment(profile);
  let next = command.replace(/-e 'ssh -p ([0-9]+)'/g, (_match, port: string) => `-e ${shellQuote(`ssh ${options} -p ${port}`)}`);
  next = next.replace(/\bscp (-r )?-P ([0-9]+)/g, (_match, recursive: string = '', port: string) => `scp ${recursive}${options} -P ${port}`);
  let replacedSshPort = false;
  next = next.replace(/\bssh -p ([0-9]+)/g, (_match, port: string) => {
    replacedSshPort = true;
    return `ssh ${options} -p ${port}`;
  });
  if (!replacedSshPort && next.startsWith('ssh ')) {
    next = next.replace(/^ssh\b/, `ssh ${options}`);
  }
  return next;
}

function adminSshOptionFragment(profile: SiteSlotSshProfile | null): string {
  const connectTimeoutSeconds = effectiveSshConnectTimeoutSeconds(profile?.connectTimeoutSeconds);
  const parts = [
    '-F', shellQuote(internalSshConfigFile(profile)),
    '-o', shellQuote(`BatchMode=${profile?.batchMode ?? 'yes'}`),
    '-o', shellQuote(`ConnectTimeout=${connectTimeoutSeconds}`),
    '-o', shellQuote(`StrictHostKeyChecking=${profile?.strictHostKeyChecking ?? 'yes'}`)
  ];
  if (profile?.identityFile) parts.push('-i', shellQuote(profile.identityFile));
  if (profile?.knownHostsFile) parts.push('-o', shellQuote(`UserKnownHostsFile=${profile.knownHostsFile}`));
  if (profile?.hostKeyAlias) parts.push('-o', shellQuote(`HostKeyAlias=${profile.hostKeyAlias}`));
  return parts.join(' ');
}

function effectiveSshConnectTimeoutSeconds(value: number | null | undefined): number {
  return Math.max(30, value ?? 30);
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function adminTransportEvidence(command: string) {
  return {
    usesRsync: command.includes('rsync '),
    usesScpFallback: command.includes('scp '),
    usesSsh: command.startsWith('ssh ') || command.includes(" -e 'ssh "),
    repositoryRootSynced: command.includes('git pull') || command.includes('git clone') || command.includes(' ./ ')
  };
}

function redactArtifactPushEvidence(
  step: SiteSlotWorkerJob['steps'][number],
  evidence: ReturnType<typeof artifactPushDryRunEvidence> & { effectiveCommand?: string }
) {
  if (!step.redactOutput) return evidence;
  return {
    ...evidence,
    command: '[redacted command]',
    effectiveCommand: evidence.effectiveCommand ? '[redacted effective command]' : undefined,
    notes: [...evidence.notes, 'Command was redacted by worker step policy.']
  };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function buildTimeline(
  plan: SiteSlotPlan,
  executions: SiteSlotExecutionRun[],
  runnerSessions: SiteSlotRunnerSession[],
  workerJobs: SiteSlotWorkerJob[],
  workerReports: SiteSlotWorkerReport[],
  rollbackExecutions: SiteSlotRollbackExecution[],
  rollbackReports: SiteSlotRollbackReport[]
): AdminTimelineEntry[] {
  const entries: AdminTimelineEntry[] = [
    {
      id: plan.planId,
      kind: 'plan',
      status: plan.status,
      title: `${plan.kind} slot plan`,
      at: plan.createdAt,
      parentId: null,
      nextActions: plan.nextActions
    },
    ...executions.map((execution) => ({
      id: execution.runId,
      kind: 'execution' as const,
      status: execution.status,
      title: `${execution.action} execution`,
      at: execution.createdAt,
      parentId: execution.planId,
      nextActions: execution.nextActions
    })),
    ...runnerSessions.map((session) => ({
      id: session.sessionId,
      kind: 'runner-session' as const,
      status: session.status,
      title: `${session.mode} runner session`,
      at: session.finishedAt ?? session.startedAt,
      parentId: session.runId,
      nextActions: session.nextActions
    })),
    ...workerJobs.map((job) => ({
      id: job.jobId,
      kind: 'worker-job' as const,
      status: job.status,
      title: `${job.worker.kind} worker job`,
      at: job.updatedAt ?? job.createdAt,
      parentId: job.sessionId,
      nextActions: job.nextActions
    })),
    ...workerReports.map((report) => ({
      id: report.reportId,
      kind: 'worker-report' as const,
      status: report.status,
      title: `${report.workerId} worker report`,
      at: report.createdAt,
      parentId: report.jobId,
      nextActions: report.nextActions
    })),
    ...rollbackExecutions.map((execution) => ({
      id: execution.rollbackExecutionId,
      kind: 'rollback-execution' as const,
      status: execution.status,
      title: `${execution.mode} rollback execution`,
      at: execution.updatedAt ?? execution.createdAt,
      parentId: execution.sourceReportId,
      nextActions: execution.nextActions
    })),
    ...rollbackReports.map((report) => ({
      id: report.rollbackReportId,
      kind: 'rollback-report' as const,
      status: report.status,
      title: `${report.workerId} rollback report`,
      at: report.createdAt,
      parentId: report.rollbackExecutionId,
      nextActions: report.nextActions
    }))
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

interface DomesticPostInstallInternalGate {
  blocked: boolean;
  warnings: string[];
  nextActions: string[];
}

function domesticPostInstallInternalGate(
  plan: SiteSlotPlan,
  workerReports: SiteSlotWorkerReport[],
  secret: SiteSlotDomesticWireGuardSecret | null
): DomesticPostInstallInternalGate {
  const empty = { blocked: false, warnings: [], nextActions: [] };
  if (plan.kind !== 'domestic') return empty;
  const report = latestByCreatedAt(workerReports);
  if (!report || report.status !== 'passed') return empty;
  const step = report.stepReports.find((item) => {
    const text = `${item.stdout ?? ''}\n${item.stderr ?? ''}`.toLowerCase();
    return item.sourceId === 'sync-internal-config.2'
      || text.includes('internal is not reachable')
      || text.includes('destination address required')
      || text.includes('no route to host');
  });
  if (!step) return empty;
  const text = `${step.stdout ?? ''}\n${step.stderr ?? ''}`.toLowerCase();
  const hasInternalReachabilityWarning = text.includes('internal is not reachable')
    || text.includes('no route to host')
    || text.includes('destination address required');
  if (!hasInternalReachabilityWarning) return empty;
  const internalIp = secret?.internalServiceIp || '10.88.88.88';
  const internalPort = domesticRuntimePortFromPlan(plan);
  const endpoint = secret?.publicEndpoint
    || endpointFromPlanHost(plan, secret?.listenPort ?? 51280)
    || `${plan.host || '<domestic-host>'}:${secret?.listenPort ?? 51280}`;
  const listenPort = secret?.listenPort ?? domesticListenPortFromEndpoint(endpoint) ?? 51280;
  const reason = domesticInternalReachabilityReason(step.stdout, step.stderr);
  return {
    blocked: true,
    warnings: [
      `blocked: Domestic relay installed but Internal service peer is not reachable at ${internalIp}:${internalPort} (${reason}). Run Internal Service Peer Status/Install on the Internal host and allow UDP ${listenPort} to ${endpoint}.`
    ],
    nextActions: [
      'check-internal-service-peer-status',
      'install-internal-service-peer',
      'verify-domestic-wg-handshake'
    ]
  };
}

function domesticRuntimePortFromPlan(plan: SiteSlotPlan): number {
  try {
    const port = plan.runtime.domestic?.upstreams.internalBaseUrl
      ? Number(new URL(plan.runtime.domestic.upstreams.internalBaseUrl).port)
      : NaN;
    return Number.isFinite(port) && port > 0 ? port : 18090;
  } catch {
    return 18090;
  }
}

function domesticListenPortFromEndpoint(endpoint: string | null | undefined): number | null {
  const match = endpoint?.match(/:(\d+)$/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function domesticInternalReachabilityReason(stdout: string | null, stderr: string | null): string {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`.toLowerCase();
  if (text.includes('destination address required')) {
    return 'WireGuard peer has no learned endpoint/handshake yet';
  }
  if (text.includes('no route to host')) {
    return 'No route to host through mx-domestic';
  }
  if (text.includes('connection refused')) {
    return 'Internal API port is reachable but refused the connection';
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return 'Internal API reachability timed out';
  }
  return 'Internal service peer has not completed the Domestic WG path';
}

function buildPipelineActionHints(
  actionPolicy: AdminActionPolicy,
  plan: SiteSlotPlan,
  executions: SiteSlotExecutionRun[],
  runnerSessions: SiteSlotRunnerSession[],
  workerJobs: SiteSlotWorkerJob[],
  workerReports: SiteSlotWorkerReport[],
  rollbackExecutions: SiteSlotRollbackExecution[],
  domesticWgSecret: SiteSlotDomesticWireGuardSecret | null,
  domesticPostInstallGate: DomesticPostInstallInternalGate = { blocked: false, warnings: [], nextActions: [] }
): AdminActionDescriptor[] {
  const actions: AdminActionDescriptor[] = [];
  const readyPreflight = sortByCreatedAt(executions).find((execution) => execution.action === 'preflight' && execution.status === 'ready');
  const confirmedApply = sortByCreatedAt(executions).find((execution) => execution.action === 'apply' && execution.status === 'ready' && execution.confirmApply);
  const latestReadyExecution = [...sortByCreatedAt(executions)].reverse().find((execution) => execution.status === 'ready') ?? null;
  const sessionNeedingWorker = [...sortByStartedAt(runnerSessions)].reverse().find((session) => {
    const canAttachWorker = session.status === 'completed' || session.status === 'queued';
    return canAttachWorker && !workerJobs.some((job) => job.sessionId === session.sessionId);
  }) ?? null;
  const failedReportNeedingRollback = [...sortByCreatedAt(workerReports)].reverse().find((report) => {
    const hasRollbackExecution = rollbackExecutions.some((execution) => execution.sourceReportId === report.reportId);
    return report.status === 'failed' && report.rollbackPlan?.required === true && !hasRollbackExecution;
  }) ?? null;
  const readyWorkerJob = [...sortByCreatedAt(workerJobs)].reverse().find((job) => {
    const hasReport = workerReports.some((report) => report.jobId === job.jobId);
    return job.status === 'ready' && !hasReport;
  }) ?? null;
  const readyWorkerJobNeedsChangeWindow = readyWorkerJob?.mode === 'remote-ssh'
    && readyWorkerJob.changeWindow.required
    && (!readyWorkerJob.changeWindow.start || !readyWorkerJob.changeWindow.end);
  const repairWorkerJobSession = readyWorkerJobNeedsChangeWindow
    ? runnerSessions.find((session) => session.sessionId === readyWorkerJob.sessionId) ?? null
    : null;
  const domesticRelayPeerJob = readyWorkerJob ? isDomesticRelayPeerWorkerJob(readyWorkerJob) : false;
  const needsDomesticWgMaterialize = plan.kind === 'domestic' && domesticWireGuardMaterializeNeeded(plan, domesticWgSecret);
  const domesticWorkerRunReady = !(plan.kind === 'domestic' && needsDomesticWgMaterialize);
  const domesticWorkerRunBlockedReason = 'Materialize Domestic WG before running Domestic worker job gates';
  const hasPassedWorkerReport = workerReports.some((report) => report.status === 'passed');

  if (domesticPostInstallGate.blocked && plan.kind === 'domestic') {
    actions.push(internalServicePeerStatusAction(actionPolicy, plan));
    if (domesticWgSecret) {
      actions.push(internalServicePeerHandoffAction(actionPolicy, plan, domesticWgSecret));
      actions.push(internalServicePeerApplyAction(actionPolicy, plan, domesticWgSecret));
    }
    if (internalServicePeerK8sHostRunnerEnsureAvailable()) {
      actions.push(internalServicePeerHostRunnerEnsureAction(actionPolicy, plan));
    }
  }

  if (needsDomesticWgMaterialize) {
    actions.push(domesticWgMaterializeAction(actionPolicy, plan, 'WG secret/materialized artifacts must exist before Domestic preflight and remote SSH', domesticWgSecret));
  } else if (plan.kind === 'domestic' && domesticWgSecret && confirmedApply && !hasPassedWorkerReport) {
    actions.push(internalServicePeerStatusAction(actionPolicy, plan));
    actions.push(internalServicePeerHandoffAction(actionPolicy, plan, domesticWgSecret));
    actions.push(internalServicePeerApplyAction(actionPolicy, plan, domesticWgSecret));
    if (internalServicePeerK8sHostRunnerEnsureAvailable()) {
      actions.push(internalServicePeerHostRunnerEnsureAction(actionPolicy, plan));
    }
  }

  if (!readyPreflight) {
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.preflight.create',
      {
        path: `/internal/v1/site-slots/plans/${encodeURIComponent(plan.planId)}/preflight`,
        bodyTemplate: {
          mode: 'dry-run',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-preflight'
        }
      },
      plan.status === 'ready-for-preflight',
      `plan status is ${plan.status}`
    ));
  }

  if (readyPreflight && !confirmedApply) {
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.apply.confirm',
      {
        path: `/internal/v1/site-slots/plans/${encodeURIComponent(plan.planId)}/apply`,
        bodyTemplate: {
          mode: 'manual',
          confirmApply: true,
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-apply'
        }
      },
      true,
      'preflight evidence must be ready before apply'
    ));
  }

  if (latestReadyExecution) {
    const hasRunnerForExecution = runnerSessions.some((session) => session.runId === latestReadyExecution.runId);
    if (!hasRunnerForExecution) {
      const remoteRunnerReadinessFailures = plan.kind === 'domestic'
        ? domesticRemoteSshReadinessFailures(plan)
        : [];
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.runner.remote-ssh',
        {
          path: `/internal/v1/site-slots/executions/${encodeURIComponent(latestReadyExecution.runId)}/runner-sessions`,
          bodyTemplate: {
            mode: 'remote-ssh',
            confirmRemoteExecution: true,
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-runner-remote'
          }
        },
        remoteRunnerReadinessFailures.length === 0 && !needsDomesticWgMaterialize,
        remoteRunnerReadinessFailures.length
          ? remoteRunnerReadinessFailures.join('; ')
          : needsDomesticWgMaterialize
            ? domesticWorkerRunBlockedReason
          : 'execution must be ready before remote runner session starts'
      ));
      if (plan.kind !== 'domestic') {
        actions.push(contextualAction(
          actionPolicy,
          'site-slot.runner.simulate',
          {
            path: `/internal/v1/site-slots/executions/${encodeURIComponent(latestReadyExecution.runId)}/runner-sessions`,
            bodyTemplate: {
              mode: 'simulate',
              requestedBy: actionPolicy.principal.principalId,
              requestId: 'admin-ui-runner-simulate'
            }
          },
          true,
          'execution must be ready before runner session starts'
        ));
      }
    }
  }

  if (sessionNeedingWorker || repairWorkerJobSession) {
    const targetSession = sessionNeedingWorker ?? repairWorkerJobSession;
    const repairWorkerJob = sessionNeedingWorker ? null : readyWorkerJob;
    if (targetSession) {
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-job.create',
        {
          path: `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(targetSession.sessionId)}/worker-jobs`,
          bodyTemplate: {
            workerId: repairWorkerJob?.worker.workerId ?? 'worker-admin-1',
            workerKind: targetSession.mode === 'awx-shadow'
              ? 'awx-runner'
              : targetSession.kind === 'oversea'
                ? 'oversea-site-agent'
                : targetSession.kind === 'domestic'
                  ? 'domestic-runner'
                  : 'internal-runner',
            approvalId: repairWorkerJob?.approval.approvalId ?? 'approval-id',
            changeWindowStart: '<change-window-start-iso>',
            changeWindowEnd: '<change-window-end-iso>',
            retryLimit: 2,
            rollbackStrategy: 'restore-previous-state',
            requestedBy: actionPolicy.principal.principalId,
            requestId: repairWorkerJob ? 'admin-ui-worker-job-recreate-change-window' : 'admin-ui-worker-job'
          }
        },
        targetSession.kind === 'domestic' ? domesticWorkerRunReady : true,
        repairWorkerJob
          ? 'existing remote SSH worker job is missing a change window; recreate it before gate review'
          : targetSession.kind === 'domestic' && !domesticWorkerRunReady
            ? domesticWorkerRunBlockedReason
          : 'runner session must be ready for worker attachment'
      ));
    }
  }

  if (readyWorkerJob && !readyWorkerJobNeedsChangeWindow) {
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-run.remote-ssh-gate',
      {
        path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/remote-ssh-gate`,
        bodyTemplate: {
          confirmRemoteExecution: true,
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-run-remote-ssh-gate'
        }
      },
      domesticWorkerRunReady,
      domesticWorkerRunReady ? 'worker job must be ready before remote SSH gate review' : domesticWorkerRunBlockedReason
    ));
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-run.remote-ssh-readonly-probe',
      {
        path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/remote-ssh-readonly-probe`,
        bodyTemplate: {
          confirmRemoteExecution: true,
          confirmReadOnlyProbe: true,
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-run-remote-ssh-readonly-probe'
        }
      },
      domesticWorkerRunReady,
      domesticWorkerRunReady ? 'worker job must pass remote SSH gate before read-only probe' : domesticWorkerRunBlockedReason
    ));
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-run.artifact-push-remote-ssh-plan',
      {
        path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-artifact-push-remote-ssh-plan`,
        bodyTemplate: {
          confirmRemoteExecution: true,
          confirmPlanOnly: true,
          workerId: readyWorkerJob.worker.workerId,
          message: 'artifact-push remote SSH plan by admin-ui',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-run-remote-ssh-plan'
        }
      },
      domesticWorkerRunReady,
      domesticWorkerRunReady ? 'worker job must be ready before remote SSH plan report' : domesticWorkerRunBlockedReason
    ));
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-run.remote-ssh-execute',
      {
        path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-artifact-push-remote-ssh`,
        bodyTemplate: {
          confirmRemoteExecution: true,
          confirmWorkerHandoff: true,
          executeWorkerHandoff: true,
          workerInternalBaseUrl: '<worker-internal-base-url>',
          overseaCallbackBaseUrl: '<oversea-callback-base-url>',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-run-remote-ssh-execute'
        }
      },
      domesticWorkerRunReady,
      domesticWorkerRunReady ? 'worker job must be ready before remote SSH worker execution' : domesticWorkerRunBlockedReason
    ));
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-run.artifact-push-dry-run',
      {
        path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-artifact-push-dry-run`,
        bodyTemplate: {
          workerId: readyWorkerJob.worker.workerId,
          message: 'artifact-push dry-run by admin-ui',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-run-artifact-push-dry-run'
        }
      },
      domesticWorkerRunReady,
      domesticWorkerRunReady ? 'worker job must be ready before artifact-push dry-run' : domesticWorkerRunBlockedReason
    ));
    if (readyWorkerJob.kind === 'domestic' && domesticRelayPeerJob) {
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.domestic-relay-readonly-probe',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/domestic-relay-readonly-probe`,
          bodyTemplate: {
            confirmRelayReadOnlyProbe: true,
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-domestic-relay-readonly-probe'
          }
        },
        domesticWorkerRunReady,
        domesticWorkerRunReady ? 'Domestic worker job must be ready before relay read-only probe' : domesticWorkerRunBlockedReason
      ));
    }
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-run.artifact-push-fake-transport',
      {
        path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-artifact-push-fake-transport`,
        bodyTemplate: {
          confirmRemoteExecution: true,
          confirmFakeTransport: true,
          workerId: readyWorkerJob.worker.workerId,
          message: 'artifact-push fake transport by admin-ui',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-run-artifact-push-fake-transport'
        }
      },
      domesticWorkerRunReady,
      domesticWorkerRunReady ? 'worker job must be ready before fake transport report' : domesticWorkerRunBlockedReason
    ));
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-run.simulate',
      {
        path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-simulate`,
        bodyTemplate: {
          workerId: readyWorkerJob.worker.workerId,
          message: 'simulated worker run by admin-ui',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-run-simulate'
        }
      },
      domesticWorkerRunReady,
      domesticWorkerRunReady ? 'worker job must be ready before simulated worker run' : domesticWorkerRunBlockedReason
    ));
  }

  if (failedReportNeedingRollback) {
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.rollback.start',
      {
        path: `/internal/v1/site-slots/worker-reports/${encodeURIComponent(failedReportNeedingRollback.reportId)}/rollback-executions`,
        bodyTemplate: {
          mode: 'simulate',
          confirmRollback: true,
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-rollback'
        }
      },
      true,
      'failed worker report with rollback plan is required'
    ));
  }

  return actions.slice(0, 20);
}

function domesticWireGuardMaterializeNeeded(
  plan: SiteSlotPlan,
  secret: SiteSlotDomesticWireGuardSecret | null
): boolean {
  if (plan.kind !== 'domestic') return false;
  const expectedEndpoint = endpointFromPlanHost(plan, secret?.listenPort ?? 51280);
  return !secret
    || !domesticWireGuardArtifactReady(secret)
    || secret.status !== 'active'
    || secret.readiness.secretMaterial !== 'injected'
    || secret.readiness.publicEndpointStatus !== 'ready'
    || secret.readiness.missingSecretInputs.length > 0
    || !validWireGuardPrivateKey(secret.domesticRelayPrivateKey)
    || !validWireGuardPublicKey(secret.domesticRelayPublicKey)
    || !validWireGuardPrivateKey(secret.internalServicePrivateKey)
    || !validWireGuardPublicKey(secret.internalServicePublicKey)
    || Boolean(expectedEndpoint && secret.publicEndpoint !== expectedEndpoint);
}

function domesticWireGuardStaleReason(
  plan: SiteSlotPlan,
  secret: SiteSlotDomesticWireGuardSecret
): string | null {
  if (!domesticWireGuardMaterializeNeeded(plan, secret)) return null;
  if (!domesticWireGuardArtifactReady(secret)) {
    return 'Domestic WireGuard artifact manifest is not ready; run Materialize Domestic WG first';
  }
  const expectedEndpoint = endpointFromPlanHost(plan, secret.listenPort ?? 51280);
  if (expectedEndpoint && secret.publicEndpoint !== expectedEndpoint) {
    return `Domestic WG materialized artifact is stale for the selected plan: endpoint ${secret.publicEndpoint || 'unset'} != ${expectedEndpoint}`;
  }
  return 'Domestic WG materialized artifact is stale for the selected plan; run Materialize Domestic WG first';
}

function domesticWgMaterializeAction(
  actionPolicy: AdminActionPolicy,
  plan: SiteSlotPlan,
  blockedReason: string,
  secret: SiteSlotDomesticWireGuardSecret | null = null
): AdminActionDescriptor {
  return contextualAction(
    actionPolicy,
    'site-slot.domestic-wg.materialize',
    {
      path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(plan.siteId)}/materialize-ready`,
      bodyTemplate: {
        siteId: plan.siteId,
        planId: plan.planId,
        publicEndpoint: endpointFromPlanHost(plan, 51280),
        listenPort: 51280,
        internalDirectEnabled: true,
        internalDirectListenPort: 51280,
        domesticGatewayIp: '10.88.0.1',
        domesticGatewayCidr: '10.88.0.0/16',
        productRelayCidrs: secret ? domesticSecretProductRelayCidrs(secret) : ['10.89.0.0/16', '10.90.0.0/16'],
        userRelayCidr: '10.89.0.0/16',
        internalServiceIp: '10.88.88.88',
        internalServiceCidr: '10.88.0.0/16',
        guestRelayCidr: '10.90.0.0/16',
        rotateRelayKey: false,
        rotateInternalServiceKey: false,
        confirmRotate: false,
        requestedBy: actionPolicy.principal.principalId,
        requestId: 'admin-ui-domestic-wg-materialize'
      }
    },
    Boolean(plan.host),
    blockedReason
  );
}

function internalServicePeerHandoffAction(
  actionPolicy: AdminActionPolicy,
  plan: SiteSlotPlan,
  secret: SiteSlotDomesticWireGuardSecret
): AdminActionDescriptor {
  const paths = internalServicePeerArtifactPaths();
  const failures = internalServicePeerHandoffFailures(plan.siteId, secret, paths, {
    planId: plan.planId,
    confirmInternalServicePeerHandoff: true
  }, plan, false);
  return contextualAction(
    actionPolicy,
    'site-slot.internal-service-peer.handoff',
    {
      path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(plan.siteId)}/internal-service-peer-handoff`,
      bodyTemplate: {
        siteId: plan.siteId,
        planId: plan.planId,
        confirmInternalServicePeerHandoff: true,
        requestedBy: actionPolicy.principal.principalId,
        requestId: 'admin-ui-internal-service-peer-handoff'
      }
    },
    failures.length === 0,
    failures.join('; ') || 'Domestic WG materialize must complete before Internal service peer handoff'
  );
}

function internalServicePeerStatusAction(
  actionPolicy: AdminActionPolicy,
  plan: SiteSlotPlan
): AdminActionDescriptor {
  return contextualAction(
    actionPolicy,
    'site-slot.internal-service-peer.status',
    {
      path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(plan.siteId)}/internal-service-peer-status`,
      bodyTemplate: {
        siteId: plan.siteId,
        planId: plan.planId,
        requestedBy: actionPolicy.principal.principalId,
        requestId: 'admin-ui-internal-service-peer-status'
      }
    },
    true,
    'check Internal host-runner, WireGuard, egress-on, and 10.88.88.88 reachability before install'
  );
}

function internalServicePeerApplyAction(
  actionPolicy: AdminActionPolicy,
  plan: SiteSlotPlan,
  secret: SiteSlotDomesticWireGuardSecret
): AdminActionDescriptor {
  const paths = internalServicePeerArtifactPaths();
  const failures = internalServicePeerHandoffFailures(plan.siteId, secret, paths, {
    planId: plan.planId,
    confirmInternalServicePeerApply: true
  }, plan, false);
  return contextualAction(
    actionPolicy,
    'site-slot.internal-service-peer.apply',
    {
      path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(plan.siteId)}/internal-service-peer-apply`,
      bodyTemplate: {
        siteId: plan.siteId,
        planId: plan.planId,
        confirmInternalServicePeerApply: true,
        requestedBy: actionPolicy.principal.principalId,
        requestId: 'admin-ui-internal-service-peer-apply'
      }
    },
    failures.length === 0,
    failures.join('; ') || 'Internal service peer artifact must be ready before installing on the Internal runtime host'
  );
}

function internalServicePeerHostRunnerEnsureAction(
  actionPolicy: AdminActionPolicy,
  plan: SiteSlotPlan
): AdminActionDescriptor {
  return contextualAction(
    actionPolicy,
    'site-slot.internal-service-peer.host-runner.ensure',
    {
      path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(plan.siteId)}/internal-service-peer-host-runner`,
      bodyTemplate: {
        siteId: plan.siteId,
        planId: plan.planId,
        confirmInternalHostRunnerEnsure: true,
        requestedBy: actionPolicy.principal.principalId,
        requestId: 'admin-ui-internal-host-runner-ensure'
      }
    },
    internalServicePeerK8sHostRunnerEnsureAvailable(),
    'MX_INTERNAL_HOST_RUNNER_K8S_ENSURE_ENABLED and MX_INTERNAL_HOST_RUNNER_K8S_FALLBACK_ENABLED are required for k8s fallback'
  );
}

function isDomesticRelayPeerWorkerJob(job: SiteSlotWorkerJob): boolean {
  return job.kind === 'domestic' && (
    job.rollbackPolicy.strategy === 'restore-domestic-wg-peer-before-append'
    || job.worker.workerId.includes('domestic-relay')
  );
}

function pipelineHealth(
  plan: SiteSlotPlan,
  executions: SiteSlotExecutionRun[],
  runnerSessions: SiteSlotRunnerSession[],
  workerJobs: SiteSlotWorkerJob[],
  workerReports: SiteSlotWorkerReport[],
  rollbackExecutions: SiteSlotRollbackExecution[],
  rollbackReports: SiteSlotRollbackReport[]
): AdminPipelineHealth {
  if (rollbackReports.some((report) => report.status === 'failed') || rollbackExecutions.some((execution) => execution.status === 'failed')) {
    return 'failed';
  }
  if (rollbackReports.some((report) => report.status === 'running') || rollbackExecutions.some((execution) => execution.status === 'running' || execution.status === 'ready')) {
    return 'rollback';
  }
  if (rollbackReports.some((report) => report.status === 'passed') || rollbackExecutions.some((execution) => execution.status === 'passed')) {
    return 'passed';
  }
  if (workerReports.some((report) => report.status === 'failed') || workerJobs.some((job) => job.status === 'failed' || job.status === 'rollback-required')) {
    return 'failed';
  }
  if (
    executions.some((execution) => execution.status === 'blocked' || execution.status === 'requires-confirmation')
    || runnerSessions.some((session) => session.status === 'blocked')
    || workerJobs.some((job) => job.status === 'blocked')
    || workerReports.some((report) => report.status === 'blocked')
    || rollbackExecutions.some((execution) => execution.status === 'blocked')
    || rollbackReports.some((report) => report.status === 'blocked')
  ) {
    return 'blocked';
  }
  if (
    runnerSessions.some((session) => session.status === 'running' || session.status === 'queued')
    || workerJobs.some((job) => job.status === 'running')
    || workerReports.some((report) => report.status === 'running')
  ) {
    return 'running';
  }
  if (workerReports.some((report) => report.status === 'passed') || workerJobs.some((job) => job.status === 'passed')) {
    return 'passed';
  }
  if (executions.some((execution) => execution.status === 'ready') || plan.status === 'ready-for-preflight') {
    return 'ready';
  }
  return 'planned';
}

function adminDashboardNextActions(summaries: AdminSiteSlotPipelineSummary[]): string[] {
  if (summaries.some((summary) => summary.health === 'failed' || summary.health === 'rollback')) {
    return ['review-site-slot-recovery', 'open-rollback-or-worker-report'];
  }
  if (summaries.some((summary) => summary.health === 'blocked')) {
    return ['review-site-slot-gates', 'approve-or-fix-blocked-change'];
  }
  if (summaries.some((summary) => summary.health === 'running')) {
    return ['watch-running-site-slot-workers', 'collect-observability-evidence'];
  }
  return ['review-release-gates', 'plan-next-site-slot-change'];
}

function buildAdminActions(principal: PlatformPrincipal): AdminActionDescriptor[] {
  return adminActionTemplates().filter((template) => adminAwxFlowEnabled() || !isAwxAdminAction(template.actionId)).map((template) => {
    const missingScopes = template.requiredScopes.filter((scope) => !principal.scopes.includes(scope));
    return {
      ...template,
      allowed: missingScopes.length === 0,
      reason: missingScopes.length === 0
        ? 'principal satisfies required scopes'
        : `missing scopes: ${missingScopes.join(', ')}`
    };
  });
}

function adminAwxFlowEnabled(): boolean {
  const value = String(process.env.MX_ENABLE_AWX_FLOW ?? '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function isAwxAdminAction(actionId: string): boolean {
  return actionId === 'site-slot.runner.awx-shadow'
    || actionId === 'site-slot.domestic-relay-peer-append-awx.prepare'
    || actionId.startsWith('site-slot.worker-run.awx-');
}

function contextualAction(
  actionPolicy: AdminActionPolicy,
  actionId: string,
  overrides: Partial<Pick<AdminActionDescriptor, 'path' | 'bodyTemplate'>>,
  runnable: boolean,
  blockedReason: string
): AdminActionDescriptor {
  const base = actionPolicy.actions.find((action) => action.actionId === actionId);
  const fallback = buildAdminActions(actionPolicy.principal).find((action) => action.actionId === actionId);
  const action = base ?? fallback;
  if (!action) {
    return {
      actionId,
      label: actionId,
      category: 'site-slot',
      method: 'POST',
      path: overrides.path ?? '',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'medium',
      allowed: false,
      reason: 'action is not registered',
      confirmFields: [],
      bodyTemplate: overrides.bodyTemplate ?? {}
    };
  }
  const allowed = action.allowed && runnable;
  return {
    ...action,
    ...overrides,
    allowed,
    reason: action.allowed ? (runnable ? action.reason : blockedReason) : action.reason,
    bodyTemplate: overrides.bodyTemplate ?? action.bodyTemplate
  };
}

function assertPrincipalScope(actionPolicy: AdminActionPolicy, scope: string): void {
  if (!actionPolicy.principal.scopes.includes(scope)) {
    throw new ForbiddenException(`missing scope: ${scope}`);
  }
}

function sanitizeSiteId(value: string | null | undefined, fallback: string): string {
  const siteId = value?.trim() || fallback;
  return siteId.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:18090';
}

function isK8sInternalServiceBaseUrl(value: string | null | undefined): boolean {
  const normalized = value ? normalizeBaseUrl(value) : '';
  if (!normalized) return false;
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return host.endsWith('.svc.cluster.local') || host.endsWith('.svc') || host.includes('.svc.');
  } catch {
    return false;
  }
}

function normalizeWorkerInternalBaseUrl(value: string | null | undefined): string | null {
  if (!value || isK8sInternalServiceBaseUrl(value)) return null;
  return normalizeBaseUrl(value);
}

function workerInternalBaseUrlFromSources(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = normalizeWorkerInternalBaseUrl(value);
    if (normalized) return normalized;
  }
  return 'http://127.0.0.1:18090';
}

function normalizeOverseaCallbackBaseUrl(value: string | null | undefined): string | null {
  if (!value || isK8sInternalServiceBaseUrl(value)) return null;
  return normalizeBaseUrl(value);
}

function workerInternalBaseUrlFromBody(body: Record<string, unknown>): string {
  return workerInternalBaseUrlFromSources(
    stringValue(body.workerInternalBaseUrl),
    stringValue(body.internalBaseUrl),
    process.env.MX_INTERNAL_BASE_URL
  );
}

function overseaCallbackBaseUrlFromBody(body: Record<string, unknown>): string | null {
  return normalizeOverseaCallbackBaseUrl(stringValue(body.overseaCallbackBaseUrl));
}

function terminalTimeoutSeconds(value: unknown): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : 300;
  return Number.isFinite(raw) ? Math.max(5, Math.min(Math.floor(raw), 900)) : 300;
}

function overseaTerminalSshArgv(profile: SiteSlotSshProfile, command: string): string[] {
  const connectTimeoutSeconds = effectiveSshConnectTimeoutSeconds(profile.connectTimeoutSeconds);
  const args = [
    '-F', internalSshConfigFile(profile),
    '-o', `BatchMode=${profile.batchMode ?? 'yes'}`,
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    '-o', 'ConnectionAttempts=2',
    '-o', 'AddressFamily=inet',
    '-o', 'IPQoS=none',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', `StrictHostKeyChecking=${profile.strictHostKeyChecking ?? 'yes'}`
  ];
  if (internalSshUsesDefaultIsolatedConfig(profile)) {
    args.push('-o', 'ProxyCommand=none', '-o', 'ProxyJump=none');
  }
  if (profile.identityFile) args.push('-i', profile.identityFile);
  if (profile.knownHostsFile) args.push('-o', `UserKnownHostsFile=${profile.knownHostsFile}`);
  if (profile.hostKeyAlias) {
    args.push('-o', `HostKeyAlias=${profile.hostKeyAlias}`);
    args.push('-o', 'CheckHostIP=no');
  }
  args.push('-p', String(profile.sshPort ?? 22), `${profile.sshUser ?? 'root'}@${profile.host ?? '<host>'}`, command);
  return args;
}

function internalSshConfigFile(profile?: SiteSlotSshProfile | null): string {
  return profile?.sshConfigFile?.trim()
    || process.env.MX_SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || process.env.SITE_SLOT_SSH_CONFIG_FILE?.trim()
    || '/dev/null';
}

function internalSshUsesDefaultIsolatedConfig(profile?: SiteSlotSshProfile | null): boolean {
  return !profile?.sshConfigFile && !process.env.MX_SITE_SLOT_SSH_CONFIG_FILE && !process.env.SITE_SLOT_SSH_CONFIG_FILE;
}

function sshFailureDiagnosis(stderr: unknown, exitCode: unknown) {
  const text = String(stderr ?? '');
  const lower = text.toLowerCase();
  let category = 'unknown';
  let summary = 'SSH command failed';
  const nextActions = ['open-remote-terminal-inspect', 'check-ssh-profile-and-host-firewall'];
  if (lower.includes('connection timed out during banner exchange')) {
    category = 'ssh-banner-timeout';
    summary = 'TCP may be reachable, but SSH did not complete banner exchange before timeout';
    nextActions.push('verify-server-sshd-and-proxy-tun-path');
  } else if (lower.includes('connection timed out') || lower.includes('operation timed out')) {
    category = 'tcp-timeout';
    summary = 'TCP connection to SSH port timed out';
    nextActions.push('verify-port-22-firewall-security-group-or-local-tun-route');
  } else if (lower.includes('no route to host') || lower.includes('network is unreachable')) {
    category = 'network-unreachable';
    summary = 'Internal runner cannot route to the SSH host';
    nextActions.push('check-clash-tun-routing-or-k8s-node-egress');
  } else if (lower.includes('host key verification failed') || lower.includes('no ed25519 host key is known')) {
    category = 'host-key';
    summary = 'Host key verification failed';
    nextActions.push('rerun-bootstrap-key-or-refresh-known-hosts');
  } else if (lower.includes('permission denied')) {
    category = 'auth';
    summary = 'SSH authentication failed';
    nextActions.push('rotate-or-bootstrap-internal-managed-key');
  } else if (typeof exitCode === 'number' && exitCode !== 255) {
    category = 'remote-command';
    summary = 'SSH connected, but the remote command failed';
    nextActions.push('inspect-step-command-output');
  }
  return {
    category,
    summary,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    stderr: text.trim().slice(0, 1000),
    nextActions: Array.from(new Set(nextActions))
  };
}

function tcpConnectProbe(host: string | null | undefined, port: number | null | undefined, timeoutSeconds: number | null | undefined) {
  return new Promise((resolveProbe) => {
    if (!host) {
      resolveProbe({
        status: 'blocked',
        host: null,
        port: port ?? null,
        durationMs: 0,
        message: 'SSH host is not configured'
      });
      return;
    }
    const started = Date.now();
    const socket = netConnect({ host, port: Number(port || 22) });
    let settled = false;
    const finish = (status: string, message: string | null = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe({
        status,
        host,
        port: Number(port || 22),
        durationMs: Date.now() - started,
        message
      });
    };
    socket.setTimeout(Math.max(1000, Math.min(Number(timeoutSeconds || 10) * 1000, 30000)));
    socket.once('connect', () => finish('passed'));
    socket.once('timeout', () => finish('timeout', 'TCP connect timed out'));
    socket.once('error', (error) => finish('failed', error.message));
  });
}

function latestByCreatedAt<T extends { createdAt: string }>(items: T[]): T | null {
  return sortByCreatedAt(items).at(-1) ?? null;
}

function latestByUpdatedAt<T extends { updatedAt: string }>(items: T[]): T | null {
  return [...items].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1) ?? null;
}

function latestByStartedAt<T extends { startedAt: string }>(items: T[]): T | null {
  return sortByStartedAt(items).at(-1) ?? null;
}

function ensureBlocked(
  siteId: string,
  reason: string,
  blockedReasons: string[],
  steps: Array<Record<string, unknown>>,
  planId: string | null = null,
  jobId: string | null = null
) {
  return {
    siteId,
    status: 'blocked',
    reason,
    blockedReasons: blockedReasons.length ? blockedReasons : [reason],
    planId,
    jobId,
    reportId: null,
    steps,
    nextActions: ['fix-blocker', 'rerun-install-sync'],
    generatedAt: new Date().toISOString()
  };
}

function overseaEnsureStep(stepId: string, status: string, objectId: string | null | undefined, detail: Record<string, unknown> = {}) {
  return {
    stepId,
    status,
    objectId: objectId ?? null,
    detail
  };
}

function overseaShadowSetupSummary(
  siteId: string,
  profile: SiteSlotSshProfile,
  mihomo: LauncherNetworkMihomoSite,
  provider: AwxProviderConfig | null,
  awxCheck: AwxProviderCheckResult | null,
  plan: SiteSlotPlan,
  preflight: SiteSlotExecutionRun,
  apply: SiteSlotExecutionRun,
  session: SiteSlotRunnerSession,
  job: SiteSlotWorkerJob,
  report: SiteSlotWorkerReport | null
) {
  const blockedReasons = uniqueStrings([
    ...blockedWarnings(plan.warnings),
    ...blockedWarnings(preflight.warnings),
    ...blockedWarnings(apply.warnings),
    ...blockedWarnings(session.warnings),
    ...blockedWarnings(job.warnings)
  ]);
  const advisoryWarnings = uniqueStrings([
    ...profile.warnings,
    ...plan.warnings.filter((warning) => !warning.startsWith('blocked:')),
    ...preflight.warnings.filter((warning) => !warning.startsWith('blocked:')),
    ...apply.warnings.filter((warning) => !warning.startsWith('blocked:')),
    ...session.warnings.filter((warning) => !warning.startsWith('blocked:')),
    ...job.warnings.filter((warning) => !warning.startsWith('blocked:')),
    ...(provider ? [] : ['AWX provider is not configured; shadow evidence will use env/default naming only']),
    ...(awxCheck?.failures ?? []).map((failure) => `awx-check: ${failure}`)
  ]);
  const status = report
    ? report.status
    : blockedReasons.length > 0 ? 'blocked' : normalizeStageStatusForEnsure(job.status);
  const steps = [
    overseaEnsureStep('ssh-profile', 'passed', profile.profileId, {
      host: profile.host,
      sshUser: profile.sshUser,
      sshPort: profile.sshPort,
      identityFile: profile.identityFile,
      knownHostsFile: profile.knownHostsFile,
      sshConfigFile: profile.sshConfigFile
    }),
    overseaEnsureStep('internal-mihomo', 'passed', mihomo.siteId, {
      subscriptionBaseUrl: mihomo.subscriptionBaseUrl,
      publicHost: mihomo.publicHost
    }),
    overseaEnsureStep('awx-provider', provider ? 'passed' : 'planned', provider?.providerId ?? null, {
      baseUrl: provider?.baseUrl ?? null,
      organization: provider?.organization ?? null,
      project: provider?.project ?? null
    }),
    overseaEnsureStep('awx-readonly-check', awxCheck ? normalizeStageStatusForEnsure(awxCheck.status) : 'planned', awxCheck?.providerId ?? null, {
      status: awxCheck?.status ?? null,
      endpoints: awxCheck?.endpoints.length ?? 0,
      failures: awxCheck?.failures ?? []
    }),
    overseaEnsureStep('plan', normalizeStageStatusForEnsure(plan.status), plan.planId, { status: plan.status }),
    overseaEnsureStep('preflight', normalizeStageStatusForEnsure(preflight.status), preflight.runId, { status: preflight.status }),
    overseaEnsureStep('apply', normalizeStageStatusForEnsure(apply.status), apply.runId, {
      status: apply.status,
      confirmApply: apply.confirmApply
    }),
    overseaEnsureStep('awx-shadow-runner', normalizeStageStatusForEnsure(session.status), session.sessionId, {
      status: session.status,
      mode: session.mode
    }),
    overseaEnsureStep('worker-job', normalizeStageStatusForEnsure(job.status), job.jobId, {
      status: job.status,
      workerKind: job.worker.kind
    }),
    overseaEnsureStep('awx-shadow-report', report ? normalizeStageStatusForEnsure(report.status) : 'blocked', report?.reportId ?? null, {
      status: report?.status ?? null,
      stepReports: report?.stepReports.length ?? 0
    })
  ];
  return {
    setupId: `oversea_shadow_${job.jobId}`,
    siteId,
    status,
    mode: 'awx-shadow',
    boundary: 'internal-shadow-no-remote-mutation',
    providerId: provider?.providerId ?? null,
    awxCheckStatus: awxCheck?.status ?? null,
    profileId: profile.profileId,
    planId: plan.planId,
    preflightRunId: preflight.runId,
    applyRunId: apply.runId,
    runnerSessionId: session.sessionId,
    jobId: job.jobId,
    reportId: report?.reportId ?? null,
    blockedReasons,
    warnings: advisoryWarnings,
    steps,
    nextActions: report
      ? ['review-awx-shadow-report', 'verify-awx-provider-readonly-check', 'replace-shadow-with-awx-api-launch']
      : ['fix-shadow-setup-blocker', 'rerun-oversea-shadow-setup'],
    generatedAt: new Date().toISOString()
  };
}

function blockedWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => warning.startsWith('blocked:'));
}

function normalizeStageStatusForEnsure(status: string | null | undefined): string {
  if (status === 'passed' || status === 'completed' || status === 'active') return 'passed';
  if (status === 'ready' || status === 'queued' || status === 'ready-for-preflight') return 'ready';
  if (status === 'running') return 'running';
  if (status === 'failed' || status === 'rollback-required') return 'failed';
  if (status === 'blocked' || status === 'requires-confirmation' || status === 'paused') return 'blocked';
  return status || 'planned';
}

function sshProfileBlockingReasons(profile: SiteSlotSshProfile): string[] {
  return [
    ...(profile.status !== 'active' ? [`SSH profile is ${profile.status}`] : []),
    ...(!profile.host ? ['SSH profile host is missing'] : []),
    ...(!profile.identityFile ? ['SSH identity file path is missing'] : []),
    ...(!profile.knownHostsFile ? ['SSH known_hosts file path is missing'] : []),
    ...(profile.sshConfigFile && !existsSync(profile.sshConfigFile) ? [`SSH config file does not exist: ${profile.sshConfigFile}`] : []),
    ...(!profile.hostKeyAlias && profile.strictHostKeyChecking === 'yes' ? ['Host alias is recommended when strict host key checking is enabled'] : []),
    ...profile.warnings.filter((warning) => warning.startsWith('missing:'))
  ];
}

function chooseOverseaPipeline(pipelines: AdminSiteSlotPipeline[]): AdminSiteSlotPipeline | null {
  const open = pipelines.filter((pipeline) => !['passed', 'failed', 'rollback'].includes(pipeline.summary.health));
  const preferred = open.length ? open : pipelines;
  return preferred
    .slice()
    .sort((left, right) => pipelineOperationalScoreForOverview(right) - pipelineOperationalScoreForOverview(left)
      || right.summary.latestUpdatedAt.localeCompare(left.summary.latestUpdatedAt))[0] ?? null;
}

function pipelineOperationalScoreForOverview(pipeline: AdminSiteSlotPipeline): number {
  const stageScore = {
    'worker-report': 70,
    'worker-job': 90,
    'runner-session': 80,
    execution: 60,
    plan: 40,
    'rollback-report': 10,
    'rollback-execution': 20
  }[pipeline.summary.currentStage] ?? 0;
  return stageScore + Math.min(pipelineObjectCountForOverview(pipeline.summary), 10);
}

function pipelineObjectCountForOverview(summary: AdminSiteSlotPipelineSummary): number {
  return Number(summary.counts.executions || 0)
    + Number(summary.counts.runnerSessions || 0)
    + Number(summary.counts.workerJobs || 0)
    + Number(summary.counts.workerReports || 0)
    + Number(summary.counts.rollbackExecutions || 0)
    + Number(summary.counts.rollbackReports || 0);
}

function overseaSiteStatus(
  profile: SiteSlotSshProfile | null,
  pipeline: AdminSiteSlotPipeline | null,
  session: SiteSlotRunnerSession | null,
  job: SiteSlotWorkerJob | null,
  report: SiteSlotWorkerReport | null
): string {
  if (!profile) return 'needs-ssh-profile';
  if (sshProfileBlockingReasons(profile).length > 0) return 'blocked';
  if (!pipeline) return 'needs-plan';
  if (report?.status === 'failed') return 'failed';
  if (report?.status === 'blocked') return 'blocked';
  if (report?.status === 'passed' && workerReportHasRemoteExecution(report)) return 'installed';
  if (report?.status === 'passed') return 'evidence-only';
  if (job?.status === 'ready' || session?.status === 'queued') return 'ready-to-install';
  if (job?.status === 'blocked' || session?.status === 'blocked' || pipeline.summary.health === 'blocked') return 'blocked';
  if (pipeline.summary.health === 'running') return 'installing';
  return pipeline.summary.health === 'ready' ? 'ready-to-install' : pipeline.summary.health;
}

function workerReportHasRemoteExecution(report: SiteSlotWorkerReport): boolean {
  return report.stepReports.some((step) => {
    const evidence = parseJsonRecord(step.stdout ?? '');
    return evidence?.mode === 'artifact-push-remote-ssh' && evidence.execution === 'executed';
  });
}

function workerReportModes(report: SiteSlotWorkerReport): string[] {
  return uniqueStrings(report.stepReports.map((step) => stringValue(parseJsonRecord(step.stdout ?? '')?.mode)).filter((value): value is string => Boolean(value)));
}

function reportStepStatus(report: SiteSlotWorkerReport, sourcePrefix: string): string | null {
  const step = report.stepReports.find((item) => item.sourceId.startsWith(sourcePrefix) || item.stepId.startsWith(sourcePrefix));
  return step?.status ?? null;
}

function latestWorkerReportFailureSummary(workerReports: SiteSlotWorkerReport[]): { phase: string; stepId: string; status: string; message: string } | null {
  const report = latestByCreatedAt(workerReports.filter((item) => item.status === 'failed' || item.status === 'blocked'));
  return report ? workerReportFailureSummary(report) : null;
}

function workerReportFailureSummary(report: SiteSlotWorkerReport): { phase: string; stepId: string; status: string; message: string } | null {
  const step = report.stepReports.find((item) => item.status === 'failed')
    ?? report.stepReports.find((item) => item.status === 'blocked');
  if (!step) return null;
  const evidence = parseJsonRecord(step.stdout ?? '');
  const executionResult = asRecord(evidence?.executionResult);
  const diagnosis = asRecord(executionResult?.diagnosis);
  const rawMessage = stringValue(step.stderr)
    ?? stringValue(executionResult?.stderr)
    ?? stringValue(executionResult?.stdout)
    ?? (diagnosis ? `${stringValue(diagnosis.category) ?? 'ssh'}: ${stringValue(diagnosis.summary) ?? 'remote execution failed'}` : null)
    ?? 'worker step failed';
  return {
    phase: stringValue(evidence?.phaseId) ?? phaseIdFromSource(step.sourceId),
    stepId: step.sourceId || step.stepId,
    status: step.status,
    message: compactFailureMessage(rawMessage)
  };
}

function compactFailureMessage(value: string): string {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' / ')
    .slice(0, 240);
}

function overseaServiceCard(name: string, status: string, detail: string | null) {
  return {
    name,
    status: normalizeStageStatusForEnsure(status),
    detail: detail ?? '-'
  };
}

function overseaNextActions(
  status: string,
  profile: SiteSlotSshProfile | null,
  mihomoSite: unknown,
  reachability: { verdict?: string; nextActions?: string[] } | null,
  report: SiteSlotWorkerReport | null
): string[] {
  if (!profile) return ['create-ssh-profile', 'bootstrap-internal-managed-key'];
  if (sshProfileBlockingReasons(profile).length > 0) return ['fix-ssh-profile', 'rerun-readonly-probe'];
  if (!mihomoSite) return ['issue-internal-hysteria2-accounts', 'publish-mihomo-site'];
  if (status === 'installed') {
    return uniqueStrings([
      'manage-mihomo-subscriptions',
      ...(reachability?.verdict === 'h-endpoint-ready' ? ['monitor-oversea-runtime'] : ['prepare-domestic-wg-h2i-delivery']),
      ...((reachability?.nextActions ?? []))
    ]);
  }
  if (status === 'ready-to-install') return ['install-sync-oversea', 'or-review-advanced-audit-actions'];
  if (status === 'failed' || status === 'blocked') return ['open-evidence-history', 'fix-blocker', 'rerun-install-sync'];
  if (report?.status === 'passed') return ['rerun-real-remote-install', 'review-evidence-mode'];
  return ['create-plan', 'install-sync-oversea'];
}

function adminActionTemplates(): Array<Omit<AdminActionDescriptor, 'allowed' | 'reason'>> {
  return [
    {
      actionId: 'release.plan.create',
      label: 'Create Release Plan',
      category: 'release',
      method: 'POST',
      path: '/internal/v1/release-management/plans',
      requiredScopes: ['release.manage'],
      gate: 'manual-evidence',
      risk: 'medium',
      confirmFields: [],
      bodyTemplate: {
        releaseId: 'rel_admin_ui',
        channel: 'shadow',
        appId: 'h2o',
        e2eResult: 'passed',
        createdBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.plan.create',
      label: 'Create Site Slot Plan',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/plans',
      requiredScopes: ['site-slot.manage'],
      gate: 'none',
      risk: 'low',
      confirmFields: [],
      bodyTemplate: {
        kind: 'domestic',
        siteId: 'domestic-main',
        sshProfileId: null,
        host: '<domestic-public-host-or-ip>',
        sshUser: 'root',
        hasDocker: true,
        hasOutboundInternet: false
      }
    },
    {
      actionId: 'site-slot.domestic-runtime-config.upsert',
      label: 'Save Domestic Runtime',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/config-center/domestic-runtime-configs',
      requiredScopes: ['site-slot.manage'],
      gate: 'none',
      risk: 'medium',
      confirmFields: [],
      bodyTemplate: {
        siteId: 'domestic-main',
        status: 'active',
        edgeBind: '0.0.0.0',
        edgePort: 18090,
        bootstrapProtocol: 'http',
        bootstrapHost: 'api.mxinfo-inc.cn',
        bootstrapPort: 18090,
        internalBaseUrl: 'http://10.88.88.88:18090',
        internalApiUpstream: 'http://10.88.88.88:18090',
        internalH2iUpstream: 'http://10.88.88.88:18090',
        dnsBind: '0.0.0.0',
        dnsPort: 53,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.domestic-runtime-config.apply',
      label: 'Apply Domestic Runtime',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/config-center/domestic-runtime-configs/:siteId/apply',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmDomesticRuntimeApply'],
      bodyTemplate: {
        siteId: 'domestic-main',
        planId: null,
        sshProfileId: null,
        saveBeforeApply: true,
        edgeBind: '0.0.0.0',
        edgePort: 18090,
        bootstrapProtocol: 'http',
        bootstrapHost: 'api.mxinfo-inc.cn',
        bootstrapPort: 18090,
        internalBaseUrl: 'http://10.88.88.88:18090',
        internalApiUpstream: 'http://10.88.88.88:18090',
        internalH2iUpstream: 'http://10.88.88.88:18090',
        dnsBind: '0.0.0.0',
        dnsPort: 53,
        confirmDomesticRuntimeApply: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.preflight.create',
      label: 'Create Preflight',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/plans/:planId/preflight',
      requiredScopes: ['site-slot.manage'],
      gate: 'none',
      risk: 'low',
      confirmFields: [],
      bodyTemplate: {
        mode: 'dry-run',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.apply.confirm',
      label: 'Confirm Apply Manifest',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/plans/:planId/apply',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-apply',
      risk: 'high',
      confirmFields: ['confirmApply'],
      bodyTemplate: {
        mode: 'manual',
        confirmApply: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.domestic-wg.materialize',
      label: 'Materialize Domestic WG',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/config-center/domestic-wg-secrets/:siteId/materialize-ready',
      requiredScopes: ['site-slot.manage'],
      gate: 'internal-secret-materialize',
      risk: 'medium',
      confirmFields: [],
      bodyTemplate: {
        siteId: 'domestic-main',
        planId: '<plan-id>',
        publicEndpoint: '<domestic-public-endpoint>',
        listenPort: 51280,
        internalDirectEnabled: true,
        internalDirectListenPort: 51280,
        domesticGatewayIp: '10.88.0.1',
        domesticGatewayCidr: '10.88.0.0/16',
        productRelayCidrs: ['10.89.0.0/16', '10.90.0.0/16'],
        userRelayCidr: '10.89.0.0/16',
        internalServiceIp: '10.88.88.88',
        internalServiceCidr: '10.88.0.0/16',
        guestRelayCidr: '10.90.0.0/16',
        rotateRelayKey: false,
        rotateInternalServiceKey: false,
        confirmRotate: false,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.internal-service-peer.handoff',
      label: 'Internal Service Peer Handoff',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/config-center/domestic-wg-secrets/:siteId/internal-service-peer-handoff',
      requiredScopes: ['site-slot.manage'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmInternalServicePeerHandoff'],
      bodyTemplate: {
        siteId: 'domestic-main',
        planId: '<plan-id>',
        confirmInternalServicePeerHandoff: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.runner.simulate',
      label: 'Start Simulated Runner',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/executions/:runId/runner-sessions',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'low',
      confirmFields: [],
      bodyTemplate: {
        mode: 'simulate',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.runner.remote-ssh',
      label: 'Queue Remote SSH Runner',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/executions/:runId/runner-sessions',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmRemoteExecution'],
      bodyTemplate: {
        mode: 'remote-ssh',
        confirmRemoteExecution: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.runner.awx-shadow',
      label: 'Queue AWX Shadow Runner',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/executions/:runId/runner-sessions',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'low',
      confirmFields: [],
      bodyTemplate: {
        mode: 'awx-shadow',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.domestic-relay-peer-append-awx.prepare',
      label: 'Prepare Domestic Relay Append AWX Job',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/executions/:runId/prepare-domestic-relay-peer-append-awx',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'medium',
      confirmFields: ['confirmAwxLaunchPrepare'],
      bodyTemplate: {
        confirmAwxLaunchPrepare: true,
        approvalId: 'approval-domestic-relay-peer-append-awx',
        changeWindowStart: '<change-window-start-iso>',
        changeWindowEnd: '<change-window-end-iso>',
        workerId: 'worker-awx-domestic-relay',
        workerKind: 'awx-runner',
        retryLimit: 1,
        rollbackStrategy: 'restore-domestic-wg-peer-before-append',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.domestic-relay-peer-append-ssh.prepare',
      label: 'Prepare Domestic Relay Append SSH Job',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/executions/:runId/prepare-domestic-relay-peer-append-ssh',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmRemoteExecution', 'confirmRelayPeerAppendSshPrepare', 'approvalId', 'changeWindowStart', 'changeWindowEnd'],
      bodyTemplate: {
        confirmRemoteExecution: true,
        confirmRelayPeerAppendSshPrepare: true,
        approvalId: 'approval-domestic-relay-peer-append',
        changeWindowStart: '<change-window-start-iso>',
        changeWindowEnd: '<change-window-end-iso>',
        workerId: 'worker-domestic-relay',
        workerKind: 'domestic-runner',
        retryLimit: 1,
        rollbackStrategy: 'restore-domestic-wg-peer-before-append',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.internal-service-peer.status',
      label: 'Internal Service Peer Status',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/config-center/domestic-wg-secrets/:siteId/internal-service-peer-status',
      requiredScopes: ['site-slot.manage'],
      gate: 'none',
      risk: 'low',
      confirmFields: [],
      bodyTemplate: {
        siteId: 'domestic-main',
        planId: '<plan-id>',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.internal-service-peer.host-runner.ensure',
      label: 'Ensure Internal K8s Host Runner Fallback',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/config-center/domestic-wg-secrets/:siteId/internal-service-peer-host-runner',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmInternalHostRunnerEnsure'],
      bodyTemplate: {
        siteId: 'domestic-main',
        planId: '<plan-id>',
        confirmInternalHostRunnerEnsure: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.internal-service-peer.apply',
      label: 'Install Internal Service Peer',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/config-center/domestic-wg-secrets/:siteId/internal-service-peer-apply',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmInternalServicePeerApply'],
      bodyTemplate: {
        siteId: 'domestic-main',
        planId: '<plan-id>',
        confirmInternalServicePeerApply: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.internal-service-peer.sync-domestic-key',
      label: 'Sync Domestic WG Key',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/config-center/domestic-wg-secrets/:siteId/internal-service-peer-sync-domestic-key',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmDomesticPeerKeySync'],
      bodyTemplate: {
        siteId: 'domestic-main',
        planId: '<plan-id>',
        confirmDomesticPeerKeySync: true,
        confirmAdoptDomesticRuntimeRelayPublicKey: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-job.create',
      label: 'Create Worker Job',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/runner-sessions/:sessionId/worker-jobs',
      requiredScopes: ['site-slot.execute'],
      gate: 'change-window',
      risk: 'medium',
      confirmFields: ['approvalId', 'changeWindowStart', 'changeWindowEnd'],
      bodyTemplate: {
        workerId: 'worker-admin-1',
        workerKind: 'internal-runner',
        approvalId: 'approval-id',
        changeWindowStart: '<change-window-start-iso>',
        changeWindowEnd: '<change-window-end-iso>',
        retryLimit: 2,
        rollbackStrategy: 'restore-previous-state',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.awx-sync-plan',
      label: 'AWX Sync Plan',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/awx-sync-plan',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'low',
      confirmFields: [],
      bodyTemplate: {
        workerId: 'worker-awx-api',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.awx-credential-sync',
      label: 'Sync AWX Credential',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-awx-credential-sync',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmAwxCredentialSync'],
      bodyTemplate: {
        confirmAwxCredentialSync: true,
        timeoutSeconds: 120,
        workerId: 'worker-awx-api',
        message: 'AWX credential sync by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.awx-object-sync',
      label: 'Sync AWX Objects',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-awx-object-sync',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'medium',
      confirmFields: ['confirmAwxSync'],
      bodyTemplate: {
        confirmAwxSync: true,
        timeoutSeconds: 120,
        workerId: 'worker-awx-api',
        message: 'AWX object sync by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.awx-shadow',
      label: 'AWX Shadow Report',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-awx-shadow',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'low',
      confirmFields: [],
      bodyTemplate: {
        workerId: 'worker-awx-shadow',
        message: 'AWX shadow worker run by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.awx-launch',
      label: 'Launch AWX Job',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-awx-launch',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmAwxLaunch'],
      bodyTemplate: {
        confirmAwxLaunch: true,
        waitForCompletion: true,
        timeoutSeconds: 180,
        pollIntervalMs: 2000,
        workerId: 'worker-awx-api',
        message: 'AWX API launch by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.simulate',
      label: 'Run Simulated Worker',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-simulate',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'low',
      confirmFields: [],
      bodyTemplate: {
        workerId: 'worker-admin-1',
        message: 'simulated worker run by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.remote-ssh-gate',
      label: 'Remote SSH Gate Check',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/remote-ssh-gate',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'medium',
      confirmFields: [],
      bodyTemplate: {
        confirmRemoteExecution: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.remote-ssh-execute',
      label: 'Remote SSH Worker Execute',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-artifact-push-remote-ssh',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmRemoteExecution', 'confirmWorkerHandoff'],
      bodyTemplate: {
        confirmRemoteExecution: true,
        confirmWorkerHandoff: true,
        executeWorkerHandoff: true,
        workerInternalBaseUrl: '<worker-internal-base-url>',
        overseaCallbackBaseUrl: '<oversea-callback-base-url>',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.remote-ssh-readonly-probe',
      label: 'Remote SSH Readonly Probe',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/remote-ssh-readonly-probe',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'medium',
      confirmFields: ['confirmRemoteExecution', 'confirmReadOnlyProbe'],
      bodyTemplate: {
        confirmRemoteExecution: true,
        confirmReadOnlyProbe: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.artifact-push-dry-run',
      label: 'Artifact Push Dry Run',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-artifact-push-dry-run',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'medium',
      confirmFields: [],
      bodyTemplate: {
        workerId: 'worker-admin-1',
        message: 'artifact-push dry-run by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.artifact-push-remote-ssh-plan',
      label: 'Remote SSH Plan Report',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-artifact-push-remote-ssh-plan',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'medium',
      confirmFields: ['confirmRemoteExecution', 'confirmPlanOnly'],
      bodyTemplate: {
        confirmRemoteExecution: true,
        confirmPlanOnly: true,
        workerId: 'worker-admin-1',
        message: 'artifact-push remote SSH plan by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.domestic-relay-peer-plan',
      label: 'Domestic Relay Peer Plan',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-domestic-relay-peer-plan',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'medium',
      confirmFields: ['confirmRelayPeerPlan'],
      bodyTemplate: {
        confirmRelayPeerPlan: true,
        leaseId: '<launcher-network-lease-id>',
        peerRole: 'guest',
        leaseIp: '<home-lease-ip>',
        publicKey: '<home-wg-public-key>',
        workerId: 'worker-admin-1',
        message: 'Domestic relay peer plan by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.domestic-relay-readonly-probe',
      label: 'Domestic Relay Readonly Probe',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/domestic-relay-readonly-probe',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'medium',
      confirmFields: ['confirmRelayReadOnlyProbe'],
      bodyTemplate: {
        confirmRelayReadOnlyProbe: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.domestic-relay-peer-append',
      label: 'Domestic Relay Peer Append Handoff',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/domestic-relay-peer-append',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmRelayPeerAppend', 'confirmRelayReadOnlyProbeReviewed', 'confirmRelayPeerPlanReviewed'],
      bodyTemplate: {
        confirmRelayPeerAppend: true,
        confirmRelayReadOnlyProbeReviewed: true,
        confirmRelayPeerPlanReviewed: true,
        leaseId: '<launcher-network-lease-id>',
        peerRole: 'guest',
        leaseIp: '<home-lease-ip>',
        publicKey: '<home-wg-public-key>',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.domestic-relay-peer-append-ssh',
      label: 'Execute Domestic Relay Peer Append',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-domestic-relay-peer-append-ssh',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-remote-execution',
      risk: 'high',
      confirmFields: ['confirmRemoteExecution', 'confirmRelayPeerAppendSsh', 'confirmRelayPeerAppend', 'confirmRelayReadOnlyProbeReviewed', 'confirmRelayPeerPlanReviewed'],
      bodyTemplate: {
        confirmRemoteExecution: true,
        confirmRelayPeerAppendSsh: true,
        confirmRelayPeerAppend: true,
        confirmRelayReadOnlyProbeReviewed: true,
        confirmRelayPeerPlanReviewed: true,
        leaseId: '<launcher-network-lease-id>',
        peerRole: 'guest',
        leaseIp: '<home-lease-ip>',
        publicKey: '<home-wg-public-key>',
        workerId: 'worker-admin-1',
        message: 'Domestic relay peer append SSH by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-run.artifact-push-fake-transport',
      label: 'Fake Worker Report',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/run-artifact-push-fake-transport',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-fake-transport',
      risk: 'medium',
      confirmFields: ['confirmRemoteExecution', 'confirmFakeTransport'],
      bodyTemplate: {
        confirmRemoteExecution: true,
        confirmFakeTransport: true,
        workerId: 'worker-admin-1',
        message: 'artifact-push fake transport by admin-ui',
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'site-slot.worker-report.record',
      label: 'Record Worker Report',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-jobs/:jobId/reports',
      requiredScopes: ['site-slot.execute'],
      gate: 'manual-evidence',
      risk: 'medium',
      confirmFields: ['stepReports'],
      bodyTemplate: {
        workerId: 'worker-admin-1',
        status: 'passed',
        message: 'manual evidence recorded by admin-ui',
        stepReports: []
      }
    },
    {
      actionId: 'site-slot.rollback.start',
      label: 'Start Rollback',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/worker-reports/:reportId/rollback-executions',
      requiredScopes: ['site-slot.execute'],
      gate: 'confirm-rollback',
      risk: 'high',
      confirmFields: ['confirmRollback'],
      bodyTemplate: {
        mode: 'simulate',
        confirmRollback: true,
        requestedBy: 'admin-ui'
      }
    },
    {
      actionId: 'dns.coredns.apply',
      label: 'Apply CoreDNS ConfigMap',
      category: 'dns',
      method: 'POST',
      path: '/internal/v1/dns/coredns/configmap/apply',
      requiredScopes: ['dns.manage'],
      gate: 'confirm-apply',
      risk: 'high',
      confirmFields: ['confirmApply'],
      bodyTemplate: {
        confirmApply: true,
        namespace: 'mx-dns',
        configMapName: 'coredns'
      }
    },
    {
      actionId: 'dns.gateway.apply',
      label: 'Apply Internal Gateway ConfigMap',
      category: 'dns',
      method: 'POST',
      path: '/internal/v1/dns/gateway/configmap/apply',
      requiredScopes: ['dns.manage'],
      gate: 'confirm-apply',
      risk: 'high',
      confirmFields: ['confirmApply'],
      bodyTemplate: {
        confirmApply: true,
        gatewayApplyBackend: 'k8s',
        namespace: 'mx-internal-shadow',
        configMapName: 'mx-internal-gateway-caddy'
      }
    },
    {
      actionId: 'dns.gateway.apply-host-nginx',
      label: 'Apply Internal Gateway Host Nginx',
      category: 'dns',
      method: 'POST',
      path: '/internal/v1/dns/gateway/configmap/apply',
      requiredScopes: ['dns.manage'],
      gate: 'confirm-apply',
      risk: 'high',
      confirmFields: ['confirmApply'],
      bodyTemplate: {
        confirmApply: true,
        gatewayApplyBackend: 'host-nginx',
        gatewayHostNginxConfigPath: '/etc/nginx/conf.d/mx-gateway.generated.conf'
      }
    },
    {
      actionId: 'rbac.user.manage',
      label: 'Manage Users and Roles',
      category: 'rbac',
      method: 'POST',
      path: '/internal/v1/user-center/users',
      requiredScopes: ['rbac.manage'],
      gate: 'manual-evidence',
      risk: 'high',
      confirmFields: [],
      bodyTemplate: {
        userId: 'usr_operator',
        email: 'operator@mx.local',
        roleIds: ['mx-user']
      }
    }
  ];
}

function shadowAdminPrincipal(): PlatformPrincipal {
  const scopes = uniqueStrings(adminActionTemplates().flatMap((action) => action.requiredScopes).concat([
    'admin.dashboard.read',
    'sdk.config.snapshot',
    'sdk.dns.evaluate',
    'sdk.release.read'
  ]));
  return {
    principalId: 'user:usr_demo_admin',
    kind: 'user',
    tenantId: 'tenant_default',
    orgIds: ['org_default'],
    displayName: 'Demo Admin',
    userId: 'usr_demo_admin',
    anonymousPrincipalId: null,
    serviceAccountId: null,
    roles: ['mx-admin'],
    scopes
  };
}

function buildLauncherServiceVipSmokes(input: {
  apps: AppCenterApp[];
  products: LauncherProductNetwork[];
  leases: LauncherNetworkLease[];
  dnsRoutes: DnsReverseProxyRoute[];
  domesticSecrets: SiteSlotDomesticWireGuardSecret[];
  generatedAt: string;
}): { generatedAt: string; smokes: AdminLauncherServiceVipSmoke[] } {
  const products = new Map(input.products.map((product) => [normalizeLauncherId(product.productId), product]));
  const dnsRoutes = input.dnsRoutes;
  const domesticSecrets = input.domesticSecrets;
  const smokes = input.apps
    .map((app) => buildLauncherServiceVipSmoke({
      app,
      product: products.get(normalizeLauncherId(app.productNetworkId || app.appId)) ?? null,
      channelProduct: products.get(launcherServiceVipSmokeChannelProductId(app)) ?? null,
      leases: input.leases,
      dnsRoutes,
      domesticSecrets,
      generatedAt: input.generatedAt
    }))
    .sort((left, right) => left.appId.localeCompare(right.appId));
  return {
    generatedAt: input.generatedAt,
    smokes
  };
}

function buildLauncherDomesticProductCidrSync(
  siteId: string,
  products: LauncherProductNetwork[],
  secret: SiteSlotDomesticWireGuardSecret | null
) {
  const scopedProducts = products
    .filter((product) => product.enabled !== false)
    .filter((product) => product.mode === 'standalone')
    .filter((product) => (product.defaultDomesticSiteId || 'domestic-main') === siteId)
    .sort((left, right) => left.productId.localeCompare(right.productId));
  const rawRequiredCidrs = scopedProducts.flatMap((product) => launcherProductRelayCidrs(product));
  const invalidRequiredCidrs = uniqueConfigStrings(rawRequiredCidrs.filter((cidr) => !parseIpv4Cidr(cidr)));
  const requiredProductRelayCidrs = uniqueConfigStrings(rawRequiredCidrs.filter((cidr) => Boolean(parseIpv4Cidr(cidr))));
  const previousProductRelayCidrs = secret ? domesticSecretProductRelayCidrsForSync(secret) : [];
  const addedProductRelayCidrs = requiredProductRelayCidrs.filter((cidr) => {
    return !previousProductRelayCidrs.some((relayCidr) => ipv4CidrContainsCidr(relayCidr, cidr));
  });
  const blockedReasons = [
    ...(secret ? [] : [`Domestic WG secret is missing for ${siteId}. Materialize Domestic WG first.`]),
    ...invalidRequiredCidrs.map((cidr) => `Invalid ProductNetwork CIDR: ${cidr}`)
  ];
  return {
    syncId: `launcher_service_vip_domestic_product_cidrs_${siteId}`,
    status: blockedReasons.length ? 'blocked' as const : addedProductRelayCidrs.length ? 'ready' as const : 'passed' as const,
    siteId,
    previousProductRelayCidrs,
    requiredProductRelayCidrs,
    addedProductRelayCidrs,
    productRelayCidrs: uniqueConfigStrings([...previousProductRelayCidrs, ...addedProductRelayCidrs]),
    products: scopedProducts.map((product) => ({
      productId: product.productId,
      displayName: product.displayName,
      mode: product.mode,
      serviceVip: product.serviceVip,
      relayCidrs: launcherProductRelayCidrs(product),
      userCidr: product.userCidr,
      anonymousCidr: product.anonymousCidr,
      defaultDomesticSiteId: product.defaultDomesticSiteId,
      enabled: product.enabled
    })),
    changed: false,
    materialDigest: secret?.fingerprints.materialDigest ?? null,
    blockedReasons,
    nextActions: blockedReasons.length
      ? ['Fix ProductNetwork/Domestic WG prerequisites and retry CIDR sync.']
      : addedProductRelayCidrs.length
        ? ['Sync will update Config Center only; materialize/apply Domestic relay runtime next.']
        : ['Domestic productRelayCidrs already cover registered standalone products.']
  };
}

function launcherProductRelayCidrs(product: LauncherProductNetwork): string[] {
  return uniqueConfigStrings([
    product.userCidr,
    product.anonymousCidr,
    ipv4HostCidr(product.serviceVip),
    ipv4HostCidr(product.internalControlIp),
    ipv4HostCidr(product.domesticGatewayIp),
    ipv4HostCidr(product.dnsServer)
  ].filter((cidr): cidr is string => Boolean(cidr)));
}

function ipv4HostCidr(value: string | null | undefined): string | null {
  const ip = String(value || '').trim();
  return ipv4ToNumber(ip) === null ? null : `${ip}/32`;
}

function buildLauncherServiceVipSmoke(input: {
  app: AppCenterApp;
  product: LauncherProductNetwork | null;
  channelProduct: LauncherProductNetwork | null;
  leases: LauncherNetworkLease[];
  dnsRoutes: DnsReverseProxyRoute[];
  domesticSecrets: SiteSlotDomesticWireGuardSecret[];
  generatedAt: string;
}): AdminLauncherServiceVipSmoke {
  const app = input.app;
  const productId = normalizeLauncherId(app.productNetworkId || app.appId);
  const product = input.product;
  const mode = app.launcherMode === 'standalone' || product?.mode === 'standalone' ? 'standalone' : 'embed';
  const channelProductId = mode === 'standalone'
    ? productId
    : normalizeLauncherId(app.standaloneChannelProductId || product?.standaloneChannelProductId || MX_H2I_PRODUCT_ID);
  const serviceVip = product?.serviceVip ?? null;
  const dnsHost = normalizeDomain(`${app.appId}.${MX_DEFAULT_APP_DNS_ZONE}`);
  const dnsRoute = findLauncherServiceDnsRoute(input.dnsRoutes, dnsHost);
  const domesticSiteId = product?.defaultDomesticSiteId || input.channelProduct?.defaultDomesticSiteId || 'domestic-main';
  const domesticSecret = input.domesticSecrets.find((secret) => secret.siteId === domesticSiteId)
    ?? input.domesticSecrets[0]
    ?? null;
  const latestLease = input.leases
    .filter((lease) => lease.productId === channelProductId)
    .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))[0]
    ?? null;
  const expectedProductCidrs = product ? launcherProductRelayCidrs(product) : [];
  const relayCidrs = domesticSecret ? domesticSecretProductRelayCidrs(domesticSecret) : [];
  const missingRelayCidrs = expectedProductCidrs.filter((cidr) => !relayCidrs.some((relayCidr) => ipv4CidrContainsCidr(relayCidr, cidr)));
  const expectedInternalAllowedIps = uniqueStrings([
    product?.internalControlIp ? `${product.internalControlIp}/32` : '10.88.88.88/32',
    serviceVip ? `${serviceVip}/32` : ''
  ].filter(Boolean));

  const checks: AdminLauncherServiceVipSmokeCheck[] = [
    serviceVipSmokeCheck(
      'app-registry',
      'App registry',
      app.enabled === false ? 'blocked' : 'passed',
      app.enabled === false ? 'App is registered but disabled.' : 'AppCenter registration is enabled.',
      app.appId,
      app.enabled === false ? 'disabled' : 'enabled'
    ),
    serviceVipSmokeCheck(
      'product-network',
      'ProductNetwork',
      product ? 'passed' : 'blocked',
      product ? 'ProductNetwork exists for this app.' : 'ProductNetwork is missing for this app.',
      productId,
      product?.productId ?? null
    ),
    serviceVipSmokeCheck(
      'service-vip',
      'Service VIP',
      serviceVip ? 'passed' : 'blocked',
      serviceVip ? 'Service VIP is assigned in ProductNetwork.' : 'Service VIP is not assigned.',
      '10.88.100.x',
      serviceVip
    ),
    serviceVipSmokeCheck(
      'dns-route',
      'DNS route',
      dnsRoute?.enabled ? 'passed' : dnsRoute ? 'warning' : 'blocked',
      dnsRoute?.enabled ? 'DNS route exists and is enabled.' : dnsRoute ? 'DNS route exists but is disabled.' : 'DNS route is missing.',
      dnsHost,
      dnsRoute?.host ?? null
    ),
    serviceVipSmokeCheck(
      'dns-target',
      'DNS target',
      dnsRoute && product && dnsRoute.dnsTarget === product.internalControlIp ? 'passed' : dnsRoute ? 'warning' : 'blocked',
      dnsRoute && product && dnsRoute.dnsTarget === product.internalControlIp
        ? 'DNS route targets the Internal service peer.'
        : dnsRoute
          ? 'DNS route target does not match the product Internal control IP.'
          : 'Cannot verify DNS target without a DNS route.',
      product?.internalControlIp ?? '10.88.88.88',
      dnsRoute?.dnsTarget ?? null
    ),
    serviceVipSmokeCheck(
      'gateway-upstream',
      'Gateway upstream',
      dnsRoute?.targetUrl ? 'passed' : 'blocked',
      dnsRoute?.targetUrl ? 'Gateway reverse proxy upstream is configured.' : 'Gateway upstream URL is missing.',
      'http://service-host:port',
      dnsRoute?.targetUrl ?? null
    ),
    serviceVipSmokeCheck(
      'domestic-secret',
      'Domestic relay secret',
      domesticSecret ? 'passed' : 'blocked',
      domesticSecret ? 'Domestic WireGuard relay material exists.' : 'Domestic WireGuard relay material is missing.',
      domesticSiteId,
      domesticSecret?.siteId ?? null
    ),
    serviceVipSmokeCheck(
      'domestic-product-cidrs',
      'Domestic product CIDRs',
      !domesticSecret ? 'blocked' : missingRelayCidrs.length ? 'blocked' : 'passed',
      !domesticSecret
        ? 'Cannot verify product relay CIDRs without Domestic relay material.'
        : missingRelayCidrs.length
          ? `Domestic productRelayCidrs does not cover ${missingRelayCidrs.join(', ')}.`
          : 'Domestic productRelayCidrs covers the app lease CIDRs.',
      expectedProductCidrs.join(', ') || null,
      relayCidrs.join(', ') || null
    ),
    serviceVipSmokeCheck(
      'internal-service-peer-contract',
      'Internal service peer contract',
      serviceVip ? 'warning' : 'blocked',
      serviceVip
        ? 'Topology expects Internal service peer AllowedIPs to include the product service VIP; runtime apply evidence is checked by Internal service peer actions.'
        : 'Cannot build Internal service peer AllowedIPs without a service VIP.',
      expectedInternalAllowedIps.join(', ') || null,
      'runtime evidence pending'
    ),
    serviceVipSmokeCheck(
      'runtime-lease',
      'Runtime lease',
      latestLease ? 'passed' : 'warning',
      latestLease ? 'At least one recent launcher lease exists for the standalone channel.' : 'No launcher runtime lease has been issued yet.',
      channelProductId,
      latestLease?.leaseIp ?? null
    )
  ];
  const status = launcherServiceVipSmokeStatus(checks);
  return {
    appId: app.appId,
    productId,
    displayName: app.displayName || app.appId,
    launcherMode: mode,
    channelProductId,
    serviceVip,
    dnsHost,
    dnsRouteId: dnsRoute?.routeId ?? null,
    upstreamUrl: dnsRoute?.targetUrl ?? null,
    latestLeaseIp: latestLease?.leaseIp ?? null,
    domesticSiteId,
    status,
    summary: launcherServiceVipSmokeSummary(status, checks),
    checks,
    nextActions: launcherServiceVipSmokeNextActions(checks),
    generatedAt: input.generatedAt
  };
}

function findLauncherServiceDnsRoute(routes: DnsReverseProxyRoute[], dnsHost: string): DnsReverseProxyRoute | null {
  const normalized = normalizeDomain(dnsHost);
  return routes.find((route) => normalizeDomain(route.host) === normalized || route.routeId === `rp_${normalized}`) ?? null;
}

function launcherServiceVipSmokeChannelProductId(app: AppCenterApp): string {
  const mode = app.launcherMode === 'standalone' ? 'standalone' : 'embed';
  return mode === 'standalone'
    ? normalizeLauncherId(app.productNetworkId || app.appId)
    : normalizeLauncherId(app.standaloneChannelProductId || MX_H2I_PRODUCT_ID);
}

function serviceVipSmokeCheck(
  checkId: string,
  label: string,
  status: AdminLauncherServiceVipSmokeStatus,
  detail: string,
  expected: string | null,
  actual: string | null
): AdminLauncherServiceVipSmokeCheck {
  return {
    checkId,
    label,
    status,
    detail,
    expected,
    actual
  };
}

function launcherServiceVipSmokeStatus(checks: AdminLauncherServiceVipSmokeCheck[]): AdminLauncherServiceVipSmokeStatus {
  if (checks.some((check) => check.status === 'blocked')) return 'blocked';
  if (checks.some((check) => check.status === 'warning')) return 'warning';
  return 'passed';
}

function launcherServiceVipSmokeSummary(
  status: AdminLauncherServiceVipSmokeStatus,
  checks: AdminLauncherServiceVipSmokeCheck[]
): string {
  if (status === 'passed') return 'Service VIP is configured across App, DNS, relay CIDR, and lease layers.';
  const first = checks.find((check) => check.status === status);
  return first?.detail ?? 'Service VIP materialization needs operator attention.';
}

function launcherServiceVipSmokeNextActions(checks: AdminLauncherServiceVipSmokeCheck[]): string[] {
  const actions: string[] = [];
  if (checks.some((check) => check.checkId === 'domestic-product-cidrs' && check.status === 'blocked')) {
    actions.push('Update Domestic WG productRelayCidrs and re-apply Internal service peer / Domestic relay runtime.');
  }
  if (checks.some((check) => check.checkId === 'dns-route' && check.status === 'blocked')) {
    actions.push('Create the app DNS route and gateway upstream in DNS Center.');
  }
  if (checks.some((check) => check.checkId === 'gateway-upstream' && check.status === 'blocked')) {
    actions.push('Set the route upstream URL to the service or host nginx/Caddy endpoint.');
  }
  if (checks.some((check) => check.checkId === 'runtime-lease' && check.status === 'warning')) {
    actions.push('Start the app client and request a launcher lease.');
  }
  return actions.length ? actions : ['Open Internal service peer actions and verify runtime apply evidence.'];
}

function launcherServiceVipReconcileResult(input: {
  siteId: string;
  appId?: string | null;
  sync: unknown;
  materialize?: unknown;
  domesticRuntimeApply?: unknown;
  internalServicePeerApply?: unknown;
  domesticPeerKeySync?: unknown;
  blockedReasons?: string[];
}) {
  const steps = [
    launcherServiceVipReconcileStep('domestic-product-cidrs', 'Sync Domestic product CIDRs', input.sync),
    launcherServiceVipReconcileStep('domestic-wg-artifact', 'Materialize Domestic WG artifact', input.materialize),
    launcherServiceVipReconcileStep('domestic-runtime', 'Apply Domestic relay runtime', input.domesticRuntimeApply),
    launcherServiceVipReconcileStep('internal-service-peer', 'Apply Internal service peer', input.internalServicePeerApply),
    launcherServiceVipReconcileStep('domestic-peer-allowed-ips', 'Sync Domestic peer AllowedIPs', input.domesticPeerKeySync)
  ].filter((step) => step.status !== 'skipped');
  const blockedReasons = uniqueStrings([
    ...(input.blockedReasons ?? []).filter((item) => item.trim().length > 0),
    ...steps.flatMap((step) => step.blockedReasons)
  ]);
  const failed = steps.some((step) => step.status === 'failed');
  const blocked = blockedReasons.length > 0 || steps.some((step) => step.status === 'blocked');
  const ready = steps.some((step) => ['ready', 'warning'].includes(step.status));
  const status = blocked ? 'blocked' : failed ? 'failed' : ready ? 'ready' : 'passed';
  return {
    reconcileId: `launcher_service_vip_reconcile_${input.siteId}`,
    status,
    siteId: input.siteId,
    appId: input.appId ?? null,
    steps,
    blockedReasons,
    nextActions: status === 'passed'
      ? ['Re-run the standalone launcher Apply Data Plane smoke.']
      : blockedReasons.length
        ? blockedReasons
        : steps.flatMap((step) => step.nextActions),
    finishedAt: new Date().toISOString()
  };
}

function launcherServiceVipReconcileStep(stepId: string, label: string, result: unknown) {
  if (!result) {
    return {
      stepId,
      label,
      status: 'skipped',
      message: 'skipped',
      blockedReasons: [] as string[],
      nextActions: [] as string[]
    };
  }
  const row = asRecord(result);
  const status = stringValue(row.status) ?? 'ready';
  const blockedReasons = (Array.isArray(row.blockedReasons) ? row.blockedReasons : [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const nextActions = (Array.isArray(row.nextActions) ? row.nextActions : [])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const message = blockedReasons[0]
    ?? nextActions[0]
    ?? stringValue(row.mode)
    ?? status;
  return {
    stepId,
    label,
    status,
    message,
    blockedReasons,
    nextActions
  };
}

function bearerToken(authorization?: string): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeLauncherId(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || MX_H2I_PRODUCT_ID;
}

function normalizeDomain(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function ipv4CidrContainsCidr(container: string, member: string): boolean {
  const left = parseIpv4Cidr(container);
  const right = parseIpv4Cidr(member);
  if (!left || !right || left.prefix > right.prefix) return false;
  const mask = cidrMask(left.prefix);
  return (left.address & mask) === (right.address & mask);
}

function parseIpv4Cidr(value: string | null | undefined): { address: number; prefix: number } | null {
  const [addressText, prefixText = '32'] = String(value || '').trim().split('/');
  const address = ipv4ToNumber(addressText);
  const prefix = Number(prefixText);
  if (address === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { address, prefix };
}

function ipv4ToNumber(value: string | null | undefined): number | null {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4) return null;
  let output = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) return null;
    output = (output << 8) + number;
  }
  return output >>> 0;
}

function cidrMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function sortSites(sites: SiteHeartbeat[]): SiteHeartbeat[] {
  return [...sites].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function sortReleasePlans(plans: ReleaseManagementPlan[]): ReleaseManagementPlan[] {
  return [...plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function sortAwxProviderConfigs(providers: AwxProviderConfig[]): AwxProviderConfig[] {
  return [...providers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function sortByStartedAt<T extends { startedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].slice(0, 12);
}

function uniqueConfigStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
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
  return cidrs.length ? uniqueStrings(cidrs) : null;
}

function domesticSecretProductRelayCidrs(secret: SiteSlotDomesticWireGuardSecret): string[] {
  const cidrs = secret.productRelayCidrs?.length
    ? secret.productRelayCidrs
    : [secret.userRelayCidr, secret.internalServiceCidr, secret.guestRelayCidr];
  return uniqueStrings(cidrs.filter((cidr) => Boolean(cidr)));
}

function domesticSecretProductRelayCidrsForSync(secret: SiteSlotDomesticWireGuardSecret): string[] {
  const cidrs = secret.productRelayCidrs?.length
    ? secret.productRelayCidrs
    : [secret.userRelayCidr, secret.internalServiceCidr, secret.guestRelayCidr];
  return uniqueConfigStrings(cidrs.filter((cidr) => Boolean(cidr)));
}

function domesticInternalServicePeerAllowedIps(secret: SiteSlotDomesticWireGuardSecret): string[] {
  const domesticGatewayCidr = `${secret.domesticGatewayIp}/32`;
  return uniqueConfigStrings([
    `${secret.internalServiceIp}/32`,
    ...domesticSecretProductRelayCidrs(secret)
      .filter((cidr) => cidr.endsWith('/32') && cidr !== domesticGatewayCidr)
  ]);
}

function domesticInternalServicePeerServiceVipIps(secret: SiteSlotDomesticWireGuardSecret | null): string[] {
  if (!secret) return [];
  return domesticInternalServicePeerAllowedIps(secret)
    .map((cidr) => cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/32$/)?.[1] ?? null)
    .filter((ip): ip is string => Boolean(ip && ip !== secret.internalServiceIp));
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.min(Math.floor(value), 50));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(1, Math.min(Math.floor(parsed), 50));
  }
  return fallback;
}
