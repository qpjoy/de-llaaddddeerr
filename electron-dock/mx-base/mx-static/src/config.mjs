// One schema drives everything about a setting: how it is parsed from the
// environment, whether it may be changed at runtime, and how the admin page
// renders it. Adding a knob in one place is the whole change.
//
// Nothing here throws. A malformed value is replaced by its default and
// recorded as a warning: a typo in .env must never stop the service from
// starting, because a stopped service loses the durable queue's availability
// for the sake of a number that had a perfectly good default.

export const GROUPS = {
  service: 'Service',
  capacity: 'Capacity',
  ingest: 'Ingest',
  cache: 'Cache',
  archive: 'NAS archive',
  advanced: 'Advanced',
}

const int = (min, max) => ({ kind: 'int', min, max })
const bool = () => ({ kind: 'bool' })
const text = (values) => ({ kind: 'text', values })

export const SCHEMA = {
  // --- capacity: stated as a service level, permits are derived from it ---
  assetQps: { env: 'MX_STATIC_SLO_ASSET_QPS', group: 'capacity', live: true, default: 10, ...int(1, 100000),
    label: 'Image/static reads per second', help: 'Sustained rate this deployment must serve.' },
  assetP95Ms: { env: 'MX_STATIC_SLO_ASSET_P95_MS', group: 'capacity', live: true, default: 200, ...int(1, 60000),
    label: 'Image latency budget (ms)', help: 'Used with the rate to size the permit pool.' },
  assetSizeKb: { env: 'MX_STATIC_SLO_ASSET_SIZE_KB', group: 'advanced', live: true, default: 200, ...int(1, 1048576),
    label: 'Typical image size (KB)', help: 'Only affects the bandwidth budget.' },
  videoViewers: { env: 'MX_STATIC_SLO_VIDEO_VIEWERS', group: 'capacity', live: true, default: 30, ...int(1, 100000),
    label: 'Concurrent video viewers', help: 'Streams that must play without stalling.' },
  videoBitrateKbps: { env: 'MX_STATIC_SLO_VIDEO_BITRATE_KBPS', group: 'capacity', live: true, default: 3000, ...int(1, 1000000),
    label: 'Video bitrate (kbps)', help: 'Per stream; used for the bandwidth budget.' },
  burst: { env: 'MX_STATIC_SLO_BURST', group: 'advanced', live: true, default: 4, ...int(1, 100),
    label: 'Burst headroom', help: 'Permits are the steady-state concurrency times this.' },
  linkMbps: { env: 'MX_STATIC_LINK_MBPS', group: 'capacity', live: true, default: 1000, ...int(1, 1000000),
    label: 'Network link (Mbps)', help: 'Measure with iperf3. The default is a placeholder.' },
  diskReadMbps: { env: 'MX_STATIC_DISK_READ_MBPS', group: 'capacity', live: true, default: 500, ...int(1, 1000000),
    label: 'Disk read throughput (MB/s)', help: 'Measure with fio. The default is a placeholder.' },
  utilisation: { env: 'MX_STATIC_PLANNING_UTILISATION', group: 'advanced', live: true, default: 70, ...int(1, 100),
    label: 'Planning utilisation (%)', help: 'Never plan to run a shared link past this.' },
  capacityStrict: { env: 'MX_STATIC_CAPACITY_STRICT', group: 'advanced', live: false, default: false, ...bool(),
    label: 'Refuse to start on an infeasible service level', help: 'Off by default: warn instead.' },
  maxLagMs: { env: 'MX_STATIC_MAX_LAG_MS', group: 'capacity', live: true, default: 250, ...int(1, 60000),
    label: 'Event-loop lag before shedding video (ms)', help: 'The asset class is never shed on lag.' },

  // --- explicit permit overrides; empty means "derive from the SLO" ---
  maxReads: { env: 'MX_STATIC_MAX_READS', group: 'advanced', live: true, default: 0, ...int(0, 100000),
    label: 'Disk-read permits (0 = derive)', help: 'Short manifest/stat/cache-fill phase.' },
  maxAssetStreams: { env: 'MX_STATIC_MAX_ASSET_STREAMS', group: 'advanced', live: true, default: 0, ...int(0, 100000),
    label: 'Image transfer permits (0 = derive)' },
  maxVideoStreams: { env: 'MX_STATIC_MAX_VIDEO_STREAMS', group: 'advanced', live: true, default: 0, ...int(0, 100000),
    label: 'Video transfer permits (0 = derive)' },

  // --- ingest ---
  imageWorkers: { env: 'MX_STATIC_IMAGE_WORKERS', group: 'ingest', live: true, default: 24, ...int(1, 512),
    label: 'Image download workers', help: 'Separate pool: big videos cannot starve image collection.' },
  videoWorkers: { env: 'MX_STATIC_VIDEO_WORKERS', group: 'ingest', live: true, default: 6, ...int(1, 512),
    label: 'Video download workers' },
  maxQueued: { env: 'MX_STATIC_MAX_QUEUED', group: 'ingest', live: true, default: 100000, ...int(1, 10000000),
    label: 'Queue capacity', help: 'Beyond this, ingest returns 429 and the caller retries.' },
  maxBatch: { env: 'MX_STATIC_MAX_BATCH', group: 'ingest', live: true, default: 200, ...int(1, 10000),
    label: 'Max URLs per batch request' },
  maxBytes: { env: 'MX_STATIC_MAX_BYTES', group: 'ingest', live: false, default: 268435456, ...int(1024, 17179869184),
    label: 'Max object size (bytes)', help: 'Downloads stream to disk, so this is not a memory cost.' },
  waitMs: { env: 'MX_STATIC_WAIT_MS', group: 'advanced', live: true, default: 1000, ...int(0, 30000),
    label: 'Synchronous ingest wait (ms)', help: 'Holds a request slot. Batch and Prefer: respond-async never wait.' },

  // --- cache ---
  cacheBytes: { env: 'MX_STATIC_CACHE_BYTES', group: 'cache', live: true, default: 268435456, ...int(0, 17179869184),
    label: 'Object cache (bytes)' },
  cacheTtlMs: { env: 'MX_STATIC_CACHE_TTL_MS', group: 'cache', live: true, default: 60000, ...int(0, 86400000),
    label: 'Object cache TTL (ms)' },
  cacheObjectBytes: { env: 'MX_STATIC_CACHE_OBJECT_BYTES', group: 'cache', live: true, default: 2097152, ...int(0, 1073741824),
    label: 'Largest cacheable object (bytes)' },
  manifestEntries: { env: 'MX_STATIC_MANIFEST_ENTRIES', group: 'cache', live: true, default: 100000, ...int(0, 10000000),
    label: 'Manifest cache entries', help: 'Stops a seeking video re-reading its manifest per Range request.' },
  fileMaxAge: { env: 'MX_STATIC_FILE_MAX_AGE', group: 'cache', live: true, default: 900, ...int(0, 31536000),
    label: 'Browser cache window (s)', help: 'Capped by the signed link’s own remaining lifetime.' },

  // --- archive ---
  nasConcurrency: { env: 'MX_STATIC_NAS_CONCURRENCY', group: 'archive', live: false, default: 4, ...int(1, 64),
    label: 'Archive concurrency', help: 'Inside one child process. Measure with scripts/nas-bench.mjs.' },
  nasVerify: { env: 'MX_STATIC_NAS_VERIFY', group: 'archive', live: false, default: 'always', ...text(['always', 'sample', 'never']),
    label: 'Far-side read-back', help: 'Eviction always verifies, whatever this says.' },
  nasIdleTimeoutMs: { env: 'MX_STATIC_NAS_IDLE_TIMEOUT_MS', group: 'archive', live: false, default: 15000, ...int(1000, 600000),
    label: 'Archive idle timeout (ms)' },
  nasMaxJobMs: { env: 'MX_STATIC_NAS_MAX_JOB_MS', group: 'archive', live: false, default: 900000, ...int(1000, 86400000),
    label: 'Archive batch time limit (ms)' },

  // --- service ---
  restoreDebounceMs: { env: 'MX_STATIC_RESTORE_DEBOUNCE_MS', group: 'advanced', live: true, default: 5000, ...int(0, 600000),
    label: 'Cold-restore debounce (ms)' },
  ioTimeoutMs: { env: 'MX_STATIC_IO_TIMEOUT_MS', group: 'advanced', live: true, default: 10000, ...int(100, 120000),
    label: 'Response deadline (ms)' },
  accelRedirect: { env: 'MX_STATIC_ACCEL_REDIRECT', group: 'service', live: true, default: '', ...text(),
    label: 'X-Accel-Redirect prefix', help: 'Set to an internal nginx location (e.g. /internal-objects/) to let nginx send the bytes. Empty means this service streams them itself.' },
  corsOrigins: { env: 'MX_STATIC_CORS_ORIGINS', group: 'service', live: true, default: '', ...text(),
    label: 'CORS origins', help: 'Exact origins, comma separated. Empty disables cross-origin reads.' },
  publicUrl: { env: 'MX_STATIC_PUBLIC_URL', group: 'service', live: true, default: '', ...text(),
    label: 'Public base URL', help: 'Used to build preview links.' },
}

