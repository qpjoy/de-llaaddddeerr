#!/usr/bin/env node
// Copy the import package(s) of a delivered package's upstream checkout into
// upstream/<name>@<commit12>/, exactly as committed at the reviewed commit
// (git archive, so no untracked or modified files), with its LICENSE and a
// SOURCE.json, after scripts/scrub-upstream.mjs empties hard-coded
// third-party credentials. The runner puts the directory on PYTHONPATH instead
// of building and installing the upstream project.
//
//   node scripts/vendor-upstream.mjs --package /tmp/platforms/98 --name yt-dlp --paths yt_dlp,LICENSE
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { treeHash } from '../src/catalog.mjs'
import { scrubDirectory } from './scrub-upstream.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { package: { type: 'string' }, name: { type: 'string' }, paths: { type: 'string' } } })
if (!values.package || !values.name || !values.paths) { console.error('usage: --package DIR --name NAME --paths a,b'); process.exit(2) }

const lock = JSON.parse(readFileSync(join(values.package, 'upstream.lock.json'), 'utf8'))
const checkout = join(values.package, 'upstream', readdirSync(join(values.package, 'upstream')).find(name => !name.startsWith('.')))
const git = (...args) => {
  const result = spawnSync('git', ['-c', 'safe.directory=*', '-C', checkout, ...args], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })
  if (result.status !== 0) { console.error(result.stderr.toString()); process.exit(1) }
  return result.stdout
}
const head = git('rev-parse', 'HEAD').toString().trim()
if (head !== lock.commit) { console.error(`checkout HEAD ${head} is not the reviewed commit ${lock.commit}`); process.exit(1) }

const id = `${values.name}@${head.slice(0, 12)}`
const target = join(root, 'upstream', id)
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
const paths = values.paths.split(',').map(path => path.trim()).filter(Boolean)
const tar = git('archive', '--format=tar', head, '--', ...paths)
const extract = spawnSync('tar', ['-x', '-C', target], { input: tar })
if (extract.status !== 0) { console.error(extract.stderr.toString()); process.exit(1) }
writeFileSync(join(target, 'SOURCE.json'), `${JSON.stringify({
  name: values.name, repo: lock.repo, origin: lock.origin, commit: head, commitDate: lock.commit_date,
  license: lock.github_metadata?.license?.spdx_id ?? null, paths, deliveredBy: `package ${lock.id}`,
}, null, 2)}\n`)
// Hard-coded third-party credentials in extractors we never call are emptied
// (and listed in SOURCE.json) before the tree is hashed.
const scrubbed = scrubDirectory(target)
const { sha256, files } = treeHash(target)
console.log(JSON.stringify({ id, sha256, files, scrubbed: scrubbed.length }))
