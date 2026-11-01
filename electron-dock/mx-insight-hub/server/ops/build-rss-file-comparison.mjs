// Read host-local files and emit a self-contained, hash-only comparison program
// for the existing Admin Pod. No temporary file or image rollout is required.
import { open, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rssSourceOptions } from './diagnose-rss-intent-migration.mjs'
import { digest, rssFileIdentity, validateFileManifest } from './rss-file-coverage.mjs'

async function load(root, name, required) {
  let handle
  try {
    handle = await open(resolve(root, 'data', name), 'r')
    const before = await handle.stat()
    if (!before.isFile() || before.size > 128 * 1024 * 1024) throw new Error('rss_file_size_unsupported')
    const bytes = await handle.readFile(), after = await handle.stat()
    if (bytes.length !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new Error('rss_file_changed_retry')
    return { value: JSON.parse(bytes.toString('utf8')),
      evidence: { state: 'read', bytes: bytes.length, sha256: digest(bytes) } }
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return { value: null, evidence: { state: 'absent' } }
    throw error
  } finally { await handle?.close() }
}

export async function buildRssFileManifest(root) {
  await stat(resolve(root, 'lib/domains/rss/rss-fetcher.js'))
  await stat(resolve(root, 'lib/domains/data-feed/services/data-feed-service.js'))
  const rss = await load(root, 'rss-results.json', true)
  const config = await load(root, 'rss-config.json', true)
  const news = await load(root, 'news-results.json', false)
  if (!rss.value?.feeds || typeof rss.value.feeds !== 'object' || Array.isArray(rss.value.feeds)
    || !Array.isArray(config.value?.feeds)) throw new Error('rss_file_shape_invalid')
  const manifest = { version: 'rss-file-manifest.v1', files: { rss: rss.evidence, config: config.evidence, news: news.evidence },
    items: [], feeds: [], configFeeds: [] }
  for (const [key, feed] of Object.entries(rss.value.feeds)) {
    if (!Array.isArray(feed?.items)) throw new Error('rss_file_shape_invalid')
    manifest.feeds.push(digest(key))
    for (const item of feed.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('rss_file_shape_invalid')
      manifest.items.push(rssFileIdentity(key, item))
    }
  }
  for (const feed of config.value.feeds) {
    if (typeof feed?.id !== 'string' || !feed.id || typeof feed.url !== 'string' || !feed.url) throw new Error('rss_config_identity_invalid')
    manifest.configFeeds.push({ keyHash: digest(feed.id), urlHash: digest(feed.url) })
  }
  validateFileManifest(manifest)
  return manifest
}

export async function buildRssComparisonProgram(root) {
  const manifest = await buildRssFileManifest(root)
  const program = await readFile(new URL('./rss-file-coverage.mjs', import.meta.url), 'utf8')
  return `${program}\nconst rssSourceOptions = ${rssSourceOptions.toString()};\nawait runRssFileComparison(${JSON.stringify(manifest)}, rssSourceOptions);\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('rss_runtime_root_required')
    process.stdout.write(await buildRssComparisonProgram(resolve(process.argv[2])))
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'incomplete', code:
      /^rss_[a-z_]+$/.test(error.message) ? error.message : 'rss_manifest_build_failed' }) + '\n')
    process.exitCode = 2
  }
}
