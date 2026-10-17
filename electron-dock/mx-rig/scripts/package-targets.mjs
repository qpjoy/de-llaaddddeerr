// Which installers one `npm run package` makes (scripts/package.mjs).
//
//   --mac / --win / --linux        the platform (default: this computer's)
//   --arm64 / --x64 / --universal  the architectures, any of them
//   --all                          every architecture of that platform:
//                                  macOS arm64, x64 and universal; Windows x64
//
// Without an architecture: Windows x64, otherwise this computer's.

export const PLATFORM_OF = Object.freeze({ mac: 'darwin', win: 'win32', linux: 'linux' })
const ALL = Object.freeze({ mac: ['arm64', 'x64', 'universal'], win: ['x64'], linux: ['x64', 'arm64'] })

export function targetPlatform(flags, host = process.platform) {
  const chosen = ['mac', 'win', 'linux'].filter((name) => flags.has(name))
  if (chosen.length > 1) throw new Error(`一次只打一个平台（给了 ${chosen.map((name) => `--${name}`).join(' ')}）`)
  return chosen[0] ?? { darwin: 'mac', win32: 'win', linux: 'linux' }[host]
}

export function buildArches(target, flags, hostArch = process.arch) {
  if (flags.has('all')) return target === 'linux' ? [hostArch === 'arm64' ? 'arm64' : 'x64'] : [...ALL[target]]
  const chosen = ['arm64', 'x64', 'universal'].filter((arch) => flags.has(arch))
  for (const arch of chosen)
    if (!ALL[target].includes(arch) && !(target === 'linux' && arch === hostArch))
      throw new Error(target === 'win' ? 'Windows 只出 x64 安装包' : `${target} 没有 ${arch} 安装包`)
  if (chosen.length) return chosen
  return target === 'win' ? ['x64'] : [hostArch]
}

/** The real architectures inside a build: both for a universal macOS app. */
export const resourceArches = (arch) => (arch === 'universal' ? ['arm64', 'x64'] : [arch])
