import test from "node:test";
import assert from "node:assert/strict";
import {
  POOL_SCENARIOS,
  runPoolSimulation,
  simulationOptions,
} from "../server/pool-simulator.mjs";
import {
  calibratedDuration,
  recordCommandTiming,
} from "../server/command-timing.mjs";
import { commandByCode } from "../server/workflow-catalog.mjs";

function assertAccounting(summary, deviceCount) {
  assert.equal(
    summary.completed + summary.failed + summary.queued,
    summary.submitted,
    "every admitted job must remain accounted for",
  );
  assert.equal(summary.invariantViolations, 0);
  assert.equal(summary.realTransportCalls, 0);
  assert(summary.peakConcurrency <= deviceCount);
  assert(summary.utilization >= 0 && summary.utilization <= 1);
  assert(summary.waitP50Ms <= summary.waitP95Ms);
  assert(summary.waitP95Ms <= summary.waitP99Ms);
  assert(summary.waitP99Ms <= summary.maxWaitMs);
  assert(summary.makespanMs <= 600001, "virtual time must be bounded");
}

function assertSerialSessions(timeline) {
  const active = new Map();
  let lastAt = -1;
  for (const event of timeline) {
    assert(event.at >= lastAt, "event time must never move backwards");
    lastAt = event.at;
    if (event.type === "started") {
      assert(
        !active.has(event.deviceId),
        `${event.deviceId} already owns a session`,
      );
      active.set(event.deviceId, event.jobId);
    } else if (["completed", "quarantine"].includes(event.type)) {
      assert.equal(active.get(event.deviceId), event.jobId);
      active.delete(event.deviceId);
    }
  }
  // Events are bounded to 1200; a truncated ledger can retain open sessions.
  if (timeline.length < 1200) assert.equal(active.size, 0);
}

test("a seed reproduces strategy and baseline metrics, decisions and device loads", () => {
  const options = { scenario: "mixed", deviceCount: 10, seed: 107 };
  const before = structuredClone(options);
  const first = runPoolSimulation(options);
  const second = runPoolSimulation(options);
  assert.deepEqual(options, before, "request data is not mutated");
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.baseline, second.baseline);
  assert.deepEqual(first.timeline, second.timeline);
  assert.deepEqual(first.devices, second.devices);
  assert.deepEqual(first.remaining, second.remaining);
  const different = runPoolSimulation({ ...options, seed: 108 });
  assert.notDeepEqual(first.summary, different.summary);
});

test("every default scenario preserves task accounting on two and ten devices", async (t) => {
  for (const deviceCount of [2, 10]) {
    for (const scenario of POOL_SCENARIOS) {
      await t.test(`${scenario.id} / ${deviceCount} devices`, () => {
        const report = runPoolSimulation({
          scenario: scenario.id,
          deviceCount,
          seed: 42,
        });
        assert.equal(report.simulated, true);
        assert.equal(report.summary.submitted, Math.max(24, deviceCount * 4));
        assert.equal(report.devices.length, deviceCount);
        assertAccounting(report.summary, deviceCount);
        assertAccounting(report.baseline, deviceCount);
        assertSerialSessions(report.timeline);
        assert.equal(report.summary.failed, scenario.id === "failure" ? 1 : 0);
        assert.equal(report.baseline.failed, scenario.id === "failure" ? 1 : 0);
        assert.equal(report.remaining.length, report.summary.queued);
        assert.equal(
          report.devices.reduce((n, device) => n + device.completed, 0),
          report.summary.completed,
        );
        if (scenario.id === "failure") {
          assert.equal(
            report.devices.filter((d) => d.state === "quarantined").length,
            1,
          );
          const lost = report.timeline.find(
            (event) => event.type === "quarantine",
          );
          assert(lost);
          assert.equal(
            report.timeline.filter(
              (event) => event.type === "started" && event.jobId === lost.jobId,
            ).length,
            1,
            "ambiguous work must not be retried",
          );
          assert(
            !report.timeline.some(
              (event) =>
                event.type === "completed" && event.jobId === lost.jobId,
            ),
          );
        }
        assert.equal(report.summary.queued, 0);
        assert.equal(report.baseline.queued, 0);
        for (const job of report.remaining) {
          assert.equal(job.status, "queued");
          assert(
            job.blockers.length > 0,
            "unfinished job must expose an actionable reason",
          );
        }
      });
    }
  }
});

