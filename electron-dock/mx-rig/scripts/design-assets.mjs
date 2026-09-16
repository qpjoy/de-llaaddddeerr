import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const VENDOR = fileURLToPath(new URL('../apps/web/vendor/', import.meta.url))
export const DESIGN_FILES = ['tokens.css', 'styles.css']

/**
 * Put the installed design system next to the shared UI.
 *
 * The workbench is loaded over `file://` by the desktop and over HTTP by
 * Internal, so one relative path has to resolve on both. Copying from
 * node_modules at start-up keeps a single source of truth — the installed
 * package — instead of a hand-maintained vendored fork that drifts.
 *
 * Returns false when the package is not installed (a packaged desktop build
 * already carries the copy) so callers can continue rather than fail to boot.
 */
export async function syncDesignAssets() {
  let sources
  try {
    sources = DESIGN_FILES.map((file) =>
      fileURLToPath(import.meta.resolve(`@qpjoy/ui-design-neon-void/${file}`))
    )
  } catch {
    return false
  }
  await mkdir(VENDOR, { recursive: true })
  for (const [index, source] of sources.entries()) {
    const body = await readFile(source, 'utf8')
    const target = resolve(VENDOR, DESIGN_FILES[index])
    let current = null
    try {
      current = await readFile(target, 'utf8')
    } catch {
      /* first run */
    }
    if (current !== body) await writeFile(target, body)
  }
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const copied = await syncDesignAssets()
  console.log(
    copied
      ? `Neon Void 设计系统已同步到 apps/web/vendor/（${DESIGN_FILES.join('、')}）`
      : '未找到 @qpjoy/ui-design-neon-void；沿用已存在的副本'
  )
}
