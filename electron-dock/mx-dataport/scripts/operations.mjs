import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { workload } from "../deploy/k8s/render.mjs";
import { readConfig } from "../apps/server/config.mjs";
import { commandFailure } from "./enroll.mjs";
import { waitForMigration, migrationDiagnostics } from "./migration-job.mjs";
import {
  acquireDeployLock,
  harborProcesses,
  markDeployLockReleasable,
} from "./recover-lock.mjs";
import {
  operationSettings,
  saveOperationSettings,
  enrollmentInputs,
} from "./bootstrap.mjs";
const requestedAction = process.argv[2] || "help",
  action = ["migrate", "restart"].includes(requestedAction)
    ? "deploy"
    : requestedAction,
  namespace = "mx-harbor";
const help =
  "Usage: bash scripts/manage.sh ops internal-production deploy|enroll|recover-lock|status|logs|plan\nrecover-lock is read-only by default; --confirm-idle attempts guarded stale-lock recovery after all operations have exited.\nUse enroll --migrate-domain for an existing Harbor origin, preserving all keys. Enroll registers https://dataport.minsight-ai.com with existing Launcher/Auth and synchronizes the optional Hub Portal credentials; it does not deploy Launcher/Hub.\nDeploy includes migration, application restart and readiness verification. migrate/restart are compatibility aliases for deploy.\nFirst deploy discovers and saves secrets/operations.json from the current Kubernetes context and local node. Missing SSO/Hub enrollment does not block deployment or migrations; integrations are resolved at runtime. Retained Kubernetes Secret takes precedence.";
if (action === "help") {
  console.log(help);
  process.exit(0);
}
if (!["deploy", "status", "logs", "plan"].includes(action)) throw Error(help);
if (requestedAction !== action)
  console.log(`DataPort ${requestedAction} now runs the full deploy workflow`);
