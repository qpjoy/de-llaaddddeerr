import type { RuntimeFeaturePolicy } from '../../types.js';

export const AWX_CREDENTIAL_SYNC_FEATURE_KEY = 'site-slot.awx.credential-sync';
export const AWX_OBJECT_SYNC_FEATURE_KEY = 'site-slot.awx.object-sync';
export const AWX_LAUNCH_FEATURE_KEY = 'site-slot.awx.launch';

export function awxRuntimeGateReasons(
  envKey: string,
  featureKey: string,
  policy: RuntimeFeaturePolicy | null | undefined
): string[] {
  if (envEnabled(envKey) || runtimePolicyAllowsRemoteExecution(policy)) return [];
  return [`${envKey}=true or runtime feature policy ${featureKey}=remote-execute is required`];
}

export function runtimePolicyAllowsRemoteExecution(policy: RuntimeFeaturePolicy | null | undefined): boolean {
  if (!policy || !policy.enabled || policy.mode !== 'remote-execute') return false;
  return !policy.expiresAt || Date.parse(policy.expiresAt) > Date.now();
}

function envEnabled(key: string): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
