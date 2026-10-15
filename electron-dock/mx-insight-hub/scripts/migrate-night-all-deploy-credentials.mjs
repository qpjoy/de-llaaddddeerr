import { lstat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { WEB_SEARCH_PROVIDERS } from '../shared/web-search.mjs'
import { normalizeAdminBase } from './migrate-tikhub-credential.mjs'
import { discoverNightAllConfig, migrateFacebookCredentials } from './migrate-facebook-credentials.mjs'
import { formatMigrationResults, migrateNightAllCredentials } from './migrate-night-all-credentials.mjs'

// One source owns each supplier for this deployment. An explicitly configured
// SQL source owns Web Search; JSON failures must never trigger another import.
export async function migrateNightAllDeployCredentials(environment = process.env, {
  discoverConfig = discoverNightAllConfig, inspect = lstat,
  migrateJson = migrateNightAllCredentials, migrateFacebook = migrateFacebookCredentials,
} = {}) {
  const target = { ...environment, MX_INSIGHT_ADMIN_BASE_URL: normalizeAdminBase(environment.MX_INSIGHT_ADMIN_BASE_URL) }
  const providers = ['rapidapi', 'tikhub', 'justone',
    ...(!environment.NIGHT_ALL_DATABASE_URL ? WEB_SEARCH_PROVIDERS.map(({ key }) => key) : [])]
  let configPath
  try {
    configPath = await discoverConfig(target)
    await inspect(configPath)
  } catch (error) {
    // An explicit bad path, permission error or other uncertain source state
    // must be corrected, not hidden by an environment/legacy fallback.
    if (environment.NIGHT_ALL_CONFIG_PATH || error?.code !== 'ENOENT') {
      throw new Error('night_all_deploy_config_unavailable')
    }
    const rows = await migrateFacebook(target)
    return { configMissing: true, providers: rows.map(row => ({ ...row, source: 'legacy-facebook', sourceEnabled: null })),
      complete: rows.every(row => ['preserved', 'migrated', 'would_migrate'].includes(row.status)) }
  }
  const result = await migrateJson({ ...target, NIGHT_ALL_CONFIG_PATH: configPath }, {
    providers, dryRun: false, allowReadableConfig: true,
  })
  return { ...result, configMissing: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateNightAllDeployCredentials().then(result => {
    process.stdout.write(`${formatMigrationResults(result)}\n`)
    if (result.configMissing) {
      process.stderr.write('Night-All JSON was not found. Set NIGHT_ALL_CONFIG_PATH to import missing Hub suppliers; only the existing Facebook fallback was attempted.\n')
    }
    if (!result.complete) process.exitCode = 1
  }).catch(() => {
    process.stderr.write('Night-All deploy credential import failed. Check NIGHT_ALL_CONFIG_PATH and Hub Admin credential state. No automatic retry or source fallback.\n')
    process.exitCode = 1
  })
}
