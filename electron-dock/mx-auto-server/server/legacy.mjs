import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const siblingKernelRoot = fileURLToPath(new URL('../../mx-test-framework/', import.meta.url))

export function resolveKernelRoot(environment = process.env) {
  return resolve(environment.MX_AUTO_KERNEL_ROOT || siblingKernelRoot)
}

export async function importKernelModule(modulePath, environment = process.env) {
  const root = resolveKernelRoot(environment)
  const entry = resolve(root, modulePath)
  const fromRoot = relative(root, entry)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`Kernel module escapes MX_AUTO_KERNEL_ROOT: ${modulePath}`)
  }
  try {
    return await import(pathToFileURL(entry).href)
  } catch (error) {
    error.message = `Cannot load the V0 mx-test-framework kernel at ${entry}: ${error.message}`
    throw error
  }
}
