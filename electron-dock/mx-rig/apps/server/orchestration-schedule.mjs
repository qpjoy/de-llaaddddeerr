import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { nextCronTime, parseCron } from '../../packages/test-platform/server/core/cron.mjs'
import { RigError } from '../../packages/contracts/index.mjs'

/**
 * Which orchestrations may run unattended, and when.
 *
 * The hard rule is that a scheduled run must be able to finish on its own. An
 * orchestration that stops for a person would sit in `awaiting_approval` until
 * someone happened to look, and a nightly schedule would quietly pile up
 * half-finished missions. So a schedule is only accepted on an orchestration
 * that has no checkpoint and calls no write tool — in practice, the ones that
 * read evidence and report.
 */
export function blockingSteps(spec, writeTools) {
  const reasons = []
  for (const node of spec.nodes) {
    if (node.type === 'approval') reasons.push(`人工检查点「${node.title}」`)
    if (node.type === 'tool' && writeTools.includes(node.tool))
      reasons.push(`写工具 ${node.tool}（节点「${node.title}」）`)
    if (node.type === 'subflow')
      reasons.push(`子编排 ${node.orchestrationKey}（请给子编排本身排期）`)
  }
  return reasons
}

export function readSchedule(input, spec, { writeTools = [], now = new Date() } = {}) {
  if (input == null) return null
  if (typeof input !== 'object' || Array.isArray(input))
    throw new RigError('invalid_schedule', '定时配置必须是对象')
  const { cronExpr, timezone = 'Asia/Shanghai', enabled = true, ...rest } = input
  if (Object.keys(rest).length)
    throw new RigError('invalid_schedule', `定时配置有多余字段：${Object.keys(rest).join('、')}`)
  if (typeof cronExpr !== 'string' || !cronExpr.trim())
    throw new RigError('invalid_schedule', '请填写 cron 表达式')
  if (typeof timezone !== 'string' || timezone.length > 64)
    throw new RigError('invalid_schedule', '时区无效')
  let parsed
  try {
    parsed = parseCron(cronExpr)
    if (!nextCronTime(parsed, now, timezone))
      throw new RigError(
        'invalid_schedule',
        `cron 表达式 "${cronExpr}" 在 ${timezone} 永远不会触发`
      )
  } catch (error) {
    if (error instanceof RigError) throw error
    throw new RigError('invalid_schedule', `cron 表达式无效：${cronExpr}`)
  }
  const blocked = blockingSteps(spec, writeTools)
  if (blocked.length)
    throw new RigError(
      'invalid_schedule',
      `这条编排需要有人参与，不能定时执行：${blocked.join('、')}。定时执行只支持能自己跑完的只读编排。`
    )
  if (spec.inputs.some((entry) => entry.required))
    throw new RigError(
      'invalid_schedule',
      `定时执行时没有人填写输入，请把必填输入（${spec.inputs
        .filter((entry) => entry.required)
        .map((entry) => entry.name)
        .join('、')}）改为非必填或去掉`
    )
  return { cronExpr: cronExpr.trim(), timezone, enabled: enabled !== false }
}

export function nextFireAt(schedule, after = new Date()) {
  if (!schedule?.enabled) return null
  const next = nextCronTime(schedule.cronExpr, after, schedule.timezone)
  return next ? next.toISOString() : null
}

/**
 * Orchestrations whose next fire time has passed.
 *
 * `lastFiredAt` is advanced by the caller in the same pass that starts the
 * mission, so a slow tick overlapping the next one cannot double-fire.
 */
export function dueOrchestrations(orchestrations, state, now = new Date()) {
  const due = []
  for (const spec of orchestrations) {
    if (!spec.enabled || !spec.schedule?.enabled) continue
    const last = state[spec.key]?.lastFiredAt
    const from = last ? new Date(last) : new Date(now.getTime() - 60_000)
    const at = nextFireAt(spec.schedule, from)
    if (at && new Date(at).getTime() <= now.getTime()) due.push({ spec, firedFor: at })
  }
  return due
}

/**
 * When each orchestration last fired.
 *
 * Kept apart from the settings file on purpose: firing must not bump the
 * policy revision, because that would invalidate every approval a person is
 * currently looking at, every time a nightly job runs.
 */
export class ScheduleState {
  constructor(file) {
    this.file = file
    this.value = {}
    this.queue = Promise.resolve()
  }
  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.value = parsed
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this
  }
  async record(key, firedAt) {
    this.value = { ...this.value, [key]: { lastFiredAt: firedAt } }
    const snapshot = JSON.stringify(this.value, null, 2)
    const operation = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temp, snapshot, { mode: 0o600 })
      await rename(temp, this.file)
    })
    this.queue = operation.catch(() => {})
    await operation
  }
}
