import { RigError } from '../../packages/contracts/index.mjs'
import { readTestInput } from '../../packages/runtime/test-workspace.mjs'
import {
  implementationEditBody,
  implementationApproveBody,
  implementationHash,
  checkImplementation
} from '../../packages/runtime/test-implementation.mjs'
import { diffLines } from '../../packages/runtime/workspace.mjs'
import { documentFor } from './state-documents.mjs'

/** Reviewed test source is a separate document, never overwritten by a Runtime save. */
export class TestImplementations {
  constructor(sourceFor, caseBooks) {
    this.sourceFor = sourceFor
    this.caseBooks = caseBooks
    this.documents = new Map()
    this.queues = new Map()
  }
  document(id) {
    if (!this.documents.has(id)) this.documents.set(id, documentFor(this.sourceFor(id)))
    return this.documents.get(id)
  }
  async present(id, state, revision) {
    const proposal =
      revision === undefined
        ? state.revisions.at(-1)
        : state.revisions.find((row) => row.version === revision)
    if (revision !== undefined && !proposal) throw new RigError('not_found', '实现版本不存在', 404)
    const book = await this.caseBooks.read(id)
    const base = state.revisions
      .filter((row) => row.reviewedAt && row.version < proposal?.version)
      .at(-1)
    const before = new Map((base?.files ?? []).map((file) => [file.path, file.content]))
    const after = new Map((proposal?.files ?? []).map((file) => [file.path, file.content]))
    return structuredClone({
      version: state.revisions.at(-1)?.version ?? 0,
      proposal: proposal ?? null,
      stale: Boolean(proposal && (proposal.caseRevision !== book.revision || !book.confirmed)),
      baseVersion: base?.version ?? null,
      diffs: [...new Set([...before.keys(), ...after.keys()])].map((path) => ({
        path,
        diff: diffLines(before.get(path) ?? '', after.get(path) ?? '', 2, 120)
      })),
      missingCaseIds: proposal
        ? book.cases
            .filter(
              (entry) =>
                entry.platforms.includes(proposal.platform) &&
                !proposal.mappings.some((m) => m.caseId === entry.caseId)
            )
            .map((entry) => entry.caseId)
        : [],
      history: state.revisions.map(
        ({
          version,
          caseRevision,
          summary,
          engine,
          platform,
          hash,
          createdAt,
          createdBy,
          reviewedAt,
          reviewedBy
        }) => ({
          version,
          caseRevision,
          summary,
          engine,
          platform,
          hash,
          createdAt,
          createdBy,
          reviewedAt,
          reviewedBy
        })
      )
    })
  }
  async read(id, revision) {
    const { value } = await this.document(id).load()
    return this.present(id, value ?? { revisions: [] }, revision)
  }
  async change(id, owner, action, input) {
    const body = readTestInput(
      action === 'approve' ? implementationApproveBody : implementationEditBody,
      input
    )
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const document = this.document(id)
      const { value, version } = await document.load()
      const state = structuredClone(value ?? { revisions: [] })
      const current = state.revisions.at(-1)
      if ((current?.version ?? 0) !== body.expectedVersion)
        throw new RigError('implementation_conflict', '测试实现已更新，请刷新后核对', 409)
      const book = await this.caseBooks.read(id)
      if (action === 'approve') {
        if (!current || current.hash !== body.hash)
          throw new RigError('implementation_conflict', '批准内容与预览不一致', 409)
        checkImplementation(current, book)
        if (!current.reviewedAt) {
          current.reviewedAt = new Date().toISOString()
          current.reviewedBy = owner
        }
      } else {
        const proposal = { ...body.proposal, caseRevision: body.caseRevision, ...(body.sourceBaseline ? { sourceBaseline: body.sourceBaseline } : {}) }
        checkImplementation(proposal, book)
        state.revisions.push({
          ...proposal,
          version: body.expectedVersion + 1,
          hash: implementationHash(proposal),
          createdAt: new Date().toISOString(),
          createdBy: owner,
          reviewedAt: null,
          reviewedBy: null
        })
      }
      if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024)
        throw new RigError('implementation_capacity', '实现历史已达容量上限，请创建后续任务', 409)
      await document.save(state, version)
      return this.present(id, state)
    })
    const settled = next.catch(() => {})
    this.queues.set(id, settled)
    settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id)
    })
    return next
  }
}

export async function testImplementationRoutes({
  projectAccess,
  req,
  res,
  path,
  url,
  principal,
  missions,
  implementations,
  readJson,
  sendJson,
  requireRole
}) {
  const match = /^\/api\/rig\/v1\/missions\/([a-f0-9-]{36})\/implementation(?::(approve))?$/.exec(
    path
  )
  if (!match) return false
  const mission = await missions.get(match[1], principal.id)
  if (!mission.workbench) throw new RigError('not_test_task', '任务未关联项目', 409)
  if (req.method === 'GET' && !match[2]) {
    const revision = url.searchParams.has('revision')
      ? Number(url.searchParams.get('revision'))
      : undefined
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw new RigError('invalid_revision', '版本必须是正整数')
    sendJson(res, 200, await implementations.read(mission.id, revision))
  } else if (req.method === 'POST') {
    requireRole(principal, 'operator')
    await projectAccess?.mission(mission, 'write')
    sendJson(
      res,
      200,
      await implementations.change(
        mission.id,
        principal.id,
        match[2] || 'edit',
        await readJson(req, 256 * 1024)
      )
    )
  } else throw new RigError('not_found', '接口不存在', 404)
  return true
}
