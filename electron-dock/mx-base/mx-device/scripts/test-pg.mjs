// npm run test:pg [-- tests/x.test.mjs ...]
// Runs the suite against a disposable local PostgreSQL so PG-backed tests run
// instead of being skipped. Fails (does not skip) when PostgreSQL is missing.
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { startTempPostgres } from "./pg-temp.mjs";

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (await readdir("tests"))
      .filter((f) => f.endsWith(".test.mjs"))
      .sort()
      .map((f) => `tests/${f}`);

let db;
try {
  db = await startTempPostgres();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
console.log(`临时 PostgreSQL：${db.version}（${db.bin}），测试结束后删除`);
const stopAndExit = async (code) => {
  await db.stop();
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void stopAndExit(130));
const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, MX_DEVICE_TEST_DATABASE_URL: db.url },
});
child.once(
  "exit",
  (code, signal) => void stopAndExit(code ?? (signal ? 1 : 0)),
);
