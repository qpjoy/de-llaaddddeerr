import {
  createLauncherClient,
  createLauncherNetworkSession,
  routePlanFromSnapshot,
  shouldRefreshNetwork,
  type AnonymousEnrollment,
  type AnonymousEnrollmentRequest,
  type LauncherClient,
  type LauncherClientOptions,
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
  productId: string;
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

export interface EmbedLauncher {
  readonly mode: 'embed';
  readonly productId: string;
  readonly client: LauncherClient;
  getProduct(): Promise<LauncherProductNetwork>;
  enrollLease(options?: EmbedLeaseOptions): Promise<LauncherNetworkLease>;
  connectNetwork(options?: EmbedNetworkSessionOptions): Promise<LauncherNetworkSession>;
  createSnapshot(options?: EmbedSnapshotOptions): Promise<LauncherNetworkSnapshot>;
  createRoutePlan(options?: EmbedSnapshotOptions): Promise<LauncherRoutePlan>;
  connectAnonymous(options?: EmbedConnectOptions): Promise<EmbedConnectionResult>;
  shouldRefreshNetwork: typeof shouldRefreshNetwork;
}

export function createEmbedLauncher(options: EmbedLauncherOptions): EmbedLauncher {
  const productId = requiredProductId(options.productId);
  const client = createLauncherClient(options);

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

  return {
    mode: 'embed',
    productId,
    client,

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
    },

    shouldRefreshNetwork
  };
}

export { routePlanFromSnapshot, shouldRefreshNetwork };

function requiredProductId(productId: string): string {
  const trimmed = productId.trim();
  if (!trimmed) throw new Error('Embed launcher productId is required');
  return trimmed;
}
