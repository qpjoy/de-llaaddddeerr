import type {
  LauncherNetworkRuntimeCollectionClaimInput,
  LauncherNetworkRuntimeCollectionClaimResult,
  LauncherNetworkRuntimeCollectionCompleteInput,
  LauncherNetworkRuntimeCollectionState,
  LauncherNetworkTrafficHistory,
  LauncherNetworkTrafficLeaseSampleInput,
  LauncherNetworkTrafficSample
} from '../types.js';

export const LAUNCHER_NETWORK_RUNTIME_SOURCE = 'domestic-relay-snapshot' as const;
export const LAUNCHER_NETWORK_RUNTIME_PLANE = 'domestic' as const;

export function launcherNetworkRuntimeCollectionId(siteId: string): string {
  return `domestic:${requiredId(siteId, 'siteId')}`;
}

export function launcherNetworkTrafficHistoryId(leaseId: string): string {
  return `domestic:${requiredId(leaseId, 'leaseId')}`;
}

export function claimLauncherNetworkRuntimeCollection(
  environment: string,
  previous: LauncherNetworkRuntimeCollectionState | null,
  input: LauncherNetworkRuntimeCollectionClaimInput
): LauncherNetworkRuntimeCollectionClaimResult {
  const siteId = requiredId(input.siteId, 'siteId');
  const claimId = requiredId(input.claimId, 'claimId');
  const requestedAt = validIso(input.requestedAt, 'requestedAt');
  const requestedAtMs = Date.parse(requestedAt);
  const minIntervalMs = boundedPositiveInteger(input.minIntervalMs, 60_000, 24 * 60 * 60 * 1000);
  const claimTtlMs = boundedPositiveInteger(input.claimTtlMs, 30_000, 10 * 60 * 1000);
  const base = previous ?? emptyCollectionState(environment, siteId, requestedAt);
  const leaseUntilMs = base.collectionLeaseUntil ? Date.parse(base.collectionLeaseUntil) : Number.NaN;
  if (
    base.status === 'collecting'
    && base.activeClaimId
    && Number.isFinite(leaseUntilMs)
    && leaseUntilMs > requestedAtMs
  ) {
    return { claimed: false, outcome: 'in-flight', state: base };
  }
  const nextAllowedAtMs = base.nextAllowedAt ? Date.parse(base.nextAllowedAt) : Number.NaN;
  if (Number.isFinite(nextAllowedAtMs) && nextAllowedAtMs > requestedAtMs) {
    return { claimed: false, outcome: 'throttled', state: base };
  }
  const state: LauncherNetworkRuntimeCollectionState = {
    ...base,
    status: 'collecting',
    activeClaimId: claimId,
    collectionLeaseUntil: new Date(requestedAtMs + claimTtlMs).toISOString(),
    lastAttemptAt: requestedAt,
    nextAllowedAt: new Date(requestedAtMs + minIntervalMs).toISOString(),
    updatedAt: requestedAt
  };
  return { claimed: true, outcome: 'claimed', state };
}

