import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  advanceLauncherNetworkHandover,
  buildLauncherNetworkHandover,
  launcherNetworkHandoverIsTerminal
} from '../lib/launcher-network-handover.js';
import {
  consumeFixedWindowRateLimit,
  type AuthenticationRateLimitDecision,
  type AuthenticationRateLimitInput,
  type AuthenticationRateLimitState
} from '../lib/auth-rate-limit.js';
import {
  builtinAppCenterApps,
  builtinConfigSecretReferences,
  appReleasePublisherServiceAccountId,
  buildAppOnboardingDefaults,
  buildAppOnboardingTemplates,
  buildAppCenterApp,
  buildAppCenterInstallation,
  builtinLauncherProductNetworks,
  buildLauncherProductNetwork,
  assertLauncherProductLeaseIsolation,
  buildAwxProviderConfig,
  buildConfigSecretReference,
  buildReleaseManagementPlan,
  updateReleaseManagementPlanMetadata,
  buildRuntimeFeaturePolicy,
  buildSecretProviderConfig,
  builtinGatewayRuntimeConfig,
  builtinSecretProviderConfigs,
  buildGatewayRuntimeConfig,
  attachDomesticWireGuardRefreshHint,
  applyLauncherNetworkMihomoSiteArchive,
  buildLauncherNetworkMihomoSite,
  buildLauncherNetworkTopology,
  buildLauncherNetworkReachabilityPlan,
  buildLauncherNetworkLease,
  nextAvailableLauncherNetworkLeaseSequence,
  launcherNetworkLeaseIsActive,
  launcherNetworkLeaseKey,
  launcherNetworkLeaseMatchesProfile,
  launcherNetworkLeaseProfile,
  releaseLauncherNetworkLease,
  buildSiteSlotAccessAccount,
  buildSiteSlotExecutionRun,
  buildSiteSlotPlan,
  buildSiteSlotDomesticRuntimeConfig,
  buildSiteSlotDomesticWireGuardSecret,
  buildSiteSlotInternalServicePeerObservation,
  buildSiteSlotRunnerSession,
  buildSiteSlotSshProfile,
  buildSiteSlotRollbackExecution,
  buildSiteSlotRollbackReport,
  buildSiteSlotWorkerJob,
  buildSiteSlotWorkerReport,
  applySiteSlotRollbackReportState,
  applySiteSlotWorkerReportState,
  buildDnsZoneSnapshot,
  buildDnsReverseProxyRoute,
  buildUserH2oRuntimeProfile,
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
  createUserCenterServiceAccountCredential,
  createUserCenterUserCredential,
  createServiceAccountPrincipalFromRecord,
  createUserCenterServiceAccount,
  createUserCenterTokenRecord,
  createUserCenterUser,
  createUserPrincipalFromRecord,
  evaluateCoreDnsConfigMapApplyGate,
  evaluateGatewayConfigMapApplyGate,
  gatewayRuntimeConfigRequestInput,
  gatewayRuntimeConfigForInput,
  evaluateSdkGatewayRoute,
  emptyUserCredentialSummary,
  evaluateAppCenterAccess,
  appCenterInstallationMatchesQuery,
  evaluateDnsPolicy,
  hashToken,
  isUserOverseaSubscriptionLinkToken,
  USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE,
  USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE,
  USER_OVERSEA_SUBSCRIPTION_LINK_TTL_SECONDS,
  userOverseaSubscriptionLinkPath,
  introspectUserCenterToken,
  introspectShadowToken,
  buildReleaseManagementDecisions,
  normalizeImportUserCenterRow,
  normalizeTestStatus,
  normalizeLauncherNetworkMihomoSite,
  normalizeUpdatePolicy,
  issueUserCenterServiceAccountCredential,
  siteSlotWorkerReportTlsFingerprint,
  releasePolicyByKind,
  renderHysteria2MihomoSubscription,
  renderUserOverseaMihomoSubscription,
  renderCoreDnsConfigMap,
  renderGatewayConfigMap,
  resolvePrincipalContext,
  userCredentialSummary,
  userH2oRuntimeProfileId,
  userCenterDeleteProtectionReason,
  userMatchesLogin,
  userOverseaAccountName,
  userOverseaEntitlementId,
  summarizeUserCenterServiceAccountCredential,
  verifyUserCenterCredential,
  verifyUserCenterServiceAccountSecret,
  required,
  MX_H2I_PRODUCT_ID,
  assertLauncherNetworkLeaseEntitlement,
  launcherNetworkAppIdForLeaseInput,
  launcherNetworkLeaseProductId,
  launcherNetworkProductIsStandaloneDefault,
  launcherNetworkSdkTestModeAllowed,
  normalizeLauncherNetworkProductId
} from './domain.js';
import { applyGatewayNginxConfigToHostRunner } from './host-runner.js';
import { applyCoreDnsConfigMapToKubernetes, applyGatewayConfigMapToKubernetes } from './kubernetes.js';
import type {
  PlatformStore,
  PublisherReleasePlanInput,
  PublisherReleasePlanResult
} from './platform-store.js';
import {
  LEGACY_HDO_ALLOWED_APP_IDS,
  LEGACY_HDO_HOME_APP_ID,
  legacyHdoAdminSeed,
  legacyHdoSeedUserIsComplete,
  legacyHdoUserCenterSeedInput,
  mergeUniqueUserCenterUsers
} from './user-center-seed.js';
import type {
  AnonymousEnrollment,
  AnonymousEnrollmentRequest,
  AppCenterAccessContextInput,
  AppCenterAccessDecision,
  AppCenterAccessInput,
  AppCenterApp,
  AppCenterAppInput,
  AppCenterInstallation,
  AppCenterInstallationInput,
  AppCenterInstallationQuery,
  AppOnboardingDefaults,
  AppOnboardingDefaultsInput,
  AppOnboardingTemplate,
  AuditEvent,
  AuditEventInput,
  AwxProviderConfig,
  AwxProviderConfigInput,
  ConfigPolicySnapshot,
  ConfigPolicySnapshotInput,
  ConfigSecretReference,
  ConfigSecretReferenceInput,
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
  DnsReverseProxyRouteInput,
  DnsZoneSnapshot,
  DnsZoneSnapshotInput,
  FeishuAuthorizationTransaction,
  FeishuAuthorizationTransactionInput,
  GatewayConfigMapApplyInput,
  GatewayConfigMapApplyResult,
  GatewayConfigMapSyncInput,
  GatewayConfigMapSyncResult,
  GatewayRuntimeConfig,
  GatewayRuntimeConfigInput,
  IdentityLinkRequest,
  ImportUserCenterUsersInput,
  ImportUserCenterUsersResult,
  ImportLegacyServiceAccountCredentialInput,
  IssueTokenInput,
  IssueServiceAccountCredentialInput,
  LauncherNetworkHandover,
  LauncherNetworkHandoverAdvanceInput,
  LauncherNetworkHandoverInput,
  LauncherNetworkLease,
  LauncherNetworkLeaseInput,
  LauncherNetworkLeaseReleaseInput,
  LauncherNetworkSnapshot,
  LauncherNetworkSnapshotInput,
  LauncherNetworkMihomoSite,
  LauncherNetworkMihomoSiteInput,
  LauncherNetworkMihomoSiteArchiveInput,
  LauncherNetworkMihomoSiteArchiveResult,
  LauncherNetworkReachabilityPlan,
  LauncherProductNetwork,
  LauncherProductNetworkInput,
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
  ReleaseManagementGateInput,
  ReleaseManagementPlanInput,
  ReleaseManagementPlanPatchInput,
  ReleaseReportInput,
  ReleaseTask,
  RuntimeConfig,
  SecretProviderConfig,
  SecretProviderConfigInput,
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
  SiteSlotDomesticRuntimeConfig,
  SiteSlotDomesticRuntimeConfigInput,
  SiteSlotDomesticWireGuardSecret,
  SiteSlotDomesticWireGuardSecretInput,
  SiteSlotInternalServicePeerObservation,
  SiteSlotInternalServicePeerObservationInput,
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
  UserCenterServiceAccountCredential,
  UserCenterServiceAccountCredentialImportResult,
  UserCenterServiceAccountCredentialStatus,
  UserCenterServiceAccountCredentialVerificationResult,
  UserCenterIssuedServiceAccountCredential,
  UserCenterTenant,
  UserCenterTokenRecord,
  UserCenterUser,
  UserCenterUserDeleteInput,
  UserCenterUserDeleteResult,
  UserCenterUserDeletionTombstone,
  UserCenterUserCredential,
  UserPasswordUpdateInput,
  UserPasswordUpdateResult,
  UserPasswordVerificationInput,
  UserPasswordVerificationResult,
  VerifyServiceAccountCredentialInput,
  UserH2oRuntimeProfile,
  UserH2oRuntimeProfileInput,
  UserOverseaEntitlement,
  UserOverseaEntitlementInput,
  UserOverseaAccountSyncReport,
  UserOverseaAccountSyncReportInput,
  UserOverseaSubscriptionRender,
  TestRun,
  TestRunInput,
  TestStep,
  TestStepInput
} from '../types.js';

const APP_RELEASE_PUBLISHER_SCOPES = ['sdk.release.read', 'sdk.release.publish'];

