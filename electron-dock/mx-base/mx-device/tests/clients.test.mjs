// V2-5 caller contract: fair share between clients, the Job API v1 (submit,
// idempotency, quotas, deadlines, long-poll, cancel), result v1 against the
// template schema, signed callback delivery, scoped streams and embed routes.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { Engine } from "../server/engine.mjs";
import { register, claim, markDispatch, finish } from "../server/model.mjs";
import { addWorkflow } from "../server/workflows.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { compareJobs } from "../server/queue-order.mjs";
import {
  orderJobs,
  CLASS_MAX_WAIT_MS,
  fairContext,
} from "../server/fairness.mjs";
import { createClient, changeClient } from "../server/clients.mjs";
import {
  OutboxDeliverer,
  verifySignature,
  backoffMs,
  MAX_ATTEMPTS,
} from "../server/outbox.mjs";

const cfg = {
  adminToken: "a".repeat(64),
  testToken: "b".repeat(64),
  streamIntervalMs: 100,
};
const NOW = 10_000_000;

// A minimal JSON Schema check for the result schema (type, const, enum,
// properties/required/additionalProperties, items, anyOf).
function conforms(value, schema, path = "$") {
  if (schema === false) throw Error(`${path}: no value allowed`);
  if (schema.anyOf) {
    const errors = [];
    for (const s of schema.anyOf)
      try {
        return conforms(value, s, path);
      } catch (e) {
        errors.push(e.message);
      }
    throw Error(`${path}: no alternative matched (${errors.join("; ")})`);
  }
  if ("const" in schema)
    assert.deepEqual(value, schema.const, `${path}: const`);
  if (schema.enum) assert(schema.enum.includes(value), `${path}: enum`);
  if (schema.type) {
    const types = [].concat(schema.type);
    const kind =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value) && types.includes("integer")
            ? "integer"
            : typeof value;
    assert(types.includes(kind), `${path}: type ${kind} not in ${types}`);
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((v, i) => conforms(v, schema.items, `${path}[${i}]`));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required || [])
      assert(k in value, `${path}: missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k])
        conforms(v, schema.properties[k], `${path}.${k}`);
      else
        assert(
          schema.additionalProperties !== false,
          `${path}: undeclared ${k}`,
        );
    }
  }
  return true;
}

function rack(store, devices = 2, rackName = "client-rack") {
  return store.atomic((s, n) => {
    for (let i = 0; i < devices; i++)
      register(s, n, "sim", {
        name: `C${i}`,
        rack: rackName,
        host: "h",
        simApps: ["xhs", "weibo"],
      });
    for (const d of s.devices) d.taskIntervalMs = 0;
    configureLoops(s, n, "sim", {
      rack: rackName,
      revision: 0,
      commandDelayMs: 200,
      cooldownMinMs: 0,
      cooldownMaxMs: 0,
    });
  });
}

test("with no client jobs the queue order is exactly the previous one", () => {
  const jobs = Array.from({ length: 60 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    mode: "sim",
    status: "queued",
    priority: 1 + (i % 9),
    createdAt: NOW - ((i * 7919) % 400000),
    estimatedDurationMs: 1000 + ((i * 104729) % 30000),
  }));
  const state = { jobs, clients: [] };
  const expected = [...jobs].sort(compareJobs(NOW)).map((j) => j.id);
  assert.deepEqual(
    orderJobs(state, NOW, [...jobs]).map((j) => j.id),
    expected,
  );
});

test("weighted fair share interleaves clients by weight, classes stay strict", () => {
  const client = (id, weight, vruntime = 0) => ({
    id,
    name: id,
    weight,
    fair: { vruntime, service: { interactive: 0, standard: 0, batch: 0 } },
  });
  const job = (n, clientId, cls = "standard", createdAt = NOW - 1000) => ({
    id: `${clientId}-${String(n).padStart(3, "0")}`,
    mode: "sim",
    status: "queued",
    priority: 5,
    createdAt,
    estimatedDurationMs: 6000,
    client: { id: clientId, class: cls, deadlineAt: null },
  });
  const jobs = [
    ...Array.from({ length: 40 }, (_, i) => job(i, "light")),
    ...Array.from({ length: 40 }, (_, i) => job(i, "heavy")),
  ];
  const state = {
    jobs,
    clients: [client("light", 1), client("heavy", 3)],
  };
  const first = orderJobs(state, NOW, [...jobs]).slice(0, 40);
  const heavy = first.filter((j) => j.client.id === "heavy").length;
  assert(heavy >= 28 && heavy <= 32, `about 3:1, got ${heavy}:${40 - heavy}`);
  // Within a client: earliest deadline first.
  const urgent = job(99, "light");
  urgent.client.deadlineAt = NOW + 60000;
  const order = orderJobs(state, NOW, [...jobs, urgent]);
  const light = order.filter((j) => j.client.id === "light");
  assert.equal(light[0].id, urgent.id);
  // An interactive job goes before any standard one; a standard job that
  // waited past its maxWait is lifted to the interactive level (once).
  const fast = job(1, "heavy", "interactive");
  fast.id = "interactive-1";
  const old = job(2, "light", "standard", NOW - CLASS_MAX_WAIT_MS.standard - 1);
  old.id = "aged-1";
  const ranked = orderJobs(state, NOW, [...jobs, fast, old]).map((j) => j.id);
  assert.deepEqual(ranked.slice(0, 2).sort(), ["aged-1", "interactive-1"]);
  // A client far ahead in virtual time waits until the others catch up.
  state.clients[1] = client("heavy", 3, 10_000_000);
  const lagging = orderJobs(state, NOW, [...jobs]).slice(0, 10);
  assert(lagging.every((j) => j.client.id === "light"));
});

test("batch keeps a floor of device time under interactive load", () => {
  const svc = (interactive, batch) => ({
    vruntime: 0,
    service: { interactive, standard: 0, batch },
    serviceAt: NOW,
  });
  const state = {
    clients: [{ id: "a", name: "a", weight: 1, fair: svc(600000, 20000) }],
    jobs: [
      {
        id: "b1",
        mode: "sim",
        status: "queued",
        priority: 8,
        createdAt: NOW,
        estimatedDurationMs: 5000,
        client: { id: "a", class: "batch" },
      },
      {
        id: "i1",
        mode: "sim",
        status: "queued",
        priority: 2,
        createdAt: NOW,
        estimatedDurationMs: 5000,
        client: { id: "a", class: "interactive" },
      },
    ],
  };
  assert.equal(fairContext(state, NOW).batchStarved, true);
  assert.equal(orderJobs(state, NOW, [...state.jobs])[0].id, "b1");
  state.clients[0].fair = svc(600000, 120000);
  assert.equal(fairContext(state, NOW).batchStarved, false);
  assert.equal(orderJobs(state, NOW, [...state.jobs])[0].id, "i1");
});

test("claims charge the estimate; the measured time is folded in after", async () => {
  let clock = NOW;
  const store = new MemoryStore(() => clock);
  await rack(store, 1);
  const { client } = await store.atomic((s, n) =>
    createClient(s, n, "sim", { name: "计费", weight: 2 }),
  );
  await store.atomic((s, n) => {
    const job = addWorkflow(s, n, "sim", {
      key: "fair-1",
      definitionId: "sim:weibo.list:1",
      rack: "client-rack",
    });
    job.client = { id: client.id, class: "standard", template: "weibo.list@1" };
  });
  const work = await store.atomic((s, n) => claim(s, n, "sim", "w"));
  const charged = store.state.clients[0].fair.vruntime;
  assert.equal(charged, work.attempt.estimatedDurationMs / 2);
  assert.equal(
    work.attempt.charge.estimateMs,
    work.attempt.estimatedDurationMs,
  );
  clock += 1000;
  await store.atomic((s, n) => markDispatch(s, n, work.attempt));
  clock += 9000;
  await store.atomic((s, n) => finish(s, n, work.attempt, { result: {} }));
  assert.equal(store.state.clientUsage.length, 2, "service + outcome rows");
  await store.atomic(() => null);
  const c = store.state.clients[0];
  assert.equal(c.fair.vruntime, 9000 / 2, "measured 9 s at weight 2");
  assert.equal(c.usage.servedMs, 9000);
  assert.equal(store.state.clientUsage.length, 0);
});

// ---- HTTP ----

async function lab(t, { devices = 2, deliverer = true, staticRoot } = {}) {
  const store = new MemoryStore();
  await rack(store, devices);
  const received = [];
  let answer = 200;
  const receiver = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    received.push({ headers: req.headers, body });
    res.writeHead(answer).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const hook = `http://127.0.0.1:${receiver.address().port}`;
  const outbox = deliverer
    ? new OutboxDeliverer(store, { intervalMs: 50 }).start()
    : null;
  const server = createApp({ store, cfg, deliverer: outbox, staticRoot });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let engine = null;
  t.after(async () => {
    await engine?.close();
    await outbox?.stop();
    await new Promise((r) => server.close(r));
    await new Promise((r) => receiver.close(r));
  });
  const admin = async (path, body) => {
    const res = await fetch(`${base}/api/${path}?mode=sim`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${cfg.adminToken}`,
        ...(body && { "content-type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, value: await res.json() };
  };
  const as =
    (key) =>
    async (path, body, headers = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${key}`,
          ...(body && { "content-type": "application/json" }),
          ...headers,
        },
        body: body && JSON.stringify(body),
      });
      const text = await res.text();
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
      return { status: res.status, value, headers: res.headers };
    };
  return {
    store,
    base,
    hook,
    received,
    admin,
    as,
    answer: (code) => (answer = code),
    startEngine() {
      engine = new Engine(store, { workerId: "w" });
      engine.start();
      return engine;
    },
  };
}