export function completeLauncherNetworkRuntimeCollection(
  previous: LauncherNetworkRuntimeCollectionState,
  input: LauncherNetworkRuntimeCollectionCompleteInput
): LauncherNetworkRuntimeCollectionState {
  if (previous.activeClaimId !== input.claimId || previous.status !== 'collecting') {
    throw new Error('Launcher runtime collection claim is stale');
  }
  const observedLeaseCount = input.samples.filter((sample) => sample.status === 'observed').length;
  const sharedPeerLeaseCount = input.samples.filter((sample) => sample.attribution === 'shared-peer').length;
  if (
    input.samples.length > input.activeLeaseCount
    || input.unmatchedPeerCount > input.peerCount
    || input.collectedLeaseCount !== observedLeaseCount
    || input.sharedPeerLeaseCount !== sharedPeerLeaseCount
    || (input.result === 'observed' && input.failureCode !== null)
    || (input.result !== 'observed' && input.failureCode === null)
    || (input.failureCode === 'capacity-blocked'
      && (input.samples.length !== 0 || input.collectedLeaseCount !== 0))
  ) throw new Error('Launcher runtime collection completion is inconsistent');
  const sampledAt = validIso(input.sampledAt, 'sampledAt');
  return {
    ...previous,
    status: 'idle',
    activeClaimId: null,
    collectionLeaseUntil: null,
    lastCompletedAt: sampledAt,
    latestSnapshotId: requiredId(input.snapshotId, 'snapshotId'),
    latestResult: input.result,
    activeLeaseCount: boundedNonNegativeInteger(input.activeLeaseCount, 100_000),
    peerCount: boundedNonNegativeInteger(input.peerCount, 100_000),
    unmatchedPeerCount: boundedNonNegativeInteger(input.unmatchedPeerCount, 100_000),
    sharedPeerLeaseCount: boundedNonNegativeInteger(input.sharedPeerLeaseCount, 100_000),
    collectedLeaseCount: boundedNonNegativeInteger(input.collectedLeaseCount, 100_000),
    collectionDurationMs: boundedNonNegativeInteger(input.collectionDurationMs, 24 * 60 * 60 * 1000),
    latestFailureCode: input.failureCode,
    updatedAt: sampledAt
  };
}

export function appendLauncherNetworkTrafficHistory(
  environment: string,
  siteId: string,
  previous: LauncherNetworkTrafficHistory | null,
  input: LauncherNetworkRuntimeCollectionCompleteInput,
  leaseSample: LauncherNetworkTrafficLeaseSampleInput
): LauncherNetworkTrafficHistory {
  const retentionSamples = boundedPositiveInteger(input.retentionSamples, 2, 288);
  const intervalMs = boundedPositiveInteger(input.intervalMs, 60_000, 24 * 60 * 60 * 1000);
  const observedAt = validIso(input.sampledAt, 'sampledAt');
  const priorSamples = previous?.samples ?? [];
  if (priorSamples.some((sample) => sample.snapshotId === input.snapshotId)) {
    return previous as LauncherNetworkTrafficHistory;
  }
  const sample = buildTrafficSample(
    leaseSample,
    requiredId(input.snapshotId, 'snapshotId'),
    observedAt,
    priorSamples.at(-1) ?? null
  );
  const createdAt = previous?.createdAt ?? observedAt;
  return {
    historyId: launcherNetworkTrafficHistoryId(leaseSample.leaseId),
    environment,
    leaseId: requiredId(leaseSample.leaseId, 'leaseId'),
    productId: requiredId(leaseSample.productId, 'productId'),
    siteId: requiredId(siteId, 'siteId'),
    source: LAUNCHER_NETWORK_RUNTIME_SOURCE,
    plane: LAUNCHER_NETWORK_RUNTIME_PLANE,
    intervalSeconds: Math.floor(intervalMs / 1000),
    retentionSamples,
    samples: [...priorSamples, sample].slice(-retentionSamples),
    createdAt,
    updatedAt: observedAt
  };
}

