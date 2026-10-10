import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateApplicationSsoSettings } from "../../mx-common/src/identity/profile.mjs";
import { operationSettings } from "./bootstrap.mjs";

export const HARBOR_ORIGIN = "https://harbor.minsight-ai.com";
const launcherApplication =
  "/var/lib/mx-launcher/identity/applications/public/mx-harbor.json";
const decode = (secret, key) =>
  secret?.data?.[key] === undefined
    ? undefined
    : Buffer.from(secret.data[key], "base64").toString();
function readPrivate(file) {
  if (!existsSync(file)) return undefined;
  const st = statSync(file);
  if (!st.isFile() || st.mode & 0o077)
    throw Error("接入文件必须为私有普通文件（0600）。");
  return readFileSync(file, "utf8");
}
function saveNew(file, value) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
}
function profile(value, hub) {
  const p = validateApplicationSsoSettings(JSON.parse(value));
  if (
    p.appId !== "mx-harbor" ||
    p.origin !== HARBOR_ORIGIN ||
    p.audience !== "mx-harbor" ||
    p.issuer !== hub.issuer ||
    p.audience === hub.audience ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.sessionKey ?? "") ||
    Buffer.from(p.sessionKey, "base64url").length !== 32
  )
    throw Error("Harbor 接入身份与正式域名或 Hub 身份来源不一致，停止覆盖。");
  return p;
}

// Callers hold the Harbor deployment lock. Writes use resourceVersion; partial
// success is safe to retry and never authorizes an account or grants a product.
export function enroll({
  readSecret,
  writeSecret,
  register,
  directory = "secrets",
  applicationFile = launcherApplication,
}) {
  const runtime = readSecret("mx-harbor", "mx-harbor-runtime");
  if (!runtime?.data?.MX_HARBOR_DATABASE_URL)
    throw Error("请先完成 Harbor deploy，再运行 enroll。");
  const portal = readSecret("mx-insight-hub", "mx-harbor-portal");
  const hub = JSON.parse(
    decode(
      readSecret("mx-insight-hub", "mx-insight-hub-browser-sso"),
      "profile.json",
    ) || "null",
  );
  if (
    !hub?.issuer ||
    !hub.audience ||
    !hub.legacyIssuer?.startsWith("mx-user-center:")
  )
    throw Error(
      "Hub SSO 尚未接入；enroll 需要现有 Hub 身份来源，普通 deploy 不受影响。",
    );
  const profileFile = resolve(directory, "identity/profile.json"),
    tokenFile = resolve(directory, "gateway-token");
  const candidates = [
    readPrivate(profileFile),
    readPrivate(applicationFile),
    decode(runtime, "profile.json"),
    decode(portal, "profile.json"),
  ]
    .filter((v) => v !== undefined)
    .map((v) => profile(v, hub));
  if (candidates.some((p) => !isDeepStrictEqual(p, candidates[0])))
    throw Error("已有 Harbor SSO 配置冲突，停止覆盖。");
  const tokens = [
    readPrivate(tokenFile),
    decode(runtime, "MX_HARBOR_GATEWAY_TOKEN"),
    decode(portal, "gateway-token"),
  ]
    .filter((v) => v !== undefined)
    .map((v) => v.trim());
  if (tokens.some((v) => v.length < 32 || v !== tokens[0]))
    throw Error("已有 Harbor 网关凭据冲突或无效，停止覆盖。");
  // Recover retained credentials before the Launcher command; it must not create
  // another session key when only the local file was lost.
  if (candidates.length)
    saveNew(profileFile, JSON.stringify(candidates[0], null, 2) + "\n");
  mkdirSync(dirname(profileFile), { recursive: true, mode: 0o700 });
  register(profileFile);
  const registered = profile(readPrivate(profileFile), hub);
  if (candidates.length && !isDeepStrictEqual(registered, candidates[0]))
    throw Error("Launcher 返回不同的接入身份，未更新集群。");
  const gateway = tokens[0] || randomBytes(32).toString("base64url");
  saveNew(tokenFile, gateway + "\n");
  const encoded = Buffer.from(JSON.stringify(registered)).toString("base64");
  writeSecret("mx-harbor", "mx-harbor-runtime", runtime, {
    "profile.json": encoded,
    MX_HARBOR_GATEWAY_TOKEN: Buffer.from(gateway).toString("base64"),
  });
  writeSecret("mx-insight-hub", "mx-harbor-portal", portal, {
    "profile.json": encoded,
    "gateway-token": Buffer.from(gateway).toString("base64"),
  });
  return { origin: HARBOR_ORIGIN, appId: registered.appId };
}

