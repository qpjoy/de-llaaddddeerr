#!/usr/bin/env node
// Measures archive throughput against a real NAS at several concurrency levels
// and recommends MX_STATIC_NAS_CONCURRENCY. Writes only into its own temporary
// subdirectory of the confirmed NAS root and removes it afterwards; it never
// reads, writes or deletes anything under objects/ or metadata/.
//
// The operation sequence mirrors src/archive-io.mjs: create temp, stream the
// bytes while hashing, fsync, optionally read back and verify, rename, fsync
// the directory. Small-file NFS writes are latency bound, so the point of the
// measurement is to find where added concurrency stops buying throughput.
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { dirname, join } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map(part => {
  const [key, value = 'true'] = part.replace(/^--/, '').split('=')
  return [key, value]
}))
const usage = `Usage:
  node scripts/nas-bench.mjs --nas=/mnt/nas/mx-static --volume-id=mx-static-nas-01 \\
    [--sizes=200k,5m] [--concurrency=1,2,4,8,16] [--count=64] [--verify=always,never]

Writes <count> objects per (size, concurrency, verify) combination into
<nas>/.mx-static-bench-<pid>/ and deletes that directory when done.`
if (!args.nas || !args['volume-id']) { console.error(usage); process.exit(2) }

const bytesOf = text => {
  const match = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(text.trim())
  if (!match) throw new Error(`unrecognised size: ${text}`)
  return Math.round(Number(match[1]) * { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()])
}
const list = (text, fallback) => (text || fallback).split(',').map(part => part.trim()).filter(Boolean)
const sizes = list(args.sizes, '200k,5m').map(text => ({ label: text, bytes: bytesOf(text) }))
const levels = list(args.concurrency, '1,2,4,8,16').map(Number)
const verifyModes = list(args.verify, 'always')
const count = Number(args.count || 64)
if (![count, ...levels].every(n => Number.isInteger(n) && n > 0)) { console.error(usage); process.exit(2) }

// Same guard the archive worker uses: never write into an unconfirmed mount.
const marker = join(args.nas, '.mx-static-volume-id')
let identity
try { identity = (await readFile(marker, 'utf8')).trim() } catch {
  console.error(`refusing to run: ${marker} is unreadable. Mount the NAS and create the volume marker first.`)
  process.exit(2)
}
if (identity !== args['volume-id']) {
  console.error(`refusing to run: ${marker} holds "${identity}", not "${args['volume-id']}".`)
  process.exit(2)
}

const scratch = join(args.nas, `.mx-static-bench-${process.pid}`)
const source = join(scratch, 'source')
const syncDir = async path => { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }

async function writeOne(target, payload, sha256, verify) {
  await mkdir(dirname(target), { recursive: true, mode: 0o750 })
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    const hash = createHash('sha256')
    await pipeline(createReadStream(payload),
      new Transform({ transform(chunk, _, cb) { hash.update(chunk); cb(null, chunk) } }),
      createWriteStream(temp, { flags: 'wx', mode: 0o640 }))
    if (hash.digest('hex') !== sha256) throw new Error('source_checksum_mismatch')
    const file = await open(temp, 'r+'); try { await file.sync() } finally { await file.close() }
    if (verify === 'always') {
      const back = createHash('sha256')
      for await (const chunk of createReadStream(temp)) back.update(chunk)
      if (back.digest('hex') !== sha256) throw new Error('archive_checksum_mismatch')
    }
    await rename(temp, target)
    await syncDir(dirname(target))
  } finally { await unlink(temp).catch(() => {}) }
}

async function measure(size, concurrency, verify, payload, sha256) {
  const root = join(scratch, `${size.label}-c${concurrency}-${verify}-${randomUUID().slice(0, 8)}`)
  await mkdir(root, { recursive: true, mode: 0o750 })
  const queue = Array.from({ length: count }, (_, index) => index)
  const started = process.hrtime.bigint()
  let failures = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
      // Shard like the object tree so directory growth is represented.
      try { await writeOne(join(root, String(index % 16), `${randomUUID()}`), payload, sha256, verify) }
      catch { failures++ }
    }
  }))
  const seconds = Number(process.hrtime.bigint() - started) / 1e9
  return { objectsPerSecond: count / seconds, mbPerSecond: (count * size.bytes) / seconds / 1024 ** 2, seconds, failures }
}

console.log(`nas-bench: ${count} objects per run into ${scratch}`)
console.log(`sizes=${sizes.map(s => s.label).join(',')} concurrency=${levels.join(',')} verify=${verifyModes.join(',')}\n`)
const results = []
try {
  await mkdir(scratch, { recursive: true, mode: 0o750 })
  for (const size of sizes) {
    // Stage the payload locally once; the measurement is the NAS write path.
    const payload = join(scratch, `payload-${size.label}`)
    const body = randomBytes(Math.min(size.bytes, 8 * 1024 * 1024))
    const handle = await open(payload, 'wx', 0o640)
    try {
      for (let written = 0; written < size.bytes; written += body.length) await handle.write(body, 0, Math.min(body.length, size.bytes - written))
      await handle.sync()
    } finally { await handle.close() }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(payload)) hash.update(chunk)
    const sha256 = hash.digest('hex')

    for (const verify of verifyModes) {
      console.log(`--- ${size.label} objects, verify=${verify} ---`)
      console.log('concurrency   objects/s      MB/s    elapsed   failures')
      for (const concurrency of levels) {
        const run = await measure(size, concurrency, verify, payload, sha256)
        results.push({ size: size.label, verify, concurrency, ...run })
        console.log(`${String(concurrency).padStart(11)}${run.objectsPerSecond.toFixed(1).padStart(12)}${run.mbPerSecond.toFixed(1).padStart(10)}${run.seconds.toFixed(1).padStart(11)}s${String(run.failures).padStart(11)}`)
      }
      console.log()
    }
  }
} finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}) }

// Recommend the smallest level past which throughput gains under 15%: beyond
// that the added concurrency costs NAS resources without buying anything.
const best = new Map()
for (const row of results) {
  const key = `${row.size}/${row.verify}`
  const previous = best.get(key)
  if (!previous || row.objectsPerSecond > previous.objectsPerSecond * 1.15) best.set(key, row)
}
console.log('Recommended MX_STATIC_NAS_CONCURRENCY per workload:')
for (const [key, row] of best) console.log(`  ${key.padEnd(18)} ${row.concurrency}  (${row.objectsPerSecond.toFixed(1)} objects/s, ${row.mbPerSecond.toFixed(1)} MB/s)`)
const recommended = Math.max(...[...best.values()].map(row => row.concurrency))
console.log(`\nSet MX_STATIC_NAS_CONCURRENCY=${recommended} in compose.nas.yml, then re-attach the archive container.`)
if (results.some(row => row.failures)) console.log('Some writes failed; investigate before trusting these numbers.')
