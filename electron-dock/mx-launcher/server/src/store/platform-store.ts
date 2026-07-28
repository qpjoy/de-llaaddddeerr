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
  IssueTokenInput,
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
  ReleaseReportInput,
  ReleaseTask,
  RuntimeFeaturePolicy,
  RuntimeFeaturePolicyInput,
  RuntimeConfig,
  SecretProviderConfig,
  SecretProviderConfigInput,
  SdkGatewayAccessDecision,
  SdkGatewayAccessInput,
  SdkGatewayManifest,
  SiteSlotExecutionInput,
  SiteSlotExecutionRun,
  SiteSlotPlan,
  SiteSlotPlanInput,
  SiteSlotDomesticRuntimeConfig,
  SiteSlotDomesticRuntimeConfigInput,
  SiteSlotDomesticWireGuardSecret,
  SiteSlotDomesticWireGuardSecretInput,
  SiteSlotAccessAccount,
  SiteSlotAccessAccountIssueInput,
  SiteSlotAccessAccountIssueResult,
  SiteSlotRollbackExecution,
  SiteSlotRollbackExecutionInput,
  SiteSlotRollbackReport,
  SiteSlotRollbackReportInput,
  SiteSlotRunnerSession,
  SiteSlotRunnerStartInput,
  SiteSlotSshProfile,
  SiteSlotSshProfileInput,
  SiteSlotKind,
  SiteSlotWorkerJob,
  SiteSlotWorkerJobInput,
  SiteSlotWorkerReport,
  SiteSlotWorkerReportInput,
  SiteHeartbeat,
  SiteRole,
  TestGateInput,
  TestGateVerdict,
  TokenIntrospectionInput,
  TokenIntrospectionResult,
  UserCenterBootstrapResult,
  UserCenterIssuedToken,
  ImportUserCenterUsersInput,
  ImportUserCenterUsersResult,
  ImportLegacyServiceAccountCredentialInput,
  IssueServiceAccountCredentialInput,
  UserCenterRole,
  UserCenterServiceAccount,
  UserCenterServiceAccountCredentialImportResult,
  UserCenterServiceAccountCredentialStatus,
  UserCenterServiceAccountCredentialVerificationResult,
  UserCenterIssuedServiceAccountCredential,
  UserCenterUserDeleteInput,
  UserCenterUserDeleteResult,
  UserCenterUser,
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
  TestStepInput
} from '../types.js';
import type {
  AuthenticationRateLimitDecision,
  AuthenticationRateLimitInput
} from '../lib/auth-rate-limit.js';

export type MaybePromise<T> = T | Promise<T>;

export type PublisherReleasePlanInput = ReleaseManagementPlanInput & {
  productId: string;
  requestId: string;
  publisherRequestFingerprint: string;
};

export type PublisherReleasePlanResult =
  | { outcome: 'created' | 'replayed'; plan: ReleaseManagementPlan }
  | { outcome: 'conflict'; planId: string };

export interface PlatformOverview {
  environment: string;
  siteId: string;
  siteRole: SiteRole;
  enabledModules: string[];
  storeDriver: RuntimeConfig['storeDriver'];
  publicBaseUrl: string;
  internalBaseUrl: string;
  sites: number;
  enrollments: number;
  snapshots: number;
  configPolicySnapshots: number;
  secretProviderConfigs: number;
  configSecretReferences: number;
  appCenterApps: number;
  userCenterUsers: number;
  userCenterServiceAccounts: number;
  userCenterTokens: number;
  siteSlotPlans: number;
  siteSlotExecutions: number;
  siteSlotRunnerSessions: number;
  siteSlotWorkerJobs: number;
  siteSlotWorkerReports: number;
  siteSlotRollbackExecutions: number;
  siteSlotRollbackReports: number;
  siteSlotDomesticRuntimeConfigs: number;
  awxProviderConfigs: number;
  dnsPolicies: number;
  dnsReverseProxyRoutes: number;
  dnsZoneSnapshots: number;
  coreDnsConfigMapSyncs: number;
  coreDnsConfigMapApplies: number;
  gatewayConfigMapSyncs: number;
  gatewayConfigMapApplies: number;
  releaseManagementPlans: number;
  permissionGrants: number;
  testRuns: number;
  auditEvents: number;
  logs: number;
}

