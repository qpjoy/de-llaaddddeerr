/**
 * Thin HTTP client for `electron-server`. All endpoints documented in
 * `electron-server/docs/API.md`.
 *
 * Phase 5: bearer-token auth + automatic refresh on 401.
 */

export interface VersionManifest {
  release: string;
  minClientRelease: string | null;
  marketSpecVersion: number;
  supportedSpecRange: string;
  migrationsHead: number;
  manifestEtag: string;
  publishedAt: string;
}

export interface RemoteMarketplaceEntry {
  id: string;
  npm: string;
  name: string;
  description: string | null;
  latestVersion: string;
  manifestUrl: string | null;
  tarballUrl: string | null;
  homepage: string | null;
  author: string | null;
  category: string | null;
  verified: boolean;
  bootstrap: boolean;
  visibility: 'public' | 'free' | 'paid' | 'private';
  specVersion: number;
  metadata: Record<string, unknown> | null;
}

export interface RemoteMarketplaceIndex {
  generatedAt: string;
  release: string;
  entries: RemoteMarketplaceEntry[];
}

export interface RemoteMigration {
  version: number;
  name: string;
  checksum: string;
  up: string;
  down: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface ClientPluginState {
  id: string;
  npm: string | null;
  name: string | null;
  version: string | null;
  state: string;
  manifest: Record<string, unknown> | null;
  health?: Record<string, unknown> | null;
}

export interface UpdateCheckRequest {
  installId: string;
  deviceId?: string | null;
  platform: string;
  arch: string;
  capabilities: string[];
  app: {
    name: string;
    version: string;
    isPackaged: boolean;
  };
  market: {
    version: string | null;
  };
  plugins: ClientPluginState[];
}

export type UpdateActionMode = 'manual' | 'notify' | 'auto' | 'force' | 'silent';
export type UpdateRestartPolicy = 'none' | 'plugin' | 'app' | 'system';
export type UpdateTargetKind = 'market' | 'plugin' | 'game';
export type UpdateReportStatus =
  | 'seen'
  | 'applied'
  | 'failed'
  | 'skipped'
  | 'restart_required'
  | 'awaiting_grant';

export interface UpdateAction {
  actionId: string;
  planId: string;
  targetKind: UpdateTargetKind;
  targetId: string;
  pluginId: string | null;
  npm: string | null;
  fromVersion: string | null;
  toVersion: string;
  mode: UpdateActionMode;
  restartPolicy: UpdateRestartPolicy;
  channel: string;
  tarballUrl: string | null;
  manifestChecksum: string | null;
  tarballChecksum: string | null;
  autoGrant: boolean | 'manifest' | string[] | null;
  autoActivate: boolean;
  force: boolean;
  reason: string;
}

export interface UpdateCheckResponse {
  serverTime: string;
  subject: string;
  actions: UpdateAction[];
}

export interface UpdateReportRequest {
  planId: string;
  actionId?: string | null;
  targetId: string;
  targetKind: UpdateTargetKind;
  installId?: string | null;
  deviceId?: string | null;
  fromVersion?: string | null;
  toVersion: string;
  status: UpdateReportStatus;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PublicUser {
  id: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  role: 'user' | 'admin' | 'banned';
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
}

export interface RemoteClientOptions {
  /** Base URL, e.g. `http://127.0.0.1:8080`. We append `/api/v1/...`. */
  baseUrl: string;
  /** Read the current access token. Called on every request. */
  getAccessToken?: () => string | null;
  /** Read the current refresh token. Used to recover from 401. */
  getRefreshToken?: () => string | null;
  /** Persist new tokens after a successful refresh. */
  onTokensRefreshed?: (tokens: AuthTokens) => void | Promise<void>;
  /** Called when refresh fails (token expired / revoked) so callers can prompt re-login. */
  onAuthExpired?: () => void;
  /** Override `fetch` for tests. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 8000). */
  timeoutMs?: number;
}

export class RemoteApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RemoteApiError';
  }
}

export class RemoteClient {
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(private readonly opts: RemoteClientOptions) {}

  /* ─── public reads ──────────────────────────────────────────────────── */

  async getVersion(): Promise<VersionManifest> {
    return this.json<VersionManifest>('/api/v1/version.json');
  }

