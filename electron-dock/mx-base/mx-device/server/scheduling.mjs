import { estimatedDuration, taskLane } from "./task-contract.mjs";
import { compareJobs, effectivePriority } from "./queue-order.mjs";
export { compareJobs, effectivePriority } from "./queue-order.mjs";
import { DEFAULT_LOOP_POLICY, loopPolicyFor } from "./loop-policy.mjs";
import {
  appKey,
  deviceApps,
  appBlockers,
  deviceInterval,
  jobApp,
} from "./apps.mjs";
import { planPool } from "./pool-planner.mjs";
// Pure scheduling rules shared by claims and read-only explanations.
export const matchesJob = (device, job) =>
  device.mode === job.mode &&
  (!device.workstationDemo ||
    job.runId === device.workstationDemo.runId ||
    job.deviceId === device.id ||
    job.placement?.rack === device.rack) &&
  (!job.deviceId || device.id === job.deviceId) &&
  (!job.placement ||
    (device.rack === job.placement.rack &&
      (!job.placement.host || device.host === job.placement.host)));

export const resourceKey = ({ scope, rack, host }) =>
  JSON.stringify(scope === "rack" ? [scope, rack] : [scope, rack, host]);
export const inResource = (device, resource) =>
  device.mode === resource.mode &&
  device.rack === resource.rack &&
  (resource.scope === "rack" || device.host === resource.host);
export function resourcePolicy(state, mode, scope, rack, host = null, index) {
  const key = resourceKey({ scope, rack, host });
  return index
    ? index.policies.get(`${mode}\u0000${key}`)
    : (state.resources || []).find(
        (r) => r.mode === mode && r.resourceKey === key,
      );
}
export function policiesFor(state, device, index) {
  return [
    resourcePolicy(state, device.mode, "rack", device.rack, null, index),
    resourcePolicy(state, device.mode, "host", device.rack, device.host, index),
  ].filter(Boolean);
}
const scopeCount = (mode, scope, rack, host) =>
  JSON.stringify([mode, scope, rack, scope === "rack" ? null : host]);
/** Read-only lookups for decisions over one unchanged state at one instant.
 * Helpers accept it as an optional last argument and return identical results;
 * it only replaces repeated linear scans (apps, resources, running counts) and
 * memoizes per-device blockers. Rebuild it after any mutation. */
