import {
  brokerAbiVersion,
  createLauncherEmbedManifest,
  createLauncherClient,
  createLauncherNetworkSession,
  launcherEmbedRuntimeContractVersion,
  launcherBrokerCompatibility,
  launcherProtocolVersion,
  routePlanFromSnapshot,
  shouldRefreshNetwork,
  type AnonymousEnrollment,
  type AnonymousEnrollmentRequest,
  type LauncherBrokerCapabilitySession,
  type LauncherBrokerHandshakeDeniedReason,
  type LauncherBrokerHandshakeRequest,
  type LauncherCapability,
  type LauncherChannelRecord,
  type LauncherClient,
  type LauncherClientOptions,
  type LauncherEmbedConnectionState,
  type LauncherManifest,
  type LauncherNetworkLease,
  type LauncherNetworkLeaseInput,
  type LauncherNetworkSession,
  type LauncherNetworkSnapshot,
  type LauncherNetworkSnapshotInput,
  type LauncherProductNetwork,
  type LauncherRoutePlan,
  type LauncherWireGuardKeyPair,
  type LauncherWireGuardKeyProvider
} from '@qpjoy/mx-launcher-core';

export interface EmbedLauncherOptions extends LauncherClientOptions {
  productId?: string;
  appId?: string;
  standaloneChannelProductId?: string;
  requiredCapabilities?: LauncherCapability[];
  sdkVersion?: string;
  appVersion?: string;
  displayName?: string;
  description?: string;
  packageName?: string;
  category?: string;
  protocolVersion?: string;
  minBrokerAbiVersion?: string;
  runtimeContractVersion?: string;
  launchWithoutBroker?: 'blocked' | 'prompt-open-standalone';
  channelRegistry?: LauncherChannelRegistrySource;
  maxChannelHeartbeatAgeMs?: number;
  requestImpl?: EmbedBrokerRequestHandler;
  installId?: string;
  deviceId?: string;
  siteId?: string;
  publicKey?: string;
  privateKey?: string;
  keyPair?: LauncherWireGuardKeyPair;
  keyProvider?: LauncherWireGuardKeyProvider;
  deviceLabel?: string;
}

export interface EmbedSnapshotOptions
  extends Omit<LauncherNetworkSnapshotInput, 'appId' | 'launcherMode' | 'installId' | 'deviceId' | 'siteId' | 'publicKey'> {
  installId?: string;
  deviceId?: string;
  siteId?: string | null;
  publicKey?: string | null;
}

export interface EmbedLeaseOptions
  extends Omit<LauncherNetworkLeaseInput, 'productId' | 'mode' | 'installId' | 'deviceId' | 'siteId' | 'publicKey'> {
  installId?: string;
  deviceId?: string;
  siteId?: string | null;
  publicKey?: string | null;
}

export interface EmbedNetworkSessionOptions extends EmbedLeaseOptions {
  privateKey?: string | null;
  keyPair?: LauncherWireGuardKeyPair | null;
  keyProvider?: LauncherWireGuardKeyProvider | null;
  snapshotRequestId?: string | null;
}

export type LauncherChannelRegistrySource =
  | LauncherChannelRecord[]
  | (() => LauncherChannelRecord[] | Promise<LauncherChannelRecord[]>);

export type EmbedBrokerRequestHandler = (
  session: LauncherBrokerCapabilitySession,
  requestName: string,
  payload?: unknown
) => unknown | Promise<unknown>;

export interface EmbedConnectOptions
  extends Omit<AnonymousEnrollmentRequest, 'productId' | 'platform' | 'installId' | 'deviceId' | 'siteId' | 'publicKey'> {
  installId?: string;
  deviceId?: string;
  siteId?: string;
  publicKey?: string;
  platform?: string;
}

export interface EmbedConnectionResult {
  enrollment: AnonymousEnrollment;
  snapshot: LauncherNetworkSnapshot;
  routePlan: LauncherRoutePlan;
}

export interface EmbedBrokerConnectOptions {
  requestedCapabilities?: LauncherCapability[];
  channelRegistry?: LauncherChannelRegistrySource;
  installId?: string | null;
  deviceId?: string | null;
  userId?: string | null;
  requestId?: string | null;
}

export interface EmbedLauncherConnection {
  ok: boolean;
  state: LauncherEmbedConnectionState;
  session: LauncherBrokerCapabilitySession | null;
  reason: LauncherBrokerHandshakeDeniedReason | null;
  message: string;
  channel: LauncherChannelRecord | null;
  missingCapabilities: LauncherCapability[];
}

