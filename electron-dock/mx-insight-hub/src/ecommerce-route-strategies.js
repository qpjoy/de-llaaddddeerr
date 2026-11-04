export const ROUTE_PROVIDER_NAMES = Object.freeze({ justone: 'JustOne', tikhub: 'TikHub', rapidapi: 'RapidAPI' })
const providerName = provider => ROUTE_PROVIDER_NAMES[provider] || provider

// Every route a marketplace can take, spelled out: each supplier on its own,
// and every ordered primary -> backup pair. With JustOne and RapidAPI that is
// 固定 JustOne, 固定 RapidAPI, 优先 JustOne 失败切 RapidAPI, 优先 RapidAPI 失败切 JustOne.
export function routeStrategies(candidates = []) {
  return [
    ...candidates.map(candidate => ({ value: `fixed:${candidate.id}`, mode: 'fixed', adapterId: candidate.id,
      fallbackAdapterId: null, label: `固定 ${providerName(candidate.provider)}` })),
    ...candidates.flatMap(primary => candidates.filter(backup => backup.id !== primary.id).map(backup => ({
      value: `priority:${primary.id}>${backup.id}`, mode: 'priority', adapterId: primary.id, fallbackAdapterId: backup.id,
      label: `优先 ${providerName(primary.provider)}，失败切 ${providerName(backup.provider)}` }))),
  ]
}

// The strategy a saved route corresponds to, or null when it is not one of the
// marketplace's current options (an invalid or retired configuration).
export function currentRouteStrategy(row) {
  if (!row?.configurationValid || !row.defaultRoute) return null
  const value = row.mode === 'priority' && row.fallbackRoute
    ? `priority:${row.defaultRoute.id}>${row.fallbackRoute.id}` : `fixed:${row.defaultRoute.id}`
  return routeStrategies(row.candidates).find(strategy => strategy.value === value) ?? null
}

export function routeStrategyLabel(row) {
  if (!row?.defaultRoute) return ''
  return row.mode === 'priority' && row.fallbackRoute
    ? `优先 ${providerName(row.defaultRoute.provider)}，失败切 ${providerName(row.fallbackRoute.provider)}`
    : `固定 ${providerName(row.defaultRoute.provider)}`
}
