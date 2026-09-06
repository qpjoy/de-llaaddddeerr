import type { FetchLike } from '@qpjoy/mx-launcher-core';

import {
  createElectronLauncherReleaseUpdater,
  type ElectronLauncherArtifactDownloadProgress,
  type ElectronLauncherReleaseArtifactRef,
  type ElectronLauncherReleaseUpdater,
  type ElectronLauncherUpdateCheckResult
} from './release-updater.js';
import {
  classifyElectronLauncherUpdateArtifact,
  createElectronLauncherReleaseUpdateExecutor,
  reportElectronLauncherInstallCompletionIfUpgraded,
  type ElectronLauncherNetworkGateState,
  type ElectronLauncherReleaseUpdateExecutor,
  type ElectronLauncherUpdateArtifactClass,
  type ElectronLauncherUpdateExecutorPhase
} from './release-update-executor.js';

export type ElectronLauncherApplicationDistribution = 'installed' | 'portable' | 'development';

export type ElectronLauncherApplicationUpdatePhase =
  | 'idle'
  | 'unsupported'
  | 'needs-network'
  | 'checking'
  | 'up-to-date'
  | 'blocked'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'staged'
  | 'ready'
  | 'installing'
  | 'cancelled'
  | 'error';

export interface ElectronLauncherApplicationUpdateContext {
  baseUrl: string;
  /** Stable per-install identity required for server-side rollout decisions. */
  installId: string;
  userId?: string | null;
}

export interface ElectronLauncherApplicationUpdateComponentCandidate {
  componentKind: string;
  componentId?: string | null;
  currentVersion?: string;
}

export type ElectronLauncherApplicationUpdateComponent = ElectronLauncherApplicationUpdateComponentCandidate;

export interface ElectronLauncherApplicationUpdateArtifactCandidate {
  component: Readonly<ElectronLauncherApplicationUpdateComponentCandidate>;
  check: ElectronLauncherUpdateCheckResult;
  artifact: ElectronLauncherReleaseArtifactRef;
}

export type ElectronLauncherApplicationUpdateCandidate = ElectronLauncherApplicationUpdateArtifactCandidate;

export interface ElectronLauncherApplicationUpdateLifecycleContext {
  check: ElectronLauncherUpdateCheckResult;
  artifact: ElectronLauncherReleaseArtifactRef;
  stagedPath: string;
  signal: AbortSignal;
}

export interface ElectronLauncherApplicationUpdateState {
  phase: ElectronLauncherApplicationUpdatePhase;
  distribution: ElectronLauncherApplicationDistribution;
  currentVersion: string;
  updateAvailable: boolean;
  checkedAt: string | null;
  targetVersion: string | null;
  releaseId: string | null;
  releaseNotes: string | null;
  deliveryMode: ElectronLauncherUpdateCheckResult['deliveryMode'] | null;
  check: ElectronLauncherUpdateCheckResult | null;
  selectedArtifact: ElectronLauncherReleaseArtifactRef | null;
  artifactKind: string | null;
  artifactClass: ElectronLauncherUpdateArtifactClass | null;
  stagedPath: string | null;
  staged: boolean;
  progress: ElectronLauncherArtifactDownloadProgress | null;
  bytesReceived: number;
  totalBytes: number | null;
  percent: number | null;
  reason: string | null;
  error: string | null;
}

