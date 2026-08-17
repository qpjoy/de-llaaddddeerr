import { AppError } from '../core/errors.mjs'
import { redactLine, redactText, sanitizeUrl } from '../core/redact.mjs'

// Normalize a runner's summary.json into the platform's run/case/step shape.
//
// Two input shapes are accepted:
//   v2 — the platform contract (contracts/runner-summary.schema.json)
//   v1 — what compass already writes today, so its 23 existing Cypress cases
//        onboard without editing the application repository at all. See
//        specs/08-compass-onboarding.md.

const CASE_STATUSES = new Set(['passed', 'failed', 'skipped', 'flaky', 'notRun'])
const STEP_STATUSES = new Set(['passed', 'failed', 'skipped'])
const RUNNER_STATUSES = new Set(['passed', 'failed', 'blocked'])
const ARTIFACT_KINDS = new Set(['video', 'screenshot', 'report', 'log', 'summary'])

const integer = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback
}

/**
 * Artifact paths must stay inside the run directory. The runner names them and
 * the runner is not trusted, so anything absolute, scheme-prefixed, or
 * containing a `..` segment is dropped rather than sanitized — a path we had to
 * repair is a path we do not understand.
 */
function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return null
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return null
  const normalized = value.replace(/\\/gu, '/')
  if (normalized.split('/').some((segment) => segment === '..')) return null
  return normalized
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return []
  const artifacts = []
  for (const entry of value.slice(0, 500)) {
    const path = safeRelativePath(entry?.path)
    if (!path || !ARTIFACT_KINDS.has(entry?.kind)) continue
    artifacts.push({ kind: entry.kind, path })
  }
  return artifacts
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 500).map((entry, index) => ({
    seq: integer(entry?.seq, index + 1),
    label: redactLine(entry?.label, 200) || `步骤 ${index + 1}`,
    status: STEP_STATUSES.has(entry?.status) ? entry.status : 'passed',
    offsetMs: entry?.offsetMs == null ? null : integer(entry.offsetMs),
    durationMs: entry?.durationMs == null ? null : integer(entry.durationMs),
  }))
}

function normalizeCase(entry) {
  const caseId = typeof entry?.caseId === 'string' ? entry.caseId.trim().slice(0, 64) : ''
  if (!caseId) return null
  return {
    caseId,
    status: CASE_STATUSES.has(entry?.status) ? entry.status : 'skipped',
    attempts: Math.max(1, integer(entry?.attempts, 1)),
    durationMs: integer(entry?.durationMs),
    specPath: redactLine(entry?.spec, 240) || null,
    title: redactLine(entry?.title, 300) || null,
    errorText: entry?.error ? redactText(entry.error, 4096) : null,
    steps: normalizeSteps(entry?.steps),
    artifacts: normalizeArtifacts(entry?.artifacts),
  }
}

/**
 * compass writes schemaVersion 1: it has `specs[].tests[]` plus a `functional`
 * block where it has *already* mapped each catalog case to a status. Reuse that
 * mapping rather than re-deriving it from test titles — it is the same
 * computation, and duplicating it would let the two drift.
 */
function casesFromV1(summary) {
  const functional = summary?.functional
  if (!Array.isArray(functional?.cases)) return []
  const durationByTitle = new Map()
  for (const spec of Array.isArray(summary.specs) ? summary.specs : []) {
    for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
      if (typeof test?.title === 'string') {
        durationByTitle.set(test.title, {
          durationMs: integer(test.durationMs),
          attempts: Math.max(1, integer(test.attempts, 1)),
          error: test.error || '',
        })
      }
    }
  }
  return functional.cases
    .map((entry) => {
      const caseId = typeof entry?.id === 'string' ? entry.id.trim().slice(0, 64) : ''
      if (!caseId) return null
      const execution = durationByTitle.get(entry.actualTitle) || {}
      return {
        caseId,
        status: CASE_STATUSES.has(entry?.status) ? entry.status : 'notRun',
        attempts: execution.attempts ?? 1,
        durationMs: execution.durationMs ?? 0,
        specPath: redactLine(entry.actualSpec || entry.spec, 240) || null,
        title: redactLine(entry.actualTitle || entry.title, 300) || null,
        errorText: execution.error ? redactText(execution.error, 4096) : null,
        steps: [],
        artifacts: [],
      }
    })
    .filter(Boolean)
}

function catalogFromV1(summary) {
  const functional = summary?.functional
  if (!functional) return {}
  return {
    catalogTotal: integer(functional.catalogTotal),
    counts: functional.counts || {},
    unmapped: Array.isArray(functional.unmapped)
      ? functional.unmapped.slice(0, 200).map((entry) => ({
          caseId: typeof entry?.id === 'string' ? entry.id.slice(0, 64) : null,
          spec: redactLine(entry?.spec, 240),
          title: redactLine(entry?.title, 300),
          reason: redactLine(entry?.reason, 60),
        }))
      : [],
    catalogIssues: Array.isArray(functional.catalogIssues) ? functional.catalogIssues.slice(0, 100) : [],
  }
}

/**
 * @param {object} summary  raw summary.json from the runner
 * @param {number} exitCode process exit code
 */
