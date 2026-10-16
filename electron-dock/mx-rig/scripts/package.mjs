// The desktop installer, made for a team: it knows its server, and it carries
// its own test browser, so the people who install it only log in.
//
//   npm run package -- [--dir] [--server <地址>] [--private-http] [--no-browser]
//                      [--launcher [--bootstrap <地址,地址>]] [--mac | --win | --linux]
//
// --server        the Internal address the login page starts with (people can
//                 still change it; the one that worked is remembered)
// --private-http  start with「内网测试服务器」ticked (plain HTTP on a private IP)
// --no-browser    leave Chromium out: a smaller installer that downloads it
//                 on first use (or uses the computer's Chrome / Edge)
// --dir           an unpacked app folder instead of an installer
// --launcher      Launcher mode (docs/25): the app is Launcher's standalone
//                 product mx-rig and reaches the service through its own
//                 product network; carries the WireGuard and Mihomo engines
//                 for its platform (the network, and the overseas channel of
//                 docs/25 P3). --server then overrides the product VIP.
// --bootstrap     Launcher entrances to try, in order (default: the public
//                 relay by IP, then h2i.minsight-ai.com)
//
// A Launcher-mode installer also gets a release manifest beside it
// (<installer>.json: version, platform, arch, size, SHA-256), which is what
// scripts/manage.sh release publish uploads to Release Center (docs/25 P2).
// Only installers update themselves; a --dir build is 'portable' and does not.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { Arch, build, Platform } from 'electron-builder'
import { serviceUrl } from '../packages/contracts/index.mjs'
import { DEFAULT_BOOTSTRAP_URLS } from '../apps/desktop/launcher-network.mjs'
import { INSTALLER_EXTENSIONS, manifestPath, writeInstallerManifest } from './release-artifact.mjs'
import { binaryName, enginePackage } from '../apps/desktop/mihomo-engine.mjs'
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
const launcher = flag('launcher')
if (launcher) {
  const bootstrapUrls = (option('bootstrap') ?? '').split(',').map((url) => url.trim()).filter(Boolean)
  const serverUrl = server ? serviceUrl(server, { privateHttp: true }) : null
  const defaults = {
    launcher: {
      enabled: true,
      bootstrapUrls: bootstrapUrls.length ? bootstrapUrls : DEFAULT_BOOTSTRAP_URLS,
      ...(serverUrl ? { serverUrl } : {}),
      distribution: flag('dir') ? 'portable' : 'installed'
    }
  }
  await writeFile(defaultsFile, `${JSON.stringify(defaults, null, 2)}\n`)
  say(`Launcher mode: product mx-rig through ${defaults.launcher.bootstrapUrls.join(', ')}; the service is ${serverUrl ?? 'the product VIP'}`)
} else if (server) {
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

// -- the WireGuard engine, in Launcher mode ---------------------------------------------

// Launcher looks for it in Resources/wireguard/<platform>-<arch>. npm installs
// only this machine's engine; another platform's or architecture's is fetched
// once, at the version electron-core-wireguard asks for.
if (launcher) {
  const key = `${{ mac: 'darwin', win: 'win32', linux: 'linux' }[target]}-${arch}`
  const name = `@qpjoy/electron-core-wireguard-engine-${key}`
  const require = createRequire(import.meta.url)
  let dir = null
  try {
    dir = resolve(require.resolve(`${name}/package.json`), '..')
  } catch {
    const core = JSON.parse(await readFile(require.resolve('@qpjoy/electron-core-wireguard/package.json'), 'utf8'))
    const version = core.optionalDependencies?.[name]
    if (!version) throw new Error(`no WireGuard engine is published for ${key}`)
    dir = resolve(root, '.runtime/wireguard-engines', key, 'package')
    if (!existsSync(dir)) {
      say(`fetching ${name}@${version} (once; kept in .runtime/wireguard-engines)`)
      const into = resolve(root, '.runtime/wireguard-engines', key)
      await mkdir(into, { recursive: true })
      const packed = spawnSync('npm', ['pack', `${name}@${version}`, '--pack-destination', into, '--silent'], { encoding: 'utf8', shell: process.platform === 'win32' })
      if (packed.status !== 0) throw new Error(`fetching ${name} failed: ${packed.stderr}`)
      const tarball = join(into, packed.stdout.trim().split(/\r?\n/).at(-1))
      const unpacked = spawnSync('tar', ['-xzf', tarball, '-C', into], { stdio: 'inherit' })
      if (unpacked.status !== 0) throw new Error(`unpacking ${tarball} failed`)
    }
  }
  const from = join(dir, 'resources', 'wireguard', key)
  if (!existsSync(from)) throw new Error(`the WireGuard engine for ${key} has no binaries at ${from}`)
  config.extraResources = [...(config.extraResources ?? []), { from, to: `wireguard/${key}` }]
  say(`bundling the WireGuard engine ${from}`)
}

// -- the Mihomo engine, in Launcher mode ------------------------------------------------

// The overseas channel (docs/25 P3) runs Launcher's Mihomo build, shipped
// gzipped in Resources/mihomo/<platform>-<arch> and unpacked on first use.
// npm installs only this machine's engine package; another target's is
// fetched once at the version package.json pins. The engine packages never
// go into app.asar.
config.files = [...config.files, '!node_modules/@qpjoy/electron-plugin-tunnel-engine-*/**']
if (launcher) {
  const releasePlatform = { mac: 'darwin', win: 'win32', linux: 'linux' }[target]
  const key = `${releasePlatform}-${arch}`
  const name = enginePackage(releasePlatform, arch)
  const require = createRequire(import.meta.url)
  let dir = null
  try {
    dir = resolve(require.resolve(`${name}/package.json`), '..')
  } catch {
    const own = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
    const version = own.optionalDependencies?.[name]
    if (!version) throw new Error(`no Mihomo engine is pinned for ${key} (${name} in package.json)`)
    dir = resolve(root, '.runtime/mihomo-engines', key, 'package')
    if (!existsSync(dir)) {
      say(`fetching ${name}@${version} (once; kept in .runtime/mihomo-engines)`)
      const into = resolve(root, '.runtime/mihomo-engines', key)
      await mkdir(into, { recursive: true })
      const packed = spawnSync('npm', ['pack', `${name}@${version}`, '--pack-destination', into, '--silent'], { encoding: 'utf8', shell: process.platform === 'win32' })
      if (packed.status !== 0) throw new Error(`fetching ${name} failed: ${packed.stderr}`)
      const tarball = join(into, packed.stdout.trim().split(/\r?\n/).at(-1))
      const unpacked = spawnSync('tar', ['-xzf', tarball, '-C', into], { stdio: 'inherit' })
      if (unpacked.status !== 0) throw new Error(`unpacking ${tarball} failed`)
    }
  }
  const from = join(dir, 'resources', 'engine', key, `${binaryName(releasePlatform)}.gz`)
  if (!existsSync(from)) throw new Error(`the Mihomo engine for ${key} has no binary at ${from}`)
  config.extraResources = [...(config.extraResources ?? []), { from, to: `mihomo/${key}/${binaryName(releasePlatform)}.gz` }]
  say(`bundling the Mihomo engine ${from}`)
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

let built = []
try {
  const archs = [Arch[arch]].filter((value) => value !== undefined)
  if (flag('dir')) {
    // Local unsigned directory build; no installer/signing tool download needed.
    if (target === { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform] && arch === process.arch)
      config.electronDist = resolve(root, 'node_modules/electron/dist')
    config.win = { ...config.win, signAndEditExecutable: false }
    await build({ projectDir: root, targets: platform.createTarget('dir', ...archs), config })
  } else built = await build({ projectDir: root, targets: platform.createTarget(null, ...archs), config })
} finally {
  // The address belongs to that build only; a desktop run from source keeps
  // starting with its own.
  await rm(defaultsFile, { force: true })
}

// -- what Release Center gets, in Launcher mode ---------------------------------------

if (launcher && !flag('dir')) {
  const releasePlatform = { mac: 'darwin', win: 'win32', linux: 'linux' }[target]
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  for (const file of built.filter((path) => path.endsWith(INSTALLER_EXTENSIONS[releasePlatform]))) {
    const manifest = await writeInstallerManifest(file, { version, platform: releasePlatform, arch })
    say(`release manifest ${manifestPath(file)} (${manifest.digest.slice(0, 19)}…)`)
    say(`publish: copy both files to the Internal node, then scripts/manage.sh release publish ${manifest.fileName} --install-id <安装 ID>`)
  }
}
say(`output: ${resolve(root, 'dist')}`)
