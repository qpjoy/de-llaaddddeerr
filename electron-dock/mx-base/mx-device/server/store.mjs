import {
  BUILTIN_DEFINITIONS,
  BUILTIN_COMMAND_DEFINITIONS,
} from "./workflow-catalog.mjs";
import {
  BUILTIN_RULE_DEFINITIONS,
  BUILTIN_STRATEGY_DEFINITIONS,
} from "./strategy-catalog.mjs";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { foldUsage } from "./fairness.mjs";
import { priorStatuses, settleClients } from "./client-settlement.mjs";
import { createHash } from "node:crypto";

const clone = (value) => structuredClone(value);

// Queries over tables that grow with history. Exported so scripts/pg-baseline.mjs
// explains and times exactly the statements the store runs. Each branch of a
// UNION is index-backed (009_history_indexes.sql); a single WHERE with OR across
// these conditions made PostgreSQL scan all history on every transaction.
const SOURCE_ID = `(document->>'sourceJobId') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'`;
export const SQL = {
  // Live jobs, explicit job/key/attempt, the latest 100, and sources of live jobs.
  // Results are loaded only for sources that live dependents still need.
  atomicJobs: `WITH sources AS (
      SELECT (document->>'sourceJobId')::uuid AS id FROM mx_device.jobs
      WHERE mode=$1 AND status IN ('queued','running') AND ${SOURCE_ID}
    ), ids AS (
      SELECT id FROM mx_device.jobs WHERE mode=$1 AND status IN ('queued','running')
      UNION SELECT id FROM mx_device.jobs WHERE id=$2
      UNION SELECT id FROM mx_device.jobs WHERE mode=$1 AND request_key=$3
      UNION (SELECT id FROM mx_device.jobs WHERE mode=$1 ORDER BY created_at DESC,id DESC LIMIT 100)
      UNION SELECT id FROM sources
      UNION SELECT job_id FROM mx_device.attempts WHERE id=$4
    )
    SELECT CASE WHEN j.id IN (SELECT id FROM sources) THEN j.document ELSE j.document - 'result' END AS document, j.version
    FROM mx_device.jobs j WHERE j.mode=$1 AND j.id = ANY(ARRAY(SELECT id FROM ids))
    ORDER BY j.created_at, j.id`,
  atomicAttempts:
    "SELECT document,version FROM mx_device.attempts WHERE mode=$1 AND (status IN ('running','yielded') OR id=$2)",
  atomicCommands: `SELECT document,version FROM mx_device.execution_commands WHERE mode=$1 AND id = ANY(ARRAY(
      SELECT id FROM mx_device.execution_commands WHERE status='running'
      UNION SELECT id FROM mx_device.execution_commands WHERE job_id=$2
      UNION SELECT id FROM mx_device.execution_commands WHERE attempt_id=$3
      UNION SELECT c.id FROM mx_device.execution_commands c JOIN mx_device.jobs j ON j.id=c.job_id
        WHERE j.mode=$1 AND j.status='running'
    )) ORDER BY created_at, id`,
  snapshotJobs: `SELECT document - 'result' AS document FROM mx_device.jobs WHERE mode=$1 AND id = ANY(ARRAY(
      SELECT id FROM mx_device.jobs WHERE mode=$1 AND status IN ('queued','running')
      UNION (SELECT id FROM mx_device.jobs WHERE mode=$1 AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 100)
      UNION SELECT (document->>'sourceJobId')::uuid FROM mx_device.jobs WHERE mode=$1 AND status='queued' AND ${SOURCE_ID}
    )) ORDER BY created_at, id`,
  // Finished attempts: the latest 100, plus all started in the last 3 minutes
  // (capped) for the lane timeline. Picked from the index first; trimming large
  // documents before the LIMIT used to detoast every attempt ever recorded.
  snapshotAttempts: `(SELECT document - 'result' - 'lateEvidence' - 'checkpoints' AS document
      FROM mx_device.attempts WHERE mode=$1 AND status IN ('running','yielded'))
    UNION ALL
    (SELECT a.document - 'result' - 'lateEvidence' - 'checkpoints' FROM (
      (SELECT id, created_at FROM mx_device.attempts
        WHERE mode=$1 AND status NOT IN ('running','yielded') ORDER BY created_at DESC LIMIT 100)
      UNION
      (SELECT id, created_at FROM mx_device.attempts
        WHERE mode=$1 AND status NOT IN ('running','yielded')
          AND created_at >= (extract(epoch FROM clock_timestamp())*1000)::bigint - 180000
        ORDER BY created_at DESC LIMIT 4000)
    ) r JOIN mx_device.attempts a ON a.id=r.id ORDER BY r.created_at DESC)`,
  snapshotCommands: `(SELECT document - 'receipt' - 'lateEvidence' AS document FROM mx_device.execution_commands
      WHERE mode=$1 AND id = ANY(ARRAY(
        SELECT id FROM mx_device.execution_commands WHERE status='running'
        UNION SELECT c.id FROM mx_device.execution_commands c JOIN mx_device.jobs j ON j.id=c.job_id
          WHERE j.mode=$1 AND j.status='running'
      )) ORDER BY created_at, id)
    UNION ALL
    (SELECT c.document - 'receipt' - 'lateEvidence' FROM (
      SELECT id, created_at FROM mx_device.execution_commands
      WHERE mode=$1 AND status<>'running' AND job_id NOT IN (SELECT id FROM mx_device.jobs WHERE mode=$1 AND status='running')
      ORDER BY created_at DESC LIMIT 400
    ) r JOIN mx_device.execution_commands c ON c.id=r.id ORDER BY r.created_at DESC)`,
};

