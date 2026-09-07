import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  safeStorage,
  type IpcMainInvokeEvent
} from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isIP } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ElectronLauncherBootstrapResolution,
  ElectronLauncherStandaloneDataPlaneDiagnostics,
  LauncherNetworkLease,
  LauncherNetworkSession,
  LauncherProductNetwork,
  LauncherRoutePlan,
  LauncherWireGuardKeyPair,
  StandaloneLauncher
} from '@qpjoy/electron-launcher';
import {
  applyElectronLauncherStandaloneDataPlane,
  createElectronLauncher,
  createLauncherWireGuardKeyPair,
  defineLauncherProduct,
  loadElectronLauncherEnvFiles,
  parseElectronLauncherBootstrapUrls,
  resolveElectronLauncherBootstrap,
  stopElectronLauncherStandaloneDataPlane
} from './installed-runtime';
import {
  collectEnrollmentLeaseCapabilities,
  identityCapabilityKey,
  isLeaseCapability,
  mintLeaseCapability
} from './lease-capability-policy.mjs';

type ConnectionStatus =
  | 'idle'
  | 'resolving-bootstrap'
  | 'enrolling'
  | 'lease-active'
  | 'applying-data-plane'
  | 'data-plane-pending'
  | 'network-ready'
  | 'disconnecting'
  | 'error';

interface RuntimeConfig {
  readonly productId: 'mx-autotest';
  readonly mode: 'standalone';
  readonly bootstrapUrls: string[];
  readonly internalPort: number;
  readonly platformServerUrl: string | null;
  readonly sdkTestMode: boolean;
  readonly deviceLabel: string;
}

interface RuntimeIdentity {
  kind: 'anonymous' | 'user';
  userId: string | null;
  displayName: string | null;
  account: string | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  loginAt: string | null;
}

interface RuntimeConnection {
  status: ConnectionStatus;
  bootstrapBaseUrl: string | null;
  internalBaseUrl: string | null;
  leaseId: string | null;
  leaseIp: string | null;
  serviceVip: string | null;
  routeCidrs: string[];
  snapshotDigest: string | null;
  dataPlane: ElectronLauncherStandaloneDataPlaneDiagnostics | null;
  message: string;
  updatedAt: string | null;
}

interface RuntimeState {
  version: 1;
  installId: string;
  deviceId: string;
  config: RuntimeConfig;
  identity: RuntimeIdentity;
  connection: RuntimeConnection;
  events: string[];
}

interface LeaseCredential {
  leaseId: string;
  capability: string;
  identityKind: 'anonymous' | 'user';
  userId: string | null;
  productId: 'mx-autotest';
  installId: string;
  publicKey: string;
  expiresAt: string | null;
  updatedAt: string;
}

interface CredentialVault {
  accessToken: string | null;
  wireGuardKeyPair: LauncherWireGuardKeyPair | null;
  leaseCredentials: Record<string, LeaseCredential>;
  pendingCapabilities: Record<string, string>;
}

interface ProtectedCredentialVault {
  storage: 'electron-safe-storage-v1';
  ciphertext: string;
}

interface PersistedRuntime extends RuntimeState {
  credentialVaultVersion?: 1;
  protectedCredentials?: ProtectedCredentialVault | null;
}

interface UserAuthentication {
  userId: string;
  displayName: string | null;
  account: string;
  scopes: string[];
  accessToken: string;
  expiresAt: string | null;
}

interface RunTaskInput {
  taskId: string;
  caseFilter?: string;
}

const PRODUCT_ID = 'mx-autotest' as const;
const PRODUCT = defineLauncherProduct({
  productId: PRODUCT_ID,
  displayName: 'MX AutoTest',
  mode: 'standalone',
  appCenter: { visible: true, category: 'custom' },
  launcherActions: {
    network: true,
    release: false,
    update: false,
    rollout: false,
    appCenter: false
  }
});
const IPC_PREFIX = 'mx-autotest';
const STATE_FILE = 'mx-autotest-runtime.json';
const PROFILE_NAME = 'mx-autotest.conf';
const DEFAULT_BOOTSTRAP_URL = 'https://h2i.minsight-ai.com';
const DEFAULT_INTERNAL_PORT = 18090;
const MAX_EVENTS = 80;
const MAX_PLATFORM_BODY_BYTES = 256 * 1024;
const MAX_PLATFORM_RESPONSE_BYTES = 2 * 1024 * 1024;
const currentDir = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeState | null = null;
let activeSession: LauncherNetworkSession | null = null;
let activeBootstrapBaseUrl: string | null = null;
let credentialVault: CredentialVault = emptyCredentialVault();
let credentialStorageFailure: string | null = null;
let runtimeSaveQueue: Promise<void> = Promise.resolve();
let runtimeSaveSequence = 0;
let sessionQueue: Promise<unknown> = Promise.resolve();
let shutdownInFlight: Promise<void> | null = null;
let shutdownComplete = false;

