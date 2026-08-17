// Parse every module in the project.
//
// The test suite runs against the memory store, so `store/postgres.mjs` is never
// imported by it — a syntax error there stayed invisible behind 82 green tests
// and would only have surfaced on the deployed server. Anything that ships must
// at least be known to parse.

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const roots = ['server', 'bin', 'scripts', 'tests']

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.mjs')) yield full
  }
}

let failed = 0
for (const base of roots) {
  for (const file of walk(join(root, base))) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    } catch (error) {
      failed += 1
      console.error(`✗ ${file.slice(root.length + 1)}`)
      console.error(String(error.stderr).split('\n').slice(0, 4).join('\n'))
    }
  }
}
if (failed > 0) {
  console.error(`\n${failed} 个模块无法解析`)
  process.exit(1)
}
console.log('语法检查通过')
