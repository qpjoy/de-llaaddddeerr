// Virtual time drives the same claim, command and receipt model as the live lab.
// This module has no transport, database, HTTP, or real-device execution path.
import { register, addJob, claim, requireThat } from "./model.mjs";
import {
  beginCommand,
  completeCommand,
  simulateCommand,
} from "./workflows.mjs";
import {
  BUILTIN_DEFINITIONS,
  COMMANDS,
  commandByCode,
} from "./workflow-catalog.mjs";
import { configureLoops, DEFAULT_LOOP_POLICY } from "./loop-policy.mjs";
import {
  DEFAULT_POOL_POLICY,
  normalizePoolPolicy,
  poolAppPolicy,
  poolRunHistory,
} from "./pool-policy.mjs";
import { planPool } from "./pool-planner.mjs";
import { deviceApps } from "./apps.mjs";

export const POOL_SCENARIOS = [
  {
    id: "mixed",
    name: "混合长短任务",
    description: "搜索翻页、详情、微博和闲鱼刷新交错到达；完整会话独占设备。",
  },
  {
    id: "affinity",
    name: "同 App 亲和与空闲分流",
    description: "已有小红书热设备，连续小任务到达；比较短暂等待与立即分散。",
  },
  {
    id: "cooldown",
    name: "冷却边界与多 App",
    description: "小红书预算即将耗尽，部分设备正在冷却；其他 App 仍可执行。",
  },
  {
    id: "burst",
    name: "API 洪峰与积压",
    description: "有界批次同时入池，再加入一波高优先级请求，观察长任务等待。",
  },
  {
    id: "capabilities",
    name: "异构能力与指令迁入",
    description:
      "设备只支持部分 App/指令；8 秒后给空闲设备补充能力，重新匹配排队任务。",
  },
  {
    id: "failure",
    name: "丢失可信回执与隔离",
    description:
      "首个任务收到身份不匹配回执，设备隔离；保留部分证据，未执行任务继续分配。",
  },
  {
    id: "scale",
    name: "从两台逐步扩容",
    description: "从 2 台开始，8 秒后增加到选定规模；只重排尚未执行的任务。",
  },
  {
    id: "policy-change",
    name: "流量变化与策略替换",
    description: "8 秒后切换为分散策略；保留已执行会话和已有冷却及预算记录。",
  },
];
const RACK = "虚拟调度池";
const START = 1000000;
const MAX_TIME = 600000;
const apps = ["xhs", "weibo", "xianyu"];
const idFor = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function random(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let n = Math.imul(value ^ (value >>> 15), value | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}
function workload(scenario, deviceCount, seed) {
  const rng = random(seed);
  const count = Math.min(160, Math.max(24, deviceCount * 4));
  return Array.from({ length: count }, (_, index) => {
    let code = ["xhs.search10", "xhs.detail", "weibo.search", "xianyu.refresh"][
      index % 4
    ];
    if (scenario === "affinity")
      code = index % 8 === 7 ? "weibo.list" : "xhs.detail";
    if (scenario === "cooldown")
      code = index % 4 ? "xhs.detail" : "xianyu.refresh";
    const at =
      scenario === "burst"
        ? index < count * 0.75
          ? 0
          : 5000
        : scenario === "affinity"
          ? index * 450
          : index * 180 + Math.floor(rng() * 100);
    const def = BUILTIN_DEFINITIONS.find((d) => d.code === code);
    const duration = [];
    for (const step of def.steps)
      for (let i = 0; i < step.repeat; i++)
        duration.push(
          Math.round(commandByCode(step.code).estimateMs * (0.7 + rng() * 0.8)),
        );
    return {
      index,
      code,
      at,
      duration,
      priority: scenario === "burst" && at ? 2 : 5,
    };
  }).sort((a, b) => a.at - b.at || a.index - b.index);
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] || 0;
};

