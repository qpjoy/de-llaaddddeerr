// Presentation adapters never rewrite the archived acquisition.
export function storedNote(row) {
  const fields = row.stableFields || {}
  const metrics = fields.metrics || row.metrics || {}
  return {
    id: row.id, externalId: row.externalId, platform: 'xiaohongshu',
    title: row.title, text: row.body, url: row.url,
    author: { id: row.authorExternalId, name: row.authorName },
    tags: fields.tags || [],
    media: fields.media?.items || (fields.media?.images || []).map(url => ({ type: 'image', url })),
    metrics: { liked: metrics.likes, collected: metrics.bookmarks, comments: metrics.comments, shared: metrics.shares },
    publishedAt: row.eventTime, collectedAt: row.collectedAt,
    bodyCompleteness: row.extensions?.bodyCompleteness || 'unverified_complete',
  }
}

export function nativeNote(note) {
  const externalId = note.note_id || note.id
  if (typeof externalId !== 'string' || !/^[0-9a-f]{24}$/i.test(externalId)) throw new Error('上游笔记缺少有效 ID')
  const images = note.image_list || note.images || []
  return {
    id: `xiaohongshu:${externalId}`, externalId, platform: 'xiaohongshu',
    title: note.display_title || note.title, text: note.desc || '',
    url: `https://www.xiaohongshu.com/explore/${externalId}`,
    author: { id: note.user?.user_id, name: note.user?.nickname },
    tags: (note.tag_list || note.tags || []).map(tag => typeof tag === 'string' ? tag : tag.name).filter(Boolean),
    media: images.map(image => ({ type: 'image', url: typeof image === 'string' ? image : image.url_default || image.url || image.info_list?.[0]?.url })).filter(image => image.url),
    metrics: {}, bodyCompleteness: 'provider_preview',
  }
}

export function nativeNotePage(payload, endpoint, request) {
  const outer = payload?.data
  const inner = outer?.data
  const search = endpoint === 'search_notes'
  const entries = search ? inner?.items : inner?.notes
  if (payload?.code !== 200 || !Array.isArray(entries)) throw new Error('上游列表格式不匹配；未将错误响应当作空列表')
  const notes = search ? entries.filter(entry => entry.model_type === 'note' || entry.note).map(entry => entry.note) : entries
  const items = notes.map(nativeNote)
  let next = null
  if (search) {
    const states = [outer.has_more, inner.has_more, outer.hasMore, inner.hasMore].filter(value => value != null)
    const flags = states.map(value => {
      if ([true, 1, '1', 'true'].includes(value)) return true
      if ([false, 0, '0', 'false'].includes(value)) return false
      throw new Error('上游分页状态不明确')
    })
    if (new Set(flags).size > 1) throw new Error('上游分页状态冲突')
    const page = Number(request.page || 1)
    const nextPages = [inner.next_page, outer.next_page, inner.nextPage, outer.nextPage].filter(value => value != null)
    const nextFlags = nextPages.map(value => {
      if ([false, 0, '0', ''].includes(value)) return false
      if (value === true || Number(value) === page + 1) return true
      throw new Error('上游下一页未正确前进')
    })
    if (new Set([...flags, ...nextFlags]).size > 1) throw new Error('上游分页状态冲突')
    const hasMore = flags[0] ?? nextFlags[0] ?? null
    if (hasMore == null && entries.length) throw new Error('上游未提供续页信息')
    if (hasMore && !entries.length) throw new Error('上游空页不能继续分页')
    if (hasMore && Number(request.page || 1) < 15) {
      next = { ...request, page: Number(request.page || 1) + 1 }
      for (const field of ['search_id', 'search_session_id']) {
        if (inner[field] != null && outer[field] != null && inner[field] !== outer[field]) throw new Error('上游搜索会话冲突')
        const value = inner[field] ?? outer[field]
        if (value) next[field] = value
      }
    }
  } else {
    const cursors = [inner.cursor, outer.cursor, inner.next_cursor, outer.next_cursor, entries.at(-1)?.cursor].filter(Boolean)
    if (new Set(cursors).size > 1) throw new Error('上游用户笔记续页信息冲突')
    if (cursors[0]) {
      if (!cursors[0].startsWith('mxec2.')) throw new Error('未收到 Hub 签发的用户笔记游标')
      next = { ...request, cursor: cursors[0] }
    }
  }
  return { items, next }
}

export function mergeNotes(first, second) {
  const seen = new Set()
  return [...first, ...second].filter(item => {
    const id = item.externalId || item.id
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
