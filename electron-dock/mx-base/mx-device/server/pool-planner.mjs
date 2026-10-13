import { estimatedDuration } from "./task-contract.mjs";
import { compareJobs } from "./queue-order.mjs";
import { calibratedDuration } from "./command-timing.mjs";
import {
  normalizePoolPolicy,
  poolAppPolicy,
  poolRunHistory,
} from "./pool-policy.mjs";

const appIdOf = (job) => job.appId || "xhs";
const matches = (device, job) =>
  device.mode === job.mode &&
  (!job.deviceId || device.id === job.deviceId) &&
  (!job.placement ||
    (device.rack === job.placement.rack &&
      (!job.placement.host || device.host === job.placement.host)));
const within = (device, resource) =>
  device.rack === resource.rack &&
  (resource.scope === "rack" || device.host === resource.host);
const durationFor = (device, job) =>
  Math.max(1, calibratedDuration(device, job) || estimatedDuration(job));
const runnableDevice = (d) =>
  d.enabled &&
  d.connected !== "offline" &&
  ["idle", "running"].includes(d.state) &&
  !d.pocDisabled &&
  d.adapter !== "mobile-agent" &&
  !["waiting", "held"].includes(d.session?.status);
const supports = (d, j) =>
  (d.simApps || ["xhs", "weibo"]).includes(appIdOf(j)) &&
  (!Array.isArray(d.simCommandCodes) ||
    (j.workflow?.plan || []).every((step) =>
      d.simCommandCodes.includes(step.code),
    ));
const service = (row) =>
  row.actualServiceMs ?? row.reservedServiceMs ?? row.serviceMs ?? 0;

// Find the earliest interval with a spare rack/host permit. Running reservations
// and every prior soft assignment participate; this never grants a real lease.
function capacityStart(start, duration, resources, reservations) {
  let cursor = start;
  for (let n = 0; n <= reservations.length * 2 + 1; n++) {
    let bump = cursor;
    for (const p of resources) {
      if (p.maxConcurrent == null) continue;
      if (p.maxConcurrent < 1) return Infinity;
      const relevant = reservations.filter(
        (r) =>
          within(r.device, p) &&
          r.finishAt > cursor &&
          r.startAt < cursor + duration,
      );
      const points = [
        ...new Set([
          cursor,
          ...relevant.map((r) => Math.max(cursor, r.startAt)),
        ]),
      ].sort((a, b) => a - b);
      for (const at of points) {
        const active = relevant.filter(
          (r) => r.startAt <= at && r.finishAt > at,
        );
        if (active.length >= p.maxConcurrent) {
          bump = Math.max(bump, Math.min(...active.map((r) => r.finishAt)));
          break;
        }
      }
    }
    if (bump === cursor) return cursor;
    cursor = bump;
  }
  return Infinity;
}
function appStart(app, start, duration, policy) {
  if (duration > policy.maxServiceMs) return { code: "app-service-budget" };
  let at = Math.max(start, app.cooldownUntil || 0);
  let history = poolRunHistory(app, at, policy);
  if (
    history.length >= policy.maxRuns ||
    history.reduce((n, r) => n + service(r), 0) + duration > policy.maxServiceMs
  ) {
    const last = Math.max(
      ...history.map((r) => r.finishedAt ?? r.at + service(r)),
    );
    at = Math.max(at, last + policy.cooldownMs);
    history = poolRunHistory(app, at, policy);
  }
  if (
    history.length >= policy.maxRuns ||
    history.reduce((n, r) => n + service(r), 0) + duration > policy.maxServiceMs
  )
    return { code: "app-budget-unresolved" };
  return { at, history };
}

/** Pure, disposable placement hints for simulation only. Calls never mutate state.
 * Pending jobs are reconsidered on every plan. A running Attempt never migrates.
 * Estimates are empirical; claim still checks current hard safety guards.
 */
