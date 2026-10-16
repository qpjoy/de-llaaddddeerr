// Which requests a desktop report window may make, and which carry the
// member's credential. Kept free of Electron so it can be tested on its own;
// the window itself is report-window.mjs.

export const REPORT_PATH = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,80})\/report$/
// The stylesheets the report links to, and the tokens the design system's
// stylesheet imports: public files, sent without a credential.
const STYLES = new Set(['/vendor/neon-void.css', '/vendor/tokens.css', '/assets/report.css'])

/**
 * What one report window may load. `credential` says whether the request is
 * one the member's token is added to.
 */
export function reportRequest(raw, { origin, runId, method = 'GET' }) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return { allowed: false, credential: false }
  }
  if (url.origin !== origin || method !== 'GET' || url.username || url.password)
    return { allowed: false, credential: false }
  const path = url.pathname
  if (path.split('/').some((part) => part === '..' || part === '.')) return { allowed: false, credential: false }
  if (STYLES.has(path) && !url.search) return { allowed: true, credential: false }
  const own = `/api/v1/runs/${runId}`
  if (path === `${own}/report`) return { allowed: true, credential: true }
  if (path.startsWith(`${own}/artifacts/`) && path.length > own.length + 11) return { allowed: true, credential: true }
  return { allowed: false, credential: false }
}