// Plan steps and execution commands freeze a command definition version. Those
// rows are immutable, so PgStore stores an identical snapshot as definitionRef
// and restores the shared, frozen catalog object on read: the model and API see
// the full definition while each transaction moves ~10x less job JSON. A
// snapshot that differs from its catalog row (or has no row) stays embedded.
const SNAPSHOTS = new Map(); // catalog row JSON -> frozen object, shared across transactions
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
export function snapshotCatalog(rows) {
  const byId = new Map();
  for (const row of rows) {
    const json = JSON.stringify(row);
    let object = SNAPSHOTS.get(json);
    if (!object) {
      if (SNAPSHOTS.size >= 4096) SNAPSHOTS.clear();
      object = deepFreeze(JSON.parse(json));
      SNAPSHOTS.set(json, object);
    }
    byId.set(row.id, { json, object });
  }
  return byId;
}
function storedDefinition(holder, catalog) {
  const definition = holder.definition;
  if (!definition || typeof definition !== "object") return holder;
  const entry = catalog.get(definition.id);
  if (
    entry &&
    (entry.object === definition || entry.json === JSON.stringify(definition))
  ) {
    const { definition: _, ...rest } = holder;
    return { ...rest, definitionRef: definition.id };
  }
  if (!Object.hasOwn(holder, "definitionRef")) return holder;
  const { definitionRef: _, ...rest } = holder;
  return rest;
}
function restoreDefinition(holder, catalog) {
  if (!holder.definitionRef || holder.definition) return;
  const entry = catalog.get(holder.definitionRef);
  if (!entry)
    throw Error(`执行快照引用的指令版本缺失：${holder.definitionRef}`);
  holder.definition = entry.object;
}
export const storedJob = (job, catalog) =>
  job.workflow?.plan
    ? {
        ...job,
        workflow: {
          ...job.workflow,
          plan: job.workflow.plan.map((step) =>
            storedDefinition(step, catalog),
          ),
        },
      }
    : job;
export const storedCommand = (command, catalog) =>
  storedDefinition(command, catalog);
export function restoreJob(job, catalog) {
  for (const step of job.workflow?.plan || []) restoreDefinition(step, catalog);
  return job;
}
export function restoreCommand(command, catalog) {
  restoreDefinition(command, catalog);
  return command;
}

