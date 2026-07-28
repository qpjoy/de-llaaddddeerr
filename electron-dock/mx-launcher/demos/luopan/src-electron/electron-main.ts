import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, session, shell, type Session } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  adoptPendingElectronLauncherPackages,
  allocateElectronLauncherLocalPort,
  loadElectronLauncherEnvFiles,
  parseElectronLauncherBootstrapUrls,
  resolveElectronLauncherBootstrap,
  type ElectronLauncherBootstrapResolution,
  applyElectronLauncherStandaloneDataPlane,
  buildElectronLauncherStandaloneOwnershipClaim,
  classifyElectronLauncherUpdateArtifact,
  createElectronLauncher,
  createElectronLauncherReleaseUpdateExecutor,
  createElectronLauncherReleaseUpdater,
  createLauncherWireGuardKeyPair,
  diagnoseElectronLauncherStandaloneDataPlane,
  ensureElectronLauncherUserOverseaSubscription,
  defineLauncherProduct,
  readElectronLauncherStandaloneOwnershipState,
  releaseElectronLauncherStandaloneOwnershipClaim,
  reportElectronLauncherInstallCompletionIfUpgraded,
  routePlanFromSnapshot,
  stopElectronLauncherStandaloneDataPlane,
  upsertElectronLauncherStandaloneOwnershipClaim,
  type ElectronLauncherNetworkGateState,
  type ElectronLauncherReleaseUpdater,
  type ElectronLauncherStandaloneDataPlaneDiagnostics,
  type ElectronLauncherUpdateCheckResult,
  type ElectronLauncherUpdateExecutionResult,
  type LauncherNetworkSession,
  type LauncherProductDefinition,
  type LauncherWireGuardKeyPair,
  type StandaloneLauncher
} from '@qpjoy/electron-launcher';
import {
  createElectronTunnel,
  type ElectronTunnelHandle,
  type EventRecord,
  type RuntimeMode,
  type TunnelStatus
} from '@qpjoy/electron-plugin-tunnel';

type RuntimeStatus = 'idle' | 'connecting' | 'lease-active' | 'data-plane-pending' | 'network-ready' | 'error';
type LuopanDataPlaneMode = 'reuse' | 'standalone';

interface RuntimeConfig {
  baseUrl: string;
  /**
   * Bootstrap candidates probed BEFORE the tunnel exists (docs/20 §4.5): the
   * registered baseUrl is the in-tunnel VIP and is unreachable on first
   * enroll. Sourced from LUOPAN_BOOTSTRAP_URLS (env or .env file) or edited
   * in the CONFIG panel; the resolved one serves anonymous bootstrap traffic
   * until the data plane reports network-ready. Login credentials never use it.
   */
  bootstrapUrls: string[];
  productId: string;
  mode: 'standalone';
  sdkTestMode: boolean;
  deviceLabel: string;
}

interface RuntimeConnection {
  status: RuntimeStatus;
  bootstrapBaseUrl: string | null;
  leaseId: string | null;
  leaseIp: string | null;
  serviceVip: string | null;
  dnsServer: string | null;
  routeCidrs: string[];
  snapshotDigest: string | null;
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics | null;
  message: string | null;
  updatedAt: string | null;
}

type RuntimeUpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'blocked' | 'failed';

interface RuntimeUpdateArtifact {
  artifactId: string;
  kind: string;
  artifactClass: string;
  version: string;
  activation: string;
  autoApply: boolean;
  sizeBytes: number | null;
}

interface RuntimeUpdateExecution {
  artifactId: string;
  artifactClass: string;
  phase: string;
  activated: boolean;
  deferredReason: string | null;
  error: string | null;
}

interface RuntimeUpdate {
  status: RuntimeUpdateStatus;
  checkedAt: string | null;
  currentVersion: string;
  targetVersion: string | null;
  releaseId: string | null;
  releaseNotes: string | null;
  matchedBy: string | null;
  featureFlags: string[];
  artifacts: RuntimeUpdateArtifact[];
  execution: RuntimeUpdateExecution[];
  message: string | null;
}

// User Center identity (docs/15 SDK gateway). The access token is decrypted
// only in Electron main memory and persisted inside the safeStorage vault;
// renderer-visible identity contains display metadata only.
interface RuntimeIdentity {
  kind: 'anonymous' | 'user';
  userId: string | null;
  displayName: string | null;
  account: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  loginAt: string | null;
}

type RuntimeOverseaStatus =
  | 'waiting-login'
  | 'waiting-internal'
  | 'ensuring'
  | 'pending-sync'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopped'
  | 'error';

type RuntimeOverseaMode = Extract<RuntimeMode, 'app-global' | 'app-rule'>;

interface RuntimeOversea {
  status: RuntimeOverseaStatus;
  autoConnect: boolean;
  mode: RuntimeOverseaMode;
  userId: string | null;
  entitlementId: string | null;
  subscriptionPath: string | null;
  subscriptionName: string | null;
  siteIds: string[];
  syncStatus: string | null;
  nodeCount: number;
  ensuredAt: string | null;
  startedAt: string | null;
  lastTestUrl: string;
  lastTestAt: string | null;
  lastProxyDecision: string | null;
  message: string;
}

interface RuntimeState {
  installId: string;
  deviceId: string;
  config: RuntimeConfig;
  identity: RuntimeIdentity;
  connection: RuntimeConnection;
  oversea: RuntimeOversea;
  update: RuntimeUpdate;
  events: string[];
}

type LuopanLeaseProfile = 'anonymous' | 'employee';

interface RuntimeLeaseCredential {
  credentialKey: string;
  leaseId: string | null;
  capability: string;
  productId: string;
  identityKind: 'anonymous' | 'user';
  leaseProfile: LuopanLeaseProfile;
  installId: string;
  userId: string | null;
  publicKey: string;
  expiresAt: string | null;
  updatedAt: string;
}

interface RuntimeCredentialVault {
  accessToken: string | null;
  wireGuardKeyPair: LauncherWireGuardKeyPair | null;
  leaseCredentials: Record<string, RuntimeLeaseCredential>;
}

interface ProtectedCredentialVault {
  storage: 'electron-safe-storage-v1';
  ciphertext: string;
}

interface PendingLeaseCapability {
  credentialKey: string;
  capability: string;
}

interface ServerLeaseReleaseSummary {
  released: string[];
  failed: Array<{ leaseId: string; message: string }>;
}

interface LuopanDisconnectOptions {
  requireServerRelease?: boolean;
}

type PersistedRuntimeState = Partial<RuntimeState> & {
  protectedCredentials?: unknown;
  credentialVaultVersion?: unknown;
  legacyCredentialCleanupRequired?: unknown;
};

interface OverseaSessionContext {
  generation: number;
  userId: string;
  accessToken: string;
}

interface OverseaReconcileFlight {
  generation: number;
  controller: AbortController;
  startWhenReady: boolean;
  promise: Promise<void>;
}

const PRODUCT = defineLauncherProduct({
  productId: 'luopan',
  displayName: 'Luopan',
  mode: 'standalone',
  appCenter: {
    visible: true,
    category: 'custom'
  },
  release: {
    componentId: 'luopan',
    channel: 'shadow',
    rolloutGroup: 'sdk-test'
  },
  launcherActions: {
    network: true,
    release: true,
    update: true,
    rollout: true,
    appCenter: false
  }
});

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = 'luopan-runtime.json';
const CREDENTIAL_VAULT_VERSION = 1;
const LUOPAN_REGISTERED_BASE_URL = 'http://10.88.100.3:18090';
const OVERSEA_SUBSCRIPTION_NAME = 'System Oversea 默认订阅';
const OVERSEA_SESSION_PARTITION = 'persist:luopan-oversea';
const OVERSEA_ALLOWLIST = [
  'google.com',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'googlevideo.com',
  'youtube.com',
  'youtu.be',
  'ytimg.com',
  'x.com',
  'twitter.com',
  't.co',
  'twimg.com',
  'telegram.org',
  'telegram.me',
  't.me'
];

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeState | null = null;
let activeSession: LauncherNetworkSession | null = null;
let overseaSession: Session | null = null;
let overseaTunnel: ElectronTunnelHandle | null = null;
let overseaReconcileFlight: OverseaReconcileFlight | null = null;
let overseaSessionGeneration = 0;
let overseaReadyContext: Pick<OverseaSessionContext, 'generation' | 'userId'> | null = null;
let overseaBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let activeDataPlaneMode: LuopanDataPlaneMode | null = null;
let shutdownInFlight: Promise<void> | null = null;
let shutdownComplete = false;
let sessionOperation: Promise<unknown> = Promise.resolve();
let runtimeSaveQueue: Promise<void> = Promise.resolve();
let runtimeSaveSequence = 0;
// Decrypted only in Electron main memory. saveRuntime() persists it solely
// through safeStorage; renderers only receive tokenPresent metadata.
let activeAccessToken: string | null = null;
let credentialVault: RuntimeCredentialVault = emptyCredentialVault();
let credentialStorageFailure: string | null = null;
let legacyCredentialCleanupRequired = false;
// Pinned by the last successful bootstrap resolution; serves every API call
// made before the data plane is network-ready.
let activeBootstrapBaseUrl: string | null = null;

app.setAppUserModelId('dev.qpjoy.luopan');
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function luopanDataPlaneMode(): LuopanDataPlaneMode {
  if (booleanish(environmentValue('LUOPAN_FORCE_STANDALONE_WG'), false)) return 'standalone';
  const value = environmentValue('LUOPAN_DATA_PLANE_MODE')?.trim().toLowerCase();
  if (value === 'reuse') return 'reuse';
  return 'standalone';
}

function initialDataPlaneApplyMessage(): string {
  if (luopanDataPlaneMode() === 'reuse') {
    return 'Checking existing shared launcher data plane for Luopan reuse.';
  }
  return 'Syncing Domestic peer and applying Luopan as an independent standalone data-plane owner.';
}

function defaultConfig(): RuntimeConfig {
  return {
    // Luopan's registered product VIP (docs/19, HANDOFF §网络注册). Never fall
    // back to 10.88.88.88 / 10.88.0.1 — those are MX-H2I/foundation migration
    // compatibility addresses and are off-limits to Luopan.
    baseUrl: normalizeBaseUrl(environmentValue('LUOPAN_LAUNCHER_BASE_URL') || environmentValue('MX_LAUNCHER_BASE_URL') || LUOPAN_REGISTERED_BASE_URL),
    bootstrapUrls: parseElectronLauncherBootstrapUrls(environmentValue('LUOPAN_BOOTSTRAP_URLS')),
    productId: 'luopan',
    mode: 'standalone',
    // Registered mode by default: the lease request must pass the server-side
    // ProductNetwork + AppCenter entitlement gate. SDK test mode bypasses that
    // gate and only works when the server enables it — dev opt-in via env.
    sdkTestMode: booleanish(environmentValue('LUOPAN_SDK_TEST_MODE'), false),
    deviceLabel: environmentValue('LUOPAN_DEVICE_LABEL')?.trim() || 'Luopan Quasar Demo'
  };
}

function emptyConnection(): RuntimeConnection {
  return {
    status: 'idle',
    bootstrapBaseUrl: null,
    leaseId: null,
    leaseIp: null,
    serviceVip: null,
    dnsServer: null,
    routeCidrs: [],
    snapshotDigest: null,
    dataPlane: null,
    message: 'Launcher adapter ready.',
    updatedAt: null
  };
}

function emptyCredentialVault(): RuntimeCredentialVault {
  return {
    accessToken: null,
    wireGuardKeyPair: null,
    leaseCredentials: {}
  };
}

function emptyIdentity(): RuntimeIdentity {
  return {
    kind: 'anonymous',
    userId: null,
    displayName: null,
    account: null,
    scopes: [],
    tokenExpiresAt: null,
    loginAt: null
  };
}

function emptyOversea(): RuntimeOversea {
  return {
    status: 'waiting-login',
    autoConnect: true,
    mode: 'app-global',
    userId: null,
    entitlementId: null,
    subscriptionPath: null,
    subscriptionName: null,
    siteIds: [],
    syncStatus: null,
    nodeCount: 0,
    ensuredAt: null,
    startedAt: null,
    lastTestUrl: 'https://www.google.com',
    lastTestAt: null,
    lastProxyDecision: null,
    message: '先匿名连接 Internal，再通过隧道内 VIP 登录 User Center；随后会自动确保 Oversea 订阅并启动应用代理。'
  };
}

function hasActiveUserIdentity(state = requireRuntime()): state is RuntimeState & {
  identity: RuntimeIdentity & { kind: 'user'; userId: string };
} {
  if (state.identity.kind !== 'user' || !state.identity.userId || !activeAccessToken) return false;
  const expiresAt = state.identity.tokenExpiresAt ? Date.parse(state.identity.tokenExpiresAt) : Number.NaN;
  return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}

function emptyUpdate(): RuntimeUpdate {
  return {
    status: 'idle',
    checkedAt: null,
    currentVersion: app.getVersion(),
    targetVersion: null,
    releaseId: null,
    releaseNotes: null,
    matchedBy: null,
    featureFlags: [],
    artifacts: [],
    execution: [],
    message: 'Release Center not checked yet.'
  };
}

async function loadRuntime(): Promise<RuntimeState> {
  const fallback: RuntimeState = {
    installId: `luopan-inst-${randomUUID()}`,
    deviceId: `luopan-dev-${randomUUID()}`,
    config: defaultConfig(),
    identity: emptyIdentity(),
    connection: emptyConnection(),
    oversea: emptyOversea(),
    update: emptyUpdate(),
    events: []
  };
  const file = runtimeStateFile();
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as PersistedRuntimeState;
    const hasProtectedCredentials = parsed.protectedCredentials !== undefined && parsed.protectedCredentials !== null;
    legacyCredentialCleanupRequired = parsed.legacyCredentialCleanupRequired === true || (
      !hasProtectedCredentials
      && parsed.credentialVaultVersion !== CREDENTIAL_VAULT_VERSION
      && Boolean(stringValue(parsed.installId) || stringValue(parsed.deviceId))
    );
    credentialVault = unprotectCredentialVault(parsed.protectedCredentials);
    const persistedIdentity = normalizeIdentity(parsed.identity);
    const identity = identityCanResume(persistedIdentity, credentialVault.accessToken)
      ? persistedIdentity
      : emptyIdentity();
    activeAccessToken = identity.kind === 'user' ? credentialVault.accessToken : null;
    if (!activeAccessToken) credentialVault.accessToken = null;
    const connection = normalizeConnection(parsed.connection);
    if (credentialStorageFailure) {
      connection.status = 'error';
      connection.message = `安全凭据存储不可用，已阻止网络续租：${credentialStorageFailure}`;
      connection.updatedAt = new Date().toISOString();
    } else if (legacyCredentialCleanupRequired) {
      connection.status = 'error';
      connection.message = '检测到旧版 Luopan 未保存 WireGuard key/capability；下次连接会先清理旧本地网络并轮换 install/device identity。';
      connection.updatedAt = new Date().toISOString();
    }
    return {
      installId: stringValue(parsed.installId) || fallback.installId,
      deviceId: stringValue(parsed.deviceId) || fallback.deviceId,
      // Explicit process/.env values are deployment configuration and win
      // over CONFIG-panel values persisted by an older app run.
      config: constrainRuntimeConfig(applyEnvironmentConfigOverrides(normalizeConfig(parsed.config, fallback.config))),
      // User metadata resumes only when its access token was decrypted from
      // Electron safeStorage and has not expired.
      identity,
      connection,
      oversea: normalizeOversea(parsed.oversea),
      update: normalizeUpdate(parsed.update),
      // Runtime events can contain user/site identifiers; a fresh process has
      // no authenticated user and must not expose the previous user's trail.
      events: []
    };
  } catch {
    credentialVault = emptyCredentialVault();
    credentialStorageFailure = null;
    legacyCredentialCleanupRequired = false;
    activeAccessToken = null;
    return fallback;
  }
}

