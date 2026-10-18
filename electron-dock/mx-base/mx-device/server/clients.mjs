// Callers of the Job API v1 (V2-5, plan §6.2, §10): API keys, scopes, quotas
// and the pure transaction functions behind /v1/jobs. Simulation realm only.
//
// A key is "<client id>.<secret>"; only its SHA-256 hash is stored, so a
// request loads one client row by id and compares hashes in constant time.
// The callback secret signs deliveries and is stored (it must be, to sign);
// both are shown once, when created or rotated, and never appear in views.
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Fault, requireThat, str, stopJob } from "./model.mjs";
import { addWorkflow, definitions } from "./workflows.mjs";
import {
  CLASSES,
  CLASS_PRIORITY,
  activateClient,
  classShares,
  decayed,
  freshFair,
  orderJobs,
  systemVirtualTime,
} from "./fairness.mjs";
import { matchesJob } from "./scheduling.mjs";
import { APP_NAMES, supportedApps } from "./apps.mjs";
import { estimatedDuration } from "./task-contract.mjs";
import { jobResult, PARAMS_SCHEMA } from "./job-result.mjs";
import { FINAL } from "./client-settlement.mjs";

export const DEFAULT_QUOTAS = {
  maxQueued: 200,
  maxInflight: 20,
  ratePerMinute: 120,
  burst: 30,
};
const QUOTA_LIMITS = {
  maxQueued: [1, 2000],
  maxInflight: [1, 200],
  ratePerMinute: [1, 6000],
  burst: [1, 1000],
};
export const EMBED_SCOPES = ["none", "client", "ops"];
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_TTL_MS = 86400000;

const hash = (text) => createHash("sha256").update(text).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const event = (s, mode, now, type, message, more = {}) =>
  s.events.push({ id: randomUUID(), mode, at: now, type, message, ...more });

/** The client id is the key's prefix, so a request loads just that row. */
export const clientIdOf = (key) =>
  typeof key === "string" && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/.test(key)
    ? key.slice(0, 36)
    : null;
export const keyHashOf = (key) => hash(key);
/** Outside transactions: the row for a key, or a 401/403 Fault. */
export function authenticateClient(row, key) {
  const ok =
    row &&
    typeof row.keyHash === "string" &&
    timingSafeEqual(Buffer.from(row.keyHash), Buffer.from(hash(key)));
  requireThat(ok, "调用方凭证无效", 401);
  requireThat(row.status === "active", "调用方已停用", 403);
  return row;
}
function inTransaction(s, mode, clientId, keyHash) {
  const client = s.clients.find((c) => c.id === clientId && c.mode === mode);
  requireThat(client && client.keyHash === keyHash, "调用方凭证无效", 401);
  requireThat(client.status === "active", "调用方已停用", 403);
  return client;
}

// ---- Configuration (admin) ----

