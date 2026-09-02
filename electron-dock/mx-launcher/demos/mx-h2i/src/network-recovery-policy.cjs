const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS = 105 * 1000;
const DEFAULT_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD = 3;

// A WireGuard status only says the tunnel is down when it actually managed to
// look. The Windows machine-state probe shells out to PowerShell; when that
// spawn times out the result still carries active:false, which is
// byte-for-byte what a stopped tunnel looks like -- the field log shows
// `statusError: "spawnSync ...powershell.exe ETIMEDOUT"` next to
// `serviceState: "RUNNING"`. electron-core-wireguard marks that case with
// activeObserved:false; a null status (the query threw) and ok:false cover the
// remaining paths. Never act destructively on an unobserved status.
function wireGuardStatusObserved(status) {
  if (!status) return false;
  if (status.activeObserved === false) return false;
  if (status.active === true) return true;
  return status.ok !== false;
}

// A background WireGuard probe can report three different things:
//   1. the tunnel is confirmed live but a route/ownership/split-DNS proof is
//      gone (a real split-brain: keeping "connected" would leak traffic),
//   2. the tunnel is confirmed down,
//   3. the probe could not observe the tunnel at all.
// Case 3 is not evidence. On Windows the status query shells out to
// wg/sc/PowerShell, and those calls time out on a loaded machine; the result
// used to be indistinguishable from "tunnel down", so a single slow probe
// dropped a healthy connection to lease-only. That made
// systemDomainProxyRuntimeEligible() false, which tore the system PAC down and
// cut Internal browsing until a later probe happened to succeed.
//
// Proof loss therefore only bypasses the consecutive-failure threshold when
// the probe actually observed the tunnel. An unobserved probe just counts
// toward the threshold, so a real outage is still reported, just after
// consecutive confirmations rather than a single flaky sample.
function preserveConnectedOnBackgroundProbe(input = {}) {
  if (input.manual === true) return false;
  if (input.connectionState !== 'connected') return false;
  if (input.probeReady === true) return false;
  const threshold = Number(input.downgradeThreshold) > 0
    ? Number(input.downgradeThreshold)
    : DEFAULT_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD;
  const failures = Number(input.consecutiveFailures) || 0;
  if (failures >= threshold) return false;
  if (input.tunnelObserved === false) return true;
  return !(
    input.routeProofLost === true
    || input.ownershipProofLost === true
    || input.splitDnsProofLost === true
  );
}

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
  DEFAULT_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD,
  DEFAULT_DOMESTIC_PEER_SYNC_TIMEOUT_MS,
  DEFAULT_FAILURE_COOLDOWN_MS,
  darwinSupersedableOwnershipOwnerIds,
  isDarwinDynamicProxyEndpointRoute,
  preserveConnectedOnBackgroundProbe,
  retainedGuestRecoveryDecision,
  shouldRepairDarwinRetainedOwnership,
  stableOwnershipInstanceId,
  wireGuardRecoveryGate,
  wireGuardRecoveryTurn,
  wireGuardStatusObserved
};
