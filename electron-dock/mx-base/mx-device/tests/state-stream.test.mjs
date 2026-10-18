// V2-4 state stream: incremental patches, SSE fan-out, and that viewers share
// one state build instead of each triggering snapshots and planning.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { MemoryStore } from "../server/store.mjs";
import { createApp } from "../server/http.mjs";
import { register } from "../server/model.mjs";
import { indexState, diffState, applyPatch } from "../server/state-patch.mjs";

let seed = 7;
const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const pick = (rows) => rows[Math.floor(random() * rows.length)];
function payload(n = 6) {
  return {
    now: 1,
    devices: Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      name: `D${i}`,
      state: "idle",
    })),
    jobs: Array.from({ length: n }, (_, i) => ({
      id: `j${i}`,
      status: "queued",
    })),
    attempts: [],
    events: [],
    scheduling: {
      at: 1,
      devices: [{ deviceId: "d0", blockers: [] }],
      queue: [{ jobId: "j0", order: 0 }],
      poolPlans: [{ rack: "r", assignments: [] }],
    },
  };
}
function mutate(state) {
  const next = structuredClone(state);
  for (let k = 0; k < 6; k++) {
    const r = random();
    if (r < 0.2)
      next.jobs.push({
        id: `j${Math.floor(random() * 1e9)}`,
        status: "queued",
      });
    else if (r < 0.35 && next.jobs.length)
      next.jobs.splice(Math.floor(random() * next.jobs.length), 1);
    else if (r < 0.55 && next.jobs.length)
      pick(next.jobs).status = pick(["running", "succeeded"]);
    else if (r < 0.65)
      next.jobs.reverse(); // an ordered collection reordered
    else if (r < 0.75)
      next.attempts.push({
        id: `a${Math.floor(random() * 1e9)}`,
        status: "running",
      });
    else if (r < 0.85)
      next.events.push({ id: `e${Math.floor(random() * 1e9)}`, at: k });
    else if (r < 0.95)
      next.scheduling.queue = next.jobs.map((j, order) => ({
        jobId: j.id,
        order,
      }));
    else next.now++;
  }
  next.scheduling.at++;
  return next;
}

test("patches rebuild the next payload exactly, including order", () => {
  let state = payload(),
    client = structuredClone(state),
    index = indexState(state);
  for (let round = 0; round < 300; round++) {
    const next = mutate(state);
    const { patch, index: nextIndex } = diffState(index, next);
    if (patch) client = applyPatch(client, JSON.parse(JSON.stringify(patch)));
    const sort = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      { ...client, attempts: sort(client.attempts) },
      { ...next, attempts: sort(next.attempts) },
      `round ${round}`,
    );
    state = next;
    index = nextIndex;
  }
  // No change, no patch.
  assert.equal(diffState(index, structuredClone(state)).patch, null);
});

const cfg = {
  adminToken: "a".repeat(64),
  testToken: "b".repeat(64),
  streamIntervalMs: 100,
};
// Minimal SSE reader over fetch: yields { event, data } as they arrive.
async function* events(response) {
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
async function lab(t) {
  const store = new MemoryStore();
  await store.atomic((s, n) => {
    register(s, n, "sim", { name: "S1", rack: "r", host: "h" });
  });
  let snapshots = 0;
  const snapshot = store.snapshot.bind(store);
  store.snapshot = (mode) => {
    snapshots++;
    return snapshot(mode);
  };
  const server = createApp({ store, cfg });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${cfg.adminToken}` };
  const open = async () => {
    const abort = new AbortController();
    t.after(() => abort.abort());
    const response = await fetch(`${base}/api/stream?mode=sim`, {
      headers,
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    return events(response);
  };
  return { store, server, base, headers, open, snapshots: () => snapshots };
}

test("viewers get a snapshot, then patches for writes, and share one build", async (t) => {
  const L = await lab(t);
  const streams = await Promise.all([1, 2, 3, 4, 5].map(() => L.open()));
  const first = await Promise.all(streams.map((s) => s.next()));
  for (const { value } of first) {
    assert.equal(value.event, "snapshot");
    assert.equal(value.data.state.devices.length, 1);
  }
  // A write through the API is pushed to every viewer as a patch.
  const created = await fetch(`${L.base}/api/agents?mode=sim`, {
    method: "POST",
    headers: { ...L.headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "流式" }),
  });
  assert.equal(created.status, 201);
  for (const stream of streams) {
    let value;
    do value = (await stream.next()).value;
    while (!value.data.set?.agents && !value.data.put?.agents);
    assert.equal(value.event, "patch");
    const agents = value.data.set?.agents || value.data.put?.agents;
    assert.equal(agents[0].name, "流式");
    assert.equal(JSON.stringify(agents).includes("tokenHash"), false);
  }
  // Five viewers and a burst of polls: one build per interval, not per viewer.
  const before = L.snapshots();
  await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch(`${L.base}/api/state?mode=sim`, { headers: L.headers }),
    ),
  );
  await sleep(500);
  const builds = L.snapshots() - before;
  assert(builds <= 8, `about one build per 100 ms tick, got ${builds}`);
  assert.equal(L.server.hub.viewers("sim"), 5);
});

test("a read right after a write sees the write", async (t) => {
  const L = await lab(t);
  await fetch(`${L.base}/api/state?mode=sim`, { headers: L.headers });
  const created = await fetch(`${L.base}/api/agents?mode=sim`, {
    method: "POST",
    headers: { ...L.headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "读后写" }),
  });
  assert.equal(created.status, 201);
  const state = await (
    await fetch(`${L.base}/api/state?mode=sim`, { headers: L.headers })
  ).json();
  assert.equal(state.agents.length, 1);
});
