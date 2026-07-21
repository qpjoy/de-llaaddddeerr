export type StoreDriver = 'memory' | 'postgres';
export type SiteRole = 'internal' | 'domestic' | 'oversea' | 'h-endpoint-dev';
export type GatewayRuntimeBackend = 'k8s' | 'host-nginx';

export interface RuntimeConfig {
  environment: string;
  siteId: string;
  siteRole: SiteRole;
  enabledModules: string[];
  host: string;
  port: number;
  publicBaseUrl: string;
  internalBaseUrl: string;
  storeDriver: StoreDriver;
  databaseUrl: string | null;
  observabilitySinks: ObservabilitySink[];
  runnerDryRunDefault: boolean;
  siteSlotRunnerRemoteExecutionEnabled: boolean;
  coreDnsK8sApplyEnabled: boolean;
  coreDnsK8sAllowedNamespace: string;
  coreDnsK8sAllowedConfigMapName: string;
  gatewayK8sApplyEnabled: boolean;
  gatewayK8sAllowedNamespace: string;
  gatewayK8sAllowedConfigMapName: string;
  gatewayApplyBackend: GatewayRuntimeBackend;
  gatewayHostNginxApplyEnabled: boolean;
  gatewayHostNginxConfigPath: string;
  gatewayHostNginxInternalApiUpstream: string | null;
  launcherNetworkSdkTestModeEnabled: boolean;
  gatewayAppPort: number;
  siteSlotSshKeyRoot: string;
}

