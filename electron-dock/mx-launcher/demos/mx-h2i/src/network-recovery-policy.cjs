const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS = 105 * 1000;

function wireGuardRecoveryGate(input = {}) {
  if (input.disconnectInFlight === true) return 'disconnect-in-flight';
  if (input.connectionState === 'connecting') return 'connect-in-flight';

  const connectOperationCount = Number(input.connectOperationCount) || 0;
  const foreground = input.foreground === true;
  if (connectOperationCount > 0 && !(foreground && connectOperationCount === 1)) {
    return 'connect-in-flight';
  }

  const manual = input.manual === true;
  const lastFailureAt = Number(input.lastFailureAt) || 0;
  const now = Number(input.now) || Date.now();
  const failureCooldownMs = Number(input.failureCooldownMs) || DEFAULT_FAILURE_COOLDOWN_MS;
  if (
    !foreground
    && !manual
    && lastFailureAt > 0
    && now - lastFailureAt < failureCooldownMs
  ) {
    return 'failure-cooldown';
  }
  return null;
}

function retainedGuestRecoveryDecision(input = {}) {
  if (input.ready === true) return 'recovered';
  if (input.liveWireGuardActive === true) return 'preserve';
  return 'fresh-connect';
}

function shouldRepairDarwinRetainedOwnership(input = {}) {
  return input.platform === 'darwin'
    && input.ownershipReady !== true
    && input.tunnelReady === true
    && input.routeReady === true
    && input.internalApiReady === true;
}

function stableOwnershipInstanceId(input = {}) {
  return [
    input.ownershipInstanceId,
    input.installId,
    input.deviceId
  ].map(normalizeText).find(Boolean) || null;
}

function isDarwinDynamicProxyEndpointRoute(input = {}) {
  const gateway = normalizeText(input.gateway);
  const flags = new Set(
    Array.isArray(input.flags)
      ? input.flags.map((flag) => normalizeText(flag).toUpperCase()).filter(Boolean)
      : []
  );
  const octets = gateway.split('.').map(Number);
  const clashFakeGateway = octets.length === 4
    && octets[0] === 198
    && (octets[1] === 18 || octets[1] === 19)
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  return clashFakeGateway && flags.has('HOST') && flags.has('WASCLONED');
}

function darwinSupersedableOwnershipOwnerIds(input = {}) {
  if (input.platform !== 'darwin') return [];
  if (input.tunnelInactive !== true && input.retainedDataPlaneProven !== true) return [];
  const productId = normalizeText(input.productId);
  const currentOwnerId = normalizeText(input.currentOwnerId);
  if (!productId || !currentOwnerId) return [];

  const claims = Array.isArray(input.claims) ? input.claims : [];
  const candidates = claims.filter((claim) =>
    normalizeText(claim?.ownerId)
    && normalizeText(claim.ownerId) !== currentOwnerId
    && normalizeText(claim.productId) === productId
    && claim?.metadata?.dataPlaneOwner === true
  );
  if (candidates.length === 0) return [];

  const conflicts = Array.isArray(input.conflicts) ? input.conflicts : [];
  if (conflicts.length === 0) return [];
  const candidateIds = new Set(candidates.map((claim) => normalizeText(claim.ownerId)));
  const allowedIds = new Set([currentOwnerId, ...candidateIds]);
  for (const conflict of conflicts) {
    const owners = Array.isArray(conflict?.owners)
      ? conflict.owners.map(normalizeText).filter(Boolean)
      : [];
    if (!owners.includes(currentOwnerId)) return [];
    if (owners.some((ownerId) => !allowedIds.has(ownerId))) return [];
  }
  const conflictingIds = new Set(
    conflicts.flatMap((conflict) =>
      Array.isArray(conflict?.owners) ? conflict.owners.map(normalizeText).filter(Boolean) : []
    )
  );
  return [...candidateIds].filter((ownerId) => conflictingIds.has(ownerId)).sort();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function wireGuardRecoveryTurn(inFlight, foreground) {
  if (!inFlight) return { action: 'start', waited: false, recovery: null };
  if (foreground !== true) {
    return { action: 'reuse', waited: false, recovery: inFlight };
  }
  await Promise.resolve(inFlight).catch(() => undefined);
  return { action: 'start', waited: true, recovery: null };
}

module.exports = {
  DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS,
  DEFAULT_FAILURE_COOLDOWN_MS,
  darwinSupersedableOwnershipOwnerIds,
  isDarwinDynamicProxyEndpointRoute,
  retainedGuestRecoveryDecision,
  shouldRepairDarwinRetainedOwnership,
  stableOwnershipInstanceId,
  wireGuardRecoveryGate,
  wireGuardRecoveryTurn
};
