// Canonical entry point — name aligned with the published package
// `@qpjoy/electron-market`. The legacy `createElectronPluginHost` alias
// is kept so apps that pinned to `@qpjoy/electron-plugin@0.1.x` only need
// a package-name change to migrate to `@qpjoy/electron-market@0.2.0`.
export {
  createElectronPluginHost,
  createElectronPluginHost as createElectronMarket
} from './createElectronPluginHost';
export type {
  CreateElectronPluginHostOptions,
  CreateElectronPluginHostOptions as CreateElectronMarketOptions,
  ElectronPluginHostHandle,
  ElectronPluginHostHandle as ElectronMarketHandle
} from './createElectronPluginHost';
export {
  META_KEY_MARKET_SERVER,
  MARKET_SERVER_DEFAULTS,
  resolveMarketServer
} from './createElectronPluginHost';
export type {
  MarketServerSource,
  ResolvedMarketServer
} from './createElectronPluginHost';

export { PluginRegistry } from './registry/PluginRegistry';
export { MarketplaceClient } from './registry/MarketplaceClient';
export { PluginRuntime } from './runtime/PluginRuntime';
export { PermissionGate } from './runtime/PermissionGate';
export { PluginStore } from './store/PluginStore';
export { AdminServer } from './admin/AdminServer';
export { RemoteSyncJob, readSyncStatus, RemoteApiError } from './sync/RemoteSyncJob';
export type { SyncResult, SyncOutcome, RemoteSyncStatus } from './sync/RemoteSyncJob';
export { RemoteClient } from './sync/RemoteClient';
export type {
  RemoteClientOptions,
  RemoteMarketplaceIndex,
  VersionManifest,
  RemoteMigration,
  AuthTokens,
  PublicUser
} from './sync/RemoteClient';
export { AuthService } from './sync/AuthService';
export type { AuthState } from './sync/AuthService';

export type * from './types';