function configuredLegacyServiceAccountSecrets(): Array<[string, string]> {
  const inline = process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON?.trim();
  const file = process.env.MX_SDK_SERVICE_ACCOUNT_SECRETS_FILE?.trim();
  let raw = inline || '';
  if (!raw && file) {
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).flatMap(([key, value]) => {
      const serviceAccountId = key.trim();
      const clientSecret = typeof value === 'string' ? value.trim() : '';
      return serviceAccountId
        && clientSecret.length >= 32
        && clientSecret.length <= 4096
        && !/[\r\n\0]/.test(clientSecret)
        ? [[serviceAccountId, clientSecret] as [string, string]]
        : [];
    });
  } catch {
    return [];
  }
}

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
  private readonly siteSlotDomesticRuntimeConfigs = new Map<string, SiteSlotDomesticRuntimeConfig>();
  private readonly siteSlotDomesticWireGuardSecrets = new Map<string, SiteSlotDomesticWireGuardSecret>();
  private readonly siteSlotInternalServicePeerObservations = new Map<string, SiteSlotInternalServicePeerObservation>();
  private readonly siteSlotAccessAccounts = new Map<string, SiteSlotAccessAccount>();
  private readonly launcherNetworkMihomoSites = new Map<string, LauncherNetworkMihomoSite>();
  private readonly launcherProductNetworks = new Map<string, LauncherProductNetwork>();
  private readonly launcherNetworkLeases = new Map<string, LauncherNetworkLease>();
  private readonly launcherNetworkHandovers = new Map<string, LauncherNetworkHandover>();
  private launcherNetworkLeaseGeneration = 0;
  private readonly runtimeFeaturePolicies = new Map<string, RuntimeFeaturePolicy>();
  private readonly awxProviderConfigs = new Map<string, AwxProviderConfig>();
  private readonly secretProviderConfigs = new Map<string, SecretProviderConfig>();
  private readonly configSecretReferences = new Map<string, ConfigSecretReference>();
  private readonly appCatalog = new Map<string, AppCenterApp>();
  private readonly appCenterInstallations = new Map<string, AppCenterInstallation>();
  private readonly tenants = new Map<string, UserCenterTenant>();
  private readonly orgs = new Map<string, UserCenterOrg>();
  private readonly roles = new Map<string, UserCenterRole>();
  private readonly users = new Map<string, UserCenterUser>();
  private readonly userCredentials = new Map<string, UserCenterUserCredential>();
  private readonly userDeletionTombstones = new Map<string, UserCenterUserDeletionTombstone>();
  private readonly userH2oRuntimeProfiles = new Map<string, UserH2oRuntimeProfile>();
  private readonly userOverseaEntitlements = new Map<string, UserOverseaEntitlement>();
  private readonly userOverseaAccountSyncReports = new Map<string, UserOverseaAccountSyncReport>();
  private readonly serviceAccounts = new Map<string, UserCenterServiceAccount>();
  private readonly serviceAccountCredentials = new Map<string, UserCenterServiceAccountCredential>();
  private readonly tokens = new Map<string, UserCenterTokenRecord>();
  private readonly feishuAuthorizationTransactions = new Map<string, FeishuAuthorizationTransaction>();
  private readonly authenticationRateLimits = new Map<
    string,
    AuthenticationRateLimitState & { resetAt: string }
  >();
  private readonly dnsPolicies = new Map<string, DnsPolicy>();
  private readonly dnsReverseProxyRoutes = new Map<string, DnsReverseProxyRoute>();
  private readonly dnsZoneSnapshots = new Map<string, DnsZoneSnapshot>();
  private gatewayRuntimeConfig: GatewayRuntimeConfig;
  private readonly coreDnsConfigMapSyncs = new Map<string, CoreDnsConfigMapSyncResult>();
  private readonly coreDnsConfigMapApplies = new Map<string, CoreDnsConfigMapApplyResult>();
  private readonly gatewayConfigMapSyncs = new Map<string, GatewayConfigMapSyncResult>();
  private readonly gatewayConfigMapApplies = new Map<string, GatewayConfigMapApplyResult>();
  private readonly releaseManagementPlans = new Map<string, ReleaseManagementPlan>();
  private readonly permissionGrants = new Map<string, PermissionGrant>();
  private readonly testRuns = new Map<string, TestRun>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly logs: LogEntryInput[] = [];

  constructor(private readonly config: RuntimeConfig) {
    this.gatewayRuntimeConfig = builtinGatewayRuntimeConfig(config);
    this.registerBuiltinApps();
    this.registerBuiltinProductNetworks();
    this.registerBuiltinDns();
    this.registerBuiltinDomesticRuntimeConfigs();
    this.registerBuiltinSecretRegistry();
    this.ensureEnabledAppPublisherServiceAccounts();
  }

  overview() {
    return {
      environment: this.config.environment,
      siteId: this.config.siteId,
      siteRole: this.config.siteRole,
      enabledModules: this.config.enabledModules,
      storeDriver: this.config.storeDriver,
      publicBaseUrl: this.config.publicBaseUrl,
      internalBaseUrl: this.config.internalBaseUrl,
      sites: this.sites.size,
      enrollments: this.enrollments.size,
      snapshots: this.snapshots.size,
      configPolicySnapshots: this.configPolicySnapshots.size,
      secretProviderConfigs: this.secretProviderConfigs.size,
      configSecretReferences: this.configSecretReferences.size,
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
      siteSlotDomesticRuntimeConfigs: this.siteSlotDomesticRuntimeConfigs.size,
      awxProviderConfigs: this.awxProviderConfigs.size,
      dnsPolicies: this.dnsPolicies.size,
      dnsReverseProxyRoutes: this.dnsReverseProxyRoutes.size,
      dnsZoneSnapshots: this.dnsZoneSnapshots.size,
      coreDnsConfigMapSyncs: this.coreDnsConfigMapSyncs.size,
      coreDnsConfigMapApplies: this.coreDnsConfigMapApplies.size,
      gatewayConfigMapSyncs: this.gatewayConfigMapSyncs.size,
      gatewayConfigMapApplies: this.gatewayConfigMapApplies.size,
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
    const kind = (planInput.kind ?? planInput.sshProfile?.kind) === 'oversea' ? 'oversea' : 'domestic';
    const siteId = planInput.siteId?.trim() || planInput.sshProfile?.siteId || `${kind}-main`;
    const domesticRuntimeConfig = kind === 'domestic'
      ? planInput.domesticRuntimeConfig
        ?? this.siteSlotDomesticRuntimeConfigs.get(siteId)
        ?? buildSiteSlotDomesticRuntimeConfig(this.config, { siteId }, null)
      : null;
    const plan = buildSiteSlotPlan(
      this.config,
      { ...planInput, domesticRuntimeConfig },
      `slotplan_${randomUUID()}`
    );
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
    this.applySiteSlotWorkerReportMihomoEvidence(report);
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

  private applySiteSlotWorkerReportMihomoEvidence(report: SiteSlotWorkerReport): void {
    const tlsFingerprint = siteSlotWorkerReportTlsFingerprint(report);
    if (!tlsFingerprint) return;
    const previous = this.getLauncherNetworkMihomoSite(report.siteId);
    if (!previous || previous.tlsFingerprint === tlsFingerprint) return;
    this.upsertLauncherNetworkMihomoSite({
      siteId: report.siteId,
      tlsFingerprint,
      requestedBy: report.workerId,
      requestId: `worker-report:${report.reportId}:tls-fingerprint`
    });
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
    const productId = normalizeLauncherNetworkProductId(input.productId);
    const siteId = input.siteId?.trim() || 'domestic-main';
    const lease = this.enrollLauncherNetworkLease({
      productId,
      mode: launcherNetworkProductIsStandaloneDefault(productId) ? 'standalone' : 'embed',
      identityKind: 'anonymous',
      installId,
      deviceId,
      siteId,
      publicKey: input.publicKey,
      deviceLabel: input.deviceLabel,
      platform: input.platform,
      requestedBy: 'anonymous-enrollment',
      requestId: input.requestId
    });
    const enrollment: AnonymousEnrollment = {
      anonymousPrincipalId: `anon_${randomUUID()}`,
      installId: lease.installId,
      deviceId: lease.deviceId,
      productId: lease.productId,
      siteId: lease.siteId,
      environment: this.config.environment,
      overlayIp: lease.leaseIp,
      relayMode: input.relayMode?.trim() || 'h2i',
      publicKey: lease.publicKey,
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
      installId: enrollment.installId,
      deviceId: enrollment.deviceId,
      productId: enrollment.productId,
      siteId: enrollment.siteId,
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
    const lease = this.enrollLauncherNetworkLease({
      productId: enrollment.productId,
      mode: launcherNetworkProductIsStandaloneDefault(enrollment.productId) ? 'standalone' : 'embed',
      identityKind: 'user',
      installId: enrollment.installId,
      deviceId: enrollment.deviceId,
      siteId: enrollment.siteId,
      userId: input.userId,
      publicKey: enrollment.publicKey,
      requestedBy: 'identity-link',
      requestId: input.requestId
    });
    enrollment.overlayIp = lease.leaseIp;
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
      account: 'admin',
      email: 'admin@mx.local',
      displayName: 'MX Demo Admin',
      password: this.userCredentials.has('usr_demo_admin') ? null : legacyHdoAdminSeed.password,
      roleIds: ['mx-admin'],
      externalIds: {
        legacyUserId: String(legacyHdoAdminSeed.id),
        legacyUserName: legacyHdoAdminSeed.user_name
      },
      homeAppId: LEGACY_HDO_HOME_APP_ID,
      registeredByAppId: LEGACY_HDO_HOME_APP_ID,
      allowedAppIds: LEGACY_HDO_ALLOWED_APP_IDS,
      requestId: 'bootstrap-user-center'
    });
    const user = this.createUserCenterUser({
      userId: 'usr_demo_user',
      account: 'user',
      email: 'user@mx.local',
      displayName: 'MX Demo User',
      password: this.userCredentials.has('usr_demo_user') ? null : 'user-demo-password',
      roleIds: ['mx-user'],
      homeAppId: LEGACY_HDO_HOME_APP_ID,
      registeredByAppId: LEGACY_HDO_HOME_APP_ID,
      allowedAppIds: LEGACY_HDO_ALLOWED_APP_IDS,
      requestId: 'bootstrap-user-center'
    });
    const serviceAccount = this.createUserCenterServiceAccount({
      serviceAccountId: 'svc_sdk_gateway',
      displayName: 'SDK Gateway',
      roleIds: ['mx-service-account'],
      requestId: 'bootstrap-user-center'
    });
    this.importConfiguredLegacyServiceAccountCredentials();
    const legacySeedInput = legacyHdoUserCenterSeedInput();
    const legacyRowsToImport = legacySeedInput.users.flatMap((row) => {
      const seedUserInput = normalizeImportUserCenterRow(row, legacySeedInput);
      const accountKey = seedUserInput.account?.trim().toLowerCase() ?? '';
      if (this.userDeletionTombstones.has(accountKey)) return [];
      const previous = this.findUserCenterUserForInput(seedUserInput);
      const credential = previous ? this.userCredentials.get(previous.userId) ?? null : null;
      if (legacyHdoSeedUserIsComplete(previous, Boolean(credential))) return [];
      return [{ ...row, password: credential ? null : row.password }];
    });
    const legacyImport = legacyRowsToImport.length > 0
      ? this.importUserCenterUsers(legacyHdoUserCenterSeedInput(legacyRowsToImport))
      : null;
    return createBootstrapResult(
      [...this.roles.values()],
      mergeUniqueUserCenterUsers([admin, user, ...(legacyImport?.users ?? [])]),
      [serviceAccount]
    );
  }

  listUserCenterRoles(): UserCenterRole[] {
    return [...this.roles.values()].sort((a, b) => a.roleId.localeCompare(b.roleId));
  }

  listUserCenterUsers(): UserCenterUser[] {
    return [...this.users.values()]
      .map((user) => this.withUserCredentialSummary(user))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  createUserCenterUser(input: CreateUserInput): UserCenterUser {
    const previous = this.findUserCenterUserForInput(input);
    const draft = createUserCenterUser(input, previous, previous?.credential ?? emptyUserCredentialSummary());
    const previousCredential = this.userCredentials.get(draft.userId) ?? null;
    const credential = input.password !== undefined && input.password !== null
      ? createUserCenterUserCredential(draft.userId, input.password, input, previousCredential)
      : previousCredential;
    if (credential) this.userCredentials.set(draft.userId, credential);
    const user = createUserCenterUser(input, previous, userCredentialSummary(credential));
    this.users.set(user.userId, user);
    this.recordAudit({
      eventType: 'iam.user.upserted',
      actorKind: 'user-center',
      userId: user.userId,
      requestId: input.requestId ?? null,
      metadata: {
        account: user.account,
        email: user.email,
        roleIds: user.roleIds,
        status: user.status,
        hasPassword: user.credential.hasPassword
      }
    });
    const siteIds = normalizeEntitlementSiteIds(input.defaultOverseaSiteIds);
    if (input.provisionOversea === true) {
      this.upsertUserOverseaEntitlement({
        userId: user.userId,
        siteIds,
        requestedBy: input.requestedBy ?? 'user-center',
        requestId: input.requestId
      });
    }
    return user;
  }

  importUserCenterUsers(input: ImportUserCenterUsersInput): ImportUserCenterUsersResult {
    const users: UserCenterUser[] = [];
    const entitlements: UserOverseaEntitlement[] = [];
    const failures: ImportUserCenterUsersResult['failures'] = [];
    let imported = 0;
    let updated = 0;
    input.users.forEach((row, index) => {
      const account = typeof row.account === 'string' ? row.account : typeof row.user_name === 'string' ? row.user_name : null;
      try {
        const userInput = normalizeImportUserCenterRow(row, input);
        const previous = this.findUserCenterUserForInput(userInput);
        const user = this.createUserCenterUser(userInput);
        users.push(user);
        if (previous) updated += 1;
        else imported += 1;
        const siteIds = normalizeEntitlementSiteIds(input.defaultOverseaSiteIds);
        if (input.provisionOversea === true) {
          const entitlement = this.getUserOverseaEntitlement(user.userId);
          if (entitlement) entitlements.push(entitlement);
        }
      } catch (error) {
        failures.push({
          index,
          account,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    });
    return {
      imported,
      updated,
      failed: failures.length,
      users,
      entitlements,
      failures,
      generatedAt: new Date().toISOString()
    };
  }

  updateUserCenterPassword(input: UserPasswordUpdateInput): UserPasswordUpdateResult {
    const userId = input.userId?.trim();
    if (!userId) throw new Error('userId is required');
    const user = this.users.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    const password = input.password?.trim();
    if (!password) throw new Error('password is required');
    const now = new Date().toISOString();
    const credential = createUserCenterUserCredential(
      userId,
      password,
      input,
      this.userCredentials.get(userId) ?? null,
      now
    );
    this.userCredentials.set(userId, credential);
    let tokensRevoked = 0;
    for (const [tokenHash, token] of this.tokens.entries()) {
      if (token.subjectKind !== 'user' || token.subjectId !== userId || token.revokedAt) continue;
      this.tokens.set(tokenHash, { ...token, revokedAt: now });
      tokensRevoked += 1;
    }
    const updated = {
      ...user,
      credential: userCredentialSummary(credential),
      updatedAt: now
    };
    this.users.set(userId, updated);
    this.recordAudit({
      eventType: 'iam.user.password.updated',
      actorKind: 'user-center',
      userId,
      requestId: input.requestId ?? null,
      metadata: {
        requestedBy: input.requestedBy ?? 'user-center',
        tokensRevoked
      }
    });
    return { user: updated, tokensRevoked, updatedAt: now };
  }

  deleteUserCenterUser(input: UserCenterUserDeleteInput): UserCenterUserDeleteResult {
    const userId = input.userId?.trim();
    if (!userId) throw new Error('userId is required');
    const user = this.users.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    const protectedReason = userCenterDeleteProtectionReason(user, [...this.users.values()]);
    if (protectedReason) throw new Error(protectedReason);
    const activeLease = [...this.launcherNetworkLeases.values()]
      .find((lease) => lease.userId === userId && launcherNetworkLeaseIsActive(lease));
    if (activeLease) throw new Error(`User has an active launcher network lease: ${activeLease.leaseId}`);
    const linkedEnrollment = [...this.enrollments.values()].find((enrollment) => enrollment.userId === userId);
    if (linkedEnrollment) throw new Error(`User is linked to device enrollment: ${linkedEnrollment.installId}`);
    const entitlement = this.getUserOverseaEntitlement(userId);
    if (entitlement?.status === 'active' || entitlement?.siteIds.length) {
      throw new Error('Disable Oversea access before deleting this user');
    }

    const deletedAt = new Date().toISOString();
    const tombstone: UserCenterUserDeletionTombstone = {
      tombstoneId: user.account.trim().toLowerCase(),
      userId,
      account: user.account,
      deletedAt,
      requestedBy: input.requestedBy ?? 'user-center'
    };
    this.userDeletionTombstones.set(tombstone.tombstoneId, tombstone);
    const deletedRecords: UserCenterUserDeleteResult['deletedRecords'] = {
      credential: this.userCredentials.delete(userId) ? 1 : 0,
      tokens: deleteMapValues(this.tokens, (token) => token.subjectKind === 'user' && token.subjectId === userId),
      overseaEntitlements: this.userOverseaEntitlements.delete(userOverseaEntitlementId(userId)) ? 1 : 0,
      h2oRuntimeProfiles: deleteMapValues(this.userH2oRuntimeProfiles, (profile) => profile.userId === userId),
      appInstallations: deleteMapValues(this.appCenterInstallations, (installation) => installation.userId === userId),
      permissionGrants: deleteMapValues(this.permissionGrants, (grant) => grant.userId === userId)
    };
    this.users.delete(userId);
    this.recordAudit({
      eventType: 'iam.user.deleted',
      actorKind: 'user-center',
      userId,
      requestId: input.requestId ?? null,
      metadata: {
        account: user.account,
        requestedBy: input.requestedBy ?? 'user-center',
        deletedRecords
      }
    });
    return {
      deleted: true,
      userId,
      account: user.account,
      deletedRecords,
      deletedAt
    };
  }

  verifyUserCenterPassword(input: UserPasswordVerificationInput): UserPasswordVerificationResult {
    const userId = input.userId?.trim();
    if (!userId) {
      return { userId: '', ok: false, hasPassword: false, reason: 'userId is required' };
    }
    const credential = this.userCredentials.get(userId) ?? null;
    const hasPassword = Boolean(credential);
    const ok = input.password ? verifyUserCenterCredential(input.password, credential) : false;
    this.recordAudit({
      eventType: ok ? 'auth.password.verified' : 'auth.password.rejected',
      actorKind: 'user',
      userId,
      requestId: input.requestId ?? null,
      metadata: { hasPassword }
    });
    return {
      userId,
      ok,
      hasPassword,
      reason: ok ? 'password accepted' : hasPassword ? 'invalid credentials' : 'password is not configured'
    };
  }

  consumeAuthenticationRateLimits(
    inputs: AuthenticationRateLimitInput[]
  ): AuthenticationRateLimitDecision[] {
    const now = new Date().toISOString();
    const normalizedInputs = inputs.map((input) => ({
      ...input,
      bucketKey: input.bucketKey.trim(),
      now: input.now ?? now
    }));
    const bucketKeys = normalizedInputs.map((input) => input.bucketKey);
    if (new Set(bucketKeys).size !== bucketKeys.length) {
      throw new Error('authentication rate-limit buckets must be unique within one consume operation');
    }
    if (this.authenticationRateLimits.size >= 10_000) {
      const nowMs = Date.parse(now);
      for (const [bucketKey, state] of this.authenticationRateLimits.entries()) {
        if (Date.parse(state.resetAt) <= nowMs) this.authenticationRateLimits.delete(bucketKey);
      }
    }
    const newBucketCount = bucketKeys.filter((bucketKey) => !this.authenticationRateLimits.has(bucketKey)).length;
    const saturated = this.authenticationRateLimits.size + newBucketCount > 10_000;
    const decisions = normalizedInputs.map((input) => {
      const previous = this.authenticationRateLimits.get(input.bucketKey)
        ?? (saturated
          ? {
              windowStartedAt: input.now ?? now,
              count: input.limit,
              resetAt: new Date(Date.parse(input.now ?? now) + input.windowSeconds * 1000).toISOString()
            }
          : null);
      return consumeFixedWindowRateLimit(previous, input);
    });
    for (const [index, input] of normalizedInputs.entries()) {
      const decision = decisions[index];
      if (!decision || (saturated && !this.authenticationRateLimits.has(input.bucketKey))) continue;
      this.authenticationRateLimits.set(input.bucketKey, {
        windowStartedAt: decision.windowStartedAt,
        count: decision.count,
        resetAt: decision.resetAt
      });
    }
    return decisions;
  }

  private findUserCenterUserForInput(input: CreateUserInput): UserCenterUser | null {
    const userId = input.userId?.trim();
    if (userId && this.users.has(userId)) return this.users.get(userId) ?? null;
    const candidates = [input.account, input.username, input.email].filter((value): value is string => typeof value === 'string');
    return [...this.users.values()].find((user) => candidates.some((candidate) => userMatchesLogin(user, candidate))) ?? null;
  }

  private withUserCredentialSummary(user: UserCenterUser): UserCenterUser {
    const credential = this.userCredentials.get(user.userId) ?? null;
    return {
      ...user,
      credential: userCredentialSummary(credential, user.profile.externalIds)
    };
  }

  listUserOverseaEntitlements(): UserOverseaEntitlement[] {
    return [...this.userOverseaEntitlements.values()]
      .map((entitlement) => this.withUserOverseaRuntimeSync(entitlement))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  getUserOverseaEntitlement(userId: string): UserOverseaEntitlement | null {
    const entitlement = this.userOverseaEntitlements.get(userOverseaEntitlementId(userId)) ?? null;
    return entitlement ? this.withUserOverseaRuntimeSync(entitlement) : null;
  }

  private withUserOverseaRuntimeSync(entitlement: UserOverseaEntitlement): UserOverseaEntitlement {
    return {
      ...entitlement,
      accounts: entitlement.accounts.map((account) => {
        const runtimeAccount = this.siteSlotAccessAccounts.get(account.accountId);
        const status = runtimeAccount?.status ?? account.status;
        const accountUpdatedAt = runtimeAccount?.updatedAt ?? account.runtimeSync?.accountUpdatedAt ?? entitlement.updatedAt;
        return {
          ...account,
          status,
          runtimeSync: this.userOverseaAccountRuntimeSync(entitlement.userId, account.siteId, account.username, status, accountUpdatedAt)
        };
      })
    };
  }

  private userOverseaAccountRuntimeSync(
    userId: string,
    siteId: string,
    username: string,
    accountStatus: SiteSlotAccessAccount['status'],
    accountUpdatedAt: string
  ): UserOverseaEntitlement['accounts'][number]['runtimeSync'] {
    const checkedAt = new Date().toISOString();
    const incrementalSync = this.latestUserOverseaAccountSyncReport(userId, siteId, username);
    const fullSyncAt = this.latestOverseaAccountSyncAt(siteId);
    const lastSyncedAt = latestIsoString([incrementalSync?.createdAt ?? null, fullSyncAt]);
    if (accountStatus !== 'active') {
      return {
        status: 'disabled',
        checkedAt,
        accountUpdatedAt,
        lastSyncedAt,
        requiredAction: 'none',
        reason: 'The Internal access account is paused.'
      };
    }
    if (!lastSyncedAt) {
      return {
        status: 'no-runtime-evidence',
        checkedAt,
        accountUpdatedAt,
        lastSyncedAt,
        requiredAction: 'run-user-oversea-remote-sync',
        reason: 'No successful single-account or full configure evidence has been recorded for this Oversea account.'
      };
    }
    const accountUpdatedMs = Date.parse(accountUpdatedAt);
    const incrementalSyncMs = Date.parse(incrementalSync?.createdAt ?? '');
    const fullSyncMs = Date.parse(fullSyncAt ?? '');
    const incrementalSynced = Number.isFinite(incrementalSyncMs) && Number.isFinite(accountUpdatedMs)
      && incrementalSyncMs + 60_000 >= accountUpdatedMs;
    const fullSynced = Number.isFinite(fullSyncMs) && Number.isFinite(accountUpdatedMs)
      && fullSyncMs + 60_000 >= accountUpdatedMs;
    const synced = incrementalSynced || fullSynced;
    return {
      status: synced ? 'synced' : 'pending-sync',
      checkedAt,
      accountUpdatedAt,
      lastSyncedAt,
      requiredAction: synced ? 'none' : 'run-user-oversea-remote-sync',
      reason: synced
        ? (incrementalSynced
          ? 'The latest successful single-account remote sync is newer than this account material.'
          : 'The latest successful Oversea configure evidence is newer than this account material.')
        : 'This account was issued after the latest successful single-account or full configure evidence.'
    };
  }

  private latestUserOverseaAccountSyncReport(userId: string, siteId: string, username: string): UserOverseaAccountSyncReport | null {
    return [...this.userOverseaAccountSyncReports.values()]
      .filter((item) => (
        item.userId === userId
        && item.siteId === siteId
        && item.username === username
        && item.status === 'passed'
      ))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  private latestOverseaAccountSyncAt(siteId: string): string | null {
    const report = [...this.siteSlotWorkerReports.values()]
      .filter((item) => (
        item.siteId === siteId
        && item.stepReports.some((step) => step.status === 'passed' && step.sourceId.startsWith('configure-oversea-access'))
      ))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return report?.createdAt ?? null;
  }

  upsertUserOverseaEntitlement(input: UserOverseaEntitlementInput): UserOverseaEntitlement {
    const userId = input.userId?.trim();
    if (!userId) throw new Error('userId is required');
    const user = this.users.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    const siteIds = normalizeEntitlementSiteIds(input.siteIds);
    const effectiveSiteIds = input.siteIds !== undefined && input.siteIds !== null
      ? siteIds
      : this.defaultUserOverseaSiteIds();
    const previous = this.getUserOverseaEntitlement(user.userId);
    const accounts = effectiveSiteIds.map((siteId) => {
      const accountName = userOverseaAccountName(user, siteId);
      const issued = this.issueSiteSlotAccessAccounts({
        siteId,
        accountNames: [accountName],
        issueDefaults: false,
        requestedBy: input.requestedBy ?? 'user-center',
        requestId: input.requestId
      });
      const account = issued.accounts[0];
      return {
        siteId,
        username: account.username,
        accountId: account.accountId,
        status: account.status,
        subscriptionPath: account.subscriptionPath,
        siteSubscriptionUrl: `${issued.site.subscriptionBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(account.username)}.yaml`,
        runtimeSync: this.userOverseaAccountRuntimeSync(user.userId, account.siteId, account.username, account.status, account.updatedAt)
      };
    });
    const now = new Date().toISOString();
    const entitlement: UserOverseaEntitlement = {
      entitlementId: userOverseaEntitlementId(user.userId),
      userId: user.userId,
      environment: this.config.environment,
      service: 'hysteria2',
      siteIds: effectiveSiteIds,
      accounts,
      status: effectiveSiteIds.length ? 'active' : 'disabled',
      subscriptionPath: `/internal/v1/user-center/users/${encodeURIComponent(user.userId)}/oversea/subscription.yaml`,
      createdBy: previous?.createdBy ?? input.requestedBy ?? 'user-center',
      createdAt: previous?.createdAt ?? now,
      updatedBy: input.requestedBy ?? previous?.updatedBy ?? 'user-center',
      updatedAt: now
    };
    this.userOverseaEntitlements.set(entitlement.entitlementId, entitlement);
    this.recordAudit({
      eventType: 'iam.user_oversea_entitlement.upserted',
      actorKind: 'user-center',
      userId: user.userId,
      requestId: input.requestId ?? null,
      metadata: {
        siteIds: effectiveSiteIds,
        accounts: accounts.map((account) => ({ siteId: account.siteId, username: account.username })),
        status: entitlement.status
      }
    });
    return this.withUserOverseaRuntimeSync(entitlement);
  }

  recordUserOverseaAccountSyncReport(input: UserOverseaAccountSyncReportInput): UserOverseaAccountSyncReport {
    const now = new Date().toISOString();
    const userId = input.userId?.trim();
    const siteId = input.siteId?.trim();
    const accountId = input.accountId?.trim();
    const username = input.username?.trim();
    if (!userId) throw new Error('userId is required');
    if (!siteId) throw new Error('siteId is required');
    if (!accountId) throw new Error('accountId is required');
    if (!username) throw new Error('username is required');
    const status = input.status === 'passed' || input.status === 'failed' || input.status === 'blocked'
      ? input.status
      : 'blocked';
    const report: UserOverseaAccountSyncReport = {
      reportId: `useroverseasync_${randomUUID()}`,
      userId,
      siteId,
      accountId,
      username,
      status,
      exitCode: typeof input.exitCode === 'number' ? input.exitCode : null,
      command: input.command ?? null,
      stdout: input.stdout ?? '',
      stderr: input.stderr ?? '',
      diagnosis: input.diagnosis ?? null,
      requestedBy: input.requestedBy ?? 'user-center',
      requestId: input.requestId ?? null,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? now,
      createdAt: now
    };
    this.userOverseaAccountSyncReports.set(report.reportId, report);
    this.recordAudit({
      eventType: 'iam.user_oversea_account.sync_reported',
      actorKind: 'user-center',
      userId,
      requestId: report.requestId,
      metadata: {
        siteId,
        username,
        status: report.status,
        exitCode: report.exitCode
      }
    });
    return report;
  }

  listUserOverseaAccountSyncReports(userId?: string | null, siteId?: string | null): UserOverseaAccountSyncReport[] {
    return [...this.userOverseaAccountSyncReports.values()]
      .filter((item) => (!userId || item.userId === userId) && (!siteId || item.siteId === siteId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Mirrors the Postgres store; see the comments there for the security rationale. */
  issueUserOverseaSubscriptionLink(
    userId: string,
    options: { requestedBy?: string | null; requestId?: string | null } = {}
  ): { token: string; path: string; record: UserCenterTokenRecord } {
    const user = this.users.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    const revoked = this.revokeUserOverseaSubscriptionLink(userId, { silent: true });
    const token = `mx-v1-${randomBytes(24).toString('base64url')}`;
    const issued = createUserCenterTokenRecord(this.config, {
      subjectKind: 'user',
      subjectId: user.userId,
      audience: USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE,
      scopes: [USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE],
      ttlSeconds: USER_OVERSEA_SUBSCRIPTION_LINK_TTL_SECONDS
    }, token);
    this.tokens.set(issued.record.tokenHash, issued.record);
    this.recordAudit({
      eventType: 'auth.oversea_subscription_link.issued',
      actorKind: 'user',
      userId: user.userId,
      requestId: options.requestId ?? null,
      metadata: { tokenId: issued.record.tokenId, revokedPrevious: revoked, requestedBy: options.requestedBy ?? null }
    });
    return { token, path: userOverseaSubscriptionLinkPath(token), record: issued.record };
  }

  revokeUserOverseaSubscriptionLink(
    userId: string,
    options: { silent?: boolean; requestId?: string | null } = {}
  ): number {
    const now = new Date().toISOString();
    const tokens = [...this.tokens.values()].filter((token) => (
      token.subjectKind === 'user'
      && token.subjectId === userId
      && token.audience === USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE
      && !token.revokedAt
    ));
    for (const token of tokens) {
      this.tokens.set(token.tokenHash, { ...token, revokedAt: now });
    }
    if (tokens.length > 0 && options.silent !== true) {
      this.recordAudit({
        eventType: 'auth.oversea_subscription_link.revoked',
        actorKind: 'user',
        userId,
        requestId: options.requestId ?? null,
        metadata: { revoked: tokens.length }
      });
    }
    return tokens.length;
  }

  describeUserOverseaSubscriptionLink(userId: string): { issuedAt: string; expiresAt: string } | null {
    const token = [...this.tokens.values()]
      .filter((row) => (
        row.subjectKind === 'user'
        && row.subjectId === userId
        && row.audience === USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE
        && !row.revokedAt
        && Date.parse(row.expiresAt) > Date.now()
      ))
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0];
    return token ? { issuedAt: token.issuedAt, expiresAt: token.expiresAt } : null;
  }

  resolveUserOverseaSubscriptionLink(token: string): string | null {
    if (!isUserOverseaSubscriptionLinkToken(token)) return null;
    const record = this.tokens.get(hashToken(token));
    if (!record || record.revokedAt) return null;
    if (record.audience !== USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE) return null;
    if (!record.scopes.includes(USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE)) return null;
    if (record.subjectKind !== 'user') return null;
    if (Date.parse(record.expiresAt) <= Date.now()) return null;
    return record.subjectId;
  }

  renderUserOverseaMihomoSubscription(userId: string): UserOverseaSubscriptionRender | null {
    const user = this.users.get(userId);
    const entitlement = this.getUserOverseaEntitlement(userId);
    if (!user || !entitlement || entitlement.status !== 'active') return null;
    const entries = entitlement.accounts
      .map((accountRef) => {
        const site = this.getLauncherNetworkMihomoSite(accountRef.siteId);
        const account = this.getSiteSlotAccessAccount(accountRef.siteId, accountRef.username);
        return site && account ? { site, account } : null;
      })
      .filter((entry): entry is { site: LauncherNetworkMihomoSite; account: SiteSlotAccessAccount } => Boolean(entry));
    if (!entries.length) return null;
    return renderUserOverseaMihomoSubscription(user, entitlement, entries);
  }

  getUserH2oRuntimeProfile(userId: string, appId = 'h2o'): UserH2oRuntimeProfile | null {
    return this.userH2oRuntimeProfiles.get(userH2oRuntimeProfileId(userId, appId)) ?? null;
  }

  upsertUserH2oRuntimeProfile(input: UserH2oRuntimeProfileInput): UserH2oRuntimeProfile {
    const userId = input.userId?.trim();
    if (!userId || !this.users.has(userId)) throw new Error(`User not found: ${userId || '<missing>'}`);
    const appId = input.appId?.trim() || 'h2o';
    const previous = this.getUserH2oRuntimeProfile(userId, appId);
    const profile = buildUserH2oRuntimeProfile(input, previous);
    this.userH2oRuntimeProfiles.set(profile.profileId, profile);
    this.recordAudit({
      eventType: previous ? 'user.h2o_runtime.updated' : 'user.h2o_runtime.created',
      actorKind: 'user-center',
      userId: profile.userId,
      productId: profile.appId,
      metadata: {
        requestedBy: input.requestedBy?.trim() || 'mx-h2i-h2o',
        subscriptions: profile.subscriptions.length,
        activeSubscriptionId: profile.activeSubscriptionId,
        mode: profile.mode
      }
    });
    return profile;
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
        allowedProductIds: serviceAccount.allowedProductIds ?? [],
        status: serviceAccount.status
      }
    });
    return serviceAccount;
  }

  listUserCenterServiceAccountCredentialStatuses(): UserCenterServiceAccountCredentialStatus[] {
    return [...this.serviceAccountCredentials.values()]
      .map(summarizeUserCenterServiceAccountCredential)
      .sort((a, b) => a.serviceAccountId.localeCompare(b.serviceAccountId));
  }

  getUserCenterServiceAccountCredential(
    serviceAccountId: string
  ): UserCenterServiceAccountCredentialStatus | null {
    const credential = this.serviceAccountCredentials.get(serviceAccountId.trim());
    return credential ? summarizeUserCenterServiceAccountCredential(credential) : null;
  }

  issueUserCenterServiceAccountCredential(
    input: IssueServiceAccountCredentialInput
  ): UserCenterIssuedServiceAccountCredential {
    const serviceAccountId = input.serviceAccountId?.trim() || '';
    const serviceAccount = this.serviceAccounts.get(serviceAccountId);
    if (!serviceAccount) throw new Error(`Service account not found: ${serviceAccountId}`);
    if (serviceAccount.status !== 'active') throw new Error(`Service account is disabled: ${serviceAccountId}`);
    const previous = this.serviceAccountCredentials.get(serviceAccountId) ?? null;
    const result = issueUserCenterServiceAccountCredential(
      input,
      previous
    );
    this.serviceAccountCredentials.set(serviceAccountId, result.credential);
    this.revokeServiceAccountTokens(serviceAccountId);
    this.recordAudit({
      eventType: 'iam.service_account.credential.issued',
      actorKind: 'user-center',
      requestId: input.requestId ?? null,
      metadata: {
        serviceAccountId,
        credentialId: result.credential.credentialId,
        version: result.credential.version,
        rotated: result.credential.version > 1,
        requestedBy: input.requestedBy?.trim() || 'user-center'
      }
    });
    return result.issued;
  }

  verifyUserCenterServiceAccountCredential(
    input: VerifyServiceAccountCredentialInput
  ): UserCenterServiceAccountCredentialVerificationResult {
    const serviceAccountId = input.serviceAccountId?.trim() || '';
    const serviceAccount = this.serviceAccounts.get(serviceAccountId);
    if (!serviceAccount) {
      return { serviceAccountId, ok: false, reason: 'service-account-not-found' };
    }
    if (serviceAccount.status !== 'active') {
      return { serviceAccountId, ok: false, reason: 'service-account-disabled' };
    }
    const credential = this.serviceAccountCredentials.get(serviceAccountId) ?? null;
    if (!credential) {
      return { serviceAccountId, ok: false, reason: 'credential-not-found' };
    }
    const ok = verifyUserCenterServiceAccountSecret(input.clientSecret ?? '', credential);
    return {
      serviceAccountId,
      ok,
      reason: ok ? 'accepted' : 'invalid-secret',
      credentialVersion: credential.version
    };
  }

  importLegacyUserCenterServiceAccountCredential(
    input: ImportLegacyServiceAccountCredentialInput
  ): UserCenterServiceAccountCredentialImportResult {
    const serviceAccountId = input.serviceAccountId?.trim() || '';
    const clientSecret = input.clientSecret ?? '';
    const serviceAccount = this.serviceAccounts.get(serviceAccountId);
    if (!serviceAccount) throw new Error(`Service account not found: ${serviceAccountId}`);
    if (serviceAccount.status !== 'active') {
      throw new Error(`Service account is disabled: ${serviceAccountId}`);
    }
    const previous = this.serviceAccountCredentials.get(serviceAccountId) ?? null;
    if (previous) {
      return {
        outcome: 'preserved',
        credential: summarizeUserCenterServiceAccountCredential(previous)
      };
    }
    const credential = createUserCenterServiceAccountCredential(
      serviceAccountId,
      clientSecret,
      {
        requestedBy: input.requestedBy?.trim() || 'legacy-secret-import',
        source: 'legacy-import'
      }
    );
    this.serviceAccountCredentials.set(serviceAccountId, credential);
    this.recordAudit({
      eventType: 'iam.service_account.credential.imported',
      actorKind: 'user-center',
      requestId: input.requestId ?? null,
      metadata: {
        serviceAccountId,
        credentialId: credential.credentialId,
        version: credential.version
      }
    });
    return {
      outcome: 'imported',
      credential: summarizeUserCenterServiceAccountCredential(credential)
    };
  }

  issueUserCenterToken(input: IssueTokenInput): UserCenterIssuedToken {
    const credential = input.subjectKind === 'service-account'
      ? this.serviceAccountCredentials.get(input.subjectId) ?? null
      : null;
    if (
      input.subjectKind === 'service-account'
      && Number.isInteger(input.serviceAccountCredentialVersion)
      && (credential?.version ?? 0) !== input.serviceAccountCredentialVersion
    ) {
      throw new Error('Service account credential changed during authentication');
    }
    if (
      input.subjectKind === 'service-account'
      && input.serviceAccountClientSecret
      && !verifyUserCenterServiceAccountSecret(
        input.serviceAccountClientSecret,
        credential
      )
    ) {
      throw new Error('Service account credential changed during authentication');
    }
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
        authProvider: issued.record.authProvider ?? null,
        expiresAt: issued.record.expiresAt
      }
    });
    return issued;
  }

  createFeishuAuthorizationTransaction(
    input: FeishuAuthorizationTransactionInput
  ): FeishuAuthorizationTransaction {
    const now = Date.now();
    for (const [transactionId, transaction] of this.feishuAuthorizationTransactions.entries()) {
      if (Date.parse(transaction.expiresAt) <= now) {
        this.feishuAuthorizationTransactions.delete(transactionId);
      }
    }
    if (this.feishuAuthorizationTransactions.has(input.transactionId)) {
      throw new Error('Feishu authorization transaction already exists');
    }
    const transaction = { ...input };
    this.feishuAuthorizationTransactions.set(transaction.transactionId, transaction);
    return transaction;
  }

  consumeFeishuAuthorizationTransaction(
    transactionId: string
  ): FeishuAuthorizationTransaction | null {
    const transaction = this.feishuAuthorizationTransactions.get(transactionId) ?? null;
    if (!transaction) return null;
    if (Date.parse(transaction.expiresAt) <= Date.now()) {
      this.feishuAuthorizationTransactions.delete(transactionId);
      return null;
    }
    if (transaction.consumedAt) return { ...transaction };
    this.feishuAuthorizationTransactions.set(transactionId, {
      ...transaction,
      consumedAt: new Date().toISOString()
    });
    return transaction;
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
    const routeDecision = evaluateSdkGatewayRoute(introspection.principal, input.routeId);
    const appAccess = input.appId
      ? this.evaluateAppCenterAccess({
        appId: input.appId,
        userId: introspection.principal?.userId,
        sourceAppId: input.sourceAppId,
        includeHidden: true,
        includeDisabled: false,
        requestId: input.requestId
      })
      : null;
    const decision: SdkGatewayAccessDecision = appAccess && !appAccess.allowed
      ? {
        ...routeDecision,
        allowed: false,
        appAccess,
        reason: `SDK route scope accepted but app access denied: ${appAccess.reason}`
      }
      : { ...routeDecision, appAccess };
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
        appId: input.appId ?? null,
        appAccessAllowed: appAccess?.allowed ?? null,
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
    const appAccess = this.evaluateAppCenterAccess({
      appId,
      userId: principalContext.principal.userId ?? enrollment?.userId ?? input.userId ?? null,
      sourceAppId: input.sourceAppId,
      includeHidden: true,
      includeDisabled: false,
      requestId: input.requestId
    });
    const launcherNetwork = this.createLauncherNetworkSnapshot({
      installId: enrollment?.installId ?? input.installId ?? undefined,
      deviceId: enrollment?.deviceId ?? input.deviceId ?? undefined,
      siteId: enrollment?.siteId ?? undefined,
      userId: principalContext.principal.userId ?? enrollment?.userId ?? input.userId ?? null,
      publicKey: enrollment?.publicKey ?? null,
      appId: enrollment?.productId ?? appId,
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
      app: appAccess.allowed ? app : null,
      appAccess,
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

  listSecretProviderConfigs(): SecretProviderConfig[] {
    return [...this.secretProviderConfigs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSecretProviderConfig(providerId: string): SecretProviderConfig | null {
    return this.secretProviderConfigs.get(providerId) ?? null;
  }

  upsertSecretProviderConfig(input: SecretProviderConfigInput): SecretProviderConfig {
    const previous = input.providerId ? this.secretProviderConfigs.get(input.providerId) ?? null : null;
    const provider = buildSecretProviderConfig(this.config, input, previous);
    this.secretProviderConfigs.set(provider.providerId, provider);
    this.recordAudit({
      eventType: 'config.secret_provider.upserted',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        providerId: provider.providerId,
        kind: provider.kind,
        status: provider.status,
        authMode: provider.authMode,
        region: provider.region,
        warnings: provider.warnings
      }
    });
    return provider;
  }

  listConfigSecretReferences(): ConfigSecretReference[] {
    return [...this.configSecretReferences.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getConfigSecretReference(secretRefId: string): ConfigSecretReference | null {
    return this.configSecretReferences.get(secretRefId) ?? null;
  }

  upsertConfigSecretReference(input: ConfigSecretReferenceInput): ConfigSecretReference {
    const previous = input.secretRefId ? this.configSecretReferences.get(input.secretRefId) ?? null : null;
    const providerId = input.providerId?.trim() || previous?.providerId || '';
    const reference = buildConfigSecretReference(
      this.config,
      input,
      previous,
      this.secretProviderConfigs.has(providerId)
    );
    this.configSecretReferences.set(reference.secretRefId, reference);
    this.recordAudit({
      eventType: 'config.secret_reference.upserted',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      productId: reference.productId,
      metadata: {
        secretRefId: reference.secretRefId,
        providerId: reference.providerId,
        remoteRef: reference.remoteRef,
        appId: reference.appId,
        consumerIds: reference.consumerIds,
        exposure: reference.exposure,
        versionStage: reference.versionStage,
        target: reference.target,
        containsSecretMaterial: false,
        warnings: reference.warnings
      }
    });
    return reference;
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

  listSiteSlotDomesticRuntimeConfigs(): SiteSlotDomesticRuntimeConfig[] {
    return [...this.siteSlotDomesticRuntimeConfigs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSiteSlotDomesticRuntimeConfig(siteId: string): SiteSlotDomesticRuntimeConfig | null {
    return this.siteSlotDomesticRuntimeConfigs.get(siteId) ?? null;
  }

  upsertSiteSlotDomesticRuntimeConfig(input: SiteSlotDomesticRuntimeConfigInput): SiteSlotDomesticRuntimeConfig {
    const siteId = input.siteId?.trim() || 'domestic-main';
    const previous = this.siteSlotDomesticRuntimeConfigs.get(siteId) ?? null;
    const config = buildSiteSlotDomesticRuntimeConfig(this.config, input, previous);
    this.siteSlotDomesticRuntimeConfigs.set(config.siteId, config);
    this.recordAudit({
      eventType: 'config.domestic_runtime_config.upserted',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        configId: config.configId,
        siteId: config.siteId,
        status: config.status,
        edge: config.edge,
        upstreams: config.upstreams,
        dns: config.dns,
        warnings: config.warnings,
        configDigest: config.fingerprints.configDigest
      }
    });
    return config;
  }

  listSiteSlotDomesticWireGuardSecrets(): SiteSlotDomesticWireGuardSecret[] {
    return [...this.siteSlotDomesticWireGuardSecrets.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSiteSlotDomesticWireGuardSecret(siteId: string): SiteSlotDomesticWireGuardSecret | null {
    return this.siteSlotDomesticWireGuardSecrets.get(siteId) ?? null;
  }

  upsertSiteSlotDomesticWireGuardSecret(input: SiteSlotDomesticWireGuardSecretInput): SiteSlotDomesticWireGuardSecret {
    const siteId = input.siteId?.trim() || 'domestic-main';
    const previous = this.siteSlotDomesticWireGuardSecrets.get(siteId) ?? null;
    const secret = buildSiteSlotDomesticWireGuardSecret(this.config, input, previous);
    this.siteSlotDomesticWireGuardSecrets.set(secret.siteId, secret);
    this.recordAudit({
      eventType: 'config.domestic_wg_secret.upserted',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        secretId: secret.secretId,
        siteId: secret.siteId,
        status: secret.status,
        secretMaterial: secret.readiness.secretMaterial,
        publicEndpointStatus: secret.readiness.publicEndpointStatus,
        missingSecretInputs: secret.readiness.missingSecretInputs,
        fingerprints: secret.fingerprints
      }
    });
    return secret;
  }

  listSiteSlotInternalServicePeerObservations(planId?: string | null): SiteSlotInternalServicePeerObservation[] {
    return [...this.siteSlotInternalServicePeerObservations.values()]
      .filter((observation) => !planId || observation.planId === planId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  getSiteSlotInternalServicePeerObservation(planId: string): SiteSlotInternalServicePeerObservation | null {
    return this.siteSlotInternalServicePeerObservations.get(planId) ?? null;
  }

  upsertSiteSlotInternalServicePeerObservation(
    input: SiteSlotInternalServicePeerObservationInput
  ): SiteSlotInternalServicePeerObservation {
    const observation = buildSiteSlotInternalServicePeerObservation(input);
    const previous = this.siteSlotInternalServicePeerObservations.get(observation.planId) ?? null;
    if (
      previous?.checkedAt
      && (!observation.checkedAt || observation.checkedAt.localeCompare(previous.checkedAt) < 0)
    ) {
      return previous;
    }
    this.siteSlotInternalServicePeerObservations.set(observation.planId, observation);
    this.recordAudit({
      eventType: 'site_slot.internal_service_peer.observed',
      actorKind: 'admin-action',
      siteId: observation.siteId,
      requestId: null,
      metadata: { ...observation }
    });
    return observation;
  }

  issueSiteSlotAccessAccounts(input: SiteSlotAccessAccountIssueInput): SiteSlotAccessAccountIssueResult {
    const siteId = input.siteId?.trim() || 'oversea-main';
    const site = this.upsertLauncherNetworkMihomoSite({
      siteId,
      publicHost: input.publicHost,
      serverPorts: input.serverPorts,
      tlsFingerprint: input.tlsFingerprint,
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

  archiveLauncherNetworkMihomoSite(
    input: LauncherNetworkMihomoSiteArchiveInput
  ): LauncherNetworkMihomoSiteArchiveResult {
    const siteId = input.siteId?.trim();
    if (!siteId) throw new Error('siteId is required');
    const previous = this.launcherNetworkMihomoSites.get(siteId) ?? null;
    if (!previous) throw new Error(`Launcher Network mihomo site not found: ${siteId}`);
    const requestedBy = input.requestedBy?.trim() || 'internal';
    const now = new Date().toISOString();
    const site = applyLauncherNetworkMihomoSiteArchive(previous, input.archived, requestedBy, now);
    this.launcherNetworkMihomoSites.set(site.siteId, site);

    // Pausing the accounts is what removes this node from every user's
    // subscription: the renderer only emits proxies for active accounts.
    const nextStatus = input.archived ? 'paused' : 'active';
    const changed: SiteSlotAccessAccount[] = [];
    for (const account of this.listSiteSlotAccessAccounts(siteId)) {
      if (account.status === nextStatus) continue;
      const updated: SiteSlotAccessAccount = { ...account, status: nextStatus, updatedBy: requestedBy, updatedAt: now };
      this.siteSlotAccessAccounts.set(updated.accountId, updated);
      changed.push(updated);
    }

    const affectedUserIds = [...new Set(this.listUserOverseaEntitlements()
      .filter((entitlement) => entitlement.siteIds.includes(siteId))
      .map((entitlement) => entitlement.userId))];

    this.recordAudit({
      eventType: input.archived
        ? 'launcher_network.mihomo_site.archived'
        : 'launcher_network.mihomo_site.unarchived',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: { siteId: site.siteId, archivedBy: requestedBy, accountsChanged: changed.length, affectedUserIds }
    });

    return {
      site,
      pausedAccounts: input.archived ? changed : [],
      reactivatedAccounts: input.archived ? [] : changed,
      affectedUserIds
    };
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
    const site = this.launcherNetworkMihomoSites.get(siteId) ?? null;
    return site ? normalizeLauncherNetworkMihomoSite(site) : null;
  }

  getLauncherNetworkMihomoReachability(siteId: string): LauncherNetworkReachabilityPlan | null {
    const site = this.getLauncherNetworkMihomoSite(siteId);
    if (!site) return null;
    return buildLauncherNetworkReachabilityPlan(site, this.listSiteSlotAccessAccounts(siteId));
  }

  listLauncherProductNetworks(): LauncherProductNetwork[] {
    return [...this.launcherProductNetworks.values()]
      .sort((a, b) => a.mode.localeCompare(b.mode) || a.productIndex - b.productIndex || a.productId.localeCompare(b.productId));
  }

  getLauncherProductNetwork(productId: string): LauncherProductNetwork | null {
    const normalized = productId.trim().toLowerCase();
    return this.launcherProductNetworks.get(normalized) ?? null;
  }

  upsertLauncherProductNetwork(input: LauncherProductNetworkInput): LauncherProductNetwork {
    const previous = input.productId ? this.getLauncherProductNetwork(input.productId) : null;
    const product = buildLauncherProductNetwork(this.config, input, previous);
    assertLauncherProductLeaseIsolation(product, this.listLauncherProductNetworks());
    if (product.mode === 'embed') {
      const channel = this.getLauncherProductNetwork(product.standaloneChannelProductId);
      if (!channel || channel.mode !== 'standalone' || !channel.enabled) {
        throw new Error(`Embed product ${product.productId} requires an enabled launcher standalone channel: ${product.standaloneChannelProductId}`);
      }
    }
    this.launcherProductNetworks.set(product.productId, product);
    this.recordAudit({
      eventType: 'launcher_network.product_network.upserted',
      actorKind: 'config-center',
      productId: product.productId,
      requestId: input.requestId ?? null,
      metadata: {
        mode: product.mode,
        networkScope: product.networkScope,
        standaloneChannelProductId: product.standaloneChannelProductId,
        serviceVip: product.serviceVip,
        internalControlIp: product.internalControlIp,
        domesticGatewayIp: product.domesticGatewayIp,
        dnsServer: product.dnsServer,
        userCidr: product.userCidr,
        feishuCidr: product.feishuCidr,
        anonymousCidr: product.anonymousCidr,
        userLeaseRange: [product.userLeaseStart, product.userLeaseEnd],
        feishuLeaseRange: [product.feishuLeaseStart, product.feishuLeaseEnd],
        anonymousLeaseRange: [product.anonymousLeaseStart, product.anonymousLeaseEnd],
        updatePolicy: product.updatePolicy
      }
    });
    return product;
  }

  listLauncherNetworkLeases(productId?: string | null): LauncherNetworkLease[] {
    const normalizedProductId = productId?.trim().toLowerCase() || null;
    return [...this.launcherNetworkLeases.values()]
      .filter((lease) => !normalizedProductId || lease.productId === normalizedProductId)
      .sort((a, b) => a.productId.localeCompare(b.productId) || a.identityKind.localeCompare(b.identityKind) || a.sequence - b.sequence);
  }

  getLauncherNetworkLease(leaseId: string): LauncherNetworkLease | null {
    return this.launcherNetworkLeases.get(leaseId.trim()) ?? null;
  }

  listLauncherNetworkHandovers(): LauncherNetworkHandover[] {
    return [...this.launcherNetworkHandovers.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getLauncherNetworkHandover(transitionId: string): LauncherNetworkHandover | null {
    return this.launcherNetworkHandovers.get(transitionId.trim()) ?? null;
  }

  createLauncherNetworkHandover(input: LauncherNetworkHandoverInput): LauncherNetworkHandover {
    if (this.launcherNetworkHandovers.has(input.transitionId)) {
      throw new Error('Launcher network handover transition already exists');
    }
    const conflicting = [...this.launcherNetworkHandovers.values()].find((handover) => (
      !launcherNetworkHandoverIsTerminal(handover)
      && handover.productId === input.productId
      && handover.installId === input.installId
      && handover.deviceId === input.deviceId
      && handover.publicKey === input.publicKey
    ));
    if (conflicting) {
      throw new Error(`Launcher network handover is already active: ${conflicting.transitionId}`);
    }
    const handover = buildLauncherNetworkHandover(this.config.environment, input);
    this.launcherNetworkHandovers.set(handover.transitionId, handover);
    return handover;
  }

  advanceLauncherNetworkHandover(
    input: LauncherNetworkHandoverAdvanceInput
  ): LauncherNetworkHandover {
    const existing = this.getLauncherNetworkHandover(input.transitionId);
    if (!existing) throw new Error('Launcher network handover transition not found');
    const handover = advanceLauncherNetworkHandover(existing, input);
    this.launcherNetworkHandovers.set(handover.transitionId, handover);
    return handover;
  }

  enrollLauncherNetworkLease(input: LauncherNetworkLeaseInput): LauncherNetworkLease {
    const installId = input.installId?.trim() || `inst_${randomUUID()}`;
    const deviceId = input.deviceId?.trim() || `dev_${randomUUID()}`;
    const requestedProductId = normalizeLauncherNetworkProductId(input.productId);
    const sdkTestMode = launcherNetworkSdkTestModeAllowed(this.config, input);
    const storedRequestedProduct = this.getLauncherProductNetwork(requestedProductId);
    if (!storedRequestedProduct && !sdkTestMode) {
      throw new Error(`Launcher product ${requestedProductId} is not registered`);
    }
    const requestedProduct = storedRequestedProduct
      ?? buildLauncherProductNetwork(this.config, {
        productId: requestedProductId,
        mode: input.mode ?? (launcherNetworkProductIsStandaloneDefault(requestedProductId) ? 'standalone' : 'embed')
      }, null);
    const productId = launcherNetworkLeaseProductId(
      requestedProduct.mode === 'standalone' ? requestedProduct.productId : requestedProduct.standaloneChannelProductId
    );
    const storedProduct = this.getLauncherProductNetwork(productId);
    if (!storedProduct && !sdkTestMode) {
      throw new Error(`Launcher standalone channel ${productId} is not registered`);
    }
    const product = storedProduct
      ?? buildLauncherProductNetwork(this.config, { productId, mode: 'standalone' }, null);
    if (!sdkTestMode) {
      const appId = launcherNetworkAppIdForLeaseInput(input, requestedProduct);
      const app = this.getAppCenterApp(appId);
      assertLauncherNetworkLeaseEntitlement(input, requestedProduct, product, app);
    }
    const identityKind = input.identityKind === 'user' || input.userId?.trim() ? 'user' : 'anonymous';
    const leaseProfile = launcherNetworkLeaseProfile(input.leaseProfile, identityKind);
    const normalizedInput: LauncherNetworkLeaseInput = {
      ...input,
      appId: input.appId || requestedProduct.productId,
      productId: product.productId,
      mode: product.mode,
      identityKind,
      leaseProfile,
      installId,
      deviceId
    };
    const leaseKey = launcherNetworkLeaseKey(normalizedInput, product);
    const now = new Date();
    const allLeases = [...this.launcherNetworkLeases.values()];
    const leases = allLeases.filter((lease) => lease.productId === product.productId);
    const legacyCapabilityClaimLeaseIds = [...new Set(
      normalizedInput.legacyCapabilityClaimLeaseIds?.map((leaseId) => leaseId.trim()).filter(Boolean) ?? []
    )];
    for (const leaseId of legacyCapabilityClaimLeaseIds) {
      const legacyLease = allLeases.find((lease) => lease.leaseId === leaseId);
      if (
        !legacyLease
        || !launcherNetworkLeaseIsActive(legacyLease, now)
        || Boolean(legacyLease.capabilityDigest?.trim())
        || legacyLease.productId !== product.productId
        || legacyLease.installId !== installId
        || legacyLease.deviceId !== deviceId
        || legacyLease.publicKey !== normalizedInput.publicKey?.trim()
        || (legacyLease.identityKind === 'user' && legacyLease.userId !== normalizedInput.userId)
        || !normalizedInput.capabilityDigest?.trim()
        || !normalizedInput.capabilityVersion
        || !normalizedInput.capabilityExpiresAt?.trim()
      ) {
        throw new Error('Legacy launcher lease capability claim no longer matches this authenticated device');
      }
      const claimedLease: LauncherNetworkLease = {
        ...legacyLease,
        capabilityDigest: normalizedInput.capabilityDigest,
        capabilityVersion: normalizedInput.capabilityVersion,
        capabilityExpiresAt: normalizedInput.capabilityExpiresAt,
        updatedBy: normalizedInput.requestedBy?.trim() || 'launcher-network-legacy-capability-claim',
        updatedAt: new Date().toISOString()
      };
      this.launcherNetworkLeases.set(claimedLease.leaseId, claimedLease);
      const allIndex = allLeases.findIndex((lease) => lease.leaseId === claimedLease.leaseId);
      if (allIndex >= 0) allLeases[allIndex] = claimedLease;
      const productIndex = leases.findIndex((lease) => lease.leaseId === claimedLease.leaseId);
      if (productIndex >= 0) leases[productIndex] = claimedLease;
    }
    const publicKeyConflict = normalizedInput.publicKey?.trim()
      ? allLeases.find((lease) => (
          launcherNetworkLeaseIsActive(lease, now)
          && lease.publicKey === normalizedInput.publicKey?.trim()
          && (
            lease.productId !== product.productId
            || lease.installId !== installId
            || lease.deviceId !== deviceId
          )
        ))
      : null;
    if (publicKeyConflict) {
      throw new Error(`WireGuard publicKey is already owned by ${publicKeyConflict.installId}/${publicKeyConflict.deviceId}`);
    }
    const previous = leases.find((lease) => (
      launcherNetworkLeaseIsActive(lease, now)
      && launcherNetworkLeaseProfile(lease.leaseProfile, lease.identityKind) === leaseProfile
      && launcherNetworkLeaseMatchesProfile(product, leaseProfile, lease)
      && (
        lease.leaseKey === leaseKey
        || (
          !lease.leaseProfile
          && lease.identityKind === identityKind
          && lease.installId === installId
          && (identityKind === 'anonymous' || lease.userId === normalizedInput.userId)
        )
      )
    )) ?? null;
    if (
      previous?.publicKey
      && normalizedInput.publicKey?.trim()
      && previous.publicKey !== normalizedInput.publicKey.trim()
    ) {
      throw new Error('Launcher lease public key rotation requires a separate migration');
    }
    const sequence = previous?.sequence ?? nextAvailableLauncherNetworkLeaseSequence(
      product,
      leaseProfile,
      leases,
      now
    );
    this.launcherNetworkLeaseGeneration = Math.max(
      this.launcherNetworkLeaseGeneration,
      ...leases.map((lease) => Number(lease.generation) || 0)
    ) + 1;
    const lease = buildLauncherNetworkLease(
      this.config,
      { ...normalizedInput, generation: this.launcherNetworkLeaseGeneration },
      product,
      sequence,
      previous
    );
    this.launcherNetworkLeases.set(lease.leaseId, lease);
    this.recordAudit({
      eventType: previous ? 'launcher_network.lease.refreshed' : 'launcher_network.lease.enrolled',
      actorKind: lease.identityKind === 'user' ? 'user' : 'install',
      userId: lease.userId,
      installId: lease.installId,
      deviceId: lease.deviceId,
      productId: lease.productId,
      siteId: lease.siteId,
      requestId: input.requestId ?? null,
      overlayIp: lease.leaseIp,
      metadata: {
        leaseId: lease.leaseId,
        launcherMode: lease.launcherMode,
        identityKind: lease.identityKind,
        leaseProfile: lease.leaseProfile,
        cidr: lease.cidr,
        serviceVip: lease.serviceVip,
        requestedProductId: requestedProduct.productId,
        appId: normalizedInput.appId,
        deviceLabel: lease.deviceLabel,
        platform: lease.platform,
        deviceModel: lease.deviceModel,
        osVersion: lease.osVersion,
        appVersion: lease.appVersion,
        sdkTestMode
      }
    });
    return lease;
  }

  releaseLauncherNetworkLease(leaseId: string, input: LauncherNetworkLeaseReleaseInput = {}): LauncherNetworkLease {
    const lease = this.getLauncherNetworkLease(leaseId);
    if (!lease) throw new Error('Launcher network lease not found');
    const released = releaseLauncherNetworkLease(lease, input);
    this.launcherNetworkLeases.set(released.leaseId, released);
    this.recordAudit({
      eventType: 'launcher_network.lease.released',
      actorKind: released.identityKind === 'user' ? 'user' : 'install',
      userId: released.userId,
      installId: released.installId,
      deviceId: released.deviceId,
      productId: released.productId,
      siteId: released.siteId,
      requestId: input.requestId ?? null,
      overlayIp: released.leaseIp,
      metadata: {
        leaseId: released.leaseId,
        launcherMode: released.launcherMode,
        identityKind: released.identityKind,
        leaseProfile: released.leaseProfile,
        deviceLabel: released.deviceLabel,
        platform: released.platform,
        deviceModel: released.deviceModel,
        osVersion: released.osVersion,
        appVersion: released.appVersion,
        status: released.status,
        releasedAt: released.releasedAt
      }
    });
    return released;
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

  listAppOnboardingTemplates(): AppOnboardingTemplate[] {
    return buildAppOnboardingTemplates();
  }

  getAppOnboardingDefaults(input: AppOnboardingDefaultsInput): AppOnboardingDefaults {
    return buildAppOnboardingDefaults(
      this.config,
      input,
      this.listLauncherProductNetworks(),
      this.listDnsReverseProxyRoutes()
    );
  }

  listAppCenterApps(input: AppCenterAccessContextInput = {}): AppCenterApp[] {
    const apps = [...this.appCatalog.values()].sort((a, b) => a.appId.localeCompare(b.appId));
    if (!input.userId && !input.sourceAppId && input.includeHidden !== false && input.includeDisabled !== false) {
      return apps;
    }
    return apps.filter((app) => this.evaluateAppCenterAccess({
      ...input,
      appId: app.appId
    }).visible);
  }

  evaluateAppCenterAccess(input: AppCenterAccessInput): AppCenterAccessDecision {
    const app = this.getAppCenterApp(input.appId);
    const user = input.userId ? this.users.get(input.userId) ?? null : null;
    const principal = user ? createUserPrincipalFromRecord(user, this.listUserCenterRoles()) : null;
    const grants = [...this.permissionGrants.values()].filter((grant) => (
      grant.appId === input.appId
      && (!input.userId || grant.userId === input.userId)
    ));
    return evaluateAppCenterAccess(app, input, principal, user, grants);
  }

  getAppCenterApp(appId: string): AppCenterApp | null {
    return this.appCatalog.get(appId) ?? null;
  }

  upsertAppCenterApp(input: AppCenterAppInput): AppCenterApp {
    const appId = input.appId?.trim() || '';
    const previous = appId ? this.getAppCenterApp(appId) : null;
    const app = buildAppCenterApp(input, previous);
    if (app.enabled !== false) {
      this.ensureAppPublisherServiceAccount(app);
    } else {
      this.disableAppPublisherServiceAccount(app, false);
    }
    this.appCatalog.set(app.appId, app);
    this.recordAudit({
      eventType: previous ? 'app-center.app.updated' : 'app-center.app.created',
      actorKind: 'app-center',
      productId: app.appId,
      metadata: {
        requestedBy: input.requestedBy?.trim() || 'desktop-admin',
        launcherMode: app.launcherMode,
        standaloneChannelProductId: app.standaloneChannelProductId,
        builtin: app.builtin
      }
    });
    return app;
  }

  deleteAppCenterApp(appId: string): boolean {
    const app = this.getAppCenterApp(appId);
    if (!app) return false;
    if (app.builtin || app.systemOwned) {
      throw new Error('builtin AppCenter app cannot be deleted');
    }
    this.appCatalog.delete(app.appId);
    const publisherRevoked = this.disableAppPublisherServiceAccount(app, true);
    this.recordAudit({
      eventType: 'app-center.app.deleted',
      actorKind: 'app-center',
      productId: app.appId,
      metadata: {
        requestedBy: 'desktop-admin',
        publisherRevoked
      }
    });
    return true;
  }

  listAppCenterInstallations(input: AppCenterInstallationQuery = {}): AppCenterInstallation[] {
    return [...this.appCenterInstallations.values()]
      .filter((installation) => appCenterInstallationMatchesQuery(installation, input))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsertAppCenterInstallation(input: AppCenterInstallationInput): AppCenterInstallation {
    const draft = buildAppCenterInstallation(input, null);
    const app = this.getAppCenterApp(draft.appId);
    if (!app) throw new Error(`AppCenter app ${draft.appId} is not registered`);
    const previous = this.appCenterInstallations.get(draft.installationId) ?? null;
    const installation = buildAppCenterInstallation(input, app, previous);
    this.appCenterInstallations.set(installation.installationId, installation);
    this.recordAudit({
      eventType: previous ? 'app-center.installation.updated' : 'app-center.installation.created',
      actorKind: 'app-center',
      userId: installation.userId,
      installId: installation.installId,
      deviceId: installation.deviceId,
      productId: installation.appId,
      metadata: {
        requestedBy: input.requestedBy?.trim() || 'desktop-appcenter',
        sourceAppId: installation.sourceAppId,
        packageName: installation.packageName,
        installedVersion: installation.installedVersion,
        latestVersion: installation.latestVersion,
        status: installation.status,
        runtimeState: installation.runtimeState,
        installSource: installation.installSource
      }
    });
    return installation;
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

  getDnsReverseProxyRoute(routeId: string): DnsReverseProxyRoute | null {
    return this.dnsReverseProxyRoutes.get(routeId) ?? null;
  }

  upsertDnsReverseProxyRoute(input: DnsReverseProxyRouteInput): DnsReverseProxyRoute {
    const previous = input.routeId ? this.getDnsReverseProxyRoute(input.routeId) : null;
    const route = buildDnsReverseProxyRoute(this.config, input, previous);
    this.dnsReverseProxyRoutes.set(route.routeId, route);
    this.recordAudit({
      eventType: previous ? 'dns.reverse_proxy_route.updated' : 'dns.reverse_proxy_route.created',
      actorKind: 'dns-control',
      requestId: input.requestedBy ?? null,
      metadata: {
        routeId: route.routeId,
        host: route.host,
        targetUrl: route.targetUrl,
        enabled: route.enabled
      }
    });
    return route;
  }

  deleteDnsReverseProxyRoute(routeId: string): boolean {
    const route = this.getDnsReverseProxyRoute(routeId);
    if (!route) return false;
    this.dnsReverseProxyRoutes.delete(route.routeId);
    this.recordAudit({
      eventType: 'dns.reverse_proxy_route.deleted',
      actorKind: 'dns-control',
      metadata: {
        routeId: route.routeId,
        host: route.host,
        targetUrl: route.targetUrl
      }
    });
    return true;
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

  getGatewayRuntimeConfig(): GatewayRuntimeConfig {
    return this.gatewayRuntimeConfig;
  }

  upsertGatewayRuntimeConfig(input: GatewayRuntimeConfigInput): GatewayRuntimeConfig {
    const runtimeConfig = buildGatewayRuntimeConfig(this.config, input, this.gatewayRuntimeConfig);
    this.gatewayRuntimeConfig = runtimeConfig;
    this.recordAudit({
      eventType: 'config.gateway_runtime.saved',
      actorKind: 'config-center',
      requestId: input.requestId ?? null,
      metadata: {
        backend: runtimeConfig.backend,
        hostNginxConfigPath: runtimeConfig.hostNginxConfigPath,
        hostNginxInternalApiUpstream: runtimeConfig.hostNginxInternalApiUpstream
      }
    });
    return runtimeConfig;
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

  syncGatewayConfigMap(input: GatewayConfigMapSyncInput): GatewayConfigMapSyncResult {
    const effectiveInput = gatewayRuntimeConfigRequestInput(input, this.gatewayRuntimeConfig);
    const result = renderGatewayConfigMap(
      this.config,
      this.listDnsReverseProxyRoutes(),
      effectiveInput,
      `gatewaysync_${randomUUID()}`
    );
    this.gatewayConfigMapSyncs.set(result.syncId, result);
    this.recordAudit({
      eventType: 'dns.gateway_configmap.sync_recorded',
      actorKind: 'dns-control',
      requestId: effectiveInput.requestId ?? null,
      metadata: {
        syncId: result.syncId,
        mode: result.mode,
        status: result.status,
        applied: result.applied,
        namespace: result.namespace,
        configMapName: result.configMapName,
        routeCount: result.routeCount
      }
    });
    return result;
  }

  async applyGatewayConfigMap(input: GatewayConfigMapApplyInput): Promise<GatewayConfigMapApplyResult> {
    const effectiveInput = gatewayRuntimeConfigRequestInput(input, this.gatewayRuntimeConfig);
    const sync = this.syncGatewayConfigMap({ ...effectiveInput, mode: 'shadow-apply' });
    const gatewayConfig = gatewayRuntimeConfigForInput(this.config, effectiveInput);
    const gate = evaluateGatewayConfigMapApplyGate(this.config, sync, effectiveInput);
    const issuedAt = new Date().toISOString();
    const outcome = gate.allowed
      ? gatewayConfig.gatewayApplyBackend === 'host-nginx'
        ? await applyGatewayNginxConfigToHostRunner(gatewayConfig, {
            configPath: gatewayConfig.gatewayHostNginxConfigPath,
            nginxConfig: sync.manifest.data['nginx.conf'],
            routesMetadata: sync.manifest.data['mx-gateway-routes.json'],
            serverDryRun: gate.serverDryRun,
            requestId: effectiveInput.requestId ?? null
          })
        : await applyGatewayConfigMapToKubernetes(sync.manifest, gate.serverDryRun)
      : {
          status: 'failed' as const,
          applied: false,
          resourceVersion: null,
          message: gate.blockedReason ?? 'Internal gateway apply blocked'
        };
    const result: GatewayConfigMapApplyResult = {
      applyId: `gatewayapply_${randomUUID()}`,
      syncId: sync.syncId,
      mode: gatewayConfig.gatewayApplyBackend === 'host-nginx'
        ? gate.serverDryRun ? 'host-nginx-dry-run' : 'host-nginx-apply'
        : gate.serverDryRun ? 'k8s-server-dry-run' : 'k8s-apply',
      status: gate.allowed ? outcome.status : 'blocked',
      allowed: gate.allowed,
      applied: gate.allowed ? outcome.applied : false,
      serverDryRun: gate.serverDryRun,
      namespace: sync.namespace,
      configMapName: sync.configMapName,
      routeCount: sync.routeCount,
      manifest: sync.manifest,
      resourceVersion: gate.allowed ? outcome.resourceVersion : null,
      blockedReason: gate.blockedReason,
      message: gate.allowed ? outcome.message : (gate.blockedReason ?? 'Internal gateway apply blocked'),
      issuedAt,
      completedAt: new Date().toISOString()
    };
    this.gatewayConfigMapApplies.set(result.applyId, result);
    this.recordAudit({
      eventType: 'dns.gateway_configmap.apply_evaluated',
      actorKind: 'dns-control',
      requestId: effectiveInput.requestId ?? null,
      metadata: {
        applyId: result.applyId,
        syncId: result.syncId,
        status: result.status,
        allowed: result.allowed,
        applied: result.applied,
        serverDryRun: result.serverDryRun,
        namespace: result.namespace,
        configMapName: result.configMapName,
        routeCount: result.routeCount,
        blockedReason: result.blockedReason
      }
    });
    return result;
  }

  requestPermission(input: PermissionRequestInput): PermissionGrant {
    const app = this.appCatalog.get(input.appId);
    const requestedScopes = input.scopes.length > 0 ? input.scopes : [];
    const access = this.evaluateAppCenterAccess({
      appId: input.appId,
      userId: input.userId,
      sourceAppId: input.sourceAppId,
      includeHidden: true,
      includeDisabled: true,
      requestId: input.requestId ?? null
    });
    const allowedScopes = app && access.allowed
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
      sourceAppId: input.sourceAppId ?? null,
      accessAllowed: access.allowed,
      accessReason: access.reason,
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
        accessAllowed: access.allowed,
        accessReason: access.reason,
        scopes: requestedScopes,
        allowedScopes,
        deniedScopes,
        requestedBy: input.requestedBy
      }
    });
    return grant;
  }

  createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): LauncherNetworkSnapshot {
    const appId = normalizeLauncherNetworkProductId(input.appId);
    const launcherMode = input.launcherMode === 'embed' || input.launcherMode === 'standalone'
      ? input.launcherMode
      : launcherNetworkProductIsStandaloneDefault(appId)
        ? 'standalone'
        : 'embed';
    const requestedLease = input.leaseId?.trim()
      ? this.getLauncherNetworkLease(input.leaseId)
      : null;
    if (input.leaseId?.trim() && (!requestedLease || !launcherNetworkLeaseIsActive(requestedLease))) {
      throw new Error('Launcher network lease is missing or inactive');
    }
    if (requestedLease && requestedLease.productId !== appId) {
      throw new Error('Launcher network lease product does not match snapshot appId');
    }
    const requestedLeaseProduct = requestedLease
      ? this.getLauncherProductNetwork(requestedLease.productId)
        ?? buildLauncherProductNetwork(this.config, {
          productId: requestedLease.productId,
          mode: requestedLease.launcherMode
        }, null)
      : null;
    if (
      requestedLease?.identityKind === 'user'
      && requestedLease.userId !== input.userId?.trim()
    ) {
      throw new Error('Launcher network lease user does not match snapshot userId');
    }
    if (requestedLease) {
      const storedLeaseProfile = requestedLease.leaseProfile
        ?? (requestedLease.identityKind === 'user' ? 'employee' : 'anonymous');
      const requestedLeaseProfile = launcherNetworkLeaseProfile(
        input.leaseProfile,
        requestedLease.identityKind
      );
      if (storedLeaseProfile !== requestedLeaseProfile) {
        throw new Error('Launcher network lease profile does not match snapshot leaseProfile');
      }
      if (
        requestedLeaseProduct
        && !launcherNetworkLeaseMatchesProfile(requestedLeaseProduct, storedLeaseProfile, requestedLease)
      ) {
        throw new Error('Launcher network lease no longer belongs to its configured profile range; renew the lease');
      }
    }
    const mode = requestedLease?.identityKind === 'user' || input.userId ? 'user' : 'guest';
    const lease = requestedLease ?? this.enrollLauncherNetworkLease({
      productId: appId,
      mode: launcherMode,
      identityKind: mode === 'user' ? 'user' : 'anonymous',
      leaseProfile: input.leaseProfile,
      installId: input.installId,
      deviceId: input.deviceId,
      siteId: input.siteId,
      userId: input.userId,
      publicKey: input.publicKey,
      requestedBy: 'snapshot',
      requestId: input.requestId
    });
    const product = this.getLauncherProductNetwork(lease.productId)
      ?? buildLauncherProductNetwork(this.config, { productId: lease.productId, mode: lease.launcherMode }, null);
    const topology = buildLauncherNetworkTopology(this.config, {
      mode,
      leaseIp: lease.leaseIp,
      leaseCidr: lease.cidr,
      leaseProfile: lease.leaseProfile ?? (lease.identityKind === 'user' ? 'employee' : 'anonymous'),
      product,
      domesticSiteId: lease.domesticSiteId,
      publicKey: lease.publicKey
    });
    const domesticWireGuardSecret = this.siteSlotDomesticWireGuardSecrets.get(topology.domestic.siteId) ?? null;
    const topologyWithRefreshHint = attachDomesticWireGuardRefreshHint(topology, domesticWireGuardSecret);
    const issuedAt = new Date().toISOString();
    const unsigned = {
      environment: this.config.environment,
      appId,
      installId: lease.installId,
      deviceId: lease.deviceId,
      userId: lease.userId,
      mode,
      leaseIp: lease.leaseIp,
      topology: topologyWithRefreshHint,
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
        productId: product.productId,
        launcherMode: product.mode,
        identityKind: lease.identityKind,
        leaseProfile: lease.leaseProfile ?? (lease.identityKind === 'user' ? 'employee' : 'anonymous'),
        cidr: lease.cidr,
        leaseIp: lease.leaseIp,
        relayMode: 'h2i'
      },
      topology: topologyWithRefreshHint,
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

  createPublisherReleaseManagementPlan(
    input: PublisherReleasePlanInput
  ): PublisherReleasePlanResult {
    const existing = [...this.releaseManagementPlans.values()].find((plan) => (
      plan.productId === input.productId && plan.requestId === input.requestId
    ));
    if (existing) {
      return existing.publisherRequestFingerprint === input.publisherRequestFingerprint
        ? { outcome: 'replayed', plan: existing }
        : { outcome: 'conflict', planId: existing.planId };
    }
    return {
      outcome: 'created',
      plan: this.createReleaseManagementPlan(input)
    };
  }

  createReleaseManagementPlan(input: ReleaseManagementPlanInput): ReleaseManagementPlan {
    const releaseId = input.releaseId?.trim() || `rel_${randomUUID()}`;
    const channel = input.channel?.trim() || 'shadow';
    const appId = input.appId?.trim() || 'h2o';
    const productId = input.productId?.trim() || appId;
    const launcherUpdatePolicy = normalizeUpdatePolicy(input.launcherUpdatePolicy ?? 'platform-critical');
    const appUpdatePolicy = normalizeUpdatePolicy(input.appUpdatePolicy ?? 'app-managed');
    const launcherDecision = this.evaluateReleaseUpdate({
      componentKind: launcherUpdatePolicy,
      componentId: input.launcherComponentId?.trim()
        || (launcherUpdatePolicy === 'app-installer' || launcherUpdatePolicy === 'mx-h2i-installer' ? productId : 'mx-launcher'),
      currentVersion: input.launcherCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.launcherTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const appDecision = this.evaluateReleaseUpdate({
      componentKind: appUpdatePolicy,
      componentId: input.appComponentId?.trim() || appId,
      currentVersion: input.appCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.appTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const testRun = this.createTestRun({
      suiteId: input.suiteId?.trim() || 'hdi-shadow-e2e',
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

  updateReleaseManagementPlan(
    planId: string,
    input: ReleaseManagementPlanPatchInput
  ): ReleaseManagementPlan {
    const plan = this.getReleaseManagementPlan(planId);
    if (!plan) throw new Error(`Unknown releaseManagementPlanId: ${planId}`);
    const updated = updateReleaseManagementPlanMetadata(plan, input);
    this.releaseManagementPlans.set(planId, updated);
    this.recordAudit({
      eventType: 'release.management_plan.updated',
      actorKind: 'release-center',
      requestId: input.requestId ?? null,
      installId: updated.installId,
      userId: updated.userId,
      productId: updated.productId || updated.components.launcher.componentId,
      metadata: {
        planId: updated.planId,
        releaseId: updated.releaseId,
        channel: updated.channel,
        deliveryMode: updated.deliveryMode,
        updatedBy: updated.updatedBy
      }
    });
    return updated;
  }

  completeReleaseManagementGate(planId: string, input: ReleaseManagementGateInput): ReleaseManagementPlan {
    const plan = this.getReleaseManagementPlan(planId);
    if (!plan) throw new Error(`Unknown releaseManagementPlanId: ${planId}`);
    const currentVerdict = plan.test.gate.verdict;
    const gateIsTerminal = currentVerdict === 'passed'
      || currentVerdict === 'failed';
    if (gateIsTerminal) {
      if (currentVerdict === input.status) return plan;
      throw new Error(
        `Release management gate is terminal (${currentVerdict}); create a new plan`
      );
    }
    const run = this.recordTestStepInternal(plan.test.run.testRunId, {
      caseId: 'release-gate:e2e',
      status: input.status,
      message: input.message ?? `release management E2E gate ${input.status}`,
      evidence: {
        source: 'release-management-gate-action',
        releaseId: plan.releaseId,
        planId: plan.planId,
        ...(input.evidence ?? {})
      }
    }, true);
    const gate = this.evaluateTestGate({
      gateId: plan.test.gate.gateId,
      releaseId: plan.releaseId,
      runIds: [run.testRunId]
    });
    const updated: ReleaseManagementPlan = {
      ...plan,
      test: {
        ...plan.test,
        run,
        gate
      },
      decisions: buildReleaseManagementDecisions(plan.components.launcher, plan.components.app, gate)
    };
    this.releaseManagementPlans.set(updated.planId, updated);
    this.recordAudit({
      eventType: 'release.management_gate.completed',
      actorKind: 'release-center',
      requestId: input.requestId ?? null,
      installId: updated.installId,
      userId: updated.userId,
      productId: updated.productId || updated.components.launcher.componentId,
      metadata: {
        planId: updated.planId,
        releaseId: updated.releaseId,
        gateVerdict: updated.test.gate.verdict,
        readyToPromote: updated.decisions.readyToPromote,
        requestedBy: input.requestedBy ?? null
      }
    });
    return updated;
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
    return this.recordTestStepInternal(runId, input, false);
  }

  private recordTestStepInternal(
    runId: string,
    input: TestStepInput,
    allowPublisherGate: boolean
  ): TestRun {
    const run = this.testRuns.get(runId);
    if (!run) throw new Error(`Unknown testRunId: ${runId}`);
    if (!allowPublisherGate) {
      const publisherOwnsRun = [...this.releaseManagementPlans.values()].some((plan) => (
        Boolean(plan.publisherRequestFingerprint?.trim())
        && plan.test.run.testRunId === runId
      ));
      if (publisherOwnsRun) {
        throw new Error(
          'Publisher release test runs can only be completed through the release gate endpoint'
        );
      }
    }
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
    } else if (
      status === 'passed'
      && (allowPublisherGate || run.steps.length > 0 && run.steps.every((item) => item.status === 'passed'))
    ) {
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
    const smokeHomePublicKey = randomBytes(32).toString('base64');
    const { enrollment } = this.enrollAnonymous({
      productId: MX_H2I_PRODUCT_ID,
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
    const overseaSyncInternalConfig = overseaSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'sync-internal-config');
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
      || !overseaPrepareAccess?.commands.some((command) => command.includes('ln -sfnT /opt/mx/releases/oversea-access-stack/__release_revision__ /opt/mx/current/hysteria2-access-stack'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('HY2_EXPORT_BASE_URL=http://oversea.example.com:3434') && command.includes('HY2_EXPORT_USER=download') && command.includes('HY2_EXPORT_PASSWORD_HASH='))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('HY2_MIHOMO_ROUTING_MODE=cn-direct') && command.includes('HY2_RESERVED_INTERNAL_CIDRS=10.88.0.0/16,10.89.0.0/16,10.90.0.0/16') && command.includes('HY2_DOMESTIC_GATEWAY_IP=10.88.0.1'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('base64 -d') && command.includes('tunnel-state.json'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('reconcile-from-json') && command.includes('--mode hysteria2-only'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('./manage.sh sync-internal-defaults'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('./manage.sh docker-status'))
      || !overseaConfigureAccess?.commands.some((command) => command.includes('@qpjoy/tunnel-cli') || command.includes('qp-tunnel-cli register') || command.includes('oversea callback push-only; registration skipped'))
      || !overseaPublishSubscription?.commands.some((command) => command.includes('domesticBootstrapSubscription=') && command.includes('/subscriptions/hysteria2/oversea-sg-1-domestic.yaml'))
      || !overseaPublishSubscription?.commands.some((command) => command.includes('internalBootstrapSubscription=') && command.includes('/subscriptions/hysteria2/oversea-sg-1-internal.yaml'))
      || overseaDeployServices?.mode !== 'artifact-push'
      || !overseaDeployServices?.commands.some((command) => command.includes('rsync -az') && command.includes('mx-oversea-services.tar.gz'))
      || !overseaDeployServices?.commands.some((command) => command.includes('/opt/mx/incoming/mx-oversea-services.tar.gz'))
      || !overseaDeployServices?.commands.some((command) => command.includes('ln -sfnT /opt/mx/releases/oversea/__release_revision__ /opt/mx/current/oversea'))
      || !overseaDeployServices?.commands.some((command) => command.includes('/opt/mx/current/oversea') && command.includes('LOCAL_STACK_PATH=/opt/mx/current/hysteria2-access-stack') && command.includes('MX_ACCESS_RUNTIME=hysteria2-only'))
      || !overseaDeployServices?.commands.some((command) => command.includes('slot services placeholder; no Docker services selected'))
      || !overseaSyncInternalConfig?.commands.some((command) => command.includes('overseaConfigDelivery=internal-pushed') && command.includes('remoteCurl=skipped'))
      || overseaSyncInternalConfig?.commands.some((command) => command.includes('ssh ') && command.includes('/healthz'))
      || overseaDeploymentCommands.some((command) => command.includes('git pull') || command.includes('git clone') || command.includes('./docker/'))
    ) {
      throw new Error('Oversea slot plan did not include access stack');
    }
    checks.push('OK Oversea slot plan generated');
    const overseaAccounts = this.issueSiteSlotAccessAccounts({
      siteId: overseaSlotPlan.siteId,
      publicHost: overseaSlotPlan.host,
      serverPorts: '51288',
      tlsFingerprint: 'D6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58',
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
      || overseaAccounts.site.serverPorts !== '51288'
      || overseaAccounts.site.tlsFingerprint !== 'D6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58'
      || !overseaAccounts.accounts.some((account) => account.username === 'oversea-sg-1-internal09')
      || !overseaDomesticSubscription?.yaml.includes('type: hysteria2')
      || !overseaDomesticSubscription.yaml.includes('log-level: info')
      || !overseaDomesticSubscription.yaml.includes('port: 51288')
      || overseaDomesticSubscription.yaml.includes('port: 52120')
      || !overseaDomesticSubscription.yaml.includes('down: "30 Mbps"')
      || !overseaDomesticSubscription.yaml.includes('up: "30 Mbps"')
      || !overseaDomesticSubscription.yaml.includes('fingerprint: "D6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58"')
      || !overseaDomesticSubscription.yaml.includes('alpn:')
      || !overseaDomesticSubscription.yaml.includes('- h3')
      || !overseaDomesticSubscription.yaml.includes('DOMAIN-SUFFIX,local,DIRECT')
      || !overseaDomesticSubscription.yaml.includes('GEOSITE,CN,DIRECT')
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
      siteId: 'domestic-smoke',
      host: 'domestic-smoke.localdomain',
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
    const domesticPublicIngress = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'domestic-public-ingress-firewall');
    const domesticResolveSubscription = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'resolve-domestic-bootstrap-subscription');
    const domesticBootstrapEgress = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'bootstrap-domestic-egress');
    const domesticDockerRuntime = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'install-domestic-docker-runtime');
    const domesticEgressProxyReadiness = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'verify-domestic-egress');
    const domesticPeerCenter = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'activate-domestic-peer-center');
    const domesticDeployServices = domesticSlotPlan.deploymentPhases.find((phase) => phase.phaseId === 'deploy-slot-services');
    if (
      domesticSlotPlan.network.mode !== 'oversea-assisted'
      || domesticSlotPlan.network.qpTunnelCliMode !== 'egress-on'
      || !domesticSlotPlan.services.hostServices.includes('wg-quick@mx-domestic')
      || !domesticPackageArtifacts?.commands.some((command) => command.includes('qp-tunnel-cli-offline-fallback'))
      || !domesticPackageArtifacts?.commands.some((command) => command.includes('refresh-tunnel-cli latest'))
      || !domesticPackageArtifacts?.commands.some((command) => command.includes('--from-tarball'))
      || domesticRelayAuthority?.mode !== 'admin-action'
      || !domesticRelayAuthority?.commands.some((command) => command.includes('Domestic WG gateway=10.88.0.1') && command.includes('Internal service peer=10.88.88.88'))
      || !domesticRelayAuthority?.commands.some((command) => command.includes('mx-domestic-wg-relay.conf') && command.includes('10.90.0.0/16'))
      || !domesticRelayAuthority?.commands.some((command) => command.includes('mx-internal-service-peer.conf') && command.includes('never copy the Internal private key to Domestic'))
      || !domesticRelayAuthority?.commands.some((command) => command.includes('Internal has no public ingress'))
      || domesticPublicIngress?.mode !== 'manual'
      || !domesticPublicIngress?.commands.some((command) => command.includes('UDP 51280') && command.includes('WireGuard relay'))
      || !domesticPublicIngress?.commands.some((command) => command.includes('TCP 443') && command.includes('bootstrap/enroll/snapshot/H2I facade'))
      || !domesticPublicIngress?.commands.some((command) => command.includes('do not expose 3000, 5432, 18090'))
      || !domesticSlotPlan.nextActions.includes('confirm-domestic-public-ingress-firewall')
      || domesticResolveSubscription?.mode !== 'admin-action'
      || !domesticResolveSubscription?.commands.some((command) => command.includes('domesticBootstrapSubscription'))
      || !domesticResolveSubscription?.commands.some((command) => command.includes('mx-domestic-bootstrap-subscription.yaml') && command.includes('Domestic cannot fetch Internal URLs until mx-domestic reaches 10.88.88.88'))
      || !domesticResolveSubscription?.commands.some((command) => command.includes('install node/npm') && command.includes('npm install'))
      || domesticBootstrapEgress?.mode !== 'artifact-push'
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('QP_TUNNEL_CLI=/opt/mx/current/qp-tunnel-cli/bin/qp-tunnel-cli'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('attempt pre-egress npm install @qpjoy/tunnel-cli@latest'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('mx-domestic-qp-tunnel-cli-fallback.tar.gz'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('ln -sfnT /opt/mx/releases/qp-tunnel-cli/__release_revision__ /opt/mx/current/qp-tunnel-cli'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('mx-domestic-bootstrap-subscription.yaml') && command.includes('domestic-bootstrap-subscription.yaml'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('MIHOMO_TUN_ROUTE_EXCLUDE_ADDRESS') && command.includes('using Internal-pushed fallback'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('@qpjoy/tunnel-cli@latest') && command.includes('npm refresh skipped after egress-on'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('node/npm absent'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('egress-on'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('BOOTSTRAP_SUBSCRIPTION_FILE=/opt/mx/current/qp-tunnel-cli/domestic-bootstrap-subscription.yaml'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('--file $BOOTSTRAP_SUBSCRIPTION_FILE'))
      || !domesticBootstrapEgress?.commands.some((command) => command.includes('local bootstrap subscription file is required before WG relay/Internal URL is reachable'))
      || domesticBootstrapEgress?.commands.some((command) => command.includes('--url '))
      || !domesticDockerRuntime?.commands.some((command) => command.includes('docker') && command.includes('apt-get'))
      || domesticEgressProxyReadiness?.mode !== 'remote-ssh'
      || !domesticEgressProxyReadiness?.commands.some((command) => command.includes('www.gstatic.com/generate_204') && command.includes('--http1.1'))
      || !domesticEgressProxyReadiness?.commands.some((command) => command.includes('auth.docker.io/token') && command.includes('registry-1.docker.io/v2/'))
      || !domesticEgressProxyReadiness?.commands.some((command) => command.includes('registry-1.docker.io/v2/') && command.includes('127.0.0.1:7788'))
      || !domesticEgressProxyReadiness?.commands.some((command) => command.includes('generic HTTPS is not reachable') && command.includes('Docker registry is not reachable'))
      || !domesticEgressProxyReadiness?.commands.some((command) => command.includes('mihomo-client service is not active') && command.includes('journalctl -u mihomo-client'))
      || !domesticPeerCenter?.commands.some((command) => command.includes('install -d -m 0755 /opt/mx/releases/domestic/__release_revision__'))
      || domesticPeerCenter?.commands.some((command) => command.includes('install -d -m 0755 /opt/mx/current/domestic'))
      || !domesticPeerCenter?.commands.some((command) => command.includes('mx-domestic-wg-relay.conf') && command.includes('/etc/wireguard/mx-domestic.conf'))
      || !domesticPeerCenter?.commands.some((command) => command.includes('/opt/mx/releases/domestic/__release_revision__/mx-domestic-relay.env'))
      || domesticPeerCenter?.commands.some((command) => command.includes('/opt/mx/current/domestic/mx-domestic-relay.env'))
      || !domesticPeerCenter?.commands.some((command) => command.includes('preserving V1') && command.includes('cleanup-v1-wireguard --apply'))
      || domesticPeerCenter?.commands.some((command) => command.includes('disable --now wg-quick@hdo-home') || command.includes('wg-quick down hdo-home') || command.includes('ip link delete hdo-home'))
      || !domesticPeerCenter?.commands.some((command) => command.includes('internal service peer private key must not be copied to Domestic'))
      || domesticPeerCenter?.commands.some((command) => command.includes('rsync') && command.includes('mx-internal-service-peer.conf'))
      || !domesticDeployServices?.commands.some((command) => command.includes('mv /opt/mx/current/domestic /opt/mx/current/domestic.legacy-__release_revision__'))
      || !domesticDeployServices?.commands.some((command) => command.includes('ln -sfnT /opt/mx/releases/domestic/__release_revision__ /opt/mx/current/domestic'))
      || !domesticDeployServices?.commands.some((command) => command.includes('./manage.sh up') && command.includes('Domestic service bundle is missing executable manage.sh'))
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
      || !domesticSlotPreflightExecution.steps.some((step) => step.sourceId === 'domestic.public-ingress-firewall')
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
    const domesticSlotConfirmedApplyExecution = this.createSiteSlotExecution({
      planId: domesticSlotPlan.planId,
      action: 'apply',
      mode: 'manual',
      confirmApply: true,
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-apply-confirmed'
    });
    const domesticSlotApplyRunnerSession = this.startSiteSlotRunnerSession({
      runId: domesticSlotConfirmedApplyExecution.runId,
      mode: 'simulate',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-apply-runner-simulate'
    });
    const domesticSlotApplyWorkerJob = this.createSiteSlotWorkerJob({
      sessionId: domesticSlotApplyRunnerSession.sessionId,
      workerId: 'worker-shadow-domestic-apply',
      workerKind: 'internal-runner',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-apply-worker-job'
    });
    const domesticBootstrapPrepareWorkerStep = domesticSlotApplyWorkerJob.steps.find((step) => step.sourceId === 'bootstrap-domestic-egress.1');
    const domesticBootstrapSubscriptionWorkerStep = domesticSlotApplyWorkerJob.steps.find((step) => step.sourceId === 'bootstrap-domestic-egress.4');
    const domesticVerifyEgressWorkerStep = domesticSlotApplyWorkerJob.steps.find((step) => step.sourceId.startsWith('verify-domestic-egress.'));
    if (
      domesticSlotConfirmedApplyExecution.status !== 'ready'
      || domesticSlotApplyRunnerSession.status !== 'completed'
      || domesticBootstrapPrepareWorkerStep?.redactOutput !== false
      || !domesticBootstrapSubscriptionWorkerStep?.redactOutput
      || domesticVerifyEgressWorkerStep?.redactOutput !== false
    ) {
      throw new Error('Domestic apply worker redaction policy did not preserve egress diagnostics');
    }
    checks.push('OK Domestic apply worker preserves egress diagnostics');
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
      appId: MX_H2I_PRODUCT_ID,
      launcherMode: 'standalone',
      requestId: 'smoke-network'
    });
    if (
      networkSnapshot.overlayPolicy.cidr !== '10.89.0.0/16'
      || networkSnapshot.overlayPolicy.leaseIp !== enrollment.overlayIp
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
    const mxH2iLeases = this.listLauncherNetworkLeases(MX_H2I_PRODUCT_ID);
    if (!mxH2iLeases.some((lease) => lease.leaseIp === networkSnapshot.overlayPolicy.leaseIp && lease.identityKind === 'anonymous')) {
      throw new Error('MX-H2I network lease allocator did not persist anonymous lease');
    }
    checks.push('OK MX-H2I Network lease allocator persisted anonymous lease');
    const permissionGrant = this.requestPermission({
      appId: 'h2o',
      installId: enrollment.installId,
      userId: 'usr_demo_user',
      sourceAppId: MX_H2I_PRODUCT_ID,
      scopes: ['network.proxy.app'],
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-permission'
    });
    if (permissionGrant.decision !== 'granted') {
      throw new Error('h2o permission was not granted');
    }
    checks.push('OK h2o permission granted');
    const testRun = this.createTestRun({
      suiteId: 'hdi-shadow-e2e',
      productId: MX_H2I_PRODUCT_ID,
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
      productId: MX_H2I_PRODUCT_ID,
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
      appId: MX_H2I_PRODUCT_ID,
      channel: 'shadow',
      requestId: 'smoke-config-policy'
    });
    if (
      !configPolicySnapshot.signatures.digest
      || configPolicySnapshot.policies.dns.policy.policyId !== dnsPolicy.policyId
      || configPolicySnapshot.policies.permissionPolicy.declaredScopes.length === 0
      || configPolicySnapshot.policies.launcherNetwork.overlayPolicy.cidr !== '10.89.0.0/16'
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

  private defaultUserOverseaSiteIds(): string[] {
    const siteId = this.defaultUserOverseaSiteId();
    return siteId ? [siteId] : [];
  }

  /** Mirrors the Postgres store: never hand a user a retired site as their default. */
  private defaultUserOverseaSiteId(): string | null {
    const configured = this.configuredDefaultOverseaSiteCandidates();
    const explicit = configured.find((item) => item.explicit);
    if (explicit && this.overseaSiteIsServiceable(explicit.siteId)) return explicit.siteId;

    const sites = [...this.launcherNetworkMihomoSites.values()]
      .map((site) => normalizeLauncherNetworkMihomoSite(site))
      .filter((site) => site.status !== 'archived' && site.publicHost)
      .sort((a, b) => a.siteId.localeCompare(b.siteId));

    for (const site of sites) {
      if (this.listSiteSlotAccessAccounts(site.siteId).some((account) => account.status === 'active')) {
        return site.siteId;
      }
    }
    if (sites.length > 0) return sites[0].siteId;
    return explicit?.siteId ?? 'oversea-main';
  }

  private overseaSiteIsServiceable(siteId: string): boolean {
    const site = this.getLauncherNetworkMihomoSite(siteId);
    return Boolean(site && site.status !== 'archived' && site.publicHost);
  }

  private configuredDefaultOverseaSiteCandidates(): Array<{ siteId: string; explicit: boolean }> {
    return this.listLauncherProductNetworks()
      .map((product) => ({
        siteId: product.defaultOverseaSiteId,
        explicit: product.updatedBy !== 'builtin' || product.createdBy !== 'builtin'
      }))
      .filter((item) => item.siteId);
  }

  private ensureEnabledAppPublisherServiceAccounts(): void {
    for (const app of this.appCatalog.values()) {
      if (app.enabled === false) continue;
      try {
        this.ensureAppPublisherServiceAccount(app);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('Release publisher service account collision:')) throw error;
        console.warn(`[mx-launcher] skipped Release Publisher reconciliation for ${app.appId}: ${message}`);
      }
    }
  }

  private ensureAppPublisherServiceAccount(app: AppCenterApp): UserCenterServiceAccount {
    const serviceAccountId = appReleasePublisherServiceAccountId(app.appId);
    const previous = this.serviceAccounts.get(serviceAccountId);
    if (!previous) {
      return this.createUserCenterServiceAccount({
        serviceAccountId,
        displayName: `${app.displayName} Release Publisher`,
        roleIds: ['mx-release-publisher'],
        scopes: APP_RELEASE_PUBLISHER_SCOPES,
        allowedProductIds: [app.appId],
        requestId: 'app-release-publisher-reconcile'
      });
    }
    if (
      previous.allowedProductIds?.length !== 1
      || previous.allowedProductIds[0] !== app.appId
    ) {
      throw new Error(`Release publisher service account collision: ${serviceAccountId}`);
    }
    const scopes = [...APP_RELEASE_PUBLISHER_SCOPES];
    const roleIds = ['mx-release-publisher'];
    if (
      previous.scopes.length === scopes.length
      && scopes.every((scope) => previous.scopes.includes(scope))
      && previous.roleIds.length === roleIds.length
      && previous.roleIds[0] === roleIds[0]
      && previous.allowedProductIds?.length === 1
      && previous.allowedProductIds[0] === app.appId
      && previous.status === 'active'
    ) {
      return previous;
    }
    const reconciled: UserCenterServiceAccount = {
      ...previous,
      roleIds,
      scopes,
      allowedProductIds: [app.appId],
      status: 'active'
    };
    this.serviceAccounts.set(serviceAccountId, reconciled);
    return reconciled;
  }

  private disableAppPublisherServiceAccount(
    app: AppCenterApp,
    deleteCredential: boolean
  ): boolean {
    const serviceAccountId = appReleasePublisherServiceAccountId(app.appId);
    const publisher = this.serviceAccounts.get(serviceAccountId);
    if (
      !publisher
      || publisher.allowedProductIds?.length !== 1
      || publisher.allowedProductIds[0] !== app.appId
    ) {
      return false;
    }
    this.serviceAccounts.set(serviceAccountId, { ...publisher, status: 'disabled' });
    this.revokeServiceAccountTokens(serviceAccountId);
    if (deleteCredential) this.serviceAccountCredentials.delete(serviceAccountId);
    return true;
  }

  private revokeServiceAccountTokens(
    serviceAccountId: string,
    revokedAt = new Date().toISOString()
  ): void {
    for (const [tokenHash, token] of this.tokens.entries()) {
      if (
        token.subjectKind === 'service-account'
        && token.subjectId === serviceAccountId
        && !token.revokedAt
      ) {
        this.tokens.set(tokenHash, { ...token, revokedAt });
      }
    }
  }

  private importConfiguredLegacyServiceAccountCredentials(): void {
    for (const [serviceAccountId, clientSecret] of configuredLegacyServiceAccountSecrets()) {
      try {
        this.importLegacyUserCenterServiceAccountCredential({
          serviceAccountId,
          clientSecret,
          requestedBy: 'startup-legacy-secret-import',
          requestId: 'startup-legacy-secret-import'
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          !message.startsWith('Service account not found:')
          && !message.startsWith('Service account is disabled:')
        ) {
          throw error;
        }
        console.warn(`[mx-launcher] skipped legacy credential import for ${serviceAccountId}: ${message}`);
      }
    }
  }

  private registerBuiltinApps(): void {
    for (const app of builtinAppCenterApps()) {
      this.appCatalog.set(app.appId, app);
    }
  }

  private registerBuiltinProductNetworks(): void {
    for (const product of builtinLauncherProductNetworks(this.config)) {
      this.launcherProductNetworks.set(product.productId, product);
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

  private registerBuiltinDomesticRuntimeConfigs(): void {
    const config = buildSiteSlotDomesticRuntimeConfig(this.config, { siteId: 'domestic-main' }, null);
    this.siteSlotDomesticRuntimeConfigs.set(config.siteId, config);
  }

  private registerBuiltinSecretRegistry(): void {
    for (const provider of builtinSecretProviderConfigs(this.config)) {
      this.secretProviderConfigs.set(provider.providerId, provider);
    }
    for (const reference of builtinConfigSecretReferences(this.config)) {
      this.configSecretReferences.set(reference.secretRefId, reference);
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

function deleteMapValues<K, V>(values: Map<K, V>, predicate: (value: V) => boolean): number {
  let deleted = 0;
  for (const [key, value] of values.entries()) {
    if (!predicate(value)) continue;
    values.delete(key);
    deleted += 1;
  }
  return deleted;
}

function normalizeEntitlementSiteIds(value: UserOverseaEntitlementInput['siteIds']): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [...new Set(raw.map((item) => item.trim()).filter(Boolean))].sort();
}

function latestIsoString(values: Array<string | null | undefined>): string | null {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
}
