import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// An explicit path is useful on small system disks; otherwise use Playwright's
// normal per-user cache, also used by the packaged desktop.
const cli = fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url))
const child = spawn(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
})
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
