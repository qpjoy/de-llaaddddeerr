export const SHARE_LINK_RESOLVER = Object.freeze({
  key: 'share-link-resolver',
  label: '分享链接解析',
  path: '/data-products/share-link-resolver',
  docs: 'share-link-resolver',
  apiPath: '/api/v1/data/share-links/resolve',
  platform: 'social',
  capability: 'social.share_links.resolve',
})

export const SHARE_LINK_LIMITS = Object.freeze({ maxTextLength: 16_384, maxLinks: 10 })