app.setAppUserModelId('dev.qpjoy.mx-autotest');
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function defaultConfig(): RuntimeConfig {
  const configuredBootstrap = parseElectronLauncherBootstrapUrls(
    environmentValue('MX_AUTOTEST_BOOTSTRAP_URLS')
      || environmentValue('MX_LAUNCHER_BOOTSTRAP_URLS')
  );
  const configuredPlatform = normalizeBaseUrl(environmentValue('MX_AUTOTEST_SERVER_URL'));
  return {
    productId: PRODUCT_ID,
    mode: 'standalone',
    bootstrapUrls: configuredBootstrap.length > 0 ? configuredBootstrap : [DEFAULT_BOOTSTRAP_URL],
    internalPort: normalizePort(environmentValue('MX_AUTOTEST_INTERNAL_PORT')) ?? DEFAULT_INTERNAL_PORT,
    platformServerUrl: configuredPlatform,
    sdkTestMode: !app.isPackaged && booleanish(environmentValue('MX_AUTOTEST_SDK_TEST_MODE')),
    deviceLabel: environmentValue('MX_AUTOTEST_DEVICE_LABEL')?.trim() || 'MX AutoTest Desktop'
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

function emptyConnection(): RuntimeConnection {
  return {
    status: 'idle',
    bootstrapBaseUrl: activeBootstrapBaseUrl,
    internalBaseUrl: null,
    leaseId: null,
    leaseIp: null,
    serviceVip: null,
    routeCidrs: [],
    snapshotDigest: null,
    dataPlane: null,
    message: 'MX AutoTest standalone runtime is ready.',
    updatedAt: null
  };
}

function emptyCredentialVault(): CredentialVault {
  return {
    accessToken: null,
    wireGuardKeyPair: null,
    leaseCredentials: {},
    pendingCapabilities: {}
  };
}

async function loadRuntime(): Promise<RuntimeState> {
  const config = defaultConfig();
  const fallback: RuntimeState = {
    version: 1,
    installId: `mxat_inst_${randomUUID()}`,
    deviceId: `mxat_dev_${randomUUID()}`,
    config,
    identity: emptyIdentity(),
    connection: emptyConnection(),
    events: []
  };
  try {
    const text = await fs.readFile(runtimeStateFile(), 'utf8');
    const parsed = JSON.parse(text) as Partial<PersistedRuntime>;
    credentialVault = unprotectCredentialVault(parsed.protectedCredentials);
    const identity = normalizeIdentity(parsed.identity);
    const resumableIdentity = identityCanResume(identity, credentialVault.accessToken)
      ? identity
      : emptyIdentity();
    if (resumableIdentity.kind !== 'user') credentialVault.accessToken = null;
    const previousConnection = normalizeConnection(parsed.connection);
    const connection = previousConnection.status === 'idle'
      ? previousConnection
      : {
          ...previousConnection,
          status: credentialStorageFailure ? 'error' as const : 'data-plane-pending' as const,
          message: credentialStorageFailure
            ? `Protected credential recovery failed: ${credentialStorageFailure}`
            : 'A previous network session needs an explicit reconnect or disconnect before it is trusted.',
          updatedAt: new Date().toISOString()
        };
    return {
      version: 1,
      installId: safeRuntimeId(parsed.installId, 'mxat_inst_') || fallback.installId,
      deviceId: safeRuntimeId(parsed.deviceId, 'mxat_dev_') || fallback.deviceId,
      config,
      identity: resumableIdentity,
      connection,
      events: []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[mx-autotest] runtime load failed; using a clean fail-closed state:', safeErrorMessage(error));
    }
    credentialVault = emptyCredentialVault();
    credentialStorageFailure = null;
    return fallback;
  }
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
    throw new Error(`Protected credential storage cannot be recovered: ${credentialStorageFailure}`);
  }
  if (!secureCredentialStorageAvailable()) {
    throw new Error('Electron safeStorage is unavailable or only provides Linux basic_text; network enrollment is blocked.');
  }
}

function protectCredentialVault(): ProtectedCredentialVault | null {
  if (credentialStorageFailure) {
    throw new Error(`Refusing to overwrite unreadable protected credentials: ${credentialStorageFailure}`);
  }
  const hasSecrets = Boolean(
    credentialVault.accessToken
    || credentialVault.wireGuardKeyPair?.privateKey
    || Object.keys(credentialVault.leaseCredentials).length
    || Object.keys(credentialVault.pendingCapabilities).length
  );
  if (!hasSecrets) return null;
  ensureCredentialStorageReady();
  return {
    storage: 'electron-safe-storage-v1',
    ciphertext: safeStorage.encryptString(JSON.stringify(credentialVault)).toString('base64')
  };
}

function unprotectCredentialVault(input: unknown): CredentialVault {
  credentialStorageFailure = null;
  if (input === undefined || input === null) return emptyCredentialVault();
  const record = objectRecord(input);
  const ciphertext = stringValue(record.ciphertext);
  if (record.storage !== 'electron-safe-storage-v1' || !ciphertext) {
    credentialStorageFailure = 'invalid credential vault format';
    return emptyCredentialVault();
  }
  try {
    if (!secureCredentialStorageAvailable()) throw new Error('safeStorage encryption is unavailable');
    return normalizeCredentialVault(JSON.parse(
      safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
    ));
  } catch (error) {
    credentialStorageFailure = safeErrorMessage(error);
    return emptyCredentialVault();
  }
}

function normalizeCredentialVault(input: unknown): CredentialVault {
  const record = objectRecord(input);
  const keyRecord = objectRecord(record.wireGuardKeyPair);
  const privateKey = stringValue(keyRecord.privateKey);
  const publicKey = stringValue(keyRecord.publicKey);
  const leaseCredentials: Record<string, LeaseCredential> = {};
  for (const [key, value] of Object.entries(objectRecord(record.leaseCredentials))) {
    const credential = normalizeLeaseCredential(value);
    if (credential) leaseCredentials[key] = credential;
  }
  const pendingCapabilities: Record<string, string> = {};
  for (const [key, value] of Object.entries(objectRecord(record.pendingCapabilities))) {
    const capability = stringValue(value);
    if (capability && isLeaseCapability(capability)) pendingCapabilities[key] = capability;
  }
  return {
    accessToken: stringValue(record.accessToken),
    wireGuardKeyPair: privateKey && publicKey ? { privateKey, publicKey } : null,
    leaseCredentials,
    pendingCapabilities
  };
}

function normalizeLeaseCredential(input: unknown): LeaseCredential | null {
  const record = objectRecord(input);
  const leaseId = stringValue(record.leaseId);
  const capability = stringValue(record.capability);
  const installId = stringValue(record.installId);
  const publicKey = stringValue(record.publicKey);
  if (!leaseId || !capability || !isLeaseCapability(capability) || !installId || !publicKey || record.productId !== PRODUCT_ID) return null;
  return {
    leaseId,
    capability,
    identityKind: record.identityKind === 'user' ? 'user' : 'anonymous',
    userId: stringValue(record.userId),
    productId: PRODUCT_ID,
    installId,
    publicKey,
    expiresAt: stringValue(record.expiresAt),
    updatedAt: stringValue(record.updatedAt) || new Date(0).toISOString()
  };
}

async function saveRuntime(): Promise<void> {
  const state = requireRuntime();
  const protectedCredentials = protectCredentialVault();
  const persisted: PersistedRuntime = {
    ...state,
    credentialVaultVersion: 1,
    protectedCredentials
  };
  const snapshot = `${JSON.stringify(persisted, null, 2)}\n`;
  const file = runtimeStateFile();
  const sequence = ++runtimeSaveSequence;
  const next = runtimeSaveQueue.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${sequence}.tmp`;
    try {
      await fs.writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, file);
      await fs.chmod(file, 0o600);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  });
  runtimeSaveQueue = next;
  await next;
}

function requireRuntime(): RuntimeState {
  if (!runtime) throw new Error('MX AutoTest runtime is not initialized');
  return runtime;
}

function visibleRuntime() {
  const state = requireRuntime();
  return {
    appId: PRODUCT_ID,
    displayName: PRODUCT.displayName,
    packageName: '@qpjoy/mx-autotest',
    launcherMode: PRODUCT.mode,
    networkScope: PRODUCT.networkScope,
    installId: state.installId,
    deviceId: state.deviceId,
    credentialStorageReady: secureCredentialStorageAvailable() && !credentialStorageFailure,
    config: state.config,
    identity: {
      ...state.identity,
      tokenPresent: state.identity.kind === 'user' && Boolean(credentialVault.accessToken)
    },
    connection: state.connection,
    platform: {
      configured: Boolean(state.config.platformServerUrl),
      baseUrl: state.config.platformServerUrl
    },
    events: state.events
  };
}

function pushEvent(message: string): void {
  const state = requireRuntime();
  state.events = [
    `${new Date().toISOString()} ${safeErrorMessage(message)}`,
    ...state.events
  ].slice(0, MAX_EVENTS);
}

function broadcastRuntime(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(`${IPC_PREFIX}:runtime`, visibleRuntime());
}

async function setConnection(patch: Partial<RuntimeConnection>): Promise<void> {
  const state = requireRuntime();
  state.connection = {
    ...state.connection,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await saveRuntime();
  broadcastRuntime();
}

function runSessionExclusive<T>(task: () => Promise<T>): Promise<T> {
  const next = sessionQueue.then(task, task);
  sessionQueue = next.catch(() => undefined);
  return next;
}

function launcherClient(baseUrl: string): StandaloneLauncher {
  const state = requireRuntime();
  const keyPair = credentialVault.wireGuardKeyPair;
  const launcher = createElectronLauncher({
    baseUrl,
    productId: PRODUCT_ID,
    mode: 'standalone',
    installId: state.installId,
    deviceId: state.deviceId,
    deviceLabel: state.config.deviceLabel,
    keyPair: keyPair ?? undefined,
    privateKey: keyPair?.privateKey,
    publicKey: keyPair?.publicKey
  });
  if (launcher.mode !== 'standalone') throw new Error('MX AutoTest requires standalone launcher mode');
  return launcher;
}

async function ensureBootstrapResolved(force = false): Promise<ElectronLauncherBootstrapResolution> {
  const state = requireRuntime();
  if (!force && activeBootstrapBaseUrl) {
    return {
      ok: true,
      baseUrl: activeBootstrapBaseUrl,
      source: 'pinned',
      probes: [],
      message: `Using pinned bootstrap ${activeBootstrapBaseUrl}.`
    };
  }
  const resolution = await resolveElectronLauncherBootstrap({
    candidates: state.config.bootstrapUrls.map((url) => ({ url, source: 'MX_AUTOTEST_BOOTSTRAP_URLS' })),
    timeoutMs: 3_000
  });
  if (!resolution.ok || !resolution.baseUrl) throw new Error(resolution.message);
  activeBootstrapBaseUrl = resolution.baseUrl;
  state.connection.bootstrapBaseUrl = resolution.baseUrl;
  return resolution;
}

function ensureWireGuardKeyPair(): LauncherWireGuardKeyPair {
  ensureCredentialStorageReady();
  credentialVault.wireGuardKeyPair ??= createLauncherWireGuardKeyPair();
  return credentialVault.wireGuardKeyPair;
}

function ensurePendingCapability(identityKind: 'anonymous' | 'user', userId: string | null): string {
  const key = identityCapabilityKey(identityKind, userId);
  credentialVault.pendingCapabilities[key] ??= mintLeaseCapability();
  return credentialVault.pendingCapabilities[key];
}

function leaseCapabilitiesForEnrollment(
  identityKind: 'anonymous' | 'user',
  userId: string | null
): string | undefined {
  const state = requireRuntime();
  const publicKey = credentialVault.wireGuardKeyPair?.publicKey;
  return collectEnrollmentLeaseCapabilities({
    credentials: credentialVault.leaseCredentials,
    pendingCapabilities: credentialVault.pendingCapabilities,
    identityKind,
    userId,
    productId: PRODUCT_ID,
    installId: state.installId,
    publicKey
  });
}

function rememberLeaseCredential(lease: LauncherNetworkLease, fallbackCapability?: string): void {
  const state = requireRuntime();
  const capability = stringValue(lease.capability) || stringValue(fallbackCapability);
  const publicKey = credentialVault.wireGuardKeyPair?.publicKey;
  if (!capability || !isLeaseCapability(capability) || !publicKey || lease.productId !== PRODUCT_ID || lease.installId !== state.installId) {
    throw new Error('Launcher lease did not return a product-scoped capability');
  }
  credentialVault.leaseCredentials[lease.leaseId] = {
    leaseId: lease.leaseId,
    capability,
    identityKind: lease.identityKind === 'user' ? 'user' : 'anonymous',
    userId: lease.userId,
    productId: PRODUCT_ID,
    installId: state.installId,
    publicKey,
    expiresAt: stringValue(lease.expiresAt),
    updatedAt: new Date().toISOString()
  };
}

async function connectInternalLocked(): Promise<boolean> {
  const state = requireRuntime();
  if (state.identity.kind === 'user' && !identityCanResume(state.identity, credentialVault.accessToken)) {
    credentialVault.accessToken = null;
    state.identity = emptyIdentity();
    pushEvent('Expired User Center session cleared before reconnect');
    await saveRuntime();
  }
  const loggedIn = state.identity.kind === 'user' && Boolean(state.identity.userId && credentialVault.accessToken);
  const identityKind = loggedIn ? 'user' as const : 'anonymous' as const;
  const userId = loggedIn ? state.identity.userId : null;
  const retainedVipReady = loggedIn && state.connection.status === 'network-ready'
    ? await probeOwnServiceVip(false)
    : false;

  await setConnection({
    status: 'resolving-bootstrap',
    message: retainedVipReady
      ? 'Using the verified product VIP to request a user lease.'
      : 'Resolving the registered anonymous bootstrap entrance.'
  });

  try {
    let controlBaseUrl: string;
    if (retainedVipReady && state.connection.internalBaseUrl) {
      controlBaseUrl = state.connection.internalBaseUrl;
    } else {
      const resolution = await ensureBootstrapResolved(true);
      controlBaseUrl = requiredString(resolution.baseUrl, 'bootstrap base URL');
      if (loggedIn) await assertBearerTransportAllowed(controlBaseUrl);
    }

    const launcher = launcherClient(controlBaseUrl);
    const product = await launcher.getProduct(PRODUCT_ID);
    assertOwnRegisteredProduct(product);
    const internalBaseUrl = productServiceBaseUrl(product, state.config.internalPort);
    const keyPair = ensureWireGuardKeyPair();
    const pendingCapability = ensurePendingCapability(identityKind, userId);
    const leaseCapability = leaseCapabilitiesForEnrollment(identityKind, userId);

    // Persist before enrollment: a crash can safely retry the same key and capability.
    await saveRuntime();
    await setConnection({
      status: 'enrolling',
      internalBaseUrl,
      serviceVip: product.serviceVip,
      message: loggedIn ? 'Requesting a product-scoped user lease.' : 'Requesting a product-scoped anonymous lease.'
    });

    const session = await launcher.connectNetwork({
      identityKind,
      leaseProfile: loggedIn ? 'employee' : 'anonymous',
      userId: userId ?? undefined,
      accessToken: loggedIn ? requiredString(credentialVault.accessToken, 'access token') : undefined,
      // The server accepts a bounded comma-separated candidate set. That is
      // required for the first anonymous -> user handover: the new identity has
      // no user lease yet, while the active anonymous lease still must be proven.
      leaseCapability,
      newLeaseCapability: pendingCapability,
      keyPair,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      platform: 'quasar-electron',
      appVersion: app.getVersion(),
      sdkTestMode: state.config.sdkTestMode,
      requestedBy: 'mx-autotest-desktop',
      requestId: `mx-autotest-connect-${Date.now()}`
    });
    rememberLeaseCredential(session.lease, pendingCapability);
    for (const handoverLease of session.lease.handoverLeases ?? []) rememberLeaseCredential(handoverLease);
    delete credentialVault.pendingCapabilities[identityCapabilityKey(identityKind, userId)];
    activeSession = session;
    const routePlan = ownRouteOnlyPlan(session.routePlan);
    await saveRuntime();
    await setConnection({
      status: 'lease-active',
      leaseId: session.lease.leaseId,
      leaseIp: session.lease.leaseIp,
      serviceVip: session.lease.serviceVip,
      internalBaseUrl,
      routeCidrs: [...routePlan.routeCidrs],
      snapshotDigest: session.snapshot.signatures.digest,
      dataPlane: null,
      message: 'Lease active; synchronizing the product peer before local apply.'
    });

    await syncLeasePeers(controlBaseUrl, session);
    await setConnection({
      status: 'applying-data-plane',
      message: 'Applying the isolated route-only WireGuard data plane.'
    });
    const applied = await applyElectronLauncherStandaloneDataPlane({
      userDataDir: app.getPath('userData'),
      profileName: PROFILE_NAME,
      routePlan,
      privateKey: keyPair.privateKey,
      dnsDomains: [],
      suppressWireGuardDns: true,
      pathPreference: 'relay',
      requiredProbeTargets: ['lease-ip', 'service-vip'],
      ownerId: ownershipOwnerId(),
      productId: PRODUCT_ID,
      instanceId: state.installId,
      displayName: PRODUCT.displayName,
      metadata: {
        dataPlaneMode: 'standalone-wireguard',
        dataPlaneOwner: true,
        routeOnly: true
      },
      dnsHosts: [],
      dnsZones: [],
      routeCidrs: routePlan.routeCidrs,
      supersedeClaims: [],
      failOnOwnershipConflicts: true,
      allowSystemFallback: false,
      fallbackToAppManaged: false,
      darwinLaunchDaemon: true,
      darwinServiceIdentity: wireGuardServiceIdentity()
    });
    if (!applied.ok) {
      await setConnection({
        status: applied.state === 'ownership-conflict' ? 'error' : 'data-plane-pending',
        dataPlane: applied.diagnostics,
        message: applied.message
      });
      pushEvent(`data plane not ready: ${applied.state}`);
      await saveRuntime();
      return false;
    }

    const vipHealth = await probeServiceHealth(internalBaseUrl, session.lease.serviceVip);
    if (!vipHealth.ok) {
      await setConnection({
        status: 'data-plane-pending',
        dataPlane: {
          ...applied.diagnostics,
          ok: false,
          state: 'service-unreachable',
          severity: 'warning',
          message: vipHealth.message
        },
        message: vipHealth.message
      });
      pushEvent('service VIP health check failed');
      await saveRuntime();
      return false;
    }

    await setConnection({
      status: 'network-ready',
      dataPlane: applied.diagnostics,
      message: loggedIn
        ? 'MX AutoTest user network is ready through its own product VIP.'
        : 'MX AutoTest anonymous network is ready; User Center login is now permitted.'
    });
    pushEvent(`network ready ${session.lease.leaseIp}`);
    await saveRuntime();
    return true;
  } catch (error) {
    const message = safeErrorMessage(error);
    await setConnection({ status: 'error', message });
    pushEvent(`connect failed: ${message}`);
    await saveRuntime().catch(() => undefined);
    return false;
  }
}

function assertOwnRegisteredProduct(product: LauncherProductNetwork): void {
  if (product.productId !== PRODUCT_ID) throw new Error('Bootstrap returned a different product identity');
  if (product.mode !== 'standalone' || product.networkScope !== 'owner') {
    throw new Error('MX AutoTest ProductNetwork is not registered as a standalone owner');
  }
  // A standalone product owns its channel by definition. The bootstrap ProductNetwork
  // contract does not echo the application registry's channel field, so validate the
  // immutable local product definition here and require the server to return the
  // matching standalone owner below.
  if (PRODUCT.standaloneChannelProductId !== PRODUCT_ID) {
    throw new Error('MX AutoTest local product definition is bound to another standalone channel');
  }
  if (!product.enabled) throw new Error('MX AutoTest ProductNetwork is disabled');
  if (!product.serviceVip || !isIP(product.serviceVip)) throw new Error('MX AutoTest ProductNetwork has no valid service VIP');
}

function productServiceBaseUrl(product: LauncherProductNetwork, port: number): string {
  return `http://${product.serviceVip}:${port}`;
}

function ownRouteOnlyPlan(routePlan: LauncherRoutePlan): LauncherRoutePlan {
  if (routePlan.productId !== PRODUCT_ID) throw new Error('Refusing a route plan for another product');
  const routeCidrs = uniqueStrings([
    requiredString(routePlan.leaseCidr, 'lease CIDR'),
    `${requiredString(routePlan.serviceVip, 'service VIP')}/32`
  ]);
  return {
    ...routePlan,
    routeCidrs,
    allowedIps: routeCidrs,
    h2iDirectAllowedIps: routeCidrs
  };
}

async function syncLeasePeers(controlBaseUrl: string, session: LauncherNetworkSession): Promise<void> {
  await launcherNetworkPost(controlBaseUrl, session, `/leases/${encodeURIComponent(session.lease.leaseId)}/domestic-peer/sync`, {
    requestedBy: 'mx-autotest-desktop',
    requestId: `mx-autotest-domestic-peer-${Date.now()}`
  });
}

async function launcherNetworkPost(
  baseUrl: string,
  session: LauncherNetworkSession,
  pathname: string,
  body: Record<string, unknown>
): Promise<unknown> {
  if (!pathname.startsWith('/leases/') || !pathname.endsWith('/domestic-peer/sync')) {
    throw new Error('Launcher network operation is not allowlisted');
  }
  const credential = credentialVault.leaseCredentials[session.lease.leaseId];
  const response = await fetch(`${baseUrl}/internal/v1/launcher-network${pathname}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'Content-Type': 'application/json',
      'x-mx-lease-capability': requiredString(credential?.capability || session.lease.capability, 'lease capability'),
      ...(session.lease.identityKind === 'user' && credentialVault.accessToken
        ? { Authorization: `Bearer ${credentialVault.accessToken}` }
        : {})
    },
    body: JSON.stringify(body)
  });
  return readJsonResponse(response, 512 * 1024, 'Launcher peer sync');
}

async function probeOwnServiceVip(updateMessage: boolean): Promise<boolean> {
  const state = requireRuntime();
  const baseUrl = state.connection.internalBaseUrl;
  const serviceVip = state.connection.serviceVip;
  if (!baseUrl || !serviceVip) return false;
  const result = await probeServiceHealth(baseUrl, serviceVip);
  if (!result.ok && updateMessage) {
    await setConnection({ status: 'data-plane-pending', message: result.message });
  }
  return result.ok;
}

async function probeServiceHealth(baseUrl: string, serviceVip: string): Promise<{ ok: boolean; message: string }> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, message: 'Product service base URL is invalid.' };
  }
  if (parsed.hostname !== serviceVip || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { ok: false, message: 'Product service URL does not match the current MX AutoTest service VIP.' };
  }
  try {
    const response = await fetch(new URL('/healthz', parsed), {
      method: 'GET',
      signal: AbortSignal.timeout(4_000),
      cache: 'no-store'
    });
    await response.text();
    return response.ok
      ? { ok: true, message: 'Product service VIP health check passed.' }
      : { ok: false, message: `Product service VIP health check returned HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, message: `Product service VIP is unreachable: ${safeErrorMessage(error)}` };
  }
}

