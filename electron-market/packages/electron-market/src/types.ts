import type { PluginManifest, Permission } from '@qpjoy/electron-plugin-sdk';

export type { PluginManifest, Permission };

export type PluginState =
  | 'installed'      // present on disk, manifest scanned, not activated
  | 'awaitingGrant'  // user hasn't approved permissions yet
  | 'active'         // activate() resolved
  | 'errored'        // activate() threw or runtime crashed
  | 'disabled';      // user toggled off

export interface InstalledPluginRecord {
  id: string;
  npm: string;
  version: string;
  installPath: string;
  manifest: PluginManifest;
  grantedPermissions: Permission[];
  state: PluginState;
  errorMessage: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface MarketplaceEntry {
  id: string;
  npm: string;
  name: string;
  description: string;
  versions: string[];
  latest: string;
  manifestUrl: string;
  /** Optional direct tarball URL. Lets the host install without hitting the
   *  npm metadata API — handy on locked-down networks. */
  tarballUrl?: string;
  homepage?: string;
  verified: boolean;
  signature?: string;
  /** True for the small set of plugins that the host treats as bootstrap
   *  candidates: they may need to be installed offline before the network
   *  exists. The tunnel is the canonical example. */
  bootstrap?: boolean;
}

export interface MarketplaceIndex {
  generatedAt: string;
  entries: MarketplaceEntry[];
}

export interface HostLogEntry {
  id: number;
  pluginId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}