const list = (value, name, check, max = 50) => {
  if (value === undefined) return undefined;
  requireThat(
    Array.isArray(value) && value.length <= max,
    `${name}须为数组`,
    400,
  );
  const out = [...new Set(value.map((v) => str(v, name, 200)))];
  for (const v of out) requireThat(check(v), `${name}无效：${v}`, 400);
  return out;
};
/** Callback targets are exact origins, e.g. https://hub.internal:8443. */
export function callbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url.origin
    : null;
}
function configure(client, body, s) {
  if (body.name !== undefined) {
    client.name = str(body.name, "调用方名称", 60);
    requireThat(
      !s.clients.some(
        (c) =>
          c.id !== client.id &&
          c.mode === client.mode &&
          c.name === client.name,
      ),
      "调用方名称已存在",
      409,
    );
  }
  if (body.weight !== undefined) {
    const w = Number(body.weight);
    requireThat(
      Number.isFinite(w) && w >= 0.1 && w <= 100,
      "权重为 0.1–100",
      400,
    );
    client.weight = Math.round(w * 10) / 10;
  }
  const scopes = { ...client.scopes };
  const classes = list(body.classes, "等级", (v) => CLASSES.includes(v), 3);
  if (classes) {
    requireThat(classes.length > 0, "至少允许一个等级", 400);
    scopes.classes = CLASSES.filter((c) => classes.includes(c));
  }
  const apps = list(body.apps, "App", (v) => Object.hasOwn(APP_NAMES, v), 10);
  if (apps) scopes.apps = apps;
  const templates = list(body.templates, "模板", (v) =>
    /^[a-z0-9._-]{1,80}$/.test(v),
  );
  if (templates) scopes.templates = templates;
  const racks = list(body.racks, "机架", () => true);
  if (racks) scopes.racks = racks;
  client.scopes = scopes;
  if (body.quotas !== undefined) {
    requireThat(
      body.quotas && typeof body.quotas === "object",
      "配额须为对象",
      400,
    );
    const quotas = { ...client.quotas };
    for (const [k, [lo, hi]] of Object.entries(QUOTA_LIMITS)) {
      if (body.quotas[k] === undefined) continue;
      const v = Number(body.quotas[k]);
      requireThat(
        Number.isInteger(v) && v >= lo && v <= hi,
        `配额 ${k} 为 ${lo}–${hi} 的整数`,
        400,
      );
      quotas[k] = v;
    }
    client.quotas = quotas;
  }
  const hosts = list(
    body.callbackHosts,
    "回调来源",
    (v) => callbackOrigin(v) === v,
    10,
  );
  if (hosts) client.callbackHosts = hosts;
  if (body.embed !== undefined) {
    requireThat(EMBED_SCOPES.includes(body.embed), "嵌入范围无效", 400);
    client.embed = body.embed;
  }
}
export function createClient(s, now, mode, body) {
  requireThat(mode === "sim", "调用方当前仅用于模拟调度（V2-5）", 403);
  const id = randomUUID(),
    key = `${id}.${secret()}`,
    callbackSecret = secret();
  const client = {
    id,
    mode,
    status: "active",
    name: "",
    keyHash: hash(key),
    keyRotatedAt: now,
    callbackSecret,
    callbackHosts: [],
    weight: 1,
    scopes: {
      classes: ["standard", "batch"],
      apps: [],
      templates: [],
      racks: [],
    },
    quotas: { ...DEFAULT_QUOTAS },
    embed: "client",
    fair: freshFair(),
    bucket: null,
    usage: { submitted: 0, claimed: 0, servedMs: 0 },
    createdAt: now,
    revision: 1,
  };
  configure(client, { name: body.name ?? "", ...body }, s);
  s.clients.push(client);
  event(s, mode, now, "client", `新增调用方「${client.name}」`, {
    clientId: id,
  });
  return { client: clientView(s, now, client), key, callbackSecret };
}
export function changeClient(s, now, mode, id, body) {
  const client = s.clients.find((c) => c.id === id && c.mode === mode);
  requireThat(client, "调用方不存在", 404);
  requireThat(
    body.revision === client.revision,
    "调用方配置已变化，请刷新",
    409,
  );
  const out = {};
  if (body.status !== undefined) {
    requireThat(["active", "disabled"].includes(body.status), "状态无效", 400);
    client.status = body.status;
  }
  configure(client, body, s);
  if (body.rotateKey === true) {
    out.key = `${id}.${secret()}`;
    client.keyHash = hash(out.key);
    client.keyRotatedAt = now;
  }
  if (body.rotateCallbackSecret === true)
    client.callbackSecret = out.callbackSecret = secret();
  client.revision++;
  event(
    s,
    mode,
    now,
    "client",
    `调用方「${client.name}」已更新${out.key ? "（密钥已轮换）" : ""}${client.status === "disabled" ? "（已停用）" : ""}`,
    { clientId: id },
  );
  return { client: clientView(s, now, client), ...out };
}
/** Admin view: never the key hash or callback secret. */
export function clientView(s, now, c, counts = null) {
  const V = systemVirtualTime(s);
  const service = Object.fromEntries(
    CLASSES.map((k) => [
      k,
      Math.round(decayed(c.fair?.service?.[k], c.fair?.serviceAt, now)),
    ]),
  );
  let queued = 0,
    running = 0;
  for (const j of s.jobs)
    if (j.client?.id === c.id)
      if (j.status === "queued") queued++;
      else if (j.status === "running") running++;
  return {
    id: c.id,
    mode: c.mode,
    name: c.name,
    status: c.status,
    weight: c.weight,
    scopes: c.scopes,
    quotas: c.quotas,
    callbackHosts: c.callbackHosts,
    embed: c.embed,
    keyHint: `${c.id.slice(0, 8)}…`,
    keyRotatedAt: c.keyRotatedAt,
    createdAt: c.createdAt,
    revision: c.revision,
    usage: c.usage,
    outcomes: counts?.[c.id] || null,
    live: { queued, running },
    fair: {
      vruntimeMs: Math.round(c.fair?.vruntime || 0),
      lagMs: Math.round((c.fair?.vruntime || 0) - V),
      serviceMs: service,
    },
  };
}
export function clientsOverview(s, now, counts) {
  const shares = classShares(s, now);
  return {
    clients: s.clients
      .filter((c) => c.mode === "sim")
      .map((c) => clientView(s, now, c, counts))
      .sort((a, b) => a.name.localeCompare(b.name)),
    fairness: {
      virtualTimeMs: Math.round(systemVirtualTime(s)),
      serviceMs: Object.fromEntries(
        CLASSES.map((k) => [k, Math.round(shares.serviceMs[k])]),
      ),
      batchShare: shares.batchShare,
    },
  };
}

