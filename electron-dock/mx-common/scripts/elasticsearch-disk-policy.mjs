// Host-side deployment helper: no node_modules, model calls or index writes.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const prefix = 'cluster.routing.allocation.disk.'
export const diskPolicy = Object.freeze({
  [`${prefix}threshold_enabled`]: true,
  [`${prefix}watermark.low`]: '100gb',
  [`${prefix}watermark.high`]: '50gb',
  [`${prefix}watermark.flood_stage`]: '30gb',
})
const headroomKeys = ['low', 'high', 'flood_stage']
  .map((level) => `${prefix}watermark.${level}.max_headroom`)
const managedKeys = [...Object.keys(diskPolicy), ...headroomKeys]

export function diskPolicyUpdate() {
  return {
    persistent: {
      ...diskPolicy,
      ...Object.fromEntries(headroomKeys.map((key) => [key, null])),
    },
    // Transient overrides take precedence over persistent settings. Clear only
    // the keys this policy owns, never unrelated cluster settings.
    transient: Object.fromEntries(managedKeys.map((key) => [key, null])),
  }
}

export function matchesDiskPolicy(settings) {
  if (!settings || typeof settings !== 'object') return false
  const persistent = settings.persistent || {}
  const transient = settings.transient || {}
  return Object.entries(diskPolicy).every(([key, value]) => String(persistent[key]) === String(value))
    && headroomKeys.every((key) => persistent[key] == null)
    && managedKeys.every((key) => transient[key] == null)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    switch (process.argv[2]) {
      case 'body':
        console.log(JSON.stringify(diskPolicyUpdate()))
        break
      case 'check':
        process.exitCode = matchesDiskPolicy(JSON.parse(readFileSync(0, 'utf8'))) ? 0 : 1
        break
      case 'ack':
        process.exitCode = JSON.parse(readFileSync(0, 'utf8'))?.acknowledged === true ? 0 : 1
        break
      default:
        throw new Error('unknown_command')
    }
  } catch {
    console.error('Elasticsearch disk policy response/configuration is invalid')
    process.exitCode = 1
  }
}
