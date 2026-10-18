// npm run agent:sim -- [config path]
// Runs a simulated host Agent against a device center. Config (JSON, default
// .runtime/agent.json): { center, token, devices: [{ serial, apps? }], speed? }.
// The token is read from the file or MX_DEVICE_AGENT_TOKEN, never printed.
// Simulation only: no phone, ADB, PoC, Docker or VPN is touched.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HostAgent } from "./host-agent.mjs";
import { SimDriver } from "./sim-driver.mjs";

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
const agent = new HostAgent({
  center: cfg.center,
  token,
  devices: cfg.devices,
  driver: new SimDriver({ speed: cfg.speed ?? 1 }),
  log: (message) => console.log(`[agent] ${message}`),
});
await agent.start();
console.log(
  `模拟宿主机 Agent 已连接 ${cfg.center}：${cfg.devices.length} 台模拟设备${agent.pending?.length ? `，${agent.pending.length} 台待登记` : ""}`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await agent.stop();
    process.exit(0);
  });
