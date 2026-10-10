import { fileURLToPath, pathToFileURL } from 'node:url'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { normalizeAdminBase, readNightAllExternalPlatformCredentials } from './migrate-tikhub-credential.mjs'

export async function discoverNightAllConfig(environment = {}, {
  homeDirectory = homedir(), hubDirectory = fileURLToPath(new URL('..', import.meta.url)), inspect = lstat,
} = {}) {
  if (environment.NIGHT_ALL_CONFIG_PATH) return environment.NIGHT_ALL_CONFIG_PATH
  // The user's known checkout is the default on this workstation. On a server,
  // discover only conventional sibling workspaces, never scan arbitrary files.
  const candidates = [join(homeDirectory, 'workspace/mingxi/Night-All/config.json')]
  for (let directory = hubDirectory; dirname(directory) !== directory; directory = dirname(directory)) {
    candidates.push(join(directory, 'Night-All/config.json'), join(directory, 'mingxi/Night-All/config.json'))
  }
  for (const candidate of new Set(candidates)) {
    const info = await inspect(candidate).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (info) return candidate // The credential reader validates owner/type/mode.
  }
  return candidates[0] // Retains the reader's explicit environment fallback.
}

// Idempotent bootstrap: read target state first. Existing environment/database
// keys and deliberate database clears (revision > 0) remain authoritative.
export async function migrateFacebookCredentials(environment = process.env, { fetchImpl = fetch, readCredentials = readNightAllExternalPlatformCredentials } = {}) {
  const base = normalizeAdminBase(environment.MX_INSIGHT_ADMIN_BASE_URL)
  const token = environment.MX_INSIGHT_ADMIN_TOKEN
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw new Error('facebook_migration_admin_token_required')
  const request = async (provider, method = 'GET', body) => {
    const response = await fetchImpl(`${base}/internal/v1/admin/external-platforms/${provider}${method === 'PUT' ? '/credential' : '?range=24h'}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'x-mx-insight-admin-token': token,
        ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new Error(`facebook_migration_http_${response.status}`)
    return (await response.json()).data
  }
  const results = []
  for (const provider of ['rapidapi', 'justone']) {
    const { credential } = await request(provider)
    if (!credential || !Number.isSafeInteger(credential.revision)) throw new Error('facebook_migration_invalid_target')
    if (credential.credentialConfigured || credential.revision > 0) {
      results.push({ provider, status: 'preserved', revision: credential.revision }); continue
    }
    let values
    try {
      const envKey = provider === 'justone' ? environment.JUSTONE_API_KEY || environment.JUSTONE_TOKEN : null
      if (envKey) {
        if (envKey.length > 4096 || /[\r\n]/.test(envKey)) throw new Error('invalid_source_key')
        values = { justone: envKey.trim() }
      } else values = await readCredentials(await discoverNightAllConfig(environment), { providers: [provider], environment, allowReadableConfig: true })
    } catch {
      results.push({ provider, status: 'source_unavailable', revision: credential.revision }); continue
    }
    if (environment.MX_INSIGHT_FACEBOOK_CREDENTIAL_DRY_RUN === '1') {
      results.push({ provider, status: 'would_migrate', revision: credential.revision }); continue
    }
    const updated = await request(provider, 'PUT', { apiKey: values[provider], expectedRevision: credential.revision })
    if (!updated.credentialConfigured || updated.source !== 'database' || updated.revision !== credential.revision + 1) throw new Error('facebook_migration_unconfirmed')
    results.push({ provider, status: 'migrated', revision: updated.revision })
  }
  return results
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateFacebookCredentials().then(results => {
    for (const row of results) process.stdout.write(`Facebook credential provider=${row.provider} status=${row.status} revision=${row.revision}\n`)
    if (results.some(row => row.status === 'source_unavailable')) process.stderr.write('Facebook: no usable local Night-All credential found; configure the supplier in Hub Admin if this host has no Night-All checkout. Other services remain available.\n')
  }).catch(() => { process.stderr.write('Facebook credential migration failed; no automatic retry. Inspect Hub Admin credential state.\n'); process.exitCode = 1 })
}
