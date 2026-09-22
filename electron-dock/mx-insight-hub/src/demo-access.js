const LABELS = {
  'social.posts.analytics': '详情与阅读量',
  'social.comments.list': '笔记评论',
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
        ? '当前 Key 未包含小红书数据授权。请在 API Keys 中调整当前 Key 的权限，或切换已授权 Key，然后重新检查。'
        : '当前业务尚未开通小红书数据，请联系管理员开通。' })
  }
  for (const scope of [operation, ...(compatibility ? ['compat.xiaohongshu.app_v2'] : [])]) {
    if (access.capabilities?.includes(scope)) continue
    issues.push({ kind: 'authorization', scope, message: access.consumerCapabilities?.includes(scope)
      ? `业务已开通${LABELS[scope] || scope}，但当前 Key 未包含该权限。请在 API Keys 中调整当前 Key 的权限，或切换已授权 Key，然后重新检查。`
      : `当前业务尚未开通${LABELS[scope] || scope}，请联系管理员。` })
  }
  if (access.operations?.[operation]?.ready === false) {
    const state = access.operations[operation].effectiveState
    const reason = { disabled: '运行开关关闭', paused: '服务已暂停', blocked: '运行前置条件未满足', shadow: '当前仅处于校验状态', canary: '当前调用者未进入灰度范围' }[state] || '服务暂不可用'
    issues.push({ kind: 'runtime', scope: operation, message: `${LABELS[operation] || operation}：${reason}。业务授权、Key 权限和运行配置独立，请联系管理员处理。其他已开通服务不受影响。` })
  }
  return issues
}

// Provider credentials do not authorize a consumer or expand an existing Key snapshot.
export function ipRiskAccessIssues(access) {
  if (!access) return []
  const issues = []
  for (const [field, consumerField, scope, label] of [
    ['platforms', 'consumerPlatforms', 'ip_risk', 'IP 风险画像数据域'],
    ['capabilities', 'consumerCapabilities', 'ip.risk.query', 'IP 风险查询能力'],
  ]) {
    if (access[field]?.includes(scope)) continue
    issues.push({ kind: 'authorization', scope, message: access[consumerField]?.includes(scope)
      ? `业务已开通${label}，但当前 Hub Key 未包含该权限。请在 API Keys 中调整此 Key 的权限，或切换已授权 Key，然后重新检查。`
      : `当前 Key 所属业务尚未开通${label}。请在开放能力中为该业务开通，然后重新检查。` })
  }
  return issues
}
