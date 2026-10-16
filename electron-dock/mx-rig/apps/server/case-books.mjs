import { RigError } from '../../packages/contracts/index.mjs'
import {
  caseEditBody,
  caseConfirmBody,
  readTestInput
} from '../../packages/runtime/test-workspace.mjs'
import { documentFor } from './state-documents.mjs'
import { promoteCases } from './case-promotion.mjs'

/** Versioned case material attached to a Mission, independent of the executor's writes. */
export class CaseBooks {
  constructor(sourceFor) {
    this.sourceFor = sourceFor
    this.documents = new Map()
    this.queues = new Map()
  }
  document(id) {
    if (!this.documents.has(id)) this.documents.set(id, documentFor(this.sourceFor(id)))
    return this.documents.get(id)
  }
  async read(id, revision) {
    const { value } = await this.document(id).load()
    return this.present(value ?? { revisions: [] }, revision)
  }
  present(value, revision) {
    const current = value.revisions.at(-1)
    const selected =
      revision === undefined
        ? current
        : value.revisions.find((entry) => entry.revision === revision)
    if (revision !== undefined && !selected) throw new RigError('not_found', '用例版本不存在', 404)
    return structuredClone({
      revision: selected?.revision ?? 0,
      currentRevision: current?.revision ?? 0,
      cases: selected?.cases ?? [],
      confirmed: Boolean(selected?.confirmedAt),
      confirmedAt: selected?.confirmedAt ?? null,
      confirmedBy: selected?.confirmedBy ?? null,
      history: value.revisions.map(({ cases, ...entry }) => ({ ...entry, count: cases.length }))
    })
  }
  async change(id, owner, action, input) {
    const body = readTestInput(action === 'confirm' ? caseConfirmBody : caseEditBody, input)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const document = this.document(id)
      const { value, version } = await document.load()
      const state = structuredClone(value ?? { revisions: [] })
      const current = state.revisions.at(-1)
      if ((current?.revision ?? 0) !== body.expectedRevision)
        throw new RigError(
          'case_revision_conflict',
          '用例已更新，请刷新并核对差异后再保存或确认',
          409
        )
      if (action === 'confirm') {
        if (!current?.cases.length) throw new RigError('cases_empty', '请先提供测试用例', 409)
        const incomplete = current.cases.filter(
          (entry) => !entry.steps.trim() || !entry.expected.trim()
        )
        if (incomplete.length)
          throw new RigError(
            'cases_incomplete',
            `请补齐步骤和预期结果：${incomplete.map((entry) => entry.caseId).join('、')}`,
            409
          )
        if (current.confirmedAt) return this.present(state)
        current.confirmedAt = new Date().toISOString()
        current.confirmedBy = owner
      } else {
        const ids = body.cases.map((entry) => entry.caseId)
        if (new Set(ids).size !== ids.length)
          throw new RigError('duplicate_case', '同一任务内用例编号不能重复')
        state.revisions.push({
          revision: (current?.revision ?? 0) + 1,
          cases: body.cases,
          createdAt: new Date().toISOString(),
          createdBy: owner,
          confirmedAt: null,
          confirmedBy: null
        })
      }
      if (Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024)
        throw new RigError(
          'case_history_capacity',
          '本任务的用例历史已达到容量上限，请新建后续任务保留原历史',
          409
        )
      // PgDocument uses a real CAS; a competing replica cannot erase this version.
      await document.save(state, version)
      return this.present(state)
    })
    const settled = next.catch(() => {})
    this.queues.set(id, settled)
    settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return next
  }
}

export async function caseBookRoutes({
  projectAccess,
  req,
  res,
  path,
  url,
  principal,
  missions,
  caseBooks,
  readJson,
  sendJson,
  requireRole,
  store = null
}) {
  const match = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/cases(?::(confirm|promote))?$/.exec(path)
  if (!match) return false
  const mission = await missions.get(match[1], principal.id)
  if (!mission.workbench) throw new RigError('not_test_task', '这项任务尚未关联测试项目', 409)
  if (req.method === 'GET' && !match[2]) {
    const revision = url.searchParams.has('revision')
      ? Number(url.searchParams.get('revision'))
      : undefined
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw new RigError('invalid_revision', '版本必须是正整数')
    sendJson(res, 200, { book: await caseBooks.read(mission.id, revision) })
    return true
  }
  if (req.method === 'POST' && match[2] === 'promote') {
    // 提升到项目用例库: the version the person is looking at, confirmed.
    requireRole(principal, 'operator')
    await projectAccess?.mission(mission, 'write')
    if (!store) throw new RigError('not_available', '这个服务没有用例库', 501)
    const body = await readJson(req, 64 * 1024)
    const expected = Number(body?.expectedRevision)
    const caseIds = Array.isArray(body?.caseIds) ? body.caseIds.filter((id) => typeof id === 'string').slice(0, 200) : null
    const book = await caseBooks.read(mission.id)
    if (!Number.isSafeInteger(expected) || expected !== book.revision)
      throw new RigError('case_revision_conflict', '用例已更新，请刷新后再提升', 409)
    sendJson(res, 200, await promoteCases({ store, mission, book, principal, request: req, caseIds }))
    return true
  }
  if (req.method === 'POST') {
    requireRole(principal, 'operator')
    await projectAccess?.mission(mission, 'write')
    const body = await readJson(req, 1024 * 1024)
    sendJson(res, 200, {
      book: await caseBooks.change(mission.id, principal.id, match[2] || 'edit', body)
    })
    return true
  }
  throw new RigError('not_found', '接口不存在', 404)
}