test("clients: keys shown once; submit, replay, scopes and quotas", async (t) => {
  const L = await lab(t, { deliverer: false });
  const created = await L.admin("clients", {
    name: "Hub 模拟",
    classes: ["interactive", "standard"],
    apps: ["weibo", "xhs"],
    quotas: { maxQueued: 3, ratePerMinute: 600, burst: 5 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const { key, callbackSecret, client } = created.value;
  assert.match(key, /^[0-9a-f-]{36}\./);
  assert(callbackSecret.length >= 40);
  const listed = await L.admin("clients");
  const text = JSON.stringify(listed.value);
  assert(!text.includes("keyHash") && !text.includes(callbackSecret));
  assert.equal(listed.value.clients[0].id, client.id);
  const api = L.as(key);
  // Templates: only allowed Apps, each with a params and a result schema.
  const templates = await api("/v1/templates");
  assert.equal(templates.status, 200);
  assert(templates.value.templates.length > 3);
  assert(
    templates.value.templates.every((x) => ["weibo", "xhs"].includes(x.appId)),
  );
  const submit = (body) =>
    api("/v1/jobs", {
      template: "weibo.list",
      params: { keyword: "k" },
      class: "standard",
      ...body,
    });
  const first = await submit({ clientRequestId: "r-1" });
  assert.equal(first.status, 202, JSON.stringify(first.value));
  assert.equal(first.value.status, "queued");
  assert.equal(first.value.template, "weibo.list@1");
  assert(first.value.predicted.finishAt > first.value.predicted.startAt);
  // Same request id: the same job, not a second one.
  const again = await submit({ clientRequestId: "r-1" });
  assert.equal(again.status, 200);
  assert.equal(again.value.jobId, first.value.jobId);
  assert.equal(again.value.replayed, true);
  assert.equal(
    (await submit({ clientRequestId: "r-1", class: "interactive" })).status,
    409,
  );
  // Scopes.
  assert.equal(
    (await submit({ clientRequestId: "r-2", class: "batch" })).status,
    403,
  );
  assert.equal(
    (await submit({ clientRequestId: "r-3", template: "pdd.search" })).status,
    403,
  );
  assert.equal(
    (await submit({ clientRequestId: "r-4", template: "nope" })).status,
    404,
  );
  assert.equal(
    (await submit({ clientRequestId: "r-5", freshnessMs: 1000 })).status,
    400,
  );
  assert.equal(
    (await submit({ clientRequestId: "r-6", callback: { url: `${L.hook}/x` } }))
      .status,
    403,
    "callback origin not allowed",
  );
  // maxQueued: 3 queued at most, then 429 with Retry-After.
  assert.equal((await submit({ clientRequestId: "r-7" })).status, 202);
  assert.equal((await submit({ clientRequestId: "r-8" })).status, 202);
  const full = await submit({ clientRequestId: "r-9" });
  assert.equal(full.status, 429);
  assert(Number(full.headers.get("retry-after")) >= 1);
  // Bad or disabled keys.
  assert.equal(
    (await L.as(`${client.id}.${"x".repeat(43)}`)("/v1/templates")).status,
    401,
  );
  assert.equal((await L.as("nope")("/v1/templates")).status, 401);
  const disabled = await L.admin(`clients/${client.id}`, {
    revision: client.revision,
    status: "disabled",
  });
  assert.equal(disabled.status, 200);
  assert.equal((await api("/v1/templates")).status, 403);
  // Rotation: the old key stops working, the new one is returned once.
  const rotated = await L.admin(`clients/${client.id}`, {
    revision: disabled.value.client.revision,
    status: "active",
    rotateKey: true,
  });
  assert.equal((await api("/v1/templates")).status, 401);
  assert.equal((await L.as(rotated.value.key)("/v1/templates")).status, 200);
});

test("rate limit, deadline feasibility and expiry", async (t) => {
  const L = await lab(t, { devices: 1, deliverer: false });
  const { key } = (
    await L.admin("clients", {
      name: "限速",
      quotas: { ratePerMinute: 60, burst: 2, maxQueued: 50 },
    })
  ).value;
  const api = L.as(key);
  const submit = (id, extra) =>
    api("/v1/jobs", {
      clientRequestId: id,
      template: "weibo.list",
      params: { keyword: "k" },
      ...extra,
    });
  assert.equal((await submit("a")).status, 202);
  assert.equal((await submit("b")).status, 202);
  const limited = await submit("c");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  await sleep(1100);
  // Infeasible deadline: 422 with the predicted finish; nothing is queued.
  const before = L.store.state.jobs.length;
  const late = await submit("d", { deadlineAt: Date.now() + 100 });
  assert.equal(late.status, 422, JSON.stringify(late.value));
  assert(late.value.predictedFinishAt > Date.now());
  assert.equal(L.store.state.jobs.length, before);
  // A ttl job that no device starts in time expires without touching a phone.
  await sleep(1000);
  const ttl = await submit("e", { ttlMs: 600000 });
  assert.equal(ttl.status, 202, JSON.stringify(ttl.value));
  await L.store.atomic((s) => {
    for (const d of s.devices) d.enabled = false;
    s.jobs.find((j) => j.id === ttl.value.jobId).client.deadlineAt = 1;
  });
  L.startEngine();
  const done = await api(`/v1/jobs/${ttl.value.jobId}/wait?timeout=5`);
  assert.equal(done.value.status, "expired");
  assert.equal(done.value.final, true);
  assert.equal(done.value.result.completion, "none");
});

test("long-poll returns the v1 result; the callback is signed and retried", async (t) => {
  const L = await lab(t);
  const { key, callbackSecret, client } = (
    await L.admin("clients", { name: "回调", callbackHosts: [] })
  ).value;
  await L.admin(`clients/${client.id}`, {
    revision: client.revision,
    callbackHosts: [L.hook],
  });
  const api = L.as(key);
  const template = (await api("/v1/templates")).value.templates.find(
    (x) => x.template === "xhs.detail",
  );
  L.answer(500); // the first delivery fails
  const job = await api("/v1/jobs", {
    clientRequestId: "cb-1",
    template: "xhs.detail",
    params: { keyword: "k", target: "note-1" },
    callback: { url: `${L.hook}/mx-device` },
  });
  assert.equal(job.status, 202, JSON.stringify(job.value));
  // A short wait times out while the job is still queued (no engine yet).
  const early = await api(`/v1/jobs/${job.value.jobId}/wait?timeout=1`);
  assert.equal(early.value.timedOut, true);
  assert(["queued", "planned"].includes(early.value.status));
  L.startEngine();
  const done = await api(`/v1/jobs/${job.value.jobId}/wait?timeout=20`);
  assert.equal(done.status, 200);
  assert.equal(done.value.status, "succeeded", JSON.stringify(done.value));
  assert.equal(done.value.timedOut, false);
  const result = done.value.result;
  conforms(result, template.resultSchema);
  assert.equal(result.completion, "succeeded");
  assert.equal(result.records[0].target, "note-1");
  assert.equal(result.evidenceSummary.validatedReceipts, 2);
  // First delivery: HTTP 500, kept pending with a backoff.
  for (let i = 0; i < 50 && !L.received.length; i++) await sleep(100);
  assert.equal(L.received.length, 1);
  let [row] = await L.store.deliveries("sim", { clientId: client.id });
  for (let i = 0; i < 20 && row.attempts === 0; i++) {
    await sleep(50);
    [row] = await L.store.deliveries("sim", { clientId: client.id });
  }
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert(row.nextAt - Date.now() > 5000, "backed off about 10 s");
  // An administrator retries now; the receiver accepts it.
  L.answer(204);
  const retried = await L.admin(`outbox/${row.id}/retry`, {});
  assert.equal(retried.status, 200);
  for (let i = 0; i < 50 && L.received.length < 2; i++) await sleep(100);
  const second = L.received[1];
  assert.equal(second.headers["x-mx-delivery-id"], row.id);
  assert.equal(second.headers["x-mx-event"], "job.finished");
  assert(verifySignature(callbackSecret, second.headers, second.body));
  assert(!verifySignature("wrong", second.headers, second.body));
  assert(!verifySignature(callbackSecret, second.headers, second.body + " "));
  const payload = JSON.parse(second.body);
  assert.equal(payload.deliveryId, row.id);
  assert.equal(payload.job.status, "succeeded");
  assert.equal(payload.job.clientRequestId, "cb-1");
  for (let i = 0; i < 20; i++) {
    [row] = await L.store.deliveries("sim", { clientId: client.id });
    if (row.status === "delivered") break;
    await sleep(50);
  }
  assert.equal(row.status, "delivered");
  // The admin view lists deliveries without their payloads.
  const listed = await L.admin(`clients/${client.id}/deliveries`);
  assert.equal(listed.value.deliveries[0].status, "delivered");
  assert.equal("payload" in listed.value.deliveries[0], false);
});

test("deliveries back off exponentially and die after the last attempt", async () => {
  assert.equal(
    backoffMs(1, () => 0.5),
    10000,
  );
  assert.equal(
    backoffMs(2, () => 0.5),
    20000,
  );
  assert.equal(
    backoffMs(30, () => 0.5),
    3600000,
  );
  const store = new MemoryStore();
  const { client } = await store.atomic((s, n) =>
    createClient(s, n, "sim", {
      name: "x",
      callbackHosts: ["https://hub.test"],
    }),
  );
  const row = store.state.clients.find((c) => c.id === client.id);
  const settled = [];
  const fake = {
    settleDelivery: async (id, patch) => settled.push({ id, ...patch }),
  };
  const failing = new OutboxDeliverer(fake, {
    fetch: async () => new Response("", { status: 503 }),
  });
  const delivery = {
    id: "d1",
    event: "job.finished",
    url: "https://hub.test/cb",
    payload: { ok: 1 },
    attempts: MAX_ATTEMPTS - 1,
  };
  await failing.deliver({ delivery, client: row });
  assert.equal(settled.at(-1).status, "dead");
  // Never contacts an origin the client does not allow.
  let called = false;
  const guarded = new OutboxDeliverer(fake, {
    fetch: async () => {
      called = true;
      return new Response("", { status: 200 });
    },
  });
  await guarded.deliver({
    delivery: { ...delivery, url: "https://evil.test/cb", attempts: 0 },
    client: row,
  });
  assert.equal(called, false);
  assert.equal(settled.at(-1).status, "dead");
});

test("cancel: queued at once, a running session at its next safe point", async (t) => {
  const L = await lab(t, { devices: 1, deliverer: false });
  const { key } = (await L.admin("clients", { name: "取消" })).value;
  const api = L.as(key);
  const submit = (id, template = "xhs.search10") =>
    api("/v1/jobs", {
      clientRequestId: id,
      template,
      params: { keyword: "k" },
    });
  const running = (await submit("long")).value;
  const queued = (await submit("next", "weibo.list")).value;
  L.startEngine();
  for (let i = 0; i < 100; i++) {
    const v = (await api(`/v1/jobs/${running.jobId}`)).value;
    if (v.status === "running" && v.progress.completedSteps >= 1) break;
    await sleep(50);
  }
  const stop = await api(`/v1/jobs/${running.jobId}/cancel`, {});
  assert.equal(stop.status, 200);
  assert(
    ["stopping", "cancelled"].includes(stop.value.status),
    stop.value.status,
  );
  const ended = await api(`/v1/jobs/${running.jobId}/wait?timeout=10`);
  assert.equal(ended.value.status, "cancelled");
  assert(ended.value.result.completion !== "succeeded");
  // No command was left in flight.
  assert(
    L.store.state.commands
      .filter((c) => c.jobId === running.jobId)
      .every((c) => c.status === "succeeded"),
  );
  // Another caller's job is not visible.
  const other = (await L.admin("clients", { name: "旁人" })).value;
  assert.equal((await L.as(other.key)(`/v1/jobs/${queued.jobId}`)).status, 404);
  assert.equal(
    (await L.as(other.key)(`/v1/jobs/${queued.jobId}/cancel`, {})).status,
    404,
  );
});

async function* sse(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (event) yield { event, data: JSON.parse(data) };
    }
  }
}

test("scoped streams and the read-only embed routes", async (t) => {
  const dist = await mkdtemp(join(tmpdir(), "mx-embed-"));
  await writeFile(
    join(dist, "index.html"),
    '<!doctype html><html><head><title>x</title></head><body><script type="module" src="./assets/app.js"></script></body></html>',
  );
  const L = await lab(t, { deliverer: false, staticRoot: dist });
  const mine = (await L.admin("clients", { name: "客户甲", embed: "client" }))
    .value;
  const ops = (await L.admin("clients", { name: "Hub 管理", embed: "ops" }))
    .value;
  const a = L.as(mine.key),
    b = L.as(ops.key);
  const job = (
    await a("/v1/jobs", { clientRequestId: "s-1", template: "weibo.list" })
  ).value;
  await b("/v1/jobs", { clientRequestId: "s-2", template: "weibo.list" });
  // Client scope: only its own job, a pool summary, no devices or events.
  const own = await a("/v1/state?scope=client");
  assert.equal(own.status, 200);
  assert.equal(own.value.scope, "client");
  assert.deepEqual(
    own.value.jobs.map((j) => j.jobId),
    [job.jobId],
  );
  assert.equal(own.value.pool.devices, 2);
  for (const k of ["devices", "events", "accounts", "attempts"])
    assert.equal(k in own.value, false, k);
  assert.equal((await a("/v1/state?scope=ops")).status, 403);
  const all = await b("/v1/state?scope=ops");
  assert.equal(all.value.jobs.length, 2);
  assert(!JSON.stringify(all.value.jobs).includes("fingerprint"));
  // The client stream: a snapshot, then a patch when its job changes.
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = sse(
    await fetch(`${L.base}/v1/stream?scope=client`, {
      headers: { authorization: `Bearer ${mine.key}` },
      signal: abort.signal,
    }),
  );
  const first = (await stream.next()).value;
  assert.equal(first.event, "snapshot");
  assert.equal(first.data.state.jobs.length, 1);
  await a(`/v1/jobs/${job.jobId}/cancel`, {});
  let patch;
  do patch = (await stream.next()).value;
  while (!JSON.stringify(patch.data).includes("cancelled"));
  assert.equal(patch.event, "patch");
  // Embed: session, state, HTML with the embed marker; read-only.
  const session = await a("/embed/api/session", null, {
    "x-mx-embed-user": encodeURIComponent("张三"),
  });
  assert.deepEqual(
    {
      scope: session.value.scope,
      user: session.value.user,
      name: session.value.client.name,
    },
    { scope: "client", user: "张三", name: "客户甲" },
  );
  assert.equal(
    (await a("/embed/api/session", null, { "x-mx-embed-scope": "ops" })).status,
    403,
  );
  const opsSession = await b("/embed/api/session", null, {
    "x-mx-embed-scope": "ops",
  });
  assert.equal(opsSession.value.scope, "ops");
  const html = await a("/embed/");
  assert.equal(html.status, 200);
  assert.match(html.value, /<meta name="mx-embed" content="1" \/>/);
  assert.match(
    html.headers.get("content-security-policy"),
    /frame-ancestors 'self'/,
  );
  const write = await a("/embed/api/jobs", { x: 1 });
  assert.equal(write.status, 405);
  const otherJob = all.value.jobs.find((j) => j.id !== job.jobId);
  assert.equal((await a(`/embed/api/jobs/${otherJob.id}`)).status, 404);
  assert.equal(
    (
      await b(`/embed/api/jobs/${otherJob.id}`, null, {
        "x-mx-embed-scope": "ops",
      })
    ).status,
    200,
  );
  assert.equal((await fetch(`${L.base}/embed/api/state`)).status, 401);
  const none = (await L.admin("clients", { name: "无嵌入", embed: "none" }))
    .value;
  assert.equal((await L.as(none.key)("/embed/api/state")).status, 403);
});

test("admin changes are revision-checked and validated", async () => {
  const store = new MemoryStore();
  const { client } = await store.atomic((s, n) =>
    createClient(s, n, "sim", { name: "校验" }),
  );
  const change = (body) =>
    store.atomic((s, n) => changeClient(s, n, "sim", client.id, body));
  await assert.rejects(change({ revision: 0, weight: 2 }), /已变化/);
  await assert.rejects(change({ revision: 1, weight: 0 }), /权重/);
  await assert.rejects(change({ revision: 1, classes: [] }), /至少/);
  await assert.rejects(
    change({ revision: 1, callbackHosts: ["https://hub.test/path"] }),
    /回调来源无效/,
  );
  await assert.rejects(
    store.atomic((s, n) => createClient(s, n, "real", { name: "真机" })),
    /仅用于模拟/,
  );
  const ok = await change({
    revision: 1,
    weight: 2.5,
    quotas: { maxInflight: 1 },
    callbackHosts: ["https://hub.test:8443"],
  });
  assert.equal(ok.client.weight, 2.5);
  assert.equal(ok.client.quotas.maxInflight, 1);
  assert.equal(ok.client.quotas.maxQueued, 200);
});

test("maxInflight holds a client's other jobs back for the others", async () => {
  const store = new MemoryStore();
  await rack(store, 3);
  const { client } = await store.atomic((s, n) =>
    createClient(s, n, "sim", { name: "并发", quotas: { maxInflight: 1 } }),
  );
  await store.atomic((s, n) => {
    for (let i = 0; i < 3; i++) {
      const job = addWorkflow(s, n, "sim", {
        key: `cap-${i}`,
        definitionId: "sim:weibo.list:1",
        rack: "client-rack",
      });
      job.client = { id: client.id, class: "standard" };
    }
    addWorkflow(s, n, "sim", {
      key: "internal",
      definitionId: "sim:weibo.list:1",
      rack: "client-rack",
    });
  });
  const claimed = await store.atomic((s, n) => {
    const out = [];
    for (let w; (w = claim(s, n, "sim", "w")); ) out.push(w.job);
    return out;
  });
  assert.equal(claimed.filter((j) => j.client).length, 1);
  assert.equal(claimed.filter((j) => !j.client).length, 1);
});
