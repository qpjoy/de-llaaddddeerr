// Where procedures live: files in memory mode, `rig_procedures` when shared.
//
// Both backends run every change through the same pure rules below, inside
// one critical section (a file write queue, or a row lock), so a revision,
// a replay record and a decision on a proposal can never interleave into a
// state neither writer saw.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { RigError } from '../../packages/contracts/index.mjs'
import { diffSteps, pickBody, readProcedure, readSteps } from '../../packages/runtime/procedure.mjs'

const HISTORY_LIMIT = 20
const RUN_LIMIT = 30
// Page snapshots are the bulky part of a run; only the latest few keep one.
const SCENES_KEPT = 3
const PROPOSAL_LIMIT = 20

const newId = (prefix) => `${prefix}_${randomBytes(9).toString('hex')}`
const assertionKey = (step) =>
  `${step.kind}|${step.expected ?? ''}|${JSON.stringify(step.target ?? null)}`

/**
 * Checks of the current revision that a proposal no longer makes as written.
 * A replay cannot see this — with a check gone, nothing is left to fail — so
 * the reviewer is told, in so many words.
 */
export function droppedAssertions(before, after) {
  const kept = new Set(after.filter((step) => step.do === 'assert').map(assertionKey))
  return before.filter((step) => step.do === 'assert' && !kept.has(assertionKey(step)))
}

export function summaryOf(doc) {
  return {
    id: doc.id,
    title: doc.title,
    app: doc.app,
    caseId: doc.caseId,
    surface: doc.surface,
    status: doc.status,
    revision: doc.revision,
    steps: doc.steps.length,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    lastRun: doc.runs?.[0]
      ? {
          id: doc.runs[0].id,
          verdict: doc.runs[0].verdict,
          revision: doc.runs[0].revision,
          failedStep: doc.runs[0].failedStep,
          at: doc.runs[0].finishedAt
        }
      : null,
    openProposals: (doc.proposals ?? []).filter((entry) => entry.status === 'pending').length
  }
}

// -- the rules ---------------------------------------------------------------

