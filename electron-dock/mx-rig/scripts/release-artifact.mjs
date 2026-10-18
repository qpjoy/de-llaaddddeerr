// The manifest beside a desktop installer that may go to Release Center
// (docs/25 P2). scripts/package.mjs writes it for Launcher-mode builds only;
// scripts/release-publish.mjs refuses an installer without one, or whose
// bytes no longer match it. A build that is not in Launcher mode must never
// reach Launcher users through an update: it would take their product
// network away.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { MANIFEST } from './launcher-plan.mjs'

const RELEASE = MANIFEST.release
// What Release Center accepts per platform (an extension that does not match
// the platform is refused at upload).
export const INSTALLER_EXTENSIONS = Object.freeze({ darwin: '.dmg', win32: '.exe', linux: '.AppImage' })
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export const manifestPath = (file) => `${file}.json`

/** Describe a freshly built installer, beside it. */
export async function writeInstallerManifest(file, { version, platform, arch }) {
  const fileName = basename(file)
  if (INSTALLER_EXTENSIONS[platform] !== extname(fileName)) throw new Error(`${fileName} is not a ${platform} installer`)
  if (!SAFE_FILE.test(fileName)) throw new Error(`${fileName}: Release Center wants a plain ASCII file name`)
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`)
  const manifest = {
    productId: RELEASE.componentId,
    packageName: RELEASE.packageName,
    componentId: RELEASE.componentId,
    kind: 'app-installer',
    channel: RELEASE.channel,
    launcherMode: true,
    version,
    platform,
    arch,
    fileName,
    sizeBytes: (await stat(file)).size,
    digest: `sha256:${await sha256File(file)}`
  }
  await writeFile(manifestPath(file), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** The manifest of an installer about to be published, checked against the file. */
export async function readInstallerManifest(file) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath(file), 'utf8'))
  } catch {
    throw new Error(`${basename(file)} has no release manifest (${basename(manifestPath(file))}); only a Launcher-mode build (scripts/manage.sh desktop --launcher) can be published`)
  }
  if (manifest.launcherMode !== true) throw new Error(`${basename(file)} was not built in Launcher mode`)
  if (manifest.productId !== RELEASE.componentId || manifest.componentId !== RELEASE.componentId || manifest.kind !== 'app-installer')
    throw new Error(`${basename(file)} is not an MX Rig installer`)
  if (manifest.fileName !== basename(file)) throw new Error(`the manifest describes ${manifest.fileName}, not ${basename(file)}`)
  if (INSTALLER_EXTENSIONS[manifest.platform] !== extname(manifest.fileName)) throw new Error(`${manifest.fileName} does not match platform ${manifest.platform}`)
  if (!VERSION.test(String(manifest.version)) || !manifest.arch) throw new Error(`${basename(manifestPath(file))} is incomplete`)
  const size = (await stat(file)).size
  if (size !== manifest.sizeBytes || `sha256:${await sha256File(file)}` !== manifest.digest)
    throw new Error(`${basename(file)} changed since it was built (size or SHA-256 differs from its manifest)`)
  return manifest
}
