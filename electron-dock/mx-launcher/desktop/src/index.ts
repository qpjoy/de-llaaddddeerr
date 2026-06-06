export {
  getLauncherProduct,
  hdoProduct,
  launcherProducts,
  mxLauncherCatalog
} from './catalog.js';

export {
  createDefaultProductConfig,
  listProductConfigDefinitions
} from './config/registry.js';

export type {
  MxConfigScope,
  MxConfigSource,
  MxConfigValueType,
  MxLauncherCatalog,
  MxPlatform,
  MxProductArtifactContract,
  MxProductBackendContract,
  MxProductConfigDefinition,
  MxProductConfigRecord,
  MxProductDefinition
} from './contracts/mx.js';

export {
  decideStartupAction,
  type InstalledComponentState,
  type LauncherComponent,
  type LauncherStartupAction,
  type LauncherStartupDecision
} from './launcher/install-state.js';

export {
  findPackageFile,
  type PackageManifest,
  type PackageManifestFile
} from './security/package-manifest.js';

export type {
  MxServiceCommand,
  MxServiceRequest,
  MxServiceResponse
} from './service/contract.js';

export type {
  HdoAnonymousBootstrapRequest,
  HdoEmployeeLoginRequest,
  HdoLauncherBackendConfig,
  HdoLauncherConnectionState,
  HdoLauncherMode,
  HdoLauncherSession
} from './contracts/hdo.js';
