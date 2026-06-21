import { BadRequestException, Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asRecord, nullableString } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import { buildSiteSlotRemoteSshGate, buildSiteSlotRemoteSshReadOnlyProbe, buildSiteSlotRemoteSshWorkerHandoff } from './remote-ssh-gate.js';
import type {
  SiteSlotExecutionAction,
  SiteSlotExecutionInput,
  SiteSlotExecutionMode,
  SiteSlotKind,
  SiteSlotAccessAccount,
  SiteSlotPlanInput,
  SiteSlotPlan,
  SiteSlotRollbackExecutionInput,
  SiteSlotRollbackExecutionMode,
  SiteSlotRollbackReportInput,
  SiteSlotRollbackReportStatus,
  SiteSlotRunnerMode,
  SiteSlotRunnerStartInput,
  SiteSlotWorkerJobInput,
  SiteSlotWorkerKind,
  SiteSlotWorkerReportInput,
  SiteSlotWorkerReportStatus
} from '../../types.js';

@Controller()
export class SiteSlotsController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Get('internal/v1/site-slots/capabilities')
  capabilities() {
    return {
      capabilities: {
        model: 'internal-owned-slot-executor-v1',
        supportedKinds: ['domestic', 'oversea'],
        supportedActions: ['preflight', 'apply'],
        runnerModes: ['simulate', 'remote-ssh', 'awx-shadow'],
        executionProviders: ['internal-simulate', 'remote-ssh', 'awx-shadow'],
        executionBoundary: 'runner-session-v1',
        remoteExecution: 'disabled-by-default',
        applyGate: 'confirmApply-required',
        remoteExecutionGate: 'SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED-and-confirmRemoteExecution-required',
        workerContract: {
          version: 'site-slot-worker-v1',
          endpoints: ['worker-jobs', 'remote-ssh-gate', 'remote-ssh-handoff', 'worker-reports'],
          reportFields: ['stdout', 'stderr', 'exitCode', 'attempt', 'startedAt', 'finishedAt'],
          failurePolicy: 'stopOnFailure-and-rollbackPolicy'
        },
        rollbackContract: {
          version: 'site-slot-rollback-v1',
          endpoints: ['rollback-executions', 'rollback-reports'],
          modes: ['simulate', 'manual'],
          confirmationGate: 'confirmRollback-required-when-rollbackPlan-required'
        },
        hostServicePolicy: {
          domestic: ['wireguard-tools', 'wg-quick@mx-domestic', 'forwarding-firewall'],
          oversea: ['optional-hysteria2-systemd']
        },
        dockerPolicy: {
          default: 'docker-preferred',
          domestic: ['edge-api', 'h2i-proxy', 'snapshot-cache', 'observability-forwarder'],
          oversea: ['hysteria2-access-stack', 'site-agent', 'observability-forwarder']
        }
      }
    };
  }

  @Get('internal/v1/site-slots/plans')
  async listPlans() {
    return { plans: await this.store.listSiteSlotPlans() };
  }

  @Post('internal/v1/site-slots/:siteId/access-accounts')
  async issueAccessAccounts(@Param('siteId') siteId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return this.store.issueSiteSlotAccessAccounts({
      siteId,
      service: nullableString(body.service) ?? 'hysteria2',
      accountNames: accountNamesValue(body.accountNames ?? body.accounts),
      issueDefaults: booleanValue(body.issueDefaults),
      publicHost: nullableString(body.publicHost),
      serverPorts: nullableString(body.serverPorts),
      tlsFingerprint: nullableString(body.tlsFingerprint),
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId)
    });
  }

  @Get('internal/v1/site-slots/:siteId/access-accounts')
  async listAccessAccounts(@Param('siteId') siteId: string) {
    const site = await this.store.getLauncherNetworkMihomoSite(siteId);
    return {
      site,
      accounts: await this.store.listSiteSlotAccessAccounts(siteId)
    };
  }

  @Get('internal/v1/site-slots/:siteId/subscriptions/hysteria2/:username.yaml')
  @Header('content-type', 'text/yaml; charset=utf-8')
  async getHysteria2MihomoSubscription(@Param('siteId') siteId: string, @Param('username') username: string) {
    const subscription = await this.store.renderHysteria2MihomoSubscription(siteId, username);
    if (!subscription) throw new NotFoundException('Hysteria2 mihomo subscription not found');
    return subscription.yaml;
  }

  @Post('internal/v1/site-slots/plans')
  async createPlan(@Body() rawBody: unknown) {
    const input = await this.withDomesticBootstrapAccess(toSiteSlotPlanInput(asRecord(rawBody)));
    const hostFailure = await this.domesticPlanHostValidationFailure(input);
    if (hostFailure) throw new BadRequestException(hostFailure);
    const plan = await this.store.createSiteSlotPlan(input);
    await this.materializeDomesticBootstrapSubscription(plan);
    return { plan };
  }

  @Get('internal/v1/site-slots/plans/:planId')
  async getPlan(@Param('planId') planId: string) {
    const plan = await this.store.getSiteSlotPlan(planId);
    if (!plan) throw new NotFoundException('Site slot plan not found');
    return { plan };
  }

  @Get('internal/v1/site-slots/executions')
  async listExecutions(@Query('planId') planId?: string) {
    return { executions: await this.store.listSiteSlotExecutions(planId ?? null) };
  }

  @Post('internal/v1/site-slots/executions')
  async createExecution(@Body() rawBody: unknown) {
    return { execution: await this.createExecutionOr404(toSiteSlotExecutionInput(asRecord(rawBody))) };
  }

  @Get('internal/v1/site-slots/runner-sessions')
  async listRunnerSessions(@Query('runId') runId?: string) {
    return { sessions: await this.store.listSiteSlotRunnerSessions(runId ?? null) };
  }

  @Post('internal/v1/site-slots/executions/:runId/runner-sessions')
  async startRunnerSession(@Param('runId') runId: string, @Body() rawBody: unknown) {
    return {
      session: await this.startRunnerSessionOr404({
        ...toSiteSlotRunnerStartInput(asRecord(rawBody)),
        runId
      })
    };
  }

  @Get('internal/v1/site-slots/runner-sessions/:sessionId')
  async getRunnerSession(@Param('sessionId') sessionId: string) {
    const session = await this.store.getSiteSlotRunnerSession(sessionId);
    if (!session) throw new NotFoundException('Site slot runner session not found');
    return { session };
  }

  @Get('internal/v1/site-slots/worker-jobs')
  async listWorkerJobs(@Query('sessionId') sessionId?: string) {
    return { jobs: await this.store.listSiteSlotWorkerJobs(sessionId ?? null) };
  }

  @Post('internal/v1/site-slots/runner-sessions/:sessionId/worker-jobs')
  async createWorkerJob(@Param('sessionId') sessionId: string, @Body() rawBody: unknown) {
    return {
      job: await this.createWorkerJobOr404({
        ...toSiteSlotWorkerJobInput(asRecord(rawBody)),
        sessionId
      })
    };
  }

  @Get('internal/v1/site-slots/worker-jobs/:jobId')
  async getWorkerJob(@Param('jobId') jobId: string) {
    const job = await this.store.getSiteSlotWorkerJob(jobId);
    if (!job) throw new NotFoundException('Site slot worker job not found');
    return { job };
  }

  @Post('internal/v1/site-slots/worker-jobs/:jobId/remote-ssh-gate')
  async reviewWorkerRemoteSshGate(@Param('jobId') jobId: string, @Body() rawBody: unknown) {
    const job = await this.store.getSiteSlotWorkerJob(jobId);
    if (!job) throw new NotFoundException('Site slot worker job not found');
    const plan = await this.store.getSiteSlotPlan(job.planId);
    const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
    const body = asRecord(rawBody);
    return {
      gate: buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
        confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
        requestedBy: nullableString(body.requestedBy),
        requestId: nullableString(body.requestId)
      })
    };
  }

  @Post('internal/v1/site-slots/worker-jobs/:jobId/remote-ssh-readonly-probe')
  async createWorkerRemoteSshReadOnlyProbe(@Param('jobId') jobId: string, @Body() rawBody: unknown) {
    const job = await this.store.getSiteSlotWorkerJob(jobId);
    if (!job) throw new NotFoundException('Site slot worker job not found');
    const plan = await this.store.getSiteSlotPlan(job.planId);
    const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
    const body = asRecord(rawBody);
    const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
      confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId)
    });
    return {
      gate,
      readOnlyProbe: buildSiteSlotRemoteSshReadOnlyProbe(job, plan, sshProfile, gate, {
        confirmReadOnlyProbe: booleanValue(body.confirmReadOnlyProbe) === true
      })
    };
  }

  @Post('internal/v1/site-slots/worker-jobs/:jobId/run-artifact-push-remote-ssh')
  async createWorkerRemoteSshHandoff(@Param('jobId') jobId: string, @Body() rawBody: unknown) {
    const job = await this.store.getSiteSlotWorkerJob(jobId);
    if (!job) throw new NotFoundException('Site slot worker job not found');
    const plan = await this.store.getSiteSlotPlan(job.planId);
    const sshProfile = plan?.ssh.profileId ? await this.store.getSiteSlotSshProfile(plan.ssh.profileId) : null;
    const body = asRecord(rawBody);
    const gate = buildSiteSlotRemoteSshGate(job, plan, sshProfile, {
      confirmRemoteExecution: booleanValue(body.confirmRemoteExecution) === true,
      requestedBy: nullableString(body.requestedBy),
      requestId: nullableString(body.requestId)
    });
    return {
      gate,
      workerHandoff: buildSiteSlotRemoteSshWorkerHandoff(job, plan, gate, {
        internalBaseUrl: nullableString(body.internalBaseUrl),
        confirmWorkerHandoff: booleanValue(body.confirmWorkerHandoff) === true
      })
    };
  }

  @Get('internal/v1/site-slots/worker-reports')
  async listWorkerReports(@Query('jobId') jobId?: string) {
    return { reports: await this.store.listSiteSlotWorkerReports(jobId ?? null) };
  }

  @Post('internal/v1/site-slots/worker-jobs/:jobId/reports')
  async recordWorkerReport(@Param('jobId') jobId: string, @Body() rawBody: unknown) {
    return {
      report: await this.recordWorkerReportOr404({
        ...toSiteSlotWorkerReportInput(asRecord(rawBody)),
        jobId
      })
    };
  }

  @Get('internal/v1/site-slots/worker-reports/:reportId')
  async getWorkerReport(@Param('reportId') reportId: string) {
    const report = await this.store.getSiteSlotWorkerReport(reportId);
    if (!report) throw new NotFoundException('Site slot worker report not found');
    return { report };
  }

  @Get('internal/v1/site-slots/rollback-executions')
  async listRollbackExecutions(@Query('reportId') reportId?: string) {
    return { rollbackExecutions: await this.store.listSiteSlotRollbackExecutions(reportId ?? null) };
  }

  @Post('internal/v1/site-slots/worker-reports/:reportId/rollback-executions')
  async createRollbackExecution(@Param('reportId') reportId: string, @Body() rawBody: unknown) {
    return {
      rollbackExecution: await this.createRollbackExecutionOr404({
        ...toSiteSlotRollbackExecutionInput(asRecord(rawBody)),
        reportId
      })
    };
  }

  @Get('internal/v1/site-slots/rollback-executions/:rollbackExecutionId')
  async getRollbackExecution(@Param('rollbackExecutionId') rollbackExecutionId: string) {
    const rollbackExecution = await this.store.getSiteSlotRollbackExecution(rollbackExecutionId);
    if (!rollbackExecution) throw new NotFoundException('Site slot rollback execution not found');
    return { rollbackExecution };
  }

  @Get('internal/v1/site-slots/rollback-reports')
  async listRollbackReports(@Query('rollbackExecutionId') rollbackExecutionId?: string) {
    return { rollbackReports: await this.store.listSiteSlotRollbackReports(rollbackExecutionId ?? null) };
  }

  @Post('internal/v1/site-slots/rollback-executions/:rollbackExecutionId/reports')
  async recordRollbackReport(@Param('rollbackExecutionId') rollbackExecutionId: string, @Body() rawBody: unknown) {
    return {
      rollbackReport: await this.recordRollbackReportOr404({
        ...toSiteSlotRollbackReportInput(asRecord(rawBody)),
        rollbackExecutionId
      })
    };
  }

  @Get('internal/v1/site-slots/rollback-reports/:rollbackReportId')
  async getRollbackReport(@Param('rollbackReportId') rollbackReportId: string) {
    const rollbackReport = await this.store.getSiteSlotRollbackReport(rollbackReportId);
    if (!rollbackReport) throw new NotFoundException('Site slot rollback report not found');
    return { rollbackReport };
  }

  @Get('internal/v1/site-slots/executions/:runId')
  async getExecution(@Param('runId') runId: string) {
    const execution = await this.store.getSiteSlotExecution(runId);
    if (!execution) throw new NotFoundException('Site slot execution not found');
    return { execution };
  }

  @Post('internal/v1/site-slots/plans/:planId/preflight')
  async createPreflight(@Param('planId') planId: string, @Body() rawBody: unknown) {
    return {
      execution: await this.createExecutionOr404({
        ...toSiteSlotExecutionInput(asRecord(rawBody)),
        planId,
        action: 'preflight'
      })
    };
  }

  @Post('internal/v1/site-slots/plans/:planId/apply')
  async createApply(@Param('planId') planId: string, @Body() rawBody: unknown) {
    return {
      execution: await this.createExecutionOr404({
        ...toSiteSlotExecutionInput(asRecord(rawBody)),
        planId,
        action: 'apply'
      })
    };
  }

  private async createExecutionOr404(input: SiteSlotExecutionInput) {
    try {
      return await this.store.createSiteSlotExecution(input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown site slot plan:')) {
        throw new NotFoundException('Site slot plan not found');
      }
      throw error;
    }
  }

  private async startRunnerSessionOr404(input: SiteSlotRunnerStartInput) {
    try {
      return await this.store.startSiteSlotRunnerSession(input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown site slot execution:')) {
        throw new NotFoundException('Site slot execution not found');
      }
      throw error;
    }
  }

  private async createWorkerJobOr404(input: SiteSlotWorkerJobInput) {
    try {
      return await this.store.createSiteSlotWorkerJob(input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown site slot runner session:')) {
        throw new NotFoundException('Site slot runner session not found');
      }
      throw error;
    }
  }

  private async recordWorkerReportOr404(input: SiteSlotWorkerReportInput) {
    try {
      return await this.store.recordSiteSlotWorkerReport(input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown site slot worker job:')) {
        throw new NotFoundException('Site slot worker job not found');
      }
      throw error;
    }
  }

  private async createRollbackExecutionOr404(input: SiteSlotRollbackExecutionInput) {
    try {
      return await this.store.createSiteSlotRollbackExecution(input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown site slot worker report:')) {
        throw new NotFoundException('Site slot worker report not found');
      }
      throw error;
    }
  }

  private async recordRollbackReportOr404(input: SiteSlotRollbackReportInput) {
    try {
      return await this.store.recordSiteSlotRollbackReport(input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown site slot rollback execution:')) {
        throw new NotFoundException('Site slot rollback execution not found');
      }
      throw error;
    }
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
      requestedBy: input.createdBy ?? 'site-slots-controller',
      requestId: `${input.requestId ?? 'site-slot-plan'}-domestic-bootstrap`
    });
    const accounts = await this.store.listSiteSlotAccessAccounts(overseaSiteId);
    return {
      ...input,
      overseaSiteId,
      accessAccounts: siteSlotPlanAccessAccountMaterial(accounts)
    };
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

  private async materializeDomesticBootstrapSubscription(plan: SiteSlotPlan): Promise<void> {
    if (plan.kind !== 'domestic' || plan.network.mode !== 'oversea-assisted' || !plan.network.overseaSiteId) return;
    const accounts = await this.store.listSiteSlotAccessAccounts(plan.network.overseaSiteId);
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
}

