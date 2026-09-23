export const NEWS_ENDPOINTS = [
  { id: 'source-options', method: 'GET', path: '/api/v1/data/news/source-options', label: '新闻来源下拉', metered: false,
    description: 'data.items[].key 是稳定目录 ID，value 是显示名称。多选 key 填入搜索的 catalogEntryIds；只返回当前 Key 可检索且已绑定新闻的来源。' },
  { id: 'sources', method: 'GET', path: '/api/v1/data/news/sources', label: '数据类别与目录元数据', metered: false,
    description: 'data.categories[].id 填入搜索的 categories，label 用于显示。platform 是授权标识，不是 categories 参数。items 是通用目录元数据，不保证有新闻；新闻下拉请使用 source-options。' },
  { id: 'search', method: 'POST', path: '/api/v1/data/news/search', label: '新闻搜索与分页', metered: true,
    description: '使用上方筛选条件。data.items[].id 用于文章详情；data.pageInfo.nextCursor 用于下一页。留空关键词可浏览新闻，catalogEntryIds 数组内部匹配任一来源。' },
  { id: 'articles', method: 'GET', path: '/api/v1/data/news/articles/{id}', label: '新闻详情', metered: true,
    description: 'id 必须是新闻搜索返回的文章 ID，不是目录 ID。返回 data.article，包括已存正文与来源。可先搜索，再点击文章旁的“填入详情”。' },
  { id: 'facets', method: 'POST', path: '/api/v1/data/news/facets', label: '来源与类别统计', metered: true,
    description: '使用上方筛选条件，统计最新最多 5,000 条匹配记录。sources[].catalogEntryId 可用于目录筛选；count 是记录数，不代表事件数或全库总数。' },
]

export function newsConsoleRequest(operation, filters, articleId = '') {
  const endpoint = NEWS_ENDPOINTS.find(item => item.id === operation)
  if (!endpoint) throw new Error('未知的新闻接口')
  if (operation === 'articles' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(articleId.trim())) {
    throw new Error('请从新闻搜索结果填入有效的文章 ID（UUID）。')
  }
  const body = endpoint.method === 'POST' ? JSON.parse(JSON.stringify(filters)) : undefined
  if (operation === 'facets') delete body.cursor
  return { operation, method: endpoint.method,
    path: endpoint.path.replace('{id}', encodeURIComponent(articleId.trim())), ...(body ? { body } : {}) }
}

export function nextNewsConsoleRequest(result) {
  const page = result?.payload?.data?.pageInfo
  if (result?.request?.operation !== 'search' || !page?.hasMore || !page.nextCursor) return null
  return { ...result.request, body: { ...result.request.body, cursor: page.nextCursor } }
}
