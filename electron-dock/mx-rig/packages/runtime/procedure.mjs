// 试验规程（Procedure）: a test the crew writes once and the machine replays.
//
// A procedure is data, not code: an ordered list of steps in the same
// vocabulary the browser station speaks — open, click, fill, select, check,
// press, wait, assert — with elements named the way people name them (role
// and accessible name, or a field's label). That choice is what makes the
// rest possible:
//
// - an explored path becomes a procedure without generating code;
// - a replay needs no model: every run of the same revision does the same
//   thing, so a red result means the page changed, not that the model did;
// - a repair is a change to a list a reviewer can read step by step, proven
//   by a replay before anyone is asked to approve it.
//
// Nothing here opens a browser. `ProcedurePlayer` drives the station through
// `BrowserTools.perform`, which keeps the same origin allow-list, production
// block and sensitive-field refusal as the Agent's own tools.

import { z } from 'zod'
import { RigError } from '../contracts/index.mjs'
import { ASSERTIONS, PRESS_KEYS } from './browser.mjs'
import { procedureSites, scopeSites } from './sites.mjs'

export const STEP_LIMIT = 80
export const PROCEDURE_STATUSES = Object.freeze(['draft', 'active', 'retired'])
export const RUN_VERDICTS = Object.freeze(['passed', 'failed', 'blocked'])
/** Failure codes a repair can address; everything else is the environment's. */
export const REPAIRABLE = Object.freeze(
  new Set([
    'target_missing',
    'ambiguous_target',
    'element_not_actionable',
    'wrong_element',
    'assertion_failed'
  ])
)
const BLOCKING = new Set([
  'origin_denied',
  'browser_unavailable',
  'electron_unavailable',
  'electron_app_unknown',
  'navigation_failed',
  'sensitive_field'
])

const text = (max) => z.string().max(max)
const note = text(300).optional()
const target = z.union([
  z
    .object({
      role: z.string().min(1).max(40),
      name: text(300).optional(),
      nth: z.number().int().min(0).max(50).optional()
    })
    .strict(),
  z.object({ label: z.string().min(1).max(300) }).strict()
])

// A confirm the step says yes to (「确定删除？」); without it, cancelled.
const dialog = z.literal('accept').optional()
const dialogText = text(200).optional()

export const stepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('open'), url: z.string().min(1).max(2000), note }).strict(),
  z.object({ do: z.literal('launch'), app: z.string().min(1).max(64), note }).strict(),
  z.object({ do: z.literal('click'), target, dialog, dialogText, note }).strict(),
  z.object({ do: z.literal('fill'), target, value: text(2000), note }).strict(),
  z.object({ do: z.literal('select'), target, option: z.string().min(1).max(300), note }).strict(),
  z.object({ do: z.literal('check'), target, checked: z.boolean(), note }).strict(),
  z.object({ do: z.literal('press'), key: z.enum(PRESS_KEYS), dialog, dialogText, note }).strict(),
  z
    .object({
      do: z.literal('wait'),
      text: z.string().min(1).max(400).optional(),
      target: target.optional(),
      state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
      timeoutMs: z.number().int().min(0).max(30_000).default(5_000),
      note
    })
    .strict(),
  z
    .object({
      do: z.literal('assert'),
      kind: z.enum(Object.keys(ASSERTIONS)),
      expected: text(400).optional(),
      target: target.optional(),
      timeoutMs: z.number().int().min(0).max(10_000).default(3_000),
      note
    })
    .strict()
])

const NEEDS_TARGET = new Set(['element_visible', 'element_checked', 'value_equals'])