async function loginLocked(input: unknown): Promise<void> {
  const state = requireRuntime();
  const record = objectRecord(input);
  const account = stringValue(record.account);
  const password = typeof record.password === 'string' ? record.password : '';
  if (!account || !password) throw new Error('Account and password are required');
  if (state.connection.status !== 'network-ready') {
    throw new Error('Connect the anonymous MX AutoTest network before User Center login');
  }
  if (!await probeOwnServiceVip(true)) throw new Error('The verified MX AutoTest service VIP is not ready');
  ensureCredentialStorageReady();
  const authentication = await requestUserToken(
    requiredString(state.connection.internalBaseUrl, 'Internal base URL'),
    account,
    password
  );
  credentialVault.accessToken = authentication.accessToken;
  state.identity = {
    kind: 'user',
    userId: authentication.userId,
    displayName: authentication.displayName || account,
    account: authentication.account,
    scopes: authentication.scopes,
    tokenExpiresAt: authentication.expiresAt,
    loginAt: new Date().toISOString()
  };
  state.events = [];
  pushEvent(`User Center login succeeded for ${authentication.userId}`);
  await saveRuntime();
  broadcastRuntime();

  // Upgrade only this product from anonymous to user range. Failure remains
  // visible and never invokes another product's network lifecycle.
  if (!await connectInternalLocked()) {
    throw new Error(`User Center login succeeded, but the user network is not ready: ${state.connection.message}`);
  }
}

