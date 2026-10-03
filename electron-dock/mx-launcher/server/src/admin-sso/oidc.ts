import * as oidc from 'openid-client';
import { USER_SESSION_TTL_SECONDS } from '../lib/session-lifetime.js';
import type { AdminSsoConfig } from './config.js';

export interface LoginTransaction extends Record<string, unknown> {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: string;
  reauthenticate?: boolean;
}
export interface OidcIdentity { issuer: string; subject: string; authTime: number }
export interface AdminOidcClient {
  authorize(transaction: LoginTransaction): Promise<URL>;
  redeem(url: URL, transaction: LoginTransaction): Promise<OidcIdentity>;
}

export function createAdminOidcClient(settings: AdminSsoConfig, injected?: oidc.Configuration): AdminOidcClient {
  let discovery: Promise<oidc.Configuration> | undefined;
  const configuration = async () => {
    if (!discovery) discovery = (async () => {
      const config = injected ?? await oidc.discovery(new URL(settings.issuer), settings.clientId,
        { client_secret: settings.clientSecret, id_token_signed_response_alg: 'RS256' },
        oidc.ClientSecretBasic(settings.clientSecret), { timeout: 10 });
      oidc.enableNonRepudiationChecks(config);
      return config;
    })().catch((error) => { discovery = undefined; throw error; });
    return discovery;
  };
  return {
    async authorize(transaction) {
      return oidc.buildAuthorizationUrl(await configuration(), {
        redirect_uri: settings.callbackUrl, scope: 'openid', response_type: 'code', response_mode: 'query',
        code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier), code_challenge_method: 'S256',
        state: transaction.state, nonce: transaction.nonce,
        max_age: String(transaction.reauthenticate ? 300 : USER_SESSION_TTL_SECONDS),
        ...(transaction.reauthenticate ? { prompt: 'login' } : {})
      });
    },
    async redeem(url, transaction) {
      const tokens = await oidc.authorizationCodeGrant(await configuration(), url, {
        pkceCodeVerifier: transaction.verifier, expectedState: transaction.state,
        expectedNonce: transaction.nonce, maxAge: transaction.reauthenticate ? 300 : USER_SESSION_TTL_SECONDS, idTokenExpected: true
      });
      const claims = tokens.claims();
      if (!claims || claims.iss !== settings.issuer || typeof claims.sub !== 'string' || !claims.sub
        || claims.sub.length > 255 || typeof claims.auth_time !== 'number'
        || claims.auth_time > Date.now() / 1000 + 30) throw new Error('Invalid identity claims');
      // Access, refresh and ID tokens are deliberately not persisted or exposed
      // to this management UI. They cannot become legacy SDK credentials.
      return { issuer: claims.iss, subject: claims.sub, authTime: claims.auth_time };
    }
  };
}
