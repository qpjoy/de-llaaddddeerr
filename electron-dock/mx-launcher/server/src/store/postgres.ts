import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { DataSource, EntityManager, Repository } from 'typeorm';

import { createPlatformDataSource } from '../db/data-source.js';
import { PlatformRecordEntity, type PlatformRecordRow } from '../db/entities.js';
import {
  consumeFixedWindowRateLimit,
  type AuthenticationRateLimitDecision,
  type AuthenticationRateLimitInput,
  type AuthenticationRateLimitState
} from '../lib/auth-rate-limit.js';
import {
  advanceLauncherNetworkHandover,
  buildLauncherNetworkHandover,
  launcherNetworkHandoverIsTerminal
} from '../lib/launcher-network-handover.js';
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
  AuditEventListFilter,
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
  LauncherNetworkReachabilityPlan,
  LauncherProductNetwork,
  LauncherProductNetworkInput,
  LauncherProductUserAccess,
  LauncherProductUserAccessInput,
  LauncherProductUserAccessResult,
  LogEntryInput,
  MihomoSubscriptionRender,
  PermissionGrant,
  PermissionRequestInput,
  PrincipalContext,
  PrincipalContextInput,
  PlatformKernelSmokeResult,
  ReleaseManagementPlan,
  ReleaseManagementGateInput,
  ReleaseManagementPlanInput,
  ReleaseManagementPlanPatchInput,
  ReleasePolicyDecision,
  ReleasePolicyInput,
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
  SiteHeartbeat,
  SiteSlotKind,
  SiteSlotExecutionInput,
  SiteSlotExecutionRun,
  SiteSlotAccessAccount,
  LauncherNetworkMihomoSiteArchiveInput,
  LauncherNetworkMihomoSiteArchiveResult,
  SiteSlotAccessAccountIssueInput,
  SiteSlotAccessAccountIssueResult,
  SiteSlotDomesticRuntimeConfig,
  SiteSlotDomesticRuntimeConfigInput,
  SiteSlotDomesticWireGuardSecret,
  SiteSlotDomesticWireGuardSecretInput,
  SiteSlotInternalServicePeerObservation,
  SiteSlotInternalServicePeerObservationInput,
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
  UserCenterServiceAccountCredential,
  UserCenterServiceAccountCredentialImportResult,
  UserCenterServiceAccountCredentialStatus,
  UserCenterServiceAccountCredentialVerificationResult,
  UserCenterIssuedServiceAccountCredential,
  UserCenterTenant,
  UserCenterTokenRecord,
  UserCenterUser,
  UserCenterUserIdentity,
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
  UserOverseaEntitlementMigrationInput,
  UserOverseaEntitlementMigrationChange,
  UserOverseaEntitlementMigrationResult,
  UserOverseaEntitlementRolloutInput,
  UserOverseaEntitlementRolloutResult,
  UserOverseaEntitlementInput,
  UserOverseaAccountSyncReport,
  UserOverseaAccountSyncReportInput,
  UserOverseaSubscriptionRender,
  TestRun,
  TestRunInput,
  TestStep,
  TestStepInput
} from '../types.js';
import {
  builtinAppCenterApps,
  builtinConfigSecretReferences,
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
  GATEWAY_RUNTIME_CONFIG_ID,
  builtinGatewayRuntimeConfig,
  builtinSecretProviderConfigs,
  buildGatewayRuntimeConfig,
  buildDnsReverseProxyRoute,
  attachDomesticWireGuardRefreshHint,
  buildLauncherNetworkMihomoSite,
  buildLauncherNetworkTopology,
  buildLauncherNetworkReachabilityPlan,
  buildLauncherNetworkLease,
  buildLauncherProductUserAccess,
  planLauncherProductUserAccessBackfill,
  assertLauncherAnonymousEnrollmentPolicy,
  nextAvailableLauncherNetworkLeaseSequence,
  launcherNetworkLeaseIsActive,
  launcherNetworkLeaseKey,
  launcherNetworkLeaseMatchesProfile,
  launcherNetworkLeaseProfile,
  releaseLauncherNetworkLease,
  buildReleaseManagementDecisions,
  appReleasePublisherServiceAccountId,
  buildSiteSlotAccessAccount,
  canonicalSiteSlotAccessAccountName,
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
  builtinDnsPolicies,
  builtinDnsReverseProxyRoutes,
  buildUserH2oRuntimeProfile,
  builtinUserCenterOrg,
  builtinUserCenterRoles,
  builtinUserCenterTenant,
  createBootstrapResult,
  createConfigPolicySnapshot,
  createConfigSnapshot,
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
  evaluateAppCenterAccess,
  appCenterInstallationMatchesQuery,
  gatewayRuntimeConfigRequestInput,
  gatewayRuntimeConfigForInput,
  evaluateSdkGatewayRoute,
  evaluateDnsPolicy,
  emptyUserCredentialSummary,
  hashToken,
  isUserOverseaSubscriptionLinkToken,
  USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE,
  USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE,
  USER_OVERSEA_SUBSCRIPTION_LINK_TTL_SECONDS,
  userOverseaSubscriptionLinkPath,
  introspectUserCenterToken,
  introspectShadowToken,
  normalizeImportUserCenterRow,
  normalizeTestStatus,
  applyLauncherNetworkMihomoSiteArchive,
  normalizeLauncherNetworkMihomoSite,
  orderDefaultOverseaSiteCandidates,
  orderOverseaSubscriptionEntries,
  planUserOverseaEntitlementMigration,
  assertUserOverseaMigrationInput,
  buildUserOverseaMigrationResult,
  planUserOverseaEntitlementRollout,
  assertUserOverseaRolloutInput,
  buildUserOverseaRolloutResult,
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
  userCenterServiceAccountCredentialId,
  userOverseaAccountName,
  userOverseaEntitlementId,
  summarizeUserCenterServiceAccountCredential,
  verifyUserCenterCredential,
  verifyUserCenterServiceAccountSecret,
  required,
  MX_H2I_PRODUCT_ID,
  assertLauncherNetworkLeaseEntitlement,
  assertLauncherProductUserAccess,
  launcherNetworkAppIdForLeaseInput,
  launcherNetworkLeaseProductId,
  launcherNetworkProductIsStandaloneDefault,
  launcherNetworkSdkTestModeAllowed,
  normalizeLauncherNetworkProductId,
  launcherProductUserAccessId,
  userCenterUserIdentity
} from './domain.js';
import { applyGatewayNginxConfigToHostRunner } from './host-runner.js';
import { applyCoreDnsConfigMapToKubernetes, applyGatewayConfigMapToKubernetes } from './kubernetes.js';
import type {
  PlatformOverview,
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
  | 'iam-user-credential'
  | 'iam-user-deletion-tombstone'
  | 'user-h2o-runtime-profile'
  | 'user-oversea-entitlement'
  | 'user-oversea-account-sync-report'
  | 'iam-service-account'
  | 'iam-service-account-credential'
  | 'iam-token'
  | 'feishu-authorization-transaction'
  | 'authentication-rate-limit'
  | 'dns-policy'
  | 'dns-reverse-proxy-route'
  | 'dns-zone-snapshot'
  | 'gateway-runtime-config'
  | 'coredns-configmap-sync'
  | 'coredns-configmap-apply'
  | 'gateway-configmap-sync'
  | 'gateway-configmap-apply'
  | 'release-management-plan'
  | 'site-slot-plan'
  | 'site-slot-execution'
  | 'site-slot-runner-session'
  | 'site-slot-worker-job'
  | 'site-slot-worker-report'
  | 'site-slot-rollback-execution'
  | 'site-slot-rollback-report'
  | 'site-slot-ssh-profile'
  | 'site-slot-domestic-runtime-config'
  | 'site-slot-domestic-wg-secret'
  | 'site-slot-internal-service-peer-observation'
  | 'site-slot-access-account'
  | 'launcher-network-mihomo-site'
  | 'launcher-product-network'
  | 'launcher-product-user-access'
  | 'launcher-product-user-access-backfill'
  | 'launcher-network-lease'
  | 'launcher-network-handover'
  | 'runtime-feature-policy'
  | 'awx-provider-config'
  | 'secret-provider-config'
  | 'config-secret-reference'
  | 'app-center-app'
  | 'app-center-installation'
  | 'permission-grant'
  | 'launcher-network-snapshot'
  | 'test-run'
  | 'test-gate-verdict'
  | 'audit-event'
  | 'log-entry';

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
    await store.registerBuiltinProductNetworks();
    await store.registerBuiltinDns();
    await store.registerBuiltinGatewayRuntimeConfig();
    await store.registerBuiltinDomesticRuntimeConfigs();
    await store.registerBuiltinSecretRegistry();
    await store.bootstrapUserCenter();
    await store.backfillLegacyLauncherProductUserAccess();
    await store.ensureEnabledAppPublisherServiceAccounts();
    await store.importConfiguredLegacyServiceAccountCredentials();
    return store;
  }

  async overview(): Promise<PlatformOverview> {
    const [
      sites,
      enrollments,
      snapshots,
      configPolicySnapshots,
      secretProviderConfigs,
      configSecretReferences,
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
      siteSlotDomesticRuntimeConfigs,
      awxProviderConfigs,
      dnsPolicies,
      dnsReverseProxyRoutes,
      dnsZoneSnapshots,
      coreDnsConfigMapSyncs,
      coreDnsConfigMapApplies,
      gatewayConfigMapSyncs,
      gatewayConfigMapApplies,
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
      this.countRecords('secret-provider-config'),
      this.countRecords('config-secret-reference'),
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
      this.countRecords('site-slot-domestic-runtime-config'),
      this.countRecords('awx-provider-config'),
      this.countRecords('dns-policy'),
      this.countRecords('dns-reverse-proxy-route'),
      this.countRecords('dns-zone-snapshot'),
      this.countRecords('coredns-configmap-sync'),
      this.countRecords('coredns-configmap-apply'),
      this.countRecords('gateway-configmap-sync'),
      this.countRecords('gateway-configmap-apply'),
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
      publicBaseUrl: this.config.publicBaseUrl,
      internalBaseUrl: this.config.internalBaseUrl,
      sites,
      enrollments,
      snapshots,
      configPolicySnapshots,
      secretProviderConfigs,
      configSecretReferences,
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
      siteSlotDomesticRuntimeConfigs,
      awxProviderConfigs,
      dnsPolicies,
      dnsReverseProxyRoutes,
      dnsZoneSnapshots,
      coreDnsConfigMapSyncs,
      coreDnsConfigMapApplies,
      gatewayConfigMapSyncs,
      gatewayConfigMapApplies,
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
    const kind = (planInput.kind ?? planInput.sshProfile?.kind) === 'oversea' ? 'oversea' : 'domestic';
    const siteId = planInput.siteId?.trim() || planInput.sshProfile?.siteId || `${kind}-main`;
    const storedDomesticRuntimeConfig = kind === 'domestic'
      ? await this.getSiteSlotDomesticRuntimeConfig(siteId)
      : null;
    const domesticRuntimeConfig = kind === 'domestic'
      ? planInput.domesticRuntimeConfig
        ?? storedDomesticRuntimeConfig
        ?? buildSiteSlotDomesticRuntimeConfig(this.config, { siteId }, null)
      : null;
    const plan = buildSiteSlotPlan(
      this.config,
      { ...planInput, domesticRuntimeConfig },
      `slotplan_${randomUUID()}`
    );
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
    await this.applySiteSlotWorkerReportMihomoEvidence(report);
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

  private async applySiteSlotWorkerReportMihomoEvidence(report: SiteSlotWorkerReport): Promise<void> {
    const tlsFingerprint = siteSlotWorkerReportTlsFingerprint(report);
    if (!tlsFingerprint) return;
    const previous = await this.getLauncherNetworkMihomoSite(report.siteId);
    if (!previous || previous.tlsFingerprint === tlsFingerprint) return;
    await this.upsertLauncherNetworkMihomoSite({
      siteId: report.siteId,
      tlsFingerprint,
      requestedBy: report.workerId,
      requestId: `worker-report:${report.reportId}:tls-fingerprint`
    });
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
    const productId = normalizeLauncherNetworkProductId(input.productId);
    const siteId = input.siteId?.trim() || 'domestic-main';
    const lease = await this.enrollLauncherNetworkLease({
      productId,
      mode: launcherNetworkProductIsStandaloneDefault(productId) ? 'standalone' : 'embed',
      identityKind: 'anonymous',
      installId,
      deviceId,
      siteId,
      publicKey: input.publicKey,
      deviceLabel: input.deviceLabel,
      platform: input.platform,
      sourceIp: input.sourceIp,
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
    const snapshot = this.createSnapshot(enrollment, 1, 'visitor');
    await this.saveRecord('anonymous-enrollment', installId, enrollment, siteId);
    await this.saveRecord('config-snapshot', installId, snapshot, siteId);
    await this.recordAudit({
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
        sourceIp: input.sourceIp ?? null,
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
    const lease = await this.enrollLauncherNetworkLease({
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
    const adminCredential = await this.getRecord<UserCenterUserCredential>('iam-user-credential', 'usr_demo_admin');
    const admin = await this.createUserCenterUser({
      userId: 'usr_demo_admin',
      account: 'admin',
      email: 'admin@mx.local',
      displayName: 'MX Demo Admin',
      password: adminCredential ? null : legacyHdoAdminSeed.password,
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
    const demoUserCredential = await this.getRecord<UserCenterUserCredential>('iam-user-credential', 'usr_demo_user');
    const user = await this.createUserCenterUser({
      userId: 'usr_demo_user',
      account: 'user',
      email: 'user@mx.local',
      displayName: 'MX Demo User',
      password: demoUserCredential ? null : 'user-demo-password',
      roleIds: ['mx-user'],
      homeAppId: LEGACY_HDO_HOME_APP_ID,
      registeredByAppId: LEGACY_HDO_HOME_APP_ID,
      allowedAppIds: LEGACY_HDO_ALLOWED_APP_IDS,
      requestId: 'bootstrap-user-center'
    });
    const serviceAccount = await this.createUserCenterServiceAccount({
      serviceAccountId: 'svc_sdk_gateway',
      displayName: 'SDK Gateway',
      roleIds: ['mx-service-account'],
      requestId: 'bootstrap-user-center'
    });
    const legacySeedInput = legacyHdoUserCenterSeedInput();
    const deletionTombstones = await this.listRecords<UserCenterUserDeletionTombstone>('iam-user-deletion-tombstone');
    const deletedAccounts = new Set(deletionTombstones.map((item) => item.account.trim().toLowerCase()));
    const legacyRowsToImport: typeof legacySeedInput.users = [];
    for (const row of legacySeedInput.users) {
      const seedUserInput = normalizeImportUserCenterRow(row, legacySeedInput);
      if (deletedAccounts.has(seedUserInput.account?.trim().toLowerCase() ?? '')) continue;
      const previous = await this.findUserCenterUserForInput(seedUserInput);
      const credential = previous ? await this.getRecord<UserCenterUserCredential>('iam-user-credential', previous.userId) : null;
      if (!legacyHdoSeedUserIsComplete(previous, Boolean(credential))) {
        legacyRowsToImport.push({ ...row, password: credential ? null : row.password });
      }
    }
    const legacyImport = legacyRowsToImport.length > 0
      ? await this.importUserCenterUsers(legacyHdoUserCenterSeedInput(legacyRowsToImport))
      : null;
    return createBootstrapResult(
      await this.listUserCenterRoles(),
      mergeUniqueUserCenterUsers([admin, user, ...(legacyImport?.users ?? [])]),
      [serviceAccount]
    );
  }

  async listUserCenterRoles(): Promise<UserCenterRole[]> {
    return (await this.listRecords<UserCenterRole>('iam-role')).sort((a, b) => a.roleId.localeCompare(b.roleId));
  }

  async listUserCenterUsers(): Promise<UserCenterUser[]> {
    const users = await this.listRecords<UserCenterUser>('iam-user');
    return (await Promise.all(users.map((user) => this.withUserCredentialSummary(user))))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  async listUserCenterUserIdentities(): Promise<UserCenterUserIdentity[]> {
    return (await this.listRecords<UserCenterUser>('iam-user'))
      .map((user) => userCenterUserIdentity(user))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  async createUserCenterUser(input: CreateUserInput): Promise<UserCenterUser> {
    const previous = await this.findUserCenterUserForInput(input);
    const draft = createUserCenterUser(input, previous, previous?.credential ?? emptyUserCredentialSummary());
    const previousCredential = await this.getRecord<UserCenterUserCredential>('iam-user-credential', draft.userId);
    const credential = input.password !== undefined && input.password !== null
      ? createUserCenterUserCredential(draft.userId, input.password, input, previousCredential)
      : previousCredential;
    if (credential) await this.saveRecord('iam-user-credential', credential.userId, credential, this.config.siteId);
    const user = createUserCenterUser(input, previous, userCredentialSummary(credential));
    await this.upsertRecord('iam-user', user.userId, user, this.config.siteId);
    await this.recordAudit({
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
      await this.upsertUserOverseaEntitlement({
        userId: user.userId,
        siteIds,
        requestedBy: input.requestedBy ?? 'user-center',
        requestId: input.requestId
      });
    }
    return user;
  }

  async importUserCenterUsers(input: ImportUserCenterUsersInput): Promise<ImportUserCenterUsersResult> {
    const users: UserCenterUser[] = [];
    const entitlements: UserOverseaEntitlement[] = [];
    const failures: ImportUserCenterUsersResult['failures'] = [];
    let imported = 0;
    let updated = 0;
    for (const [index, row] of input.users.entries()) {
      const account = typeof row.account === 'string' ? row.account : typeof row.user_name === 'string' ? row.user_name : null;
      try {
        const userInput = normalizeImportUserCenterRow(row, input);
        const previous = await this.findUserCenterUserForInput(userInput);
        const user = await this.createUserCenterUser(userInput);
        users.push(user);
        if (previous) updated += 1;
        else imported += 1;
        const siteIds = normalizeEntitlementSiteIds(input.defaultOverseaSiteIds);
        if (input.provisionOversea === true) {
          const entitlement = await this.getUserOverseaEntitlement(user.userId);
          if (entitlement) entitlements.push(entitlement);
        }
      } catch (error) {
        failures.push({
          index,
          account,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
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

  async updateUserCenterPassword(input: UserPasswordUpdateInput): Promise<UserPasswordUpdateResult> {
    const userId = input.userId?.trim();
    if (!userId) throw new Error('userId is required');
    const user = await this.getRecord<UserCenterUser>('iam-user', userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    const password = input.password?.trim();
    if (!password) throw new Error('password is required');
    const now = new Date().toISOString();
    const previousCredential = await this.getRecord<UserCenterUserCredential>('iam-user-credential', userId);
    const credential = createUserCenterUserCredential(userId, password, input, previousCredential, now);
    await this.saveRecord('iam-user-credential', userId, credential, this.config.siteId);
    const tokens = await this.listRecords<UserCenterTokenRecord>('iam-token');
    const activeTokens = tokens.filter((token) => (
      token.subjectKind === 'user' && token.subjectId === userId && !token.revokedAt
    ));
    for (const token of activeTokens) {
      await this.saveRecord('iam-token', token.tokenHash, { ...token, revokedAt: now }, this.config.siteId);
    }
    const updated = {
      ...user,
      credential: userCredentialSummary(credential),
      updatedAt: now
    };
    await this.saveRecord('iam-user', userId, updated, this.config.siteId);
    await this.recordAudit({
      eventType: 'iam.user.password.updated',
      actorKind: 'user-center',
      userId,
      requestId: input.requestId ?? null,
      metadata: {
        requestedBy: input.requestedBy ?? 'user-center',
        tokensRevoked: activeTokens.length
      }
    });
    return { user: updated, tokensRevoked: activeTokens.length, updatedAt: now };
  }

  async deleteUserCenterUser(input: UserCenterUserDeleteInput): Promise<UserCenterUserDeleteResult> {
    const userId = input.userId?.trim();
    if (!userId) throw new Error('userId is required');
    const user = await this.getRecord<UserCenterUser>('iam-user', userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    const users = await this.listUserCenterUsers();
    const protectedReason = userCenterDeleteProtectionReason(user, users);
    if (protectedReason) throw new Error(protectedReason);
    const activeLease = (await this.listRecords<LauncherNetworkLease>('launcher-network-lease'))
      .find((lease) => lease.userId === userId && launcherNetworkLeaseIsActive(lease));
    if (activeLease) throw new Error(`User has an active launcher network lease: ${activeLease.leaseId}`);
    const linkedEnrollment = (await this.listRecords<AnonymousEnrollment>('anonymous-enrollment'))
      .find((enrollment) => enrollment.userId === userId);
    if (linkedEnrollment) throw new Error(`User is linked to device enrollment: ${linkedEnrollment.installId}`);
    const entitlement = await this.getUserOverseaEntitlement(userId);
    if (entitlement?.status === 'active' || entitlement?.siteIds.length) {
      throw new Error('Disable Oversea access before deleting this user');
    }

    const tokens = (await this.listRecords<UserCenterTokenRecord>('iam-token'))
      .filter((token) => token.subjectKind === 'user' && token.subjectId === userId);
    const h2oProfiles = (await this.listRecords<UserH2oRuntimeProfile>('user-h2o-runtime-profile'))
      .filter((profile) => profile.userId === userId);
    const installations = (await this.listRecords<AppCenterInstallation>('app-center-installation'))
      .filter((installation) => installation.userId === userId);
    const grants = (await this.listRecords<PermissionGrant>('permission-grant'))
      .filter((grant) => grant.userId === userId);
    const credential = await this.getRecord<UserCenterUserCredential>('iam-user-credential', userId);
    const deletedAt = new Date().toISOString();
    const tombstone: UserCenterUserDeletionTombstone = {
      tombstoneId: user.account.trim().toLowerCase(),
      userId,
      account: user.account,
      deletedAt,
      requestedBy: input.requestedBy ?? 'user-center'
    };
    const targets: Array<{ kind: RecordKind; id: string }> = [
      ...(credential ? [{ kind: 'iam-user-credential' as const, id: userId }] : []),
      ...tokens.map((token) => ({ kind: 'iam-token' as const, id: token.tokenHash })),
      ...(entitlement ? [{ kind: 'user-oversea-entitlement' as const, id: entitlement.entitlementId }] : []),
      ...h2oProfiles.map((profile) => ({ kind: 'user-h2o-runtime-profile' as const, id: profile.profileId })),
      ...installations.map((installation) => ({ kind: 'app-center-installation' as const, id: installation.installationId })),
      ...grants.map((grant) => ({ kind: 'permission-grant' as const, id: grant.grantId })),
      { kind: 'iam-user', id: userId }
    ];
    await this.dataSource.transaction(async (manager) => {
      const records = manager.getRepository(PlatformRecordEntity);
      for (const target of targets) {
        await records.delete({
          kind: target.kind,
          id: target.id,
          environment: this.config.environment
        });
      }
      await this.saveRecordTo(
        records,
        'iam-user-deletion-tombstone',
        tombstone.tombstoneId,
        tombstone,
        this.config.siteId
      );
    });
    const deletedRecords: UserCenterUserDeleteResult['deletedRecords'] = {
      credential: credential ? 1 : 0,
      tokens: tokens.length,
      overseaEntitlements: entitlement ? 1 : 0,
      h2oRuntimeProfiles: h2oProfiles.length,
      appInstallations: installations.length,
      permissionGrants: grants.length
    };
    await this.recordAudit({
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

  async verifyUserCenterPassword(input: UserPasswordVerificationInput): Promise<UserPasswordVerificationResult> {
    const userId = input.userId?.trim();
    if (!userId) {
      return { userId: '', ok: false, hasPassword: false, reason: 'userId is required' };
    }
    const credential = await this.getRecord<UserCenterUserCredential>('iam-user-credential', userId);
    const hasPassword = Boolean(credential);
    const ok = input.password ? verifyUserCenterCredential(input.password, credential) : false;
    await this.recordAudit({
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

  async consumeAuthenticationRateLimits(
    inputs: AuthenticationRateLimitInput[]
  ): Promise<AuthenticationRateLimitDecision[]> {
    if (inputs.length === 0) return [];
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

    return this.dataSource.transaction(async (manager) => {
      for (const bucketKey of [...bucketKeys].sort()) {
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`${this.config.environment}:authentication-rate-limit:${bucketKey}`]
        );
      }
      const rows = await manager.query(
        `SELECT id, data
         FROM mx_platform_records
         WHERE kind = 'authentication-rate-limit'
           AND environment = $1
           AND id = ANY($2::varchar[])
         FOR UPDATE`,
        [this.config.environment, bucketKeys]
      ) as Array<{ id: string; data: AuthenticationRateLimitState }>;
      const previousByBucket = new Map(rows.map((row) => [row.id, row.data]));
      const decisions = normalizedInputs.map((input) => consumeFixedWindowRateLimit(
        previousByBucket.get(input.bucketKey) ?? null,
        input
      ));

      for (const [index, input] of normalizedInputs.entries()) {
        const decision = decisions[index];
        if (!decision) continue;
        const state: AuthenticationRateLimitState = {
          windowStartedAt: decision.windowStartedAt,
          count: decision.count
        };
        await manager.query(
          `INSERT INTO mx_platform_records (
             kind, id, environment, site_id, data, created_at, updated_at
           )
           VALUES (
             'authentication-rate-limit', $1, $2, $3, $4::jsonb, now(), now()
           )
           ON CONFLICT (kind, id, environment) DO UPDATE
           SET data = EXCLUDED.data,
               site_id = EXCLUDED.site_id,
               updated_at = now()`,
          [
            input.bucketKey,
            this.config.environment,
            this.config.siteId,
            JSON.stringify(state)
          ]
        );
      }
      await manager.query(
        `DELETE FROM mx_platform_records
         WHERE kind = 'authentication-rate-limit'
           AND environment = $1
           AND updated_at < now() - interval '1 day'`,
        [this.config.environment]
      );
      return decisions;
    });
  }

  async listUserOverseaEntitlements(): Promise<UserOverseaEntitlement[]> {
    const entitlements = await this.listRecords<UserOverseaEntitlement>('user-oversea-entitlement');
    return (await Promise.all(entitlements.map((entitlement) => this.withUserOverseaRuntimeSync(entitlement))))
      .sort((a, b) => a.userId.localeCompare(b.userId));
  }

  async getUserOverseaEntitlement(userId: string): Promise<UserOverseaEntitlement | null> {
    const entitlement = await this.getRecord<UserOverseaEntitlement>('user-oversea-entitlement', userOverseaEntitlementId(userId));
    return entitlement ? this.withUserOverseaRuntimeSync(entitlement) : null;
  }

  private async withUserOverseaRuntimeSync(entitlement: UserOverseaEntitlement): Promise<UserOverseaEntitlement> {
    const accounts: UserOverseaEntitlement['accounts'] = [];
    for (const account of entitlement.accounts) {
      const runtimeAccount = await this.getRecord<SiteSlotAccessAccount>('site-slot-access-account', account.accountId);
      const status = runtimeAccount?.status ?? account.status;
      const accountUpdatedAt = runtimeAccount?.updatedAt ?? account.runtimeSync?.accountUpdatedAt ?? entitlement.updatedAt;
      accounts.push({
        ...account,
        status,
        runtimeSync: await this.userOverseaAccountRuntimeSync(entitlement.userId, account.siteId, account.username, status, accountUpdatedAt)
      });
    }
    return { ...entitlement, accounts };
  }

  private async userOverseaAccountRuntimeSync(
    userId: string,
    siteId: string,
    username: string,
    accountStatus: SiteSlotAccessAccount['status'],
    accountUpdatedAt: string
  ): Promise<UserOverseaEntitlement['accounts'][number]['runtimeSync']> {
    const checkedAt = new Date().toISOString();
    const incrementalSync = await this.latestUserOverseaAccountSyncReport(userId, siteId, username);
    const fullSyncAt = await this.latestOverseaAccountSyncAt(siteId);
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

  private async latestUserOverseaAccountSyncReport(
    userId: string,
    siteId: string,
    username: string
  ): Promise<UserOverseaAccountSyncReport | null> {
    return (await this.listRecords<UserOverseaAccountSyncReport>('user-oversea-account-sync-report'))
      .filter((item) => (
        item.userId === userId
        && item.siteId === siteId
        && item.username === username
        && item.status === 'passed'
      ))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  private async latestOverseaAccountSyncAt(siteId: string): Promise<string | null> {
    const report = (await this.listRecords<SiteSlotWorkerReport>('site-slot-worker-report'))
      .filter((item) => (
        item.siteId === siteId
        && item.stepReports.some((step) => step.status === 'passed' && step.sourceId.startsWith('configure-oversea-access'))
      ))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return report?.createdAt ?? null;
  }

  async upsertUserOverseaEntitlement(input: UserOverseaEntitlementInput): Promise<UserOverseaEntitlement> {
    const userId = input.userId?.trim();
    if (!userId) throw new Error('userId is required');
    const entitlement = await this.withUserOverseaEntitlementWriteLock(userId, (manager, records) => (
      this.upsertUserOverseaEntitlementLocked(manager, records, { ...input, userId })
    ));
    return this.withUserOverseaRuntimeSync(entitlement);
  }

  /** Caller must hold the per-user entitlement advisory lock for this transaction. */
  private async upsertUserOverseaEntitlementLocked(
    manager: EntityManager,
    records: Repository<PlatformRecordRow>,
    input: UserOverseaEntitlementInput & { userId: string }
  ): Promise<UserOverseaEntitlement> {
    const userId = input.userId;
    const userRow = await records.findOne({
      where: {
        kind: 'iam-user',
        id: userId,
        environment: this.config.environment
      }
    });
    const user = userRow?.data as UserCenterUser | undefined;
    if (!user) throw new Error(`User not found: ${userId}`);
    const previousRow = await records.findOne({
      where: {
        kind: 'user-oversea-entitlement',
        id: userOverseaEntitlementId(user.userId),
        environment: this.config.environment
      }
    });
    const previous = previousRow?.data as UserOverseaEntitlement | undefined;
    // 省略 siteIds 只表示「不改分配」，不表示「回到平台默认」。
    // H2O 的 ensure-subscription 每次刷新都不带 siteIds，之前落到 defaultUserOverseaSiteIds()
    // 会把 admin 刚指派的站点悄悄改回默认站点，用户看到的仍旧是老节点。
    let effectiveSiteIds: string[];
    if (input.assignmentMode === 'platform-default') {
      const defaultSiteId = await this.defaultUserOverseaSiteId();
      if (!defaultSiteId || !await this.overseaSiteIsServiceable(defaultSiteId)) {
        throw new Error('No serviceable platform default Oversea site is available');
      }
      effectiveSiteIds = [defaultSiteId];
    } else {
      effectiveSiteIds = input.siteIds !== undefined && input.siteIds !== null
        ? normalizeEntitlementSiteIds(input.siteIds)
        : previous
          ? normalizeEntitlementSiteIds(previous.siteIds)
          : await this.defaultUserOverseaSiteIds();
    }
    // Every entitlement writer takes site locks in the same stable order. This
    // keeps a multi-site update atomic without creating cross-user deadlocks.
    for (const siteId of effectiveSiteIds) {
      await this.lockLauncherNetworkMihomoSite(manager, siteId);
    }
    const accounts: UserOverseaEntitlement['accounts'] = [];
    for (const siteId of effectiveSiteIds) {
      const accountName = userOverseaAccountName(user, siteId);
      const issued = await this.issueSiteSlotAccessAccountsTo(records, {
        siteId,
        accountNames: [accountName],
        issueDefaults: false,
        requestedBy: input.requestedBy ?? 'user-center',
        requestId: input.requestId
      });
      const account = issued.accounts[0];
      accounts.push({
        siteId,
        username: account.username,
        accountId: account.accountId,
        status: account.status,
        subscriptionPath: account.subscriptionPath,
        siteSubscriptionUrl: `${issued.site.subscriptionBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(account.username)}.yaml`,
        runtimeSync: await this.userOverseaAccountRuntimeSync(user.userId, account.siteId, account.username, account.status, account.updatedAt)
      });
    }
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
    await this.saveRecordTo(records, 'user-oversea-entitlement', entitlement.entitlementId, entitlement, this.config.siteId);
    await this.recordAuditTo(records, {
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
    return entitlement;
  }

  /**
   * 把一批用户从一个出海站点搬到另一个（例如 oversea-main 退役改作他用）。
   *
   * 默认 dry-run：不带 confirm 就只返回将要发生的变更。真正执行时每个用户走
   * `upsertUserOverseaEntitlement`，所以账号签发、审计、runtimeSync 判定都和
   * admin 手动改一个用户完全一致——这里不另开一条写路径。
   */
  async migrateUserOverseaEntitlements(
    input: UserOverseaEntitlementMigrationInput
  ): Promise<UserOverseaEntitlementMigrationResult> {
    const plan = assertUserOverseaMigrationInput(input);
    if (!await this.overseaSiteIsServiceable(plan.toSiteId)) {
      throw new Error(`Target Oversea site is not serviceable: ${plan.toSiteId}`);
    }
    const entitlements = await this.listUserOverseaEntitlements();
    const planned = planUserOverseaEntitlementMigration(entitlements, plan);
    const applied = input.confirm === true;
    const changes: UserOverseaEntitlementMigrationResult['changes'] = [];
    for (const item of planned) {
      const user = await this.getRecord<UserCenterUser>('iam-user', item.userId);
      const base = { userId: item.userId, account: user?.account ?? item.userId, before: item.before, after: item.after };
      if (!applied) {
        changes.push({ ...base, status: 'planned' });
        continue;
      }
      try {
        const updated = await this.upsertUserOverseaEntitlement({
          userId: item.userId,
          siteIds: item.after,
          requestedBy: input.requestedBy ?? 'oversea-migration',
          requestId: input.requestId ?? null
        });
        changes.push({ ...base, after: updated.siteIds, status: 'migrated' });
      } catch (error) {
        changes.push({ ...base, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const result = buildUserOverseaMigrationResult(plan, applied, entitlements.length, changes);
    await this.recordAudit({
      eventType: 'iam.user_oversea_entitlement.migrated',
      actorKind: 'user-center',
      requestId: input.requestId ?? null,
      metadata: {
        fromSiteId: plan.fromSiteId,
        toSiteId: plan.toSiteId,
        mode: plan.mode,
        applied,
        matched: result.matched,
        changed: result.changed,
        failed: result.failed
      }
    });
    return result;
  }

  async rolloutUserOverseaEntitlements(
    input: UserOverseaEntitlementRolloutInput
  ): Promise<UserOverseaEntitlementRolloutResult> {
    const rollout = assertUserOverseaRolloutInput(input);
    if (!await this.overseaSiteIsServiceable(rollout.toSiteId)) {
      throw new Error(`Target Oversea site is not serviceable: ${rollout.toSiteId}`);
    }
    const users = await this.listUserCenterUsers();
    const activeHumanUsers = users.filter((user) => user.status === 'active' && !user.roleIds.includes('mx-service-account'));
    const applied = input.confirm === true;
    const changes: UserOverseaEntitlementRolloutResult['changes'] = [];
    if (!applied) {
      const planned = planUserOverseaEntitlementRollout(
        users,
        await this.listUserOverseaEntitlements(),
        rollout
      );
      changes.push(...planned.map((item) => ({ ...item, status: 'planned' as const })));
    } else {
      for (const userId of rollout.userIds ?? []) {
        let failureBase = { userId, account: userId, before: [] as string[], after: [] as string[] };
        try {
          const change = await this.withUserOverseaEntitlementWriteLock(userId, async (manager, records) => {
            const userRow = await records.findOne({
              where: {
                kind: 'iam-user',
                id: userId,
                environment: this.config.environment
              }
            });
            const user = userRow?.data as UserCenterUser | undefined;
            const entitlementRow = await records.findOne({
              where: {
                kind: 'user-oversea-entitlement',
                id: userOverseaEntitlementId(userId),
                environment: this.config.environment
              }
            });
            const current = entitlementRow?.data as UserOverseaEntitlement | undefined;
            const before = normalizeEntitlementSiteIds(current?.siteIds ?? []);
            const base = { userId, account: user?.account ?? userId, before, after: before };
            failureBase = base;
            if (!user || user.status !== 'active' || user.roleIds.includes('mx-service-account')) {
              return { ...base, status: 'skipped' as const, reason: 'User is not an active human account' };
            }
            if (before.includes(rollout.toSiteId)) {
              return { ...base, status: 'skipped' as const, reason: 'Target site is already assigned' };
            }

            const after = [...new Set([...before, rollout.toSiteId])].sort();
            // Take every site lock in the same order as ordinary entitlement
            // writes. Archive waits for this transaction and the next user
            // fails closed instead of receiving a retired target.
            for (const siteId of after) {
              await this.lockLauncherNetworkMihomoSite(manager, siteId);
            }
            const targetRow = await records.findOne({
              where: {
                kind: 'launcher-network-mihomo-site',
                id: rollout.toSiteId,
                environment: this.config.environment
              }
            });
            const target = targetRow?.data as LauncherNetworkMihomoSite | undefined;
            const normalizedTarget = target ? normalizeLauncherNetworkMihomoSite(target) : null;
            if (!normalizedTarget || normalizedTarget.status === 'archived' || !normalizedTarget.publicHost) {
              throw new Error(`Target Oversea site is not serviceable: ${rollout.toSiteId}`);
            }

            failureBase = { ...base, after };
            const updated = await this.upsertUserOverseaEntitlementLocked(manager, records, {
              userId,
              siteIds: after,
              requestedBy: input.requestedBy ?? 'oversea-rollout',
              requestId: input.requestId ?? null
            });
            return { ...base, after: updated.siteIds, status: 'migrated' as const };
          });
          changes.push(change);
        } catch (error) {
          changes.push({ ...failureBase, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const result = buildUserOverseaRolloutResult(
      rollout.toSiteId,
      applied,
      applied ? rollout.userIds?.length ?? 0 : activeHumanUsers.length,
      changes
    );
    await this.recordAudit({
      eventType: 'iam.user_oversea_entitlement.rolled_out',
      actorKind: 'user-center',
      requestId: input.requestId ?? null,
      metadata: {
        toSiteId: rollout.toSiteId,
        applied,
        matched: result.matched,
        changed: result.changed,
        skipped: result.skipped,
        failed: result.failed
      }
    });
    return result;
  }

  async recordUserOverseaAccountSyncReport(input: UserOverseaAccountSyncReportInput): Promise<UserOverseaAccountSyncReport> {
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
    await this.saveRecord('user-oversea-account-sync-report', report.reportId, report, siteId);
    await this.recordAudit({
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

  async listUserOverseaAccountSyncReports(userId?: string | null, siteId?: string | null): Promise<UserOverseaAccountSyncReport[]> {
    return (await this.listRecords<UserOverseaAccountSyncReport>('user-oversea-account-sync-report'))
      .filter((item) => (!userId || item.userId === userId) && (!siteId || item.siteId === siteId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Issue (or rotate) the public subscription link for a user.
   *
   * Previous links are revoked in the same pass: a rotation that left the old URL
   * working would give a leaked link unlimited life, which is the main thing an
   * admin rotates to stop.
   */
  async issueUserOverseaSubscriptionLink(
    userId: string,
    options: { requestedBy?: string | null; requestId?: string | null } = {}
  ): Promise<{ token: string; path: string; record: UserCenterTokenRecord }> {
    const user = await this.getRecord<UserCenterUser>('iam-user', userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    const revoked = await this.revokeUserOverseaSubscriptionLink(userId, { silent: true });
    const token = `mx-v1-${randomBytes(24).toString('base64url')}`;
    const issued = createUserCenterTokenRecord(this.config, {
      subjectKind: 'user',
      subjectId: user.userId,
      audience: USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE,
      scopes: [USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE],
      ttlSeconds: USER_OVERSEA_SUBSCRIPTION_LINK_TTL_SECONDS
    }, token);
    await this.saveRecord('iam-token', issued.record.tokenHash, issued.record, this.config.siteId);
    await this.recordAudit({
      eventType: 'auth.oversea_subscription_link.issued',
      actorKind: 'user',
      userId: user.userId,
      requestId: options.requestId ?? null,
      // The token itself is never audited; only its id and what it replaced.
      metadata: { tokenId: issued.record.tokenId, revokedPrevious: revoked, requestedBy: options.requestedBy ?? null }
    });
    return { token, path: userOverseaSubscriptionLinkPath(token), record: issued.record };
  }

  async revokeUserOverseaSubscriptionLink(
    userId: string,
    options: { silent?: boolean; requestId?: string | null } = {}
  ): Promise<number> {
    const now = new Date().toISOString();
    const tokens = (await this.listRecords<UserCenterTokenRecord>('iam-token')).filter((token) => (
      token.subjectKind === 'user'
      && token.subjectId === userId
      && token.audience === USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE
      && !token.revokedAt
    ));
    for (const token of tokens) {
      await this.saveRecord('iam-token', token.tokenHash, { ...token, revokedAt: now }, this.config.siteId);
    }
    if (tokens.length > 0 && options.silent !== true) {
      await this.recordAudit({
        eventType: 'auth.oversea_subscription_link.revoked',
        actorKind: 'user',
        userId,
        requestId: options.requestId ?? null,
        metadata: { revoked: tokens.length }
      });
    }
    return tokens.length;
  }

  /** Metadata only -- the plaintext token exists solely in the URL the admin copied. */
  async describeUserOverseaSubscriptionLink(userId: string): Promise<{ issuedAt: string; expiresAt: string } | null> {
    const token = (await this.listRecords<UserCenterTokenRecord>('iam-token'))
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

  /**
   * Resolve a public subscription token to its owner.
   *
   * Deliberately narrow: a token minted for any other audience or scope -- a login
   * token above all -- must not be usable here even though it is a valid token.
   */
  async resolveUserOverseaSubscriptionLink(token: string): Promise<string | null> {
    if (!isUserOverseaSubscriptionLinkToken(token)) return null;
    const record = await this.getRecord<UserCenterTokenRecord>('iam-token', hashToken(token));
    if (!record || record.revokedAt) return null;
    if (record.audience !== USER_OVERSEA_SUBSCRIPTION_LINK_AUDIENCE) return null;
    if (!record.scopes.includes(USER_OVERSEA_SUBSCRIPTION_LINK_SCOPE)) return null;
    if (record.subjectKind !== 'user') return null;
    if (Date.parse(record.expiresAt) <= Date.now()) return null;
    const user = await this.getRecord<UserCenterUser>('iam-user', record.subjectId);
    if (!user || user.status !== 'active') return null;
    return record.subjectId;
  }

  async renderUserOverseaMihomoSubscription(userId: string): Promise<UserOverseaSubscriptionRender | null> {
    const user = await this.getRecord<UserCenterUser>('iam-user', userId);
    const entitlement = await this.getUserOverseaEntitlement(userId);
    if (!user || user.status !== 'active' || !entitlement || entitlement.status !== 'active') return null;
    const entries = [];
    for (const accountRef of entitlement.accounts) {
      const site = await this.getLauncherNetworkMihomoSite(accountRef.siteId);
      const account = await this.getSiteSlotAccessAccount(accountRef.siteId, accountRef.username);
      if (site && account) entries.push({ site, account });
    }
    if (!entries.length) return null;
    return renderUserOverseaMihomoSubscription(
      user,
      entitlement,
      orderOverseaSubscriptionEntries(entries, await this.defaultUserOverseaSiteId())
    );
  }

  async getUserH2oRuntimeProfile(userId: string, appId = 'h2o'): Promise<UserH2oRuntimeProfile | null> {
    return this.getRecord<UserH2oRuntimeProfile>('user-h2o-runtime-profile', userH2oRuntimeProfileId(userId, appId));
  }

  async upsertUserH2oRuntimeProfile(input: UserH2oRuntimeProfileInput): Promise<UserH2oRuntimeProfile> {
    const userId = input.userId?.trim();
    const user = userId ? await this.getRecord<UserCenterUser>('iam-user', userId) : null;
    if (!userId || !user) throw new Error(`User not found: ${userId || '<missing>'}`);
    const appId = input.appId?.trim() || 'h2o';
    const previous = await this.getUserH2oRuntimeProfile(userId, appId);
    const profile = buildUserH2oRuntimeProfile(input, previous);
    await this.saveRecord('user-h2o-runtime-profile', profile.profileId, profile, this.config.siteId);
    await this.recordAudit({
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
        allowedProductIds: serviceAccount.allowedProductIds ?? [],
        status: serviceAccount.status
      }
    });
    return serviceAccount;
  }

  async listUserCenterServiceAccountCredentialStatuses(): Promise<UserCenterServiceAccountCredentialStatus[]> {
    return (await this.listRecords<UserCenterServiceAccountCredential>('iam-service-account-credential'))
      .map(summarizeUserCenterServiceAccountCredential)
      .sort((a, b) => a.serviceAccountId.localeCompare(b.serviceAccountId));
  }

  async getUserCenterServiceAccountCredential(
    serviceAccountId: string
  ): Promise<UserCenterServiceAccountCredentialStatus | null> {
    const credential = await this.getServiceAccountCredentialRecord(serviceAccountId);
    return credential ? summarizeUserCenterServiceAccountCredential(credential) : null;
  }

  async issueUserCenterServiceAccountCredential(
    input: IssueServiceAccountCredentialInput
  ): Promise<UserCenterIssuedServiceAccountCredential> {
    const serviceAccountId = input.serviceAccountId?.trim() || '';
    if (!serviceAccountId) throw new Error('serviceAccountId is required');
    const result = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [`mx-launcher:${this.config.environment}:service-account-credential`, serviceAccountId]
      );
      const records = manager.getRepository(PlatformRecordEntity);
      const serviceAccountRow = await records.findOne({
        where: {
          kind: 'iam-service-account',
          id: serviceAccountId,
          environment: this.config.environment
        }
      });
      const serviceAccount = serviceAccountRow?.data as UserCenterServiceAccount | undefined;
      if (!serviceAccount) throw new Error(`Service account not found: ${serviceAccountId}`);
      if (serviceAccount.status !== 'active') throw new Error(`Service account is disabled: ${serviceAccountId}`);
      const credentialId = userCenterServiceAccountCredentialId(serviceAccountId);
      const credentialRow = await records.findOne({
        where: {
          kind: 'iam-service-account-credential',
          id: credentialId,
          environment: this.config.environment
        }
      });
      const previous = credentialRow?.data as UserCenterServiceAccountCredential | undefined;
      if (previous && previous.serviceAccountId !== serviceAccountId) {
        throw new Error(`Service account credential id collision: ${credentialId}`);
      }
      const issued = issueUserCenterServiceAccountCredential(input, previous ?? null);
      await this.saveRecordTo(
        records,
        'iam-service-account-credential',
        issued.credential.credentialId,
        issued.credential,
        this.config.siteId
      );
      await this.revokeServiceAccountTokensTo(records, serviceAccountId);
      await this.recordAuditTo(records, {
        eventType: 'iam.service_account.credential.issued',
        actorKind: 'user-center',
        requestId: input.requestId ?? null,
        metadata: {
          serviceAccountId,
          credentialId: issued.credential.credentialId,
          version: issued.credential.version,
          rotated: issued.credential.version > 1,
          requestedBy: input.requestedBy?.trim() || 'user-center'
        }
      });
      return issued;
    });
    return result.issued;
  }

  async verifyUserCenterServiceAccountCredential(
    input: VerifyServiceAccountCredentialInput
  ): Promise<UserCenterServiceAccountCredentialVerificationResult> {
    const serviceAccountId = input.serviceAccountId?.trim() || '';
    const serviceAccount = serviceAccountId
      ? await this.getRecord<UserCenterServiceAccount>('iam-service-account', serviceAccountId)
      : null;
    if (!serviceAccount) {
      return { serviceAccountId, ok: false, reason: 'service-account-not-found' };
    }
    if (serviceAccount.status !== 'active') {
      return { serviceAccountId, ok: false, reason: 'service-account-disabled' };
    }
    const credential = await this.getServiceAccountCredentialRecord(serviceAccountId);
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

  async importLegacyUserCenterServiceAccountCredential(
    input: ImportLegacyServiceAccountCredentialInput
  ): Promise<UserCenterServiceAccountCredentialImportResult> {
    const serviceAccountId = input.serviceAccountId?.trim() || '';
    const clientSecret = input.clientSecret ?? '';
    if (!serviceAccountId) throw new Error('serviceAccountId is required');
    const result = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [`mx-launcher:${this.config.environment}:service-account-credential`, serviceAccountId]
      );
      const records = manager.getRepository(PlatformRecordEntity);
      const serviceAccountRow = await records.findOne({
        where: {
          kind: 'iam-service-account',
          id: serviceAccountId,
          environment: this.config.environment
        }
      });
      const serviceAccount = serviceAccountRow?.data as UserCenterServiceAccount | undefined;
      if (!serviceAccount) throw new Error(`Service account not found: ${serviceAccountId}`);
      if (serviceAccount.status !== 'active') {
        throw new Error(`Service account is disabled: ${serviceAccountId}`);
      }
      const credentialId = userCenterServiceAccountCredentialId(serviceAccountId);
      const credentialRow = await records.findOne({
        where: {
          kind: 'iam-service-account-credential',
          id: credentialId,
          environment: this.config.environment
        }
      });
      const previous = credentialRow?.data as UserCenterServiceAccountCredential | undefined;
      if (previous && previous.serviceAccountId !== serviceAccountId) {
        throw new Error(`Service account credential id collision: ${credentialId}`);
      }
      if (previous) {
        return {
          outcome: 'preserved' as const,
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
      await this.saveRecordTo(
        records,
        'iam-service-account-credential',
        credential.credentialId,
        credential,
        this.config.siteId
      );
      await this.recordAuditTo(records, {
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
        outcome: 'imported' as const,
        credential: summarizeUserCenterServiceAccountCredential(credential)
      };
    });
    return result;
  }

  async issueUserCenterToken(input: IssueTokenInput): Promise<UserCenterIssuedToken> {
    if (input.subjectKind === 'service-account') {
      return this.issueServiceAccountTokenWithLifecycleLock(input);
    }
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
        authProvider: issued.record.authProvider ?? null,
        expiresAt: issued.record.expiresAt
      }
    });
    return issued;
  }

  private async issueServiceAccountTokenWithLifecycleLock(
    input: IssueTokenInput
  ): Promise<UserCenterIssuedToken> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [`mx-launcher:${this.config.environment}:service-account-credential`, input.subjectId]
      );
      const records = manager.getRepository(PlatformRecordEntity);
      const serviceAccountRow = await records.findOne({
        where: {
          kind: 'iam-service-account',
          id: input.subjectId,
          environment: this.config.environment
        }
      });
      const serviceAccount = serviceAccountRow?.data as UserCenterServiceAccount | undefined;
      if (!serviceAccount || serviceAccount.status !== 'active') {
        throw new Error(`Unknown token subject: service-account:${input.subjectId}`);
      }
      if (
        input.serviceAccountClientSecret
        || Number.isInteger(input.serviceAccountCredentialVersion)
      ) {
        const credentialRow = await records.findOne({
          where: {
            kind: 'iam-service-account-credential',
            id: userCenterServiceAccountCredentialId(input.subjectId),
            environment: this.config.environment
          }
        });
        const credential = credentialRow?.data as UserCenterServiceAccountCredential | undefined;
        if (
          Number.isInteger(input.serviceAccountCredentialVersion)
          && (credential?.version ?? 0) !== input.serviceAccountCredentialVersion
        ) {
          throw new Error('Service account credential changed during authentication');
        }
        if (
          input.serviceAccountClientSecret
          && (
            !credential
            || credential.serviceAccountId !== input.subjectId
            || !verifyUserCenterServiceAccountSecret(input.serviceAccountClientSecret, credential)
          )
        ) {
          throw new Error('Service account credential changed during authentication');
        }
      }
      const roles = await this.listRecordsFrom<UserCenterRole>(records, 'iam-role');
      const principal = createServiceAccountPrincipalFromRecord(serviceAccount, roles);
      const requestedScopes = input.scopes?.length ? input.scopes : principal.scopes;
      const allowedScopes = requestedScopes.filter((scope) => principal.scopes.includes(scope));
      const token = `mx-v1-${randomBytes(24).toString('base64url')}`;
      const issued = createUserCenterTokenRecord(this.config, {
        ...input,
        scopes: allowedScopes
      }, token);
      await this.saveRecordTo(
        records,
        'iam-token',
        issued.record.tokenHash,
        issued.record,
        this.config.siteId
      );
      await this.recordAuditTo(records, {
        eventType: 'auth.token.issued',
        actorKind: 'service-account',
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
    });
  }

  async createFeishuAuthorizationTransaction(
    input: FeishuAuthorizationTransactionInput
  ): Promise<FeishuAuthorizationTransaction> {
    const rows = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM mx_platform_records
         WHERE kind = 'feishu-authorization-transaction'
           AND environment = $1
           AND NULLIF(data ->> 'expiresAt', '')::timestamptz <= now()`,
        [this.config.environment]
      );
      return manager.query(
        `INSERT INTO mx_platform_records (
           kind, id, environment, site_id, data, created_at, updated_at
         )
         VALUES (
           'feishu-authorization-transaction', $1, $2, $3, $4::jsonb, now(), now()
         )
         ON CONFLICT (kind, id, environment) DO NOTHING
         RETURNING data`,
        [
          input.transactionId,
          this.config.environment,
          this.config.siteId,
          JSON.stringify(input)
        ]
      ) as Promise<Array<{ data: FeishuAuthorizationTransaction }>>;
    });
    const transaction = rows[0]?.data;
    if (!transaction) throw new Error('Feishu authorization transaction already exists');
    return transaction;
  }

  async consumeFeishuAuthorizationTransaction(
    transactionId: string
  ): Promise<FeishuAuthorizationTransaction | null> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query(
        `SELECT data
         FROM mx_platform_records
         WHERE kind = 'feishu-authorization-transaction'
           AND id = $1
           AND environment = $2
         FOR UPDATE`,
        [transactionId, this.config.environment]
      ) as Array<{ data: FeishuAuthorizationTransaction }>;
      const transaction = rows[0]?.data ?? null;
      if (!transaction) return null;
      if (Date.parse(transaction.expiresAt) <= Date.now()) {
        await manager.query(
          `DELETE FROM mx_platform_records
           WHERE kind = 'feishu-authorization-transaction'
             AND id = $1
             AND environment = $2`,
          [transactionId, this.config.environment]
        );
        return null;
      }
      if (transaction.consumedAt) return transaction;
      await manager.query(
        `UPDATE mx_platform_records
         SET data = data || $3::jsonb,
             updated_at = now()
         WHERE kind = 'feishu-authorization-transaction'
           AND id = $1
           AND environment = $2`,
        [
          transactionId,
          this.config.environment,
          JSON.stringify({ consumedAt: new Date().toISOString() })
        ]
      );
      return transaction;
    });
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
    const routeDecision = evaluateSdkGatewayRoute(introspection.principal, input.routeId);
    const appAccess = input.appId
      ? await this.evaluateAppCenterAccess({
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
        appId: input.appId ?? null,
        appAccessAllowed: appAccess?.allowed ?? null,
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
    const appAccess = await this.evaluateAppCenterAccess({
      appId,
      userId: principalContext.principal.userId ?? enrollment?.userId ?? input.userId ?? null,
      sourceAppId: input.sourceAppId,
      includeHidden: true,
      includeDisabled: false,
      requestId: input.requestId
    });
    const launcherNetwork = await this.createLauncherNetworkSnapshot({
      installId: enrollment?.installId ?? input.installId ?? undefined,
      deviceId: enrollment?.deviceId ?? input.deviceId ?? undefined,
      siteId: enrollment?.siteId ?? undefined,
      userId: principalContext.principal.userId ?? enrollment?.userId ?? input.userId ?? null,
      publicKey: enrollment?.publicKey ?? null,
      appId: enrollment?.productId ?? appId,
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
      app: appAccess.allowed ? app : null,
      appAccess,
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

  async listSecretProviderConfigs(): Promise<SecretProviderConfig[]> {
    const providers = await this.listRecords<SecretProviderConfig>('secret-provider-config');
    return providers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSecretProviderConfig(providerId: string): Promise<SecretProviderConfig | null> {
    return this.getRecord<SecretProviderConfig>('secret-provider-config', providerId);
  }

  async upsertSecretProviderConfig(input: SecretProviderConfigInput): Promise<SecretProviderConfig> {
    const previous = input.providerId ? await this.getSecretProviderConfig(input.providerId) : null;
    const provider = buildSecretProviderConfig(this.config, input, previous);
    await this.saveRecord('secret-provider-config', provider.providerId, provider, this.config.siteId);
    await this.recordAudit({
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

  async listConfigSecretReferences(): Promise<ConfigSecretReference[]> {
    const references = await this.listRecords<ConfigSecretReference>('config-secret-reference');
    return references.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConfigSecretReference(secretRefId: string): Promise<ConfigSecretReference | null> {
    return this.getRecord<ConfigSecretReference>('config-secret-reference', secretRefId);
  }

  async upsertConfigSecretReference(input: ConfigSecretReferenceInput): Promise<ConfigSecretReference> {
    const previous = input.secretRefId ? await this.getConfigSecretReference(input.secretRefId) : null;
    const providerId = input.providerId?.trim() || previous?.providerId || '';
    const provider = providerId ? await this.getSecretProviderConfig(providerId) : null;
    const reference = buildConfigSecretReference(this.config, input, previous, Boolean(provider));
    await this.saveRecord('config-secret-reference', reference.secretRefId, reference, this.config.siteId);
    await this.recordAudit({
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

  async listSiteSlotDomesticRuntimeConfigs(): Promise<SiteSlotDomesticRuntimeConfig[]> {
    const configs = await this.listRecords<SiteSlotDomesticRuntimeConfig>('site-slot-domestic-runtime-config');
    return configs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSiteSlotDomesticRuntimeConfig(siteId: string): Promise<SiteSlotDomesticRuntimeConfig | null> {
    return this.getRecord<SiteSlotDomesticRuntimeConfig>('site-slot-domestic-runtime-config', siteId);
  }

  async upsertSiteSlotDomesticRuntimeConfig(input: SiteSlotDomesticRuntimeConfigInput): Promise<SiteSlotDomesticRuntimeConfig> {
    const siteId = input.siteId?.trim() || 'domestic-main';
    const previous = await this.getSiteSlotDomesticRuntimeConfig(siteId);
    const config = buildSiteSlotDomesticRuntimeConfig(this.config, input, previous);
    await this.saveRecord('site-slot-domestic-runtime-config', config.siteId, config, config.siteId);
    await this.recordAudit({
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

  async listSiteSlotDomesticWireGuardSecrets(): Promise<SiteSlotDomesticWireGuardSecret[]> {
    const secrets = await this.listRecords<SiteSlotDomesticWireGuardSecret>('site-slot-domestic-wg-secret');
    return secrets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSiteSlotDomesticWireGuardSecret(siteId: string): Promise<SiteSlotDomesticWireGuardSecret | null> {
    return this.getRecord<SiteSlotDomesticWireGuardSecret>('site-slot-domestic-wg-secret', siteId);
  }

  async upsertSiteSlotDomesticWireGuardSecret(input: SiteSlotDomesticWireGuardSecretInput): Promise<SiteSlotDomesticWireGuardSecret> {
    const siteId = input.siteId?.trim() || 'domestic-main';
    const previous = await this.getSiteSlotDomesticWireGuardSecret(siteId);
    const secret = buildSiteSlotDomesticWireGuardSecret(this.config, input, previous);
    await this.saveRecord('site-slot-domestic-wg-secret', secret.siteId, secret, secret.siteId);
    await this.recordAudit({
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

  async listSiteSlotInternalServicePeerObservations(
    planId?: string | null
  ): Promise<SiteSlotInternalServicePeerObservation[]> {
    const observations = await this.listRecords<SiteSlotInternalServicePeerObservation>(
      'site-slot-internal-service-peer-observation'
    );
    return observations
      .filter((observation) => !planId || observation.planId === planId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  async getSiteSlotInternalServicePeerObservation(
    planId: string
  ): Promise<SiteSlotInternalServicePeerObservation | null> {
    return this.getRecord<SiteSlotInternalServicePeerObservation>(
      'site-slot-internal-service-peer-observation',
      planId
    );
  }

  async upsertSiteSlotInternalServicePeerObservation(
    input: SiteSlotInternalServicePeerObservationInput
  ): Promise<SiteSlotInternalServicePeerObservation> {
    const observation = buildSiteSlotInternalServicePeerObservation(input);
    const rows = await this.dataSource.query(
      `INSERT INTO mx_platform_records (
         kind, id, environment, site_id, data, created_at, updated_at
       )
       VALUES (
         'site-slot-internal-service-peer-observation', $1, $2, $3, $4::jsonb, now(), now()
       )
       ON CONFLICT (kind, id, environment) DO UPDATE
       SET data = EXCLUDED.data,
           site_id = EXCLUDED.site_id,
           updated_at = now()
       WHERE (mx_platform_records.data->>'checkedAt') IS NULL
          OR (
            (EXCLUDED.data->>'checkedAt') IS NOT NULL
            AND (EXCLUDED.data->>'checkedAt') >= (mx_platform_records.data->>'checkedAt')
          )
       RETURNING data`,
      [
        observation.planId,
        this.config.environment,
        observation.siteId,
        JSON.stringify(observation)
      ]
    ) as Array<{ data: SiteSlotInternalServicePeerObservation }>;
    const persisted = rows[0]?.data
      ?? await this.getSiteSlotInternalServicePeerObservation(observation.planId)
      ?? observation;
    if (persisted.recordedAt === observation.recordedAt) {
      await this.recordAudit({
        eventType: 'site_slot.internal_service_peer.observed',
        actorKind: 'admin-action',
        siteId: observation.siteId,
        requestId: null,
        metadata: { ...observation }
      });
    }
    return persisted;
  }

  async issueSiteSlotAccessAccounts(input: SiteSlotAccessAccountIssueInput): Promise<SiteSlotAccessAccountIssueResult> {
    const siteId = input.siteId?.trim() || 'oversea-main';
    return this.withLauncherNetworkMihomoSiteWriteLock(siteId, (records) => (
      this.issueSiteSlotAccessAccountsTo(records, { ...input, siteId })
    ));
  }

  /** Caller must hold the site advisory lock in the transaction backing records. */
  private async issueSiteSlotAccessAccountsTo(
    records: Repository<PlatformRecordRow>,
    input: SiteSlotAccessAccountIssueInput & { siteId: string }
  ): Promise<SiteSlotAccessAccountIssueResult> {
    const siteId = input.siteId;
    const site = await this.upsertLauncherNetworkMihomoSiteTo(records, {
      siteId,
      publicHost: input.publicHost,
      serverPorts: input.serverPorts,
      tlsFingerprint: input.tlsFingerprint,
      requestedBy: input.requestedBy,
      requestId: input.requestId
    });
    const accountNames = resolveIssueAccountNames(input, siteId);
    const accounts: SiteSlotAccessAccount[] = [];
    for (const username of accountNames) {
      const accountId = `slotacct_${siteId}_${username}`.replace(/[^a-zA-Z0-9._-]/g, '_');
      const previousRow = await records.findOne({
        where: {
          kind: 'site-slot-access-account',
          id: accountId,
          environment: this.config.environment
        }
      });
      const previous = previousRow?.data as SiteSlotAccessAccount | undefined;
      const built = buildSiteSlotAccessAccount(this.config, {
        siteId,
        username,
        authToken: previous?.authToken || randomBytes(24).toString('base64url'),
        requestedBy: input.requestedBy
      }, previous ?? null);
      // Only the explicit unarchive mutation may reactivate a paused account.
      // This keeps a retired/offline migration source out of user subscriptions
      // while entitlement updates add and sync its replacement.
      const account: SiteSlotAccessAccount = site.status === 'archived'
        ? {
            ...built,
            status: 'paused',
            updatedBy: previous?.updatedBy ?? built.updatedBy,
            updatedAt: previous?.updatedAt ?? built.updatedAt
          }
        : built;
      await this.saveRecordTo(records, 'site-slot-access-account', account.accountId, account, account.siteId);
      accounts.push(account);
    }
    await this.recordAuditTo(records, {
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

  async listSiteSlotAccessAccounts(siteId: string): Promise<SiteSlotAccessAccount[]> {
    return (await this.listRecords<SiteSlotAccessAccount>('site-slot-access-account'))
      .filter((account) => account.siteId === siteId)
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async getSiteSlotAccessAccount(siteId: string, username: string): Promise<SiteSlotAccessAccount | null> {
    const accounts = await this.listSiteSlotAccessAccounts(siteId);
    return accounts.find((account) => account.username === username) ?? null;
  }

  async upsertLauncherNetworkMihomoSite(input: LauncherNetworkMihomoSiteInput): Promise<LauncherNetworkMihomoSite> {
    const siteId = input.siteId?.trim() || 'oversea-main';
    return this.withLauncherNetworkMihomoSiteWriteLock(siteId, (records) => (
      this.upsertLauncherNetworkMihomoSiteTo(records, { ...input, siteId })
    ));
  }

  private async upsertLauncherNetworkMihomoSiteTo(
    records: Repository<PlatformRecordRow>,
    input: LauncherNetworkMihomoSiteInput
  ): Promise<LauncherNetworkMihomoSite> {
    const siteId = input.siteId?.trim() || 'oversea-main';
    const previousRow = await records.findOne({
      where: {
        kind: 'launcher-network-mihomo-site',
        id: siteId,
        environment: this.config.environment
      }
    });
    const storedPrevious = previousRow?.data as LauncherNetworkMihomoSite | undefined;
    const previous = storedPrevious ? normalizeLauncherNetworkMihomoSite(storedPrevious) : null;
    const latestPlan = await this.latestSiteSlotPlanForSite(siteId, records);
    const site = buildLauncherNetworkMihomoSite(this.config, input, previous, latestPlan?.host ?? null);
    await this.saveRecordTo(records, 'launcher-network-mihomo-site', site.siteId, site, site.siteId);
    await this.recordAuditTo(records, {
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

  /**
   * 归档/恢复一台 oversea 机器。
   *
   * 关键点：不去逐个改用户 entitlement，而是把该站点下所有 access account 置为
   * paused —— `renderUserOverseaMihomoSubscription` 只收 active 账号，所以节点会
   * 自动从每个用户的 subscription.yaml 里消失，用户下次刷新订阅就看不到它了。
   * entitlement 本身保留，恢复站点时账号重新 active，订阅自动恢复。
   */
  async archiveLauncherNetworkMihomoSite(
    input: LauncherNetworkMihomoSiteArchiveInput
  ): Promise<LauncherNetworkMihomoSiteArchiveResult> {
    const siteId = input.siteId?.trim();
    if (!siteId) throw new Error('siteId is required');
    return this.withLauncherNetworkMihomoSiteWriteLock(siteId, async (records) => {
      const previousRow = await records.findOne({
        where: {
          kind: 'launcher-network-mihomo-site',
          id: siteId,
          environment: this.config.environment
        }
      });
      const storedPrevious = previousRow?.data as LauncherNetworkMihomoSite | undefined;
      if (!storedPrevious) throw new Error(`Launcher Network mihomo site not found: ${siteId}`);
      const previous = normalizeLauncherNetworkMihomoSite(storedPrevious);
      const requestedBy = input.requestedBy?.trim() || 'internal';
      const now = new Date().toISOString();
      const site = applyLauncherNetworkMihomoSiteArchive(previous, input.archived, requestedBy, now);
      await this.saveRecordTo(records, 'launcher-network-mihomo-site', site.siteId, site, site.siteId);

      const accounts = (await this.listRecordsFrom<SiteSlotAccessAccount>(records, 'site-slot-access-account'))
        .filter((account) => account.siteId === siteId);
      const nextStatus = input.archived ? 'paused' : 'active';
      const changed: SiteSlotAccessAccount[] = [];
      for (const account of accounts) {
        if (account.status === nextStatus) continue;
        const updated: SiteSlotAccessAccount = { ...account, status: nextStatus, updatedBy: requestedBy, updatedAt: now };
        await this.saveRecordTo(records, 'site-slot-access-account', updated.accountId, updated, updated.siteId);
        changed.push(updated);
      }

      const entitlements = await this.listRecordsFrom<UserOverseaEntitlement>(records, 'user-oversea-entitlement');
      const affectedUserIds = [...new Set(entitlements
        .filter((entitlement) => entitlement.siteIds.includes(siteId))
        .map((entitlement) => entitlement.userId))];

      await this.recordAuditTo(records, {
        eventType: input.archived
          ? 'launcher_network.mihomo_site.archived'
          : 'launcher_network.mihomo_site.unarchived',
        actorKind: 'config-center',
        requestId: input.requestId ?? null,
        metadata: {
          siteId: site.siteId,
          archivedBy: requestedBy,
          accountsChanged: changed.length,
          affectedUserIds
        }
      });

      return {
        site,
        pausedAccounts: input.archived ? changed : [],
        reactivatedAccounts: input.archived ? [] : changed,
        affectedUserIds
      };
    });
  }

  async getLauncherNetworkMihomoSite(siteId: string): Promise<LauncherNetworkMihomoSite | null> {
    const site = await this.getRecord<LauncherNetworkMihomoSite>('launcher-network-mihomo-site', siteId);
    return site ? normalizeLauncherNetworkMihomoSite(site) : null;
  }

  async listLauncherNetworkMihomoSites(): Promise<LauncherNetworkMihomoSite[]> {
    return (await this.listRecords<LauncherNetworkMihomoSite>('launcher-network-mihomo-site'))
      .map((site) => normalizeLauncherNetworkMihomoSite(site))
      .sort((a, b) => a.siteId.localeCompare(b.siteId));
  }

  async getLauncherNetworkMihomoReachability(siteId: string): Promise<LauncherNetworkReachabilityPlan | null> {
    const site = await this.getLauncherNetworkMihomoSite(siteId);
    if (!site) return null;
    return buildLauncherNetworkReachabilityPlan(site, await this.listSiteSlotAccessAccounts(siteId));
  }

  async listLauncherProductNetworks(): Promise<LauncherProductNetwork[]> {
    const products = await this.listRecords<LauncherProductNetwork>('launcher-product-network');
    return products.sort((a, b) => a.mode.localeCompare(b.mode) || a.productIndex - b.productIndex || a.productId.localeCompare(b.productId));
  }

  async getLauncherProductNetwork(productId: string): Promise<LauncherProductNetwork | null> {
    return this.getRecord<LauncherProductNetwork>('launcher-product-network', productId.trim().toLowerCase());
  }

  async upsertLauncherProductNetwork(input: LauncherProductNetworkInput): Promise<LauncherProductNetwork> {
    const productId = input.productId?.trim().toLowerCase();
    if (!productId) throw new Error('Launcher product network requires productId');
    const product = await this.dataSource.transaction(async (manager) => {
      await this.lockLauncherProductNetwork(manager, productId);
      const records = manager.getRepository(PlatformRecordEntity);
      const products = await this.listRecordsFrom<LauncherProductNetwork>(records, 'launcher-product-network');
      const previous = products.find((candidate) => candidate.productId === productId) ?? null;
      const next = buildLauncherProductNetwork(this.config, input, previous);
      assertLauncherProductLeaseIsolation(next, products);
      if (next.mode === 'embed') {
        const channel = products.find((candidate) => candidate.productId === next.standaloneChannelProductId);
        if (!channel || channel.mode !== 'standalone' || !channel.enabled) {
          throw new Error(`Embed product ${next.productId} requires an enabled launcher standalone channel: ${next.standaloneChannelProductId}`);
        }
      }
      await this.saveRecordTo(records, 'launcher-product-network', next.productId, next, this.config.siteId);
      return next;
    });
    await this.recordAudit({
      eventType: 'launcher_network.product_network.upserted',
      actorKind: 'config-center',
      productId: product.productId,
      requestId: input.requestId ?? null,
      metadata: {
        mode: product.mode,
        networkScope: product.networkScope,
        standaloneChannelProductId: product.standaloneChannelProductId,
        serviceVip: product.serviceVip,
        userCidr: product.userCidr,
        feishuCidr: product.feishuCidr,
        anonymousCidr: product.anonymousCidr,
        userLeaseRange: [product.userLeaseStart, product.userLeaseEnd],
        feishuLeaseRange: [product.feishuLeaseStart, product.feishuLeaseEnd],
        anonymousLeaseRange: [product.anonymousLeaseStart, product.anonymousLeaseEnd],
        updatePolicy: product.updatePolicy,
        anonymousEnrollmentPolicy: product.anonymousEnrollmentPolicy,
        anonymousUiVisibility: product.anonymousUiVisibility
      }
    });
    return product;
  }

  async listLauncherProductUserAccess(
    productId?: string | null
  ): Promise<LauncherProductUserAccess[]> {
    const normalizedProductId = productId?.trim()
      ? normalizeLauncherNetworkProductId(productId)
      : null;
    const entries = await this.listRecords<LauncherProductUserAccess>('launcher-product-user-access');
    return entries
      .filter((access) => !normalizedProductId || access.productId === normalizedProductId)
      .sort((left, right) => left.productId.localeCompare(right.productId) || left.userId.localeCompare(right.userId));
  }

  async getLauncherProductUserAccess(
    productId: string,
    userId: string
  ): Promise<LauncherProductUserAccess | null> {
    return this.getRecord<LauncherProductUserAccess>(
      'launcher-product-user-access',
      launcherProductUserAccessId(productId, userId)
    );
  }

  private async backfillLegacyLauncherProductUserAccess(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [
          `mx-launcher:${this.config.environment}:launcher-product-user-access`,
          'legacy-audit-backfill-v1'
        ]
      );
      const records = manager.getRepository(PlatformRecordEntity);
      const migrationId = 'legacy-audit-backfill-v1';
      const completed = await records.findOne({
        where: {
          kind: 'launcher-product-user-access-backfill',
          id: migrationId,
          environment: this.config.environment
        }
      });
      if (completed) return;
      const auditRows = await records.createQueryBuilder('record')
        .where('record.kind = :kind', { kind: 'audit-event' })
        .andWhere('record.environment = :environment', { environment: this.config.environment })
        .andWhere("record.data ->> 'provenance' = :provenance", { provenance: 'server' })
        .andWhere("record.data ->> 'eventType' IN (:...eventTypes)", {
          eventTypes: [
            'launcher_network.product_user_access.blocked',
            'launcher_network.product_user_access.allowed'
          ]
        })
        .andWhere("NULLIF(BTRIM(record.data ->> 'productId'), '') IS NOT NULL")
        .andWhere("NULLIF(BTRIM(record.data ->> 'userId'), '') IS NOT NULL")
        .getMany();
      const auditEvents = auditRows.map((row) => row.data as unknown as AuditEvent);
      const preflight = planLauncherProductUserAccessBackfill({
        environment: this.config.environment,
        auditEvents,
        users: [],
        products: [],
        existingAccess: []
      });
      for (const pair of preflight.lockPairs) {
        await this.lockLauncherProductNetwork(manager, pair.productId);
        await this.lockLauncherProductUserAccess(manager, pair.productId, pair.userId);
      }
      const candidateUserIds = [...new Set(preflight.lockPairs.map((pair) => pair.userId))];
      const userRows = candidateUserIds.length > 0
        ? await manager.query(
            `SELECT data
             FROM mx_platform_records
             WHERE kind = 'iam-user'
               AND environment = $1
               AND id = ANY($2::varchar[])
             FOR UPDATE`,
            [this.config.environment, candidateUserIds]
          ) as Array<{ data: UserCenterUser }>
        : [];
      const users = userRows.map((row) => row.data);
      const products = preflight.lockPairs.length > 0
        ? await this.listRecordsFrom<LauncherProductNetwork>(records, 'launcher-product-network')
        : [];
      const existingAccess = preflight.lockPairs.length > 0
        ? await this.listRecordsFrom<LauncherProductUserAccess>(records, 'launcher-product-user-access')
        : [];
      const plan = planLauncherProductUserAccessBackfill({
        environment: this.config.environment,
        auditEvents,
        users,
        products,
        existingAccess
      });
      for (const access of plan.accesses) {
        await this.saveRecordTo(
          records,
          'launcher-product-user-access',
          access.accessId,
          access,
          this.config.siteId
        );
      }
      const completedAt = new Date().toISOString();
      await this.saveRecordTo(
        records,
        'launcher-product-user-access-backfill',
        migrationId,
        {
          migrationId,
          environment: this.config.environment,
          counts: plan.counts,
          completedAt
        },
        this.config.siteId
      );
      if (plan.counts.candidatePairs > 0) {
        await this.recordAuditTo(records, {
          eventType: 'launcher_network.product_user_access_backfill.completed',
          actorKind: 'migration',
          requestId: migrationId,
          metadata: { ...plan.counts, migrationId }
        });
      }
    });
  }

  async setLauncherProductUserAccess(
    input: LauncherProductUserAccessInput
  ): Promise<LauncherProductUserAccessResult> {
    const productId = normalizeLauncherNetworkProductId(input.productId);
    const userId = input.userId?.trim();
    if (!userId) throw new Error('Launcher product user access requires userId');
    const now = new Date().toISOString();
    const result = await this.dataSource.transaction(async (manager) => {
      await this.lockLauncherProductNetwork(manager, productId);
      await this.lockLauncherProductUserAccess(manager, productId, userId);
      const records = manager.getRepository(PlatformRecordEntity);
      const productRow = await records.findOne({
        where: {
          kind: 'launcher-product-network',
          id: productId,
          environment: this.config.environment
        }
      });
      if (!productRow) throw new Error(`Launcher product not found: ${productId}`);
      const userRow = await records.findOne({
        where: {
          kind: 'iam-user',
          id: userId,
          environment: this.config.environment
        }
      });
      if (!userRow) throw new Error(`User not found: ${userId}`);
      const user = userRow.data as unknown as UserCenterUser;
      const accessId = launcherProductUserAccessId(productId, userId);
      const accessRow = await records.findOne({
        where: {
          kind: 'launcher-product-user-access',
          id: accessId,
          environment: this.config.environment
        }
      });
      const access = buildLauncherProductUserAccess(
        this.config.environment,
        { ...input, productId, userId },
        accessRow?.data as unknown as LauncherProductUserAccess | null,
        now
      );
      await this.saveRecordTo(
        records,
        'launcher-product-user-access',
        access.access.accessId,
        access.access,
        this.config.siteId
      );
      const releasedLeases = input.blocked
        ? (await this.listRecordsFrom<LauncherNetworkLease>(records, 'launcher-network-lease'))
          .filter((lease) => (
            lease.productId === productId
            && lease.identityKind === 'user'
            && lease.userId === userId
            && launcherNetworkLeaseIsActive(lease)
          ))
          .map((lease) => releaseLauncherNetworkLease(lease, input, now))
        : [];
      for (const lease of releasedLeases) {
        await this.saveRecordTo(records, 'launcher-network-lease', lease.leaseId, lease, lease.siteId);
      }
      return { access, user, releasedLeases };
    });
    const reason = input.reason?.trim() || null;
    await this.recordAudit({
      eventType: input.blocked
        ? 'launcher_network.product_user_access.blocked'
        : 'launcher_network.product_user_access.allowed',
      actorKind: 'user-center',
      userId,
      productId,
      requestId: input.requestId ?? null,
      metadata: {
        requestedBy: input.requestedBy ?? 'launcher-network-admin',
        reason,
        changed: result.access.changed,
        releasedLeaseIds: result.releasedLeases.map((lease) => lease.leaseId),
        runtimePeerRemoval: 'not-performed',
        userStatus: result.user.status,
        tokensRevoked: 0
      }
    });
    return {
      productId,
      userId,
      blocked: input.blocked,
      changed: result.access.changed,
      reason,
      access: result.access.access,
      user: result.user,
      releasedLeases: result.releasedLeases,
      updatedAt: now
    };
  }

  async listLauncherNetworkLeases(productId?: string | null): Promise<LauncherNetworkLease[]> {
    const normalizedProductId = productId?.trim().toLowerCase() || null;
    const leases = await this.listRecords<LauncherNetworkLease>('launcher-network-lease');
    return leases
      .filter((lease) => !normalizedProductId || lease.productId === normalizedProductId)
      .sort((a, b) => a.productId.localeCompare(b.productId) || a.identityKind.localeCompare(b.identityKind) || a.sequence - b.sequence);
  }

  async getLauncherNetworkLease(leaseId: string): Promise<LauncherNetworkLease | null> {
    return this.getRecord<LauncherNetworkLease>('launcher-network-lease', leaseId.trim());
  }

  async listLauncherNetworkHandovers(): Promise<LauncherNetworkHandover[]> {
    const handovers = await this.listRecords<LauncherNetworkHandover>('launcher-network-handover');
    return handovers.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getLauncherNetworkHandover(
    transitionId: string
  ): Promise<LauncherNetworkHandover | null> {
    return this.getRecord<LauncherNetworkHandover>(
      'launcher-network-handover',
      transitionId.trim()
    );
  }

  async createLauncherNetworkHandover(
    input: LauncherNetworkHandoverInput
  ): Promise<LauncherNetworkHandover> {
    return this.dataSource.transaction(async (manager) => {
      const records = manager.getRepository(PlatformRecordEntity);
      await this.lockLauncherNetworkHandoverDevice(manager, input);
      await this.lockLauncherNetworkHandover(manager, input.transitionId);
      const existing = await records.findOne({
        where: {
          kind: 'launcher-network-handover',
          id: input.transitionId,
          environment: this.config.environment
        }
      });
      if (existing) throw new Error('Launcher network handover transition already exists');
      const conflicting = (
        await this.listRecordsFrom<LauncherNetworkHandover>(
          records,
          'launcher-network-handover'
        )
      ).find((handover) => (
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
      await this.saveRecordTo(
        records,
        'launcher-network-handover',
        handover.transitionId,
        handover,
        this.config.siteId
      );
      return handover;
    });
  }

  async advanceLauncherNetworkHandover(
    input: LauncherNetworkHandoverAdvanceInput
  ): Promise<LauncherNetworkHandover> {
    return this.dataSource.transaction(async (manager) => {
      const records = manager.getRepository(PlatformRecordEntity);
      await this.lockLauncherNetworkHandover(manager, input.transitionId);
      const row = await records.findOne({
        where: {
          kind: 'launcher-network-handover',
          id: input.transitionId,
          environment: this.config.environment
        }
      });
      if (!row) throw new Error('Launcher network handover transition not found');
      const handover = advanceLauncherNetworkHandover(
        row.data as unknown as LauncherNetworkHandover,
        input
      );
      await this.saveRecordTo(
        records,
        'launcher-network-handover',
        handover.transitionId,
        handover,
        this.config.siteId
      );
      return handover;
    });
  }

  async enrollLauncherNetworkLease(input: LauncherNetworkLeaseInput): Promise<LauncherNetworkLease> {
    const installId = input.installId?.trim() || `inst_${randomUUID()}`;
    const deviceId = input.deviceId?.trim() || `dev_${randomUUID()}`;
    const requestedProductId = normalizeLauncherNetworkProductId(input.productId);
    const sdkTestMode = launcherNetworkSdkTestModeAllowed(this.config, input);
    const storedRequestedProduct = await this.getLauncherProductNetwork(requestedProductId);
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
    const storedProduct = await this.getLauncherProductNetwork(productId);
    if (!storedProduct && !sdkTestMode) {
      throw new Error(`Launcher standalone channel ${productId} is not registered`);
    }
    const product = storedProduct
      ?? buildLauncherProductNetwork(this.config, { productId, mode: 'standalone' }, null);
    if (!sdkTestMode) {
      const appId = launcherNetworkAppIdForLeaseInput(input, requestedProduct);
      const app = await this.getAppCenterApp(appId);
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
    const allocation = await this.dataSource.transaction(async (manager) => {
      const records = manager.getRepository(PlatformRecordEntity);
      await this.lockLauncherProductNetwork(manager, product.productId);
      if (normalizedInput.userId) {
        await this.lockLauncherProductUserAccess(manager, product.productId, normalizedInput.userId);
        const userRow = await records.findOne({
          where: {
            kind: 'iam-user',
            id: normalizedInput.userId,
            environment: this.config.environment
          }
        });
        if (!userRow) throw new Error(`User not found: ${normalizedInput.userId}`);
        const accessRow = await records.findOne({
          where: {
            kind: 'launcher-product-user-access',
            id: launcherProductUserAccessId(product.productId, normalizedInput.userId),
            environment: this.config.environment
          }
        });
        assertLauncherProductUserAccess(
          accessRow?.data as unknown as LauncherProductUserAccess | undefined,
          product.productId,
          normalizedInput.userId
        );
      }
      await this.lockLauncherNetworkLeasePool(manager, product.productId, leaseProfile);
      if (normalizedInput.publicKey?.trim()) {
        await this.lockLauncherNetworkPublicKey(manager, normalizedInput.publicKey.trim());
      }
      const leaseKey = launcherNetworkLeaseKey(normalizedInput, product);
      const now = new Date();
      const nowIso = now.toISOString();
      const currentProducts = await this.listRecordsFrom<LauncherProductNetwork>(records, 'launcher-product-network');
      const admissionProduct = currentProducts.find((candidate) => candidate.productId === product.productId)
        ?? product;
      const allLeases = await this.listRecordsFrom<LauncherNetworkLease>(records, 'launcher-network-lease');
      const leases = allLeases.filter((lease) => lease.productId === product.productId);
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
      assertLauncherAnonymousEnrollmentPolicy(
        normalizedInput,
        admissionProduct,
        previous,
        now
      );
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
          updatedAt: nowIso
        };
        await this.saveRecordTo(
          records,
          'launcher-network-lease',
          claimedLease.leaseId,
          claimedLease,
          claimedLease.siteId
        );
        const allIndex = allLeases.findIndex((lease) => lease.leaseId === claimedLease.leaseId);
        if (allIndex >= 0) allLeases[allIndex] = claimedLease;
        const productIndex = leases.findIndex((lease) => lease.leaseId === claimedLease.leaseId);
        if (productIndex >= 0) leases[productIndex] = claimedLease;
      }
      const expiredLeases = leases.filter((lease) => lease.status === 'active' && !launcherNetworkLeaseIsActive(lease, now));
      for (const expiredLease of expiredLeases) {
        const released = releaseLauncherNetworkLease(expiredLease, {
          requestedBy: 'launcher-network-expiry',
          requestId: input.requestId ?? null
        }, nowIso);
        await this.saveRecordTo(records, 'launcher-network-lease', released.leaseId, released, released.siteId);
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
      if (
        previous?.publicKey
        && normalizedInput.publicKey?.trim()
        && previous.publicKey !== normalizedInput.publicKey.trim()
      ) {
        throw new Error('Launcher lease public key rotation requires a separate migration');
      }
      const sequence = previous
        ? previous.sequence
        : nextAvailableLauncherNetworkLeaseSequence(
          product,
          leaseProfile,
          leases,
          now
        );
      const generationRows = await manager.query(
        `SELECT nextval('mx_launcher_lease_generation_seq')::text AS generation`
      ) as Array<{ generation: string }>;
      const generation = Number(generationRows[0]?.generation);
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new Error('Unable to allocate launcher lease generation');
      }
      const lease = buildLauncherNetworkLease(
        this.config,
        { ...normalizedInput, generation },
        product,
        sequence,
        previous,
        nowIso
      );
      await this.saveRecordTo(records, 'launcher-network-lease', lease.leaseId, lease, lease.siteId);
      return { lease, previous };
    });
    const { lease, previous } = allocation;
    await this.recordAudit({
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
        sourceIp: lease.sourceIp,
        sdkTestMode
      }
    });
    return lease;
  }

  async releaseLauncherNetworkLease(leaseId: string, input: LauncherNetworkLeaseReleaseInput = {}): Promise<LauncherNetworkLease> {
    const lease = await this.getLauncherNetworkLease(leaseId);
    if (!lease) throw new Error('Launcher network lease not found');
    const released = releaseLauncherNetworkLease(lease, input);
    await this.saveRecord('launcher-network-lease', released.leaseId, released, released.siteId);
    await this.recordAudit({
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

  async renderHysteria2MihomoSubscription(siteId: string, username: string): Promise<MihomoSubscriptionRender | null> {
    const site = await this.getLauncherNetworkMihomoSite(siteId);
    const account = await this.getSiteSlotAccessAccount(siteId, username);
    if (!site || !account || account.status !== 'active') return null;
    return renderHysteria2MihomoSubscription(site, account);
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

  async listAwxProviderConfigs(kind?: SiteSlotKind | 'all' | null): Promise<AwxProviderConfig[]> {
    const providers = await this.listRecords<AwxProviderConfig>('awx-provider-config');
    return providers
      .filter((provider) => !kind || kind === 'all' || provider.defaultKind === kind || provider.defaultKind === 'all')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getAwxProviderConfig(providerId: string): Promise<AwxProviderConfig | null> {
    return this.getRecord<AwxProviderConfig>('awx-provider-config', providerId);
  }

  async upsertAwxProviderConfig(input: AwxProviderConfigInput): Promise<AwxProviderConfig> {
    const candidate = buildAwxProviderConfig(this.config, input, null);
    const previous = await this.getAwxProviderConfig(candidate.providerId);
    const provider = buildAwxProviderConfig(this.config, input, previous);
    await this.saveRecord('awx-provider-config', provider.providerId, provider, this.config.siteId);
    await this.recordAudit({
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
    return this.recordAuditTo(this.records, input);
  }

  async listAuditEvents(filter: AuditEventListFilter): Promise<AuditEvent[]> {
    const metadataLeaseId = filter.metadataLeaseId.trim();
    if (!metadataLeaseId) return [];
    const limit = Math.min(50, Math.max(1, Math.floor(filter.limit ?? 50)));
    const rows = await this.records.createQueryBuilder('record')
      .where('record.kind = :kind', { kind: 'audit-event' })
      .andWhere('record.environment = :environment', { environment: this.config.environment })
      .andWhere('record.data @> CAST(:metadataFilter AS jsonb)', {
        metadataFilter: JSON.stringify({
          provenance: 'server',
          metadata: { leaseId: metadataLeaseId }
        })
      })
      .orderBy('record.createdAt', 'DESC')
      .addOrderBy('record.id', 'DESC')
      .limit(limit)
      .getMany();
    return rows.map((row) => row.data as unknown as AuditEvent);
  }

  private async recordAuditTo(
    records: Repository<PlatformRecordRow>,
    input: AuditEventInput
  ): Promise<AuditEvent> {
    const row: AuditEvent = {
      provenance: input.provenance === undefined ? 'server' : input.provenance,
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
    await this.saveRecordTo(records, 'audit-event', row.eventId, row, row.siteId);
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

  listAppOnboardingTemplates(): AppOnboardingTemplate[] {
    return buildAppOnboardingTemplates();
  }

  async getAppOnboardingDefaults(input: AppOnboardingDefaultsInput): Promise<AppOnboardingDefaults> {
    return buildAppOnboardingDefaults(
      this.config,
      input,
      await this.listLauncherProductNetworks(),
      await this.listDnsReverseProxyRoutes()
    );
  }

  async listAppCenterApps(input: AppCenterAccessContextInput = {}): Promise<AppCenterApp[]> {
    const apps = (await this.listRecords<AppCenterApp>('app-center-app')).sort((a, b) => a.appId.localeCompare(b.appId));
    if (!input.userId && !input.sourceAppId && input.includeHidden !== false && input.includeDisabled !== false) {
      return apps;
    }
    const decisions = await Promise.all(apps.map((app) => this.evaluateAppCenterAccess({ ...input, appId: app.appId })));
    const visibleAppIds = new Set(decisions.filter((decision) => decision.visible).map((decision) => decision.appId));
    return apps.filter((app) => visibleAppIds.has(app.appId));
  }

  async evaluateAppCenterAccess(input: AppCenterAccessInput): Promise<AppCenterAccessDecision> {
    const app = await this.getAppCenterApp(input.appId);
    const user = input.userId ? await this.getRecord<UserCenterUser>('iam-user', input.userId) : null;
    const principal = user ? createUserPrincipalFromRecord(user, await this.listUserCenterRoles()) : null;
    const grants = (await this.listRecords<PermissionGrant>('permission-grant')).filter((grant) => (
      grant.appId === input.appId
      && (!input.userId || grant.userId === input.userId)
    ));
    return evaluateAppCenterAccess(app, input, principal, user, grants);
  }

  async getAppCenterApp(appId: string): Promise<AppCenterApp | null> {
    return this.getRecord<AppCenterApp>('app-center-app', appId);
  }

  async upsertAppCenterApp(input: AppCenterAppInput): Promise<AppCenterApp> {
    const appId = input.appId?.trim() || '';
    const previous = appId ? await this.getAppCenterApp(appId) : null;
    const app = buildAppCenterApp(input, previous);
    await this.dataSource.transaction(async (manager) => {
      const records = manager.getRepository(PlatformRecordEntity);
      if (app.enabled !== false) {
        await this.ensureAppPublisherServiceAccountTo(manager, records, app);
      } else {
        await this.disableAppPublisherServiceAccountTo(manager, records, app, false);
      }
      await this.saveRecordTo(records, 'app-center-app', app.appId, app, this.config.siteId);
      await this.recordAuditTo(records, {
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
    });
    return app;
  }

  async deleteAppCenterApp(appId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const records = manager.getRepository(PlatformRecordEntity);
      const appRow = await records.findOne({
        where: {
          kind: 'app-center-app',
          id: appId,
          environment: this.config.environment
        }
      });
      const app = appRow?.data as AppCenterApp | undefined;
      if (!app) return false;
      if (app.builtin || app.systemOwned) {
        throw new Error('builtin AppCenter app cannot be deleted');
      }
      await records.delete({
        kind: 'app-center-app',
        id: app.appId,
        environment: this.config.environment
      });
      const publisherRevoked = await this.disableAppPublisherServiceAccountTo(
        manager,
        records,
        app,
        true
      );
      await this.recordAuditTo(records, {
        eventType: 'app-center.app.deleted',
        actorKind: 'app-center',
        productId: app.appId,
        metadata: {
          requestedBy: 'desktop-admin',
          publisherRevoked
        }
      });
      return true;
    });
  }

  async listAppCenterInstallations(input: AppCenterInstallationQuery = {}): Promise<AppCenterInstallation[]> {
    return (await this.listRecords<AppCenterInstallation>('app-center-installation'))
      .filter((installation) => appCenterInstallationMatchesQuery(installation, input))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async upsertAppCenterInstallation(input: AppCenterInstallationInput): Promise<AppCenterInstallation> {
    const draft = buildAppCenterInstallation(input, null);
    const app = await this.getAppCenterApp(draft.appId);
    if (!app) throw new Error(`AppCenter app ${draft.appId} is not registered`);
    const previous = await this.getRecord<AppCenterInstallation>('app-center-installation', draft.installationId);
    const installation = buildAppCenterInstallation(input, app, previous);
    await this.saveRecord('app-center-installation', installation.installationId, installation, this.config.siteId);
    await this.recordAudit({
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

  async getDnsReverseProxyRoute(routeId: string): Promise<DnsReverseProxyRoute | null> {
    return this.getRecord<DnsReverseProxyRoute>('dns-reverse-proxy-route', routeId);
  }

  async upsertDnsReverseProxyRoute(input: DnsReverseProxyRouteInput): Promise<DnsReverseProxyRoute> {
    const previous = input.routeId ? await this.getDnsReverseProxyRoute(input.routeId) : null;
    const route = buildDnsReverseProxyRoute(this.config, input, previous);
    await this.saveRecord('dns-reverse-proxy-route', route.routeId, route, this.config.siteId);
    await this.recordAudit({
      eventType: previous ? 'dns.reverse_proxy_route.updated' : 'dns.reverse_proxy_route.created',
      actorKind: 'dns-control',
      metadata: {
        requestedBy: input.requestedBy?.trim() || 'desktop-admin',
        routeId: route.routeId,
        host: route.host,
        targetUrl: route.targetUrl,
        enabled: route.enabled
      }
    });
    return route;
  }

  async deleteDnsReverseProxyRoute(routeId: string): Promise<boolean> {
    const route = await this.getDnsReverseProxyRoute(routeId);
    if (!route) return false;
    await this.records.delete({
      kind: 'dns-reverse-proxy-route',
      id: route.routeId,
      environment: this.config.environment
    });
    await this.recordAudit({
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

  async getGatewayRuntimeConfig(): Promise<GatewayRuntimeConfig> {
    return await this.getRecord<GatewayRuntimeConfig>('gateway-runtime-config', GATEWAY_RUNTIME_CONFIG_ID)
      ?? builtinGatewayRuntimeConfig(this.config);
  }

  async upsertGatewayRuntimeConfig(input: GatewayRuntimeConfigInput): Promise<GatewayRuntimeConfig> {
    const previous = await this.getRecord<GatewayRuntimeConfig>('gateway-runtime-config', GATEWAY_RUNTIME_CONFIG_ID);
    const runtimeConfig = buildGatewayRuntimeConfig(this.config, input, previous);
    await this.saveRecord('gateway-runtime-config', runtimeConfig.configId, runtimeConfig, runtimeConfig.siteId);
    await this.recordAudit({
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

  async syncGatewayConfigMap(input: GatewayConfigMapSyncInput): Promise<GatewayConfigMapSyncResult> {
    const effectiveInput = gatewayRuntimeConfigRequestInput(input, await this.getGatewayRuntimeConfig());
    const result = renderGatewayConfigMap(
      this.config,
      await this.listDnsReverseProxyRoutes(),
      effectiveInput,
      `gatewaysync_${randomUUID()}`
    );
    await this.saveRecord('gateway-configmap-sync', result.syncId, result, this.config.siteId);
    await this.recordAudit({
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
    const effectiveInput = gatewayRuntimeConfigRequestInput(input, await this.getGatewayRuntimeConfig());
    const sync = await this.syncGatewayConfigMap({ ...effectiveInput, mode: 'shadow-apply' });
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
    await this.saveRecord('gateway-configmap-apply', result.applyId, result, this.config.siteId);
    await this.recordAudit({
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

  async requestPermission(input: PermissionRequestInput): Promise<PermissionGrant> {
    const app = await this.getAppCenterApp(input.appId);
    const requestedScopes = input.scopes.length > 0 ? input.scopes : [];
    const access = await this.evaluateAppCenterAccess({
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

  async createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): Promise<LauncherNetworkSnapshot> {
    const appId = normalizeLauncherNetworkProductId(input.appId);
    const launcherMode = input.launcherMode === 'embed' || input.launcherMode === 'standalone'
      ? input.launcherMode
      : launcherNetworkProductIsStandaloneDefault(appId)
        ? 'standalone'
        : 'embed';
    const requestedLease = input.leaseId?.trim()
      ? await this.getLauncherNetworkLease(input.leaseId)
      : null;
    if (input.leaseId?.trim() && (!requestedLease || !launcherNetworkLeaseIsActive(requestedLease))) {
      throw new Error('Launcher network lease is missing or inactive');
    }
    if (requestedLease && requestedLease.productId !== appId) {
      throw new Error('Launcher network lease product does not match snapshot appId');
    }
    const requestedLeaseProduct = requestedLease
      ? await this.getLauncherProductNetwork(requestedLease.productId)
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
    const snapshotUserId = requestedLease?.userId ?? input.userId?.trim() ?? null;
    assertLauncherProductUserAccess(
      snapshotUserId
        ? await this.getLauncherProductUserAccess(requestedLease?.productId ?? appId, snapshotUserId)
        : null,
      requestedLease?.productId ?? appId,
      snapshotUserId ?? ''
    );
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
    const lease = requestedLease ?? await this.enrollLauncherNetworkLease({
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
    const product = await this.getLauncherProductNetwork(lease.productId)
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
    const domesticWireGuardSecret = await this.getSiteSlotDomesticWireGuardSecret(topology.domestic.siteId);
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
        topologyModel: snapshot.topology.model,
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

  async createPublisherReleaseManagementPlan(
    input: PublisherReleasePlanInput
  ): Promise<PublisherReleasePlanResult> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [
            `mx-launcher:${this.config.environment}:release-publisher:${input.productId}:${input.requestId}`
          ]
        );
        const existing = await this.findPublisherReleaseManagementPlan(
          manager,
          input.productId,
          input.requestId
        );
        if (existing) {
          return existing.publisherRequestFingerprint === input.publisherRequestFingerprint
            ? { outcome: 'replayed' as const, plan: existing }
            : { outcome: 'conflict' as const, planId: existing.planId };
        }
        const records = manager.getRepository(PlatformRecordEntity);
        const plan = await this.createPublisherReleaseManagementPlanTo(records, input);
        return { outcome: 'created' as const, plan };
      });
    } catch (error) {
      if (!isReleasePublisherRequestUniqueViolation(error)) throw error;
      const existing = await this.findPublisherReleaseManagementPlan(
        this.dataSource.manager,
        input.productId,
        input.requestId
      );
      if (!existing) throw error;
      return existing.publisherRequestFingerprint === input.publisherRequestFingerprint
        ? { outcome: 'replayed', plan: existing }
        : { outcome: 'conflict', planId: existing.planId };
    }
  }

  private async createPublisherReleaseManagementPlanTo(
    records: Repository<PlatformRecordRow>,
    input: PublisherReleasePlanInput
  ): Promise<ReleaseManagementPlan> {
    if ((input.e2eResult ?? 'running') !== 'running') {
      throw new Error('Publisher release plans must start with a running E2E result');
    }
    const releaseId = input.releaseId?.trim() || `rel_${randomUUID()}`;
    const channel = input.channel?.trim() || 'shadow';
    const appId = input.appId?.trim() || input.productId;
    const launcherUpdatePolicy = normalizeUpdatePolicy(input.launcherUpdatePolicy ?? 'app-installer');
    const appUpdatePolicy = normalizeUpdatePolicy(input.appUpdatePolicy ?? 'config-snapshot');
    const launcherDecision = releasePolicyDecisionForInput({
      componentKind: launcherUpdatePolicy,
      componentId: input.launcherComponentId?.trim() || input.productId,
      currentVersion: input.launcherCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.launcherTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const appDecision = releasePolicyDecisionForInput({
      componentKind: appUpdatePolicy,
      componentId: input.appComponentId?.trim() || appId,
      currentVersion: input.appCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.appTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    for (const [decision, decisionInput] of [
      [launcherDecision, {
        channel,
        installId: input.installId ?? null,
        userId: input.userId ?? null
      }],
      [appDecision, {
        channel,
        installId: input.installId ?? null,
        userId: input.userId ?? null
      }]
    ] as const) {
      if (!decision.updateAvailable) continue;
      await this.saveRecordTo(records, 'release-policy-decision', `relpol_${randomUUID()}`, {
        ...decision,
        ...decisionInput,
        evaluatedAt: new Date().toISOString()
      }, this.config.siteId);
    }

    const startedAt = new Date().toISOString();
    const testRun: TestRun = {
      testRunId: `trun_${randomUUID()}`,
      suiteId: input.suiteId?.trim() || 'hdi-shadow-e2e',
      productId: input.productId,
      environment: this.config.environment,
      topology: input.topology?.trim() || 'h-d-i-shadow',
      sites: input.sites && input.sites.length > 0
        ? input.sites
        : ['internal-main', 'domestic-main'],
      releaseId,
      configSnapshotId: null,
      installId: input.installId ?? null,
      deviceId: null,
      traceId: `trace_${randomUUID()}`,
      state: 'running',
      steps: [],
      startedAt,
      finishedAt: null
    };
    await this.saveRecordTo(
      records,
      'test-run',
      testRun.testRunId,
      testRun,
      this.config.siteId
    );
    await this.recordAuditTo(records, {
      eventType: 'test.run.created',
      actorKind: 'test-center',
      installId: testRun.installId,
      deviceId: testRun.deviceId,
      productId: testRun.productId,
      traceId: testRun.traceId,
      metadata: {
        suiteId: testRun.suiteId,
        topology: testRun.topology,
        releaseId: testRun.releaseId
      }
    });

    const gate: TestGateVerdict = {
      gateId: `gate_${releaseId}_e2e`,
      releaseId,
      verdict: 'blocked',
      requiredRuns: [testRun.testRunId],
      evaluatedAt: new Date().toISOString(),
      reason: 'at least one required run is not complete'
    };
    await this.saveRecordTo(
      records,
      'test-gate-verdict',
      `${gate.gateId}:${gate.releaseId}:${randomUUID()}`,
      gate,
      this.config.siteId
    );
    await this.recordAuditTo(records, {
      eventType: 'test.gate.evaluated',
      actorKind: 'test-center',
      requestId: gate.gateId,
      metadata: {
        gateId: gate.gateId,
        releaseId: gate.releaseId,
        verdict: gate.verdict,
        requiredRuns: gate.requiredRuns,
        evaluatedAt: gate.evaluatedAt,
        reason: gate.reason
      }
    });

    const plan = buildReleaseManagementPlan(this.config, { ...input, channel }, {
      planId: `relplan_${randomUUID()}`,
      releaseId,
      launcherDecision,
      appDecision,
      testRun,
      gate,
      createdAt: new Date().toISOString()
    });
    await this.saveRecordTo(
      records,
      'release-management-plan',
      plan.planId,
      plan,
      this.config.siteId
    );
    await this.recordAuditTo(records, {
      eventType: 'release.management_plan.created',
      actorKind: 'release-center',
      requestId: input.requestId,
      installId: plan.installId,
      userId: plan.userId,
      productId: input.productId,
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

  private async findPublisherReleaseManagementPlan(
    manager: EntityManager,
    productId: string,
    requestId: string
  ): Promise<ReleaseManagementPlan | null> {
    const rows = await manager.query(
      `SELECT data
       FROM mx_platform_records
       WHERE kind = 'release-management-plan'
         AND environment = $1
         AND data->>'productId' = $2
         AND data->>'requestId' = $3
       LIMIT 1`,
      [this.config.environment, productId, requestId]
    ) as Array<{ data: ReleaseManagementPlan }>;
    return rows[0]?.data ?? null;
  }

  async createReleaseManagementPlan(input: ReleaseManagementPlanInput): Promise<ReleaseManagementPlan> {
    const releaseId = input.releaseId?.trim() || `rel_${randomUUID()}`;
    const channel = input.channel?.trim() || 'shadow';
    const appId = input.appId?.trim() || 'h2o';
    const productId = input.productId?.trim() || appId;
    const launcherUpdatePolicy = normalizeUpdatePolicy(input.launcherUpdatePolicy ?? 'platform-critical');
    const appUpdatePolicy = normalizeUpdatePolicy(input.appUpdatePolicy ?? 'app-managed');
    const launcherDecision = await this.evaluateReleaseUpdate({
      componentKind: launcherUpdatePolicy,
      componentId: input.launcherComponentId?.trim()
        || (launcherUpdatePolicy === 'app-installer' || launcherUpdatePolicy === 'mx-h2i-installer' ? productId : 'mx-launcher'),
      currentVersion: input.launcherCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.launcherTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const appDecision = await this.evaluateReleaseUpdate({
      componentKind: appUpdatePolicy,
      componentId: input.appComponentId?.trim() || appId,
      currentVersion: input.appCurrentVersion?.trim() || '0.1.0',
      targetVersion: input.appTargetVersion?.trim() || '0.1.1',
      channel,
      installId: input.installId,
      userId: input.userId
    });
    const testRun = await this.createTestRun({
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

  async updateReleaseManagementPlan(
    planId: string,
    input: ReleaseManagementPlanPatchInput
  ): Promise<ReleaseManagementPlan> {
    const plan = await this.getReleaseManagementPlan(planId);
    if (!plan) throw new Error(`Unknown releaseManagementPlanId: ${planId}`);
    const updated = updateReleaseManagementPlanMetadata(plan, input);
    await this.saveRecord('release-management-plan', planId, updated, this.config.siteId);
    await this.recordAudit({
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

  async completeReleaseManagementGate(planId: string, input: ReleaseManagementGateInput): Promise<ReleaseManagementPlan> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`mx-launcher:${this.config.environment}:release-gate:${planId}`]
      );
      const records = manager.getRepository(PlatformRecordEntity);
      const planRow = await records.findOne({
        where: {
          kind: 'release-management-plan',
          id: planId,
          environment: this.config.environment
        }
      });
      if (!planRow) throw new Error(`Unknown releaseManagementPlanId: ${planId}`);
      const plan = planRow.data as unknown as ReleaseManagementPlan;
      const currentVerdict = plan.test.gate.verdict;
      const gateIsTerminal = currentVerdict === 'passed'
        || currentVerdict === 'failed';
      if (gateIsTerminal) {
        if (currentVerdict === input.status) return plan;
        throw new Error(
          `Release management gate is terminal (${currentVerdict}); create a new plan`
        );
      }

      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`mx-launcher:${this.config.environment}:release-test-run:${plan.test.run.testRunId}`]
      );
      const runRow = await records.findOne({
        where: {
          kind: 'test-run',
          id: plan.test.run.testRunId,
          environment: this.config.environment
        }
      });
      if (!runRow) throw new Error(`Unknown testRunId: ${plan.test.run.testRunId}`);
      const previousRun = runRow.data as unknown as TestRun;
      const status = normalizeTestStatus(input.status);
      const step: TestStep = {
        stepId: `tstep_${randomUUID()}`,
        caseId: 'release-gate:e2e',
        status,
        message: input.message ?? `release management E2E gate ${input.status}`,
        evidence: {
          source: 'release-management-gate-action',
          releaseId: plan.releaseId,
          planId: plan.planId,
          ...(input.evidence ?? {})
        },
        createdAt: new Date().toISOString()
      };
      const run: TestRun = {
        ...previousRun,
        steps: [...previousRun.steps, step]
      };
      if (status === 'failed' || status === 'blocked') {
        run.state = status;
        run.finishedAt = step.createdAt;
      } else if (status === 'passed') {
        run.state = 'passed';
        run.finishedAt = step.createdAt;
      }
      await this.saveRecordTo(records, 'test-run', run.testRunId, run, this.config.siteId);
      await this.recordAuditTo(records, {
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

      const gate: TestGateVerdict = {
        gateId: plan.test.gate.gateId,
        releaseId: plan.releaseId,
        verdict: run.state === 'failed'
          ? 'failed'
          : run.state === 'blocked' || run.state === 'running'
            ? 'blocked'
            : 'passed',
        requiredRuns: [run.testRunId],
        evaluatedAt: new Date().toISOString(),
        reason: run.state === 'failed'
          ? 'at least one required run failed'
          : run.state === 'blocked' || run.state === 'running'
            ? 'at least one required run is not complete'
            : 'all required runs passed'
      };
      await this.saveRecordTo(
        records,
        'test-gate-verdict',
        `${gate.gateId}:${gate.releaseId}:${randomUUID()}`,
        gate,
        this.config.siteId
      );
      await this.recordAuditTo(records, {
        eventType: 'test.gate.evaluated',
        actorKind: 'test-center',
        requestId: gate.gateId,
        metadata: {
          gateId: gate.gateId,
          releaseId: gate.releaseId,
          verdict: gate.verdict,
          requiredRuns: gate.requiredRuns,
          evaluatedAt: gate.evaluatedAt,
          reason: gate.reason
        }
      });

      const updated: ReleaseManagementPlan = {
        ...plan,
        test: {
          ...plan.test,
          run,
          gate
        },
        decisions: buildReleaseManagementDecisions(
          plan.components.launcher,
          plan.components.app,
          gate
        )
      };
      await this.saveRecordTo(
        records,
        'release-management-plan',
        updated.planId,
        updated,
        this.config.siteId
      );
      await this.recordAuditTo(records, {
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
    });
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
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`mx-launcher:${this.config.environment}:release-test-run:${runId}`]
      );
      const records = manager.getRepository(PlatformRecordEntity);
      const runRow = await records.findOne({
        where: {
          kind: 'test-run',
          id: runId,
          environment: this.config.environment
        }
      });
      if (!runRow) throw new Error(`Unknown testRunId: ${runId}`);
      const publisherPlans = await manager.query(
        `SELECT id
         FROM mx_platform_records
         WHERE kind = 'release-management-plan'
           AND environment = $1
           AND NULLIF(data->>'publisherRequestFingerprint', '') IS NOT NULL
           AND data#>>'{test,run,testRunId}' = $2
         LIMIT 1`,
        [this.config.environment, runId]
      ) as Array<{ id: string }>;
      if (publisherPlans.length > 0) {
        throw new Error(
          'Publisher release test runs can only be completed through the release gate endpoint'
        );
      }
      const previousRun = runRow.data as unknown as TestRun;
      const status = normalizeTestStatus(input.status);
      const step: TestStep = {
        stepId: `tstep_${randomUUID()}`,
        caseId: input.caseId,
        status,
        message: input.message ?? null,
        evidence: input.evidence ?? {},
        createdAt: new Date().toISOString()
      };
      const run: TestRun = {
        ...previousRun,
        steps: [...previousRun.steps, step]
      };
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
      await this.saveRecordTo(records, 'test-run', run.testRunId, run, this.config.siteId);
      await this.recordAuditTo(records, {
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
    });
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
    const smokeHomePublicKey = randomBytes(32).toString('base64');
    const { enrollment } = await this.enrollAnonymous({
      productId: MX_H2I_PRODUCT_ID,
      platform: 'darwin',
      publicKey: smokeHomePublicKey,
      requestId: 'smoke-enroll'
    });
    if (enrollment.publicKey !== smokeHomePublicKey) {
      throw new Error('anonymous enrollment did not preserve Home WG public key');
    }
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
      || !overseaPrepareAccess?.commands.some((command) => command.includes('ln -sfnT /opt/mx/state/hysteria2-access-stack/.env /opt/mx/releases/oversea-access-stack/__release_revision__/.env'))
      || !overseaPrepareAccess?.commands.some((command) => command.includes('ln -sfnT /opt/mx/state/hysteria2-access-stack/config /opt/mx/releases/oversea-access-stack/__release_revision__/config'))
      || !overseaPrepareAccess?.commands.some((command) => command.includes('ln -sfnT /opt/mx/state/hysteria2-access-stack/data /opt/mx/releases/oversea-access-stack/__release_revision__/data'))
      || !overseaPrepareAccess?.commands.some((command) => command.includes('ln -sfnT /opt/mx/releases/oversea-access-stack/__release_revision__ /opt/mx/current/hysteria2-access-stack'))
      || !overseaConfigureAccess?.commands.some((command) => (
        command.includes('HY2_EXPORT_BASE_URL=http://oversea.example.com:3434')
        && command.includes('HY2_EXPORT_USER=download')
        && command.includes('env_file=/opt/mx/state/hysteria2-access-stack/.env')
        && command.includes('mv -f "$tmp_file" "$env_file"')
        && !command.includes('"HY2_EXPORT_PASSWORD_HASH="')
        && !command.includes('"HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH="')
        && !command.includes('"HY2_SYSTEM_SUBSCRIPTION_AUTH_TOKEN_SHA256="')
      ))
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
    const overseaAccounts = await this.issueSiteSlotAccessAccounts({
      siteId: overseaSlotPlan.siteId,
      publicHost: overseaSlotPlan.host,
      serverPorts: '51288',
      tlsFingerprint: 'D6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58',
      issueDefaults: true,
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-oversea-access-accounts'
    });
    const overseaDomesticSubscription = await this.renderHysteria2MihomoSubscription(
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
    const overseaReachability = await this.getLauncherNetworkMihomoReachability(overseaSlotPlan.siteId);
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
    const domesticSlotPlan = await this.createSiteSlotPlan({
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
      || !domesticSlotPreflightExecution.steps.some((step) => step.sourceId === 'domestic.public-ingress-firewall')
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
    const domesticSlotConfirmedApplyExecution = await this.createSiteSlotExecution({
      planId: domesticSlotPlan.planId,
      action: 'apply',
      mode: 'manual',
      confirmApply: true,
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-apply-confirmed'
    });
    const domesticSlotApplyRunnerSession = await this.startSiteSlotRunnerSession({
      runId: domesticSlotConfirmedApplyExecution.runId,
      mode: 'simulate',
      requestedBy: 'platform-kernel-smoke',
      requestId: 'smoke-domestic-slot-apply-runner-simulate'
    });
    const domesticSlotApplyWorkerJob = await this.createSiteSlotWorkerJob({
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
      || !domesticSlotRemoteRunnerSession.warnings.some((warning) => (
        warning.includes('SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED')
        || warning.includes('remote-ssh requires confirmRemoteExecution=true')
      ))
    ) {
      throw new Error('Domestic slot remote runner session was not blocked by remote execution gate');
    }
    checks.push('OK Domestic slot remote runner gate blocked without confirmation');
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
    const mxH2iLeases = await this.listLauncherNetworkLeases(MX_H2I_PRODUCT_ID);
    if (!mxH2iLeases.some((lease) => lease.leaseIp === networkSnapshot.overlayPolicy.leaseIp && lease.identityKind === 'anonymous')) {
      throw new Error('MX-H2I network lease allocator did not persist anonymous lease');
    }
    checks.push('OK MX-H2I Network lease allocator persisted anonymous lease');
    const permissionGrant = await this.requestPermission({
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
    const testRun = await this.createTestRun({
      suiteId: 'hdi-shadow-e2e',
      productId: MX_H2I_PRODUCT_ID,
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

  private async ensureEnabledAppPublisherServiceAccounts(): Promise<void> {
    const apps = await this.listRecords<AppCenterApp>('app-center-app');
    for (const app of apps) {
      if (app.enabled === false) continue;
      try {
        await this.ensureAppPublisherServiceAccount(app);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('Release publisher service account collision:')) throw error;
        console.warn(`[mx-launcher] skipped Release Publisher reconciliation for ${app.appId}: ${message}`);
      }
    }
  }

  private async ensureAppPublisherServiceAccount(app: AppCenterApp): Promise<UserCenterServiceAccount> {
    return this.dataSource.transaction(async (manager) => (
      this.ensureAppPublisherServiceAccountTo(
        manager,
        manager.getRepository(PlatformRecordEntity),
        app
      )
    ));
  }

  private async ensureAppPublisherServiceAccountTo(
    manager: EntityManager,
    records: Repository<PlatformRecordRow>,
    app: AppCenterApp
  ): Promise<UserCenterServiceAccount> {
    const serviceAccountId = appReleasePublisherServiceAccountId(app.appId);
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`mx-launcher:${this.config.environment}:service-account-credential`, serviceAccountId]
    );
    const previousRow = await records.findOne({
      where: {
        kind: 'iam-service-account',
        id: serviceAccountId,
        environment: this.config.environment
      }
    });
    const previous = previousRow?.data as UserCenterServiceAccount | undefined;
    if (!previous) {
      const serviceAccount = createUserCenterServiceAccount({
        serviceAccountId,
        displayName: `${app.displayName} Release Publisher`,
        roleIds: ['mx-release-publisher'],
        scopes: APP_RELEASE_PUBLISHER_SCOPES,
        allowedProductIds: [app.appId],
        requestId: 'app-release-publisher-reconcile'
      });
      await this.saveRecordTo(
        records,
        'iam-service-account',
        serviceAccountId,
        serviceAccount,
        this.config.siteId
      );
      await this.recordAuditTo(records, {
        eventType: 'iam.service_account.upserted',
        actorKind: 'user-center',
        requestId: 'app-release-publisher-reconcile',
        metadata: {
          serviceAccountId,
          roleIds: serviceAccount.roleIds,
          scopes: serviceAccount.scopes,
          allowedProductIds: serviceAccount.allowedProductIds ?? [],
          status: serviceAccount.status
        }
      });
      return serviceAccount;
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
    await this.saveRecordTo(
      records,
      'iam-service-account',
      serviceAccountId,
      reconciled,
      this.config.siteId
    );
    return reconciled;
  }

  private async disableAppPublisherServiceAccountTo(
    manager: EntityManager,
    records: Repository<PlatformRecordRow>,
    app: AppCenterApp,
    deleteCredential: boolean
  ): Promise<boolean> {
    const serviceAccountId = appReleasePublisherServiceAccountId(app.appId);
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`mx-launcher:${this.config.environment}:service-account-credential`, serviceAccountId]
    );
    const publisherRow = await records.findOne({
      where: {
        kind: 'iam-service-account',
        id: serviceAccountId,
        environment: this.config.environment
      }
    });
    const publisher = publisherRow?.data as UserCenterServiceAccount | undefined;
    if (
      !publisher
      || publisher.allowedProductIds?.length !== 1
      || publisher.allowedProductIds[0] !== app.appId
    ) {
      return false;
    }
    await this.saveRecordTo(
      records,
      'iam-service-account',
      serviceAccountId,
      { ...publisher, status: 'disabled' },
      this.config.siteId
    );
    await this.revokeServiceAccountTokensTo(records, serviceAccountId);
    if (deleteCredential) {
      await records.delete({
        kind: 'iam-service-account-credential',
        id: userCenterServiceAccountCredentialId(serviceAccountId),
        environment: this.config.environment
      });
    }
    return true;
  }

  private async revokeServiceAccountTokensTo(
    records: Repository<PlatformRecordRow>,
    serviceAccountId: string,
    revokedAt = new Date().toISOString()
  ): Promise<void> {
    const tokenRows = await records.find({
      where: {
        kind: 'iam-token',
        environment: this.config.environment
      }
    });
    for (const row of tokenRows) {
      const token = row.data as unknown as UserCenterTokenRecord;
      if (
        token.subjectKind === 'service-account'
        && token.subjectId === serviceAccountId
        && !token.revokedAt
      ) {
        await this.saveRecordTo(
          records,
          'iam-token',
          row.id,
          { ...token, revokedAt },
          row.siteId
        );
      }
    }
  }

  private async importConfiguredLegacyServiceAccountCredentials(): Promise<void> {
    for (const [serviceAccountId, clientSecret] of configuredLegacyServiceAccountSecrets()) {
      try {
        await this.importLegacyUserCenterServiceAccountCredential({
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

  private async registerBuiltinApps(): Promise<void> {
    await Promise.all(
      builtinAppCenterApps().map((app) => this.saveRecord('app-center-app', app.appId, app, this.config.siteId))
    );
  }

  private async registerBuiltinProductNetworks(): Promise<void> {
    for (const product of builtinLauncherProductNetworks(this.config)) {
      const existing = await this.getRecord<LauncherProductNetwork>(
        'launcher-product-network',
        product.productId
      );
      if (!existing) {
        await this.saveRecord(
          'launcher-product-network',
          product.productId,
          product,
          this.config.siteId
        );
        continue;
      }
      const hasCompleteFeishuPool = Boolean(
        existing.feishuCidr
        && existing.feishuLeaseStart
        && existing.feishuLeaseEnd
      );
      const automatedPoolMigrationNeedsRepair = (
        existing.updatedBy === 'builtin-feishu-pool-migration'
        || existing.updatedBy === 'persisted-feishu-pool-migration'
      ) && (
        existing.userCidr !== product.userCidr
        || existing.feishuCidr !== product.feishuCidr
        || existing.anonymousCidr !== product.anonymousCidr
        || existing.userLeaseStart !== product.userLeaseStart
        || existing.userLeaseEnd !== product.userLeaseEnd
        || existing.feishuLeaseStart !== product.feishuLeaseStart
        || existing.feishuLeaseEnd !== product.feishuLeaseEnd
        || existing.anonymousLeaseStart !== product.anonymousLeaseStart
        || existing.anonymousLeaseEnd !== product.anonymousLeaseEnd
      );
      const anonymousPolicyNeedsBackfill = ![
        'enabled',
        'drain',
        'disabled'
      ].includes(existing.anonymousEnrollmentPolicy)
        || !['primary', 'advanced', 'hidden'].includes(existing.anonymousUiVisibility);
      if (hasCompleteFeishuPool && !automatedPoolMigrationNeedsRepair) {
        if (anonymousPolicyNeedsBackfill) {
          const migrated = buildLauncherProductNetwork(this.config, {
            productId: existing.productId,
            requestedBy: 'builtin-anonymous-policy-backfill'
          }, existing);
          await this.saveRecord(
            'launcher-product-network',
            migrated.productId,
            migrated,
            this.config.siteId
          );
        }
        continue;
      }
      const migrated = buildLauncherProductNetwork(this.config, {
        productId: existing.productId,
        userCidr: product.userCidr,
        feishuCidr: product.feishuCidr,
        anonymousCidr: product.anonymousCidr,
        userLeaseStart: product.userLeaseStart,
        userLeaseEnd: product.userLeaseEnd,
        feishuLeaseStart: product.feishuLeaseStart,
        feishuLeaseEnd: product.feishuLeaseEnd,
        anonymousLeaseStart: product.anonymousLeaseStart,
        anonymousLeaseEnd: product.anonymousLeaseEnd,
        requestedBy: 'builtin-feishu-pool-migration'
      }, existing);
      await this.saveRecord(
        'launcher-product-network',
        migrated.productId,
        migrated,
        this.config.siteId
      );
    }
    const persistedProducts = await this.listRecords<LauncherProductNetwork>('launcher-product-network');
    for (const existing of persistedProducts) {
      const hasCompleteFeishuPool = Boolean(
        existing.feishuCidr
        && existing.feishuLeaseStart
        && existing.feishuLeaseEnd
      );
      const hasAnonymousPolicy = ['enabled', 'drain', 'disabled'].includes(existing.anonymousEnrollmentPolicy)
        && ['primary', 'advanced', 'hidden'].includes(existing.anonymousUiVisibility);
      if (hasCompleteFeishuPool && hasAnonymousPolicy) {
        continue;
      }
      let migrated: LauncherProductNetwork;
      try {
        migrated = buildLauncherProductNetwork(this.config, {
          productId: existing.productId,
          requestedBy: hasCompleteFeishuPool
            ? 'persisted-anonymous-policy-backfill'
            : 'persisted-feishu-pool-migration'
        }, existing);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const requiresOperatorPoolMigration = (
          message === 'Launcher employee, Feishu, and anonymous lease ranges must not overlap'
          || message === 'Launcher lease profile ranges must use valid ascending IPv4 addresses'
          || /^Launcher (employee|Feishu|anonymous) lease range must be contained by its IPv4 CIDR$/.test(message)
        );
        if (!requiresOperatorPoolMigration) throw error;
        console.warn(
          `[mx-launcher] skipped automatic Feishu pool migration for ${existing.productId}: ${message}`
        );
        continue;
      }
      await this.saveRecord(
        'launcher-product-network',
        migrated.productId,
        migrated,
        this.config.siteId
      );
    }
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

  private async registerBuiltinGatewayRuntimeConfig(): Promise<void> {
    const existing = await this.getRecord<GatewayRuntimeConfig>('gateway-runtime-config', GATEWAY_RUNTIME_CONFIG_ID);
    if (existing) return;
    const runtimeConfig = builtinGatewayRuntimeConfig(this.config, new Date().toISOString(), 'pg-seed');
    await this.saveRecord('gateway-runtime-config', runtimeConfig.configId, runtimeConfig, runtimeConfig.siteId);
  }

  private async registerBuiltinDomesticRuntimeConfigs(): Promise<void> {
    const siteId = 'domestic-main';
    const existing = await this.getSiteSlotDomesticRuntimeConfig(siteId);
    if (existing) return;
    const config = buildSiteSlotDomesticRuntimeConfig(this.config, { siteId, requestedBy: 'pg-seed' }, null);
    await this.saveRecord('site-slot-domestic-runtime-config', config.siteId, config, config.siteId);
  }

  private async registerBuiltinSecretRegistry(): Promise<void> {
    for (const provider of builtinSecretProviderConfigs(this.config)) {
      const existing = await this.getSecretProviderConfig(provider.providerId);
      if (!existing) {
        await this.saveRecord('secret-provider-config', provider.providerId, provider, this.config.siteId);
      }
    }
    for (const reference of builtinConfigSecretReferences(this.config)) {
      const existing = await this.getConfigSecretReference(reference.secretRefId);
      if (!existing) {
        await this.saveRecord('config-secret-reference', reference.secretRefId, reference, this.config.siteId);
      }
    }
  }

  private createSnapshot(
    enrollment: AnonymousEnrollment,
    version: number,
    defaultMode: 'visitor' | 'employee'
  ): ConfigSnapshot {
    return createConfigSnapshot(this.config, enrollment, `cfgsnap_${randomUUID()}`, version, defaultMode);
  }

  private async countRecords(kind: RecordKind): Promise<number> {
    return this.records.count({
      where: {
        kind,
        environment: this.config.environment
      }
    });
  }

  private async getServiceAccountCredentialRecord(
    serviceAccountId: string
  ): Promise<UserCenterServiceAccountCredential | null> {
    const normalizedServiceAccountId = serviceAccountId.trim();
    if (!normalizedServiceAccountId) return null;
    const credential = await this.getRecord<UserCenterServiceAccountCredential>(
      'iam-service-account-credential',
      userCenterServiceAccountCredentialId(normalizedServiceAccountId)
    );
    return credential?.serviceAccountId === normalizedServiceAccountId ? credential : null;
  }

  private async listRecords<T extends object>(kind: RecordKind): Promise<T[]> {
    return this.listRecordsFrom(this.records, kind);
  }

  private async listRecordsFrom<T extends object>(
    records: Repository<PlatformRecordRow>,
    kind: RecordKind
  ): Promise<T[]> {
    const rows = await records.find({
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
    await this.saveRecordTo(this.records, kind, id, data, siteId);
  }

  private async saveRecordTo<T extends object>(
    records: Repository<PlatformRecordRow>,
    kind: RecordKind,
    id: string,
    data: T,
    siteId: string | null
  ): Promise<void> {
    await records.save({
      kind,
      id,
      environment: this.config.environment,
      siteId,
      data: data as Record<string, unknown>
    });
  }

  private async lockLauncherNetworkLeasePool(
    manager: EntityManager,
    productId: string,
    leaseProfile: 'employee' | 'feishu' | 'anonymous'
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`mx-launcher:${this.config.environment}:${productId}`, `launcher-network-lease:${leaseProfile}`]
    );
  }

  private async lockLauncherProductNetwork(
    manager: EntityManager,
    productId: string
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`mx-launcher:${this.config.environment}`, `launcher-product-network:${productId}`]
    );
  }

  private async lockLauncherProductUserAccess(
    manager: EntityManager,
    productId: string,
    userId: string
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`mx-launcher:${this.config.environment}:launcher-product-user-access`, `${productId}:${userId}`]
    );
  }

  private async lockLauncherNetworkHandover(
    manager: EntityManager,
    transitionId: string
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`mx-launcher:${this.config.environment}:handover`, transitionId]
    );
  }

  private async lockLauncherNetworkHandoverDevice(
    manager: EntityManager,
    input: LauncherNetworkHandoverInput
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [
        `mx-launcher:${this.config.environment}:handover-device`,
        `${input.productId}:${input.installId}:${input.deviceId}:${input.publicKey}`
      ]
    );
  }

  private async lockLauncherNetworkPublicKey(
    manager: EntityManager,
    publicKey: string
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`mx-launcher:${this.config.environment}`, `launcher-network-public-key:${publicKey}`]
    );
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

  private async latestSiteSlotPlanForSite(
    siteId: string,
    records: Repository<PlatformRecordRow> = this.records
  ): Promise<SiteSlotPlan | null> {
    const plans = await this.listRecordsFrom<SiteSlotPlan>(records, 'site-slot-plan');
    return plans
      .filter((plan) => plan.siteId === siteId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  private async withLauncherNetworkMihomoSiteWriteLock<T>(
    siteId: string,
    run: (records: Repository<PlatformRecordRow>) => Promise<T>
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockLauncherNetworkMihomoSite(manager, siteId);
      return run(manager.getRepository(PlatformRecordEntity));
    });
  }

  private async lockLauncherNetworkMihomoSite(manager: EntityManager, siteId: string): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [`mx-launcher:${this.config.environment}:launcher-network-mihomo-site`, siteId]
    );
  }

  private async withUserOverseaEntitlementWriteLock<T>(
    userId: string,
    run: (manager: EntityManager, records: Repository<PlatformRecordRow>) => Promise<T>
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [`mx-launcher:${this.config.environment}:user-oversea-entitlement`, userId]
      );
      return run(manager, manager.getRepository(PlatformRecordEntity));
    });
  }

  private async defaultUserOverseaSiteIds(): Promise<string[]> {
    const siteId = await this.defaultUserOverseaSiteId();
    return siteId ? [siteId] : [];
  }

  /**
   * 兜底站点必须是「还在服役的」站点。
   *
   * 之前这里无条件返回 'oversea-main'：那台机器退役/归档之后，新用户仍然会被分到
   * 它上面，拿到一份指向死节点的订阅，而且客户端看不出问题在服务端。
   * 现在按 显式配置 -> 有活跃账号的在役站点 -> 任意在役站点 -> oversea-main 逐级降级。
   */
  private async defaultUserOverseaSiteId(): Promise<string | null> {
    const configured = await this.configuredDefaultOverseaSiteCandidates();
    const explicit = configured.find((item) => item.explicit);
    if (explicit && await this.overseaSiteIsServiceable(explicit.siteId)) return explicit.siteId;

    const sites = (await this.listRecords<LauncherNetworkMihomoSite>('launcher-network-mihomo-site'))
      .map((site) => normalizeLauncherNetworkMihomoSite(site))
      .filter((site) => site.status !== 'archived' && site.publicHost)
      .sort((a, b) => a.siteId.localeCompare(b.siteId));

    for (const site of sites) {
      const accounts = await this.listSiteSlotAccessAccounts(site.siteId);
      if (accounts.some((account) => account.status === 'active')) return site.siteId;
    }
    if (sites.length > 0) return sites[0].siteId;
    // 一个可用站点都没有时保留历史行为，让上层的 ensure 去报 blocked，
    // 而不是在这里返回 null 让 entitlement 静默变成空。
    return explicit?.siteId ?? 'oversea-main';
  }

  private async overseaSiteIsServiceable(siteId: string): Promise<boolean> {
    const site = await this.getLauncherNetworkMihomoSite(siteId);
    return Boolean(site && site.status !== 'archived' && site.publicHost);
  }

  /**
   * MX-H2I 的 product network 是平台默认出海站点的唯一权威来源。
   *
   * `listLauncherProductNetworks()` 按 mode/index/id 排序，谁排在前面纯属巧合；
   * 以前 `find(explicit)` 会随机挑中某个 standalone 产品的默认站点，admin 在
   * Site Registry 里改了默认也可能不生效。这里把 mx-h2i 顶到最前面。
   */
  private async configuredDefaultOverseaSiteCandidates(): Promise<Array<{ siteId: string; explicit: boolean }>> {
    return orderDefaultOverseaSiteCandidates(await this.listLauncherProductNetworks());
  }

  private async findUserCenterUserForInput(input: CreateUserInput): Promise<UserCenterUser | null> {
    const userId = input.userId?.trim();
    if (userId) {
      const user = await this.getRecord<UserCenterUser>('iam-user', userId);
      if (user) return user;
    }
    const candidates = [input.account, input.username, input.email].filter((value): value is string => typeof value === 'string');
    if (!candidates.length) return null;
    const users = await this.listRecords<UserCenterUser>('iam-user');
    return users.find((user) => candidates.some((candidate) => userMatchesLogin(user, candidate))) ?? null;
  }

  private async withUserCredentialSummary(user: UserCenterUser): Promise<UserCenterUser> {
    const credential = await this.getRecord<UserCenterUserCredential>('iam-user-credential', user.userId);
    return {
      ...user,
      credential: userCredentialSummary(credential, user.profile.externalIds)
    };
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

function releasePolicyDecisionForInput(input: ReleasePolicyInput): ReleasePolicyDecision {
  const componentKind = normalizeUpdatePolicy(input.componentKind);
  if (input.currentVersion === input.targetVersion) {
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
  return {
    componentKind,
    componentId: input.componentId,
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion,
    updateAvailable: true,
    ...releasePolicyByKind(componentKind)
  };
}

function isReleasePublisherRequestUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505'
    && candidate.constraint === 'uq_mx_release_publisher_request';
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
  return [...new Set(names.map((name) => canonicalSiteSlotAccessAccountName(String(name))))];
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
