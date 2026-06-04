export interface HdoPluginSettings {
  hdoControlBaseUrl?: string | null;
  relayMode?: HdoRelayMode | null;
  sessionUserId?: string | null;
  deviceId?: string | null;
  deviceLabel?: string | null;
  devicePlatform?: string | null;
  wireGuardPeer?: HdoWireGuardPeerSettings | null;
  wireGuardDesiredActive?: boolean | null;
  wireGuardAutoRecover?: boolean | null;
  wireGuardLaunchDaemonEnabled?: boolean | null;
  autoRunDeviceTasks?: boolean | null;
  activeProfileId?: string | null;
  anonymous?: {
    mode?: 'anonymous' | null;
    appId?: string | null;
    installId?: string | null;
    updatedAt?: string | null;
  } | null;
  domainProxy?: Record<string, unknown> | null;
  lastTaskRun?: Record<string, unknown> | null;
  lastNotification?: Record<string, unknown> | null;
  lastManifest?: Record<string, unknown> | null;
  lastSubscription?: string | null;
  networkLeases?: HdoNetworkLeasesSettings | null;
  updatedAt?: string | null;
}

export type HdoRelayMode = 'mesh-hdi' | 'mesh-h2i' | 'mesh-h2h';

export type HdoServiceProtocol =
  | 'tcp'
  | 'udp'
  | 'http'
  | 'https'
  | 'ws'
  | 'wss'
  | 'ssh'
  | 'sftp'
  | 'scp'
  | 'ftp'
  | 'ftps'
  | 'mysql'
  | 'postgresql'
  | 'redis'
  | 'mongodb'
  | 'mssql'
  | 'rdp'
  | 'vnc'
  | 'smb'
  | 'ldap'
  | 'ldaps'
  | 'grpc'
  | 'grpcs'
  | 'mqtt'
  | 'amqp'
  | 'smtp'
  | 'imap'
  | 'pop3'
  | 'dns'
  | 'custom';

export interface HdoWireGuardPeerSettings {
  privateKey?: string | null;
  publicKey?: string | null;
  overlayIp?: string | null;
  address?: string | null;
  config?: string | null;
  configPath?: string | null;
  allowedIps?: string[] | null;
  h2iDirectCandidateIps?: string[] | null;
  routeProbe?: unknown | null;
  canUseDefaultMesh?: boolean | null;
  lastError?: string | null;
  updatedAt?: string | null;
}

export interface HdoNetworkLeaseSettings {
  deviceId?: string | null;
  sessionUserId?: string | null;
  anonymous?: HdoPluginSettings['anonymous'];
  wireGuardPeer?: HdoWireGuardPeerSettings | null;
  updatedAt?: string | null;
}

export interface HdoNetworkLeasesSettings {
  anonymous?: HdoNetworkLeaseSettings | null;
  account?: HdoNetworkLeaseSettings | null;
  accounts?: Record<string, HdoNetworkLeaseSettings | null> | null;
}

export interface HdoSessionSnapshot {
  loggedIn: boolean;
  user: Record<string, unknown> | null;
  hasAccessToken: boolean;
}

export interface HdoLocalPluginState {
  pluginId: string;
  npm: string | null;
  name: string | null;
  version: string | null;
  state: string;
  manifest: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
}

export interface HdoSnapshot {
  serverBaseUrl: string | null;
  marketServerBaseUrl: string | null;
  settings: HdoPluginSettings;
  session: HdoSessionSnapshot;
  readiness: unknown | null;
  devices: unknown[];
  deviceTasks: unknown[];
  localPlugins: HdoLocalPluginState[];
  wireGuardStatus?: unknown | null;
  wireGuardDaemonStatus?: unknown | null;
  taskRunnerBusy: boolean;
  admin: {
    users?: unknown[];
    meshGroups?: unknown[];
    memberships?: unknown[];
    nodes: unknown[];
    devices?: unknown[];
    services: unknown[];
    profiles: unknown[];
    rateLimits: unknown[];
    pluginStates?: unknown[];
    tasks?: unknown[];
  } | null;
  lastError: string | null;
}

export interface HdoDeviceRegistrationInput {
  id?: string | null;
  label?: string | null;
  platform?: string | null;
  publicKey?: string | null;
  overlayIp?: string | null;
  status?: 'pending' | 'online' | 'offline' | 'error';
  metadata?: Record<string, unknown> | null;
}

export interface HdoNodeInput {
  id?: string | null;
  name: string;
  kind: 'domestic' | 'home' | 'oversea';
  publicHost?: string | null;
  overlayIp?: string | null;
  status?: 'pending' | 'online' | 'offline' | 'error';
  metadata?: Record<string, unknown> | null;
}

export interface HdoServiceInput {
  id?: string | null;
  name: string;
  nodeId?: string | null;
  targetHost: string;
  targetPort: number;
  protocol?: HdoServiceProtocol;
  domains?: string[];
  enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface HdoPublishedServiceInput {
  name?: string | null;
  targetPort: number;
  protocol?: HdoServiceProtocol;
  domains?: string[];
  enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface HdoRateLimitInput {
  id?: string | null;
  subjectType: 'user' | 'device' | 'profile' | 'node';
  subjectId: string;
  downRate?: string | null;
  downCeil?: string | null;
  upRate?: string | null;
  upCeil?: string | null;
  metadata?: Record<string, unknown> | null;
}
