/**
 * DTOs that cross module boundaries. These are the canonical shapes — the
 * REST API (electron-server) MUST use the same field names so JSON
 * round-trips without translation.
 */

export type Visibility = 'public' | 'free' | 'paid' | 'private';
export type EntrySource = 'remote' | 'seed' | 'manual';
export type InstallSource = 'seed' | 'registry' | 'tarball' | 'local-dir' | 'standalone';
export type PluginState =
  | 'installed'
  | 'awaitingGrant'
  | 'active'
  | 'errored'
  | 'disabled';
export type LogLevel = 'info' | 'warn' | 'error';
export type SyncScope = 'marketplace' | 'migrations' | 'user';

export interface MarketplaceEntry {
  id: string;
  npm: string;
  name: string;
  description: string | null;
  latestVersion: string;
  manifestUrl: string | null;
  tarballUrl: string | null;
  homepage: string | null;
  author: string | null;
  category: string | null;
  verified: boolean;
  bootstrap: boolean;
  visibility: Visibility;
  specVersion: number;
  metadata: Record<string, unknown> | null;
  source: EntrySource;
  fetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceVersion {
  entryId: string;
  version: string;
  changelog: string | null;
  releasedAt: string | null;
  minHostVersion: string | null;
  maxHostVersion: string | null;
  deprecated: boolean;
  yanked: boolean;
  manifestChecksum: string | null;
  tarballChecksum: string | null;
}

/**
 * Manifest as it appears on disk. Mirrored from `@qpjoy/electron-plugin-sdk`
 * intentionally (we don't want a runtime dep on the SDK in this package).
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  homepage?: string;
  engines: {
    /** Preferred semver range against `@qpjoy/electron-market`. */
    electronMarket?: string;
    /** @deprecated legacy alias for `electronMarket`. */
    electronPlugin?: string;
    electron?: string;
  };
  permissions: string[];
  activationEvents: string[];
  contributes?: Record<string, unknown>;
}

export interface InstalledPlugin {
  id: string;
  npm: string;
  version: string;
  installPath: string;
  installSource: InstallSource;
  manifest: PluginManifest;
  grantedPermissions: string[];
  state: PluginState;
  errorMessage: string | null;
  marketplaceEntryId: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface PluginLogEntry {
  id: number;
  pluginId: string;
  level: LogLevel;
  message: string;
  meta: Record<string, unknown> | null;
  correlationId: string | null;
  createdAt: string;
}

export interface RemoteSyncState {
  scope: SyncScope;
  lastRelease: string | null;
  lastFetchedAt: string | null;
  nextCheckAt: string | null;
  failureCount: number;
  lastError: string | null;
  data: Record<string, unknown> | null;
}

export interface AuthSession {
  id: number;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  user: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaMigrationRow {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}
