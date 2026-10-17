// The desktop installer, made for a team: it knows its server, and it carries
// its own test browser, so the people who install it only log in.
//
//   npm run package -- [--dir] [--server <地址>] [--private-http] [--no-browser]
//                      [--launcher [--bootstrap <地址,地址>]]
//                      [--mac | --win | --linux] [--arm64] [--x64] [--universal] [--all]
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
// --arm64 / --x64 / --universal / --all
//                 which architectures (scripts/package-targets.mjs): one
//                 installer each; --all is macOS arm64 + x64 + universal, or
//                 Windows x64. A universal Mac app carries both Chromiums.
//
// Every build uses the published Launcher packages: a checkout in local
// package mode (scripts/dev-mode.mjs) is switched to npm for the build and
// back afterwards.
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
import { join, relative, resolve, sep } from 'node:path'
import { Arch, build, Platform } from 'electron-builder'
import { serviceUrl } from '../packages/contracts/index.mjs'
import { DEFAULT_BOOTSTRAP_URLS } from '../apps/desktop/launcher-network.mjs'
import { INSTALLER_EXTENSIONS, manifestPath, writeInstallerManifest } from './release-artifact.mjs'
import { binaryName, enginePackage } from '../apps/desktop/mihomo-engine.mjs'
import { PLATFORM_OF, buildArches, resourceArches, targetPlatform } from './package-targets.mjs'
import { createDevMode } from './dev-mode.mjs'
import {
  chromiumBuild,
  executableIn,
  hostPlatform,
  installChromium,
  playwrightCache,
  progressLine
} from '../packages/runtime/browser-provision.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')).map((arg) => arg.slice(2)))
const flag = (name) => flags.has(name)
const option = (name) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const say = (message) => console.log(`[package] ${message}`)

const target = targetPlatform(flags)
const platform = { mac: Platform.MAC, win: Platform.WINDOWS, linux: Platform.LINUX }[target]
const releasePlatform = PLATFORM_OF[target]
const arches = buildArches(target, flags)
const launcher = flag('launcher')
say(`${target}: ${arches.join(', ')}${launcher ? ' (Launcher mode)' : ''}`)

// -- the server these builds start with ---------------------------------------------

const defaultsFile = resolve(root, 'apps/desktop/defaults.json')
const server = option('server') ?? process.env.MX_RIG_SERVER_URL
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

// -- what goes into Resources, per real architecture ------------------------------------

/** One platform's Chromium: this machine's Playwright cache, or a copy fetched once. */
async function chromiumFor(arch) {
  const key = hostPlatform(releasePlatform, arch)
  if (!key) {
    say(`no Chromium build for ${target}-${arch}; the app will use the computer's Chrome / Edge or download one`)
    return null
  }
  const { folder } = chromiumBuild()
  const cache = key === hostPlatform() ? playwrightCache() : null
  let dir = cache && existsSync(executableIn(cache, key)) ? cache : null
  if (!dir) {
    dir = resolve(root, '.runtime/browsers', key)
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
  }
  // Only this platform's folder (chrome-mac-arm64, chrome-win64…): a universal
  // app carries two of them side by side, and Playwright picks its own.
  const sub = relative(join(dir, folder), executableIn(dir, key)).split(sep)[0]
  return { from: join(dir, folder, sub), to: `ms-playwright/${folder}/${sub}` }
}

/** An engine package: installed (this machine's) or fetched once at its pinned version. */
async function enginePackageDir(name, version, cache) {
  try {
    return resolve(require.resolve(`${name}/package.json`), '..')
  } catch {
    if (!version) throw new Error(`no version is pinned for ${name}`)
    const into = resolve(root, '.runtime', cache, name.split('/').pop())
    const dir = join(into, 'package')
    if (!existsSync(dir)) {
      say(`fetching ${name}@${version} (once; kept in .runtime/${cache})`)
      await mkdir(into, { recursive: true })
      const packed = spawnSync('npm', ['pack', `${name}@${version}`, '--pack-destination', into, '--silent'], { encoding: 'utf8', shell: process.platform === 'win32' })
      if (packed.status !== 0) throw new Error(`fetching ${name} failed: ${packed.stderr}`)
      const tarball = join(into, packed.stdout.trim().split(/\r?\n/).at(-1))
      const unpacked = spawnSync('tar', ['-xzf', tarball, '-C', into], { stdio: 'inherit' })
      if (unpacked.status !== 0) throw new Error(`unpacking ${tarball} failed`)
    }
    return dir
  }
}

// Launcher looks for WireGuard in Resources/wireguard/<platform>-<arch>, at
// the version electron-core-wireguard asks for.
async function wireguardFor(arch) {
  const key = `${releasePlatform}-${arch}`
  const name = `@qpjoy/electron-core-wireguard-engine-${key}`
  const core = JSON.parse(await readFile(require.resolve('@qpjoy/electron-core-wireguard/package.json'), 'utf8'))
  const dir = await enginePackageDir(name, core.optionalDependencies?.[name], 'wireguard-engines')
  const from = join(dir, 'resources', 'wireguard', key)
  if (!existsSync(from)) throw new Error(`the WireGuard engine for ${key} has no binaries at ${from}`)
  return { from, to: `wireguard/${key}` }
}

