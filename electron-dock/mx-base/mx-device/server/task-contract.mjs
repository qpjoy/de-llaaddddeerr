// Shared pure task metadata. Estimates are ranking hints, never execution deadlines.
export const EXECUTION_MODEL = "exclusive-session.v1";
export const AGING_INTERVAL_MS = 30000;
// Aging lifts a job at most MAX_AGING_BOOST levels, so priority still separates
// work during a backlog instead of collapsing everything to 1 after ~4 minutes.
// STARVATION_MS bounds waiting: older jobs are served first, FIFO. A backlog that
// keeps every job past this bound is a capacity problem for admission control.
export const MAX_AGING_BOOST = 3;
export const STARVATION_MS = 300000;
export const SHORT_TASK_MS = 15000;
export const defaultDurationMs = (operation, pages = 1) =>
  operation === "search" ? 15000 + Math.max(0, pages - 1) * 10000 : 20000;
export const estimatedDuration = (job) =>
  job.estimatedDurationMs ?? defaultDurationMs(job.operation, job.input?.pages);
export const taskLane = (job) =>
  estimatedDuration(job) <= SHORT_TASK_MS ? "short" : "long";
