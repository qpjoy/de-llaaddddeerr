import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { DataSource, Repository } from 'typeorm';

import { createPlatformDataSource } from '../db/data-source.js';
import { PlatformRecordEntity, type PlatformRecordRow } from '../db/entities.js';
import type {
  AnonymousEnrollment,
  AnonymousEnrollmentRequest,
  AppCenterApp,
  AuditEvent,
  AuditEventInput,
  ConfigPolicySnapshot,
  ConfigPolicySnapshotInput,
  ConfigSnapshot,
  CoreDnsConfigMapApplyInput,
  CoreDnsConfigMapApplyResult,
  CoreDnsConfigMapSyncInput,
  CoreDnsConfigMapSyncResult,
  CreateServiceAccountInput,
  CreateUserInput,
  DnsPolicy,
  DnsQueryInput,
  DnsResolutionDecision,
  DnsReverseProxyRoute,
  DnsZoneSnapshot,
  DnsZoneSnapshotInput,
  IdentityLinkRequest,
  IssueTokenInput,
  LauncherNetworkSnapshot,
  LauncherNetworkSnapshotInput,
  LogEntryInput,
  PermissionGrant,
  PermissionRequestInput,
  PrincipalContext,
  PrincipalContextInput,
  PlatformKernelSmokeResult,
  ReleaseManagementPlan,
  ReleaseManagementPlanInput,
  ReleasePolicyDecision,
  ReleasePolicyInput,
  ReleaseReportInput,
  ReleaseTask,
  RuntimeConfig,
  RuntimeFeaturePolicy,
  RuntimeFeaturePolicyInput,
  SdkGatewayAccessDecision,
  SdkGatewayAccessInput,
  SdkGatewayManifest,
  SiteHeartbeat,
  SiteSlotExecutionInput,
  SiteSlotExecutionRun,
  SiteSlotPlan,
  SiteSlotPlanInput,
  SiteSlotRollbackExecution,
  SiteSlotRollbackExecutionInput,
  SiteSlotRollbackReport,
  SiteSlotRollbackReportInput,
  SiteSlotRunnerSession,
  SiteSlotRunnerStartInput,
  SiteSlotSshProfile,
  SiteSlotSshProfileInput,
  SiteSlotWorkerJob,
  SiteSlotWorkerJobInput,
  SiteSlotWorkerReport,
  SiteSlotWorkerReportInput,
  SiteRole,
  TestGateInput,
  TestGateVerdict,
  TokenIntrospectionInput,
  TokenIntrospectionResult,
  UserCenterBootstrapResult,
  UserCenterIssuedToken,
  UserCenterOrg,
  UserCenterRole,
  UserCenterServiceAccount,
  UserCenterTenant,
  UserCenterTokenRecord,
  UserCenterUser,
  TestRun,
  TestRunInput,
  TestStep,
  TestStepInput
} from '../types.js';
import {
  builtinAppCenterApps,
  buildReleaseManagementPlan,
  buildRuntimeFeaturePolicy,
  buildSiteSlotExecutionRun,
  buildSiteSlotPlan,
  buildSiteSlotRunnerSession,
  buildSiteSlotSshProfile,
  buildSiteSlotRollbackExecution,
  buildSiteSlotRollbackReport,
  buildSiteSlotWorkerJob,
  buildSiteSlotWorkerReport,
  applySiteSlotRollbackReportState,
  applySiteSlotWorkerReportState,
  buildDnsZoneSnapshot,
  builtinDnsPolicies,
  builtinDnsReverseProxyRoutes,
  builtinUserCenterOrg,
  builtinUserCenterRoles,
  builtinUserCenterTenant,
  createBootstrapResult,
  createConfigPolicySnapshot,
  createConfigSnapshot,
  createSdkGatewayManifest,
  createServiceAccountPrincipalFromRecord,
  createUserCenterServiceAccount,
  createUserCenterTokenRecord,
  createUserCenterUser,
  createUserPrincipalFromRecord,
  evaluateCoreDnsConfigMapApplyGate,
  evaluateSdkGatewayRoute,
  evaluateDnsPolicy,
  hashToken,
  introspectUserCenterToken,
  introspectShadowToken,
  normalizeTestStatus,
  normalizeUpdatePolicy,
  releasePolicyByKind,
  renderCoreDnsConfigMap,
  resolvePrincipalContext,
  required
} from './domain.js';
import { applyCoreDnsConfigMapToKubernetes } from './kubernetes.js';
import type { PlatformOverview, PlatformStore } from './platform-store.js';

type RecordKind =
  | 'site-heartbeat'
  | 'anonymous-enrollment'
  | 'config-snapshot'
  | 'config-policy-snapshot'
  | 'release-task'
  | 'release-policy-decision'
  | 'iam-tenant'
  | 'iam-org'
  | 'iam-role'
  | 'iam-user'
  | 'iam-service-account'
  | 'iam-token'
  | 'dns-policy'
  | 'dns-reverse-proxy-route'
  | 'dns-zone-snapshot'
  | 'coredns-configmap-sync'
  | 'coredns-configmap-apply'
  | 'release-management-plan'
  | 'site-slot-plan'
  | 'site-slot-execution'
  | 'site-slot-runner-session'
  | 'site-slot-worker-job'
  | 'site-slot-worker-report'
  | 'site-slot-rollback-execution'
  | 'site-slot-rollback-report'
  | 'site-slot-ssh-profile'
  | 'runtime-feature-policy'
  | 'app-center-app'
  | 'permission-grant'
  | 'launcher-network-snapshot'
  | 'test-run'
  | 'test-gate-verdict'
  | 'audit-event'
  | 'log-entry';

type SequenceName = 'mx_overlay_ip_seq' | 'mx_guest_ip_seq' | 'mx_user_ip_seq';

export class PostgresStore implements PlatformStore {
  private constructor(
    private readonly config: RuntimeConfig,
    private readonly dataSource: DataSource,
    private readonly records: Repository<PlatformRecordRow>
  ) {}

  static async create(config: RuntimeConfig): Promise<PostgresStore> {
    const dataSource = createPlatformDataSource(config);
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const store = new PostgresStore(config, dataSource, dataSource.getRepository(PlatformRecordEntity));
    await store.registerBuiltinApps();
    await store.registerBuiltinDns();
    return store;
  }

  async overview(): Promise<PlatformOverview> {
    const [
      sites,
      enrollments,
      snapshots,
      configPolicySnapshots,
      appCenterApps,
      userCenterUsers,
      userCenterServiceAccounts,
      userCenterTokens,
      siteSlotPlans,
      siteSlotExecutions,
      siteSlotRunnerSessions,
      siteSlotWorkerJobs,
      siteSlotWorkerReports,
      siteSlotRollbackExecutions,
      siteSlotRollbackReports,
      dnsPolicies,
      dnsReverseProxyRoutes,
      dnsZoneSnapshots,
      coreDnsConfigMapSyncs,
      coreDnsConfigMapApplies,
      releaseManagementPlans,
      permissionGrants,
      testRuns,
      auditEvents,
      logs
    ] = await Promise.all([
      this.countRecords('site-heartbeat'),
      this.countRecords('anonymous-enrollment'),
      this.countRecords('config-snapshot'),
      this.countRecords('config-policy-snapshot'),
      this.countRecords('app-center-app'),
      this.countRecords('iam-user'),
      this.countRecords('iam-service-account'),
      this.countRecords('iam-token'),
      this.countRecords('site-slot-plan'),
      this.countRecords('site-slot-execution'),
      this.countRecords('site-slot-runner-session'),
      this.countRecords('site-slot-worker-job'),
      this.countRecords('site-slot-worker-report'),
      this.countRecords('site-slot-rollback-execution'),
      this.countRecords('site-slot-rollback-report'),
      this.countRecords('dns-policy'),
      this.countRecords('dns-reverse-proxy-route'),
      this.countRecords('dns-zone-snapshot'),
      this.countRecords('coredns-configmap-sync'),
      this.countRecords('coredns-configmap-apply'),
      this.countRecords('release-management-plan'),
      this.countRecords('permission-grant'),
      this.countRecords('test-run'),
      this.countRecords('audit-event'),
      this.countRecords('log-entry')
    ]);
    return {
      environment: this.config.environment,
      siteId: this.config.siteId,
      siteRole: this.config.siteRole,
      enabledModules: this.config.enabledModules,
      storeDriver: this.config.storeDriver,
      sites,
      enrollments,
      snapshots,
      configPolicySnapshots,
      appCenterApps,
      userCenterUsers,
      userCenterServiceAccounts,
      userCenterTokens,
      siteSlotPlans,
      siteSlotExecutions,
      siteSlotRunnerSessions,
      siteSlotWorkerJobs,
      siteSlotWorkerReports,
      siteSlotRollbackExecutions,
      siteSlotRollbackReports,
      dnsPolicies,
      dnsReverseProxyRoutes,
      dnsZoneSnapshots,
      coreDnsConfigMapSyncs,
      coreDnsConfigMapApplies,
      releaseManagementPlans,
      permissionGrants,
      testRuns,
      auditEvents,
      logs
    };
  }

  async upsertSiteHeartbeat(
    heartbeat: Omit<SiteHeartbeat, 'environment' | 'lastSeenAt' | 'siteRole'> & { siteRole?: SiteRole }
  ): Promise<SiteHeartbeat> {
    const row: SiteHeartbeat = {
      ...heartbeat,
      environment: this.config.environment,
      siteRole: heartbeat.siteRole ?? this.config.siteRole,
      lastSeenAt: new Date().toISOString()
    };
    await this.saveRecord('site-heartbeat', row.siteId, row, row.siteId);
    return row;
  }

  async listSites(): Promise<SiteHeartbeat[]> {
    return (await this.listRecords<SiteHeartbeat>('site-heartbeat')).sort((a, b) => a.siteId.localeCompare(b.siteId));
  }

  async createSiteSlotPlan(input: SiteSlotPlanInput): Promise<SiteSlotPlan> {
    const planInput = await this.withSiteSlotSshProfile(input);
    const plan = buildSiteSlotPlan(this.config, planInput, `slotplan_${randomUUID()}`);
    await this.saveRecord('site-slot-plan', plan.planId, plan, plan.siteId);
    await this.recordAudit({
      eventType: 'site_slot.plan.created',
      actorKind: 'deploy-center',
      requestId: planInput.requestId ?? null,
      metadata: {
        planId: plan.planId,
        siteId: plan.siteId,
        kind: plan.kind,
        status: plan.status,
        networkMode: plan.network.mode,
        requiresOversea: plan.network.requiresOversea,
        nextActions: plan.nextActions
      }
    });
    return plan;
  }

  async getSiteSlotPlan(planId: string): Promise<SiteSlotPlan | null> {
    return this.getRecord<SiteSlotPlan>('site-slot-plan', planId);
  }

