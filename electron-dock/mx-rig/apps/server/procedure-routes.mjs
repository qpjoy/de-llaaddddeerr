// /api/rig/v1/procedures — the API over 试验规程.
//
// Reading is open to every member; writing needs an operator. Replays are
// executed on desktop stations and reported here; the service never drives a
// browser itself. A replay of a procedure tied to a catalog case is also
// recorded as a run of that app, through the kernel's own route, so it lands
// in the same reports as any other run.

import { z } from 'zod'
import { RigError } from '../../packages/contracts/index.mjs'
import { requireRole } from '../../packages/test-platform/server/identity/index.mjs'
import {
  describeStep,
  kernelSummary,
  procedureFromMission
} from '../../packages/runtime/procedure.mjs'
import { parseBody } from './schemas.mjs'

const ID = 'prc_[a-f0-9]{18}'
const LIST = /^\/api\/rig\/v1\/procedures$/
const ONE = new RegExp(`^/api/rig/v1/procedures/(${ID})$`)
const STATUS = new RegExp(`^/api/rig/v1/procedures/(${ID}):status$`)
const REVISE = new RegExp(`^/api/rig/v1/procedures/(${ID}):revise$`)
const RUNS = new RegExp(`^/api/rig/v1/procedures/(${ID})/runs$`)
const PROPOSALS = new RegExp(`^/api/rig/v1/procedures/(${ID})/proposals$`)
const DECIDE = new RegExp(`^/api/rig/v1/procedures/(${ID})/proposals/(prp_[a-f0-9]{18}):decide$`)