export function planPool(state, now, { rack, policy: suppliedPolicy } = {}) {
  const configured = (state.loopPolicies || []).find(
    (p) => p.mode === "sim" && p.rack === rack,
  )?.scheduler;
  const policy = normalizePoolPolicy(suppliedPolicy || configured || {});
  const result = {
    at: now,
    mode: "sim",
    rack: rack ?? null,
    policy,
    assignments: [],
    blocked: [],
    idlePercent: 0,
    deviceCount: 0,
  };
  if (!policy.enabled) return result;
  const allDevices = state.devices.filter(
    (d) => d.mode === "sim" && (!rack || d.rack === rack),
  );
  const resources = (state.resources || []).filter((r) => r.mode === "sim");
  const reservations = [];
  const jobsById = new Map(state.jobs.map((j) => [j.id, j]));
  const devices = [];
  for (const d of allDevices) {
    const active = (state.attempts || []).find(
      (a) => a.deviceId === d.id && ["running", "yielded"].includes(a.status),
    );
    const runningJob = jobsById.get(active?.jobId);
    const runningDuration = runningJob ? durationFor(d, runningJob) : 180000;
    const estimateFinish = (active?.createdAt ?? now) + runningDuration;
    // An overdue estimate is uncertain, not evidence that a slot is 1 ms away.
    const finishAt =
      d.state === "running"
        ? estimateFinish > now
          ? estimateFinish
          : now + runningDuration
        : now;
    if (d.state === "running")
      reservations.push({ device: d, startAt: now, finishAt });
    const deviceResources = resources.filter((p) => within(d, p));
    if (!runnableDevice(d) || deviceResources.some((p) => p.draining)) continue;
    const apps = new Map(
      (d.simApps || ["xhs", "weibo"]).map((appId) => {
        const source =
          (state.apps || []).find(
            (a) => a.mode === "sim" && a.deviceId === d.id && a.appId === appId,
          ) || {};
        const app = {
          ...source,
          appId,
          poolRuns: (source.poolRuns || []).map((r) => ({ ...r })),
        };
        if (runningJob && appIdOf(runningJob) === appId) {
          app.poolRuns = app.poolRuns.filter((r) => r.attemptId !== active.id);
          app.poolRuns.push({
            at: active.createdAt,
            finishedAt: finishAt,
            reservedServiceMs: durationFor(d, runningJob),
            attemptId: active.id,
          });
          app.cooldownUntil = Math.max(
            app.cooldownUntil || 0,
            finishAt + (app.cooldownMs || 0),
          );
        }
        return [appId, app];
      }),
    );
    const warm = runningJob
      ? appIdOf(runningJob)
      : [...apps.values()]
          .filter((a) => a.lastClaimedAt != null)
          .sort((a, b) => b.lastClaimedAt - a.lastClaimedAt)[0]?.appId;
    devices.push({
      device: d,
      freeAt: Math.max(finishAt, d.cooldownUntil || 0),
      apps,
      warmApp: warm,
      queueLength: 0,
      resources: deviceResources,
    });
  }
  result.deviceCount = devices.length;
  result.idlePercent = devices.length
    ? (devices.filter((x) => x.device.state === "idle" && x.freeAt <= now)
        .length /
        devices.length) *
      100
    : 0;
  const queue = state.jobs
    .filter(
      (j) =>
        j.mode === "sim" &&
        j.status === "queued" &&
        allDevices.some((d) => matches(d, j)),
    )
    .sort(compareJobs(now));
  for (const job of queue) {
    if (job.notBefore > now) {
      result.blocked.push({
        jobId: job.id,
        code: "not-before",
        reason: "尚未到任务允许领取时间，不预占软队列",
      });
      continue;
    }
    const source = jobsById.get(job.sourceJobId);
    if (job.sourceJobId && source?.status !== "succeeded") {
      result.blocked.push({
        jobId: job.id,
        code: "dependency",
        reason: "等待来源任务成功；依赖关系不参与设备绑定",
      });
      continue;
    }
    const candidates = [];
    const codes = new Set();
    const compatible = devices.filter(
      (s) => matches(s.device, job) && supports(s.device, job),
    );
    const idlePercent = compatible.length
      ? (compatible.filter(
          (s) => s.device.state === "idle" && s.freeAt <= now && !s.queueLength,
        ).length /
          compatible.length) *
        100
      : 0;
    for (const slot of devices) {
      const d = slot.device;
      if (!matches(d, job)) continue;
      if (!supports(d, job)) {
        codes.add("capability");
        continue;
      }
      if (slot.queueLength >= policy.maxQueuePerDevice) {
        codes.add("queue-limit");
        continue;
      }
      const appId = appIdOf(job),
        app = slot.apps.get(appId),
        appPolicy = poolAppPolicy(policy, appId);
      const duration = durationFor(d, job);
      const ready = appStart(
        app,
        Math.max(now, slot.freeAt, job.notBefore || 0),
        duration,
        appPolicy,
      );
      if (ready.code) {
        codes.add(ready.code);
        continue;
      }
      const startAt = capacityStart(
        ready.at,
        duration,
        slot.resources,
        reservations,
      );
      if (!Number.isFinite(startAt)) {
        codes.add("resource-capacity");
        continue;
      }
      if (startAt - now > policy.maxQueueWaitMs) {
        codes.add("queue-wait-budget");
        continue;
      }
      candidates.push({
        slot,
        app,
        appPolicy,
        duration,
        startAt,
        finishAt: startAt + duration,
        affinity: duration <= policy.shortTaskMs && slot.warmApp === appId,
      });
    }
    if (!candidates.length) {
      const code = [...codes][0] || "no-device";
      const labels = {
        capability: "无匹配的 App/指令能力",
        "queue-limit": "软队列已达到配置上限",
        "app-service-budget": "整段任务预计耗时超过 App 服务预算",
        "resource-capacity": "机架或宿主机没有并发许可",
        "queue-wait-budget": "预计排队时间超过软队列等待预算",
        "no-device": "没有可规划的模拟设备",
        "app-budget-unresolved": "历史派发尚未完成核验，App 预算保留",
      };
      result.blocked.push({
        jobId: job.id,
        code,
        reason: labels[code],
        codes: [...codes],
      });
      continue;
    }
    candidates.sort(
      (a, b) =>
        a.finishAt - b.finishAt ||
        a.startAt - b.startAt ||
        a.slot.queueLength - b.slot.queueLength ||
        a.slot.device.name.localeCompare(b.slot.device.name) ||
        a.slot.device.id.localeCompare(b.slot.device.id),
    );
    let chosen = candidates[0];
    const spread =
      policy.strategy === "spread" ||
      (policy.strategy === "adaptive" &&
        idlePercent > policy.idleSpreadThresholdPct);
    if (!spread) {
      const warm = candidates
        .filter(
          (c) =>
            c.affinity &&
            c.startAt <= chosen.startAt + policy.maxAffinityDelayMs,
        )
        .sort(
          (a, b) =>
            a.finishAt - b.finishAt ||
            a.slot.device.name.localeCompare(b.slot.device.name) ||
            a.slot.device.id.localeCompare(b.slot.device.id),
        );
      if (warm.length) chosen = warm[0];
    }
    const { slot, app, appPolicy, startAt, finishAt, duration, affinity } =
      chosen;
    const reasonCode = spread
      ? "idle-spread"
      : affinity
        ? "bounded-affinity"
        : "earliest-finish";
    const reason = {
      "idle-spread": "空闲比例触发分散，按预计最早完成分配",
      "bounded-affinity": "同 App 小任务亲和，等待增加未超过上限",
      "earliest-finish": "约束满足后按预计最早完成分配",
    }[reasonCode];
    result.assignments.push({
      jobId: job.id,
      deviceId: slot.device.id,
      appId: app.appId,
      startAt,
      finishAt,
      durationMs: duration,
      waitMs: startAt - now,
      costMs: finishAt - now,
      queuePosition: slot.queueLength + 1,
      affinity,
      idlePercent,
      reasonCode,
      reason,
      mutable: true,
    });
    app.poolRuns = poolRunHistory(app, startAt, appPolicy);
    app.poolRuns.push({
      at: startAt,
      finishedAt: finishAt,
      reservedServiceMs: duration,
    });
    app.cooldownUntil = finishAt + (app.cooldownMs || 0);
    slot.freeAt = finishAt + (slot.device.taskIntervalMs ?? 300);
    slot.warmApp = app.appId;
    slot.queueLength++;
    reservations.push({ device: slot.device, startAt, finishAt });
  }
  return result;
}