async function requestUserToken(baseUrl: string, account: string, password: string): Promise<UserAuthentication> {
  const state = requireRuntime();
  if (new URL(baseUrl).hostname !== state.connection.serviceVip) {
    throw new Error('User Center login is restricted to the current product service VIP');
  }
  const response = await fetch(new URL('/internal/v1/sdk/oauth/token', baseUrl), {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      username: account,
      password,
      audience: 'mx-sdk',
      scope: 'auth.read',
      requestId: `mx-autotest-oauth-${Date.now()}`
    })
  });
  const payload = objectRecord(await readJsonResponse(response, 512 * 1024, 'User Center login'));
  const token = objectRecord(payload.token && typeof payload.token === 'object' ? payload.token : payload);
  const principal = objectRecord(token.principal);
  const subject = stringValue(token.subject);
  const userId = stringValue(principal.userId)
    || (subject?.startsWith('user:') ? stringValue(subject.slice('user:'.length)) : null);
  const accessToken = stringValue(token.access_token);
  const scopes = typeof token.scope === 'string' ? uniqueStrings(token.scope.split(/\s+/)) : [];
  if (!userId || !accessToken || !scopes.includes('auth.read')) {
    throw new Error('User Center did not return the required user principal and auth.read token');
  }
  return {
    userId,
    displayName: stringValue(principal.displayName),
    account,
    scopes,
    accessToken,
    expiresAt: stringValue(token.expires_at)
  };
}