export class MemoryStore {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.state = {
      devices: [],
      jobs: [],
      attempts: [],
      events: [],
      resources: [],
      apps: [],
      accounts: [],
      agents: [],
      clients: [],
      // Not part of transaction state in PgStore: append-only side tables.
      outbox: [],
      clientUsage: [],
      definitions: structuredClone(BUILTIN_DEFINITIONS),
      commandDefinitions: structuredClone(BUILTIN_COMMAND_DEFINITIONS),
      ruleDefinitions: structuredClone(BUILTIN_RULE_DEFINITIONS),
      strategyDefinitions: structuredClone(BUILTIN_STRATEGY_DEFINITIONS),
      commands: [],
      loopPolicies: [],
    };
    this.tail = Promise.resolve();
    this.workers = [];
    this.frames = new Map();
  }
  async atomic(fn, { frame } = {}) {
    const prev = this.tail;
    let release;
    this.tail = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      const state = clone(this.state),
        now = this.clock();
      state.clients ||= [];
      state.outbox ||= [];
      state.clientUsage ||= [];
      // Every MemoryStore transaction sees the realm: fold usage at once.
      if (state.clientUsage.length) {
        foldUsage(state, now, state.clientUsage);
        state.clientUsage = [];
      }
      const prior = priorStatuses(state);
      const result = fn(state, now);
      if (result?.then)
        throw Error("Async work inside transaction is forbidden");
      const { outbox, usage } = settleClients(state, now, prior);
      state.clientUsage.push(...usage);
      for (const row of outbox)
        if (
          !state.outbox.some(
            (o) => o.jobId === row.jobId && o.event === row.event,
          )
        )
          state.outbox.push(row);
      this.state = state;
      if (frame && result === true)
        this.frames.set(frame.deviceId, clone(frame));
      return clone(result);
    } finally {
      release();
    }
  }
  async snapshot(mode) {
    const { outbox, clientUsage, ...state } = clone(this.state);
    return {
      ...Object.fromEntries(
        Object.entries(state).map(([k, rows]) => [
          k,
          rows.filter((r) => r.mode === mode),
        ]),
      ),
      workers: clone(this.workers),
      now: this.clock(),
    };
  }
  async detail(mode, id) {
    const job = this.state.jobs.find((j) => j.id === id && j.mode === mode);
    return (
      job &&
      clone({
        job,
        attempts: this.state.attempts.filter((a) => a.jobId === id),
        commands: (this.state.commands || []).filter((c) => c.jobId === id),
      })
    );
  }
  // ---- Job API v1 reads and the callback outbox (outside transactions) ----
  async client(id) {
    return clone(this.state.clients.find((c) => c.id === id) || null);
  }
  async jobStatuses(mode, ids) {
    const wanted = new Set(ids);
    return new Map(
      this.state.jobs
        .filter((j) => j.mode === mode && wanted.has(j.id))
        .map((j) => [j.id, j.status]),
    );
  }
  async clientJobs(mode, clientId, { limit = 50, active = false } = {}) {
    return clone(
      this.state.jobs
        .filter(
          (j) =>
            j.mode === mode &&
            j.client?.id === clientId &&
            (!active || ["queued", "running"].includes(j.status)),
        )
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(({ result, ...j }) => j),
    );
  }
  async clientJobCounts(mode) {
    const counts = {};
    for (const j of this.state.jobs)
      if (j.mode === mode && j.client) {
        counts[j.client.id] ||= {};
        counts[j.client.id][j.status] =
          (counts[j.client.id][j.status] || 0) + 1;
      }
    return counts;
  }
  async claimDeliveries({ limit = 20, lockMs = 30000 } = {}) {
    const now = this.clock();
    const due = this.state.outbox
      .filter(
        (o) =>
          o.status === "pending" && o.nextAt <= now && o.lockedUntil <= now,
      )
      .sort((a, b) => a.nextAt - b.nextAt)
      .slice(0, limit);
    for (const o of due) o.lockedUntil = now + lockMs;
    return due.map((o) => ({
      delivery: clone(o),
      client: clone(this.state.clients.find((c) => c.id === o.clientId)),
    }));
  }
  async settleDelivery(id, { status, attempts, nextAt, last }) {
    const o = this.state.outbox.find((x) => x.id === id);
    if (!o) return;
    Object.assign(o, { status, attempts, nextAt, lockedUntil: 0, last });
  }
  async deliveries(mode, { clientId = null, limit = 50 } = {}) {
    return clone(
      this.state.outbox
        .filter(
          (o) => o.mode === mode && (!clientId || o.clientId === clientId),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit),
    );
  }
  async pruneOutbox({ retentionMs }) {
    const before = this.state.outbox.length,
      floor = this.clock() - retentionMs;
    this.state.outbox = this.state.outbox.filter(
      (o) => o.status === "pending" || o.createdAt >= floor,
    );
    return before - this.state.outbox.length;
  }
  async retryDelivery(mode, id) {
    const o = this.state.outbox.find((x) => x.id === id && x.mode === mode);
    if (!o || o.status === "delivered") return null;
    Object.assign(o, {
      status: "pending",
      nextAt: this.clock(),
      lockedUntil: 0,
    });
    return clone(o);
  }
  async heartbeat(id, doc) {
    this.workers = this.workers.filter((w) => w.id !== id);
    this.workers.push({ id, at: this.clock(), ...doc });
  }
  async pruneEvents({ retentionMs, keepLatest }) {
    return this.atomic((s, now) => {
      const deleted = {};
      for (const mode of ["sim", "real"]) {
        const keep = new Set(
          s.events.filter((e) => e.mode === mode).slice(-keepLatest),
        );
        const before = s.events.length;
        s.events = s.events.filter(
          (e) =>
            e.mode !== mode || keep.has(e) || e.at >= now - retentionMs[mode],
        );
        deleted[mode] = before - s.events.length;
      }
      return deleted;
    });
  }
  async ready() {
    return true;
  }
  async close() {}
  async frame(deviceId, captureId) {
    const d = this.state.devices.find(
      (d) => d.id === deviceId && d.mode === "real",
    );
    const frame = this.frames.get(deviceId);
    return frame &&
      d?.observer?.version === frame.version &&
      d.frame?.id === frame.captureId &&
      frame.captureId === captureId
      ? Buffer.from(frame.png)
      : null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Columns are authoritative for delivery state; the document holds the rest.
const outboxRow = (r) => ({
  ...r.document,
  status: r.status,
  attempts: r.attempts,
  nextAt: Number(r.next_at),
  lockedUntil: Number(r.locked_until),
  createdAt: Number(r.created_at),
});
class Conflict extends Error {
  constructor(table) {
    super(`并发写入冲突：${table}`);
    this.code = "MXCONFLICT";
  }
}
export class LeadershipLost extends Error {
  constructor() {
    super("调度器已失去领导权，本次调度未提交");
    this.code = "MXLEADER";
    this.status = 409;
  }
}
// What makes work claimable: a scheduler is notified only when this changes,
// not on every command receipt.
const schedulable = (table, row) =>
  table === "devices"
    ? `${row.state}|${row.enabled}|${row.connected}|${row.session?.status}`
    : table === "jobs" || table === "attempts"
      ? row.status
      : table === "agents"
        ? `${row.status}|${row.instanceId}`
        : null;
// Version conflicts, deadlocks, lock timeouts and concurrent inserts re-run fn.
const RETRYABLE = new Set(["MXCONFLICT", "40001", "40P01", "55P03", "23505"]);

// Mutable rows, in foreign-key write order.
const ROW_TABLES = [
  ["clients", "clients"],
  ["agents", "agents"],
  ["loopPolicies", "loop_policies"],
  ["resources", "resource_policies"],
  ["devices", "devices"],
  ["apps", "device_apps"],
  ["accounts", "accounts"],
  ["jobs", "jobs"],
  ["attempts", "attempts"],
  ["commands", "execution_commands"],
];
// Append-only version catalogs. Task and command catalogs share logical ids.
const CATALOG_TABLES = [
  ["definitions", "task_definitions"],
  ["commandDefinitions", "command_definitions"],
  ["ruleDefinitions", "rule_definitions"],
  ["strategyDefinitions", "strategy_definitions"],
];
const stored = (table, row, catalog) =>
  table === "jobs"
    ? storedJob(row, catalog)
    : table === "execution_commands"
      ? storedCommand(row, catalog)
      : row;
const WRITERS = {
  clients: {
    insert:
      "INSERT INTO mx_device.clients(id,mode,status,document,version) VALUES($1,$2,$3,$4,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (c, json) => [c.id, c.mode, c.status, json],
    update:
      "UPDATE mx_device.clients SET status=$2,document=$3,version=version+1 WHERE id=$1 AND version=$4",
    updateArgs: (c, json, v) => [c.id, c.status, json, v],
  },
  agents: {
    insert:
      "INSERT INTO mx_device.agents(id,mode,status,document,version) VALUES($1,$2,$3,$4,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (a, json) => [a.id, a.mode, a.status, json],
    update:
      "UPDATE mx_device.agents SET status=$2,document=$3,version=version+1 WHERE id=$1 AND version=$4",
    updateArgs: (a, json, v) => [a.id, a.status, json, v],
  },
  loop_policies: {
    insert:
      "INSERT INTO mx_device.loop_policies(id,mode,rack,document,version) VALUES($1,$2,$3,$4,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (p, json) => [p.id, p.mode, p.rack, json],
    update:
      "UPDATE mx_device.loop_policies SET document=$2,version=version+1 WHERE id=$1 AND version=$3",
    updateArgs: (p, json, v) => [p.id, json, v],
  },
  resource_policies: {
    insert:
      "INSERT INTO mx_device.resource_policies(id,mode,resource_key,document,version) VALUES($1,$2,$3,$4,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (r, json) => [r.id, r.mode, r.resourceKey, json],
    update:
      "UPDATE mx_device.resource_policies SET document=$2,version=version+1 WHERE id=$1 AND version=$3",
    updateArgs: (r, json, v) => [r.id, json, v],
  },
  devices: {
    insert:
      "INSERT INTO mx_device.devices(id,mode,resource_key,account_key,document,version) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (d, json) => [d.id, d.mode, d.resourceKey, d.accountKey, json],
    update:
      "UPDATE mx_device.devices SET document=$2,resource_key=$3,account_key=$4,version=version+1 WHERE id=$1 AND version=$5",
    updateArgs: (d, json, v) => [d.id, json, d.resourceKey, d.accountKey, v],
  },
  device_apps: {
    insert:
      "INSERT INTO mx_device.device_apps(id,mode,device_id,app_id,account_key,document,version) VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (a, json) => [
      a.id,
      a.mode,
      a.deviceId,
      a.appId,
      a.accountKey,
      json,
    ],
    update:
      "UPDATE mx_device.device_apps SET document=$2,version=version+1 WHERE id=$1 AND version=$3",
    updateArgs: (a, json, v) => [a.id, json, v],
  },
  accounts: {
    insert:
      "INSERT INTO mx_device.accounts(id,mode,app_id,account_key,status,document,version) VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (a, json) => [
      a.id,
      a.mode,
      a.appId,
      a.accountKey,
      a.status,
      json,
    ],
    update:
      "UPDATE mx_device.accounts SET status=$2,document=$3,version=version+1 WHERE id=$1 AND version=$4",
    updateArgs: (a, json, v) => [a.id, a.status, json, v],
  },
  jobs: {
    insert:
      "INSERT INTO mx_device.jobs(id,mode,request_key,status,created_at,document,version) VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (j, json) => [j.id, j.mode, j.key, j.status, j.createdAt, json],
    update:
      "UPDATE mx_device.jobs SET status=$2,document=$3,version=version+1 WHERE id=$1 AND version=$4",
    updateArgs: (j, json, v) => [j.id, j.status, json, v],
  },
  attempts: {
    insert:
      "INSERT INTO mx_device.attempts(id,mode,job_id,device_id,status,created_at,document,version) VALUES($1,$2,$3,$4,$5,$6,$7,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (a, json) => [
      a.id,
      a.mode,
      a.jobId,
      a.deviceId,
      a.status,
      a.createdAt,
      json,
    ],
    update:
      "UPDATE mx_device.attempts SET status=$2,document=$3,version=version+1 WHERE id=$1 AND version=$4",
    updateArgs: (a, json, v) => [a.id, a.status, json, v],
  },
  execution_commands: {
    insert:
      "INSERT INTO mx_device.execution_commands(id,mode,job_id,attempt_id,device_id,status,created_at,document,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1) ON CONFLICT(id) DO NOTHING",
    insertArgs: (c, json) => [
      c.id,
      c.mode,
      c.jobId,
      c.attemptId,
      c.deviceId,
      c.status,
      c.createdAt,
      json,
    ],
    update:
      "UPDATE mx_device.execution_commands SET status=$2,document=$3,version=version+1 WHERE id=$1 AND version=$4",
    updateArgs: (c, json, v) => [c.id, c.status, json, v],
  },
};

