// Product fields only. Collector credentials/lineage remain in the restricted archive.
export function newsFields(raw = {}) {
  let attributes = raw.attributes
  if (typeof attributes === 'string') {
    try { attributes = JSON.parse(attributes) } catch { attributes = {} }
  }
  attributes = attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {}
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : null
  const labels = value => Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, 50) : []
  const status = text(attributes.body_status) || text(raw.content_extent)
  return {
    contractVersion: 'news-fields.v1',
    summary: text(attributes.summary),
    topics: labels(attributes.source_topics),
    keywords: labels(attributes.source_keywords),
    section: text(attributes.section),
    contentExtent: ['full_text', 'summary', 'reference'].includes(status) ? status : 'unknown',
  }
}