async function logoutLocked(): Promise<void> {
  const state = requireRuntime();
  credentialVault.accessToken = null;
  state.identity = emptyIdentity();
  state.events = [];
  pushEvent('Local User Center session cleared');
  await disconnectLocked('logout');
}

async function disconnectLocked(reason: 'manual' | 'logout' | 'shutdown'): Promise<boolean> {
  const state = requireRuntime();
  const sessionToStop = activeSession;
  const connectionToRestore = state.connection;
  const needsCleanup = Boolean(
    sessionToStop
    || state.connection.status !== 'idle'
    || Object.keys(credentialVault.leaseCredentials).length > 0
  );
  if (!needsCleanup) return true;

  state.connection = {
    ...state.connection,
    status: 'disconnecting',
    message: `Stopping only the MX AutoTest data plane (${reason}).`,
    updatedAt: new Date().toISOString()
  };
  broadcastRuntime();
  try {
    const result = await stopElectronLauncherStandaloneDataPlane({
      userDataDir: app.getPath('userData'),
      profileName: PROFILE_NAME,
      routePlan: sessionToStop ? ownRouteOnlyPlan(sessionToStop.routePlan) : undefined,
      ownerId: ownershipOwnerId(),
      darwinLaunchDaemon: true,
      allowSystemFallback: false,
      fallbackToAppManaged: false,
      darwinServiceIdentity: wireGuardServiceIdentity()
    });
    if (!result.ok) {
      state.connection = {
        ...connectionToRestore,
        status: 'error',
        message: result.message || 'MX AutoTest local data-plane cleanup failed.',
        updatedAt: new Date().toISOString()
      };
      pushEvent('local data-plane cleanup failed; ownership claim retained');
      await saveRuntime();
      broadcastRuntime();
      return false;
    }
    activeSession = null;
    const releaseFailures = await releaseServerLeases();
    state.connection = {
      ...emptyConnection(),
      message: releaseFailures.length
        ? `Local network stopped. ${releaseFailures.length} server lease release(s) remain queued for retry.`
        : 'MX AutoTest network stopped and product leases released.',
      updatedAt: new Date().toISOString()
    };
    pushEvent(releaseFailures.length ? 'local network stopped; server release pending' : 'network disconnected');
    await saveRuntime();
    broadcastRuntime();
    return true;
  } catch (error) {
    state.connection = {
      ...connectionToRestore,
      status: 'error',
      message: safeErrorMessage(error),
      updatedAt: new Date().toISOString()
    };
    pushEvent(`disconnect failed: ${safeErrorMessage(error)}`);
    await saveRuntime().catch(() => undefined);
    broadcastRuntime();
    return false;
  }
}

