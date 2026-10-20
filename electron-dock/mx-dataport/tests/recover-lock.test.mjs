import test from "node:test";
import assert from "node:assert/strict";
import {
  recoverLock,
  harborProcesses,
  acquireDeployLock,
  markDeployLockReleasable,
} from "../scripts/recover-lock.mjs";

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
    "106 node /repo/mx-dataport/scripts/enroll.mjs",
  ].join("\n");
  const found = harborProcesses(output, (pid) => {
    if (pid === 103) throw Error("Permission denied");
    return pid === 100 ? "/repo/mx-harbor" : "/repo/other-app";
  });
  assert.deepEqual(
    found.map((p) => p.pid),
    [100, 101, 103, 106],
  );
  assert.equal(found[2].ownership, "unknown");
  assert.ok(!JSON.stringify(found).includes("DO-NOT-PRINT"));
});

function releasableLock(data = {}) {
  return {
    metadata: {
      uid: "old-lock",
      resourceVersion: "42",
      creationTimestamp: "2020-01-01T00:00:00Z",
    },
    data: {
      action: "deploy",
      ownerHost: "internal-test",
      ownerPid: "123",
      recoveryVersion: "1",
      recoveryState: "releasable",
      ...data,
    },
  };
}

const alreadyExists = () => Object.assign(Error("AlreadyExists"), { lockAlreadyExists: true });

test("automatic recovery requires a versioned completed deploy and explicit known ownership, regardless of age", () => {
  for (const data of [
    { recoveryVersion: undefined },
    { recoveryVersion: "2" },
    { recoveryState: "active" },
    { recoveryState: undefined },
    { action: "enroll" },
    { ownerHost: undefined },
    { ownerPid: undefined },
    { ownerHost: "another-host" },
    { ownerPid: "0" },
    { ownerPid: "invalid" },
  ]) {
    const f = fixture();
    f.setLock(releasableLock(data));
    assert.throws(() => recoverLock({ ...f.options, automatic: true, confirmIdle: true }));
    assert.equal(f.removals.length, 0);
  }
  const legacy = fixture();
  assert.throws(() => recoverLock({ ...legacy.options, automatic: true }), /自动释放凭据/);
  assert.equal(legacy.removals.length, 0);
});

test("automatic recovery keeps live or uncertain owners and still checks all local work and migration resources", () => {
  for (const setup of [
    f => { f.options.alive = () => true; },
    f => { f.options.alive = () => { throw Error("Permission denied"); }; },
    f => { f.options.processes = () => [{ pid: 456, script: "operations.mjs" }]; },
    f => { f.jobs.items.push({ metadata: { name: "mx-harbor-migrate-pending" }, status: {} }); },
    f => { f.pods.items.push({ metadata: { ownerReferences: [{ kind: "Job", name: "mx-harbor-migrate-orphan" }] }, status: { phase: "Running" } }); },
  ]) {
    const f = fixture();
    f.setLock(releasableLock());
    setup(f);
    assert.throws(() => recoverLock({ ...f.options, automatic: true }));
    assert.equal(f.removals.length, 0);
  }
});

test("acquisition creates once normally, and retries only once after guarded recovery", () => {
  const f = fixture();
  f.setLock(releasableLock());
  let creates = 0;
  const created = { metadata: { uid: "new-lock" } };
  const create = () => {
    creates++;
    if (creates === 1) throw alreadyExists();
    return created;
  };
  assert.equal(acquireDeployLock({ ...f.options, create }), created);
  assert.equal(creates, 2);
  assert.deepEqual(f.removals[0].preconditions, { uid: "old-lock", resourceVersion: "42" });
  const fresh = fixture();
  assert.equal(acquireDeployLock({ ...fresh.options, create: () => created }), created);
  assert.equal(fresh.calls.length, 0);
});

test("acquisition never recovers an ambiguous create error, steals a replacement, or loops after a race", () => {
  for (const error of [
    Error("Timeout"),
    Error("AlreadyExists text from an ambiguous response"),
    SyntaxError('Unexpected token in JSON: AlreadyExists'),
  ]) {
    const failed = fixture();
    assert.throws(() => acquireDeployLock({ ...failed.options, create: () => { throw error; } }), actual => actual === error);
    assert.equal(failed.calls.length, 0);
  }
  const replaced = fixture();
  replaced.setLock(releasableLock());
  replaced.options.remove = value => {
    replaced.removals.push(value);
    replaced.setLock({ metadata: { uid: "competing-owner", resourceVersion: "43" } });
  };
  let creates = 0;
  const collision = () => { creates++; throw alreadyExists(); };
  assert.throws(() => acquireDeployLock({ ...replaced.options, create: collision }), /其他任务/);
  assert.equal(creates, 1);
  assert.equal(replaced.removals.length, 1);
  const race = fixture();
  race.setLock(releasableLock());
  creates = 0;
  assert.throws(() => acquireDeployLock({ ...race.options, create: collision }), /AlreadyExists/);
  assert.equal(creates, 2);
  assert.equal(race.removals.length, 1);
});

test("automatic deletion conflicts stop acquisition without a retry", () => {
  const f = fixture({ remove: () => { throw Error("Conflict"); } });
  f.setLock(releasableLock());
  let creates = 0;
  assert.throws(() => acquireDeployLock({ ...f.options, create: () => { creates++; throw alreadyExists(); } }), /Conflict/);
  assert.equal(creates, 1);
});

test("completion marking rereads owner and patches with both UID and current resourceVersion guards", () => {
  const f = fixture();
  const original = releasableLock({ recoveryState: "active" });
  const current = structuredClone(original);
  current.metadata.resourceVersion = "47";
  f.setLock(current);
  const patches = [];
  markDeployLockReleasable({ lock: original, get: f.options.get, patch: p => patches.push(p), host: "internal-test", pid: 123 });
  assert.deepEqual(patches, [[
    { op: "test", path: "/metadata/uid", value: "old-lock" },
    { op: "test", path: "/metadata/resourceVersion", value: "47" },
    { op: "replace", path: "/data/recoveryState", value: "releasable" },
  ]]);
  assert.equal(f.removals.length, 0);
});

test("completion marking refuses missing, foreign, malformed, or replaced locks and preserves patch conflicts", () => {
  const original = releasableLock({ recoveryState: "active" });
  for (const current of [
    null,
    { ...original, metadata: { uid: "replacement", resourceVersion: "43" } },
    { ...original, metadata: { uid: "old-lock" } },
    ...[
      { ownerHost: "other-host" }, { ownerPid: "456" }, { action: "enroll" },
      { recoveryVersion: undefined }, { recoveryState: undefined }, { recoveryState: "unknown" },
    ].map(data => releasableLock(data)),
  ]) {
    const f = fixture();
    f.setLock(current);
    let patches = 0;
    assert.throws(() => markDeployLockReleasable({ lock: original, get: f.options.get, patch: () => { patches++; }, host: "internal-test", pid: 123 }), /身份或状态/);
    assert.equal(patches, 0);
  }
  const f = fixture();
  f.setLock(original);
  assert.throws(() => markDeployLockReleasable({ lock: original, get: f.options.get, patch: () => { throw Error("Conflict"); }, host: "internal-test", pid: 123 }), /Conflict/);
});
