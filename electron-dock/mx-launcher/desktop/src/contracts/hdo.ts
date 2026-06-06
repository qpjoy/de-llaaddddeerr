export type HdoLauncherMode = 'visitor' | 'employee';
export type HdoLauncherConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';

/**
 * Compatible with POST /api/v1/hdo/anonymous/bootstrap.
 */
export interface HdoAnonymousBootstrapRequest {
  publicKey: string;
  installId: string;
  appId?: string | null;
  deviceLabel?: string | null;
  label?: string | null;
  platform?: string | null;
  relayMode?: string | null;
}

export interface HdoEmployeeLoginRequest {
  identifier: string;
  password: string;
  deviceLabel?: string | null;
  platform?: string | null;
}

export interface HdoLauncherSession {
  mode: HdoLauncherMode;
  connectionState: HdoLauncherConnectionState;
  userId: string | null;
  deviceId: string | null;
  meshGroupId: string | null;
  overlayIp: string | null;
  localIp: string | null;
  profileId: string | null;
}

export interface HdoLauncherBackendConfig {
  productId: 'hdo';
  legacyProductId: 'hdo';
  apiBaseUrl: string;
  bootstrapEndpoint: '/api/v1/hdo/anonymous/bootstrap';
  readinessEndpoint: '/api/v1/hdo/readiness';
  deviceTasksEndpoint: '/api/v1/hdo/device-tasks';
  launcherAdminEndpoint: '/api/v1/mx-launcher/admin/products/hdo';
}