async function releaseServerLeases(): Promise<string[]> {
  const credentials = Object.values(credentialVault.leaseCredentials).filter((credential) => (
    credential.productId === PRODUCT_ID
    && credential.installId === requireRuntime().installId
    && credential.publicKey === credentialVault.wireGuardKeyPair?.publicKey
  ));
  if (!credentials.length) return [];
  let baseUrl: string;
  try {
    baseUrl = requiredString((await ensureBootstrapResolved(false)).baseUrl, 'bootstrap base URL');
  } catch {
    return credentials.map((credential) => credential.leaseId);
  }
  const failures: string[] = [];
  for (const credential of credentials) {
    try {
      const response = await fetch(`${baseUrl}/internal/v1/launcher-network/leases/${encodeURIComponent(credential.leaseId)}/release`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'Content-Type': 'application/json',
          'x-mx-lease-capability': credential.capability
        },
        body: JSON.stringify({
          requestedBy: 'mx-autotest-desktop',
          requestId: `mx-autotest-release-${Date.now()}-${credential.leaseId}`
        })
      });
      const payload = objectRecord(await readJsonResponse(response, 512 * 1024, 'Launcher lease release'));
      if (objectRecord(payload.lease).status !== 'released') throw new Error('Server did not confirm released status');
      delete credentialVault.leaseCredentials[credential.leaseId];
    } catch {
      failures.push(credential.leaseId);
    }
  }
  return failures;
}

async function getPlatformSnapshot(): Promise<unknown> {
  const [discovery, me, apps, tasks, runs, runners] = await Promise.all([
    platformRequest('GET', '/api/v1'),
    platformRequest('GET', '/api/v1/auth/me'),
    platformRequest('GET', '/api/v1/apps'),
    platformRequest('GET', '/api/v1/tasks'),
    platformRequest('GET', '/api/v1/runs?limit=20'),
    platformRequest('GET', '/api/v1/runners')
  ]);
  return { discovery, me, apps, tasks, runs, runners };
}

