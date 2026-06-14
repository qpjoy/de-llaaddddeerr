import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import { asRecord } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import { checkAwxProvider } from '../config-center/awx-provider-check.js';
import { buildAwxProviderSyncPlan } from '../config-center/awx-provider-sync-plan.js';
import { buildSiteSlotRemoteSshGate, buildSiteSlotRemoteSshReadOnlyProbe, buildSiteSlotRemoteSshWorkerHandoff } from '../site-slots/remote-ssh-gate.js';
import { runAwxApiLaunch } from './awx-api-launch.js';
import { runAwxCredentialSync } from './awx-credential-sync.js';
import { runAwxObjectSync } from './awx-object-sync.js';
import {
  AWX_CREDENTIAL_SYNC_FEATURE_KEY,
  AWX_LAUNCH_FEATURE_KEY,
  AWX_OBJECT_SYNC_FEATURE_KEY
} from './awx-runtime-gates.js';
import type {
  AdminActionDescriptor,
  AdminActionPolicy,
  AdminDashboardSnapshot,
  AdminPipelineHealth,
  AdminSiteSlotPipeline,
  AdminSiteSlotPipelineSummary,
  AdminTimelineEntry,
  AwxProviderCheckResult,
  AwxProviderConfig,
  LauncherNetworkMihomoSite,
  PlatformPrincipal,
  ReleaseManagementPlan,
  RuntimeFeaturePolicy,
  SiteHeartbeat,
  SiteSlotAccessAccount,
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
    const [overview, sites, releasePlans, pipelines, awxProviders, runtimeFeaturePolicies] = await Promise.all([
      this.store.overview(),
      this.store.listSites(),
      this.store.listReleaseManagementPlans(),
      this.buildSiteSlotPipelines(actionPolicy),
      this.store.listAwxProviderConfigs(),
      this.listAwxRuntimePolicies()
    ]);
    const summaries = pipelines.map((pipeline) => pipeline.summary);
    return {
      generatedAt: new Date().toISOString(),
      overview: overview as unknown as Record<string, unknown>,
      actionPolicy,
      sites: sortSites(sites).slice(0, limit),
      latestReleasePlans: sortReleasePlans(releasePlans).slice(0, limit),
      siteSlotPipelines: summaries.slice(0, limit),
      awxProviders: sortAwxProviderConfigs(awxProviders).slice(0, limit),
      runtimeFeaturePolicies,
      nextActions: adminDashboardNextActions(summaries)
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
      pipelines: pipelines.slice(0, limit).map((pipeline) => ({
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
    const internalBaseUrl = normalizeBaseUrl(stringValue(body.internalBaseUrl) ?? process.env.MX_INTERNAL_BASE_URL ?? 'http://127.0.0.1:18090');
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
      strictHostKeyChecking: stringValue(body.strictHostKeyChecking) ?? 'yes',
      connectTimeoutSeconds: numberValueOrNull(body.connectTimeoutSeconds) ?? 30,
      batchMode: stringValue(body.batchMode) ?? 'yes',
      status: 'active',
      requestedBy,
      requestId: `${requestId}-ssh-profile`
    });
    const access = await this.store.issueSiteSlotAccessAccounts({
      siteId,
      service: 'hysteria2',
      issueDefaults: true,
      publicHost: profile.host,
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
      internalBaseUrl,
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
    const internalBaseUrl = normalizeBaseUrl(stringValue(body.internalBaseUrl) ?? process.env.MX_INTERNAL_BASE_URL ?? 'http://127.0.0.1:18090');
    const executeRemote = booleanValue(body.executeRemote) === true;
    const confirmInstall = booleanValue(body.confirmInstall) === true;
    const force = booleanValue(body.force) === true;
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

    const access = await this.store.issueSiteSlotAccessAccounts({
      siteId,
      service: 'hysteria2',
      issueDefaults: true,
      publicHost: profile.host,
      requestedBy,
      requestId
    });
    const planAccessAccounts = siteSlotPlanAccessAccountMaterial(await this.store.listSiteSlotAccessAccounts(siteId));
    ensureSteps.push(overseaEnsureStep('internal-mihomo', 'passed', access.site.siteId, {
      subscriptionBaseUrl: access.site.subscriptionBaseUrl,
      accounts: planAccessAccounts.length
    }));

    let plan = await this.findReusableOverseaPlan(siteId, profile.profileId);
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
        internalBaseUrl,
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

    const workerRun = await this.runRemoteSshWorker(job.jobId, profile.profileId, internalBaseUrl, requestedBy, requestId);
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

  private async findReusableOverseaPlan(siteId: string, profileId: string): Promise<SiteSlotPlan | null> {
    const plans = await this.store.listSiteSlotPlans();
    return latestByCreatedAt(plans.filter((plan) => (
      plan.kind === 'oversea'
      && plan.siteId === siteId
      && plan.ssh.profileId === profileId
      && plan.status !== 'blocked'
      && reusableOverseaPlanContract(plan)
    )));
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
      && (session.status === 'queued' || session.status === 'running' || session.status === 'passed')
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
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, internalBaseUrl, jobId, 'artifact-push-remote-ssh'], {
        cwd: mxRoot,
        env: {
          ...process.env,
          MX_INTERNAL_BASE_URL: internalBaseUrl,
          SITE_SLOT_SSH_PROFILE_ID: sshProfileId,
          SITE_SLOT_WORKER_REMOTE_SSH: '1',
          SITE_SLOT_CONFIRM_REMOTE_EXECUTION: '1',
          SITE_SLOT_WORKER_ID: 'worker-admin-ensure',
          SITE_SLOT_WORKER_MESSAGE: 'oversea install/sync by admin ensure',
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
        reservedInternalCidrs: ['10.88.0.0/16', '10.89.0.0/16', '10.90.0.0/16', '10.91.0.0/16'],
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
      return {
        plan: await this.store.createSiteSlotPlan(toSiteSlotPlanInput(body))
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
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
        confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
        requestedBy: stringValue(body.requestedBy),
        requestId: stringValue(body.requestId)
      });
      return {
        gate,
        workerHandoff: buildSiteSlotRemoteSshWorkerHandoff(job, plan, gate, {
          internalBaseUrl: stringValue(body.internalBaseUrl),
          confirmWorkerHandoff: booleanValue(body.confirmWorkerHandoff) === true
        })
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
      const relayPeerPlan = adminDomesticRelayPeerPlanResult(job, plan, body);
      if (relayPeerPlan.status !== 'ready') return { relayPeerPlan };
      const reportResult = domesticRelayPeerPlanStepReports(job, plan, body);
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
      return {
        relayReadOnlyProbe: adminDomesticRelayReadOnlyProbeResult(job, plan, body)
      };
    }
    if (actionId === 'site-slot.worker-run.domestic-relay-peer-append') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/domestic-relay-peer-append$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run Domestic relay peer append path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      const plan = await this.store.getSiteSlotPlan(job.planId);
      return {
        relayPeerAppend: adminDomesticRelayPeerAppendResult(job, plan, body)
      };
    }
    if (actionId === 'site-slot.worker-run.domestic-relay-peer-append-ssh') {
      const match = matchPath(path, /^\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)\/run-domestic-relay-peer-append-ssh$/);
      if (!match) throw new BadRequestException('Admin site-slot worker-run Domestic relay peer append SSH path is invalid');
      const job = await this.store.getSiteSlotWorkerJob(match[1]);
      if (!job) throw new NotFoundException('Site slot worker job not found');
      const plan = await this.store.getSiteSlotPlan(job.planId);
      const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
      const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
        confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
        requestedBy: stringValue(body.requestedBy),
        requestId: stringValue(body.requestId)
      });
      const relayPeerAppend = adminDomesticRelayPeerAppendResult(job, plan, body);
      const relayPeerAppendSsh = adminDomesticRelayPeerAppendSshResult(job, plan, sshProfile, gate, body, relayPeerAppend);
      if (relayPeerAppendSsh.status !== 'ready') return { gate, relayPeerAppend, relayPeerAppendSsh };
      const reportResult = await domesticRelayPeerAppendSshStepReports(job, plan, sshProfile, gate, body);
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
      const plan = dryRun ? await this.store.getSiteSlotPlan(job.planId) : null;
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

  private async buildSiteSlotPipelines(actionPolicy: AdminActionPolicy, planId?: string | null): Promise<AdminSiteSlotPipeline[]> {
    const [plans, executions, runnerSessions, workerJobs, workerReports, rollbackExecutions, rollbackReports] = await Promise.all([
      this.store.listSiteSlotPlans(),
      this.store.listSiteSlotExecutions(),
      this.store.listSiteSlotRunnerSessions(),
      this.store.listSiteSlotWorkerJobs(),
      this.store.listSiteSlotWorkerReports(),
      this.store.listSiteSlotRollbackExecutions(),
      this.store.listSiteSlotRollbackReports()
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
  actionPolicy: AdminActionPolicy
): AdminSiteSlotPipeline {
  const timeline = buildTimeline(plan, executions, runnerSessions, workerJobs, workerReports, rollbackExecutions, rollbackReports);
  const latest = timeline[timeline.length - 1] ?? null;
  const warnings = uniqueStrings([
    ...plan.warnings,
    ...executions.flatMap((execution) => execution.warnings),
    ...runnerSessions.flatMap((session) => session.warnings),
    ...workerJobs.flatMap((job) => job.warnings),
    ...rollbackExecutions.flatMap((execution) => execution.warnings)
  ]);
  const nextActions = uniqueStrings(latest?.nextActions.length ? latest.nextActions : plan.nextActions);
  const summary: AdminSiteSlotPipelineSummary = {
    planId: plan.planId,
    siteId: plan.siteId,
    kind: plan.kind,
    environment: plan.environment,
    status: plan.status,
    health: pipelineHealth(plan, executions, runnerSessions, workerJobs, workerReports, rollbackExecutions, rollbackReports),
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
    nextActions,
    actionHints: buildPipelineActionHints(actionPolicy, plan, executions, runnerSessions, workerJobs, workerReports, rollbackExecutions)
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
    internalBaseUrl: stringValue(body.internalBaseUrl),
    accessAccounts: siteSlotPlanAccessAccountsValue(body.accessAccounts),
    requestId: stringValue(body.requestId),
    createdBy: stringValue(body.createdBy)
  };
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
  body: Record<string, unknown>
): {
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
} {
  const steps = [...job.steps].sort((left, right) => left.order - right.order);
  const carrierStep = steps.find((step) => phaseIdFromSource(step.sourceId) === 'prepare-domestic-relay-authority')
    ?? steps.find((step) => phaseIdFromSource(step.sourceId) === 'install-host-wireguard')
    ?? steps[0];
  const evidence = domesticRelayPeerPlanEvidence(job, carrierStep, plan, body);
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
  body: Record<string, unknown>
) {
  const input = domesticRelayPeerInput(body);
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
      listenPort: 51820,
      gatewayIp: '10.88.0.1',
      configPath: '/etc/wireguard/mx-domestic.conf',
      envArtifact: 'mx-domestic-relay.env'
    },
    internalServicePeer: {
      role: 'internal-service',
      fixedIp: '10.90.0.10',
      allowedIps: ['10.90.0.10/32'],
      configArtifact: 'mx-internal-service-peer.conf',
      privateKeyPlacement: 'internal-only',
      privateKeyCopiedToDomestic: false
    },
    homePeer: {
      role: input.peerRole,
      leaseIp: input.leaseIp,
      cidr: relayPeerCidr(input.peerRole),
      allowedIps: allowedIp ? [allowedIp] : [],
      publicKey: input.publicKey,
      publicKeyStatus: input.publicKey ? 'ready-to-append' : 'pending-public-key',
      provisionedBy: 'internal-signed-relay-lease',
      domesticMutation: 'append-peer-after-enroll'
    },
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
  sshProfile: SiteSlotSshProfile | null
) {
  const failures: string[] = [];
  const artifactBaseDir = resolveSiteSlotArtifactBaseDir();
  const artifactReferences = artifactReferenceValues(step.command).map((ref) => artifactReferenceEvidence(ref, artifactBaseDir, failures));
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
  const evidence = artifactPushDryRunEvidence(job, step, plan, sshProfile);
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
  const evidence = artifactPushDryRunEvidence(job, step, plan, sshProfile);
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
  const evidence = artifactPushDryRunEvidence(job, step, plan, sshProfile);
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
  body: Record<string, unknown>
) {
  const input = domesticRelayPeerInput(body);
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
    homePeer: {
      role: input.peerRole,
      leaseIp: input.leaseIp,
      cidr: relayPeerCidr(input.peerRole),
      allowedIps: input.leaseIp ? [`${input.leaseIp}/32`] : [],
      publicKey: input.publicKey,
      publicKeyStatus: input.publicKey ? 'ready-to-append' : 'pending-public-key'
    },
    domesticRelay: {
      interfaceName: 'mx-domestic',
      listenPort: 51820,
      gatewayIp: '10.88.0.1',
      endpointHost: plan?.host ?? null
    },
    internalServicePeer: {
      fixedIp: '10.90.0.10',
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
  body: Record<string, unknown>
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
    command: domesticRelayReadOnlyProbeCommand(plan),
    env: {
      SITE_SLOT_READONLY_PROBE: '1',
      SITE_SLOT_DOMESTIC_RELAY_PROBE: '1',
      SITE_SLOT_SSH_PROFILE_ID: plan?.ssh.profileId ?? null
    },
    domesticRelay: {
      siteId: plan?.siteId ?? job.siteId,
      endpointHost: plan?.host ?? null,
      interfaceName: 'mx-domestic',
      listenPort: 51820,
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
        'ip -4 address show dev mx-domestic',
        'ip route get 10.90.0.10',
        'systemctl status wg-quick@mx-domestic --no-pager'
      ]
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
      'The probe fails if /etc/wireguard/mx-internal-service-peer.conf exists on Domestic.'
    ],
    nextActions: blockedReasons.length > 0
      ? ['fix-domestic-relay-readonly-probe-gates', 'rerun-domestic-relay-readonly-probe']
      : ['run-readonly-probe-from-internal', 'review-wg-show-output', 'prepare-gated-peer-append']
  };
}

function adminDomesticRelayPeerAppendResult(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>
) {
  const input = domesticRelayPeerInput(body);
  const blockedReasons = domesticRelayPeerAppendFailures(job, plan, body, input);
  const allowedIp = input.leaseIp ? `${input.leaseIp}/32` : null;
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
      listenPort: 51820,
      gatewayIp: '10.88.0.1',
      configPath: '/etc/wireguard/mx-domestic.conf',
      unit: 'wg-quick@mx-domestic'
    },
    homePeer: {
      role: input.peerRole,
      leaseIp: input.leaseIp,
      cidr: relayPeerCidr(input.peerRole),
      allowedIps: allowedIp ? [allowedIp] : [],
      publicKey: input.publicKey,
      publicKeyStatus: input.publicKey ? 'ready-to-append' : 'pending-public-key'
    },
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
  body: Record<string, unknown>
): Promise<{
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
}> {
  const input = domesticRelayPeerInput(body);
  const relayPeerAppend = adminDomesticRelayPeerAppendResult(job, plan, body);
  const blockedReasons = domesticRelayPeerAppendSshFailures(gate, body, relayPeerAppend, sshProfile);
  const steps = [...job.steps].sort((left, right) => left.order - right.order);
  const carrierStep = steps.find((step) => phaseIdFromSource(step.sourceId) === 'prepare-domestic-relay-authority')
    ?? steps.find((step) => phaseIdFromSource(step.sourceId) === 'install-host-wireguard')
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

  const evidence = domesticRelayPeerAppendSshEvidence(job, carrierStep, plan, sshProfile, gate, body, {
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
  result: {
    status: NonNullable<SiteSlotWorkerReportInput['status']>;
    execution: string;
    exitCode: number | null;
    blockedReasons: string[];
    executionResult: Record<string, unknown> | null;
  }
) {
  const input = domesticRelayPeerInput(body);
  const allowedIp = input.leaseIp ? `${input.leaseIp}/32` : null;
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
      listenPort: 51820,
      gatewayIp: '10.88.0.1',
      configPath: '/etc/wireguard/mx-domestic.conf',
      unit: 'wg-quick@mx-domestic'
    },
    homePeer: {
      role: input.peerRole,
      leaseIp: input.leaseIp,
      cidr: relayPeerCidr(input.peerRole),
      allowedIps: allowedIp ? [allowedIp] : [],
      publicKey: input.publicKey,
      publicKeyStatus: input.publicKey ? 'ready-to-append' : 'pending-public-key'
    },
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

function domesticRelayPeerInput(body: Record<string, unknown>): {
  peerRole: 'guest' | 'user';
  leaseIp: string | null;
  publicKey: string | null;
} {
  const rawRole = stringValue(body.peerRole) ?? stringValue(body.role);
  const leaseIp = stringValue(body.leaseIp) ?? stringValue(body.ip);
  const inferredRole = leaseIp?.startsWith('10.89.') ? 'user' : 'guest';
  const peerRole = rawRole === 'user' || rawRole === 'guest' ? rawRole : inferredRole;
  return {
    peerRole,
    leaseIp,
    publicKey: stringValue(body.publicKey)
  };
}

function domesticRelayPeerPlanFailures(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  input = domesticRelayPeerInput(body)
): string[] {
  const failures: string[] = [];
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
    failures.push('Home relay leaseIp must be in 10.89.0.0/16 or 10.91.0.0/16');
  } else if (input.peerRole === 'user' && !input.leaseIp.startsWith('10.89.')) {
    failures.push('user relay peer must use 10.89.0.0/16');
  } else if (input.peerRole === 'guest' && !input.leaseIp.startsWith('10.91.')) {
    failures.push('guest relay peer must use 10.91.0.0/16');
  }
  return failures;
}

function validWireGuardPublicKey(value: string): boolean {
  return /^[A-Za-z0-9+/=]{32,88}$/.test(value) && !/\s/.test(value);
}

function validRelayLeaseIp(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  return octets[0] === 10 && (octets[1] === 89 || octets[1] === 91);
}

function relayPeerCidr(role: 'guest' | 'user'): string {
  return role === 'user' ? '10.89.0.0/16' : '10.91.0.0/16';
}

function domesticRelayPeerAppendFailures(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  body: Record<string, unknown>,
  input = domesticRelayPeerInput(body)
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
  input: ReturnType<typeof domesticRelayPeerInput>,
  label: string
): string[] {
  const failures: string[] = [];
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
    failures.push('Home relay leaseIp must be in 10.89.0.0/16 or 10.91.0.0/16');
  } else if (input.peerRole === 'user' && !input.leaseIp.startsWith('10.89.')) {
    failures.push('user relay peer must use 10.89.0.0/16');
  } else if (input.peerRole === 'guest' && !input.leaseIp.startsWith('10.91.')) {
    failures.push('guest relay peer must use 10.91.0.0/16');
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

function domesticRelayReadOnlyProbeCommand(plan: SiteSlotPlan | null): string {
  const sshUser = plan?.ssh.user ?? 'root';
  const sshPort = plan?.ssh.port ?? 22;
  const host = plan?.host ?? '<domestic-host>';
  return `ssh -p ${sshPort} ${shellQuote(`${sshUser}@${host}`)} ${shellQuote(domesticRelayReadOnlyProbeScript())}`;
}

function domesticRelayReadOnlyProbeScript(): string {
  return [
    'set -eu',
    'printf "mx-domestic-relay-readonly-probe\\n"',
    'id -u',
    'hostname',
    'uname -a',
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi',
    'if command -v wg >/dev/null 2>&1; then wg show mx-domestic; else echo "wg: missing"; fi',
    'ip -4 address show dev mx-domestic 2>/dev/null || true',
    'ip route get 10.90.0.10 2>/dev/null || true',
    'systemctl status wg-quick@mx-domestic --no-pager 2>/dev/null || true'
  ].join('; ');
}

function domesticRelayPeerAppendCommand(
  plan: SiteSlotPlan | null,
  input: ReturnType<typeof domesticRelayPeerInput>
): string {
  const sshUser = plan?.ssh.user ?? 'root';
  const sshPort = plan?.ssh.port ?? 22;
  const host = plan?.host ?? '<domestic-host>';
  return `ssh -p ${sshPort} ${shellQuote(`${sshUser}@${host}`)} ${shellQuote(domesticRelayPeerAppendScript(input))}`;
}

function domesticRelayPeerAppendScript(input: ReturnType<typeof domesticRelayPeerInput>): string {
  const publicKey = input.publicKey ?? '<home-wg-public-key>';
  const allowedIp = input.leaseIp ? `${input.leaseIp}/32` : '<home-lease-ip>/32';
  return [
    'set -eu',
    'printf "mx-domestic-relay-peer-append\\n"',
    'test -f /etc/wireguard/mx-domestic.conf',
    'if test -f /etc/wireguard/mx-internal-service-peer.conf; then echo "blocked: internal service peer private key must not be copied to Domestic"; exit 1; fi',
    'if ! command -v wg >/dev/null 2>&1; then echo "blocked: wg missing"; exit 1; fi',
    'wg show mx-domestic >/dev/null',
    `wg set mx-domestic peer ${shellQuote(publicKey)} allowed-ips ${shellQuote(allowedIp)}`,
    'wg show mx-domestic',
    'if command -v wg-quick >/dev/null 2>&1; then wg-quick save mx-domestic || true; fi',
    'systemctl status wg-quick@mx-domestic --no-pager 2>/dev/null || true'
  ].join('; ');
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

function artifactReferenceEvidence(ref: string, artifactBaseDir: string, failures: string[]) {
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
  return commands.some((command) => command.includes('/bin/qp-tunnel-cli register --internal'))
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

function buildPipelineActionHints(
  actionPolicy: AdminActionPolicy,
  plan: SiteSlotPlan,
  executions: SiteSlotExecutionRun[],
  runnerSessions: SiteSlotRunnerSession[],
  workerJobs: SiteSlotWorkerJob[],
  workerReports: SiteSlotWorkerReport[],
  rollbackExecutions: SiteSlotRollbackExecution[]
): AdminActionDescriptor[] {
  const actions: AdminActionDescriptor[] = [];
  const readyPreflight = sortByCreatedAt(executions).find((execution) => execution.action === 'preflight' && execution.status === 'ready');
  const confirmedApply = sortByCreatedAt(executions).find((execution) => execution.action === 'apply' && execution.status === 'ready' && execution.confirmApply);
  const latestReadyExecution = [...sortByCreatedAt(executions)].reverse().find((execution) => execution.status === 'ready') ?? null;
  const sessionNeedingWorker = [...sortByStartedAt(runnerSessions)].reverse().find((session) => {
    const canAttachWorker = session.status === 'completed' || session.status === 'queued' || session.status === 'running';
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
        true,
        'execution must be ready before remote runner session starts'
      ));
      if (plan.kind !== 'oversea') {
        actions.push(contextualAction(
          actionPolicy,
          'site-slot.runner.awx-shadow',
          {
            path: `/internal/v1/site-slots/executions/${encodeURIComponent(latestReadyExecution.runId)}/runner-sessions`,
            bodyTemplate: {
              mode: 'awx-shadow',
              requestedBy: actionPolicy.principal.principalId,
              requestId: 'admin-ui-runner-awx-shadow'
            }
          },
          true,
          'execution must be ready before AWX shadow runner session starts'
        ));
      }
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

  if (plan.kind === 'domestic' && confirmedApply) {
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.domestic-relay-peer-append-awx.prepare',
      {
        path: `/internal/v1/site-slots/executions/${encodeURIComponent(confirmedApply.runId)}/prepare-domestic-relay-peer-append-awx`,
        bodyTemplate: {
          confirmAwxLaunchPrepare: true,
          approvalId: 'approval-domestic-relay-peer-append-awx',
          changeWindowStart: '<change-window-start-iso>',
          changeWindowEnd: '<change-window-end-iso>',
          workerId: `worker-awx-domestic-relay-${plan.siteId}`,
          workerKind: 'awx-runner',
          retryLimit: 1,
          rollbackStrategy: 'restore-domestic-wg-peer-before-append',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-domestic-relay-peer-append-awx-prepare'
        }
      },
      true,
      'confirmed Domestic apply execution is required before preparing relay peer append AWX job'
    ));
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.domestic-relay-peer-append-ssh.prepare',
      {
        path: `/internal/v1/site-slots/executions/${encodeURIComponent(confirmedApply.runId)}/prepare-domestic-relay-peer-append-ssh`,
        bodyTemplate: {
          confirmRemoteExecution: true,
          confirmRelayPeerAppendSshPrepare: true,
          approvalId: 'approval-domestic-relay-peer-append',
          changeWindowStart: '<change-window-start-iso>',
          changeWindowEnd: '<change-window-end-iso>',
          workerId: `worker-domestic-relay-${plan.siteId}`,
          workerKind: 'domestic-runner',
          retryLimit: 1,
          rollbackStrategy: 'restore-domestic-wg-peer-before-append',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-domestic-relay-peer-append-ssh-prepare'
        }
      },
      true,
      'confirmed Domestic apply execution is required before preparing relay peer append SSH job'
    ));
  }

  if (sessionNeedingWorker) {
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-job.create',
      {
        path: `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(sessionNeedingWorker.sessionId)}/worker-jobs`,
        bodyTemplate: {
          workerId: 'worker-admin-1',
          workerKind: sessionNeedingWorker.mode === 'awx-shadow'
            ? 'awx-runner'
            : sessionNeedingWorker.kind === 'oversea'
              ? 'oversea-site-agent'
              : 'internal-runner',
          approvalId: 'approval-id',
          retryLimit: 2,
          rollbackStrategy: 'restore-previous-state',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-job'
        }
      },
      true,
      'runner session must be ready for worker attachment'
    ));
  }

  if (readyWorkerJob) {
    if (readyWorkerJob.kind !== 'oversea') {
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.awx-sync-plan',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/awx-sync-plan`,
          bodyTemplate: {
            workerId: readyWorkerJob.worker.workerId,
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-awx-sync-plan'
          }
        },
        true,
        'worker job must be ready before AWX object sync planning'
      ));
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.awx-credential-sync',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-awx-credential-sync`,
          bodyTemplate: {
            confirmAwxCredentialSync: true,
            timeoutSeconds: 120,
            workerId: readyWorkerJob.worker.workerId,
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-awx-credential-sync'
          }
        },
        true,
        'worker job must be ready before AWX credential sync'
      ));
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.awx-object-sync',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-awx-object-sync`,
          bodyTemplate: {
            confirmAwxSync: true,
            timeoutSeconds: 120,
            workerId: readyWorkerJob.worker.workerId,
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-awx-object-sync'
          }
        },
        true,
        'worker job must be ready before AWX object sync'
      ));
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.awx-launch',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-awx-launch`,
          bodyTemplate: {
            confirmAwxLaunch: true,
            waitForCompletion: true,
            timeoutSeconds: 180,
            pollIntervalMs: 2000,
            workerId: readyWorkerJob.worker.workerId,
            message: 'AWX API launch by admin-ui',
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-awx-launch'
          }
        },
        true,
        'worker job must be ready before AWX API launch'
      ));
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.awx-shadow',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-awx-shadow`,
          bodyTemplate: {
            workerId: readyWorkerJob.worker.workerId,
            message: 'AWX shadow worker run by admin-ui',
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-awx-shadow'
          }
        },
        true,
        'worker job must be ready before AWX shadow report'
      ));
    }
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
      true,
      'worker job must be ready before remote SSH gate review'
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
      true,
      'worker job must pass remote SSH gate before read-only probe'
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
      true,
      'worker job must be ready before remote SSH plan report'
    ));
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-run.remote-ssh-execute',
      {
        path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-artifact-push-remote-ssh`,
        bodyTemplate: {
          confirmRemoteExecution: true,
          confirmWorkerHandoff: true,
          internalBaseUrl: '<internal-base-url>',
          requestedBy: actionPolicy.principal.principalId,
          requestId: 'admin-ui-worker-run-remote-ssh-execute'
        }
      },
      true,
      'worker job must be ready before remote SSH worker handoff'
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
      true,
      'worker job must be ready before artifact-push dry-run'
    ));
    if (readyWorkerJob.kind === 'domestic') {
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
        true,
        'Domestic worker job must be ready before relay read-only probe'
      ));
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.domestic-relay-peer-plan',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-domestic-relay-peer-plan`,
          bodyTemplate: {
            confirmRelayPeerPlan: true,
            peerRole: 'guest',
            leaseIp: '<home-lease-ip>',
            publicKey: '<home-wg-public-key>',
            workerId: readyWorkerJob.worker.workerId,
            message: 'Domestic relay peer plan by admin-ui',
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-domestic-relay-peer-plan'
          }
        },
        true,
        'Domestic worker job must be ready before relay peer plan evidence'
      ));
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.domestic-relay-peer-append',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/domestic-relay-peer-append`,
          bodyTemplate: {
            confirmRelayPeerAppend: true,
            confirmRelayReadOnlyProbeReviewed: true,
            confirmRelayPeerPlanReviewed: true,
            peerRole: 'guest',
            leaseIp: '<home-lease-ip>',
            publicKey: '<home-wg-public-key>',
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-domestic-relay-peer-append'
          }
        },
        true,
        'Domestic relay read-only probe and peer plan should be reviewed before peer append handoff'
      ));
      actions.push(contextualAction(
        actionPolicy,
        'site-slot.worker-run.domestic-relay-peer-append-ssh',
        {
          path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(readyWorkerJob.jobId)}/run-domestic-relay-peer-append-ssh`,
          bodyTemplate: {
            confirmRemoteExecution: true,
            confirmRelayPeerAppendSsh: true,
            confirmRelayPeerAppend: true,
            confirmRelayReadOnlyProbeReviewed: true,
            confirmRelayPeerPlanReviewed: true,
            peerRole: 'guest',
            leaseIp: '<home-lease-ip>',
            publicKey: '<home-wg-public-key>',
            workerId: readyWorkerJob.worker.workerId,
            message: 'Domestic relay peer append SSH by admin-ui',
            requestedBy: actionPolicy.principal.principalId,
            requestId: 'admin-ui-worker-run-domestic-relay-peer-append-ssh'
          }
        },
        true,
        'Domestic relay peer append SSH requires remote SSH gates and explicit operator confirmation'
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
      true,
      'worker job must be ready before fake transport report'
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
      true,
      'worker job must be ready before simulated worker run'
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
  return adminActionTemplates().map((template) => {
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

function workerReportFailureSummary(report: SiteSlotWorkerReport): { phase: string; stepId: string; status: string; message: string } | null {
  const step = report.stepReports.find((item) => item.status === 'failed')
    ?? report.stepReports.find((item) => item.status === 'blocked');
  if (!step) return null;
  const evidence = parseJsonRecord(step.stdout ?? '');
  const executionResult = asRecord(evidence?.executionResult);
  const diagnosis = asRecord(executionResult?.diagnosis);
  const rawMessage = (diagnosis ? `${stringValue(diagnosis.category) ?? 'ssh'}: ${stringValue(diagnosis.summary) ?? 'remote execution failed'}` : null)
    ?? stringValue(step.stderr)
    ?? stringValue(executionResult?.stderr)
    ?? stringValue(executionResult?.stdout)
    ?? 'worker step failed';
  return {
    phase: stringValue(evidence?.phaseId) ?? phaseIdFromSource(step.sourceId),
    stepId: step.stepId,
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
        host: 'domestic.example.com',
        sshUser: 'root',
        hasDocker: true,
        hasOutboundInternet: false
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
      actionId: 'site-slot.worker-job.create',
      label: 'Create Worker Job',
      category: 'site-slot',
      method: 'POST',
      path: '/internal/v1/site-slots/runner-sessions/:sessionId/worker-jobs',
      requiredScopes: ['site-slot.execute'],
      gate: 'change-window',
      risk: 'medium',
      confirmFields: ['approvalId'],
      bodyTemplate: {
        workerId: 'worker-admin-1',
        workerKind: 'internal-runner',
        approvalId: 'approval-id',
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
      label: 'Remote SSH Worker Handoff',
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
        internalBaseUrl: '<internal-base-url>',
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

function bearerToken(authorization?: string): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.min(Math.floor(value), 50));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(1, Math.min(Math.floor(parsed), 50));
  }
  return fallback;
}
