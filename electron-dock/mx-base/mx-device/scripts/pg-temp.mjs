// Disposable local PostgreSQL for tests and measurements. It never touches the
// project database, Docker, or any service: initdb into a new temp directory,
// listen only on 127.0.0.1 with a random port, and delete everything on exit.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import pg from "pg";

const candidates = () => {
  const dirs = [];
  if (process.env.MX_DEVICE_PG_BIN) dirs.push(process.env.MX_DEVICE_PG_BIN);
  for (const dir of (process.env.PATH || "").split(delimiter)) dirs.push(dir);
  for (const root of ["/opt/homebrew/opt", "/usr/local/opt"])
    if (existsSync(root))
      for (const name of readdirSync(root)
        .filter((n) => /^postgresql(@\d+)?$/.test(n))
        .sort()
        .reverse())
        dirs.push(join(root, name, "bin"));
  dirs.push("/Applications/Postgres.app/Contents/Versions/latest/bin");
  if (existsSync("/usr/lib/postgresql"))
    for (const v of readdirSync("/usr/lib/postgresql").sort().reverse())
      dirs.push(join("/usr/lib/postgresql", v, "bin"));
  return dirs;
};

export function findPostgres() {
  const bin = candidates().find(
    (dir) =>
      dir && existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")),
  );
  if (!bin)
    throw Error(
      "找不到 PostgreSQL 的 initdb/postgres。请安装（例如 brew install postgresql@17），或设置 MX_DEVICE_PG_BIN=<包含 initdb 和 postgres 的目录>",
    );
  const version = spawnSync(join(bin, "postgres"), ["--version"], {
    encoding: "utf8",
  }).stdout.trim();
  return { bin, version };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function waitReady(url, child, deadline) {
  for (;;) {
    if (child.exitCode !== null)
      throw Error(`临时 PostgreSQL 启动失败（退出码 ${child.exitCode}）`);
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      await client.end().catch(() => {});
    }
  }
}

/** Starts a throwaway cluster; returns {url, version, stop}. Durability is
 * deliberately off: this is for disposable tests and relative measurements. */
export async function startTempPostgres({ maxConnections = 200, settings = {} } = {}) {
  const { bin, version } = findPostgres();
  const dir = await mkdtemp(join(tmpdir(), "mx-device-pg-"));
  const data = join(dir, "data");
  const init = spawnSync(
    join(bin, "initdb"),
    ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale", "--no-sync"],
    { encoding: "utf8" },
  );
  if (init.status) {
    await rm(dir, { recursive: true, force: true });
    throw Error(`initdb 失败：${init.stderr || init.stdout}`);
  }
  const port = await freePort();
  const conf = {
    listen_addresses: "127.0.0.1",
    port: String(port),
    unix_socket_directories: "",
    max_connections: String(maxConnections),
    fsync: "off",
    synchronous_commit: "off",
    full_page_writes: "off",
    ...settings,
  };
  const args = ["-D", data];
  for (const [k, v] of Object.entries(conf)) args.push("-c", `${k}=${v}`);
  const child = spawn(join(bin, "postgres"), args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-8000);
  });
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGINT"); // fast shutdown
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await waitReady(url, child, Date.now() + 20000);
  } catch (error) {
    await stop();
    throw Error(`${error.message}\n${log}`);
  }
  return { url, version, bin, dir, stop };
}