async function runTask(input: unknown): Promise<unknown> {
  const record = objectRecord(input);
  const task: RunTaskInput = {
    taskId: requiredShortText(record.taskId, 'taskId'),
    ...(stringValue(record.caseFilter) ? { caseFilter: requiredCaseFilter(record.caseFilter) } : {})
  };
  return platformRequest(
    'POST',
    `/api/v1/tasks/${encodeURIComponent(task.taskId)}:run`,
    task.caseFilter ? { caseFilter: task.caseFilter } : {}
  );
}

async function platformRequest(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<unknown> {
  const state = requireRuntime();
  const allowed = (
    method === 'GET' && [
      '/api/v1',
      '/api/v1/auth/me',
      '/api/v1/apps',
      '/api/v1/tasks',
      '/api/v1/runs?limit=20',
      '/api/v1/runners'
    ].includes(pathname)
  ) || (
    method === 'POST'
    && /^\/api\/v1\/tasks\/[A-Za-z0-9._%~-]+:run$/.test(pathname)
  );
  if (!allowed) throw new Error('MX AutoTest platform operation is not allowlisted');
  if (state.connection.status !== 'network-ready') throw new Error('MX AutoTest network is not ready');
  if (!identityCanResume(state.identity, credentialVault.accessToken)) {
    credentialVault.accessToken = null;
    state.identity = emptyIdentity();
    pushEvent('Expired User Center session cleared before platform access');
    await saveRuntime();
    broadcastRuntime();
    throw new Error('User Center login has expired; sign in again');
  }
  const accessToken = requiredString(credentialVault.accessToken, 'User Center access token');
  const baseUrl = requiredString(state.config.platformServerUrl, 'MX_AUTOTEST_SERVER_URL');
  await assertBearerTransportAllowed(baseUrl);
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized) > MAX_PLATFORM_BODY_BYTES) {
    throw new Error('Platform request body exceeds the desktop bridge limit');
  }
  const response = await fetch(new URL(pathname, `${baseUrl}/`), {
    method,
    signal: AbortSignal.timeout(method === 'GET' ? 15_000 : 30_000),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(serialized ? { 'Content-Type': 'application/json' } : {})
    },
    ...(serialized ? { body: serialized } : {})
  });
  if (response.status === 401) {
    credentialVault.accessToken = null;
    state.identity = emptyIdentity();
    pushEvent('User Center session was rejected by MX AutoTest and has been cleared');
    await saveRuntime();
    broadcastRuntime();
  }
  return redactSecrets(await readJsonResponse(response, MAX_PLATFORM_RESPONSE_BYTES, 'MX AutoTest platform'));
}

async function assertBearerTransportAllowed(baseUrl: string): Promise<void> {
  const parsed = new URL(baseUrl);
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:') throw new Error('Bearer transport must use HTTP(S)');
  if (isLoopbackHost(parsed.hostname)) return;
  const state = requireRuntime();
  if (
    state.connection.status === 'network-ready'
    && parsed.hostname === state.connection.serviceVip
    && await probeOwnServiceVip(false)
  ) return;
  throw new Error('Bearer transport requires validated HTTPS, loopback, or the verified MX AutoTest service VIP');
}

async function readJsonResponse(response: Response, maxBytes: number, label: string): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`${label} response exceeds the desktop bridge limit`);
  const payload = text ? safeJson(text) : null;
  if (!response.ok) {
    const record = objectRecord(payload);
    throw new Error(`${label} failed: HTTP ${response.status} ${stringValue(record.message) || response.statusText}`);
  }
  return payload;
}

