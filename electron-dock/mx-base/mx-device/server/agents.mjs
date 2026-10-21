// Center side of the host Agent protocol (V2-3), as pure transaction
// functions over state. Transport (HTTP long-poll, batched reports) lives in
// http.mjs; the Agent itself in server/agent/.
//
// An Agent connects out with its own token. Its devices receive each session
// as a lease grant with a per-device fencing token. The Agent accepts the
// grant and asks for directives; every command is issued by the center
// (beginCommand) as a "run" directive under the lease token and a continuous
// seq, and its receipt is checked before the next one is issued. A
// partitioned Agent therefore finishes at most the command in hand and then
// waits at a safe point; the center always knows whether anything was issued.
//
// Real realm (V2-6 P1): an Agent is approved for one host and must drive its
// phones with the PoC driver. An adopted phone starts paused; it is enabled
// only through control "enable" with fresh idle evidence (a read-only probe
// the Agent runs on request) and the exclusive-owner acknowledgement. A phone
// is either Agent-hosted or a legacy PoC registration, never both.
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  Fault,
  requireThat,
  str,
  register,
  finish,
  returnLease,
  cancelSession,
} from "./model.mjs";
import {
  beginCommand,
  completeCommand,
  resumeOwnSession,
  cleanWorkflowFaults,
} from "./workflows.mjs";
import { findAccount, recordAccountSignal } from "./accounts.mjs";
import {
  AGENT_PROTOCOL,
  AGENT_LEASE_MS,
  AGENT_GRACE_MS,
  AGENT_HEARTBEAT_MS,
  agentOnline,
} from "./agent-lease.mjs";

export const AGENT_SIGNALS = [
  "captcha",
  "rate-limited",
  "logged-out",
  "risk-warning",
  "app-crash",
];
const SERIAL = /^[A-Za-z0-9._:-]{1,80}$/;
// What a real-realm Agent may drive (V2-6 P1): the PoC driver, XHS only.
const REAL_DRIVER = "poc";
const POC_CODES = new Set(["xhs.search", "xhs.search.next", "xhs.note.detail"]);
// A probe request older than this is not run any more (ask again).
const PROBE_FRESH_MS = 30000;
const hash = (token) => createHash("sha256").update(token).digest("hex");
const event = (s, mode, now, type, message, more = {}) =>
  s.events.push({ id: randomUUID(), mode, at: now, type, message, ...more });
const bump = (d) => {
  d.revision++;
};

/** The agent id is the token's prefix, so a transaction can load just that row. */
export const agentIdOf = (token) =>
  typeof token === "string" && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/.test(token)
    ? token.slice(0, 36)
    : null;
export function authenticate(s, token) {
  const id = agentIdOf(token),
    agent = id && (s.agents || []).find((a) => a.id === id);
  const expected = agent && Buffer.from(agent.tokenHash, "hex"),
    actual = Buffer.from(hash(String(token)), "hex");
  if (!agent || !timingSafeEqual(expected, actual))
    throw new Fault("Agent 凭证无效", 401);
  if (agent.status !== "active") throw new Fault("Agent 已停用", 403);
  return agent;
}
const newToken = (id) => `${id}.${randomBytes(32).toString("base64url")}`;

export function agentView(s, now, agent) {
  const devices = s.devices.filter((d) => d.agentId === agent.id);
  return {
    id: agent.id,
    mode: agent.mode,
    name: agent.name,
    host: agent.host,
    status: agent.status,
    revision: agent.revision,
    online: agentOnline(agent, now),
    lastSeenAt: agent.lastSeenAt || null,
    instanceId: agent.instanceId,
    version: agent.version,
    driver: agent.driver,
    capabilities: agent.capabilities || [],
    clockOffsetMs: agent.clockOffsetMs ?? null,
    buffered: agent.buffered || 0,
    pending: agent.pending || [],
    // Reported serials this realm already registers as another device: a
    // phone cannot be adopted twice (real realm: legacy PoC or another Agent).
    conflicts:
      agent.mode === "real"
        ? (agent.pending || []).filter((serial) =>
            s.devices.some((d) => d.mode === "real" && d.serial === serial),
          )
        : [],
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      serial: d.serial,
      rack: d.rack,
      state: d.state,
      connected: d.connected,
      enabled: d.enabled,
    })),
    leases: s.attempts.filter(
      (a) => a.agentId === agent.id && a.status === "running",
    ).length,
  };
}

