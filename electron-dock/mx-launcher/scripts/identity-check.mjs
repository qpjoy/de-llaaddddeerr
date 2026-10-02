// This self-contained function also runs inside the API Pod via node -e.
// Never return response bodies, environment values, tokens or error messages.
export async function identityProbe(origin, fingerprint, { env = process.env, fetcher = fetch } = {}) {
  const failure = (stage, code, status) => ({ version: 1, ok: false, stage, code, ...(status ? { status } : {}) });
  if (env.MX_ADMIN_SSO_ENABLED !== '1') return failure('configuration', 'CONFIG_DISABLED');
  if (env.MX_ADMIN_SSO_ORIGIN !== origin || env.MX_ADMIN_SSO_ISSUER !== `${origin}/identity` ||
      !env.MX_ADMIN_SSO_CLIENT_ID || !env.MX_ADMIN_SSO_CLIENT_SECRET) return failure('configuration', 'CONFIG_MISMATCH');
  try {
    const { readFileSync } = await import('node:fs');
    const { X509Certificate } = await import('node:crypto');
    const ca = new X509Certificate(readFileSync(env.NODE_EXTRA_CA_CERTS));
    if (ca.fingerprint256 !== fingerprint) return failure('configuration', 'CA_MISMATCH');
  } catch { return failure('configuration', 'CA_UNREADABLE'); }
  for (const [stage, url] of [
    ['local-session', 'http://127.0.0.1:18090/auth/admin/session'],
    ['discovery', `${origin}/identity/.well-known/openid-configuration`],
    ['https-session', `${origin}/auth/admin/session`]
  ]) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) return failure(stage, 'HTTP_ERROR', response.status);
      let json;
      try { json = await response.json(); } catch { return failure(stage, 'INVALID_JSON'); }
      if (stage === 'discovery') {
        if (json.issuer !== `${origin}/identity`) return failure(stage, 'ISSUER_MISMATCH');
      } else if (json.enabled !== true) return failure(stage, json.unavailable ? 'CONFIG_UNAVAILABLE' : 'SESSION_DISABLED');
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      const allowed = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
        'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID'];
      return failure(stage, error?.name === 'TimeoutError' ? 'TIMEOUT' : allowed.includes(code) ? code : 'FETCH_ERROR');
    }
  }
  return { version: 1, ok: true, stage: 'complete', code: 'OK' };
}