async function saveRuntime(): Promise<void> {
  if (!runtime) return;
  const file = runtimeStateFile();
  const protectedCredentials = protectCredentialVault(credentialVault);
  const snapshot = JSON.stringify({
    ...runtime,
    credentialVaultVersion: CREDENTIAL_VAULT_VERSION,
    legacyCredentialCleanupRequired,
    ...(protectedCredentials ? { protectedCredentials } : {})
  }, null, 2);
  const sequence = ++runtimeSaveSequence;
  const next = runtimeSaveQueue.catch(() => undefined).then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    const temporary = `${file}.${process.pid}.${sequence}.tmp`;
    try {
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  });
  runtimeSaveQueue = next;
  await next;
}

function runSessionExclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = sessionOperation.then(task, task);
  sessionOperation = next.catch(() => undefined);
  return next;
}

function runtimeStateFile(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function secureCredentialStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  const backend = typeof safeStorage.getSelectedStorageBackend === 'function'
    ? stringValue(safeStorage.getSelectedStorageBackend())
    : null;
  return Boolean(backend && backend !== 'basic_text');
}

function ensureCredentialStorageReady(): void {
  if (credentialStorageFailure) {
    throw new Error(`安全凭据存储恢复失败：${credentialStorageFailure}。请备份诊断后删除 Luopan runtime 再重新登录。`);
  }
  if (!secureCredentialStorageAvailable()) {
    throw new Error('Electron safeStorage 不可用或仅提供 Linux basic_text，已阻止保存 token、lease capability 和 WireGuard 私钥。');
  }
}

function protectCredentialVault(input: RuntimeCredentialVault): ProtectedCredentialVault | null {
  if (credentialStorageFailure) {
    throw new Error(`Refusing to overwrite unreadable protected credentials: ${credentialStorageFailure}`);
  }
  const normalized = normalizeCredentialVault(input);
  credentialVault = normalized;
  const hasCredentials = Boolean(
    normalized.accessToken
    || normalized.wireGuardKeyPair?.privateKey
    || Object.keys(normalized.leaseCredentials).length > 0
  );
  if (!hasCredentials) return null;
  ensureCredentialStorageReady();
  return {
    storage: 'electron-safe-storage-v1',
    ciphertext: safeStorage.encryptString(JSON.stringify(normalized)).toString('base64')
  };
}

function unprotectCredentialVault(input: unknown): RuntimeCredentialVault {
  credentialStorageFailure = null;
  if (input === undefined || input === null) return emptyCredentialVault();
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const ciphertext = stringValue(record.ciphertext);
  if (record.storage !== 'electron-safe-storage-v1' || !ciphertext) {
    credentialStorageFailure = 'runtime 中的加密凭据格式无效';
    return emptyCredentialVault();
  }
  try {
    if (!secureCredentialStorageAvailable()) {
      throw new Error('Electron safeStorage 不可用或仅提供 Linux basic_text');
    }
    return normalizeCredentialVault(JSON.parse(
      safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    ));
  } catch (error) {
    credentialStorageFailure = errorMessage(error);
    return emptyCredentialVault();
  }
}

function normalizeCredentialVault(input: unknown): RuntimeCredentialVault {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const keyPairRecord = record.wireGuardKeyPair && typeof record.wireGuardKeyPair === 'object'
    ? record.wireGuardKeyPair as Record<string, unknown>
    : {};
  const privateKey = stringValue(keyPairRecord.privateKey);
  const publicKey = stringValue(keyPairRecord.publicKey);
  const rawCredentials = record.leaseCredentials && typeof record.leaseCredentials === 'object'
    ? Object.values(record.leaseCredentials as Record<string, unknown>)
    : [];
  const leaseCredentials = Object.fromEntries(rawCredentials
    .map(normalizeLeaseCredential)
    .filter((item): item is RuntimeLeaseCredential => Boolean(item))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 24)
    .map((item) => [item.credentialKey, item]));
  return {
    accessToken: stringValue(record.accessToken),
    wireGuardKeyPair: privateKey && publicKey ? { privateKey, publicKey } : null,
    leaseCredentials
  };
}

function normalizeLeaseCredential(input: unknown): RuntimeLeaseCredential | null {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const credentialKey = stringValue(record.credentialKey);
  const capability = stringValue(record.capability);
  const productId = stringValue(record.productId);
  const installId = stringValue(record.installId);
  const publicKey = stringValue(record.publicKey);
  if (
    !credentialKey
    || !capability
    || !/^mxlc1\.[A-Za-z0-9_-]{43}$/.test(capability)
    || !productId
    || !installId
    || !publicKey
  ) return null;
  const identityKind = record.identityKind === 'user' ? 'user' : 'anonymous';
  return {
    credentialKey,
    leaseId: stringValue(record.leaseId),
    capability,
    productId,
    identityKind,
    leaseProfile: identityKind === 'user' ? 'employee' : 'anonymous',
    installId,
    userId: identityKind === 'user' ? stringValue(record.userId) : null,
    publicKey,
    expiresAt: stringValue(record.expiresAt),
    updatedAt: stringValue(record.updatedAt) || new Date(0).toISOString()
  };
}

function identityCanResume(identity: RuntimeIdentity, accessToken: string | null): boolean {
  if (identity.kind !== 'user' || !identity.userId || !accessToken) return false;
  const expiresAt = identity.tokenExpiresAt ? Date.parse(identity.tokenExpiresAt) : Number.NaN;
  return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}

function ensureWireGuardKeyPair(): LauncherWireGuardKeyPair {
  ensureCredentialStorageReady();
  if (!credentialVault.wireGuardKeyPair) {
    credentialVault.wireGuardKeyPair = createLauncherWireGuardKeyPair();
  }
  return credentialVault.wireGuardKeyPair;
}

function pendingLeaseCredentialKey(identityKind: 'anonymous' | 'user', userId: string | null): string {
  const profile: LuopanLeaseProfile = identityKind === 'user' ? 'employee' : 'anonymous';
  return `pending:${requireRuntime().config.productId}:${profile}:${userId || 'anonymous'}`;
}

function ensurePendingLeaseCapability(
  identityKind: 'anonymous' | 'user',
  userId: string | null
): PendingLeaseCapability {
  const state = requireRuntime();
  const keyPair = ensureWireGuardKeyPair();
  const credentialKey = pendingLeaseCredentialKey(identityKind, userId);
  const existing = credentialVault.leaseCredentials[credentialKey];
  if (existing?.capability) return { credentialKey, capability: existing.capability };
  const capability = `mxlc1.${randomBytes(32).toString('base64url')}`;
  credentialVault.leaseCredentials[credentialKey] = {
    credentialKey,
    leaseId: null,
    capability,
    productId: state.config.productId,
    identityKind,
    leaseProfile: identityKind === 'user' ? 'employee' : 'anonymous',
    installId: state.installId,
    userId,
    publicKey: keyPair.publicKey,
    expiresAt: null,
    updatedAt: new Date().toISOString()
  };
  credentialVault = normalizeCredentialVault(credentialVault);
  return { credentialKey, capability };
}

function leaseCapabilitiesForEnrollment(
  identityKind: 'anonymous' | 'user',
  userId: string | null
): string | undefined {
  const state = requireRuntime();
  const publicKey = credentialVault.wireGuardKeyPair?.publicKey;
  const profile: LuopanLeaseProfile = identityKind === 'user' ? 'employee' : 'anonymous';
  const credentials = Object.values(credentialVault.leaseCredentials)
    .filter((item) => (
      item.productId === state.config.productId
      && item.installId === state.installId
      && (!publicKey || item.publicKey === publicKey)
    ))
    .sort((left, right) => {
      const leftPriority = left.leaseProfile === profile && left.userId === userId ? 1 : 0;
      const rightPriority = right.leaseProfile === profile && right.userId === userId ? 1 : 0;
      return rightPriority - leftPriority || right.updatedAt.localeCompare(left.updatedAt);
    });
  const capabilities = [...new Set(credentials.map((item) => item.capability))].slice(0, 16);
  return capabilities.length > 0 ? capabilities.join(',') : undefined;
}

function rememberLeaseCredential(
  lease: LauncherNetworkSession['lease'],
  pendingCredentialKey?: string
): void {
  const state = requireRuntime();
  const leaseId = stringValue(lease.leaseId);
  const fallbackCapability = pendingCredentialKey
    ? credentialVault.leaseCredentials[pendingCredentialKey]?.capability
    : null;
  const capability = stringValue(lease.capability) || fallbackCapability;
  const publicKey = stringValue(lease.publicKey) || credentialVault.wireGuardKeyPair?.publicKey || null;
  if (!leaseId || !capability || !publicKey) {
    throw new Error('Launcher enrollment did not return a persistable lease capability and public key.');
  }
  const retained = Object.fromEntries(Object.entries(credentialVault.leaseCredentials)
    .filter(([key, item]) => (
      key !== pendingCredentialKey
      && item.leaseId !== leaseId
    )));
  retained[leaseId] = {
    credentialKey: leaseId,
    leaseId,
    capability,
    productId: stringValue(lease.productId) || state.config.productId,
    identityKind: lease.identityKind === 'user' ? 'user' : 'anonymous',
    leaseProfile: lease.identityKind === 'user' ? 'employee' : 'anonymous',
    installId: stringValue(lease.installId) || state.installId,
    userId: lease.identityKind === 'user' ? stringValue(lease.userId) : null,
    publicKey,
    expiresAt: stringValue(lease.expiresAt),
    updatedAt: new Date().toISOString()
  };
  credentialVault.leaseCredentials = retained;
  credentialVault = normalizeCredentialVault(credentialVault);
}

function forgetLeaseCredential(leaseId: string): void {
  credentialVault.leaseCredentials = Object.fromEntries(
    Object.entries(credentialVault.leaseCredentials)
      .filter(([, item]) => item.leaseId !== leaseId)
  );
}

function leaseCredentialForLeaseId(leaseId: string | null): RuntimeLeaseCredential | null {
  if (!leaseId) return null;
  return Object.values(credentialVault.leaseCredentials)
    .find((item) => item.leaseId === leaseId) ?? null;
}

function hasReleasableLeaseCredentials(state = requireRuntime()): boolean {
  return Object.values(credentialVault.leaseCredentials).some((item) => (
    Boolean(item.leaseId)
    && item.productId === state.config.productId
    && item.installId === state.installId
  ));
}

function completeLegacyCredentialMigration(): void {
  if (!legacyCredentialCleanupRequired) return;
  const state = requireRuntime();
  state.installId = `luopan-inst-${randomUUID()}`;
  state.deviceId = `luopan-dev-${randomUUID()}`;
  credentialVault = emptyCredentialVault();
  activeAccessToken = null;
  state.identity = emptyIdentity();
  legacyCredentialCleanupRequired = false;
  pushEvent('legacy launcher identity rotated after local data-plane cleanup');
}

function visibleRuntime() {
  const state = requireRuntime();
  return {
    appId: PRODUCT.productId,
    displayName: PRODUCT.displayName,
    packageName: '@qpjoy/electron-launcher',
    launcherMode: PRODUCT.mode,
    installId: state.installId,
    deviceId: state.deviceId,
    credentialMigrationRequired: legacyCredentialCleanupRequired,
    config: state.config,
    identity: { ...state.identity, tokenPresent: hasActiveUserIdentity(state) },
    connection: state.connection,
    oversea: {
      ...state.oversea,
      tunnel: visibleOverseaTunnel()
    },
    update: state.update,
    events: state.events
  };
}

function visibleOverseaTunnel() {
  const status = overseaTunnel?.status() ?? null;
  const active = status?.activeSubscription ?? null;
  const events = overseaTunnel?.manager.listEvents().slice(0, 30).map(visibleOverseaEvent) ?? [];
  return {
    running: status?.running ?? false,
    health: status?.health ?? { ok: false, level: 'warning' as const, message: 'Oversea tunnel runtime is initializing.' },
    mode: (status?.mode === 'app-rule' ? 'app-rule' : 'app-global') as RuntimeOverseaMode,
    ports: status?.ports ?? { admin: 23456, controller: 23457, mixed: 23458, dns: 1053 },
    engine: status?.engine
      ? {
          target: status.engine.target,
          available: status.engine.available,
          source: status.engine.source
        }
      : { target: `${process.platform}-${process.arch}`, available: false, source: 'missing' as const },
    activeSubscription: active
      ? {
          id: active.id,
          name: active.name,
          lastUpdatedAt: active.lastUpdatedAt
        }
      : null,
    events
  };
}

function visibleOverseaEvent(event: EventRecord) {
  return {
    id: event.id,
    level: event.level,
    message: event.message,
    createdAt: event.createdAt
  };
}

function requireRuntime(): RuntimeState {
  if (!runtime) throw new Error('Luopan runtime is not ready');
  return runtime;
}

function launcherClient(): StandaloneLauncher {
  const state = requireRuntime();
  const keyPair = credentialVault.wireGuardKeyPair;
  const launcher = createElectronLauncher({
    baseUrl: effectiveApiBaseUrl(),
    productId: state.config.productId,
    mode: 'standalone',
    installId: state.installId,
    deviceId: state.deviceId,
    deviceLabel: state.config.deviceLabel,
    keyPair: keyPair ?? undefined,
    privateKey: keyPair?.privateKey,
    publicKey: keyPair?.publicKey
  });
  if (launcher.mode !== 'standalone') {
    throw new Error('Luopan demo requires standalone launcher mode');
  }
  return launcher;
}

/**
 * API base for the current phase: once the data plane is network-ready the
 * product talks to its own VIP; before that (enroll, login, update check,
 * peer sync) everything goes through the resolved bootstrap URL.
 */
function effectiveApiBaseUrl(): string {
  const state = requireRuntime();
  if (state.connection.status === 'network-ready') return state.config.baseUrl;
  return activeBootstrapBaseUrl || state.config.baseUrl;
}

/**
 * Probe bootstrap candidates (env/.env/config order) and pin the first
 * healthy one. `force` re-probes even when one is already pinned — used when
 * a connect attempt starts, so a network change picks a new entrance.
 */
async function ensureBootstrapResolved(force = false): Promise<ElectronLauncherBootstrapResolution | null> {
  const state = requireRuntime();
  if (!force && activeBootstrapBaseUrl) return null;
  const resolution = await resolveElectronLauncherBootstrap({
    candidates: [
      ...state.config.bootstrapUrls.map((url) => ({ url, source: 'bootstrap-urls' })),
      { url: state.config.baseUrl, source: 'config.baseUrl' }
    ],
    timeoutMs: 3000
  });
  if (resolution.ok && resolution.baseUrl) {
    activeBootstrapBaseUrl = resolution.baseUrl;
    state.connection.bootstrapBaseUrl = resolution.baseUrl;
    pushEvent(`bootstrap resolved ${resolution.baseUrl} (${resolution.source})`);
  } else {
    activeBootstrapBaseUrl = null;
    state.connection.bootstrapBaseUrl = null;
    pushEvent('bootstrap resolve failed');
  }
  return resolution;
}

// --- Release update wiring (docs/19 §3+§5, docs/17 state machine) ----------
// Everything below consumes @qpjoy/electron-launcher; no update logic lives in
// the product. The last check result is kept in memory only: `apply-update`
// must always execute a fresh Release Center decision, never a persisted one.
let lastUpdateCheck: ElectronLauncherUpdateCheckResult | null = null;

