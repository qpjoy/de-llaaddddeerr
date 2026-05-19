export interface HdoPluginSettings {
  hdoControlBaseUrl?: string | null;
  deviceId?: string | null;
  deviceLabel?: string | null;
  devicePlatform?: string | null;
  lastManifest?: Record<string, unknown> | null;
  lastSubscription?: string | null;
  updatedAt?: string | null;
}

export interface HdoSessionSnapshot {
  loggedIn: boolean;
  user: Record<string, unknown> | null;
  hasAccessToken: boolean;
}

export interface HdoSnapshot {
  serverBaseUrl: string | null;
  marketServerBaseUrl: string | null;
  settings: HdoPluginSettings;
  session: HdoSessionSnapshot;
  readiness: unknown | null;
  devices: unknown[];
  admin: {
    nodes: unknown[];
    services: unknown[];
    profiles: unknown[];
    rateLimits: unknown[];
  } | null;
  lastError: string | null;
}

export interface HdoDeviceRegistrationInput {
  id?: string | null;
  label?: string | null;
  platform?: string | null;
  publicKey?: string | null;
  overlayIp?: string | null;
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
  protocol?: 'tcp' | 'udp' | 'http' | 'https';
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
