import {
  AGING_INTERVAL_MS,
  MAX_AGING_BOOST,
  STARVATION_MS,
  estimatedDuration,
} from "./task-contract.mjs";
export const starved = (job, now) => now - job.createdAt >= STARVATION_MS;
export const effectivePriority = (job, now) =>
  starved(job, now)
    ? 1
    : Math.max(
        1,
        job.priority -
          Math.min(
            MAX_AGING_BOOST,
            Math.floor(Math.max(0, now - job.createdAt) / AGING_INTERVAL_MS),
          ),
      );
// Within one effective priority, jobs waiting at least one aging interval are
// FIFO and come first (they are older than every fresh job); fresh jobs are
// shortest-first. This keeps the comparator a consistent total order.
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
