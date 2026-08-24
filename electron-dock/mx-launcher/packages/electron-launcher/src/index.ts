import {
  assertCompatibleBroker,
  brokerAbiVersion,
  createLauncherEmbedManifest,
  createLauncherClient,
  createLauncherNetworkSession,
  createLauncherWireGuardKeyPair,
  launcherBrokerCompatibility,
  launcherEmbedRuntimeContractVersion,
  launcherNetworkScopeForMode,
  launcherProtocolVersion,
  networkDigest,
  networkRefreshKey,
  normalizeLauncherBaseUrl,
  routePlanFromSnapshot,
  shouldRefreshNetwork,
  type FetchLike,
  type LauncherBrokerCapabilitySession,
  type LauncherBrokerHandshakeDeniedReason,
  type LauncherBrokerHandshakeRequest,
  type LauncherBrokerHandshakeResult,
  type LauncherCapability,
  type LauncherChannelRecord,
  type LauncherClient,
  type LauncherClientOptions,
  type LauncherEmbedConnectionState,
  type LauncherEmbedBrokerRequestName,
  type LauncherEmbedManifestInput,
  type LauncherEmbedRuntimeEventName,
  type LauncherIdentityKind,
  type LauncherManifest,
  type LauncherNetworkLease,
  type LauncherNetworkLeaseInput,
  type LauncherNetworkScope,
  type LauncherNetworkSession,
  type LauncherNetworkSessionInput,
  type LauncherNetworkSnapshot,
  type LauncherNetworkSnapshotInput,
  type LauncherProductMode,
  type LauncherProductNetwork,
  type LauncherProductNetworkInput,
  type LauncherProductUpdatePolicy,
  type LauncherRoutePlan,
  type LauncherWireGuardKeyMaterial,
  type LauncherWireGuardKeyPair,
  type LauncherWireGuardKeyProvider
} from '@qpjoy/mx-launcher-core';
import {
  createEmbedLauncher,
  type EmbedConnectOptions,
  type EmbedConnectionResult,
  type EmbedBrokerConnectOptions,
  type EmbedBrokerRequestHandler,
  type EmbedLauncherConnection,
  type EmbedLauncherEventHandler,
  type EmbedLauncherEventName,
  type EmbedLauncher,
  type EmbedLauncherOptions,
  type EmbedLegacyNetworkApi,
  type LauncherChannelRegistrySource,
  type EmbedSnapshotOptions
} from '@qpjoy/mx-launcher-embed-sdk';
import {
  createStandaloneLauncher,
  type StandaloneLeaseOptions,
  type StandaloneNetworkSessionOptions,
  type StandaloneConnectOptions,
  type StandaloneConnectionResult,
  type StandaloneLauncher,
  type StandaloneLauncherOptions,
  type StandaloneSnapshotOptions,
  type StandaloneUserConnectOptions
} from '@qpjoy/mx-launcher-standalone';
export {
  loadElectronLauncherEnvFiles,
  normalizeElectronLauncherBootstrapUrl,
  parseElectronLauncherBootstrapUrls,
  resolveElectronLauncherBootstrap,
  type ElectronLauncherBootstrapCandidate,
  type ElectronLauncherBootstrapProbe,
  type ElectronLauncherBootstrapResolution,
  type ResolveElectronLauncherBootstrapOptions
} from './bootstrap.js';
export {
  createElectronLauncherSystemDomainProxy,
  renderElectronLauncherPacScript,
  type ElectronLauncherExternalApplyAbortExecution,
  type ElectronLauncherExternalApplyAbortOptions,
  type ElectronLauncherPacProxy,
  type ElectronLauncherPacMatchMode,
  type ElectronLauncherSystemDomainProxyApplyOptions,
  type ElectronLauncherSystemDomainProxyManager,
  type ElectronLauncherSystemDomainProxyOptions,
  type ElectronLauncherSystemDomainProxyPolicy,
  type ElectronLauncherSystemDomainProxyRoute,
  type ElectronLauncherSystemDomainProxyStatus
} from './system-domain-proxy.js';
export {
  classifyLauncherIpv4Address,
  diagnoseLauncherHostResolution,
  type ElectronLauncherAddressDiagnostic,
  type ElectronLauncherHostResolutionDiagnostics,
  type ElectronLauncherHostResolutionDiagnosticInput,
  type ElectronLauncherHostResolutionSeverity,
  type ElectronLauncherHostResolutionState,
  type ElectronLauncherIpClassification,
  type ElectronLauncherNetworkPhase
} from './network-diagnostics.js';
export {
  buildElectronLauncherNetworkOwnershipRegistry,
  mergedElectronLauncherDnsZones,
  mergedElectronLauncherReverseProxyRoutes,
  resolveElectronLauncherDnsOwner,
  type ElectronLauncherNetworkOwner,
  type ElectronLauncherNetworkOwnerState,
  type ElectronLauncherNetworkOwnershipClaim,
  type ElectronLauncherNetworkOwnershipConflict,
  type ElectronLauncherNetworkOwnershipEntry,
  type ElectronLauncherNetworkOwnershipRegistry,
  type ElectronLauncherNetworkOwnershipResource,
  type ElectronLauncherNetworkOwnershipRoute
} from './network-ownership-registry.js';
export {
  defaultElectronLauncherNetworkModeEventStatePath,
  publishElectronLauncherNetworkModeEvent,
  readElectronLauncherNetworkModeEventState,
  subscribeElectronLauncherNetworkModeEvents,
  type ElectronLauncherNetworkMode,
  type ElectronLauncherNetworkModeEvent,
  type ElectronLauncherNetworkModeEventInput,
  type ElectronLauncherNetworkModeEventName,
  type ElectronLauncherNetworkModeEventPhase,
  type ElectronLauncherNetworkModeEventPublishOptions,
  type ElectronLauncherNetworkModeEventState
} from './network-mode-events.js';
export {
  applyElectronLauncherStandaloneDataPlane,
  buildElectronLauncherStandaloneOwnershipClaim,
  claimElectronLauncherStandaloneOwnershipClaim,
  diagnoseElectronLauncherStandaloneDataPlane,
  readElectronLauncherStandaloneOwnershipState,
  releaseElectronLauncherStandaloneOwnershipClaim,
  stopElectronLauncherStandaloneDataPlane,
  upsertElectronLauncherStandaloneOwnershipClaim,
  type ElectronLauncherStandaloneDataPlaneApplyInput,
  type ElectronLauncherStandaloneDataPlaneApplyResult,
  type ElectronLauncherStandaloneDataPlaneDiagnostics,
  type ElectronLauncherStandaloneDataPlaneInput,
  type ElectronLauncherStandaloneDataPlaneProbeTarget,
  type ElectronLauncherStandaloneDataPlaneSeverity,
  type ElectronLauncherStandaloneDataPlaneStopInput,
  type ElectronLauncherStandaloneDataPlaneStopResult,
  type ElectronLauncherStandaloneDataPlaneState,
  type ElectronLauncherStandaloneEndpointProbe,
  type ElectronLauncherStandaloneOwnershipClaimOptions,
  type ElectronLauncherStandaloneOwnershipClaimResult,
  type ElectronLauncherStandaloneOwnershipInput,
  type ElectronLauncherStandaloneOwnershipState,
  type ElectronLauncherStandaloneRouteProbe
} from './standalone-data-plane.js';
export {
  createElectronLauncherReleaseUpdater,
  downloadElectronLauncherReleaseArtifactToFile,
  type ElectronLauncherArtifactDownloadInput,
  type ElectronLauncherArtifactDownloadResult,
  type ElectronLauncherReleaseActivationMode,
  type ElectronLauncherReleaseArtifactRef,
  type ElectronLauncherReleasePlan,
  type ElectronLauncherReleasePolicyDecision,
  type ElectronLauncherReleaseReportInput,
  type ElectronLauncherReleaseUpdateMode,
  type ElectronLauncherReleaseUpdater,
  type ElectronLauncherReleaseUpdaterOptions,
  type ElectronLauncherUpdateCheckInput,
  type ElectronLauncherUpdateCheckResult
} from './release-updater.js';
export {
  allocateElectronLauncherLocalPort,
  electronLauncherDefaultBasePort,
  type ElectronLauncherLocalPortLease,
  type ElectronLauncherLocalPortRequest
} from './local-ports.js';
export {
  ensureElectronLauncherUserOverseaSubscription,
  type ElectronLauncherOverseaEnsureStatus,
  type ElectronLauncherUserOverseaEnsureResult,
  type ElectronLauncherUserOverseaSubscription,
  type EnsureElectronLauncherUserOverseaSubscriptionInput
} from './oversea.js';
export {
  adoptPendingElectronLauncherPackages,
  classifyElectronLauncherUpdateArtifact,
  createElectronLauncherReleaseUpdateExecutor,
  reportElectronLauncherInstallCompletionIfUpgraded,
  type ElectronLauncherArtifactActivation,
  type ElectronLauncherArtifactExecution,
  type ElectronLauncherNetworkGateState,
  type ElectronLauncherReleaseUpdateExecutor,
  type ElectronLauncherUpdateArtifactClass,
  type ElectronLauncherUpdateExecutionResult,
  type ElectronLauncherUpdateExecutorOptions,
  type ElectronLauncherUpdateExecutorPhase
} from './release-update-executor.js';

