import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { integrationSlotManifest } from '../server/contracts/integration-slot.mjs'

// Validation only. Never imports an adapter, installs packages, fetches a URL or runs commands.
const root = new URL('../integrations/', import.meta.url)
const ids = new Set()
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const source = new URL(`${entry.name}/manifest.json`, root)
  const manifest = integrationSlotManifest.parse(JSON.parse(await readFile(source, 'utf8')))
  if (ids.has(manifest.slotId)) throw new Error(`Duplicate slotId: ${manifest.slotId}`)
  ids.add(manifest.slotId)
  console.log(`${manifest.slotId}: valid manifest, ${manifest.adapter.activation} (${fileURLToPath(source)})`)
}