// ---- Job API v1 (transaction functions) ----

/** Validates a submission; the result is what idempotency compares. */
export function submission(body) {
  requireThat(body && typeof body === "object", "请求须为对象", 400);
  for (const k of ["freshnessMs", "shareable"])
    requireThat(
      body[k] === undefined,
      "结果共享（freshnessMs / shareable）尚未启用，待确认 Q4",
      400,
    );
  const clientRequestId = str(body.clientRequestId, "clientRequestId", 120);
  requireThat(
    REQUEST_ID.test(clientRequestId),
    "clientRequestId 格式无效",
    400,
  );
  const template = str(body.template, "模板", 80);
  const version = body.version === undefined ? null : Number(body.version);
  requireThat(
    version === null || (Number.isInteger(version) && version >= 1),
    "模板版本须为正整数",
    400,
  );
  const params = body.params ?? {};
  requireThat(
    params && typeof params === "object" && !Array.isArray(params),
    "params 须为对象",
    400,
  );
  for (const k of Object.keys(params))
    requireThat(
      Object.hasOwn(PARAMS_SCHEMA.properties, k),
      `未知参数：${k}`,
      400,
    );
  const cls = body.class ?? "standard";
  requireThat(
    CLASSES.includes(cls),
    "class 为 interactive / standard / batch",
    400,
  );
  requireThat(
    body.deadlineAt === undefined || body.ttlMs === undefined,
    "deadlineAt 与 ttlMs 只能给一个",
    400,
  );
  for (const k of ["deadlineAt", "ttlMs"])
    requireThat(
      body[k] === undefined || (Number.isInteger(body[k]) && body[k] > 0),
      `${k} 须为正整数（毫秒）`,
      400,
    );
  requireThat(
    body.ttlMs === undefined || body.ttlMs <= MAX_TTL_MS,
    "ttlMs 最长 24 小时",
    400,
  );
  let callbackUrl = null;
  if (body.callback !== undefined && body.callback !== null) {
    requireThat(
      typeof body.callback?.url === "string",
      "callback.url 须为字符串",
      400,
    );
    callbackUrl = str(body.callback.url, "回调地址", 500);
    requireThat(callbackOrigin(callbackUrl), "回调地址须为 http(s) URL", 400);
  }
  return {
    clientRequestId,
    template,
    version,
    params: {
      ...(params.keyword !== undefined && {
        keyword: str(params.keyword, "关键词", 200),
      }),
      ...(params.target !== undefined && {
        target: str(params.target, "目标标识", 200),
      }),
    },
    class: cls,
    deadlineAt: body.deadlineAt ?? null,
    ttlMs: body.ttlMs ?? null,
    rack: body.rack === undefined ? null : str(body.rack, "机架"),
    callbackUrl,
  };
}
export const requestKey = (clientId, clientRequestId) =>
  `client:${clientId}:${clientRequestId}`;

