// The Mihomo binary behind the overseas channel (docs/25 P3).
//
// It comes from Launcher's own engine packages,
// @qpjoy/electron-plugin-tunnel-engine-<platform>-<arch>, as a gzipped file.
// A source checkout reads it from node_modules (npm installed this
// machine's); an installer carries the target platform's in
// Resources/mihomo/<platform>-<arch> (scripts/package.mjs). Either way it is
// unpacked once into the app's data folder, under the digest of what was
// shipped, so a new engine is unpacked again and an old one is never run by
// mistake.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

export const enginePackage = (platform = process.platform, arch = process.arch) => `@qpjoy/electron-plugin-tunnel-engine-${platform}-${arch}`
export const binaryName = (platform = process.platform) => (platform === 'win32' ? 'mihomo.exe' : 'mihomo')

/** Where the shipped .gz is: the installer's Resources, or the installed npm package. */
export function shippedEngine({ packaged, resourcesPath, platform = process.platform, arch = process.arch, resolve = createRequire(import.meta.url).resolve }) {
  const key = `${platform}-${arch}`
  const file = `${binaryName(platform)}.gz`
  if (packaged) return join(resourcesPath, 'mihomo', key, file)
  let root
  try {
    root = dirname(resolve(`${enginePackage(platform, arch)}/package.json`))
  } catch {
    throw new Error(`没有 ${key} 的海外通道引擎（${enginePackage(platform, arch)}）；重新运行 npm install`)
  }
  return join(root, 'resources', 'engine', key, file)
}

/** The runnable binary, unpacked into `cacheDir` once per shipped engine. */
export async function prepareEngine({ shipped, cacheDir, platform = process.platform }) {
  if (!existsSync(shipped)) throw new Error('这个安装包里没有海外通道引擎')
  const digest = createHash('sha256').update(await readFile(shipped)).digest('hex').slice(0, 16)
  const target = join(cacheDir, digest, binaryName(platform))
  if (existsSync(target)) return target
  await mkdir(dirname(target), { recursive: true })
  const partial = `${target}.${process.pid}.part`
  try {
    await pipeline(createReadStream(shipped), createGunzip(), createWriteStream(partial, { mode: 0o755 }))
    if (platform !== 'win32') await chmod(partial, 0o755)
    await rename(partial, target)
  } catch (error) {
    await rm(partial, { force: true })
    throw new Error(`解压海外通道引擎失败：${error.message}`)
  }
  // Earlier engines are not run again.
  for (const entry of await readdir(cacheDir).catch(() => []))
    if (entry !== digest) await rm(join(cacheDir, entry), { recursive: true, force: true }).catch(() => {})
  return target
}
