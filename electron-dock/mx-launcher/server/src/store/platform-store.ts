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
  RuntimeFeaturePolicy,
  RuntimeFeaturePolicyInput,
  RuntimeConfig,
  SdkGatewayAccessDecision,
  SdkGatewayAccessInput,
  SdkGatewayManifest,
  SiteSlotExecutionInput,
  SiteSlotExecutionRun,
  SiteSlotPlan,
  SiteSlotPlanInput,
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
  UserCenterRole,
  UserCenterServiceAccount,
  UserCenterUser,
  UserOverseaEntitlement,
  UserOverseaEntitlementInput,
  UserOverseaAccountSyncReport,
  UserOverseaAccountSyncReportInput,
  UserOverseaSubscriptionRender,
  TestRun,
  TestRunInput,
  TestStepInput
} from '../types.js';

export type MaybePromise<T> = T | Promise<T>;

export interface PlatformOverview {
  environment: string;
  siteId: string;
  siteRole: SiteRole;
  enabledModules: string[];
  storeDriver: RuntimeConfig['storeDriver'];
  sites: number;
  enrollments: number;
  snapshots: number;
  configPolicySnapshots: number;
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
  awxProviderConfigs: number;
  dnsPolicies: number;
  dnsReverseProxyRoutes: number;
  dnsZoneSnapshots: number;
  coreDnsConfigMapSyncs: number;
  coreDnsConfigMapApplies: number;
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
  listUserOverseaEntitlements(): MaybePromise<UserOverseaEntitlement[]>;
  getUserOverseaEntitlement(userId: string): MaybePromise<UserOverseaEntitlement | null>;
  upsertUserOverseaEntitlement(input: UserOverseaEntitlementInput): MaybePromise<UserOverseaEntitlement>;
  recordUserOverseaAccountSyncReport(input: UserOverseaAccountSyncReportInput): MaybePromise<UserOverseaAccountSyncReport>;
  listUserOverseaAccountSyncReports(userId?: string | null, siteId?: string | null): MaybePromise<UserOverseaAccountSyncReport[]>;
  renderUserOverseaMihomoSubscription(userId: string): MaybePromise<UserOverseaSubscriptionRender | null>;
  listUserCenterServiceAccounts(): MaybePromise<UserCenterServiceAccount[]>;
  createUserCenterServiceAccount(input: CreateServiceAccountInput): MaybePromise<UserCenterServiceAccount>;
  issueUserCenterToken(input: IssueTokenInput): MaybePromise<UserCenterIssuedToken>;
  introspectToken(input: TokenIntrospectionInput): MaybePromise<TokenIntrospectionResult>;
  resolvePrincipalContext(input: PrincipalContextInput): MaybePromise<PrincipalContext>;
  sdkGatewayManifest(): MaybePromise<SdkGatewayManifest>;
  evaluateSdkGatewayAccess(input: SdkGatewayAccessInput): MaybePromise<SdkGatewayAccessDecision>;
  createConfigPolicySnapshot(input: ConfigPolicySnapshotInput): MaybePromise<ConfigPolicySnapshot>;
  getConfigPolicySnapshot(snapshotId: string): MaybePromise<ConfigPolicySnapshot | null>;
  listSiteSlotSshProfiles(): MaybePromise<SiteSlotSshProfile[]>;
  getSiteSlotSshProfile(profileId: string): MaybePromise<SiteSlotSshProfile | null>;
  getSiteSlotSshProfileForSite(siteId: string): MaybePromise<SiteSlotSshProfile | null>;
  upsertSiteSlotSshProfile(input: SiteSlotSshProfileInput): MaybePromise<SiteSlotSshProfile>;
  listSiteSlotDomesticWireGuardSecrets(): MaybePromise<SiteSlotDomesticWireGuardSecret[]>;
  getSiteSlotDomesticWireGuardSecret(siteId: string): MaybePromise<SiteSlotDomesticWireGuardSecret | null>;
  upsertSiteSlotDomesticWireGuardSecret(input: SiteSlotDomesticWireGuardSecretInput): MaybePromise<SiteSlotDomesticWireGuardSecret>;
  issueSiteSlotAccessAccounts(input: SiteSlotAccessAccountIssueInput): MaybePromise<SiteSlotAccessAccountIssueResult>;
  listSiteSlotAccessAccounts(siteId: string): MaybePromise<SiteSlotAccessAccount[]>;
  getSiteSlotAccessAccount(siteId: string, username: string): MaybePromise<SiteSlotAccessAccount | null>;
  upsertLauncherNetworkMihomoSite(input: LauncherNetworkMihomoSiteInput): MaybePromise<LauncherNetworkMihomoSite>;
  getLauncherNetworkMihomoSite(siteId: string): MaybePromise<LauncherNetworkMihomoSite | null>;
  getLauncherNetworkMihomoReachability(siteId: string): MaybePromise<LauncherNetworkReachabilityPlan | null>;
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
  listAppCenterApps(): MaybePromise<AppCenterApp[]>;
  getAppCenterApp(appId: string): MaybePromise<AppCenterApp | null>;
  listDnsPolicies(): MaybePromise<DnsPolicy[]>;
  getEffectiveDnsPolicy(appId?: string | null): MaybePromise<DnsPolicy>;
  evaluateDnsQuery(input: DnsQueryInput): MaybePromise<DnsResolutionDecision>;
  listDnsReverseProxyRoutes(): MaybePromise<DnsReverseProxyRoute[]>;
  buildDnsZoneSnapshot(input: DnsZoneSnapshotInput): MaybePromise<DnsZoneSnapshot>;
  getDnsZoneSnapshot(snapshotId: string): MaybePromise<DnsZoneSnapshot | null>;
  syncCoreDnsConfigMap(input: CoreDnsConfigMapSyncInput): MaybePromise<CoreDnsConfigMapSyncResult>;
  applyCoreDnsConfigMap(input: CoreDnsConfigMapApplyInput): MaybePromise<CoreDnsConfigMapApplyResult>;
  requestPermission(input: PermissionRequestInput): MaybePromise<PermissionGrant>;
  createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): MaybePromise<LauncherNetworkSnapshot>;
  evaluateReleaseUpdate(input: ReleasePolicyInput): MaybePromise<ReleasePolicyDecision>;
  createReleaseManagementPlan(input: ReleaseManagementPlanInput): MaybePromise<ReleaseManagementPlan>;
  getReleaseManagementPlan(planId: string): MaybePromise<ReleaseManagementPlan | null>;
  listReleaseManagementPlans(): MaybePromise<ReleaseManagementPlan[]>;
  createTestRun(input: TestRunInput): MaybePromise<TestRun>;
  getTestRun(runId: string): MaybePromise<TestRun | null>;
  recordTestStep(runId: string, input: TestStepInput): MaybePromise<TestRun>;
  evaluateTestGate(input: TestGateInput): MaybePromise<TestGateVerdict>;
  runPlatformKernelSmoke(): MaybePromise<PlatformKernelSmokeResult>;
}
