export type LauncherProductMode = 'standalone' | 'embed';
export type LauncherIdentityKind = 'user' | 'anonymous';
export type LauncherProductUpdatePolicy = 'launcher-managed' | 'app-managed' | 'host-managed';

export interface LauncherClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
}

export type FetchLike = (input: string, init?: FetchInitLike) => Promise<ResponseLike>;

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export interface LauncherWireGuardKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface LauncherWireGuardKeyMaterial {
  privateKey: string | null;
  publicKey: string;
  source: 'generated' | 'provider' | 'provided-private-key' | 'provided-public-key';
}

export type LauncherWireGuardKeyProvider = () => LauncherWireGuardKeyPair | Promise<LauncherWireGuardKeyPair>;

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

export interface LauncherNetworkSessionInput extends LauncherNetworkLeaseInput {
  appId?: string | null;
  launcherMode?: LauncherProductMode | string | null;
  privateKey?: string | null;
  keyPair?: LauncherWireGuardKeyPair | null;
  keyProvider?: LauncherWireGuardKeyProvider | null;
  snapshotRequestId?: string | null;
}

export interface LauncherProductNetworkInput {
  productId?: string | null;
  displayName?: string | null;
  mode?: LauncherProductMode | string | null;
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
  status: 'active';
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
  homeLease: {
    mode: 'guest' | 'user';
    ip: string;
    cidr: string;
  };
  domestic: {
    siteId: string;
    role: 'relay-proxy-cache-forwarder';
    publicIpRequired: true;
    gatewayIp: string;
    overlayCidrs: string[];
    configSource: 'internal-signed-snapshot';
    storesAuthority: false;
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
  };
  subscriptions: {
    mihomo: {
      authority: 'internal-config-center';
      siteId: string;
      baseUrl: string;
      fetchPath: string;
      reachableVia: string[];
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
      configArtifact: string;
      envArtifact: string;
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
      configArtifact: string;
      privateKeyPlacement: 'internal-only';
      direction: 'internal-outbound-to-domestic-public-wg';
    };
    internalDirectPeer?: {
      role: 'internal-direct-service';
      enabled: boolean;
      fixedIp: string;
      endpoint: string | null;
      listenPort: number;
      publicKey: string | null;
      allowedIps: string[];
      configArtifact: string;
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
  };
  gates: Record<string, boolean>;
}

export interface LauncherRoutePlan {
  productId: string;
  launcherMode: LauncherProductMode;
  identityKind: LauncherIdentityKind;
  leaseIp: string;
  leaseCidr: string;
  serviceVip: string;
  internalControlIp: string;
  internalBaseUrl: string;
  domesticGatewayIp: string;
  domesticRelayEndpoint: string | null;
  domesticRelayPublicKey: string | null;
  preferredPath: 'h2i-direct' | 'hdi-relay' | 'h2i-hybrid';
  h2iDirectEnabled: boolean;
  h2iDirectEndpoint: string | null;
  h2iDirectPublicKey: string | null;
  h2iDirectAllowedIps: string[];
  domesticSiteId: string;
  overseaSiteId: string;
  dnsServer: string;
  routeCidrs: string[];
  allowedIps: string[];
  updatePolicy: LauncherProductUpdatePolicy;
  rateLimitProfile: string;
  dnsPolicyId: string;
  licensePolicyId: string;
  snapshotId: string;
  snapshotDigest: string;
  materialDigest: string | null;
  secretUpdatedAt: string | null;
  refreshKey: string;
}

export interface LauncherNetworkSession {
  wireGuard: LauncherWireGuardKeyMaterial;
  lease: LauncherNetworkLease;
  snapshot: LauncherNetworkSnapshot;
  routePlan: LauncherRoutePlan;
}

export interface LauncherClient {
  listProducts(): Promise<LauncherProductNetwork[]>;
  getProduct(productId: string): Promise<LauncherProductNetwork>;
  upsertProduct(productId: string, input: LauncherProductNetworkInput): Promise<LauncherProductNetwork>;
  enrollLease(input: LauncherNetworkLeaseInput): Promise<LauncherNetworkLease>;
  createSnapshot(input: LauncherNetworkSnapshotInput): Promise<LauncherNetworkSnapshot>;
  enrollAnonymous(input: AnonymousEnrollmentRequest): Promise<AnonymousEnrollment>;
  getConfigSnapshot(installId: string): Promise<unknown>;
}

export class LauncherApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'LauncherApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function createLauncherClient(options: LauncherClientOptions): LauncherClient {
  const baseUrl = normalizeLauncherBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getGlobalFetch();

