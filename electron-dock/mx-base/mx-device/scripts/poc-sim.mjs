// npm run poc:sim -- [--port 18181] [--count 2] [--delay 600]
// Local stand-ins for the XHS PoC, one per phone, on consecutive ports of
// 127.0.0.1 (same HTTP contract as the real PoC; synthetic data). Point an
// Agent at them with driver "poc" to try a PoC-driven rack without a phone.
import { PocSimulator } from "../server/agent/poc-sim.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", "18181"));
const count = Number(arg("count", "2"));
const delayMs = Number(arg("delay", "600"));
const servers = [];
for (let i = 0; i < count; i++) {
  const sim = new PocSimulator({ delayMs, name: `poc-sim-${i + 1}` });
  servers.push(await sim.listen(port + i));
  console.log(`模拟 PoC ${i + 1}：http://127.0.0.1:${port + i}`);
}
console.log("仅模拟数据；不连接手机。Ctrl+C 结束。");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    for (const s of servers) s.close();
    process.exit(0);
  });
