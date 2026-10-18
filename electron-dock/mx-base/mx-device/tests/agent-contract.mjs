// Adapter conformance suite (plan §7.7). Every driver, SimDriver first and
// real drivers later, must pass it before a device runs on it:
// busy rejection, receipt identity, timeout is never success, honest stop
// declaration with evidence, and reset evidence. The Device Gate rules are
// checked here too, since every driver runs behind the gate.
import test from "node:test";
import assert from "node:assert/strict";
import { DeviceGate } from "../server/agent/gate.mjs";

/** A command as the center issues it (run directive). */
export function sampleCommand(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    seq: 1,
    token: 7,
    jobId: "00000000-0000-4000-8000-000000000002",
    attemptId: "00000000-0000-4000-8000-000000000003",
    deviceId: "00000000-0000-4000-8000-000000000004",
    appId: "weibo",
    code: "weibo.search",
    stepIndex: 1,
    page: 1,
    params: { keyword: "契约" },
    definition: null,
    commandVersion: undefined,
    simulationDurationMs: 20,
    ...overrides,
  };
}

export function driverContract(name, makeDriver, device) {
  test(`${name}: declares its capabilities honestly`, () => {
    const caps = makeDriver().capabilities(device);
    for (const key of ["canCancel", "canAbort", "canFence"])
      assert.equal(typeof caps[key], "boolean", key);
    assert(Array.isArray(caps.apps) && caps.apps.length);
    assert(Array.isArray(caps.commands) && caps.commands.length);
  });
  test(`${name}: busy device rejects a second command`, async () => {
    const driver = makeDriver();
    const ctx = { serial: device.serial, seq: 1, token: 7 };
    const first = driver.execute(sampleCommand(), ctx);
    await assert.rejects(
      driver.execute(sampleCommand({ id: "x", seq: 2 }), { ...ctx, seq: 2 }),
      (e) => e.code === "busy",
    );
    await first;
  });
  test(`${name}: receipts echo commandId, seq and token`, async () => {
    const driver = makeDriver();
    const receipt = await driver.execute(sampleCommand({ seq: 3 }), {
      serial: device.serial,
      seq: 3,
      token: 9,
    });
    assert.equal(receipt.commandId, sampleCommand().id);
    assert.equal(receipt.seq, 3);
    assert.equal(receipt.token, 9);
    assert.equal(receipt.stopped, true);
  });
  test(`${name}: a timed-out command never yields a receipt`, async () => {
    const driver = makeDriver({ hang: () => true });
    const abort = new AbortController();
    const run = driver.execute(sampleCommand(), {
      serial: device.serial,
      seq: 1,
      token: 7,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 60);
    await assert.rejects(run);
  });
  test(`${name}: stop and reset produce evidence`, async () => {
    const driver = makeDriver();
    const caps = driver.capabilities(device);
    if (caps.canCancel) {
      const evidence = await driver.stop({ serial: device.serial });
      assert.equal(evidence.safePoint, true);
    } else assert.equal(driver.stop, undefined);
    const reset = await driver.reset({ serial: device.serial }, "weibo");
    assert.equal(reset.home, true);
  });
}

export function gateContract() {
  test("Device Gate: tokens fence leases; seq is continuous; deadlines hold", () => {
    let clock = 0;
    const gate = new DeviceGate(() => clock);
    const lease = { attemptId: "a1", token: 5, leaseMs: 1000 };
    assert.deepEqual(gate.grant("d", lease), { ok: true });
    assert.equal(gate.grant("d", lease).duplicate, true, "idempotent");
    assert.equal(
      gate.grant("d", { ...lease, attemptId: "other" }).reason,
      "stale-token",
      "same token, different lease",
    );
    assert.equal(gate.grant("d", { ...lease, token: 4 }).reason, "stale-token");
    assert.equal(gate.begin("d", { token: 4, seq: 1 }).reason, "stale-token");
    assert.equal(gate.begin("d", { token: 5, seq: 2 }).reason, "out-of-order");
    assert(gate.begin("d", { token: 5, seq: 1 }).ok);
    assert.equal(gate.begin("d", { token: 5, seq: 2 }).reason, "busy");
    // A newer token cannot replace a lease while a command runs.
    assert.equal(
      gate.grant("d", { attemptId: "a2", token: 6, leaseMs: 1000 }).reason,
      "busy",
    );
    gate.end("d", 5);
    assert.equal(gate.begin("d", { token: 5, seq: 1 }).reason, "out-of-order");
    clock = 1500;
    assert.equal(gate.begin("d", { token: 5, seq: 2 }).reason, "lease-expired");
    gate.renew("d", 5, 1000);
    assert(gate.begin("d", { token: 5, seq: 2 }).ok);
    gate.end("d", 5);
    // A newer token replaces the idle lease at once.
    assert(gate.grant("d", { attemptId: "a2", token: 6, leaseMs: 1000 }).ok);
    assert.equal(gate.begin("d", { token: 5, seq: 3 }).reason, "stale-token");
    gate.revoke("d", 6);
    assert.equal(gate.begin("d", { token: 6, seq: 1 }).reason, "lease-expired");
  });
}
