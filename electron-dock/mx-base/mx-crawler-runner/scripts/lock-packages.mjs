#!/usr/bin/env node
// Record (--write) or verify (default) the sha256 of every reviewed package
// tree in packages.json. The image build runs the check before installing
// anything; the runner checks again at startup.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { treeHash } from '../src/catalog.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const path = join(root, 'packages.json')
const catalog = JSON.parse(readFileSync(path, 'utf8'))
const write = process.argv.includes('--write')
let mismatches = 0
for (const [id, entry] of Object.entries(catalog.upstreams || {})) {
  const { sha256, files } = treeHash(resolve(root, entry.root))
  const ok = entry.sha256 === sha256
  if (!ok) mismatches += 1
  console.log(`${ok ? 'ok      ' : write ? 'updated ' : 'MISMATCH'} ${id.padEnd(30)} ${String(files).padStart(5)} files  ${sha256}`)
  if (write) entry.sha256 = sha256
}
for (const [slotId, entry] of Object.entries(catalog.packages)) {
  const { sha256, files } = treeHash(resolve(root, entry.root))
  const ok = entry.sha256 === sha256
  if (!ok) mismatches += 1
  console.log(`${ok ? 'ok      ' : write ? 'updated ' : 'MISMATCH'} ${slotId.padEnd(30)} ${String(files).padStart(5)} files  ${sha256}`)
  if (write) entry.sha256 = sha256
}
if (write) writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`)
else if (mismatches) { console.error(`${mismatches} package(s) differ from packages.json; review the change, then run with --write`); process.exit(1) }