// The overseas channel (docs/25 P3) runs Launcher's Mihomo build, shipped
// gzipped in Resources/mihomo/<platform>-<arch>, at the version package.json pins.
async function mihomoFor(arch) {
  const key = `${releasePlatform}-${arch}`
  const name = enginePackage(releasePlatform, arch)
  const own = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const dir = await enginePackageDir(name, own.optionalDependencies?.[name], 'mihomo-engines')
  const file = `${binaryName(releasePlatform)}.gz`
  const from = join(dir, 'resources', 'engine', key, file)
  if (!existsSync(from)) throw new Error(`the Mihomo engine for ${key} has no binary at ${from}`)
  return { from, to: `mihomo/${key}/${file}` }
}

// -- one build ----------------------------------------------------------------------

async function buildOne(arch) {
  const config = JSON.parse(await readFile(resolve(root, 'apps/desktop/builder.json'), 'utf8'))
  const resources = []
  for (const part of resourceArches(arch)) {
    if (!flag('no-browser')) resources.push(await chromiumFor(part))
    if (launcher) resources.push(await wireguardFor(part), await mihomoFor(part))
  }
  for (const entry of resources.filter(Boolean)) say(`bundling ${entry.to} ← ${entry.from}`)
  config.extraResources = [...(config.extraResources ?? []), ...resources.filter(Boolean)]
  // The engine packages are Resources, never app.asar.
  config.files = [...config.files, '!node_modules/@qpjoy/electron-plugin-tunnel-engine-*/**']

  if (target === 'mac') {
    // macOS asks once before running an app without a Developer ID signature;
    // the disk image says what to click (apps/desktop/first-run.mjs then offers
    // to move it into Applications).
    config.dmg = {
      ...config.dmg,
      window: { width: 540, height: 460 },
      contents: [
        { x: 130, y: 190 },
        { x: 410, y: 190, type: 'link', path: '/Applications' },
        // A Launcher-mode build is opened differently: network first, then the unified account.
        { x: 270, y: 350, type: 'file', path: resolve(root, launcher ? 'deploy/desktop/launcher/首次打开说明.txt' : 'deploy/desktop/首次打开说明.txt') }
      ]
    }
    // Both architectures' engines and browsers are in both halves of a
    // universal build, identical: kept as they are rather than merged.
    if (arch === 'universal') config.mac = { ...config.mac, x64ArchFiles: '**/{ms-playwright,wireguard,mihomo}/**/*' }
    // Without a Developer ID (CSC_LINK / CSC_NAME), electron-builder leaves the
    // app with Electron's signature broken by the repackaging, and Apple
    // silicon kills the helpers ("Network service crashed"). An ad-hoc
    // signature over the whole bundle is what lets it run.
    if (process.platform === 'darwin' && !process.env.CSC_LINK && !process.env.CSC_NAME) {
      config.mac = { ...config.mac, identity: null }
      config.afterPack = async ({ appOutDir, packager }) => {
        const app = join(appOutDir, `${packager.appInfo.productFilename}.app`)
        const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
        if (signed.status !== 0) throw new Error(`ad-hoc signing ${app} failed`)
        say(`signed ad hoc ${relative(root, app)} (no Developer ID): macOS asks once on first open`)
      }
    }
  }

  const archs = [Arch[arch]].filter((value) => value !== undefined)
  if (flag('dir')) {
    // Local unsigned directory build; no installer/signing tool download needed.
    if (target === { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform] && arch === process.arch)
      config.electronDist = resolve(root, 'node_modules/electron/dist')
    config.win = { ...config.win, signAndEditExecutable: false }
    await build({ projectDir: root, targets: platform.createTarget('dir', ...archs), config })
    return []
  }
  return build({ projectDir: root, targets: platform.createTarget(null, ...archs), config })
}

// -- build them all, from the published packages ---------------------------------------

const devMode = createDevMode({ log: (line) => say(line) })
const backToLocal = devMode.recorded() === 'local' || devMode.current() !== 'npm'
if (backToLocal) say('this checkout uses the local Launcher packages: switching to the published ones for the build')
// Temporary switches: .dev-mode.json keeps the developer's mode, so a build
// interrupted halfway still knows to return to local (npm run setup does too).
devMode.useNpm({ remember: false })
const installers = []
try {
  for (const arch of arches) {
    const built = await buildOne(arch)
    installers.push(...built.filter((path) => path.endsWith(INSTALLER_EXTENSIONS[releasePlatform])).map((file) => ({ file, arch })))
  }
} finally {
  // The address belongs to these builds only; a desktop run from source keeps
  // starting with its own.
  await rm(defaultsFile, { force: true })
  if (backToLocal) {
    say('back to the local Launcher packages')
    devMode.useLocal({ build: false, remember: false })
  }
}

// -- what Release Center gets, in Launcher mode ---------------------------------------

if (launcher) {
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  for (const { file, arch } of installers) {
    const manifest = await writeInstallerManifest(file, { version, platform: releasePlatform, arch })
    say(`release manifest ${manifestPath(file)} (${manifest.digest.slice(0, 19)}…)`)
    say(`publish: copy both files to the Internal node, then scripts/manage.sh release publish ${manifest.fileName} --install-id <安装 ID>`)
  }
}
for (const { file } of installers) say(`installer: ${relative(root, file)}`)
say(`output: ${resolve(root, 'dist')}`)
