const LABELS = {
  'social.posts.search': '笔记搜索',
  'social.posts.resolve': '笔记详情',
  'social.users.resolve': '用户资料',
  'social.users.posts': '用户笔记',
  'compat.xiaohongshu.app_v2': '小红书 App V2 接口',
}

// Diagnose each operation independently: paused user posts must not block search.
export function demoAccessIssues(access, operation, compatibility = false) {
  if (!access) return [] // Manual admin keys remain server-validated.
  const issues = []
  if (!access.platforms?.includes('xiaohongshu')) {
    issues.push({ kind: 'authorization', scope: 'xiaohongshu', message:
      access.consumerPlatforms?.includes('xiaohongshu')
        ? '当前 Key 未包含小红书数据授权。请切换已授权 Key，或创建包含小红书的新 Key。'
        : '当前业务尚未开通小红书数据，请联系管理员开通。' })
  }
  for (const scope of [operation, ...(compatibility ? ['compat.xiaohongshu.app_v2'] : [])]) {
    if (access.capabilities?.includes(scope)) continue
    issues.push({ kind: 'authorization', scope, message: access.consumerCapabilities?.includes(scope)
      ? `当前 Key 未包含${LABELS[scope] || scope}授权。请在新 Key 中勾选此项。`
      : `当前业务尚未开通${LABELS[scope] || scope}，请联系管理员。` })
  }
  if (access.operations?.[operation]?.ready === false) {
    issues.push({ kind: 'runtime', scope: operation, message: `${LABELS[operation] || operation}服务暂不可用，请联系管理员恢复。其他已开通服务不受影响。` })
  }
  return issues
}
