// Event timeline retention. Events are the UI timeline/audit trail; Job, Attempt,
// command receipts and late evidence live in their own tables and are not pruned.
// The newest keepLatest events per realm are always kept, whatever their age.
export const DEFAULT_EVENT_RETENTION = Object.freeze({
  simDays: 7,
  realDays: 90,
  keepLatest: 1000,
});
const LIMITS = {
  simDays: [1, 3650],
  realDays: [1, 3650],
  keepLatest: [100, 1000000],
};
export function eventRetention(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("eventRetention 须为对象");
  for (const key of Object.keys(input))
    if (!Object.hasOwn(LIMITS, key)) throw Error(`eventRetention.${key} 未知`);
  const r = { ...DEFAULT_EVENT_RETENTION, ...input };
  for (const [key, [min, max]] of Object.entries(LIMITS))
    if (!Number.isInteger(r[key]) || r[key] < min || r[key] > max)
      throw Error(`eventRetention.${key} 须为 ${min}–${max} 的整数`);
  return {
    ...r,
    retentionMs: { sim: r.simDays * 86400000, real: r.realDays * 86400000 },
  };
}
