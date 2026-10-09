// Shared pure task metadata. Estimates are ranking hints, never execution deadlines.
export const EXECUTION_MODEL = "exclusive-session.v1";
export const AGING_INTERVAL_MS = 30000;
export const SHORT_TASK_MS = 15000;
export const defaultDurationMs = (operation, pages = 1) =>
  operation === "search" ? 15000 + Math.max(0, pages - 1) * 10000 : 20000;
export const estimatedDuration = (job) =>
  job.estimatedDurationMs ?? defaultDurationMs(job.operation, job.input?.pages);
export const taskLane = (job) =>
  estimatedDuration(job) <= SHORT_TASK_MS ? "short" : "long";