export const ELECTRON_LAUNCHER_PACKAGE_NAME = '@qpjoy/electron-launcher';

export type ElectronLauncherMode = LauncherProductMode;

export interface ElectronLauncherOptions extends LauncherClientOptions {
  productId?: string;
  appId?: string;
  mode?: ElectronLauncherMode;
  standaloneChannelProductId?: string;
  requiredCapabilities?: LauncherCapability[];
  sdkVersion?: string;
  appVersion?: string;
  displayName?: string;
  description?: string;
  packageName?: string;
  category?: string;
  runtimeContractVersion?: string;
  channelRegistry?: LauncherChannelRegistrySource;
  requestImpl?: EmbedBrokerRequestHandler;
  installId?: string;
  deviceId?: string;
  siteId?: string;
  publicKey?: string;
  privateKey?: string;
  keyPair?: LauncherWireGuardKeyPair;
  keyProvider?: LauncherWireGuardKeyProvider;
  deviceLabel?: string;
}

export type ElectronLauncher = EmbedLauncher | StandaloneLauncher;

export interface LauncherProductActions {
  network: boolean;
  release: boolean;
  update: boolean;
  rollout: boolean;
  appCenter: boolean;
}

export interface LauncherProductDefinition {
  productId: string;
  displayName: string;
  mode: ElectronLauncherMode;
  networkScope: LauncherNetworkScope;
  standaloneChannelProductId: string;
  appCenter: {
    visible: boolean;
    category: string;
  };
  release: {
    componentId: string;
    channel: string;
    rolloutGroup: string | null;
  };
  launcherActions: LauncherProductActions;
}

