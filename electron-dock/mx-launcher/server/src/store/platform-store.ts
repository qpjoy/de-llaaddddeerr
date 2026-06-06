import type {
  AnonymousEnrollment,
  AnonymousEnrollmentRequest,
  AppCenterApp,
  AuditEvent,
  AuditEventInput,
  ConfigSnapshot,
  IdentityLinkRequest,
  LauncherNetworkSnapshot,
  LauncherNetworkSnapshotInput,
  LogEntryInput,
  PermissionGrant,
  PermissionRequestInput,
  PlatformKernelSmokeResult,
  ReleasePolicyDecision,
  ReleasePolicyInput,
  ReleaseReportInput,
  ReleaseTask,
  RuntimeConfig,
  SiteHeartbeat,
  SiteRole,
  TestGateInput,
  TestGateVerdict,
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
  getSnapshot(installId: string): MaybePromise<ConfigSnapshot | null>;
  listTasks(installId: string): MaybePromise<ReleaseTask[]>;
  recordReleaseReport(input: ReleaseReportInput): MaybePromise<AuditEvent>;
  recordAudit(input: AuditEventInput): MaybePromise<AuditEvent>;
  recordLogs(entries: LogEntryInput[]): MaybePromise<{ accepted: number; sinks: RuntimeConfig['observabilitySinks'] }>;
  observabilitySinks(): MaybePromise<RuntimeConfig['observabilitySinks']>;
  listAppCenterApps(): MaybePromise<AppCenterApp[]>;
  getAppCenterApp(appId: string): MaybePromise<AppCenterApp | null>;
  requestPermission(input: PermissionRequestInput): MaybePromise<PermissionGrant>;
  createLauncherNetworkSnapshot(input: LauncherNetworkSnapshotInput): MaybePromise<LauncherNetworkSnapshot>;
  evaluateReleaseUpdate(input: ReleasePolicyInput): MaybePromise<ReleasePolicyDecision>;
  createTestRun(input: TestRunInput): MaybePromise<TestRun>;
  getTestRun(runId: string): MaybePromise<TestRun | null>;
  recordTestStep(runId: string, input: TestStepInput): MaybePromise<TestRun>;
  evaluateTestGate(input: TestGateInput): MaybePromise<TestGateVerdict>;
  runPlatformKernelSmoke(): MaybePromise<PlatformKernelSmokeResult>;
}