function releaseUpdater(): ElectronLauncherReleaseUpdater {
  const state = requireRuntime();
  return createElectronLauncherReleaseUpdater({
    // In-tunnel VIP once connected; bootstrap URL before that, so the update
    // panel (and startup bookkeeping) works pre-connect too.
    baseUrl: effectiveApiBaseUrl(),
    reportInstallId: state.installId
  });
}

// docs/17 stability boundary: never activate artifacts while the product's
// network path is busy. Luopan maps its connection status onto the gate; the
// executor re-checks this before every activation and defers with a report.
function updateNetworkGate(): ElectronLauncherNetworkGateState {
  const status = requireRuntime().connection.status;
  if (status === 'connecting') return 'connecting';
  if (status === 'data-plane-pending') return 'recovering';
  return 'idle';
}

function updateExecutor(updater: ElectronLauncherReleaseUpdater) {
  return createElectronLauncherReleaseUpdateExecutor({
    updater,
    baseDir: app.getPath('userData'),
    installId: requireRuntime().installId,
    networkGate: () => updateNetworkGate(),
    onPhase: (phase, detail) => {
      const artifactId = typeof detail.artifactId === 'string' ? ` ${detail.artifactId}` : '';
      pushEvent(`update ${phase}${artifactId}`);
      broadcastRuntime();
    },
    applyConfig: (activePath) => {
      pushEvent(`config snapshot activated ${path.basename(activePath)}`);
      broadcastRuntime();
    },
    applyRenderer: (activePath) => {
      pushEvent(`renderer bundle activated ${path.basename(activePath)}`);
      mainWindow?.webContents.reload();
    },
    openInstaller: async (filePath) => {
      await shell.openPath(filePath);
    }
  });
}

// Ranking across the installer/hot component namespaces: an actionable
// decision wins; blocked beats up-to-date so gate state stays visible.
function chooseUpdateCheck(checks: ElectronLauncherUpdateCheckResult[]): ElectronLauncherUpdateCheckResult {
  if (checks.length === 0) throw new Error('Release check returned no results');
  return checks.find((check) => check.status === 'update-available')
    ?? checks.find((check) => check.status === 'blocked')
    ?? checks.find((check) => check.status === 'up-to-date')
    ?? checks[0];
}

function updateFromCheck(check: ElectronLauncherUpdateCheckResult): RuntimeUpdate {
  return {
    status: check.status,
    checkedAt: check.checkedAt,
    currentVersion: app.getVersion(),
    targetVersion: check.decision.targetVersion || null,
    releaseId: check.plan?.releaseId ?? null,
    releaseNotes: check.releaseNotes ?? null,
    matchedBy: check.rollout?.matchedBy ?? null,
    featureFlags: check.featureFlags ?? [],
    artifacts: check.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      artifactClass: classifyElectronLauncherUpdateArtifact(artifact.kind),
      version: artifact.version,
      activation: artifact.activation,
      autoApply: artifact.autoApply,
      sizeBytes: artifact.sizeBytes
    })),
    execution: [],
    message: check.reason
  };
}

function executionSummary(result: ElectronLauncherUpdateExecutionResult): RuntimeUpdateExecution[] {
  return result.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    artifactClass: artifact.artifactClass,
    phase: artifact.phase,
    activated: artifact.activated,
    deferredReason: artifact.deferredReason,
    error: artifact.error
  }));
}

// Boot-time update bookkeeping (docs/19 §5 pipelines 3+4): promote staged
// npm-package pointers to current, then report installer-completed on the
// first start after a version change so Release Center closes the loop.
async function adoptUpdatesAndReportInstallCompletion(): Promise<void> {
  const baseDir = app.getPath('userData');
  const adopted = await adoptPendingElectronLauncherPackages(baseDir);
  for (const pointer of adopted) {
    pushEvent(`launcher package adopted ${pointer.version}`);
  }
  // A first start after installer activation occurs before the data plane is
  // ready. Resolve the public/LAN entrance before constructing the updater so
  // installer-completed evidence is not sent to the unreachable in-tunnel VIP.
  if (requireRuntime().connection.status !== 'network-ready') {
    await ensureBootstrapResolved();
  }
  const completion = await reportElectronLauncherInstallCompletionIfUpgraded({
    updater: releaseUpdater(),
    baseDir,
    currentVersion: app.getVersion(),
    installId: requireRuntime().installId
  });
  if (completion.upgraded) {
    pushEvent(`installer completed ${completion.from} -> ${completion.to}`);
  }
  if (adopted.length > 0 || completion.upgraded) {
    await saveRuntime();
    broadcastRuntime();
  }
}

function pushEvent(message: string): void {
  const state = requireRuntime();
  const stamp = new Date().toISOString().slice(11, 19);
  state.events = [`${stamp} ${message}`, ...state.events].slice(0, 12);
}

async function setConnection(connection: Partial<RuntimeConnection>): Promise<void> {
  const state = requireRuntime();
  state.connection = {
    ...state.connection,
    ...connection,
    updatedAt: new Date().toISOString()
  };
  await saveRuntime();
  broadcastRuntime();
}

function broadcastRuntime(): void {
  mainWindow?.webContents.send('luopan:runtime', visibleRuntime());
}

function resolvePreloadPath(): string {
  const override = process.env.QUASAR_ELECTRON_PRELOAD;
  const candidates = [
    override ? path.resolve(currentDir, override) : '',
    path.resolve(currentDir, 'preload/electron-preload.cjs'),
    path.resolve(currentDir, 'electron-preload.cjs'),
    path.resolve(currentDir, 'electron-preload.js')
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function createWindow(): Promise<void> {
  nativeTheme.themeSource = 'dark';
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    title: 'Luopan',
    backgroundColor: '#171b28',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: resolvePreloadPath()
    }
  });
  mainWindow = window;

  if (process.platform === 'win32') {
    // Windows logoff/shutdown does not emit app.before-quit. Hold the session
    // open until the same strict Internal/Oversea cleanup transaction settles.
    (window as unknown as {
      on(eventName: 'query-session-end', listener: (event: { preventDefault(): void }) => void): void;
    }).on('query-session-end', (event) => {
      if (shutdownComplete) return;
      event.preventDefault();
      if (shutdownInFlight) return;
      shutdownInFlight = runSessionExclusive(shutdownLuopanApplication)
        .then(() => {
          shutdownComplete = true;
          app.quit();
        })
        .catch(surfaceShutdownFailure)
        .finally(() => {
          if (!shutdownComplete) shutdownInFlight = null;
        });
    });
  }

  window.once('ready-to-show', () => {
    mainWindow?.show();
    broadcastRuntime();
  });
  window.on('closed', () => {
    mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.DEV) {
    await loadDevRenderer(window);
  } else {
    await window.loadFile('index.html');
  }
}

async function loadDevRenderer(window: BrowserWindow): Promise<void> {
  const candidates = devRendererUrlCandidates();
  const lastErrors = new Map<string, string>();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const url of candidates) {
      try {
        await probeDevServer(url);
        await window.loadURL(url);
        return;
      } catch (error) {
        lastErrors.set(url, errorMessage(error));
      }
    }
    await sleep(250);
  }
  const attempts = candidates.map((url) => `${url}: ${lastErrors.get(url) || 'not-attempted'}`);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(devRendererErrorHtml(attempts))}`);
  if (!window.isVisible()) window.show();
}

function devRendererUrlCandidates(): string[] {
  const explicit = normalizeDevRendererUrl(environmentValue('LUOPAN_RENDERER_URL'));
  const appUrl = normalizeDevRendererUrl(process.env.APP_URL);
  const ports = uniqueNumbers([
    devRendererPort(explicit),
    devRendererPort(appUrl),
    9031
  ].filter((port): port is number => Boolean(port)));
  return uniqueStrings([
    explicit,
    ...ports.flatMap((port) => devRendererNetworkHosts().map((host) => `http://${host}:${port}`)),
    appUrl,
    ...ports.flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  ].filter((url): url is string => Boolean(url)));
}

function normalizeDevRendererUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.hostname === '0.0.0.0' || url.hostname === '::') return null;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function devRendererPort(rawUrl: string | null): number | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function devRendererNetworkHosts(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    .filter(isDevRendererAddress)
    .sort((left, right) => devRendererAddressScore(left) - devRendererAddressScore(right));
  return uniqueStrings(addresses);
}

function isDevRendererAddress(address: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 127 || (parts[0] === 169 && parts[1] === 254)) return false;
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return false;
  return true;
}

function devRendererAddressScore(address: string): number {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 2;
  return 3;
}

async function probeDevServer(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname;
  await tcpProbe(host, port);
}

