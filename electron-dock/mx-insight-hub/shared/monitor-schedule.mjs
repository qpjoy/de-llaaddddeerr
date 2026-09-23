import { Cron } from 'croner'

export const MONITOR_TIME_ZONE = 'Asia/Shanghai'
export const DEFAULT_BALANCE_SCHEDULE = { mode: 'cron', expression: '*/30 * * * *' }

export function normalizeMonitorSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请选择有效的执行计划')
  if (value.mode === 'interval') {
    if (Object.keys(value).some(key => !['mode', 'minutes'].includes(key))
      || !Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 1440) {
      throw new Error('固定间隔需为 1–1440 分钟的整数')
    }
    return { mode: 'interval', minutes: value.minutes }
  }
  if (value.mode !== 'cron' || Object.keys(value).some(key => !['mode', 'expression'].includes(key))
    || typeof value.expression !== 'string' || value.expression.length > 128) throw new Error('请输入有效的五段 Cron 表达式')
  const expression = value.expression.trim().replace(/\s+/g, ' ').toUpperCase()
  if (expression.split(' ').length !== 5 || !/^[\dA-Z*,/\- ]+$/.test(expression)) {
    throw new Error('Cron 格式：分 时 日 月 周；支持数字、英文月/星期、*、/、-、逗号，不支持秒字段')
  }
  try {
    if (!new Cron(expression, { timezone: MONITOR_TIME_ZONE }).nextRun()) throw Error()
  } catch { throw new Error('Cron 表达式无效或不存在可执行的日期') }
  return { mode: 'cron', expression }
}

// Cron steps reset at each field boundary. Only convert genuinely uniform
// durations; e.g. */45 would alternate 45-minute and 15-minute gaps.
export function scheduleEveryMinutes(minutes) {
  const interval = normalizeMonitorSchedule({ mode: 'interval', minutes })
  if (minutes < 60 && 60 % minutes === 0) return { mode: 'cron', expression: `${minutes === 1 ? '*' : `*/${minutes}`} * * * *` }
  if (minutes % 60 === 0 && 1440 % minutes === 0) {
    const hours = minutes / 60
    return { mode: 'cron', expression: `0 ${hours === 24 ? '0' : hours === 1 ? '*' : `*/${hours}`} * * *` }
  }
  return interval
}

export function scheduleControls(schedule) {
  if (schedule.mode === 'interval') return { mode: 'interval', minutes: schedule.minutes }
  const expression = schedule.expression.trim().replace(/\s+/g, ' ')
  if (expression === '* * * * *') return { mode: 'every', minutes: 1 }
  if (expression === '0 * * * *') return { mode: 'every', minutes: 60 }
  let match = expression.match(/^(?:\*|0)\/(\d+) \* \* \* \*$/)
  if (match && Number(match[1]) < 60 && 60 % Number(match[1]) === 0) return { mode: 'every', minutes: Number(match[1]) }
  match = expression.match(/^0 (?:\*|0)\/(\d+) \* \* \*$/)
  if (match && Number(match[1]) < 24 && 24 % Number(match[1]) === 0) return { mode: 'every', minutes: Number(match[1]) * 60 }
  const fields = expression.split(' ')
  if (fields.length === 5 && fields.slice(2).every(field => field === '*')) {
    const uniformList = (field, size) => {
      if (!/^\d+(,\d+)+$/.test(field)) return null
      const numbers = [...new Set(field.split(',').map(Number))].sort((a, b) => a - b)
      const step = size / numbers.length
      return Number.isInteger(step) && numbers.every((number, index) => number === index * step) ? step : null
    }
    const minutes = fields[1] === '*' ? uniformList(fields[0], 60)
      : fields[0] === '0' ? (uniformList(fields[1], 24) || 0) * 60 : null
    if (minutes) return { mode: 'every', minutes }
  }
  match = expression.match(/^(\d+) (\d+) \* \* \*$/)
  if (match && Number(match[1]) < 60 && Number(match[2]) < 24) return { mode: 'daily', time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}` }
  return { mode: 'custom' }
}

export function describeMonitorSchedule(schedule) {
  const controls = scheduleControls(schedule)
  if (controls.mode === 'every') return `每 ${controls.minutes} 分钟（整点对齐）`
  if (controls.mode === 'interval') return `固定间隔 ${controls.minutes} 分钟`
  if (controls.mode === 'daily') return `每天 ${controls.time}`
  return `Cron：${schedule.expression}`
}

export function nextMonitorRun(schedule, after, anchor = after) {
  const date = new Date(after)
  if (schedule.mode === 'cron') {
    const next = new Cron(schedule.expression, { timezone: MONITOR_TIME_ZONE }).nextRun(date)
    if (!next) throw new Error('执行计划没有后续时间')
    return next
  }
  const period = schedule.minutes * 60_000
  const base = new Date(anchor).getTime()
  return new Date(base + (Math.floor((date.getTime() - base) / period) + 1) * period)
}

export function previewMonitorRuns(schedule, after = new Date(), count = 3) {
  const normalized = normalizeMonitorSchedule(schedule)
  const dates = []
  let date = after
  for (let i = 0; i < count; i++) { date = nextMonitorRun(normalized, date); dates.push(date.toISOString()) }
  return dates
}