export interface ElectronLauncherApplicationUpdaterOptions {
  baseDir: string;
  packageName: string;
  currentVersion: string;
  productId?: string | null;
  channel?: string;
  distribution?: ElectronLauncherApplicationDistribution;
  platform?: string | null;
  arch?: string | null;
  componentCandidates?: readonly ElectronLauncherApplicationUpdateComponentCandidate[];
  /**
   * `fail-fast` preserves server decision integrity. `best-effort` exists only
   * for explicitly audited legacy products that must retain a partial check loop.
   */
  componentCheckFailureMode?: 'fail-fast' | 'best-effort';
  getContext: () => ElectronLauncherApplicationUpdateContext | null | Promise<ElectronLauncherApplicationUpdateContext | null>;
  fetchImpl?: FetchLike;
  allowLegacyProductFallback?: boolean;
  downloadTimeoutMs?: number;
  networkGate?: () => ElectronLauncherNetworkGateState | Promise<ElectronLauncherNetworkGateState>;
  selectArtifact?: (
    candidates: readonly ElectronLauncherApplicationUpdateArtifactCandidate[]
  ) => ElectronLauncherApplicationUpdateArtifactCandidate | null;
  applyConfig?: (activePath: string) => void | Promise<void>;
  applyRenderer?: (activePath: string) => void | Promise<void>;
  beforeActivate?: (context: ElectronLauncherApplicationUpdateLifecycleContext) => void | Promise<void>;
  beforeInstallCleanup?: (context: ElectronLauncherApplicationUpdateLifecycleContext) => void | Promise<void>;
  openInstaller?: (filePath: string, context: ElectronLauncherApplicationUpdateLifecycleContext) => void | Promise<void>;
  relaunch?: (context: ElectronLauncherApplicationUpdateLifecycleContext) => void | Promise<void>;
  exit?: (code: number, context: ElectronLauncherApplicationUpdateLifecycleContext) => void | Promise<void>;
  onState?: (state: ElectronLauncherApplicationUpdateState) => void;
  onExecutorPhase?: (phase: ElectronLauncherUpdateExecutorPhase, detail: Record<string, unknown>) => void;
  onProgress?: (progress: ElectronLauncherArtifactDownloadProgress) => void;
}

export interface ElectronLauncherApplicationUpdateOperationOptions {
  signal?: AbortSignal;
}

export type ElectronLauncherApplicationUpdateOperation = 'network-ready' | 'check' | 'download' | 'install';
export type ElectronLauncherApplicationUpdateOperationInput = ElectronLauncherApplicationUpdateOperationOptions;

export interface ElectronLauncherApplicationUpdater {
  getState(): ElectronLauncherApplicationUpdateState;
  handleNetworkReady(options?: ElectronLauncherApplicationUpdateOperationOptions): Promise<ElectronLauncherApplicationUpdateState>;
  check(options?: ElectronLauncherApplicationUpdateOperationOptions): Promise<ElectronLauncherApplicationUpdateState>;
  download(options?: ElectronLauncherApplicationUpdateOperationOptions): Promise<ElectronLauncherApplicationUpdateState>;
  install(options?: ElectronLauncherApplicationUpdateOperationOptions): Promise<ElectronLauncherApplicationUpdateState>;
  cancel(reason?: string): ElectronLauncherApplicationUpdateState;
}

interface Operation {
  generation: number;
  controller: AbortController;
  detachExternalSignal: () => void;
  committed: boolean;
  commitReason: string | null;
}

const DEFAULT_COMPONENT_CANDIDATES: readonly ElectronLauncherApplicationUpdateComponentCandidate[] = [
  { componentKind: 'app-asar' },
  { componentKind: 'app-installer' }
];

