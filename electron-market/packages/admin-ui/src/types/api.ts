/**
 * Mirror of the host-side types. Kept hand-maintained so the admin SPA can
 * be built independently of the runtime package (no path-into-dist imports).
 */

export type Permission = string;

export type PluginState =
  | 'installed'
  | 'awaitingGrant'
  | 'active'
  | 'errored'
  | 'disabled';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  homepage?: string;
  engines: { electronMarket?: string; electronPlugin?: string; electron?: string };
  permissions: Permission[];
  activationEvents: string[];
  contributes?: {
    adminPanel?: { url: string; label?: string };
    settings?: { schema: string };
    commands?: Array<{ id: string; title: string }>;
  };
}

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

export type Visibility = 'public' | 'free' | 'paid' | 'private';

export interface MarketplaceEntry {
  id: string;
  npm: string;
  name: string;
  description: string;
  versions: string[];
  latest: string;
  manifestUrl: string;
  tarballUrl?: string;
  homepage?: string;
  category?: string | null;
  verified: boolean;
  signature?: string;
  bootstrap?: boolean;
  visibility?: Visibility;
  metadata?: Record<string, unknown> | null;
}

export interface MarketplaceIndex {
  generatedAt: string;
  entries: MarketplaceEntry[];
}

export interface PluginLogEntry {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}
