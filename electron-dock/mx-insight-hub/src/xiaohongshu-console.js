export const XHS_CONSOLE_ENDPOINTS = [
  { id: 'post', label: '按链接获取笔记', path: '/api/v1/data/post', capability: 'social.posts.resolve', fields: [
    ['url', '笔记链接', 'string', true], ['deliveryMode', '交付方式', ['cache_first', 'cache_only', 'refresh', 'live_only'], false, 'cache_first'],
  ] },
  { id: 'search_notes', label: '搜索笔记', capability: 'social.posts.search', fields: [
    ['keyword', '关键词', 'string', true], ['page', '页码', 'number', false, 1],
    ['sort_type', '排序', ['general', 'time_descending', 'popularity_descending', 'comment_descending', 'collect_descending', 'english_preferred'], false, 'general'],
    ['note_type', '笔记类型', ['不限', '视频笔记', '普通笔记', '直播笔记'], false, '不限'],
    ['time_filter', '时间范围', ['不限', '一天内', '一周内', '半年内'], false, '不限'],
    ['search_id', '搜索标识（续页）', 'string'], ['search_session_id', '搜索会话（续页）', 'string'],
    ['source', '来源参数', 'string'], ['ai_mode', 'AI 模式', ['0', '1']],
  ] },
  { id: 'get_image_note_detail', label: '按 ID 获取图文笔记', capability: 'social.posts.resolve', fields: [['note_id', '笔记 ID', 'string'], ['share_text', '分享链接或文本', 'string']], oneOf: ['note_id', 'share_text'] },
  { id: 'search_users', label: '搜索用户', capability: 'social.users.resolve', fields: [['keyword', '关键词', 'string', true], ['page', '页码', 'number', false, 1], ['search_id', '搜索标识（续页）', 'string'], ['source', '来源参数', 'string']] },
  { id: 'get_user_info', label: '获取用户资料', capability: 'social.users.resolve', fields: [['user_id', '用户 ID', 'string'], ['share_text', '主页分享链接或文本', 'string']], oneOf: ['user_id', 'share_text'] },
  { id: 'get_user_posted_notes', label: '获取用户笔记', capability: 'social.users.posts', fields: [['user_id', '用户 ID', 'string'], ['share_text', '主页分享链接或文本', 'string'], ['cursor', '下一页游标', 'string']], oneOf: ['user_id', 'share_text'] },
].map(endpoint => ({ ...endpoint, path: endpoint.path || `/api/v1/xiaohongshu/app_v2/${endpoint.id}`, compatibility: endpoint.id !== 'post' }))

export function consoleBody(endpoint, values) {
  if (!XHS_CONSOLE_ENDPOINTS.includes(endpoint)) throw new Error('请选择 Hub 小红书接口')
  const body = endpoint.id === 'post' ? { platform: 'xiaohongshu' } : {}
  for (const [key, label, type, required] of endpoint.fields) {
    const value = values[key]
    if (value == null || String(value).trim() === '') { if (required) throw new Error(`请填写${label}`); continue }
    if (Array.isArray(type) && !type.includes(value)) throw new Error(`${label}不在可选范围内`)
    if (type === 'number' && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 15)) throw new Error('页码必须为 1–15 的整数')
    if (['note_id', 'user_id'].includes(key) && !/^[0-9a-f]{24}$/i.test(value)) throw new Error(`${label}应为 24 位 ID`)
    body[key] = type === 'number' ? Number(value) : String(value).trim()
  }
  if (endpoint.oneOf && !endpoint.oneOf.some(key => body[key])) throw new Error('请填写 ID 或分享链接其中一项')
  return body
}

export function consoleRequestIdentity(endpoint, body) {
  return JSON.stringify([endpoint.id, Object.keys(body).sort().map(key => [key, body[key]])])
}
