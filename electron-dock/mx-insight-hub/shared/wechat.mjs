import services from './wechat-services.json' with { type: 'json' }
export const WECHAT_SERVICES = services
export const WECHAT_PRODUCTS = [
  { key: 'wechat-mp', label: '微信公众号', group: 'mp', catalogKeys: ['source-catalog-0025'], description: '文章正文、账号、互动与评论' },
  { key: 'wechat-channels', label: '微信视频号', group: 'channels', catalogKeys: ['source-catalog-0003'], description: '账号、作品、合集与直播' },
  { key: 'wechat-search', label: '微信搜一搜', group: 'search', catalogKeys: ['source-catalog-0026'], description: '公众号、文章与视频检索' },
]
export const wechatProduct = key => WECHAT_PRODUCTS.find(product => product.key === key)
export const wechatServiceProduct = key => WECHAT_PRODUCTS.find(product => key.startsWith(`wechat.${product.group}.`) || product.group === 'mp' && key.startsWith('wechat.demo.'))
export const wechatServices = product => services.filter(row => wechatServiceProduct(row.key)?.key === product.key)
