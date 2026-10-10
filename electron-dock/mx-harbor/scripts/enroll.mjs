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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let temp, lock, kube;
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
      if (r.status !== 0)
        throw Error(`${cmd} 执行失败；未输出可能包含凭据的子进程内容。`);
      return r;
    };
    const { settings } = operationSettings({ run, action: "enroll" });
    kube = (ns, args, input) =>
      run("kubectl", ["--context", settings.context, "-n", ns, ...args], input);
    const get = (ns, args) => {
      const value = kube(ns, [
        ...args,
        "-o",
        "json",
        "--request-timeout=15s",
      ]).stdout.trim();
      return value ? JSON.parse(value) : null;
    };
    if (
      get("mx-harbor", ["get", "namespace", "kube-system"])?.metadata?.uid !==
        settings.clusterUid ||
      get("mx-harbor", ["get", "node", settings.node])?.metadata?.labels?.[
        "kubernetes.io/hostname"
      ] !== hostname()
    )
      throw Error("集群或本机节点与固定部署目标不一致。");
    temp = mkdtempSync(join(tmpdir(), "mx-harbor-enroll-"));
    lock = JSON.parse(
      kube("mx-harbor", [
        "create",
        "configmap",
        "mx-harbor-deploy-lock",
        "--from-literal=action=enroll",
        "-o",
        "json",
      ]).stdout,
    );
    enroll({
      readSecret: (ns, name) =>
        get(ns, ["get", "secret", name, "--ignore-not-found"]),
      writeSecret: (ns, name, previous, data) => {
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
      register: (file) =>
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
        ]),
    });
    console.log("Harbor 接入配置已同步；已有密钥保留，账号与产品权限未修改。");
    console.log(
      "新登记的 Auth client 须按 Launcher 原流程发布；Hub 须部署包含可选 Portal 挂载的版本。随后 Secret 投影更新即可生效。",
    );
  } catch (error) {
    console.error(
      `Harbor enroll: ${error instanceof SyntaxError ? "接入配置无法解析（值已隐藏）。" : error.message}`,
    );
    process.exitCode = 1;
  } finally {
    try {
      if (lock) {
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
    } finally {
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  }
}
