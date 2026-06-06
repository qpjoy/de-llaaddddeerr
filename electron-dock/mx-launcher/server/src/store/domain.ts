import { createHash } from 'node:crypto';

import type {
  AnonymousEnrollment,
  AppCenterApp,
  ConfigSnapshot,
  ReleasePolicyDecision,
  RuntimeConfig,
  TestStep,
  UpdatePolicyKind
} from '../types.js';

export function builtinAppCenterApps(): AppCenterApp[] {
  return [
    {
      appId: 'h2o',
      displayName: 'H2O',
      builtin: true,
      version: '0.1.0',
      category: 'network',
      description: 'Clash-like AppCenter network app powered by Launcher Network.',
      channels: ['shadow', 'beta', 'stable'],
      permissions: [
        'auth.read',
        'network.hdi.status',
        'network.proxy.app',
        'network.proxy.global',
        'network.tun.request',
        'network.dns.policy',
        'network.pac.policy',
        'observability.write'
      ],
      requiredCapabilities: ['launcher-network', 'app-center-runtime'],
      updatePolicy: 'app-managed',
      entrypoints: {
        desktop: 'app://h2o/index.html',
        settings: 'app://h2o/settings.html'
      },
      protocol: {
        appCenter: '1.0',
        launcher: '1.0'
      }
    }
  ];
}

export function createConfigSnapshot(
  config: RuntimeConfig,
  enrollment: AnonymousEnrollment,
  snapshotId: string,
  version: number,
  defaultMode: 'visitor' | 'employee'
): ConfigSnapshot {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 6 * 60 * 60 * 1000);
  const unsigned = {
    environment: config.environment,
    siteId: enrollment.siteId,
    productId: enrollment.productId,
    installId: enrollment.installId,
    deviceId: enrollment.deviceId,
    anonymousPrincipalId: enrollment.anonymousPrincipalId,
    userId: enrollment.userId,
    version,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    config: {
      serverBaseUrl: config.publicBaseUrl,
      defaultMode,
      relayMode: enrollment.relayMode,
      overlayIp: enrollment.overlayIp
    }
  };
  const digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  return {
    snapshotId,
    ...unsigned,
    endpoints: {
      publicBaseUrl: config.publicBaseUrl,
      internalBaseUrl: config.internalBaseUrl,
      preferredAfterRelay: 'internal',
      fallbackOrder: ['domestic', 'internal']
    },
    observability: {
      level: 'info',
      sinks: config.observabilitySinks
    },
    release: {
      channel: config.environment === 'shadow' ? 'shadow' : 'stable',
      tasksUrl: '/internal/v1/release/tasks'
    },
    resources: [],
    signatures: {
      algorithm: 'sha256-dev-digest',
      digest,
      issuer: 'mx-launcher-server-shadow'
    }
  };
}

export function normalizeUpdatePolicy(value: string): UpdatePolicyKind {
  if (
    value === 'platform-critical'
    || value === 'platform-ui'
    || value === 'app-managed'
    || value === 'mandatory-app'
    || value === 'config-snapshot'
  ) {
    return value;
  }
  return 'app-managed';
}

export function releasePolicyByKind(
  kind: UpdatePolicyKind
): Omit<ReleasePolicyDecision, 'componentKind' | 'componentId' | 'currentVersion' | 'targetVersion' | 'updateAvailable'> {
  if (kind === 'platform-critical') {
    return {
      updateMode: 'mandatory',
      canSkip: false,
      canDefer: false,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'platform-critical updates are mandatory and gated'
    };
  }
  if (kind === 'platform-ui') {
    return {
      updateMode: 'automatic',
      canSkip: false,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'platform UI updates are automatic with maintenance-window deferral'
    };
  }
  if (kind === 'mandatory-app') {
    return {
      updateMode: 'mandatory',
      canSkip: false,
      canDefer: true,
      requiresGate: true,
      rollbackRequired: true,
      reason: 'app update is marked mandatory'
    };
  }
  if (kind === 'config-snapshot') {
    return {
      updateMode: 'automatic',
      canSkip: false,
      canDefer: false,
      requiresGate: false,
      rollbackRequired: true,
      reason: 'config snapshots are signed and automatically applied'
    };
  }
  return {
    updateMode: 'manual',
    canSkip: true,
    canDefer: true,
    requiresGate: false,
    rollbackRequired: true,
    reason: 'app-managed updates can be skipped by user or policy'
  };
}

export function normalizeTestStatus(value: string): TestStep['status'] {
  if (value === 'failed' || value === 'blocked') return value;
  return 'passed';
}

export function required<T>(value: T | null, message: string): T {
  if (value) return value;
  throw new Error(message);
}
