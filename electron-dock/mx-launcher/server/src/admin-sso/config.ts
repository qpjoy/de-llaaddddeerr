export interface AdminSsoConfig {
  issuer: string;
  origin: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  localSubjects?: boolean;
}

// No development HTTP escape hatch in production configuration. Tests inject a
// loopback provider directly into the protocol client instead.
export function loadAdminSsoConfig(env = process.env): AdminSsoConfig | null {
  if (env.MX_ADMIN_SSO_ENABLED !== '1') return null;
  const httpsUrl = (key: string, originOnly = false) => {
    const raw = env[key]?.trim() || '';
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (originOnly && url.pathname !== '/')) throw new Error(`Invalid ${key}`);
    return originOnly ? url.origin : raw;
  };
  const issuer = httpsUrl('MX_ADMIN_SSO_ISSUER');
  const origin = httpsUrl('MX_ADMIN_SSO_ORIGIN', true);
  const clientId = env.MX_ADMIN_SSO_CLIENT_ID?.trim();
  const clientSecret = env.MX_ADMIN_SSO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error('SSO client credentials are required');
  const localSubjects = env.MX_ADMIN_SSO_LOCAL_SUBJECTS === '1';
  if (localSubjects && issuer !== `${origin}/identity`) throw new Error('Managed identity issuer must share the configured origin');
  return { issuer, origin, clientId, clientSecret, callbackUrl: `${origin}/auth/admin/callback`, localSubjects };
}