test("scaling to one hundred devices keeps each phone serial and drains bounded workload", () => {
  const report = runPoolSimulation({
    scenario: "scale",
    deviceCount: 100,
    seed: 42,
  });
  assert.equal(report.devices.length, 100);
  assert.equal(report.summary.submitted, 160);
  assert.equal(report.summary.completed, 160);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.queued, 0);
  assertAccounting(report.summary, 100);
  assertAccounting(report.baseline, 100);
  assertSerialSessions(report.timeline);
  const expansion = report.timeline.find((event) => event.type === "scale");
  assert.equal(expansion.at, 8000);
  const initialNames = new Set(["设备 001", "设备 002"]);
  assert(
    report.timeline
      .filter((event) => event.type === "started" && event.at < 8000)
      .every((event) => initialNames.has(event.deviceId)),
  );
});

test("simulation runs without fetch and keeps impossible budgets explicitly queued", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () =>
    assert.fail("virtual simulation must never call fetch"),
  );
  const report = runPoolSimulation({
    scenario: "mixed",
    deviceCount: 2,
    seed: 42,
    policy: { appDefaults: { maxServiceMs: 200 } },
  });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(report.summary.submitted, 24);
  assert.equal(report.summary.completed, 0);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.queued, 24);
  assert(
    report.remaining.every((job) =>
      job.blockers.some((reason) => reason.code === "app-service-budget"),
    ),
  );
  assertAccounting(report.summary, 2);
});

test("invalid benchmark inputs fail before executing a workload", () => {
  for (const input of [
    null,
    [],
    { scenario: "unknown" },
    { deviceCount: 3 },
    { deviceCount: "10" },
    { seed: -1 },
    { seed: 1.2 },
    { seed: 2147483648 },
    { policy: { enabled: false } },
    { policy: { idleSpreadThresholdPct: 101 } },
    { policy: { strategy: "random" } },
    { policy: { appPolicies: { xhs: { maxRuns: 0 } } } },
  ]) {
    assert.throws(
      () => simulationOptions(input),
      (error) => error.status === 400,
    );
  }
});

test("command timing needs three observations, isolates definition versions and bounds history", () => {
  const device = { mode: "sim" };
  const code = "xhs.note.detail";
  const command = { definitionId: "sim:xhs.detail:1", code, createdAt: 1000 };
  const job = {
    workflow: { definitionId: command.definitionId, plan: [{ code }] },
  };
  const expected = commandByCode(code).estimateMs;
  recordCommandTiming(device, command, 2000);
  recordCommandTiming(device, command, 3000);
  assert.equal(calibratedDuration(device, job), expected);
  recordCommandTiming(device, command, 4000);
  assert.equal(calibratedDuration(device, job), 3000);
  assert.equal(
    calibratedDuration(device, {
      workflow: { ...job.workflow, definitionId: "sim:xhs.detail:2" },
    }),
    expected,
  );
  for (let n = 0; n < 40; n++) recordCommandTiming(device, command, 1500 + n);
  assert.equal(
    device.commandTimings[`${command.definitionId}/${code}`].samples.length,
    32,
  );
  assert.equal(
    device.commandTimings[`${command.definitionId}/${code}`].count,
    43,
  );
  for (let n = 0; n < 140; n++)
    recordCommandTiming(
      device,
      { ...command, definitionId: `custom-${n}`, createdAt: 10000 + n },
      11000 + n,
    );
  assert.equal(Object.keys(device.commandTimings).length, 128);
  assert(!device.commandTimings[`${command.definitionId}/${code}`]);
});

test("real, restore and invalid timing observations cannot train the simulator", () => {
  const command = {
    definitionId: "sim:xhs.detail:1",
    code: "xhs.note.detail",
    createdAt: 1000,
  };
  const real = { mode: "real" };
  recordCommandTiming(real, command, 2000);
  assert.equal(real.commandTimings, undefined);
  const simulated = { mode: "sim" };
  recordCommandTiming(simulated, { ...command, restoring: true }, 2000);
  for (const end of [999, 1000, Infinity, NaN, 181001])
    recordCommandTiming(simulated, command, end);
  assert.equal(simulated.commandTimings, undefined);
});
