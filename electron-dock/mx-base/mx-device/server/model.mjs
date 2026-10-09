import { randomUUID, createHash } from "node:crypto";

export class Fault extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
export const requireThat = (yes, message, status) => {
  if (!yes) throw new Fault(message, status);
};
export const str = (v, name, max = 120) => {
  requireThat(
    typeof v === "string" && v.trim() && v.length <= max,
    `${name}必填，最多 ${max} 字符`,
    400,
  );
  return v.trim();
};
export const realm = (v) => {
  requireThat(["sim", "real"].includes(v), "无效的运行模式", 400);
  return v;
};
export const uuid = (v) => {
  requireThat(
    typeof v === "string" &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v),
    "无效 ID",
    400,
  );
  return v;
};
export function origin(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Fault("服务地址无效", 400);
  }
  requireThat(
    u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      Number(u.port) >= 18081 &&
      Number(u.port) <= 18180 &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "兼容适配器仅允许执行器宿主机 http://127.0.0.1:18081–18180；不接受路径、凭证或重定向",
    400,
  );
  return u.origin;
}
export function noteLink(value) {
  const text = str(value, "详情链接", 8192);
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Fault("详情链接无效", 400);
  }
  requireThat(
    u.protocol === "https:" &&
      u.hostname === "www.xiaohongshu.com" &&
      /^\/explore\/[a-zA-Z0-9]+\/?$/.test(u.pathname) &&
      !u.username &&
      !u.password &&
      !u.hash,
    "请使用搜索结果中的小红书 HTTPS explore 链接",
    400,
  );
  return text;
}
const event = (s, mode, at, type, message, more = {}) =>
  s.events.push({ id: randomUUID(), mode, at, type, message, ...more });