// ---- Administration (session / admin token) ----

export function createAgent(s, now, mode, body) {
  const real = mode === "real";
  if (real) {
    // The host this Agent runs on is named and approved explicitly; its
    // phones still start paused and need their own confirmation.
    requireThat(
      body?.approved === true,
      "必须批准此宿主机 Agent 接入真实设备",
      400,
    );
    str(body.host, "宿主机", 80);
  }
  s.agents ||= [];
  requireThat(
    s.agents.filter((a) => a.mode === mode).length < 50,
    "最多登记 50 个 Agent",
  );
  const id = randomUUID(),
    token = newToken(id);
  const agent = {
    id,
    mode,
    name: str(body?.name, "Agent 名称", 80),
    host: str(body?.host || "模拟宿主机", "宿主机", 80),
    status: "active",
    tokenHash: hash(token),
    revision: 1,
    createdAt: now,
    lastSeenAt: 0,
    instanceId: null,
    version: null,
    driver: null,
    capabilities: [],
    serials: [],
    pending: [],
  };
  if (real) agent.approvedAt = now;
  s.agents.push(agent);
  event(
    s,
    mode,
    now,
    "agent",
    `登记宿主机 Agent「${agent.name}」${real ? `（真实设备，${agent.host}；只接受 PoC 驱动，登记的手机默认暂停）` : ""}`,
  );
  // The token is shown once; only its hash is stored.
  return { agent: agentView(s, now, agent), token };
}
const findAgent = (s, mode, id) => {
  const agent = (s.agents || []).find((a) => a.id === id && a.mode === mode);
  requireThat(agent, "Agent 不存在", 404);
  return agent;
};
export function changeAgent(s, now, mode, id, body) {
  const agent = findAgent(s, mode, id);
  requireThat(body?.revision === agent.revision, "Agent 已被修改，请刷新", 409);
  requireThat(
    ["disable", "enable", "rotate"].includes(body.action),
    "未知操作",
    400,
  );
  let token = null;
  if (body.action === "disable") agent.status = "disabled";
  if (body.action === "enable") agent.status = "active";
  if (body.action === "rotate") {
    token = newToken(agent.id);
    agent.tokenHash = hash(token);
  }
  agent.revision++;
  event(
    s,
    mode,
    now,
    "agent",
    `Agent「${agent.name}」${{ disable: "已停用：不再签发新租约，在途租约照常结束", enable: "已启用", rotate: "已更换凭证，旧凭证立即失效" }[body.action]}`,
  );
  return { agent: agentView(s, now, agent), token };
}
/** Registers a serial the Agent reported as a new device it hosts. A real
 * phone is registered paused (register), with the account it uses, and
 * takes work only after control "enable" (fresh probe + exclusive). */