// A scoped transaction must not silently see an empty or partial realm where it
// expects the whole one; touching a collection it did not load is an error.
const UNLOADED = Symbol("unloaded");
const unloaded = (name) =>
  new Proxy([], {
    get(target, prop) {
      if (prop === UNLOADED) return true;
      throw new Error(`作用域事务访问了未加载的集合：${name}`);
    },
  });
const isUnloaded = (rows) => rows?.[UNLOADED] === true;

async function select(c, table, sql, params, versions) {
  const { rows } = await c.query(sql, params);
  return rows.map((r) => {
    if (r.version !== undefined)
      versions.set(`${table}:${r.document.id}`, String(r.version));
    return r.document;
  });
}
const byMode = (table) =>
  `SELECT document${table.versioned ? ",version" : ""} FROM mx_device.${table.name} WHERE mode=$1`;

async function loadRealm(c, mode, { jobId, key, attemptId }) {
  const versions = new Map();
  const all = (name, versioned = true) =>
    select(c, name, byMode({ name, versioned }), [mode], versions);
  const rows = {
    clients: await all("clients"),
    agents: await all("agents"),
    devices: await all("devices"),
    jobs: await select(
      c,
      "jobs",
      SQL.atomicJobs,
      [mode, jobId, key, attemptId],
      versions,
    ),
    attempts: await select(
      c,
      "attempts",
      SQL.atomicAttempts,
      [mode, attemptId],
      versions,
    ),
    resources: await all("resource_policies"),
    apps: await all("device_apps"),
    accounts: await all("accounts"),
    definitions: await all("task_definitions", false),
    commandDefinitions: await all("command_definitions", false),
    loopPolicies: await all("loop_policies"),
    ruleDefinitions: await all("rule_definitions", false),
    strategyDefinitions: await all("strategy_definitions", false),
    commands: await select(
      c,
      "execution_commands",
      SQL.atomicCommands,
      [mode, jobId, attemptId],
      versions,
    ),
  };
  // Measured-service corrections appended since the last realm transaction;
  // folded into client rows by this one (rolled back with it on failure).
  const usage = (
    await c.query(
      "DELETE FROM mx_device.client_usage WHERE mode=$1 RETURNING document",
      [mode],
    )
  ).rows.map((r) => r.document);
  return { rows, versions, usage };
}