export function schedulingIndex(state, now) {
  const apps = new Map(),
    policies = new Map(),
    running = new Map();
  for (const a of state.apps || []) {
    const key = appKey(a.mode, a.deviceId, a.appId);
    if (!apps.has(key)) apps.set(key, a);
  }
  for (const r of state.resources || []) {
    const key = `${r.mode}\u0000${r.resourceKey}`;
    if (!policies.has(key)) policies.set(key, r);
  }
  for (const x of state.devices)
    if (x.state === "running")
      for (const key of [
        scopeCount(x.mode, "rack", x.rack),
        scopeCount(x.mode, "host", x.rack, x.host),
      ])
        running.set(key, (running.get(key) || 0) + 1);
  return { now, apps, policies, running, blockers: new Map() };
}
export function deviceBlockers(state, now, d, index) {
  if (index && index.now === now && index.blockers.has(d.id))
    return index.blockers.get(d.id);
  const reasons = [],
    add = (code, message) => reasons.push({ code, message });
  for (const p of policiesFor(state, d, index)) {
    const label = p.scope === "rack" ? "机架" : "宿主机";
    if (p.draining) add(`${p.scope}-draining`, `${label}已排空，停止新领取`);
    const running = index
      ? index.running.get(scopeCount(p.mode, p.scope, p.rack, p.host)) || 0
      : state.devices.filter((x) => inResource(x, p) && x.state === "running")
          .length;
    if (p.maxConcurrent != null && running >= p.maxConcurrent)
      add(
        `${p.scope}-capacity`,
        `${label}并发已达上限（${running}/${p.maxConcurrent}）`,
      );
  }
  if (d.state === "quarantined")
    add("quarantined", "执行结果待核验，设备已隔离");
  if (d.adapter === "mobile-agent")
    add("observer-only", "仅观察设备，不支持搜索/详情");
  if (d.pocDisabled) add("poc-disabled", "旧 PoC 通道已停用");
  if (["waiting", "held"].includes(d.session?.status))
    add("reserved", "执行槽被本中心会话预留");
  if (!d.enabled) add("paused", "设备已暂停领取");
  if (d.state === "running")
    add(
      "running",
      d.workflowAttemptId
        ? "大循环保留插槽，检查点可按预算插入小任务"
        : "设备正在执行，完整会话不抢占",
    );
  else if (!["idle", "quarantined"].includes(d.state))
    add("unknown-state", "执行槽状态未知");
  if (d.connected === "offline") add("offline", "模拟设备离线");
  if (d.cooldownUntil > now)
    add(
      "cooldown",
      `设备冷却中，约 ${Math.ceil((d.cooldownUntil - now) / 1000)} 秒`,
    );
  if (index && index.now === now) index.blockers.set(d.id, reasons);
  return reasons;
}
export function workerHealth(worker, now) {
  if (!worker || now - worker.at >= 10000 || worker.at > now + 1000)
    return "stale";
  return worker.lastError ? "error" : "fresh";
}
function workerBlockers(state, now, device) {
  const workers = (state.workers || []).filter(
    (w) =>
      w.role === "device-worker" &&
      (device.mode === "sim" || w.id === device.workerId),
  );
  const healthy = workers.filter((w) => workerHealth(w, now) === "fresh");
  if (!healthy.length)
    return [
      { code: "worker-unavailable", message: "执行器无新鲜健康心跳，等待恢复" },
    ];
  if (
    healthy.every((w) => {
      const used =
        device.mode === "sim"
          ? (w.simulationInflight ?? w.inflight)
          : (w.realInflight ?? w.inflight);
      const limit =
        device.mode === "sim"
          ? (w.maxSimulationInflight ?? w.maxInflight ?? 4)
          : (w.maxRealInflight ?? w.maxInflight ?? 4);
      return Number.isInteger(used) && used >= limit;
    })
  )
    return [{ code: "worker-capacity", message: "执行器工作槽已满，等待领取" }];
  return [];
}

// Same admission rule for claims and queue explanations. A parent already owns
// the physical slot, so its child does not consume another rack capacity unit.
export function insertionCost(state, device, child) {
  const p = loopPolicyFor(state, device) || DEFAULT_LOOP_POLICY;
  return Math.max(
    child.estimatedDurationMs,
    child.workflow.plan.length * p.commandDelayMs,
  );
}
export function insertionBlockers(state, now, device, child, index) {
  const a = state.attempts.find((a) => a.id === device.workflowAttemptId);
  const parent = state.jobs.find((j) => j.id === a?.jobId);
  const w = parent?.workflow;
  const reasons = [];
  const add = (code, message) => reasons.push({ code, message });
  if (!w || child.workflow?.loop !== "small") {
    add("session-reserved", "此插槽保留给大循环，仅允许插入小任务");
    return reasons;
  }
  if (
    a.status !== "yielded" ||
    !w.safePoint ||
    state.attempts.some(
      (x) => x.deviceId === device.id && x.status === "running",
    )
  )
    add("checkpoint-wait", "等待大循环的安全检查点与在途指令结束");
  if (!w.resumable) add("not-resumable", "此定义不允许中途插入");
  if (
    state.devices.some(
      (other) =>
        other.id !== device.id &&
        matchesJob(other, child) &&
        !deviceBlockers(state, now, other, index).length &&
        !appBlockers(state, now, other, child, index).length,
    )
  )
    add("idle-preferred", "另有匹配的空闲插槽，优先直接分配");
  if (w.insertions >= w.policySnapshot.maxInsertions)
    add("insertion-limit", "已达插入次数上限，等待大循环完成");
  const elapsed =
    w.detourMs + (w.detourStartedAt != null ? now - w.detourStartedAt : 0);
  if (
    Math.max(elapsed, w.insertedEstimateMs) +
      insertionCost(state, device, child) +
      w.policySnapshot.commandDelayMs >
    w.policySnapshot.maxDetourMs
  )
    add("insertion-budget", "插入及恢复的预计耗时超出剩余预算，等待大循环完成");
  return reasons;
}

