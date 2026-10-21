import test from "node:test";
import assert from "node:assert/strict";
import { waitForMigration, migrationDiagnostics, migrationLogSummary } from "../scripts/migration-job.mjs";

const response = value => ({ status: 0, stdout: JSON.stringify(value) });
const job = "mx-harbor-migrate-test";

test("migration waits for confirmed Complete, not a running or merely succeeded Pod", async () => {
  const states = [{}, { succeeded: 1 }, { conditions: [{ type: "Complete", status: "True" }] }];
  let time = 0, calls = 0;
  const result = await waitForMigration((args, options) => {
    assert.ok(args.includes(`job/${job}`));
    assert.ok(args.includes("--request-timeout=15s"));
    assert.equal(options.timeout, 20000);
    return response({ status: states[calls++] });
  }, job, { now: () => time, pause: async ms => { time += ms; } });
  assert.equal(result.outcome, "complete");
  assert.equal(calls, 3);
});

test("Failed and FailureTarget stop immediately instead of waiting 310 seconds", async () => {
  for (const type of ["Failed", "FailureTarget"]) {
    const result = await waitForMigration(() => response({ status: {
      conditions: [{ type, status: "True", reason: "BackoffLimitExceeded", message: "private-sensitive-payload" }],
    } }), job, { pause: () => assert.fail("a failed Job must not keep waiting") });
    assert.equal(result.outcome, "failed");
    assert.equal(result.detail, "BackoffLimitExceeded");
  }
});

test("pending migration is bounded, and unavailable/malformed API responses cannot mean success", async () => {
  let time = 0;
  const result = await waitForMigration(() => response({ status: { active: 1 } }), job, {
    timeoutMs: 5000, now: () => time, pause: async ms => { time += ms; },
  });
  assert.equal(result.outcome, "timeout");
  assert.equal(time, 5000);
  for (const receipt of [
    { status: 1, stderr: "Error from server (Forbidden): private-sensitive-payload" },
    { status: null, error: { code: "ETIMEDOUT" }, stderr: "private-sensitive-payload" },
    { status: 0, stdout: "private-sensitive-payload" },
  ]) {
    const unavailable = await waitForMigration(() => receipt, job);
    assert.equal(unavailable.outcome, "unavailable");
    assert.doesNotMatch(unavailable.detail, /private-sensitive-payload/);
  }
});

test("diagnostics distinguish unscheduled, missing-image and DB failures without raw specs/logs", () => {
  const log = [
    "postgres://private-sensitive-payload",
    JSON.stringify({ event: "dataport_migration", stage: "connect", status: "started" }),
    JSON.stringify({ event: "dataport_migration", stage: "connect", status: "failed", code: "28P01", message: "private-sensitive-payload" }),
  ].join("\n");
  const report = migrationDiagnostics(args => {
    if (args[0] === "logs") return { status: 0, stdout: log };
    if (args.includes("pods")) return response({ items: [{
      spec: { env: "private-sensitive-payload" },
      status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "private-sensitive-payload" }],
        containerStatuses: [{ state: { waiting: { reason: "ErrImageNeverPull", message: "private-sensitive-payload" } } }],
      },
    }] });
    return response({ items: [
      { involvedObject: { name: `${job}-pod` }, reason: "FailedCreatePodSandBox", message: "private-sensitive-payload" },
      { involvedObject: { name: "unrelated-pod" }, reason: "FailedMount" },
    ] });
  }, job, { status: { conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded", message: "private-sensitive-payload" }] } });
  assert.equal(report.conditions[0].reason, "DeadlineExceeded");
  assert.equal(report.pods[0].schedulingReason, "Unschedulable");
  assert.equal(report.pods[0].containers[0].reason, "ErrImageNeverPull");
  assert.equal(report.migration.at(-1).code, "28P01");
  assert.deepEqual(report.warnings, ["FailedCreatePodSandBox"]);
  assert.doesNotMatch(JSON.stringify(report), /private-sensitive-payload/);
  assert.deepEqual(migrationLogSummary('null\n{"event":"dataport_migration","stage":"private-sensitive-payload","status":"failed"}'), []);
});
