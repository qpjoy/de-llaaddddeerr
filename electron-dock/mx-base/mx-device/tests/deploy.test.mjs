import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = fileURLToPath(new URL("../", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mx-device-deploy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "bin", "scratch"]) mkdirSync(join(root, dir));
  for (const name of [
    "manage.sh",
    "scripts/manage.sh",
    "scripts/setup.mjs",
    "scripts/token.mjs",
  ])
    copyFileSync(join(project, name), join(root, name));
  const executable = (name, body) =>
    writeFileSync(join(root, "bin", name), `#!${process.execPath}\n${body}`, {
      mode: 0o755,
    });
  executable("uname", `console.log("Linux")`);
  executable("flock", `process.exit(process.env.FAIL_LOCK === "1" ? 1 : 0)`);
  executable(
    "docker",
    `
const fs = require('node:fs'), cp = require('node:child_process');
const a = process.argv.slice(2), env = process.env;
fs.appendFileSync(env.CALLS, JSON.stringify({args:a, proxy:env.HTTP_PROXY || '', https:env.HTTPS_PROXY || ''})+'\\n');
if (a[0] === 'context') console.log(env.ENDPOINT || 'unix:///var/run/docker.sock');
if (a[0] === 'volume') console.log(env.VOLUMES || '');
if (a[0] === 'inspect') console.log(env.WORKER_EXIT || '0');
if (a[0] === 'compose' && a.includes('--help')) { console.log('--wait --wait-timeout'); process.exit(0); }
if (a[0] === 'compose' && a.includes('--quiet') && a.includes('worker')) console.log(env.WORKER_ID || '');
if (a[0] === 'buildx' && a[1] === 'inspect') console.log('docker');
let phase;
if (a[0] === 'buildx' && a[1] === 'build') {
  phase = 'build';
  if (env.FAIL_PHASE !== phase) fs.writeFileSync(a[a.indexOf('--iidfile')+1], 'sha256:fixture');
}
if (a[0] === 'compose' && a.includes('up')) phase = a.at(-1) === 'postgres' ? 'database' : 'rollout';
if (a[0] === 'compose' && a.includes('stop')) phase = 'drain';
if (a[0] === 'compose' && a.at(-1) === 'migrate') phase = 'migration';
if (phase && env.FAIL_PHASE === phase) process.exit(42);
if (a[0] === 'run' && a.includes('/bootstrap/setup.mjs')) {
  const r = cp.spawnSync(process.execPath, ['scripts/setup.mjs'], {cwd:env.FIXTURE, stdio:'inherit'});
  process.exit(r.status ?? 1);
}
`,
  );
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    TMPDIR: join(root, "scratch"),
    CALLS: join(root, "calls.jsonl"),
    FIXTURE: root,
    DOCKER_HOST: "",
    DOCKER_CONTEXT: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    MX_DEVICE_BUILD_PROXY: "",
  };
  return {
    root,
    run: (args = ["deploy"], extra = {}) =>
      spawnSync("bash", [join(root, "scripts/manage.sh"), ...args], {
        cwd: tmpdir(),
        env: { ...env, ...extra },
        encoding: "utf8",
      }),
    calls: () =>
      readFileSync(env.CALLS, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse),
  };
}
const isBuild = (c) => c.args[0] === "buildx" && c.args[1] === "build";
const isStop = (c) => c.args.includes("stop");
const isMigrate = (c) => c.args.at(-1) === "migrate";
const isRollout = (c) => c.args.includes("--force-recreate");