export function adoptDevice(s, now, mode, id, body) {
  const agent = findAgent(s, mode, id);
  const serial = str(body?.serial, "设备序列号", 80);
  requireThat(SERIAL.test(serial), "序列号格式无效", 400);
  requireThat(
    (agent.pending || []).includes(serial),
    "该序列号不在 Agent 的待登记清单中",
    409,
  );
  // A PoC-driven phone can only do what the PoC can (XHS, three commands):
  // its Apps and commands come from the driver's report, not the form.
  const poc = agent.driver === "poc";
  const reported = agent.reported?.[serial];
  if (mode === "real") {
    requireThat(agent.status === "active", "Agent 已停用", 409);
    requireThat(
      agent.driver === REAL_DRIVER,
      "真实设备目前只接入 PoC 驱动（L0）；请先让 Agent 以 driver: poc 连接",
      409,
    );
    const apps = (reported?.apps || []).filter((x) => x === "xhs");
    const commands = (reported?.commands || []).filter((x) => POC_CODES.has(x));
    requireThat(
      apps.length && commands.length,
      "Agent 没有为这台手机上报可用的小红书 PoC 能力",
      409,
    );
    const d = register(
      s,
      now,
      mode,
      {
        name: body.name || serial,
        rack: body.rack,
        host: body.host || agent.host,
        accountKey: body.accountKey,
        approved: body.approved,
      },
      { agentId: agent.id, serial, apps, commands },
    );
    Object.assign(d, { driver: "poc", pocLevel: reported?.level || "L0" });
    return adopted(s, now, mode, agent, d, body, serial, true);
  }
  const d = register(s, now, mode, {
    name: body.name || serial,
    rack: body.rack,
    host: body.host || agent.host,
    simApps: poc ? reported?.apps : body.simApps,
    ...(poc && reported?.commands?.length
      ? { simCommandCodes: reported.commands }
      : {}),
  });
  Object.assign(d, { agentId: agent.id, serial, leaseToken: 0 });
  if (poc)
    Object.assign(d, { driver: "poc", pocLevel: reported?.level || "L0" });
  return adopted(s, now, mode, agent, d, body, serial, poc);
}
function adopted(s, now, mode, agent, d, body, serial, poc) {
  // The rack slot this phone is plugged into (unique per rack).
  if (body.slot !== undefined && body.slot !== null && body.slot !== "") {
    const slot = Number(body.slot);
    requireThat(
      Number.isInteger(slot) && slot >= 1 && slot <= 200,
      "插槽号为 1–200",
      400,
    );
    requireThat(
      !s.devices.some(
        (x) =>
          x !== d && x.mode === mode && x.rack === d.rack && x.slot === slot,
      ),
      `${d.rack} 的插槽 ${slot} 已有设备`,
      409,
    );
    d.slot = slot;
  }
  agent.pending = agent.pending.filter((x) => x !== serial);
  event(
    s,
    mode,
    now,
    "agent",
    `${d.name}${d.slot ? `（插槽 ${d.slot}）` : ""} 由 Agent「${agent.name}」托管（${serial}${poc ? "，PoC 驱动" : ""}）${mode === "real" ? "；默认暂停，启用前须检查连接并确认独占" : ""}`,
    { deviceId: d.id },
  );
  return d;
}
/** Asks the Agent to stop a running session at its next safe point. A
 * session parked at a checkpoint has nothing in flight and is cancelled here. */
export function requestStop(s, now, mode, attemptId, body) {
  const a = s.attempts.find((x) => x.id === attemptId && x.mode === mode);
  requireThat(a?.executor === "agent", "只能停止由 Agent 执行的会话", 404);
  const reason = str(body?.reason || "管理员停止", "原因", 200);
  if (a.status === "yielded") {
    cancelSession(s, now, a, `${reason}：会话停在检查点，没有在途指令`);
    return { attemptId, status: "cancelled" };
  }
  requireThat(a.status === "running", "会话已结束", 409);
  a.agentStop ??= { at: now, reason };
  event(
    s,
    mode,
    now,
    "agent-stop",
    `请求 Agent 在下一个安全点停止：${reason}`,
    {
      jobId: a.jobId,
      deviceId: a.deviceId,
      attemptId,
    },
  );
  return { attemptId, status: "stopping" };
}

// ---- Agent messages (Agent token) ----

/** hello: identity, devices and the leases the Agent still holds. Leases it
 * does not hold are settled now: requeued if nothing was issued under them,
 * otherwise unknown (no blind retry). */
