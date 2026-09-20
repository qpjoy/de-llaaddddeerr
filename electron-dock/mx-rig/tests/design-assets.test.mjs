import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DESIGN_FILES, syncDesignAssets } from '../scripts/design-assets.mjs'

test('production only verifies prebuilt design assets; a missing or stale build fails without writing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-design-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePaths = DESIGN_FILES.map((file) => join(root, file))
  for (const path of sourcePaths) await writeFile(path, ':root { color: red }')
  const vendor = join(root, 'vendor')
  await assert.rejects(syncDesignAssets({ sourcePaths, vendor, readOnly: true }), /重新构建/)
  assert.deepEqual((await readdir(root)).sort(), [...DESIGN_FILES].sort())
  await syncDesignAssets({ sourcePaths, vendor })
  assert.equal(await syncDesignAssets({ sourcePaths, vendor, readOnly: true }), true)
  await writeFile(sourcePaths[0], ':root { color: blue }')
  await assert.rejects(syncDesignAssets({ sourcePaths, vendor, readOnly: true }), /重新构建/)
  assert.equal(await readFile(join(vendor, DESIGN_FILES[0]), 'utf8'), ':root { color: red }')
})