export const rules = {
  create(id, body, by, now) {
    return {
      id,
      ...readProcedure(body),
      status: 'draft',
      revision: 1,
      createdBy: by,
      createdAt: now,
      updatedBy: by,
      updatedAt: now,
      reason: '创建',
      history: [],
      runs: [],
      proposals: []
    }
  },

  revise(doc, { body, by, now, reason, expectedRevision }) {
    if (expectedRevision !== doc.revision)
      throw new RigError(
        'procedure_conflict',
        `规程已被改为第 ${doc.revision} 版；请刷新后在最新版本上修改`,
        409
      )
    if (doc.status === 'retired') throw new RigError('procedure_retired', '规程已停用', 409)
    const next = readProcedure(body)
    const history = [
      {
        revision: doc.revision,
        ...pickBody(doc),
        by: doc.updatedBy,
        at: doc.updatedAt,
        reason: doc.reason
      },
      ...doc.history
    ].slice(0, HISTORY_LIMIT)
    // Open proposals were made against the old steps; they cannot be applied
    // to the new ones and are closed, with the reason.
    const proposals = doc.proposals.map((entry) =>
      entry.status === 'pending'
        ? {
            ...entry,
            status: 'superseded',
            decidedAt: now,
            note: `规程已改为第 ${doc.revision + 1} 版`
          }
        : entry
    )
    return {
      ...doc,
      ...next,
      revision: doc.revision + 1,
      // A changed procedure has not been proven yet: back to draft until a
      // replay of the new revision passes.
      status: doc.status === 'active' ? 'draft' : doc.status,
      updatedBy: by,
      updatedAt: now,
      reason: String(reason || '修改').slice(0, 300),
      history,
      proposals
    }
  },

  status(doc, { status, by, now }) {
    if (status === 'active') {
      const proven = doc.runs.find(
        (run) => run.revision === doc.revision && run.station !== 'repair'
      )
      if (!proven || proven.verdict !== 'passed')
        throw new RigError(
          'procedure_unproven',
          `第 ${doc.revision} 版还没有一次通过的试车；启用前先在桌面端试车`,
          409
        )
    }
    return { ...doc, status, updatedBy: by, updatedAt: now }
  },

  run(doc, run) {
    const runs = [run, ...doc.runs]
      .slice(0, RUN_LIMIT)
      .map((entry, index) =>
        index < SCENES_KEPT || !entry.failure?.snapshot
          ? entry
          : { ...entry, failure: { ...entry.failure, snapshot: undefined } }
      )
    return { ...doc, runs }
  },

  propose(doc, proposal) {
    if (proposal.baseRevision !== doc.revision)
      throw new RigError(
        'proposal_stale',
        `这个修正基于第 ${proposal.baseRevision} 版，规程已是第 ${doc.revision} 版`,
        409
      )
    const steps = proposal.steps ? readSteps(proposal.steps, doc) : null
    const entry = {
      ...proposal,
      steps,
      diff: steps ? diffSteps(doc.steps, steps) : null,
      droppedAssertions: steps ? droppedAssertions(doc.steps, steps).length : 0,
      status: 'pending'
    }
    return { ...doc, proposals: [entry, ...doc.proposals].slice(0, PROPOSAL_LIMIT) }
  },

  /**
   * A person decides. Approving applies the proposed steps as the next
   * revision — only if they were proven by a replay, and only if the
   * procedure is still the revision they were written against.
   */
  decide(doc, { proposalId, approved, by, now }) {
    const proposal = doc.proposals.find((entry) => entry.id === proposalId)
    if (!proposal) throw new RigError('not_found', '修正提议不存在', 404)
    if (proposal.status !== 'pending')
      throw new RigError('proposal_decided', '这个修正提议已经处理过', 409)
    const close = (status, extra = {}) =>
      doc.proposals.map((entry) =>
        entry.id === proposalId
          ? { ...entry, status, decidedBy: by, decidedAt: now, ...extra }
          : entry
      )
    if (!approved) return { ...doc, proposals: close(proposal.steps ? 'rejected' : 'dismissed') }
    if (!proposal.steps)
      throw new RigError(
        'proposal_without_change',
        '这条提议没有修改步骤（判断为非用例问题），只能标记为已读',
        409
      )
    if (proposal.validation?.verdict !== 'passed')
      throw new RigError(
        'proposal_unproven',
        '修正后的规程没有通过验证试车，不能批准；可以驳回，或在编辑器里手工修改',
        409
      )
    const revised = rules.revise(
      { ...doc, proposals: close('approved') },
      {
        body: { ...pickBody(doc), steps: proposal.steps },
        by,
        now,
        reason: `纠正措施：${proposal.rationale}`.slice(0, 300),
        expectedRevision: proposal.baseRevision
      }
    )
    // The validation replay *was* a passing replay of exactly these steps:
    // it counts as the proof the new revision needs, so the procedure keeps
    // the status it had instead of dropping back to draft.
    return {
      ...revised,
      status: doc.status,
      runs: [
        {
          ...proposal.validation,
          id: proposal.validation.id ?? newId('prr'),
          revision: revised.revision,
          station: 'validation',
          by: proposal.by
        },
        ...revised.runs
      ].slice(0, RUN_LIMIT)
    }
  }
}

// -- backends ----------------------------------------------------------------