export function simulationOptions(body = {}) {
  requireThat(
    body && typeof body === "object" && !Array.isArray(body),
    "模拟参数无效",
    400,
  );
  const scenario = body.scenario ?? "mixed";
  const deviceCount = body.deviceCount ?? 10;
  const seed = body.seed ?? 42;
  requireThat(
    POOL_SCENARIOS.some((s) => s.id === scenario),
    "未知演练场景",
    400,
  );
  requireThat(
    [2, 10, 20, 50, 100].includes(deviceCount),
    "设备数须为 2/10/20/50/100",
    400,
  );
  requireThat(
    Number.isInteger(seed) && seed >= 0 && seed <= 2147483647,
    "seed 须为非负 32 位整数",
    400,
  );
  const policy = normalizePoolPolicy(body.policy || DEFAULT_POOL_POLICY);
  requireThat(policy.enabled !== false, "策略对照要求启用调度池规则", 400);
  return { scenario, deviceCount, seed, policy };
}

function execute(options, jobs, baseline = false, experiment = {}) {
  const { scenario, deviceCount } = options;
  const policy = {
    ...options.policy,
    strategy: baseline ? "spread" : options.policy.strategy,
  };
  const state = {
    devices: [],
    jobs: [],
    attempts: [],
    events: [],
    resources: [],
    apps: [],
    commands: [],
    definitions: structuredClone(BUILTIN_DEFINITIONS),
    loopPolicies: [],
  };
  const timeline = [];
  const active = new Map();
  const busyTime = new Map();
  const names = new Map();
  const jobSpecs = new Map();
  const lastPlan = new Map();
  const previousApp = new Map();
  const bindings = new Map();
  const migrated = new Set();
  let now = START,
    index = 0,
    replans = 0,
    appSwitches = 0,
    switchTimeMs = 0,
    violations = 0;
  let changed = false,
    failed = false,
    peak = 0,
    totalCapacityMs = 0,
    rounds = 0;
  const note = (type, message, extra = {}) => {
    if (timeline.length < 1200)
      timeline.push({ at: now - START, type, message, ...extra });
  };
  const label = (job) =>
    `T${String(jobSpecs.get(job.id)?.index + 1).padStart(3, "0")}`;
  function addDevice(number) {
    const inventory = scenario === "capabilities" ? [apps[number % 3]] : apps;
    const codes = COMMANDS.filter(
      (c) => !c.appId || inventory.includes(c.appId),
    )
      .map((c) => c.code)
      .filter(
        (code) =>
          scenario !== "capabilities" ||
          number % 2 ||
          code !== "xhs.note.detail",
      );
    const d = register(state, now, "sim", {
      name: `设备 ${String(number + 1).padStart(3, "0")}`,
      rack: RACK,
      host: `虚拟主机 ${Math.floor(number / 10) + 1}`,
      simApps: inventory,
      simCommandCodes: codes,
    });
    const originalId = d.id;
    d.id = idFor(1000 + number);
    for (const app of state.apps.filter((a) => a.deviceId === originalId)) {
      app.deviceId = d.id;
      app.id = `${d.id}/${app.appId}`;
    }
    d.taskIntervalMs = 0;
    names.set(d.id, d.name);
    busyTime.set(d.id, 0);
    if (scenario === "affinity" && number === 0) {
      d.projection = { appId: "xhs" };
      d.foregroundAppId = "xhs";
      const app = state.apps.find(
        (a) => a.deviceId === d.id && a.appId === "xhs",
      );
      app.lastDispatchedAt = now - 1;
      app.lastClaimedAt = now - 1;
    }
    if (scenario === "cooldown" && number % 2 === 0) {
      state.apps.find(
        (a) => a.deviceId === d.id && a.appId === "xhs",
      ).cooldownUntil = now + 9000;
    }
    return d;
  }
  const initial = scenario === "scale" ? 2 : deviceCount;
  for (let n = 0; n < initial; n++) addDevice(n);
  // The old checkpoint demo has a separate policy. Disable its synthetic random
  // rests here so all compared runs share the pool policy's deterministic budget.
  configureLoops(state, now, "sim", {
    ...DEFAULT_LOOP_POLICY,
    rack: RACK,
    revision: 0,
    smallLimit: 100,
    largeLimit: 100,
    maxInsertions: 0,
    cooldownMinMs: 0,
    cooldownMaxMs: 0,
    commandDelayMs: 200,
    scheduler: policy,
  });
  function start(work) {
    if (active.has(work.device.id)) {
      violations++;
      throw Error("模拟不变量失败：单机指令重叠");
    }
    if (
      bindings.has(work.job.id) &&
      bindings.get(work.job.id) !== work.device.id
    )
      throw Error("模拟不变量失败：已执行会话跨设备迁移");
    bindings.set(work.job.id, work.device.id);
    if (work.attempt.dispatchedAt == null) {
      const app = deviceApps(state, work.device).find(
        (a) => a.appId === work.job.appId,
      );
      const appPolicy = poolAppPolicy(
        state.loopPolicies[0].scheduler,
        work.job.appId,
      );
      const history = poolRunHistory(app, now, appPolicy);
      requireThat(
        work.device.mode === "sim" &&
          app.cooldownUntil <= now &&
          work.device.cooldownUntil <= now &&
          history.length < appPolicy.maxRuns &&
          history.reduce(
            (n, r) => n + (r.actualServiceMs ?? r.reservedServiceMs ?? 0),
            0,
          ) +
            work.attempt.estimatedDurationMs <=
            appPolicy.maxServiceMs,
        "模拟不变量失败：新会话的冷却或预计服务预算未满足",
      );
      requireThat(
        work.job.workflow.plan.every((step) =>
          work.device.simCommandCodes.includes(step.code),
        ),
        "模拟不变量失败：缺少指令能力",
      );
    }
    const command = beginCommand(state, now, work.attempt);
    requireThat(command, "模拟指令无法开始");
    const spec = jobSpecs.get(work.job.id);
    // beginCommand adds the policy's switch cost when the App is not in front.
    // Experiments may fix the modeled switch independently of what the planner
    // assumes, to compare a switch-aware plan with an unaware one fairly.
    const switchMs =
      experiment.modeledSwitchMs == null
        ? command.switchMs || 0
        : command.definition?.action === "open" &&
            work.device.foregroundAppId !== work.job.appId
          ? experiment.modeledSwitchMs
          : 0;
    const duration = (spec.duration[command.stepIndex] || 1000) + switchMs;
    switchTimeMs += switchMs;
    active.set(work.device.id, { work, command, end: now + duration });
    if (command.stepIndex === 0) {
      if (
        previousApp.has(work.device.id) &&
        previousApp.get(work.device.id) !== work.job.appId
      )
        appSwitches++;
      previousApp.set(work.device.id, work.job.appId);
      note("started", work.job.reason, {
        jobId: label(work.job),
        deviceId: work.device.name,
        appId: work.job.appId,
      });
    }
  }
  while (rounds++ < 20000 && now - START <= MAX_TIME) {
    // Receipts are processed before new scheduling decisions at the same time.
    for (const [id, item] of [...active]) {
      if (item.end > now) continue;
      const { work, command } = item;
      active.delete(id);
      busyTime.set(id, busyTime.get(id) + item.end - command.createdAt);
      const receipt = simulateCommand(command);
      if (
        scenario === "failure" &&
        jobSpecs.get(work.job.id).index === 0 &&
        !failed
      ) {
        receipt.commandId = "lost-trustworthy-receipt";
        failed = true;
      }
      completeCommand(state, now, work.attempt, command, receipt);
      if (work.job.status === "unknown")
        note("quarantine", "回执无法确认，隔离设备；禁止自动重试此任务", {
          jobId: label(work.job),
          deviceId: work.device.name,
        });
      else if (work.job.status === "succeeded")
        note("completed", "全部指令回执核验完成", {
          jobId: label(work.job),
          deviceId: work.device.name,
          appId: work.job.appId,
        });
      else if (
        work.job.workflow.loop === "small" &&
        work.job.status === "running"
      )
        start(work);
    }
    if (!changed && now >= START + 8000) {
      changed = true;
      if (scenario === "scale") {
        for (let n = initial; n < deviceCount; n++) addDevice(n);
        note("scale", `扩容到 ${deviceCount} 台；运行中任务保持原设备`);
      } else if (scenario === "capabilities") {
        note(
          "capability",
          "能力迁入已排队；各设备在当前会话结束后更新指令清单",
        );
      } else if (scenario === "policy-change") {
        const row = state.loopPolicies[0];
        configureLoops(state, now, "sim", {
          ...row,
          scheduler: { ...policy, strategy: "spread" },
        });
        note("policy", "分配策略改为 spread；执行中的任务与冷却记录保留");
      }
    }
    if (scenario === "capabilities" && changed) {
      for (const d of state.devices.filter(
        (d) => d.state === "idle" && !migrated.has(d.id),
      )) {
        d.simApps = [...apps];
        d.simCommandCodes = COMMANDS.map((c) => c.code);
        migrated.add(d.id);
        note("capability", "设备已空闲，三种 App 的模拟指令迁入完成", {
          deviceId: d.name,
        });
      }
    }
    while (index < jobs.length && jobs[index].at <= now - START) {
      const spec = jobs[index++];
      const job = addJob(state, now, "sim", {
        key: `virtual-${spec.index}`,
        runId: "virtual",
        definitionId: `sim:${spec.code}:1`,
        rack: RACK,
        priority: spec.priority,
        keyword: `合成主题 ${spec.index + 1}`,
      });
      // Deterministic tie ordering; these IDs never leave this isolated state store.
      const oldId = job.id;
      job.id = idFor(spec.index + 1);
      for (const event of state.events)
        if (event.jobId === oldId) event.jobId = job.id;
      jobSpecs.set(job.id, spec);
      // All benchmark sessions are non-preemptible. The existing rack20 scenario
      // separately tests the optional bounded checkpoint insertion mechanism.
      job.workflow.resumable = false;
    }
    const plan = planPool(state, now, { rack: RACK });
    for (const assignment of plan.assignments) {
      const before = lastPlan.get(assignment.jobId);
      if (before && before !== assignment.deviceId) {
        replans++;
        const job = state.jobs.find((j) => j.id === assignment.jobId);
        note(
          "replan",
          `${names.get(before)} → ${names.get(assignment.deviceId)}；${assignment.reason}`,
          { jobId: label(job) },
        );
      }
      lastPlan.set(assignment.jobId, assignment.deviceId);
    }
    let work;
    const round = {};
    while ((work = claim(state, now, "sim", "virtual-worker", { round })))
      start(work);
    peak = Math.max(peak, active.size);
    for (const d of state.devices) {
      if (
        state.commands.filter(
          (c) => c.deviceId === d.id && c.status === "running",
        ).length > 1
      )
        violations++;
    }
    if (
      index === jobs.length &&
      !state.jobs.some((j) => ["queued", "running"].includes(j.status))
    )
      break;
    const future = [now + 1000, START + MAX_TIME + 1];
    if (index < jobs.length) future.push(START + jobs[index].at);
    if (!changed) future.push(START + 8000);
    for (const item of active.values()) future.push(item.end);
    for (const d of state.devices) future.push(d.cooldownUntil || 0);
    for (const app of state.apps) future.push(app.cooldownUntil || 0);
    // Running work is observed by its next receipt event, not a speculative
    // estimate moving one millisecond into the future after an underestimate.
    for (const a of plan.assignments)
      if (!active.has(a.deviceId)) future.push(a.startAt);
    const next = Math.min(...future.filter((t) => t > now));
    totalCapacityMs += (next - now) * state.devices.length;
    now = next;
    // Keep model event history bounded; report evidence is retained separately.
    if (state.events.length > 500) state.events = state.events.slice(-100);
  }
  const complete = state.jobs.filter((j) => j.status === "succeeded");
  const waits = state.jobs
    .filter((j) => j.startedAt != null)
    .map((j) => j.startedAt - j.createdAt);
  const duration = now - START;
  const totalBusy = [...busyTime.values()].reduce((a, b) => a + b, 0);
  return {
    summary: {
      submitted: state.jobs.length,
      completed: complete.length,
      failed: state.jobs.filter(
        (j) => !["queued", "running", "succeeded"].includes(j.status),
      ).length,
      queued: state.jobs.filter((j) => ["queued", "running"].includes(j.status))
        .length,
      makespanMs: duration,
      waitP50Ms: percentile(waits, 0.5),
      waitP95Ms: percentile(waits, 0.95),
      waitP99Ms: percentile(waits, 0.99),
      maxWaitMs: Math.max(0, ...waits),
      turnaroundP95Ms: percentile(
        complete.map((j) => j.completedAt - j.createdAt),
        0.95,
      ),
      utilization: totalCapacityMs ? totalBusy / totalCapacityMs : 0,
      appSwitches,
      switchTimeMs,
      replans,
      peakConcurrency: peak,
      invariantViolations: violations,
      commands: state.commands.length,
      realTransportCalls: 0,
    },
    timeline,
    devices: state.devices.map((d) => ({
      id: d.name,
      name: d.name,
      state: d.state,
      completed: complete.filter((j) => j.lastDeviceId === d.id).length,
      busyMs: busyTime.get(d.id),
      apps: deviceApps(state, d).map((a) => a.appId),
      commandCount: d.simCommandCodes.length,
    })),
    remaining: state.jobs
      .filter((j) => ["queued", "running"].includes(j.status))
      .map((j) => ({
        jobId: label(j),
        appId: j.appId,
        status: j.status,
        blockers: planPool(state, now, { rack: RACK }).blocked.filter(
          (b) => b.jobId === j.id,
        ),
      })),
  };
}

