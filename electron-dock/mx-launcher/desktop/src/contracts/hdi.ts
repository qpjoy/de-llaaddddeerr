export type HdiLauncherMode = 'visitor' | 'employee';
export type HdiLauncherConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';

/**
 * Compatible with the legacy POST /api/v1/hdo/anonymous/bootstrap endpoint.
 */
export interface HdiAnonymousBootstrapRequest {
  publicKey: string;
  installId: string;
  appId?: string | null;
  deviceLabel?: string | null;
  label?: string | null;
  platform?: string | null;
  relayMode?: string | null;
}

export interface HdiEmployeeLoginRequest {
  identifier: string;
  password: string;
  deviceLabel?: string | null;
  platform?: string | null;
}

export interface HdiLauncherSession {
  mode: HdiLauncherMode;
  connectionState: HdiLauncherConnectionState;
  userId: string | null;
  deviceId: string | null;
  meshGroupId: string | null;
  overlayIp: string | null;
  localIp: string | null;
  profileId: string | null;
}

export interface HdiLauncherBackendConfig {
  productId: 'hdi';
  legacyProductId: 'hdo';
  apiBaseUrl: string;
  bootstrapEndpoint: '/api/v1/hdo/anonymous/bootstrap';
  readinessEndpoint: '/api/v1/hdo/readiness';
  deviceTasksEndpoint: '/api/v1/hdo/device-tasks';
  launcherAdminEndpoint: '/api/v1/mx-launcher/admin/products/hdi';
}
