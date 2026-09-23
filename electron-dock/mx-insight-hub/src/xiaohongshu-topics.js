export function xiaohongshuTopicHref(topic) {
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(topic)}`
}

// The body endpoint supplies structured tags when analytics omits them.
// Claim before dispatch: reopening, refresh and failed requests never repeat
// this supplemental call. Failed calls keep the existing explicit retry path.
export function claimNoteTagsRequest(saved, { payload, apiKey, resolveIssues }) {
  if (!apiKey.trim() || resolveIssues.length || !payload?.data?.item || payload.meta?.tagsAvailable === true
    || saved.tagsRequested || saved.result || saved.error || saved.identity) return false
  saved.tagsRequested = true
  return true
}
