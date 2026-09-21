import { randomUUID } from 'node:crypto'

// Objects are addressed by an immutable key whose path also decides how many
// entries land in one directory. At 100 new objects/s a date-only layout puts
// 8.6M files in a single directory per day; on an NFS server with a small
// metadata cache every lookup there becomes a disk seek. Sharding by hour and
// by the first byte of the id keeps a leaf directory in the low thousands.
//
// Reads accept the older date-only shape as well, so a partially migrated tree
// stays readable. Writes only ever produce the sharded form.
const SHARDED = '[a-z0-9][a-z0-9-]{0,63}\\/\\d{4}\\/\\d{2}\\/\\d{2}\\/\\d{2}\\/[0-9a-f]{2}\\/[0-9a-f-]{36}'
const LEGACY = '[a-z0-9][a-z0-9-]{0,63}\\/\\d{4}\\/\\d{2}\\/\\d{2}\\/[0-9a-f-]{36}'
export const KEY_PATTERN = new RegExp(`^(?:${SHARDED}|${LEGACY})$`)
export const isObjectKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value)
export const isSharded = (value) => new RegExp(`^${SHARDED}$`).test(value)

export function newObjectKey(project, now = new Date()) {
  const stamp = now.toISOString()
  const id = randomUUID()
  return `${project}/${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/${stamp.slice(8, 10)}/${stamp.slice(11, 13)}/${id.slice(0, 2)}/${id}`
}