export interface LauncherProductDefinitionInput {
  productId: string;
  displayName?: string;
  mode?: ElectronLauncherMode;
  standaloneChannelProductId?: string;
  appCenter?: {
    visible?: boolean;
    category?: string;
  };
  release?: {
    componentId?: string;
    channel?: string;
    rolloutGroup?: string | null;
  };
  launcherActions?: Partial<LauncherProductActions>;
}

export function createElectronLauncher(options: ElectronLauncherOptions): ElectronLauncher {
  const mode = options.mode ?? 'embed';
  if (mode === 'standalone') {
    return createStandaloneLauncher({
      ...options,
      productId: options.productId ?? 'launcher'
    });
  }
  return createEmbedLauncher({
    ...options,
    productId: requiredProductId(options.productId ?? options.appId),
    appId: options.appId ?? options.productId
  });
}

export function defineLauncherProduct(input: LauncherProductDefinitionInput): LauncherProductDefinition {
  const productId = requiredProductId(input.productId);
  const displayName = input.displayName?.trim() || productId;
  const mode = input.mode ?? 'embed';
  const standaloneChannelProductId = mode === 'standalone'
    ? productId
    : input.standaloneChannelProductId?.trim() || 'mx-h2i';
  const actions = input.launcherActions ?? {};
  return {
    productId,
    displayName,
    mode,
    networkScope: launcherNetworkScopeForMode(mode),
    standaloneChannelProductId,
    appCenter: {
      visible: input.appCenter?.visible ?? true,
      category: input.appCenter?.category?.trim() || 'app'
    },
    release: {
      componentId: input.release?.componentId?.trim() || productId,
      channel: input.release?.channel?.trim() || 'stable',
      rolloutGroup: input.release?.rolloutGroup ?? null
    },
    launcherActions: {
      network: actions.network ?? true,
      release: actions.release ?? true,
      update: actions.update ?? true,
      rollout: actions.rollout ?? true,
      appCenter: actions.appCenter ?? true
    }
  };
}

