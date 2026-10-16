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
    // Rig owns exactly one network: its own Launcher product network (docs/25),
    // in one module. Nothing anywhere drives another product's runtime or
    // edits routes by hand.
    const own = file.endsWith(join('apps', 'desktop', 'launcher-network.mjs'))
    if (/mx-h2i-runtime|exec\(.*(?:netsh|route)/.test(source) || (!own && /applyElectronLauncherStandaloneDataPlane|stopElectronLauncherStandaloneDataPlane/.test(source)))
      throw new Error(`Network ownership coupling: ${file}`)
    if (own && /['"`](?:mx-h2i|luopan|appcenter|h2o)['"`]/.test(source))
      throw new Error(`Rig's product network names another product: ${file}`)
    // The overseas channel (docs/25 P3) is a loopback proxy for Rig's own test
    // browser: nothing here sets a system proxy or PAC for everyone else.
    if (/networksetup\s|-setwebproxy|-setautoproxyurl|scutil\s+--proxy|netsh\s+winhttp|Internet Settings|ProxyServer|setSystemProxy/.test(source))
      throw new Error(`System proxy change: ${file}`)
  }
}
console.log(`${count} JavaScript modules parse; only Rig's own product network owns a data plane, and nothing sets a system proxy.`)