function coerce(spec, raw) {
  if (raw === undefined || raw === '') return { value: spec.default }
  const text = String(raw).trim()
  if (spec.kind === 'bool') {
    if (/^(true|1|yes|on)$/i.test(text)) return { value: true }
    if (/^(false|0|no|off)$/i.test(text)) return { value: false }
    return { value: spec.default, warning: `expected true or false, got "${text}"` }
  }
  if (spec.kind === 'int') {
    const value = Number(text)
    if (!Number.isFinite(value) || !Number.isInteger(value)) return { value: spec.default, warning: `expected a whole number, got "${text}"` }
    if (value < spec.min || value > spec.max) return { value: spec.default, warning: `must be between ${spec.min} and ${spec.max}, got ${value}` }
    return { value }
  }
  if (spec.values && !spec.values.includes(text)) return { value: spec.default, warning: `expected one of ${spec.values.join(', ')}, got "${text}"` }
  return { value: text }
}

// Layered: schema default, then environment, then runtime overrides. Every bad
// value degrades to the layer below it and is reported, never thrown.
export function resolveConfig(env = process.env, overrides = {}) {
  const values = {}, warnings = []
  for (const [name, spec] of Object.entries(SCHEMA)) {
    const fromEnv = coerce(spec, env[spec.env])
    if (fromEnv.warning) warnings.push(`${spec.env}: ${fromEnv.warning} (using ${JSON.stringify(spec.default)})`)
    values[name] = fromEnv.value
    if (!(name in overrides)) continue
    if (!spec.live) { warnings.push(`${name}: not adjustable at runtime; the stored override is ignored`); continue }
    const override = coerce(spec, overrides[name])
    if (override.warning) warnings.push(`${name} (stored): ${override.warning} (using ${JSON.stringify(values[name])})`)
    else values[name] = override.value
  }
  return { values, warnings }
}

// What a caller may send to the settings API, with the reason for each refusal.
export function validateOverrides(input) {
  const accepted = {}, rejected = {}
  for (const [name, raw] of Object.entries(input || {})) {
    const spec = SCHEMA[name]
    if (!spec) { rejected[name] = 'unknown setting'; continue }
    if (!spec.live) { rejected[name] = 'not adjustable at runtime; set it in .env and redeploy'; continue }
    if (raw === null) { accepted[name] = null; continue } // null clears the override
    const { warning, value } = coerce(spec, raw)
    if (warning) rejected[name] = warning
    else accepted[name] = value
  }
  return { accepted, rejected }
}

export const describeSchema = () => Object.entries(SCHEMA).map(([name, spec]) => ({
  name, env: spec.env, group: spec.group, groupLabel: GROUPS[spec.group], live: Boolean(spec.live),
  kind: spec.kind, min: spec.min, max: spec.max, values: spec.values,
  default: spec.default, label: spec.label, help: spec.help || '',
}))
