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
// The image copies mx-common/src beside mx-rig and resolves every package —
// mx-common's too — from mx-rig's node_modules (npm ci --omit=dev --omit=optional).
const common = resolve(root, '../mx-common')
const commonExports = JSON.parse(readFileSync(resolve(common, 'package.json'), 'utf8')).exports
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')).packages
const installed = (name) => {
  const entry = lock[`node_modules/${name}`]
  return Boolean(entry && !entry.dev && !entry.optional)
}
const packageName = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
// Every source of every `COPY mx-rig/…` line (a line may name several).
const copied = [...readFileSync(resolve(root, 'deploy/Dockerfile'), 'utf8').matchAll(/^COPY (.+?) \S+$/gm)]
  .flatMap((match) => match[1].split(/\s+/))
  .filter((source) => source.startsWith('mx-rig/'))
  .map((source) => source.slice('mx-rig/'.length).replace(/\/$/, ''))
// The repository root is the image's working directory.
const inImage = (file) => file === '' || file.startsWith('../mx-common/src/') || copied.some((dir) => file === dir || file.startsWith(`${dir}/`))
const rel = (file) => relative(root, file).split(sep).join('/')

test('everything the server loads or reads at its own path is copied into the image', () => {
  const seen = new Set()
  const missing = []
  const packages = new Set()
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
    // Packages: mx-common is followed into its copied source; every other one
    // must be something the image installs.
    // Statements only: a template or a sentence that says "from 'x'" is not an import.
    const statements = [
      ...source.matchAll(/^\s*(?:import|export)\s[^;'"]*?from\s+['"]([^.'"/][^'"]*)['"]/gm),
      ...source.matchAll(/^\s*import\s+['"]([^.'"/][^'"]*)['"]/gm),
      ...source.matchAll(/\bawait\s+import\(\s*['"]([^.'"/][^'"]*)['"]\s*\)/g)
    ]
    for (const [, specifier] of statements) {
      if (specifier.startsWith('node:')) continue
      if (specifier === '@qpjoy/mx-common' || specifier.startsWith('@qpjoy/mx-common/')) {
        const sub = `.${specifier.slice('@qpjoy/mx-common'.length)}`
        if (commonExports[sub]) queue.push(resolve(common, commonExports[sub]))
        continue
      }
      packages.add(packageName(specifier))
    }
  }
  assert.ok(seen.size > 50, `walked ${seen.size} files`)
  assert.deepEqual([...new Set(missing)].sort(), [], `not in deploy/Dockerfile: ${missing.join(', ')}`)
  // 2026-10-17: browser SSO pulls openid-client / undici through mx-common;
  // the image only has them because mx-rig depends on them itself.
  assert.ok(packages.has('openid-client'), 'the SSO module is part of what the server loads')
  const absent = [...packages].filter((name) => !installed(name) && !name.startsWith('@qpjoy/mx-rig')).sort()
  assert.deepEqual(absent, [], `the image would not install: ${absent.join(', ')}`)
})