function tcpProbe(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const finish = (error?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.setTimeout(1000, () => finish(new Error('tcp-timeout')));
    socket.once('connect', () => finish());
    socket.once('error', finish);
  });
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function devRendererErrorHtml(attempts: string[]): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Luopan renderer unavailable</title>
    <style>
      body { margin: 0; min-height: 100vh; background: #171b28; color: #f4f7fb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: grid; place-items: center; }
      main { width: min(760px, calc(100vw - 64px)); border: 1px solid #33415f; border-radius: 8px; padding: 28px; background: #1d2333; }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p, li { color: #b7bfce; line-height: 1.55; }
      code { color: #34f5d2; }
      pre { white-space: pre-wrap; color: #fda4af; background: #111624; border-radius: 6px; padding: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Luopan renderer is not ready</h1>
      <p>Electron could not load the Quasar dev server. Keep <code>pnpm dev</code> running and check that port <code>9031</code> is not blocked or occupied.</p>
      <pre>${escapeHtml(attempts.join('\n') || 'No renderer URL was attempted.')}</pre>
    </main>
  </body>
</html>`;
}

async function initializeOverseaTunnel(): Promise<void> {
  overseaSession = session.fromPartition(OVERSEA_SESSION_PARTITION, { cache: true });
  await clearOverseaBrowserSession();
  overseaTunnel = createElectronTunnel({ app, ipcMain, session: overseaSession }, {
    appName: 'Luopan Oversea',
    userDataPath: path.join(app.getPath('userData'), 'oversea'),
    startAdminServer: false,
    registerIpc: false,
    registerMarketplace: false,
    adminPort: 23456,
    controllerPort: 23457,
    mixedPort: 23458,
    dnsPort: 1053
  });
  const allocatedPorts = await allocateOverseaPorts(overseaTunnel.status());
  await overseaTunnel.manager.setLocalPorts(allocatedPorts);
  const desiredMode = requireRuntime().oversea.mode;
  if (overseaTunnel.status().mode !== desiredMode) {
    overseaTunnel.manager.setMode(desiredMode);
  }
  await overseaTunnel.applyProxy();
  clearOverseaManagedSubscriptions('startup');
  overseaTunnel.manager.clearEvents();
  overseaTunnel.manager.on('event', scheduleOverseaBroadcast);
  const state = requireRuntime();
  state.oversea = {
    ...state.oversea,
    status: 'waiting-login',
    userId: null,
    entitlementId: null,
    subscriptionPath: null,
    subscriptionName: null,
    siteIds: [],
    syncStatus: null,
    nodeCount: 0,
    ensuredAt: null,
    startedAt: null,
    lastProxyDecision: 'DIRECT',
    message: '先匿名连接 Internal，再通过隧道内 VIP 登录 User Center；随后会自动确保 Oversea 订阅并启动应用代理。'
  };
  await saveRuntime();
}

function configureOverseaNativeRuntime(): void {
  if (process.env.QPJOY_TUNNEL_BETTER_SQLITE3_PATH?.trim()) return;
  const packageRelativePath = path.join('node_modules', 'better-sqlite3');
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'luopan-native', packageRelativePath)]
    : [
        path.resolve(currentDir, '..', '..', '.electron-native', packageRelativePath),
        path.resolve(process.cwd(), '.electron-native', packageRelativePath)
      ];
  const selected = candidates.find((candidate) => existsSync(path.join(candidate, 'package.json')));
  if (!selected) {
    throw new Error('Electron native runtime is missing. Run `pnpm run prepare:electron-native` in demos/luopan.');
  }
  process.env.QPJOY_TUNNEL_BETTER_SQLITE3_PATH = selected;
}

async function allocateOverseaPorts(status: TunnelStatus): Promise<TunnelStatus['ports']> {
  const requests = [
    ['admin', 'mihomo-admin', status.ports.admin, 'tcp'],
    ['controller', 'mihomo-controller', status.ports.controller, 'tcp'],
    ['mixed', 'mihomo-mixed', status.ports.mixed, 'tcp'],
    ['dns', 'mihomo-dns', status.ports.dns, 'tcp+udp']
  ] as const;
  const allocated = { ...status.ports };
  for (const [key, service, preferredPort, protocol] of requests) {
    const lease = await allocateElectronLauncherLocalPort({
      productId: PRODUCT.productId,
      service,
      preferredPort,
      protocol
    });
    allocated[key] = lease.port;
  }
  return allocated;
}

function scheduleOverseaBroadcast(): void {
  if (overseaBroadcastTimer) return;
  overseaBroadcastTimer = setTimeout(() => {
    overseaBroadcastTimer = null;
    if (runtime && runtime.oversea.status === 'running' && overseaTunnel && !overseaTunnel.status().running) {
      void overseaSession?.setProxy({ mode: 'direct' }).catch(() => undefined);
      runtime.oversea = {
        ...runtime.oversea,
        status: 'error',
        lastProxyDecision: 'DIRECT',
        message: overseaTunnel.status().health.message || 'mihomo 已意外退出；请查看日志并重新启动。'
      };
      void saveRuntime();
    }
    if (runtime) broadcastRuntime();
  }, 120);
}

function requireOverseaTunnel(): ElectronTunnelHandle {
  if (!overseaTunnel || !overseaSession) throw new Error('Luopan Oversea tunnel runtime is not ready.');
  return overseaTunnel;
}

async function setOversea(patch: Partial<RuntimeOversea>): Promise<void> {
  const state = requireRuntime();
  state.oversea = { ...state.oversea, ...patch };
  await saveRuntime();
  broadcastRuntime();
}

function captureOverseaSessionContext(): OverseaSessionContext | null {
  const state = requireRuntime();
  const accessToken = activeAccessToken;
  if (!hasActiveUserIdentity(state) || !accessToken) {
    return null;
  }
  return {
    generation: overseaSessionGeneration,
    userId: state.identity.userId,
    accessToken
  };
}

function isCurrentOverseaSession(context: OverseaSessionContext): boolean {
  const state = requireRuntime();
  return context.generation === overseaSessionGeneration
    && hasActiveUserIdentity(state)
    && state.identity.userId === context.userId
    && activeAccessToken === context.accessToken;
}

function hasReadyOverseaSubscription(context: OverseaSessionContext): boolean {
  return isCurrentOverseaSession(context)
    && overseaReadyContext?.generation === context.generation
    && overseaReadyContext.userId === context.userId
    && Boolean(overseaTunnel?.status().activeSubscription);
}

async function setOverseaForSession(context: OverseaSessionContext, patch: Partial<RuntimeOversea>): Promise<boolean> {
  if (!isCurrentOverseaSession(context)) return false;
  await setOversea(patch);
  return isCurrentOverseaSession(context);
}

function clearOverseaManagedSubscriptions(reason: string): void {
  if (!overseaTunnel) return;
  const subscriptions = overseaTunnel.manager.listSubscriptions();
  for (const subscription of subscriptions) {
    overseaTunnel.manager.deleteSubscription(subscription.id);
  }
  overseaReadyContext = null;
  if (subscriptions.length > 0) pushEvent(`oversea subscriptions cleared ${reason}`);
}

async function deactivateOverseaTunnel(): Promise<void> {
  if (overseaTunnel) await overseaTunnel.manager.stop();
  await overseaSession?.setProxy({ mode: 'direct' });
}

async function clearOverseaBrowserSession(): Promise<void> {
  if (!overseaSession) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window !== mainWindow && !window.isDestroyed() && window.webContents.session === overseaSession) {
      window.destroy();
    }
  }
  await overseaSession.clearStorageData();
  await overseaSession.clearCache();
}

async function invalidateOverseaIdentitySession(reason: string): Promise<void> {
  const flight = overseaReconcileFlight;
  activeAccessToken = null;
  credentialVault.accessToken = null;
  overseaSessionGeneration += 1;
  overseaReadyContext = null;
  flight?.controller.abort();
  await flight?.promise.catch(() => undefined);
  const failures: string[] = [];
  try {
    await deactivateOverseaTunnel();
  } catch (error) {
    failures.push(`stop: ${errorMessage(error)}`);
  }
  try {
    clearOverseaManagedSubscriptions(reason);
  } catch (error) {
    failures.push(`subscription purge: ${errorMessage(error)}`);
  }
  try {
    overseaTunnel?.manager.clearEvents();
  } catch (error) {
    failures.push(`event purge: ${errorMessage(error)}`);
  }
  try {
    await clearOverseaBrowserSession();
  } catch (error) {
    failures.push(`browser session purge: ${errorMessage(error)}`);
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}

async function abortOverseaReconcile(): Promise<void> {
  const flight = overseaReconcileFlight;
  if (!flight) return;
  flight.controller.abort();
  await flight.promise.catch(() => undefined);
}

function reconcileOversea(reason: string, startWhenReady = false): Promise<void> {
  const state = requireRuntime();
  const context = captureOverseaSessionContext();
  if (!context) {
    return setOversea({
      status: 'waiting-login',
      userId: null,
      message: '请先登录 User Center；Oversea 订阅只为当前登录用户自动创建。'
    });
  }
  if (state.connection.status !== 'network-ready') {
    return setOversea({
      status: 'waiting-internal',
      userId: context.userId,
      message: '登录已完成；连接 Internal 后会自动确保 Oversea 订阅并启动代理。'
    });
  }

  const current = overseaReconcileFlight;
  if (current?.generation === context.generation) {
    current.startWhenReady ||= startWhenReady;
    return current.promise;
  }

  current?.controller.abort();
  const controller = new AbortController();
  const flight: OverseaReconcileFlight = {
    generation: context.generation,
    controller,
    startWhenReady,
    promise: Promise.resolve()
  };
  const previous = current?.promise.catch(() => undefined) ?? Promise.resolve();
  const promise = previous.then(() => runOverseaReconcile(reason, context, flight));
  flight.promise = promise.finally(() => {
    if (overseaReconcileFlight === flight) overseaReconcileFlight = null;
  });
  overseaReconcileFlight = flight;
  return flight.promise;
}

function reconcileOverseaInBackground(reason: string): void {
  void reconcileOversea(reason).catch((error) => {
    console.warn(`[luopan] automatic Oversea reconcile failed (${reason}):`, errorMessage(error));
  });
}

async function runOverseaReconcile(
  reason: string,
  context: OverseaSessionContext,
  flight: OverseaReconcileFlight
): Promise<void> {
  if (!isCurrentOverseaSession(context) || requireRuntime().connection.status !== 'network-ready') return;

  pushEvent(`oversea ensure started ${reason}`);
  if (!await setOverseaForSession(context, {
    status: 'ensuring',
    userId: context.userId,
    message: '正在通过 Internal 为当前用户确保 Oversea 订阅并同步远端账号。'
  })) return;
  try {
    const state = requireRuntime();
    const result = await ensureElectronLauncherUserOverseaSubscription({
      baseUrl: state.config.baseUrl,
      userId: context.userId,
      accessToken: context.accessToken,
      siteIds: configuredOverseaSiteIds(),
      requestedBy: 'luopan-oversea',
      requestId: `luopan-oversea-${context.generation}-${Date.now()}`,
      signal: flight.controller.signal
    });
    if (!isCurrentOverseaSession(context) || flight.controller.signal.aborted) return;
    const common = {
      userId: context.userId,
      entitlementId: result.entitlementId,
      subscriptionPath: result.ready ? result.subscription?.path ?? null : null,
      subscriptionName: result.ready && result.subscription ? OVERSEA_SUBSCRIPTION_NAME : null,
      siteIds: result.siteIds,
      syncStatus: result.syncStatus || result.status,
      nodeCount: result.ready && result.subscription ? countOverseaNodes(result.subscription.yaml) : 0,
      ensuredAt: result.generatedAt || new Date().toISOString()
    };
    if (!result.ready || !result.subscription) {
      await deactivateOverseaTunnel();
      if (!isCurrentOverseaSession(context)) return;
      clearOverseaManagedSubscriptions(`ensure-${result.status}`);
      pushEvent(`oversea ensure ${result.status}`);
      await setOverseaForSession(context, {
        ...common,
        status: result.status === 'pending-runtime-sync' ? 'pending-sync' : 'error',
        message: result.reason
      });
      return;
    }

    const tunnel = requireOverseaTunnel();
    const subscriptionUrl = joinApiUrl(state.config.baseUrl, result.subscription.path);
    await tunnel.manager.applyManagedConfig({
      subscription: {
        name: OVERSEA_SUBSCRIPTION_NAME,
        url: subscriptionUrl
      },
      subscriptionContent: result.subscription.yaml,
      mode: state.oversea.mode,
      autoStart: false,
      rules: { allowlist: OVERSEA_ALLOWLIST },
      source: 'luopan-oversea'
    });
    if (!isCurrentOverseaSession(context)) return;
    overseaReadyContext = { generation: context.generation, userId: context.userId };
    pushEvent(`oversea subscription ready ${result.siteIds.join(',') || 'default'}`);
    if (!await setOverseaForSession(context, {
      ...common,
      status: tunnel.status().running ? 'running' : 'ready',
      message: result.reason
    })) return;
    if (requireRuntime().oversea.autoConnect || flight.startWhenReady) {
      await startOverseaRuntime(`auto:${reason}`);
    }
  } catch (error) {
    if (flight.controller.signal.aborted || !isCurrentOverseaSession(context)) return;
    const message = errorMessage(error);
    await deactivateOverseaTunnel().catch(() => undefined);
    if (!isCurrentOverseaSession(context)) return;
    clearOverseaManagedSubscriptions('ensure-error');
    pushEvent(`oversea ensure failed ${message}`);
    await setOverseaForSession(context, { status: 'error', message });
  }
}

async function startOverseaRuntime(reason: string): Promise<boolean> {
  const state = requireRuntime();
  let context = captureOverseaSessionContext();
  if (!context) {
    await setOversea({ status: 'waiting-login', message: '请先登录 User Center 再启动 Oversea。' });
    return false;
  }
  if (state.connection.status !== 'network-ready') {
    await setOversea({ status: 'waiting-internal', message: '请先连接 Internal 再启动 Oversea。' });
    return false;
  }
  const tunnel = requireOverseaTunnel();
  if (!hasReadyOverseaSubscription(context)) {
    await reconcileOversea(`start:${reason}`, true);
    context = captureOverseaSessionContext();
    if (!context || !hasReadyOverseaSubscription(context)) return false;
    if (tunnel.status().running) return true;
  }
  if (tunnel.status().running) {
    await tunnel.applyProxy();
    if (!isCurrentOverseaSession(context)) {
      await deactivateOverseaTunnel();
      return false;
    }
    const decision = await resolveOverseaProxyDecision();
    await setOverseaForSession(context, { status: 'running', lastProxyDecision: decision, message: `Oversea 应用代理已连接（${decision}）。` });
    return true;
  }

  pushEvent(`oversea start ${reason}`);
  if (!await setOverseaForSession(context, { status: 'starting', message: '正在启动 mihomo 并等待本地 mixed 代理就绪。' })) return false;
  try {
    await tunnel.manager.start();
    await waitForOverseaProxy(tunnel.status().ports.mixed);
    if (!isCurrentOverseaSession(context)) {
      await deactivateOverseaTunnel();
      return false;
    }
    await tunnel.applyProxy();
    const decision = await resolveOverseaProxyDecision();
    pushEvent(`oversea running :${tunnel.status().ports.mixed}`);
    await setOverseaForSession(context, {
      status: 'running',
      startedAt: new Date().toISOString(),
      lastProxyDecision: decision,
      message: `Oversea 应用代理已自动连接（${decision}）。`
    });
    return true;
  } catch (error) {
    await tunnel.manager.stop().catch(() => undefined);
    await overseaSession?.setProxy({ mode: 'direct' }).catch(() => undefined);
    if (!isCurrentOverseaSession(context)) return false;
    const message = errorMessage(error);
    pushEvent(`oversea start failed ${message}`);
    await setOverseaForSession(context, { status: 'error', message });
    return false;
  }
}

async function stopOverseaRuntime(reason: string): Promise<void> {
  if (!overseaTunnel) return;
  await deactivateOverseaTunnel();
  await setOversea({
    status: 'stopped',
    ...(reason === 'manual' ? { autoConnect: false } : {}),
    lastProxyDecision: 'DIRECT',
    message: `Oversea 应用代理已停止（${reason}）。`
  });
  pushEvent(`oversea stopped ${reason}`);
}

async function setOverseaMode(mode: RuntimeOverseaMode): Promise<void> {
  if (mode !== 'app-global' && mode !== 'app-rule') throw new Error('Luopan only supports app-global or app-rule Oversea mode.');
  const tunnel = requireOverseaTunnel();
  const changed = tunnel.manager.setMode(mode);
  if (changed) await tunnel.manager.applyRuntimeConfigChange();
  await tunnel.applyProxy();
  const running = tunnel.status().running;
  if (running) await waitForOverseaProxy(tunnel.status().ports.mixed);
  const currentStatus = requireRuntime().oversea.status;
  await setOversea({
    mode,
    status: running ? 'running' : currentStatus,
    lastProxyDecision: running ? await resolveOverseaProxyDecision() : requireRuntime().oversea.lastProxyDecision,
    message: mode === 'app-global'
      ? '已切换为应用全局代理：外网测试窗口默认走 Oversea，Internal/本地控制面保持直连。'
      : '已切换为规则代理：仅 Google、YouTube、X/Twitter、Telegram 等允许域名走 Oversea。'
  });
  pushEvent(`oversea mode ${mode}`);
}

async function openOverseaTestWindow(rawUrl: unknown): Promise<void> {
  const url = normalizeOverseaTestUrl(rawUrl);
  const context = captureOverseaSessionContext();
  if (!context) throw new Error('请先通过 Internal 登录 User Center。');
  if (!requireOverseaTunnel().status().running) {
    const started = await startOverseaRuntime('test-window');
    if (!started) throw new Error(requireRuntime().oversea.message);
  }
  if (!isCurrentOverseaSession(context)) throw new Error('登录会话已变化，请重新打开测试窗口。');
  const decision = await resolveOverseaProxyDecision(url);
  if (!await setOverseaForSession(context, {
    lastTestUrl: url,
    lastTestAt: new Date().toISOString(),
    lastProxyDecision: decision,
    message: `测试窗口将使用 ${decision} 打开 ${new URL(url).hostname}。`
  })) throw new Error('登录会话已变化，请重新打开测试窗口。');
  await requireOverseaTunnel().openTestWindow(url);
  if (!isCurrentOverseaSession(context)) await clearOverseaBrowserSession();
}

async function resolveOverseaProxyDecision(url = 'https://www.google.com'): Promise<string> {
  if (!overseaSession) return 'DIRECT';
  try {
    return await overseaSession.resolveProxy(url);
  } catch {
    return 'unknown';
  }
}

async function waitForOverseaProxy(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not listening';
  while (Date.now() < deadline) {
    try {
      await tcpProbe('127.0.0.1', port);
      return;
    } catch (error) {
      lastError = errorMessage(error);
      await sleep(180);
    }
  }
  throw new Error(`mihomo mixed proxy 127.0.0.1:${port} did not become ready (${lastError}).`);
}

function normalizeOverseaTestUrl(value: unknown): string {
  const text = stringValue(value) || 'https://www.google.com';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    return parsed.toString();
  } catch {
    throw new Error('测试地址必须是有效的 HTTP 或 HTTPS URL。');
  }
}

function configuredOverseaSiteIds(): string[] {
  return uniqueStrings((environmentValue('LUOPAN_OVERSEA_SITE_IDS') || '').split(/[\s,;]+/));
}

function countOverseaNodes(yaml: string): number {
  return Math.max(0, (yaml.match(/^\s+type:\s*hysteria2\s*$/gim) || []).length);
}

function joinApiUrl(baseUrl: string, pathName: string): string {
  const base = new URL(`${normalizeBaseUrl(baseUrl)}/`);
  const resolved = new URL(pathName, base);
  if (resolved.origin !== base.origin) {
    throw new Error('Oversea subscription URL must stay on the configured Internal service origin.');
  }
  return resolved.toString();
}

function registerIpc(): void {
  ipcMain.handle('luopan:get-runtime', () => visibleRuntime());
  ipcMain.handle('luopan:save-config', (_event, input) => runSessionExclusive(async () => {
    const state = requireRuntime();
    const current = state.config;
    const previousBootstrapBaseUrl = activeBootstrapBaseUrl;
    const next = constrainRuntimeConfig(applyEnvironmentConfigOverrides(normalizeConfig(input, current)));
    const channelChanged = current.baseUrl !== next.baseUrl || current.sdkTestMode !== next.sdkTestMode;
    const bootstrapChanged = current.bootstrapUrls.join('\n') !== next.bootstrapUrls.join('\n');
    const endpointChanged = channelChanged || bootstrapChanged;
    let cleanupError: string | null = null;
    if (endpointChanged) {
      try {
        await invalidateOverseaIdentitySession('config-endpoint-changed');
      } catch (error) {
        cleanupError = errorMessage(error);
      }
      activeAccessToken = null;
      credentialVault.accessToken = null;
      state.identity = emptyIdentity();
      state.events = [];
    }
    if (endpointChanged && (
      state.connection.status !== 'idle'
      || activeSession
      || hasReleasableLeaseCredentials(state)
      || legacyCredentialCleanupRequired
    )) {
      try {
        // Release the old server lease through the old bootstrap/config
        // entrance before switching channels. Otherwise a base-url change
        // could send the authenticated release to the new environment and
        // leave the old lease active.
        const disconnected = await disconnectLuopanDataPlane('config-change', {
          requireServerRelease: true
        });
        if (!disconnected) {
          cleanupError = [
            cleanupError,
            state.connection.message || '旧连接尚未完成本地停止、服务端 lease 释放和安全持久化。'
          ].filter(Boolean).join('; ');
        }
      } catch (error) {
        cleanupError = [cleanupError, errorMessage(error)].filter(Boolean).join('; ');
      }
    }
    if (endpointChanged && cleanupError) {
      state.oversea = {
        ...state.oversea,
        status: 'error',
        message: `连接配置未应用；旧入口仍保留，以便重试 lease 清理：${cleanupError}`
      };
      pushEvent(`runtime config rejected ${cleanupError}`);
      await saveRuntime().catch((error) => {
        pushEvent(`runtime config rejection persist failed ${errorMessage(error)}`);
      });
      broadcastRuntime();
      return visibleRuntime();
    }
    state.config = next;
    if (endpointChanged) {
      activeBootstrapBaseUrl = null;
      // Capabilities are scoped to the old endpoint. Successful strict
      // cleanup removed real leases; discard any remaining pending token so
      // it can never be sent to the newly configured origin.
      credentialVault.leaseCredentials = {};
      state.oversea = {
        ...emptyOversea(),
        autoConnect: state.oversea.autoConnect,
        mode: state.oversea.mode,
        message: cleanupError
          ? `连接配置已变更并清除登录态；本地清理有异常：${cleanupError}`
          : '连接配置已变更；请重新匿名 Connect Internal，再通过隧道内 VIP 登录。'
      };
    }
    try {
      await saveRuntime();
      pushEvent('runtime config saved');
    } catch (error) {
      state.config = current;
      activeBootstrapBaseUrl = previousBootstrapBaseUrl;
      state.oversea = {
        ...state.oversea,
        status: 'error',
        message: `连接配置未应用，旧入口已恢复：${errorMessage(error)}`
      };
      pushEvent(`runtime config persist failed ${errorMessage(error)}`);
      await saveRuntime().catch(() => undefined);
    }
    broadcastRuntime();
    return visibleRuntime();
  }));
  // User Center: password login via SDK gateway -> identityKind 'user'. The
  // next connect (or reconnect) picks up the login lease range automatically.
  ipcMain.handle('luopan:login', (_event, input) => runSessionExclusive(async () => {
    const state = requireRuntime();
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const account = stringValue(record.account);
    const password = typeof record.password === 'string' ? record.password : '';
    if (!account || !password) {
      pushEvent('login rejected: missing account or password');
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    if (state.connection.status !== 'network-ready') {
      pushEvent('login rejected: Internal data plane is not ready');
      state.connection.message = '安全限制：请先匿名 Connect Internal，再通过隧道内 VIP 登录 User Center。';
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    try {
      await assertLuopanSecureLoginChannel();
    } catch (error) {
      state.connection = {
        ...state.connection,
        status: 'data-plane-pending',
        message: errorMessage(error),
        updatedAt: new Date().toISOString()
      };
      pushEvent(`login channel rejected ${errorMessage(error)}`);
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    let auth: Awaited<ReturnType<typeof authenticateLuopanUser>>;
    try {
      ensureCredentialStorageReady();
      auth = await authenticateLuopanUser(account, password);
    } catch (error) {
      pushEvent(`login failed ${errorMessage(error)}`);
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    try {
      await invalidateOverseaIdentitySession('login-rotation');
      activeAccessToken = auth.accessToken;
      credentialVault.accessToken = auth.accessToken;
      state.identity = {
        kind: 'user',
        userId: auth.userId,
        displayName: auth.displayName || account,
        account,
        scopes: auth.scopes,
        tokenExpiresAt: auth.expiresAt,
        loginAt: new Date().toISOString()
      };
      state.oversea = {
        ...emptyOversea(),
        autoConnect: state.oversea.autoConnect,
        mode: state.oversea.mode,
        status: 'ensuring',
        userId: auth.userId,
        message: '登录成功；正在通过 Internal 确保当前用户的 Oversea 订阅。'
      };
      state.events = [];
      pushEvent(`user login ${auth.userId}`);
    } catch (error) {
      activeAccessToken = null;
      credentialVault.accessToken = null;
      state.identity = emptyIdentity();
      state.oversea = {
        ...emptyOversea(),
        autoConnect: state.oversea.autoConnect,
        mode: state.oversea.mode,
        message: `登录会话切换失败，已保持匿名安全状态：${errorMessage(error)}`
      };
      await deactivateOverseaTunnel().catch(() => undefined);
      try {
        clearOverseaManagedSubscriptions('login-rotation-failed');
      } catch {
        // The failure is already surfaced in the runtime event below.
      }
      pushEvent(`login session rotation failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    if (activeAccessToken) {
      reconcileOverseaInBackground('login');
    }
    return visibleRuntime();
  }));
  ipcMain.handle('luopan:change-password', (_event, input) => runSessionExclusive(async () => {
    const state = requireRuntime();
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const currentPassword = typeof record.currentPassword === 'string' ? record.currentPassword : '';
    const newPassword = typeof record.newPassword === 'string' ? record.newPassword : '';
    if (!currentPassword || !newPassword) {
      pushEvent('password change rejected: current and new passwords are required');
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    if (!hasActiveUserIdentity(state) || !activeAccessToken || !state.identity.userId) {
      pushEvent('password change rejected: User Center login is required');
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    if (state.connection.status !== 'network-ready') {
      pushEvent('password change rejected: Internal data plane is not ready');
      state.connection.message = '请先连接 Internal；改密只允许通过隧道内 VIP 发送。';
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    try {
      await assertLuopanSecureLoginChannel();
      await requestLuopanOwnPasswordChange(activeAccessToken, currentPassword, newPassword);
    } catch (error) {
      pushEvent(`password change failed ${errorMessage(error)}`);
      await saveRuntime();
      broadcastRuntime();
      return visibleRuntime();
    }
    let cleanupError: string | null = null;
    try {
      await invalidateOverseaIdentitySession('password-change');
    } catch (error) {
      cleanupError = errorMessage(error);
    }
    const mutableState: RuntimeState = state;
    activeAccessToken = null;
    credentialVault.accessToken = null;
    mutableState.identity = emptyIdentity();
    mutableState.events = [];
    await disconnectLuopanDataPlane('password-change');
    mutableState.oversea = {
      ...emptyOversea(),
      autoConnect: mutableState.oversea.autoConnect,
      mode: mutableState.oversea.mode,
      lastProxyDecision: 'DIRECT',
      message: cleanupError
        ? `密码已更新并退出登录；部分本地清理失败，请退出罗盘后重试：${cleanupError}`
        : '密码已更新；旧 token 已撤销，请使用新密码重新登录 User Center。'
    };
    if (cleanupError) pushEvent(`password change cleanup failed ${cleanupError}`);
    pushEvent('user password changed; local session cleared');
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  }));
  ipcMain.handle('luopan:logout', () => runSessionExclusive(async () => {
    const state = requireRuntime();
    let cleanupError: string | null = null;
    try {
      await invalidateOverseaIdentitySession('logout');
    } catch (error) {
      cleanupError = errorMessage(error);
    }
    activeAccessToken = null;
    credentialVault.accessToken = null;
    state.identity = emptyIdentity();
    state.events = [];
    await disconnectLuopanDataPlane('logout');
    state.oversea = {
      ...emptyOversea(),
      autoConnect: state.oversea.autoConnect,
      mode: state.oversea.mode,
      lastProxyDecision: 'DIRECT',
      message: cleanupError
        ? `已退出登录并清除身份；部分本地清理失败，请退出罗盘后重试：${cleanupError}`
        : '已退出登录；Oversea 代理、订阅密钥与测试站点会话均已清除。'
    };
    if (cleanupError) pushEvent(`logout cleanup failed ${cleanupError}`);
    pushEvent('user logged out');
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  }));
  ipcMain.handle('luopan:connect-test-mode', () => runSessionExclusive(async () => {
    await requestLuopanLease();
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  }));
  ipcMain.handle('luopan:apply-data-plane', () => runSessionExclusive(async () => {
    const ready = await applyLuopanDataPlane();
    if (ready) reconcileOverseaInBackground('data-plane-ready');
    return visibleRuntime();
  }));
  // One-click "connect into Internal": registered lease -> WG data plane ->
  // in-tunnel service VIP reachability. Same building blocks as the two-step
  // buttons; success means the product path to Internal is proven end to end.
  ipcMain.handle('luopan:connect-internal', () => runSessionExclusive(async () => {
    const leased = await requestLuopanLease();
    if (leased) {
      const ready = await applyLuopanDataPlane();
      pushEvent(ready ? 'connect internal complete' : 'connect internal pending data plane');
      if (ready) reconcileOverseaInBackground('connect-internal');
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  }));
  ipcMain.handle('luopan:disconnect-data-plane', () => runSessionExclusive(async () => {
    await disconnectLuopanDataPlane('manual');
    return visibleRuntime();
  }));
  ipcMain.handle('luopan:refresh-snapshot', () => runSessionExclusive(async () => {
    try {
      const state = requireRuntime();
      const leaseCredential = leaseCredentialForLeaseId(
        stringValue(activeSession?.lease.leaseId) || state.connection.leaseId
      );
      if (!leaseCredential?.leaseId) {
        throw new Error('No active Luopan lease capability is available for snapshot refresh.');
      }
      if (leaseCredential.identityKind === 'user' && !hasActiveUserIdentity(state)) {
        throw new Error('The user lease token expired; log in again before refreshing its snapshot.');
      }
      const snapshot = await launcherClient().createSnapshot({
        leaseId: leaseCredential.leaseId,
        leaseCapability: leaseCredential.capability,
        accessToken: leaseCredential.identityKind === 'user' ? activeAccessToken : undefined,
        installId: state.installId,
        deviceId: state.deviceId,
        userId: leaseCredential.userId,
        leaseProfile: leaseCredential.leaseProfile,
        publicKey: leaseCredential.publicKey,
        requestId: `luopan-snapshot-${Date.now()}`
      });
      const routePlan = routePlanFromSnapshot(snapshot);
      const dataPlane = diagnoseElectronLauncherStandaloneDataPlane({
        routePlan,
        leaseIp: state.connection.leaseIp || routePlan.leaseIp,
        serviceVip: snapshot.topology.product.serviceVip,
        dnsServer: snapshot.topology.relayPlan.routes.dnsServer
      });
      await setConnection({
        status: runtimeStatusForDataPlane(dataPlane),
        leaseIp: state.connection.leaseIp || routePlan.leaseIp,
        serviceVip: snapshot.topology.product.serviceVip,
        dnsServer: snapshot.topology.relayPlan.routes.dnsServer,
        routeCidrs: snapshot.topology.relayPlan.routes.internalCidrs,
        snapshotDigest: snapshot.signatures.digest,
        dataPlane,
        message: `Snapshot refreshed. ${dataPlane.message}`
      });
      pushEvent('snapshot refreshed');
      if (dataPlane.ok) reconcileOverseaInBackground('snapshot-ready');
    } catch (error) {
      await setConnection({
        status: 'error',
        message: errorMessage(error)
      });
      pushEvent(`snapshot failed ${errorMessage(error)}`);
    }
    return visibleRuntime();
  }));
  ipcMain.handle('luopan:reset-session', () => runSessionExclusive(async () => {
    const state = requireRuntime();
    const stopped = await disconnectLuopanDataPlane('reset');
    if (!stopped) {
      pushEvent('local runtime session reset blocked by data-plane cleanup');
      return visibleRuntime();
    }
    state.connection = emptyConnection();
    state.oversea = {
      ...state.oversea,
      status: hasActiveUserIdentity(state) ? 'waiting-internal' : 'waiting-login',
      lastProxyDecision: 'DIRECT',
      message: hasActiveUserIdentity(state)
        ? '本地连接状态已重置；重新连接 Internal 后会重新校验 Oversea。'
        : '本地连接状态已重置；请先连接 Internal，再登录 User Center。'
    };
    pushEvent('local runtime session reset');
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  }));
  ipcMain.handle('luopan:refresh-oversea-subscription', async () => {
    await reconcileOversea('manual-refresh');
    return visibleRuntime();
  });
  ipcMain.handle('luopan:start-oversea', async () => {
    await startOverseaRuntime('manual');
    return visibleRuntime();
  });
  ipcMain.handle('luopan:stop-oversea', async () => {
    await stopOverseaRuntime('manual');
    return visibleRuntime();
  });
  ipcMain.handle('luopan:set-oversea-mode', async (_event, mode) => {
    await setOverseaMode(mode === 'app-rule' ? 'app-rule' : 'app-global');
    return visibleRuntime();
  });
  ipcMain.handle('luopan:set-oversea-auto-connect', async (_event, enabled) => {
    const autoConnect = enabled === true;
    await setOversea({ autoConnect, message: autoConnect
      ? '自动连接已开启；登录且 Internal 就绪后会自动确保订阅并启动代理。'
      : '自动连接已关闭；订阅仍可手动刷新和启动。' });
    if (autoConnect) reconcileOverseaInBackground('auto-connect-enabled');
    return visibleRuntime();
  });
  ipcMain.handle('luopan:open-oversea-test-window', async (_event, input) => {
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    await openOverseaTestWindow(record.url);
    return visibleRuntime();
  });
  ipcMain.handle('luopan:check-updates', async () => {
    const state = requireRuntime();
    state.update = { ...state.update, status: 'checking', message: 'Checking Release Center decision.' };
    broadcastRuntime();
    try {
      if (state.connection.status !== 'network-ready') await ensureBootstrapResolved();
      // Launcher convention (same as mx-h2i): installer plans target
      // `<componentId>`, hot plans target `<componentId>-renderer`. Check
      // both namespaces and keep the strongest decision. userId is passed so
      // per-user targeted releases (docs/20 §5.8) match logged-in users.
      const updater = releaseUpdater();
      const userId = hasActiveUserIdentity(state) ? state.identity.userId : null;
      const checks: ElectronLauncherUpdateCheckResult[] = [];
      for (const componentId of [PRODUCT.release.componentId, `${PRODUCT.release.componentId}-renderer`]) {
        checks.push(await updater.check({
          componentId,
          currentVersion: app.getVersion(),
          channel: PRODUCT.release.channel,
          installId: state.installId,
          userId,
          platform: process.platform,
          arch: process.arch
        }));
      }
      const check = chooseUpdateCheck(checks);
      lastUpdateCheck = check;
      state.update = updateFromCheck(check);
      pushEvent(`update check ${check.status}`);
    } catch (error) {
      lastUpdateCheck = null;
      state.update = { ...emptyUpdate(), status: 'failed', message: errorMessage(error) };
      pushEvent(`update check failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:apply-update', async () => {
    const state = requireRuntime();
    if (!lastUpdateCheck || lastUpdateCheck.status !== 'update-available') {
      state.update = { ...state.update, message: 'No update-available decision in memory; run check first.' };
      broadcastRuntime();
      return visibleRuntime();
    }
    try {
      const result = await updateExecutor(releaseUpdater()).execute(lastUpdateCheck);
      state.update = {
        ...state.update,
        execution: executionSummary(result),
        message: result.executed
          ? `Executed release ${result.releaseId}: ${result.artifacts.length} artifact(s) processed.`
          : result.reason
      };
      pushEvent(`update executed ${result.releaseId ?? 'none'}`);
    } catch (error) {
      state.update = { ...state.update, status: 'failed', message: errorMessage(error) };
      pushEvent(`update execute failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:open-staged-installer', async () => {
    const state = requireRuntime();
    const artifact = lastUpdateCheck?.artifacts.find(
      (candidate) => classifyElectronLauncherUpdateArtifact(candidate.kind) === 'installer'
    );
    if (!artifact) {
      state.update = { ...state.update, message: 'No installer artifact in the last check.' };
      broadcastRuntime();
      return visibleRuntime();
    }
    try {
      const installerPath = await updateExecutor(releaseUpdater()).openStagedInstaller(artifact);
      state.update = { ...state.update, message: `Installer opened: ${path.basename(installerPath)}. Confirm the OS prompt to install.` };
      pushEvent('installer opened');
    } catch (error) {
      state.update = { ...state.update, message: errorMessage(error) };
      pushEvent(`installer open failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:rollback-update-slot', async (_event, slot) => {
    const state = requireRuntime();
    const normalizedSlot = slot === 'renderer' ? 'renderer' : 'config';
    try {
      const pointer = await updateExecutor(releaseUpdater()).rollback(normalizedSlot);
      state.update = {
        ...state.update,
        message: pointer
          ? `Rolled ${normalizedSlot} slot back to ${pointer.version}.`
          : `No previous ${normalizedSlot} slot to roll back to.`
      };
      pushEvent(pointer ? `update slot rolled back ${normalizedSlot} ${pointer.version}` : `rollback skipped ${normalizedSlot}`);
    } catch (error) {
      state.update = { ...state.update, message: errorMessage(error) };
      pushEvent(`rollback failed ${errorMessage(error)}`);
    }
    await saveRuntime();
    broadcastRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('luopan:open-admin', async () => {
    await shell.openExternal(`${requireRuntime().config.baseUrl}/admin/`);
  });
  ipcMain.handle('luopan:open-internal-entry', async () => {
    await shell.openExternal('http://luopan.mxinfo-inc.cn/');
  });
}

async function releaseLuopanServerLeases(
  sessionToRelease: LauncherNetworkSession | null
): Promise<ServerLeaseReleaseSummary> {
  const state = requireRuntime();
  const publicKey = credentialVault.wireGuardKeyPair?.publicKey;
  const candidates = new Map<string, {
    leaseId: string;
    capability: string;
    identityKind: 'anonymous' | 'user';
  }>();
  for (const credential of Object.values(credentialVault.leaseCredentials)) {
    if (
      !credential.leaseId
      || credential.productId !== state.config.productId
      || credential.installId !== state.installId
      || (publicKey && credential.publicKey !== publicKey)
    ) continue;
    candidates.set(credential.leaseId, {
      leaseId: credential.leaseId,
      capability: credential.capability,
      identityKind: credential.identityKind
    });
  }
  const sessionLeaseId = stringValue(sessionToRelease?.lease.leaseId);
  const sessionCapability = stringValue(sessionToRelease?.lease.capability);
  if (sessionLeaseId && sessionCapability) {
    candidates.set(sessionLeaseId, {
      leaseId: sessionLeaseId,
      capability: sessionCapability,
      identityKind: sessionToRelease?.lease.identityKind === 'user' ? 'user' : 'anonymous'
    });
  }
  if (candidates.size === 0) return { released: [], failed: [] };

  const resolution = await ensureBootstrapResolved(!activeBootstrapBaseUrl);
  if (resolution && !resolution.ok) {
    return {
      released: [],
      failed: [...candidates.keys()].map((leaseId) => ({ leaseId, message: resolution.message }))
    };
  }

  const results = await Promise.all([...candidates.values()].map(async (candidate) => {
    try {
      const payload = await postLauncherNetwork(
        `/leases/${encodeURIComponent(candidate.leaseId)}/release`,
        {
          requestedBy: 'luopan-quasar-demo',
          requestId: `luopan-release-${Date.now()}-${candidate.leaseId}`
        },
        candidate
      );
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const lease = record.lease && typeof record.lease === 'object'
        ? record.lease as Record<string, unknown>
        : {};
      if (stringValue(lease.status) !== 'released') {
        throw new Error('Internal did not confirm released status.');
      }
      forgetLeaseCredential(candidate.leaseId);
      return { ok: true as const, leaseId: candidate.leaseId };
    } catch (error) {
      return { ok: false as const, leaseId: candidate.leaseId, message: errorMessage(error) };
    }
  }));
  const released = results.filter((item) => item.ok).map((item) => item.leaseId);
  const failed = results
    .filter((item): item is Extract<typeof results[number], { ok: false }> => !item.ok)
    .map((item) => ({ leaseId: item.leaseId, message: item.message }));
  return { released, failed };
}

async function disconnectLuopanDataPlane(
  reason: 'manual' | 'logout' | 'password-change' | 'config-change' | 'reset' | 'shutdown',
  options: LuopanDisconnectOptions = {}
): Promise<boolean> {
  const state = requireRuntime();
  const legacyMigrationWasRequired = legacyCredentialCleanupRequired;
  const dataPlaneMode = currentLuopanDataPlaneMode();
  const sessionToStop = activeSession;
  const connectionToRestore = state.connection;
  pushEvent(`data-plane disconnect started ${reason}`);
  activeSession = null;
  state.connection = {
    ...state.connection,
    status: 'connecting',
    message: '正在断开 Internal，并先停止 Oversea 应用代理。',
    updatedAt: new Date().toISOString()
  };
  broadcastRuntime();
  await abortOverseaReconcile().catch((error) => {
    pushEvent(`oversea ensure abort failed ${errorMessage(error)}`);
  });
  await deactivateOverseaTunnel().catch((error) => {
    pushEvent(`oversea stop before Internal disconnect failed ${errorMessage(error)}`);
  });
  const overseaAfterDisconnect: Partial<RuntimeOversea> = {
    status: hasActiveUserIdentity(state) ? 'waiting-internal' : 'waiting-login',
    lastProxyDecision: 'DIRECT',
    message: hasActiveUserIdentity(state)
      ? 'Internal 已断开；重新连接后会重新校验订阅并恢复 Oversea。'
      : 'Internal 已断开；请先重新连接，再通过隧道内 VIP 登录 User Center。'
  };
  try {
    await setOversea(overseaAfterDisconnect);
  } catch (error) {
    // An unreadable safeStorage vault must stay untouched, but it must never
    // prevent local WireGuard/routes from being removed.
    state.oversea = { ...state.oversea, ...overseaAfterDisconnect };
    pushEvent(`runtime persist skipped before data-plane stop ${errorMessage(error)}`);
    broadcastRuntime();
  }
  let stopped = false;
  let serverReleaseComplete = true;
  let persistenceComplete = true;
  let releaseMessage: string | null = null;
  try {
    const result = dataPlaneMode === 'reuse'
      ? {
          ok: true,
          message: releaseLuopanReuseClaim(state.installId)
        }
      : await stopElectronLauncherStandaloneDataPlane({
          userDataDir: app.getPath('userData'),
          profileName: 'luopan.conf',
          routePlan: sessionToStop
            ? luopanStandaloneDataPlaneRoutePlan(sessionToStop.routePlan)
            : undefined,
          ownerId: `${PRODUCT.productId}:${state.installId}`,
          darwinLaunchDaemon: true,
          allowSystemFallback: false,
          darwinServiceIdentity: luopanWireGuardServiceIdentity()
        });
    stopped = result.ok;
    if (stopped) {
      activeDataPlaneMode = null;
      try {
        const release = await releaseLuopanServerLeases(sessionToStop);
        if (release.released.length > 0) {
          pushEvent(`server lease released ${release.released.join(',')}`);
        }
        if (release.failed.length > 0) {
          serverReleaseComplete = false;
          const failures = release.failed.map((item) => `${item.leaseId}: ${item.message}`).join('; ');
          releaseMessage = `本地网络已停止，但服务端 lease 暂未全部释放，将在后续操作重试：${failures}`;
          pushEvent(`server lease release pending ${failures}`);
        }
      } catch (error) {
        serverReleaseComplete = false;
        releaseMessage = `本地网络已停止，但服务端 lease 释放失败，将在后续操作重试：${errorMessage(error)}`;
        pushEvent(`server lease release pending ${errorMessage(error)}`);
      }
      completeLegacyCredentialMigration();
    } else {
      activeSession = sessionToStop;
    }
    state.connection = {
      ...(result.ok ? emptyConnection() : connectionToRestore),
      status: result.ok ? 'idle' : 'error',
      bootstrapBaseUrl: activeBootstrapBaseUrl,
      message: releaseMessage ? `${result.message} ${releaseMessage}` : result.message,
      updatedAt: new Date().toISOString()
    };
    pushEvent(result.ok ? 'data-plane stopped' : `data-plane stop failed ${result.message}`);
  } catch (error) {
    activeSession = sessionToStop;
    state.connection = {
      ...connectionToRestore,
      status: 'error',
      bootstrapBaseUrl: activeBootstrapBaseUrl,
      message: errorMessage(error),
      updatedAt: new Date().toISOString()
    };
    pushEvent(`data-plane stop failed ${errorMessage(error)}`);
  }
  try {
    await saveRuntime();
  } catch (error) {
    persistenceComplete = false;
    if (legacyMigrationWasRequired) legacyCredentialCleanupRequired = true;
    const message = `运行状态未能持久化，但本地网络清理结果保持不变：${errorMessage(error)}`;
    state.connection = {
      ...state.connection,
      message: [state.connection.message, message].filter(Boolean).join(' '),
      updatedAt: new Date().toISOString()
    };
    pushEvent(`runtime persist skipped after data-plane stop ${errorMessage(error)}`);
  }
  broadcastRuntime();
  return stopped
    && (!options.requireServerRelease || (serverReleaseComplete && persistenceComplete))
    && (!legacyMigrationWasRequired || persistenceComplete);
}

// Step 1 of connecting into Internal: enroll a lease against the registered
// ProductNetwork (identityKind anonymous -> anonymous lease range). In
// registered mode the server enforces the entitlement gate: ProductNetwork
// enabled + AppCenter app `luopan` enabled with launcher-network +
// launcher-standalone capabilities.
async function requestLuopanLease(): Promise<boolean> {
  if (legacyCredentialCleanupRequired) {
    const migrated = await disconnectLuopanDataPlane('reset');
    if (!migrated) {
      pushEvent('legacy launcher identity migration blocked by local cleanup or persistence failure');
      return false;
    }
  }
  const state = requireRuntime();
  const loggedIn = hasActiveUserIdentity(state);
  const identityKind = loggedIn ? 'user' as const : 'anonymous' as const;
  const userId = loggedIn ? state.identity.userId : null;
  await setConnection({
    status: 'connecting',
    message: state.config.sdkTestMode
      ? 'Requesting Launcher Network lease in SDK test mode.'
      : loggedIn
        ? `Requesting user-range Luopan lease for ${state.identity.userId}.`
        : 'Requesting registered Luopan Launcher Network lease.'
  });
  pushEvent('lease request started');
  try {
    // First hop must be bootstrap-reachable: re-probe candidates on every
    // connect attempt so a network change picks a working entrance.
    const resolution = await ensureBootstrapResolved(true);
    if (resolution && !resolution.ok) {
      throw new Error(resolution.message);
    }
    ensureCredentialStorageReady();
    const keyPair = ensureWireGuardKeyPair();
    const pendingCapability = ensurePendingLeaseCapability(identityKind, userId);
    // Persist the key and next capability before the request. A crash after
    // server enrollment can then safely retry/claim the same lease.
    await saveRuntime();
    const leaseCapability = leaseCapabilitiesForEnrollment(identityKind, userId);
    const session = await launcherClient().connectNetwork({
      // Logged-in users land in the user lease range, anonymous sessions in
      // the anonymous range (docs/20 §1.2). Same API, different identityKind.
      identityKind,
      leaseProfile: loggedIn ? 'employee' : 'anonymous',
      userId: userId ?? undefined,
      accessToken: loggedIn ? activeAccessToken : undefined,
      leaseCapability,
      newLeaseCapability: pendingCapability.capability,
      keyPair,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      platform: 'quasar-electron',
      sdkTestMode: state.config.sdkTestMode,
      requestedBy: 'luopan-quasar-demo',
      requestId: `luopan-${Date.now()}`
    });
    for (const handoverLease of session.lease.handoverLeases ?? []) {
      rememberLeaseCredential(handoverLease);
    }
    rememberLeaseCredential(session.lease, pendingCapability.credentialKey);
    await saveRuntime();
    activeSession = session;
    await applySession(session);
    pushEvent(`lease active ${session.lease.leaseIp}`);
    return true;
  } catch (error) {
    await setConnection({
      status: 'error',
      message: errorMessage(error)
    });
    pushEvent(`lease failed ${errorMessage(error)}`);
    return false;
  }
}

// Step 2: bring up the local WG data plane for the active lease and verify the
// product service VIP is reachable in-tunnel. Returns true only when the data
// plane is fully ready (routes installed + VIP healthz answered).
async function applyLuopanDataPlane(): Promise<boolean> {
  await setConnection({
    status: 'connecting',
    message: initialDataPlaneApplyMessage()
  });
  pushEvent('data-plane apply started');
  try {
    if (!activeSession) throw new Error('Request a Luopan lease before applying the local data plane.');
    const privateKey = stringValue(activeSession.wireGuard.privateKey);
    if (!privateKey) throw new Error('Luopan WireGuard private key is missing; request a fresh lease.');
    // A retained claim describes the data plane that is actually live. Do not
    // let a changed environment variable relabel an existing standalone owner
    // as reuse (or vice versa) before the old mode has been torn down.
    activeDataPlaneMode = currentLuopanDataPlaneMode();
    if (activeDataPlaneMode === 'reuse') {
      const attached = attachToSharedDataPlane(activeSession);
      if (attached) {
        await setConnection({
          status: runtimeStatusForDataPlane(attached.dataPlane),
          dataPlane: attached.dataPlane,
          message: attached.message
        });
        pushEvent(`data-plane attached ${attached.reason}`);
        return attached.dataPlane.ok;
      }
      const dataPlane = diagnoseSharedDataPlane(activeSession);
      await setConnection({
        status: runtimeStatusForDataPlane(dataPlane),
        dataPlane,
        message: dataPlane.message
      });
      pushEvent(`data-plane pending ${dataPlane.state}`);
      return dataPlane.ok;
    }
    await syncLeasePeers(activeSession);
    const dataPlaneRoutePlan = luopanStandaloneDataPlaneRoutePlan(activeSession.routePlan);
    const result = await applyElectronLauncherStandaloneDataPlane({
      userDataDir: app.getPath('userData'),
      profileName: 'luopan.conf',
      routePlan: dataPlaneRoutePlan,
      privateKey,
      // Luopan is intentionally route-only today. Do not advertise DNS
      // namespaces that this process neither installs nor serves.
      dnsDomains: [],
      suppressWireGuardDns: true,
      requiredProbeTargets: ['lease-ip', 'service-vip'],
      ownerId: `${PRODUCT.productId}:${requireRuntime().installId}`,
      productId: PRODUCT.productId,
      instanceId: requireRuntime().installId,
      displayName: PRODUCT.displayName,
      metadata: {
        dataPlaneMode: 'standalone-wireguard',
        dataPlaneOwner: true
      },
      routeCidrs: luopanOwnershipRouteCidrs(dataPlaneRoutePlan),
      failOnOwnershipConflicts: true,
      allowSystemFallback: false,
      darwinLaunchDaemon: true,
      fallbackToAppManaged: false,
      darwinServiceIdentity: luopanWireGuardServiceIdentity()
    });
    const dataPlane = withServiceVipReachability(result.diagnostics, activeSession, 'standalone-wireguard');
    await setConnection({
      status: runtimeStatusForDataPlane(dataPlane),
      dataPlane,
      message: dataPlane.ok ? result.message : dataPlane.message
    });
    pushEvent(result.ok && dataPlane.ok ? 'data-plane ready' : `data-plane pending ${dataPlane.state}`);
    return result.ok && dataPlane.ok;
  } catch (error) {
    await setConnection({
      status: 'error',
      message: errorMessage(error)
    });
    pushEvent(`data-plane failed ${errorMessage(error)}`);
    return false;
  }
}

async function applySession(session: LauncherNetworkSession): Promise<void> {
  const dataPlane = diagnoseElectronLauncherStandaloneDataPlane({
    routePlan: session.routePlan,
    leaseIp: session.lease.leaseIp,
    serviceVip: session.lease.serviceVip,
    dnsServer: session.routePlan.dnsServer
  });
  await setConnection({
    status: runtimeStatusForDataPlane(dataPlane),
    leaseId: session.lease.leaseId,
    leaseIp: session.lease.leaseIp,
    serviceVip: session.lease.serviceVip,
    dnsServer: session.routePlan.dnsServer,
    routeCidrs: session.routePlan.routeCidrs,
    snapshotDigest: session.snapshot.signatures.digest,
    dataPlane,
    message: session.lease.productId === PRODUCT.productId
      ? dataPlane.message
      : `Lease is active on ${session.lease.productId}. ${dataPlane.message}`
  });
}

function diagnoseSharedDataPlane(session: LauncherNetworkSession): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const routeProof = sharedDataPlaneRouteProof(session);
  if (!sharedCoreRoutesReady(routeProof)) {
    return {
      ...routeProof,
      ok: false,
      state: routeProof.state === 'proxy-tun-captured' ? routeProof.state : 'data-plane-pending',
      severity: routeProof.severity === 'error' ? routeProof.severity : 'warning',
      message: `No shared launcher data plane is ready for Luopan reuse. ${routeProof.message} Unset LUOPAN_DATA_PLANE_MODE or set it to standalone when Luopan should own its data plane.`
    };
  }
  const dataPlaneOwner = sharedFoundationOwnerClaim();
  if (!dataPlaneOwner) {
    return {
      ...routeProof,
      ok: false,
      state: 'data-plane-pending',
      severity: 'warning',
      message: 'Shared foundation routes are present, but no product-neutral launcher-foundation owner claim is registered. Start the launcher foundation plane or use standalone product routes.'
    };
  }
  const gatewayReachability = probeIcmpReachability(session.routePlan.domesticGatewayIp);
  if (!gatewayReachability.ok) {
    return {
      ...routeProof,
      ok: false,
      state: 'data-plane-pending',
      severity: 'warning',
      message: `Shared launcher routes are present, but Domestic gateway ${session.routePlan.domesticGatewayIp} is not reachable (${gatewayReachability.message}). Keep the current data-plane owner connected before Luopan reuses it.`
    };
  }
  return withServiceVipReachability(routeProof, session, 'shared-reuse');
}

function attachToSharedDataPlane(session: LauncherNetworkSession): {
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics;
  message: string;
  reason: string;
} | null {
  const routeProof = sharedDataPlaneRouteProof(session);
  if (!sharedCoreRoutesReady(routeProof)) return null;
  const gatewayReachability = probeIcmpReachability(session.routePlan.domesticGatewayIp);
  if (!gatewayReachability.ok) return null;

  const dataPlaneOwner = sharedFoundationOwnerClaim();
  if (!dataPlaneOwner) return null;
  const dataPlane = withServiceVipReachability(routeProof, session, 'shared-reuse');
  const claim = {
    ...buildElectronLauncherStandaloneOwnershipClaim(session.routePlan, {
      ownerId: `${PRODUCT.productId}:${requireRuntime().installId}`,
      productId: PRODUCT.productId,
      instanceId: requireRuntime().installId,
      displayName: PRODUCT.displayName,
      routeCidrs: luopanOwnershipRouteCidrs(session.routePlan),
      priority: 90
    }),
    state: dataPlane.ok ? 'active' as const : 'connecting' as const,
    metadata: {
      dataPlaneMode: 'shared-reuse',
      dataPlaneOwnerId: dataPlaneOwner?.ownerId ?? null,
      serviceVip: session.routePlan.serviceVip,
      dnsServer: session.routePlan.dnsServer
    }
  };
  upsertElectronLauncherStandaloneOwnershipClaim(claim);
  const reason = dataPlaneOwner?.ownerId ? `owner:${dataPlaneOwner.ownerId}` : 'route-proof';
  return {
    dataPlane,
    reason,
    message: `Attached to existing shared launcher data plane (${reason}). ${dataPlane.message}`
  };
}

function luopanStandaloneDataPlaneRoutePlan(routePlan: LauncherNetworkSession['routePlan']): LauncherNetworkSession['routePlan'] {
  const routeCidrs = luopanOwnershipRouteCidrs(routePlan);
  return {
    ...routePlan,
    routeCidrs,
    allowedIps: routeCidrs,
    h2iDirectAllowedIps: routeCidrs
  };
}

function luopanOwnershipRouteCidrs(routePlan: LauncherNetworkSession['routePlan']): string[] {
  return uniqueStrings([
    routePlan.leaseCidr,
    routePlan.serviceVip ? `${routePlan.serviceVip}/32` : ''
  ].filter((value): value is string => Boolean(value)));
}

function currentLuopanDataPlaneMode(): LuopanDataPlaneMode {
  if (activeDataPlaneMode) return activeDataPlaneMode;
  const ownerId = runtime ? `${PRODUCT.productId}:${runtime.installId}` : null;
  if (ownerId) {
    const ownClaim = readElectronLauncherStandaloneOwnershipState().claims.find(
      (claim) => claim.ownerId === ownerId
    );
    if (ownClaim?.metadata?.dataPlaneMode === 'standalone-wireguard') return 'standalone';
    if (ownClaim?.metadata?.dataPlaneMode === 'shared-reuse') return 'reuse';
  }
  return luopanDataPlaneMode();
}

function releaseLuopanReuseClaim(installId: string): string {
  releaseElectronLauncherStandaloneOwnershipClaim(`${PRODUCT.productId}:${installId}`);
  return 'Luopan detached from the shared launcher data plane; the shared owner was left running.';
}

function sharedDataPlaneRouteProof(session: LauncherNetworkSession): ElectronLauncherStandaloneDataPlaneDiagnostics {
  return diagnoseElectronLauncherStandaloneDataPlane({
    routePlan: session.routePlan,
    leaseIp: session.lease.leaseIp,
    serviceVip: session.lease.serviceVip,
    dnsServer: session.routePlan.dnsServer,
    wireGuardActive: true
  });
}

function sharedCoreRoutesReady(dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics): boolean {
  const targets = new Set(['internal-control', 'domestic-gateway', 'dns-server']);
  const probes = dataPlane.probes.filter((probe) => targets.has(probe.target));
  return probes.length > 0 && probes.every((probe) => probe.ok && !probe.viaProxyTun);
}

function sharedFoundationOwnerClaim(): { ownerId?: string | null; productId?: string | null; state?: string | null; metadata?: Record<string, unknown> | null } | null {
  const state = readElectronLauncherStandaloneOwnershipState();
  return state.claims.find(isSharedDataPlaneOwner) ?? null;
}

function isSharedDataPlaneOwner(claim: { ownerId?: string | null; productId?: string | null; state?: string | null; dnsZones?: string[] | null; routeCidrs?: string[] | null; metadata?: Record<string, unknown> | null }): boolean {
  if (!claim.ownerId || claim.state === 'released') return false;
  const dataPlaneMode = claim.metadata?.dataPlaneMode;
  return dataPlaneMode === 'launcher-foundation'
    || dataPlaneMode === 'shared-foundation'
    || claim.metadata?.foundationOwner === true;
}

function withServiceVipReachability(
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics,
  session: LauncherNetworkSession,
  mode: 'shared-reuse' | 'standalone-wireguard'
): ElectronLauncherStandaloneDataPlaneDiagnostics {
  const serviceVip = stringValue(session.lease.serviceVip) || stringValue(session.routePlan.serviceVip);
  const serviceRoute = dataPlane.probes.find((probe) => probe.target === 'service-vip');
  if (!serviceVip || serviceRoute?.ok !== true || !dataPlane.ok) return dataPlane;
  const prefix = mode === 'shared-reuse'
    ? 'Shared launcher routes are present'
    : 'Standalone WireGuard routes are present';
  const serviceHealth = probeServiceVipHealth(session, serviceVip);
  if (!serviceHealth.ok) {
    return {
      ...dataPlane,
      ok: false,
      state: 'service-unreachable',
      severity: 'warning',
      message: `${prefix}; Luopan service VIP ${serviceVip} is routed through ${serviceRoute.interfaceName || 'WireGuard'}, but ${serviceHealth.url} is not reachable (${serviceHealth.message}). Apply Domestic relay/Internal service-peer materialization before treating this channel as network-ready.`
    };
  }
  return {
    ...dataPlane,
    message: `${prefix}; Luopan service VIP ${serviceVip} is routed through ${serviceRoute.interfaceName || 'WireGuard'} and ${serviceHealth.url} is reachable.`
  };
}

function probeServiceVipHealth(session: LauncherNetworkSession, serviceVip: string): { ok: boolean; url: string; message: string } {
  const url = serviceVipHealthUrl(session, serviceVip);
  try {
    execFileSync('curl', ['-fsS', '--max-time', '2', url], { stdio: 'pipe', timeout: 3000 });
    return { ok: true, url, message: 'healthz ok' };
  } catch (error) {
    return { ok: false, url, message: errorMessage(error) };
  }
}

function serviceVipHealthUrl(session: LauncherNetworkSession, serviceVip: string): string {
  try {
    const parsed = new URL(stringValue(session.routePlan.internalBaseUrl) || `http://${serviceVip}:18090`);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '18090');
    return `${parsed.protocol}//${serviceVip}${port ? `:${port}` : ''}/healthz`;
  } catch {
    return `http://${serviceVip}:18090/healthz`;
  }
}

function probeIcmpReachability(host: string): { ok: boolean; message: string } {
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', '1000', host]
    : process.platform === 'darwin'
      ? ['-c', '1', '-W', '1000', host]
      : ['-c', '1', '-W', '1', host];
  try {
    execFileSync('ping', args, { stdio: 'pipe', timeout: 2500 });
    return { ok: true, message: 'icmp-ok' };
  } catch (error) {
    return { ok: false, message: errorMessage(error) || 'icmp-timeout' };
  }
}

async function syncLeasePeers(session: LauncherNetworkSession): Promise<void> {
  const leaseId = stringValue(session.lease.leaseId);
  if (!leaseId) throw new Error('Launcher leaseId is missing; cannot sync Domestic peer.');
  await postLauncherNetwork(`/leases/${encodeURIComponent(leaseId)}/domestic-peer/sync`, {
    requestedBy: 'luopan-quasar-demo',
    requestId: `luopan-domestic-peer-${Date.now()}`
  }, session.lease);
  try {
    await postLauncherNetwork(`/leases/${encodeURIComponent(leaseId)}/internal-direct-peer/sync`, {
      requestedBy: 'luopan-quasar-demo',
      requestId: `luopan-internal-direct-peer-${Date.now()}`
    }, session.lease);
  } catch (error) {
    pushEvent(`internal direct sync skipped ${errorMessage(error)}`);
  }
}

async function postLauncherNetwork(
  pathname: string,
  body: Record<string, unknown>,
  lease?: Pick<LauncherNetworkSession['lease'], 'leaseId' | 'capability' | 'identityKind'>
): Promise<unknown> {
  // Called during data-plane bring-up (pre-tunnel): must use the bootstrap URL.
  const leaseCredential = leaseCredentialForLeaseId(stringValue(lease?.leaseId));
  const capability = stringValue(lease?.capability) || leaseCredential?.capability || null;
  const accessToken = lease?.identityKind === 'user' ? activeAccessToken : null;
  const response = await fetch(`${effectiveApiBaseUrl()}/internal/v1/launcher-network${pathname}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'Content-Type': 'application/json',
      ...(capability ? { 'x-mx-lease-capability': capability } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message?: unknown }).message)
      : text || response.statusText;
    throw new Error(`Launcher network request failed: ${response.status} ${message}`);
  }
  return payload;
}

async function assertLuopanSecureLoginChannel(): Promise<void> {
  const state = requireRuntime();
  const serviceVip = stringValue(state.connection.serviceVip);
  if (!serviceVip) throw new Error('安全登录通道缺少已验证的 Internal service VIP，请重新 Connect Internal。');
  const base = new URL(state.config.baseUrl);
  if (base.hostname !== serviceVip) {
    throw new Error(`安全登录通道拒绝非当前 service VIP 的地址：${base.hostname}（期望 ${serviceVip}）。`);
  }
  try {
    const response = await fetch(new URL('/healthz', base), {
      method: 'GET',
      signal: AbortSignal.timeout(4_000),
      cache: 'no-store'
    });
    await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`安全登录通道尚未就绪：${errorMessage(error)}。请重新 Connect Internal。`);
  }
}

// User Center login via the SDK gateway OAuth password grant (docs/15).
// This is intentionally called only after Internal is network-ready, so the
// password is sent to the in-tunnel product VIP rather than a public
// bootstrap endpoint. The returned principal.userId is the key for the
// login-range lease and Release Center user targeting.
interface LuopanUserAuthentication {
  userId: string;
  displayName: string | null;
  scopes: string[];
  accessToken: string;
  expiresAt: string | null;
}

class UserCenterLoginError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string
  ) {
    super(`User Center login failed: ${status} ${serverMessage}`);
    this.name = 'UserCenterLoginError';
  }
}

async function requestLuopanUserToken(account: string, password: string): Promise<LuopanUserAuthentication> {
  const response = await fetch(`${effectiveApiBaseUrl()}/internal/v1/sdk/oauth/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username: account,
      password,
      audience: 'mx-sdk',
      scope: 'auth.read network.hdi.status oversea.subscription.ensure',
      requestId: `luopan-oauth-${Date.now()}`
    })
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : null;
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (!response.ok) {
    const message = stringValue(record.message) || text || response.statusText;
    throw new UserCenterLoginError(response.status, message);
  }
  const token = (record.token && typeof record.token === 'object' ? record.token : record) as Record<string, unknown>;
  const principal = token.principal && typeof token.principal === 'object' ? token.principal as Record<string, unknown> : {};
  const subject = stringValue(token.subject);
  const userId = stringValue(principal.userId)
    || (subject?.startsWith('user:') ? stringValue(subject.slice('user:'.length)) : null);
  if (!userId) throw new Error('User Center login did not return a user principal.');
  const accessToken = stringValue(token.access_token);
  if (!accessToken) throw new Error('User Center login did not return an access token.');
  const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [];
  if (!scopes.includes('oversea.subscription.ensure')) {
    throw new Error('User Center login token is missing oversea.subscription.ensure scope.');
  }
  return {
    userId,
    displayName: stringValue(principal.displayName),
    scopes,
    accessToken,
    expiresAt: stringValue(token.expires_at)
  };
}

async function requestLuopanOwnPasswordChange(
  accessToken: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const response = await fetch(`${effectiveApiBaseUrl()}/internal/v1/sdk/users/me/password`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      currentPassword,
      newPassword,
      requestId: `luopan-password-change-${Date.now()}`
    })
  });
  const text = await response.text();
  if (response.ok) return;
  const payload = text ? safeJson(text) : null;
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const message = stringValue(record.message) || text || response.statusText;
  throw new Error(`User Center password change failed: ${response.status} ${message}`);
}

function legacyHdoMigrationBaseUrl(): string | null {
  const configured = stringValue(environmentValue('LUOPAN_LEGACY_HDO_BASE_URL'));
  if (!configured) return null;
  try {
    const parsed = new URL(configured.includes('://') ? configured : `https://${configured}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function shouldMigrateLegacyHdoUser(error: unknown): error is UserCenterLoginError {
  return error instanceof UserCenterLoginError
    && error.status === 401
    && error.serverMessage.toLowerCase().includes('account is not active');
}

/**
 * Transitional V1 -> V2 identity bridge.
 *
 * The normal password grant always stays on the verified Internal service
 * VIP. Only when V2 reports that the account is absent/inactive, and an
 * operator explicitly configured LUOPAN_LEGACY_HDO_BASE_URL, do we validate
 * the same credentials against V1 HDO. A successful V1 response is then
 * imported through the in-tunnel V2 User Center endpoint as an ordinary
 * mx-user. V1 bearer/refresh tokens are deliberately ignored.
 */
async function migrateLegacyHdoUser(account: string, password: string, legacyBaseUrl: string): Promise<void> {
  const legacyResponse = await fetch(`${legacyBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: account, password })
  });
  const legacyText = await legacyResponse.text();
  const legacyPayload = legacyText ? safeJson(legacyText) : null;
  const legacyRecord = legacyPayload && typeof legacyPayload === 'object'
    ? legacyPayload as Record<string, unknown>
    : {};
  if (!legacyResponse.ok) {
    const message = stringValue(legacyRecord.error)
      || stringValue(legacyRecord.message)
      || legacyText
      || legacyResponse.statusText;
    throw new Error(`Legacy HDO login failed: ${legacyResponse.status} ${message}`);
  }
  const legacyUser = legacyRecord.user && typeof legacyRecord.user === 'object'
    ? legacyRecord.user as Record<string, unknown>
    : null;
  if (!legacyUser) throw new Error('Legacy HDO login did not return a user.');
  if (stringValue(legacyUser.role)?.toLowerCase() === 'banned') {
    throw new Error('Legacy HDO account is banned.');
  }

  const legacyUserId = stringValue(legacyUser.id);
  const legacyUsername = stringValue(legacyUser.username) || account;
  const legacyEmail = stringValue(legacyUser.email);
  const legacyDisplayName = stringValue(legacyUser.displayName) || legacyUsername;
  const siteIds = configuredOverseaSiteIds();
  const importResponse = await fetch(`${effectiveApiBaseUrl()}/internal/v1/user-center/users/import`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      users: [{
        ...(legacyUserId ? { id: legacyUserId } : {}),
        account: legacyUsername,
        username: legacyUsername,
        ...(legacyEmail ? { email: legacyEmail } : {}),
        displayName: legacyDisplayName,
        user_name: legacyUsername,
        password
      }],
      defaultRoleIds: ['mx-user'],
      defaultOrgIds: ['org_default'],
      defaultHomeAppId: 'luopan',
      defaultRegisteredByAppId: 'luopan',
      defaultAllowedAppIds: ['luopan', 'h2o'],
      ...(siteIds.length ? { defaultOverseaSiteIds: siteIds } : {}),
      provisionOversea: true,
      requestedBy: 'luopan-legacy-hdo-migration',
      requestId: `luopan-legacy-hdo-migration-${Date.now()}`
    })
  });
  const importText = await importResponse.text();
  const importPayload = importText ? safeJson(importText) : null;
  const importRecord = importPayload && typeof importPayload === 'object'
    ? importPayload as Record<string, unknown>
    : {};
  if (!importResponse.ok) {
    const message = stringValue(importRecord.message) || importText || importResponse.statusText;
    throw new Error(`User Center migration failed: ${importResponse.status} ${message}`);
  }
  const result = importRecord.import && typeof importRecord.import === 'object'
    ? importRecord.import as Record<string, unknown>
    : importRecord;
  const failed = typeof result.failed === 'number' ? result.failed : 0;
  if (failed > 0) {
    const failures = Array.isArray(result.failures) ? result.failures : [];
    const first = failures[0] && typeof failures[0] === 'object'
      ? failures[0] as Record<string, unknown>
      : {};
    throw new Error(`User Center migration failed: ${stringValue(first.reason) || `${failed} row(s) rejected`}`);
  }
  const importedUsers = Array.isArray(result.users) ? result.users : [];
  const importedUser = importedUsers[0] && typeof importedUsers[0] === 'object'
    ? importedUsers[0] as Record<string, unknown>
    : null;
  if (!importedUser) throw new Error('User Center migration did not return an imported user.');
  if (stringValue(importedUser.status) !== 'active') {
    throw new Error('User Center account is disabled; an administrator must activate it.');
  }
}

async function authenticateLuopanUser(account: string, password: string): Promise<LuopanUserAuthentication> {
  try {
    return await requestLuopanUserToken(account, password);
  } catch (error) {
    const legacyBaseUrl = legacyHdoMigrationBaseUrl();
    if (!legacyBaseUrl || !shouldMigrateLegacyHdoUser(error)) throw error;
    pushEvent('legacy HDO identity verification started');
    await migrateLegacyHdoUser(account, password, legacyBaseUrl);
    pushEvent('legacy HDO identity migrated to User Center');
    return requestLuopanUserToken(account, password);
  }
}

function luopanWireGuardServiceIdentity() {
  return {
    displayName: 'Luopan WireGuard',
    darwinLaunchDaemonLabelPrefix: 'com.qpjoy.luopan.wireguard',
    darwinSupportRoot: '/Library/Application Support/QPJoy/Luopan',
    darwinLogDir: '/Library/Logs/QPJoy-Luopan',
    darwinDaemonScriptName: 'luopan-wireguard-daemon.sh',
    staleDarwinLaunchDaemonLabelPrefixes: ['com.qpjoy.luopan.wireguard']
  };
}

function normalizeConfig(input: unknown, fallback: RuntimeConfig = defaultConfig()): RuntimeConfig {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    baseUrl: normalizeBaseUrl(stringValue(record.baseUrl) || fallback.baseUrl),
    bootstrapUrls: normalizeBootstrapUrls(record.bootstrapUrls, fallback.bootstrapUrls),
    productId: 'luopan',
    mode: 'standalone',
    sdkTestMode: typeof record.sdkTestMode === 'boolean' ? record.sdkTestMode : fallback.sdkTestMode,
    deviceLabel: stringValue(record.deviceLabel) || fallback.deviceLabel
  };
}

