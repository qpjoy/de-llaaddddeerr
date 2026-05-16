/**
 * Session glue between the renderer / admin SPA and the upstream
 * electron-server. Persists tokens into marketplace-db so they survive
 * app restarts.
 */
import type { MarketplaceDB } from '@qpjoy/marketplace-db';

import { RemoteClient, type AuthTokens, type PublicUser } from './RemoteClient';

export interface AuthServiceOptions {
  db: MarketplaceDB;
  client: RemoteClient;
}

export interface AuthState {
  user: PublicUser | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

export class AuthService {
  constructor(private readonly opts: AuthServiceOptions) {}

  getAccessToken(): string | null {
    return this.opts.db.getActiveSession()?.accessToken ?? null;
  }

  getRefreshToken(): string | null {
    return this.opts.db.getActiveSession()?.refreshToken ?? null;
  }

  state(): AuthState {
    const s = this.opts.db.getActiveSession();
    return {
      user: (s?.user as PublicUser | null) ?? null,
      accessExpiresAt: s?.expiresAt ?? null,
      refreshExpiresAt: ((s?.user as Record<string, unknown> | null)?.refreshExpiresAt as string | undefined) ?? null
    };
  }

  /**
   * Replaces the persisted session. The marketplace-db keeps one session
   * row (we wipe + insert on every change); the `user_json` column carries
   * both the user payload and the refresh expiry for convenience.
   */
  async setSession(input: { tokens: AuthTokens; user: PublicUser }): Promise<void> {
    this.opts.db.setSession({
      accessToken: input.tokens.accessToken,
      refreshToken: input.tokens.refreshToken,
      expiresAt: input.tokens.accessExpiresAt,
      user: { ...input.user, refreshExpiresAt: input.tokens.refreshExpiresAt }
    });
  }

  async clearSession(): Promise<void> {
    const refresh = this.getRefreshToken();
    if (refresh) await this.opts.client.logout(refresh).catch(() => undefined);
    this.opts.db.clearSession();
  }

  async login(identifier: string, password: string): Promise<AuthState> {
    const out = await this.opts.client.login(identifier, password);
    await this.setSession(out);
    return this.state();
  }

  async register(input: {
    username?: string;
    email?: string;
    phone?: string;
    password: string;
    displayName?: string;
    verificationCode?: string;
  }): Promise<AuthState> {
    const out = await this.opts.client.register(input);
    await this.setSession(out);
    return this.state();
  }

  async refreshIfNeeded(): Promise<AuthState> {
    const session = this.opts.db.getActiveSession();
    if (!session?.refreshToken) return { user: null, accessExpiresAt: null, refreshExpiresAt: null };
    // Pre-emptive refresh if less than 60s remain on the access token.
    const expiresMs = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
    if (expiresMs - Date.now() > 60_000) return this.state();

    try {
      const next = await this.opts.client.refreshTokens(session.refreshToken);
      const user = (session.user as PublicUser | null) ?? null;
      if (user) await this.setSession({ tokens: next, user });
      return this.state();
    } catch {
      this.opts.db.clearSession();
      return { user: null, accessExpiresAt: null, refreshExpiresAt: null };
    }
  }

  async me(): Promise<PublicUser | null> {
    const u = await this.opts.client.me();
    if (!u) {
      // Token expired and refresh failed → already cleared by RemoteClient.
      return null;
    }
    // Refresh the cached profile in our session row.
    const session = this.opts.db.getActiveSession();
    if (session?.accessToken && session.refreshToken) {
      this.opts.db.setSession({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt,
        user: { ...u, refreshExpiresAt: (session.user as Record<string, unknown>)?.refreshExpiresAt ?? null }
      });
    }
    return u;
  }

  async requestCode(input: {
    channel: 'email' | 'sms';
    destination: string;
    purpose: 'register' | 'login' | 'reset';
  }): Promise<{ delivered: string; hint?: string }> {
    return this.opts.client.requestVerificationCode(input);
  }
}