export const procedureBody = z
  .object({
    title: z.string().min(1).max(200),
    app: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .nullable()
      .default(null),
    caseId: z
      .string()
      .regex(/^[A-Z0-9]{2,6}(-[A-Z0-9]+)+-\d{3}$/)
      .nullable()
      .default(null),
    surface: z.enum(['web', 'electron']).default('web'),
    baseUrl: z.string().url().max(2000).nullable().default(null),
    variables: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), text(500)).default({}),
    steps: z.array(stepSchema).min(1).max(STEP_LIMIT)
  })
  .strict()
  .superRefine((value, ctx) => {
    const first = value.steps[0]?.do
    if (value.surface === 'web' && first !== 'open')
      ctx.addIssue({ code: 'custom', message: '网页规程的第一步必须是 open', path: ['steps', 0] })
    if (value.surface === 'electron' && first !== 'launch')
      ctx.addIssue({
        code: 'custom',
        message: 'Electron 规程的第一步必须是 launch',
        path: ['steps', 0]
      })
    value.steps.forEach((step, index) => {
      if (step.do === 'assert' && NEEDS_TARGET.has(step.kind) && !step.target)
        ctx.addIssue({
          code: 'custom',
          message: `${step.kind} 需要 target`,
          path: ['steps', index]
        })
      if (step.do === 'assert' && !NEEDS_TARGET.has(step.kind) && !step.expected)
        ctx.addIssue({
          code: 'custom',
          message: `${step.kind} 需要 expected`,
          path: ['steps', index]
        })
      if (step.do === 'wait' && !step.text && !step.target)
        ctx.addIssue({
          code: 'custom',
          message: 'wait 需要 text 或 target',
          path: ['steps', index]
        })
      if (step.do === 'open' && !/^https?:\/\//.test(step.url) && !value.baseUrl)
        ctx.addIssue({
          code: 'custom',
          message: '相对地址需要规程的 baseUrl',
          path: ['steps', index]
        })
    })
  })

/** Validate a procedure body; the error names the first problem in words. */
export function readProcedure(input) {
  const parsed = procedureBody.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RigError(
      'invalid_procedure',
      `规程不合法：${issue.path.length ? `${issue.path.join('.')}：` : ''}${issue.message}`
    )
  }
  return parsed.data
}

/** Steps only — for a proposal, which revises the steps of an existing procedure. */
export function readSteps(input, base) {
  return readProcedure({ ...pickBody(base), steps: input }).steps
}

export function pickBody(procedure) {
  const { title, app, caseId, surface, baseUrl, variables, steps } = procedure
  return { title, app, caseId, surface, baseUrl, variables, steps }
}

const withDialog = (a) =>
  a.dialog === 'accept' ? { dialog: 'accept', ...(a.dialogText ? { dialogText: String(a.dialogText) } : {}) } : {}

const STEP_FROM_TOOL = {
  browser_open: (a) => ({ do: 'open', url: a.url }),
  electron_launch: (a) => ({ do: 'launch', app: a.app }),
  browser_click: (a) => a.target && { do: 'click', target: a.target, ...withDialog(a) },
  browser_fill: (a) => a.target && { do: 'fill', target: a.target, value: String(a.value ?? '') },
  browser_select: (a) => a.target && { do: 'select', target: a.target, option: String(a.option) },
  browser_check: (a) => a.target && { do: 'check', target: a.target, checked: Boolean(a.checked) },
  browser_press: (a) => ({ do: 'press', key: a.key, ...withDialog(a) }),
  browser_wait: (a) =>
    a.text
      ? { do: 'wait', text: a.text, state: a.state ?? 'visible' }
      : a.target && { do: 'wait', target: a.target, state: a.state ?? 'visible' }
}

/**
 * 固化: an explored mission becomes a procedure draft.
 *
 * Only what the station recorded counts — the action each tool call really
 * resolved to, and each deterministic assertion. A failed call left nothing
 * on the page and is not a step. An assertion that failed during exploration
 * is kept, marked, so the reviewer decides whether the expectation or the
 * page was wrong.
 */
