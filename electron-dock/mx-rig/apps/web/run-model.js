// What the run detail knows about one run, apart from drawing it (docs/21 M4).
// No DOM here, so the tests can load it in Node.

export const ACTIVE_RUN = ['queued', 'pending-runner', 'running']

export const RUN_TEXT = {
  queued: '排队',
  'pending-runner': '等待执行机',
  running: '执行中',
  passed: '通过',
  failed: '失败',
  flaky: '不稳定',
  blocked: '受阻',
  expired: '已过期',
  timeout: '超时',
  cancelled: '已取消'
}

export const CASE_TEXT = {
  passed: '通过',
  failed: '失败',
  flaky: '不稳定',
  skipped: '跳过',
  notRun: '未执行',
  running: '执行中'
}

/** The pipeline, in order. Mirrors RUN_STAGES in the kernel's events/run-events.mjs. */
export const STAGES = [
  ['claim', '认领'],
  ['checkout', '检出'],
  ['install', '装依赖'],
  ['launch', '启动'],
  ['execute', '执行'],
  ['upload', '收产物'],
  ['archive', '归档']
]

const LOG_LINES = 300

export function liveModel() {
  return {
    stages: new Map(),
    cases: new Map(),
    order: [],
    logs: [],
    counts: { passed: 0, failed: 0 },
    runner: null,
    finished: null,
    lastSeq: 0
  }
}

function liveCase(model, caseId) {
  const key = caseId || '(未命名)'
  let entry = model.cases.get(key)
  if (!entry) {
    entry = { caseId: key, title: '', status: 'running', steps: [], durationMs: null }
    model.cases.set(key, entry)
    model.order.push(key)
  }
  return entry
}

/** Fold one timeline event into the model. Events at or before the cursor are ignored, so a page read twice counts once. */
export function applyEvent(model, event) {
  if (!event || !(event.seq > model.lastSeq)) return model
  model.lastSeq = event.seq
  const payload = event.payload ?? {}
  if (event.kind === 'run.claimed') {
    model.runner = payload.runner || null
  } else if (event.kind === 'stage') {
    const index = STAGES.findIndex(([key]) => key === payload.stage)
    if (index !== -1) {
      // A stage that never reported and has been overtaken did not happen: a
      // web suite installs nothing, and 「装依赖」 waiting forever reads as stuck.
      for (const [key] of STAGES.slice(0, index))
        if (!model.stages.has(key)) model.stages.set(key, { status: 'skipped', detail: '' })
      const status = payload.status === 'ok' ? 'done' : payload.status === 'failed' ? 'failed' : 'active'
      model.stages.set(payload.stage, { status, detail: payload.detail || '' })
    }
  } else if (event.kind === 'case.started') {
    const entry = liveCase(model, payload.caseId)
    entry.title = payload.title || entry.title
    entry.status = 'running'
  } else if (event.kind === 'case.finished') {
    const entry = liveCase(model, payload.caseId)
    entry.status = payload.status
    entry.durationMs = payload.durationMs ?? null
    if (payload.status === 'passed' || payload.status === 'flaky') model.counts.passed += 1
    if (payload.status === 'failed') model.counts.failed += 1
  } else if (event.kind === 'step') {
    liveCase(model, payload.caseId).steps.push({
      seq: payload.seq,
      label: payload.label,
      status: payload.status,
      offsetMs: payload.offsetMs ?? null
    })
  } else if (event.kind === 'log') {
    model.logs.push(payload.line ?? '')
    if (model.logs.length > LOG_LINES) model.logs.shift()
  } else if (event.kind === 'run.finished') {
    // The run is over, so nothing is still in progress: a stage left open
    // finished — or, in a blocked run, is where it got stuck — and one that
    // never reported did not happen.
    const stuck = payload.status === 'blocked'
    for (const [key] of STAGES.slice(0, -1)) {
      const entry = model.stages.get(key)
      if (!entry) model.stages.set(key, { status: 'skipped', detail: '' })
      else if (entry.status === 'active') entry.status = stuck ? 'failed' : 'done'
    }
    model.stages.set('archive', { status: 'done', detail: '' })
    model.finished = payload.status || 'finished'
  }
  return model
}

/** The stage the run broke at, as [label, detail], or null. */
export function brokenStage(model) {
  for (const [key, label] of STAGES) {
    const entry = model.stages.get(key)
    if (entry?.status === 'failed') return [label, entry.detail]
  }
  return null
}

/**
 * The recording that belongs to a case — the kernel report's rule, so the two
 * never disagree. Cypress names a video after its spec file, so several cases
 * of one spec share it. A run's only video is never assumed to be every case's:
 * unrelated footage beside a case would be false evidence.
 */
export function recordingFor(testCase, artifacts) {
  const videos = artifacts.filter((entry) => /\.(mp4|webm)$/iu.test(entry.path))
  if (videos.length === 0) return null
  const declared = new Set(
    (Array.isArray(testCase.artifacts) ? testCase.artifacts : [])
      .filter((entry) => entry?.kind === 'video' && typeof entry.path === 'string')
      .map((entry) => entry.path)
  )
  const byDeclaration = videos.find((entry) => declared.has(entry.path))
  if (byDeclaration) return byDeclaration
  const byCase = videos.find((entry) => entry.path.includes(testCase.caseId))
  if (byCase) return byCase
  if (testCase.specPath) {
    const specName = testCase.specPath.split('\\').join('/').split('/').pop()
    const bySpec = videos.find((entry) => entry.path.includes(specName))
    if (bySpec) return bySpec
  }
  return null
}

/** The screenshots a case declared that the run actually holds. */
export function screenshotsFor(testCase, artifacts) {
  const held = new Set(artifacts.map((entry) => entry.path))
  return (Array.isArray(testCase.artifacts) ? testCase.artifacts : [])
    .filter((entry) => entry?.kind === 'screenshot' && held.has(entry.path) && /\.(png|jpe?g)$/iu.test(entry.path))
    .slice(0, 4)
}

/**
 * Where the page loads a file of the run from. The browser workbench asks the
 * service with its cookie; the desktop's page has no credential and asks its
 * main process (apps/desktop/run-media.mjs) through `rig-media:`.
 */
export function artifactSrc(runId, path, native) {
  return native
    ? `rig-media://run/${runId}/${encodeURI(path)}`
    : `/api/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURI(path)}`
}

export function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${Math.round(seconds % 60)} 秒`
}

/**
 * A point in a recording: mm:ss like the report, with tenths — steps a few
 * hundred milliseconds apart would otherwise all read 00:00.
 */
export function clock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--'
  const tenths = Math.floor(ms / 100)
  const seconds = Math.floor(tenths / 10)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${tenths % 10}`
}

/** A plan's case filter, short enough for a chip: a few names, or how many. */
export function filterLabel(filter) {
  const entries = String(filter ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries.length <= 2 ? `只跑 ${entries.join('、')}` : `只跑 ${entries.length} 条`
}
