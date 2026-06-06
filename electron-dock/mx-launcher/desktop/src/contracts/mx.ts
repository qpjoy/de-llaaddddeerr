export type MxPlatform = 'darwin' | 'win32' | 'linux';
export type MxConfigScope = 'global' | 'product' | 'user' | 'device' | 'install';
export type MxConfigValueType = 'string' | 'boolean' | 'number' | 'json' | 'secret';
export type MxConfigSource = 'default' | 'server' | 'user' | 'device' | 'installer';

export interface MxProductBackendContract {
  mxLauncherAdminApi: string;
  legacyApiBase: string | null;
  configApi: string | null;
}

export interface MxProductArtifactContract {
  resourcesDirectory: string;
  serviceProfile: string | null;
}

export interface MxProductConfigDefinition {
  key: string;
  label: string;
  scope: MxConfigScope;
  valueType: MxConfigValueType;
  required: boolean;
  sensitive?: boolean;
  defaultValue?: unknown;
  description?: string;
}

export interface MxProductConfigRecord {
  productId: string;
  key: string;
  scope: MxConfigScope;
  value: unknown;
  source: MxConfigSource;
  updatedAt: string;
}

export interface MxProductDefinition {
  id: string;
  name: string;
  legacyProductId: string | null;
  displayName: string;
  description: string;
  category: string;
  channels: string[];
  platforms: MxPlatform[];
  capabilities: string[];
  backend: MxProductBackendContract;
  artifacts: MxProductArtifactContract;
  config: MxProductConfigDefinition[];
}

export interface MxLauncherCatalog {
  schemaVersion: 1;
  platformName: 'MX Launcher';
  products: MxProductDefinition[];
}
