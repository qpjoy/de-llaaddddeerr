import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The server image copies chosen directories (deploy/Dockerfile), while every
// test here runs from the whole repository. A module the server loads — or a
// file it reads with new URL(…, import.meta.url) — that lives outside those
// directories works everywhere except in the container, where the server dies
// on start (2026-10-16: test-packs/ was missing and the Pod crash-looped).
// This walks what the server process can load and checks it is in the image.

const root = fileURLToPath(new URL('../', import.meta.url))
// Every source of every `COPY mx-rig/…` line (a line may name several).
const copied = [...readFileSync(resolve(root, 'deploy/Dockerfile'), 'utf8').matchAll(/^COPY (.+?) \S+$/gm)]
  .flatMap((match) => match[1].split(/\s+/))
  .filter((source) => source.startsWith('mx-rig/'))
  .map((source) => source.slice('mx-rig/'.length).replace(/\/$/, ''))
// The repository root is the image's working directory.
const inImage = (file) => file === '' || copied.some((dir) => file === dir || file.startsWith(`${dir}/`))
const rel = (file) => relative(root, file).split(sep).join('/')

test('everything the server loads or reads at its own path is copied into the image', () => {
  const seen = new Set()
  const missing = []
  const queue = [resolve(root, 'apps/server/index.mjs')]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!inImage(rel(file))) missing.push(rel(file))
    if (!/\.(mjs|js)$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    const targets = [
      // Static and dynamic imports with a relative specifier.
      ...[...source.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((match) => match[1]),
      // Files read relative to the module.
      ...[...source.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)].map((match) => match[1])
    ]
    for (const target of targets) {
      const path = resolve(dirname(file), target)
      // A directory reference (a root, a template folder) is checked as such.
      if (existsSync(path)) queue.push(path)
    }
  }
  assert.ok(seen.size > 50, `walked ${seen.size} files`)
  assert.deepEqual([...new Set(missing)].sort(), [], `not in deploy/Dockerfile: ${missing.join(', ')}`)
})
