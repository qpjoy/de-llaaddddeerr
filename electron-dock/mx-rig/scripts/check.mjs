import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
async function walk(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.runtime'].includes(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(p)))
    else files.push(p)
  }
  return files
}
let count = 0
for (const file of await walk(root)) {
  if (/\.(mjs|cjs|js)$/.test(file)) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    count++
  }
  if (
    file.includes(`${join('apps', 'desktop')}`) ||
    file.includes(`${join('packages', 'runtime')}`)
  ) {
    const source = await readFile(file, 'utf8')
    if (
      /applyElectronLauncherStandaloneDataPlane|stopElectronLauncherStandaloneDataPlane|mx-h2i-runtime|exec\(.*(?:netsh|route)/.test(
        source
      )
    )
      throw new Error(`Network ownership coupling: ${file}`)
  }
}
console.log(`${count} JavaScript modules parse; runtime has no network-owner implementation.`)