function applyEnvironmentConfigOverrides(config: RuntimeConfig): RuntimeConfig {
  const baseUrl = stringValue(environmentValue('LUOPAN_LAUNCHER_BASE_URL'))
    || stringValue(environmentValue('MX_LAUNCHER_BASE_URL'));
  const bootstrapValue = environmentValue('LUOPAN_BOOTSTRAP_URLS');
  const bootstrapUrls = bootstrapValue === undefined
    ? []
    : parseElectronLauncherBootstrapUrls(bootstrapValue);
  const sdkTestMode = environmentValue('LUOPAN_SDK_TEST_MODE');
  const deviceLabel = stringValue(environmentValue('LUOPAN_DEVICE_LABEL'));
  return {
    ...config,
    baseUrl: baseUrl ? normalizeBaseUrl(baseUrl) : config.baseUrl,
    bootstrapUrls: bootstrapUrls.length > 0 ? bootstrapUrls : config.bootstrapUrls,
    sdkTestMode: sdkTestMode === undefined
      ? config.sdkTestMode
      : booleanish(sdkTestMode, false),
    deviceLabel: deviceLabel || config.deviceLabel
  };
}

function constrainRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  if (!app.isPackaged) return config;
  return {
    ...config,
    baseUrl: LUOPAN_REGISTERED_BASE_URL,
    sdkTestMode: false
  };
}