function retryAfter(message, seconds) {
  const e = new Fault(message, 429);
  e.headers = { "Retry-After": String(Math.max(1, Math.ceil(seconds))) };
  e.body = { retryAfterSeconds: Math.max(1, Math.ceil(seconds)) };
  return e;
}
function takeToken(client, now) {
  const { ratePerMinute, burst } = client.quotas;
  const rate = ratePerMinute / 60000;
  const b = client.bucket || { tokens: burst, at: now };
  const tokens = Math.min(burst, b.tokens + Math.max(0, now - b.at) * rate);
  if (tokens < 1)
    throw retryAfter("提交速率超出配额", (1 - tokens) / rate / 1000);
  client.bucket = { tokens: tokens - 1, at: now };
}
function template(s, mode, req) {
  const versions = definitions(s).filter(
    (d) => d.mode === mode && d.code === req.template,
  );
  requireThat(versions.length, `模板不存在：${req.template}`, 404);
  const def =
    req.version === null
      ? versions
          .filter((d) => !d.archived)
          .sort((a, b) => b.version - a.version)[0]
      : versions.find((d) => d.version === req.version);
  requireThat(def, "模板版本不存在或已归档", 404);
  return def;
}

/** Rough start/finish: the work ordered ahead on the devices that can run
 * this job, spread over them. Ignores pacing, so it errs early. */
export function predictJob(s, now, job) {
  const runs = (d, j) =>
    d.mode === j.mode &&
    matchesJob(d, j) &&
    supportedApps(d).includes(j.appId || "xhs");
  const devices = s.devices.filter(
    (d) =>
      d.enabled &&
      d.state !== "quarantined" &&
      d.connected !== "offline" &&
      runs(d, job),
  );
  if (!devices.length)
    return {
      startAt: null,
      finishAt: null,
      confidence: "none",
      source: "estimate",
      reason: "当前没有可执行此模板的启用设备",
    };
  const queue = orderJobs(
    s,
    now,
    s.jobs.filter((j) => j.mode === job.mode && j.status === "queued"),
  );
  let aheadMs = 0,
    ahead = 0;
  for (const j of queue) {
    if (j.id === job.id) break;
    if (devices.some((d) => runs(d, j))) {
      aheadMs += estimatedDuration(j);
      ahead++;
    }
  }
  const ids = new Set(devices.map((d) => d.id));
  let busyMs = 0;
  for (const a of s.attempts)
    if (ids.has(a.deviceId) && ["running", "yielded"].includes(a.status))
      busyMs += Math.max(
        0,
        (a.dispatchedAt ?? a.createdAt) + (a.estimatedDurationMs ?? 0) - now,
      );
  const startAt = now + Math.round((aheadMs + busyMs) / devices.length);
  const idle = devices.some(
    (d) => d.state === "idle" && !(d.cooldownUntil > now),
  );
  return {
    startAt,
    finishAt: startAt + estimatedDuration(job),
    confidence:
      !ahead && idle ? "high" : ahead < devices.length * 3 ? "medium" : "low",
    source: "estimate",
    candidates: devices.length,
    ahead,
  };
}