export type EmbedLauncherEventName =
  | 'broker.connected'
  | 'broker.disconnected'
  | 'auth.changed'
  | 'capability.changed'
  | 'network.ready'
  | 'network.blocked'
  | 'release.available'
  | 'app.install.progress'
  | 'app.updated';

export type EmbedLauncherEventHandler = (event: {
  name: EmbedLauncherEventName;
  state: LauncherEmbedConnectionState;
  session: LauncherBrokerCapabilitySession | null;
  payload?: unknown;
}) => void;

export interface EmbedLegacyNetworkApi {
  getProduct(): Promise<LauncherProductNetwork>;
  enrollLease(options?: EmbedLeaseOptions): Promise<LauncherNetworkLease>;
  connectNetwork(options?: EmbedNetworkSessionOptions): Promise<LauncherNetworkSession>;
  createSnapshot(options?: EmbedSnapshotOptions): Promise<LauncherNetworkSnapshot>;
  createRoutePlan(options?: EmbedSnapshotOptions): Promise<LauncherRoutePlan>;
  connectAnonymous(options?: EmbedConnectOptions): Promise<EmbedConnectionResult>;
}

export interface EmbedLauncher {
  readonly mode: 'embed';
  readonly productId: string;
  readonly appId: string;
  readonly standaloneChannelProductId: string;
  readonly requiredCapabilities: LauncherCapability[];
  readonly manifest: LauncherManifest;
  readonly client: LauncherClient;
  readonly legacyNetwork: EmbedLegacyNetworkApi;
  connect(options?: EmbedBrokerConnectOptions): Promise<EmbedLauncherConnection>;
  request<T = unknown>(requestName: string, payload?: unknown): Promise<T>;
  on(eventName: EmbedLauncherEventName, handler: EmbedLauncherEventHandler): () => void;
  off(eventName: EmbedLauncherEventName, handler: EmbedLauncherEventHandler): void;
  shouldRefreshNetwork: typeof shouldRefreshNetwork;
}