export function procedureFromMission(mission, { title, app = null, caseId = null } = {}) {
  const steps = []
  const skipped = []
  for (const event of mission.events ?? []) {
    if (event.kind === 'tool_result') {
      const result = event.data?.result
      const action = event.data?.action ?? result?.action
      if (!action || result?.error) continue
      const step = STEP_FROM_TOOL[action.tool]?.(action)
      if (step) steps.push(step)
      else skipped.push(action.tool)
    } else if (event.kind === 'assertion') {
      const assertion = event.data?.assertion
      if (!assertion || assertion.station === 'native') continue
      steps.push({
        do: 'assert',
        kind: assertion.kind,
        ...(assertion.expected !== undefined ? { expected: String(assertion.expected) } : {}),
        ...(assertion.target ? { target: assertion.target } : {}),
        ...(assertion.passed ? {} : { note: '探索时未通过：请确认期望值后再启用' })
      })
    }
  }
  const surface = steps[0]?.do === 'launch' ? 'electron' : 'web'
  let baseUrl = null
  if (surface === 'web') {
    try {
      baseUrl = new URL(steps.find((step) => step.do === 'open')?.url).origin
    } catch {
      baseUrl = null
    }
  }
  const draft = {
    title: String(title || mission.goal || '探索路径')
      .replace(/\s+/g, ' ')
      .slice(0, 200),
    app,
    caseId,
    surface,
    baseUrl,
    variables: {},
    steps: steps.slice(0, STEP_LIMIT)
  }
  const warnings = [
    ...(mission.truncated
      ? ['这份任务记录是同步来的副本，较早的步骤可能缺失；请在执行它的桌面端固化。']
      : []),
    ...(skipped.length
      ? [`${skipped.length} 个动作不能写成规程步骤（${[...new Set(skipped)].join('、')}）。`]
      : []),
    ...(steps.length > STEP_LIMIT ? [`步骤超过 ${STEP_LIMIT} 个，后面的已省略。`] : []),
    ...(steps.some((step) => step.note?.startsWith('探索时未通过'))
      ? ['有断言在探索时未通过，已标注。']
      : []),
    // A person typed a password or a code in between: the procedure cannot.
    ...((mission.events ?? []).some((event) => event.kind === 'takeover' && event.data?.manual)
      ? ['这项任务里有人工操作（例如输入密码、验证码），规程不包含这些步骤；重放前要准备好登录状态，或让规程从登录之后的页面开始。']
      : [])
  ]
  if (!steps.length)
    throw new RigError('nothing_to_capture', '这项任务没有可以固化的浏览器动作或断言', 409)
  return { procedure: readProcedure(draft), warnings }
}

/** Replace {{name}} with the procedure's variables; unknown names are an error. */
export function bindStep(step, variables = {}, baseUrl = null) {
  const fill = (value) =>
    String(value).replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (match, name) => {
      if (!Object.hasOwn(variables, name))
        throw new RigError('invalid_procedure', `规程变量 ${name} 没有定义`)
      return variables[name]
    })
  const bound = { ...step }
  for (const key of ['url', 'value', 'option', 'expected', 'text'])
    if (typeof bound[key] === 'string') bound[key] = fill(bound[key])
  if (bound.do === 'open' && baseUrl) bound.url = new URL(bound.url, baseUrl).toString()
  return bound
}

/** How a step reads in a table, a report and a replay log. */
export function describeStep(step) {
  const where = !step.target
    ? ''
    : step.target.label !== undefined
      ? `「${step.target.label}」输入框`
      : `${step.target.role}${step.target.name ? `「${step.target.name}」` : ''}${
          step.target.nth !== undefined ? `（第 ${step.target.nth + 1} 个）` : ''
        }`
  switch (step.do) {
    case 'open':
      return `打开 ${step.url}`
    case 'launch':
      return `启动应用 ${step.app}`
    case 'click':
      return `点击 ${where}${step.dialog === 'accept' ? '，弹出确认框时点确定' : ''}`
    case 'fill':
      return `在 ${where} 填写「${step.value}」`
    case 'select':
      return `在 ${where} 选择「${step.option}」`
    case 'check':
      return `${step.checked ? '勾选' : '取消勾选'} ${where}`
    case 'press':
      return `按键 ${step.key}${step.dialog === 'accept' ? '，弹出确认框时点确定' : ''}`
    case 'wait':
      return `等待 ${step.text ? `文字「${step.text}」` : where} ${step.state}`
    case 'assert':
      return `断言：${ASSERTIONS[step.kind]}${where ? ` ${where}` : ''}${
        step.expected !== undefined ? ` = 「${step.expected}」` : ''
      }`
    default:
      return step.do
  }
}

