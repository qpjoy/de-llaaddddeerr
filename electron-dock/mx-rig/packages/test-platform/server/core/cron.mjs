import { AppError } from './errors.mjs'

// Five-field cron (minute hour day-of-month month day-of-week) evaluated in a
// named IANA time zone.
//
// No dependency: the only hard part is the time zone, and Intl already knows
// every zone and every DST rule. The algorithm walks candidate instants in UTC
// and asks Intl what the local wall clock reads there, which sidesteps having to
// model DST transitions ourselves — a local time that does not exist is simply
// never produced by the formatter, and one that occurs twice matches twice, of
// which we take the first.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
]

const MONTH_ALIASES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_ALIASES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function parseValue(token, field) {
  const lower = token.toLowerCase()
  if (field.name === 'month') {
    const index = MONTH_ALIASES.indexOf(lower)
    if (index !== -1) return index + 1
  }
  if (field.name === 'dayOfWeek') {
    const index = DAY_ALIASES.indexOf(lower)
    if (index !== -1) return index
  }
  if (!/^\d+$/u.test(token)) {
    throw new AppError(400, 'task_schedule_invalid', `Invalid ${field.name} value "${token}"`)
  }
  const value = Number(token)
  // Both 0 and 7 mean Sunday in every cron implementation people expect.
  if (field.name === 'dayOfWeek' && value === 7) return 0
  if (value < field.min || value > field.max) {
    throw new AppError(
      400,
      'task_schedule_invalid',
      `${field.name} must be between ${field.min} and ${field.max}`,
    )
  }
  return value
}

function parseField(spec, field) {
  const values = new Set()
  for (const part of spec.split(',')) {
    if (!part) throw new AppError(400, 'task_schedule_invalid', `Empty ${field.name} entry`)
    const [range, stepText] = part.split('/')
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/u.test(stepText) || Number(stepText) === 0) {
        throw new AppError(400, 'task_schedule_invalid', `Invalid ${field.name} step "${stepText}"`)
      }
      step = Number(stepText)
    }
    let start = field.min
    let end = field.max
    if (range !== '*') {
      const bounds = range.split('-')
      if (bounds.length > 2) {
        throw new AppError(400, 'task_schedule_invalid', `Invalid ${field.name} range "${range}"`)
      }
      start = parseValue(bounds[0], field)
      // `5/15` means "from 5 to the end of the field, every 15", not just "5".
      end = bounds.length === 2 ? parseValue(bounds[1], field) : stepText === undefined ? start : field.max
      if (end < start) {
        throw new AppError(400, 'task_schedule_invalid', `Invalid ${field.name} range "${range}"`)
      }
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

export function parseCron(expression) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new AppError(400, 'task_schedule_invalid', 'cronExpr is required')
  }
  const parts = expression.trim().split(/\s+/u)
  if (parts.length !== 5) {
    throw new AppError(
      400,
      'task_schedule_invalid',
      'cronExpr must have exactly 5 fields: minute hour day-of-month month day-of-week',
    )
  }
  const parsed = {}
  FIELDS.forEach((field, index) => {
    parsed[field.name] = parseField(parts[index], field)
  })
  // Standard cron: when both day fields are restricted they are OR-ed, not
  // AND-ed. `0 0 1 * MON` fires on the 1st *and* on every Monday.
  parsed.dayOfMonthRestricted = parts[2] !== '*'
  parsed.dayOfWeekRestricted = parts[4] !== '*'
  return parsed
}

const formatterCache = new Map()

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone)
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
      })
    } catch {
      throw new AppError(400, 'task_schedule_invalid', `Unknown time zone "${timeZone}"`)
    }
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

function zonedParts(instant, timeZone) {
  const parts = {}
  for (const { type, value } of formatterFor(timeZone).formatToParts(instant)) {
    parts[type] = value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dayOfWeek: DAY_ALIASES.indexOf(parts.weekday.toLowerCase().slice(0, 3)),
  }
}

function dayMatches(parsed, local) {
  const byMonth = parsed.dayOfMonth.has(local.day)
  const byWeek = parsed.dayOfWeek.has(local.dayOfWeek)
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) return byMonth || byWeek
  if (parsed.dayOfMonthRestricted) return byMonth
  if (parsed.dayOfWeekRestricted) return byWeek
  return true
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// Two years of minutes is far more than any five-field expression needs; an
// expression that finds nothing in that span (`0 0 30 2 *` — 30 February) is
// unsatisfiable and must be rejected rather than looped on forever.
const SEARCH_LIMIT_MS = 2 * 366 * 24 * HOUR

/**
 * First instant strictly after `after` that matches the expression.
 * Returns null when the expression can never fire.
 */
export function nextCronTime(expression, after = new Date(), timeZone = 'UTC') {
  const parsed = typeof expression === 'string' ? parseCron(expression) : expression
  const deadline = after.getTime() + SEARCH_LIMIT_MS
  // Start at the next whole minute: cron has minute resolution and `after` is
  // exclusive, so the current partial minute can never be the answer.
  let cursor = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE

  while (cursor <= deadline) {
    const instant = new Date(cursor)
    const local = zonedParts(instant, timeZone)

    // Skip in the largest safe stride: a whole day when the date is wrong, a
    // whole hour when the hour is wrong. Each stride is the distance to the next
    // local boundary computed at the *current* offset, then applied in UTC.
    //
    // That stays correct across DST because any overshoot equals the offset
    // change over the stride, and the local minutes overshot are exactly the
    // ones the spring-forward deleted — minutes that never occur cannot be the
    // answer. A fall-back undershoots instead, costing one extra iteration.
    if (!parsed.month.has(local.month) || !dayMatches(parsed, local)) {
      cursor += (24 - local.hour) * HOUR - local.minute * MINUTE
      continue
    }
    if (!parsed.hour.has(local.hour)) {
      cursor += HOUR - local.minute * MINUTE
      continue
    }
    if (!parsed.minute.has(local.minute)) {
      cursor += MINUTE
      continue
    }
    return instant
  }
  return null
}

/** Validate at task-creation time so a bad expression fails fast, not at 02:00. */
export function assertSchedulable(expression, timeZone) {
  const parsed = parseCron(expression)
  if (!nextCronTime(parsed, new Date(), timeZone)) {
    throw new AppError(
      400,
      'task_schedule_invalid',
      `cronExpr "${expression}" never fires in ${timeZone}`,
    )
  }
  return parsed
}