const run = (
  cmd,
  args,
  { input, env = process.env, inherit = false, optional = false, timeout } = {},
) => {
  const result = spawnSync(cmd, args, {
    input,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  if ((result.error || result.status !== 0) && !optional) {
    // kubectl errors can contain the Secret submitted on stdin. Only share
    // recognized categories, never raw stderr, stdout, environment or arguments.
    if (cmd === "kubectl") throw commandFailure(cmd, result);
    throw Error(`${cmd} failed (${result.status}); inspect the operation locally`);
  }
  return result;
};
let settings, discovered;
try {
  ({ settings, discovered } = operationSettings({ run, action }));
} catch (error) {
  console.error(`DataPort: ${error.message}`);
  process.exit(1);
}
const kube = (args, options) =>
  run(
    "kubectl",
    ["--context", settings.context, "-n", namespace, ...args],
    options,
  );
const read = (args, optional = false) => {
  const r = kube([...args, "-o", "json"], { optional });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return JSON.parse(r.stdout);
};
if (action === "plan") {
  console.log(
    JSON.stringify(
      {
        context: settings.context,
        clusterUid: settings.clusterUid,
        node: settings.node,
        namespace,
        appPort: 18220,
        operations: [
          "verify retained identity and credentials",
          "build immutable image",
          "run isolated migration",
          "update and restart DataPort once",
          "wait for rollout and readiness",
        ],
        deployment: workload({
          node: settings.node,
          image: "mx-harbor:<unique-build-tag>",
        }),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const cluster = read(["get", "namespace", "kube-system"]);
if (cluster.metadata.uid !== settings.clusterUid)
  throw Error("Cluster identity drift; no mutation performed");
if (action === "status") {
  kube(["get", "deployment,pod,job,service"], { inherit: true });
  process.exit(0);
}
if (action === "logs") {
  kube(["logs", "deployment/mx-harbor", "--tail=150"], { inherit: true });
  process.exit(0);
}
// Require a local single-node build/import target; never guess SSH credentials or another host.
const node = read(["get", "node", settings.node]);
const nodeHostname = node.metadata.labels["kubernetes.io/hostname"];
if (
  nodeHostname !== hostname() ||
  node.spec?.unschedulable ||
  !node.status.conditions.some((c) => c.type === "Ready" && c.status === "True")
)
  throw Error(
    "Run on the configured ready Internal node; hostname must match its Kubernetes hostname label",
  );
const allowedTaints = new Set([
  "node-role.kubernetes.io/control-plane",
  "node-role.kubernetes.io/master",
]);
if (
  node.spec?.taints?.some(
    (t) =>
      ["NoSchedule", "NoExecute"].includes(t.effect) &&
      !allowedTaints.has(t.key),
  )
)
  throw Error("Node has an unsupported scheduling taint");
try {
  if (discovered) {
    saveOperationSettings(settings);
    console.log(
      "DataPort: 已生成 secrets/operations.json，固定当前集群、本机节点和 Hub 上游。",
    );
  }
  // Validate supplied enrollment files; missing external integration is allowed.
  const retained = read([
    "get",
    "secret",
    "mx-harbor-runtime",
    "--ignore-not-found",
  ]);
  if (!retained?.data) {
    if (
      read(["get", "deployment", "mx-harbor", "--ignore-not-found"])?.metadata
    )
      throw Error(
        "Installed DataPort runtime Secret is missing; restore it before deploying",
      );
    enrollmentInputs();
  }
} catch (error) {
  console.error(`DataPort: ${error.message}`);
  process.exit(1);
}
const ns = read(["get", "namespace", namespace, "--ignore-not-found"]);
if (!ns) {
  kube(["create", "namespace", namespace]);
}
let temp,
  lock,
  job = "",
  release = true,
  completed = false;
const lockRead = (args) => read([...args, "--request-timeout=15s"]);
const removeLock = (options) => {
  const path = join(temp, "unlock.json");
  writeFileSync(path, JSON.stringify(options), { mode: 0o600 });
  kube([
    "delete",
    "--raw",
    `/api/v1/namespaces/${namespace}/configmaps/mx-harbor-deploy-lock`,
    "--request-timeout=15s",
    "-f",
    path,
  ]);
};
const acquireLock = () => {
  try {
    return acquireDeployLock({
      create: () => {
        const result = kube([
          "create",
          "configmap",
          "mx-harbor-deploy-lock",
          `--from-literal=action=${action}`,
          `--from-literal=ownerHost=${hostname()}`,
          `--from-literal=ownerPid=${process.pid}`,
          "--from-literal=recoveryVersion=1",
          "--from-literal=recoveryState=active",
          "--request-timeout=15s",
          "-o",
          "json",
        ], { optional: true });
        if (result.error || result.status !== 0) {
          const failure = commandFailure("kubectl", result);
          // Only a definite server response permits recovery; a parse error or
          // a timed-out create might have already acquired a different lock.
          failure.lockAlreadyExists = !result.error &&
            /^(?:Error from server \(AlreadyExists\): |error: failed to create configmap: )configmaps "mx-harbor-deploy-lock" already exists$/.test((result.stderr || "").trim());
          throw failure;
        }
        const created = JSON.parse(result.stdout);
        if (
          !created?.metadata?.uid || !created.metadata.resourceVersion ||
          created.data?.action !== "deploy" ||
          created.data?.ownerHost !== hostname() ||
          created.data?.ownerPid !== String(process.pid) ||
          created.data?.recoveryVersion !== "1" ||
          created.data?.recoveryState !== "active"
        ) throw Error("部署锁创建响应身份不完整；请先只读核对锁状态。");
        return created;
      },
      get: lockRead,
      remove: removeLock,
      processes: () => harborProcesses(run("ps", ["-eo", "pid=,args="]).stdout)
        .filter((entry) => entry.pid !== process.pid),
      report: (message) => console.log(`DataPort: ${message}`),
    });
  } catch (error) {
    const reason = error instanceof SyntaxError
      ? "部署锁响应无法解析；请先只读核对锁状态，不要重复部署。"
      : error.message;
    throw Error(`获取部署锁 ${namespace}/mx-harbor-deploy-lock 失败。${reason} 可运行 bash scripts/manage.sh ops internal-production recover-lock（默认只读）核对锁状态。`);
  }
};
const apply = (object) =>
  kube(["apply", "-f", "-"], { input: JSON.stringify(object) });
try {
  // Prepare cleanup storage before acquiring the lock: a full/missing TMPDIR
  // must not create a lock which this process cannot release.
  temp = mkdtempSync(join(tmpdir(), "mx-harbor-deploy-"));
  lock = acquireLock();
  // Reconcile our namespace label even after an interrupted first deployment.
  kube([
    "label",
    "namespace",
    namespace,
    "mx-common.io/client=allowed",
    "--overwrite",
  ]);
  const retained = read([
    "get",
    "secret",
    "mx-harbor-runtime",
    "--ignore-not-found",
  ]);
  let data = retained?.data
    ? Object.fromEntries(
        Object.entries(retained.data).map(([k, v]) => [
          k,
          Buffer.from(v, "base64").toString(),
        ]),
      )
    : null;
  if (!data) {
    if (
      read(["get", "deployment", "mx-harbor", "--ignore-not-found"])?.metadata
    )
      throw Error(
        "Installed DataPort runtime Secret is missing; restore it before deploying",
      );
    // This provisions only mx_harbor and preserves the mx-common product Secret on repeats.
    const kubeconfigPath = join(temp, "kubeconfig");
    writeFileSync(
      kubeconfigPath,
      run("kubectl", [
        "--context",
        settings.context,
        "config",
        "view",
        "--minify",
        "--raw",
      ]).stdout,
      { mode: 0o600 },
    );
    const db = run(
      "bash",
      ["../mx-common/scripts/manage.sh", "provision", "mx-harbor"],
      { env: { ...process.env, KUBECONFIG: kubeconfigPath } },
    ).stdout.trim();
    data = {
      MX_HARBOR_DATABASE_URL: db,
      MX_HARBOR_HUB_ADMIN_ORIGIN: settings.hubAdminOrigin,
      MX_HARBOR_SSO_PROFILE: "/run/harbor/profile.json",
      MX_HARBOR_PORT: "18220",
    };
  }
  // Fill previously missing enrollment only; never rotate retained credentials.
  const enrollment = enrollmentInputs(data);
  if (enrollment.profile) data["profile.json"] = enrollment.profile;
  if (enrollment.gatewayToken)
    data.MX_HARBOR_GATEWAY_TOKEN = enrollment.gatewayToken;
  readConfig(data);
  if (!data["profile.json"] || !data.MX_HARBOR_GATEWAY_TOKEN)
    console.log(
      "DataPort: 外部接入待配置，继续数据库迁移和发布；运行时相关接口暂不可用。",
    );
  if (data.MX_HARBOR_HUB_ADMIN_ORIGIN !== settings.hubAdminOrigin)
    throw Error("Retained upstream differs; explicit migration required");
  apply({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "mx-harbor-runtime", namespace },
    type: "Opaque",
    stringData: data,
  });
  const image = `mx-harbor:build-${Date.now()}-${randomUUID().slice(0, 8)}`,
    proxy =
      process.env.MX_HARBOR_BUILD_PROXY || process.env.MX_INSIGHT_BUILD_PROXY,
    env = { ...process.env },
    args = [
      "buildx",
      "build",
      "--load",
      "--network",
      "host",
      "--build-context",
      `mx_common=${resolve("../mx-common")}`,
      "-t",
      image,
      ".",
    ];
  if (proxy) {
    try {
      const proxyUrl = new URL(proxy);
      if (
        !["http:", "https:"].includes(proxyUrl.protocol) ||
        proxyUrl.username ||
        proxyUrl.password ||
        proxyUrl.pathname !== "/" ||
        proxyUrl.search ||
        proxyUrl.hash ||
        /[\s,"']/.test(proxy)
      )
        throw Error();
    } catch {
      throw Error("Invalid HTTP(S) build proxy (value hidden)");
    }
    Object.assign(env, {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
    });
    // buildkitd keeps creation-time environment: changing build args or the
    // caller's proxy does not change registry pulls in an existing builder.
    // Keep previous builders/caches and select one scoped to this proxy.
    const signature = createHash("sha256").update(proxy).digest("hex").slice(0, 16),
      builder = `mx-harbor-buildproxy-${signature}`,
      inspection = run("docker", ["buildx", "inspect", builder], {
        optional: true,
      });
    if (inspection.status === 0) {
      const info = inspection.stdout,
        nodes = info.split(/^Nodes:\s*$/m)[1] || "",
        options = [...info.matchAll(/^Driver Options:\s*(.*)$/gm)],
        values = new Map(
          [...(options[0]?.[1] || "").matchAll(/(?:^|\s)([\w.]+)="([^"\r\n]*)"/g)]
            .map((entry) => [entry[1], entry[2]]),
        );
      if (
        !/^Driver:\s+docker-container\s*$/m.test(info) ||
        (nodes.match(/^Name:\s+/gm) || []).length !== 1 ||
        options.length !== 1 ||
        values.get("network") !== "host" ||
        ["env.HTTP_PROXY", "env.HTTPS_PROXY"].some(key => values.get(key) !== proxy) ||
        ["env.http_proxy", "env.https_proxy", "env.ALL_PROXY", "env.all_proxy"]
          .some(key => values.has(key) && values.get(key) !== proxy) ||
        ["env.NO_PROXY", "env.no_proxy"].some(key => values.get(key))
      )
        throw Error(
          "Build proxy builder configuration differs or cannot be verified; existing builder/cache left intact. Inspect this builder before retrying.",
        );
    } else {
      console.log(`DataPort: creating scoped build proxy builder ${builder}`);
      run(
        "docker",
        [
          "buildx",
          "create",
          "--name",
          builder,
          "--driver",
          "docker-container",
          "--driver-opt",
          "network=host",
          "--driver-opt",
          `env.HTTP_PROXY=${proxy}`,
          "--driver-opt",
          `env.HTTPS_PROXY=${proxy}`,
          "--driver-opt",
          `env.http_proxy=${proxy}`,
          "--driver-opt",
          `env.https_proxy=${proxy}`,
          "--buildkitd-flags",
          "--allow-insecure-entitlement network.host",
        ],
        { env },
      );
    }
    args.splice(
      2,
      0,
      "--builder",
      builder,
      "--allow",
      "network.host",
      "--build-arg",
      `HTTP_PROXY=${proxy}`,
      "--build-arg",
      `HTTPS_PROXY=${proxy}`,
    );
  }
  run("docker", args, { env, inherit: true });
  const archive = join(temp, "image.tar");
  run("docker", ["image", "save", "-o", archive, image]);
  run("ctr", ["-n", "k8s.io", "images", "import", archive], {
    inherit: true,
  });
  const images = run("ctr", [
    "-n",
    "k8s.io",
    "images",
    "ls",
    "-q",
  ]).stdout.split("\n");
  if (!images.includes(`docker.io/library/${image}`))
    throw Error("Image import could not be verified");
  job = `mx-harbor-migrate-${randomUUID().slice(0, 8)}`;
  apply(workload({ namespace, node: nodeHostname, image, job }));
  console.log(`DataPort: waiting for migration job/${job}`);
  const migration = await waitForMigration(kube, job);
  if (migration.outcome !== "complete") {
    console.error("DataPort migration diagnostics: " + JSON.stringify(
      migrationDiagnostics(kube, job, migration.snapshot),
    ));
    throw Error(`DataPort migration ${migration.outcome}: ${migration.detail}; job/${job}; application not updated`);
  }
  job = "";
  // The unique immutable image changes the Pod template, replacing the old Pod exactly once.
  apply(workload({ namespace, node: nodeHostname, image }));
  apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "mx-harbor", namespace },
    spec: {
      selector: { app: "mx-harbor" },
      ports: [{ port: 18220, targetPort: "http" }],
    },
  });
  kube(["rollout", "status", "deployment/mx-harbor", "--timeout=180s"], {
    inherit: true,
  });
  const health = await fetch("http://127.0.0.1:18220/ready", {
    signal: AbortSignal.timeout(5000),
  });
  if (!health.ok) throw Error("DataPort readiness failed");
  completed = true;
} catch (error) {
  if (job) {
    const stopped = kube(
      [
        "delete",
        `job/${job}`,
        "--cascade=foreground",
        "--wait=true",
        "--timeout=60s",
        "--request-timeout=15s",
      ],
      { optional: true, timeout: 65000 },
    );
    if (stopped.status !== 0) {
      release = false;
      console.error(
        "Migration termination unconfirmed; DataPort deployment lock retained",
      );
    }
  }
  throw error;
} finally {
  try {
    if (lock && release) {
      // Only a fully completed deploy can leave a proof for automatic recovery.
      // SIGKILL, failed migrations and unknown API outcomes remain manual.
      if (completed) markDeployLockReleasable({
        lock,
        get: lockRead,
        patch: (operations) => kube([
          "patch", "configmap", "mx-harbor-deploy-lock",
          "--type=json", "-p", JSON.stringify(operations),
          "--request-timeout=15s",
        ]),
      });
      removeLock({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: lock.metadata.uid },
      });
    }
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
console.log(`DataPort ${action} completed`);