  return {
    async listProducts() {
      const payload = await requestJson<{ products: LauncherProductNetwork[] }>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/launcher-network/products'),
        'GET'
      );
      return payload.products;
    },

    async getProduct(productId) {
      const payload = await requestJson<{ product: LauncherProductNetwork }>(
        fetchImpl,
        joinUrl(baseUrl, `/internal/v1/launcher-network/products/${encodeURIComponent(productId)}`),
        'GET'
      );
      return payload.product;
    },

    async upsertProduct(productId, input) {
      const payload = await requestJson<{ product: LauncherProductNetwork }>(
        fetchImpl,
        joinUrl(baseUrl, `/internal/v1/launcher-network/products/${encodeURIComponent(productId)}`),
        'POST',
        { ...input, productId }
      );
      return payload.product;
    },

    async enrollLease(input) {
      const payload = await requestJson<{ lease: LauncherNetworkLease }>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/launcher-network/enrollments'),
        'POST',
        compactBody(input)
      );
      return payload.lease;
    },

    async createSnapshot(input) {
      const payload = await requestJson<{ snapshot: LauncherNetworkSnapshot }>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/launcher-network/snapshots'),
        'POST',
        compactBody(input)
      );
      return payload.snapshot;
    },

    async enrollAnonymous(input) {
      return requestJson<AnonymousEnrollment>(
        fetchImpl,
        joinUrl(baseUrl, '/internal/v1/enrollments/anonymous'),
        'POST',
        compactBody(input)
      );
    },

    async getConfigSnapshot(installId) {
      const payload = await requestJson<{ snapshot: unknown }>(
        fetchImpl,
        joinUrl(baseUrl, `/internal/v1/config/snapshots/${encodeURIComponent(installId)}`),
        'GET'
      );
      return payload.snapshot;
    }
  };
}

export async function createLauncherNetworkSession(
  client: LauncherClient,
  input: LauncherNetworkSessionInput = {}
): Promise<LauncherNetworkSession> {
  const wireGuard = await resolveWireGuardKeyMaterial(input);
  const productId = input.productId?.trim() || input.appId?.trim() || 'launcher';
  const mode = launcherProductMode(input.mode ?? input.launcherMode ?? (productId === 'launcher' ? 'standalone' : 'embed'));
  const lease = await client.enrollLease({
    appId: input.appId ?? productId,
    productId,
    mode,
    identityKind: input.identityKind,
    installId: input.installId,
    deviceId: input.deviceId,
    siteId: input.siteId,
    userId: input.userId,
    publicKey: wireGuard.publicKey,
    deviceLabel: input.deviceLabel,
    platform: input.platform,
    requestedBy: input.requestedBy ?? 'launcher-network-session',
    requestId: input.requestId,
    sdkTestMode: input.sdkTestMode
  });
  const snapshot = await client.createSnapshot({
    installId: lease.installId,
    deviceId: lease.deviceId,
    siteId: lease.siteId,
    userId: lease.userId,
    publicKey: wireGuard.publicKey,
    appId: lease.productId,
    launcherMode: lease.launcherMode,
    requestId: input.snapshotRequestId ?? input.requestId ?? undefined
  });
  return {
    wireGuard,
    lease,
    snapshot,
    routePlan: routePlanFromSnapshot(snapshot)
  };
}