function siteSlotPlanAccessAccountMaterial(accounts: SiteSlotAccessAccount[]): SiteSlotPlanInput['accessAccounts'] {
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

function toSiteSlotPlanInput(body: Record<string, unknown>): SiteSlotPlanInput {
  return {
    siteId: nullableString(body.siteId),
    kind: siteSlotKind(body.kind),
    sshProfileId: nullableString(body.sshProfileId),
    host: nullableString(body.host),
    sshUser: nullableString(body.sshUser),
    sshPort: numberValue(body.sshPort),
    rootAccess: booleanValue(body.rootAccess),
    hasDocker: booleanValue(body.hasDocker),
    hasOutboundInternet: booleanValue(body.hasOutboundInternet),
    overseaSiteId: nullableString(body.overseaSiteId),
    overseaHost: nullableString(body.overseaHost),
    serverPorts: nullableString(body.serverPorts),
    exportPort: numberValue(body.exportPort),
    internalBaseUrl: nullableString(body.internalBaseUrl),
    workerInternalBaseUrl: nullableString(body.workerInternalBaseUrl),
    overseaCallbackBaseUrl: nullableString(body.overseaCallbackBaseUrl),
    accessAccounts: siteSlotPlanAccessAccountsValue(body.accessAccounts),
    requestId: nullableString(body.requestId),
    createdBy: nullableString(body.createdBy)
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

function toSiteSlotExecutionInput(body: Record<string, unknown>): SiteSlotExecutionInput {
  return {
    planId: nullableString(body.planId),
    action: siteSlotExecutionAction(body.action),
    mode: siteSlotExecutionMode(body.mode),
    confirmApply: booleanValue(body.confirmApply),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toSiteSlotRunnerStartInput(body: Record<string, unknown>): SiteSlotRunnerStartInput {
  return {
    runId: nullableString(body.runId),
    mode: siteSlotRunnerMode(body.mode),
    confirmRemoteExecution: booleanValue(body.confirmRemoteExecution),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toSiteSlotWorkerJobInput(body: Record<string, unknown>): SiteSlotWorkerJobInput {
  return {
    sessionId: nullableString(body.sessionId),
    workerId: nullableString(body.workerId),
    workerKind: siteSlotWorkerKind(body.workerKind),
    approvalId: nullableString(body.approvalId),
    changeWindowStart: nullableString(body.changeWindowStart),
    changeWindowEnd: nullableString(body.changeWindowEnd),
    retryLimit: numberValue(body.retryLimit),
    rollbackStrategy: nullableString(body.rollbackStrategy),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toSiteSlotWorkerReportInput(body: Record<string, unknown>): SiteSlotWorkerReportInput {
  return {
    jobId: nullableString(body.jobId),
    workerId: nullableString(body.workerId),
    status: siteSlotWorkerReportStatus(body.status),
    message: nullableString(body.message),
    stepReports: stepReportArray(body.stepReports),
    requestId: nullableString(body.requestId)
  };
}

function toSiteSlotRollbackExecutionInput(body: Record<string, unknown>): SiteSlotRollbackExecutionInput {
  return {
    reportId: nullableString(body.reportId),
    mode: siteSlotRollbackExecutionMode(body.mode),
    confirmRollback: booleanValue(body.confirmRollback),
    requestedBy: nullableString(body.requestedBy),
    requestId: nullableString(body.requestId)
  };
}

function toSiteSlotRollbackReportInput(body: Record<string, unknown>): SiteSlotRollbackReportInput {
  return {
    rollbackExecutionId: nullableString(body.rollbackExecutionId),
    workerId: nullableString(body.workerId),
    status: siteSlotRollbackReportStatus(body.status),
    message: nullableString(body.message),
    stepReports: rollbackStepReportArray(body.stepReports),
    requestId: nullableString(body.requestId)
  };
}

function siteSlotKind(value: unknown): SiteSlotKind | null {
  if (value === 'domestic' || value === 'oversea') return value;
  return null;
}

function siteSlotExecutionAction(value: unknown): SiteSlotExecutionAction | null {
  if (value === 'preflight' || value === 'apply') return value;
  return null;
}

function siteSlotExecutionMode(value: unknown): SiteSlotExecutionMode | null {
  if (value === 'dry-run' || value === 'manual' || value === 'ssh') return value;
  return null;
}

function siteSlotRunnerMode(value: unknown): SiteSlotRunnerMode | null {
  if (value === 'simulate' || value === 'remote-ssh' || value === 'awx-shadow') return value;
  return null;
}

function siteSlotRollbackExecutionMode(value: unknown): SiteSlotRollbackExecutionMode | null {
  if (value === 'simulate' || value === 'manual') return value;
  return null;
}

function siteSlotWorkerKind(value: unknown): SiteSlotWorkerKind | null {
  if (value === 'internal-runner' || value === 'domestic-runner' || value === 'oversea-site-agent' || value === 'awx-runner' || value === 'admin-manual') return value;
  return null;
}

function siteSlotWorkerReportStatus(value: unknown): SiteSlotWorkerReportStatus | null {
  if (value === 'running' || value === 'passed' || value === 'failed' || value === 'blocked') return value;
  return null;
}

function siteSlotRollbackReportStatus(value: unknown): SiteSlotRollbackReportStatus | null {
  if (value === 'running' || value === 'passed' || value === 'failed' || value === 'blocked') return value;
  return null;
}

function stepReportArray(value: unknown): SiteSlotWorkerReportInput['stepReports'] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    return {
      stepId: nullableString(row.stepId),
      status: siteSlotWorkerReportStatus(row.status),
      exitCode: numberValue(row.exitCode),
      stdout: nullableString(row.stdout),
      stderr: nullableString(row.stderr),
      startedAt: nullableString(row.startedAt),
      finishedAt: nullableString(row.finishedAt),
      attempt: numberValue(row.attempt)
    };
  });
}

function accountNamesValue(value: unknown): string[] | string | null {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  return nullableString(value);
}

function siteSlotPlanAccessAccountsValue(value: unknown): SiteSlotPlanInput['accessAccounts'] {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    const row = asRecord(item);
    return {
      username: nullableString(row.username) ?? '',
      authToken: nullableString(row.authToken) ?? '',
      status: nullableString(row.status),
      upRate: nullableString(row.upRate),
      downRate: nullableString(row.downRate)
    };
  }).filter((account) => account.username && account.authToken);
}

function rollbackStepReportArray(value: unknown): SiteSlotRollbackReportInput['stepReports'] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    return {
      stepId: nullableString(row.stepId),
      status: siteSlotRollbackReportStatus(row.status),
      exitCode: numberValue(row.exitCode),
      stdout: nullableString(row.stdout),
      stderr: nullableString(row.stderr),
      startedAt: nullableString(row.startedAt),
      finishedAt: nullableString(row.finishedAt),
      attempt: numberValue(row.attempt)
    };
  });
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
