import { internalOpsTokenMatches } from './internal-ops-auth.js';

export const REDACTED_SITE_SLOT_CREDENTIAL = '[redacted Internal site-slot credential material]';
export const REDACTED_SITE_SLOT_COMMAND = '[redacted Internal site-slot command]';

/**
 * Site-slot plans and their derived execution objects intentionally contain
 * runnable commands.  Oversea commands also carry the Internal-pushed tunnel
 * state, including system subscription credentials.  Keep the full worker
 * contract for authenticated Internal operators while presenting a stable,
 * recursively redacted shape to every other caller.
 */
export function siteSlotOpsAwareView<T>(value: T, opsToken: string | undefined): T {
  if (internalOpsTokenMatches(opsToken)) return value;
  return redactSiteSlotCredentialMaterial(value);
}

export function redactSiteSlotCredentialMaterial<T>(value: T): T {
  return redactSiteSlotValue(value) as T;
}

function redactSiteSlotValue(value: unknown, key?: string): unknown {
  if (key && isSiteSlotCommandKey(key)) {
    if (Array.isArray(value)) return value.map(() => REDACTED_SITE_SLOT_COMMAND);
    if (value !== null && value !== undefined) return REDACTED_SITE_SLOT_COMMAND;
  }
  if (key && isSiteSlotCredentialKey(key) && value !== null && value !== undefined) {
    return REDACTED_SITE_SLOT_CREDENTIAL;
  }
  if (typeof value === 'string') {
    return siteSlotStringContainsCredentialMaterial(value)
      ? REDACTED_SITE_SLOT_CREDENTIAL
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSiteSlotValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [
      childKey,
      redactSiteSlotValue(item, childKey)
    ]));
  }
  return value;
}

function isSiteSlotCommandKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'command' || normalized === 'commands';
}

function isSiteSlotCredentialKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalized === 'authtoken') return true;
  return normalized.includes('systemsubscription')
    && (normalized.includes('credential') || normalized.includes('authtoken'))
    && (normalized.includes('digest') || normalized.includes('sha256'));
}

function siteSlotStringContainsCredentialMaterial(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes('/opt/mx/site-agent/tunnel-state.json')
    || normalized.includes('/opt/mx/site-agent/.tunnel-state.json.tmp')
    || normalized.includes('system-subscription-credential-sha256=')
    || normalized.includes('hy2_system_subscription_auth_token_sha256');
}