export function createLauncherWireGuardKeyPair(): LauncherWireGuardKeyPair {
  const privateKey = randomWireGuardPrivateKey();
  return {
    privateKey,
    publicKey: wireGuardPublicKeyFromPrivateKey(privateKey)
  };
}

export function wireGuardPublicKeyFromPrivateKey(privateKey: string): string {
  const scalar = decodeBase64Key(privateKey, 'WireGuard private key');
  const clamped = clampWireGuardPrivateKey(scalar);
  const publicKey = x25519(clamped, basePointBytes());
  return bytesToBase64(publicKey);
}

export function routePlanFromSnapshot(snapshot: LauncherNetworkSnapshot): LauncherRoutePlan {
  const topology = snapshot.topology;
  const relayPlan = topology.relayPlan;
  const product = topology.product;
  const materialDigest = relayPlan.refreshHint.materialDigest;
  const secretUpdatedAt = relayPlan.refreshHint.secretUpdatedAt;

  return {
    productId: snapshot.overlayPolicy.productId,
    launcherMode: snapshot.overlayPolicy.launcherMode,
    identityKind: snapshot.overlayPolicy.identityKind,
    leaseIp: snapshot.overlayPolicy.leaseIp,
    leaseCidr: snapshot.overlayPolicy.cidr,
    serviceVip: product.serviceVip,
    internalControlIp: topology.internal.relayPeer.fixedIp,
    internalBaseUrl: topology.internal.baseUrl,
    domesticGatewayIp: topology.domestic.gatewayIp,
    domesticRelayEndpoint: relayPlan.domesticRelay.publicEndpoint ?? relayPlan.refreshHint.publicEndpoint ?? null,
    domesticRelayPublicKey: relayPlan.domesticRelay.publicKey ?? null,
    preferredPath: relayPlan.internalDirectPeer?.enabled && relayPlan.internalDirectPeer.endpoint && relayPlan.internalDirectPeer.publicKey
      ? 'h2i-hybrid'
      : 'hdi-relay',
    h2iDirectEnabled: relayPlan.internalDirectPeer?.enabled === true,
    h2iDirectEndpoint: relayPlan.internalDirectPeer?.endpoint ?? null,
    h2iDirectPublicKey: relayPlan.internalDirectPeer?.publicKey ?? null,
    h2iDirectAllowedIps: [...(relayPlan.internalDirectPeer?.allowedIps ?? relayPlan.routes.internalCidrs)],
    domesticSiteId: topology.domestic.siteId,
    overseaSiteId: topology.oversea.siteId,
    dnsServer: relayPlan.routes.dnsServer,
    routeCidrs: [...relayPlan.routes.internalCidrs],
    allowedIps: [...relayPlan.homePeer.allowedIps],
    updatePolicy: product.updatePolicy,
    rateLimitProfile: product.rateLimitProfile,
    dnsPolicyId: product.dnsPolicyId,
    licensePolicyId: product.licensePolicyId,
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.signatures.digest,
    materialDigest,
    secretUpdatedAt,
    refreshKey: networkRefreshKey(snapshot)
  };
}

export function networkDigest(snapshot: LauncherNetworkSnapshot): string {
  return snapshot.signatures.digest;
}

export function networkRefreshKey(value: LauncherNetworkSnapshot | LauncherRoutePlan | string): string {
  if (typeof value === 'string') return value;
  if ('refreshKey' in value) return value.refreshKey;
  return [
    value.signatures.digest,
    value.overlayPolicy.productId,
    value.overlayPolicy.launcherMode,
    value.overlayPolicy.identityKind,
    value.overlayPolicy.leaseIp,
    value.topology.product.serviceVip,
    value.topology.internal.relayPeer.fixedIp,
    value.topology.relayPlan.refreshHint.materialDigest ?? '',
    value.topology.relayPlan.refreshHint.secretUpdatedAt ?? ''
  ].join('|');
}

