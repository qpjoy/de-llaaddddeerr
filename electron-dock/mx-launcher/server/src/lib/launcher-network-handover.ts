import type {
  LauncherNetworkHandover,
  LauncherNetworkHandoverAdvanceInput,
  LauncherNetworkHandoverInput,
  LauncherNetworkHandoverPeerPhase,
  LauncherNetworkHandoverStatus
} from '../types.js';

export function buildLauncherNetworkHandover(
  environment: string,
  input: LauncherNetworkHandoverInput,
  now = new Date().toISOString()
): LauncherNetworkHandover {
  return {
    ...input,
    environment,
    status: 'preparing',
    domesticPhase: 'pending',
    internalPhase: 'pending',
    lastError: null,
    createdAt: now,
    updatedAt: now
  };
}

export function advanceLauncherNetworkHandover(
  handover: LauncherNetworkHandover,
  input: LauncherNetworkHandoverAdvanceInput,
  now = new Date().toISOString()
): LauncherNetworkHandover {
  if (handover.transitionId !== input.transitionId) {
    throw new Error('Launcher network handover transition does not match');
  }
  if (handover.status === 'committed' || handover.status === 'aborted') {
    return handover;
  }
  const peerRequired = input.peer === 'domestic'
    ? handover.domesticRequired !== false
    : handover.internalRequired !== false;
  if (!peerRequired) return handover;
  const peerField = input.peer === 'domestic' ? 'domesticPhase' : 'internalPhase';
  const peerPhase = phaseResult(input.phase);
  const next: LauncherNetworkHandover = {
    ...handover,
    ...(input.success ? { [peerField]: peerPhase } : {}),
    status: input.success
      ? pendingStatus(input.phase)
      : failureStatus(input.phase),
    lastError: input.success ? null : input.error?.trim() || `${input.peer} ${input.phase} failed`,
    updatedAt: now
  };
  if (
    input.success
    && (handover.domesticRequired === false || next.domesticPhase === peerPhase)
    && (handover.internalRequired === false || next.internalPhase === peerPhase)
  ) {
    next.status = terminalStatus(input.phase);
  }
  return next;
}

export function launcherNetworkHandoverIsTerminal(
  handover: LauncherNetworkHandover
): boolean {
  return handover.status === 'committed' || handover.status === 'aborted';
}

function phaseResult(
  phase: LauncherNetworkHandoverAdvanceInput['phase']
): LauncherNetworkHandoverPeerPhase {
  if (phase === 'commit') return 'committed';
  if (phase === 'abort') return 'aborted';
  return 'prepared';
}

function pendingStatus(
  phase: LauncherNetworkHandoverAdvanceInput['phase']
): LauncherNetworkHandoverStatus {
  if (phase === 'commit') return 'commit-pending';
  if (phase === 'abort') return 'abort-pending';
  return 'preparing';
}

function failureStatus(
  phase: LauncherNetworkHandoverAdvanceInput['phase']
): LauncherNetworkHandoverStatus {
  if (phase === 'commit') return 'commit-pending';
  if (phase === 'abort') return 'abort-pending';
  return 'preparing';
}

function terminalStatus(
  phase: LauncherNetworkHandoverAdvanceInput['phase']
): LauncherNetworkHandoverStatus {
  if (phase === 'commit') return 'committed';
  if (phase === 'abort') return 'aborted';
  return 'prepared';
}