// One device and the live work on it, locked FOR UPDATE in a fixed order:
// device, attempts, jobs, commands, apps.
async function loadScoped(
  c,
  mode,
  scope,
  { deviceId, attemptId, jobId, agentId },
) {
  if (!["attempt", "device", "agent"].includes(scope))
    throw new Error(`未知事务作用域：${scope}`);
  const versions = new Map();
  // The Agent row a message is authenticated against (read, never locked here).
  const agents = agentId
    ? await select(
        c,
        "agents",
        `SELECT document,version FROM mx_device.agents WHERE id=$1 AND mode=$2${scope === "agent" ? " FOR UPDATE" : ""}`,
        [agentId, mode],
        versions,
      )
    : unloaded("agents");
  if (scope === "agent") return loadAgent(c, mode, agentId, agents, versions);
  if (!deviceId && attemptId)
    deviceId = (
      await c.query("SELECT device_id FROM mx_device.attempts WHERE id=$1", [
        attemptId,
      ])
    ).rows[0]?.device_id;
  const devices = deviceId
    ? await select(
        c,
        "devices",
        "SELECT document,version FROM mx_device.devices WHERE id=$1 AND mode=$2 FOR UPDATE",
        [deviceId, mode],
        versions,
      )
    : [];
  const rows = {
    clients: unloaded("clients"),
    agents,
    devices,
    jobs: unloaded("jobs"),
    attempts: unloaded("attempts"),
    resources: unloaded("resources"),
    apps: unloaded("apps"),
    accounts: unloaded("accounts"),
    definitions: unloaded("definitions"),
    commandDefinitions: [],
    loopPolicies: unloaded("loopPolicies"),
    ruleDefinitions: unloaded("ruleDefinitions"),
    strategyDefinitions: unloaded("strategyDefinitions"),
    commands: unloaded("commands"),
  };
  if (scope === "device") return { rows, versions };
  const attemptIds = [attemptId, devices[0]?.workflowAttemptId].filter(Boolean);
  rows.attempts = await select(
    c,
    "attempts",
    "SELECT document,version FROM mx_device.attempts WHERE mode=$1 AND (id=ANY($2::uuid[]) OR (device_id=$3 AND status IN ('running','yielded'))) ORDER BY id FOR UPDATE",
    [mode, attemptIds, deviceId ?? null],
    versions,
  );
  const jobIds = [
    ...new Set([jobId, ...rows.attempts.map((a) => a.jobId)].filter(Boolean)),
  ];
  rows.jobs = await select(
    c,
    "jobs",
    "SELECT document,version FROM mx_device.jobs WHERE mode=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
    [mode, jobIds],
    versions,
  );
  rows.commands = await select(
    c,
    "execution_commands",
    "SELECT document,version FROM mx_device.execution_commands WHERE mode=$1 AND (attempt_id=ANY($2::uuid[]) OR job_id=ANY($3::uuid[]) OR (device_id=$4 AND status='running')) ORDER BY created_at,id FOR UPDATE",
    [mode, rows.attempts.map((a) => a.id), jobIds, deviceId ?? null],
    versions,
  );
  rows.apps = await select(
    c,
    "device_apps",
    "SELECT document,version FROM mx_device.device_apps WHERE mode=$1 AND device_id=$2 ORDER BY id FOR UPDATE",
    [mode, deviceId ?? null],
    versions,
  );
  // The accounts of this device's Apps (charged at dispatch, settled at end).
  rows.accounts = await select(
    c,
    "accounts",
    "SELECT document,version FROM mx_device.accounts WHERE mode=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",
    [mode, rows.apps.map((a) => `${mode}/${a.appId}/${a.accountKey}`)],
    versions,
  );
  rows.loopPolicies = await select(
    c,
    "loop_policies",
    byMode({ name: "loop_policies", versioned: true }),
    [mode],
    versions,
  );
  rows.resources = await select(
    c,
    "resource_policies",
    byMode({ name: "resource_policies", versioned: true }),
    [mode],
    versions,
  );
  rows.commandDefinitions = await select(
    c,
    "command_definitions",
    byMode({ name: "command_definitions", versioned: false }),
    [mode],
    versions,
  );
  return { rows, versions };
}

// One Agent and the live work on its devices: heartbeats renew these leases
// and polls read the grants. Only the Agent row and the attempts are locked.
async function loadAgent(c, mode, agentId, agents, versions) {
  const devices = await select(
    c,
    "devices",
    "SELECT document,version FROM mx_device.devices WHERE mode=$1 AND document->>'agentId'=$2 ORDER BY id",
    [mode, agentId],
    versions,
  );
  const attempts = await select(
    c,
    "attempts",
    "SELECT document,version FROM mx_device.attempts WHERE mode=$1 AND device_id=ANY($2::uuid[]) AND status IN ('running','yielded') ORDER BY id FOR UPDATE",
    [mode, devices.map((d) => d.id)],
    versions,
  );
  const jobs = await select(
    c,
    "jobs",
    "SELECT document,version FROM mx_device.jobs WHERE mode=$1 AND id=ANY($2::uuid[]) ORDER BY id",
    [mode, [...new Set(attempts.map((a) => a.jobId))]],
    versions,
  );
  const commandDefinitions = await select(
    c,
    "command_definitions",
    byMode({ name: "command_definitions", versioned: false }),
    [mode],
    versions,
  );
  return {
    rows: {
      clients: unloaded("clients"),
      agents,
      devices,
      jobs,
      attempts,
      commandDefinitions,
      resources: unloaded("resources"),
      apps: unloaded("apps"),
      accounts: unloaded("accounts"),
      definitions: unloaded("definitions"),
      loopPolicies: unloaded("loopPolicies"),
      ruleDefinitions: unloaded("ruleDefinitions"),
      strategyDefinitions: unloaded("strategyDefinitions"),
      commands: unloaded("commands"),
    },
    versions,
  };
}

