import type {
  AnonymousEnrollment,
  AnonymousEnrollmentRequest,
  AppCenterApp,
  AuditEvent,
  AuditEventInput,
  ConfigSnapshot,
  DnsPolicy,
  DnsQueryInput,
  DnsResolutionDecision,
  DnsReverseProxyRoute,
  IdentityLinkRequest,
  LauncherNetworkSnapshot,
  LauncherNetworkSnapshotInput,
  LogEntryInput,
  PermissionGrant,
  PermissionRequestInput,
  PrincipalContext,
  PrincipalContextInput,
  PlatformKernelSmokeResult,
  ReleasePolicyDecision,
  ReleasePolicyInput,
  ReleaseReportInput,
  ReleaseTask,
  RuntimeConfig,
  SdkGatewayManifest,
  SiteHeartbeat,
  SiteRole,
  TestGateInput,
  TestGateVerdict,
  TokenIntrospectionInput,
  TokenIntrospectionResult,
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
  appCenterApps: number;
  dnsPolicies: number;
  dnsReverseProxyRoutes: number;
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
  enrollAnonymous(input: AnonymousEnrollmentRequest): MaybePromise<{
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
  }>;
  linkIdentity(input: IdentityLinkRequest): MaybePromise<{
    enrollment: AnonymousEnrollment;
    snapshot: ConfigSnapshot;
    auditEvent: AuditEvent;
  }>;
  introspectToken(input: TokenIntrospectionInput): MaybePromise<TokenIntrospectionResult>;
  resolvePrincipalContext(input: PrincipalContextInput): MaybePromise<PrincipalContext>;
  sdkGatewayManifest(): MaybePromise<SdkGatewayManifest>;
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
  requestPermission(input: PermissionRequestInput): MaybePromise<PermissionGrant>;
  createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): MaybePromise<LauncherNetworkSnapshot>;
  evaluateReleaseUpdate(input: ReleasePolicyInput): MaybePromise<ReleasePolicyDecision>;
  createTestRun(input: TestRunInput): MaybePromise<TestRun>;
  getTestRun(runId: string): MaybePromise<TestRun | null>;
  recordTestStep(runId: string, input: TestStepInput): MaybePromise<TestRun>;
  evaluateTestGate(input: TestGateInput): MaybePromise<TestGateVerdict>;
  runPlatformKernelSmoke(): MaybePromise<PlatformKernelSmokeResult>;
}