export function agentHello(s, now, token, body) {
  const agent = authenticate(s, token);
  const instanceId = str(body?.instanceId, "实例 ID", 80);
  const devices = Array.isArray(body.devices) ? body.devices : [];
  requireThat(
    devices.length <= 200 &&
      devices.every(
        (d) => typeof d?.serial === "string" && SERIAL.test(d.serial),
      ),
    "设备清单无效",
    400,
  );
  const leases = Array.isArray(body.leases) ? body.leases.slice(0, 200) : [];
  const driver = str(body.driver || "sim", "驱动", 20);
  // A real-realm Agent drives phones; only the PoC driver is accepted there.
  requireThat(
    agent.mode === "sim" || driver === REAL_DRIVER,
    "真实设备的 Agent 目前只接受 PoC 驱动（driver: poc）",
    403,
  );
  const restarted = agent.instanceId !== instanceId;
  Object.assign(agent, {
    instanceId,
    protocol: Number(body.protocol) || AGENT_PROTOCOL,
    version: str(body.version || "unknown", "版本", 40),
    driver,
    capabilities: (Array.isArray(body.capabilities) ? body.capabilities : [])
      .filter((x) => typeof x === "string")
      .slice(0, 50),
    lastSeenAt: now,
    serials: devices.map((d) => d.serial),
    // What the driver says each phone can do (bounded); used at adoption.
    reported: Object.fromEntries(
      devices.map((d) => [
        d.serial,
        {
          apps: (Array.isArray(d.apps) ? d.apps : [])
            .filter((x) => typeof x === "string")
            .slice(0, 10),
          commands: (Array.isArray(d.commands) ? d.commands : [])
            .filter((x) => typeof x === "string" && x.length <= 80)
            .slice(0, 100),
          level: typeof d.level === "string" ? d.level.slice(0, 8) : null,
        },
      ]),
    ),
  });
  const bound = s.devices.filter((d) => d.agentId === agent.id);
  agent.pending = agent.serials.filter(
    (serial) => !bound.some((d) => d.serial === serial),
  );
  for (const d of bound) {
    const seen = agent.serials.includes(d.serial);
    if (seen && d.offlineBy === "agent") {
      d.connected = "online";
      delete d.offlineBy;
      bump(d);
    } else if (!seen && d.connected !== "offline") {
      d.connected = "offline";
      d.offlineBy = "agent";
      bump(d);
    }
  }
  const held = new Set(leases.map((l) => `${l.attemptId}:${l.token}`));
  for (const a of s.attempts.filter(
    (a) => a.agentId === agent.id && a.status === "running",
  ))
    if (!held.has(`${a.id}:${a.token}`))
      settleLostLease(
        s,
        now,
        a,
        restarted ? "Agent 重启后不再持有租约" : "Agent 未持有该租约",
      );
  cleanWorkflowFaults(s, now);
  event(
    s,
    agent.mode,
    now,
    "agent",
    `Agent「${agent.name}」${restarted ? "已连接（新实例）" : "已重连"}：${bound.length} 台已登记，${agent.pending.length} 台待登记`,
  );
  return {
    agentId: agent.id,
    // The realm this Agent works for: a simulation Agent must never drive
    // a real phone (its driver checks what it is connected to).
    mode: agent.mode,
    protocol: AGENT_PROTOCOL,
    heartbeatMs: AGENT_HEARTBEAT_MS,
    leaseMs: AGENT_LEASE_MS,
    graceMs: AGENT_GRACE_MS,
    devices: bound.map((d) => ({
      deviceId: d.id,
      serial: d.serial,
      name: d.name,
      token: d.leaseToken || 0,
    })),
    pending: agent.pending,
    now,
  };
}
function settleLostLease(s, now, a, reason) {
  if (!a.leaseIssued) returnLease(s, now, a, reason);
  else
    finish(s, now, a, {
      error: `${reason}，已发出的指令结果未知；隔离设备，不自动重试`,
    });
}
/** heartbeat: liveness, clock offset and lease renewal. */
export function agentHeartbeat(s, now, token, body) {
  const agent = authenticate(s, token);
  if (body?.instanceId !== agent.instanceId)
    throw new Fault("Agent 实例已变化，请重新 hello", 409);
  agent.lastSeenAt = now;
  agent.clockOffsetMs = Number.isFinite(body.clockMs)
    ? Math.round(body.clockMs - now)
    : null;
  agent.buffered = Number.isInteger(body.buffered) ? body.buffered : 0;
  const leases = (Array.isArray(body.leases) ? body.leases : [])
    .slice(0, 200)
    .map(({ attemptId, token: t }) => {
      const a = s.attempts.find((x) => x.id === attemptId);
      if (!a || a.agentId !== agent.id || a.token !== t)
        return { attemptId, token: t, status: "revoked" };
      if (a.status !== "running")
        return { attemptId, token: t, status: a.status };
      if (a.leaseUntil + AGENT_GRACE_MS <= now)
        return { attemptId, token: t, status: "expired" };
      a.leaseUntil = now + AGENT_LEASE_MS;
      return {
        attemptId,
        token: t,
        status: "ok",
        leaseMs: AGENT_LEASE_MS,
        stop: !!a.agentStop,
      };
    });
  return { leases, now };
}
/** poll: grants not accepted yet, stop requests and probe requests. Only a
 * probe request is consumed here (handed out once, like the host worker's
 * claim of a legacy probe: a lost one needs another click). */