export function submitJob(s, now, mode, clientId, keyHash, body) {
  requireThat(mode === "sim", "Job API v1 当前仅开放模拟模式", 403);
  const client = inTransaction(s, mode, clientId, keyHash);
  const req = submission(body);
  const key = requestKey(client.id, req.clientRequestId);
  const fingerprint = hash(JSON.stringify(req));
  const prior = s.jobs.find((j) => j.mode === mode && j.key === key);
  if (prior) {
    requireThat(
      prior.client?.fingerprint === fingerprint,
      "同一 clientRequestId 已用于不同请求",
      409,
    );
    return { job: prior, replayed: true };
  }
  const def = template(s, mode, req);
  const { scopes } = client;
  requireThat(
    scopes.classes.includes(req.class),
    `调用方未获准使用等级 ${req.class}`,
    403,
  );
  requireThat(
    !scopes.apps.length || scopes.apps.includes(def.appId),
    "调用方未获准使用此 App",
    403,
  );
  requireThat(
    !scopes.templates.length || scopes.templates.includes(def.code),
    "调用方未获准使用此模板",
    403,
  );
  requireThat(
    !req.rack || !scopes.racks.length || scopes.racks.includes(req.rack),
    "调用方未获准使用此机架",
    403,
  );
  if (req.callbackUrl)
    requireThat(
      client.callbackHosts.includes(callbackOrigin(req.callbackUrl)),
      "回调地址不在调用方允许的来源内",
      403,
    );
  takeToken(client, now);
  const queued = s.jobs.filter(
    (j) => j.client?.id === client.id && j.status === "queued",
  ).length;
  if (queued >= client.quotas.maxQueued)
    throw retryAfter(
      `排队任务已达调用方上限（${client.quotas.maxQueued}）`,
      30,
    );
  activateClient(s, now, client);
  const job = addWorkflow(s, now, mode, {
    key,
    definitionId: def.id,
    keyword: req.params.keyword,
    target: req.params.target,
    priority: CLASS_PRIORITY[req.class],
    rack: req.rack ?? undefined,
  });
  job.client = {
    id: client.id,
    name: client.name,
    requestId: req.clientRequestId,
    class: req.class,
    template: `${def.code}@${def.version}`,
    deadlineAt: req.deadlineAt ?? (req.ttlMs ? now + req.ttlMs : null),
    callbackUrl: req.callbackUrl,
    fingerprint,
    submittedAt: now,
  };
  const predicted = predictJob(s, now, job);
  if (job.client.deadlineAt != null) {
    requireThat(job.client.deadlineAt > now, "截止时间已过", 422);
    if (
      predicted.finishAt == null ||
      predicted.finishAt > job.client.deadlineAt
    ) {
      // Throwing rolls the whole submission back: nothing is queued.
      const e = new Fault(
        predicted.finishAt == null
          ? "截止时间前无法完成：没有可执行此模板的设备"
          : "预计完成时间晚于截止时间",
        422,
      );
      e.body = { predictedFinishAt: predicted.finishAt, predicted };
      throw e;
    }
  }
  job.reason = `调用方「${client.name}」· ${req.class}；${job.reason}`;
  client.usage.submitted++;
  return { job, predicted, replayed: false };
}
export function cancelClientJob(s, now, mode, clientId, keyHash, jobId) {
  const client = inTransaction(s, mode, clientId, keyHash);
  const j = s.jobs.find((j) => j.id === jobId && j.mode === mode);
  requireThat(j && j.client?.id === client.id, "任务不存在", 404);
  return stopJob(s, now, mode, jobId, `调用方「${client.name}」取消`);
}

// ---- Views ----

const v1Status = (job, entry) =>
  job.status === "queued"
    ? entry?.poolAssignment
      ? "planned"
      : "queued"
    : job.status === "running" && job.stopRequestedAt
      ? "stopping"
      : job.status;
/** A job as its caller sees it. entry: its scheduling queue entry, if any. */
export function jobView(
  job,
  { entry = null, predicted = null, detail = null, at } = {},
) {
  const plan = job.workflow?.plan || [];
  const assignment = entry?.poolAssignment;
  return {
    jobId: job.id,
    clientRequestId: job.client?.requestId ?? null,
    template: job.client?.template ?? null,
    class: job.client?.class ?? null,
    status: v1Status(job, entry),
    final: FINAL.has(job.status),
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    deadlineAt: job.client?.deadlineAt ?? null,
    predicted:
      job.status !== "queued"
        ? null
        : assignment
          ? {
              startAt: assignment.startAt,
              finishAt: assignment.finishAt,
              confidence: assignment.startAt <= (at ?? 0) ? "high" : "medium",
              source: "plan",
            }
          : predicted,
    blockers:
      job.status === "queued"
        ? (entry?.reasons || []).filter((r) => r.code !== "candidate")
        : [],
    queuePosition: entry?.order ?? null,
    progress: {
      completedSteps: job.workflow?.nextStep ?? 0,
      steps: plan.length,
    },
    reason: job.reason || null,
    result: detail
      ? jobResult(job, detail)
      : FINAL.has(job.status)
        ? jobResult(job)
        : null,
  };
}