export interface ObservabilitySink {
  kind: string;
  environment: string;
  url: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export interface SiteHeartbeat {
  siteId: string;
  environment: string;
  siteRole: SiteRole;
  kind: 'internal' | 'domestic-edge' | 'oversea-access' | 'h-endpoint' | 'unknown';
  version: string;
  capabilities: string[];
  metrics: Record<string, number>;
  lastSeenAt: string;
}

export type SiteSlotKind = 'domestic' | 'oversea';
export type SiteSlotNetworkMode = 'direct' | 'oversea-assisted' | 'offline-manual';

export interface SiteSlotPlanAccessAccountInput {
  username: string;
  authToken: string;
  status?: 'active' | 'paused' | string | null;
  upRate?: string | null;
  downRate?: string | null;
}

export interface SiteSlotPlanInput {
  siteId?: string | null;
  kind?: SiteSlotKind | null;
  sshProfileId?: string | null;
  sshProfile?: SiteSlotSshProfile | null;
  sshProfileError?: string | null;
  host?: string | null;
  sshUser?: string | null;
  sshPort?: number | null;
  rootAccess?: boolean | null;
  hasDocker?: boolean | null;
  hasOutboundInternet?: boolean | null;
  overseaSiteId?: string | null;
  overseaHost?: string | null;
  serverPorts?: string | null;
  exportPort?: number | null;
  internalBaseUrl?: string | null;
  workerInternalBaseUrl?: string | null;
  overseaCallbackBaseUrl?: string | null;
  domesticRuntimeConfig?: SiteSlotDomesticRuntimeConfig | null;
  accessAccounts?: SiteSlotPlanAccessAccountInput[] | null;
  requestId?: string | null;
  createdBy?: string | null;
}

export interface SiteSlotPreflightCheck {
  checkId: string;
  title: string;
  stage: 'local' | 'remote' | 'network' | 'security';
  severity: 'required' | 'recommended' | 'optional';
  requiresRoot: boolean;
  command: string;
  expected: string;
  remediation: string;
}

export interface SiteSlotDeploymentPhase {
  phaseId: string;
  title: string;
  mode: 'manual' | 'remote-ssh' | 'artifact-push' | 'runner-job' | 'admin-action';
  target: 'internal' | SiteSlotKind;
  required: boolean;
  commands: string[];
  notes: string[];
}

export interface SiteSlotPlan {
  planId: string;
  siteId: string;
  kind: SiteSlotKind;
  environment: string;
  status: 'planned' | 'blocked' | 'ready-for-preflight';
  host: string | null;
  ssh: {
    user: string;
    port: number;
    rootAccess: boolean;
    rootRequired: boolean;
    profileId: string | null;
    profileSource: 'config-center' | 'request-body' | 'none';
    profileStatus: 'active' | 'paused' | null;
    profileWarnings: string[];
  };
  network: {
    mode: SiteSlotNetworkMode;
    requiresOversea: boolean;
    overseaSiteId: string | null;
    overseaHost: string | null;
    qpTunnelCliMode: 'not-required' | 'tun-on' | 'server-on' | 'egress-on' | 'manual';
    notes: string[];
  };
  access: {
    oversea: {
      role: 'hysteria2-server' | 'not-required';
      components: string[];
      subscriptionSource: 'internal';
      tunnelCliRegistration: '@qpjoy/tunnel-cli';
    };
    internal: {
      mihomoDeployment: 'internal-managed';
      dnsAuthority: 'internal-coredns';
      wgRelayAccess: boolean;
      subscriptionStore: 'config-center';
      accountAuthority: 'internal';
      dnsPath: 'wg-relay-internal-dns';
      reservedInternalCidrs: string[];
      domesticGatewayIp: '10.88.0.1';
    };
    hEndpoint: {
      bootstrapPath: string[];
      directPath: string[];
      routingPolicy: 'cn-direct';
      internalOnlyRoutes: string[];
      externalPath: string[];
    };
  };
  services: {
    hostServices: string[];
    dockerStacks: string[];
    dockerPreferred: boolean;
    hostServiceReason: string;
  };
  runtime: {
    domestic: SiteSlotDomesticRuntimeConfig | null;
    oversea: SiteSlotOverseaRuntimeConfig | null;
  };
  preflightChecks: SiteSlotPreflightCheck[];
  deploymentPhases: SiteSlotDeploymentPhase[];
  warnings: string[];
  nextActions: string[];
  createdBy: string;
  createdAt: string;
}

export interface SiteSlotOverseaRuntimeConfig {
  serverPorts: string;
  firstServerPort: number;
  exportPort: number;
  exportBaseUrl: string | null;
  workerInternalBaseUrl: string | null;
  overseaCallbackBaseUrl: string | null;
  callbackMode: 'push-only' | 'remote-callback';
  warnings: string[];
}

export type SiteSlotExecutionAction = 'preflight' | 'apply';
export type SiteSlotExecutionMode = 'dry-run' | 'manual' | 'ssh';
export type SiteSlotExecutionStatus = 'ready' | 'blocked' | 'requires-confirmation';

export interface SiteSlotExecutionInput {
  planId?: string | null;
  action?: SiteSlotExecutionAction | null;
  mode?: SiteSlotExecutionMode | null;
  confirmApply?: boolean | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotExecutionStep {
  stepId: string;
  sourceId: string;
  title: string;
  target: 'internal' | SiteSlotKind;
  order: number;
  requiresRoot: boolean;
  command: string;
  expected: string;
  notes: string[];
}

export interface SiteSlotExecutionRun {
  runId: string;
  planId: string;
  siteId: string;
  kind: SiteSlotKind;
  environment: string;
  action: SiteSlotExecutionAction;
  mode: SiteSlotExecutionMode;
  status: SiteSlotExecutionStatus;
  dryRun: boolean;
  confirmApply: boolean;
  remoteExecution: {
    supported: boolean;
    boundary: 'manifest-only' | 'future-ssh-runner';
    reason: string;
  };
  gates: {
    planStatus: SiteSlotPlan['status'];
    applyConfirmed: boolean;
    remoteExecutionSupported: boolean;
    requiredStepCount: number;
  };
  warnings: string[];
  steps: SiteSlotExecutionStep[];
  nextActions: string[];
  createdBy: string;
  createdAt: string;
}

export type SiteSlotRunnerMode = 'simulate' | 'remote-ssh' | 'awx-shadow';
export type SiteSlotRunnerSessionStatus = 'completed' | 'blocked' | 'queued' | 'running' | 'passed' | 'failed' | 'rollback-required';
export type SiteSlotRunnerStepStatus = 'simulated' | 'blocked' | 'pending';

export interface SiteSlotRunnerStartInput {
  runId?: string | null;
  mode?: SiteSlotRunnerMode | null;
  confirmRemoteExecution?: boolean | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotRunnerStepResult {
  stepId: string;
  sourceId: string;
  order: number;
  target: 'internal' | SiteSlotKind;
  status: SiteSlotRunnerStepStatus;
  command: string;
  exitCode: number | null;
  output: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SiteSlotRunnerSession {
  sessionId: string;
  runId: string;
  planId: string;
  siteId: string;
  kind: SiteSlotKind;
  environment: string;
  mode: SiteSlotRunnerMode;
  status: SiteSlotRunnerSessionStatus;
  dryRun: boolean;
  confirmRemoteExecution: boolean;
  gates: {
    executionStatus: SiteSlotExecutionStatus;
    remoteExecutionEnabled: boolean;
    remoteExecutionConfirmed: boolean;
    stepCount: number;
  };
  warnings: string[];
  stepResults: SiteSlotRunnerStepResult[];
  currentWorkerJobId: string | null;
  currentReportId: string | null;
  rollbackPlan: SiteSlotRollbackPlan | null;
  nextActions: string[];
  createdBy: string;
  startedAt: string;
  finishedAt: string | null;
}

export type SiteSlotWorkerKind = 'internal-runner' | 'domestic-runner' | 'oversea-site-agent' | 'awx-runner' | 'admin-manual';
export type SiteSlotWorkerJobStatus = 'ready' | 'blocked' | 'running' | 'passed' | 'failed' | 'rollback-required';
export type SiteSlotWorkerReportStatus = 'running' | 'passed' | 'failed' | 'blocked';

export interface SiteSlotWorkerJobInput {
  sessionId?: string | null;
  workerId?: string | null;
  workerKind?: SiteSlotWorkerKind | null;
  approvalId?: string | null;
  changeWindowStart?: string | null;
  changeWindowEnd?: string | null;
  retryLimit?: number | null;
  rollbackStrategy?: string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotWorkerJobStep {
  stepId: string;
  sourceId: string;
  order: number;
  target: 'internal' | SiteSlotKind;
  command: string;
  requiresRoot: boolean;
  timeoutSeconds: number;
  stopOnFailure: boolean;
  redactOutput: boolean;
}

export interface SiteSlotWorkerJob {
  jobId: string;
  contractVersion: 'site-slot-worker-v1';
  sessionId: string;
  runId: string;
  planId: string;
  siteId: string;
  kind: SiteSlotKind;
  environment: string;
  mode: SiteSlotRunnerMode;
  status: SiteSlotWorkerJobStatus;
  dryRun: boolean;
  worker: {
    workerId: string;
    kind: SiteSlotWorkerKind;
  };
  approval: {
    required: boolean;
    approvalId: string | null;
    status: 'not-required' | 'recorded' | 'missing';
  };
  changeWindow: {
    start: string | null;
    end: string | null;
    required: boolean;
  };
  retryPolicy: {
    maxAttempts: number;
    stopOnFailure: boolean;
  };
  rollbackPolicy: {
    strategy: string;
    requiredOnFailure: boolean;
  };
  steps: SiteSlotWorkerJobStep[];
  warnings: string[];
  currentReportId: string | null;
  rollbackPlan: SiteSlotRollbackPlan | null;
  updatedAt: string | null;
  nextActions: string[];
  createdBy: string;
  createdAt: string;
}

export interface SiteSlotRollbackStep {
  stepId: string;
  order: number;
  target: 'internal' | SiteSlotKind;
  title: string;
  command: string;
  requiresApproval: boolean;
}

export interface SiteSlotRollbackPlan {
  rollbackPlanId: string;
  jobId: string;
  sessionId: string;
  runId: string;
  planId: string;
  siteId: string;
  environment: string;
  required: boolean;
  status: 'not-required' | 'planned';
  reason: string;
  strategy: string;
  steps: SiteSlotRollbackStep[];
  createdAt: string;
}

export interface SiteSlotWorkerStepReportInput {
  stepId?: string | null;
  status?: SiteSlotWorkerReportStatus | null;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  attempt?: number | null;
}

export interface SiteSlotWorkerReportInput {
  jobId?: string | null;
  workerId?: string | null;
  status?: SiteSlotWorkerReportStatus | null;
  message?: string | null;
  stepReports?: SiteSlotWorkerStepReportInput[];
  requestId?: string | null;
}

export interface SiteSlotWorkerStepReport {
  stepId: string;
  sourceId: string;
  order: number;
  status: SiteSlotWorkerReportStatus;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempt: number;
}

export interface SiteSlotWorkerReport {
  reportId: string;
  jobId: string;
  sessionId: string;
  runId: string;
  planId: string;
  siteId: string;
  environment: string;
  workerId: string;
  status: SiteSlotWorkerReportStatus;
  message: string | null;
  stepReports: SiteSlotWorkerStepReport[];
  rollbackPlan: SiteSlotRollbackPlan | null;
  nextActions: string[];
  createdAt: string;
}

export type SiteSlotRollbackExecutionMode = 'simulate' | 'manual';
export type SiteSlotRollbackExecutionStatus = 'ready' | 'blocked' | 'running' | 'passed' | 'failed';
export type SiteSlotRollbackStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked';
export type SiteSlotRollbackReportStatus = 'running' | 'passed' | 'failed' | 'blocked';

export interface SiteSlotRollbackExecutionInput {
  reportId?: string | null;
  mode?: SiteSlotRollbackExecutionMode | null;
  confirmRollback?: boolean | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotRollbackExecutionStepResult {
  stepId: string;
  order: number;
  target: 'internal' | SiteSlotKind;
  status: SiteSlotRollbackStepStatus;
  command: string;
  exitCode: number | null;
  output: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SiteSlotRollbackExecution {
  rollbackExecutionId: string;
  contractVersion: 'site-slot-rollback-v1';
  rollbackPlanId: string | null;
  sourceReportId: string;
  jobId: string;
  sessionId: string;
  runId: string;
  planId: string;
  siteId: string;
  environment: string;
  mode: SiteSlotRollbackExecutionMode;
  status: SiteSlotRollbackExecutionStatus;
  dryRun: boolean;
  confirmRollback: boolean;
  rollbackPlan: SiteSlotRollbackPlan | null;
  gates: {
    workerReportStatus: SiteSlotWorkerReportStatus;
    rollbackPlanStatus: SiteSlotRollbackPlan['status'] | null;
    rollbackRequired: boolean;
    rollbackConfirmed: boolean;
    stepCount: number;
  };
  warnings: string[];
  stepResults: SiteSlotRollbackExecutionStepResult[];
  currentRollbackReportId: string | null;
  nextActions: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface SiteSlotRollbackStepReportInput {
  stepId?: string | null;
  status?: SiteSlotRollbackReportStatus | null;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  attempt?: number | null;
}

export interface SiteSlotRollbackReportInput {
  rollbackExecutionId?: string | null;
  workerId?: string | null;
  status?: SiteSlotRollbackReportStatus | null;
  message?: string | null;
  stepReports?: SiteSlotRollbackStepReportInput[];
  requestId?: string | null;
}

export interface SiteSlotRollbackStepReport {
  stepId: string;
  order: number;
  target: 'internal' | SiteSlotKind;
  status: SiteSlotRollbackReportStatus;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempt: number;
}

export interface SiteSlotRollbackReport {
  rollbackReportId: string;
  rollbackExecutionId: string;
  rollbackPlanId: string | null;
  sourceReportId: string;
  jobId: string;
  sessionId: string;
  runId: string;
  planId: string;
  siteId: string;
  environment: string;
  workerId: string;
  status: SiteSlotRollbackReportStatus;
  message: string | null;
  stepReports: SiteSlotRollbackStepReport[];
  nextActions: string[];
  createdAt: string;
}

export type AdminPipelineHealth = 'planned' | 'ready' | 'running' | 'passed' | 'failed' | 'blocked' | 'rollback';

export interface AdminTimelineEntry {
  id: string;
  kind: 'plan' | 'execution' | 'runner-session' | 'worker-job' | 'worker-report' | 'rollback-execution' | 'rollback-report';
  status: string;
  title: string;
  at: string;
  parentId: string | null;
  nextActions: string[];
}

export type AdminActionCategory = 'release' | 'site-slot' | 'dns' | 'observability' | 'rbac';
export type AdminActionGate = 'none' | 'confirm-apply' | 'confirm-remote-execution' | 'confirm-fake-transport' | 'confirm-rollback' | 'manual-evidence' | 'change-window' | 'internal-secret-materialize';
export type AdminActionRisk = 'low' | 'medium' | 'high';

export interface AdminActionDescriptor {
  actionId: string;
  label: string;
  category: AdminActionCategory;
  method: 'GET' | 'POST';
  path: string;
  requiredScopes: string[];
  gate: AdminActionGate;
  risk: AdminActionRisk;
  allowed: boolean;
  reason: string;
  confirmFields: string[];
  bodyTemplate: Record<string, unknown>;
}

export interface AdminActionPolicy {
  authMode: 'shadow-rbac-v1';
  principal: PlatformPrincipal;
  warnings: string[];
  actions: AdminActionDescriptor[];
}

export interface AdminSiteSlotPipelineSummary {
  planId: string;
  siteId: string;
  kind: SiteSlotKind;
  environment: string;
  status: SiteSlotPlan['status'];
  health: AdminPipelineHealth;
  currentStage: string;
  latestStatus: string;
  latestUpdatedAt: string;
  counts: {
    executions: number;
    runnerSessions: number;
    workerJobs: number;
    workerReports: number;
    rollbackExecutions: number;
    rollbackReports: number;
  };
  warnings: string[];
  failureSummary: {
    phase: string;
    stepId: string;
    status: string;
    message: string;
  } | null;
  domesticWireGuard?: {
    status: string;
    publicEndpoint: string | null;
    listenPort: number;
    internalDirectEnabled: boolean;
    internalDirectEndpoint: string | null;
    internalDirectListenPort: number;
    internalServiceIp: string;
    materialDigest: string | null;
    updatedAt: string | null;
  } | null;
  nextActions: string[];
  actionHints: AdminActionDescriptor[];
}

export interface AdminSiteSlotPipeline {
  summary: AdminSiteSlotPipelineSummary;
  plan: SiteSlotPlan;
  executions: SiteSlotExecutionRun[];
  runnerSessions: SiteSlotRunnerSession[];
  workerJobs: SiteSlotWorkerJob[];
  workerReports: SiteSlotWorkerReport[];
  rollbackExecutions: SiteSlotRollbackExecution[];
  rollbackReports: SiteSlotRollbackReport[];
  timeline: AdminTimelineEntry[];
}

export type AdminLauncherServiceVipSmokeStatus = 'passed' | 'warning' | 'blocked';

export interface AdminLauncherServiceVipSmokeCheck {
  checkId: string;
  label: string;
  status: AdminLauncherServiceVipSmokeStatus;
  detail: string;
  expected: string | null;
  actual: string | null;
}

export interface AdminLauncherServiceVipSmoke {
  appId: string;
  productId: string;
  displayName: string;
  launcherMode: LauncherProductMode;
  networkScope: LauncherNetworkScope;
  channelProductId: string;
  serviceVip: string | null;
  dnsHost: string;
  dnsRouteId: string | null;
  upstreamUrl: string | null;
  latestLeaseIp: string | null;
  domesticSiteId: string;
  status: AdminLauncherServiceVipSmokeStatus;
  summary: string;
  checks: AdminLauncherServiceVipSmokeCheck[];
  nextActions: string[];
  generatedAt: string;
}

export interface AdminDashboardSnapshot {
  generatedAt: string;
  overview: Record<string, unknown>;
  actionPolicy: AdminActionPolicy;
  sites: SiteHeartbeat[];
  latestReleasePlans: ReleaseManagementPlan[];
  siteSlotPipelines: AdminSiteSlotPipelineSummary[];
  awxProviders: AwxProviderConfig[];
  runtimeFeaturePolicies: RuntimeFeaturePolicy[];
  launcherServiceVipSmokes: AdminLauncherServiceVipSmoke[];
  nextActions: string[];
}

export interface AnonymousEnrollmentRequest {
  productId?: string;
  siteId?: string;
  installId?: string;
  deviceId?: string;
  deviceLabel?: string;
  platform?: string;
  publicKey?: string;
  relayMode?: string;
  requestId?: string;
}

export interface AnonymousEnrollment {
  anonymousPrincipalId: string;
  installId: string;
  deviceId: string;
  productId: string;
  siteId: string;
  environment: string;
  overlayIp: string;
  relayMode: string;
  publicKey: string | null;
  createdAt: string;
  userId: string | null;
}

export interface IdentityLinkRequest {
  installId: string;
  userId: string;
  requestId?: string;
  authProvider?: string;
}

export interface UserCenterTenant {
  tenantId: string;
  displayName: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface UserCenterOrg {
  orgId: string;
  tenantId: string;
  displayName: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface UserCenterRole {
  roleId: string;
  displayName: string;
  scopes: string[];
  createdAt: string;
}

export interface UserCenterUserProfile {
  title: string | null;
  department: string | null;
  location: string | null;
  address: string | null;
  phone: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  externalIds: Record<string, string>;
}

export interface UserCenterUserCredentialSummary {
  hasPassword: boolean;
  passwordUpdatedAt: string | null;
  providers: string[];
}

export interface UserCenterAppAccess {
  homeAppId: string | null;
  registeredByAppId: string | null;
  allowedAppIds: string[];
  deniedAppIds: string[];
}

export interface UserCenterUser {
  userId: string;
  tenantId: string;
  orgIds: string[];
  account: string;
  email: string | null;
  displayName: string;
  roleIds: string[];
  status: 'active' | 'disabled';
  profile: UserCenterUserProfile;
  credential: UserCenterUserCredentialSummary;
  appAccess: UserCenterAppAccess;
  createdAt: string;
  updatedAt: string;
}

export interface UserCenterUserCredential {
  credentialId: string;
  userId: string;
  kind: 'local-password';
  passwordHash: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface UserCenterServiceAccount {
  serviceAccountId: string;
  tenantId: string;
  displayName: string;
  roleIds: string[];
  scopes: string[];
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface UserCenterTokenRecord {
  tokenId: string;
  tokenHash: string;
  subjectKind: 'user' | 'service-account';
  subjectId: string;
  audience: string;
  scopes: string[];
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface UserCenterIssuedToken {
  token: string;
  record: UserCenterTokenRecord;
}

export interface UserCenterBootstrapResult {
  tenant: UserCenterTenant;
  org: UserCenterOrg;
  roles: UserCenterRole[];
  users: UserCenterUser[];
  serviceAccounts: UserCenterServiceAccount[];
}

export interface CreateUserInput {
  userId?: string | null;
  account?: string | null;
  username?: string | null;
  email?: string | null;
  displayName?: string | null;
  password?: string | null;
  roleIds?: string[];
  orgIds?: string[];
  status?: 'active' | 'disabled' | string | null;
  profile?: Partial<UserCenterUserProfile> | null;
  attributes?: Record<string, unknown> | null;
  externalIds?: Record<string, string> | null;
  appAccess?: Partial<UserCenterAppAccess> | null;
  homeAppId?: string | null;
  registeredByAppId?: string | null;
  allowedAppIds?: string[] | string | null;
  deniedAppIds?: string[] | string | null;
  defaultOverseaSiteIds?: string[] | string | null;
  provisionOversea?: boolean | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface ImportUserCenterUserRow {
  id?: string | number | null;
  userId?: string | null;
  account?: string | null;
  username?: string | null;
  user_name?: string | null;
  email?: string | null;
  displayName?: string | null;
  display_name?: string | null;
  password?: string | null;
  profile?: Partial<UserCenterUserProfile> | null;
  attributes?: Record<string, unknown> | null;
  externalIds?: Record<string, string> | null;
  appAccess?: Partial<UserCenterAppAccess> | null;
  homeAppId?: string | null;
  registeredByAppId?: string | null;
  allowedAppIds?: string[] | string | null;
  deniedAppIds?: string[] | string | null;
}

export interface ImportUserCenterUsersInput {
  users: ImportUserCenterUserRow[];
  defaultRoleIds?: string[];
  defaultOrgIds?: string[];
  defaultHomeAppId?: string | null;
  defaultRegisteredByAppId?: string | null;
  defaultAllowedAppIds?: string[] | string | null;
  defaultOverseaSiteIds?: string[] | string | null;
  provisionOversea?: boolean | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface ImportUserCenterUsersResult {
  imported: number;
  updated: number;
  failed: number;
  users: UserCenterUser[];
  entitlements: UserOverseaEntitlement[];
  failures: Array<{
    index: number;
    account: string | null;
    reason: string;
  }>;
  generatedAt: string;
}

export interface UserPasswordVerificationInput {
  userId?: string | null;
  password?: string | null;
  requestId?: string | null;
}

export interface UserPasswordVerificationResult {
  userId: string;
  ok: boolean;
  hasPassword: boolean;
  reason: string;
}

export interface UserPasswordUpdateInput {
  userId?: string | null;
  password?: string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface UserPasswordUpdateResult {
  user: UserCenterUser;
  tokensRevoked: number;
  updatedAt: string;
}

export interface UserCenterUserDeleteInput {
  userId?: string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface UserCenterUserDeleteResult {
  deleted: true;
  userId: string;
  account: string;
  deletedRecords: {
    credential: number;
    tokens: number;
    overseaEntitlements: number;
    h2oRuntimeProfiles: number;
    appInstallations: number;
    permissionGrants: number;
  };
  deletedAt: string;
}

export interface UserCenterUserDeletionTombstone {
  tombstoneId: string;
  userId: string;
  account: string;
  deletedAt: string;
  requestedBy: string;
}

export interface CreateServiceAccountInput {
  serviceAccountId?: string | null;
  displayName?: string | null;
  roleIds?: string[];
  scopes?: string[];
  requestId?: string | null;
}

export interface IssueTokenInput {
  subjectKind: 'user' | 'service-account';
  subjectId: string;
  audience?: string | null;
  scopes?: string[];
  ttlSeconds?: number | null;
  requestId?: string | null;
}

export type PrincipalKind = 'anonymous' | 'user' | 'service-account' | 'unknown';

export interface PlatformPrincipal {
  principalId: string;
  kind: PrincipalKind;
  tenantId: string;
  orgIds: string[];
  displayName: string;
  userId: string | null;
  anonymousPrincipalId: string | null;
  serviceAccountId: string | null;
  roles: string[];
  scopes: string[];
}

export interface TokenIntrospectionInput {
  token?: string | null;
  audience?: string | null;
  requestId?: string | null;
}

export interface TokenIntrospectionResult {
  active: boolean;
  tokenKind: 'oauth2-access-token' | 'jwt' | 'service-token' | 'shadow-token' | 'unknown';
  issuer: string;
  audience: string | null;
  subject: string | null;
  principal: PlatformPrincipal | null;
  scopes: string[];
  expiresAt: string | null;
  reason: string;
}

export interface PrincipalContextInput {
  token?: string | null;
  audience?: string | null;
  userId?: string | null;
  anonymousPrincipalId?: string | null;
  serviceAccountId?: string | null;
  installId?: string | null;
  requestId?: string | null;
}

export interface PrincipalContext {
  principal: PlatformPrincipal;
  auth: TokenIntrospectionResult;
  bindings: {
    installId: string | null;
    deviceId: string | null;
    anonymousPrincipalId: string | null;
    linkedUserId: string | null;
  };
  gateway: {
    authority: 'sdk-gateway';
    canUseSdkGateway: boolean;
    allowedRoutes: string[];
  };
  source: 'token' | 'identity-binding' | 'service-account' | 'anonymous' | 'unknown';
}

export interface SdkGatewayRoute {
  routeId: string;
  path: string;
  upstreamModule: string;
  audience: string;
  authRequired: boolean;
  description: string;
}

export interface SdkGatewayManifest {
  gatewayId: string;
  environment: string;
  siteId: string;
  authority: 'sdk-gateway';
  authAuthority: 'user-center';
  basePath: '/internal/v1/sdk';
  modules: string[];
  routes: SdkGatewayRoute[];
  sdk: {
    audience: string;
    oauthTokenUrl: string;
    tokenIntrospectionUrl: string;
    principalContextUrl: string;
    rolesUrl: string;
    usersUrl: string;
    serviceAccountsUrl: string;
    permissionsRequestUrl: string;
    configSnapshotUrl: string;
    dnsPolicyUrl: string;
    dnsEvaluateUrl: string;
    dnsZoneUrl: string;
    dnsCoreDnsConfigMapUrl: string;
    auditUrl: string;
    observabilityLogsUrl: string;
    documentationUrl: string;
    openApiUrl: string;
    markdownUrl: string;
  };
}

export interface SdkGatewayAccessInput {
  token?: string | null;
  audience?: string | null;
  routeId: string;
  appId?: string | null;
  sourceAppId?: string | null;
  requestId?: string | null;
}

export interface SdkGatewayAccessDecision {
  routeId: string;
  allowed: boolean;
  principal: PlatformPrincipal | null;
  matchedScopes: string[];
  missingScopes: string[];
  appAccess: AppCenterAccessDecision | null;
  reason: string;
}

export interface ConfigSnapshot {
  snapshotId: string;
  environment: string;
  siteId: string;
  productId: string;
  installId: string;
  deviceId: string;
  anonymousPrincipalId: string;
  userId: string | null;
  version: number;
  issuedAt: string;
  expiresAt: string;
  config: Record<string, unknown>;
  endpoints: {
    publicBaseUrl: string;
    internalBaseUrl: string;
    preferredAfterRelay: 'domestic' | 'internal';
    fallbackOrder: Array<'domestic' | 'internal'>;
  };
  observability: {
    level: string;
    sinks: ObservabilitySink[];
  };
  release: {
    channel: string;
    tasksUrl: string;
  };
  resources: Array<{
    kind: string;
    url: string;
    sha256: string;
  }>;
  signatures: {
    algorithm: string;
    digest: string;
    issuer: string;
  };
}

export interface ConfigPolicySnapshotInput {
  installId?: string | null;
  deviceId?: string | null;
  appId?: string | null;
  sourceAppId?: string | null;
  productId?: string | null;
  channel?: string | null;
  userId?: string | null;
  token?: string | null;
  audience?: string | null;
  requestId?: string | null;
}

export interface SiteSlotSshProfileInput {
  profileId?: string | null;
  siteId?: string | null;
  kind?: SiteSlotKind | null;
  host?: string | null;
  sshUser?: string | null;
  sshPort?: number | null;
  identityFile?: string | null;
  knownHostsFile?: string | null;
  sshConfigFile?: string | null;
  hostKeyAlias?: string | null;
  serverPorts?: string | null;
  exportPort?: number | null;
  internalBaseUrl?: string | null;
  workerInternalBaseUrl?: string | null;
  overseaCallbackBaseUrl?: string | null;
  strictHostKeyChecking?: 'yes' | 'no' | 'ask' | 'accept-new' | string | null;
  connectTimeoutSeconds?: number | null;
  batchMode?: 'yes' | 'no' | string | null;
  status?: 'active' | 'paused' | string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotSshProfileBootstrapInput {
  profileId?: string | null;
  siteId?: string | null;
  kind?: SiteSlotKind | null;
  host?: string | null;
  sshUser?: string | null;
  sshPort?: number | null;
  password?: string | null;
  hostKeyAlias?: string | null;
  serverPorts?: string | null;
  exportPort?: number | null;
  internalBaseUrl?: string | null;
  workerInternalBaseUrl?: string | null;
  overseaCallbackBaseUrl?: string | null;
  connectTimeoutSeconds?: number | null;
  rotateKey?: boolean | null;
  scanHostKey?: boolean | null;
  executeBootstrap?: boolean | null;
  confirmBootstrap?: boolean | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotSshProfileBootstrapResult {
  status: 'planned' | 'blocked' | 'passed' | 'failed';
  execution: 'not-started' | 'blocked' | 'completed' | 'failed';
  boundary: 'ssh-password-bootstrap';
  profileId: string;
  siteId: string;
  kind: SiteSlotKind;
  host: string | null;
  sshUser: string;
  sshPort: number;
  key: {
    rootDir: string;
    identityFile: string;
    publicKeyFile: string;
    sshConfigFile: string;
    generated: boolean;
    rotated: boolean;
  };
  knownHosts: {
    file: string;
    scanned: boolean;
    status: 'not-requested' | 'passed' | 'failed';
    lineCount: number;
  };
  install: {
    requested: boolean;
    command: string;
    verifyCommand: string;
    status: 'not-requested' | 'blocked' | 'passed' | 'failed';
    exitCode: number | null;
    stdout: string | null;
    stderr: string | null;
  };
  gates: {
    envGate: {
      status: 'passed' | 'blocked';
      variable: 'SITE_SLOT_SSH_PASSWORD_BOOTSTRAP_ENABLED';
    };
    requestGate: {
      status: 'passed' | 'blocked';
      confirmBootstrap: boolean;
      hasPassword: boolean;
    };
  };
  warnings: string[];
  nextActions: string[];
}

export interface SiteSlotSshProfile {
  profileId: string;
  siteId: string;
  kind: SiteSlotKind;
  environment: string;
  host: string | null;
  sshUser: string;
  sshPort: number;
  identityFile: string | null;
  knownHostsFile: string | null;
  sshConfigFile: string | null;
  hostKeyAlias: string | null;
  serverPorts: string | null;
  exportPort: number | null;
  workerInternalBaseUrl: string | null;
  overseaCallbackBaseUrl: string | null;
  strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new';
  connectTimeoutSeconds: number;
  batchMode: 'yes' | 'no';
  status: 'active' | 'paused';
  source: 'config-center';
  warnings: string[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface SiteSlotDomesticWireGuardSecretInput {
  siteId?: string | null;
  status?: 'active' | 'paused' | string | null;
  publicEndpoint?: string | null;
  listenPort?: number | null;
  internalDirectEnabled?: boolean | null;
  internalDirectEndpoint?: string | null;
  internalDirectListenPort?: number | null;
  domesticGatewayIp?: string | null;
  domesticGatewayCidr?: string | null;
  productRelayCidrs?: string[] | null;
  userRelayCidr?: string | null;
  internalServiceIp?: string | null;
  internalServiceCidr?: string | null;
  guestRelayCidr?: string | null;
  domesticRelayPrivateKey?: string | null;
  domesticRelayPublicKey?: string | null;
  internalServicePrivateKey?: string | null;
  internalServicePublicKey?: string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotDomesticWireGuardSecret {
  secretId: string;
  siteId: string;
  kind: 'domestic';
  environment: string;
  status: 'active' | 'paused';
  publicEndpoint: string | null;
  listenPort: number;
  internalDirectEnabled: boolean;
  internalDirectEndpoint: string | null;
  internalDirectListenPort: number;
  domesticGatewayIp: string;
  domesticGatewayCidr: string;
  productRelayCidrs: string[];
  userRelayCidr: string;
  internalServiceIp: string;
  internalServiceCidr: string;
  guestRelayCidr: string;
  domesticRelayPrivateKey: string | null;
  domesticRelayPublicKey: string | null;
  internalServicePrivateKey: string | null;
  internalServicePublicKey: string | null;
  fingerprints: {
    domesticRelayPublicKey: string | null;
    internalServicePublicKey: string | null;
    materialDigest: string;
  };
  readiness: {
    secretMaterial: 'injected' | 'placeholder';
    publicEndpointStatus: 'ready' | 'placeholder';
    missingSecretInputs: string[];
    materializerEnvKeys: string[];
  };
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface SiteSlotDomesticRuntimeConfigInput {
  siteId?: string | null;
  status?: 'active' | 'paused' | string | null;
  edgeBind?: string | null;
  edgePort?: number | null;
  bootstrapProtocol?: string | null;
  bootstrapHost?: string | null;
  bootstrapPort?: number | null;
  internalBaseUrl?: string | null;
  internalApiUpstream?: string | null;
  internalH2iUpstream?: string | null;
  dnsBind?: string | null;
  dnsPort?: number | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotDomesticRuntimeConfig {
  configId: string;
  siteId: string;
  kind: 'domestic-runtime';
  environment: string;
  status: 'active' | 'paused';
  edge: {
    bind: string;
    port: number;
    publicBaseUrl: string;
  };
  upstreams: {
    internalBaseUrl: string;
    internalApi: string;
    internalH2i: string;
  };
  dns: {
    bind: string;
    port: number;
  };
  env: Record<string, string>;
  warnings: string[];
  fingerprints: {
    configDigest: string;
  };
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export type RuntimeFeaturePolicyScopeKind = 'global' | 'site' | 'profile';
export type RuntimeFeaturePolicyMode = 'disabled' | 'plan-only' | 'readonly-execute' | 'remote-execute';

export type AwxProviderStatus = 'active' | 'paused';
export type AwxProviderKind = SiteSlotKind | 'all';

export interface AwxProviderConfigInput {
  providerId?: string | null;
  name?: string | null;
  status?: AwxProviderStatus | string | null;
  baseUrl?: string | null;
  organization?: string | null;
  project?: string | null;
  inventoryPrefix?: string | null;
  credentialPrefix?: string | null;
  jobTemplatePrefix?: string | null;
  defaultKind?: AwxProviderKind | string | null;
  verifyTls?: boolean | null;
  requestTimeoutSeconds?: number | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface AwxProviderConfig {
  providerId: string;
  name: string;
  environment: string;
  status: AwxProviderStatus;
  baseUrl: string | null;
  organization: string;
  project: string;
  inventoryPrefix: string;
  credentialPrefix: string;
  jobTemplatePrefix: string;
  defaultKind: AwxProviderKind;
  verifyTls: boolean;
  requestTimeoutSeconds: number;
  source: 'config-center';
  warnings: string[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface AwxProviderCheckInput {
  kind?: SiteSlotKind | string | null;
  token?: string | null;
  requestTimeoutSeconds?: number | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface AwxProviderCheckEndpoint {
  name: string;
  method: 'GET';
  path: string;
  status: 'passed' | 'blocked' | 'failed';
  httpStatus: number | null;
  durationMs: number;
  count: number | null;
  matchedNames: string[];
  message: string;
}

export interface AwxProviderCheckResult {
  providerId: string;
  checkedAt: string;
  mode: 'awx-api-readonly';
  status: 'passed' | 'blocked' | 'failed';
  baseUrl: string | null;
  organization: string;
  project: string;
  inventory: string;
  jobTemplate: string;
  targetKind: SiteSlotKind;
  endpoints: AwxProviderCheckEndpoint[];
  failures: string[];
  warnings: string[];
  nextActions: string[];
}

export interface AwxProviderSyncPlanInput {
  kind?: SiteSlotKind | string | null;
  siteId?: string | null;
  host?: string | null;
  sshUser?: string | null;
  sshPort?: number | null;
  sshProfileId?: string | null;
  planId?: string | null;
  jobId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  requestId?: string | null;
}

export interface AwxProviderSyncPlanObject {
  objectType: 'organization' | 'project' | 'inventory' | 'host' | 'credential' | 'job-template';
  name: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PATCH';
  required: boolean;
  status: 'planned' | 'blocked';
  fields: Record<string, unknown>;
  notes: string[];
}

export interface AwxProviderSyncPlan {
  syncPlanId: string;
  generatedAt: string;
  mode: 'awx-object-sync-plan';
  status: 'ready' | 'blocked';
  execution: 'not-started';
  boundary: 'awx-object-sync-plan-only';
  providerId: string | null;
  baseUrl: string | null;
  organization: string;
  project: string;
  targetKind: SiteSlotKind;
  siteId: string | null;
  host: string | null;
  sshUser: string | null;
  sshPort: number | null;
  sshProfileId: string | null;
  inventory: string;
  inventoryHost: string | null;
  credential: string;
  jobTemplate: string;
  requiredPlaybook: string;
  objects: AwxProviderSyncPlanObject[];
  extraVarsContract: string[];
  blockedReasons: string[];
  warnings: string[];
  nextActions: string[];
}

export interface RuntimeFeaturePolicyInput {
  featureKey?: string | null;
  scopeKind?: RuntimeFeaturePolicyScopeKind | string | null;
  scopeId?: string | null;
  enabled?: boolean | null;
  mode?: RuntimeFeaturePolicyMode | string | null;
  expiresAt?: string | null;
  requiresApproval?: boolean | null;
  reason?: string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface RuntimeFeaturePolicy {
  policyId: string;
  featureKey: string;
  environment: string;
  scopeKind: RuntimeFeaturePolicyScopeKind;
  scopeId: string | null;
  enabled: boolean;
  mode: RuntimeFeaturePolicyMode;
  expiresAt: string | null;
  requiresApproval: boolean;
  reason: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ConfigPolicySnapshot {
  snapshotId: string;
  environment: string;
  siteId: string;
  version: number;
  productId: string;
  appId: string;
  channel: string;
  installId: string | null;
  deviceId: string | null;
  anonymousPrincipalId: string | null;
  userId: string | null;
  principal: PlatformPrincipal;
  issuedAt: string;
  expiresAt: string;
  source: {
    configCenter: 'v1-shadow';
    requestId: string | null;
  };
  rollout: {
    segmentId: string;
    percentage: number;
    reasons: string[];
  };
  policies: {
    app: AppCenterApp | null;
    permissionPolicy: {
      appId: string;
      declaredScopes: string[];
      appAccess: AppCenterAccessDecision | null;
      defaultDecision: 'public-app' | 'allowed-by-app-policy' | 'requires-appcenter-grant' | 'denied-by-app-policy';
    };
    launcherNetwork: LauncherNetworkSnapshot;
    dns: {
      policy: DnsPolicy;
      reverseProxyRoutes: DnsReverseProxyRoute[];
    };
    sdkGateway: SdkGatewayManifest;
    release: {
      launcher: ReleasePolicyDecision;
      app: ReleasePolicyDecision;
    };
    observability: {
      level: string;
      sinks: ObservabilitySink[];
    };
  };
  signatures: {
    algorithm: 'sha256-dev-digest';
    digest: string;
    issuer: string;
  };
}

export interface AuditEventInput {
  eventType?: string;
  actorKind?: string;
  userId?: string | null;
  anonymousPrincipalId?: string | null;
  installId?: string | null;
  deviceId?: string | null;
  productId?: string | null;
  siteId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  overlayIp?: string | null;
  configSnapshotId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditEvent extends Required<Omit<AuditEventInput, 'metadata'>> {
  eventId: string;
  environment: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface LogEntryInput {
  level?: string;
  message?: string;
  service?: string;
  productId?: string;
  siteId?: string;
  requestId?: string;
  traceId?: string;
  installId?: string;
  deviceId?: string;
  userId?: string;
  anonymousPrincipalId?: string;
  metadata?: Record<string, unknown>;
}

export interface ReleaseTask {
  taskId: string;
  productId: string;
  installId: string;
  kind:
    | 'config-refresh'
    | 'artifact-update'
    | 'npm-package-update'
    | 'asar-update'
    | 'installer-update'
    | 'feature-flag-update'
    | 'service-repair'
    | 'runner-job';
  state: 'pending' | 'leased' | 'completed' | 'failed';
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface ReleaseReportInput {
  taskId?: string;
  installId?: string;
  status?: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export type UpdatePolicyKind =
  | 'platform-critical'
  | 'platform-ui'
  | 'app-managed'
  | 'mandatory-app'
  | 'config-snapshot'
  | 'feature-flag'
  | 'renderer-ui'
  | 'launcher-npm'
  | 'launcher-asar'
  | 'app-asar'
  | 'appcenter-app'
  | 'mx-h2i-installer'
  | 'native-helper';

export type ReleaseArtifactKind =
  | 'config-snapshot'
  | 'feature-flag'
  | 'renderer-ui'
  | 'launcher-npm'
  | 'launcher-asar'
  | 'app-asar'
  | 'appcenter-app'
  | 'mx-h2i-installer'
  | 'native-helper';

export type ReleaseActivationMode =
  | 'hot-auto'
  | 'hot-manual'
  | 'restart-auto'
  | 'restart-manual'
  | 'installer-manual';

export type ReleaseRolloutStrategy =
  | 'all'
  | 'canary'
  | 'gray'
  | 'manual-ring'
  | 'feature-flag';

export interface ReleaseArtifactRef {
  artifactId: string;
  kind: ReleaseArtifactKind;
  componentId: string;
  version: string;
  source: 'internal-postgres' | 'npm-sync' | 'ci-artifact' | 'manual-upload' | 'config-center';
  url: string | null;
  digest: string | null;
  signature: string | null;
  sizeBytes: number | null;
  platform: string | null;
  activation: ReleaseActivationMode;
  autoApply: boolean;
  restartRequired: boolean;
  requiredAppRestart: boolean;
  notes: string[];
}

export interface ReleaseRolloutPolicy {
  strategy: ReleaseRolloutStrategy;
  percentage: number;
  segmentId: string;
  rings: string[];
  featureKeys: string[];
  channels: string[];
  audience: {
    installIds: string[];
    userIds: string[];
    siteIds: string[];
  };
  allowAutoPromote: boolean;
  canaryMetricGate: string;
}

export interface ReleaseActivationPolicy {
  checkSource: 'internal-postgres';
  hotUpdateAuto: boolean;
  hotUpdateToast: boolean;
  majorUpdateRequiresInstaller: boolean;
  restartAfterApply: boolean;
  manualConfirmRequired: boolean;
  connectionSafeMode: boolean;
}

export type AppCenterAccessDefaultDecision = 'public' | 'authenticated' | 'private';

export interface AppCenterAccessPolicy {
  defaultDecision: AppCenterAccessDefaultDecision;
  allowAdmin: boolean;
  allowRoles: string[];
  allowUserIds: string[];
  allowOrgIds: string[];
  allowRegisteredByAppIds: string[];
  allowHomeAppIds: string[];
  requirePermissionGrant: boolean;
}

export interface AppCenterAccessContextInput {
  userId?: string | null;
  sourceAppId?: string | null;
  includeHidden?: boolean | null;
  includeDisabled?: boolean | null;
  requestId?: string | null;
}

export interface AppCenterAccessDecision {
  appId: string;
  allowed: boolean;
  visible: boolean;
  reason: string;
  matched: string[];
  missing: string[];
  principal: PlatformPrincipal | null;
  policy: AppCenterAccessPolicy;
}

export interface AppCenterAccessInput extends AppCenterAccessContextInput {
  appId: string;
}

export interface AppCenterApp {
  appId: string;
  displayName: string;
  fullName?: string | null;
  builtin: boolean;
  systemOwned?: boolean;
  packageName?: string | null;
  version: string;
  category: string;
  description: string;
  launcherMode?: LauncherProductMode;
  standaloneChannelProductId?: string | null;
  productNetworkId?: string | null;
  enabled?: boolean;
  channels: string[];
  permissions: string[];
  requiredCapabilities: string[];
  runtimeContractVersion?: string | null;
  manifest: AppCenterAppManifest | null;
  accessPolicy: AppCenterAccessPolicy;
  updatePolicy: UpdatePolicyKind;
  entrypoints: Record<string, string>;
  protocol: {
    appCenter: string;
    launcher: string;
  };
}

export interface AppCenterAppManifest {
  appId: string;
  productId: string;
  displayName?: string;
  description?: string;
  packageName?: string;
  category?: string;
  launcherMode: LauncherProductMode;
  sdkVersion?: string;
  appVersion?: string;
  sdkAbiVersion?: string;
  protocolVersion?: string;
  runtimeContractVersion?: string;
  requiredCapabilities: string[];
  network?: {
    scope?: LauncherNetworkScope;
    serviceVip?: string | null;
  };
  standalone?: {
    ownsNetwork: true;
    brokerEnabled: boolean;
  };
  embed?: {
    standaloneChannelProductId: string;
    launchWithoutBroker: 'blocked' | 'prompt-open-standalone';
  };
}

export interface AppCenterAppInput {
  appId?: string | null;
  displayName?: string | null;
  fullName?: string | null;
  builtin?: boolean | null;
  systemOwned?: boolean | null;
  packageName?: string | null;
  version?: string | null;
  category?: string | null;
  description?: string | null;
  launcherMode?: LauncherProductMode | string | null;
  standaloneChannelProductId?: string | null;
  productNetworkId?: string | null;
  enabled?: boolean | null;
  channels?: string[] | string | null;
  permissions?: string[] | string | null;
  requiredCapabilities?: string[] | string | null;
  runtimeContractVersion?: string | null;
  manifest?: Record<string, unknown> | AppCenterAppManifest | null;
  accessPolicy?: Partial<AppCenterAccessPolicy> | null;
  updatePolicy?: UpdatePolicyKind | string | null;
  entrypoints?: Record<string, string> | null;
  protocol?: {
    appCenter?: string | null;
    launcher?: string | null;
  } | null;
  requestedBy?: string | null;
}

export type AppCenterInstallationStatus =
  | 'available'
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'enabled'
  | 'ready'
  | 'running'
  | 'error'
  | 'disabled';

export interface AppCenterInstallation {
  installationId: string;
  appId: string;
  installId: string | null;
  deviceId: string | null;
  userId: string | null;
  sourceAppId: string | null;
  packageName: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  status: AppCenterInstallationStatus;
  runtimeState: string | null;
  installSource: string | null;
  installPath: string | null;
  manifest: AppCenterAppManifest | Record<string, unknown> | null;
  manifestDigest: string | null;
  installedAt: string | null;
  lastSeenAt: string;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AppCenterInstallationQuery extends AppCenterAccessContextInput {
  appId?: string | null;
  installId?: string | null;
  deviceId?: string | null;
  packageName?: string | null;
}

export interface AppCenterInstallationInput {
  appId: string;
  installId?: string | null;
  deviceId?: string | null;
  userId?: string | null;
  sourceAppId?: string | null;
  packageName?: string | null;
  installedVersion?: string | null;
  latestVersion?: string | null;
  status?: AppCenterInstallationStatus | string | null;
  runtimeState?: string | null;
  installSource?: string | null;
  installPath?: string | null;
  manifest?: Record<string, unknown> | AppCenterAppManifest | null;
  manifestDigest?: string | null;
  installedAt?: string | null;
  lastSeenAt?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  requestedBy?: string | null;
}

export interface AppOnboardingTemplate {
  templateId: string;
  label: string;
  detail: string;
  launcherMode?: LauncherProductMode;
  category?: string;
  appId?: string;
  displayName?: string;
  description?: string;
  dnsRouteEnabled: boolean;
}

export interface AppOnboardingDefaultsInput {
  templateId?: string | null;
  appId?: string | null;
  displayName?: string | null;
  category?: string | null;
  description?: string | null;
  packageName?: string | null;
  launcherMode?: LauncherProductMode | string | null;
  standaloneChannelProductId?: string | null;
  dnsHost?: string | null;
  targetUrl?: string | null;
  manifest?: Record<string, unknown> | AppCenterAppManifest | null;
  requestedBy?: string | null;
}

export interface AppOnboardingDefaults {
  template: AppOnboardingTemplate;
  app: AppCenterAppInput & {
    appId: string;
    displayName: string;
    category: string;
    description: string;
    packageName: string | null;
    launcherMode: LauncherProductMode;
    standaloneChannelProductId: string;
    productNetworkId: string;
    channels: string[];
    permissions: string[];
    requiredCapabilities: string[];
    runtimeContractVersion?: string | null;
    manifest: AppCenterAppManifest | null;
    updatePolicy: UpdatePolicyKind;
    enabled: boolean;
  };
  productNetwork: LauncherProductNetworkInput & {
    productId: string;
    displayName: string;
    mode: LauncherProductMode;
    standaloneChannelProductId: string;
    productIndex: number;
  };
  dnsRoute: DnsReverseProxyRouteInput & {
    routeId: string;
    host: string;
    dnsTarget: string;
    targetUrl: string;
    enabled: boolean;
    tlsMode: DnsReverseProxyRoute['tlsMode'];
    authRequired: boolean;
  };
  operatorSteps: Array<{
    stepId: string;
    label: string;
    detail: string;
    writesTo: string;
  }>;
}

export interface PermissionRequestInput {
  appId: string;
  scopes: string[];
  requestedBy: string;
  installId?: string | null;
  userId?: string | null;
  sourceAppId?: string | null;
  requestId?: string;
}

export interface PermissionGrant {
  grantId: string;
  appId: string;
  scopes: string[];
  allowedScopes: string[];
  deniedScopes: string[];
  decision: 'granted' | 'partial' | 'denied';
  requestedBy: string;
  installId: string | null;
  userId: string | null;
  sourceAppId: string | null;
  accessAllowed: boolean;
  accessReason: string;
  createdAt: string;
}

export interface LauncherNetworkSnapshotInput {
  installId?: string;
  deviceId?: string;
  siteId?: string | null;
  userId?: string | null;
  publicKey?: string | null;
  appId?: string;
  launcherMode?: LauncherProductMode | null;
  requestId?: string;
}

export type LauncherProductMode = 'standalone' | 'embed';
export type LauncherIdentityKind = 'user' | 'anonymous';
export type LauncherProductUpdatePolicy = 'launcher-managed' | 'app-managed' | 'host-managed';
export type LauncherNetworkScope = 'owner' | 'broker-session';

export interface LauncherProductNetworkInput {
  productId?: string | null;
  displayName?: string | null;
  mode?: LauncherProductMode | string | null;
  networkScope?: LauncherNetworkScope | string | null;
  standaloneChannelProductId?: string | null;
  productIndex?: number | null;
  internalControlIp?: string | null;
  domesticGatewayIp?: string | null;
  dnsServer?: string | null;
  serviceVip?: string | null;
  userCidr?: string | null;
  anonymousCidr?: string | null;
  userLeaseStart?: string | null;
  userLeaseEnd?: string | null;
  anonymousLeaseStart?: string | null;
  anonymousLeaseEnd?: string | null;
  defaultDomesticSiteId?: string | null;
  defaultOverseaSiteId?: string | null;
  updatePolicy?: LauncherProductUpdatePolicy | string | null;
  rateLimitProfile?: string | null;
  dnsPolicyId?: string | null;
  licensePolicyId?: string | null;
  enabled?: boolean | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface LauncherProductNetwork {
  productId: string;
  displayName: string;
  mode: LauncherProductMode;
  networkScope: LauncherNetworkScope;
  standaloneChannelProductId: string;
  productIndex: number;
  fabricCidr: '10.88.0.0/16';
  internalControlIp: string;
  domesticGatewayIp: string;
  dnsServer: string;
  serviceVip: string;
  userCidr: string;
  anonymousCidr: string;
  userLeaseStart: string;
  userLeaseEnd: string;
  anonymousLeaseStart: string;
  anonymousLeaseEnd: string;
  defaultDomesticSiteId: string;
  defaultOverseaSiteId: string;
  updatePolicy: LauncherProductUpdatePolicy;
  rateLimitProfile: string;
  dnsPolicyId: string;
  licensePolicyId: string;
  enabled: boolean;
  notes: string[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface LauncherNetworkLeaseInput {
  appId?: string | null;
  productId?: string | null;
  mode?: LauncherProductMode | string | null;
  identityKind?: LauncherIdentityKind | string | null;
  installId?: string | null;
  deviceId?: string | null;
  siteId?: string | null;
  userId?: string | null;
  publicKey?: string | null;
  deviceLabel?: string | null;
  platform?: string | null;
  requestedBy?: string | null;
  requestId?: string | null;
  sdkTestMode?: boolean | string | null;
}

export interface LauncherNetworkLeaseReleaseInput {
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface LauncherNetworkLease {
  leaseId: string;
  leaseKey: string;
  environment: string;
  productId: string;
  launcherMode: LauncherProductMode;
  identityKind: LauncherIdentityKind;
  sequence: number;
  installId: string;
  deviceId: string;
  siteId: string;
  userId: string | null;
  cidr: string;
  leaseIp: string;
  serviceVip: string;
  internalControlIp: string;
  domesticGatewayIp: string;
  domesticSiteId: string;
  overseaSiteId: string;
  publicKey: string | null;
  deviceLabel: string | null;
  platform: string | null;
  status: 'active' | 'released';
  expiresAt: string;
  releasedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface LauncherNetworkSnapshot {
  snapshotId: string;
  environment: string;
  appId: string;
  installId: string;
  deviceId: string;
  userId: string | null;
  mode: 'guest' | 'user';
  overlayPolicy: {
    productId: string;
    launcherMode: LauncherProductMode;
    identityKind: LauncherIdentityKind;
    cidr: string;
    leaseIp: string;
    relayMode: 'h2i';
  };
  topology: LauncherNetworkTopology;
  capabilities: {
    wireGuard: boolean;
    splitDns: boolean;
    pac: boolean;
    tun: boolean;
    systemProxy: boolean;
  };
  dns: {
    authority: 'internal-coredns';
    matchDomains: string[];
    fallback: 'system';
  };
  pac: {
    priority: string[];
  };
  signatures: {
    algorithm: string;
    digest: string;
    issuer: string;
  };
  issuedAt: string;
}

export interface LauncherNetworkTopology {
  model: 'internal-authority-domestic-relay-oversea-access-v1';
  product: {
    productId: string;
    displayName: string;
    mode: LauncherProductMode;
    serviceVip: string;
    internalControlIp: string;
    domesticGatewayIp: string;
    dnsServer: string;
    userCidr: string;
    anonymousCidr: string;
    updatePolicy: LauncherProductUpdatePolicy;
    rateLimitProfile: string;
    dnsPolicyId: string;
    licensePolicyId: string;
  };
  bootstrap: {
    order: Array<
      | 'deploy-oversea-access-if-domestic-needs-egress'
      | 'deploy-domestic-public-relay-foundation'
      | 'internal-joins-domestic-relay-as-service-peer'
      | 'home-enrolls-through-domestic-public-facade'
      | 'promote-home-to-domestic-wg-relay-primary'
    >;
    hdiWithoutRelay: 'bootstrap-proxy-only';
    steadyStateAccess: 'domestic-wg-relay-primary';
  };
  authority: {
    users: 'internal-user-center';
    config: 'internal-config-center';
    mihomo: 'internal-mihomo';
    dns: 'internal-coredns';
    release: 'internal-release-center';
  };
  homePath: {
    bootstrap: 'home-to-domestic-public-enroll-proxy';
    afterEnroll: 'home-to-domestic-wg-relay-to-internal';
    subscriptionFetch: 'home-through-domestic-h2i-to-internal-mihomo';
    overseaTraffic: 'home-direct-to-oversea-hysteria2';
  };
  homeLease: {
    mode: 'guest' | 'user';
    ip: string;
    cidr: string;
  };
  domestic: {
    siteId: string;
    role: 'relay-proxy-cache-forwarder';
    publicIpRequired: true;
    publicServices: Array<'api-facade' | 'wg-relay' | 'h2i-proxy' | 'snapshot-cache' | 'observability-forwarder'>;
    gatewayIp: string;
    overlayCidrs: string[];
    configSource: 'internal-signed-snapshot';
    storesAuthority: false;
    requiredFor: Array<'enroll-proxy' | 'wg-relay' | 'h2i-proxy' | 'internal-dns' | 'snapshot-cache'>;
  };
  internal: {
    siteId: string;
    publicIngress: false;
    baseUrl: string;
    enrollUrl: string;
    configSnapshotUrl: string;
    mihomoSubscriptionBaseUrl: string;
    requiresEnrollLease: true;
    relayPeer: {
      required: true;
      fixedIp: string;
      initiatedBy: 'internal-outbound-to-domestic-public-wg';
      purpose: string;
    };
  };
  oversea: {
    siteId: string;
    role: 'hysteria2-access-site';
    subscriptionAuthority: 'internal-mihomo';
    trafficPath: 'direct-after-subscription';
    healthEvidenceOutlet: {
      baseUrl: string;
      healthPath: '/healthz';
      evidencePath: '/clients.csv';
      authority: 'internal-config-center';
      purpose: 'health-and-evidence';
    };
  };
  subscriptions: {
    mihomo: {
      authority: 'internal-config-center';
      siteId: string;
      baseUrl: string;
      fetchPath: string;
      reachableVia: Array<'domestic-wg-relay' | 'h2i-proxy' | 'internal-dns'>;
      fallback: 'domestic-snapshot-cache';
    };
  };
  relayPlan: {
    authority: 'internal-config-center';
    domesticRelay: {
      siteId: string;
      interfaceName: 'mx-domestic';
      listenPort: 51280;
      gatewayIp: string;
      publicEndpoint: string | null;
      publicKey: string | null;
      configArtifact: 'mx-domestic-wg-relay.conf';
      envArtifact: 'mx-domestic-relay.env';
    };
    refreshHint: {
      source: 'internal-domestic-wg-secret';
      mode: 'snapshot-digest';
      publicEndpoint: string | null;
      domesticRelayPublicKeyFingerprint: string | null;
      internalServicePublicKeyFingerprint: string | null;
      materialDigest: string | null;
      secretUpdatedAt: string | null;
    };
    internalServicePeer: {
      role: 'internal-service';
      fixedIp: string;
      allowedIps: string[];
      configArtifact: 'mx-internal-service-peer.conf';
      privateKeyPlacement: 'internal-only';
      direction: 'internal-outbound-to-domestic-public-wg';
    };
    internalDirectPeer: {
      role: 'internal-direct-service';
      enabled: boolean;
      fixedIp: string;
      endpoint: string | null;
      listenPort: number;
      publicKey: string | null;
      allowedIps: string[];
      configArtifact: 'mx-internal-service-peer.conf';
      peerMutation: 'append-home-peer-after-enroll';
      fallback: 'domestic-wg-relay';
    };
    homePeer: {
      role: 'guest' | 'user';
      leaseIp: string;
      cidr: string;
      allowedIps: string[];
      publicKey: string | null;
      publicKeyStatus: 'ready-to-append' | 'pending-public-key';
      provisionedBy: 'internal-signed-relay-lease';
      domesticMutation: 'append-peer-after-enroll';
    };
    routes: {
      internalCidrs: string[];
      dnsServer: string;
      subscriptionReachability: 'domestic-wg-relay+h2i-proxy';
      externalTraffic: 'direct-to-oversea-hysteria2-after-subscription';
    };
    gates: {
      domesticConfigMustNotContainInternalPrivateKey: true;
      homePublicKeyRequiredForRealPeer: true;
      bootstrapFacadeOnlyBeforeLease: true;
      steadyStateRequiresDomesticRelay: true;
    };
  };
  gates: {
    anonymousEnrollBeforeInternalReachability: true;
    domesticPublicFacadeOnlyBootstrapsEnroll: true;
    fixedInternalIpAfterEnroll: true;
    internalPublicIpRequired: false;
    internalMustJoinDomesticRelayBeforeHomeCanReachInternal: true;
    wgRelayBecomesPrimaryAfterEnroll: true;
    domesticMustNotOwnUsersOrSubscriptions: true;
    overseaMustNotOwnSubscriptionStore: true;
  };
}

export type SiteSlotAccessAccountRole = 'internal' | 'domestic' | 'internal-reserved' | 'h-endpoint' | 'operator';

export interface SiteSlotAccessAccountIssueInput {
  siteId?: string | null;
  service?: 'hysteria2' | string | null;
  accountNames?: string[] | string | null;
  issueDefaults?: boolean | null;
  publicHost?: string | null;
  serverPorts?: string | null;
  tlsFingerprint?: string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface SiteSlotAccessAccount {
  accountId: string;
  siteId: string;
  environment: string;
  service: 'hysteria2';
  username: string;
  role: SiteSlotAccessAccountRole;
  authToken: string;
  status: 'active' | 'paused';
  routingPolicy: 'cn-direct';
  subscriptionPath: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface LauncherNetworkMihomoSiteInput {
  siteId?: string | null;
  publicHost?: string | null;
  serverPorts?: string | null;
  tlsFingerprint?: string | null;
  subscriptionBaseUrl?: string | null;
  routingPolicy?: 'cn-direct' | string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface LauncherNetworkMihomoSite {
  siteId: string;
  environment: string;
  mode: 'internal-managed';
  source: 'site-slot-access-accounts';
  service: 'hysteria2';
  publicHost: string | null;
  serverPorts: string;
  tlsFingerprint: string | null;
  subscriptionBaseUrl: string;
  routingPolicy: 'cn-direct';
  reservedInternalCidrs: string[];
  domesticGatewayIp: '10.88.0.1';
  dnsPath: 'wg-relay-internal-dns';
  reachability: {
    internalUrlOnly: true;
    domesticWgRelayRequired: true;
    h2iRequired: true;
    notes: string[];
  };
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export type LauncherNetworkReachabilityStageStatus = 'ready' | 'pending-evidence' | 'blocked';
export type LauncherNetworkReachabilityOwner = 'internal' | 'oversea' | 'domestic' | 'h-endpoint';

export interface LauncherNetworkReachabilityStage {
  stageId: string;
  order: number;
  owner: LauncherNetworkReachabilityOwner;
  title: string;
  status: LauncherNetworkReachabilityStageStatus;
  dependsOn: string[];
  requiredEvidence: string[];
  notes: string[];
}

export interface LauncherNetworkReachabilityPlan {
  siteId: string;
  environment: string;
  verdict: 'blocked' | 'internal-output-ready' | 'h-endpoint-blocked' | 'h-endpoint-ready';
  currentBoundary: 'internal-only' | 'domestic-relay' | 'h-endpoint';
  subscriptionBaseUrl: string;
  accountSummary: {
    total: number;
    internal: number;
    domestic: number;
    internalReserved: number;
    hEndpoint: number;
  };
  executionOrder: string[];
  gates: {
    domesticWgRelayRequired: true;
    h2iRequired: true;
    internalDnsRequired: true;
    mihomoAuthority: 'internal-config-center';
    overseaRuntime: 'hysteria2-only';
    domesticGatewayIp: '10.88.0.1';
    reservedInternalCidrs: string[];
  };
  stages: LauncherNetworkReachabilityStage[];
  nextActions: string[];
  generatedAt: string;
}

export interface SiteSlotAccessAccountIssueResult {
  site: LauncherNetworkMihomoSite;
  accounts: SiteSlotAccessAccount[];
}

export interface MihomoSubscriptionRender {
  siteId: string;
  username: string;
  accountId: string;
  contentType: 'text/yaml';
  yaml: string;
  reachability: LauncherNetworkMihomoSite['reachability'];
  generatedAt: string;
}

export interface UserOverseaEntitlementInput {
  userId?: string | null;
  siteIds?: string[] | string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface UserOverseaEntitlementAccount {
  siteId: string;
  username: string;
  accountId: string;
  status: SiteSlotAccessAccount['status'];
  subscriptionPath: string;
  siteSubscriptionUrl: string;
  runtimeSync: {
    status: 'synced' | 'pending-sync' | 'no-runtime-evidence' | 'disabled';
    checkedAt: string;
    accountUpdatedAt: string;
    lastSyncedAt: string | null;
    requiredAction: 'none' | 'run-user-oversea-remote-sync' | 'run-oversea-install-sync';
    reason: string;
  };
}

export interface UserOverseaEntitlement {
  entitlementId: string;
  userId: string;
  environment: string;
  service: 'hysteria2';
  siteIds: string[];
  accounts: UserOverseaEntitlementAccount[];
  status: 'active' | 'disabled';
  subscriptionPath: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface UserOverseaSubscriptionRender {
  userId: string;
  entitlementId: string;
  contentType: 'text/yaml';
  yaml: string;
  accounts: UserOverseaEntitlementAccount[];
  generatedAt: string;
}

export interface UserH2oSubscriptionAuth {
  type: 'none' | 'basic' | string;
  username?: string | null;
  password?: string | null;
}

export interface UserH2oSubscription {
  id: string;
  name: string;
  url: string;
  nodes: number;
  latencyMs: number;
  status: string;
  source: string;
  requiresUser: boolean;
  assignable: boolean;
  entitlementId: string | null;
  siteIds: string[];
  syncStatus: string | null;
  errorMessage: string | null;
  yamlBytes: number;
  auth: UserH2oSubscriptionAuth;
  headers: Record<string, string>;
  pinnedAt: string | null;
  lastUpdatedAt: string;
}

export interface UserH2oRuntimeProfileInput {
  userId?: string | null;
  appId?: string | null;
  mode?: string | null;
  activeSubscriptionId?: string | null;
  activeSubscription?: Partial<UserH2oSubscription> | null;
  subscriptions?: Array<Partial<UserH2oSubscription>> | null;
  ports?: Record<string, number> | null;
  rules?: Array<Record<string, unknown>> | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface UserH2oRuntimeProfile {
  profileId: string;
  userId: string;
  appId: string;
  mode: string;
  activeSubscriptionId: string | null;
  activeSubscription: UserH2oSubscription | null;
  subscriptions: UserH2oSubscription[];
  ports: Record<string, number>;
  rules: Array<Record<string, unknown>>;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  requestId: string | null;
}

export interface UserOverseaAccountSyncReportInput {
  userId?: string | null;
  siteId?: string | null;
  accountId?: string | null;
  username?: string | null;
  status?: 'passed' | 'failed' | 'blocked' | null;
  exitCode?: number | null;
  command?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  diagnosis?: Record<string, unknown> | null;
  requestedBy?: string | null;
  requestId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface UserOverseaAccountSyncReport {
  reportId: string;
  userId: string;
  siteId: string;
  accountId: string;
  username: string;
  status: 'passed' | 'failed' | 'blocked';
  exitCode: number | null;
  command: string | null;
  stdout: string;
  stderr: string;
  diagnosis: Record<string, unknown> | null;
  requestedBy: string;
  requestId: string | null;
  startedAt: string | null;
  finishedAt: string;
  createdAt: string;
}

export type DnsFallbackTarget = 'system-dns' | 'system-proxy' | 'h2o-proxy' | 'direct';

export interface DnsPolicy {
  policyId: string;
  environment: string;
  siteId: string;
  name: string;
  version: number;
  enabled: boolean;
  priority: number;
  owners: string[];
  whitelist: {
    exactDomains: string[];
    suffixes: string[];
  };
  internal: {
    authority: 'internal-coredns';
    serviceDns: string;
    h2iRequired: boolean;
  };
  fallbackOrder: DnsFallbackTarget[];
  proxyHints: {
    pacPriority: string[];
    allowSystemProxyFallback: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface DnsQueryInput {
  domain: string;
  appId?: string | null;
  installId?: string | null;
  userId?: string | null;
  requestId?: string | null;
}

export interface DnsResolutionDecision {
  domain: string;
  normalizedDomain: string;
  matched: boolean;
  policyId: string;
  route: 'internal-dns' | 'fallback';
  resolver: 'internal-coredns' | DnsFallbackTarget;
  fallbackOrder: DnsFallbackTarget[];
  reverseProxyRoute: DnsReverseProxyRoute | null;
  reason: string;
}

export interface DnsReverseProxyRoute {
  routeId: string;
  environment: string;
  host: string;
  dnsTarget: string;
  targetUrl: string | null;
  enabled: boolean;
  tlsMode: 'internal' | 'passthrough' | 'edge-terminated';
  authRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DnsReverseProxyRouteInput {
  routeId?: string | null;
  host?: string | null;
  dnsTarget?: string | null;
  targetUrl?: string | null;
  enabled?: boolean | null;
  tlsMode?: DnsReverseProxyRoute['tlsMode'] | null;
  authRequired?: boolean | null;
  requestedBy?: string | null;
}

export interface DnsZoneSnapshotInput {
  policyId?: string | null;
  appId?: string | null;
  requestId?: string | null;
}

export interface DnsZoneRecord {
  name: string;
  type: 'A' | 'CNAME';
  value: string;
  ttlSeconds: number;
  source: 'dns-policy' | 'reverse-proxy-route' | 'internal-service';
}

export interface DnsZoneSnapshot {
  snapshotId: string;
  environment: string;
  siteId: string;
  policyId: string;
  version: number;
  authority: 'internal-coredns';
  zoneNames: string[];
  serviceDns: string;
  records: DnsZoneRecord[];
  reverseProxyRoutes: DnsReverseProxyRoute[];
  fallbackOrder: DnsFallbackTarget[];
  corefile: {
    targetServiceDns: string;
    serverBlocks: Array<{
      zone: string;
      text: string;
    }>;
    combined: string;
  };
  issuedAt: string;
  expiresAt: string;
  signatures: {
    algorithm: 'sha256-dev-digest';
    digest: string;
    issuer: string;
  };
}

export interface CoreDnsConfigMapSyncInput extends DnsZoneSnapshotInput {
  snapshotId?: string | null;
  namespace?: string | null;
  configMapName?: string | null;
  mode?: 'dry-run' | 'shadow-apply' | null;
  requestId?: string | null;
}

export interface CoreDnsConfigMapManifest {
  apiVersion: 'v1';
  kind: 'ConfigMap';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  data: {
    Corefile: string;
    'mx-zone-snapshot.json': string;
  };
  yaml: string;
}

export interface CoreDnsConfigMapSyncResult {
  syncId: string;
  mode: 'dry-run' | 'shadow-apply';
  status: 'rendered' | 'recorded';
  applied: boolean;
  snapshotId: string;
  namespace: string;
  configMapName: string;
  manifest: CoreDnsConfigMapManifest;
  issuedAt: string;
  message: string;
}

export interface CoreDnsConfigMapApplyInput extends CoreDnsConfigMapSyncInput {
  confirmApply?: boolean | null;
  serverDryRun?: boolean | null;
  actor?: string | null;
}

export interface CoreDnsConfigMapApplyResult {
  applyId: string;
  syncId: string;
  mode: 'k8s-server-dry-run' | 'k8s-apply';
  status: 'blocked' | 'server-dry-run' | 'applied' | 'failed';
  allowed: boolean;
  applied: boolean;
  serverDryRun: boolean;
  snapshotId: string;
  namespace: string;
  configMapName: string;
  manifest: CoreDnsConfigMapManifest;
  resourceVersion: string | null;
  blockedReason: string | null;
  message: string;
  issuedAt: string;
  completedAt: string;
}

export interface GatewayConfigMapSyncInput {
  appId?: string | null;
  namespace?: string | null;
  configMapName?: string | null;
  gatewayApplyBackend?: RuntimeConfig['gatewayApplyBackend'] | null;
  gatewayHostNginxConfigPath?: string | null;
  gatewayHostNginxInternalApiUpstream?: string | null;
  mode?: 'dry-run' | 'shadow-apply' | null;
  requestId?: string | null;
}

export interface GatewayRuntimeConfigInput {
  backend?: GatewayRuntimeBackend | string | null;
  hostNginxConfigPath?: string | null;
  hostNginxInternalApiUpstream?: string | null;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface GatewayRuntimeConfig {
  configId: string;
  environment: string;
  siteId: string;
  backend: GatewayRuntimeBackend;
  hostNginxApplyEnabled: boolean;
  hostNginxConfigPath: string;
  hostNginxInternalApiUpstream: string | null;
  gatewayAppPort: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  requestId: string | null;
}

export interface GatewayConfigMapManifest {
  apiVersion: 'v1';
  kind: 'ConfigMap';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  data: {
    Caddyfile: string;
    'nginx.conf': string;
    'mx-gateway-routes.json': string;
  };
  yaml: string;
}

export interface GatewayConfigMapSyncResult {
  syncId: string;
  mode: 'dry-run' | 'shadow-apply';
  status: 'rendered' | 'recorded';
  applied: boolean;
  namespace: string;
  configMapName: string;
  routeCount: number;
  manifest: GatewayConfigMapManifest;
  issuedAt: string;
  message: string;
}

export interface GatewayConfigMapApplyInput extends GatewayConfigMapSyncInput {
  confirmApply?: boolean | null;
  serverDryRun?: boolean | null;
  actor?: string | null;
}

export interface GatewayConfigMapApplyResult {
  applyId: string;
  syncId: string;
  mode: 'k8s-server-dry-run' | 'k8s-apply' | 'host-nginx-dry-run' | 'host-nginx-apply';
  status: 'blocked' | 'server-dry-run' | 'applied' | 'failed';
  allowed: boolean;
  applied: boolean;
  serverDryRun: boolean;
  namespace: string;
  configMapName: string;
  routeCount: number;
  manifest: GatewayConfigMapManifest;
  resourceVersion: string | null;
  blockedReason: string | null;
  message: string;
  issuedAt: string;
  completedAt: string;
}

export interface ReleasePolicyInput {
  componentKind: string;
  componentId: string;
  currentVersion: string;
  targetVersion: string;
  channel: string;
  installId?: string | null;
  userId?: string | null;
}

export interface ReleasePolicyDecision {
  componentKind: UpdatePolicyKind;
  componentId: string;
  currentVersion: string;
  targetVersion: string;
  updateAvailable: boolean;
  updateMode: 'none' | 'automatic' | 'manual' | 'mandatory';
  canSkip: boolean;
  canDefer: boolean;
  requiresGate: boolean;
  rollbackRequired: boolean;
  reason: string;
}

export type ReleaseManagementE2eResult = 'passed' | 'failed' | 'blocked' | 'running';

export interface ReleaseManagementPlanInput {
  releaseId?: string | null;
  channel?: string | null;
  installId?: string | null;
  userId?: string | null;
  productId?: string | null;
  appId?: string | null;
  launcherComponentId?: string | null;
  appComponentId?: string | null;
  launcherUpdatePolicy?: UpdatePolicyKind | string | null;
  appUpdatePolicy?: UpdatePolicyKind | string | null;
  launcherCurrentVersion?: string | null;
  launcherTargetVersion?: string | null;
  appCurrentVersion?: string | null;
  appTargetVersion?: string | null;
  artifactKind?: ReleaseArtifactKind | string | null;
  artifactVersion?: string | null;
  artifactUrl?: string | null;
  artifactDigest?: string | null;
  artifactSignature?: string | null;
  artifactSizeBytes?: number | null;
  artifactPlatform?: string | null;
  activationMode?: ReleaseActivationMode | string | null;
  rolloutStrategy?: ReleaseRolloutStrategy | string | null;
  rolloutPercentage?: number | null;
  rolloutSegment?: string | null;
  rolloutRings?: string[];
  featureKeys?: string[];
  /** Explicit per-user / per-install targeting; a one-user gray release is a single entry here. */
  targetUserIds?: string[];
  targetInstallIds?: string[];
  releaseNotes?: string | null;
  suiteId?: string | null;
  topology?: string | null;
  sites?: string[];
  e2eResult?: ReleaseManagementE2eResult | null;
  createdBy?: string | null;
  requestId?: string | null;
}

export interface ReleaseManagementGateInput {
  status: ReleaseManagementE2eResult;
  message?: string | null;
  evidence?: Record<string, unknown>;
  requestedBy?: string | null;
  requestId?: string | null;
}

export interface ReleaseManagementPlan {
  planId: string;
  releaseId: string;
  environment: string;
  channel: string;
  installId: string | null;
  userId: string | null;
  createdBy: string;
  components: {
    launcher: ReleasePolicyDecision;
    app: ReleasePolicyDecision;
  };
  artifacts: ReleaseArtifactRef[];
  rollout: ReleaseRolloutPolicy;
  activation: ReleaseActivationPolicy;
  releaseNotes: string | null;
  test: {
    suiteId: string;
    topology: string;
    sites: string[];
    run: TestRun;
    gate: TestGateVerdict;
  };
  decisions: {
    readyToPromote: boolean;
    requiresApproval: boolean;
    canaryAllowed: boolean;
    rollbackRequired: boolean;
    nextActions: string[];
  };
  createdAt: string;
}

export interface TestRunInput {
  suiteId: string;
  productId: string;
  topology: string;
  sites: string[];
  releaseId?: string | null;
  configSnapshotId?: string | null;
  installId?: string | null;
  deviceId?: string | null;
}

export interface TestStepInput {
  caseId: string;
  status: string;
  message?: string | null;
  evidence?: Record<string, unknown>;
}

export interface TestStep {
  stepId: string;
  caseId: string;
  status: 'passed' | 'failed' | 'blocked';
  message: string | null;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface TestRun {
  testRunId: string;
  suiteId: string;
  productId: string;
  environment: string;
  topology: string;
  sites: string[];
  releaseId: string | null;
  configSnapshotId: string | null;
  installId: string | null;
  deviceId: string | null;
  traceId: string;
  state: 'running' | 'passed' | 'failed' | 'blocked';
  steps: TestStep[];
  startedAt: string;
  finishedAt: string | null;
}

export interface TestGateInput {
  gateId: string;
  releaseId: string;
  runIds: string[];
}

export interface TestGateVerdict {
  gateId: string;
  releaseId: string;
  verdict: 'passed' | 'failed' | 'blocked';
  requiredRuns: string[];
  evaluatedAt: string;
  reason: string;
}

export interface PlatformKernelSmokeResult {
  ok: boolean;
  checks: string[];
  app: AppCenterApp;
  userCenter: UserCenterBootstrapResult;
  issuedServiceToken: UserCenterIssuedToken;
  sdkAccess: SdkGatewayAccessDecision;
  deniedSdkAccess: SdkGatewayAccessDecision;
  configPolicySnapshot: ConfigPolicySnapshot;
  enrollment: AnonymousEnrollment;
  principalContext: PrincipalContext;
  sdkIntrospection: TokenIntrospectionResult;
  sdkGateway: SdkGatewayManifest;
  domesticSlotPlan: SiteSlotPlan;
  overseaSlotPlan: SiteSlotPlan;
  domesticSlotPreflightExecution: SiteSlotExecutionRun;
  domesticSlotApplyExecution: SiteSlotExecutionRun;
  domesticSlotPreflightRunnerSession: SiteSlotRunnerSession;
  domesticSlotRemoteRunnerSession: SiteSlotRunnerSession;
  domesticSlotWorkerJob: SiteSlotWorkerJob;
  domesticSlotWorkerReport: SiteSlotWorkerReport;
  domesticSlotFailedWorkerJob: SiteSlotWorkerJob;
  domesticSlotFailedWorkerReport: SiteSlotWorkerReport;
  domesticSlotRollbackExecution: SiteSlotRollbackExecution;
  domesticSlotRollbackReport: SiteSlotRollbackReport;
  networkSnapshot: LauncherNetworkSnapshot;
  permissionGrant: PermissionGrant;
  testRun: TestRun;
  gate: TestGateVerdict;
  releaseManagementPlan: ReleaseManagementPlan;
  launcherUpdate: ReleasePolicyDecision;
  h2oUpdate: ReleasePolicyDecision;
  dnsPolicy: DnsPolicy;
  dnsDecision: DnsResolutionDecision;
  dnsZoneSnapshot: DnsZoneSnapshot;
  coreDnsSync: CoreDnsConfigMapSyncResult;
}