// Empty input falls back (usually to LUOPAN_BOOTSTRAP_URLS from env/.env):
// an explicit list wins, a cleared field re-enables the environment default.
function normalizeBootstrapUrls(input: unknown, fallback: string[]): string[] {
  const raw = typeof input === 'string'
    ? input
    : Array.isArray(input)
      ? input.filter((item): item is string => typeof item === 'string').join(',')
      : null;
  if (raw === null) return fallback;
  const parsed = parseElectronLauncherBootstrapUrls(raw);
  return parsed.length > 0 ? parsed : fallback;
}

function normalizeConnection(input: unknown): RuntimeConnection {
  const fallback = emptyConnection();
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const leaseIp = stringValue(record.leaseIp);
  const dataPlane = normalizeDataPlane(record.dataPlane);
  const status = normalizeRuntimeStatus(record.status, leaseIp, dataPlane);
  return {
    status,
    bootstrapBaseUrl: stringValue(record.bootstrapBaseUrl),
    leaseId: stringValue(record.leaseId),
    leaseIp,
    serviceVip: stringValue(record.serviceVip),
    dnsServer: stringValue(record.dnsServer),
    routeCidrs: Array.isArray(record.routeCidrs) ? record.routeCidrs.filter((item): item is string => typeof item === 'string') : [],
    snapshotDigest: stringValue(record.snapshotDigest),
    dataPlane,
    message: stringValue(record.message) || fallback.message,
    updatedAt: stringValue(record.updatedAt)
  };
}

