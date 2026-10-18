// PostgreSQL keyset boundaries must retain microseconds. Date is appropriate
// for display, but converting a database timestamp through it can skip rows.
// Keep old millisecond cursors valid alongside the exact UTC database form.
export function cursorTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(value)) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== `${value.slice(0, 23)}Z`) return null
  return value
}

export function cursorTimestampOrderKey(value) {
  const timestamp = cursorTimestamp(value)
  return timestamp == null ? '' : timestamp.slice(0, -1).padEnd(26, '0')
}
