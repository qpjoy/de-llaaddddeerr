// 提升到项目用例库 (docs/21 §3.2 c, M2).
//
// A test task's cases are a snapshot: confirmed for that task, they change
// nothing else. Promoting a confirmed version writes those cases into the
// project's case library — the baseline later tasks import from — through the
// kernel's own case validation, so a promoted case is one the library could
// have taken from the UI directly. A case the code repository owns is left to
// the repository; an id the library cannot hold is reported, not invented.

import { RigError } from '../../packages/contracts/index.mjs'
import { recordAudit } from '../../packages/test-platform/server/audit.mjs'
import {
  CASE_ID_PATTERN,
  PLATFORM_CATALOG,
  parseCaseInput
} from '../../packages/test-platform/server/routes/cases.mjs'

const clip = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
// 「1. 打开登录页」「2、输入账号」: the number is the order, not the step.
const lines = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(\d+[.、)）]|[-*•])\s*/, '').trim())
    .filter(Boolean)

/**
 * A task case as a library case. Steps and expectations pair line by line
 * when they have the same number of lines; otherwise the expectations belong
 * to the last step, which is how a person reads 「做完这些，应该看到……」.
 */
export function libraryCase(entry, { goal = '', revision = null, confirmedBy = null, confirmedAt = null } = {}) {
  const actions = lines(entry.steps)
  const expects = lines(entry.expected)
  const steps = actions.length
    ? actions.map((action, index) => ({
        action,
        expect:
          actions.length === expects.length
            ? expects[index]
            : index === actions.length - 1
              ? expects.join('；')
              : ''
      }))
    : expects.length
      ? [{ action: '', expect: expects.join('；') }]
      : []
  const lowered = entry.priority === 'P3'
  return {
    caseId: String(entry.caseId ?? '').toUpperCase(),
    title: clip(entry.title, 300),
    priority: lowered ? 'P2' : entry.priority ?? 'P1',
    preconditions: clip(entry.preconditions, 2000) || undefined,
    requirementRef: clip(entry.requirementRef, 96) || undefined,
    suite: clip(entry.suiteSlug, 96) || undefined,
    tags: Array.isArray(entry.platforms) ? entry.platforms : [],
    steps,
    notes: clip(
      [
        `来自测试任务「${clip(goal, 120)}」第 ${revision ?? '?'} 版`,
        confirmedAt ? `${confirmedBy ?? '成员'} 于 ${confirmedAt.slice(0, 10)} 确认` : null,
        lowered ? '原优先级 P3，用例库最低为 P2' : null,
        entry.specPath ? `关联实现：${clip(entry.specPath, 200)}` : null
      ]
        .filter(Boolean)
        .join('；'),
      2000
    )
  }
}

/**
 * Promote cases of a task's confirmed case version into its project's library.
 *
 * @returns {{ promoted: Array<{caseId:string, action:'created'|'updated'}>, skipped: Array<{caseId:string, reason:string}> }}
 */
export async function promoteCases({ store, mission, book, principal, request = null, caseIds = null }) {
  const appId = mission.workbench?.appId
  if (!appId) throw new RigError('not_test_task', '这项任务尚未关联测试项目', 409)
  if (!book.confirmed) throw new RigError('cases_not_confirmed', '只有已确认的用例版本才能提升到用例库', 409)
  const wanted = caseIds ? new Set(caseIds.map((id) => String(id).toUpperCase())) : null
  const promoted = []
  const skipped = []
  for (const entry of book.cases) {
    const draft = libraryCase(entry, {
      goal: mission.goal,
      revision: book.revision,
      confirmedBy: book.confirmedBy,
      confirmedAt: book.confirmedAt
    })
    if (wanted && !wanted.has(draft.caseId)) continue
    if (!CASE_ID_PATTERN.test(draft.caseId)) {
      skipped.push({ caseId: entry.caseId, reason: '编号不符合用例库规范：<应用>-<端>-<业务域>-<三位序号>，例如 LP-FE-AUTH-001' })
      continue
    }
    const existing = await store.getCase(appId, draft.caseId)
    if (existing && !existing.retiredAt && existing.origin === 'catalog') {
      skipped.push({ caseId: draft.caseId, reason: '这条用例来自代码仓库，以仓库里的目录为准' })
      continue
    }
    let input
    try {
      input = parseCaseInput(draft, { existing: existing && !existing.retiredAt ? existing : null })
    } catch (error) {
      skipped.push({ caseId: draft.caseId, reason: String(error.message ?? error).slice(0, 200) })
      continue
    }
    const action = existing && !existing.retiredAt ? 'updated' : 'created'
    const saved = await store.upsertCase(appId, {
      ...input,
      origin: 'platform',
      catalogFile: PLATFORM_CATALOG,
      createdBy: action === 'updated' ? existing.createdBy ?? principal.id : principal.id
    })
    await recordAudit(store, {
      principal,
      request,
      action: 'case.promote',
      resourceType: 'case',
      resourceId: saved?.caseId ?? draft.caseId,
      appId,
      before: action === 'updated' ? { title: existing.title, priority: existing.priority } : null,
      after: { title: input.title, priority: input.priority, mission: mission.id, caseRevision: book.revision }
    })
    promoted.push({ caseId: draft.caseId, action })
  }
  return { promoted, skipped }
}
