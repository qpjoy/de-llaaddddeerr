// Caller fairness (V2-5, plan §6.3): weighted fair share between clients after
// Linux EEVDF, priority classes with one-step aging and a batch floor.
//
// Each client c has a weight w_c and a virtual runtime V_c (weighted device
// time it has received). A claim charges V_c += est/w_c; when the session ends
// the difference to the measured device time is appended as a usage row and
// folded into V_c by the next realm-wide transaction. The system virtual time
// V is the weighted average of V_c over clients with work waiting. A client
// that becomes active again starts at max(V_c, V), so idle time banks no
// credit. Within one level the queue is a merge: the next job comes from the
// eligible client (V_c <= V + LAG_LIMIT_MS) whose head job has the smallest
// virtual deadline V_c + est/w_c. Inside a client: earliest deadline, then
// shortest, then first come.
//
// Jobs without a client (admin console, demos) form one participant pinned to
// V with weight 1, ordered exactly as before; with no client jobs in the queue
// the order is unchanged.
import { compareJobs, effectivePriority } from "./queue-order.mjs";
import { estimatedDuration } from "./task-contract.mjs";

export const CLASSES = ["interactive", "standard", "batch"];
export const CLASS_NAMES = {
  interactive: "交互",
  standard: "标准",
  batch: "批量",
};
// Strict between classes; mapped onto the existing 1–9 scale.
export const CLASS_PRIORITY = { interactive: 2, standard: 5, batch: 8 };
// Waiting longer than its class's maxWait lifts a job one class, once.
export const CLASS_MAX_WAIT_MS = {
  interactive: 30000,
  standard: 120000,
  batch: 600000,
};
const LIFT = { interactive: 1, standard: 2, batch: 5 };
// Batch keeps at least this share of client device time (decayed service).
export const BATCH_FLOOR = 0.1;
export const SERVICE_HALF_LIFE_MS = 300000;
// Below this much recent service the shares are noise; no floor lift.
const FLOOR_MIN_SERVICE_MS = 60000;
export const LAG_LIMIT_MS = 120000;
const INTERNAL = "\u0000internal";

export const decayed = (value, at, now) =>
  !value
    ? 0
    : value * 2 ** (-Math.max(0, now - (at ?? now)) / SERVICE_HALF_LIFE_MS);
const emptyService = () => ({ interactive: 0, standard: 0, batch: 0 });
export function freshFair() {
  return { vruntime: 0, service: emptyService(), serviceAt: null };
}
/** Decays a client's per-class service to now (in place). */
function decayService(fair, now) {
  for (const k of CLASSES)
    fair.service[k] = decayed(fair.service[k], fair.serviceAt, now);
  fair.serviceAt = now;
}

const clientRows = (state) => state.clients || [];
const isActive = (j) => j.status === "queued" || j.status === "running";
/** System virtual time: weighted average of V_c over clients with queued
 * work (all clients with live work when nothing is queued). */
export function systemVirtualTime(state, { exclude = null } = {}) {
  const busy = new Set();
  for (const j of state.jobs)
    if (j.client && j.status === "queued" && j.client.id !== exclude)
      busy.add(j.client.id);
  let sum = 0,
    weights = 0;
  for (const c of clientRows(state))
    if (busy.has(c.id)) {
      sum += (c.fair?.vruntime || 0) * c.weight;
      weights += c.weight;
    }
  return weights ? sum / weights : 0;
}
/** On (re)activation: no credit for idle time. */
export function activateClient(state, now, client) {
  const live = state.jobs.some(
    (j) => j.client?.id === client.id && isActive(j),
  );
  if (live) return;
  client.fair ||= freshFair();
  client.fair.vruntime = Math.max(
    client.fair.vruntime || 0,
    systemVirtualTime(state, { exclude: client.id }),
  );
}
/** Charges a claim's estimate; the attempt remembers it for settlement. */
export function chargeClient(state, now, job, attempt) {
  if (!job.client) return;
  const client = clientRows(state).find((c) => c.id === job.client.id);
  if (!client) return;
  const est = attempt.estimatedDurationMs ?? estimatedDuration(job);
  client.fair ||= freshFair();
  decayService(client.fair, now);
  client.fair.vruntime += est / client.weight;
  client.fair.service[job.client.class] += est;
  attempt.charge = {
    clientId: client.id,
    class: job.client.class,
    estimateMs: est,
    weight: client.weight,
  };
  client.usage.claimed = (client.usage.claimed || 0) + 1;
}
/** Folds usage rows into the client rows: outcomes count; service rows
 * correct V_c and the class service by measured minus charged time. */
