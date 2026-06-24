import {
  createLauncherClient,
  createLauncherNetworkSession,
  createLauncherWireGuardKeyPair,
  networkDigest,
  networkRefreshKey,
  normalizeLauncherBaseUrl,
  routePlanFromSnapshot,
  shouldRefreshNetwork,
  type FetchLike,
  type LauncherClient,
  type LauncherClientOptions,
  type LauncherIdentityKind,
  type LauncherNetworkLease,
  type LauncherNetworkLeaseInput,
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
  type EmbedLeaseOptions,
  type EmbedNetworkSessionOptions,
  type EmbedConnectOptions,
  type EmbedConnectionResult,
  type EmbedLauncher,
  type EmbedLauncherOptions,
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
  createElectronLauncherSystemDomainProxy,
  renderElectronLauncherPacScript,
  type ElectronLauncherPacProxy,
  type ElectronLauncherPacMatchMode,
  type ElectronLauncherSystemDomainProxyManager,
  type ElectronLauncherSystemDomainProxyOptions,
  type ElectronLauncherSystemDomainProxyPolicy,
  type ElectronLauncherSystemDomainProxyStatus
} from './system-domain-proxy.js';

export const ELECTRON_LAUNCHER_PACKAGE_NAME = '@qpjoy/electron-launcher';

export type ElectronLauncherMode = LauncherProductMode;

export interface ElectronLauncherOptions extends LauncherClientOptions {
  productId?: string;
  mode?: ElectronLauncherMode;
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
    productId: requiredProductId(options.productId)
  });
}

export function defineLauncherProduct(input: LauncherProductDefinitionInput): LauncherProductDefinition {
  const productId = requiredProductId(input.productId);
  const displayName = input.displayName?.trim() || productId;
  const mode = input.mode ?? 'embed';
  const actions = input.launcherActions ?? {};
  return {
    productId,
    displayName,
    mode,
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
  createEmbedLauncher,
  createLauncherClient,
  createLauncherNetworkSession,
  createLauncherWireGuardKeyPair,
  createStandaloneLauncher,
  networkDigest,
  networkRefreshKey,
  normalizeLauncherBaseUrl,
  routePlanFromSnapshot,
  shouldRefreshNetwork
};

export type {
  EmbedConnectOptions,
  EmbedConnectionResult,
  EmbedLauncher,
  EmbedLauncherOptions,
  EmbedLeaseOptions,
  EmbedNetworkSessionOptions,
  EmbedSnapshotOptions,
  FetchLike,
  LauncherClient,
  LauncherClientOptions,
  LauncherIdentityKind,
  LauncherNetworkLease,
  LauncherNetworkLeaseInput,
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
