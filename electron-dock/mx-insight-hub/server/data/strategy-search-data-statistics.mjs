import { AppError } from '../core/errors.mjs'
import { strategySearchCatalog } from './strategy-search-catalog.mjs'

export const STRATEGY_DATA_METRICS = ['newObjects', 'updatedObjects', 'contentRevisions', 'observations', 'observedObjects']
export const STRATEGY_DATA_CONNECTORS = ['night-all', 'night-all-legacy',
  'external-platform:tikhub', 'external-platform:justone', 'external-platform:rapidapi']
const platforms = [...new Set([...strategySearchCatalog().interfaces.flatMap(row => row.platforms.map(item => item.platform)), 'social'])]
export const STRATEGY_DATA_STREAMS = platforms.flatMap(platform => [
  `${platform}.search_posts.v1`, `${platform}.night-all-compat.v1`, `${platform}.external-platform.v1`,
])

function counters(row = {}) {
  return Object.fromEntries(STRATEGY_DATA_METRICS.map(key => {
    const value = Number(row[key] ?? 0)
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AppError(503, 'usage_aggregate_out_of_range', 'Stored data count cannot be represented safely')
    }
    return [key, value]
  }))
}

export function strategySearchDataStatisticsResponse(window, result) {
  const rows = result.rows || []
  const groups = rows.filter(row => row.level === 'total')
  return {
    available: result.available !== false,
    ...(result.reason ? { reason: result.reason } : {}),
    timeZone: window.timeZone, fromDay: window.fromDay, throughDay: window.throughDay, days: window.days,
    summary: result.available === false ? null : counters(rows.find(row => row.level === 'summary')),
    items: groups.map(group => ({
      interface: group.interface, platform: group.platform, objectType: group.objectType,
      total: counters(group),
      daily: window.days.map(day => ({ day, ...counters(rows.find(row => row.level === 'daily'
        && row.interface === group.interface && row.platform === group.platform && row.objectType === group.objectType && row.day === day)) })),
    })),
    processing: { available: false, reason: '本接口未统计入库队列积压或失败任务；已返回交付不代表异步入库完成，请在数据清洗中心核对任务。' },
    notes: [
      '按 Asia/Shanghai 的实际 Hub 入库日统计（ingest_runs.started_at），不是接口调用日、原文发布日期或 Night-All 数据库新增量；今日尚未结束。',
      '这是有入库链路证据的子集：包括 Night-All 兼容交付、已有 Hub 直连 data/search/raw 及小红书已接入的账号链路；标准 data/search 使用 search_posts 或 external-platform 入库流。Twitter 专用 /data/social/* 与微信原生转发当前明确 skipIngest，不在本看板覆盖范围，不能将其缺席解释为新增量为零。',
      '新增对象只计首版归属创建 run，且首次入库、首版与该 run 的创建时间精确匹配的 canonical 对象；重复观察仍为第 1 版时不算新增。对象身份包含 dataset、platform、objectType、externalId，不等于跨数据集去重的真实内容数。',
      '更新对象为新写入第 2 版及以后内容版本的唯一对象；内容版本为这些版本条数。指标变化或重新观察不一定产生内容版本，新增与更新对象可以在同一窗口同时出现。',
      '观测条数为已保存 observations，观察对象按 canonical ID 去重。summary 与各项 total 的对象数为整个窗口去重，daily 为当天去重，不能把每日或各接口对象数相加重建全局唯一数。',
      '仅纳入有已保存策略接口路径、完整 request→ingest_run→observation 链路和已完成入库 run 的记录；没有 canonical 入库的微信原生转发、缺失旧链路或观察的结果不在统计中。旧 canonical_revision 缺失时不猜测内容更新。',
      '接口按保存的逻辑合同归属，兼容别名已合并；零值不代表上游没有返回、没有持久化或旧 URL 可退役。统计读取不会触发采集、补入库或修改历史。',
    ],
  }
}
