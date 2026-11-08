// Reviewed supplier catalog for the two comment business interfaces. Request
// recipes, Strategy Search routing policies, Admin editors and API docs all
// read this one table, so a supplier can never be selectable in one place and
// missing from another.
//
// Verification levels (strongest first):
// - verified: a saved paid page from this supplier passed this parser;
// - sample:   calibrated from the supplier's official free documentation sample;
// - derived:  the supplier relays the same platform-native page as an already
//             calibrated parser; enabled, and the first production page must be
//             inspected with server/ops/inspect-post-comment-contract.mjs;
// - pending:  the request contract is reviewed but the response layout is not.
//             Never dispatched: requests fail before any supplier call.
export const COMMENT_INTERFACES = Object.freeze(['post-comments', 'comment-replies'])
export const COMMENT_VERIFICATION_LEVELS = Object.freeze(['verified', 'sample', 'derived', 'pending'])
export const COMMENT_TARGET_PLATFORMS = Object.freeze(['twitter', 'reddit', 'xiaohongshu', 'weibo', 'instagram',
  'douyin', 'bilibili', 'kuaishou', 'zhihu'])

const freeze = rows => Object.freeze(Object.fromEntries(Object.entries(rows)
  .map(([platform, providers]) => [platform, Object.freeze({ ...providers })])))

export const COMMENT_PROVIDER_CATALOG = Object.freeze({
  'post-comments': freeze({
    twitter: { tikhub: 'verified', justone: 'sample' },
    reddit: { tikhub: 'verified', justone: 'sample' },
    kuaishou: { tikhub: 'verified', justone: 'sample' },
    instagram: { tikhub: 'verified' },
    weibo: { tikhub: 'verified', justone: 'sample' },
    douyin: { tikhub: 'verified', justone: 'sample' },
    tiktok: { justone: 'sample' },
    zhihu: { tikhub: 'derived', justone: 'sample' },
    linkedin: { justone: 'sample' },
    bilibili: { justone: 'sample', tikhub: 'derived' },
    facebook: { justone: 'sample' },
    xiaohongshu: { tikhub: 'verified' },
    youtube: { tikhub: 'verified' },
  }),
  'comment-replies': freeze({
    // Live paid samples 2026-11-07 (see comment-reply-projection.mjs header).
    twitter: { tikhub: 'verified' },
    douyin: { tikhub: 'verified' },
    kuaishou: { tikhub: 'verified' },
    bilibili: { tikhub: 'verified' },
    instagram: { tikhub: 'verified' },
    reddit: { tikhub: 'derived' },
    weibo: { tikhub: 'derived' },
    xiaohongshu: { tikhub: 'derived' },
    zhihu: { tikhub: 'derived' },
  }),
})

// Reply suppliers that also need the comment's post (see comment-replies.mjs).
export const COMMENT_REPLY_CONTENT_REQUIRED = Object.freeze(['reddit', 'xiaohongshu', 'instagram', 'douyin', 'bilibili', 'kuaishou'])

// Preference used for the deployment default: the main suppliers first and
// JustOne as the guarantee where it is registered.
const PREFERENCE = ['tikhub', 'rapidapi', 'justone']

export const commentProviders = (interfaceId, platform) => COMMENT_PROVIDER_CATALOG[interfaceId]?.[platform] || null
export const commentRoutePlatforms = interfaceId => Object.keys(COMMENT_PROVIDER_CATALOG[interfaceId] || {})
export const commentProviderAvailable = (interfaceId, platform, provider) => {
  const level = commentProviders(interfaceId, platform)?.[provider]
  return Boolean(level) && level !== 'pending'
}

// Reviewed exceptions to the preference order. Bilibili's TikHub comment list
// returned only 3 rows on page 1 of 240,390 (live, 2026-11-07), so its full
// JustOne cursor list stays the default; TikHub remains selectable in Admin.
const DEFAULT_OVERRIDES = Object.freeze({ 'post-comments/bilibili': Object.freeze({ mode: 'fixed', primaryProvider: 'justone', fallbackProvider: null }) })

export function defaultCommentRoute(interfaceId, platform) {
  const providers = commentProviders(interfaceId, platform)
  if (!providers) return null
  const override = DEFAULT_OVERRIDES[`${interfaceId}/${platform}`]
  if (override) return { ...override }
  const ordered = PREFERENCE.filter(provider => Object.hasOwn(providers, provider))
  const available = ordered.filter(provider => providers[provider] !== 'pending')
  const primary = available[0] || ordered[0]
  const fallback = available.find(provider => provider !== primary) || null
  return { mode: fallback ? 'priority' : 'fixed', primaryProvider: primary, fallbackProvider: fallback }
}
