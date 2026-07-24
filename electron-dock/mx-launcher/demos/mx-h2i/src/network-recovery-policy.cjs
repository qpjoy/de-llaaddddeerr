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
    && input.internalApiReady === true
    && input.splitDnsReady === true;
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
  retainedGuestRecoveryDecision,
  shouldRepairDarwinRetainedOwnership,
  wireGuardRecoveryGate,
  wireGuardRecoveryTurn
};