export class FileProcedureStore {
  constructor(dir) {
    this.dir = dir
    this.docs = new Map()
    this.queue = Promise.resolve()
  }
  async init() {
    await mkdir(this.dir, { recursive: true })
    for (const file of await readdir(this.dir)) {
      if (!/^prc_[a-f0-9]+\.json$/.test(file)) continue
      const doc = JSON.parse(await readFile(join(this.dir, file), 'utf8'))
      this.docs.set(doc.id, doc)
    }
    return this
  }
  async #write(doc) {
    const file = join(this.dir, `${doc.id}.json`)
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temp, JSON.stringify(doc), { mode: 0o600 })
    await rename(temp, file)
  }
  async list({ app = null, caseId = null } = {}) {
    return [...this.docs.values()]
      .filter((doc) => (!app || doc.app === app) && (!caseId || doc.caseId === caseId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((doc) => structuredClone(doc))
  }
  async get(id) {
    const doc = this.docs.get(id)
    if (!doc) throw new RigError('not_found', '规程不存在', 404)
    return structuredClone(doc)
  }
  async insert(doc) {
    this.docs.set(doc.id, doc)
    await this.#write(doc)
    return structuredClone(doc)
  }
  /** Serialised: one change at a time, each against the latest state. */
  update(id, change) {
    const next = this.queue.then(async () => {
      const current = await this.get(id)
      const doc = change(current)
      this.docs.set(id, doc)
      await this.#write(doc)
      return structuredClone(doc)
    })
    this.queue = next.catch(() => {})
    return next
  }
}

export class PgProcedureStore {
  constructor(pool) {
    this.pool = pool
  }
  async list({ app = null, caseId = null } = {}) {
    const { rows } = await this.pool.query(
      `SELECT doc FROM rig_procedures
        WHERE ($1::text IS NULL OR app = $1) AND ($2::text IS NULL OR case_id = $2)
        ORDER BY updated_at DESC LIMIT 500`,
      [app, caseId]
    )
    return rows.map((row) => row.doc)
  }
  async get(id) {
    const { rows } = await this.pool.query('SELECT doc FROM rig_procedures WHERE id = $1', [id])
    if (!rows[0]) throw new RigError('not_found', '规程不存在', 404)
    return rows[0].doc
  }
  async insert(doc) {
    await this.pool.query(
      `INSERT INTO rig_procedures (id, app, case_id, status, doc, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
      [doc.id, doc.app, doc.caseId, doc.status, JSON.stringify(doc), doc.createdAt]
    )
    return doc
  }
  /** One change under a row lock: replicas take turns on the same procedure. */
  async update(id, change) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        'SELECT doc FROM rig_procedures WHERE id = $1 FOR UPDATE',
        [id]
      )
      if (!rows[0]) throw new RigError('not_found', '规程不存在', 404)
      const doc = change(rows[0].doc)
      await client.query(
        `UPDATE rig_procedures
            SET app = $2, case_id = $3, status = $4, doc = $5::jsonb, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, doc.app, doc.caseId, doc.status, JSON.stringify(doc)]
      )
      await client.query('COMMIT')
      return doc
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}

/** The operations the API offers, on either backend. */
export class Procedures {
  constructor(store, { now = () => new Date().toISOString() } = {}) {
    this.store = store
    this.now = now
  }
  async list(filter) {
    return (await this.store.list(filter)).map(summaryOf)
  }
  get(id) {
    return this.store.get(id)
  }
  create(body, by) {
    return this.store.insert(rules.create(newId('prc'), body, by, this.now()))
  }
  revise(id, { body, expectedRevision, reason }, by) {
    return this.store.update(id, (doc) =>
      rules.revise(doc, { body, by, now: this.now(), reason, expectedRevision })
    )
  }
  setStatus(id, status, by) {
    return this.store.update(id, (doc) => rules.status(doc, { status, by, now: this.now() }))
  }
  recordRun(id, run, by) {
    const entry = { ...run, id: newId('prr'), by, recordedAt: this.now() }
    return this.store
      .update(id, (doc) => {
        if (run.revision !== doc.revision && run.station !== 'repair')
          throw new RigError(
            'procedure_conflict',
            `这次试车跑的是第 ${run.revision} 版，规程已是第 ${doc.revision} 版`,
            409
          )
        return rules.run(doc, entry)
      })
      .then((doc) => ({ doc, run: entry }))
  }
  attachKernelRun(id, runId, kernelRunId) {
    return this.store.update(id, (doc) => ({
      ...doc,
      runs: doc.runs.map((entry) => (entry.id === runId ? { ...entry, kernelRunId } : entry))
    }))
  }
  propose(id, proposal, by) {
    const entry = { ...proposal, id: newId('prp'), by, at: this.now() }
    return this.store
      .update(id, (doc) => rules.propose(doc, entry))
      .then((doc) => ({ doc, proposal: doc.proposals[0] }))
  }
  decide(id, proposalId, approved, by) {
    return this.store.update(id, (doc) =>
      rules.decide(doc, { proposalId, approved, by, now: this.now() })
    )
  }
}
