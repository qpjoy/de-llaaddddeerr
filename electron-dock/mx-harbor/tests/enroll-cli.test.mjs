import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { commandFailure } from "../scripts/enroll.mjs";

const sensitive = "DO-NOT-PRINT-SECRET-PAYLOAD";
test("enroll reports allowlisted subprocess errors without echoing credentials", () => {
  for (const [stderr, expected] of [
    [
      'error: failed to create configmap: configmaps "mx-harbor-deploy-lock" already exists',
      /AlreadyExists/,
    ],
    ["Error from server (Forbidden):", /Forbidden/],
    ["Error from server (Conflict):", /Conflict/],
    ["Error from server (NotFound):", /NotFound/],
    ["Error from server (Invalid):", /Invalid/],
    ["You must be logged in to the server (Unauthorized)", /Unauthorized/],
    ['error: context "retained-context" does not exist', /kubeconfig/],
    ["x509: certificate has expired", /TLS/],
    [
      "The connection to the server was refused: connection refused",
      /无法连接/,
    ],
    ["unexpected failure", /原因未识别/],
  ]) {
    const error = commandFailure("kubectl", {
      status: 1,
      stderr: `${stderr}\n${sensitive}`,
      stdout: sensitive,
    });
    assert.match(error.message, expected);
    assert.match(error.message, /exit=1/);
    assert.ok(!error.message.includes(sensitive));
    assert.ok(!error.message.includes("retained-context"));
  }
  assert.match(
    commandFailure("kubectl", {
      status: null,
      error: { code: "ENOENT", message: sensitive },
    }).message,
    /命令不存在/,
  );
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "harbor-enroll-cli-"));
  const dir = join(root, "mx-harbor");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "scripts/manage.sh",
    "scripts/enroll.mjs",
    "scripts/recover-lock.mjs",
    "scripts/bootstrap.mjs",
    "apps/server/config.mjs",
    "../mx-common/src/identity/profile.mjs",
  ]) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), target);
  }
  mkdirSync(join(dir, "secrets"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "secrets/operations.json"),
    JSON.stringify({
      context: "retained-context",
      clusterUid: "retained-cluster",
      node: "retained-node",
      hubAdminOrigin: "http://hub.internal:18151",
    }),
  );
  writeFileSync(
    join(dir, "bin/kubectl"),
    `#!${process.execPath}
const fs = require('node:fs'), os = require('node:os');
const args = process.argv.slice(2), a = args.slice(4), key = a.slice(0,3).join(' '), dir = process.env.HARBOR_ENROLL_TEST_DIR;
const out = value => process.stdout.write(JSON.stringify(value));
const fail = message => {process.stdout.write(${JSON.stringify(sensitive)}); process.stderr.write(message + '\\n' + ${JSON.stringify(sensitive)}); process.exit(1)};
fs.appendFileSync(dir+'/calls', JSON.stringify(args)+'\\n');
if (key === 'get namespace kube-system') {
  if(process.env.HARBOR_ENROLL_TEST_FAILURE === 'cluster') fail('error: context "retained-context" does not exist');
  out({metadata:{uid:'retained-cluster'}});
} else if (key === 'get node retained-node') out({metadata:{labels:{'kubernetes.io/hostname':os.hostname()}}});
else if (key === 'get configmap mx-harbor-deploy-lock') { if(!fs.existsSync(dir+'/removed')) out({metadata:{uid:'our-lock-uid',resourceVersion:'42'},data:{action:'deploy'}}); }
else if (a[0] === 'get' && ['jobs','pods'].includes(a[1])) out({items:[]});
else if (key === 'create configmap mx-harbor-deploy-lock') {
  if(process.env.HARBOR_ENROLL_TEST_FAILURE === 'lock') fail('error: failed to create configmap: configmaps "mx-harbor-deploy-lock" already exists');
  out({metadata:{uid:'our-lock-uid'}});
} else if (key === 'get secret mx-harbor-runtime') out({data:{MX_HARBOR_DATABASE_URL:Buffer.from('retained-db').toString('base64')}});
else if (key === 'get secret mx-harbor-portal') {}
else if (key === 'get secret mx-insight-hub-browser-sso') {
  if(process.env.HARBOR_ENROLL_TEST_FAILURE === 'parse') {process.stdout.write(${JSON.stringify(sensitive)});process.exit(0)}
  fail('Error from server (Forbidden): secrets "mx-insight-hub-browser-sso" is forbidden');
} else if (a[0] === 'delete' && a[1] === '--raw') {
  const file = a[a.indexOf('-f')+1];
  fs.writeFileSync(dir+'/unlock', fs.readFileSync(file));
  fs.writeFileSync(dir+'/temp-path', require('node:path').dirname(file));
  if(process.env.HARBOR_ENROLL_TEST_UNLOCK_FAILURE) fail('Error from server (Conflict): UID precondition failed');
  fs.writeFileSync(dir+'/removed','true');
} else fail('unexpected command');
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "bin/ps"),
    `#!${process.execPath}\nprocess.exit(0);\n`,
    { mode: 0o755 },
  );
  return {
    dir,
    run: (failure, unlockFailure = false, actionArgs = ["enroll"]) =>
      spawnSync(
        "/bin/bash",
        [
          join(dir, "scripts/manage.sh"),
          "ops",
          "internal-production",
          ...actionArgs,
        ],
        {
          // manage.sh must work even when launched outside the application directory.
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(dir, "bin")}:${process.env.PATH}`,
            NODE_OPTIONS: "",
            MX_HARBOR_KUBE_CONTEXT: "",
            MX_HARBOR_NODE: "",
            MX_HARBOR_HUB_ADMIN_ORIGIN: "",
            HARBOR_ENROLL_TEST_DIR: dir,
            HARBOR_ENROLL_TEST_FAILURE: failure,
            HARBOR_ENROLL_TEST_UNLOCK_FAILURE: unlockFailure ? "1" : "",
          },
        },
      ),
    calls: () =>
      readFileSync(join(dir, "calls"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse),
  };
}

function assertSafeFailure(result, pattern) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, pattern);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(sensitive));
  assert.ok(!result.stdout.includes("接入配置已同步"));
}
test("enroll identifies kubeconfig failure before acquiring a lock or changing Secrets", (t) => {
  const f = fixture(t);
  assertSafeFailure(f.run("cluster"), /核对集群 kube-system UID.*kubeconfig/);
  assert.equal(f.calls().length, 1);
});
test("enroll identifies an existing deployment lock and never deletes another task's lock", (t) => {
  const f = fixture(t);
  assertSafeFailure(f.run("lock"), /获取 Harbor 部署锁.*AlreadyExists/);
  assert.equal(f.calls().length, 3);
  assert.ok(
    f.calls()[2].some((arg) => arg.startsWith("--from-literal=ownerHost=")),
  );
  assert.ok(
    f.calls()[2].some((arg) => /^--from-literal=ownerPid=\d+$/.test(arg)),
  );
  assert.equal(existsSync(join(f.dir, "unlock")), false);
});

test("recover-lock CLI defaults to inspection and only explicit recovery removes the checked lock", (t) => {
  const f = fixture(t);
  const check = f.run("recovery", false, ["recover-lock"]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /只读检查通过/);
  assert.ok(f.calls().every((args) => args[4] === "get"));
  assert.equal(existsSync(join(f.dir, "unlock")), false);
  const recovered = f.run("recovery", false, [
    "recover-lock",
    "--confirm-idle",
  ]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /遗留部署锁已释放/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.dir, "unlock"))).preconditions,
    { uid: "our-lock-uid", resourceVersion: "42" },
  );
  assert.equal(
    existsSync(readFileSync(join(f.dir, "temp-path"), "utf8")),
    false,
  );
});
test("recover-lock CLI does not mutate a cluster it cannot verify", (t) => {
  const f = fixture(t);
  const result = f.run("cluster", false, ["recover-lock", "--confirm-idle"]);
  assertSafeFailure(result, /kubeconfig/);
  assert.equal(f.calls().length, 1);
  assert.equal(existsSync(join(f.dir, "unlock")), false);
});
test("enroll names the denied Hub Secret and releases only its own lock", (t) => {
  const f = fixture(t);
  assertSafeFailure(
    f.run("hub"),
    /读取 Secret mx-insight-hub\/mx-insight-hub-browser-sso.*Forbidden/,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "unlock"))), {
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid: "our-lock-uid" },
  });
  assert.equal(
    existsSync(readFileSync(join(f.dir, "temp-path"), "utf8")),
    false,
  );
  for (const args of f.calls()) {
    assert.deepEqual(args.slice(0, 2), ["--context", "retained-context"]);
    assert.ok(args.includes("--request-timeout=15s"));
  }
});
test("enroll preserves the first failure when lock release also fails", (t) => {
  const f = fixture(t);
  const result = f.run("hub", true);
  assertSafeFailure(
    result,
    /读取 Secret mx-insight-hub\/mx-insight-hub-browser-sso.*Forbidden/,
  );
  assert.match(result.stderr, /释放 Harbor 部署锁.*Conflict/);
  assert.match(result.stderr, /解锁未确认/);
  assert.equal(
    existsSync(readFileSync(join(f.dir, "temp-path"), "utf8")),
    false,
  );
  assert.equal(f.calls().filter((args) => args.includes("delete")).length, 1);
});
test("enroll hides malformed JSON while retaining the failed resource and cleaning up", (t) => {
  const f = fixture(t);
  assertSafeFailure(
    f.run("parse"),
    /读取 Secret mx-insight-hub\/mx-insight-hub-browser-sso.*配置无法解析/,
  );
  assert.equal(
    existsSync(readFileSync(join(f.dir, "temp-path"), "utf8")),
    false,
  );
});