function normalizeIdentity(input: unknown): RuntimeIdentity {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const userId = stringValue(record.userId);
  if (record.kind !== 'user' || !userId) return emptyIdentity();
  return {
    kind: 'user',
    userId,
    displayName: stringValue(record.displayName),
    account: stringValue(record.account),
    scopes: Array.isArray(record.scopes) ? record.scopes.filter((item): item is string => typeof item === 'string') : [],
    tokenExpiresAt: stringValue(record.tokenExpiresAt),
    loginAt: stringValue(record.loginAt)
  };
}

function normalizeOversea(input: unknown): RuntimeOversea {
  const fallback = emptyOversea();
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const status = normalizeOverseaStatus(record.status);
  return {
    status,
    autoConnect: typeof record.autoConnect === 'boolean' ? record.autoConnect : fallback.autoConnect,
    mode: record.mode === 'app-rule' ? 'app-rule' : 'app-global',
    userId: stringValue(record.userId),
    entitlementId: stringValue(record.entitlementId),
    subscriptionPath: stringValue(record.subscriptionPath),
    subscriptionName: stringValue(record.subscriptionName),
    siteIds: Array.isArray(record.siteIds) ? record.siteIds.filter((item): item is string => typeof item === 'string') : [],
    syncStatus: stringValue(record.syncStatus),
    nodeCount: Number.isInteger(record.nodeCount) && Number(record.nodeCount) >= 0 ? Number(record.nodeCount) : 0,
    ensuredAt: stringValue(record.ensuredAt),
    startedAt: stringValue(record.startedAt),
    lastTestUrl: stringValue(record.lastTestUrl) || fallback.lastTestUrl,
    lastTestAt: stringValue(record.lastTestAt),
    lastProxyDecision: stringValue(record.lastProxyDecision),
    message: stringValue(record.message) || fallback.message
  };
}

