import { readFileSync, statSync } from 'node:fs'

export function readSsoProfile(file) {
  if (!file) return null
  // Kubernetes fsGroup may add group-read to a read-only Secret mount.
  if (statSync(file).mode & 0o027) throw new Error('Hub SSO profile must be private (0600 or read-only group)')
  const p = JSON.parse(readFileSync(file, 'utf8'))
  for (const name of ['origin', 'issuer']) {
    const u = new URL(p[name])
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (name === 'origin' && u.origin !== p.origin)) throw new Error('Invalid Hub SSO HTTPS origin')
  }
  if (!p.clientId || !p.clientSecret || !p.legacyIssuer?.startsWith('mx-user-center:') || !p.audience || !/^[A-Za-z0-9_-]{43}$/.test(p.sessionKey)) throw new Error('Incomplete Hub SSO profile')
  if (p.previousProviders !== undefined) {
    if (!Array.isArray(p.previousProviders) || p.previousProviders.length > 1) throw new Error('Invalid previous SSO providers')
    for (const prior of p.previousProviders) {
      const u = new URL(prior.issuer)
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/identity'
        || prior.issuer === p.issuer || !prior.clientId || !prior.clientSecret) throw new Error('Invalid previous SSO provider')
    }
  }
  return p
}

