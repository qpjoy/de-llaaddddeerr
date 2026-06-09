import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';

import { asRecord } from '../../lib/http.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';
import { buildSiteSlotRemoteSshGate, buildSiteSlotRemoteSshReadOnlyProbe, buildSiteSlotRemoteSshWorkerHandoff } from '../site-slots/remote-ssh-gate.js';
import type {
  AdminActionDescriptor,
  AdminActionPolicy,
  AdminDashboardSnapshot,
  AdminPipelineHealth,
  AdminSiteSlotPipeline,
  AdminSiteSlotPipelineSummary,
  AdminTimelineEntry,
  PlatformPrincipal,
  ReleaseManagementPlan,
  SiteHeartbeat,
  SiteSlotExecutionRun,
  SiteSlotExecutionMode,
  SiteSlotPlan,
  SiteSlotPlanInput,
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
    const [overview, sites, releasePlans, pipelines] = await Promise.all([
      this.store.overview(),
      this.store.listSites(),
      this.store.listReleaseManagementPlans(),
      this.buildSiteSlotPipelines(actionPolicy)
    ]);
    const summaries = pipelines.map((pipeline) => pipeline.summary);
    return {
      generatedAt: new Date().toISOString(),
      overview: overview as unknown as Record<string, unknown>,
      actionPolicy,
      sites: sortSites(sites).slice(0, limit),
      latestReleasePlans: sortReleasePlans(releasePlans).slice(0, limit),
      siteSlotPipelines: summaries.slice(0, limit),
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
    if (actionId === 'site-slot.runner.simulate' || actionId === 'site-slot.runner.remote-ssh') {
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
  if (value === 'simulate' || value === 'remote-ssh') return value;
  return null;
}

function siteSlotWorkerKind(value: unknown): SiteSlotWorkerKind | null {
  if (value === 'internal-runner' || value === 'domestic-runner' || value === 'oversea-site-agent' || value === 'admin-manual') return value;
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
    requestId: stringValue(body.requestId),
    createdBy: stringValue(body.createdBy)
  };
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
  const module = manifest?.modules.find((item) => basename(stringValue(item.artifactPath) ?? stringValue(item.artifact) ?? '') === basename(resolvedPath)) ?? null;
  const manifestSelfReference = basename(resolvedPath) === 'manifest.json';
  const sha256 = exists ? sha256File(resolvedPath) : null;
  if (!exists) failures.push(`missing artifact: ${ref} -> ${resolvedPath}`);
  if (exists && !manifest) failures.push(`missing artifact manifest for ${ref}`);
  if (exists && manifest && !module && !manifestSelfReference) failures.push(`artifact not listed in manifest: ${ref}`);
  if (exists && module?.sha256 && sha256 !== module.sha256) {
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
      sha256Status: module.sha256 === sha256 ? 'passed' : 'failed',
      bytes: module.bytes,
      metadata: module.metadata
    } : null
  };
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
      metadata: asRecord(module.metadata)
    }))
  };
}

function adminSshProfileEvidence(plan: SiteSlotPlan | null, profile: SiteSlotSshProfile | null) {
  const identityFileExists = profile?.identityFile ? existsSync(profile.identityFile) : null;
  const knownHostsFileExists = profile?.knownHostsFile ? existsSync(profile.knownHostsFile) : null;
  const gateWarnings = [
    ...(plan ? [] : ['plan not found while building dry-run SSH evidence']),
    ...(plan?.ssh.profileStatus === 'paused' || profile?.status === 'paused' ? ['managed SSH profile is paused'] : []),
    ...(profile?.identityFile && identityFileExists === false ? [`SSH identity file does not exist: ${profile.identityFile}`] : []),
    ...(profile?.knownHostsFile && knownHostsFileExists === false ? [`SSH known_hosts file does not exist: ${profile.knownHostsFile}`] : [])
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
  const parts = [
    '-o', shellQuote(`BatchMode=${profile?.batchMode ?? 'yes'}`),
    '-o', shellQuote(`ConnectTimeout=${profile?.connectTimeoutSeconds ?? 10}`),
    '-o', shellQuote(`StrictHostKeyChecking=${profile?.strictHostKeyChecking ?? 'yes'}`)
  ];
  if (profile?.identityFile) parts.push('-i', shellQuote(profile.identityFile));
  if (profile?.knownHostsFile) parts.push('-o', shellQuote(`UserKnownHostsFile=${profile.knownHostsFile}`));
  if (profile?.hostKeyAlias) parts.push('-o', shellQuote(`HostKeyAlias=${profile.hostKeyAlias}`));
  return parts.join(' ');
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
    }
  }

  if (sessionNeedingWorker) {
    actions.push(contextualAction(
      actionPolicy,
      'site-slot.worker-job.create',
      {
        path: `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(sessionNeedingWorker.sessionId)}/worker-jobs`,
        bodyTemplate: {
          workerId: 'worker-admin-1',
          workerKind: sessionNeedingWorker.kind === 'oversea' ? 'oversea-site-agent' : 'internal-runner',
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

  return actions.slice(0, 8);
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
