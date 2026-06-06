export type LauncherComponent = 'electron-ui' | 'launcher' | 'windows-service' | 'product-resources';
export type LauncherStartupAction = 'launch-ui' | 'install-service' | 'upgrade-service' | 'repair-service';

export interface InstalledComponentState {
  component: LauncherComponent;
  installedVersion: string | null;
  desiredVersion: string;
  hashVerified: boolean;
  signatureVerified: boolean;
  healthy: boolean;
}

export interface LauncherStartupDecision {
  action: LauncherStartupAction;
  requiresElevation: boolean;
  reason: string;
}

export function decideStartupAction(components: InstalledComponentState[]): LauncherStartupDecision {
  const service = components.find((row) => row.component === 'windows-service');
  if (!service || !service.installedVersion) {
    return {
      action: 'install-service',
      requiresElevation: true,
      reason: 'Windows service is not installed'
    };
  }
  if (service.installedVersion !== service.desiredVersion) {
    return {
      action: 'upgrade-service',
      requiresElevation: true,
      reason: 'Windows service version differs from package manifest'
    };
  }
  if (!service.hashVerified || !service.signatureVerified || !service.healthy) {
    return {
      action: 'repair-service',
      requiresElevation: true,
      reason: 'Windows service verification or health check failed'
    };
  }
  return {
    action: 'launch-ui',
    requiresElevation: false,
    reason: 'Installed components are ready'
  };
}
