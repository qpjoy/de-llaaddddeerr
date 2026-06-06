export type StoreDriver = 'memory' | 'postgres';
export type SiteRole = 'internal' | 'domestic' | 'oversea' | 'h-endpoint-dev';

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
  createdAt: string;
  userId: string | null;
}

export interface IdentityLinkRequest {
  installId: string;
  userId: string;
  requestId?: string;
  authProvider?: string;
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
  kind: 'config-refresh' | 'artifact-update' | 'service-repair' | 'runner-job';
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
  | 'config-snapshot';

export interface AppCenterApp {
  appId: string;
  displayName: string;
  builtin: boolean;
  version: string;
  category: string;
  description: string;
  channels: string[];
  permissions: string[];
  requiredCapabilities: string[];
  updatePolicy: UpdatePolicyKind;
  entrypoints: Record<string, string>;
  protocol: {
    appCenter: string;
    launcher: string;
  };
}

export interface PermissionRequestInput {
  appId: string;
  scopes: string[];
  requestedBy: string;
  installId?: string | null;
  userId?: string | null;
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
  createdAt: string;
}

export interface LauncherNetworkSnapshotInput {
  installId?: string;
  deviceId?: string;
  userId?: string | null;
  appId?: string;
  requestId?: string;
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
    cidr: '100.91.0.0/16' | '100.89.0.0/16';
    leaseIp: string;
    relayMode: 'h2i';
  };
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
  enrollment: AnonymousEnrollment;
  networkSnapshot: LauncherNetworkSnapshot;
  permissionGrant: PermissionGrant;
  testRun: TestRun;
  gate: TestGateVerdict;
  launcherUpdate: ReleasePolicyDecision;
  h2oUpdate: ReleasePolicyDecision;
}