const key = (step) => JSON.stringify({ ...step, note: undefined })

/**
 * Step-level difference between two revisions, as a reviewer reads it:
 * kept, removed, added — by longest common subsequence, so one changed
 * locator shows as one step out and one in, not a rewrite of the rest.
 */
export function diffSteps(before, after) {
  const a = before.map(key)
  const b = after.map(key)
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const out = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: 'keep', before: i, after: j, step: after[j] })
      i += 1
      j += 1
    } else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])) {
      // The old step first, then its replacement: how a reviewer reads a change.
      out.push({ op: 'remove', before: i, step: before[i] })
      i += 1
    } else {
      out.push({ op: 'add', after: j, step: after[j] })
      j += 1
    }
  }
  return {
    entries: out,
    added: out.filter((entry) => entry.op === 'add').length,
    removed: out.filter((entry) => entry.op === 'remove').length
  }
}

/**
 * Plays a procedure on a station, step by step, with no model involved.
 *
 * The verdict follows the platform's semantics: a step that cannot be done
 * because the page is not as written, or an assertion that does not hold,
 * is `failed`; an environment that cannot be reached (origin not allowed,
 * browser or app missing, navigation error) is `blocked` — neither a pass
 * nor a product failure. After the first failure the rest is `skipped`.
 */
export class ProcedurePlayer {
  constructor(browser, { now = () => new Date() } = {}) {
    this.browser = browser
    this.now = now
  }

  /**
   * @param {object} procedure a stored procedure (id, revision, body fields)
   * @param {object} options
   * @param {object} options.policy       the execution policy (origins, production hosts)
   * @param {string} options.runId        evidence directory name for this replay
   * @param {number} [options.stopBefore] replay only the steps before this index
   *   and leave the page there: how a repair starts at the failure point
   * @param {AbortSignal} [options.signal]
   */
  async run(procedure, { policy: given, runId, stopBefore = null, signal, onStep } = {}) {
    // A saved procedure was read by the person who saved it: the sites it
    // goes to come with it, as a mission's confirmed sites do.
    const policy = scopeSites(given, procedureSites(procedure))
    const started = this.now()
    const steps = []
    let failure = null
    const limit =
      stopBefore === null ? procedure.steps.length : Math.min(stopBefore, procedure.steps.length)
    for (let index = 0; index < procedure.steps.length; index += 1) {
      const step = procedure.steps[index]
      const entry = { index, do: step.do, text: describeStep(step), note: step.note ?? null }
      if (failure || index >= limit) {
        steps.push({ ...entry, status: 'skipped', durationMs: 0 })
        continue
      }
      const at = Date.now()
      try {
        signal?.throwIfAborted()
        const bound = bindStep(step, procedure.variables, procedure.baseUrl)
        const outcome = await this.browser.perform(bound, { policy, signal, runId })
        if (outcome.assertion && !outcome.assertion.passed) {
          failure = await this.#failure(
            index,
            {
              code: 'assertion_failed',
              message: `断言未通过：${outcome.assertion.description}（期望 ${
                outcome.assertion.expected ?? '成立'
              }，实际 ${JSON.stringify(outcome.assertion.actual)}）`
            },
            runId
          )
          steps.push({
            ...entry,
            status: 'failed',
            durationMs: Date.now() - at,
            assertion: outcome.assertion
          })
        } else {
          steps.push({
            ...entry,
            status: 'passed',
            durationMs: Date.now() - at,
            ...(outcome.assertion ? { assertion: outcome.assertion } : {}),
            ...(outcome.wait ? { wait: outcome.wait } : {})
          })
        }
      } catch (error) {
        if (signal?.aborted) throw error
        const code = error instanceof RigError ? error.code : 'step_failed'
        failure = await this.#failure(index, { code, message: error.message }, runId)
        steps.push({
          ...entry,
          status: 'failed',
          durationMs: Date.now() - at,
          error: { code, message: error.message }
        })
      }
      onStep?.(steps.at(-1))
    }
    const finished = this.now()
    const verdict = !failure
      ? stopBefore === null
        ? 'passed'
        : 'partial'
      : BLOCKING.has(failure.code)
        ? 'blocked'
        : 'failed'
    return {
      procedureId: procedure.id ?? null,
      revision: procedure.revision ?? null,
      runId,
      verdict,
      repairable: Boolean(failure && REPAIRABLE.has(failure.code)),
      failedStep: failure?.index ?? null,
      failure,
      steps,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime()
    }
  }

  async #failure(index, { code, message }, runId) {
    // What the page looked like when the step could not be done: the evidence
    // a person reads, and where a repair starts.
    const scene = await this.browser.scene?.(runId).catch(() => null)
    return { index, code, message, ...(scene ?? {}) }
  }
}

