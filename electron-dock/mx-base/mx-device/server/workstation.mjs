import { createHash, randomUUID } from "node:crypto";
import { requireThat, str, uuid, register, publicDevice } from "./model.mjs";
import { APP_NAMES, supportedApps, ensureApps, appBlockers } from "./apps.mjs";
import { commandDefinitions } from "./command-registry.mjs";
import { definitions, addWorkflow } from "./workflows.mjs";
import { matchesJob, policiesFor } from "./scheduling.mjs";
import {
  applyStrategy,
  listStrategies,
  resolveStrategy,
} from "./strategy-registry.mjs";

const event = (s, now, type, message, more = {}) =>
  s.events.push({
    id: randomUUID(),
    mode: "sim",
    at: now,
    type,
    message,
    ...more,
  });
const simulation = (mode) =>
  requireThat(mode === "sim", "此工作台管理操作仅用于模拟机架", 403);
const object = (body, keys) =>
  requireThat(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).every((key) => keys.includes(key)),
    "请求含不支持或只读字段",
    400,
  );
const revisionMatches = (body, row, label) => {
  requireThat(
    Number.isInteger(body.revision) && body.revision >= 0,
    "revision 须为非负整数",
    400,
  );
  requireThat(
    body.revision === (row.revision || 0),
    `${label}已更新，请刷新后重试`,
  );
};
const queued = (s, mode, id, body) => {
  simulation(mode);
  const job = s.jobs.find((j) => j.mode === mode && j.id === uuid(id));
  requireThat(job, "任务不存在", 404);
  revisionMatches(body, job, "任务");
  requireThat(
    job.status === "queued" &&
      !s.attempts.some(
        (a) => a.jobId === job.id && ["running", "yielded"].includes(a.status),
      ),
    "只能管理尚未领取的排队任务；执行中和保留会话不能迁移",
  );
  return job;
};

// A manual assignment changes a queued job's hard constraint, never an Attempt.
// Keeping placement by default prevents a release from silently crossing racks.
export function assignQueuedJob(s, now, mode, id, body) {
  object(body, ["revision", "deviceId", "clearPlacement"]);
  const job = queued(s, mode, id, body);
  requireThat(
    body.deviceId === null || typeof body.deviceId === "string",
    "deviceId 须为设备 ID 或 null",
    400,
  );
  requireThat(
    body.clearPlacement === undefined ||
      typeof body.clearPlacement === "boolean",
    "clearPlacement 须为布尔值",
    400,
  );
  requireThat(
    !body.clearPlacement || body.deviceId === null,
    "仅回收中央队列时可以清除调度范围",
    400,
  );
  const previousDeviceId = job.deviceId || null;
  if (body.deviceId !== null) {
    const device = s.devices.find(
      (d) => d.mode === mode && d.id === uuid(body.deviceId),
    );
    requireThat(device, "目标模拟设备不存在", 404);
    requireThat(
      device.enabled &&
        device.state !== "quarantined" &&
        device.connected !== "offline",
      "目标设备暂停、隔离或离线，不能人工指派",
    );
    requireThat(
      ["idle", "running"].includes(device.state) &&
        !["waiting", "held"].includes(device.session?.status),
      "目标设备执行槽未知或已被控制会话预留",
    );
    requireThat(
      !policiesFor(s, device).some((p) => p.draining),
      "目标机架或宿主机已排空",
    );
    requireThat(
      matchesJob(device, { ...job, deviceId: device.id }),
      "目标设备不在任务原有机架或宿主机范围内",
    );
    const capability = appBlockers(s, now, device, job).filter(
      (b) => b.code !== "app-cooldown",
    );
    requireThat(
      !capability.length,
      capability.map((b) => b.message).join("；"),
    );
    job.deviceId = device.id;
    job.reason = `管理员指派至 ${device.name}；仍须等待执行槽、App 和设备冷却及调度预算`;
  } else {
    job.deviceId = null;
    if (body.clearPlacement) delete job.placement;
    job.reason = job.placement
      ? "已回收中央队列，保留原机架/宿主机范围"
      : "已回收中央队列，等待兼容设备";
  }
  job.revision = (job.revision || 0) + 1;
  job.updatedAt = now;
  event(s, now, "job-assignment", job.reason, {
    jobId: job.id,
    deviceId: job.deviceId,
    previousDeviceId,
    revision: job.revision,
    placement: job.placement || null,
  });
  return job;
}

export function cancelQueuedJob(s, now, mode, id, body) {
  object(body, ["revision"]);
  const job = queued(s, mode, id, body);
  job.status = "cancelled";
  job.completedAt = now;
  job.updatedAt = now;
  job.revision = (job.revision || 0) + 1;
  job.reason = "管理员取消未领取任务；任务与审计记录保留";
  event(s, now, "cancelled", job.reason, { jobId: id, revision: job.revision });
  return job;
}

