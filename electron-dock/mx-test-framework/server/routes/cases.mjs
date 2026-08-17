import { AppError } from '../core/errors.mjs'
import { enumValue, optionalString, requiredString, stringArray } from '../core/http.mjs'
import { redactLine } from '../core/redact.mjs'

// Case authoring.
//
// A tester writes *what* should be tested; an engineer writes the code that
// tests it. The platform already tells those apart without a new state machine:
// a case whose id no spec claims simply reports `notRun`. So a case authored
// here is a real catalog entry from the moment it is saved — it shows up in
// every report as "defined, not yet implemented" until code claims the id.

export const CASE_ID_PATTERN = /^[A-Z0-9]{2,6}(-[A-Z0-9]+)+-\d{3}$/u
export const PRIORITIES = ['P0', 'P1', 'P2', 'unprioritized']
export const TRACKS = ['functional', 'demo']

/** Cases written in the UI carry this instead of a repository file name. */
export const PLATFORM_CATALOG = '__platform__'

function parseSteps(value) {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, 60)
    .map((entry) => ({
      action: redactLine(entry?.action, 300),
      expect: redactLine(entry?.expect, 300),
    }))
    .filter((entry) => entry.action || entry.expect)
}

export function parseCaseInput(body, { existing = null } = {}) {
  const caseId = requiredString(body, 'caseId', { maxLength: 64 }).toUpperCase()
  if (!CASE_ID_PATTERN.test(caseId)) {
    throw new AppError(400, 'invalid_case_id', `用例编号 "${caseId}" 不符合规范`, {
      hint: '格式是 <应用>-<端>-<业务域>-<三位序号>，例如 CPS-EL-BOOT-001。',
    })
  }
  return {
    caseId,
    title: requiredString(body, 'title', { maxLength: 300 }),
    priority: enumValue(body, 'priority', PRIORITIES, existing?.priority ?? 'P1'),
    tags: stringArray(body.tags, { maxItems: 20, maxLength: 60 }),
    tracks: (Array.isArray(body.tracks) ? body.tracks : existing?.tracks ?? ['functional']).filter(
      (track) => TRACKS.includes(track),
    ),
    steps: parseSteps(body.steps),
    preconditions: optionalString(body, 'preconditions', { maxLength: 2000 }),
    notes: optionalString(body, 'notes', { maxLength: 2000 }),
    requirementRef: optionalString(body, 'requirementRef', { maxLength: 96 }),
    suiteSlug: optionalString(body, 'suite', { maxLength: 96 }),
  }
}

/**
 * Render platform-authored cases as a catalog file for the repository.
 *
 * This is the handoff: a tester writes cases here, an engineer downloads this
 * file, commits it, and implements the specs. Git stays the source of truth for
 * code (ADR-0003) while the people who know what to test are not required to
 * open a pull request to say so.
 */
export function exportCatalog(app, cases) {
  return {
    schemaVersion: 2,
    application: app.slug,
    catalogFile: `testing/catalog/${app.slug}.json`,
    _comment:
      '由 MX 测试平台导出。提交到仓库后，用 catalog:sync 回传，之后这些用例的真相就在 git 里。',
    cases: cases
      .filter((entry) => !entry.retiredAt)
      .map((entry) => ({
        id: entry.caseId,
        priority: entry.priority,
        title: entry.title,
        ...(entry.tags?.length ? { tags: entry.tags } : {}),
        ...(entry.tracks?.length ? { tracks: entry.tracks } : {}),
        ...(entry.requirementRef ? { requirementRef: entry.requirementRef } : {}),
        ...(entry.specPath ? { spec: entry.specPath } : {}),
        ...(entry.steps?.length
          ? { _steps: entry.steps.map((step) => `${step.action} → ${step.expect}`) }
          : {}),
      })),
  }
}

/**
 * Attach implementation status to catalog entries.
 *
 * `implemented` is derived from whether any run has ever executed the case, not
 * from a flag someone has to remember to set — a case is implemented exactly
 * when code claims its id.
 */
export function decorateCases(cases, recentByCaseId) {
  return cases.map((entry) => {
    const recent = recentByCaseId.get(entry.caseId)
    // A `notRun` row is the platform recording that this case was *expected*
    // and did not run — it is the absence of an implementation, not evidence of
    // one. Only an execution that actually happened proves code claims the id.
    const everExecuted = Boolean(recent) && recent.status !== 'notRun'
    return {
      ...entry,
      implemented: Boolean(entry.specPath) || everExecuted,
      lastStatus: recent?.status ?? 'notRun',
      lastRunId: recent?.runId ?? null,
      lastRunAt: recent?.finishedAt ?? null,
    }
  })
}