export function createElectronLauncherApplicationUpdater(
  options: ElectronLauncherApplicationUpdaterOptions
): ElectronLauncherApplicationUpdater {
  const baseDir = requiredValue(options.baseDir, 'baseDir');
  const packageName = requiredValue(options.packageName, 'packageName');
  const currentVersion = requiredValue(options.currentVersion, 'currentVersion');
  const channel = options.channel?.trim() || 'stable';
  const distribution = options.distribution ?? 'installed';
  const componentCandidates = normalizeComponentCandidates(options.componentCandidates);
  let state: ElectronLauncherApplicationUpdateState = {
    phase: 'idle',
    distribution,
    currentVersion,
    updateAvailable: false,
    checkedAt: null,
    targetVersion: null,
    releaseId: null,
    releaseNotes: null,
    deliveryMode: null,
    check: null,
    selectedArtifact: null,
    artifactKind: null,
    artifactClass: null,
    stagedPath: null,
    staged: false,
    progress: null,
    bytesReceived: 0,
    totalBytes: null,
    percent: null,
    reason: null,
    error: null
  };
  let generation = 0;
  const activeOperations = new Set<Operation>();
  let checkInFlight: Promise<ElectronLauncherApplicationUpdateState> | null = null;
  let downloadInFlight: Promise<ElectronLauncherApplicationUpdateState> | null = null;
  let installInFlight: Promise<ElectronLauncherApplicationUpdateState> | null = null;
  let networkReadyInFlight: Promise<ElectronLauncherApplicationUpdateState> | null = null;
  let workflowTail: Promise<void> = Promise.resolve();
  let automaticCheckIdentity: string | null = null;
  let lastContext: ElectronLauncherApplicationUpdateContext | null = null;
  let lastUpdater: ElectronLauncherReleaseUpdater | null = null;
  let lastExecutor: ElectronLauncherReleaseUpdateExecutor | null = null;
  let selectedCandidate: ElectronLauncherApplicationUpdateArtifactCandidate | null = null;
  let activePath: string | null = null;
  let installationHandoffStarted = false;
  let irreversibleCommitReason: string | null = null;

  const snapshot = (): ElectronLauncherApplicationUpdateState => immutableClone(state);
  const publish = (next: ElectronLauncherApplicationUpdateState): ElectronLauncherApplicationUpdateState => {
    state = immutableClone(next);
    try {
      options.onState?.(snapshot());
    } catch {
      // Observers must not interrupt an update transaction.
    }
    return snapshot();
  };
  const update = (
    patch: Partial<ElectronLauncherApplicationUpdateState>,
    operation?: Operation
  ): ElectronLauncherApplicationUpdateState => {
    if (operation && operation.generation !== generation && !operation.committed) return snapshot();
    return publish({ ...state, ...patch });
  };
  const beginOperation = (externalSignal?: AbortSignal): Operation => {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    const operation: Operation = {
      generation,
      controller,
      detachExternalSignal: () => externalSignal?.removeEventListener('abort', forwardAbort),
      committed: false,
      commitReason: null
    };
    activeOperations.add(operation);
    return operation;
  };
  const endOperation = (operation: Operation) => {
    operation.detachExternalSignal();
    activeOperations.delete(operation);
  };
  const checkpoint = (operation: Operation) => {
    if (operation.committed) return;
    if (operation.generation !== generation || operation.controller.signal.aborted) {
      throw new ApplicationUpdateCancelledError(cancellationReason(operation.controller.signal));
    }
  };
  const markCommitted = (operation: Operation, reason: string) => {
    checkpoint(operation);
    operation.detachExternalSignal();
    if (operation.controller.signal.aborted) {
      throw new ApplicationUpdateCancelledError(cancellationReason(operation.controller.signal));
    }
    operation.committed = true;
    operation.commitReason = reason;
    irreversibleCommitReason = reason;
  };
  const recordCompletedHandoff = (operation: Operation, reason: string) => {
    operation.detachExternalSignal();
    operation.committed = true;
    operation.commitReason = reason;
    irreversibleCommitReason = reason;
  };
  const runOperation = async (
    signal: AbortSignal | undefined,
    operationBody: (operation: Operation) => Promise<ElectronLauncherApplicationUpdateState>
  ): Promise<ElectronLauncherApplicationUpdateState> => {
    const operation = beginOperation(signal);
    try {
      checkpoint(operation);
      return await operationBody(operation);
    } catch (error) {
      if (operation.generation !== generation && !operation.committed) return snapshot();
      if (!operation.committed && (operation.controller.signal.aborted || error instanceof ApplicationUpdateCancelledError)) {
        return update({
          phase: 'cancelled',
          reason: errorMessage(error) || cancellationReason(operation.controller.signal),
          error: null,
          progress: null
        }, operation);
      }
      return update({
        phase: 'error',
        reason: errorMessage(error),
        error: errorMessage(error),
        progress: null
      }, operation);
    } finally {
      endOperation(operation);
    }
  };
  const scheduleOperation = (
    signal: AbortSignal | undefined,
    operationBody: (operation: Operation) => Promise<ElectronLauncherApplicationUpdateState>
  ): Promise<ElectronLauncherApplicationUpdateState> => {
    const requestedGeneration = generation;
    const scheduled = workflowTail.then(
      () => requestedGeneration === generation
        ? runOperation(signal, operationBody)
        : snapshot(),
      () => requestedGeneration === generation
        ? runOperation(signal, operationBody)
        : snapshot()
    );
    workflowTail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };
  const unsupported = (operation: Operation): ElectronLauncherApplicationUpdateState | null => {
    if (distribution === 'installed') return null;
    return update({
      phase: 'unsupported',
      updateAvailable: false,
      reason: `${distribution} distribution does not support managed application updates`,
      error: null
    }, operation);
  };
  const readContext = async (operation: Operation): Promise<ElectronLauncherApplicationUpdateContext | null> => {
    const value = await options.getContext();
    checkpoint(operation);
    if (!value) return null;
    return {
      baseUrl: normalizedBaseUrl(value.baseUrl),
      installId: requiredValue(value.installId, 'context.installId'),
      userId: value.userId?.trim() || null
    };
  };
  const assertContextUnchanged = async (operation: Operation): Promise<void> => {
    if (!lastContext) throw new Error('application update context is not available; check again');
    const currentContext = await readContext(operation);
    if (!currentContext) throw new Error('Launcher network is not ready; check again before continuing');
    if (contextIdentity(currentContext) !== contextIdentity(lastContext)) {
      throw new Error('application update context changed; check again before continuing');
    }
  };
  const assertNetworkGateReady = async (operation: Operation): Promise<void> => {
    checkpoint(operation);
    const gate = options.networkGate ? await options.networkGate() : 'idle';
    checkpoint(operation);
    if (gate === 'connecting' || gate === 'recovering' || gate === 'permission-required') {
      throw new Error(`application update is blocked while network state is ${gate}`);
    }
  };
  const createUpdater = (context: ElectronLauncherApplicationUpdateContext): ElectronLauncherReleaseUpdater =>
    createElectronLauncherReleaseUpdater({
      baseUrl: context.baseUrl,
      fetchImpl: options.fetchImpl,
      reportInstallId: context.installId,
      productId: options.productId,
      packageName,
      channel,
      allowLegacyProductFallback: options.allowLegacyProductFallback
    });
  const lifecycleContext = (operation: Operation): ElectronLauncherApplicationUpdateLifecycleContext => {
    if (!selectedCandidate || !state.stagedPath) throw new Error('application update has no staged artifact');
    return Object.freeze({
      check: selectedCandidate.check,
      artifact: selectedCandidate.artifact,
      stagedPath: state.stagedPath,
      signal: operation.controller.signal
    });
  };
  const createExecutor = (
    updater: ElectronLauncherReleaseUpdater,
    context: ElectronLauncherApplicationUpdateContext,
    operation: Operation,
    installerContext?: ElectronLauncherApplicationUpdateLifecycleContext
  ): ElectronLauncherReleaseUpdateExecutor => createElectronLauncherReleaseUpdateExecutor({
    updater,
    baseDir,
    installId: context.installId,
    networkGate: options.networkGate,
    applyConfig: options.applyConfig,
    applyRenderer: options.applyRenderer,
    onPhase: (phase, detail) => {
      if (operation.generation !== generation || operation.controller.signal.aborted) return;
      try {
        options.onExecutorPhase?.(phase, detail);
      } catch {
        // Observers must not interrupt an update transaction.
      }
      if (phase === 'downloading' || phase === 'verifying' || phase === 'staged') {
        update({ phase }, operation);
      }
    },
    openInstaller: async (filePath) => {
      if (!options.openInstaller || !installerContext) {
        throw new Error('application updater requires openInstaller to install this artifact');
      }
      await options.openInstaller(filePath, installerContext);
    }
  });

  const performCheck = async (
    operation: Operation,
    suppliedContext?: ElectronLauncherApplicationUpdateContext
  ): Promise<ElectronLauncherApplicationUpdateState> => {
    const unsupportedState = unsupported(operation);
    if (unsupportedState) return unsupportedState;
    lastContext = null;
    lastUpdater = null;
    lastExecutor = null;
    selectedCandidate = null;
    activePath = null;
    installationHandoffStarted = false;
    irreversibleCommitReason = null;
    update({
      phase: 'checking',
      updateAvailable: false,
      checkedAt: null,
      targetVersion: null,
      releaseId: null,
      releaseNotes: null,
      deliveryMode: null,
      check: null,
      selectedArtifact: null,
      artifactKind: null,
      artifactClass: null,
      stagedPath: null,
      staged: false,
      progress: null,
      bytesReceived: 0,
      totalBytes: null,
      percent: null,
      reason: null,
      error: null
    }, operation);
    const context = suppliedContext ?? await readContext(operation);
    if (!context) {
      return update({
        phase: 'needs-network',
        reason: 'Launcher network is not ready',
        error: null
      }, operation);
    }
    const updater = createUpdater(context);
    const checkedCandidates: Array<{
      component: Readonly<ElectronLauncherApplicationUpdateComponentCandidate>;
      check: ElectronLauncherUpdateCheckResult;
    }> = [];
    const componentErrors: Error[] = [];
    for (const component of componentCandidates) {
      checkpoint(operation);
      try {
        const check = immutableClone(await updater.check({
          componentKind: component.componentKind,
          componentId: component.componentId,
          currentVersion: component.currentVersion || currentVersion,
          channel,
          installId: context.installId,
          userId: context.userId,
          platform: options.platform ?? process.platform,
          arch: options.arch ?? process.arch,
          signal: operation.controller.signal
        }));
        checkpoint(operation);
        checkedCandidates.push({ component, check });
      } catch (error) {
        checkpoint(operation);
        if (options.componentCheckFailureMode !== 'best-effort') throw error;
        componentErrors.push(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    }
    if (checkedCandidates.length === 0 && componentErrors.length > 0) throw componentErrors[0];
    const artifactCandidates = checkedCandidates.flatMap(({ component, check }) =>
      check.status === 'update-available'
        ? check.artifacts
            .map((artifact) => Object.freeze({ component, check, artifact }))
            .filter(({ artifact }) => classifyElectronLauncherUpdateArtifact(artifact.kind) !== 'unknown')
        : []
    );
    const fingerprints = new Map(
      artifactCandidates.map((candidate) => [candidate, candidateFingerprint(candidate)])
    );
    const selectedByProduct = options.selectArtifact
      ? options.selectArtifact(artifactCandidates)
      : artifactCandidates[0] ?? null;
    if (selectedByProduct && !artifactCandidates.includes(selectedByProduct)) {
      throw new Error('selectArtifact must return one of the supplied candidates');
    }
    if (
      selectedByProduct
      && fingerprints.get(selectedByProduct) !== candidateFingerprint(selectedByProduct)
    ) {
      throw new Error('selectArtifact must not mutate a supplied candidate');
    }
    const selected = selectedByProduct ? cloneCandidate(selectedByProduct) : null;
    if (selected) assertVerifiableArtifact(selected.artifact);
    const representative = selected?.check
      ?? checkedCandidates.find(({ check }) => check.status === 'update-available')?.check
      ?? checkedCandidates.find(({ check }) => check.status === 'blocked')?.check
      ?? checkedCandidates.find(({ check }) => check.status === 'up-to-date')?.check
      ?? checkedCandidates[0]?.check;
    if (!representative) throw new Error('Release Center returned no update checks');
    if (representative.status === 'update-available' && !selected) {
      throw new Error('Release Center returned an update without an applicable artifact');
    }
    checkpoint(operation);
    lastContext = context;
    lastUpdater = updater;
    lastExecutor = null;
    selectedCandidate = selected;
    activePath = null;
    const common = {
      checkedAt: representative.checkedAt,
      targetVersion: representative.decision.targetVersion || null,
      releaseId: representative.plan?.releaseId ?? null,
      releaseNotes: representative.releaseNotes ?? null,
      deliveryMode: representative.deliveryMode ?? 'prompt-download-restart' as const,
      check: representative,
      selectedArtifact: selected?.artifact ?? null,
      artifactKind: selected?.artifact.kind ?? null,
      artifactClass: selected ? classifyElectronLauncherUpdateArtifact(selected.artifact.kind) : null,
      stagedPath: null,
      staged: false,
      progress: null,
      bytesReceived: 0,
      totalBytes: null,
      percent: null,
      reason: representative.reason,
      error: null
    };
    if (representative.status === 'update-available') {
      return update({ ...common, phase: 'available', updateAvailable: true }, operation);
    }
    if (representative.status === 'blocked') {
      return update({ ...common, phase: 'blocked', updateAvailable: false }, operation);
    }
    if (representative.status === 'up-to-date') {
      return update({ ...common, phase: 'up-to-date', updateAvailable: false }, operation);
    }
    return update({
      ...common,
      phase: 'error',
      updateAvailable: false,
      error: representative.reason || 'Release Center update check failed'
    }, operation);
  };

  const activateStagedIfNeeded = async (operation: Operation): Promise<ElectronLauncherApplicationUpdateState> => {
    if (!selectedCandidate || !lastExecutor || !state.stagedPath) {
      throw new Error('application update has no staged artifact');
    }
    const artifactClass = classifyElectronLauncherUpdateArtifact(selectedCandidate.artifact.kind);
    if (artifactClass === 'installer') {
      return update({ phase: 'ready', staged: true, progress: null, reason: 'installer is ready for manual installation' }, operation);
    }
    if (activePath) {
      return update({ phase: 'ready', staged: true, progress: null }, operation);
    }
    if (artifactClass !== 'asar' && !selectedCandidate.artifact.autoApply) {
      return update({ phase: 'staged', staged: true, progress: null, reason: 'manual activation required' }, operation);
    }
    await assertNetworkGateReady(operation);
    const context = lifecycleContext(operation);
    await options.beforeActivate?.(context);
    checkpoint(operation);
    await assertNetworkGateReady(operation);
    markCommitted(operation, 'verified artifact activation has started');
    const activation = await lastExecutor.activateStaged(
      selectedCandidate.artifact,
      state.stagedPath,
      { releaseId: selectedCandidate.check.plan?.releaseId ?? null }
    );
    checkpoint(operation);
    activePath = activation.activePath;
    return update({
      phase: activation.activePath ? 'ready' : 'staged',
      staged: true,
      progress: null,
      reason: activation.deferredReason || (activation.activePath ? 'update is ready' : 'activation deferred')
    }, operation);
  };

  const performDownload = async (operation: Operation): Promise<ElectronLauncherApplicationUpdateState> => {
    const unsupportedState = unsupported(operation);
    if (unsupportedState) return unsupportedState;
    if (!selectedCandidate || !lastUpdater || !lastContext || state.check?.status !== 'update-available') {
      const checked = await performCheck(operation);
      if (checked.phase !== 'available') return checked;
    }
    checkpoint(operation);
    if (!selectedCandidate || !lastUpdater || !lastContext) {
      throw new Error('application update has no selected artifact');
    }
    await assertContextUnchanged(operation);
    assertVerifiableArtifact(selectedCandidate.artifact);
    if (state.stagedPath) return activateStagedIfNeeded(operation);
    const executor = createExecutor(lastUpdater, lastContext, operation);
    lastExecutor = executor;
    const artifact = { ...selectedCandidate.artifact, autoApply: false };
    const executionCheck: ElectronLauncherUpdateCheckResult = {
      ...selectedCandidate.check,
      artifacts: [artifact]
    };
    update({
      phase: 'downloading',
      staged: false,
      progress: null,
      bytesReceived: 0,
      totalBytes: null,
      percent: null,
      reason: 'downloading update',
      error: null
    }, operation);
    const result = await executor.execute(executionCheck, {
      signal: operation.controller.signal,
      downloadTimeoutMs: options.downloadTimeoutMs,
      onProgress: (progress) => {
        if (operation.generation !== generation || operation.controller.signal.aborted) return;
        const safeProgress = immutableClone(progress);
        try {
          options.onProgress?.(safeProgress);
        } catch {
          // Progress observers must not interrupt a verified download.
        }
        if (operation.generation !== generation || operation.controller.signal.aborted) return;
        update({
          phase: safeProgress.phase,
          progress: safeProgress,
          bytesReceived: safeProgress.bytesReceived,
          totalBytes: safeProgress.totalBytes,
          percent: safeProgress.percent
        }, operation);
      }
    });
    checkpoint(operation);
    const execution = result.artifacts.find((item) => item.artifactId === artifact.artifactId);
    if (!execution || execution.phase === 'failed' || execution.phase === 'cancelled' || !execution.stagedPath) {
      throw new Error(execution?.error || result.reason || 'release artifact download failed');
    }
    update({
      phase: 'staged',
      stagedPath: execution.stagedPath,
      staged: true,
      progress: null,
      reason: execution.deferredReason || 'update artifact staged'
    }, operation);
    checkpoint(operation);
    return activateStagedIfNeeded(operation);
  };

  const performInstall = async (operation: Operation): Promise<ElectronLauncherApplicationUpdateState> => {
    const unsupportedState = unsupported(operation);
    if (unsupportedState) return unsupportedState;
    if (!selectedCandidate || !lastExecutor || !state.stagedPath) {
      throw new Error('download and verify the application update before installing it');
    }
    if (installationHandoffStarted) {
      return update({
        phase: 'installing',
        reason: 'installation handoff already started; duplicate install was ignored',
        error: null
      }, operation);
    }
    await assertContextUnchanged(operation);
    assertVerifiableArtifact(selectedCandidate.artifact);
    const artifactClass = classifyElectronLauncherUpdateArtifact(selectedCandidate.artifact.kind);
    if (artifactClass === 'asar' && !activePath) {
      const activated = await activateStagedIfNeeded(operation);
      if (activated.phase !== 'ready') return activated;
    }
    checkpoint(operation);
    await assertNetworkGateReady(operation);
    const context = lifecycleContext(operation);
    update({ phase: 'installing', progress: null, reason: 'installing update', error: null }, operation);
    if (artifactClass === 'installer') {
      if (!options.openInstaller) throw new Error('application updater requires openInstaller for installer artifacts');
      if (!lastUpdater || !lastContext) throw new Error('application update context is no longer available');
      const installerExecutor = createExecutor(lastUpdater, lastContext, operation, context);
      await installerExecutor.openStagedInstaller(selectedCandidate.artifact, {
        stagedPath: state.stagedPath,
        releaseId: selectedCandidate.check.plan?.releaseId ?? null
      });
      // A failed opener must remain retryable. Once it resolves, however, the
      // operating-system handoff may already be irreversible even if the
      // caller cancelled while the opener was awaiting completion.
      recordCompletedHandoff(operation, 'installer handoff has started');
      installationHandoffStarted = true;
    } else if (artifactClass === 'asar' && (!options.relaunch || !options.exit)) {
      throw new Error('application updater requires relaunch and exit for ASAR artifacts');
    }
    await options.beforeInstallCleanup?.(context);
    if (artifactClass === 'asar') {
      checkpoint(operation);
      await assertNetworkGateReady(operation);
      markCommitted(operation, 'application relaunch has started');
      installationHandoffStarted = true;
      await options.relaunch?.(context);
    }
    await options.exit?.(0, context);
    return update({
      phase: 'installing',
      reason: artifactClass === 'installer' ? 'installer opened' : 'application relaunch requested'
    }, operation);
  };

  const api: ElectronLauncherApplicationUpdater = {
    getState: snapshot,
    handleNetworkReady(operationOptions = {}) {
      if (networkReadyInFlight) return networkReadyInFlight;
      const operationPromise = scheduleOperation(operationOptions.signal, async (operation) => {
        const unsupportedState = unsupported(operation);
        if (unsupportedState) return unsupportedState;
        const context = await readContext(operation);
        if (!context) {
          return update({ phase: 'needs-network', reason: 'Launcher network is not ready', error: null }, operation);
        }
        const identity = [context.baseUrl, context.installId || '', context.userId || '', channel, currentVersion].join('\u0000');
        if (automaticCheckIdentity === identity) return snapshot();
        try {
          await reportElectronLauncherInstallCompletionIfUpgraded({
            updater: createUpdater(context),
            baseDir,
            currentVersion,
            installId: context.installId
          });
        } catch {
          // Startup bookkeeping is best-effort and must not suppress update checks.
        }
        checkpoint(operation);
        const checked = await performCheck(operation, context);
        checkpoint(operation);
        if (checked.phase === 'error' || checked.phase === 'cancelled' || checked.phase === 'needs-network') return checked;
        if (
          checked.phase === 'available'
          && checked.deliveryMode === 'silent-download-next-start'
          && checked.artifactClass === 'asar'
        ) {
          const downloaded = await performDownload(operation);
          if (downloaded.phase !== 'error' && downloaded.phase !== 'cancelled') {
            automaticCheckIdentity = identity;
          }
          return downloaded;
        }
        automaticCheckIdentity = identity;
        return checked;
      });
      networkReadyInFlight = operationPromise.finally(() => {
        if (networkReadyInFlight === tracked) networkReadyInFlight = null;
      });
      const tracked = networkReadyInFlight;
      return tracked;
    },
    check(operationOptions = {}) {
      if (checkInFlight) return checkInFlight;
      const operationPromise = scheduleOperation(operationOptions.signal, performCheck);
      checkInFlight = operationPromise.finally(() => {
        if (checkInFlight === tracked) checkInFlight = null;
      });
      const tracked = checkInFlight;
      return tracked;
    },
    download(operationOptions = {}) {
      if (downloadInFlight) return downloadInFlight;
      const operationPromise = scheduleOperation(operationOptions.signal, performDownload);
      downloadInFlight = operationPromise.finally(() => {
        if (downloadInFlight === tracked) downloadInFlight = null;
      });
      const tracked = downloadInFlight;
      return tracked;
    },
    install(operationOptions = {}) {
      if (installInFlight) return installInFlight;
      const operationPromise = scheduleOperation(operationOptions.signal, performInstall);
      installInFlight = operationPromise.finally(() => {
        if (installInFlight === tracked) installInFlight = null;
      });
      const tracked = installInFlight;
      return tracked;
    },
    cancel(reason = 'application update cancelled') {
      generation += 1;
      const committed = [...activeOperations].find((operation) => operation.committed);
      const committedReason = committed?.commitReason || irreversibleCommitReason;
      for (const operation of activeOperations) {
        if (!operation.committed) operation.controller.abort(reason);
      }
      checkInFlight = null;
      downloadInFlight = null;
      installInFlight = null;
      networkReadyInFlight = null;
      return publish({
        ...state,
        phase: committedReason ? state.phase : 'cancelled',
        progress: null,
        reason: committedReason
          ? `${committedReason}; cancellation cannot undo it`
          : reason,
        error: null
      });
    }
  };

  return api;
}

function normalizeComponentCandidates(
  value: readonly ElectronLauncherApplicationUpdateComponentCandidate[] | undefined
): readonly ElectronLauncherApplicationUpdateComponentCandidate[] {
  const candidates = value?.length ? value : DEFAULT_COMPONENT_CANDIDATES;
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    componentKind: requiredValue(candidate.componentKind, 'componentCandidates.componentKind'),
    componentId: candidate.componentId?.trim() || null,
    currentVersion: candidate.currentVersion?.trim() || undefined
  })));
}

