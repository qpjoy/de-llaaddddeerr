// Public product contracts; physical routing belongs to the server adapter.
export const XHS_DISCOVERY_VERSION = 'mx-insight-hub.xiaohongshu-discovery.v1'
export const XHS_HOT_SORTS = ['premium_imp_num', 'premium_good_read_rate', 'premium_read_num', 'premium_engage_num', 'premium_engage_rate', 'premium_like_num', 'premium_fav_num', 'premium_cmt_num']
export const XHS_HOT_WINDOWS = ['DAY_3', 'DAY_7', 'DAY_14', 'DAY_30']
export const XHS_DISCOVERY_PRODUCTS = Object.freeze([
  { id: 'hot_notes', key: 'xiaohongshu-hot-notes', label: '小红书热门笔记', tab: '热门内容', operation: 'social.posts.hot_search', path: '/api/v1/data/xiaohongshu/hot-notes/search',
    description: '按关键词、类目和时间范围发现热门内容，比较实际返回的指标。',
    fields: [['searchWord', '关键词', 'string'], ['orderBy', '排序指标', XHS_HOT_SORTS, false, 'premium_imp_num'], ['nd', '时间范围', XHS_HOT_WINDOWS, false, 'DAY_7'], ['noteContentCategory', '类目路径', 'string'], ['cursor', '下一页游标', 'string']] },
  { id: 'creator_inspiration', key: 'xiaohongshu-inspiration', label: '小红书创作灵感', tab: '灵感看板', operation: 'social.inspiration.list', path: '/api/v1/data/xiaohongshu/creator-inspirations',
    description: '浏览创作者中心返回的热点灵感，按需获取下一页。', fields: [['cursor', '下一页游标', 'string']] },
])

// These are presentation containers, not a claim that each row is a note or
// has a canonical identity. Ambiguous/missing lists remain inspectable objects.
export function discoveryCollection(value) {
  if (Array.isArray(value)) return { items: value, path: '$' }
  if (!value || typeof value !== 'object') return null
  const lists = ['items', 'notes', 'list', 'feeds', 'noteList'].filter(key => Array.isArray(value[key]))
  return lists.length === 1 ? { items: value[lists[0]], path: `$.${lists[0]}` } : null
}
