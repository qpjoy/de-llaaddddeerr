// Running part of a suite.
//
// The filter a person writes is a mix of two things: Case IDs ("rerun
// LP-FE-AUTH-001") and spec globs ("everything under smoke/"). Engines only
// understand the second. The platform is the only component that knows the
// mapping between them — that is what the catalog is — so translating happens
// here, once, before the run starts.
//
// docs/04-runner-contract.md defines `MXT_CASE_FILTER`; docs/25 §15d records
// why it took until now to mean anything.

import { AppError } from '../core/errors.mjs'

const CASE_ID_SHAPE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/u

/** Split a written filter into its entries, dropping empties and duplicates. */
export function parseCaseFilter(value) {
  if (typeof value !== 'string') return []
  const seen = new Set()
  for (const entry of value.split(',')) {
    const trimmed = entry.trim()
    if (trimmed) seen.add(trimmed.slice(0, 200))
  }
  return [...seen].slice(0, 50)
}

/**
 * Turn a filter into something a runner can act on.
 *
 * Refuses rather than degrades. A filter naming a case the catalog has never
 * heard of, or one whose catalog entry has no spec path, cannot be honoured —
 * and a run that quietly ignored its filter would execute the entire suite
 * while the record said otherwise. That is worse than an error message.
 */
export async function resolveCaseFilter({ store, appId, filter, suiteSlug = null }) {
  const entries = parseCaseFilter(filter)
  if (entries.length === 0) return null

  const caseIds = entries.filter((entry) => CASE_ID_SHAPE.test(entry))
  const globs = entries.filter((entry) => !CASE_ID_SHAPE.test(entry))

  const specs = new Set(globs)
  const matchedCaseIds = []
  if (caseIds.length > 0) {
    const catalog = await store.listCases(appId)
    const byId = new Map(catalog.map((entry) => [entry.caseId, entry]))
    const unknown = []
    const unmapped = []
    for (const caseId of caseIds) {
      const entry = byId.get(caseId)
      if (!entry) {
        unknown.push(caseId)
        continue
      }
      if (!entry.specPath) {
        unmapped.push(caseId)
        continue
      }
      specs.add(entry.specPath)
      matchedCaseIds.push(caseId)
    }
    if (unknown.length > 0) {
      throw new AppError(400, 'case_filter_unknown', `用例目录里没有这些 ID：${unknown.join('、')}`, {
        hint: '目录来自被测仓库的 case-catalog 文件。同步过目录之后再试。',
      })
    }
    if (unmapped.length > 0) {
      throw new AppError(400, 'case_filter_unmapped', `这些用例还没有对应的 spec 文件：${unmapped.join('、')}`, {
        hint: '「已登记、待实现」的用例没有代码可跑。等它实现之后再单独重跑。',
      })
    }
  }

  return {
    // What the person wrote, kept verbatim: it is what the run record shows and
    // what `MXT_CASE_FILTER` carries for engines that understand Case IDs.
    raw: entries.join(','),
    caseIds: matchedCaseIds,
    // What every engine understands. compass reads this as `E2E_SPEC`.
    specs: [...specs],
    suiteSlug,
  }
}

/**
 * The catalog subset a filtered run should be measured against.
 *
 * Without this, rerunning one case would report the other twenty-two as
 * "registered but never ran" — technically true, and it would make `notRun`
 * useless the first time anybody used a filter.
 */
export function catalogSubsetFor(catalogCases, filter) {
  if (!filter) return catalogCases
  const ids = new Set(filter.caseIds ?? [])
  const specs = new Set(filter.specs ?? [])
  return catalogCases.filter(
    (entry) => ids.has(entry.caseId) || (entry.specPath && specs.has(entry.specPath)),
  )
}
