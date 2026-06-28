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
  type LauncherProductNetworkInput,
  type LauncherRoutePlan,
  type LauncherWireGuardKeyPair,
  type LauncherWireGuardKeyProvider
} from '@qpjoy/mx-launcher-core';

export interface StandaloneLauncherOptions extends LauncherClientOptions {
  productId?: string;
  installId?: string;
  deviceId?: string;
  siteId?: string;
  publicKey?: string;
  privateKey?: string;
  keyPair?: LauncherWireGuardKeyPair;
  keyProvider?: LauncherWireGuardKeyProvider;
  deviceLabel?: string;
}

export interface StandaloneSnapshotOptions
  extends Omit<LauncherNetworkSnapshotInput, 'appId' | 'launcherMode' | 'installId' | 'deviceId' | 'siteId' | 'publicKey'> {
  installId?: string;
  deviceId?: string;
  siteId?: string | null;
  publicKey?: string | null;
}

export interface StandaloneLeaseOptions
  extends Omit<LauncherNetworkLeaseInput, 'productId' | 'mode' | 'installId' | 'deviceId' | 'siteId' | 'publicKey'> {
  installId?: string;
  deviceId?: string;
  siteId?: string | null;
  publicKey?: string | null;
}

export interface StandaloneNetworkSessionOptions extends StandaloneLeaseOptions {
  privateKey?: string | null;
  keyPair?: LauncherWireGuardKeyPair | null;
  keyProvider?: LauncherWireGuardKeyProvider | null;
  snapshotRequestId?: string | null;
}

export interface StandaloneConnectOptions
  extends Omit<AnonymousEnrollmentRequest, 'productId' | 'platform' | 'installId' | 'deviceId' | 'siteId' | 'publicKey'> {
  installId?: string;
  deviceId?: string;
  siteId?: string;
  publicKey?: string;
  platform?: string;
}

export interface StandaloneUserConnectOptions extends StandaloneSnapshotOptions {
  userId: string;
}

export interface StandaloneConnectionResult {
  enrollment: AnonymousEnrollment;
  snapshot: LauncherNetworkSnapshot;
  routePlan: LauncherRoutePlan;
}

export interface StandaloneLauncher {
  readonly mode: 'standalone';
  readonly productId: string;
  readonly client: LauncherClient;
  listProducts(): Promise<LauncherProductNetwork[]>;
  getProduct(productId?: string): Promise<LauncherProductNetwork>;
  upsertProduct(productId: string, input: LauncherProductNetworkInput): Promise<LauncherProductNetwork>;
  enrollLease(options?: StandaloneLeaseOptions): Promise<LauncherNetworkLease>;
  connectNetwork(options?: StandaloneNetworkSessionOptions): Promise<LauncherNetworkSession>;
  createSnapshot(options?: StandaloneSnapshotOptions): Promise<LauncherNetworkSnapshot>;
  createRoutePlan(options?: StandaloneSnapshotOptions): Promise<LauncherRoutePlan>;
  connectAnonymous(options?: StandaloneConnectOptions): Promise<StandaloneConnectionResult>;
  connectUser(options: StandaloneUserConnectOptions): Promise<{ snapshot: LauncherNetworkSnapshot; routePlan: LauncherRoutePlan }>;
  shouldRefreshNetwork: typeof shouldRefreshNetwork;
}

export function createStandaloneLauncher(options: StandaloneLauncherOptions): StandaloneLauncher {
  const productId = normalizeStandaloneProductId(options.productId);
  const client = createLauncherClient(options);

  async function createSnapshot(input: StandaloneSnapshotOptions = {}): Promise<LauncherNetworkSnapshot> {
    return client.createSnapshot({
      ...input,
      appId: productId,
      launcherMode: 'standalone',
      installId: input.installId ?? options.installId,
      deviceId: input.deviceId ?? options.deviceId,
      siteId: input.siteId ?? options.siteId,
      publicKey: input.publicKey ?? options.publicKey
    });
  }

  async function enrollLease(input: StandaloneLeaseOptions = {}): Promise<LauncherNetworkLease> {
    return client.enrollLease({
      ...input,
      appId: input.appId ?? productId,
      productId,
      mode: 'standalone',
      installId: input.installId ?? options.installId,
      deviceId: input.deviceId ?? options.deviceId,
      siteId: input.siteId ?? options.siteId,
      publicKey: input.publicKey ?? options.publicKey,
      deviceLabel: input.deviceLabel ?? options.deviceLabel,
      requestedBy: input.requestedBy ?? 'standalone-sdk'
    });
  }

  async function connectNetwork(input: StandaloneNetworkSessionOptions = {}): Promise<LauncherNetworkSession> {
    return createLauncherNetworkSession(client, {
      ...input,
      productId,
      appId: productId,
      mode: 'standalone',
      launcherMode: 'standalone',
      installId: input.installId ?? options.installId,
      deviceId: input.deviceId ?? options.deviceId,
      siteId: input.siteId ?? options.siteId,
      publicKey: input.publicKey ?? options.publicKey,
      privateKey: input.privateKey ?? options.privateKey,
      keyPair: input.keyPair ?? options.keyPair,
      keyProvider: input.keyProvider ?? options.keyProvider,
      deviceLabel: input.deviceLabel ?? options.deviceLabel,
      requestedBy: input.requestedBy ?? 'standalone-sdk'
    });
  }

  return {
    mode: 'standalone',
    productId,
    client,

    listProducts() {
      return client.listProducts();
    },

    getProduct(targetProductId = productId) {
      return client.getProduct(targetProductId);
    },

    upsertProduct(targetProductId, input) {
      return client.upsertProduct(targetProductId, input);
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
        platform: input.platform ?? 'standalone',
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

    async connectUser(input) {
      const snapshot = await createSnapshot(input);
      return {
        snapshot,
        routePlan: routePlanFromSnapshot(snapshot)
      };
    },

    shouldRefreshNetwork
  };
}

export { routePlanFromSnapshot, shouldRefreshNetwork };

function normalizeStandaloneProductId(productId: string | undefined): string {
  const trimmed = (productId ?? 'launcher').trim();
  if (!trimmed) throw new Error('Standalone launcher productId is required');
  return trimmed;
}
