// Acceptance packs (验收包): a product's test project as data, kept in the
// repository under test-packs/<id>/pack.json (docs/21 §5).
//
// A pack is turned into the same plan the Compass reconcile already applies
// — app, suites, tasks, catalogs — so creating a project from a pack is
// idempotent in the same way: run it twice and nothing is duplicated, and
// what a person changed on an existing app is not overwritten.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKS_ROOT = resolve(fileURLToPath(new URL('../../../../test-packs', import.meta.url)))
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/u

/** The repository a workspace suite checks out: the project's own QA repo on the machine running it. */
export const workspaceRepo = (appSlug) => `rig-workspace://${appSlug}/qa`
export const WORKSPACE_REPO = /^rig-workspace:\/\/([a-z0-9][a-z0-9-]{0,62})\/qa$/u
/** The project's published test versions on the service (docs/23 M7b): any runner may fetch them. */
export const publishedRepo = (appSlug) => `rig-published://${appSlug}`
export const PUBLISHED_REPO = /^rig-published:\/\/([a-z0-9][a-z0-9-]{0,62})$/u

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function inside(root, path) {
  const full = resolve(root, path)
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`验收包里的路径越界：${path}`)
  return full
}

/** One pack with its catalogs read, or null when there is no such pack. */
export function loadPack(id, { root = PACKS_ROOT } = {}) {
  if (!PACK_ID.test(String(id ?? ''))) return null
  const dir = join(root, id)
  const file = join(dir, 'pack.json')
  if (!existsSync(file)) return null
  const pack = readJson(file)
  if (pack.id !== id) throw new Error(`验收包 ${id} 的 pack.json 写的是 ${pack.id}`)
  return {
    ...pack,
    dir,
    catalogs: (pack.catalogs ?? []).map((path) => ({ path, catalog: readJson(inside(dir, path)) }))
  }
}

export function listPacks({ root = PACKS_ROOT } = {}) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PACK_ID.test(entry.name) && existsSync(join(root, entry.name, 'pack.json')))
    .map((entry) => loadPack(entry.name, { root }))
    .filter(Boolean)
}

/** What a person choosing a pack needs to see; no file system paths. */
export function describePack(pack) {
  const counted = (entry) => entry.catalog.cases.filter((item) => item.automationState !== 'reference' && item.retired !== true).length
  return {
    id: pack.id,
    version: pack.version,
    title: pack.title,
    description: pack.description,
    app: pack.app,
    source: pack.source,
    suites: pack.suites.map((suite) => ({ slug: suite.slug, displayName: suite.displayName, surface: suite.surface })),
    plans: pack.plans.map((plan) => ({ name: plan.name, suite: plan.suite })),
    cases: pack.catalogs.reduce((sum, entry) => sum + counted(entry), 0),
    references: pack.catalogs.reduce(
      (sum, entry) => sum + entry.catalog.cases.filter((item) => item.automationState === 'reference').length,
      0
    ),
    boundary: pack.boundary ?? null
  }
}

/**
 * The reconcile plan for `pack`. Workspace suites check out the project's QA
 * repository on the machine that holds it, so their plans can only be pinned
 * to that machine: without `runnerId` the plan has no tasks for them, and
 * says so.
 */
export function buildPackPlan(pack, { appSlug = null, runnerId = null } = {}) {
  const slug = appSlug || pack.app.slug
  const suites = pack.suites.map(({ workspace, ...suite }) => ({
    ...suite,
    ...(workspace ? { repoUrl: workspaceRepo(slug), defaultBranch: 'main', ownSource: true } : {})
  }))
  const workspaceSuites = new Set(pack.suites.filter((suite) => suite.workspace).map((suite) => suite.slug))
  const tasks = []
  const warnings = []
  for (const plan of pack.plans ?? []) {
    if (workspaceSuites.has(plan.suite) && !runnerId) {
      warnings.push(`执行计划「${plan.name}」要指定持有测试项目工作区的电脑，请在桌面端建立快照后再生成。`)
      continue
    }
    tasks.push({
      suiteSlug: plan.suite,
      name: plan.name,
      profile: plan.profile ?? 'mock',
      track: plan.track ?? 'functional',
      ...(workspaceSuites.has(plan.suite) ? { runsOn: 'pinned-runner', runnerId } : { runsOn: plan.runsOn ?? null }),
      caseFilter: plan.caseFilter ?? null,
      schedule: plan.schedule ?? { kind: 'manual' }
    })
  }
  return {
    app: {
      slug,
      displayName: pack.app.displayName,
      surfaces: pack.app.surfaces,
      repoUrl: pack.source?.repoUrl ?? null,
      defaultBranch: pack.source?.ref ?? null
    },
    suites,
    tasks,
    catalogs: pack.catalogs.map((entry) => structuredClone(entry.catalog)),
    warnings
  }
}
