// "Can this key work right now, and if not, what should be raised."
//
// A rejected call has three separable causes -- a spent quota window, a blocked
// provider operation and an expired key -- and each has a different owner and a
// different fix, so they are reported as separate issues rather than collapsed
// into one red dot. Every issue carries the action its owner would take.
//
// Evidence is optional on purpose. The key list knows only the key itself; the
// overview request adds quota and operation readiness. Calling this with no
// overview yields the same rule evaluated against less evidence, so the list
// and the drawer can never disagree about the part they both can see.

const DEFAULT_OPERATION_LABEL = (operationKey) => operationKey
// An authorization scope is shown to people beside the same scope rendered by
// the rest of the page, so the caller supplies one naming of it rather than the
// rule inventing a second.
const DEFAULT_SCOPE_LABEL = (entry) => entry.scope

// Rotation should start before the key stops working, not after.
const EXPIRY_WARNING_DAYS = 14
// A window this close to spent will bite during the next traffic spike.
const QUOTA_WARNING_RATIO = 0.1

export function apiKeyHealth(key, overview, {
  operationLabel = DEFAULT_OPERATION_LABEL,
  scopeLabel = DEFAULT_SCOPE_LABEL,
} = {}) {
  const issues = []
  const status = key?.effectiveStatus || key?.status

  if (status === 'expired') {
    issues.push({ level: 'blocked', text: 'Key 已过期', action: '轮换一把新 Key' })
  } else if (status === 'revoked') {
    issues.push({ level: 'blocked', text: 'Key 已撤销', action: '签发替代 Key' })
  } else if (key?.expiresAt) {
    const daysLeft = Math.floor((new Date(key.expiresAt).getTime() - Date.now()) / 86_400_000)
    if (Number.isFinite(daysLeft) && daysLeft <= EXPIRY_WARNING_DAYS) {
      issues.push({ level: 'warn', text: `${Math.max(0, daysLeft)} 天后过期`, action: '提前轮换' })
    }
  }

  for (const entry of overview?.quota || []) {
    const { binding } = entry
    if (!binding) continue
    if (binding.remaining === 0) {
      issues.push({
        level: 'blocked',
        text: `${scopeLabel(entry)} 窗口额度已用完`,
        action: binding.limitScope === 'api_key'
          ? '调整这把 Key 的额度或换一把'
          : '调整调用者额度或等窗口恢复',
      })
    } else if (binding.limit > 0 && binding.remaining / binding.limit <= QUOTA_WARNING_RATIO) {
      issues.push({
        level: 'warn',
        text: `${scopeLabel(entry)} 窗口额度剩余 ${binding.remaining}/${binding.limit}`,
        action: '窗口恢复后自动缓解',
      })
    }
  }

  // A blocked operation is not the key's fault and the tenant cannot fix it,
  // so it is named as an operator action rather than as a key problem.
  for (const entry of overview?.blockedOperations || []) {
    issues.push({
      level: 'blocked',
      text: `${operationLabel(entry.operation)} 当前不可调用`,
      action: entry.effectiveState === 'blocked'
        ? '由管理员检查上游前置条件'
        : `运行状态：${entry.effectiveState}`,
    })
  }

  return {
    issues,
    level: issues.some((issue) => issue.level === 'blocked')
      ? 'blocked'
      : issues.length > 0 ? 'warn' : 'healthy',
  }
}

// The shared layer: what is true for every key under one consumer.
//
// Kept separate from apiKeyHealth because the audience and the fix differ. A
// blocked operation or a spent consumer window rejects every key alike, so
// naming a key here would send someone to rotate a credential that was never
// the problem.
export function consumerHealth(health, {
  operationLabel = DEFAULT_OPERATION_LABEL,
  scopeLabel = DEFAULT_SCOPE_LABEL,
} = {}) {
  const issues = []

  // Reported first and on its own: when a tenant is suspended, every other
  // number on the page is still true and still irrelevant, because nothing
  // under it can call at all.
  if (health?.tenant?.status === 'suspended') {
    issues.push({
      level: 'blocked',
      text: '租户已停用',
      detail: '该租户下所有调用者的全部 Key 都会被拒绝；额度与用量记录保持不变。',
      action: '由管理员在“调用者”页恢复该租户',
    })
  }

  for (const entry of health?.blockedOperations || []) {
    issues.push({
      level: 'blocked',
      text: `${operationLabel(entry.operation)} 当前不可调用`,
      detail: '该调用者的所有 Key 都会被拒绝，与 Key 本身无关。',
      action: entry.effectiveState === 'blocked'
        ? '由管理员在“开放能力”检查上游前置条件'
        : `运行状态：${entry.effectiveState}`,
    })
  }

  for (const entry of health?.quota || []) {
    if (entry.remaining === 0) {
      issues.push({
        level: 'blocked',
        text: `${scopeLabel(entry)} 共享额度已用完`,
        detail: `${entry.used}/${entry.limit}，窗口 ${entry.windowSeconds} 秒。`,
        action: '提高该调用者额度，或等窗口滚动恢复',
      })
    } else if (entry.limit > 0 && entry.remaining / entry.limit <= QUOTA_WARNING_RATIO) {
      issues.push({
        level: 'warn',
        text: `${scopeLabel(entry)} 共享额度剩余 ${entry.remaining}/${entry.limit}`,
        detail: `窗口 ${entry.windowSeconds} 秒，由该调用者下所有 Key 共用。`,
        action: '窗口恢复后自动缓解；持续贴顶应提高额度',
      })
    }
  }

  const keys = health?.keys
  if (keys?.expiringSoon > 0) {
    issues.push({
      level: 'warn',
      text: `${keys.expiringSoon} 把 Key 即将过期`,
      detail: `共 ${keys.total} 把，其中 ${keys.active} 把可用。`,
      action: '提前签发替代 Key 并完成客户端切换',
    })
  }

  return {
    issues,
    level: issues.some((issue) => issue.level === 'blocked')
      ? 'blocked'
      : issues.length > 0 ? 'warn' : 'healthy',
  }
}