// Never echo stderr: kubectl may include the entire Secret submitted on stdin.
// Only recognized error categories and static guidance may reach the terminal.
export function commandFailure(cmd, result) {
  let reason = "原因未识别；子进程内容已隐藏以保护凭据。";
  const stderr = result.stderr || "";
  const serverCode = stderr.match(/Error from server \((\w+)\)/)?.[1];
  const serverReasons = {
    AlreadyExists:
      "AlreadyExists：资源已存在；若为部署锁，请先确认没有部署、迁移或接入任务正在运行，不会自动删除锁。",
    Forbidden:
      "Forbidden：当前 Kubernetes 身份无权操作此资源，请检查该资源的 RBAC 授权。",
    Unauthorized: "Unauthorized：Kubernetes 登录凭据无效或已过期。",
    NotFound: "NotFound：目标资源或 namespace 不存在，请确认前置部署已完成。",
    Conflict:
      "Conflict：资源已被其他任务修改；待其他任务完成后重新运行 enroll。",
    Invalid:
      "Invalid：API Server 拒绝资源内容或字段，请检查目标资源的配置约束。",
    BadRequest:
      "BadRequest：API Server 拒绝此请求，请检查目标资源和 kubectl 版本。",
    ServiceUnavailable: "ServiceUnavailable：Kubernetes API 暂不可用。",
    Timeout: "Timeout：Kubernetes API 请求超时，请检查集群连接。",
  };
  if (result.error?.code === "ENOENT")
    reason = "命令不存在，请检查安装及 PATH。";
  else if (result.error?.code === "EACCES") reason = "命令没有执行权限。";
  else if (result.error?.code === "ETIMEDOUT") reason = "命令执行超时。";
  else if (Object.hasOwn(serverReasons, serverCode))
    reason = serverReasons[serverCode];
  else if (/\balready exists\b/i.test(stderr))
    reason = serverReasons.AlreadyExists;
  else if (/\bforbidden\b/i.test(stderr)) reason = serverReasons.Forbidden;
  else if (
    /\bunauthorized\b|must be logged in to the server|server has asked for the client to provide credentials/i.test(
      stderr,
    )
  )
    reason = serverReasons.Unauthorized;
  else if (
    /context .* does not exist|no context exists with the name|current-context is not set|no configuration has been provided/i.test(
      stderr,
    )
  )
    reason =
      "固定的 context 不在当前 kubeconfig 中；请恢复 deploy 使用的 KUBECONFIG，不要修改已固定的集群。";
  else if (
    /x509:|certificate has expired|certificate signed by unknown authority/i.test(
      stderr,
    )
  )
    reason = "Kubernetes TLS 证书校验失败，请检查 kubeconfig、证书与本机时间。";
  else if (
    /connection refused|no such host|i\/o timeout|context deadline exceeded|TLS handshake timeout|unable to connect to the server/i.test(
      stderr,
    )
  )
    reason = "无法连接 Kubernetes API；请检查集群、网络、代理及 kubeconfig。";
  const status = Number.isInteger(result.status)
    ? `exit=${result.status}`
    : "进程未正常退出";
  return Error(`${cmd} 执行失败（${status}）。${reason}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let temp,
    lock,
    kube,
    completed = false;
  let stage = "读取固定部署配置";
  const report = (error) => {
    console.error(
      `Harbor enroll: [${stage}] ${error instanceof SyntaxError ? "接入配置无法解析（值已隐藏）。" : error.message}`,
    );
    process.exitCode = 1;
  };
  try {
    if (process.argv.length > 2)
      throw Error(
        "Usage: bash scripts/manage.sh ops internal-production enroll",
      );
    if (!existsSync("secrets/operations.json"))
      throw Error("请先运行 Harbor deploy 固定集群。");
    const run = (cmd, args, input) => {
      const r = spawnSync(cmd, args, {
        input,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.error || r.status !== 0) throw commandFailure(cmd, r);
      return r;
    };
    const { settings } = operationSettings({ run, action: "enroll" });
    kube = (ns, args, input) =>
      run(
        "kubectl",
        [
          "--context",
          settings.context,
          "-n",
          ns,
          ...args,
          "--request-timeout=15s",
        ],
        input,
      );
    const get = (ns, args) => {
      const value = kube(ns, [...args, "-o", "json"]).stdout.trim();
      return value ? JSON.parse(value) : null;
    };
    stage = "核对集群 kube-system UID";
    if (
      get("mx-harbor", ["get", "namespace", "kube-system"])?.metadata?.uid !==
      settings.clusterUid
    )
      throw Error("集群与固定部署目标不一致。");
    stage = "核对部署节点 hostname";
    if (
      get("mx-harbor", ["get", "node", settings.node])?.metadata?.labels?.[
        "kubernetes.io/hostname"
      ] !== hostname()
    )
      throw Error("本机节点与固定部署目标不一致。");
    temp = mkdtempSync(join(tmpdir(), "mx-harbor-enroll-"));
    stage = "获取 Harbor 部署锁 mx-harbor/mx-harbor-deploy-lock";
    lock = JSON.parse(
      kube("mx-harbor", [
        "create",
        "configmap",
        "mx-harbor-deploy-lock",
        "--from-literal=action=enroll",
        `--from-literal=ownerHost=${hostname()}`,
        `--from-literal=ownerPid=${process.pid}`,
        "-o",
        "json",
      ]).stdout,
    );
    enroll({
      readSecret: (ns, name) => {
        stage = `读取 Secret ${ns}/${name}`;
        const secret = get(ns, ["get", "secret", name, "--ignore-not-found"]);
        stage = "验证 Harbor 与 Hub 接入配置";
        return secret;
      },
      writeSecret: (ns, name, previous, data) => {
        stage = `同步 Secret ${ns}/${name}`;
        const doc = previous
          ? { ...previous, data: { ...previous.data, ...data } }
          : {
              apiVersion: "v1",
              kind: "Secret",
              metadata: { name, namespace: ns },
              type: "Opaque",
              data,
            };
        kube(
          ns,
          [previous ? "replace" : "create", "-f", "-"],
          JSON.stringify(doc),
        );
      },
      register: (file) => {
        stage = "Launcher 登记 mx-harbor SSO client";
        run("bash", [
          "../mx-launcher/scripts/manage.sh",
          "ops",
          "identity",
          "app",
          "--app",
          "mx-harbor",
          "--origin",
          HARBOR_ORIGIN,
          "--audience",
          "mx-harbor",
          "--entry",
          "public",
          "--output",
          file,
        ]);
        stage = "验证 Launcher 接入身份";
      },
    });
    completed = true;
  } catch (error) {
    report(error);
  } finally {
    try {
      if (lock) {
        stage = "释放 Harbor 部署锁 mx-harbor/mx-harbor-deploy-lock";
        const file = join(temp, "unlock.json");
        writeFileSync(
          file,
          JSON.stringify({
            apiVersion: "v1",
            kind: "DeleteOptions",
            preconditions: { uid: lock.metadata.uid },
          }),
        );
        kube("mx-harbor", [
          "delete",
          "--raw",
          "/api/v1/namespaces/mx-harbor/configmaps/mx-harbor-deploy-lock",
          "-f",
          file,
        ]);
      }
    } catch (error) {
      report(error);
      console.error(
        "Harbor enroll: 解锁未确认；重新运行前请检查部署锁。未自动删除其他任务的锁。",
      );
    } finally {
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  }
  if (completed && !process.exitCode) {
    console.log("Harbor 接入配置已同步；已有密钥保留，账号与产品权限未修改。");
    console.log(
      "新登记的 Auth client 须按 Launcher 原流程发布；Hub 须部署包含可选 Portal 挂载的版本。随后 Secret 投影更新即可生效。",
    );
  }
}