/**
 * A replay as the test kernel records any run: one case (the procedure's
 * catalog entry) whose steps are the procedure's steps. That is what puts
 * procedures in the quality report, the case history and flaky detection
 * without a second reporting system.
 */
export function kernelSummary(procedure, result) {
  const status =
    result.verdict === 'passed' ? 'passed' : result.verdict === 'blocked' ? 'skipped' : 'failed'
  return {
    schemaVersion: 2,
    status:
      result.verdict === 'blocked' ? 'blocked' : result.verdict === 'passed' ? 'passed' : 'failed',
    ...(result.verdict === 'blocked'
      ? { blockedReason: result.failure?.message ?? '环境不可用' }
      : {}),
    totals: {
      tests: 1,
      passed: status === 'passed' ? 1 : 0,
      failed: status === 'failed' ? 1 : 0,
      skipped: status === 'skipped' ? 1 : 0,
      durationMs: result.durationMs
    },
    cases: [
      {
        caseId: procedure.caseId,
        title: procedure.title,
        status,
        durationMs: result.durationMs,
        spec: `rig-procedure:${procedure.id}@${procedure.revision}`,
        ...(result.failure
          ? { error: `第 ${result.failure.index + 1} 步：${result.failure.message}` }
          : {}),
        steps: result.steps.map((step) => ({
          title: `${step.index + 1}. ${step.text}`,
          status: step.status,
          durationMs: step.durationMs,
          ...(step.error ? { error: step.error.message } : {})
        }))
      }
    ],
    ...(procedure.baseUrl ? { targetUrl: procedure.baseUrl } : {}),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt
  }
}

/**
 * A batch a station replayed, as the runner summary the kernel ingests: one
 * case per procedure. Blocked replays are skipped cases — the environment's,
 * not the product's — and the run is blocked only when nothing could run.
 */
export function batchSummary(entries, { startedAt, finishedAt } = {}) {
  const cases = entries.map(({ procedure, result }) => {
    const single = kernelSummary(procedure, result).cases[0]
    return single
  })
  const count = (status) => cases.filter((entry) => entry.status === status).length
  const failed = count('failed')
  const passed = count('passed')
  const skipped = count('skipped')
  const status = failed ? 'failed' : passed ? 'passed' : 'blocked'
  return {
    schemaVersion: 2,
    status,
    ...(status === 'blocked'
      ? {
          blockedReason: entries.length
            ? entries.map(({ procedure, result }) => `「${procedure.title}」：${result.failure?.message ?? '受阻'}`).join('；').slice(0, 280)
            : '这个应用没有可以回归的规程（需要已启用、关联了用例的网页规程）'
        }
      : {}),
    totals: {
      tests: cases.length,
      passed,
      failed,
      skipped,
      durationMs: entries.reduce((sum, { result }) => sum + (result.durationMs ?? 0), 0)
    },
    cases,
    startedAt: startedAt ?? entries[0]?.result.startedAt ?? new Date().toISOString(),
    finishedAt: finishedAt ?? entries.at(-1)?.result.finishedAt ?? new Date().toISOString()
  }
}
