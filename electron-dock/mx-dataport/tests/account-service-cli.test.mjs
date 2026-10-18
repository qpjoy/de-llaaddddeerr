import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dataport-account-ops-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "secrets"));
  writeFileSync(
    join(root, "secrets/operations.json"),
    JSON.stringify({
      context: "test",
      clusterUid: "fixture-cluster",
      node: "fixture-node",
      hubAdminOrigin:
        "http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151",
    }),
  );
  writeFileSync(
    join(root, "bin/kubectl"),
    `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),args=process.argv.slice(2),root=process.env.QA_ACCOUNT_ROOT,input=fs.readFileSync(0,'utf8');
fs.appendFileSync(p.join(root,'calls'),JSON.stringify({args,input})+'\\n');
const ns=args[3],a=args.slice(4),file=p.join(root,ns+'.json'),out=x=>process.stdout.write(JSON.stringify(x));
if(a[0]==='get'&&a[1]==='namespace')out({metadata:{uid:'fixture-cluster'}});
else if(a[0]==='get'&&a[1]==='node')out({metadata:{labels:{'kubernetes.io/hostname':${JSON.stringify(hostname())}}},status:{conditions:[{type:'Ready',status:'True'}]}});
else if(a[0]==='get'&&a[1]==='secret'){if(fs.existsSync(file))process.stdout.write(fs.readFileSync(file));}
else if(a[0]==='get'&&a[1]==='deployment')out({spec:{template:{spec:{containers:[{name:ns==='mx-insight-hub'?'admin':'internal-api',env:process.env.QA_ACCOUNT_CUSTOM?[{name:'MX_DATAPORT_ACCOUNT_TOKEN_FILE',value:'/custom/retained-token'}]:[]}]}}}});
else if(a[0]==='create'&&a[1]==='configmap')out({metadata:{uid:'owned-lock'}});
else if(a[0]==='create'&&a[1]==='-f'){
 if(ns==='mx-insight-hub'&&process.env.QA_ACCOUNT_FAIL_HUB){process.stderr.write(input);process.exit(1);}
 fs.writeFileSync(file,input,{flag:'wx'});
}
else if(a[0]==='exec')out(['auth','hub'].includes(a.at(-1))?{standard:!process.env.QA_ACCOUNT_RUNTIME_CUSTOM}:{records:Number(process.env.QA_ACCOUNT_RECORDS||0),credentialFilesPresent:!!process.env.QA_ACCOUNT_FILES});
else if(a[0]==='delete'){if(JSON.parse(input).preconditions.uid!=='owned-lock')process.exit(2);}
else process.exit(3);
`,
    { mode: 0o700 },
  );
  return {
    run(args, extra = {}) {
      return spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/account-service.mjs", import.meta.url),
          ),
          ...args,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            MX_HARBOR_KUBE_CONTEXT: "test",
            MX_HARBOR_NODE: "fixture-node",
            MX_HARBOR_HUB_ADMIN_ORIGIN:
              "http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151",
            QA_ACCOUNT_ROOT: root,
            PATH: join(root, "bin") + ":" + process.env.PATH,
            ...extra,
          },
          encoding: "utf8",
        },
      );
    },
    calls() {
      return existsSync(join(root, "calls"))
        ? readFileSync(join(root, "calls"), "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse)
        : [];
    },
    auth() {
      return readFileSync(join(root, "mx-internal-shadow.json"), "utf8");
    },
    hub() {
      return readFileSync(join(root, "mx-insight-hub.json"), "utf8");
    },
  };
}
test("account setup CLI is read-only by default, initializes once, and never outputs credentials", (t) => {
  const f = fixture(t),
    status = f.run([]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(f.calls().every((c) => c.args[4] === "get"));
  const absent = f.run(["configure"]);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /First install/);
  const first = f.run(["configure", "--initialize"]);
  assert.equal(first.status, 0, first.stderr);
  const auth = f.auth(),
    hub = f.hub();
  assert.doesNotMatch(
    first.stdout + first.stderr,
    new RegExp(JSON.parse(auth).data["account-token"]),
  );
  const before = f.calls().length,
    repeat = f.run(["configure", "--initialize"]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(f.auth(), auth);
  assert.equal(f.hub(), hub);
  assert.ok(
    !f
      .calls()
      .slice(before)
      .some(
        (c) =>
          (c.args[4] === "exec" && c.input.includes("BEGIN READ ONLY")) ||
          (c.args[4] === "create" && c.args[5] === "-f"),
      ),
  );
});
test("partial Hub provisioning recovers using the original Auth encryption key without leaking failed manifests", (t) => {
  const f = fixture(t),
    first = f.run(["configure", "--initialize"], { QA_ACCOUNT_FAIL_HUB: "1" });
  assert.notEqual(first.status, 0);
  const auth = f.auth();
  assert.doesNotMatch(first.stderr, /account-token|credential-key|apiVersion/);
  const recovery = f.run(["configure"]);
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(f.auth(), auth);
  assert.equal(JSON.parse(f.hub()).data["credential-key"], undefined);
});
test("prior account records/files and custom credential sources block first-key creation", (t) => {
  for (const flags of [
    { QA_ACCOUNT_RECORDS: "1" },
    { QA_ACCOUNT_FILES: "1" },
    { QA_ACCOUNT_CUSTOM: "1" },
    { QA_ACCOUNT_RUNTIME_CUSTOM: "1" },
  ]) {
    const f = fixture(t),
      result = f.run(["configure", "--initialize"], flags);
    assert.notEqual(result.status, 0);
    assert.ok(
      !f.calls().some((c) => c.args[4] === "create" && c.args[5] === "-f"),
    );
  }
});