function normalizeOverseaStatus(value: unknown): RuntimeOverseaStatus {
  if (value === 'waiting-login'
    || value === 'waiting-internal'
    || value === 'pending-sync'
    || value === 'ready'
    || value === 'stopped'
    || value === 'error') return value;
  return 'waiting-login';
}

function normalizeUpdate(input: unknown): RuntimeUpdate {
  const fallback = emptyUpdate();
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const status = record.status;
  return {
    // A persisted 'checking' means the app died mid-check; reset to idle. The
    // execution summary is kept for display, but apply always re-checks.
    status: status === 'up-to-date' || status === 'update-available' || status === 'blocked' || status === 'failed' ? status : 'idle',
    checkedAt: stringValue(record.checkedAt),
    currentVersion: app.getVersion(),
    targetVersion: stringValue(record.targetVersion),
    releaseId: stringValue(record.releaseId),
    releaseNotes: stringValue(record.releaseNotes),
    matchedBy: stringValue(record.matchedBy),
    featureFlags: Array.isArray(record.featureFlags) ? record.featureFlags.filter((item): item is string => typeof item === 'string') : [],
    artifacts: Array.isArray(record.artifacts) ? record.artifacts.filter((item): item is RuntimeUpdateArtifact => Boolean(item) && typeof item === 'object') : [],
    execution: Array.isArray(record.execution) ? record.execution.filter((item): item is RuntimeUpdateExecution => Boolean(item) && typeof item === 'object') : [],
    message: stringValue(record.message) || fallback.message
  };
}

function runtimeStatusForDataPlane(dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics): RuntimeStatus {
  if (dataPlane.ok) return 'network-ready';
  if (dataPlane.state === 'lease-missing') return 'idle';
  if (dataPlane.state === 'lease-active') return 'lease-active';
  return 'data-plane-pending';
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return value === 'idle'
    || value === 'connecting'
    || value === 'lease-active'
    || value === 'data-plane-pending'
    || value === 'network-ready'
    || value === 'error';
}

function normalizeRuntimeStatus(
  value: unknown,
  leaseIp: string | null,
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics | null
): RuntimeStatus {
  if (value === 'connected') return dataPlane?.ok ? 'network-ready' : leaseIp ? 'data-plane-pending' : 'idle';
  return isRuntimeStatus(value) ? value : 'idle';
}

function normalizeDataPlane(value: unknown): ElectronLauncherStandaloneDataPlaneDiagnostics | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ElectronLauncherStandaloneDataPlaneDiagnostics>;
  if (typeof record.state !== 'string' || typeof record.message !== 'string') return null;
  return record as ElectronLauncherStandaloneDataPlaneDiagnostics;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return LUOPAN_REGISTERED_BASE_URL;
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return LUOPAN_REGISTERED_BASE_URL;
    return parsed.origin;
  } catch {
    return LUOPAN_REGISTERED_BASE_URL;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanish(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

// Dynamic access deliberately prevents Quasar/Vite from replacing project
// .env values with build-time string literals in Electron main. Packaged apps
// must still be able to load <userData>/.env before defaultConfig() runs.
function environmentValue(name: string): string | undefined {
  return process.env[name];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function shutdownLuopanApplication(): Promise<void> {
  if (!runtime) return;
  const stopped = await disconnectLuopanDataPlane('shutdown');
  if (!stopped) {
    throw new Error(requireRuntime().connection.message || 'Luopan Internal data-plane cleanup did not complete.');
  }
  await abortOverseaReconcile();
  if (overseaBroadcastTimer) {
    clearTimeout(overseaBroadcastTimer);
    overseaBroadcastTimer = null;
  }
  const tunnel = overseaTunnel;
  if (tunnel) {
    await tunnel.close();
    if (overseaTunnel === tunnel) {
      overseaTunnel = null;
      overseaSession = null;
    }
  }
  await runtimeSaveQueue.catch((error) => {
    // Local routes and privileged services are already stopped. A failed
    // diagnostic/runtime write must not trap the app in before-quit.
    console.warn('[luopan] final runtime state was not persisted:', errorMessage(error));
  });
}

async function surfaceShutdownFailure(error: unknown): Promise<void> {
  const message = `退出清理失败，Luopan 将保持运行以便重试：${errorMessage(error)}`;
  console.warn('[luopan] shutdown failed:', errorMessage(error));
  if (runtime) {
    runtime.connection = {
      ...runtime.connection,
      status: 'error',
      message,
      updatedAt: new Date().toISOString()
    };
    pushEvent(`shutdown failed ${errorMessage(error)}`);
    await saveRuntime().catch((saveError) => {
      console.warn('[luopan] failed to persist shutdown error:', errorMessage(saveError));
    });
    broadcastRuntime();
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    try {
      await createWindow();
    } catch (windowError) {
      console.warn('[luopan] failed to recreate shutdown error window:', errorMessage(windowError));
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    }
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) return;
  // .env support for packaged builds (no shell env there). Real env vars win;
  // then per-machine <userData>/.env; then the .env shipped inside the app
  // (electron-builder extraResources); then the project .env during dev.
  const envResult = loadElectronLauncherEnvFiles([
    path.join(app.getPath('userData'), '.env'),
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
    path.join(app.getAppPath(), '.env'),
    path.resolve(currentDir, '..', '..', '.env')
  ]);
  if (envResult.loadedFrom) {
    console.log(`[luopan] env file loaded: ${envResult.loadedFrom} (${envResult.applied.join(', ') || 'no new keys'})`);
  }
  runtime = await loadRuntime();
  try {
    configureOverseaNativeRuntime();
    await initializeOverseaTunnel();
  } catch (error) {
    const message = `Oversea runtime initialization failed: ${errorMessage(error)}`;
    requireRuntime().oversea = { ...requireRuntime().oversea, status: 'error', message };
    pushEvent(message);
    await saveRuntime();
  }
  registerIpc();
  await createWindow();
  void adoptUpdatesAndReportInstallCompletion().catch((error) => {
    console.warn('[luopan] startup update bookkeeping failed:', errorMessage(error));
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (!ownsSingleInstanceLock || shutdownComplete) return;
  event.preventDefault();
  if (shutdownInFlight) return;
  shutdownInFlight = runSessionExclusive(shutdownLuopanApplication)
    .then(() => {
      shutdownComplete = true;
      app.quit();
    })
    .catch(surfaceShutdownFailure)
    .finally(() => {
      if (!shutdownComplete) shutdownInFlight = null;
    });
});