function registerIpc(): void {
  ipcMain.handle(`${IPC_PREFIX}:get-runtime`, (event) => {
    assertTrustedRenderer(event);
    return visibleRuntime();
  });
  ipcMain.handle(`${IPC_PREFIX}:connect-internal`, (event) => {
    assertTrustedRenderer(event);
    return runSessionExclusive(async () => {
      if (!await connectInternalLocked()) throw new Error(requireRuntime().connection.message);
      return visibleRuntime();
    });
  });
  ipcMain.handle(`${IPC_PREFIX}:login`, (event, input) => {
    assertTrustedRenderer(event);
    return runSessionExclusive(async () => {
      try {
        await loginLocked(input);
      } catch (error) {
        const message = safeErrorMessage(error);
        pushEvent(`login failed: ${message}`);
        await saveRuntime().catch(() => undefined);
        broadcastRuntime();
        throw new Error(message);
      }
      broadcastRuntime();
      return visibleRuntime();
    });
  });
  ipcMain.handle(`${IPC_PREFIX}:logout`, (event) => {
    assertTrustedRenderer(event);
    return runSessionExclusive(async () => {
      await logoutLocked();
      if (requireRuntime().connection.status === 'error') {
        throw new Error(requireRuntime().connection.message);
      }
      return visibleRuntime();
    });
  });
  ipcMain.handle(`${IPC_PREFIX}:disconnect`, (event) => {
    assertTrustedRenderer(event);
    return runSessionExclusive(async () => {
      if (!await disconnectLocked('manual')) throw new Error(requireRuntime().connection.message);
      return visibleRuntime();
    });
  });
  ipcMain.handle(`${IPC_PREFIX}:get-platform-snapshot`, async (event) => {
    assertTrustedRenderer(event);
    return getPlatformSnapshot();
  });
  ipcMain.handle(`${IPC_PREFIX}:run-task`, async (event, input) => {
    assertTrustedRenderer(event);
    return runTask(input);
  });
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender.id !== mainWindow.webContents.id
    || event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('IPC request did not originate from the MX AutoTest window');
  }
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
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: 'MX AutoTest',
    backgroundColor: '#10141f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: 'persist:mx-autotest',
      preload: resolvePreloadPath()
    }
  });
  mainWindow = window;
  window.once('ready-to-show', () => {
    window.show();
    broadcastRuntime();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  if (process.env.DEV) {
    await window.loadURL(process.env.APP_URL || 'http://127.0.0.1:9032');
  } else {
    await window.loadFile(path.join(currentDir, 'index.html'));
  }
}

function wireGuardServiceIdentity() {
  return {
    displayName: 'MX AutoTest WireGuard',
    darwinLaunchDaemonLabelPrefix: 'com.qpjoy.mx-autotest.wireguard',
    darwinSupportRoot: '/Library/Application Support/QPJoy/MX-AutoTest',
    darwinLogDir: '/Library/Logs/QPJoy-MX-AutoTest',
    darwinDaemonScriptName: 'mx-autotest-wireguard-daemon.sh',
    staleDarwinLaunchDaemonLabelPrefixes: ['com.qpjoy.mx-autotest.wireguard']
  };
}

function ownershipOwnerId(): string {
  return `${PRODUCT_ID}:${requireRuntime().installId}`;
}

function normalizeIdentity(input: unknown): RuntimeIdentity {
  const record = objectRecord(input);
  if (record.kind !== 'user') return emptyIdentity();
  const userId = stringValue(record.userId);
  if (!userId) return emptyIdentity();
  return {
    kind: 'user',
    userId,
    displayName: stringValue(record.displayName),
    account: stringValue(record.account),
    scopes: uniqueStrings(Array.isArray(record.scopes) ? record.scopes.map(String) : []),
    tokenExpiresAt: stringValue(record.tokenExpiresAt),
    loginAt: stringValue(record.loginAt)
  };
}

function identityCanResume(identity: RuntimeIdentity, accessToken: string | null): boolean {
  if (identity.kind !== 'user' || !identity.userId || !accessToken) return false;
  if (!identity.tokenExpiresAt) return true;
  const expiresAt = Date.parse(identity.tokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 30_000;
}

function normalizeConnection(input: unknown): RuntimeConnection {
  const record = objectRecord(input);
  const status = isConnectionStatus(record.status) ? record.status : 'idle';
  const dataPlane = objectRecord(record.dataPlane);
  return {
    status,
    bootstrapBaseUrl: normalizeBaseUrl(record.bootstrapBaseUrl) || null,
    internalBaseUrl: normalizeBaseUrl(record.internalBaseUrl) || null,
    leaseId: stringValue(record.leaseId),
    leaseIp: stringValue(record.leaseIp),
    serviceVip: stringValue(record.serviceVip),
    routeCidrs: uniqueStrings(Array.isArray(record.routeCidrs) ? record.routeCidrs.map(String) : []),
    snapshotDigest: stringValue(record.snapshotDigest),
    dataPlane: typeof dataPlane.state === 'string' && typeof dataPlane.message === 'string'
      ? dataPlane as unknown as ElectronLauncherStandaloneDataPlaneDiagnostics
      : null,
    message: stringValue(record.message) || 'Runtime loaded.',
    updatedAt: stringValue(record.updatedAt)
  };
}

function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return [
    'idle',
    'resolving-bootstrap',
    'enrolling',
    'lease-active',
    'applying-data-plane',
    'data-plane-pending',
    'network-ready',
    'disconnecting',
    'error'
  ].includes(String(value));
}

function normalizeBaseUrl(input: unknown): string | null {
  const value = stringValue(input);
  if (!value) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizePort(input: unknown): number | null {
  const value = Number(input);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : null;
}

function safeRuntimeId(input: unknown, prefix: string): string | null {
  const value = stringValue(input);
  return value && value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function environmentValue(name: string): string | undefined {
  return process.env[name];
}

function booleanish(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function objectRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function stringValue(input: unknown): string | null {
  return typeof input === 'string' && input.trim() ? input.trim() : null;
}

function requiredString(input: unknown, label: string): string {
  const value = stringValue(input);
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function requiredShortText(input: unknown, label: string): string {
  const value = requiredString(input, label);
  if (value.length > 160 || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new Error(`${label} contains unsupported characters or is too long`);
  }
  return value;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requiredCaseFilter(input: unknown): string {
  const value = requiredString(input, 'caseFilter');
  if (value.length > 1_000) throw new Error('caseFilter is too long');
  return value;
}

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redactSecrets(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = /(password|secret|token|authorization|credential|capability|private.?key)/i.test(key)
      ? '[redacted]'
      : redactSecrets(item, depth + 1);
  }
  return output;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/("?(?:password|secret|token|capability|privateKey)"?\s*[:=]\s*)[^\s,;}]+/gi, '$1[redacted]')
    .slice(0, 1_000);
}

async function shutdownApplication(): Promise<void> {
  const stopped = await runSessionExclusive(() => disconnectLocked('shutdown'));
  if (!stopped) throw new Error('MX AutoTest could not verify its local network cleanup');
  await runtimeSaveQueue.catch(() => undefined);
}

app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) return;
  const envResult = loadElectronLauncherEnvFiles([
    path.join(app.getPath('userData'), '.env'),
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
    path.join(app.getAppPath(), '.env'),
    path.resolve(currentDir, '..', '..', '.env')
  ]);
  if (envResult.loadedFrom) {
    console.log(`[mx-autotest] env loaded from ${envResult.loadedFrom}`);
  }
  runtime = await loadRuntime();
  await saveRuntime().catch((error) => {
    console.warn('[mx-autotest] initial runtime persistence failed:', safeErrorMessage(error));
  });
  registerIpc();
  await createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (!ownsSingleInstanceLock || shutdownComplete) return;
  event.preventDefault();
  if (shutdownInFlight) return;
  shutdownInFlight = shutdownApplication()
    .then(() => {
      shutdownComplete = true;
      app.quit();
    })
    .catch((error) => {
      console.error('[mx-autotest] shutdown cleanup blocked exit:', safeErrorMessage(error));
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    })
    .finally(() => {
      if (!shutdownComplete) shutdownInFlight = null;
    });
});
