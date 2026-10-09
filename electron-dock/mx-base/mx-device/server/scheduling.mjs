import {
  AGING_INTERVAL_MS,
  estimatedDuration,
  taskLane,
} from "./task-contract.mjs";
import { deviceApps, appBlockers, deviceInterval, jobApp } from "./apps.mjs";
// Pure scheduling rules shared by claims and read-only explanations.
export const effectivePriority = (job, now) =>
  Math.max(
    1,
    job.priority -
      Math.floor(Math.max(0, now - job.createdAt) / AGING_INTERVAL_MS),
  );
export const compareJobs = (now) => (a, b) => {
  const priority = effectivePriority(a, now) - effectivePriority(b, now);
  if (priority) return priority;
  // Old jobs outrank fresh short jobs at equal effective priority. Among old jobs use FIFO.
  if (Math.max(now - a.createdAt, now - b.createdAt) >= AGING_INTERVAL_MS)
    return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  return (
    estimatedDuration(a) - estimatedDuration(b) ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
};
export const matchesJob = (device, job) =>
  device.mode === job.mode &&
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
export function resourcePolicy(state, mode, scope, rack, host = null) {
  return (state.resources || []).find(
    (r) =>
      r.mode === mode && r.resourceKey === resourceKey({ scope, rack, host }),
  );
}
export function policiesFor(state, device) {
  return [
    resourcePolicy(state, device.mode, "rack", device.rack),
    resourcePolicy(state, device.mode, "host", device.rack, device.host),
  ].filter(Boolean);
}
export function deviceBlockers(state, now, d) {
  const reasons = [],
    add = (code, message) => reasons.push({ code, message });
  for (const p of policiesFor(state, d)) {
    const label = p.scope === "rack" ? "机架" : "宿主机";
    if (p.draining) add(`${p.scope}-draining`, `${label}已排空，停止新领取`);
    const running = state.devices.filter(
      (x) => inResource(x, p) && x.state === "running",
    ).length;
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
  if (d.state === "running") add("running", "设备正在执行，完整会话不抢占");
  else if (!["idle", "quarantined"].includes(d.state))
    add("unknown-state", "执行槽状态未知");
  if (d.connected === "offline") add("offline", "模拟设备离线");
  if (d.cooldownUntil > now)
    add(
      "cooldown",
      `设备冷却中，约 ${Math.ceil((d.cooldownUntil - now) / 1000)} 秒`,
    );
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
    healthy.every(
      (w) => Number.isInteger(w.inflight) && w.inflight >= (w.maxInflight || 4),
    )
  )
    return [{ code: "worker-capacity", message: "执行器工作槽已满，等待领取" }];
  return [];
}

export function schedulingSnapshot(state, now, mode) {
  const devices = state.devices.filter((d) => d.mode === mode);
  const jobs = state.jobs.filter((j) => j.mode === mode);
  const queue = jobs
    .filter((j) => j.status === "queued")
    .sort(compareJobs(now));
  const availability = devices.map((d) => {
    const common = [
      ...deviceBlockers(state, now, d),
      ...workerBlockers(state, now, d),
    ];
    const running = state.attempts?.find(
      (a) => a.deviceId === d.id && a.status === "running",
    );
    const apps = deviceApps(state, d).map((app) => ({
      ...app,
      active: !!running && jobApp(running) === app.appId,
      nextAllowedAt: Math.max(d.cooldownUntil || 0, app.cooldownUntil),
      blockers: [...common, ...appBlockers(state, now, d, app)],
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
    const ready = candidates.filter(
      (d) =>
        byDevice.get(d.id).commonBlockers.length === 0 &&
        !appBlockers(state, now, d, j).length,
    );
    if (!candidates.length)
      reasons.push({ code: "no-device", message: "没有匹配的已登记设备" });
    else if (!ready.length) {
      const codes = new Set();
      for (const d of candidates)
        for (const r of [
          ...byDevice.get(d.id).commonBlockers,
          ...appBlockers(state, now, d, j),
        ]) {
          if (!codes.has(r.code)) {
            reasons.push(r);
            codes.add(r.code);
          }
        }
    }
    return {
      jobId: j.id,
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
