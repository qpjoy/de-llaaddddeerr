// Runs inside every store transaction, after the state transition (V2-5).
// Both outputs are insert-only, so per-device execution transactions write
// them without loading or locking client rows:
// - a client job that reached a final status appends an outcome usage row,
//   and one callback delivery (outbox) when the caller asked for one;
// - a session charged to a client that ended appends the difference between
//   its measured device time and the estimate charged at claim.
// The next realm-wide transaction folds usage rows into the client rows.
import { randomUUID } from "node:crypto";
import { resultCompletion } from "./job-result.mjs";

export const FINAL = new Set([
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
  "expired",
  "blocked",
  "skipped",
]);
// Session statuses that end a charge ("interrupted" requeues the job).
const SETTLED = new Set([...FINAL, "interrupted"]);
const loaded = (rows) => {
  try {
    return Array.isArray(rows) && rows.length >= 0 ? rows : null;
  } catch {
    return null; // an unloaded collection of a scoped transaction
  }
};
/** Statuses before the transition, for the collections this transaction loaded. */
export function priorStatuses(state) {
  const jobs = loaded(state.jobs),
    attempts = loaded(state.attempts);
  return {
    jobs: jobs && new Map(jobs.map((j) => [j.id, j.status])),
    attempts: attempts && new Map(attempts.map((a) => [a.id, a.status])),
  };
}
/** What a session cost in device time: nothing when it was handed back
 * before any command; else wall time on the device minus insertion detours. */
export function measuredMs(attempt, job) {
  if (
    ["expired", "blocked"].includes(attempt.status) &&
    attempt.dispatchedAt == null
  )
    return 0;
  const start = attempt.dispatchedAt ?? attempt.createdAt;
  const detour = attempt.loop === "large" ? job?.workflow?.detourMs || 0 : 0;
  return Math.max(0, (attempt.completedAt ?? start) - start - detour);
}
export function callbackPayload(job, deliveryId, now) {
  return {
    event: "job.finished",
    deliveryId,
    occurredAt: now,
    job: {
      jobId: job.id,
      clientRequestId: job.client.requestId,
      template: job.client.template,
      class: job.client.class,
      status: job.status,
      completion: resultCompletion(job),
      reason: job.reason || null,
      completedAt: job.completedAt ?? now,
      // Thin event: the receiver reads items from the Job API.
      links: { self: `/v1/jobs/${job.id}` },
    },
  };
}

export function settleClients(state, now, prior) {
  const outbox = [],
    usage = [];
  const jobs = prior.jobs && loaded(state.jobs);
  const attempts = prior.attempts && loaded(state.attempts);
  const jobById = jobs ? new Map(jobs.map((j) => [j.id, j])) : null;
  if (attempts)
    for (const a of attempts) {
      if (!a.charge || !SETTLED.has(a.status)) continue;
      const before = prior.attempts.get(a.id);
      if (before !== "running" && before !== "yielded") continue;
      const actualMs = measuredMs(a, jobById?.get(a.jobId));
      usage.push({
        mode: a.mode,
        clientId: a.charge.clientId,
        at: now,
        jobId: a.jobId,
        attemptId: a.id,
        class: a.charge.class,
        weight: a.charge.weight,
        actualMs,
        deltaMs: actualMs - a.charge.estimateMs,
      });
    }
  if (jobs)
    for (const j of jobs) {
      if (!j.client || !FINAL.has(j.status)) continue;
      const before = prior.jobs.get(j.id);
      if (before === undefined || FINAL.has(before)) continue;
      usage.push({
        mode: j.mode,
        clientId: j.client.id,
        at: now,
        jobId: j.id,
        outcome: j.status,
      });
      if (j.client.callbackUrl) {
        const id = randomUUID();
        outbox.push({
          id,
          mode: j.mode,
          clientId: j.client.id,
          jobId: j.id,
          event: "job.finished",
          status: "pending",
          attempts: 0,
          nextAt: now,
          lockedUntil: 0,
          createdAt: now,
          url: j.client.callbackUrl,
          payload: callbackPayload(j, id, now),
        });
      }
    }
  return { outbox, usage };
}
