export const DOUYIN_DETAIL_ENDPOINT = 't.api_ab9535a5f6389ce6'
export const DOUYIN_SHARE_CODE_ENDPOINT = 't.api_47a9cfa7c14880c8'

export function douyinDetailId(value) {
  return typeof value === 'string' && /^\d{15,25}$/u.test(value) ? value : null
}

export function xiaohongshuNoteUrl(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/iu.test(value)
    ? `https://www.xiaohongshu.com/explore/${value.toLowerCase()}` : null
}

export function shareLinkActions(result, access) {
  const { platform, postId } = result
  const granted = (domain, capability) => access === null || (access?.platforms?.includes(domain) && access?.capabilities?.includes(capability))
  if (!result.ok) {
    if (platform === 'douyin' && result.code === 'share_code_requires_lookup' && granted('social', `native.${DOUYIN_SHARE_CODE_ENDPOINT}`)) {
      return [{ label: '打开抖音口令查询', href: `#/data-products/social-content?endpoint=${DOUYIN_SHARE_CODE_ENDPOINT}`,
        hint: '进入后，把原口令填入 share_code，再手动发送。' }]
    }
    return []
  }
  const actions = []
  if (platform === 'douyin' && douyinDetailId(postId)) {
    if (granted('social', `native.${DOUYIN_DETAIL_ENDPOINT}`)) actions.push({
      label: '填写作品详情查询', href: `#/data-products/social-content?endpoint=${DOUYIN_DETAIL_ENDPOINT}&awemeId=${postId}`,
    })
  } else if (platform === 'xiaohongshu' && xiaohongshuNoteUrl(postId)) {
    if (granted(platform, 'social.posts.resolve')) actions.push({
      label: '填写笔记详情查询', href: `#/data-products/xiaohongshu-note?noteId=${postId}`,
    })
  } else return []
  if (granted(platform, 'social.comments.list')) actions.push({
    label: '填写评论查询', href: `#/data-products/strategy-search?view=product&interface=post-comments&platform=${platform}&contentId=${postId}`,
  })
  return actions
}
