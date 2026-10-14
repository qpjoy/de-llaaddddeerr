// These entries navigate to existing governed tools; they never grant access.
export const isProductAdmin = session => session?.kind === 'admin-token' && session.platformAdmin === true

export function productManagementLinks(path) {
  const links = []
  if (['/data-products/search', '/data-products/social-content'].includes(path)) links.push(['搜索策略与迁移状态', '#/data-products/strategy-search?view=routing', '按业务接口和平台查看当前路由与迁移进度。'])
  if (path.includes('wechat')) links.push(['微信服务运行配置', '#/external-platforms?provider=tikhub', '管理各微信接口的运行开关、凭据与调用证据。'])
  else if (path.includes('xiaohongshu')) links.push(['小红书服务运行配置', '#/data-platforms?platform=xiaohongshu', '查看业务接口、当前路由与独立操作状态。'])
  else if (path.endsWith('/enterprise')) links.push(['企业服务运行配置', '#/external-platforms?provider=qixin', '管理企业查询接口的运行状态与调用证据。'])
  else if (path.endsWith('/ecommerce-treasure-box')) links.push(['电商平台与默认路由', '#/data-platforms?domain=ecommerce', '查看各平台的适配接口和当前默认供应商。'])
  else if (path.endsWith('/news')) links.push(['新闻来源归类', '#/agent/catalog-classifier', '审核来源绑定和归类建议。'])
  else if (path.endsWith('/virtual-supermarket')) links.push(['商品上架与目录', '#/data-products/virtual-supermarket?view=demo&mode=catalog', '在产品展示中的目录模式管理现有商品上架记录。'])
  links.push(['数据与来源', '#/data-center', '浏览已收录数据、版本与来源证据。'],
    ['服务授权', '#/platforms', '管理调用者和 Key 的明确授权。'],
    ['使用记录', '#/usage', '核对请求状态、计量与账单证据。'])
  return links.map(([label, href, description]) => ({ label, href, description }))
}
