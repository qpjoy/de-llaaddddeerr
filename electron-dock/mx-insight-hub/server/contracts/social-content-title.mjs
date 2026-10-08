// Ordinary social posts have a body/caption, not a generated headline. Names
// of profiles/places and real article titles belong to different object types.
export function hasNoContentTitle(platform, item = {}) {
  if (!['twitter', 'facebook', 'weibo', 'instagram'].includes(platform)) return false
  const kind = String(item.objectType || item.contentType || item.content_type || item.type || '').toLowerCase()
  return !/(?:profile|user|account|location|place|hashtag|topic|article)/.test(kind)
}

export function dataSearchContentTitles(payload, platform) {
  if (!Array.isArray(payload?.data?.items)) return payload
  return { ...payload, data: { ...payload.data, items: payload.data.items.map(item =>
    hasNoContentTitle(platform, item) ? { ...item, title: null } : item) } }
}