export function foldUsage(state, now, rows) {
  for (const u of rows) {
    const client = clientRows(state).find((c) => c.id === u.clientId);
    if (!client) continue;
    if (u.outcome) {
      client.usage[u.outcome] = (client.usage[u.outcome] || 0) + 1;
      continue;
    }
    client.fair ||= freshFair();
    decayService(client.fair, now);
    client.fair.vruntime = Math.max(
      0,
      client.fair.vruntime + u.deltaMs / (u.weight || client.weight),
    );
    client.fair.service[u.class] = Math.max(
      0,
      client.fair.service[u.class] + decayed(u.deltaMs, u.at, now),
    );
    client.usage.servedMs = (client.usage.servedMs || 0) + u.actualMs;
  }
}
/** Recent per-class device time of all clients and the batch share. */
export function classShares(state, now) {
  const total = emptyService();
  for (const c of clientRows(state))
    for (const k of CLASSES)
      total[k] += decayed(c.fair?.service?.[k], c.fair?.serviceAt, now);
  const sum = total.interactive + total.standard + total.batch;
  return {
    serviceMs: total,
    totalMs: sum,
    batchShare: sum ? total.batch / sum : null,
  };
}
/** The level a client job competes at (lower first): its class, lifted one
 * class after waiting maxWait, or the top while batch is under its floor. */
export function clientLevel(job, now, batchStarved = false) {
  const cls = job.client.class;
  if (cls === "batch" && batchStarved) return 1;
  return now - job.createdAt >= CLASS_MAX_WAIT_MS[cls]
    ? LIFT[cls]
    : CLASS_PRIORITY[cls];
}
const byDeadline = (a, b) =>
  (a.client.deadlineAt ?? Infinity) - (b.client.deadlineAt ?? Infinity) ||
  estimatedDuration(a) - estimatedDuration(b) ||
  a.createdAt - b.createdAt ||
  a.id.localeCompare(b.id);

/** Per-round fairness context for ordering. */
export function fairContext(state, now) {
  const shares = classShares(state, now);
  const batchWaiting = state.jobs.some(
    (j) => j.client?.class === "batch" && j.status === "queued",
  );
  return {
    V: systemVirtualTime(state),
    batchStarved:
      batchWaiting &&
      shares.totalMs >= FLOOR_MIN_SERVICE_MS &&
      shares.batchShare < BATCH_FLOOR,
    clients: new Map(clientRows(state).map((c) => [c.id, c])),
  };
}

/** The queue in scheduling order; sorts `jobs` (an array the caller owns). */
export function orderJobs(state, now, jobs) {
  const cmp = compareJobs(now);
  if (!jobs.some((j) => j.client)) return jobs.sort(cmp);
  const ctx = fairContext(state, now);
  const levels = new Map(); // level -> participant -> jobs
  for (const j of jobs) {
    const level = j.client
      ? clientLevel(j, now, ctx.batchStarved)
      : effectivePriority(j, now);
    const who = j.client?.id ?? INTERNAL;
    if (!levels.has(level)) levels.set(level, new Map());
    const group = levels.get(level);
    if (!group.has(who)) group.set(who, []);
    group.get(who).push(j);
  }
  // Simulated virtual runtimes carry across levels within this round.
  const vt = new Map(),
    weight = (who) =>
      who === INTERNAL ? 1 : ctx.clients.get(who)?.weight || 1;
  const virtual = (who) => {
    if (!vt.has(who))
      vt.set(
        who,
        who === INTERNAL
          ? ctx.V
          : (ctx.clients.get(who)?.fair?.vruntime ?? ctx.V),
      );
    return vt.get(who);
  };
  const out = [];
  for (const level of [...levels.keys()].sort((a, b) => a - b)) {
    const queues = [...levels.get(level)].map(([who, list]) => ({
      who,
      list: list.sort(who === INTERNAL ? cmp : byDeadline),
      at: 0,
    }));
    if (queues.length === 1) {
      out.push(...queues[0].list);
      for (const j of queues[0].list)
        vt.set(
          queues[0].who,
          virtual(queues[0].who) + estimatedDuration(j) / weight(queues[0].who),
        );
      continue;
    }
    for (let left = jobs.length; left > 0; left--) {
      const live = queues.filter((q) => q.at < q.list.length);
      if (!live.length) break;
      let sum = 0,
        weights = 0;
      for (const q of live) {
        sum += virtual(q.who) * weight(q.who);
        weights += weight(q.who);
      }
      const V = sum / weights;
      const key = (q) =>
        virtual(q.who) + estimatedDuration(q.list[q.at]) / weight(q.who);
      const eligible = live.filter((q) => virtual(q.who) <= V + LAG_LIMIT_MS);
      const pick = (eligible.length ? eligible : live).reduce((best, q) => {
        const d = key(q) - key(best);
        if (d < 0) return q;
        if (d > 0) return best;
        const x = q.list[q.at],
          y = best.list[best.at];
        return (x.createdAt - y.createdAt || x.id.localeCompare(y.id)) < 0
          ? q
          : best;
      });
      const job = pick.list[pick.at++];
      vt.set(
        pick.who,
        virtual(pick.who) + estimatedDuration(job) / weight(pick.who),
      );
      out.push(job);
    }
  }
  jobs.length = 0;
  jobs.push(...out);
  return jobs;
}
