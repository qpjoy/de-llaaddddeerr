// 站点范围: where the isolated browser may go, without an admin having to
// list every test site first.
//
// Two modes, set by the admin (`policy.browserSites`):
// - `ask` (the default): the admin's list is sites that need no question. Any
//   other site is asked about once, when the Agent first opens it, and the
//   member's yes holds for that mission. A site a person went to during
//   takeover counts as asked. A procedure a person saved carries its own
//   sites. Production hosts are never granted.
// - `list`: only the admin's list, as before.
//
// Either way the Agent's own destination is what is guarded. In `ask` mode a
// page's own requests (scripts, APIs on another domain, a login or captcha
// iframe, a WebSocket) are the page's behaviour and go through; only
// production hosts stay closed to them.

import { isProductionHost } from '../contracts/index.mjs'

export const SITE_MODES = Object.freeze(['ask', 'list'])

/** `https://host[:port]`, or null for anything that is not a plain web address. */
export function originOf(raw) {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

export function asks(policy) {
  return policy?.browserSites !== 'list'
}

export function isProduction(raw, policy) {
  try {
    return isProductionHost(new URL(raw).hostname, policy?.productionHosts ?? [])
  } catch {
    return false
  }
}

/**
 * The policy as one mission sees it: the admin's sites plus the ones its
 * member said yes to. In `list` mode grants do not exist.
 */
export function scopeSites(policy, granted = []) {
  if (!policy || !asks(policy) || !granted?.length) return policy
  const extra = granted.filter((origin) => originOf(origin) === origin && !isProduction(origin, policy))
  return { ...policy, browserOrigins: [...new Set([...(policy.browserOrigins ?? []), ...extra])] }
}

/**
 * What opening this address would take: nothing (already allowed), a yes from
 * the member for this mission, or it cannot happen at all.
 * @returns {{ status: 'allowed' | 'ask' | 'denied', origin: string|null, reason?: string }}
 */
export function siteDecision(raw, policy) {
  const origin = originOf(raw)
  if (!origin) return { status: 'denied', origin: null, reason: '只能打开 http / https 地址，且地址里不能带账号密码' }
  if (isProduction(raw, policy))
    return { status: 'denied', origin, reason: `${new URL(raw).hostname} 在生产环境禁区里，自动化不会打开它` }
  if ((policy?.browserOrigins ?? []).includes(origin)) return { status: 'allowed', origin }
  if (!asks(policy))
    return { status: 'denied', origin, reason: `${origin} 不在管理员允许的站点里（管理员设置为只允许列表内的站点）` }
  return { status: 'ask', origin }
}

/** The sites a saved procedure goes to: its base address and every page it opens. */
export function procedureSites(procedure) {
  const found = new Set()
  const add = (raw) => {
    const origin = originOf(raw)
    if (origin) found.add(origin)
  }
  if (procedure?.baseUrl) add(procedure.baseUrl)
  for (const step of procedure?.steps ?? []) {
    if (step?.do !== 'open' || typeof step.url !== 'string') continue
    if (/^https?:\/\//i.test(step.url)) add(step.url)
  }
  return [...found]
}
