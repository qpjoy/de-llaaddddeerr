import { compareWithCatalog } from './summary.mjs'

/** Assertions come from the runner; the reviewed snapshot supplies the coverage denominator. */
export function reconcileWorkbench(workbench, normalized) {
  const expected = new Map(workbench.bindings.map((entry) => [entry.caseId, entry.specPath]))
  const observed = normalized.cases.map((entry) => {
    const spec = expected.get(entry.caseId)
    if (!spec || entry.specPath === spec) return entry
    return {
      ...entry,
      status: ['failed', 'flaky'].includes(entry.status) ? entry.status : 'notRun',
      errorText: `脚本与确认的关联不一致：期望 ${spec}，实际 ${entry.specPath || '未上报'}。${entry.errorText || ''}`
    }
  })
  const reconciled = compareWithCatalog(workbench.cases, observed)
  const missing = reconciled.cases.filter(
    (entry) => expected.has(entry.caseId) && ['notRun', 'skipped'].includes(entry.status)
  )
  if (missing.length && normalized.status === 'passed') {
    normalized.status = 'blocked'
    normalized.blockedReason = `已确认用例未完整验证：${missing.map((entry) => entry.caseId).join('、')}`
  }
  reconciled.catalog.workbench = {
    revision: workbench.revision,
    platform: workbench.platform,
    executionScope: 'suite'
  }
  return reconciled
}
