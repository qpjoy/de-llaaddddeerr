import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, lstat, chmod } from "node:fs/promises";
import { resolve } from "node:path";
const dir = resolve(".runtime");
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const names = ["postgres-password", "config.json", "api.json", "worker.json"];
const present = await Promise.all(
  names.map(async (name) => {
    try {
      if (!(await lstat(`${dir}/${name}`)).isFile())
        throw new Error(`配置必须是普通文件: ${name}`);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }),
);
if (present.some(Boolean)) {
  if (!present.every(Boolean))
    throw new Error(
      ".runtime 配置不完整；请恢复原配置备份，拒绝重新生成密码/凭证",
    );
  try {
    const password = await readFile(`${dir}/postgres-password`, "utf8");
    const [local, api, worker] = await Promise.all(
      names
        .slice(1)
        .map(async (name) =>
          JSON.parse(await readFile(`${dir}/${name}`, "utf8")),
        ),
    );
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error();
    for (const cfg of [local, api, worker]) {
      const url = new URL(cfg.databaseUrl);
      if (
        url.protocol !== "postgresql:" ||
        url.username !== "mx_device" ||
        decodeURIComponent(url.password) !== password ||
        url.pathname !== "/mx_device" ||
        url.search ||
        url.hash ||
        url.hostname !== (cfg === api ? "postgres" : "127.0.0.1") ||
        url.port !== (cfg === api ? "5432" : "18894")
      )
        throw new Error();
    }
    if (
      local.port !== 18891 ||
      api.port !== 18891 ||
      local.host !== "127.0.0.1" ||
      api.host !== "0.0.0.0" ||
      !local.workerId ||
      worker.workerId !== local.workerId ||
      api.workerId !== local.workerId ||
      !["adminToken", "testToken"].every(
        (key) =>
          typeof local[key] === "string" &&
          local[key].length >= 32 &&
          local[key] === api[key],
      ) ||
      local.adminToken === local.testToken
    )
      throw new Error();
  } catch {
    throw new Error(
      "现有配置与独立部署约定不一致；请核对原配置/密码/端口，不会覆盖或输出凭证",
    );
  }
  console.log("配置校验通过，保留现有数据库密码、管理凭证与测试凭证。");
  process.exit(0);
}
const secret = () => randomBytes(32).toString("hex"),
  password = secret(),
  adminToken = secret(),
  testToken = secret();
const base = {
  adminToken,
  testToken,
  workerId: "mx-internal-server-worker",
  secureCookies: false,
};
const databaseUrl = `postgresql://mx_device:${password}@127.0.0.1:18894/mx_device`;
// Files are individually mounted read-only; enclosing host directory is owner-only.
const save = (name, value) =>
  writeFile(
    `${dir}/${name}`,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    { mode: 0o644, flag: "wx" },
  );
await save("postgres-password", password);
await save("config.json", {
  ...base,
  databaseUrl,
  host: "127.0.0.1",
  port: 18891,
});
await save("api.json", {
  ...base,
  databaseUrl: databaseUrl.replace("127.0.0.1:18894", "postgres:5432"),
  host: "0.0.0.0",
  port: 18891,
});
await save("worker.json", { databaseUrl, workerId: base.workerId });
console.log(
  "独立配置已生成到 .runtime/；未连接手机。登录凭证使用 bash scripts/manage.sh token 查看。",
);
