import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importGraph, pack } from '../scripts/pack-cli.mjs'

// `mx-rig` on its own: what the tarball holds is what the CLI imports, and
// nothing of the server, the desktop or the web workbench.

const root = fileURLToPath(new URL('../', import.meta.url))

test('the CLI packs as its import graph and runs from the tarball', async () => {
  const graph = await importGraph()
  assert.deepEqual(graph.packages, ['playwright', 'zod'], 'a spec template’s import line is not an import')
  assert.ok(graph.files.includes('packages/runtime/workspace.mjs'))
  assert.ok(!graph.files.some((file) => /^apps\/(server|desktop)\//.test(file)))
  // The web workbench only lends the replay player, which the CLI's /replay inlines.
  assert.deepEqual(graph.files.filter((file) => file.startsWith('apps/web/')), ['apps/web/replay.js'])
  assert.deepEqual(graph.assets, ['apps/web/replay.css'])

  const out = await mkdtemp(join(tmpdir(), 'mx-rig-pack-'))
  const { tarball, files } = await pack({ out })
  const listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((entry) => entry.replace(/^package\//, ''))
  assert.deepEqual(listed.filter((entry) => /\.(mjs|js)$/.test(entry)).sort(), files)
  assert.ok(listed.includes('apps/web/replay.css'))
  assert.ok(listed.includes('README.md') && listed.includes('package.json'))

  const unpacked = await mkdtemp(join(tmpdir(), 'mx-rig-unpacked-'))
  execFileSync('tar', ['-xzf', tarball, '-C', unpacked])
  const home = join(unpacked, 'package')
  const manifest = JSON.parse(await readFile(join(home, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.bin, { 'mx-rig': 'bin/mx-rig.mjs' })
  assert.deepEqual(Object.keys(manifest.dependencies), ['playwright', 'zod'])
  // Dependencies as npm would install them, from this checkout.
  await symlink(join(root, 'node_modules'), join(home, 'node_modules'))
  const help = spawnSync(process.execPath, [join(home, 'bin', 'mx-rig.mjs'), '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /mx-rig exec/)
  const station = spawnSync(process.execPath, [join(home, 'bin', 'mx-rig.mjs'), 'station'], { encoding: 'utf8' })
  assert.equal(station.status, 0, station.stderr)
  assert.match(station.stdout, /mx-rig station enroll/)
  // Every module loads, not only the ones --help touches. (The entry script
  // runs the CLI when imported; it is what the two runs above exercised.)
  const modules = files.filter((file) => file !== 'bin/mx-rig.mjs')
  const loads = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `${modules.map((file) => `await import(${JSON.stringify(join(home, file))})`).join(';')};console.log('loaded', ${modules.length})`],
    { encoding: 'utf8', env: { ...process.env, MX_RIG_STATION_DIR: join(unpacked, 'station') } }
  )
  assert.equal(loads.status, 0, loads.stderr)
  assert.equal(loads.stdout.trim(), `loaded ${modules.length}`)
})
