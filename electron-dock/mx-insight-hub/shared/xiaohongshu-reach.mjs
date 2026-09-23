// Preserve only explicit note-level counters. Topic totals and interaction
// counts are not substitutes for reads or impressions.
export function xiaohongshuReach(note) {
  const interactions = note?.interact_info || {}
  const counter = value => {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }
  return {
    views: counter(interactions.view_count ?? interactions.read_count ?? note?.view_count ?? note?.read_count ?? note?.readNum),
    impressions: counter(interactions.impression_count ?? note?.impression_count ?? note?.impNum),
  }
}
