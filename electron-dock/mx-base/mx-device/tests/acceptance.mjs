// Portable API acceptance entry for a future mx-rig suite. Only simulation credentials.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
const cfg = JSON.parse(
  await readFile(process.argv[2] || ".runtime/config.json", "utf8"),
);
const base = cfg.baseUrl || "http://127.0.0.1:18891",
  token = cfg.testToken;
const call = async (path, body) => {
  const r = await fetch(`${base}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(r.ok, true, `API ${path} returned ${r.status}`);
  return r.json();
};
assert.equal(
  (await call("session")).role,
  "test",
  "Refuse an admin credential; this suite must be unable to reach real devices",
);
const report = {
  startedAt: new Date().toISOString(),
  boundary: "SIMULATION ONLY — no real-phone acceptance",
  cases: [],
};
async function until(check, timeout = 55000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await call("state?mode=sim");
    const result = check(state);
    if (result) return result;
    await sleep(300);
  }
  throw Error("Timed out waiting for simulation evidence");
}
for (const kind of ["five", "priority", "failover", "multiapp"]) {
  const key = `acceptance-${kind}-${crypto.randomUUID()}`;
  await call("scenarios?mode=sim", { kind, key });
  let interruptedJob = null,
    interruptedDevice = null;
  if (kind === "failover") {
    const work = await until((s) => {
      const d = s.devices.find(
        (d) => d.name === "模拟手机 A" && d.state === "running",
      );
      if (!d) return null;
      const a = s.attempts.find(
        (a) => a.deviceId === d.id && a.status === "running",
      );
      return a && { d, a };
    });
    interruptedJob = work.a.jobId;
    interruptedDevice = work.d.id;
    await call(`devices/${work.d.id}/control?mode=sim`, {
      revision: work.d.revision,
      action: "disconnect",
    });
  }
  const jobs = await until((s) => {
    const jobs = s.jobs.filter((j) => j.runId === key);
    return (
      jobs.length === (["priority", "multiapp"].includes(kind) ? 3 : 5) &&
      jobs.every((j) => j.status === "succeeded") &&
      jobs
    );
  });
  const details = await Promise.all(
    jobs.map((j) => call(`jobs/${j.id}?mode=sim`)),
  );
  if (kind === "five") {
    assert.equal(new Set(jobs.map((j) => j.lastDeviceId)).size, 1);
    const attempts = details
      .flatMap((d) => d.attempts)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 1; i < attempts.length; i++)
      assert(
        attempts[i].createdAt >= attempts[i - 1].completedAt,
        "No physical-slot overlap",
      );
  }
  if (kind === "priority") {
    const order = [...jobs].sort((a, b) => a.startedAt - b.startedAt);
    assert.deepEqual(
      order.map((j) => j.priority),
      [1, 1, 8],
      "Short high-priority job waits for current search, then precedes background job",
    );
  }
  if (kind === "failover") {
    const d = details.find((d) => d.job.id === interruptedJob);
    assert(d);
    assert.equal(d.attempts.length, 2);
    assert.equal(d.attempts[0].status, "interrupted");
    assert.equal(d.attempts[1].status, "succeeded");
    assert.notEqual(d.job.lastDeviceId, interruptedDevice);
    assert(
      d.attempts[1].createdAt >= d.attempts[0].completedAt + 6000,
      "Respect simulated takeover timeout",
    );
  }
  if (kind === "multiapp") {
    const order = [...jobs].sort((a, b) => a.startedAt - b.startedAt);
    assert.deepEqual(
      order.map((j) => j.appId),
      ["xhs", "weibo", "xhs"],
    );
    assert.equal(new Set(order.map((j) => j.lastDeviceId)).size, 1);
    assert(order[1].startedAt >= order[0].completedAt + 300);
    assert(
      order[1].startedAt < order[0].completedAt + 12000,
      "Weibo uses the XHS cooldown window",
    );
    assert(
      order[2].startedAt >= order[0].completedAt + 12000,
      "XHS respects its own deadline",
    );
    assert(order[2].startedAt >= order[1].completedAt + 300);
  }
  report.cases.push({
    id: `MXD-${kind.toUpperCase()}`,
    status: "passed",
    runId: key,
    jobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      attempts: j.attemptCount,
    })),
  });
  console.log(`PASS MXD-${kind.toUpperCase()}`);
}
report.finishedAt = new Date().toISOString();
if (process.argv[3])
  await writeFile(process.argv[3], JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
console.log(
  "4 simulated acceptance scenarios passed; real devices were never addressed.",
);
