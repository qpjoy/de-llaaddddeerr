import test from "node:test";
import assert from "node:assert/strict";
import { recoverLock, harborProcesses } from "../scripts/recover-lock.mjs";

function fixture(overrides = {}) {
  let lock = {
    metadata: {
      uid: "old-lock",
      resourceVersion: "42",
      creationTimestamp: "2026-10-11T00:00:00Z",
    },
    data: { action: "deploy" },
  };
  const calls = [],
    reports = [],
    removals = [];
  const jobs = { items: [] },
    pods = { items: [] };
  const options = {
    host: "internal-test",
    processes: () => [],
    alive: () => false,
    report: (value) => reports.push(value),
    get: (args) => {
      calls.push(args);
      return structuredClone(
        args[1] === "configmap" ? lock : args[1] === "jobs" ? jobs : pods,
      );
    },
    remove: (value) => {
      removals.push(value);
      lock = null;
    },
    ...overrides,
  };
  return {
    options,
    calls,
    reports,
    removals,
    jobs,
    pods,
    setLock: (value) => {
      lock = value;
    },
  };
}

test("lock recovery defaults to read-only inspection even when the legacy lock appears idle", () => {
  const f = fixture();
  assert.equal(recoverLock(f.options), "checked");
  assert.deepEqual(f.removals, []);
  assert.equal(f.reports[0].ownerPid, "legacy-unknown");
  assert.ok(f.calls.every((a) => ["configmap", "jobs", "pods"].includes(a[1])));
});
test("confirmed recovery deletes only the inspected UID and resourceVersion, then verifies absence", () => {
  const f = fixture();
  f.jobs.items.push({
    metadata: { name: "mx-harbor-migrate-done" },
    status: { conditions: [{ type: "Complete", status: "True" }] },
  });
  f.pods.items.push({
    metadata: { name: "web", labels: { app: "mx-harbor" } },
    spec: { containers: [{ name: "web" }] },
    status: { phase: "Running" },
  });
  assert.equal(recoverLock({ ...f.options, confirmIdle: true }), "released");
  assert.deepEqual(f.removals, [
    {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: "old-lock", resourceVersion: "42" },
    },
  ]);
  assert.equal(recoverLock({ ...f.options, confirmIdle: true }), "absent");
  assert.equal(f.removals.length, 1);
});
test("confirmation never bypasses a live owner, foreign owner or an active/ambiguous process", () => {
  for (const data of [
    { action: "enroll", ownerHost: "internal-test", ownerPid: "123" },
    { action: "deploy", ownerHost: "other-host", ownerPid: "123" },
    { action: "deploy", ownerHost: "internal-test" },
  ]) {
    const f = fixture({ alive: () => true });
    f.setLock({ metadata: { uid: "old-lock", resourceVersion: "42" }, data });
    assert.throws(
      () => recoverLock({ ...f.options, confirmIdle: true }),
      /持有/,
    );
    assert.equal(f.removals.length, 0);
  }
  const f = fixture({
    processes: () => [
      { pid: 456, script: "operations.mjs", ownership: "unknown" },
    ],
  });
  assert.throws(
    () => recoverLock({ ...f.options, confirmIdle: true }),
    /操作进程/,
  );
  assert.equal(f.removals.length, 0);
});
test("recovery refuses pending/active migration Jobs and orphaned nonterminal migration Pods", () => {
  for (const status of [
    {},
    { active: 1 },
    { active: 1, conditions: [{ type: "Failed", status: "True" }] },
  ]) {
    const f = fixture();
    f.jobs.items.push({ metadata: { name: "mx-harbor-migrate-test" }, status });
    assert.throws(
      () => recoverLock({ ...f.options, confirmIdle: true }),
      /迁移 Job/,
    );
    assert.equal(f.removals.length, 0);
  }
  for (const phase of ["Pending", "Running", "Unknown", undefined]) {
    const f = fixture();
    f.pods.items.push({
      metadata: {
        name: "orphan",
        ownerReferences: [{ kind: "Job", name: "mx-harbor-migrate-gone" }],
      },
      status: { phase },
    });
    assert.throws(
      () => recoverLock({ ...f.options, confirmIdle: true }),
      /迁移 Pod/,
    );
    assert.equal(f.removals.length, 0);
  }
});
test("read errors and server-side conflicts do not fall back to unguarded deletion", () => {
  const f = fixture();
  const original = f.options.get;
  f.options.get = (args) => {
    if (args[1] === "jobs") throw Error("Forbidden");
    return original(args);
  };
  assert.throws(
    () => recoverLock({ ...f.options, confirmIdle: true }),
    /Forbidden/,
  );
  assert.equal(f.removals.length, 0);
  const conflict = fixture({
    remove: () => {
      throw Error("Conflict: resourceVersion changed");
    },
  });
  assert.throws(
    () => recoverLock({ ...conflict.options, confirmIdle: true }),
    /Conflict/,
  );
  assert.equal(conflict.calls.filter((a) => a[1] === "configmap").length, 1);
});
test("a deleted/recreated lock is preserved, and incomplete deletion never reports success", () => {
  const f = fixture();
  const original = f.options.remove;
  f.options.remove = (value) => {
    original(value);
    f.setLock({ metadata: { uid: "another-task", resourceVersion: "43" } });
  };
  assert.equal(recoverLock({ ...f.options, confirmIdle: true }), "replaced");
  assert.equal(f.removals.length, 1);
  const pending = fixture({ remove: () => {} });
  assert.throws(
    () => recoverLock({ ...pending.options, confirmIdle: true }),
    /仍在删除中/,
  );
});
test("process inspection reports only safe identifiers and conservatively retains unknown owners", () => {
  const output = [
    "100 node scripts/operations.mjs deploy --token DO-NOT-PRINT",
    "101 node /repo/mx-harbor/scripts/enroll.mjs",
    "102 node scripts/operations.mjs deploy",
    "103 node scripts/migrate.mjs",
    "104 node scripts/recover-lock.mjs --confirm-idle",
    "105 node apps/server/index.mjs",
  ].join("\n");
  const found = harborProcesses(output, (pid) => {
    if (pid === 103) throw Error("Permission denied");
    return pid === 100 ? "/repo/mx-harbor" : "/repo/other-app";
  });
  assert.deepEqual(
    found.map((p) => p.pid),
    [100, 101, 103],
  );
  assert.equal(found[2].ownership, "unknown");
  assert.ok(!JSON.stringify(found).includes("DO-NOT-PRINT"));
});
