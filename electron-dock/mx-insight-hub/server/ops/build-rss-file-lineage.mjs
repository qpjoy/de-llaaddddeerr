// Private metadata and hashes travel directly to Hub stdin, never to logs.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { loadRssRuntimeFiles, manifestFromRssFiles } from './build-rss-file-comparison.mjs'

export async function buildRssLineageBundle(root) {
  const files = await loadRssRuntimeFiles(root)
  if (files.news.evidence.state !== 'absent') throw new Error('rss_news_file_requires_migration')
  const manifest = manifestFromRssFiles(files)
  const { feeds, ...rssMetadata } = files.rss.value
  const feedMetadata = Object.fromEntries(Object.entries(feeds).map(([key, value]) => {
    const { items, ...metadata } = value
    return [key, metadata]
  }))
  return { version: 'rss-file-lineage-bundle.v1', manifest,
    metadata: { config: files.config.value, rss: { ...rssMetadata, feeds: feedMetadata } } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('rss_runtime_root_required')
    const data = JSON.stringify(await buildRssLineageBundle(resolve(process.argv[2])))
    if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('rss_lineage_bundle_too_large')
    process.stdout.write(data)
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'failed', code:
      /^rss_[a-z_]+$/.test(error.message) ? error.message : 'rss_lineage_build_failed' }) + '\n')
    process.exitCode = 1
  }
}
