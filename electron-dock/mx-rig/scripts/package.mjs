import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { build, Platform } from 'electron-builder'
const root = fileURLToPath(new URL('../', import.meta.url))
const config = JSON.parse(await readFile(resolve(root, 'apps/desktop/builder.json'), 'utf8'))
if (process.argv.includes('--dir')) {
  // Local unsigned directory build; no installer/signing tool download needed.
  config.electronDist = resolve(root, 'node_modules/electron/dist')
  config.win = { ...config.win, signAndEditExecutable: false }
  await build({ projectDir: root, targets: Platform.current().createTarget('dir'), config })
} else await build({ projectDir: root, config })