export function shouldRefreshNetwork(
  previous: LauncherNetworkSnapshot | LauncherRoutePlan | string | null | undefined,
  next: LauncherNetworkSnapshot | LauncherRoutePlan | string | null | undefined
): boolean {
  if (!next) return false;
  if (!previous) return true;
  return networkRefreshKey(previous) !== networkRefreshKey(next);
}

export function normalizeLauncherBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('Launcher baseUrl is required');
  return trimmed.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function resolveWireGuardKeyMaterial(input: LauncherNetworkSessionInput): Promise<LauncherWireGuardKeyMaterial> {
  if (input.keyPair) {
    const privateKey = normalizeWireGuardPrivateKey(input.keyPair.privateKey);
    const publicKey = wireGuardPublicKeyFromPrivateKey(privateKey);
    assertMatchingPublicKey(input.keyPair.publicKey, publicKey);
    return { privateKey, publicKey, source: 'provider' };
  }
  if (input.keyProvider) {
    const keyPair = await input.keyProvider();
    const privateKey = normalizeWireGuardPrivateKey(keyPair.privateKey);
    const publicKey = wireGuardPublicKeyFromPrivateKey(privateKey);
    assertMatchingPublicKey(keyPair.publicKey, publicKey);
    return { privateKey, publicKey, source: 'provider' };
  }
  if (input.privateKey) {
    const privateKey = normalizeWireGuardPrivateKey(input.privateKey);
    const publicKey = wireGuardPublicKeyFromPrivateKey(privateKey);
    if (input.publicKey) assertMatchingPublicKey(input.publicKey, publicKey);
    return { privateKey, publicKey, source: 'provided-private-key' };
  }
  if (input.publicKey) {
    return {
      privateKey: null,
      publicKey: normalizeWireGuardPublicKey(input.publicKey),
      source: 'provided-public-key'
    };
  }
  const keyPair = createLauncherWireGuardKeyPair();
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    source: 'generated'
  };
}

function launcherProductMode(value: LauncherProductMode | string | null | undefined): LauncherProductMode {
  return value === 'standalone' ? 'standalone' : 'embed';
}

function randomWireGuardPrivateKey(): string {
  return bytesToBase64(clampWireGuardPrivateKey(randomBytes32()));
}

function normalizeWireGuardPrivateKey(value: string): string {
  return bytesToBase64(clampWireGuardPrivateKey(decodeBase64Key(value, 'WireGuard private key')));
}

function normalizeWireGuardPublicKey(value: string): string {
  return bytesToBase64(decodeBase64Key(value, 'WireGuard public key'));
}

function assertMatchingPublicKey(provided: string | null | undefined, expected: string): void {
  if (!provided) return;
  if (normalizeWireGuardPublicKey(provided) !== expected) {
    throw new Error('WireGuard publicKey does not match privateKey');
  }
}

function randomBytes32(): Uint8Array {
  const cryptoLike = (globalThis as { crypto?: { getRandomValues<T extends Uint8Array>(array: T): T } }).crypto;
  if (!cryptoLike?.getRandomValues) {
    throw new Error('Secure random generator is not available for WireGuard key generation');
  }
  return cryptoLike.getRandomValues(new Uint8Array(32));
}

