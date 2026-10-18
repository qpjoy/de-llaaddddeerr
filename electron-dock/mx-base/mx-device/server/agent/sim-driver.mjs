// SimDriver: the Driver SPI (plan §7.4) over the synthetic simulator. No
// phone, ADB, PoC or network. Fault hooks make the contract tests possible.
import { setTimeout as sleep } from "node:timers/promises";
import { simulateCommand } from "../workflows.mjs";
import { COMMANDS } from "../workflow-catalog.mjs";

export class SimDriver {
  /** speed scales simulated command time; faults: { hang(cmd), mismatch(cmd),
   * signal(cmd) -> kind | null } decide misbehaviour per command. */
  constructor({ speed = 1, faults = {} } = {}) {
    this.kind = "sim";
    this.speed = speed;
    this.faults = faults;
    this.busy = new Set();
    this.foreground = new Map();
  }
  capabilities(device) {
    return {
      apps: device.apps || ["xhs", "weibo", "xianyu", "pdd"],
      commands: device.commands || COMMANDS.map((c) => c.code),
      canCancel: true, // stops between commands (safe points)
      canAbort: false, // a command in flight is never interrupted
      canFence: true,
    };
  }
  async probe(device) {
    return {
      reachable: true,
      idle: !this.busy.has(device.serial),
      foreground: this.foreground.get(device.serial) || null,
    };
  }
  /** Runs one command; the receipt echoes commandId, seq and token. */
  async execute(cmd, { serial, seq, token, signal }) {
    if (this.busy.has(serial))
      throw Object.assign(new Error("设备忙"), { code: "busy" });
    this.busy.add(serial);
    try {
      await sleep(
        Math.max(1, Math.round((cmd.simulationDurationMs || 300) * this.speed)),
        undefined,
        { signal },
      );
      if (this.faults.hang?.(cmd)) await sleep(3600000, undefined, { signal });
      const receipt = { ...simulateCommand(cmd), seq, token };
      if (this.faults.mismatch?.(cmd))
        receipt.result = { ...receipt.result, keyword: "外部插入的关键词" };
      if (cmd.definition?.action === "open")
        this.foreground.set(serial, cmd.appId);
      const kind = this.faults.signal?.(cmd);
      return kind ? { ...receipt, signal: kind } : receipt;
    } finally {
      this.busy.delete(serial);
    }
  }
  /** Stop at a safe point: nothing is in flight between commands. */
  async stop({ serial }) {
    return { safePoint: !this.busy.has(serial), at: Date.now() };
  }
  async reset({ serial }, appId) {
    this.foreground.delete(serial);
    return { home: true, appId: appId || null };
  }
}
