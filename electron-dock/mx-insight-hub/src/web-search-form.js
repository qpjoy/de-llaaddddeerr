// Keep the form aligned with the public contract; the server remains authoritative.
export const SEARCH_RESOURCE_LABELS = { web: '网页', image: '图片', video: '视频' }
export const SEARCH_RESOURCE_MAX = { web: 50, image: 30, video: 10 }
export function buildWebSearchBody(form) {
  const query = form.query.trim()
  if (!query || query.length > 2000 || query.includes('\0')) throw Error('请输入 1–2000 字的问题或关键词。')
  const resources = Object.keys(SEARCH_RESOURCE_LABELS).filter(type => form.types.includes(type)).map(type => ({ type, limit: Number(form.limits[type]) })).sort((a, b) => a.type.localeCompare(b.type))
  if (!resources.length) throw Error('请至少选择一种搜索资源。')
  if (resources.some(row => !Number.isInteger(row.limit) || row.limit < 1 || row.limit > SEARCH_RESOURCE_MAX[row.type])) throw Error('结果数量超出支持范围，请检查更多筛选。')
  const sites = [...new Set(form.sites.split(/[\s,，]+/).filter(Boolean).map(site => site.toLowerCase()))].sort()
  if (sites.length > 20 || sites.some(site => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(site))) throw Error('站点请填写域名（如 example.com），最多 20 个，不含 https:// 或路径。')
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  if ((form.from || form.to) && (!date(form.from) || !date(form.to) || form.from > form.to)) throw Error('请填写有效的开始和结束日期，开始日期不能晚于结束日期。')
  if (form.recency && form.from) throw Error('时间范围与自定义日期只能选择一种。')
  if ((sites.length || form.from || form.recency) && !form.types.includes('web')) throw Error('站点和日期筛选需要同时选择网页。')
  return { query, ...(form.provider ? { provider: form.provider } : {}), resources, edition: form.edition,
    ...(sites.length ? { sites } : {}), ...(form.from ? { from: form.from, to: form.to } : {}), ...(form.recency ? { recency: form.recency } : {}) }
}
export function matchingSearchProviders(providers, body) {
  if (!body) return []
  return providers.filter(provider => (!body.provider || provider.key === body.provider) &&
    body.resources.every(row => provider.resources.includes(row.type) && row.limit <= (row.type === 'web' ? provider.maxResults : SEARCH_RESOURCE_MAX[row.type])) &&
    (provider.key === 'baidu' || (!body.sites?.length && !body.from && !body.recency && body.edition === 'standard')))
}