export function normalizeSummary(summary, exitCode) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new AppError(400, 'summary_schema_invalid', 'summary must be a JSON object')
  }
  const schemaVersion = integer(summary.schemaVersion, 0)
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new AppError(400, 'summary_schema_invalid', 'summary.schemaVersion must be 1 or 2')
  }

  const cases =
    schemaVersion === 2
      ? (Array.isArray(summary.cases) ? summary.cases : []).map(normalizeCase).filter(Boolean)
      : casesFromV1(summary)

  // Case ids are unique per run. A runner reporting the same id twice is the
  // "duplicate-case-execution" signal, not a reason to write two rows.
  const seen = new Set()
  const duplicates = []
  const uniqueCases = []
  for (const testCase of cases) {
    if (seen.has(testCase.caseId)) {
      duplicates.push(testCase.caseId)
      continue
    }
    seen.add(testCase.caseId)
    uniqueCases.push(testCase)
  }

  const reported = RUNNER_STATUSES.has(summary.status) ? summary.status : null
  const totals = {
    tests: integer(summary.totals?.tests, uniqueCases.length),
    passed: integer(summary.totals?.passed),
    failed: integer(summary.totals?.failed),
    skipped: integer(summary.totals?.skipped),
    flaky: integer(summary.totals?.flaky, uniqueCases.filter((c) => c.status === 'flaky').length),
    durationMs: integer(summary.totals?.durationMs),
  }

  const { status, blockedReason } = resolveStatus({ reported, exitCode, totals, summary })
  const catalog = schemaVersion === 1 ? catalogFromV1(summary) : normalizeCatalogV2(summary)

  return {
    status,
    blockedReason,
    totals,
    catalog,
    cases: uniqueCases,
    duplicates,
    artifacts: normalizeArtifacts(summary.artifacts),
    targetUrl: summary.targetUrl ? sanitizeUrl(summary.targetUrl) : null,
    startedAt: typeof summary.startedAt === 'string' ? summary.startedAt : null,
    finishedAt: typeof summary.finishedAt === 'string' ? summary.finishedAt : null,
  }
}

function normalizeCatalogV2(summary) {
  const catalog = summary.catalog
  if (!catalog || typeof catalog !== 'object') return {}
  return {
    catalogTotal: integer(catalog.catalogTotal),
    counts: catalog.counts || {},
    unmapped: Array.isArray(catalog.unmapped) ? catalog.unmapped.slice(0, 200) : [],
    catalogIssues: Array.isArray(catalog.catalogIssues) ? catalog.catalogIssues.slice(0, 100) : [],
  }
}

/**
 * The exit code is authoritative when it disagrees with `status`: a runner that
 * crashed mid-write can leave a stale or truncated `passed` in the file, and
 * trusting that is exactly how a green run that never happened gets recorded.
 *
 * Zero executed cases is always `blocked`, never `passed` — the rule compass
 * established, and the one that keeps a misconfigured target from reading as a
 * clean sheet.
 */
function resolveStatus({ reported, exitCode, totals, summary }) {
  const code = Number.isInteger(exitCode) ? exitCode : null
  const declaredReason = summary.blockedReason ? redactText(summary.blockedReason, 1000) : null

  if (code !== null && code !== 0 && code !== 1) {
    return {
      status: 'blocked',
      blockedReason: declaredReason || `runner exited with code ${code}`,
    }
  }
  if (totals.tests === 0) {
    return { status: 'blocked', blockedReason: declaredReason || 'No tests were executed' }
  }
  if (code === 1 || reported === 'failed' || totals.failed > 0) {
    return { status: 'failed', blockedReason: null }
  }
  if (reported === 'blocked') {
    return { status: 'blocked', blockedReason: declaredReason || 'Runner reported blocked' }
  }
  return { status: totals.flaky > 0 ? 'flaky' : 'passed', blockedReason: null }
}

/**
 * Compare what ran against what the catalog says should exist.
 * `notRun` is the point of this: a case that quietly stopped running is
 * invisible in a plain pass count.
 */
export function compareWithCatalog(catalogCases, runCases) {
  const byId = new Map(runCases.map((entry) => [entry.caseId, entry]))
  const merged = []
  // Catalog-only tallies. Unmapped cases are reported separately and must not
  // enter these counts, or the coverage denominators stop meaning anything.
  const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0, notRun: 0 }

  for (const catalogCase of catalogCases) {
    const executed = byId.get(catalogCase.caseId)
    const status = executed ? executed.status : 'notRun'
    counts[status] = (counts[status] || 0) + 1
    merged.push({ ...(executed || { caseId: catalogCase.caseId }), status, inCatalog: true })
    byId.delete(catalogCase.caseId)
  }

  const unmapped = []
  for (const entry of byId.values()) {
    unmapped.push({
      caseId: entry.caseId,
      spec: entry.specPath,
      title: entry.title,
      reason: 'case-id-not-in-catalog',
    })
    merged.push({ ...entry, inCatalog: false })
  }

  const catalogTotal = catalogCases.length
  const completed = counts.passed + counts.failed + counts.skipped + counts.flaky
  const asserted = counts.passed + counts.failed + counts.flaky
  const linked = catalogCases.filter((entry) => entry.requirementRef).length

  return {
    cases: merged,
    catalog: {
      catalogTotal,
      counts,
      unmapped,
      // Four numerators, three different denominators, all named. A single
      // "coverage" figure here would be read as requirement coverage, which
      // nothing in this system is able to measure. See specs/03-case-catalog.md.
      coverage: {
        catalogCompletionPercent: percent(completed, catalogTotal),
        catalogPassPercent: percent(counts.passed, catalogTotal),
        executedPassPercent: percent(counts.passed, asserted),
        requirementLinkedPercent: percent(linked, catalogTotal),
      },
    },
  }
}

function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : 0
}
