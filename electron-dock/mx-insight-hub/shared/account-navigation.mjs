// Only supported SPA mounts are accepted; this is never an arbitrary return URL.
export const hubUiPath = pathname => pathname === '/admin/' || pathname === '/admin' ? '/admin/' : '/'

export function hubLoginUrl(pathname, options = {}) {
  const query = new URLSearchParams({ ...options, surface: 'application', ui: hubUiPath(pathname) })
  return `/auth/sso/login?${query}`
}