function decodeBase64Key(value: string, label: string): Uint8Array {
  const trimmed = value.trim();
  const bufferFactory = (globalThis as {
    Buffer?: {
      from(input: string, encoding: string): { length: number; [index: number]: number };
    };
  }).Buffer;
  if (bufferFactory?.from) {
    const buffer = bufferFactory.from(trimmed, 'base64');
    const bytes = new Uint8Array(buffer.length);
    for (let index = 0; index < buffer.length; index += 1) bytes[index] = buffer[index];
    if (bytes.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
    return bytes;
  }
  const atobFn = (globalThis as { atob?: (input: string) => string }).atob;
  if (!atobFn) throw new Error('Base64 decoder is not available');
  const binary = atobFn(trimmed);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const bufferFactory = (globalThis as {
    Buffer?: {
      from(input: Uint8Array): { toString(encoding: string): string };
    };
  }).Buffer;
  if (bufferFactory?.from) return bufferFactory.from(bytes).toString('base64');
  const btoaFn = (globalThis as { btoa?: (input: string) => string }).btoa;
  if (!btoaFn) throw new Error('Base64 encoder is not available');
  return btoaFn(String.fromCharCode(...bytes));
}

function clampWireGuardPrivateKey(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) throw new Error('WireGuard private key must be 32 bytes');
  const next = new Uint8Array(bytes);
  next[0] &= 248;
  next[31] &= 127;
  next[31] |= 64;
  return next;
}

function basePointBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 9;
  return bytes;
}

function x25519(scalar: Uint8Array, point: Uint8Array): Uint8Array {
  const p = (1n << 255n) - 19n;
  const x1 = decodeLittleEndian(point);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  const k = decodeLittleEndian(clampWireGuardPrivateKey(scalar));
  for (let t = 254; t >= 0; t -= 1) {
    const bit = (k >> BigInt(t)) & 1n;
    swap ^= bit;
    [x2, x3] = conditionalSwap(swap, x2, x3);
    [z2, z3] = conditionalSwap(swap, z2, z3);
    swap = bit;
    const a = mod(x2 + z2, p);
    const aa = mod(a * a, p);
    const b = mod(x2 - z2, p);
    const bb = mod(b * b, p);
    const e = mod(aa - bb, p);
    const c = mod(x3 + z3, p);
    const d = mod(x3 - z3, p);
    const da = mod(d * a, p);
    const cb = mod(c * b, p);
    x3 = mod((da + cb) * (da + cb), p);
    z3 = mod(x1 * mod((da - cb) * (da - cb), p), p);
    x2 = mod(aa * bb, p);
    z2 = mod(e * (aa + 121665n * e), p);
  }
  [x2, x3] = conditionalSwap(swap, x2, x3);
  [z2, z3] = conditionalSwap(swap, z2, z3);
  return encodeLittleEndian(mod(x2 * modInverse(z2, p), p), 32);
}

function conditionalSwap(swap: bigint, left: bigint, right: bigint): [bigint, bigint] {
  return swap === 1n ? [right, left] : [left, right];
}

function decodeLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(bytes[index]);
  }
  return value;
}

function encodeLittleEndian(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let next = value;
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number(next & 255n);
    next >>= 8n;
  }
  return bytes;
}

function mod(value: bigint, p: bigint): bigint {
  const result = value % p;
  return result >= 0n ? result : result + p;
}

function modInverse(value: bigint, p: bigint): bigint {
  return modPow(value, p - 2n, p);
}

function modPow(base: bigint, exponent: bigint, p: bigint): bigint {
  let result = 1n;
  let nextBase = mod(base, p);
  let nextExponent = exponent;
  while (nextExponent > 0n) {
    if (nextExponent & 1n) result = mod(result * nextBase, p);
    nextBase = mod(nextBase * nextBase, p);
    nextExponent >>= 1n;
  }
  return result;
}

function compactBody(input: object): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== undefined && value !== null) body[key] = value;
  }
  return body;
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetchImpl(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  const payload = parseJsonPayload(text);

  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    throw new LauncherApiError(`MX Launcher request failed: ${response.status}${statusText}`, response.status, payload);
  }

  return payload as T;
}

function parseJsonPayload(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getGlobalFetch(): FetchLike {
  const globalWithFetch = globalThis as typeof globalThis & { fetch?: FetchLike };
  if (!globalWithFetch.fetch) throw new Error('No fetch implementation available for MX Launcher client');
  return globalWithFetch.fetch.bind(globalThis);
}
