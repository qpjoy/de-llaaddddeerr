// One error code per quota layer.
//
// All five layers used to report `quota_exceeded`, which told a caller only
// "some limit stopped you" -- the layer lived in `details.limitScope`, which
// most clients never read. The layers need different responses: a consumer or
// key window recovers on its own, a plan month does not, and a burst limit
// means slow down rather than wait. Naming them in the code makes that
// difference visible at the point a caller actually branches.
//
// `limitScope` stays in details unchanged, so anything already reading it
// keeps working.
export const QUOTA_EXCEEDED_CODES = Object.freeze({
  consumer: 'consumer_quota_exceeded',
  api_key: 'api_key_quota_exceeded',
  plan_window: 'plan_window_quota_exceeded',
  plan_month: 'plan_month_quota_exceeded',
  plan_burst: 'plan_burst_exceeded',
})

// Every 429 a quota check can produce. Endpoint declarations spread this rather
// than listing the codes, so adding a layer cannot leave a published contract
// behind.
export const QUOTA_429_CODES = Object.freeze(Object.values(QUOTA_EXCEEDED_CODES))

export function quotaExceededCode(limitScope) {
  return QUOTA_EXCEEDED_CODES[limitScope] || 'quota_exceeded'
}
