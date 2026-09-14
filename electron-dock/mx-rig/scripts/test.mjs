import { mkdir, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const temp = resolve(root, '.runtime/test-tmp')
await mkdir(temp, { recursive: true })
// Artifact integration tests intentionally retain the production 5 GiB
// reserve. Put their scratch data on the selected workspace volume, not C:.
const dirs =
  process.argv[2] === 'kernel'
    ? ['packages/test-platform/tests']
    : ['tests', 'packages/test-platform/tests']
const files = []
for (const dir of dirs)
  for (const file of await readdir(resolve(root, dir)))
    if (file.endsWith('.test.mjs')) files.push(resolve(root, dir, file))
const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root,
  env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
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
