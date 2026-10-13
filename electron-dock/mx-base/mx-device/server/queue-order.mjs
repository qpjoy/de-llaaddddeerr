import { AGING_INTERVAL_MS, estimatedDuration } from "./task-contract.mjs";
export const effectivePriority = (job, now) =>
  Math.max(
    1,
    job.priority -
      Math.floor(Math.max(0, now - job.createdAt) / AGING_INTERVAL_MS),
  );
export const compareJobs = (now) => (a, b) => {
  const priority = effectivePriority(a, now) - effectivePriority(b, now);
  if (priority) return priority;
  if (Math.max(now - a.createdAt, now - b.createdAt) >= AGING_INTERVAL_MS)
    return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  return (
    estimatedDuration(a) - estimatedDuration(b) ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
};