function requiredValue(value: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`application updater requires ${name}`);
  return normalized;
}

function normalizedBaseUrl(value: string): string {
  const normalized = requiredValue(value, 'context.baseUrl').replace(/\/+$/, '');
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('application update context.baseUrl must use HTTP or HTTPS');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function contextIdentity(context: ElectronLauncherApplicationUpdateContext): string {
  return [context.baseUrl, context.installId || '', context.userId || ''].join('\u0000');
}

function assertVerifiableArtifact(artifact: ElectronLauncherReleaseArtifactRef): void {
  if (!artifact.url?.trim()) {
    throw new Error(`release artifact ${artifact.artifactId} has no download URL`);
  }
  const digest = artifact.digest?.trim() || '';
  if (!/^(?:sha256:)?[a-f0-9]{64}$/i.test(digest)) {
    throw new Error(`release artifact ${artifact.artifactId} requires a SHA-256 digest`);
  }
  if (!Number.isSafeInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) < 0) {
    throw new Error(`release artifact ${artifact.artifactId} requires a non-negative integer sizeBytes`);
  }
}

function cancellationReason(signal: AbortSignal): string {
  if (typeof signal.reason === 'string' && signal.reason.trim()) return signal.reason.trim();
  if (signal.reason instanceof Error && signal.reason.message) return signal.reason.message;
  return 'application update cancelled';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'application update failed';
}

function candidateFingerprint(
  candidate: ElectronLauncherApplicationUpdateArtifactCandidate
): string {
  return JSON.stringify(candidate);
}

function cloneCandidate(
  candidate: ElectronLauncherApplicationUpdateArtifactCandidate
): ElectronLauncherApplicationUpdateArtifactCandidate {
  return immutableClone(candidate);
}

function immutableClone<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

class ApplicationUpdateCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationUpdateCancelledError';
  }
}