// reference: true recomputes every lookup without the index (equivalence tests).
export function schedulingSnapshot(
  state,
  now,
  mode,
  { reference = false } = {},
) {
  const index = reference ? undefined : schedulingIndex(state, now);
  const devices = state.devices.filter((d) => d.mode === mode);
  const jobs = state.jobs.filter((j) => j.mode === mode);
  const queue = jobs
    .filter((j) => j.status === "queued")
    .sort(compareJobs(now));
  const availability = devices.map((d) => {
    const common = [
      ...deviceBlockers(state, now, d, index),
      ...workerBlockers(state, now, d),
    ];
    const running = state.attempts?.find(
      (a) => a.deviceId === d.id && a.status === "running",
    );
    const apps = deviceApps(state, d, index).map((app) => ({
      ...app,
      active: !!running && jobApp(running) === app.appId,
      nextAllowedAt: Math.max(d.cooldownUntil || 0, app.cooldownUntil),
      blockers: [...common, ...appBlockers(state, now, d, app, index)],
    }));
    return {
      deviceId: d.id,
      deviceIntervalMs: deviceInterval(d),
      apps,
      commonBlockers: common,
      blockers:
        !common.length && apps.length && apps.every((a) => a.blockers.length)
          ? [
              {
                code: "all-apps-cooling",
                message: "此设备所有 App 均在冷却，等待各自截止时间",
              },
            ]
          : common,
    };
  });
  const byDevice = new Map(availability.map((d) => [d.deviceId, d]));
  const byJob = new Map(jobs.map((j) => [j.id, j]));
  const poolPlans =
    mode === "sim"
      ? (state.loopPolicies || [])
          .filter((p) => p.mode === "sim" && p.scheduler?.enabled)
          .map((p) => planPool(state, now, { rack: p.rack }))
      : [];
  const plansByRack = new Map(poolPlans.map((p) => [p.rack, p]));
  // Plan lookups grouped by job, preserving plan order.
  const group = (rows) => {
    const byJob = new Map();
    for (const row of rows) {
      if (!byJob.has(row.jobId)) byJob.set(row.jobId, []);
      byJob.get(row.jobId).push(row);
    }
    return byJob;
  };
  const rackAssignments = new Map(
    poolPlans.map((p) => [p.rack, group(p.assignments)]),
  );
  const allAssignments = group(poolPlans.flatMap((p) => p.assignments));
  const allBlocked = group(poolPlans.flatMap((p) => p.blocked));
  const waiting = queue.map((j, i) => {
    const reasons = [];
    if (j.notBefore > now)
      reasons.push({
        code: "not-before",
        message: `延迟领取，约 ${Math.ceil((j.notBefore - now) / 1000)} 秒`,
      });
    if (j.sourceJobId) {
      const source = byJob.get(j.sourceJobId);
      if (!source || ["queued", "running"].includes(source.status))
        reasons.push({ code: "dependency", message: "等待来源搜索完成" });
      else if (source.status !== "succeeded")
        reasons.push({
          code: "dependency-failed",
          message: "来源任务未成功，等待标记依赖阻塞",
        });
    }
    const candidates = devices.filter((d) => matchesJob(d, j));
    const reasonsByDevice = new Map();
    const candidateReasons = (d) => {
      if (!reasonsByDevice.has(d.id))
        reasonsByDevice.set(d.id, [
          ...byDevice
            .get(d.id)
            .commonBlockers.filter(
              (r) =>
                !d.workflowAttemptId ||
                !["running", "rack-capacity", "host-capacity"].includes(r.code),
            ),
          ...(d.workflowAttemptId
            ? insertionBlockers(state, now, d, j, index)
            : []),
          ...appBlockers(state, now, d, j, index),
        ]);
      return reasonsByDevice.get(d.id);
    };
    const ready = candidates.filter(
      (d) =>
        candidateReasons(d).length === 0 &&
        (!plansByRack.has(d.rack) ||
          (rackAssignments.get(d.rack).get(j.id) || []).some(
            (a) =>
              a.deviceId === d.id && a.startAt <= now && a.queuePosition === 1,
          )),
    );
    if (!candidates.length)
      reasons.push({ code: "no-device", message: "没有匹配的已登记设备" });
    else if (!ready.length) {
      const codes = new Set();
      for (const d of candidates)
        for (const r of candidateReasons(d)) {
          if (!codes.has(r.code)) {
            reasons.push(r);
            codes.add(r.code);
          }
        }
    }
    const legacyReady = ready.some((d) => !plansByRack.has(d.rack));
    const poolAssignment =
      !legacyReady &&
      [...(allAssignments.get(j.id) || [])].sort(
        (a, b) => a.finishAt - b.finishAt,
      )[0];
    const poolBlocked = allBlocked.get(j.id)?.[0];
    if (!ready.length && poolAssignment && poolAssignment.startAt > now)
      reasons.push({
        code: "pool-soft-queue",
        message: `${poolAssignment.reason}；软排队约 ${Math.ceil((poolAssignment.startAt - now) / 1000)} 秒，尚未绑定设备`,
      });
    else if (!ready.length && !poolAssignment && poolBlocked)
      reasons.push({ code: poolBlocked.code, message: poolBlocked.reason });
    return {
      jobId: j.id,
      poolAssignment: poolAssignment || null,
      order: i + 1,
      effectivePriority: effectivePriority(j, now),
      estimatedDurationMs: estimatedDuration(j),
      lane: taskLane(j),
      waitMs: Math.max(0, now - j.createdAt),
      candidateDeviceIds: ready.map((d) => d.id),
      status: reasons.length ? "waiting" : "candidate",
      reasons: reasons.length
        ? reasons
        : [{ code: "candidate", message: "候选条件满足，等待执行器核验领取" }],
    };
  });
  const groups = [];
  for (const d of devices)
    for (const scope of ["rack", "host"]) {
      const key = resourceKey({ scope, rack: d.rack, host: d.host });
      if (groups.some((g) => g.resourceKey === key)) continue;
      const policy = resourcePolicy(state, mode, scope, d.rack, d.host);
      const group = {
        scope,
        mode,
        rack: d.rack,
        host: scope === "host" ? d.host : null,
        resourceKey: key,
        revision: policy?.revision || 0,
        draining: policy?.draining || false,
        maxConcurrent: policy?.maxConcurrent ?? null,
      };
      const members = devices.filter((x) => inResource(x, group));
      group.deviceIds = members.map((x) => x.id);
      group.workerIds = [...new Set(members.map((x) => x.workerId))];
      group.total = members.length;
      group.running = members.filter((x) => x.state === "running").length;
      group.paused = members.filter((x) => !x.enabled).length;
      group.quarantined = members.filter(
        (x) => x.state === "quarantined",
      ).length;
      group.observerOnly = members.filter(
        (x) => x.adapter === "mobile-agent" || x.pocDisabled,
      ).length;
      group.candidates = members.filter(
        (x) => byDevice.get(x.id).blockers.length === 0,
      ).length;
      group.queued = queue.filter((j) =>
        j.deviceId
          ? group.deviceIds.includes(j.deviceId)
          : j.placement?.rack === group.rack &&
            (scope === "rack" || j.placement.host === group.host),
      ).length;
      groups.push(group);
    }
  return {
    at: now,
    groups,
    poolPlans,
    devices: availability,
    queue: waiting,
    counts: {
      total: devices.length,
      candidates: availability.filter((d) => !d.blockers.length).length,
      running: devices.filter((d) => d.state === "running").length,
      quarantined: devices.filter((d) => d.state === "quarantined").length,
      queued: queue.length,
      unbound: queue.filter((j) => !j.deviceId && !j.placement).length,
    },
  };
}