export class PgStore {
  constructor(url, { max = 4 } = {}) {
    this.conflicts = 0;
    this.pool = new pg.Pool({
      connectionString: url,
      max,
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
      idleTimeoutMillis: 10000,
      application_name: "mx-device",
    });
    this.pool.on("error", () => {});
  }
  async migrate() {
    const dir = new URL("../migrations/", import.meta.url);
    // File I/O precedes the transaction; migrations contain only bounded DB work.
    const files = await Promise.all(
      (await readdir(dir))
        .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
        .sort()
        .map(async (name) => {
          const sql = await readFile(new URL(name, dir), "utf8");
          return {
            name,
            sql,
            checksum: createHash("sha256").update(sql).digest("hex"),
          };
        }),
    );
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='2s'");
      await c.query("SET LOCAL statement_timeout='4s'");
      await c.query("SELECT pg_advisory_xact_lock(1297634386,2)");
      await c.query("CREATE SCHEMA IF NOT EXISTS mx_device");
      await c.query(
        "CREATE TABLE IF NOT EXISTS mx_device.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const applied = (
        await c.query("SELECT name,checksum FROM mx_device.schema_migrations")
      ).rows;
      for (const old of applied) {
        if (
          !files.some((f) => f.name === old.name && f.checksum === old.checksum)
        )
          throw new Error(
            "Applied migration changed or is missing; refusing downgrade",
          );
      }
      for (const f of files) {
        if (applied.some((old) => old.name === f.name)) continue;
        // 001 is idempotent, allowing pre-ledger installations to be adopted in place.
        await c.query(f.sql);
        await c.query(
          "INSERT INTO mx_device.schema_migrations(name,checksum) VALUES($1,$2)",
          [f.name, f.checksum],
        );
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async ready() {
    await this.pool.query("SELECT 1 FROM mx_device.devices LIMIT 1");
    return true;
  }
  async close() {
    await this.pool.end();
  }
  // Small batches outside the realm lock: store transactions only append events,
  // so deleting old rows never blocks scheduling for long.
  async pruneEvents({
    retentionMs,
    keepLatest,
    batchSize = 5000,
    maxBatches = 20,
  }) {
    const deleted = {};
    for (const mode of ["sim", "real"]) {
      deleted[mode] = 0;
      const floor = (
        await this.pool.query(
          "SELECT seq FROM mx_device.events WHERE mode=$1 ORDER BY seq DESC OFFSET $2 LIMIT 1",
          [mode, keepLatest - 1],
        )
      ).rows[0]?.seq;
      if (floor == null) continue;
      for (let i = 0; i < maxBatches; i++) {
        const { rowCount } = await this.pool.query(
          `DELETE FROM mx_device.events WHERE seq IN (
            SELECT seq FROM mx_device.events WHERE mode=$1 AND seq<$2
              AND at < (extract(epoch FROM clock_timestamp())*1000)::bigint - $3
            ORDER BY at LIMIT $4)`,
          [mode, floor, retentionMs[mode], batchSize],
        );
        deleted[mode] += rowCount;
        if (rowCount < batchSize) break;
      }
    }
    return deleted;
  }
  async heartbeat(id, doc) {
    await this.pool.query(
      "INSERT INTO mx_device.workers VALUES($1,(extract(epoch FROM clock_timestamp())*1000)::bigint,$2) ON CONFLICT(id) DO UPDATE SET at=excluded.at,document=excluded.document",
      [id, doc],
    );
    // Per-instance rows from restarted workers expire after a day.
    await this.pool.query(
      "DELETE FROM mx_device.workers WHERE at < (extract(epoch FROM clock_timestamp())*1000)::bigint - 86400000",
    );
  }
  /** Runs a pure, synchronous state transition and persists the rows it changed.
   *
   * Global (default): loads the realm under the realm advisory lock; for
   * scheduling, admin and claims. scope "attempt" | "device": loads only that
   * device's rows FOR UPDATE and takes no realm lock, so per-device execution
   * never queues behind other devices. Unloaded collections throw if touched.
   * Every write is a version CAS; on conflict the transaction rolls back and
   * fn re-runs on fresh rows (fn performs no I/O, so re-running is safe).
   * epoch: when given, the transaction must still belong to that scheduler
   * leader epoch, or it fails with LeadershipLost and is not retried. */
  async atomic(fn, options = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#transaction(fn, options);
      } catch (error) {
        if (attempt >= 4 || !RETRYABLE.has(error.code)) throw error;
        this.conflicts++;
        await sleep(5 + Math.floor(Math.random() * 20) * attempt);
      }
    }
  }
  async #transaction(
    fn,
    {
      mode = "sim",
      jobId = null,
      attemptId = null,
      key = null,
      frame = null,
      scope = null,
      deviceId = null,
      epoch = null,
      agentId = null,
    },
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='2s'");
      await c.query("SET LOCAL statement_timeout='5s'");
      if (epoch != null) {
        // FOR SHARE: a new leader's epoch bump waits for this transaction, and
        // this transaction sees the bump if it came first.
        const current = (
          await c.query(
            "SELECT epoch FROM mx_device.scheduler_leader WHERE id=1 FOR SHARE",
          )
        ).rows[0]?.epoch;
        if (Number(current) !== Number(epoch)) throw new LeadershipLost();
      }
      if (!scope)
        // Serialize realm-wide decisions (claims, admin) with each other; never
        // physical execution. Per-device work uses scoped row locks instead.
        await c.query("SELECT pg_advisory_xact_lock(1297634386,$1)", [
          mode === "real" ? 1 : 0,
        ]);
      const now = Number(
        (
          await c.query(
            "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
          )
        ).rows[0].now,
      );
      const loaded = scope
        ? await loadScoped(c, mode, scope, {
            deviceId,
            attemptId,
            jobId,
            agentId,
          })
        : await loadRealm(c, mode, { jobId, key, attemptId });
      const { rows, versions } = loaded;
      const catalog = snapshotCatalog(rows.commandDefinitions);
      const state = { ...rows, events: [] };
      // Row JSON as loaded; jobs and commands compare in stored (by-reference) form.
      const before = new Map(),
        signals = new Map();
      for (const [name, table] of ROW_TABLES)
        if (Array.isArray(rows[name]) && !isUnloaded(rows[name]))
          for (const row of rows[name]) {
            before.set(
              `${table}:${row.id}`,
              JSON.stringify(stored(table, row, catalog)),
            );
            signals.set(`${table}:${row.id}`, schedulable(table, row));
          }
      for (const j of isUnloaded(rows.jobs) ? [] : rows.jobs)
        restoreJob(j, catalog);
      for (const cdoc of isUnloaded(rows.commands) ? [] : rows.commands)
        restoreCommand(cdoc, catalog);
      const catalogsBefore = new Map();
      for (const [name, table] of CATALOG_TABLES)
        if (!isUnloaded(rows[name]))
          for (const row of rows[name])
            catalogsBefore.set(`${table}:${row.id}`, JSON.stringify(row));

      if (loaded.usage?.length) foldUsage(state, now, loaded.usage);
      const prior = priorStatuses(state);
      const result = fn(state, now);
      if (result?.then)
        throw new Error("Async work inside transaction is forbidden");
      const settled = settleClients(state, now, prior);