export function createEmbedLauncher(options: EmbedLauncherOptions): EmbedLauncher {
  const productId = requiredProductId(options.productId ?? options.appId);
  const appId = requiredProductId(options.appId ?? options.productId);
  const standaloneChannelProductId = normalizeProductId(options.standaloneChannelProductId ?? 'mx-h2i');
  const requiredCapabilities = uniqueCapabilities(options.requiredCapabilities ?? ['user.session']);
  const client = createLauncherClient(options);
  const manifest = createLauncherEmbedManifest({
    appId,
    productId,
    displayName: options.displayName,
    description: options.description,
    packageName: options.packageName,
    category: options.category,
    sdkVersion: options.sdkVersion,
    appVersion: options.appVersion,
    protocolVersion: options.protocolVersion,
    sdkAbiVersion: options.minBrokerAbiVersion ?? brokerAbiVersion,
    runtimeContractVersion: options.runtimeContractVersion ?? launcherEmbedRuntimeContractVersion,
    standaloneChannelProductId,
    launchWithoutBroker: options.launchWithoutBroker,
    requiredCapabilities
  });
  const handlers = new Map<EmbedLauncherEventName, Set<EmbedLauncherEventHandler>>();
  let currentState: LauncherEmbedConnectionState = 'idle';
  let currentSession: LauncherBrokerCapabilitySession | null = null;

  async function createSnapshot(input: EmbedSnapshotOptions = {}): Promise<LauncherNetworkSnapshot> {
    return client.createSnapshot({
      ...input,
      appId: productId,
      launcherMode: 'embed',
      installId: input.installId ?? options.installId,
      deviceId: input.deviceId ?? options.deviceId,
      siteId: input.siteId ?? options.siteId,
      publicKey: input.publicKey ?? options.publicKey
    });
  }

  async function enrollLease(input: EmbedLeaseOptions = {}): Promise<LauncherNetworkLease> {
    return client.enrollLease({
      ...input,
      appId: input.appId ?? productId,
      productId,
      mode: 'embed',
      installId: input.installId ?? options.installId,
      deviceId: input.deviceId ?? options.deviceId,
      siteId: input.siteId ?? options.siteId,
      publicKey: input.publicKey ?? options.publicKey,
      deviceLabel: input.deviceLabel ?? options.deviceLabel,
      requestedBy: input.requestedBy ?? 'embed-sdk'
    });
  }

  async function connectNetwork(input: EmbedNetworkSessionOptions = {}): Promise<LauncherNetworkSession> {
    return createLauncherNetworkSession(client, {
      ...input,
      productId,
      appId: productId,
      mode: 'embed',
      launcherMode: 'embed',
      installId: input.installId ?? options.installId,
      deviceId: input.deviceId ?? options.deviceId,
      siteId: input.siteId ?? options.siteId,
      publicKey: input.publicKey ?? options.publicKey,
      privateKey: input.privateKey ?? options.privateKey,
      keyPair: input.keyPair ?? options.keyPair,
      keyProvider: input.keyProvider ?? options.keyProvider,
      deviceLabel: input.deviceLabel ?? options.deviceLabel,
      requestedBy: input.requestedBy ?? 'embed-sdk'
    });
  }

  function setState(state: LauncherEmbedConnectionState, eventName: EmbedLauncherEventName, payload?: unknown): void {
    currentState = state;
    emit(eventName, payload);
  }

  function emit(name: EmbedLauncherEventName, payload?: unknown): void {
    const event = { name, state: currentState, session: currentSession, payload };
    for (const handler of handlers.get(name) ?? []) handler(event);
  }

  const legacyNetwork: EmbedLegacyNetworkApi = {
    getProduct() {
      return client.getProduct(productId);
    },

    enrollLease,
    connectNetwork,
    createSnapshot,

    async createRoutePlan(input) {
      return routePlanFromSnapshot(await createSnapshot(input));
    },

    async connectAnonymous(input = {}) {
      const enrollment = await client.enrollAnonymous({
        ...input,
        productId,
        platform: input.platform ?? 'embed',
        installId: input.installId ?? options.installId,
        deviceId: input.deviceId ?? options.deviceId,
        siteId: input.siteId ?? options.siteId,
        publicKey: input.publicKey ?? options.publicKey,
        deviceLabel: input.deviceLabel ?? options.deviceLabel,
        relayMode: input.relayMode ?? 'h2i'
      });
      const snapshot = await createSnapshot({
        installId: enrollment.installId,
        deviceId: enrollment.deviceId,
        siteId: enrollment.siteId,
        publicKey: enrollment.publicKey ?? input.publicKey ?? options.publicKey,
        requestId: input.requestId
      });
      return {
        enrollment,
        snapshot,
        routePlan: routePlanFromSnapshot(snapshot)
      };
    }
  };

  const launcher: EmbedLauncher = {
    mode: 'embed',
    productId,
    appId,
    standaloneChannelProductId,
    requiredCapabilities,
    manifest,
    client,
    legacyNetwork,

    async connect(input = {}) {
      setState('discovering-broker', 'broker.disconnected');
      const requestedCapabilities = uniqueCapabilities(input.requestedCapabilities ?? requiredCapabilities);
      const registry = await resolveChannelRegistry(input.channelRegistry ?? options.channelRegistry);
      const channel = registry.find((record) => normalizeProductId(record.productId) === standaloneChannelProductId && channelIsFresh(record, options.maxChannelHeartbeatAgeMs)) ?? null;
      if (!channel) {
        currentSession = null;
        setState('standalone-required', 'network.blocked', { standaloneChannelProductId });
        return deniedConnection('standalone-required', `Open ${standaloneChannelProductId} before launching ${appId}.`, null, []);
      }

      const request = buildHandshakeRequest({
        appId,
        productId,
        standaloneChannelProductId,
        requestedCapabilities,
        options,
        input
      });
      const compatibility = launcherBrokerCompatibility({
        embedProtocolVersion: request.protocolVersion,
        brokerProtocolVersion: channel.protocolVersion,
        minBrokerAbiVersion: request.minBrokerAbiVersion,
        brokerAbiVersion: channel.brokerAbiVersion
      });
      if (!compatibility.compatible) {
        currentSession = null;
        setState('broker-incompatible', 'network.blocked', compatibility);
        return deniedConnection('broker-incompatible', compatibility.message, channel, []);
      }

      const missingCapabilities = requestedCapabilities.filter((capability) => !channel.capabilities.includes(capability));
      if (missingCapabilities.length) {
        currentSession = null;
        setState('capability-denied', 'capability.changed', { missingCapabilities });
        return deniedConnection('capability-denied', `Broker channel ${channel.productId} does not grant: ${missingCapabilities.join(', ')}.`, channel, missingCapabilities);
      }

      const session = buildBrokerSession({
        appId,
        productId,
        standaloneChannelProductId,
        channel,
        grantedCapabilities: requestedCapabilities,
        installId: input.installId ?? options.installId ?? null,
        deviceId: input.deviceId ?? options.deviceId ?? null,
        userId: input.userId ?? null
      });
      currentSession = session;
      setState('connected', 'broker.connected', session);
      if (requestedCapabilities.includes('network.status') || requestedCapabilities.includes('network.proxy')) {
        setState('network-ready', 'network.ready', session);
      }
      return {
        ok: true,
        state: currentState,
        session,
        reason: null,
        message: 'Connected to standalone broker channel.',
        channel,
        missingCapabilities: []
      };
    },

    async request<T = unknown>(requestName: string, payload?: unknown): Promise<T> {
      if (!currentSession) {
        throw new Error('Embed launcher is not connected to a standalone broker');
      }
      if (!currentSession.grantedCapabilities.includes(requestName as LauncherCapability)) {
        throw new Error(`Capability is not granted for embed broker session: ${requestName}`);
      }
      if (!options.requestImpl) {
        throw new Error('No embed broker request transport is configured');
      }
      return options.requestImpl(currentSession, requestName, payload) as Promise<T>;
    },

    on(eventName, handler) {
      const set = handlers.get(eventName) ?? new Set<EmbedLauncherEventHandler>();
      set.add(handler);
      handlers.set(eventName, set);
      return () => launcher.off(eventName, handler);
    },

    off(eventName, handler) {
      handlers.get(eventName)?.delete(handler);
    },

    shouldRefreshNetwork
  };

  return launcher;
}