function buildTrafficSample(
  input: LauncherNetworkTrafficLeaseSampleInput,
  snapshotId: string,
  observedAt: string,
  previous: LauncherNetworkTrafficSample | null
): LauncherNetworkTrafficSample {
  const sharedLeaseCount = boundedPositiveInteger(input.sharedLeaseCount, 1, 100_000);
  if (
    (input.attribution !== 'exact' && input.attribution !== 'shared-peer')
    ||
    (input.attribution === 'exact' && sharedLeaseCount !== 1)
    || (input.attribution === 'shared-peer' && sharedLeaseCount < 2)
  ) throw new Error('Launcher runtime traffic attribution is inconsistent');
  const handshakeValid = input.latestHandshakeEpoch === null
    || (
      Number.isSafeInteger(input.latestHandshakeEpoch)
      && input.latestHandshakeEpoch >= 0
      && input.latestHandshakeEpoch * 1000 <= Date.parse(observedAt) + (5 * 60 * 1000)
    );
  const observedFieldsValid = input.peerConfigured === 'no'
    ? input.latestHandshakeEpoch === null && input.rxBytes === null && input.txBytes === null
    : input.peerConfigured === 'yes'
      && handshakeValid
      && nonNegativeSafeInteger(input.rxBytes)
      && nonNegativeSafeInteger(input.txBytes)
      && typeof input.seriesId === 'string'
      && /^[a-f0-9]{24}$/.test(input.seriesId);
  const status = input.status === 'observed' && !observedFieldsValid
    ? 'unavailable' as const
    : input.status;
  const countersValid = status === 'observed'
    && input.peerConfigured === 'yes'
    && nonNegativeSafeInteger(input.rxBytes)
    && nonNegativeSafeInteger(input.txBytes)
    && typeof input.seriesId === 'string'
    && /^[a-f0-9]{24}$/.test(input.seriesId);
  const rxBytes = countersValid ? input.rxBytes : null;
  const txBytes = countersValid ? input.txBytes : null;
  const delta = trafficRateDelta(previous, observedAt, input.seriesId, rxBytes, txBytes);
  return {
    snapshotId,
    observedAt,
    status,
    peerConfigured: input.peerConfigured,
    latestHandshakeEpoch: status === 'observed' ? input.latestHandshakeEpoch : null,
    rxBytes,
    txBytes,
    relayRxBytesPerSecond: delta?.rx ?? null,
    relayTxBytesPerSecond: delta?.tx ?? null,
    rateWindowSeconds: delta?.windowSeconds ?? null,
    attribution: input.attribution,
    sharedLeaseCount,
    seriesId: countersValid ? input.seriesId : null
  };
}

function trafficRateDelta(
  previous: LauncherNetworkTrafficSample | null,
  observedAt: string,
  seriesId: string | null,
  rxBytes: number | null,
  txBytes: number | null
): { rx: number; tx: number; windowSeconds: number } | null {
  if (
    !previous
    || previous.status !== 'observed'
    || previous.peerConfigured !== 'yes'
    || previous.seriesId !== seriesId
    || !nonNegativeSafeInteger(previous.rxBytes)
    || !nonNegativeSafeInteger(previous.txBytes)
    || !nonNegativeSafeInteger(rxBytes)
    || !nonNegativeSafeInteger(txBytes)
    || rxBytes < previous.rxBytes
    || txBytes < previous.txBytes
  ) return null;
  const elapsedSeconds = (Date.parse(observedAt) - Date.parse(previous.observedAt)) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return null;
  return {
    rx: (rxBytes - previous.rxBytes) / elapsedSeconds,
    tx: (txBytes - previous.txBytes) / elapsedSeconds,
    windowSeconds: elapsedSeconds
  };
}

function emptyCollectionState(
  environment: string,
  siteId: string,
  now: string
): LauncherNetworkRuntimeCollectionState {
  return {
    collectionId: launcherNetworkRuntimeCollectionId(siteId),
    environment,
    siteId,
    source: LAUNCHER_NETWORK_RUNTIME_SOURCE,
    plane: LAUNCHER_NETWORK_RUNTIME_PLANE,
    status: 'idle',
    activeClaimId: null,
    collectionLeaseUntil: null,
    lastAttemptAt: null,
    lastCompletedAt: null,
    nextAllowedAt: null,
    latestSnapshotId: null,
    latestResult: null,
    activeLeaseCount: 0,
    peerCount: 0,
    unmatchedPeerCount: 0,
    sharedPeerLeaseCount: 0,
    collectedLeaseCount: 0,
    collectionDurationMs: 0,
    latestFailureCode: null,
    updatedAt: now
  };
}

function requiredId(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 160) throw new Error(`Launcher runtime ${field} is invalid`);
  return normalized;
}

function validIso(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!value || !Number.isFinite(parsed)) throw new Error(`Launcher runtime ${field} is invalid`);
  return new Date(parsed).toISOString();
}

function boundedPositiveInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('Launcher runtime numeric bound is invalid');
  }
  return value;
}

function boundedNonNegativeInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error('Launcher runtime numeric bound is invalid');
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