function requiredProductId(productId: string | undefined): string {
  const trimmed = productId?.trim();
  if (!trimmed) throw new Error('Electron Launcher productId is required for embed mode');
  return trimmed;
}

export {
  assertCompatibleBroker,
  brokerAbiVersion,
  createEmbedLauncher,
  createLauncherClient,
  createLauncherEmbedManifest,
  createLauncherNetworkSession,
  createLauncherWireGuardKeyPair,
  createStandaloneLauncher,
  launcherBrokerCompatibility,
  launcherEmbedRuntimeContractVersion,
  launcherNetworkScopeForMode,
  launcherProtocolVersion,
  networkDigest,
  networkRefreshKey,
  normalizeLauncherBaseUrl,
  routePlanFromSnapshot,
  shouldRefreshNetwork
};

export type {
  EmbedBrokerConnectOptions,
  EmbedBrokerRequestHandler,
  EmbedConnectOptions,
  EmbedConnectionResult,
  EmbedLauncherConnection,
  EmbedLauncherEventHandler,
  EmbedLauncherEventName,
  EmbedLauncher,
  EmbedLauncherOptions,
  EmbedLegacyNetworkApi,
  EmbedSnapshotOptions,
  FetchLike,
  LauncherBrokerCapabilitySession,
  LauncherBrokerHandshakeDeniedReason,
  LauncherBrokerHandshakeRequest,
  LauncherBrokerHandshakeResult,
  LauncherCapability,
  LauncherChannelRegistrySource,
  LauncherChannelRecord,
  LauncherClient,
  LauncherClientOptions,
  LauncherEmbedConnectionState,
  LauncherEmbedBrokerRequestName,
  LauncherEmbedManifestInput,
  LauncherEmbedRuntimeEventName,
  LauncherIdentityKind,
  LauncherManifest,
  LauncherNetworkLease,
  LauncherNetworkLeaseInput,
  LauncherNetworkScope,
  LauncherNetworkSession,
  LauncherNetworkSessionInput,
  LauncherNetworkSnapshot,
  LauncherNetworkSnapshotInput,
  LauncherProductMode,
  LauncherProductNetwork,
  LauncherProductNetworkInput,
  LauncherProductUpdatePolicy,
  LauncherRoutePlan,
  LauncherWireGuardKeyMaterial,
  LauncherWireGuardKeyPair,
  LauncherWireGuardKeyProvider,
  StandaloneConnectOptions,
  StandaloneConnectionResult,
  StandaloneLeaseOptions,
  StandaloneNetworkSessionOptions,
  StandaloneLauncher,
  StandaloneLauncherOptions,
  StandaloneSnapshotOptions,
  StandaloneUserConnectOptions
};