export interface PlatformStore {
  overview(): MaybePromise<PlatformOverview>;
  upsertSiteHeartbeat(
    heartbeat: Omit<SiteHeartbeat, 'environment' | 'lastSeenAt' | 'siteRole'> & { siteRole?: SiteRole }
  ): MaybePromise<SiteHeartbeat>;
  listSites(): MaybePromise<SiteHeartbeat[]>;
  createSiteSlotPlan(input: SiteSlotPlanInput): MaybePromise<SiteSlotPlan>;
  getSiteSlotPlan(planId: string): MaybePromise<SiteSlotPlan | null>;
  listSiteSlotPlans(): MaybePromise<SiteSlotPlan[]>;
  createSiteSlotExecution(input: SiteSlotExecutionInput): MaybePromise<SiteSlotExecutionRun>;
  getSiteSlotExecution(runId: string): MaybePromise<SiteSlotExecutionRun | null>;
  listSiteSlotExecutions(planId?: string | null): MaybePromise<SiteSlotExecutionRun[]>;
  startSiteSlotRunnerSession(input: SiteSlotRunnerStartInput): MaybePromise<SiteSlotRunnerSession>;
  getSiteSlotRunnerSession(sessionId: string): MaybePromise<SiteSlotRunnerSession | null>;
  listSiteSlotRunnerSessions(runId?: string | null): MaybePromise<SiteSlotRunnerSession[]>;
  createSiteSlotWorkerJob(input: SiteSlotWorkerJobInput): MaybePromise<SiteSlotWorkerJob>;
  getSiteSlotWorkerJob(jobId: string): MaybePromise<SiteSlotWorkerJob | null>;
  listSiteSlotWorkerJobs(sessionId?: string | null): MaybePromise<SiteSlotWorkerJob[]>;
  recordSiteSlotWorkerReport(input: SiteSlotWorkerReportInput): MaybePromise<SiteSlotWorkerReport>;
  getSiteSlotWorkerReport(reportId: string): MaybePromise<SiteSlotWorkerReport | null>;
  listSiteSlotWorkerReports(jobId?: string | null): MaybePromise<SiteSlotWorkerReport[]>;
  createSiteSlotRollbackExecution(input: SiteSlotRollbackExecutionInput): MaybePromise<SiteSlotRollbackExecution>;
  getSiteSlotRollbackExecution(rollbackExecutionId: string): MaybePromise<SiteSlotRollbackExecution | null>;
  listSiteSlotRollbackExecutions(reportId?: string | null): MaybePromise<SiteSlotRollbackExecution[]>;
  recordSiteSlotRollbackReport(input: SiteSlotRollbackReportInput): MaybePromise<SiteSlotRollbackReport>;
  getSiteSlotRollbackReport(rollbackReportId: string): MaybePromise<SiteSlotRollbackReport | null>;
  listSiteSlotRollbackReports(rollbackExecutionId?: string | null): MaybePromise<SiteSlotRollbackReport[]>;
  enrollAnonymous(input: AnonymousEnrollmentRequest): MaybePromise<{
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
  }>;
  linkIdentity(input: IdentityLinkRequest): MaybePromise<{
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
    auditEvent: AuditEvent;
  }>;
  bootstrapUserCenter(): MaybePromise<UserCenterBootstrapResult>;
  listUserCenterRoles(): MaybePromise<UserCenterRole[]>;
  listUserCenterUsers(): MaybePromise<UserCenterUser[]>;
  createUserCenterUser(input: CreateUserInput): MaybePromise<UserCenterUser>;
  importUserCenterUsers(input: ImportUserCenterUsersInput): MaybePromise<ImportUserCenterUsersResult>;
  updateUserCenterPassword(input: UserPasswordUpdateInput): MaybePromise<UserPasswordUpdateResult>;
  deleteUserCenterUser(input: UserCenterUserDeleteInput): MaybePromise<UserCenterUserDeleteResult>;
  verifyUserCenterPassword(input: UserPasswordVerificationInput): MaybePromise<UserPasswordVerificationResult>;
  consumeAuthenticationRateLimits(
    inputs: AuthenticationRateLimitInput[]
  ): MaybePromise<AuthenticationRateLimitDecision[]>;
  listUserOverseaEntitlements(): MaybePromise<UserOverseaEntitlement[]>;
  getUserOverseaEntitlement(userId: string): MaybePromise<UserOverseaEntitlement | null>;
  upsertUserOverseaEntitlement(input: UserOverseaEntitlementInput): MaybePromise<UserOverseaEntitlement>;
  recordUserOverseaAccountSyncReport(input: UserOverseaAccountSyncReportInput): MaybePromise<UserOverseaAccountSyncReport>;
  listUserOverseaAccountSyncReports(userId?: string | null, siteId?: string | null): MaybePromise<UserOverseaAccountSyncReport[]>;
  renderUserOverseaMihomoSubscription(userId: string): MaybePromise<UserOverseaSubscriptionRender | null>;
  getUserH2oRuntimeProfile(userId: string, appId?: string | null): MaybePromise<UserH2oRuntimeProfile | null>;
  upsertUserH2oRuntimeProfile(input: UserH2oRuntimeProfileInput): MaybePromise<UserH2oRuntimeProfile>;
  listUserCenterServiceAccounts(): MaybePromise<UserCenterServiceAccount[]>;
  createUserCenterServiceAccount(input: CreateServiceAccountInput): MaybePromise<UserCenterServiceAccount>;
  listUserCenterServiceAccountCredentialStatuses(): MaybePromise<UserCenterServiceAccountCredentialStatus[]>;
  getUserCenterServiceAccountCredential(
    serviceAccountId: string
  ): MaybePromise<UserCenterServiceAccountCredentialStatus | null>;
  issueUserCenterServiceAccountCredential(
    input: IssueServiceAccountCredentialInput
  ): MaybePromise<UserCenterIssuedServiceAccountCredential>;
  verifyUserCenterServiceAccountCredential(
    input: VerifyServiceAccountCredentialInput
  ): MaybePromise<UserCenterServiceAccountCredentialVerificationResult>;
  importLegacyUserCenterServiceAccountCredential(
    input: ImportLegacyServiceAccountCredentialInput
  ): MaybePromise<UserCenterServiceAccountCredentialImportResult>;
  createFeishuAuthorizationTransaction(
    input: FeishuAuthorizationTransactionInput
  ): MaybePromise<FeishuAuthorizationTransaction>;
  consumeFeishuAuthorizationTransaction(
    transactionId: string
  ): MaybePromise<FeishuAuthorizationTransaction | null>;
  issueUserCenterToken(input: IssueTokenInput): MaybePromise<UserCenterIssuedToken>;
  introspectToken(input: TokenIntrospectionInput): MaybePromise<TokenIntrospectionResult>;
  resolvePrincipalContext(input: PrincipalContextInput): MaybePromise<PrincipalContext>;
  sdkGatewayManifest(): MaybePromise<SdkGatewayManifest>;
  evaluateSdkGatewayAccess(input: SdkGatewayAccessInput): MaybePromise<SdkGatewayAccessDecision>;
  createConfigPolicySnapshot(input: ConfigPolicySnapshotInput): MaybePromise<ConfigPolicySnapshot>;
  getConfigPolicySnapshot(snapshotId: string): MaybePromise<ConfigPolicySnapshot | null>;
  listSecretProviderConfigs(): MaybePromise<SecretProviderConfig[]>;
  getSecretProviderConfig(providerId: string): MaybePromise<SecretProviderConfig | null>;
  upsertSecretProviderConfig(input: SecretProviderConfigInput): MaybePromise<SecretProviderConfig>;
  listConfigSecretReferences(): MaybePromise<ConfigSecretReference[]>;
  getConfigSecretReference(secretRefId: string): MaybePromise<ConfigSecretReference | null>;
  upsertConfigSecretReference(input: ConfigSecretReferenceInput): MaybePromise<ConfigSecretReference>;
  listSiteSlotSshProfiles(): MaybePromise<SiteSlotSshProfile[]>;
  getSiteSlotSshProfile(profileId: string): MaybePromise<SiteSlotSshProfile | null>;
  getSiteSlotSshProfileForSite(siteId: string): MaybePromise<SiteSlotSshProfile | null>;
  upsertSiteSlotSshProfile(input: SiteSlotSshProfileInput): MaybePromise<SiteSlotSshProfile>;
  listSiteSlotDomesticWireGuardSecrets(): MaybePromise<SiteSlotDomesticWireGuardSecret[]>;
  getSiteSlotDomesticWireGuardSecret(siteId: string): MaybePromise<SiteSlotDomesticWireGuardSecret | null>;
  upsertSiteSlotDomesticWireGuardSecret(input: SiteSlotDomesticWireGuardSecretInput): MaybePromise<SiteSlotDomesticWireGuardSecret>;
  listSiteSlotDomesticRuntimeConfigs(): MaybePromise<SiteSlotDomesticRuntimeConfig[]>;
  getSiteSlotDomesticRuntimeConfig(siteId: string): MaybePromise<SiteSlotDomesticRuntimeConfig | null>;
  upsertSiteSlotDomesticRuntimeConfig(input: SiteSlotDomesticRuntimeConfigInput): MaybePromise<SiteSlotDomesticRuntimeConfig>;
  issueSiteSlotAccessAccounts(input: SiteSlotAccessAccountIssueInput): MaybePromise<SiteSlotAccessAccountIssueResult>;
  listSiteSlotAccessAccounts(siteId: string): MaybePromise<SiteSlotAccessAccount[]>;
  getSiteSlotAccessAccount(siteId: string, username: string): MaybePromise<SiteSlotAccessAccount | null>;
  upsertLauncherNetworkMihomoSite(input: LauncherNetworkMihomoSiteInput): MaybePromise<LauncherNetworkMihomoSite>;
  getLauncherNetworkMihomoSite(siteId: string): MaybePromise<LauncherNetworkMihomoSite | null>;
  getLauncherNetworkMihomoReachability(siteId: string): MaybePromise<LauncherNetworkReachabilityPlan | null>;
  listLauncherProductNetworks(): MaybePromise<LauncherProductNetwork[]>;
  getLauncherProductNetwork(productId: string): MaybePromise<LauncherProductNetwork | null>;
  upsertLauncherProductNetwork(input: LauncherProductNetworkInput): MaybePromise<LauncherProductNetwork>;
  listLauncherNetworkLeases(productId?: string | null): MaybePromise<LauncherNetworkLease[]>;
  getLauncherNetworkLease(leaseId: string): MaybePromise<LauncherNetworkLease | null>;
  enrollLauncherNetworkLease(input: LauncherNetworkLeaseInput): MaybePromise<LauncherNetworkLease>;
  releaseLauncherNetworkLease(leaseId: string, input?: LauncherNetworkLeaseReleaseInput): MaybePromise<LauncherNetworkLease>;
  listLauncherNetworkHandovers(): MaybePromise<LauncherNetworkHandover[]>;
  getLauncherNetworkHandover(transitionId: string): MaybePromise<LauncherNetworkHandover | null>;
  createLauncherNetworkHandover(input: LauncherNetworkHandoverInput): MaybePromise<LauncherNetworkHandover>;
  advanceLauncherNetworkHandover(input: LauncherNetworkHandoverAdvanceInput): MaybePromise<LauncherNetworkHandover>;
  renderHysteria2MihomoSubscription(siteId: string, username: string): MaybePromise<MihomoSubscriptionRender | null>;
  listRuntimeFeaturePolicies(featureKey?: string | null): MaybePromise<RuntimeFeaturePolicy[]>;
  getRuntimeFeaturePolicy(policyId: string): MaybePromise<RuntimeFeaturePolicy | null>;
  upsertRuntimeFeaturePolicy(input: RuntimeFeaturePolicyInput): MaybePromise<RuntimeFeaturePolicy>;
  listAwxProviderConfigs(kind?: SiteSlotKind | 'all' | null): MaybePromise<AwxProviderConfig[]>;
  getAwxProviderConfig(providerId: string): MaybePromise<AwxProviderConfig | null>;
  upsertAwxProviderConfig(input: AwxProviderConfigInput): MaybePromise<AwxProviderConfig>;
  getSnapshot(installId: string): MaybePromise<ConfigSnapshot | null>;
  listTasks(installId: string): MaybePromise<ReleaseTask[]>;
  recordReleaseReport(input: ReleaseReportInput): MaybePromise<AuditEvent>;
  recordAudit(input: AuditEventInput): MaybePromise<AuditEvent>;
  recordLogs(entries: LogEntryInput[]): MaybePromise<{ accepted: number; sinks: RuntimeConfig['observabilitySinks'] }>;
  observabilitySinks(): MaybePromise<RuntimeConfig['observabilitySinks']>;
  listAppOnboardingTemplates(): MaybePromise<AppOnboardingTemplate[]>;
  getAppOnboardingDefaults(input: AppOnboardingDefaultsInput): MaybePromise<AppOnboardingDefaults>;
  listAppCenterApps(input?: AppCenterAccessContextInput): MaybePromise<AppCenterApp[]>;
  evaluateAppCenterAccess(input: AppCenterAccessInput): MaybePromise<AppCenterAccessDecision>;
  getAppCenterApp(appId: string): MaybePromise<AppCenterApp | null>;
  upsertAppCenterApp(input: AppCenterAppInput): MaybePromise<AppCenterApp>;
  deleteAppCenterApp(appId: string): MaybePromise<boolean>;
  listAppCenterInstallations(input?: AppCenterInstallationQuery): MaybePromise<AppCenterInstallation[]>;
  upsertAppCenterInstallation(input: AppCenterInstallationInput): MaybePromise<AppCenterInstallation>;
  listDnsPolicies(): MaybePromise<DnsPolicy[]>;
  getEffectiveDnsPolicy(appId?: string | null): MaybePromise<DnsPolicy>;
  evaluateDnsQuery(input: DnsQueryInput): MaybePromise<DnsResolutionDecision>;
  listDnsReverseProxyRoutes(): MaybePromise<DnsReverseProxyRoute[]>;
  getDnsReverseProxyRoute(routeId: string): MaybePromise<DnsReverseProxyRoute | null>;
  upsertDnsReverseProxyRoute(input: DnsReverseProxyRouteInput): MaybePromise<DnsReverseProxyRoute>;
  deleteDnsReverseProxyRoute(routeId: string): MaybePromise<boolean>;
  buildDnsZoneSnapshot(input: DnsZoneSnapshotInput): MaybePromise<DnsZoneSnapshot>;
  getDnsZoneSnapshot(snapshotId: string): MaybePromise<DnsZoneSnapshot | null>;
  getGatewayRuntimeConfig(): MaybePromise<GatewayRuntimeConfig>;
  upsertGatewayRuntimeConfig(input: GatewayRuntimeConfigInput): MaybePromise<GatewayRuntimeConfig>;
  syncCoreDnsConfigMap(input: CoreDnsConfigMapSyncInput): MaybePromise<CoreDnsConfigMapSyncResult>;
  applyCoreDnsConfigMap(input: CoreDnsConfigMapApplyInput): MaybePromise<CoreDnsConfigMapApplyResult>;
  syncGatewayConfigMap(input: GatewayConfigMapSyncInput): MaybePromise<GatewayConfigMapSyncResult>;
  applyGatewayConfigMap(input: GatewayConfigMapApplyInput): MaybePromise<GatewayConfigMapApplyResult>;
  requestPermission(input: PermissionRequestInput): MaybePromise<PermissionGrant>;
  createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): MaybePromise<LauncherNetworkSnapshot>;
  evaluateReleaseUpdate(input: ReleasePolicyInput): MaybePromise<ReleasePolicyDecision>;
  createPublisherReleaseManagementPlan(
    input: PublisherReleasePlanInput
  ): MaybePromise<PublisherReleasePlanResult>;
  createReleaseManagementPlan(input: ReleaseManagementPlanInput): MaybePromise<ReleaseManagementPlan>;
  completeReleaseManagementGate(planId: string, input: ReleaseManagementGateInput): MaybePromise<ReleaseManagementPlan>;
  getReleaseManagementPlan(planId: string): MaybePromise<ReleaseManagementPlan | null>;
  listReleaseManagementPlans(): MaybePromise<ReleaseManagementPlan[]>;
  createTestRun(input: TestRunInput): MaybePromise<TestRun>;
  getTestRun(runId: string): MaybePromise<TestRun | null>;
  recordTestStep(runId: string, input: TestStepInput): MaybePromise<TestRun>;
  evaluateTestGate(input: TestGateInput): MaybePromise<TestGateVerdict>;
  runPlatformKernelSmoke(): MaybePromise<PlatformKernelSmokeResult>;
}