export function agentInbox(s, now, token) {
  const agent = authenticate(s, token);
  const grants = [],
    controls = [];
  for (const d of s.devices)
    if (
      d.agentId === agent.id &&
      d.mode === "real" &&
      d.probeRequestedAt > (d.probeTakenAt || 0) &&
      now - d.probeRequestedAt <= PROBE_FRESH_MS
    ) {
      d.probeTakenAt = d.probeRequestedAt;
      bump(d);
      controls.push({
        type: "device.probe",
        deviceId: d.id,
        serial: d.serial,
        requestedAt: d.probeRequestedAt,
      });
    }
  for (const a of s.attempts) {
    if (a.agentId !== agent.id || a.status !== "running") continue;
    const d = s.devices.find((d) => d.id === a.deviceId);
    if (a.agentState === "granted") grants.push(grantMessage(s, now, a, d));
    if (a.agentStop)
      controls.push({
        type: "attempt.stop",
        attemptId: a.id,
        deviceId: a.deviceId,
        token: a.token,
        reason: a.agentStop.reason,
      });
  }
  return { grants, controls, now };
}
/** device.probed: the read-only PoC state the Agent read for a probe
 * request; idle evidence for control "enable" / "recover". In the real realm a
 * PoC simulator is never evidence (realms do not mix). */