export function configureSimDevice(s, now, mode, id, body) {
  simulation(mode);
  object(body, ["revision", "simApps", "simCommandCodes"]);
  const device = s.devices.find((d) => d.mode === mode && d.id === uuid(id));
  requireThat(device, "设备不存在", 404);
  revisionMatches(body, device, "设备");
  requireThat(
    !device.enabled &&
      device.state === "idle" &&
      !device.workflowAttemptId &&
      !s.attempts.some(
        (a) => a.deviceId === id && ["running", "yielded"].includes(a.status),
      ) &&
      !["waiting", "held"].includes(device.session?.status),
    "先暂停设备并等待全部执行、保留会话和控制会话结束，再修改能力",
  );
  requireThat(
    body.simApps !== undefined || body.simCommandCodes !== undefined,
    "至少修改 App 或指令能力",
    400,
  );
  const next = { ...device };
  if (body.simApps !== undefined) {
    requireThat(
      Array.isArray(body.simApps) &&
        body.simApps.length > 0 &&
        body.simApps.length <= Object.keys(APP_NAMES).length &&
        body.simApps.every((app) => Object.hasOwn(APP_NAMES, app)),
      "模拟 App 清单无效",
      400,
    );
    next.simApps = [...new Set(body.simApps)];
  }
  if (body.simCommandCodes === null) delete next.simCommandCodes;
  else if (body.simCommandCodes !== undefined) {
    const available = commandDefinitions(s);
    requireThat(
      Array.isArray(body.simCommandCodes) &&
        body.simCommandCodes.length > 0 &&
        body.simCommandCodes.length <= available.length &&
        body.simCommandCodes.every((code) =>
          available.some((c) => c.code === code),
        ),
      "模拟指令清单无效",
      400,
    );
    next.simCommandCodes = [...new Set(body.simCommandCodes)];
  }
  const stranded = s.jobs.find(
    (job) =>
      job.mode === mode &&
      job.deviceId === id &&
      job.status === "queued" &&
      appBlockers(s, now, next, job).some(
        (b) => b.code === "app-unsupported" || b.code === "command-unsupported",
      ),
  );
  requireThat(
    !stranded,
    "有绑定的排队任务依赖待移除能力，请先回收任务至中央队列",
  );
  const before = {
    simApps: supportedApps(device),
    simCommandCodes: device.simCommandCodes || null,
  };
  Object.assign(device, next, {
    revision: device.revision + 1,
    updatedAt: now,
  });
  if (body.simCommandCodes === null) delete device.simCommandCodes;
  ensureApps(s, device); // Existing app rows and cooldown history remain, even when disabled.
  event(
    s,
    now,
    "device-capabilities",
    `${device.name} 更新模拟 App / 指令能力，设备保持暂停`,
    {
      deviceId: id,
      before,
      after: {
        simApps: supportedApps(device),
        simCommandCodes: device.simCommandCodes || null,
      },
    },
  );
  return publicDevice(device);
}

export const WORKSTATION_SCENARIOS = [
  {
    id: "mixed",
    name: "长短任务混合",
    description: "四个平台的长短任务进入中央队列，观察单机串行与多机并发。",
  },
  {
    id: "affinity",
    name: "同 App 亲和与空闲分流",
    description:
      "连续小红书任务分两批到达，根据所选策略比较亲和排队与空闲机分流。",
  },
  {
    id: "cooldown",
    name: "冷却与跨 App 使用",
    description:
      "首台小红书初始冷却 5 秒，各 App 任务结束后冷却 3 秒，观察其它 App 继续匹配。",
  },
  {
    id: "burst",
    name: "API 洪峰与积压",
    description: "集中提交有界混合任务，观察中央队列、各设备等待与完成速度。",
  },
];

