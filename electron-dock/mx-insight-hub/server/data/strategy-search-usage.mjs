import { AppError } from '../core/errors.mjs'
import { strategySearchCatalog } from './strategy-search-catalog.mjs'

export const STRATEGY_SEARCH_USAGE_TIME_ZONE = 'Asia/Shanghai'
const DAY_MS = 86_400_000
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: STRATEGY_SEARCH_USAGE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})

export function strategySearchUsageDay(value) {
  return dayFormatter.format(new Date(value))
}

export function strategySearchUsageWindow(searchParams, now = new Date()) {
  if ([...searchParams.keys()].some(key => key !== 'days') || searchParams.getAll('days').length > 1) {
    throw new AppError(400, 'unsupported_fields', 'Only one days query field is supported')
  }
  const count = searchParams.get('days') ?? '7'
  if (!/^(?:[1-9]|[12]\d|3[01])$/u.test(count)) {
    throw new AppError(400, 'invalid_request', 'days must be an integer from 1 to 31')
  }
  const throughDay = strategySearchUsageDay(now)
  const today = new Date(`${throughDay}T00:00:00+08:00`).getTime()
  const from = new Date(today - (Number(count) - 1) * DAY_MS).toISOString()
  const days = Array.from({ length: Number(count) }, (_, index) => (
    strategySearchUsageDay(new Date(new Date(from).getTime() + index * DAY_MS))
  ))
  return {
    timeZone: STRATEGY_SEARCH_USAGE_TIME_ZONE, from, to: new Date(today + DAY_MS).toISOString(),
    fromDay: days[0], throughDay, days,
    paths: strategySearchCatalog().interfaces.flatMap(row => row.paths),
  }
}

function safeCount(value) {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new AppError(503, 'usage_aggregate_out_of_range', 'Recorded request count cannot be represented safely')
  }
  return count
}

export function strategySearchUsageResponse(window, rows) {
  const daily = () => window.days.map(day => ({ day, requests: 0, nightAllRequests: 0 }))
  const items = strategySearchCatalog().interfaces.flatMap(group => group.paths
    .filter(path => !path.startsWith('/api/v1/search/'))
    .map(path => ({
      interface: group.id, path,
      paths: path.startsWith('/api/v1/night-all/search/')
        ? [path.replace('/night-all/', '/'), path] : [path],
      total: 0, nightAllRequests: 0, daily: daily(), platforms: [],
    })))
  for (const row of rows) {
    const item = items.find(candidate => candidate.paths.includes(row.path))
    const day = item?.daily.find(candidate => candidate.day === row.day)
    if (!day) continue
    const requests = safeCount(row.requests)
    const nightAllRequests = safeCount(row.nightAllRequests)
    if (nightAllRequests > requests) {
      throw new AppError(503, 'usage_aggregate_invalid', 'Night-All evidence exceeds recorded requests')
    }
    const platformKey = row.platform ?? 'unspecified'
    let platform = item.platforms.find(candidate => candidate.platform === platformKey)
    if (!platform) {
      platform = { platform: platformKey, total: 0, nightAllRequests: 0, daily: daily() }
      item.platforms.push(platform)
    }
    const platformDay = platform.daily.find(candidate => candidate.day === row.day)
    for (const target of [item, platform]) {
      target.total = safeCount(target.total + requests)
      target.nightAllRequests = safeCount(target.nightAllRequests + nightAllRequests)
    }
    for (const target of [day, platformDay]) {
      target.requests = safeCount(target.requests + requests)
      target.nightAllRequests = safeCount(target.nightAllRequests + nightAllRequests)
    }
  }
  for (const item of items) item.platforms.sort((a, b) => a.platform.localeCompare(b.platform))
  return {
    timeZone: window.timeZone, fromDay: window.fromDay, throughDay: window.throughDay,
    days: window.days, metric: 'recorded_business_requests',
    notes: [
      '按 Asia/Shanghai 自然日及业务请求创建时间统计，包含今天尚未结束的部分；每条 usage_requests 记录计一次，幂等重放和预检失败不重复计入。',
      '路径来自已保存的逻辑请求合同；/search 与 /night-all/search 兼容别名合并，不能区分它们的 HTTP 访问次数。缺少已保存路径的历史记录不计入。',
      '微信的 data/search、/search/raw 与专项搜索入口均归一到 /api/v1/data/wechat/search/search，账本平台为 social；本统计不能区分三个实际入口或微信搜索、公众号别名。',
      'Night-All 请求数仅统计存在关联 connector_calls 的业务请求，多条调用证据仍计一次；历史 data/search 等缺少此证据，不能据此推断全部迁移情况或供应商派发次数。',
      '零值仅表示本区间没有匹配的已记录请求，不能单独作为停用接口的依据。',
    ],
    items,
  }
}
