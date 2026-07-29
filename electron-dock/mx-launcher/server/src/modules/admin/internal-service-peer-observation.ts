import type {
  SiteSlotDomesticWireGuardSecret,
  SiteSlotInternalServicePeerObservation,
  SiteSlotInternalServicePeerObservationInput,
  SiteSlotInternalServicePeerObservationSource,
  SiteSlotInternalServicePeerObservationStatus,
  SiteSlotPlan,
  SiteSlotWorkerReport
} from '../../types.js';

const OBSERVATION_STATUSES = new Set<SiteSlotInternalServicePeerObservationStatus>([
  'passed',
  'ready',
  'blocked',
  'failed'
]);

export function internalServicePeerObservationInput(
  sourceAction: SiteSlotInternalServicePeerObservationSource,
  siteId: string,
  plan: SiteSlotPlan | null,
  secret: SiteSlotDomesticWireGuardSecret | null,
  runtimeStatus: unknown,
  workerReport: SiteSlotWorkerReport | null,
  requestedBy?: string | null
): SiteSlotInternalServicePeerObservationInput | null {
  if (!plan || !secret || plan.kind !== 'domestic' || plan.siteId !== siteId || secret.siteId !== siteId) {
    return null;
  }
  const runtime = recordValue(runtimeStatus);
  if (runtime.siteId !== siteId || runtime.planId !== plan.planId) return null;
  const status = typeof runtime.status === 'string' && OBSERVATION_STATUSES.has(
    runtime.status as SiteSlotInternalServicePeerObservationStatus
  )
    ? runtime.status as SiteSlotInternalServicePeerObservationStatus
    : null;
  if (!status) return null;
  const livePublicKey = internalServicePeerLivePublicKey(runtime);
  const publicKeyMatchesCurrentSecret = Boolean(
    secret.internalServicePublicKey
    && livePublicKey
    && secret.internalServicePublicKey === livePublicKey
  );
  const livePeerPublicKeys = internalServicePeerLivePeerPublicKeys(runtime);
  const peerKeyMatchesCurrentSecret = Boolean(
    secret.domesticRelayPublicKey
    && livePeerPublicKeys.includes(secret.domesticRelayPublicKey)
  );
  const runtimeMaterialMatchesCurrentSecret = publicKeyMatchesCurrentSecret && peerKeyMatchesCurrentSecret;
  const observationStatus = status === 'passed' && !runtimeMaterialMatchesCurrentSecret
    ? 'blocked'
    : status;
  const keyBlockedReasons = status === 'passed'
    ? [
        ...(!publicKeyMatchesCurrentSecret
          ? ['Active Internal WireGuard public key does not match the current Config Center key']
          : []),
        ...(!peerKeyMatchesCurrentSecret
          ? ['Active Internal WireGuard peer does not match the current Domestic relay key']
          : [])
      ]
    : [];
  return {
    siteId,
    planId: plan.planId,
    materialDigest: secret.fingerprints.materialDigest,
    workerReportId: workerReport?.reportId ?? null,
    status: observationStatus,
    sourceAction,
    blockedReasons: [
      ...(Array.isArray(runtime.blockedReasons)
        ? runtime.blockedReasons.filter((reason): reason is string => typeof reason === 'string')
        : []),
      ...keyBlockedReasons
    ],
    checkedAt: typeof runtime.checkedAt === 'string' ? runtime.checkedAt : null,
    requestedBy
  };
}

export function internalServicePeerObservationClearsWarning(
  plan: SiteSlotPlan,
  report: SiteSlotWorkerReport,
  secret: SiteSlotDomesticWireGuardSecret | null,
  observation: SiteSlotInternalServicePeerObservation | null
): boolean {
  if (!secret || !observation || observation.status !== 'passed') return false;
  if (
    observation.siteId !== plan.siteId
    || observation.planId !== plan.planId
    || observation.materialDigest !== secret.fingerprints.materialDigest
    || observation.workerReportId !== report.reportId
  ) {
    return false;
  }
  return true;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function internalServicePeerLivePublicKey(runtime: Record<string, unknown>): string | null {
  const iface = recordValue(runtime.interface);
  const explicit = typeof iface.livePublicKey === 'string' ? iface.livePublicKey.trim() : '';
  if (validWireGuardPublicKey(explicit)) return explicit;
  const wgShow = recordValue(iface.wgShow);
  const stdout = typeof wgShow.stdout === 'string' ? wgShow.stdout : '';
  const match = stdout.match(/(?:^|\n)\s*public key:\s*([A-Za-z0-9+/]{43}=)\s*(?:\n|$)/i);
  return match?.[1] && validWireGuardPublicKey(match[1]) ? match[1] : null;
}

function internalServicePeerLivePeerPublicKeys(runtime: Record<string, unknown>): string[] {
  const iface = recordValue(runtime.interface);
  const explicit = Array.isArray(iface.livePeerPublicKeys)
    ? iface.livePeerPublicKeys.filter((value): value is string => (
        typeof value === 'string' && validWireGuardPublicKey(value)
      ))
    : [];
  if (explicit.length > 0) return explicit;
  const wgShow = recordValue(iface.wgShow);
  const stdout = typeof wgShow.stdout === 'string' ? wgShow.stdout : '';
  return [...stdout.matchAll(/(?:^|\n)\s*peer:\s*([A-Za-z0-9+/]{43}=)\s*(?:\n|$)/gi)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value) && validWireGuardPublicKey(value));
}

function validWireGuardPublicKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.trim());
}
