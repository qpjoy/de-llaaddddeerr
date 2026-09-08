import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildCompassPlan as buildSharedCompassPlan } from '../../mx-test-framework/server/onboarding/compass.mjs'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function electronCommand(environment) {
  const raw = nonEmpty(environment.MX_AUTO_COMPASS_ELECTRON_COMMAND_JSON)
  if (!raw) return ['pnpm', 'test']
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('MX_AUTO_COMPASS_ELECTRON_COMMAND_JSON must be a non-empty JSON string array')
  }
  return parsed
}

function electronSource(value) {
  if (!value) return null
  if (/^(?:https?|ssh|git):\/\//u.test(value) || /^[^/@\s]+@[^:\s]+:.+/u.test(value)) return value

  const localPath = resolve(value.startsWith('file://') ? fileURLToPath(value) : value)
  let canonicalLocalPath
  let repositoryRoot
  try {
    canonicalLocalPath = realpathSync(localPath)
    repositoryRoot = execFileSync('git', ['-C', localPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    throw new Error(`Electron test source must be a Git remote or checkout root: ${value}`)
  }
  if (realpathSync(repositoryRoot) !== canonicalLocalPath) {
    throw new Error(`Electron test source is a subdirectory, not a Git checkout root: ${value}`)
  }
  return localPath
}

export function buildCompassPlan(environment = process.env) {
  const electronRepo = electronSource(
    nonEmpty(environment.MX_AUTO_COMPASS_QA_REPO) ||
      nonEmpty(environment.MX_AUTO_COMPASS_TEST_PACK)
  )
  return buildSharedCompassPlan({
    appSlug: nonEmpty(environment.MX_AUTO_COMPASS_APP_SLUG) || 'luopan',
    webBranch: nonEmpty(environment.MX_AUTO_COMPASS_BRANCH) || 'public',
    webRepoUrl: nonEmpty(environment.MX_AUTO_COMPASS_REPO),
    functionalCron: nonEmpty(environment.MX_AUTO_COMPASS_FUNCTIONAL_CRON),
    timezone: nonEmpty(environment.MX_AUTO_COMPASS_TIMEZONE) || 'Asia/Shanghai',
    electronQaRepoUrl: electronRepo,
    electronBranch: nonEmpty(environment.MX_AUTO_COMPASS_ELECTRON_BRANCH) || 'main',
    electronWorkingDir: nonEmpty(environment.MX_AUTO_COMPASS_ELECTRON_WORKING_DIR) || '.',
    electronOs: nonEmpty(environment.MX_AUTO_COMPASS_ELECTRON_OS) || 'windows',
    electronCommand: electronRepo ? electronCommand(environment) : undefined
  })
}

async function syncCatalogs(client, appSlug, catalogs) {
  for (const catalog of catalogs) {
    const result = await client.call(
      'POST',
      `/api/v1/apps/${encodeURIComponent(appSlug)}/catalog:sync`,
      catalog
    )
    console.log(
      `[onboard] synced catalog ${catalog.catalogFile}: ` +
        `${result.added?.length ?? 0} added, ${result.updated?.length ?? 0} updated, ` +
        `${result.retired?.length ?? 0} retired`
    )
  }
}

function createClient(environment = process.env) {
  const baseUrl = (environment.MX_AUTO_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/u, '')
  const token = nonEmpty(environment.MX_AUTO_TOKEN) || nonEmpty(environment.MX_AUTO_ADMIN_TOKEN)
  if (!token) throw new Error('MX_AUTO_TOKEN is required')

  return {
    baseUrl,
    async call(method, path, body) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      })
      const text = await response.text()
      let parsed = null
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = { text }
        }
      }
      if (!response.ok) {
        const error = new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 400)}`)
        error.status = response.status
        throw error
      }
      return parsed
    }
  }
}

async function ensureApp(client, desired) {
  let apps = (await client.call('GET', '/api/v1/apps'))?.apps ?? []
  let current = apps.find((app) => app.slug === desired.slug)
  if (!current) {
    try {
      current = (await client.call('POST', '/api/v1/apps', desired)).app
      console.log(`[onboard] created app ${desired.slug}`)
    } catch (error) {
      if (error.status !== 409) throw error
      apps = (await client.call('GET', '/api/v1/apps'))?.apps ?? []
      current = apps.find((app) => app.slug === desired.slug)
    }
  }
  if (!current) throw new Error(`app ${desired.slug} could not be created or read`)
  if (current.repoUrl !== desired.repoUrl || current.defaultBranch !== desired.defaultBranch) {
    console.warn(
      `[onboard] app ${desired.slug} already exists; its repo/branch was preserved. ` +
        `Current=${current.repoUrl || '<none>'}@${current.defaultBranch || '<none>'}`
    )
  }
  return current
}

async function upsertSuites(client, appSlug, desiredSuites) {
  let suites = (await client.call('GET', `/api/v1/apps/${encodeURIComponent(appSlug)}/suites`))?.suites ?? []
  const result = new Map()
  for (const desired of desiredSuites) {
    const current = suites.find((suite) => suite.slug === desired.slug)
    if (current) {
      const { slug: _slug, ...patch } = desired
      const updated = await client.call(
        'PATCH',
        `/api/v1/apps/${encodeURIComponent(appSlug)}/suites/${encodeURIComponent(desired.slug)}`,
        patch
      )
      result.set(desired.slug, updated.suite)
      console.log(`[onboard] reconciled suite ${desired.slug}`)
    } else {
      const created = await client.call(
        'POST',
        `/api/v1/apps/${encodeURIComponent(appSlug)}/suites`,
        desired
      )
      result.set(desired.slug, created.suite)
      suites.push(created.suite)
      console.log(`[onboard] created suite ${desired.slug}`)
    }
  }
  return result
}

async function upsertTasks(client, appSlug, desiredTasks, suites) {
  const existing = (await client.call('GET', `/api/v1/tasks?app=${encodeURIComponent(appSlug)}`))?.tasks ?? []
  for (const desired of desiredTasks) {
    const suite = suites.get(desired.suiteSlug)
    if (!suite) throw new Error(`suite ${desired.suiteSlug} was not reconciled`)
    const current = existing.find((task) => task.name === desired.name)
    const { suiteSlug, ...settings } = desired
    if (current) {
      if (current.suiteId !== suite.id) {
        throw new Error(`task ${desired.name} already points at another suite; refusing to rewrite history`)
      }
      await client.call('PATCH', `/api/v1/tasks/${encodeURIComponent(current.id)}`, {
        ...settings,
        enabled: true
      })
      console.log(`[onboard] reconciled task ${desired.name}`)
    } else {
      await client.call('POST', '/api/v1/tasks', {
        app: appSlug,
        suite: suiteSlug,
        ...settings
      })
      console.log(`[onboard] created task ${desired.name}`)
    }
  }
}

export async function onboardCompass(environment = process.env) {
  const plan = buildCompassPlan(environment)
  const client = createClient(environment)
  await ensureApp(client, plan.app)
  const suites = await upsertSuites(client, plan.app.slug, plan.suites)
  await syncCatalogs(client, plan.app.slug, plan.catalogs)
  await upsertTasks(client, plan.app.slug, plan.tasks, suites)
  if (!plan.electronConfigured) {
    console.log(
      '[onboard] Electron suite skipped: set MX_AUTO_COMPASS_QA_REPO or ' +
        'MX_AUTO_COMPASS_TEST_PACK to a real Git source.'
    )
  }
  console.log(`[onboard] Compass configuration is ready at ${client.baseUrl}; no run was triggered.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  onboardCompass().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
