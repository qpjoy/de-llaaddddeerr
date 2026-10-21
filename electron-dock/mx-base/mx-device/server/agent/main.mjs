// npm run agent:sim -- [config path]
// Runs a host Agent against a device center. Config (JSON, default
// .runtime/agent.json): { center, token, driver?: "sim" | "poc",
//   devices: [{ serial, apps?, pocOrigin? }], speed? }.
// driver "sim" (default) touches no phone. driver "poc" calls each phone's
// PoC at its pocOrigin (host-local, e.g. http://127.0.0.1:18081) and nothing
// else; it must run on the host next to the PoC, never on the center. Which
// realm it serves comes from the center (the Agent's registration): a
// simulation Agent drives only PoC simulators, a real one never one.
// The token is read from the file or MX_DEVICE_AGENT_TOKEN, never printed.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HostAgent } from "./host-agent.mjs";
import { SimDriver } from "./sim-driver.mjs";
import { PocDriver } from "./poc-driver.mjs";

const path = resolve(process.argv[2] || ".runtime/agent.json");
let cfg;
try {
  cfg = JSON.parse(await readFile(path, "utf8"));
} catch {
  throw Error(`缺少 Agent 配置：${path}`);
}
const token = process.env.MX_DEVICE_AGENT_TOKEN || cfg.token;
if (!cfg.center || !token || !Array.isArray(cfg.devices) || !cfg.devices.length)
  throw Error("Agent 配置需要 center、token 和 devices");
const poc = cfg.driver === "poc";
if (poc)
  for (const d of cfg.devices) {
    let url = null;
    try {
      url = new URL(d.pocOrigin);
    } catch {}
    // The PoC is reached on this host only (no public PoC port).
    if (
      !url ||
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search
    )
      throw Error(
        `设备 ${d.serial} 的 pocOrigin 须为本机地址，如 http://127.0.0.1:18081`,
      );
  }
const agent = new HostAgent({
  center: cfg.center,
  token,
  devices: cfg.devices,
  driver: poc
    ? new PocDriver({
        origins: Object.fromEntries(
          cfg.devices.map((d) => [d.serial, new URL(d.pocOrigin).origin]),
        ),
      })
    : new SimDriver({ speed: cfg.speed ?? 1 }),
  version: poc ? "poc-agent/1" : "sim-agent/1",
  log: (message) => console.log(`[agent] ${message}`),
});
await agent.start();
console.log(
  `${poc ? "PoC" : "模拟"}宿主机 Agent 已连接 ${cfg.center}：${cfg.devices.length} 台设备${agent.pending?.length ? `，${agent.pending.length} 台待登记` : ""}`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await agent.stop();
    process.exit(0);
  });