      // Append-only catalogs: new versions are inserted; existing ones never change.
      for (const [name, table] of CATALOG_TABLES) {
        if (isUnloaded(state[name])) continue;
        for (const d of state[name]) {
          const prior = catalogsBefore.get(`${table}:${d.id}`);
          if (prior === undefined)
            await c.query(
              `INSERT INTO mx_device.${table} VALUES($1,$2,$3,$4,$5)`,
              [d.id, d.mode, d.code, d.version, d],
            );
          else if (prior !== JSON.stringify(d))
            throw new Error(`目录版本不可修改：${table} ${d.id}`);
        }
      }
      let workChanged = false;
      for (const [name, table] of ROW_TABLES) {
        if (isUnloaded(state[name])) continue;
        const writer = WRITERS[table];
        for (const row of state[name]) {
          const id = `${table}:${row.id}`,
            json = JSON.stringify(stored(table, row, catalog));
          if (before.get(id) === json) continue;
          const version = versions.get(id);
          const { rowCount } = await c.query(
            version === undefined ? writer.insert : writer.update,
            version === undefined
              ? writer.insertArgs(row, json)
              : writer.updateArgs(row, json, version),
          );
          if (rowCount !== 1) throw new Conflict(table);
          const signal = schedulable(table, row);
          if (signal !== null && signal !== signals.get(id)) workChanged = true;
        }
      }
      for (const e of state.events)
        await c.query(
          "INSERT INTO mx_device.events(mode,at,document) VALUES($1,$2,$3)",
          [mode, e.at, e],
        );
      for (const u of settled.usage)
        await c.query(
          "INSERT INTO mx_device.client_usage(mode,client_id,at,document) VALUES($1,$2,$3,$4)",
          [u.mode, u.clientId, u.at, u],
        );
      // One delivery per job event, even if the job row is written twice.
      for (const o of settled.outbox)
        await c.query(
          "INSERT INTO mx_device.outbox(id,mode,client_id,job_id,event,status,attempts,next_at,locked_until,created_at,document) VALUES($1,$2,$3,$4,$5,'pending',0,$6,0,$7,$8) ON CONFLICT(job_id,event) DO NOTHING",
          [
            o.id,
            o.mode,
            o.clientId,
            o.jobId,
            o.event,
            o.nextAt,
            o.createdAt,
            {
              id: o.id,
              mode: o.mode,
              clientId: o.clientId,
              jobId: o.jobId,
              event: o.event,
              url: o.url,
              payload: o.payload,
            },
          ],
        );
      if (frame && result === true) {
        await c.query(
          "INSERT INTO mx_device.latest_frames(device_id,capture_id,config_version,received_at,png) VALUES($1,$2,$3,$4,$5) ON CONFLICT(device_id) DO UPDATE SET capture_id=excluded.capture_id,config_version=excluded.config_version,received_at=excluded.received_at,png=excluded.png",
          [frame.deviceId, frame.captureId, frame.version, now, frame.png],
        );
      }
      // Delivered on commit; wakes schedulers listening for new or freed work.
      if (workChanged)
        await c.query("SELECT pg_notify('mx_device_work', $1)", [mode]);
      await c.query("COMMIT");
      return clone(result);
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  async snapshot(mode) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='5s'");
      const [
        d,
        j,
        e,
        w,
        a,
        r,
        apps,
        definitions,
        commandDefinitions,
        ruleDefinitions,
        strategyDefinitions,
        loopPolicies,
        commands,
        accounts,
        agents,
        clients,
        clock,
      ] = [
        await client.query(
          "SELECT document FROM mx_device.devices WHERE mode=$1 ORDER BY id",
          [mode],
        ),
        await client.query(SQL.snapshotJobs, [mode]),
        await client.query(
          "SELECT seq,document FROM mx_device.events WHERE mode=$1 ORDER BY seq DESC LIMIT 100",
          [mode],
        ),
        await client.query(
          "SELECT id,at,document FROM mx_device.workers ORDER BY id",
        ),
        await client.query(SQL.snapshotAttempts, [mode]),
        await client.query(
          "SELECT document FROM mx_device.resource_policies WHERE mode=$1 ORDER BY id",
          [mode],
        ),
        await client.query(
          "SELECT document FROM mx_device.device_apps WHERE mode=$1 ORDER BY id",
          [mode],
        ),
        await client.query(
          "SELECT document FROM mx_device.task_definitions WHERE mode=$1",
          [mode],
        ),
        await client.query(
          "SELECT document FROM mx_device.command_definitions WHERE mode=$1",
          [mode],
        ),
        await client.query(
          "SELECT document FROM mx_device.rule_definitions WHERE mode=$1",
          [mode],
        ),
        await client.query(
          "SELECT document FROM mx_device.strategy_definitions WHERE mode=$1",
          [mode],
        ),
        await client.query(
          "SELECT document FROM mx_device.loop_policies WHERE mode=$1 ORDER BY id",
          [mode],
        ),
        await client.query(SQL.snapshotCommands, [mode]),
        await client.query(
          "SELECT document FROM mx_device.accounts WHERE mode=$1 ORDER BY id",
          [mode],
        ),
        await client.query(
          "SELECT document FROM mx_device.agents WHERE mode=$1 ORDER BY id",
          [mode],
        ),
        await client.query(
          "SELECT document FROM mx_device.clients WHERE mode=$1 ORDER BY id",
          [mode],
        ),
        await client.query(
          "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
        ),
      ];
      await client.query("COMMIT");
      const catalog = snapshotCatalog(
        commandDefinitions.rows.map((r) => r.document),
      );
      return {
        devices: d.rows.map((r) => r.document),
        jobs: j.rows.map((r) => restoreJob(r.document, catalog)),
        attempts: a.rows.map((r) => r.document),
        events: e.rows.reverse().map((r) => ({ ...r.document, seq: r.seq })),
        resources: r.rows.map((r) => r.document),
        apps: apps.rows.map((r) => r.document),
        definitions: definitions.rows.map((r) => r.document),
        commandDefinitions: commandDefinitions.rows.map((r) => r.document),
        ruleDefinitions: ruleDefinitions.rows.map((r) => r.document),
        strategyDefinitions: strategyDefinitions.rows.map((r) => r.document),
        loopPolicies: loopPolicies.rows.map((r) => r.document),
        commands: commands.rows.map((r) => restoreCommand(r.document, catalog)),
        accounts: accounts.rows.map((r) => r.document),
        agents: agents.rows.map((r) => r.document),
        clients: clients.rows.map((r) => r.document),
        now: Number(clock.rows[0].now),
        workers: w.rows.map((r) => ({
          ...r.document,
          id: r.id,
          at: Number(r.at),
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  // ---- Job API v1 reads and the callback outbox (outside transactions) ----
  async client(id) {
    const { rows } = await this.pool.query(
      "SELECT document FROM mx_device.clients WHERE id=$1",
      [id],
    );
    return rows[0]?.document || null;
  }
  async jobStatuses(mode, ids) {
    if (!ids.length) return new Map();
    const { rows } = await this.pool.query(
      "SELECT id,status FROM mx_device.jobs WHERE mode=$1 AND id=ANY($2::uuid[])",
      [mode, ids],
    );
    return new Map(rows.map((r) => [r.id, r.status]));
  }
  async #catalog(mode) {
    return snapshotCatalog(
      (
        await this.pool.query(
          "SELECT document FROM mx_device.command_definitions WHERE mode=$1",
          [mode],
        )
      ).rows.map((r) => r.document),
    );
  }
  async clientJobs(mode, clientId, { limit = 50, active = false } = {}) {
    const { rows } = await this.pool.query(
      `SELECT document - 'result' AS document FROM mx_device.jobs
        WHERE mode=$1 AND document ? 'client' AND document->'client'->>'id'=$2
        ${active ? "AND status IN ('queued','running')" : ""}
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [mode, clientId, limit],
    );
    const catalog = await this.#catalog(mode);
    return rows.map((r) => restoreJob(r.document, catalog));
  }
  async clientJobCounts(mode) {
    const { rows } = await this.pool.query(
      `SELECT document->'client'->>'id' AS client_id, status, count(*)::int AS n
        FROM mx_device.jobs WHERE mode=$1 AND document ? 'client'
        GROUP BY 1, 2`,
      [mode],
    );
    const counts = {};
    for (const r of rows) (counts[r.client_id] ||= {})[r.status] = r.n;
    return counts;
  }
  /** Due deliveries, locked for lockMs so another API replica skips them. */
  async claimDeliveries({ limit = 20, lockMs = 30000 } = {}) {
    const { rows } = await this.pool.query(
      `WITH due AS (
         SELECT id FROM mx_device.outbox
         WHERE status='pending'
           AND next_at <= (extract(epoch FROM clock_timestamp())*1000)::bigint
           AND locked_until <= (extract(epoch FROM clock_timestamp())*1000)::bigint
         ORDER BY next_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE mx_device.outbox o
         SET locked_until=(extract(epoch FROM clock_timestamp())*1000)::bigint + $2
         FROM due WHERE o.id=due.id
       RETURNING o.*`,
      [limit, lockMs],
    );
    if (!rows.length) return [];
    const clients = new Map(
      (
        await this.pool.query(
          "SELECT id,document FROM mx_device.clients WHERE id=ANY($1::uuid[])",
          [[...new Set(rows.map((r) => r.client_id))]],
        )
      ).rows.map((r) => [r.id, r.document]),
    );
    return rows.map((r) => ({
      delivery: outboxRow(r),
      client: clients.get(r.client_id) || null,
    }));
  }
  async settleDelivery(id, { status, attempts, nextAt, last }) {
    await this.pool.query(
      `UPDATE mx_device.outbox SET status=$2, attempts=$3, next_at=$4, locked_until=0,
        document=jsonb_set(document, '{last}', $5::jsonb) WHERE id=$1`,
      [id, status, attempts, nextAt, JSON.stringify(last ?? null)],
    );
  }
  async deliveries(mode, { clientId = null, limit = 50 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM mx_device.outbox WHERE mode=$1 AND ($2::uuid IS NULL OR client_id=$2)
        ORDER BY created_at DESC LIMIT $3`,
      [mode, clientId, limit],
    );
    return rows.map(outboxRow);
  }
  /** Settled deliveries older than retentionMs, in small batches. */
  async pruneOutbox({ retentionMs, batchSize = 5000 }) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM mx_device.outbox WHERE id IN (
        SELECT id FROM mx_device.outbox WHERE status IN ('delivered','dead')
          AND created_at < (extract(epoch FROM clock_timestamp())*1000)::bigint - $1
        ORDER BY created_at LIMIT $2)`,
      [retentionMs, batchSize],
    );
    return rowCount;
  }
  async retryDelivery(mode, id) {
    const { rows } = await this.pool.query(
      `UPDATE mx_device.outbox SET status='pending', locked_until=0,
         next_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
       WHERE id=$1 AND mode=$2 AND status<>'delivered' RETURNING *`,
      [id, mode],
    );
    return rows[0] ? outboxRow(rows[0]) : null;
  }
  async frame(deviceId, captureId) {
    const { rows } = await this.pool.query(
      "SELECT f.png FROM mx_device.latest_frames f JOIN mx_device.devices d ON d.id=f.device_id WHERE d.mode='real' AND f.device_id=$1 AND f.capture_id=$2 AND f.config_version::text=d.document->'observer'->>'version' AND f.capture_id::text=d.document->'frame'->>'id'",
      [deviceId, captureId],
    );
    return rows[0]?.png || null;
  }
  async detail(mode, id) {
    const j = await this.pool.query(
      "SELECT document FROM mx_device.jobs WHERE id=$1 AND mode=$2",
      [id, mode],
    );
    if (!j.rowCount) return null;
    const catalog = snapshotCatalog(
      (
        await this.pool.query(
          "SELECT document FROM mx_device.command_definitions WHERE mode=$1",
          [mode],
        )
      ).rows.map((r) => r.document),
    );
    return {
      job: restoreJob(j.rows[0].document, catalog),
      commands: (
        await this.pool.query(
          "SELECT document FROM mx_device.execution_commands WHERE job_id=$1 ORDER BY created_at,id",
          [id],
        )
      ).rows.map((r) => restoreCommand(r.document, catalog)),
      attempts: (
        await this.pool.query(
          "SELECT document FROM mx_device.attempts WHERE job_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows.map((r) => r.document),
    };
  }
}