// All-or-nothing even for direct callers; Store.atomic provides the durable lock.
export function launchWorkstationDemo(s, now, mode, body) {
  simulation(mode);
  object(body, ["key", "rack", "deviceCount", "scenario", "strategyId"]);
  const key = str(body.key, "演示幂等键", 100);
  const rack = str(body.rack, "独立演示机架", 100);
  const deviceCount = body.deviceCount;
  requireThat(
    [2, 10, 20, 50, 100].includes(deviceCount),
    "演示设备数须为 2、10、20、50 或 100",
    400,
  );
  requireThat(
    WORKSTATION_SCENARIOS.some((v) => v.id === body.scenario),
    "此场景仅支持虚拟对照或尚未实现实时演示",
    400,
  );
  const strategyId =
    body.strategyId === undefined ? null : str(body.strategyId, "策略版本 ID");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        key,
        rack,
        deviceCount,
        scenario: body.scenario,
        strategyId,
      }),
    )
    .digest("hex");
  const prior = s.devices.find(
    (d) =>
      d.mode === mode &&
      d.workstationDemo?.runId === key &&
      d.workstationDemo.fingerprint,
  )?.workstationDemo;
  if (prior) {
    requireThat(
      prior.fingerprint === fingerprint,
      "同一演示幂等键不能用于不同配置",
    );
    return { ...structuredClone(prior), replayed: true };
  }
  requireThat(
    !s.devices.some((d) => d.mode === mode && d.rack === rack),
    "演示须使用新的独立机架名，不覆盖现有机架",
  );
  requireThat(
    !s.resources?.some((r) => r.mode === mode && r.rack === rack) &&
      !s.loopPolicies?.some((p) => p.mode === mode && p.rack === rack),
    "此机架名已保留资源策略，请使用新的独立机架名",
  );
  requireThat(
    !s.jobs.some(
      (j) =>
        j.mode === mode && (j.runId === key || j.key?.startsWith(`${key}:`)),
    ),
    "演示幂等键已被其它任务使用",
  );
  requireThat(
    s.devices.filter((d) => d.mode === mode).length + deviceCount <= 100,
    "新增演示后超出模拟池 100 台上限；现有机架和历史不会自动删除",
    429,
  );
  const jobCount = Math.min(
    body.scenario === "burst" ? deviceCount * 6 : deviceCount * 2,
    200,
  );
  requireThat(
    s.jobs.filter(
      (j) => j.mode === mode && ["queued", "running"].includes(j.status),
    ).length +
      jobCount <=
      200,
    "演示任务将超出 200 个活动任务上限，请等待或取消排队任务",
    429,
  );
  const strategy = strategyId
    ? resolveStrategy(s, strategyId)
    : listStrategies(s).find((row) => row.recommended) ||
      resolveStrategy(s, "pool.balanced");
  requireThat(strategy, "可用调度策略不存在，请选择未归档策略", 400);
  const work = structuredClone(s);
  const devices = Array.from({ length: deviceCount }, (_, index) => {
    const d = register(work, now, mode, {
      name: `演示手机 ${String(index + 1).padStart(3, "0")}`,
      rack,
      host: `模拟宿主机 ${Math.floor(index / 10) + 1}`,
      simApps: ["xhs", "weibo", "xianyu", "pdd"],
    });
    d.slot = index + 1;
    return d;
  });
  const policy = applyStrategy(work, now, mode, {
    rack,
    revision: 0,
    strategyId: strategy.id,
  });
  if (body.scenario === "cooldown") {
    for (const d of devices)
      for (const app of ensureApps(work, d)) app.cooldownMs = 3000;
    const first = ensureApps(work, devices[0]).find(
      (app) => app.appId === "xhs",
    );
    first.cooldownUntil = now + 5000;
  }
  const types =
    body.scenario === "affinity"
      ? ["xhs.list", "xhs.detail", "xhs.ocr"]
      : body.scenario === "cooldown"
        ? ["xhs.list", "weibo.list", "pdd.refresh", "xianyu.refresh"]
        : [
            "xhs.search10",
            "pdd.search5",
            "weibo.list",
            "xhs.ocr",
            "xianyu.refresh",
            "pdd.search_detail_ocr",
            "pdd.refresh",
            "weibo.search",
          ];
  const jobIds = [];
  for (let index = 0; index < jobCount; index++) {
    const code = types[index % types.length];
    const def = definitions(work)
      .filter((d) => d.mode === mode && d.code === code)
      .sort((a, b) => b.version - a.version)[0];
    requireThat(
      def && !def.archived,
      `演示所需任务 ${code} 已归档或不存在，请先恢复`,
      409,
    );
    const job = addWorkflow(work, now, mode, {
      key: `${key}:${index + 1}`,
      runId: key,
      rack,
      definitionId: def.id,
      priority: index % 4 === 0 ? 3 : 5,
      keyword: `演示主题 ${index + 1}`,
      target: `demo-item-${index + 1}`,
    });
    if (body.scenario === "affinity" && index >= deviceCount)
      job.notBefore = now + 1500;
    jobIds.push(job.id);
  }
  const metadata = {
    runId: key,
    fingerprint,
    rack,
    deviceCount,
    scenario: body.scenario,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    policyRevision: policy.revision,
    jobCount,
    jobIds,
    createdAt: now,
  };
  // One durable source for replay; every device carries only the run identity.
  for (const d of devices) d.workstationDemo = { runId: key };
  devices[0].workstationDemo = structuredClone(metadata);
  event(
    work,
    now,
    "workstation-demo",
    `${rack}：${deviceCount} 台模拟手机、${jobCount} 个任务进入中央队列`,
    { runId: key, rack },
  );
  Object.assign(s, work);
  return { ...metadata, replayed: false };
}