const bump = (d) => {
  d.revision++;
};
const active = (j) => ["queued", "running"].includes(j.status);
const findDevice = (s, mode, id) => {
  const d = s.devices.find((d) => d.mode === mode && d.id === id);
  requireThat(d, "设备不存在", 404);
  return d;
};
export function register(s, now, mode, body) {
  requireThat(
    s.devices.filter((d) => d.mode === mode).length < 64,
    "首版每个模式最多 64 台设备",
  );
  const endpoint = mode === "real" ? origin(body.origin) : null;
  const workerId =
    mode === "real" ? str(body.workerId, "执行器") : "simulation";
  const resourceKey =
    mode === "real" ? `${workerId}:${endpoint}` : randomUUID();
  const accountKey =
    mode === "real" ? str(body.accountKey, "账号资源标识") : resourceKey;
  requireThat(
    !s.devices.some(
      (d) =>
        d.mode === mode &&
        (d.resourceKey === resourceKey || d.accountKey === accountKey),
    ),
    "该入口或账号资源已登记；不能给同一手机另起别名绕过互斥",
  );
  if (mode === "real" && body.serial)
    requireThat(
      !s.devices.some(
        (d) => d.mode === mode && d.serial === String(body.serial).trim(),
      ),
      "该序列号已登记，不能重复占用同一手机",
    );
  if (mode === "real")
    requireThat(body.approved === true, "必须批准此本机连接目标", 400);
  const d = {
    id: randomUUID(),
    mode,
    name: str(body.name, "设备名称", 80),
    rack: str(body.rack || "未分配机架", "机架"),
    host: str(body.host || "未命名宿主机", "宿主机"),
    workerId,
    origin: endpoint,
    resourceKey,
    accountKey,
    identity: mode === "real" ? "legacy-endpoint-unverified" : "simulated",
    serial: body.serial ? str(body.serial, "序列号") : null,
    enabled: mode === "sim",
    state: "idle",
    connected: mode === "sim" ? "online" : "unknown",
    revision: 1,
    epoch: 1,
    cooldownUntil: 0,
    probe: null,
    projection: null,
    createdAt: now,
  };
  s.devices.push(d);
  event(
    s,
    mode,
    now,
    "registered",
    `${d.name} 已登记${mode === "real" ? "，默认暂停；物理身份待核验" : ""}`,
    { deviceId: d.id },
  );
  return d;
}
export function addJob(s, now, mode, body) {
  const key = str(body.key, "幂等键"),
    operation = body.operation;
  requireThat(
    ["search", "note"].includes(operation),
    "只支持有界搜索和详情任务",
    400,
  );
  const input =
    operation === "search"
      ? {
          keyword: str(body.keyword, "关键词", 200),
          pages: Number(body.pages ?? 1),
        }
      : { input: body.sourceJobId ? null : noteLink(body.input) };
  if (operation === "search")
    requireThat(
      Number.isInteger(input.pages) && input.pages >= 1 && input.pages <= 3,
      "每个搜索会话限定 1–3 页",
      400,
    );
  const sourceJobId = body.sourceJobId ? uuid(body.sourceJobId) : null;
  requireThat(
    !sourceJobId || operation === "note",
    "只有详情任务可以引用搜索结果",
    400,
  );
  const deviceId = body.deviceId ? uuid(body.deviceId) : null;
  const priority = Number(body.priority ?? 5);
  requireThat(
    Number.isInteger(priority) && priority >= 1 && priority <= 9,
    "优先级为 1–9，1 最高",
    400,
  );
  const spec = { operation, input, deviceId, sourceJobId, priority };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(spec))
    .digest("hex");
  const previous = s.jobs.find((j) => j.mode === mode && j.key === key);
  if (previous) {
    requireThat(
      previous.fingerprint === fingerprint,
      "同一幂等键不能用于不同任务",
    );
    return previous;
  }
  requireThat(
    s.jobs.filter((j) => j.mode === mode && active(j)).length < 200,
    "任务池已满（200）",
    429,
  );
  if (deviceId) {
    const d = findDevice(s, mode, deviceId);
    requireThat(
      d.enabled && d.state !== "quarantined",
      "目标设备尚未启用或待核验",
    );
  }
  if (mode === "real")
    requireThat(deviceId, "兼容真机任务必须明确指定设备；不自动更换账号", 400);
  if (sourceJobId) {
    const src = s.jobs.find((j) => j.id === sourceJobId && j.mode === mode);
    requireThat(src?.operation === "search", "依赖的搜索任务不存在", 400);
    if (mode === "real")
      requireThat(src.deviceId === deviceId, "真实详情需沿用来源设备和账号");
  }
  const j = {
    id: randomUUID(),
    mode,
    key,
    fingerprint,
    ...spec,
    status: "queued",
    createdAt: now,
    notBefore: now,
    attemptCount: 0,
    reason: sourceJobId ? "等待来源搜索" : "等待兼容设备",
    lastDeviceId: null,
    runId: body.runId || null,
  };
  s.jobs.push(j);
  event(
    s,
    mode,
    now,
    "queued",
    `${operation === "search" ? `搜索「${input.keyword}」` : "详情任务"} 已进入任务池`,
    { jobId: j.id },
  );
  return j;
}
export function control(s, now, mode, id, body) {
  const d = findDevice(s, mode, id);
  requireThat(body.revision === d.revision, "设备状态已更新，请刷新后重试");
  const current = s.attempts.find(
    (a) => a.deviceId === id && a.status === "running",
  );
  if (body.action === "pause") d.enabled = false;
  else if (body.action === "enable") {
    requireThat(!current && d.state === "idle", "设备执行中或待核验");
    if (mode === "real") {
      requireThat(
        d.probe?.idle === true && now - d.probe.at < 60000,
        "请先检查连接，并取得 60 秒内的空闲证据",
      );
      requireThat(
        body.confirmedExclusive === true,
        "请确认 Hub 旧调度和其他调用方已停止，手机由本中心独占",
      );
    }
    requireThat(d.connected !== "offline", "设备离线");
    d.enabled = true;
  } else if (body.action === "recover") {
    requireThat(
      d.state === "quarantined" && !current && now >= (d.recoveryAfter || 0),
      "尚不能恢复，须等待执行租约结束",
    );
    requireThat(
      body.confirmedStopped === true && str(body.reason, "核验说明", 500),
      "需确认旧执行器及手机操作已停止",
    );
    if (mode === "real")
      requireThat(
        d.probe?.idle && now - d.probe.at < 60000,
        "须重新取得空闲证据",
      );
    d.state = "idle";
    d.enabled = false;
    d.epoch++;
    d.cooldownUntil = now + 2000;
  } else if (body.action === "disconnect") {
    requireThat(mode === "sim", "断线注入只允许模拟设备", 400);
    d.connected = "offline";
    d.enabled = false;
    d.epoch++;
    if (current) {
      current.status = "interrupted";
      current.completedAt = now;
      const j = s.jobs.find((j) => j.id === current.jobId);
      j.status = "queued";
      j.notBefore = now + 6000;
      j.reason = "模拟中断：6 秒后由其他设备领取";
      j.lastDeviceId = id;
      d.state = "idle";
      event(
        s,
        mode,
        now,
        "sim-interrupted",
        `${d.name} 模拟中断，任务保留；旧尝试不能提交结果`,
        { jobId: j.id, deviceId: id },
      );
    }
  } else if (body.action === "reconnect") {
    requireThat(mode === "sim", "仅模拟模式可直接恢复连接", 400);
    requireThat(!current, "设备仍在执行");
    d.connected = "online";
    d.state = "idle";
    d.enabled = true;
    d.epoch++;
  } else throw new Fault("未知设备操作", 400);
  bump(d);
  event(s, mode, now, body.action, `${d.name}：${body.action}`, {
    deviceId: id,
  });
  return d;
}
export function recordProbe(s, now, mode, id, revision, observation) {
  const d = findDevice(s, mode, id);
  requireThat(d.revision === revision, "检查期间设备状态已变化，请重新检查");
  d.probe = { ...observation, at: now };
  d.connected = observation.reachable ? "online" : "unknown";
  if (!observation.idle) d.enabled = false;
  if (observation.projection)
    d.projection = {
      ...observation.projection,
      observedAt: now,
      source: "real",
      progressAt:
        d.projection?.fingerprint === observation.projection.fingerprint
          ? d.projection.progressAt
          : now,
    };
  bump(d);
  event(
    s,
    mode,
    now,
    "probe",
    `${d.name}：${observation.reachable ? "接口可达" : "接口不可达"} / ${observation.idle ? "报告空闲" : "不可判定为可调度"}`,
    { deviceId: id },
  );
  return d;
}
export function sweep(s, now, mode) {
  for (const a of s.attempts.filter(
    (a) => a.mode === mode && a.status === "running" && a.leaseUntil <= now,
  )) {
    const j = s.jobs.find((j) => j.id === a.jobId),
      d = findDevice(s, mode, a.deviceId);
    a.status = "unknown";
    a.completedAt = now;
    a.error = "执行租约过期，结果未知";
    if (j) {
      j.status = "unknown";
      j.reason = a.error;
      j.completedAt = now;
    }
    d.enabled = false;
    d.state = "quarantined";
    d.recoveryAfter = a.leaseUntil;
    bump(d);
    event(
      s,
      mode,
      now,
      "unknown",
      "租约过期：隔离设备；未派发任务仍在池中，不盲目重试",
      { jobId: a.jobId, deviceId: d.id },
    );
  }
}
export function claim(s, now, mode, workerId) {
  sweep(s, now, mode);
  const devices = s.devices.filter(
    (d) =>
      d.mode === mode &&
      d.enabled &&
      d.state === "idle" &&
      d.connected !== "offline" &&
      d.cooldownUntil <= now &&
      (mode === "sim" || d.workerId === workerId),
  );
  devices.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const pending = s.jobs.filter(
    (j) => j.mode === mode && j.status === "queued" && j.notBefore <= now,
  );
  const score = (j) =>
    Math.max(1, j.priority - Math.floor((now - j.createdAt) / 30000));
  pending.sort(
    (a, b) =>
      score(a) - score(b) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
  for (const j of pending) {
    if (j.sourceJobId) {
      const src = s.jobs.find((x) => x.id === j.sourceJobId);
      if (!src || active(src)) continue;
      if (src.status !== "succeeded") {
        j.status = "blocked";
        j.reason = "来源任务未成功，不重新采集";
        j.completedAt = now;
        continue;
      }
      const link = src.result?.pages?.[0]?.items?.[0]?.detailInput;
      if (!link) {
        j.status = "skipped";
        j.reason = "来源搜索没有可用详情链接";
        j.completedAt = now;
        continue;
      }
      try {
        j.input.input = noteLink(link);
      } catch {
        j.status = "blocked";
        j.reason = "来源详情链接未通过校验";
        j.completedAt = now;
        continue;
      }
    }
    const d = devices.find((d) => !j.deviceId || d.id === j.deviceId);
    if (!d) continue;
    const a = {
      id: randomUUID(),
      jobId: j.id,
      mode,
      deviceId: d.id,
      workerId,
      epoch: d.epoch,
      status: "running",
      createdAt: now,
      leaseUntil: now + 180000,
      dispatchedAt: null,
      checkpoints: [],
    };
    s.attempts.push(a);
    j.status = "running";
    j.attemptCount++;
    j.lastDeviceId = d.id;
    j.reason = `优先级 ${j.priority}，等待提升后 ${score(j)}；设备空闲且依赖满足`;
    j.startedAt = now;
    d.state = "running";
    bump(d);
    event(s, mode, now, "claimed", `${d.name} 领取任务；${j.reason}`, {
      jobId: j.id,
      deviceId: d.id,
      attemptId: a.id,
    });
    return { device: d, job: j, attempt: a };
  }
  return null;
}
export function owned(s, now, a) {
  const current = s.attempts.find((x) => x.id === a.id),
    d = s.devices.find((x) => x.id === a.deviceId);
  return (
    current?.status === "running" &&
    current.epoch === a.epoch &&
    current.leaseUntil > now &&
    d?.epoch === a.epoch
  );
}
export function markDispatch(s, now, a) {
  if (!owned(s, now, a)) return false;
  const row = s.attempts.find((x) => x.id === a.id);
  row.dispatchedAt ??= now;
  return true;
}
export function checkpoint(s, now, a, result) {
  if (!owned(s, now, a)) return false;
  s.attempts.find((x) => x.id === a.id).checkpoints.push(result);
  const d = s.devices.find((d) => d.id === a.deviceId);
  d.projection = {
    source: a.mode === "sim" ? "sim" : "real",
    observedAt: now,
    progressAt: now,
    type: result.detail ? "note" : "search",
    page: result.page || null,
    count: result.count ?? null,
    keyword: result.keyword || null,
    status: result.status || "步骤完成",
    items: (result.items || [])
      .map((i) => ({ id: i.id, title: i.title, authorName: i.authorName }))
      .slice(0, 50),
    detail: result.detail
      ? {
          id: result.detail.id,
          title: result.detail.title,
          content: result.detail.content,
        }
      : null,
    isBusy: false,
  };
  bump(d);
  event(
    s,
    a.mode,
    now,
    "checkpoint",
    result.detail
      ? "详情证据已保存"
      : `已确认第 ${result.page} 页，${result.count} 条`,
    { jobId: a.jobId, deviceId: a.deviceId, projection: d.projection },
  );
  return true;
}
export function finish(s, now, a, outcome) {
  const row = s.attempts.find((x) => x.id === a.id);
  if (!row) return;
  if (!owned(s, now, a)) {
    row.lateEvidence ??= { at: now, ...outcome };
    event(s, a.mode, now, "late", "迟到回执保留为证据，不覆盖当前任务", {
      jobId: a.jobId,
      attemptId: a.id,
    });
    return;
  }
  const j = s.jobs.find((j) => j.id === a.jobId),
    d = findDevice(s, a.mode, a.deviceId);
  row.completedAt = now;
  row.result = outcome.result;
  row.error = outcome.error;
  if (outcome.blockedBeforeDispatch && !row.dispatchedAt) {
    row.status = "blocked";
    j.status = "queued";
    j.reason = "手机未报告空闲，已暂停设备；任务保留";
    d.enabled = false;
    d.state = "idle";
  } else if (outcome.error) {
    row.status = "unknown";
    j.status = "unknown";
    j.reason = outcome.error;
    j.completedAt = now;
    d.state = "quarantined";
    d.enabled = false;
    d.recoveryAfter = row.leaseUntil;
  } else {
    row.status = "succeeded";
    j.status = "succeeded";
    j.result = outcome.result;
    j.completedAt = now;
    j.reason = "全部已确认步骤完成";
    d.state = "idle";
    d.cooldownUntil = now + (a.mode === "real" ? 2000 : 300);
  }
  bump(d);
  event(s, a.mode, now, row.status, `${d.name}：${j.reason}`, {
    jobId: j.id,
    deviceId: d.id,
    attemptId: a.id,
  });
}
export function cancel(s, now, mode, id) {
  const j = s.jobs.find((j) => j.mode === mode && j.id === id);
  requireThat(j?.status === "queued", "只能取消未派发任务");
  j.status = "cancelled";
  j.completedAt = now;
  j.reason = "管理员取消";
  event(s, mode, now, "cancelled", "取消未派发任务", { jobId: id });
  return j;
}
export function scenario(s, now, kind, key) {
  requireThat(
    ["five", "failover", "priority"].includes(kind),
    "未知演示场景",
    400,
  );
  const prior = s.jobs.find((j) => j.mode === "sim" && j.runId === key);
  if (prior) return { runId: key, replayed: true };
  requireThat(
    !s.jobs.some((j) => j.mode === "sim" && active(j)),
    "请先完成当前演示，或取消未执行任务",
  );
  let devices = s.devices.filter((d) => d.mode === "sim");
  while (devices.length < 2) {
    register(s, now, "sim", {
      name: `模拟手机 ${devices.length ? "B" : "A"}`,
      rack: "演示机架",
      host: "模拟宿主机",
    });
    devices = s.devices.filter((d) => d.mode === "sim");
  }
  devices.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  for (const [i, d] of devices.entries()) {
    d.enabled = i === 0 || (kind === "failover" && i === 1);
    d.connected = "online";
    d.state = "idle";
    d.cooldownUntil = 0;
    d.epoch++;
    bump(d);
  }
  const put = (n, b) =>
    addJob(s, now + n, "sim", {
      key: `${key}:${n}`,
      runId: key,
      priority: 5,
      ...b,
    });
  const a = put(1, {
    operation: "search",
    keyword: "美食",
    pages: 2,
    priority: kind === "priority" ? 1 : 5,
  });
  if (kind === "priority") {
    const b = put(2, {
      operation: "search",
      keyword: "后台长任务",
      pages: 3,
      priority: 8,
    });
    b.notBefore = now + 1500;
    const c = put(3, {
      operation: "note",
      input: "https://www.xiaohongshu.com/explore/demo3",
      priority: 1,
    });
    c.notBefore = now + 3500;
  } else {
    put(2, {
      operation: "note",
      input: "https://www.xiaohongshu.com/explore/demo1",
    });
    put(3, { operation: "note", sourceJobId: a.id });
    put(4, { operation: "search", keyword: "杭州", pages: 1 });
    put(5, { operation: "search", keyword: "旅行", pages: 1, priority: 8 });
  }
  event(
    s,
    "sim",
    now,
    "scenario",
    kind === "failover"
      ? "双机演示已开始：可点击设备 A 的模拟断线，观察接管"
      : "演示任务已入池；全部为模拟，不连接真机",
    { runId: key },
  );
  return { runId: key };
}