test("deploy: one command, proxy only during build, TMPDIR, migration before rollout, repeat retains credentials", (t) => {
  const f = fixture(t),
    proxy = "http://127.0.0.1:7789";
  const first = f.run(["deploy"], { MX_DEVICE_BUILD_PROXY: proxy });
  assert.equal(first.status, 0, first.stderr);
  const calls = f.calls(),
    build = calls.find(isBuild);
  assert.equal(build.proxy, proxy);
  assert.equal(build.https, proxy);
  assert.equal(build.args[build.args.indexOf("--network") + 1], "host");
  assert.equal(build.args[build.args.indexOf("--builder") + 1], "default");
  assert(
    build.args[build.args.indexOf("--iidfile") + 1].startsWith(
      join(f.root, "scratch"),
    ),
  );
  assert.deepEqual(readdirSync(join(f.root, "scratch")), []);
  assert(calls.filter((c) => !isBuild(c)).every((c) => !c.proxy && !c.https));
  assert(calls.every((c) => !c.args.join(" ").includes(proxy)));
  assert(calls.findIndex(isBuild) < calls.findIndex(isStop));
  assert(calls.findIndex(isStop) < calls.findIndex(isMigrate));
  assert(calls.findIndex(isMigrate) < calls.findIndex(isRollout));
  assert(calls.find(isRollout).args.includes("--no-deps"));
  assert.deepEqual(calls.find(isRollout).args.slice(-2), ["api", "worker"]);
  assert(
    calls.every(
      (c) =>
        !c.args.some((a) =>
          ["down", "prune", "restart", "mobile-agent"].includes(a),
        ),
    ),
  );
  const names = ["config.json", "api.json", "worker.json", "postgres-password"];
  const before = names.map((name) =>
    readFileSync(join(f.root, ".runtime", name), "utf8"),
  );
  const again = f.run(["up"], {
    VOLUMES: "mx-device_data",
    WORKER_ID: "old-worker",
  });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(
    names.map((name) => readFileSync(join(f.root, ".runtime", name), "utf8")),
    before,
  );
  const direct = f.calls().filter(isBuild).at(-1);
  assert.equal(direct.proxy, "");
  assert.equal(direct.args[direct.args.indexOf("--network") + 1], "default");
  assert(!first.stdout.includes(before[3]));
});

for (const phase of ["build", "database", "drain", "migration", "rollout"]) {
  test(`deploy fails closed at ${phase}; no later stage/false success`, (t) => {
    const f = fixture(t),
      result = f.run(["deploy"], { FAIL_PHASE: phase });
    assert.notEqual(result.status, 0);
    assert(!result.stdout.includes("部署完成"));
    const calls = f.calls();
    if (phase === "build" || phase === "database") assert(!calls.some(isStop));
    if (phase === "drain") assert(!calls.some(isMigrate));
    if (phase !== "rollout") assert(!calls.some(isRollout));
    if (phase === "migration") assert(calls.some(isMigrate));
    if (phase === "rollout") assert(calls.some(isRollout));
    assert.deepEqual(readdirSync(join(f.root, "scratch")), []);
  });
}

test("retained database without credentials refuses bootstrap/build", (t) => {
  const f = fixture(t),
    r = f.run(["deploy"], { VOLUMES: "other\nmx-device_data" });
  assert.notEqual(r.status, 0);
  assert(!f.calls().some(isBuild));
  assert(!f.calls().some((c) => c.args[0] === "run"));
});

test("partial configuration is never overwritten", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".runtime"));
  const path = join(f.root, ".runtime", "postgres-password");
  writeFileSync(path, "retained-password");
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(path, "utf8"), "retained-password");
  assert(!f.calls().some(isStop));
});

test("complete but mismatched configuration fails before stopping the worker", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["init"]).status, 0);
  const path = join(f.root, ".runtime", "worker.json");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg.databaseUrl = "postgresql://mx_device:wrong@127.0.0.1:18894/mx_device";
  const changed = JSON.stringify(cfg);
  writeFileSync(path, changed);
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(path, "utf8"), changed);
  assert(!f.calls().some(isStop));
});

test("an unclean worker exit blocks migrations and restart", (t) => {
  const f = fixture(t),
    r = f.run(["deploy"], { WORKER_ID: "old-worker", WORKER_EXIT: "137" });
  assert.notEqual(r.status, 0);
  assert(f.calls().some(isStop));
  assert(!f.calls().some(isMigrate));
  assert(!f.calls().some(isRollout));
});

for (const extra of [
  { ENDPOINT: "ssh://other-server" },
  { DOCKER_HOST: "tcp://other:2375" },
  { FAIL_LOCK: "1" },
  { MX_DEVICE_BUILD_PROXY: "http://bad\nproxy" },
]) {
  test(`reject unsafe deployment input: ${Object.keys(extra)[0]}`, (t) => {
    const f = fixture(t);
    assert.notEqual(f.run(["deploy"], extra).status, 0);
    assert(!f.calls().some(isBuild));
    assert(!f.calls().some(isStop));
  });
}
