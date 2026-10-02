// The desktop installer, made for a team: it knows its server, and it carries
// its own test browser, so the people who install it only log in.
//
//   npm run package -- [--dir] [--server <地址>] [--private-http] [--no-browser]
//                      [--mac | --win | --linux]
//
// --server        the Internal address the login page starts with (people can
//                 still change it; the one that worked is remembered)
// --private-http  start with「内网测试服务器」ticked (plain HTTP on a private IP)
// --no-browser    leave Chromium out: a smaller installer that downloads it
//                 on first use (or uses the computer's Chrome / Edge)
// --dir           an unpacked app folder instead of an installer

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { Arch, build, Platform } from 'electron-builder'
import { serviceUrl } from '../packages/contracts/index.mjs'
import {
  chromiumBuild,
  executableIn,
  hostPlatform,
  installChromium,
  playwrightCache,
  progressLine
} from '../packages/runtime/browser-provision.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const say = (message) => console.log(`[package] ${message}`)

const config = JSON.parse(await readFile(resolve(root, 'apps/desktop/builder.json'), 'utf8'))
const target = flag('win') ? 'win' : flag('linux') ? 'linux' : flag('mac') ? 'mac' : { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
const platform = { mac: Platform.MAC, win: Platform.WINDOWS, linux: Platform.LINUX }[target]
// One architecture per build, the same for the app and the Chromium it carries.
const arch = flag('x64') ? 'x64' : flag('arm64') ? 'arm64' : target === 'win' ? 'x64' : process.arch

// -- the server this build starts with ----------------------------------------------

const defaultsFile = resolve(root, 'apps/desktop/defaults.json')
const server = option('server') ?? process.env.MX_RIG_SERVER_URL
if (server) {
  const privateHttp = flag('private-http')
  // Refused here rather than on twenty people's login pages.
  const url = serviceUrl(server, { privateHttp })
  await writeFile(defaultsFile, `${JSON.stringify({ server: url, privateHttp }, null, 2)}\n`)
  say(`login starts with ${url}${privateHttp ? '（内网 HTTP）' : ''}`)
} else {
  // A build without --server must not carry the last one's address.
  await rm(defaultsFile, { force: true })
  say('no --server: the login page starts with http://127.0.0.1:8791')
}

// -- the test browser it carries ------------------------------------------------------

if (!flag('no-browser')) {
  const key = hostPlatform({ mac: 'darwin', win: 'win32', linux: 'linux' }[target], arch)
  if (!key) {
    say(`no Chromium build for ${target}-${arch}; the app will use the computer's Chrome / Edge or download one`)
  } else {
    const { folder } = chromiumBuild()
    // This machine's own Playwright cache when it matches; otherwise a copy
    // fetched once for packaging, under .runtime/browsers/<platform>.
    const cache = key === hostPlatform() ? playwrightCache() : null
    let from = cache && existsSync(executableIn(cache, key)) ? join(cache, folder) : null
    if (!from) {
      const dir = resolve(root, '.runtime/browsers', key)
      if (!existsSync(executableIn(dir, key))) {
        say(`fetching Chromium for ${key} (once; kept in .runtime/browsers)`)
        const seen = { step: -1 }
        await installChromium({
          dir,
          platform: key,
          onProgress: (event) => {
            const line = progressLine({ phase: 'downloading', ...event }, seen)
            if (line) say(line)
          }
        })
      }
      from = join(dir, folder)
    }
    config.extraResources = [...(config.extraResources ?? []), { from, to: `ms-playwright/${folder}` }]
    say(`bundling ${from}`)
  }
}

// -- the first open of an unsigned build ------------------------------------------------

// macOS asks once before running an app without a Developer ID signature; the
// disk image says what to click. (The app then offers to move itself into
// Applications: apps/desktop/first-run.mjs.)
if (target === 'mac')
  config.dmg = {
    ...config.dmg,
    window: { width: 540, height: 460 },
    contents: [
      { x: 130, y: 190 },
      { x: 410, y: 190, type: 'link', path: '/Applications' },
      { x: 270, y: 350, type: 'file', path: resolve(root, 'deploy/desktop/首次打开说明.txt') }
    ]
  }

// -- a signature macOS will run --------------------------------------------------------

// Without a Developer ID (CSC_LINK / CSC_NAME), electron-builder leaves the
// app with Electron's signature broken by the repackaging, and Apple silicon
// kills the helpers ("Network service crashed"). An ad-hoc signature over
// the whole bundle is what lets it run; Gatekeeper still asks once, as the
// disk image says. A real identity, when present, is used as before.
if (target === 'mac' && process.platform === 'darwin' && !process.env.CSC_LINK && !process.env.CSC_NAME) {
  config.mac = { ...config.mac, identity: null }
  config.afterPack = async ({ appOutDir, packager }) => {
    const app = join(appOutDir, `${packager.appInfo.productFilename}.app`)
    const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
    if (signed.status !== 0) throw new Error(`ad-hoc signing ${app} failed`)
    say('signed ad hoc (no Developer ID): macOS asks once on first open')
  }
}

// -- build ------------------------------------------------------------------------------

try {
  const archs = [Arch[arch]].filter((value) => value !== undefined)
  if (flag('dir')) {
    // Local unsigned directory build; no installer/signing tool download needed.
    if (target === { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform] && arch === process.arch)
      config.electronDist = resolve(root, 'node_modules/electron/dist')
    config.win = { ...config.win, signAndEditExecutable: false }
    await build({ projectDir: root, targets: platform.createTarget('dir', ...archs), config })
  } else await build({ projectDir: root, targets: platform.createTarget(null, ...archs), config })
} finally {
  // The address belongs to that build only; a desktop run from source keeps
  // starting with its own.
  await rm(defaultsFile, { force: true })
}
say(`output: ${resolve(root, 'dist')}`)
