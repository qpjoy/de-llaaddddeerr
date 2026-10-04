import { existsSync, readFileSync, statSync } from 'node:fs'
// Also used by dependency-free host preflight before npm/image installation.
import { readApplicationSsoProfile } from '../../../mx-common/src/identity/profile.mjs'

export function validateConsoleAccess(entries) {
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error('Invalid payment console access list')
  const seen = new Set()
  return entries.map(entry => {
    const issuer = new URL(entry.issuer)
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash
      || typeof entry.subject !== 'string' || !entry.subject || entry.subject.length > 200
      || typeof entry.clientId !== 'string' || !entry.clientId
      || !/^[A-Za-z0-9._-]{1,80}$/.test(entry.appId ?? '')
      || !['test','live'].includes(entry.environment) || entry.role !== 'viewer'
      || Object.keys(entry).some(key => !['issuer','subject','clientId','appId','environment','role'].includes(key))) {
      throw new Error('Console access requires an exact identity, application, environment and viewer role')
    }
    const key = JSON.stringify([entry.issuer, entry.subject, entry.clientId, entry.appId, entry.environment])
    if (seen.has(key)) throw new Error('Duplicate payment console access')
    seen.add(key)
    return { ...entry }
  })
}

export function readConsoleConfig(profileFile, accessFile) {
  if (!existsSync(profileFile || '') && !existsSync(accessFile || '')) return null
  const settings = readApplicationSsoProfile(profileFile)
  if (!settings || settings.appId !== 'mx-pay' || settings.scope !== 'openid mx:identity') throw new Error('Payment console requires its own mx-pay SSO profile')
  if (statSync(accessFile).mode & 0o027) throw new Error('Payment console access file must be private')
  const access = validateConsoleAccess(JSON.parse(readFileSync(accessFile, 'utf8')))
  const providers = [settings, ...(settings.previousProviders || [])]
  if (access.some(entry => !providers.some(p => p.issuer === entry.issuer && p.clientId === entry.clientId))) {
    throw new Error('Payment console access identity does not match its registered provider')
  }
  return { settings, access }
}

export function consolePrincipal(identity, access) {
  return { issuer: identity.issuer, subject: identity.subject, clientId: identity.clientId, displayName: identity.displayName,
    grants: access.filter(entry => entry.issuer === identity.issuer && entry.subject === identity.subject && entry.clientId === identity.clientId)
      .map(({ appId, environment, role }) => ({ appId, environment, role })) }
}
