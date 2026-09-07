import { pathToFileURL } from 'node:url'
import { mapExternalEnvironment } from './env.mjs'
import { importKernelModule, resolveKernelRoot } from './legacy.mjs'

export async function start(environment = process.env) {
  mapExternalEnvironment(environment, process.env)
  const kernel = await importKernelModule('server/index.mjs', environment)
  return kernel.start()
}

async function main() {
  const runtime = await start()
  console.log(
    `mx-auto-server V0 listening on http://${runtime.config.host}:${runtime.config.port}` +
      ` (kernel=${resolveKernelRoot()}, launcherAudience=${runtime.config.launcher.audience})`
  )

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await runtime.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
