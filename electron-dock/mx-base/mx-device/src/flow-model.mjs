// Flow view model (V2-4): where work is in its lifecycle and how fast it moves.
// accepted → queued → planned → leased → running → done, abnormal ends apart.
// Rates use the last 3 minutes, the window the state snapshot keeps.
export const FLOW_WINDOW_MS = 180000;

const percentile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};
const ABNORMAL = {
  unknown: "结果待核验",
  failed: "业务失败",
  cancelled: "已取消",
  blocked: "依赖阻塞",
  skipped: "已跳过",
  expired: "租约退回",
};

export function flowModel(state, { rack = "", now }) {
  const since = now - FLOW_WINDOW_MS,
    perMinute = (n) => Math.round((n * 60000 * 10) / FLOW_WINDOW_MS) / 10;
  const devices = new Map(state.devices.map((d) => [d.id, d]));
  const inRack = (deviceId) => !rack || devices.get(deviceId)?.rack === rack;
  const planned = new Map(
    (state.scheduling?.queue || [])
      .filter((q) => q.poolAssignment)
      .map((q) => [q.jobId, q.poolAssignment]),
  );
  const jobs = state.jobs.filter(
    (j) =>
      !rack ||
      j.placement?.rack === rack ||
      (planned.get(j.id) && inRack(planned.get(j.id).deviceId)) ||
      (j.lastDeviceId && inRack(j.lastDeviceId)),
  );
  const queued = jobs.filter((j) => j.status === "queued");
  const attempts = state.attempts.filter((a) => inRack(a.deviceId));
  const live = attempts.filter((a) => a.status === "running");
  const leased = live.filter(
    (a) => a.agentState === "granted" || a.dispatchedAt == null,
  );
  const recent = attempts.filter((a) => (a.completedAt ?? 0) >= since);
  const done = recent.filter((a) => a.status === "succeeded");
  const started = attempts.filter(
    (a) => (a.dispatchedAt ?? a.createdAt) >= since && a.queuedMs != null,
  );
  const waits = started.map((a) => a.queuedMs);
  const abnormal = Object.entries(ABNORMAL)
    .map(([status, label]) => ({
      status,
      label,
      count: recent.filter((a) => a.status === status).length,
    }))
    .filter((x) => x.count);
  const arrived = jobs.filter((j) => j.createdAt >= since).length;
  // The live queue lists the first entries only; whole-pool totals come
  // from the server (exact when no rack filter is applied).
  const summary = !rack && state.scheduling?.queueSummary;
  const plannedCount = summary
    ? summary.planned
    : queued.filter((j) => planned.has(j.id)).length;
  const queuedCount = summary
    ? summary.total - summary.planned
    : queued.filter((j) => !planned.has(j.id)).length;
  return {
    windowMs: FLOW_WINDOW_MS,
    stages: [
      {
        id: "accepted",
        label: "已接收",
        count: arrived,
        note: `近 3 分钟 · ${perMinute(arrived)} 个/分钟`,
      },
      {
        id: "queued",
        label: "排队",
        count: queuedCount,
        note: "等待设备或预算",
      },
      {
        id: "planned",
        label: "已计划",
        count: plannedCount,
        note: "软计划，可改派",
      },
      {
        id: "leased",
        label: "已签租约",
        count: leased.length,
        note: "设备已绑定，尚未发出指令",
      },
      {
        id: "running",
        label: "执行中",
        count: live.length - leased.length,
        note: `检查点等待 ${attempts.filter((a) => a.status === "yielded").length}`,
      },
      {
        id: "done",
        label: "完成",
        count: done.length,
        note: `近 3 分钟 · ${perMinute(done.length)} 个/分钟`,
      },
    ],
    abnormal,
    throughputPerMin: perMinute(done.length),
    waitP50Ms: percentile(waits, 0.5),
    waitP95Ms: percentile(waits, 0.95),
  };
}
