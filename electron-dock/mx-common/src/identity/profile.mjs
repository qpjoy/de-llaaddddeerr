import { readFileSync, statSync } from 'node:fs'

function httpsUrl(value, origin = false) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (origin && url.origin !== value)) throw new Error('Invalid SSO HTTPS address')
  return url
}

export function validateApplicationSsoSettings(p) {
  httpsUrl(p.origin, true); httpsUrl(p.issuer)
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(p.appId ?? '')
    || ![p.clientId,p.clientSecret,p.audience].every(value => typeof value === 'string' && value.length > 0))
    throw new Error('Incomplete application SSO profile')
  if (p.scope !== undefined && !['openid mx:identity', 'openid mx:hub'].includes(p.scope)) throw new Error('Invalid MX identity scope')
  for (const [key, suffix] of [['callbackUrl','callback'], ['interactionUrl','interaction']]) {
    if (p[key] !== undefined && p[key] !== `${p.origin}/auth/sso/${suffix}`) throw new Error('SSO endpoint does not match application origin')
  }
  if (p.previousProviders !== undefined) {
    if (!Array.isArray(p.previousProviders) || p.previousProviders.length > 1) throw new Error('Invalid previous SSO providers')
    for (const prior of p.previousProviders) {
      const url = httpsUrl(prior.issuer)
      if (url.pathname !== '/identity' || prior.issuer === p.issuer || !prior.clientId || !prior.clientSecret) throw new Error('Invalid previous SSO provider')
    }
  }
  return p
}

export function readApplicationSsoProfile(file) {
  if (!file) return null
  // Kubernetes fsGroup may add group-read to a read-only Secret mount.
  if (statSync(file).mode & 0o027) throw new Error('SSO profile must be private (0600 or read-only group)')
  const p = validateApplicationSsoSettings(JSON.parse(readFileSync(file, 'utf8')))
  if (!/^[A-Za-z0-9_-]{43}$/.test(p.sessionKey ?? '') || Buffer.from(p.sessionKey, 'base64url').length !== 32)
    throw new Error('SSO profile requires a persistent 32-byte session key')
  return p
}
