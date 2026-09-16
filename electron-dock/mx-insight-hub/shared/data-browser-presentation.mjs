export const metricLabels = { likes: '点赞', comments: '评论', shares: '分享', favorites: '收藏', views: '浏览', followers: '粉丝' }
export function metricNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,18}(\.\d{1,4})?$/.test(value))) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}
export function sourceTags(row) {
  const tags = row.stable_fields?.tags ?? row.sample?.tags ?? row.observation?.tags
  return [...new Set((Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 200))]
}
export const safeMediaUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null
export function recordPresentation(row) {
  const stable = row.stable_fields || {}
  const author = stable.author || row.observation?.author || {}
  const profile = row.profile?.fields || stable.profile || {}
  const image = stable.media?.images?.[0]
  return {
    avatar: safeMediaUrl(profile.avatarUrl || author.avatarUrl),
    cover: safeMediaUrl(stable.media?.coverUrl || (typeof image === 'string' ? image : image?.url)),
    bio: typeof profile.bio === 'string' ? profile.bio : '',
    followers: metricNumber(row.profile?.metrics?.followers ?? profile.followers ?? author.followers),
    tags: sourceTags(row),
    metrics: Object.fromEntries(Object.keys(metricLabels).map((key) => [key, metricNumber(stable.metrics?.[key])])),
  }
}
