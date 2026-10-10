import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readApplicationSsoProfile } from "../../mx-common/src/identity/profile.mjs";

const file = "secrets/operations.json";
function validate(settings) {
  if (
    !settings ||
    !["context", "node", "clusterUid", "hubAdminOrigin"].every(
      (key) =>
        typeof settings[key] === "string" &&
        settings[key].trim() &&
        !settings[key].startsWith("REPLACE_WITH_"),
    )
  )
    throw Error(
      "secrets/operations.json 配置不完整；请恢复原配置，脚本不会覆盖已有文件。",
    );
  let url;
  try {
    url = new URL(settings.hubAdminOrigin);
  } catch {}
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== settings.hubAdminOrigin
  )
    throw Error(
      "secrets/operations.json 中的 Hub Admin origin 无效（配置值已隐藏）。",
    );
  return settings;
}

export function operationSettings({ run, action, env = process.env }) {
  if (existsSync(file)) {
    let settings;
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw Error(
        "secrets/operations.json 无法解析；请恢复原配置，脚本不会覆盖已有文件。",
      );
    }
    validate(settings);
    for (const [key, variable] of [
      ["context", "MX_HARBOR_KUBE_CONTEXT"],
      ["node", "MX_HARBOR_NODE"],
      ["hubAdminOrigin", "MX_HARBOR_HUB_ADMIN_ORIGIN"],
    ])
      if (env[variable] && env[variable] !== settings[key])
        throw Error(
          `${variable} 与已固定部署配置不一致；普通 deploy 不迁移目标。`,
        );
    return { settings, discovered: false };
  }
  if (action === "plan")
    throw Error(
      "尚未生成 secrets/operations.json。首次 deploy 会自动发现并固定当前集群和本机节点；plan 保持离线，不自动连接集群。",
    );
  const context =
    env.MX_HARBOR_KUBE_CONTEXT ||
    run("kubectl", ["config", "current-context"]).stdout.trim();
  if (!context)
    throw Error(
      "没有当前 Kubernetes context；请配置 kubeconfig 或设置 MX_HARBOR_KUBE_CONTEXT。",
    );
  const get = (namespace, args) => {
    const result = run("kubectl", [
      "--context",
      context,
      "-n",
      namespace,
      ...args,
      "-o",
      "json",
      "--request-timeout=15s",
    ]).stdout.trim();
    try {
      return result ? JSON.parse(result) : null;
    } catch {
      throw Error(
        "Kubernetes 返回了无效 JSON，停止自动发现（响应内容已隐藏）。",
      );
    }
  };
  const cluster = get("mx-harbor", ["get", "namespace", "kube-system"]);
  const nodes = get("mx-harbor", ["get", "nodes"]);
  const local = (nodes?.items || []).filter(
    (node) =>
      node.metadata?.labels?.["kubernetes.io/hostname"] === hostname() &&
      (!env.MX_HARBOR_NODE || node.metadata.name === env.MX_HARBOR_NODE),
  );
  if (local.length !== 1)
    throw Error(
      "无法唯一识别本机 Kubernetes 节点；请在 Internal 节点运行，或核对 MX_HARBOR_NODE 和 hostname 标签。",
    );
  const deployed = get("mx-harbor", [
    "get",
    "deployment",
    "mx-harbor",
    "--ignore-not-found",
  ]);
  if (
    deployed?.metadata &&
    deployed.spec?.template?.spec?.nodeSelector?.["kubernetes.io/hostname"] !==
      hostname()
  )
    throw Error(
      "已有 Harbor 的部署节点与本机不一致；请恢复原 operations.json，不自动迁移节点。",
    );
  const retained = get("mx-harbor", [
    "get",
    "secret",
    "mx-harbor-runtime",
    "--ignore-not-found",
  ]);
  let hubAdminOrigin = retained?.data?.MX_HARBOR_HUB_ADMIN_ORIGIN
    ? Buffer.from(retained.data.MX_HARBOR_HUB_ADMIN_ORIGIN, "base64").toString()
    : env.MX_HARBOR_HUB_ADMIN_ORIGIN;
  if (
    hubAdminOrigin &&
    env.MX_HARBOR_HUB_ADMIN_ORIGIN &&
    hubAdminOrigin !== env.MX_HARBOR_HUB_ADMIN_ORIGIN
  )
    throw Error(
      "保留的 Hub 上游与 MX_HARBOR_HUB_ADMIN_ORIGIN 不一致，停止自动发现。",
    );
  if (!hubAdminOrigin) {
    const service = get("mx-insight-hub", [
      "get",
      "service",
      "mx-insight-hub-admin",
      "--ignore-not-found",
    ]);
    if (!service?.spec?.ports?.some((port) => port.port === 18151))
      throw Error(
        "未发现 Hub Admin Service 的 18151 端口；先完成 Hub 部署，或显式设置 MX_HARBOR_HUB_ADMIN_ORIGIN。",
      );
    hubAdminOrigin =
      "http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151";
  }
  const settings = validate({
    context,
    clusterUid: cluster?.metadata?.uid,
    node: local[0].metadata.name,
    hubAdminOrigin,
  });
  return { settings, discovered: true };
}

export function saveOperationSettings(settings) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
}

export function firstInstallInputs() {
  const issues = [];
  let profile, gatewayToken;
  for (const [path, description] of [
    [
      "secrets/identity/profile.json",
      "请先在 Launcher 登记 mx-harbor 的正式 HTTPS 域名并导出 SSO profile",
    ],
    [
      "secrets/gateway-token",
      "需至少 32 字符的独立网关凭据，并与 Hub Portal 使用同一份",
    ],
  ]) {
    if (!existsSync(path)) {
      issues.push(`${path} 缺失：${description}`);
      continue;
    }
    try {
      if (!statSync(path).isFile() || statSync(path).mode & 0o077)
        throw Error();
      if (path.endsWith(".json")) {
        const settings = readApplicationSsoProfile(path);
        if (settings?.appId !== "mx-harbor") throw Error();
        profile = readFileSync(path, "utf8");
      } else {
        gatewayToken = readFileSync(path, "utf8").trim();
        if (gatewayToken.length < 32) throw Error();
      }
    } catch {
      issues.push(
        `${path} 无效或权限不是 0600：${description}（配置值已隐藏）`,
      );
    }
  }
  if (issues.length)
    throw Error(
      `首次部署配置未完成：\n- ${issues.join("\n- ")}\n尚未创建数据库、运行迁移或重启应用。详见 docs/implementation-and-operations.md。`,
    );
  return { profile, gatewayToken };
}