// experiment (internal, not exposed over HTTP): { modeledSwitchMs } fixes the
// simulated App switch time regardless of the policy's planning assumption.
export function runPoolSimulation(body, experiment = {}) {
  const options = simulationOptions(body);
  const jobs = workload(options.scenario, options.deviceCount, options.seed);
  const current = execute(options, jobs, false, experiment);
  const baseline = execute(options, jobs, true, experiment);
  return {
    ...options,
    name: POOL_SCENARIOS.find((s) => s.id === options.scenario).name,
    simulated: true,
    ...current,
    baseline: baseline.summary,
    baselineName: "spread（相同预算与工作负载）",
    invariantChecks: [
      "单机指令互斥",
      "运行后设备绑定不变",
      "新会话冷却准入",
      "预计服务预算与次数准入",
      "完整指令能力",
      "模拟 realm",
    ],
    limitations: [
      "本次是隔离的虚拟时钟演练，不保存到运行中任务池，不调用真实手机。",
      "相同 seed 使用相同逐指令耗时；对照仅比较放置策略，不证明普遍最优。",
      "100 台是虚拟调度实验；在线 Worker 默认并行 10 个模拟执行（可配置），不是生产容量或 HA 验收。",
      "App 切换按策略的切换耗时计入会话第一条打开指令；真实切换耗时需实测校准。",
      "任务最长模拟 10 分钟，未完成项明确保留；等待分位数只统计已开始任务，应结合积压一起判断。",
      "耗时校准来自合成回执；平台限流、真实页面恢复、账号安全、Hub 业务结果契约仍需独立验收。",
    ],
  };
}
