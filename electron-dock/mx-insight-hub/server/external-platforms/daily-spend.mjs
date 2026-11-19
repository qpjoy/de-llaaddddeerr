import { decimalAmount } from './balance-adapters.mjs'

const DAY = 86_400_000
const SCALE = 10n ** 12n
const amountText = units => `${units / SCALE}.${String(units % SCALE).padStart(12, '0')}`

export function dailySpendWindow(at, hour = 0) {
  const offset = (8 - hour) * 3_600_000
  const start = Math.floor((new Date(at).getTime() + offset) / DAY) * DAY - offset
  return { windowStart: new Date(start).toISOString(), windowEnd: new Date(start + DAY).toISOString() }
}

// Account-wide cash decreases, not a supplier bill. Positive balance changes
// never undo earlier decreases; simultaneous recharge and spending can be hidden.
export function advanceDailySpend(previous, { at, balance, dayStartHour = 0 }) {
  at = new Date(at).toISOString()
  const window = dailySpendWindow(at, dayStartHour)
  const baseline = () => ({ ...window, dayStartHour, amount: '0', lastBalance: balance,
    baselineAt: at, observedAt: at,
    partial: new Date(at) - new Date(window.windowStart) > 5 * 60_000 })
  if (!previous || previous.dayStartHour !== dayStartHour) return baseline()
  const delta = decimalAmount(previous.lastBalance).units - decimalAmount(balance).units
  const advance = () => ({ ...previous, amount: amountText(decimalAmount(previous.amount).units + (delta > 0n ? delta : 0n)),
    lastBalance: balance, observedAt: at })
  if (previous.windowStart === window.windowStart) {
    const { previousWindow: _old, ...state } = advance()
    return state
  }
  const state = baseline()
  // A timely boundary read closes the last half-hour of the preceding day.
  // After downtime across a boundary there is no defensible daily allocation.
  if (previous.windowEnd === window.windowStart && !state.partial) {
    const { previousWindow: _old, ...completed } = advance()
    state.previousWindow = completed
  }
  return state
}

export function dailySpendExceeded(amount, threshold) {
  return decimalAmount(amount).units > decimalAmount(threshold).units
}