export { routePlanFromSnapshot, shouldRefreshNetwork };

function requiredProductId(productId: string | undefined): string {
  const trimmed = productId?.trim();
  if (!trimmed) throw new Error('Embed launcher productId is required');
  return trimmed;
}

function normalizeProductId(productId: string): string {
  const normalized = productId.trim().toLowerCase();
  if (!normalized) throw new Error('Launcher productId is required');
  return normalized;
}

function uniqueCapabilities(capabilities: LauncherCapability[]): LauncherCapability[] {
  return [...new Set(capabilities.map((capability) => String(capability || '').trim()).filter(Boolean))] as LauncherCapability[];
}

async function resolveChannelRegistry(source: LauncherChannelRegistrySource | undefined): Promise<LauncherChannelRecord[]> {
  if (!source) return [];
  const records = typeof source === 'function' ? await source() : source;
  return records.filter((record) => record && record.productId && record.socketPath);
}

function channelIsFresh(record: LauncherChannelRecord, maxAgeMs: number | undefined): boolean {
  if (!maxAgeMs || maxAgeMs <= 0) return true;
  const heartbeat = Date.parse(record.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return false;
  return Date.now() - heartbeat <= maxAgeMs;
}

function buildHandshakeRequest(input: {
  appId: string;
  productId: string;
  standaloneChannelProductId: string;
  requestedCapabilities: LauncherCapability[];
  options: EmbedLauncherOptions;
  input: EmbedBrokerConnectOptions;
}): LauncherBrokerHandshakeRequest {
  return {
    appId: input.appId,
    productId: input.productId,
    launcherMode: 'embed',
    sdkVersion: input.options.sdkVersion,
    appVersion: input.options.appVersion,
    protocolVersion: input.options.protocolVersion ?? launcherProtocolVersion,
    minBrokerAbiVersion: input.options.minBrokerAbiVersion ?? brokerAbiVersion,
    standaloneChannelProductId: input.standaloneChannelProductId,
    requestedCapabilities: input.requestedCapabilities,
    installId: input.input.installId ?? input.options.installId ?? null,
    deviceId: input.input.deviceId ?? input.options.deviceId ?? null,
    userId: input.input.userId ?? null,
    requestId: input.input.requestId ?? null
  };
}

function buildBrokerSession(input: {
  appId: string;
  productId: string;
  standaloneChannelProductId: string;
  channel: LauncherChannelRecord;
  grantedCapabilities: LauncherCapability[];
  installId: string | null;
  deviceId: string | null;
  userId: string | null;
}): LauncherBrokerCapabilitySession {
  return {
    sessionId: `embed_${input.appId}_${input.channel.instanceId}`,
    appId: input.appId,
    productId: input.productId,
    launcherMode: 'embed',
    networkScope: 'broker-session',
    standaloneChannelProductId: input.standaloneChannelProductId,
    channel: input.channel,
    grantedCapabilities: input.grantedCapabilities,
    deniedCapabilities: [],
    userId: input.userId,
    installId: input.installId,
    deviceId: input.deviceId,
    issuedAt: new Date().toISOString(),
    expiresAt: null
  };
}

function deniedConnection(
  reason: NonNullable<EmbedLauncherConnection['reason']>,
  message: string,
  channel: LauncherChannelRecord | null,
  missingCapabilities: LauncherCapability[]
): EmbedLauncherConnection {
  return {
    ok: false,
    state: reason === 'broker-incompatible' ? 'broker-incompatible' : reason === 'capability-denied' ? 'capability-denied' : 'standalone-required',
    session: null,
    reason,
    message,
    channel,
    missingCapabilities
  };
}