const shortText = (max) => z.string().max(max)
const stepResult = z
  .object({
    index: z.number().int().min(0).max(200),
    do: shortText(20),
    text: shortText(600),
    note: shortText(300).nullable().optional(),
    status: z.enum(['passed', 'failed', 'skipped']),
    durationMs: z.number().int().min(0),
    error: z.object({ code: shortText(60), message: shortText(600) }).optional(),
    assertion: z.record(z.string(), z.unknown()).optional(),
    wait: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
export const replay = z
  .object({
    procedureId: z.string().max(40).nullable().optional(),
    runId: z.string().max(80).optional(),
    revision: z.number().int().min(1),
    verdict: z.enum(['passed', 'failed', 'blocked']),
    repairable: z.boolean().default(false),
    failedStep: z.number().int().min(0).nullable(),
    failure: z
      .object({
        index: z.number().int().min(0),
        code: shortText(60),
        message: shortText(600),
        url: shortText(2000).optional(),
        title: shortText(300).optional(),
        screenshot: shortText(300).optional(),
        snapshot: shortText(20_000).optional()
      })
      .strict()
      .nullable(),
    steps: z.array(stepResult).max(200),
    // Stored with the procedure and passed to the test kernel as the run's
    // times: a value that is not an instant would fail there.
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().int().min(0),
    station: z.enum(['desktop', 'station', 'test']).default('desktop')
  })
  .strict()

const createBody = z.object({ procedure: z.unknown() }).strict()
const reviseBody = z
  .object({
    expectedRevision: z.number().int().min(1),
    procedure: z.unknown(),
    reason: shortText(300).optional()
  })
  .strict()
const statusBody = z.object({ status: z.enum(['draft', 'active', 'retired']) }).strict()
const runBody = z.object({ run: replay }).strict()
const proposalBody = z
  .object({
    proposal: z
      .object({
        baseRevision: z.number().int().min(1),
        verdict: z.enum(['case-issue', 'product-defect', 'environment-blocked', 'inconclusive']),
        rationale: z.string().min(1).max(1000),
        steps: z.array(z.unknown()).max(80).nullable(),
        missionId: z.string().uuid().nullable().default(null),
        validation: replay.omit({ station: true }).nullable().default(null)
      })
      .strict()
  })
  .strict()
const decideBody = z.object({ approved: z.boolean() }).strict()
const captureBody = z
  .object({
    missionId: z.string().uuid(),
    title: shortText(200).optional(),
    app: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .nullable()
      .optional(),
    caseId: z.string().max(64).nullable().optional()
  })
  .strict()

/** A procedure as the workbench shows it: every step also in words. */
function present(doc) {
  return {
    ...doc,
    stepText: doc.steps.map(describeStep),
    proposals: doc.proposals.map((entry) =>
      entry.diff
        ? {
            ...entry,
            diff: {
              ...entry.diff,
              entries: entry.diff.entries.map((line) => ({
                ...line,
                text: describeStep(line.step)
              }))
            }
          }
        : entry
    )
  }
}

/**
 * A procedure proven on the current revision implements its catalog case.
 * Only cases written in the platform are updated this way; a case that lives
 * in a repository's catalog file is that repository's to change.
 */
async function markImplemented({ kernel, principal, doc }) {
  if (!doc.app || !doc.caseId) return false
  try {
    const { cases } = await kernel.app.invoke({
      method: 'GET',
      path: `/api/v1/apps/${doc.app}/cases`,
      principal,
      source: 'rig-procedure'
    })
    const entry = cases.find((item) => item.caseId === doc.caseId)
    if (!entry || entry.origin !== 'platform') return false
    await kernel.app.invoke({
      method: 'PUT',
      path: `/api/v1/apps/${doc.app}/cases/${doc.caseId}`,
      body: {
        title: entry.title,
        priority: entry.priority,
        tags: entry.tags,
        tracks: entry.tracks,
        steps: entry.steps,
        preconditions: entry.preconditions,
        notes: entry.notes,
        requirementRef: entry.requirementRef,
        suite: entry.suiteSlug,
        prerequisites: entry.prerequisites,
        coverageMode: doc.surface === 'electron' ? 'automated-renderer' : 'automated-browser',
        automationState: 'implemented'
      },
      principal,
      source: 'rig-procedure'
    })
    return true
  } catch {
    return false
  }
}

const importBody = z
  .object({
    cases: z
      .array(
        z
          .object({
            app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
            caseId: z.string().max(64),
            title: z.string().min(1).max(300),
            priority: z.enum(['P0', 'P1', 'P2']),
            steps: z
              .array(z.object({ action: z.string().max(300), expect: z.string().max(300) }))
              .max(30),
            preconditions: z.string().max(1000).optional(),
            requirementRef: z.string().max(96).optional(),
            tags: z.array(z.string().max(60)).max(20).default([])
          })
          .strip()
      )
      .min(1)
      .max(30)
  })
  .strict()

/**
 * Case drafts a person chose to keep, written into the catalog through the
 * kernel's own route — same validation, same 409 on a taken id, same audit.
 * Each case stands alone: one taken id does not stop the others.
 */
async function importCases({ req, res, principal, kernel, readJson, sendJson }) {
  requireRole(principal, 'operator')
  if (req.method !== 'POST') throw new RigError('not_found', '接口不存在', 404)
  const body = parseBody(importBody, await readJson(req, 200_000))
  const results = []
  for (const draft of body.cases) {
    try {
      const created = await kernel.app.invoke({
        method: 'POST',
        path: `/api/v1/apps/${draft.app}/cases`,
        body: {
          caseId: draft.caseId,
          title: draft.title,
          priority: draft.priority,
          tags: draft.tags,
          steps: draft.steps,
          preconditions: draft.preconditions,
          requirementRef: draft.requirementRef,
          coverageMode: 'planned',
          automationState: 'planned'
        },
        principal,
        source: 'rig-authoring'
      })
      results.push({ caseId: draft.caseId, ok: true, case: created.case })
    } catch (error) {
      results.push({ caseId: draft.caseId, ok: false, error: error.message })
    }
  }
  sendJson(res, 200, { results })
  return true
}

export async function procedureRoutes(context) {
  const { req, res, path, url, principal, procedures, kernel, missions, readJson, sendJson } =
    context
  if (path === '/api/rig/v1/cases:import') return importCases(context)
  if (!path.startsWith('/api/rig/v1/procedures')) return false
  const who = principal.id
  let match

  if (LIST.test(path) && req.method === 'GET') {
    sendJson(res, 200, {
      procedures: await procedures.list({
        app: url.searchParams.get('app') || null,
        caseId: url.searchParams.get('caseId') || null
      })
    })
    return true
  }
  if ((match = ONE.exec(path)) && req.method === 'GET') {
    sendJson(res, 200, { procedure: present(await procedures.get(match[1])) })
    return true
  }

  requireRole(principal, 'operator')
  if (LIST.test(path) && req.method === 'POST') {
    const body = parseBody(createBody, await readJson(req, 200_000))
    sendJson(res, 201, { procedure: present(await procedures.create(body.procedure, who)) })
    return true
  }
  if (path === '/api/rig/v1/procedures:capture' && req.method === 'POST') {
    // A mission this member ran on the service, captured as a draft. A
    // desktop captures from its own full record instead and posts the result.
    const body = parseBody(captureBody, await readJson(req, 4_000))
    const row = missions.public(await missions.get(body.missionId, who))
    const { procedure, warnings } = procedureFromMission(row, body)
    sendJson(res, 201, { procedure: present(await procedures.create(procedure, who)), warnings })
    return true
  }
  if ((match = REVISE.exec(path)) && req.method === 'POST') {
    const body = parseBody(reviseBody, await readJson(req, 200_000))
    sendJson(res, 200, {
      procedure: present(
        await procedures.revise(
          match[1],
          { body: body.procedure, expectedRevision: body.expectedRevision, reason: body.reason },
          who
        )
      )
    })
    return true
  }
  if ((match = STATUS.exec(path)) && req.method === 'POST') {
    const body = parseBody(statusBody, await readJson(req, 2_000))
    const doc = await procedures.setStatus(match[1], body.status, who)
    const caseUpdated =
      body.status === 'active' ? await markImplemented({ kernel, principal, doc }) : false
    sendJson(res, 200, { procedure: present(doc), caseUpdated })
    return true
  }
  if ((match = RUNS.exec(path)) && req.method === 'POST') {
    const body = parseBody(runBody, await readJson(req, 400_000))
    const { doc, run } = await procedures.recordRun(match[1], body.run, who)
    let kernelRun = null
    let kernelError = null
    if (doc.app && doc.caseId) {
      try {
        const recorded = await kernel.app.invoke({
          method: 'POST',
          path: `/api/v1/apps/${doc.app}/results:record`,
          body: { surface: doc.surface, summary: kernelSummary(doc, run) },
          principal,
          source: 'rig-procedure'
        })
        kernelRun = recorded.run
        await procedures.attachKernelRun(doc.id, run.id, kernelRun.id)
      } catch (error) {
        // The replay is recorded either way; the report entry is what failed.
        kernelError = error.message
      }
    }
    sendJson(res, 201, {
      run: { ...run, ...(kernelRun ? { kernelRunId: kernelRun.id } : {}) },
      kernelRun: kernelRun ? { id: kernelRun.id, status: kernelRun.status } : null,
      ...(kernelError ? { kernelError } : {})
    })
    return true
  }
  if ((match = PROPOSALS.exec(path)) && req.method === 'POST') {
    const body = parseBody(proposalBody, await readJson(req, 400_000))
    const { proposal } = await procedures.propose(match[1], body.proposal, who)
    sendJson(res, 201, { proposal })
    return true
  }
  if ((match = DECIDE.exec(path)) && req.method === 'POST') {
    const body = parseBody(decideBody, await readJson(req, 1_000))
    sendJson(res, 200, {
      procedure: present(await procedures.decide(match[1], match[2], body.approved, who))
    })
    return true
  }
  throw new RigError('not_found', '接口不存在', 404)
}
