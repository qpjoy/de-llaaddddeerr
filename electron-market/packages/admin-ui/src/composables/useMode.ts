/**
 * The same SPA bundle runs in two contexts:
 *
 *  - **local**: served by the desktop host on `http://127.0.0.1:23455/`.
 *    The host relays `/api/auth/*` to the upstream server and stores tokens
 *    in `marketplace-db.auth_session`.
 *  - **server**: served by electron-server itself under `/admin/`. There
 *    is no host to relay through; the SPA talks to `/api/v1/*` directly
 *    and persists the token in `localStorage`.
 *
 * `useMode()` answers two questions every API call needs:
 *   - which base path to prepend
 *   - which header / persistence layer carries the token
 */

export type Mode = 'local' | 'server';

let resolvedMode: Mode | null = null;

export function detectMode(): Mode {
  if (resolvedMode) return resolvedMode;
  // Hash-router URLs look like `http://host/admin/#/marketplace`. The hash
  // never makes it to the server, so the path prefix is the only signal.
  resolvedMode = window.location.pathname.startsWith('/admin/') ? 'server' : 'local';
  return resolvedMode;
}

export function useMode() {
  const mode = detectMode();
  const apiBase = mode === 'server' ? '/api/v1' : '/api';
  return { mode, apiBase };
}

/**
 * Token persistence. In local mode the host already handles tokens —
 * `getToken` returns null and `setToken` is a no-op (the host's relay
 * adds `Authorization` for us based on `marketplace-db.auth_session`).
 *
 * In server mode the bundle itself owns the token, stored in localStorage
 * under `qpjoy.server.token`.
 */
const TOKEN_KEY = 'qpjoy.server.token';
const REFRESH_KEY = 'qpjoy.server.refresh';

export function getServerToken(): string | null {
  if (detectMode() !== 'server') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setServerToken(token: string | null): void {
  if (detectMode() !== 'server') return;
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

export function getServerRefreshToken(): string | null {
  if (detectMode() !== 'server') return null;
  return localStorage.getItem(REFRESH_KEY);
}

export function setServerRefreshToken(token: string | null): void {
  if (detectMode() !== 'server') return;
  if (token === null) localStorage.removeItem(REFRESH_KEY);
  else localStorage.setItem(REFRESH_KEY, token);
}