  async listSiteSlotPlans(): Promise<SiteSlotPlan[]> {
    return (await this.listRecords<SiteSlotPlan>('site-slot-plan')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createSiteSlotExecution(input: SiteSlotExecutionInput): Promise<SiteSlotExecutionRun> {
    const planId = input.planId?.trim();
    const plan = planId ? await this.getRecord<SiteSlotPlan>('site-slot-plan', planId) : null;
    if (!plan) throw new Error(`Unknown site slot plan: ${input.planId ?? '<empty>'}`);
    const run = buildSiteSlotExecutionRun(this.config, plan, input, `slotexec_${randomUUID()}`);
    await this.saveRecord('site-slot-execution', run.runId, run, run.siteId);
    await this.recordAudit({
      eventType: 'site_slot.execution.created',
      actorKind: 'deploy-center',
      requestId: input.requestId ?? null,
      metadata: {
        runId: run.runId,
        planId: run.planId,
        siteId: run.siteId,
        kind: run.kind,
        action: run.action,
        mode: run.mode,
        status: run.status,
        stepCount: run.steps.length,
        nextActions: run.nextActions
      }
    });
    return run;
  }

  async getSiteSlotExecution(runId: string): Promise<SiteSlotExecutionRun | null> {
    return this.getRecord<SiteSlotExecutionRun>('site-slot-execution', runId);
  }

  async listSiteSlotExecutions(planId?: string | null): Promise<SiteSlotExecutionRun[]> {
    return (await this.listRecords<SiteSlotExecutionRun>('site-slot-execution'))
      .filter((run) => !planId || run.planId === planId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async startSiteSlotRunnerSession(input: SiteSlotRunnerStartInput): Promise<SiteSlotRunnerSession> {
    const runId = input.runId?.trim();
    const execution = runId ? await this.getRecord<SiteSlotExecutionRun>('site-slot-execution', runId) : null;
    if (!execution) throw new Error(`Unknown site slot execution: ${input.runId ?? '<empty>'}`);
    const session = buildSiteSlotRunnerSession(this.config, execution, input, `slotrunner_${randomUUID()}`);
    await this.saveRecord('site-slot-runner-session', session.sessionId, session, session.siteId);
    await this.recordAudit({
      eventType: 'site_slot.runner.started',
      actorKind: 'runner-controller',
      requestId: input.requestId ?? null,
      metadata: {
        sessionId: session.sessionId,
        runId: session.runId,
        planId: session.planId,
        siteId: session.siteId,
        kind: session.kind,
        mode: session.mode,
        status: session.status,
        stepCount: session.stepResults.length,
        nextActions: session.nextActions
      }
    });
    return session;
  }

  async getSiteSlotRunnerSession(sessionId: string): Promise<SiteSlotRunnerSession | null> {
    return this.getRecord<SiteSlotRunnerSession>('site-slot-runner-session', sessionId);
  }

  async listSiteSlotRunnerSessions(runId?: string | null): Promise<SiteSlotRunnerSession[]> {
    return (await this.listRecords<SiteSlotRunnerSession>('site-slot-runner-session'))
      .filter((session) => !runId || session.runId === runId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async createSiteSlotWorkerJob(input: SiteSlotWorkerJobInput): Promise<SiteSlotWorkerJob> {
    const sessionId = input.sessionId?.trim();
    const session = sessionId ? await this.getRecord<SiteSlotRunnerSession>('site-slot-runner-session', sessionId) : null;
    if (!session) throw new Error(`Unknown site slot runner session: ${input.sessionId ?? '<empty>'}`);
    const job = buildSiteSlotWorkerJob(session, input, `slotjob_${randomUUID()}`);
    await this.saveRecord('site-slot-worker-job', job.jobId, job, job.siteId);
    await this.recordAudit({
      eventType: 'site_slot.worker_job.created',
      actorKind: 'runner-controller',
      requestId: input.requestId ?? null,
      metadata: {
        jobId: job.jobId,
        sessionId: job.sessionId,
        runId: job.runId,
        planId: job.planId,
        siteId: job.siteId,
        mode: job.mode,
        status: job.status,
        workerKind: job.worker.kind,
        stepCount: job.steps.length,
        nextActions: job.nextActions
      }
    });
    return job;
  }

  async getSiteSlotWorkerJob(jobId: string): Promise<SiteSlotWorkerJob | null> {
    return this.getRecord<SiteSlotWorkerJob>('site-slot-worker-job', jobId);
  }

  async listSiteSlotWorkerJobs(sessionId?: string | null): Promise<SiteSlotWorkerJob[]> {
    return (await this.listRecords<SiteSlotWorkerJob>('site-slot-worker-job'))
      .filter((job) => !sessionId || job.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recordSiteSlotWorkerReport(input: SiteSlotWorkerReportInput): Promise<SiteSlotWorkerReport> {
    const jobId = input.jobId?.trim();
    const job = jobId ? await this.getRecord<SiteSlotWorkerJob>('site-slot-worker-job', jobId) : null;
    if (!job) throw new Error(`Unknown site slot worker job: ${input.jobId ?? '<empty>'}`);
    const report = buildSiteSlotWorkerReport(job, input, `slotreport_${randomUUID()}`);
    const session = await this.getRecord<SiteSlotRunnerSession>('site-slot-runner-session', job.sessionId);
    if (session) {
      const state = applySiteSlotWorkerReportState(job, session, report);
      await this.saveRecord('site-slot-worker-job', state.job.jobId, state.job, state.job.siteId);
      await this.saveRecord('site-slot-runner-session', state.session.sessionId, state.session, state.session.siteId);
    }
    await this.saveRecord('site-slot-worker-report', report.reportId, report, report.siteId);
    await this.recordAudit({
      eventType: 'site_slot.worker_report.recorded',
      actorKind: 'runner-worker',
      requestId: input.requestId ?? null,
      metadata: {
        reportId: report.reportId,
        jobId: report.jobId,
        sessionId: report.sessionId,
        runId: report.runId,
        planId: report.planId,
        siteId: report.siteId,
        workerId: report.workerId,
        status: report.status,
        stepReportCount: report.stepReports.length,
        nextActions: report.nextActions
      }
    });
    return report;
  }

  async getSiteSlotWorkerReport(reportId: string): Promise<SiteSlotWorkerReport | null> {
    return this.getRecord<SiteSlotWorkerReport>('site-slot-worker-report', reportId);
  }

  async listSiteSlotWorkerReports(jobId?: string | null): Promise<SiteSlotWorkerReport[]> {
    return (await this.listRecords<SiteSlotWorkerReport>('site-slot-worker-report'))
      .filter((report) => !jobId || report.jobId === jobId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createSiteSlotRollbackExecution(input: SiteSlotRollbackExecutionInput): Promise<SiteSlotRollbackExecution> {
    const reportId = input.reportId?.trim();
    const report = reportId ? await this.getRecord<SiteSlotWorkerReport>('site-slot-worker-report', reportId) : null;
    if (!report) throw new Error(`Unknown site slot worker report: ${input.reportId ?? '<empty>'}`);
    const rollbackExecution = buildSiteSlotRollbackExecution(report, input, `slotrollback_${randomUUID()}`);
    await this.saveRecord(
      'site-slot-rollback-execution',
      rollbackExecution.rollbackExecutionId,
      rollbackExecution,
      rollbackExecution.siteId
    );
    await this.recordAudit({
      eventType: 'site_slot.rollback_execution.created',
      actorKind: 'runner-controller',
      requestId: input.requestId ?? null,
      metadata: {
        rollbackExecutionId: rollbackExecution.rollbackExecutionId,
        rollbackPlanId: rollbackExecution.rollbackPlanId,
        sourceReportId: rollbackExecution.sourceReportId,
        jobId: rollbackExecution.jobId,
        sessionId: rollbackExecution.sessionId,
        runId: rollbackExecution.runId,
        planId: rollbackExecution.planId,
        siteId: rollbackExecution.siteId,
        mode: rollbackExecution.mode,
        status: rollbackExecution.status,
        dryRun: rollbackExecution.dryRun,
        stepCount: rollbackExecution.stepResults.length,
        nextActions: rollbackExecution.nextActions
      }
    });
    return rollbackExecution;
  }

  async getSiteSlotRollbackExecution(rollbackExecutionId: string): Promise<SiteSlotRollbackExecution | null> {
    return this.getRecord<SiteSlotRollbackExecution>('site-slot-rollback-execution', rollbackExecutionId);
  }

  async listSiteSlotRollbackExecutions(reportId?: string | null): Promise<SiteSlotRollbackExecution[]> {
    return (await this.listRecords<SiteSlotRollbackExecution>('site-slot-rollback-execution'))
      .filter((execution) => !reportId || execution.sourceReportId === reportId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recordSiteSlotRollbackReport(input: SiteSlotRollbackReportInput): Promise<SiteSlotRollbackReport> {
    const rollbackExecutionId = input.rollbackExecutionId?.trim();
    const rollbackExecution = rollbackExecutionId
      ? await this.getRecord<SiteSlotRollbackExecution>('site-slot-rollback-execution', rollbackExecutionId)
      : null;
    if (!rollbackExecution) {
      throw new Error(`Unknown site slot rollback execution: ${input.rollbackExecutionId ?? '<empty>'}`);
    }
    const report = buildSiteSlotRollbackReport(rollbackExecution, input, `slotrollbackreport_${randomUUID()}`);
    const executionState = applySiteSlotRollbackReportState(rollbackExecution, report);
    await this.saveRecord('site-slot-rollback-execution', executionState.rollbackExecutionId, executionState, executionState.siteId);
    await this.saveRecord('site-slot-rollback-report', report.rollbackReportId, report, report.siteId);
    await this.recordAudit({
      eventType: 'site_slot.rollback_report.recorded',
      actorKind: 'runner-worker',
      requestId: input.requestId ?? null,
      metadata: {
        rollbackReportId: report.rollbackReportId,
        rollbackExecutionId: report.rollbackExecutionId,
        rollbackPlanId: report.rollbackPlanId,
        sourceReportId: report.sourceReportId,
        jobId: report.jobId,
        sessionId: report.sessionId,
        runId: report.runId,
        planId: report.planId,
        siteId: report.siteId,
        workerId: report.workerId,
        status: report.status,
        stepReportCount: report.stepReports.length,
        nextActions: report.nextActions
      }
    });
    return report;
  }

  async getSiteSlotRollbackReport(rollbackReportId: string): Promise<SiteSlotRollbackReport | null> {
    return this.getRecord<SiteSlotRollbackReport>('site-slot-rollback-report', rollbackReportId);
  }

  async listSiteSlotRollbackReports(rollbackExecutionId?: string | null): Promise<SiteSlotRollbackReport[]> {
    return (await this.listRecords<SiteSlotRollbackReport>('site-slot-rollback-report'))
      .filter((report) => !rollbackExecutionId || report.rollbackExecutionId === rollbackExecutionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async enrollAnonymous(input: AnonymousEnrollmentRequest): Promise<{
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
  }> {
    const now = new Date().toISOString();
    const installId = input.installId?.trim() || `inst_${randomUUID()}`;
    const deviceId = input.deviceId?.trim() || `dev_${randomUUID()}`;
    const productId = input.productId?.trim() || 'hdo';
    const siteId = input.siteId?.trim() || 'domestic-main';
    const enrollment: AnonymousEnrollment = {
      anonymousPrincipalId: `anon_${randomUUID()}`,
      installId,
      deviceId,
      productId,
      siteId,
      environment: this.config.environment,
      overlayIp: await this.allocateOverlayIp(),
      relayMode: input.relayMode?.trim() || 'h2i',
      createdAt: now,
      userId: null
    };
    const snapshot = this.createSnapshot(enrollment, 1, 'visitor');
    await this.saveRecord('anonymous-enrollment', installId, enrollment, siteId);
    await this.saveRecord('config-snapshot', installId, snapshot, siteId);
    await this.recordAudit({
      eventType: 'enrollment.anonymous.created',
      actorKind: 'anonymous_install',
      anonymousPrincipalId: enrollment.anonymousPrincipalId,
      installId,
      deviceId,
      productId,
      siteId,
      requestId: input.requestId ?? null,
      overlayIp: enrollment.overlayIp,
      configSnapshotId: snapshot.snapshotId,
      metadata: {
        platform: input.platform ?? null,
        deviceLabel: input.deviceLabel ?? null,
        hasPublicKey: Boolean(input.publicKey)
      }
    });
    return { enrollment, snapshot };
  }

  async linkIdentity(input: IdentityLinkRequest): Promise<{
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
    auditEvent: AuditEvent;
  }> {
    const enrollment = await this.getRecord<AnonymousEnrollment>('anonymous-enrollment', input.installId);
    if (!enrollment) {
      throw new Error(`Unknown installId: ${input.installId}`);
    }
    enrollment.userId = input.userId;
    const previous = await this.getRecord<ConfigSnapshot>('config-snapshot', input.installId);
    const nextVersion = (previous?.version ?? 1) + 1;
    const snapshot = this.createSnapshot(enrollment, nextVersion, 'employee');
    await this.saveRecord('anonymous-enrollment', input.installId, enrollment, enrollment.siteId);
    await this.saveRecord('config-snapshot', input.installId, snapshot, enrollment.siteId);
    const auditEvent = await this.recordAudit({
      eventType: 'identity.linked',
      actorKind: 'user',
      userId: input.userId,
      anonymousPrincipalId: enrollment.anonymousPrincipalId,
      installId: enrollment.installId,
      deviceId: enrollment.deviceId,
      productId: enrollment.productId,
      siteId: enrollment.siteId,
      requestId: input.requestId ?? null,
      overlayIp: enrollment.overlayIp,
      configSnapshotId: snapshot.snapshotId,
      metadata: {
        authProvider: input.authProvider ?? 'local'
      }
    });
    return { enrollment, snapshot, auditEvent };
  }

  async bootstrapUserCenter(): Promise<UserCenterBootstrapResult> {
    const tenant = await this.upsertRecord('iam-tenant', 'tenant_default', builtinUserCenterTenant(), this.config.siteId);
    const org = await this.upsertRecord('iam-org', 'org_default', builtinUserCenterOrg(), this.config.siteId);
    for (const role of builtinUserCenterRoles()) {
      await this.upsertRecord('iam-role', role.roleId, role, this.config.siteId);
    }
    const admin = await this.createUserCenterUser({
      userId: 'usr_demo_admin',
      email: 'admin@mx.local',
      displayName: 'MX Demo Admin',
      roleIds: ['mx-admin'],
      requestId: 'bootstrap-user-center'
    });
    const user = await this.createUserCenterUser({
      userId: 'usr_demo_user',
      email: 'user@mx.local',
      displayName: 'MX Demo User',
      roleIds: ['mx-user'],
      requestId: 'bootstrap-user-center'
    });
    const serviceAccount = await this.createUserCenterServiceAccount({
      serviceAccountId: 'svc_sdk_gateway',
      displayName: 'SDK Gateway',
      roleIds: ['mx-service-account'],
      requestId: 'bootstrap-user-center'
    });
    return createBootstrapResult(
      await this.listUserCenterRoles(),
      [admin, user],
      [serviceAccount]
    );
  }

  async listUserCenterRoles(): Promise<UserCenterRole[]> {
    return (await this.listRecords<UserCenterRole>('iam-role')).sort((a, b) => a.roleId.localeCompare(b.roleId));
  }

  async listUserCenterUsers(): Promise<UserCenterUser[]> {
    return (await this.listRecords<UserCenterUser>('iam-user')).sort((a, b) => a.userId.localeCompare(b.userId));
  }

  async createUserCenterUser(input: CreateUserInput): Promise<UserCenterUser> {
    const user = createUserCenterUser(input);
    await this.upsertRecord('iam-user', user.userId, user, this.config.siteId);
    await this.recordAudit({
      eventType: 'iam.user.upserted',
      actorKind: 'user-center',
      userId: user.userId,
      requestId: input.requestId ?? null,
      metadata: {
        email: user.email,
        roleIds: user.roleIds,
        status: user.status
      }
    });
    return user;
  }

  async listUserCenterServiceAccounts(): Promise<UserCenterServiceAccount[]> {
    return (await this.listRecords<UserCenterServiceAccount>('iam-service-account'))
      .sort((a, b) => a.serviceAccountId.localeCompare(b.serviceAccountId));
  }

  async createUserCenterServiceAccount(input: CreateServiceAccountInput): Promise<UserCenterServiceAccount> {
    const serviceAccount = createUserCenterServiceAccount(input);
    await this.upsertRecord('iam-service-account', serviceAccount.serviceAccountId, serviceAccount, this.config.siteId);
    await this.recordAudit({
      eventType: 'iam.service_account.upserted',
      actorKind: 'user-center',
      requestId: input.requestId ?? null,
      metadata: {
        serviceAccountId: serviceAccount.serviceAccountId,
        roleIds: serviceAccount.roleIds,
        scopes: serviceAccount.scopes,
        status: serviceAccount.status
      }
    });
    return serviceAccount;
  }

  async issueUserCenterToken(input: IssueTokenInput): Promise<UserCenterIssuedToken> {
    const principal = await this.principalForSubject(input.subjectKind, input.subjectId);
    if (!principal) {
      throw new Error(`Unknown token subject: ${input.subjectKind}:${input.subjectId}`);
    }
    const requestedScopes = input.scopes?.length ? input.scopes : principal.scopes;
    const allowedScopes = requestedScopes.filter((scope) => principal.scopes.includes(scope));
    const token = `mx-v1-${randomBytes(24).toString('base64url')}`;
    const issued = createUserCenterTokenRecord(this.config, {
      ...input,
      scopes: allowedScopes
    }, token);
    await this.saveRecord('iam-token', issued.record.tokenHash, issued.record, this.config.siteId);
    await this.recordAudit({
      eventType: 'auth.token.issued',
      actorKind: input.subjectKind,
      userId: input.subjectKind === 'user' ? input.subjectId : null,
      requestId: input.requestId ?? null,
      metadata: {
        tokenId: issued.record.tokenId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        audience: issued.record.audience,
        scopes: issued.record.scopes,
        expiresAt: issued.record.expiresAt
      }
    });
    return issued;
  }

  async introspectToken(input: TokenIntrospectionInput): Promise<TokenIntrospectionResult> {
    const token = input.token?.trim() ?? '';
    const record = token ? await this.getRecord<UserCenterTokenRecord>('iam-token', hashToken(token)) : null;
    const principal = record ? await this.principalForSubject(record.subjectKind, record.subjectId) : null;
    const result = introspectUserCenterToken(this.config, input, record, principal)
      ?? introspectShadowToken(this.config, input);
    await this.recordAudit({
      eventType: 'auth.token.introspected',
      actorKind: result.principal?.kind ?? 'unknown',
      userId: result.principal?.userId ?? null,
      anonymousPrincipalId: result.principal?.anonymousPrincipalId ?? null,
      requestId: input.requestId ?? null,
      metadata: {
        active: result.active,
        audience: result.audience,
        subject: result.subject,
        tokenKind: result.tokenKind,
        reason: result.reason
      }
    });
    return result;
  }

  async resolvePrincipalContext(input: PrincipalContextInput): Promise<PrincipalContext> {
    const enrollment = input.installId
      ? await this.getRecord<AnonymousEnrollment>('anonymous-enrollment', input.installId)
      : null;
    const auth = await this.introspectToken({
      token: input.token,
      audience: input.audience,
      requestId: input.requestId
    });
    const boundPrincipal = input.userId ? await this.principalForSubject('user', input.userId) : null;
    const context = resolvePrincipalContext(this.config, input, enrollment, auth, boundPrincipal);
    await this.recordAudit({
      eventType: 'identity.context.resolved',
      actorKind: context.principal.kind,
      userId: context.principal.userId,
      anonymousPrincipalId: context.principal.anonymousPrincipalId,
      installId: context.bindings.installId,
      deviceId: context.bindings.deviceId,
      requestId: input.requestId ?? null,
      metadata: {
        source: context.source,
        active: context.auth.active,
        canUseSdkGateway: context.gateway.canUseSdkGateway,
        allowedRoutes: context.gateway.allowedRoutes
      }
    });
    return context;
  }

  sdkGatewayManifest(): SdkGatewayManifest {
    return createSdkGatewayManifest(this.config);
  }

  async evaluateSdkGatewayAccess(input: SdkGatewayAccessInput): Promise<SdkGatewayAccessDecision> {
    const introspection = await this.introspectToken({
      token: input.token,
      audience: input.audience,
      requestId: input.requestId
    });
    const decision = evaluateSdkGatewayRoute(introspection.principal, input.routeId);
    await this.recordAudit({
      eventType: 'sdk.gateway.access.evaluated',
      actorKind: decision.principal?.kind ?? 'unknown',
      userId: decision.principal?.userId ?? null,
      requestId: input.requestId ?? null,
      metadata: {
        routeId: input.routeId,
        allowed: decision.allowed,
        matchedScopes: decision.matchedScopes,
        missingScopes: decision.missingScopes,
        reason: decision.reason
      }
    });
    return decision;
  }

  async createConfigPolicySnapshot(input: ConfigPolicySnapshotInput): Promise<ConfigPolicySnapshot> {
    const appId = input.appId?.trim() || 'h2o';
    const enrollment = input.installId
      ? await this.getRecord<AnonymousEnrollment>('anonymous-enrollment', input.installId)
      : null;
    const principalContext = await this.resolvePrincipalContext({
      token: input.token,
      audience: input.audience,
      userId: input.userId,
      installId: input.installId,
      requestId: input.requestId
    });
    const app = await this.getAppCenterApp(appId);
    const launcherNetwork = await this.createLauncherNetworkSnapshot({
      installId: enrollment?.installId ?? input.installId ?? undefined,
      deviceId: enrollment?.deviceId ?? input.deviceId ?? undefined,
      userId: principalContext.principal.userId ?? enrollment?.userId ?? input.userId ?? null,
      appId,
      requestId: input.requestId ?? undefined
    });
    const launcherRelease = await this.evaluateReleaseUpdate({
      componentKind: 'platform-critical',
      componentId: 'launcher-network',
      currentVersion: '0.1.0',
      targetVersion: '0.1.1',
      channel: input.channel ?? 'shadow',
      installId: enrollment?.installId ?? input.installId ?? null,
      userId: principalContext.principal.userId
    });
    const appRelease = await this.evaluateReleaseUpdate({
      componentKind: app?.updatePolicy ?? 'app-managed',
      componentId: appId,
      currentVersion: app?.version ?? '0.1.0',
      targetVersion: app?.version === '0.1.1' ? app.version : '0.1.1',
      channel: input.channel ?? 'shadow',
      installId: enrollment?.installId ?? input.installId ?? null,
      userId: principalContext.principal.userId
    });
    const snapshot = createConfigPolicySnapshot(this.config, input, {
      snapshotId: `polsnap_${randomUUID()}`,
      version: await this.countRecords('config-policy-snapshot') + 1,
      app,
      principal: principalContext.principal,
      enrollment,
      launcherNetwork,
      dnsPolicy: await this.getEffectiveDnsPolicy(appId),
      reverseProxyRoutes: await this.listDnsReverseProxyRoutes(),
      sdkGateway: await this.sdkGatewayManifest(),
      launcherRelease,
      appRelease
    });
    await this.saveRecord('config-policy-snapshot', snapshot.snapshotId, snapshot, this.config.siteId);
    await this.recordAudit({
      eventType: 'config.policy_snapshot.issued',
      actorKind: 'config-center',
      userId: snapshot.userId,
      anonymousPrincipalId: snapshot.anonymousPrincipalId,
      installId: snapshot.installId,
      deviceId: snapshot.deviceId,
      productId: snapshot.productId,
      requestId: input.requestId ?? null,
      configSnapshotId: snapshot.snapshotId,
      metadata: {
        appId: snapshot.appId,
        version: snapshot.version,
        digest: snapshot.signatures.digest,
        dnsPolicyId: snapshot.policies.dns.policy.policyId,
        launcherNetworkSnapshotId: snapshot.policies.launcherNetwork.snapshotId
      }
    });
    return snapshot;
  }

  async getConfigPolicySnapshot(snapshotId: string): Promise<ConfigPolicySnapshot | null> {
    return this.getRecord<ConfigPolicySnapshot>('config-policy-snapshot', snapshotId);
  }

  async listSiteSlotSshProfiles(): Promise<SiteSlotSshProfile[]> {
    const profiles = await this.listRecords<SiteSlotSshProfile>('site-slot-ssh-profile');
    return profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSiteSlotSshProfile(profileId: string): Promise<SiteSlotSshProfile | null> {
    return this.getRecord<SiteSlotSshProfile>('site-slot-ssh-profile', profileId);
  }

  async getSiteSlotSshProfileForSite(siteId: string): Promise<SiteSlotSshProfile | null> {
    const profiles = await this.listSiteSlotSshProfiles();
    return profiles.find((profile) => profile.siteId === siteId && profile.status === 'active') ?? null;
  }

  async upsertSiteSlotSshProfile(input: SiteSlotSshProfileInput): Promise<SiteSlotSshProfile> {
    const previous = input.profileId ? await this.getSiteSlotSshProfile(input.profileId) : null;
    const profile = buildSiteSlotSshProfile(this.config, input, previous);
    await this.saveRecord('site-slot-ssh-profile', profile.profileId, profile, profile.siteId);
    await this.recordAudit({
      eventType: 'config.site_slot_ssh_profile.upserted',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        profileId: profile.profileId,
        siteId: profile.siteId,
        kind: profile.kind,
        status: profile.status,
        warnings: profile.warnings
      }
    });
    return profile;
  }

  async listRuntimeFeaturePolicies(featureKey?: string | null): Promise<RuntimeFeaturePolicy[]> {
    const policies = await this.listRecords<RuntimeFeaturePolicy>('runtime-feature-policy');
    return policies
      .filter((policy) => !featureKey || policy.featureKey === featureKey)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRuntimeFeaturePolicy(policyId: string): Promise<RuntimeFeaturePolicy | null> {
    return this.getRecord<RuntimeFeaturePolicy>('runtime-feature-policy', policyId);
  }

  async upsertRuntimeFeaturePolicy(input: RuntimeFeaturePolicyInput): Promise<RuntimeFeaturePolicy> {
    const candidate = buildRuntimeFeaturePolicy(this.config, input, null);
    const previous = await this.getRuntimeFeaturePolicy(candidate.policyId);
    const policy = buildRuntimeFeaturePolicy(this.config, input, previous);
    await this.saveRecord('runtime-feature-policy', policy.policyId, policy, policy.scopeId ?? this.config.siteId);
    await this.recordAudit({
      eventType: 'config.runtime_feature_policy.upserted',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        policyId: policy.policyId,
        featureKey: policy.featureKey,
        scopeKind: policy.scopeKind,
        scopeId: policy.scopeId,
        enabled: policy.enabled,
        mode: policy.mode,
        expiresAt: policy.expiresAt
      }
    });
    return policy;
  }

  private async withSiteSlotSshProfile(input: SiteSlotPlanInput): Promise<SiteSlotPlanInput> {
    const profileId = input.sshProfileId?.trim();
    if (!profileId) return input;
    const profile = await this.getSiteSlotSshProfile(profileId);
    if (!profile) return { ...input, sshProfileError: `SSH profile not found: ${profileId}` };
    return {
      ...input,
      sshProfile: profile,
      kind: input.kind ?? profile.kind,
      siteId: input.siteId ?? profile.siteId
    };
  }

  async getSnapshot(installId: string): Promise<ConfigSnapshot | null> {
    return this.getRecord<ConfigSnapshot>('config-snapshot', installId);
  }

  async listTasks(installId: string): Promise<ReleaseTask[]> {
    const tasks = await this.listRecords<ReleaseTask>('release-task');
    return tasks.filter((task) => task.installId === installId);
  }

  async recordReleaseReport(input: ReleaseReportInput): Promise<AuditEvent> {
    return this.recordAudit({
      eventType: 'release.report.received',
      actorKind: 'install',
      installId: input.installId ?? null,
      requestId: input.taskId ?? null,
      metadata: {
        status: input.status ?? 'unknown',
        error: input.error ?? null,
        ...input.metadata
      }
    });
  }

  async recordAudit(input: AuditEventInput): Promise<AuditEvent> {
    const row: AuditEvent = {
      eventId: `aud_${randomUUID()}`,
      eventType: input.eventType ?? 'unknown',
      actorKind: input.actorKind ?? 'system',
      userId: input.userId ?? null,
      anonymousPrincipalId: input.anonymousPrincipalId ?? null,
      installId: input.installId ?? null,
      deviceId: input.deviceId ?? null,
      productId: input.productId ?? null,
      siteId: input.siteId ?? this.config.siteId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      overlayIp: input.overlayIp ?? null,
      configSnapshotId: input.configSnapshotId ?? null,
      environment: this.config.environment,
      metadata: input.metadata ?? null,
      createdAt: new Date().toISOString()
    };
    await this.saveRecord('audit-event', row.eventId, row, row.siteId);
    return row;
  }

  async recordLogs(entries: LogEntryInput[]): Promise<{ accepted: number; sinks: RuntimeConfig['observabilitySinks'] }> {
    await Promise.all(
      entries.map((entry) => this.saveRecord('log-entry', `log_${randomUUID()}`, entry, entry.siteId ?? this.config.siteId))
    );
    return {
      accepted: entries.length,
      sinks: this.config.observabilitySinks
    };
  }

  observabilitySinks(): RuntimeConfig['observabilitySinks'] {
    return this.config.observabilitySinks;
  }

  async listAppCenterApps(): Promise<AppCenterApp[]> {
    return (await this.listRecords<AppCenterApp>('app-center-app')).sort((a, b) => a.appId.localeCompare(b.appId));
  }

  async getAppCenterApp(appId: string): Promise<AppCenterApp | null> {
    return this.getRecord<AppCenterApp>('app-center-app', appId);
  }

  async listDnsPolicies(): Promise<DnsPolicy[]> {
    return (await this.listRecords<DnsPolicy>('dns-policy')).sort((a, b) => b.priority - a.priority);
  }

  async getEffectiveDnsPolicy(appId?: string | null): Promise<DnsPolicy> {
    const policies = (await this.listDnsPolicies())
      .filter((policy) => policy.enabled)
      .filter((policy) => !appId || policy.owners.includes(appId) || policy.owners.includes('sdk-gateway'));
    return required(policies[0] ?? null, 'effective DNS policy is registered');
  }

  async evaluateDnsQuery(input: DnsQueryInput): Promise<DnsResolutionDecision> {
    const policy = await this.getEffectiveDnsPolicy(input.appId);
    const decision = evaluateDnsPolicy(policy, await this.listDnsReverseProxyRoutes(), input);
    await this.recordAudit({
      eventType: 'dns.query.evaluated',
      actorKind: input.appId ? 'app' : 'sdk-gateway',
      userId: input.userId ?? null,
      installId: input.installId ?? null,
      productId: input.appId ?? null,
      requestId: input.requestId ?? null,
      metadata: {
        domain: decision.normalizedDomain,
        route: decision.route,
        resolver: decision.resolver,
        matched: decision.matched,
        reverseProxyRouteId: decision.reverseProxyRoute?.routeId ?? null
      }
    });
    return decision;
  }

  async listDnsReverseProxyRoutes(): Promise<DnsReverseProxyRoute[]> {
    return (await this.listRecords<DnsReverseProxyRoute>('dns-reverse-proxy-route'))
      .sort((a, b) => a.host.localeCompare(b.host));
  }

  async buildDnsZoneSnapshot(input: DnsZoneSnapshotInput): Promise<DnsZoneSnapshot> {
    const policy = input.policyId
      ? required(await this.getRecord<DnsPolicy>('dns-policy', input.policyId), `DNS policy not found: ${input.policyId}`)
      : await this.getEffectiveDnsPolicy(input.appId ?? 'sdk-gateway');
    const snapshot = buildDnsZoneSnapshot(this.config, {
      snapshotId: `dnszone_${randomUUID()}`,
      version: await this.countRecords('dns-zone-snapshot') + 1,
      policy,
      reverseProxyRoutes: await this.listDnsReverseProxyRoutes(),
      requestId: input.requestId ?? null
    });
    await this.saveRecord('dns-zone-snapshot', snapshot.snapshotId, snapshot, this.config.siteId);
    await this.recordAudit({
      eventType: 'dns.zone_snapshot.built',
      actorKind: 'dns-control',
      requestId: input.requestId ?? null,
      metadata: {
        snapshotId: snapshot.snapshotId,
        policyId: snapshot.policyId,
        zones: snapshot.zoneNames,
        records: snapshot.records.length,
        digest: snapshot.signatures.digest
      }
    });
    return snapshot;
  }

  async getDnsZoneSnapshot(snapshotId: string): Promise<DnsZoneSnapshot | null> {
    return this.getRecord<DnsZoneSnapshot>('dns-zone-snapshot', snapshotId);
  }

  async syncCoreDnsConfigMap(input: CoreDnsConfigMapSyncInput): Promise<CoreDnsConfigMapSyncResult> {
    const snapshot = input.snapshotId
      ? required(await this.getDnsZoneSnapshot(input.snapshotId), `DNS zone snapshot not found: ${input.snapshotId}`)
      : await this.buildDnsZoneSnapshot(input);
    const result = renderCoreDnsConfigMap(snapshot, input, `dnsync_${randomUUID()}`);
    await this.saveRecord('coredns-configmap-sync', result.syncId, result, this.config.siteId);
    await this.recordAudit({
      eventType: 'dns.coredns_configmap.sync_recorded',
      actorKind: 'dns-control',
      requestId: input.requestId ?? null,
      metadata: {
        syncId: result.syncId,
        mode: result.mode,
        status: result.status,
        applied: result.applied,
        snapshotId: result.snapshotId,
        namespace: result.namespace,
        configMapName: result.configMapName,
        digest: snapshot.signatures.digest
      }
    });
    return result;
  }

  async applyCoreDnsConfigMap(input: CoreDnsConfigMapApplyInput): Promise<CoreDnsConfigMapApplyResult> {
    const sync = await this.syncCoreDnsConfigMap({ ...input, mode: 'shadow-apply' });
    const gate = evaluateCoreDnsConfigMapApplyGate(this.config, sync, input);
    const issuedAt = new Date().toISOString();
    const outcome = gate.allowed
      ? await applyCoreDnsConfigMapToKubernetes(sync.manifest, gate.serverDryRun)
      : {
          status: 'failed' as const,
          applied: false,
          resourceVersion: null,
          message: gate.blockedReason ?? 'CoreDNS apply blocked'
        };
    const result: CoreDnsConfigMapApplyResult = {
      applyId: `dnsapply_${randomUUID()}`,
      syncId: sync.syncId,
      mode: gate.serverDryRun ? 'k8s-server-dry-run' : 'k8s-apply',
      status: gate.allowed ? outcome.status : 'blocked',
      allowed: gate.allowed,
      applied: gate.allowed ? outcome.applied : false,
      serverDryRun: gate.serverDryRun,
      snapshotId: sync.snapshotId,
      namespace: sync.namespace,
      configMapName: sync.configMapName,
      manifest: sync.manifest,
      resourceVersion: gate.allowed ? outcome.resourceVersion : null,
      blockedReason: gate.blockedReason,
      message: gate.allowed ? outcome.message : (gate.blockedReason ?? 'CoreDNS apply blocked'),
      issuedAt,
      completedAt: new Date().toISOString()
    };
    await this.saveRecord('coredns-configmap-apply', result.applyId, result, this.config.siteId);
    await this.recordAudit({
      eventType: 'dns.coredns_configmap.apply_evaluated',
      actorKind: 'dns-control',
      requestId: input.requestId ?? null,
      metadata: {
        applyId: result.applyId,
        syncId: result.syncId,
        status: result.status,
        allowed: result.allowed,
        applied: result.applied,
        serverDryRun: result.serverDryRun,
        snapshotId: result.snapshotId,
        namespace: result.namespace,
        configMapName: result.configMapName,
        blockedReason: result.blockedReason
      }
    });
    return result;
  }

  async requestPermission(input: PermissionRequestInput): Promise<PermissionGrant> {
    const app = await this.getAppCenterApp(input.appId);
    const requestedScopes = input.scopes.length > 0 ? input.scopes : [];
    const allowedScopes = app
      ? requestedScopes.filter((scope) => app.permissions.includes(scope))
      : [];
    const deniedScopes = requestedScopes.filter((scope) => !allowedScopes.includes(scope));
    const decision: PermissionGrant['decision'] =
      allowedScopes.length === 0 ? 'denied' : deniedScopes.length === 0 ? 'granted' : 'partial';
    const grant: PermissionGrant = {
      grantId: `grant_${randomUUID()}`,
      appId: input.appId,
      scopes: requestedScopes,
      allowedScopes,
      deniedScopes,
      decision,
      requestedBy: input.requestedBy,
      installId: input.installId ?? null,
      userId: input.userId ?? null,
      createdAt: new Date().toISOString()
    };
    await this.saveRecord('permission-grant', grant.grantId, grant, this.config.siteId);
    await this.recordAudit({
      eventType: 'permission.request.evaluated',
      actorKind: 'app-center',
      userId: input.userId ?? null,
      installId: input.installId ?? null,
      productId: input.appId,
      requestId: input.requestId ?? null,
      metadata: {
        decision,
        scopes: requestedScopes,
        allowedScopes,
        deniedScopes,
        requestedBy: input.requestedBy
      }
    });
    return grant;
  }

  async createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): Promise<LauncherNetworkSnapshot> {
    const mode = input.userId ? 'user' : 'guest';
    const leaseIp = mode === 'user' ? await this.allocateUserLeaseIp() : await this.allocateGuestLeaseIp();
    const issuedAt = new Date().toISOString();
    const unsigned = {
      environment: this.config.environment,
      appId: input.appId ?? 'h2o',
      installId: input.installId ?? `inst_${randomUUID()}`,
      deviceId: input.deviceId ?? `dev_${randomUUID()}`,
      userId: input.userId ?? null,
      mode,
      leaseIp,
      issuedAt
    };
    const digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    const snapshot: LauncherNetworkSnapshot = {
      snapshotId: `lnsnap_${randomUUID()}`,
      environment: unsigned.environment,
      appId: unsigned.appId,
      installId: unsigned.installId,
      deviceId: unsigned.deviceId,
      userId: unsigned.userId,
      mode,
      overlayPolicy: {
        cidr: mode === 'user' ? '10.89.0.0/16' : '10.91.0.0/16',
        leaseIp,
        relayMode: 'h2i'
      },
      capabilities: {
        wireGuard: true,
        splitDns: true,
        pac: true,
        tun: true,
        systemProxy: true
      },
      dns: {
        authority: 'internal-coredns',
        matchDomains: ['internal.mx', 'corp.mx', 'h2i.mx'],
        fallback: 'system'
      },
      pac: {
        priority: ['launcher-network', 'app-center-policy', 'system-proxy', 'h2o', 'direct']
      },
      signatures: {
        algorithm: 'sha256-dev-digest',
        digest,
        issuer: 'mx-launcher-network-shadow'
      },
      issuedAt
    };
    await this.saveRecord('launcher-network-snapshot', snapshot.snapshotId, snapshot, this.config.siteId);
    await this.recordAudit({
      eventType: 'launcher-network.snapshot.issued',
      actorKind: 'install',
      userId: snapshot.userId,
      installId: snapshot.installId,
      deviceId: snapshot.deviceId,
      productId: snapshot.appId,
      requestId: input.requestId ?? null,
      overlayIp: snapshot.overlayPolicy.leaseIp,
      metadata: {
        mode: snapshot.mode,
        cidr: snapshot.overlayPolicy.cidr,
        capabilities: snapshot.capabilities
      }
    });
    return snapshot;
  }

  async evaluateReleaseUpdate(input: ReleasePolicyInput): Promise<ReleasePolicyDecision> {
    const componentKind = normalizeUpdatePolicy(input.componentKind);
    const updateAvailable = input.currentVersion !== input.targetVersion;
    if (!updateAvailable) {
      return {
        componentKind,
        componentId: input.componentId,
        currentVersion: input.currentVersion,
        targetVersion: input.targetVersion,
        updateAvailable: false,
        updateMode: 'none',
        canSkip: true,
        canDefer: true,
        requiresGate: false,
        rollbackRequired: false,
        reason: 'component is already at target version'
      };
    }

    const decision: ReleasePolicyDecision = {
      componentKind,
      componentId: input.componentId,
      currentVersion: input.currentVersion,
      targetVersion: input.targetVersion,
      updateAvailable: true,
      ...releasePolicyByKind(componentKind)
    };
    await this.saveRecord('release-policy-decision', `relpol_${randomUUID()}`, {
      ...decision,
      channel: input.channel,
      installId: input.installId ?? null,
      userId: input.userId ?? null,
      evaluatedAt: new Date().toISOString()
    }, this.config.siteId);
    return decision;
  }

  async createReleaseManagementPlan(input: ReleaseManagementPlanInput): Promise<ReleaseManagementPlan> {
    const releaseId = input.releaseId?.trim() || `rel_${randomUUID()}`;
    const channel = input.channel?.trim() || 'shadow';
    const appId = input.appId?.trim() || 'h2o';
    const productId = input.productId?.trim() || appId;
    const launcherDecision = await this.evaluateReleaseUpdate({
      componentKind: 'platform-critical',
      componentId: 'mx-launcher',
      currentVersion: input.launcherCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.launcherTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const appDecision = await this.evaluateReleaseUpdate({
      componentKind: 'app-managed',
      componentId: appId,
      currentVersion: input.appCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.appTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const testRun = await this.createTestRun({
      suiteId: input.suiteId?.trim() || 'hdo-shadow-e2e',
      releaseId,
      installId: input.installId,
      productId,
      topology: input.topology?.trim() || 'h-d-i-shadow',
      sites: input.sites ?? ['internal-main', 'domestic-main']
    });
    const e2eResult = input.e2eResult ?? 'running';
    const gatedRun = e2eResult === 'running'
      ? testRun
      : await this.recordTestStep(testRun.testRunId, {
          caseId: 'release-gate:e2e',
          status: e2eResult,
          message: `release management E2E gate ${e2eResult}`,
          evidence: {
            releaseId,
            channel,
            source: 'release-management-v1'
          }
        });
    const gate = await this.evaluateTestGate({
      gateId: `gate_${releaseId}_e2e`,
      releaseId,
      runIds: [gatedRun.testRunId]
    });
    const plan = buildReleaseManagementPlan(this.config, { ...input, channel }, {
      planId: `relplan_${randomUUID()}`,
      releaseId,
      launcherDecision,
      appDecision,
      testRun: gatedRun,
      gate,
      createdAt: new Date().toISOString()
    });
    await this.saveRecord('release-management-plan', plan.planId, plan, this.config.siteId);
    await this.recordAudit({
      eventType: 'release.management_plan.created',
      actorKind: 'release-center',
      requestId: input.requestId ?? null,
      installId: plan.installId,
      userId: plan.userId,
      productId,
      metadata: {
        planId: plan.planId,
        releaseId: plan.releaseId,
        channel: plan.channel,
        gateVerdict: plan.test.gate.verdict,
        readyToPromote: plan.decisions.readyToPromote,
        nextActions: plan.decisions.nextActions
      }
    });
    return plan;
  }

  async getReleaseManagementPlan(planId: string): Promise<ReleaseManagementPlan | null> {
    return this.getRecord<ReleaseManagementPlan>('release-management-plan', planId);
  }

  async listReleaseManagementPlans(): Promise<ReleaseManagementPlan[]> {
    return (await this.listRecords<ReleaseManagementPlan>('release-management-plan'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createTestRun(input: TestRunInput): Promise<TestRun> {
    const now = new Date().toISOString();
    const run: TestRun = {
      testRunId: `trun_${randomUUID()}`,
      suiteId: input.suiteId,
      productId: input.productId,
      environment: this.config.environment,
      topology: input.topology,
      sites: input.sites.length > 0 ? input.sites : ['domestic-main', 'internal-main'],
      releaseId: input.releaseId ?? null,
      configSnapshotId: input.configSnapshotId ?? null,
      installId: input.installId ?? null,
      deviceId: input.deviceId ?? null,
      traceId: `trace_${randomUUID()}`,
      state: 'running',
      steps: [],
      startedAt: now,
      finishedAt: null
    };
    await this.saveRecord('test-run', run.testRunId, run, this.config.siteId);
    await this.recordAudit({
      eventType: 'test.run.created',
      actorKind: 'test-center',
      installId: run.installId,
      deviceId: run.deviceId,
      productId: run.productId,
      traceId: run.traceId,
      metadata: {
        suiteId: run.suiteId,
        topology: run.topology,
        releaseId: run.releaseId
      }
    });
    return run;
  }

  async getTestRun(runId: string): Promise<TestRun | null> {
    return this.getRecord<TestRun>('test-run', runId);
  }

  async recordTestStep(runId: string, input: TestStepInput): Promise<TestRun> {
    const run = await this.getTestRun(runId);
    if (!run) throw new Error(`Unknown testRunId: ${runId}`);
    const status = normalizeTestStatus(input.status);
    const step: TestStep = {
      stepId: `tstep_${randomUUID()}`,
      caseId: input.caseId,
      status,
      message: input.message ?? null,
      evidence: input.evidence ?? {},
      createdAt: new Date().toISOString()
    };
    run.steps.push(step);
    if (status === 'failed') {
      run.state = 'failed';
      run.finishedAt = step.createdAt;
    } else if (status === 'blocked') {
      run.state = 'blocked';
      run.finishedAt = step.createdAt;
    } else if (run.steps.length > 0 && run.steps.every((item) => item.status === 'passed')) {
      run.state = 'passed';
      run.finishedAt = step.createdAt;
    }
    await this.saveRecord('test-run', run.testRunId, run, this.config.siteId);
    await this.recordAudit({
      eventType: 'test.step.recorded',
      actorKind: 'test-center',
      installId: run.installId,
      deviceId: run.deviceId,
      productId: run.productId,
      traceId: run.traceId,
      metadata: {
        testRunId: run.testRunId,
        caseId: step.caseId,
        status: step.status
      }
    });
    return run;
  }

  async evaluateTestGate(input: TestGateInput): Promise<TestGateVerdict> {
    const runs = (await Promise.all(input.runIds.map((runId) => this.getTestRun(runId))))
      .filter((run): run is TestRun => Boolean(run));
    const missingRuns = input.runIds.length - runs.length;
    const evaluatedAt = new Date().toISOString();
    let verdict: TestGateVerdict['verdict'] = 'passed';
    let reason = 'all required runs passed';
    if (input.runIds.length === 0 || missingRuns > 0) {
      verdict = 'blocked';
      reason = 'required test runs are missing';
    } else if (runs.some((run) => run.state === 'failed')) {
      verdict = 'failed';
      reason = 'at least one required run failed';
    } else if (runs.some((run) => run.state === 'blocked' || run.state === 'running')) {
      verdict = 'blocked';
      reason = 'at least one required run is not complete';
    }
    const gate: TestGateVerdict = {
      gateId: input.gateId,
      releaseId: input.releaseId,
      verdict,
      requiredRuns: input.runIds,
      evaluatedAt,
      reason
    };
    await this.saveRecord('test-gate-verdict', `${gate.gateId}:${gate.releaseId}:${randomUUID()}`, gate, this.config.siteId);
    await this.recordAudit({
      eventType: 'test.gate.evaluated',
      actorKind: 'test-center',
      requestId: input.gateId,
      metadata: {
        gateId: gate.gateId,
        releaseId: gate.releaseId,
        verdict: gate.verdict,
        requiredRuns: gate.requiredRuns,
        evaluatedAt: gate.evaluatedAt,
        reason: gate.reason
      }
    });
    return gate;
  }

  async runPlatformKernelSmoke(): Promise<PlatformKernelSmokeResult> {
    const checks: string[] = [];
    const app = required(await this.getAppCenterApp('h2o'), 'h2o app is registered');
    checks.push('OK app h2o registered');
    const userCenter = await this.bootstrapUserCenter();
    if (!userCenter.roles.some((role) => role.roleId === 'mx-service-account')) {
      throw new Error('User Center bootstrap did not register service-account role');
    }
    checks.push('OK User Center bootstrap registered RBAC records');
    const issuedServiceToken = await this.issueUserCenterToken({
      subjectKind: 'service-account',
      subjectId: 'svc_sdk_gateway',
      audience: 'mx-sdk',
      requestId: 'smoke-service-token'
    });
    checks.push('OK User Center issued service token');
    const sdkAccess = await this.evaluateSdkGatewayAccess({
      token: issuedServiceToken.token,
      audience: 'mx-sdk',
      routeId: 'sdk.dns.evaluate',
      requestId: 'smoke-sdk-access'
    });
    if (!sdkAccess.allowed) {
      throw new Error('SDK Gateway did not allow service account dns evaluate');
    }
    checks.push('OK SDK Gateway allowed scoped service account');
    const issuedUserToken = await this.issueUserCenterToken({
      subjectKind: 'user',
      subjectId: 'usr_demo_user',
      audience: 'mx-sdk',
      requestId: 'smoke-user-token'
    });
    const deniedSdkAccess = await this.evaluateSdkGatewayAccess({
      token: issuedUserToken.token,
      audience: 'mx-sdk',
      routeId: 'sdk.audit.write',
      requestId: 'smoke-sdk-denied'
    });
    if (deniedSdkAccess.allowed) {
      throw new Error('SDK Gateway allowed a user without sdk.audit.write');
    }
    checks.push('OK SDK Gateway denied missing scope');
    const { enrollment } = await this.enrollAnonymous({
      productId: 'h2o',
      platform: 'darwin',
      requestId: 'smoke-enroll'
    });
    checks.push('OK anonymous install enrolled');
    const principalContext = await this.resolvePrincipalContext({
      installId: enrollment.installId,
      requestId: 'smoke-principal-context'
    });
    if (principalContext.principal.kind !== 'anonymous' || !principalContext.gateway.canUseSdkGateway) {
      throw new Error('anonymous install principal context was not resolved');
    }
    checks.push('OK User Center principal context resolved');
    const sdkIntrospection = await this.introspectToken({
      token: issuedServiceToken.token,
      audience: 'mx-sdk',
      requestId: 'smoke-sdk-introspection'
    });
    if (!sdkIntrospection.active || sdkIntrospection.principal?.kind !== 'service-account') {
      throw new Error('SDK Gateway service token was not accepted');
    }
    checks.push('OK SDK Gateway service token introspected');
    const sdkGateway = await this.sdkGatewayManifest();
    if (!sdkGateway.routes.some((route) => route.routeId === 'sdk.identity.introspect')) {
      throw new Error('SDK Gateway manifest did not expose identity introspection');
    }
    checks.push('OK SDK Gateway manifest published');
    const overseaSlotPlan = await this.createSiteSlotPlan({
      kind: 'oversea',
      siteId: 'oversea-sg-1',
      host: 'oversea.example.com',
      sshUser: 'root',
      hasDocker: true,
      hasOutboundInternet: true,
      requestId: 'smoke-oversea-slot'
    });
    const overseaPackageArtifacts = overseaSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'package-slot-artifacts');
    const overseaPrepareAccess = overseaSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'prepare-access-stack');
    const overseaConfigureAccess = overseaSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'configure-oversea-access');
    const overseaPublishSubscription = overseaSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'publish-internal-subscription');
    const overseaDeployServices = overseaSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'deploy-slot-services');
    const overseaDeploymentCommands = overseaSlotPlan.deploymentPhases.flatMap((phase) => phase.commands);
    if (
      overseaSlotPlan.kind !== 'oversea'
      || !overseaSlotPlan.services.dockerStacks.includes('docker/hysteria2-access-stack')
      || overseaPackageArtifacts?.mode !== 'admin-action'
      || !overseaPackageArtifacts?.commands.some((command) => command.includes('modules=hysteria2-access-stack,site-agent,runner-worker,observability-forwarder'))
      || !overseaPackageArtifacts?.commands.some((command) => command.includes('never sync the repository root'))
      || overseaPrepareAccess?.mode !== 'artifact-push'
      || !overseaPrepareAccess?.commands.some((command) => command.includes('rsync -az') && command.includes('mx-oversea-access-stack.tar.gz'))
      || !overseaPrepareAccess?.commands.some((command) => command.includes('scp -P') && command.includes('mx-oversea-access-stack.tar.gz'))
      || !overseaPrepareAccess?.commands.some((command) => command.includes('/opt/mx/releases/oversea-access-stack/<release-revision>'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('HY2_EXPORT_PASSWORD_HASH=<caddy-bcrypt-hash-from-internal-secret>'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('HY2_MIHOMO_ROUTING_MODE=cn-direct') && command.includes('HY2_RESERVED_INTERNAL_CIDRS=10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16') && command.includes('HY2_DOMESTIC_GATEWAY_IP=10.88.0.1'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('base64 -d') && command.includes('tunnel-state.json'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('reconcile-from-json') && command.includes('--mode hysteria2-only'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('@qpjoy/tunnel-cli') || command.includes('qp-tunnel-cli register'))
      || !overseaPublishSubscription?.commands.some((command) => command.includes('domesticBootstrapSubscription=') && command.includes('/subscriptions/hysteria2/domestic-bootstrap.yaml'))
      || overseaDeployServices?.mode !== 'artifact-push'
      || !overseaDeployServices?.commands.some((command) => command.includes('rsync -az') && command.includes('mx-oversea-services.tar.gz'))
      || !overseaDeployServices?.commands.some((command) => command.includes('/opt/mx/incoming/mx-oversea-services.tar.gz'))
      || !overseaDeployServices?.commands.some((command) => command.includes('/opt/mx/current/oversea') && command.includes('LOCAL_STACK_PATH=/opt/mx/current/hysteria2-access-stack') && command.includes('MX_ACCESS_RUNTIME=hysteria2-only'))
      || overseaDeploymentCommands.some((command) => command.includes('git pull') || command.includes('git clone') || command.includes('./docker/'))
    ) {
      throw new Error('Oversea slot plan did not include access stack');
    }
    checks.push('OK Oversea slot plan generated');
    const domesticSlotPlan = await this.createSiteSlotPlan({
      kind: 'domestic',
      siteId: 'domestic-main',
      host: 'domestic.example.com',
      sshUser: 'root',
      rootAccess: true,
      hasDocker: true,
      hasOutboundInternet: false,
      overseaSiteId: overseaSlotPlan.siteId,
      overseaHost: overseaSlotPlan.host,
      internalBaseUrl: this.config.internalBaseUrl,
      requestId: 'smoke-domestic-slot'
    });
    const domesticPackageArtifacts = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'package-slot-artifacts');
    const domesticResolveSubscription = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'resolve-domestic-bootstrap-subscription');
    const domesticBootstrapEgress = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'bootstrap-domestic-egress');
    if (
      domesticSlotPlan.network.mode !== 'oversea-assisted'
      || domesticSlotPlan.network.qpTunnelCliMode !== 'server-on'
      || !domesticSlotPlan.services.hostServices.includes('wg-quick@mx-domestic')
      || !domesticPackageArtifacts?.commands.some((command) => command.includes('qp-tunnel-cli-offline-fallback'))
      || !domesticPackageArtifacts?.commands.some((command) => command.includes('refresh-tunnel-cli latest'))
      || domesticResolveSubscription?.mode !== 'admin-action'
      || !domesticResolveSubscription?.commands.some((command) => command.includes('domesticBootstrapSubscription'))
      || !domesticResolveSubscription?.commands.some((command) => command.includes('do not ask Domestic to npm install'))
      || domesticBootstrapEgress?.mode !== 'artifact-push'
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('npm i -g @qpjoy/tunnel-cli'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('mx-domestic-qp-tunnel-cli-fallback.tar.gz'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('server-on'))
      || domesticBootstrapEgress?.commands.some((command) => command.includes('tun-on'))
    ) {
      throw new Error('Domestic slot plan did not model host WireGuard and Oversea-assisted bootstrap');
    }
    checks.push('OK Domestic slot plan generated');
    const domesticSlotPreflightExecution = await this.createSiteSlotExecution({
      planId: domesticSlotPlan.planId,
      action: 'preflight',
      mode: 'dry-run',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-preflight'
    });
    if (
      domesticSlotPreflightExecution.status !== 'ready'
      || !domesticSlotPreflightExecution.steps.some((step) => step.sourceId === 'domestic.wireguard')
    ) {
      throw new Error('Domestic slot preflight execution did not produce a ready WireGuard check manifest');
    }
    checks.push('OK Domestic slot preflight execution manifest generated');
    const domesticSlotApplyExecution = await this.createSiteSlotExecution({
      planId: domesticSlotPlan.planId,
      action: 'apply',
      mode: 'manual',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-apply'
    });
    if (
      domesticSlotApplyExecution.status !== 'requires-confirmation'
      || !domesticSlotApplyExecution.nextActions.includes('rerun-apply-with-confirmApply-true')
    ) {
      throw new Error('Domestic slot apply execution did not require explicit confirmation');
    }
    checks.push('OK Domestic slot apply execution gate requires confirmation');
    const domesticSlotPreflightRunnerSession = await this.startSiteSlotRunnerSession({
      runId: domesticSlotPreflightExecution.runId,
      mode: 'simulate',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-runner-simulate'
    });
    if (
      domesticSlotPreflightRunnerSession.status !== 'completed'
      || !domesticSlotPreflightRunnerSession.stepResults.every((step) => step.status === 'simulated')
    ) {
      throw new Error('Domestic slot simulated runner session did not complete every step');
    }
    checks.push('OK Domestic slot runner simulated preflight session completed');
    const domesticSlotRemoteRunnerSession = await this.startSiteSlotRunnerSession({
      runId: domesticSlotPreflightExecution.runId,
      mode: 'remote-ssh',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-runner-remote'
    });
    if (
      domesticSlotRemoteRunnerSession.status !== 'blocked'
      || !domesticSlotRemoteRunnerSession.warnings.some((warning) => warning.includes('SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED'))
    ) {
      throw new Error('Domestic slot remote runner session was not blocked by remote execution gate');
    }
    checks.push('OK Domestic slot remote runner gate blocked by default');
    const domesticSlotWorkerJob = await this.createSiteSlotWorkerJob({
      sessionId: domesticSlotPreflightRunnerSession.sessionId,
      workerId: 'worker-shadow-domestic',
      workerKind: 'internal-runner',
      retryLimit: 2,
      rollbackStrategy: 'no-op-simulated-rollback',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-worker-job'
    });
    if (
      domesticSlotWorkerJob.status !== 'ready'
      || domesticSlotWorkerJob.contractVersion !== 'site-slot-worker-v1'
      || domesticSlotWorkerJob.steps.length !== domesticSlotPreflightRunnerSession.stepResults.length
    ) {
      throw new Error('Domestic slot worker job contract was not ready');
    }
    checks.push('OK Domestic slot worker job contract created');
    const domesticSlotWorkerReport = await this.recordSiteSlotWorkerReport({
      jobId: domesticSlotWorkerJob.jobId,
      workerId: domesticSlotWorkerJob.worker.workerId,
      status: 'passed',
      message: 'shadow worker contract passed',
      stepReports: [
        {
          stepId: domesticSlotWorkerJob.steps[0]?.stepId,
          status: 'passed',
          exitCode: 0,
          stdout: 'wireguard check simulated',
          stderr: null,
          attempt: 1
        }
      ],
      requestId: 'smoke-domestic-slot-worker-report'
    });
    if (
      domesticSlotWorkerReport.status !== 'passed'
      || !domesticSlotWorkerReport.nextActions.includes('close-change-window')
      || domesticSlotWorkerReport.stepReports[0]?.stdout !== 'wireguard check simulated'
    ) {
      throw new Error('Domestic slot worker report did not record passed evidence');
    }
    checks.push('OK Domestic slot worker report recorded passed evidence');
    const domesticSlotWorkerJobState = required(await this.getSiteSlotWorkerJob(domesticSlotWorkerJob.jobId), 'worker job state exists');
    const domesticSlotPreflightRunnerSessionState = required(await this.getSiteSlotRunnerSession(domesticSlotPreflightRunnerSession.sessionId), 'runner session state exists');
    if (domesticSlotWorkerJobState.status !== 'passed' || domesticSlotPreflightRunnerSessionState.status !== 'passed') {
      throw new Error('Worker report did not advance job and runner session to passed');
    }
    checks.push('OK Worker report advanced job/session state to passed');
    const failedRunnerSession = await this.startSiteSlotRunnerSession({
      runId: domesticSlotPreflightExecution.runId,
      mode: 'simulate',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-runner-failed-simulate'
    });
    const failedWorkerJob = await this.createSiteSlotWorkerJob({
      sessionId: failedRunnerSession.sessionId,
      workerId: 'worker-shadow-domestic-failed',
      workerKind: 'internal-runner',
      rollbackStrategy: 'restore-failed-simulated-state',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-worker-failed-job'
    });
    const domesticSlotFailedWorkerReport = await this.recordSiteSlotWorkerReport({
      jobId: failedWorkerJob.jobId,
      workerId: failedWorkerJob.worker.workerId,
      status: 'failed',
      message: 'shadow worker contract failed',
      stepReports: [
        {
          stepId: failedWorkerJob.steps[0]?.stepId,
          status: 'failed',
          exitCode: 2,
          stdout: 'failure stdout',
          stderr: 'failure stderr',
          attempt: 1
        }
      ],
      requestId: 'smoke-domestic-slot-worker-failed-report'
    });
    const domesticSlotFailedWorkerJob = required(await this.getSiteSlotWorkerJob(failedWorkerJob.jobId), 'failed worker job state exists');
    if (
      domesticSlotFailedWorkerJob.status !== 'failed'
      || domesticSlotFailedWorkerReport.rollbackPlan?.status !== 'planned'
      || domesticSlotFailedWorkerReport.rollbackPlan.strategy !== 'restore-failed-simulated-state'
    ) {
      throw new Error('Failed worker report did not produce rollback plan and failed state');
    }
    checks.push('OK Failed worker report generated rollback plan');
    const domesticSlotFailedRollbackPlan = required(domesticSlotFailedWorkerReport.rollbackPlan, 'failed worker rollback plan exists');
    const domesticSlotRollbackExecution = await this.createSiteSlotRollbackExecution({
      reportId: domesticSlotFailedWorkerReport.reportId,
      mode: 'simulate',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-rollback-execution'
    });
    if (
      domesticSlotRollbackExecution.status !== 'ready'
      || domesticSlotRollbackExecution.contractVersion !== 'site-slot-rollback-v1'
      || domesticSlotRollbackExecution.rollbackPlanId !== domesticSlotFailedRollbackPlan.rollbackPlanId
      || domesticSlotRollbackExecution.stepResults.length !== domesticSlotFailedRollbackPlan.steps.length
    ) {
      throw new Error('Rollback execution contract was not ready');
    }
    checks.push('OK Rollback execution contract created');
    const domesticSlotRollbackReport = await this.recordSiteSlotRollbackReport({
      rollbackExecutionId: domesticSlotRollbackExecution.rollbackExecutionId,
      workerId: 'worker-shadow-domestic-rollback',
      status: 'passed',
      message: 'shadow rollback contract passed',
      stepReports: [
        {
          stepId: domesticSlotRollbackExecution.stepResults[0]?.stepId,
          status: 'passed',
          exitCode: 0,
          stdout: 'rollback evidence collected',
          stderr: null,
          attempt: 1
        }
      ],
      requestId: 'smoke-domestic-slot-rollback-report'
    });
    const domesticSlotRollbackExecutionState = required(
      await this.getSiteSlotRollbackExecution(domesticSlotRollbackExecution.rollbackExecutionId),
      'rollback execution state exists'
    );
    if (
      domesticSlotRollbackReport.status !== 'passed'
      || !domesticSlotRollbackReport.nextActions.includes('close-rollback-window')
      || domesticSlotRollbackExecutionState.status !== 'passed'
      || domesticSlotRollbackExecutionState.currentRollbackReportId !== domesticSlotRollbackReport.rollbackReportId
    ) {
      throw new Error('Rollback report did not advance rollback execution to passed');
    }
    checks.push('OK Rollback report advanced rollback execution to passed');
    const networkSnapshot = await this.createLauncherNetworkSnapshot({
      installId: enrollment.installId,
      deviceId: enrollment.deviceId,
      appId: 'h2o',
      requestId: 'smoke-network'
    });
    if (networkSnapshot.overlayPolicy.cidr !== '10.91.0.0/16') {
      throw new Error('guest network snapshot did not use 10.91.0.0/16');
    }
    checks.push('OK guest network snapshot issued');
    const permissionGrant = await this.requestPermission({
      appId: 'h2o',
      installId: enrollment.installId,
      scopes: ['network.proxy.app'],
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-permission'
    });
    if (permissionGrant.decision !== 'granted') {
      throw new Error('h2o permission was not granted');
    }
    checks.push('OK h2o permission granted');
    const testRun = await this.createTestRun({
      suiteId: 'hdo-shadow-e2e',
      productId: 'h2o',
      topology: 'h-d-i-shadow',
      sites: ['domestic-main', 'internal-main'],
      releaseId: 'rel_smoke',
      installId: enrollment.installId,
      deviceId: enrollment.deviceId
    });
    const completedRun = await this.recordTestStep(testRun.testRunId, {
      caseId: 'platform-kernel',
      status: 'passed',
      evidence: { source: 'postgres-smoke' }
    });
    checks.push('OK e2e test run passed');
    const gate = await this.evaluateTestGate({
      gateId: 'gate_platform_kernel',
      releaseId: 'rel_smoke',
      runIds: [completedRun.testRunId]
    });
    if (gate.verdict !== 'passed') {
      throw new Error('release gate did not pass');
    }
    checks.push('OK release gate passed');
    const launcherUpdate = await this.evaluateReleaseUpdate({
      componentKind: 'platform-critical',
      componentId: 'launcher-network',
      currentVersion: '0.1.0',
      targetVersion: '0.1.1',
      channel: 'shadow',
      installId: enrollment.installId
    });
    if (launcherUpdate.updateMode !== 'mandatory') {
      throw new Error('launcher-network update was not mandatory');
    }
    checks.push('OK launcher update mandatory');
    const h2oUpdate = await this.evaluateReleaseUpdate({
      componentKind: 'app-managed',
      componentId: 'h2o',
      currentVersion: '0.1.0',
      targetVersion: '0.1.1',
      channel: 'shadow',
      installId: enrollment.installId
    });
    if (!h2oUpdate.canSkip) {
      throw new Error('h2o update was not skippable');
    }
    checks.push('OK h2o update skippable');
    const releaseManagementPlan = await this.createReleaseManagementPlan({
      releaseId: 'rel_smoke_management',
      installId: enrollment.installId,
      channel: 'shadow',
      appId: 'h2o',
      e2eResult: 'passed',
      requestId: 'smoke-release-management'
    });
    if (
      !releaseManagementPlan.decisions.readyToPromote
      || releaseManagementPlan.test.gate.verdict !== 'passed'
      || !releaseManagementPlan.decisions.nextActions.includes('open-canary-or-shadow-rollout')
    ) {
      throw new Error('release management plan did not pass E2E gate');
    }
    checks.push('OK Release Management plan passed E2E gate');
    const dnsPolicy = await this.getEffectiveDnsPolicy('h2o');
    checks.push('OK split DNS policy registered');
    const dnsDecision = await this.evaluateDnsQuery({
      domain: 'gateway.internal.mx',
      appId: 'h2o',
      installId: enrollment.installId,
      requestId: 'smoke-dns'
    });
    if (dnsDecision.route !== 'internal-dns' || !dnsDecision.reverseProxyRoute) {
      throw new Error('split DNS did not route gateway.internal.mx to Internal reverse proxy');
    }
    checks.push('OK split DNS internal reverse proxy decision');
    const dnsZoneSnapshot = await this.buildDnsZoneSnapshot({
      appId: 'h2o',
      requestId: 'smoke-dns-zone'
    });
    if (
      !dnsZoneSnapshot.signatures.digest
      || !dnsZoneSnapshot.zoneNames.includes('internal.mx')
      || !dnsZoneSnapshot.records.some((record) => record.name === 'gateway.internal.mx')
    ) {
      throw new Error('DNS zone snapshot did not include signed Internal CoreDNS records');
    }
    checks.push('OK DNS Control signed CoreDNS zone snapshot built');
    const coreDnsSync = await this.syncCoreDnsConfigMap({
      snapshotId: dnsZoneSnapshot.snapshotId,
      mode: 'shadow-apply',
      requestId: 'smoke-coredns-sync'
    });
    if (
      coreDnsSync.applied
      || coreDnsSync.namespace !== 'mx-dns'
      || !coreDnsSync.manifest.yaml.includes('Corefile')
      || !coreDnsSync.manifest.yaml.includes('gateway.internal.mx')
      || !coreDnsSync.manifest.yaml.includes(dnsZoneSnapshot.signatures.digest)
    ) {
      throw new Error('CoreDNS ConfigMap sync did not render expected shadow manifest');
    }
    checks.push('OK CoreDNS ConfigMap shadow sync rendered');
    const configPolicySnapshot = await this.createConfigPolicySnapshot({
      installId: enrollment.installId,
      appId: 'h2o',
      channel: 'shadow',
      requestId: 'smoke-config-policy'
    });
    if (
      !configPolicySnapshot.signatures.digest
      || configPolicySnapshot.policies.dns.policy.policyId !== dnsPolicy.policyId
      || configPolicySnapshot.policies.permissionPolicy.declaredScopes.length === 0
      || configPolicySnapshot.policies.launcherNetwork.overlayPolicy.cidr !== '10.91.0.0/16'
    ) {
      throw new Error('config policy snapshot did not aggregate signed platform policy');
    }
    checks.push('OK Config Center signed policy snapshot issued');
    return {
      ok: true,
      checks,
      app,
      userCenter,
      issuedServiceToken,
      sdkAccess,
      deniedSdkAccess,
      configPolicySnapshot,
      enrollment,
      principalContext,
      sdkIntrospection,
      sdkGateway,
      domesticSlotPlan,
      overseaSlotPlan,
      domesticSlotPreflightExecution,
      domesticSlotApplyExecution,
      domesticSlotPreflightRunnerSession: domesticSlotPreflightRunnerSessionState,
      domesticSlotRemoteRunnerSession,
      domesticSlotWorkerJob: domesticSlotWorkerJobState,
      domesticSlotWorkerReport,
      domesticSlotFailedWorkerJob,
      domesticSlotFailedWorkerReport,
      domesticSlotRollbackExecution: domesticSlotRollbackExecutionState,
      domesticSlotRollbackReport,
      networkSnapshot,
      permissionGrant,
      testRun: completedRun,
      gate,
      releaseManagementPlan,
      launcherUpdate,
      h2oUpdate,
      dnsPolicy,
      dnsDecision,
      dnsZoneSnapshot,
      coreDnsSync
    };
  }

  private async registerBuiltinApps(): Promise<void> {
    await Promise.all(
      builtinAppCenterApps().map((app) => this.saveRecord('app-center-app', app.appId, app, this.config.siteId))
    );
  }

  private async registerBuiltinDns(): Promise<void> {
    await Promise.all([
      ...builtinDnsPolicies(this.config).map((policy) => {
        return this.saveRecord('dns-policy', policy.policyId, policy, policy.siteId);
      }),
      ...builtinDnsReverseProxyRoutes(this.config).map((route) => {
        return this.saveRecord('dns-reverse-proxy-route', route.routeId, route, this.config.siteId);
      })
    ]);
  }

  private createSnapshot(
    enrollment: AnonymousEnrollment,
    version: number,
    defaultMode: 'visitor' | 'employee'
  ): ConfigSnapshot {
    return createConfigSnapshot(this.config, enrollment, `cfgsnap_${randomUUID()}`, version, defaultMode);
  }

  private async allocateOverlayIp(): Promise<string> {
    return `10.70.0.${await this.nextSequenceValue('mx_overlay_ip_seq')}`;
  }

  private async allocateGuestLeaseIp(): Promise<string> {
    return `10.91.0.${await this.nextSequenceValue('mx_guest_ip_seq')}`;
  }

  private async allocateUserLeaseIp(): Promise<string> {
    return `10.89.0.${await this.nextSequenceValue('mx_user_ip_seq')}`;
  }

  private async nextSequenceValue(sequenceName: SequenceName): Promise<number> {
    const rows = await this.dataSource.query(`SELECT nextval('${sequenceName}') AS value`) as Array<{ value: string | number }>;
    return Number(rows[0]?.value ?? 20);
  }

  private async countRecords(kind: RecordKind): Promise<number> {
    return this.records.count({
      where: {
        kind,
        environment: this.config.environment
      }
    });
  }

  private async listRecords<T extends object>(kind: RecordKind): Promise<T[]> {
    const rows = await this.records.find({
      where: {
        kind,
        environment: this.config.environment
      },
      order: {
        id: 'ASC'
      }
    });
    return rows.map((row) => row.data as T);
  }

  private async getRecord<T extends object>(kind: RecordKind, id: string): Promise<T | null> {
    const row = await this.records.findOne({
      where: {
        kind,
        id,
        environment: this.config.environment
      }
    });
    return row ? row.data as T : null;
  }

  private async saveRecord<T extends object>(
    kind: RecordKind,
    id: string,
    data: T,
    siteId: string | null
  ): Promise<void> {
    await this.records.save({
      kind,
      id,
      environment: this.config.environment,
      siteId,
      data: data as Record<string, unknown>
    });
  }

  private async upsertRecord<T extends object>(
    kind: RecordKind,
    id: string,
    data: T,
    siteId: string | null
  ): Promise<T> {
    await this.saveRecord(kind, id, data, siteId);
    return data;
  }

  private async principalForSubject(
    subjectKind: UserCenterTokenRecord['subjectKind'],
    subjectId: string
  ) {
    const roles = await this.listUserCenterRoles();
    if (subjectKind === 'user') {
      const user = await this.getRecord<UserCenterUser>('iam-user', subjectId);
      return user && user.status === 'active' ? createUserPrincipalFromRecord(user, roles) : null;
    }
    const serviceAccount = await this.getRecord<UserCenterServiceAccount>('iam-service-account', subjectId);
    return serviceAccount && serviceAccount.status === 'active'
      ? createServiceAccountPrincipalFromRecord(serviceAccount, roles)
      : null;
  }
}
