import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  builtinAppCenterApps,
  buildAwxProviderConfig,
  buildReleaseManagementPlan,
  buildRuntimeFeaturePolicy,
  buildLauncherNetworkMihomoSite,
  buildLauncherNetworkTopology,
  buildLauncherNetworkReachabilityPlan,
  buildSiteSlotAccessAccount,
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
  createConfigSnapshot,
  createConfigPolicySnapshot,
  createSdkGatewayManifest,
  defaultSiteSlotAccessAccountNames,
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
  renderHysteria2MihomoSubscription,
  renderCoreDnsConfigMap,
  resolvePrincipalContext,
  required
} from './domain.js';
import { applyCoreDnsConfigMapToKubernetes } from './kubernetes.js';
import type { PlatformStore } from './platform-store.js';
import type {
  AnonymousEnrollment,
  AnonymousEnrollmentRequest,
  AppCenterApp,
  AuditEvent,
  AuditEventInput,
  AwxProviderConfig,
  AwxProviderConfigInput,
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
  LauncherNetworkMihomoSite,
  LauncherNetworkMihomoSiteInput,
  LauncherNetworkReachabilityPlan,
  LogEntryInput,
  MihomoSubscriptionRender,
  PermissionGrant,
  PermissionRequestInput,
  PrincipalContext,
  PrincipalContextInput,
  PlatformKernelSmokeResult,
  ReleasePolicyDecision,
  ReleasePolicyInput,
  ReleaseManagementPlan,
  ReleaseManagementPlanInput,
  ReleaseReportInput,
  ReleaseTask,
  RuntimeConfig,
  RuntimeFeaturePolicy,
  RuntimeFeaturePolicyInput,
  SdkGatewayAccessDecision,
  SdkGatewayAccessInput,
  SdkGatewayManifest,
  SiteSlotExecutionInput,
  SiteSlotExecutionRun,
  SiteSlotAccessAccount,
  SiteSlotAccessAccountIssueInput,
  SiteSlotAccessAccountIssueResult,
  SiteSlotKind,
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
  SiteHeartbeat,
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

export class MemoryStore implements PlatformStore {
  private readonly sites = new Map<string, SiteHeartbeat>();
  private readonly enrollments = new Map<string, AnonymousEnrollment>();
  private readonly snapshots = new Map<string, ConfigSnapshot>();
  private readonly configPolicySnapshots = new Map<string, ConfigPolicySnapshot>();
  private readonly tasks = new Map<string, ReleaseTask[]>();
  private readonly siteSlotPlans = new Map<string, SiteSlotPlan>();
  private readonly siteSlotExecutions = new Map<string, SiteSlotExecutionRun>();
  private readonly siteSlotRunnerSessions = new Map<string, SiteSlotRunnerSession>();
  private readonly siteSlotWorkerJobs = new Map<string, SiteSlotWorkerJob>();
  private readonly siteSlotWorkerReports = new Map<string, SiteSlotWorkerReport>();
  private readonly siteSlotRollbackExecutions = new Map<string, SiteSlotRollbackExecution>();
  private readonly siteSlotRollbackReports = new Map<string, SiteSlotRollbackReport>();
  private readonly siteSlotSshProfiles = new Map<string, SiteSlotSshProfile>();
  private readonly siteSlotAccessAccounts = new Map<string, SiteSlotAccessAccount>();
  private readonly launcherNetworkMihomoSites = new Map<string, LauncherNetworkMihomoSite>();
  private readonly runtimeFeaturePolicies = new Map<string, RuntimeFeaturePolicy>();
  private readonly awxProviderConfigs = new Map<string, AwxProviderConfig>();
  private readonly appCatalog = new Map<string, AppCenterApp>();
  private readonly tenants = new Map<string, UserCenterTenant>();
  private readonly orgs = new Map<string, UserCenterOrg>();
  private readonly roles = new Map<string, UserCenterRole>();
  private readonly users = new Map<string, UserCenterUser>();
  private readonly serviceAccounts = new Map<string, UserCenterServiceAccount>();
  private readonly tokens = new Map<string, UserCenterTokenRecord>();
  private readonly dnsPolicies = new Map<string, DnsPolicy>();
  private readonly dnsReverseProxyRoutes = new Map<string, DnsReverseProxyRoute>();
  private readonly dnsZoneSnapshots = new Map<string, DnsZoneSnapshot>();
  private readonly coreDnsConfigMapSyncs = new Map<string, CoreDnsConfigMapSyncResult>();
  private readonly coreDnsConfigMapApplies = new Map<string, CoreDnsConfigMapApplyResult>();
  private readonly releaseManagementPlans = new Map<string, ReleaseManagementPlan>();
  private readonly permissionGrants = new Map<string, PermissionGrant>();
  private readonly testRuns = new Map<string, TestRun>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly logs: LogEntryInput[] = [];
  private nextGuestHost = 20;
  private nextUserHost = 20;

  constructor(private readonly config: RuntimeConfig) {
    this.registerBuiltinApps();
    this.registerBuiltinDns();
  }

  overview() {
    return {
      environment: this.config.environment,
      siteId: this.config.siteId,
      siteRole: this.config.siteRole,
      enabledModules: this.config.enabledModules,
      storeDriver: this.config.storeDriver,
      sites: this.sites.size,
      enrollments: this.enrollments.size,
      snapshots: this.snapshots.size,
      configPolicySnapshots: this.configPolicySnapshots.size,
      appCenterApps: this.appCatalog.size,
      userCenterUsers: this.users.size,
      userCenterServiceAccounts: this.serviceAccounts.size,
      userCenterTokens: this.tokens.size,
      siteSlotPlans: this.siteSlotPlans.size,
      siteSlotExecutions: this.siteSlotExecutions.size,
      siteSlotRunnerSessions: this.siteSlotRunnerSessions.size,
      siteSlotWorkerJobs: this.siteSlotWorkerJobs.size,
      siteSlotWorkerReports: this.siteSlotWorkerReports.size,
      siteSlotRollbackExecutions: this.siteSlotRollbackExecutions.size,
      siteSlotRollbackReports: this.siteSlotRollbackReports.size,
      awxProviderConfigs: this.awxProviderConfigs.size,
      dnsPolicies: this.dnsPolicies.size,
      dnsReverseProxyRoutes: this.dnsReverseProxyRoutes.size,
      dnsZoneSnapshots: this.dnsZoneSnapshots.size,
      coreDnsConfigMapSyncs: this.coreDnsConfigMapSyncs.size,
      coreDnsConfigMapApplies: this.coreDnsConfigMapApplies.size,
      releaseManagementPlans: this.releaseManagementPlans.size,
      permissionGrants: this.permissionGrants.size,
      testRuns: this.testRuns.size,
      auditEvents: this.auditEvents.length,
      logs: this.logs.length
    };
  }

  upsertSiteHeartbeat(
    heartbeat: Omit<SiteHeartbeat, 'environment' | 'lastSeenAt' | 'siteRole'> & { siteRole?: SiteRole }
  ): SiteHeartbeat {
    const row: SiteHeartbeat = {
      ...heartbeat,
      environment: this.config.environment,
      siteRole: heartbeat.siteRole ?? this.config.siteRole,
      lastSeenAt: new Date().toISOString()
    };
    this.sites.set(row.siteId, row);
    return row;
  }

  listSites(): SiteHeartbeat[] {
    return [...this.sites.values()].sort((a, b) => a.siteId.localeCompare(b.siteId));
  }

  createSiteSlotPlan(input: SiteSlotPlanInput): SiteSlotPlan {
    const planInput = this.withSiteSlotSshProfile(input);
    const plan = buildSiteSlotPlan(this.config, planInput, `slotplan_${randomUUID()}`);
    this.siteSlotPlans.set(plan.planId, plan);
    this.recordAudit({
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

  getSiteSlotPlan(planId: string): SiteSlotPlan | null {
    return this.siteSlotPlans.get(planId) ?? null;
  }

  listSiteSlotPlans(): SiteSlotPlan[] {
    return [...this.siteSlotPlans.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createSiteSlotExecution(input: SiteSlotExecutionInput): SiteSlotExecutionRun {
    const planId = input.planId?.trim();
    const plan = planId ? this.siteSlotPlans.get(planId) : null;
    if (!plan) throw new Error(`Unknown site slot plan: ${input.planId ?? '<empty>'}`);
    const run = buildSiteSlotExecutionRun(this.config, plan, input, `slotexec_${randomUUID()}`);
    this.siteSlotExecutions.set(run.runId, run);
    this.recordAudit({
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

  getSiteSlotExecution(runId: string): SiteSlotExecutionRun | null {
    return this.siteSlotExecutions.get(runId) ?? null;
  }

  listSiteSlotExecutions(planId?: string | null): SiteSlotExecutionRun[] {
    return [...this.siteSlotExecutions.values()]
      .filter((run) => !planId || run.planId === planId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  startSiteSlotRunnerSession(input: SiteSlotRunnerStartInput): SiteSlotRunnerSession {
    const runId = input.runId?.trim();
    const execution = runId ? this.siteSlotExecutions.get(runId) : null;
    if (!execution) throw new Error(`Unknown site slot execution: ${input.runId ?? '<empty>'}`);
    const session = buildSiteSlotRunnerSession(this.config, execution, input, `slotrunner_${randomUUID()}`);
    this.siteSlotRunnerSessions.set(session.sessionId, session);
    this.recordAudit({
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

  getSiteSlotRunnerSession(sessionId: string): SiteSlotRunnerSession | null {
    return this.siteSlotRunnerSessions.get(sessionId) ?? null;
  }

  listSiteSlotRunnerSessions(runId?: string | null): SiteSlotRunnerSession[] {
    return [...this.siteSlotRunnerSessions.values()]
      .filter((session) => !runId || session.runId === runId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  createSiteSlotWorkerJob(input: SiteSlotWorkerJobInput): SiteSlotWorkerJob {
    const sessionId = input.sessionId?.trim();
    const session = sessionId ? this.siteSlotRunnerSessions.get(sessionId) : null;
    if (!session) throw new Error(`Unknown site slot runner session: ${input.sessionId ?? '<empty>'}`);
    const job = buildSiteSlotWorkerJob(session, input, `slotjob_${randomUUID()}`);
    this.siteSlotWorkerJobs.set(job.jobId, job);
    this.recordAudit({
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

  getSiteSlotWorkerJob(jobId: string): SiteSlotWorkerJob | null {
    return this.siteSlotWorkerJobs.get(jobId) ?? null;
  }

  listSiteSlotWorkerJobs(sessionId?: string | null): SiteSlotWorkerJob[] {
    return [...this.siteSlotWorkerJobs.values()]
      .filter((job) => !sessionId || job.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recordSiteSlotWorkerReport(input: SiteSlotWorkerReportInput): SiteSlotWorkerReport {
    const jobId = input.jobId?.trim();
    const job = jobId ? this.siteSlotWorkerJobs.get(jobId) : null;
    if (!job) throw new Error(`Unknown site slot worker job: ${input.jobId ?? '<empty>'}`);
    const report = buildSiteSlotWorkerReport(job, input, `slotreport_${randomUUID()}`);
    const session = this.siteSlotRunnerSessions.get(job.sessionId);
    if (session) {
      const state = applySiteSlotWorkerReportState(job, session, report);
      this.siteSlotWorkerJobs.set(state.job.jobId, state.job);
      this.siteSlotRunnerSessions.set(state.session.sessionId, state.session);
    }
    this.siteSlotWorkerReports.set(report.reportId, report);
    this.recordAudit({
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

  getSiteSlotWorkerReport(reportId: string): SiteSlotWorkerReport | null {
    return this.siteSlotWorkerReports.get(reportId) ?? null;
  }

  listSiteSlotWorkerReports(jobId?: string | null): SiteSlotWorkerReport[] {
    return [...this.siteSlotWorkerReports.values()]
      .filter((report) => !jobId || report.jobId === jobId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createSiteSlotRollbackExecution(input: SiteSlotRollbackExecutionInput): SiteSlotRollbackExecution {
    const reportId = input.reportId?.trim();
    const report = reportId ? this.siteSlotWorkerReports.get(reportId) : null;
    if (!report) throw new Error(`Unknown site slot worker report: ${input.reportId ?? '<empty>'}`);
    const rollbackExecution = buildSiteSlotRollbackExecution(report, input, `slotrollback_${randomUUID()}`);
    this.siteSlotRollbackExecutions.set(rollbackExecution.rollbackExecutionId, rollbackExecution);
    this.recordAudit({
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

  getSiteSlotRollbackExecution(rollbackExecutionId: string): SiteSlotRollbackExecution | null {
    return this.siteSlotRollbackExecutions.get(rollbackExecutionId) ?? null;
  }

  listSiteSlotRollbackExecutions(reportId?: string | null): SiteSlotRollbackExecution[] {
    return [...this.siteSlotRollbackExecutions.values()]
      .filter((execution) => !reportId || execution.sourceReportId === reportId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recordSiteSlotRollbackReport(input: SiteSlotRollbackReportInput): SiteSlotRollbackReport {
    const rollbackExecutionId = input.rollbackExecutionId?.trim();
    const rollbackExecution = rollbackExecutionId ? this.siteSlotRollbackExecutions.get(rollbackExecutionId) : null;
    if (!rollbackExecution) throw new Error(`Unknown site slot rollback execution: ${input.rollbackExecutionId ?? '<empty>'}`);
    const report = buildSiteSlotRollbackReport(rollbackExecution, input, `slotrollbackreport_${randomUUID()}`);
    const executionState = applySiteSlotRollbackReportState(rollbackExecution, report);
    this.siteSlotRollbackExecutions.set(executionState.rollbackExecutionId, executionState);
    this.siteSlotRollbackReports.set(report.rollbackReportId, report);
    this.recordAudit({
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

  getSiteSlotRollbackReport(rollbackReportId: string): SiteSlotRollbackReport | null {
    return this.siteSlotRollbackReports.get(rollbackReportId) ?? null;
  }

  listSiteSlotRollbackReports(rollbackExecutionId?: string | null): SiteSlotRollbackReport[] {
    return [...this.siteSlotRollbackReports.values()]
      .filter((report) => !rollbackExecutionId || report.rollbackExecutionId === rollbackExecutionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  enrollAnonymous(input: AnonymousEnrollmentRequest): {
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
  } {
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
      overlayIp: this.allocateGuestLeaseIp(),
      relayMode: input.relayMode?.trim() || 'h2i',
      publicKey: input.publicKey?.trim() || null,
      createdAt: now,
      userId: null
    };
    this.enrollments.set(installId, enrollment);
    const snapshot = this.createSnapshot(enrollment, 1, 'visitor');
    this.snapshots.set(installId, snapshot);
    this.recordAudit({
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

  linkIdentity(input: IdentityLinkRequest): {
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
    auditEvent: AuditEvent;
  } {
    const enrollment = this.enrollments.get(input.installId);
    if (!enrollment) {
      throw new Error(`Unknown installId: ${input.installId}`);
    }
    enrollment.userId = input.userId;
    if (!enrollment.overlayIp.startsWith('10.89.')) {
      enrollment.overlayIp = this.allocateUserLeaseIp();
    }
    const previous = this.snapshots.get(input.installId);
    const nextVersion = (previous?.version ?? 1) + 1;
    const snapshot = this.createSnapshot(enrollment, nextVersion, 'employee');
    this.snapshots.set(input.installId, snapshot);
    const auditEvent = this.recordAudit({
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

  bootstrapUserCenter(): UserCenterBootstrapResult {
    const tenant = builtinUserCenterTenant();
    const org = builtinUserCenterOrg();
    this.tenants.set(tenant.tenantId, tenant);
    this.orgs.set(org.orgId, org);
    for (const role of builtinUserCenterRoles()) {
      this.roles.set(role.roleId, role);
    }
    const admin = this.createUserCenterUser({
      userId: 'usr_demo_admin',
      email: 'admin@mx.local',
      displayName: 'MX Demo Admin',
      roleIds: ['mx-admin'],
      requestId: 'bootstrap-user-center'
    });
    const user = this.createUserCenterUser({
      userId: 'usr_demo_user',
      email: 'user@mx.local',
      displayName: 'MX Demo User',
      roleIds: ['mx-user'],
      requestId: 'bootstrap-user-center'
    });
    const serviceAccount = this.createUserCenterServiceAccount({
      serviceAccountId: 'svc_sdk_gateway',
      displayName: 'SDK Gateway',
      roleIds: ['mx-service-account'],
      requestId: 'bootstrap-user-center'
    });
    return createBootstrapResult([...this.roles.values()], [admin, user], [serviceAccount]);
  }

  listUserCenterRoles(): UserCenterRole[] {
    return [...this.roles.values()].sort((a, b) => a.roleId.localeCompare(b.roleId));
  }

  listUserCenterUsers(): UserCenterUser[] {
    return [...this.users.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }

  createUserCenterUser(input: CreateUserInput): UserCenterUser {
    const user = createUserCenterUser(input);
    this.users.set(user.userId, user);
    this.recordAudit({
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

  listUserCenterServiceAccounts(): UserCenterServiceAccount[] {
    return [...this.serviceAccounts.values()].sort((a, b) => a.serviceAccountId.localeCompare(b.serviceAccountId));
  }

  createUserCenterServiceAccount(input: CreateServiceAccountInput): UserCenterServiceAccount {
    const serviceAccount = createUserCenterServiceAccount(input);
    this.serviceAccounts.set(serviceAccount.serviceAccountId, serviceAccount);
    this.recordAudit({
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

  issueUserCenterToken(input: IssueTokenInput): UserCenterIssuedToken {
    const principal = this.principalForSubject(input.subjectKind, input.subjectId);
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
    this.tokens.set(issued.record.tokenHash, issued.record);
    this.recordAudit({
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

  introspectToken(input: TokenIntrospectionInput): TokenIntrospectionResult {
    const token = input.token?.trim() ?? '';
    const record = token ? this.tokens.get(hashToken(token)) ?? null : null;
    const principal = record ? this.principalForSubject(record.subjectKind, record.subjectId) : null;
    const result = introspectUserCenterToken(this.config, input, record, principal)
      ?? introspectShadowToken(this.config, input);
    this.recordAudit({
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

  resolvePrincipalContext(input: PrincipalContextInput): PrincipalContext {
    const enrollment = input.installId ? this.enrollments.get(input.installId) ?? null : null;
    const auth = this.introspectToken({
      token: input.token,
      audience: input.audience,
      requestId: input.requestId
    });
    const boundPrincipal = input.userId ? this.principalForSubject('user', input.userId) : null;
    const context = resolvePrincipalContext(this.config, input, enrollment, auth, boundPrincipal);
    this.recordAudit({
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

  evaluateSdkGatewayAccess(input: SdkGatewayAccessInput): SdkGatewayAccessDecision {
    const introspection = this.introspectToken({
      token: input.token,
      audience: input.audience,
      requestId: input.requestId
    });
    const decision = evaluateSdkGatewayRoute(introspection.principal, input.routeId);
    this.recordAudit({
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

  createConfigPolicySnapshot(input: ConfigPolicySnapshotInput): ConfigPolicySnapshot {
    const appId = input.appId?.trim() || 'h2o';
    const enrollment = input.installId ? this.enrollments.get(input.installId) ?? null : null;
    const principalContext = this.resolvePrincipalContext({
      token: input.token,
      audience: input.audience,
      userId: input.userId,
      installId: input.installId,
      requestId: input.requestId
    });
    const app = this.getAppCenterApp(appId);
    const launcherNetwork = this.createLauncherNetworkSnapshot({
      installId: enrollment?.installId ?? input.installId ?? undefined,
      deviceId: enrollment?.deviceId ?? input.deviceId ?? undefined,
      siteId: enrollment?.siteId ?? undefined,
      userId: principalContext.principal.userId ?? enrollment?.userId ?? input.userId ?? null,
      publicKey: enrollment?.publicKey ?? null,
      appId,
      requestId: input.requestId ?? undefined
    });
    const launcherRelease = this.evaluateReleaseUpdate({
      componentKind: 'platform-critical',
      componentId: 'launcher-network',
      currentVersion: '0.1.0',
      targetVersion: '0.1.1',
      channel: input.channel ?? 'shadow',
      installId: enrollment?.installId ?? input.installId ?? null,
      userId: principalContext.principal.userId
    });
    const appRelease = this.evaluateReleaseUpdate({
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
      version: this.configPolicySnapshots.size + 1,
      app,
      principal: principalContext.principal,
      enrollment,
      launcherNetwork,
      dnsPolicy: this.getEffectiveDnsPolicy(appId),
      reverseProxyRoutes: this.listDnsReverseProxyRoutes(),
      sdkGateway: this.sdkGatewayManifest(),
      launcherRelease,
      appRelease
    });
    this.configPolicySnapshots.set(snapshot.snapshotId, snapshot);
    this.recordAudit({
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

  getConfigPolicySnapshot(snapshotId: string): ConfigPolicySnapshot | null {
    return this.configPolicySnapshots.get(snapshotId) ?? null;
  }

  listSiteSlotSshProfiles(): SiteSlotSshProfile[] {
    return [...this.siteSlotSshProfiles.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSiteSlotSshProfile(profileId: string): SiteSlotSshProfile | null {
    return this.siteSlotSshProfiles.get(profileId) ?? null;
  }

  getSiteSlotSshProfileForSite(siteId: string): SiteSlotSshProfile | null {
    return this.listSiteSlotSshProfiles().find((profile) => profile.siteId === siteId && profile.status === 'active') ?? null;
  }

  upsertSiteSlotSshProfile(input: SiteSlotSshProfileInput): SiteSlotSshProfile {
    const previous = input.profileId ? this.siteSlotSshProfiles.get(input.profileId) ?? null : null;
    const profile = buildSiteSlotSshProfile(this.config, input, previous);
    this.siteSlotSshProfiles.set(profile.profileId, profile);
    this.recordAudit({
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

  issueSiteSlotAccessAccounts(input: SiteSlotAccessAccountIssueInput): SiteSlotAccessAccountIssueResult {
    const siteId = input.siteId?.trim() || 'oversea-main';
    const site = this.upsertLauncherNetworkMihomoSite({
      siteId,
      publicHost: input.publicHost,
      serverPorts: input.serverPorts,
      requestedBy: input.requestedBy,
      requestId: input.requestId
    });
    const accountNames = resolveIssueAccountNames(input, siteId);
    const accounts = accountNames.map((username) => {
      const accountId = `slotacct_${siteId}_${username}`.replace(/[^a-zA-Z0-9._-]/g, '_');
      const previous = this.siteSlotAccessAccounts.get(accountId) ?? null;
      const account = buildSiteSlotAccessAccount(this.config, {
        siteId,
        username,
        authToken: previous?.authToken || randomBytes(24).toString('base64url'),
        requestedBy: input.requestedBy
      }, previous);
      this.siteSlotAccessAccounts.set(account.accountId, account);
      return account;
    });
    this.recordAudit({
      eventType: 'config.site_slot_access_accounts.issued',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        siteId,
        service: 'hysteria2',
        accounts: accounts.map((account) => ({ username: account.username, role: account.role }))
      }
    });
    return { site, accounts };
  }

  listSiteSlotAccessAccounts(siteId: string): SiteSlotAccessAccount[] {
    return [...this.siteSlotAccessAccounts.values()]
      .filter((account) => account.siteId === siteId)
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  getSiteSlotAccessAccount(siteId: string, username: string): SiteSlotAccessAccount | null {
    return this.listSiteSlotAccessAccounts(siteId).find((account) => account.username === username) ?? null;
  }

  upsertLauncherNetworkMihomoSite(input: LauncherNetworkMihomoSiteInput): LauncherNetworkMihomoSite {
    const siteId = input.siteId?.trim() || 'oversea-main';
    const previous = this.launcherNetworkMihomoSites.get(siteId) ?? null;
    const latestPlan = this.latestSiteSlotPlanForSite(siteId);
    const site = buildLauncherNetworkMihomoSite(this.config, input, previous, latestPlan?.host ?? null);
    this.launcherNetworkMihomoSites.set(site.siteId, site);
    this.recordAudit({
      eventType: 'launcher_network.mihomo_site.upserted',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        siteId: site.siteId,
        publicHost: site.publicHost,
        subscriptionBaseUrl: site.subscriptionBaseUrl,
        reachability: site.reachability
      }
    });
    return site;
  }

  getLauncherNetworkMihomoSite(siteId: string): LauncherNetworkMihomoSite | null {
    return this.launcherNetworkMihomoSites.get(siteId) ?? null;
  }

  getLauncherNetworkMihomoReachability(siteId: string): LauncherNetworkReachabilityPlan | null {
    const site = this.getLauncherNetworkMihomoSite(siteId);
    if (!site) return null;
    return buildLauncherNetworkReachabilityPlan(site, this.listSiteSlotAccessAccounts(siteId));
  }

  renderHysteria2MihomoSubscription(siteId: string, username: string): MihomoSubscriptionRender | null {
    const site = this.getLauncherNetworkMihomoSite(siteId);
    const account = this.getSiteSlotAccessAccount(siteId, username);
    if (!site || !account || account.status !== 'active') return null;
    return renderHysteria2MihomoSubscription(site, account);
  }

  listRuntimeFeaturePolicies(featureKey?: string | null): RuntimeFeaturePolicy[] {
    return [...this.runtimeFeaturePolicies.values()]
      .filter((policy) => !featureKey || policy.featureKey === featureKey)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getRuntimeFeaturePolicy(policyId: string): RuntimeFeaturePolicy | null {
    return this.runtimeFeaturePolicies.get(policyId) ?? null;
  }

  upsertRuntimeFeaturePolicy(input: RuntimeFeaturePolicyInput): RuntimeFeaturePolicy {
    const candidate = buildRuntimeFeaturePolicy(this.config, input, null);
    const previous = this.runtimeFeaturePolicies.get(candidate.policyId) ?? null;
    const policy = buildRuntimeFeaturePolicy(this.config, input, previous);
    this.runtimeFeaturePolicies.set(policy.policyId, policy);
    this.recordAudit({
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

  listAwxProviderConfigs(kind?: SiteSlotKind | 'all' | null): AwxProviderConfig[] {
    return [...this.awxProviderConfigs.values()]
      .filter((provider) => !kind || kind === 'all' || provider.defaultKind === kind || provider.defaultKind === 'all')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getAwxProviderConfig(providerId: string): AwxProviderConfig | null {
    return this.awxProviderConfigs.get(providerId) ?? null;
  }

  upsertAwxProviderConfig(input: AwxProviderConfigInput): AwxProviderConfig {
    const candidate = buildAwxProviderConfig(this.config, input, null);
    const previous = this.awxProviderConfigs.get(candidate.providerId) ?? null;
    const provider = buildAwxProviderConfig(this.config, input, previous);
    this.awxProviderConfigs.set(provider.providerId, provider);
    this.recordAudit({
      eventType: 'config.awx_provider.upserted',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        providerId: provider.providerId,
        status: provider.status,
        defaultKind: provider.defaultKind,
        baseUrl: provider.baseUrl,
        organization: provider.organization,
        project: provider.project
      }
    });
    return provider;
  }

  private withSiteSlotSshProfile(input: SiteSlotPlanInput): SiteSlotPlanInput {
    const profileId = input.sshProfileId?.trim();
    if (!profileId) return input;
    const profile = this.siteSlotSshProfiles.get(profileId);
    if (!profile) return { ...input, sshProfileError: `SSH profile not found: ${profileId}` };
    return {
      ...input,
      sshProfile: profile,
      kind: input.kind ?? profile.kind,
      siteId: input.siteId ?? profile.siteId
    };
  }

  getSnapshot(installId: string): ConfigSnapshot | null {
    return this.snapshots.get(installId) ?? null;
  }

  listTasks(installId: string): ReleaseTask[] {
    return this.tasks.get(installId) ?? [];
  }

  recordReleaseReport(input: ReleaseReportInput): AuditEvent {
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

  recordAudit(input: AuditEventInput): AuditEvent {
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
    this.auditEvents.push(row);
    return row;
  }

  recordLogs(entries: LogEntryInput[]): { accepted: number; sinks: RuntimeConfig['observabilitySinks'] } {
    this.logs.push(...entries);
    return {
      accepted: entries.length,
      sinks: this.config.observabilitySinks
    };
  }

  observabilitySinks(): RuntimeConfig['observabilitySinks'] {
    return this.config.observabilitySinks;
  }

  listAppCenterApps(): AppCenterApp[] {
    return [...this.appCatalog.values()].sort((a, b) => a.appId.localeCompare(b.appId));
  }

  getAppCenterApp(appId: string): AppCenterApp | null {
    return this.appCatalog.get(appId) ?? null;
  }

  listDnsPolicies(): DnsPolicy[] {
    return [...this.dnsPolicies.values()].sort((a, b) => b.priority - a.priority);
  }

  getEffectiveDnsPolicy(appId?: string | null): DnsPolicy {
    const policies = this.listDnsPolicies()
      .filter((policy) => policy.enabled)
      .filter((policy) => !appId || policy.owners.includes(appId) || policy.owners.includes('sdk-gateway'));
    return required(policies[0] ?? null, 'effective DNS policy is registered');
  }

  evaluateDnsQuery(input: DnsQueryInput): DnsResolutionDecision {
    const policy = this.getEffectiveDnsPolicy(input.appId);
    const decision = evaluateDnsPolicy(policy, this.listDnsReverseProxyRoutes(), input);
    this.recordAudit({
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

  listDnsReverseProxyRoutes(): DnsReverseProxyRoute[] {
    return [...this.dnsReverseProxyRoutes.values()].sort((a, b) => a.host.localeCompare(b.host));
  }

  buildDnsZoneSnapshot(input: DnsZoneSnapshotInput): DnsZoneSnapshot {
    const policy = input.policyId
      ? required(this.dnsPolicies.get(input.policyId) ?? null, `DNS policy not found: ${input.policyId}`)
      : this.getEffectiveDnsPolicy(input.appId ?? 'sdk-gateway');
    const snapshot = buildDnsZoneSnapshot(this.config, {
      snapshotId: `dnszone_${randomUUID()}`,
      version: this.dnsZoneSnapshots.size + 1,
      policy,
      reverseProxyRoutes: this.listDnsReverseProxyRoutes(),
      requestId: input.requestId ?? null
    });
    this.dnsZoneSnapshots.set(snapshot.snapshotId, snapshot);
    this.recordAudit({
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

  getDnsZoneSnapshot(snapshotId: string): DnsZoneSnapshot | null {
    return this.dnsZoneSnapshots.get(snapshotId) ?? null;
  }

  syncCoreDnsConfigMap(input: CoreDnsConfigMapSyncInput): CoreDnsConfigMapSyncResult {
    const snapshot = input.snapshotId
      ? required(this.getDnsZoneSnapshot(input.snapshotId), `DNS zone snapshot not found: ${input.snapshotId}`)
      : this.buildDnsZoneSnapshot(input);
    const result = renderCoreDnsConfigMap(snapshot, input, `dnsync_${randomUUID()}`);
    this.coreDnsConfigMapSyncs.set(result.syncId, result);
    this.recordAudit({
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
    const sync = this.syncCoreDnsConfigMap({ ...input, mode: 'shadow-apply' });
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
    this.coreDnsConfigMapApplies.set(result.applyId, result);
    this.recordAudit({
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

  requestPermission(input: PermissionRequestInput): PermissionGrant {
    const app = this.appCatalog.get(input.appId);
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
    this.permissionGrants.set(grant.grantId, grant);
    this.recordAudit({
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

  createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): LauncherNetworkSnapshot {
    const mode = input.userId ? 'user' : 'guest';
    const leaseIp = mode === 'user' ? this.allocateUserLeaseIp() : this.allocateGuestLeaseIp();
    const topology = buildLauncherNetworkTopology(this.config, {
      mode,
      leaseIp,
      domesticSiteId: input.siteId,
      publicKey: input.publicKey
    });
    const issuedAt = new Date().toISOString();
    const unsigned = {
      environment: this.config.environment,
      appId: input.appId ?? 'h2o',
      installId: input.installId ?? `inst_${randomUUID()}`,
      deviceId: input.deviceId ?? `dev_${randomUUID()}`,
      userId: input.userId ?? null,
      mode,
      leaseIp,
      topology,
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
      topology,
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
    this.recordAudit({
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
        topologyModel: snapshot.topology.model,
        capabilities: snapshot.capabilities
      }
    });
    return snapshot;
  }

  evaluateReleaseUpdate(input: ReleasePolicyInput): ReleasePolicyDecision {
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

    const policy = releasePolicyByKind(componentKind);
    return {
      componentKind,
      componentId: input.componentId,
      currentVersion: input.currentVersion,
      targetVersion: input.targetVersion,
      updateAvailable: true,
      ...policy
    };
  }

  createReleaseManagementPlan(input: ReleaseManagementPlanInput): ReleaseManagementPlan {
    const releaseId = input.releaseId?.trim() || `rel_${randomUUID()}`;
    const channel = input.channel?.trim() || 'shadow';
    const appId = input.appId?.trim() || 'h2o';
    const productId = input.productId?.trim() || appId;
    const launcherDecision = this.evaluateReleaseUpdate({
      componentKind: 'platform-critical',
      componentId: 'mx-launcher',
      currentVersion: input.launcherCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.launcherTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const appDecision = this.evaluateReleaseUpdate({
      componentKind: 'app-managed',
      componentId: appId,
      currentVersion: input.appCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.appTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const testRun = this.createTestRun({
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
      : this.recordTestStep(testRun.testRunId, {
          caseId: 'release-gate:e2e',
          status: e2eResult,
          message: `release management E2E gate ${e2eResult}`,
          evidence: {
            releaseId,
            channel,
            source: 'release-management-v1'
          }
        });
    const gate = this.evaluateTestGate({
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
    this.releaseManagementPlans.set(plan.planId, plan);
    this.recordAudit({
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

  getReleaseManagementPlan(planId: string): ReleaseManagementPlan | null {
    return this.releaseManagementPlans.get(planId) ?? null;
  }

  listReleaseManagementPlans(): ReleaseManagementPlan[] {
    return [...this.releaseManagementPlans.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createTestRun(input: TestRunInput): TestRun {
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
    this.testRuns.set(run.testRunId, run);
    this.recordAudit({
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

  getTestRun(runId: string): TestRun | null {
    return this.testRuns.get(runId) ?? null;
  }

  recordTestStep(runId: string, input: TestStepInput): TestRun {
    const run = this.testRuns.get(runId);
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
    this.recordAudit({
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

  evaluateTestGate(input: TestGateInput): TestGateVerdict {
    const runs = input.runIds.map((runId) => this.testRuns.get(runId)).filter((run): run is TestRun => Boolean(run));
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
    this.recordAudit({
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

  runPlatformKernelSmoke(): PlatformKernelSmokeResult {
    const checks: string[] = [];
    const app = required(this.getAppCenterApp('h2o'), 'h2o app is registered');
    checks.push('OK app h2o registered');
    const userCenter = this.bootstrapUserCenter();
    if (!userCenter.roles.some((role) => role.roleId === 'mx-service-account')) {
      throw new Error('User Center bootstrap did not register service-account role');
    }
    checks.push('OK User Center bootstrap registered RBAC records');
    const issuedServiceToken = this.issueUserCenterToken({
      subjectKind: 'service-account',
      subjectId: 'svc_sdk_gateway',
      audience: 'mx-sdk',
      requestId: 'smoke-service-token'
    });
    checks.push('OK User Center issued service token');
    const sdkAccess = this.evaluateSdkGatewayAccess({
      token: issuedServiceToken.token,
      audience: 'mx-sdk',
      routeId: 'sdk.dns.evaluate',
      requestId: 'smoke-sdk-access'
    });
    if (!sdkAccess.allowed) {
      throw new Error('SDK Gateway did not allow service account dns evaluate');
    }
    checks.push('OK SDK Gateway allowed scoped service account');
    const issuedUserToken = this.issueUserCenterToken({
      subjectKind: 'user',
      subjectId: 'usr_demo_user',
      audience: 'mx-sdk',
      requestId: 'smoke-user-token'
    });
    const deniedSdkAccess = this.evaluateSdkGatewayAccess({
      token: issuedUserToken.token,
      audience: 'mx-sdk',
      routeId: 'sdk.audit.write',
      requestId: 'smoke-sdk-denied'
    });
    if (deniedSdkAccess.allowed) {
      throw new Error('SDK Gateway allowed a user without sdk.audit.write');
    }
    checks.push('OK SDK Gateway denied missing scope');
    const smokeHomePublicKey = 'WvN2n3i6LXoJt1qX0lA2uP7cYy4rZs8mQb9dEfGhIjK=';
    const { enrollment } = this.enrollAnonymous({
      productId: 'h2o',
      platform: 'darwin',
      publicKey: smokeHomePublicKey,
      requestId: 'smoke-enroll'
    });
    if (enrollment.publicKey !== smokeHomePublicKey) {
      throw new Error('anonymous enrollment did not preserve Home WG public key');
    }
    checks.push('OK anonymous install enrolled');
    const principalContext = this.resolvePrincipalContext({
      installId: enrollment.installId,
      requestId: 'smoke-principal-context'
    });
    if (principalContext.principal.kind !== 'anonymous' || !principalContext.gateway.canUseSdkGateway) {
      throw new Error('anonymous install principal context was not resolved');
    }
    checks.push('OK User Center principal context resolved');
    const sdkIntrospection = this.introspectToken({
      token: issuedServiceToken.token,
      audience: 'mx-sdk',
      requestId: 'smoke-sdk-introspection'
    });
    if (!sdkIntrospection.active || sdkIntrospection.principal?.kind !== 'service-account') {
      throw new Error('SDK Gateway service token was not accepted');
    }
    checks.push('OK SDK Gateway service token introspected');
    const sdkGateway = this.sdkGatewayManifest();
    if (!sdkGateway.routes.some((route) => route.routeId === 'sdk.identity.introspect')) {
      throw new Error('SDK Gateway manifest did not expose identity introspection');
    }
    checks.push('OK SDK Gateway manifest published');
    const overseaSlotPlan = this.createSiteSlotPlan({
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
      || !overseaPrepareAccess?.commands.some((command) => command.includes('/opt/mx/releases/oversea-access-stack/__release_revision__'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('HY2_EXPORT_BASE_URL=http://oversea.example.com:3434') && command.includes('HY2_EXPORT_USER=download') && command.includes('HY2_EXPORT_PASSWORD_HASH='))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('HY2_MIHOMO_ROUTING_MODE=cn-direct') && command.includes('HY2_RESERVED_INTERNAL_CIDRS=10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16') && command.includes('HY2_DOMESTIC_GATEWAY_IP=10.88.0.1'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('base64 -d') && command.includes('tunnel-state.json'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('reconcile-from-json') && command.includes('--mode hysteria2-only'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('@qpjoy/tunnel-cli') || command.includes('qp-tunnel-cli register'))
      || !overseaPublishSubscription?.commands.some((command) => command.includes('domesticBootstrapSubscription=') && command.includes('/subscriptions/hysteria2/oversea-sg-1-domestic.yaml'))
      || !overseaPublishSubscription?.commands.some((command) => command.includes('internalBootstrapSubscription=') && command.includes('/subscriptions/hysteria2/oversea-sg-1-internal.yaml'))
      || overseaDeployServices?.mode !== 'artifact-push'
      || !overseaDeployServices?.commands.some((command) => command.includes('rsync -az') && command.includes('mx-oversea-services.tar.gz'))
      || !overseaDeployServices?.commands.some((command) => command.includes('/opt/mx/incoming/mx-oversea-services.tar.gz'))
      || !overseaDeployServices?.commands.some((command) => command.includes('/opt/mx/current/oversea') && command.includes('LOCAL_STACK_PATH=/opt/mx/current/hysteria2-access-stack') && command.includes('MX_ACCESS_RUNTIME=hysteria2-only'))
      || overseaDeploymentCommands.some((command) => command.includes('git pull') || command.includes('git clone') || command.includes('./docker/'))
    ) {
      throw new Error('Oversea slot plan did not include access stack');
    }
    checks.push('OK Oversea slot plan generated');
    const overseaAccounts = this.issueSiteSlotAccessAccounts({
      siteId: overseaSlotPlan.siteId,
      publicHost: overseaSlotPlan.host,
      serverPorts: '51288',
      issueDefaults: true,
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-oversea-access-accounts'
    });
    const overseaDomesticSubscription = this.renderHysteria2MihomoSubscription(
      overseaSlotPlan.siteId,
      'oversea-sg-1-domestic'
    );
    if (
      overseaAccounts.site.reachability.domesticWgRelayRequired !== true
      || !overseaAccounts.accounts.some((account) => account.username === 'oversea-sg-1-internal09')
      || !overseaDomesticSubscription?.yaml.includes('type: hysteria2')
      || !overseaDomesticSubscription.yaml.includes('GEOIP,CN,DIRECT')
      || !overseaDomesticSubscription.reachability.h2iRequired
    ) {
      throw new Error('Internal mihomo subscription authority was not issued for Oversea slot');
    }
    checks.push('OK Internal mihomo subscription issued');
    const overseaReachability = this.getLauncherNetworkMihomoReachability(overseaSlotPlan.siteId);
    if (
      overseaReachability?.verdict !== 'h-endpoint-blocked'
      || overseaReachability.currentBoundary !== 'internal-only'
      || !overseaReachability.stages.some((stage) => stage.stageId === 'domestic-wg-relay' && stage.status === 'blocked')
      || !overseaReachability.stages.some((stage) => stage.stageId === 'h2i-internal-dns' && stage.status === 'blocked')
      || !overseaReachability.executionOrder.some((step) => step.includes('Domestic WG/H2I'))
    ) {
      throw new Error('Launcher Network reachability ordering did not preserve Domestic/H2I gates');
    }
    checks.push('OK Launcher Network reachability ordering gated');
    const domesticSlotPlan = this.createSiteSlotPlan({
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
    const domesticRelayAuthority = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'prepare-domestic-relay-authority');
    const domesticResolveSubscription = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'resolve-domestic-bootstrap-subscription');
    const domesticBootstrapEgress = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'bootstrap-domestic-egress');
    const domesticWireGuardInstall = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'install-host-wireguard');
    if (
      domesticSlotPlan.network.mode !== 'oversea-assisted'
      || domesticSlotPlan.network.qpTunnelCliMode !== 'server-on'
      || !domesticSlotPlan.services.hostServices.includes('wg-quick@mx-domestic')
      || !domesticPackageArtifacts?.commands.some((command) => command.includes('qp-tunnel-cli-offline-fallback'))
      || !domesticPackageArtifacts?.commands.some((command) => command.includes('refresh-tunnel-cli latest'))
      || domesticRelayAuthority?.mode !== 'admin-action'
      || !domesticRelayAuthority?.commands.some((command) => command.includes('Domestic WG gateway=10.88.0.1') && command.includes('Internal service peer=10.90.0.10'))
      || !domesticRelayAuthority?.commands.some((command) => command.includes('mx-domestic-wg-relay.conf') && command.includes('10.90.0.0/16'))
      || !domesticRelayAuthority?.commands.some((command) => command.includes('mx-internal-service-peer.conf') && command.includes('never copy the Internal private key to Domestic'))
      || !domesticRelayAuthority?.commands.some((command) => command.includes('Internal has no public ingress'))
      || domesticResolveSubscription?.mode !== 'admin-action'
      || !domesticResolveSubscription?.commands.some((command) => command.includes('domesticBootstrapSubscription'))
      || !domesticResolveSubscription?.commands.some((command) => command.includes('do not ask Domestic to npm install'))
      || domesticBootstrapEgress?.mode !== 'artifact-push'
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('npm i -g @qpjoy/tunnel-cli'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('mx-domestic-qp-tunnel-cli-fallback.tar.gz'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('server-on'))
      || !domesticWireGuardInstall?.commands.some((command) => command.includes('mx-domestic-wg-relay.conf') && command.includes('/etc/wireguard/mx-domestic.conf'))
      || !domesticWireGuardInstall?.commands.some((command) => command.includes('mx-domestic-relay.env'))
      || !domesticWireGuardInstall?.commands.some((command) => command.includes('internal service peer private key must not be copied to Domestic'))
      || domesticWireGuardInstall?.commands.some((command) => command.includes('rsync') && command.includes('mx-internal-service-peer.conf'))
      || domesticBootstrapEgress?.commands.some((command) => command.includes('tun-on'))
    ) {
      throw new Error('Domestic slot plan did not model host WireGuard and Oversea-assisted bootstrap');
    }
    checks.push('OK Domestic slot plan generated');
    const domesticSlotPreflightExecution = this.createSiteSlotExecution({
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
    const domesticSlotApplyExecution = this.createSiteSlotExecution({
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
    const domesticSlotPreflightRunnerSession = this.startSiteSlotRunnerSession({
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
    const domesticSlotRemoteRunnerSession = this.startSiteSlotRunnerSession({
      runId: domesticSlotPreflightExecution.runId,
      mode: 'remote-ssh',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-runner-remote'
    });
    if (
      domesticSlotRemoteRunnerSession.status !== 'blocked'
      || !domesticSlotRemoteRunnerSession.warnings.some((warning) => (
        warning.includes('SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED')
        || warning.includes('remote-ssh requires confirmRemoteExecution=true')
      ))
    ) {
      throw new Error('Domestic slot remote runner session was not blocked by remote execution gate');
    }
    checks.push('OK Domestic slot remote runner gate blocked without confirmation');
    const domesticSlotWorkerJob = this.createSiteSlotWorkerJob({
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
    const domesticSlotWorkerReport = this.recordSiteSlotWorkerReport({
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
    const domesticSlotWorkerJobState = required(this.getSiteSlotWorkerJob(domesticSlotWorkerJob.jobId), 'worker job state exists');
    const domesticSlotPreflightRunnerSessionState = required(this.getSiteSlotRunnerSession(domesticSlotPreflightRunnerSession.sessionId), 'runner session state exists');
    if (domesticSlotWorkerJobState.status !== 'passed' || domesticSlotPreflightRunnerSessionState.status !== 'passed') {
      throw new Error('Worker report did not advance job and runner session to passed');
    }
    checks.push('OK Worker report advanced job/session state to passed');
    const failedRunnerSession = this.startSiteSlotRunnerSession({
      runId: domesticSlotPreflightExecution.runId,
      mode: 'simulate',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-runner-failed-simulate'
    });
    const failedWorkerJob = this.createSiteSlotWorkerJob({
      sessionId: failedRunnerSession.sessionId,
      workerId: 'worker-shadow-domestic-failed',
      workerKind: 'internal-runner',
      rollbackStrategy: 'restore-failed-simulated-state',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-worker-failed-job'
    });
    const domesticSlotFailedWorkerReport = this.recordSiteSlotWorkerReport({
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
    const domesticSlotFailedWorkerJob = required(this.getSiteSlotWorkerJob(failedWorkerJob.jobId), 'failed worker job state exists');
    if (
      domesticSlotFailedWorkerJob.status !== 'failed'
      || domesticSlotFailedWorkerReport.rollbackPlan?.status !== 'planned'
      || domesticSlotFailedWorkerReport.rollbackPlan.strategy !== 'restore-failed-simulated-state'
    ) {
      throw new Error('Failed worker report did not produce rollback plan and failed state');
    }
    checks.push('OK Failed worker report generated rollback plan');
    const domesticSlotFailedRollbackPlan = required(domesticSlotFailedWorkerReport.rollbackPlan, 'failed worker rollback plan exists');
    const domesticSlotRollbackExecution = this.createSiteSlotRollbackExecution({
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
    const domesticSlotRollbackReport = this.recordSiteSlotRollbackReport({
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
      this.getSiteSlotRollbackExecution(domesticSlotRollbackExecution.rollbackExecutionId),
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
    const networkSnapshot = this.createLauncherNetworkSnapshot({
      installId: enrollment.installId,
      deviceId: enrollment.deviceId,
      publicKey: enrollment.publicKey,
      appId: 'h2o',
      requestId: 'smoke-network'
    });
    if (
      networkSnapshot.overlayPolicy.cidr !== '10.91.0.0/16'
      || networkSnapshot.topology.relayPlan.homePeer.publicKey !== smokeHomePublicKey
      || networkSnapshot.topology.relayPlan.homePeer.publicKeyStatus !== 'ready-to-append'
      || networkSnapshot.topology.relayPlan.homePeer.allowedIps[0] !== `${networkSnapshot.overlayPolicy.leaseIp}/32`
      || networkSnapshot.topology.relayPlan.internalServicePeer.privateKeyPlacement !== 'internal-only'
      || networkSnapshot.topology.relayPlan.domesticRelay.configArtifact !== 'mx-domestic-wg-relay.conf'
      || networkSnapshot.topology.relayPlan.routes.subscriptionReachability !== 'domestic-wg-relay+h2i-proxy'
    ) {
      throw new Error('guest network snapshot did not model Domestic relay peer lease');
    }
    checks.push('OK guest network snapshot issued with Domestic relay lease');
    const permissionGrant = this.requestPermission({
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
    const testRun = this.createTestRun({
      suiteId: 'hdo-shadow-e2e',
      productId: 'h2o',
      topology: 'h-d-i-shadow',
      sites: ['domestic-main', 'internal-main'],
      releaseId: 'rel_smoke',
      installId: enrollment.installId,
      deviceId: enrollment.deviceId
    });
    const completedRun = this.recordTestStep(testRun.testRunId, {
      caseId: 'platform-kernel',
      status: 'passed',
      evidence: { source: 'memory-smoke' }
    });
    checks.push('OK e2e test run passed');
    const gate = this.evaluateTestGate({
      gateId: 'gate_platform_kernel',
      releaseId: 'rel_smoke',
      runIds: [completedRun.testRunId]
    });
    if (gate.verdict !== 'passed') {
      throw new Error('release gate did not pass');
    }
    checks.push('OK release gate passed');
    const launcherUpdate = this.evaluateReleaseUpdate({
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
    const h2oUpdate = this.evaluateReleaseUpdate({
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
    const releaseManagementPlan = this.createReleaseManagementPlan({
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
    const dnsPolicy = this.getEffectiveDnsPolicy('h2o');
    checks.push('OK split DNS policy registered');
    const dnsDecision = this.evaluateDnsQuery({
      domain: 'gateway.internal.mx',
      appId: 'h2o',
      installId: enrollment.installId,
      requestId: 'smoke-dns'
    });
    if (dnsDecision.route !== 'internal-dns' || !dnsDecision.reverseProxyRoute) {
      throw new Error('split DNS did not route gateway.internal.mx to Internal reverse proxy');
    }
    checks.push('OK split DNS internal reverse proxy decision');
    const dnsZoneSnapshot = this.buildDnsZoneSnapshot({
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
    const coreDnsSync = this.syncCoreDnsConfigMap({
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
    const configPolicySnapshot = this.createConfigPolicySnapshot({
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

  private latestSiteSlotPlanForSite(siteId: string): SiteSlotPlan | null {
    return [...this.siteSlotPlans.values()]
      .filter((plan) => plan.siteId === siteId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  private allocateGuestLeaseIp(): string {
    const host = this.nextGuestHost;
    this.nextGuestHost += 1;
    return leaseIpFromSequence('10.91', host);
  }

  private allocateUserLeaseIp(): string {
    const host = this.nextUserHost;
    this.nextUserHost += 1;
    return leaseIpFromSequence('10.89', host);
  }

  private registerBuiltinApps(): void {
    for (const app of builtinAppCenterApps()) {
      this.appCatalog.set(app.appId, app);
    }
  }

  private registerBuiltinDns(): void {
    for (const policy of builtinDnsPolicies(this.config)) {
      this.dnsPolicies.set(policy.policyId, policy);
    }
    for (const route of builtinDnsReverseProxyRoutes(this.config)) {
      this.dnsReverseProxyRoutes.set(route.routeId, route);
    }
  }

  private principalForSubject(
    subjectKind: UserCenterTokenRecord['subjectKind'],
    subjectId: string
  ) {
    const roles = this.listUserCenterRoles();
    if (subjectKind === 'user') {
      const user = this.users.get(subjectId);
      return user && user.status === 'active' ? createUserPrincipalFromRecord(user, roles) : null;
    }
    const serviceAccount = this.serviceAccounts.get(subjectId);
    return serviceAccount && serviceAccount.status === 'active'
      ? createServiceAccountPrincipalFromRecord(serviceAccount, roles)
      : null;
  }

  private createSnapshot(
    enrollment: AnonymousEnrollment,
    version: number,
    defaultMode: 'visitor' | 'employee'
  ): ConfigSnapshot {
    return createConfigSnapshot(this.config, enrollment, `cfgsnap_${randomUUID()}`, version, defaultMode);
  }
}

function leaseIpFromSequence(prefix: '10.89' | '10.91', sequence: number): string {
  const capacity = 256 * 254;
  const normalized = ((Math.max(1, Math.floor(sequence)) - 1) % capacity) + 1;
  const thirdOctet = Math.floor((normalized - 1) / 254);
  const fourthOctet = ((normalized - 1) % 254) + 1;
  return `${prefix}.${thirdOctet}.${fourthOctet}`;
}

function resolveIssueAccountNames(input: SiteSlotAccessAccountIssueInput, siteId: string): string[] {
  const requested = Array.isArray(input.accountNames)
    ? input.accountNames
    : typeof input.accountNames === 'string'
      ? input.accountNames.split(',')
      : [];
  const names = (input.issueDefaults === false && requested.length > 0)
    ? requested
    : [...defaultSiteSlotAccessAccountNames(siteId), ...requested];
  return [...new Set(names.map((name) => String(name).trim().toLowerCase()).filter(Boolean))];
}
