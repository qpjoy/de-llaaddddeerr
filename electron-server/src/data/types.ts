/**
 * Wire DTOs. These MUST stay in sync (field-name-identical) with
 * `@qpjoy/marketplace-db/src/types.ts` so the host can round-trip
 * server JSON straight into its SQLite without translation.
 *
 * When we eventually move from JSON-on-disk to Postgres, the DAO layer
 * changes; these types do not.
 */

export type Visibility = 'public' | 'free' | 'paid' | 'private';

/** Server-side metadata for a plugin id. */
export interface MarketplaceEntryDTO {
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
}

export interface MarketplaceIndexDTO {
  generatedAt: string;       // ISO timestamp
  release: string;           // matches version.json.release
  entries: MarketplaceEntryDTO[];
}

export interface VersionManifestDTO {
  /** Monotonic release tag. Format intentionally free-form — usually a date or semver. */
  release: string;
  /** Server-recommended minimum client release. Older hosts get a polite 426 hint. */
  minClientRelease: string | null;
  /** Bumped when the plugin manifest spec changes shape. */
  marketSpecVersion: number;
  /** Range of plugin manifest spec versions this server can serve. */
  supportedSpecRange: string;
  /** Latest migration version available on the server. */
  migrationsHead: number;
  /** ETag of the marketplace index JSON — clients use this to skip re-fetching when unchanged. */
  manifestEtag: string;
  publishedAt: string;       // ISO
}

export interface PluginVersionDTO {
  version: string;
  changelog: string | null;
  releasedAt: string | null;
  minHostVersion: string | null;
  maxHostVersion: string | null;
  deprecated: boolean;
  yanked: boolean;
  manifestChecksum: string | null;
  tarballChecksum: string | null;
  tarballUrl: string | null;
}

export interface PluginDetailDTO extends MarketplaceEntryDTO {
  versions: PluginVersionDTO[];
  /** Full manifest of the latest version, if known. */
  latestManifest: Record<string, unknown> | null;
  /** Screenshots, README hash, license, etc. */
  extra: Record<string, unknown> | null;
}

export interface MigrationDTO {
  version: number;
  name: string;
  checksum: string;
  up: string;
  down: string | null;
}
