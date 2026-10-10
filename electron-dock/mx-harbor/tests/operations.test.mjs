import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
function fixture(t, { fresh = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "harbor-ops-test-")),
    dir = join(root, "mx-harbor");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Execute copied sources, not the repository script: a fresh checkout has no node_modules.
  for (const path of [
    "scripts/manage.sh",
    "scripts/operations.mjs",
    "deploy/k8s/render.mjs",
    "apps/server/config.mjs",
  ]) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(new URL(`../${path}`, import.meta.url), target);
  }
  const sharedProfile = join(root, "mx-common/src/identity/profile.mjs");
  mkdirSync(dirname(sharedProfile), { recursive: true });
  copyFileSync(
    new URL("../../mx-common/src/identity/profile.mjs", import.meta.url),
    sharedProfile,
  );
  mkdirSync(join(dir, "secrets"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "secrets/operations.json"),
    JSON.stringify({
      context: "test-context",
      clusterUid: "fixture-cluster",
      node: "configured-node-name",
      hubAdminOrigin: "http://hub.internal:18151",
    }),
  );
  mkdirSync(join(dir, "secrets/identity"));
  const profile = {
    origin: "https://harbor.example.test",
    issuer: "https://auth.example.test/identity",
    appId: "mx-harbor",
    clientId: "harbor",
    clientSecret: "s".repeat(43),
    audience: "mx-harbor",
    scope: "openid mx:identity",
    sessionKey: "k".repeat(43),
  };
  writeFileSync(
    join(dir, "secrets/identity/profile.json"),
    JSON.stringify(profile),
    { mode: 0o600 },
  );
  writeFileSync(join(dir, "secrets/gateway-token"), "g".repeat(43), {
    mode: 0o600,
  });
  writeFileSync(
    join(dir, "network.mjs"),
    `
import {appendFileSync} from 'node:fs';
globalThis.fetch = async url => {
  if(url !== 'http://127.0.0.1:18220/ready') throw new Error('Unexpected readiness target');
  appendFileSync(process.env.HARBOR_TEST_DIR+'/calls', JSON.stringify({cmd:'readiness',args:[url],stdin:''})+'\\n');
  return new Response('{}', {status:process.env.HARBOR_TEST_READINESS_FAILURE ? 503 : 200});
};
`,
  );
  const stub = `#!${process.execPath}
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cmd=path.basename(process.argv[1]),args=process.argv.slice(2),dir=process.env.HARBOR_TEST_DIR;
const stdin=fs.readFileSync(0,'utf8');fs.appendFileSync(dir+'/calls',JSON.stringify({cmd,args,stdin})+'\\n');
if(cmd==='kubectl'){
 if(args.includes('config')&&args.includes('view')){process.stdout.write('test-only-kubeconfig');process.exit(0)}
 const a=args.slice(4),key=a.slice(0,3).join(' '),out=x=>process.stdout.write(JSON.stringify(x));
 if(key==='get namespace kube-system')out({metadata:{uid:process.env.HARBOR_TEST_DRIFT?'wrong':'fixture-cluster'}});
 else if(a[0]==='get'&&a[1]==='node')out({metadata:{labels:{'kubernetes.io/hostname':os.hostname()}},spec:{},status:{conditions:[{type:'Ready',status:'True'}]}});
 else if(key==='get namespace mx-harbor'){if(!process.env.HARBOR_TEST_FRESH||fs.existsSync(dir+'/namespace'))out({metadata:{name:'mx-harbor'}})}
 else if(key==='create namespace mx-harbor')fs.writeFileSync(dir+'/namespace','created');
 else if(key==='create configmap mx-harbor-deploy-lock'){fs.writeFileSync(dir+'/lock','fixture-lock-uid',{flag:'wx'});out({metadata:{uid:'fixture-lock-uid'}});}
 else if(key==='get secret mx-harbor-runtime'){
  if(fs.existsSync(dir+'/runtime.json')){out(JSON.parse(fs.readFileSync(dir+'/runtime.json')));process.exit(0)}
  if(process.env.HARBOR_TEST_FRESH)process.exit(0);
  const profile={origin:'https://harbor.example.test',issuer:'https://auth.example.test/identity',appId:'mx-harbor',clientId:'harbor',clientSecret:'s'.repeat(43),audience:'mx-harbor',scope:'openid mx:identity',sessionKey:'k'.repeat(43)};
  const data={'profile.json':JSON.stringify(profile),MX_HARBOR_DATABASE_URL:'postgres://test:test@pg.internal/mx_harbor',MX_HARBOR_GATEWAY_TOKEN:'g'.repeat(43),MX_HARBOR_HUB_ADMIN_ORIGIN:'http://hub.internal:18151',MX_HARBOR_SSO_PROFILE:'/run/harbor/profile.json'};out({data:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,Buffer.from(v).toString('base64')]))});
 }
 else if(key==='get deployment mx-harbor'){if(fs.existsSync(dir+'/deployment.json'))out(JSON.parse(fs.readFileSync(dir+'/deployment.json')))}
 else if(a[0]==='apply'){const doc=JSON.parse(stdin);if(doc.kind==='Secret')fs.writeFileSync(dir+'/runtime.json',JSON.stringify({data:Object.fromEntries(Object.entries(doc.stringData).map(([k,v])=>[k,Buffer.from(v).toString('base64')]))}));if(doc.kind==='Deployment')fs.writeFileSync(dir+'/deployment.json',stdin);}
 else if(a[0]==='rollout'&&process.env.HARBOR_TEST_ROLLOUT_FAILURE)process.exit(1);
 else if(a[0]==='wait'&&process.env.HARBOR_TEST_MIGRATION_FAILURE)process.exit(1);
 else if(a[0]==='delete'&&a[1]?.startsWith('job/')&&process.env.HARBOR_TEST_DELETE_FAILURE)process.exit(1);
 else if(a[0]==='delete'&&a.includes('--raw')){if(process.env.HARBOR_TEST_UNLOCK_FAILURE)process.exit(1);const options=JSON.parse(fs.readFileSync(a.at(-1)));if(options.preconditions.uid!==fs.readFileSync(dir+'/lock','utf8'))process.exit(1);fs.unlinkSync(dir+'/lock');}
}else if(cmd==='bash'){if(args.join(' ')!=='../mx-common/scripts/manage.sh provision mx-harbor')process.exit(1);process.stdout.write('postgres://test:test@pg.internal/mx_harbor');}
else if(cmd==='docker'&&args.includes('-t'))fs.writeFileSync(dir+'/image',args[args.indexOf('-t')+1]);
else if(cmd==='ctr'&&args.includes('ls'))process.stdout.write('docker.io/library/'+fs.readFileSync(dir+'/image','utf8')+'\\n');
`;
  for (const cmd of ["kubectl", "docker", "ctr", "bash"])
    writeFileSync(join(dir, "bin", cmd), stub, { mode: 0o755 });
  const run = (action, extra = {}) =>
    spawnSync(
      "/bin/bash",
      [join(dir, "scripts/manage.sh"), "ops", "internal-production", action],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: join(dir, "bin") + ":" + process.env.PATH,
          NODE_OPTIONS: `--import=${pathToFileURL(join(dir, "network.mjs")).href}`,
          HARBOR_TEST_DIR: dir,
          HARBOR_TEST_FRESH: fresh ? "1" : "",
          MX_HARBOR_BUILD_PROXY: "",
          MX_INSIGHT_BUILD_PROXY: "",
          ...extra,
        },
      },
    );
  return {
    dir,
    run,
    calls: () =>
      existsSync(join(dir, "calls"))
        ? readFileSync(join(dir, "calls"), "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse)
        : [],
  };
}
test("plan is offline and status remains read only; cluster drift prevents mutation", (t) => {
  const f = fixture(t);
  assert.equal(existsSync(join(f.dir, "node_modules")), false);
  assert.equal(
    existsSync(join(dirname(f.dir), "mx-common/node_modules")),
    false,
  );
  const help = f.run("help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /deploy\|status/);
  assert.equal(f.run("plan").status, 0);
  assert.equal(f.calls().length, 0);
  assert.equal(f.run("status").status, 0);
  assert.ok(f.calls().every((c) => c.args.includes("get")));
  assert.notEqual(f.run("restart", { HARBOR_TEST_DRIFT: "1" }).status, 0);
  assert.ok(f.calls().every((c) => c.args.includes("get")));
});
function assertFullDeploy(calls) {
  const position = (predicate) => calls.findIndex(predicate);
  for (const predicate of [
    (c) => c.args.includes("buildx"),
    (c) => c.stdin.includes('"kind":"Job"'),
    (c) => c.args.includes("wait"),
    (c) => c.stdin.includes('"kind":"Deployment"'),
    (c) => c.args.includes("rollout"),
    (c) => c.cmd === "readiness",
  ])
    assert.ok(
      position(predicate) >= 0,
      "complete deployment stage must be present",
    );
  const documents = calls
    .filter((c) => c.args.includes("apply"))
    .map((c) => JSON.parse(c.stdin));
  assert.equal(documents.filter((d) => d.kind === "Deployment").length, 1);
  const job = documents.find((d) => d.kind === "Job"),
    app = documents.find((d) => d.kind === "Deployment");
  assert.equal(
    job.spec.template.spec.containers[0].image,
    app.spec.template.spec.containers[0].image,
  );
  assert.ok(
    position((c) => c.args.includes("buildx")) <
      position((c) => c.stdin.includes('"kind":"Job"')),
  );
  assert.ok(
    position((c) => c.args.includes("wait")) <
      position((c) => c.stdin.includes('"kind":"Deployment"')),
  );
  assert.ok(
    position((c) => c.stdin.includes('"kind":"Deployment"')) <
      position((c) => c.args.includes("rollout")),
  );
  assert.ok(
    position((c) => c.args.includes("rollout")) <
      position((c) => c.cmd === "readiness"),
  );
  assert.ok(
    !calls.some((c) => c.args.includes("restart")),
    "new immutable image restarts the Pod once without a second rollout",
  );
  assert.ok(
    calls.some(
      (c) =>
        c.args.includes("--raw") &&
        c.args.some((a) => a.endsWith("/configmaps/mx-harbor-deploy-lock")),
    ),
  );
  assert.ok(
    calls
      .filter((c) => c.cmd === "kubectl" && c.args.includes("rollout"))
      .every((c) => c.args.includes("deployment/mx-harbor")),
  );
}
test("deploy bootstraps once and repeats the full migrate/restart/readiness workflow with retained credentials", (t) => {
  const f = fixture(t, { fresh: true });
  const first = f.run("deploy");
  assert.equal(first.status, 0, first.stderr);
  const calls = f.calls();
  assertFullDeploy(calls);
  const credentials = readFileSync(join(f.dir, "runtime.json"), "utf8");
  rmSync(join(f.dir, "secrets/identity/profile.json"));
  rmSync(join(f.dir, "secrets/gateway-token"));
  const second = f.run("deploy");
  assert.equal(second.status, 0, second.stderr);
  const all = f.calls();
  assertFullDeploy(all.slice(calls.length));
  const deploymentImages = all
    .filter((c) => c.stdin.includes('"kind":"Deployment"'))
    .map((c) => JSON.parse(c.stdin).spec.template.spec.containers[0].image);
  assert.notEqual(
    deploymentImages[0],
    deploymentImages[1],
    "each deploy changes the Pod template to trigger its restart",
  );
  assert.equal(readFileSync(join(f.dir, "runtime.json"), "utf8"), credentials);
  assert.equal(
    all.filter((c) => c.cmd === "bash").length,
    1,
    "provision only this product, only on first install",
  );
  assert.equal(
    all.filter((c) => c.args.join(" ").includes("create namespace")).length,
    1,
  );
  assert.equal(
    all.filter(
      (c) => c.args.includes("label") && c.args.includes("--overwrite"),
    ).length,
    2,
  );
  assert.equal(existsSync(join(f.dir, "lock")), false);
});
test("legacy migrate and restart commands both run the complete deploy workflow", (t) => {
  for (const action of ["migrate", "restart"]) {
    const f = fixture(t),
      result = f.run(action);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /now runs the full deploy workflow/);
    assertFullDeploy(f.calls());
  }
});
test("rollout or readiness failure reports failure instead of a successful deployment", (t) => {
  for (const flag of [
    "HARBOR_TEST_ROLLOUT_FAILURE",
    "HARBOR_TEST_READINESS_FAILURE",
  ]) {
    const f = fixture(t),
      result = f.run("deploy", { [flag]: "1" });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /deploy completed/);
    assert.equal(existsSync(join(f.dir, "lock")), false);
    if (flag === "HARBOR_TEST_ROLLOUT_FAILURE")
      assert.ok(!f.calls().some((c) => c.cmd === "readiness"));
  }
});
test("failed migration never deploys; unconfirmed termination retains the deployment lock", (t) => {
  for (const terminationFails of [false, true]) {
    const f = fixture(t),
      result = f.run("deploy", {
        HARBOR_TEST_MIGRATION_FAILURE: "1",
        ...(terminationFails ? { HARBOR_TEST_DELETE_FAILURE: "1" } : {}),
      });
    assert.notEqual(result.status, 0);
    const calls = f.calls();
    assert.ok(
      calls.some((c) => c.args.includes("wait")),
      result.stderr,
    );
    assert.ok(!calls.some((c) => c.stdin.includes('"kind":"Deployment"')));
    assert.equal(
      calls.some((c) => c.args.includes("--raw")),
      !terminationFails,
    );
    assert.ok(calls.some((c) => c.args.includes("--cascade=foreground")));
    const job = calls
      .map((c) => c.stdin && JSON.parse(c.stdin))
      .find((c) => c?.kind === "Job");
    assert.equal(
      job.spec.template.spec.nodeSelector["kubernetes.io/hostname"],
      hostname(),
    );
  }
});
test("unlock failure still removes temporary private configuration", (t) => {
  const f = fixture(t),
    result = f.run("deploy", {
      HARBOR_TEST_MIGRATION_FAILURE: "1",
      HARBOR_TEST_UNLOCK_FAILURE: "1",
    });
  assert.notEqual(result.status, 0);
  const unlock = f.calls().find((c) => c.args.includes("--raw"));
  assert.ok(unlock, result.stderr);
  assert.equal(existsSync(dirname(unlock.args.at(-1))), false);
});
