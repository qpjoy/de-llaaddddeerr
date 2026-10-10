import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { workload } from "../deploy/k8s/render.mjs";
import { readConfig } from "../apps/server/config.mjs";
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
  "Usage: bash scripts/manage.sh ops internal-production deploy|enroll|recover-lock|status|logs|plan\nrecover-lock is read-only by default; --confirm-idle attempts guarded stale-lock recovery after all operations have exited.\nEnroll registers https://harbor.minsight-ai.com with existing Launcher/Auth and synchronizes the optional Hub Portal credentials; it does not deploy Launcher/Hub.\nDeploy includes migration, application restart and readiness verification. migrate/restart are compatibility aliases for deploy.\nFirst deploy discovers and saves secrets/operations.json from the current Kubernetes context and local node. Missing SSO/Hub enrollment does not block deployment or migrations; integrations are resolved at runtime. Retained Kubernetes Secret takes precedence.";
if (action === "help") {
  console.log(help);
  process.exit(0);
}
if (!["deploy", "status", "logs", "plan"].includes(action)) throw Error(help);
if (requestedAction !== action)
  console.log(`Harbor ${requestedAction} now runs the full deploy workflow`);
const run = (
  cmd,
  args,
  { input, env = process.env, inherit = false, optional = false } = {},
) => {
  const result = spawnSync(cmd, args, {
    input,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0 && !optional)
    throw Error(
      `${cmd} failed (${result.status}); inspect the operation locally`,
    );
  return result;
};
let settings, discovered;
try {
  ({ settings, discovered } = operationSettings({ run, action }));
} catch (error) {
  console.error(`Harbor: ${error.message}`);
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
          "update and restart Harbor once",
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
      "Harbor: 已生成 secrets/operations.json，固定当前集群、本机节点和 Hub 上游。",
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
        "Installed Harbor runtime Secret is missing; restore it before deploying",
      );
    enrollmentInputs();
  }
} catch (error) {
  console.error(`Harbor: ${error.message}`);
  process.exit(1);
}
const ns = read(["get", "namespace", namespace, "--ignore-not-found"]);
if (!ns) {
  kube(["create", "namespace", namespace]);
}
const lock = JSON.parse(
    kube([
      "create",
      "configmap",
      "mx-harbor-deploy-lock",
      `--from-literal=action=${action}`,
      `--from-literal=ownerHost=${hostname()}`,
      `--from-literal=ownerPid=${process.pid}`,
      "-o",
      "json",
    ]).stdout,
  ),
  temp = mkdtempSync(join(tmpdir(), "mx-harbor-deploy-"));
let job = "",
  release = true;
const apply = (object) =>
  kube(["apply", "-f", "-"], { input: JSON.stringify(object) });
try {
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
        "Installed Harbor runtime Secret is missing; restore it before deploying",
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
      "Harbor: 外部接入待配置，继续数据库迁移和发布；运行时相关接口暂不可用。",
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
    const proxyUrl = new URL(proxy);
    if (
      !["http:", "https:"].includes(proxyUrl.protocol) ||
      proxyUrl.username ||
      proxyUrl.password
    )
      throw Error("Invalid build proxy");
    Object.assign(env, {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
    });
    const builder = "mx-harbor-buildproxy";
    if (
      run("docker", ["buildx", "inspect", builder], { optional: true })
        .status !== 0
    )
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
          `network=host,env.HTTP_PROXY=${proxy},env.HTTPS_PROXY=${proxy}`,
        ],
        { env },
      );
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
  const wait = kube(
    ["wait", "--for=condition=complete", `job/${job}`, "--timeout=310s"],
    { optional: true, inherit: true },
  );
  if (wait.status !== 0) {
    kube([
      "delete",
      `job/${job}`,
      "--cascade=foreground",
      "--wait=true",
      "--timeout=60s",
    ]);
    job = "";
    throw Error("Harbor migration failed; application not updated");
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
  if (!health.ok) throw Error("Harbor readiness failed");
} catch (error) {
  if (job) {
    const stopped = kube(
      [
        "delete",
        `job/${job}`,
        "--cascade=foreground",
        "--wait=true",
        "--timeout=60s",
      ],
      { optional: true },
    );
    if (stopped.status !== 0) {
      release = false;
      console.error(
        "Migration termination unconfirmed; Harbor deployment lock retained",
      );
    }
  }
  throw error;
} finally {
  try {
    if (release) {
      const path = join(temp, "unlock.json");
      writeFileSync(
        path,
        JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: lock.metadata.uid },
        }),
      );
      kube([
        "delete",
        "--raw",
        `/api/v1/namespaces/${namespace}/configmaps/mx-harbor-deploy-lock`,
        "-f",
        path,
      ]);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
console.log(`Harbor ${action} completed`);
