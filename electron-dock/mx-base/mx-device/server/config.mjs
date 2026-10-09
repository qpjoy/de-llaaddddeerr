import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export async function config(requireAuth = true) {
  const path = resolve(process.env.MX_DEVICE_CONFIG || ".runtime/config.json");
  let cfg;
  try {
    cfg = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw Error(`缺少设备中心配置：${path}；先运行 npm run init`);
  }
  if (
    !cfg.databaseUrl ||
    (requireAuth &&
      (!(cfg.adminToken?.length >= 32) || !(cfg.testToken?.length >= 32)))
  )
    throw Error("配置不完整；拒绝以弱凭证启动");
  return { host: "127.0.0.1", port: 18891, workerId: "local-worker", ...cfg };
}