export function agentProbed(s, now, token, m) {
  const agent = authenticate(s, token);
  const d = s.devices.find(
    (d) => d.id === m?.deviceId && d.agentId === agent.id,
  );
  requireThat(d, "设备不属于此 Agent", 404);
  requireThat(
    Number.isSafeInteger(m.requestedAt) &&
      m.requestedAt === d.probeTakenAt &&
      d.probe?.requestedAt !== m.requestedAt &&
      now - m.requestedAt <= PROBE_FRESH_MS,
    "检查请求已过期或已有结果，请重新检查",
    409,
  );
  const o =
    m.observation && typeof m.observation === "object" ? m.observation : {};
  const reachable = o.reachable === true,
    simulator = o.simulator === true;
  const crossed = reachable && (d.mode === "real") === simulator;
  const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
  const p = o.poc && typeof o.poc === "object" ? o.poc : null;
  d.probe = {
    reachable,
    idle: reachable && o.idle === true && !crossed,
    simulator,
    error: crossed
      ? d.mode === "real"
        ? "真实设备连接的是 PoC 模拟器，不能作为空闲证据"
        : "模拟设备连接的不是 PoC 模拟器"
      : reachable
        ? null
        : "PoC 不可达",
    poc: p && {
      type: text(p.type, 20),
      keyword: text(p.keyword, 200),
      page: Number.isSafeInteger(p.page) ? p.page : null,
      count: Number.isSafeInteger(p.count) ? p.count : null,
      isBusy: typeof p.isBusy === "boolean" ? p.isBusy : null,
      status: text(p.status, 120),
    },
    source: "agent",
    requestedAt: m.requestedAt,
    at: now,
  };
  if (!d.probe.idle) d.enabled = false;
  bump(d);
  event(
    s,
    d.mode,
    now,
    "probe",
    `${d.name}：Agent 读取 PoC 状态 / ${d.probe.error || (d.probe.idle ? "报告空闲" : "不可判定为可调度")}`,
    { deviceId: d.id },
  );
  return { ok: true, idle: d.probe.idle };
}
function grantMessage(s, now, a, d) {
  const j = s.jobs.find((j) => j.id === a.jobId),
    w = j.workflow;
  return {
    type: "lease.grant",
    attemptId: a.id,
    deviceId: d.id,
    serial: d.serial,
    token: a.token,
    generation: a.executionGeneration,
    leaseMs: Math.max(0, a.leaseUntil - now),
    job: {
      id: j.id,
      appId: j.appId,
      name: w.name,
      loop: w.loop,
      steps: w.plan.length,
      startStep: w.nextStep,
      plan: w.plan.map((step) => ({
        code: step.code,
        version: step.definition?.version ?? null,
        effect: step.definition?.effect ?? null,
      })),
    },
  };
}
const commandMessage = (c) => ({
  id: c.id,
  seq: c.seq,
  token: c.token,
  jobId: c.jobId,
  attemptId: c.attemptId,
  deviceId: c.deviceId,
  appId: c.appId,
  code: c.code,
  stepIndex: c.stepIndex,
  page: c.page,
  params: c.params,
  definition: c.definition,
  commandVersion: c.commandVersion,
  estimateMs: c.estimatedDurationMs,
  simulationDurationMs: c.simulationDurationMs,
});
const resend = (row, c) => ({
  action: "run",
  generation: row.executionGeneration,
  command: commandMessage(c),
});
/** The next step for a lease: run (one command), wait, yield, stop or done. */
function nextDirective(s, now, row, agent) {
  if (row.agentStop && row.status === "running")
    return { action: "stop", reason: row.agentStop.reason };
  if (row.status === "yielded") {
    const resumed = resumeOwnSession(s, now, row, `agent:${agent.id}`);
    if (!resumed) {
      // The scheduler decides (a small task may be inserted); the lease ends.
      row.agentState = "yielded";
      return { action: "yield" };
    }
    if (resumed.waitUntil)
      return {
        action: "wait",
        waitMs: Math.min(5000, Math.max(50, resumed.waitUntil - now)),
      };
    row.leaseUntil = now + AGENT_LEASE_MS;
    row.workerId = `agent:${agent.id}`;
  }
  if (row.status !== "running") return { action: "done", status: row.status };
  const c = beginCommand(s, now, row);
  if (!c) return { action: "done", status: row.status };
  row.leaseIssued = (row.leaseIssued || 0) + 1;
  row.seq = (row.seq || 0) + 1;
  Object.assign(c, { seq: row.seq, token: row.token, agentId: agent.id });
  return {
    action: "run",
    generation: row.executionGeneration,
    command: commandMessage(c),
  };
}
/** One lease message from the Agent, in a transaction scoped to its attempt. */
export function agentReport(s, now, token, m) {
  const agent = authenticate(s, token);
  const row = s.attempts.find((a) => a.id === m?.attemptId);
  if (!row || row.agentId !== agent.id || row.token !== m.token)
    return { ok: false, error: "stale-token", directive: { action: "drop" } };
  const live = () =>
    row.status === "running" &&
    row.leaseUntil + AGENT_GRACE_MS > now &&
    row.executionGeneration === (m.generation ?? row.executionGeneration);
  const inflight = () =>
    s.commands.find(
      (c) =>
        c.attemptId === row.id &&
        c.status === "running" &&
        c.token === row.token,
    );
  switch (m.type) {
    case "lease.accept": {
      if (!live())
        return { ok: false, directive: { action: "done", status: row.status } };
      if (row.agentState === "granted") {
        row.agentState = "accepted";
        row.acceptedAt = now;
        row.leaseUntil = now + AGENT_LEASE_MS;
      }
      // A repeated accept (lost response) gets the command in flight again.
      const c = inflight();
      return {
        ok: true,
        directive: c ? resend(row, c) : nextDirective(s, now, row, agent),
      };
    }
    case "lease.reject": {
      if (row.status !== "running" || row.leaseIssued)
        return {
          ok: false,
          error: "already-started",
          directive: { action: "drop" },
        };
      const reason = ["busy", "capability", "device-fault"].includes(m.reason)
        ? m.reason
        : "device-fault";
      returnLease(
        s,
        now,
        row,
        `Agent 拒绝租约（${{ busy: "设备忙", capability: "能力不符", "device-fault": "设备异常" }[reason]}）；暂停设备待核查`,
        { pause: true },
      );
      return { ok: true, directive: { action: "drop" } };
    }
    case "command.finished": {
      const c = s.commands.find((x) => x.id === m.commandId);
      if (!c || c.attemptId !== row.id || c.token !== row.token)
        return {
          ok: false,
          error: "unknown-command",
          directive: { action: "drop" },
        };
      if (c.status !== "running") {
        // A repeat: the answer to the first delivery was lost. If that answer
        // issued the next command, the Agent never saw it; send it again.
        if (c.status === "unknown")
          c.lateEvidence ??= { at: now, receipt: m.receipt };
        const next = inflight();
        return {
          ok: c.status === "succeeded",
          duplicate: true,
          directive:
            c.status !== "succeeded" ||
            !["running", "yielded"].includes(row.status)
              ? { action: "done", status: row.status }
              : next
                ? resend(row, next)
                : nextDirective(s, now, row, agent),
        };
      }
      // Device Gate echo: the receipt must name this command, seq and token.
      const echo =
        m.seq === c.seq &&
        m.receipt?.commandId === c.id &&
        m.receipt?.seq === c.seq &&
        m.receipt?.token === c.token;
      const ok = completeCommand(s, now, row, c, echo ? m.receipt : null);
      if (!ok)
        return { ok: false, directive: { action: "done", status: row.status } };
      if (row.status === "succeeded")
        return { ok: true, directive: { action: "done", status: "succeeded" } };
      return { ok: true, directive: nextDirective(s, now, row, agent) };
    }
    case "lease.next": {
      // The Agent asks only with no command in hand: an issued command means
      // the answer carrying it was lost.
      const next = inflight();
      if (next)
        return { ok: true, duplicate: true, directive: resend(row, next) };
      if (row.status !== "yielded" && !live())
        return { ok: false, directive: { action: "done", status: row.status } };
      return { ok: true, directive: nextDirective(s, now, row, agent) };
    }
    case "attempt.stopped": {
      if (row.status !== "running" || !row.agentStop)
        return { ok: false, directive: { action: "done", status: row.status } };
      if (inflight()) {
        finish(s, now, row, {
          error: "停止时仍有未回执的指令，结果未知；隔离设备",
        });
        cleanWorkflowFaults(s, now);
      } else
        cancelSession(
          s,
          now,
          row,
          `${row.agentStop.reason}：Agent 已在安全点停止${m.evidence?.reset ? "并复位" : ""}`,
        );
      return { ok: true, directive: { action: "done", status: row.status } };
    }
    default:
      throw new Fault("未知的 Agent 消息", 400);
  }
}
/** signal: platform risk signals go to the account of that device App. */
export function agentSignal(s, now, token, m) {
  const agent = authenticate(s, token);
  const d = s.devices.find(
    (d) => d.id === m?.deviceId && d.agentId === agent.id,
  );
  requireThat(d, "设备不属于此 Agent", 404);
  requireThat(AGENT_SIGNALS.includes(m.kind), "未知的平台信号", 400);
  const detail =
    typeof m.detail === "string" ? m.detail.trim().slice(0, 200) : "";
  if (m.kind === "app-crash") {
    event(
      s,
      d.mode,
      now,
      "agent-signal",
      `${d.name}：App 崩溃${detail ? `（${detail}）` : ""}`,
      {
        deviceId: d.id,
      },
    );
    return { ok: true };
  }
  const account = findAccount(s, d, m.appId);
  requireThat(account, "设备上没有该 App 的账号", 404);
  recordAccountSignal(s, now, d.mode, account.id, {
    kind: m.kind,
    detail: `Agent 上报${detail ? `：${detail}` : ""}`,
  });
  return { ok: true, accountId: account.id };
}