  async getMarketplaceIndex(etag?: string | null): Promise<{
    index: RemoteMarketplaceIndex | null;
    etag: string | null;
  }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (etag) headers['if-none-match'] = etag;
    const res = await this.request('/api/v1/marketplace/index.json', { headers });
    if (res.status === 304) return { index: null, etag: etag ?? null };
    const newEtag = res.headers.get('etag');
    const body = (await res.json()) as RemoteMarketplaceIndex;
    return { index: body, etag: newEtag };
  }

  async getMigration(version: number): Promise<RemoteMigration> {
    return this.json<RemoteMigration>(`/api/v1/migrations/${version}`);
  }

  async getPluginDetail(id: string): Promise<unknown> {
    return this.json(`/api/v1/plugins/${encodeURIComponent(id)}`);
  }

  /**
   * Ask the server for a tarball download URL for a plugin. The server
   * checks visibility + entitlements and either returns a (possibly
   * presigned) URL, or 401/402/403. Host then downloads the URL and
   * installs via `PluginStore.installFrom({ type: 'tarball', path })`.
   *
   * Public plugins return the npm-registry URL anyone can fetch; paid
   * plugins will return a short-lived presigned URL once OSS is wired up.
   * Either way, the response shape is stable.
   */
  async requestPluginDownload(input: {
    pluginId: string;
    version?: string;
  }): Promise<{
    pluginId: string;
    version: string;
    tarballUrl: string;
    expiresAt: string;
    presigned: boolean;
    manifestChecksum: string | null;
    tarballChecksum: string | null;
  }> {
    return this.json(
      `/api/v1/plugins/${encodeURIComponent(input.pluginId)}/download`,
      { method: 'POST', body: JSON.stringify({ version: input.version }) }
    );
  }

  async checkUpdates(input: UpdateCheckRequest): Promise<UpdateCheckResponse> {
    return this.json('/api/v1/updates/check', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  async reportUpdate(input: UpdateReportRequest): Promise<void> {
    await this.request('/api/v1/updates/report', {
      method: 'POST',
      body: JSON.stringify(input)
    }).catch(() => undefined);
  }

  /* ─── auth ──────────────────────────────────────────────────────────── */

  async register(input: {
    username?: string;
    email?: string;
    phone?: string;
    password: string;
    displayName?: string;
    verificationCode?: string;
  }): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    return this.json('/api/v1/auth/register', { method: 'POST', body: JSON.stringify(input) });
  }

  async login(identifier: string, password: string): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    return this.json('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password })
    });
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    return this.json('/api/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken })
    });
  }

  async logout(refreshToken: string | null): Promise<void> {
    await this.request('/api/v1/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken })
    }).catch(() => undefined);
  }

  async me(): Promise<PublicUser | null> {
    try {
      return await this.json<PublicUser>('/api/v1/auth/me');
    } catch (err) {
      if (err instanceof RemoteApiError && err.status === 401) return null;
      throw err;
    }
  }

  async requestVerificationCode(input: {
    channel: 'email' | 'sms';
    destination: string;
    purpose: 'register' | 'login' | 'reset';
  }): Promise<{ delivered: string; hint?: string }> {
    return this.json('/api/v1/auth/code', { method: 'POST', body: JSON.stringify(input) });
  }

  /* ─── helpers ───────────────────────────────────────────────────────── */

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    return (await res.json()) as T;
  }

  private async request(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const url = this.opts.baseUrl.replace(/\/$/, '') + path;
    const fetchFn = this.opts.fetch ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const access = this.opts.getAccessToken?.();
    if (access) headers.set('authorization', `Bearer ${access}`);

    try {
      const res = await fetchFn(url, { ...init, headers, signal: controller.signal });

      // Auto-refresh on 401, but only once per call, and only for endpoints
      // that aren't themselves auth ones (avoid recursion).
      if (
        res.status === 401 &&
        !retried &&
        !path.startsWith('/api/v1/auth/refresh') &&
        !path.startsWith('/api/v1/auth/login') &&
        this.opts.getRefreshToken
      ) {
        const refreshed = await this.tryRefresh();
        if (refreshed) {
          clearTimeout(timeout);
          return this.request(path, init, true);
        }
        // Surface the auth-expired signal so the UI can prompt re-login.
        this.opts.onAuthExpired?.();
      }

      if (!res.ok && res.status !== 304) {
        const body = await res.text().catch(() => '');
        throw new RemoteApiError(res.status, `${res.status} ${res.statusText} — ${body}`);
      }
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshToken = this.opts.getRefreshToken?.();
    if (!refreshToken) return false;
    this.refreshInFlight = (async () => {
      try {
        const next = await this.refreshTokens(refreshToken);
        await this.opts.onTokensRefreshed?.(next);
        return true;
      } catch {
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }
}
