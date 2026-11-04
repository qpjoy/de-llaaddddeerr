// Run in the actual Night-All runtime directory. Read files only; do not load
// application modules (which may start schedulers), fetch, or print articles.
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export async function inspectFeedFiles(root) {
  const report = { version: 'rss-file-fallbacks.v1', status: 'observed', files: {} }
  // These are the fixed paths used by rss-fetcher.js/data-feed-service.js.
  for (const kind of ['rss', 'news', 'rss-config']) {
    const filename = resolve(root, 'data', kind === 'rss-config' ? 'rss-config.json' : `${kind}-results.json`)
    try {
      const info = await stat(filename)
      if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('file_size_unsupported')
      const buffer = await readFile(filename)
      const value = JSON.parse(buffer.toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_shape')
      const feeds = kind === 'rss' ? value.feeds : null
      if (kind === 'rss' && (!feeds || typeof feeds !== 'object' || Array.isArray(feeds))) throw new Error('invalid_shape')
      const groups = kind === 'rss' ? Object.values(feeds).map(feed => feed?.items)
        : [kind === 'rss-config' ? value.feeds : value.items]
      if (groups.some(items => !Array.isArray(items))) throw new Error('invalid_shape')
      const rows = groups.flat()
      report.files[kind] = { state: 'read', bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        feeds: kind === 'rss-config' ? rows.length : feeds ? Object.keys(feeds).length : null, items: rows.length,
        itemsWithoutLink: rows.filter(row => !(row?.link || row?.url || row?.guid)).length }
    } catch (error) {
      const absent = error.code === 'ENOENT'
      report.files[kind] = { state: absent ? 'absent' : 'unavailable' }
      if (!absent) report.status = 'incomplete'
    }
  }
  return report
}

if (process.argv[1] === '-' && /\/\[eval\d+\]$/.test(import.meta.url)
  || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(process.argv[2] || process.cwd())
  try {
    // Wrong cwd must not masquerade as proof that both fallback files are absent.
    await stat(resolve(root, 'lib/domains/rss/rss-fetcher.js'))
    await stat(resolve(root, 'lib/domains/data-feed/services/data-feed-service.js'))
    const report = await inspectFeedFiles(root)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (report.status !== 'observed') process.exitCode = 2
  } catch {
    process.stdout.write(JSON.stringify({ version: 'rss-file-fallbacks.v1', status: 'runtime_root_unverified' }) + '\n')
    process.exitCode = 2
  }
}
