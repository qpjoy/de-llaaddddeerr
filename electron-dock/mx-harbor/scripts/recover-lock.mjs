import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readlinkSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { operationSettings } from "./bootstrap.mjs";
import { commandFailure } from "./enroll.mjs";

const lockName = "mx-harbor-deploy-lock";
const migrationName = (name) =>
  typeof name === "string" && name.startsWith("mx-harbor-migrate-");
const terminal = (object) =>
  object.status?.conditions?.some(
    (c) => ["Complete", "Failed"].includes(c.type) && c.status === "True",
  );
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw Error("无法核对锁持有进程，停止恢复。");
  }
}

// Inspect arguments locally, but only return PID/script names: a command line can
// contain credentials. Ambiguous process ownership blocks recovery conservatively.
export function harborProcesses(
  output,
  cwdFor = (pid) => readlinkSync(`/proc/${pid}/cwd`),
) {
  const matches = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!fields) continue;
    const [, pid, command] = fields;
    const script = command.match(
      /(?:^|\s)(\S*\/?scripts\/(operations|enroll|migrate)\.mjs)(?:\s|$)/,
    );
    if (!script) continue;
    let cwd;
    try {
      cwd = cwdFor(Number(pid));
    } catch {}
    if (
      script[1].includes("/mx-harbor/scripts/") ||
      (cwd && basename(cwd) === "mx-harbor") ||
      !cwd
    )
      matches.push({
        pid: Number(pid),
        script: `${script[2]}.mjs`,
        ownership: cwd ? "Harbor" : "unknown",
      });
  }
  return matches;
}

// Explicit recovery only. An old lock has no owner evidence, so it requires an
// operator assertion in addition to the independent Job/Pod checks. Never use a TTL.
export function recoverLock({
  get,
  remove,
  confirmIdle = false,
  alive = processAlive,
  host = hostname(),
  processes,
  report = () => {},
}) {
  const lock = get(["get", "configmap", lockName, "--ignore-not-found"]);
  if (!lock) return "absent";
  const { uid, resourceVersion } = lock.metadata ?? {};
  if (!uid || !resourceVersion)
    throw Error("部署锁缺少 UID/resourceVersion，停止恢复。");
  const { ownerHost, ownerPid } = lock.data ?? {};
  report({
    action: lock.data?.action,
    created: lock.metadata.creationTimestamp,
    ownerHost: ownerHost ?? "legacy-unknown",
    ownerPid: ownerPid ?? "legacy-unknown",
  });
  if (ownerHost !== undefined || ownerPid !== undefined) {
    if (
      ownerHost !== host ||
      !/^[1-9][0-9]*$/.test(ownerPid ?? "") ||
      !Number.isSafeInteger(Number(ownerPid))
    )
      throw Error("部署锁的持有主机/PID 无法在本机确认，停止恢复。");
    if (alive(Number(ownerPid)))
      throw Error(
        "部署锁的持有进程仍存在，停止恢复；--confirm-idle 不能绕过此检查。",
      );
  }
  const running = processes();
  report({ processes: running });
  if (running.length)
    throw Error("仍有 Harbor 操作进程，或进程归属无法确认，停止恢复。");
  const jobs = get(["get", "jobs"]),
    pods = get(["get", "pods"]);
  if (!Array.isArray(jobs?.items) || !Array.isArray(pods?.items))
    throw Error("无法确认迁移 Job/Pod 状态，停止恢复。");
  const migrationJobs = jobs.items.filter(
    (j) =>
      migrationName(j.metadata?.name) ||
      j.metadata?.labels?.app === "mx-harbor",
  );
  report({
    migrationJobs: migrationJobs.map((j) => ({
      name: j.metadata.name,
      active: j.status?.active ?? 0,
      terminal: Boolean(terminal(j)),
    })),
  });
  if (
    migrationJobs.some((j) => !terminal(j) || Number(j.status?.active || 0) > 0)
  )
    throw Error("仍有未结束的 Harbor 迁移 Job，停止恢复；先检查 Job 状态。");
  const migrationPods = pods.items.filter(
    (p) =>
      p.metadata?.ownerReferences?.some(
        (o) => o.kind === "Job" && migrationName(o.name),
      ) ||
      migrationName(
        p.metadata?.labels?.["batch.kubernetes.io/job-name"] ||
          p.metadata?.labels?.["job-name"],
      ) ||
      (p.metadata?.labels?.app === "mx-harbor" &&
        p.spec?.containers?.some((c) => c.name === "migrate")),
  );
  report({
    migrationPods: migrationPods.map((p) => ({
      name: p.metadata.name,
      phase: p.status?.phase ?? "Unknown",
    })),
  });
  if (
    migrationPods.some(
      (p) => !["Succeeded", "Failed"].includes(p.status?.phase),
    )
  )
    throw Error("仍有未结束的 Harbor 迁移 Pod，停止恢复；先确认迁移已终止。");
  if (!confirmIdle) return "checked";
  // A concurrent edit or delete/recreate must fail the server-side preconditions.
  remove({
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid, resourceVersion },
  });
  const remaining = get(["get", "configmap", lockName, "--ignore-not-found"]);
  if (remaining?.metadata?.uid === uid)
    throw Error("部署锁仍在删除中，停止重试接入；请检查锁的 finalizers。");
  return remaining ? "replaced" : "released";
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let temp,
    stage = "读取固定部署配置";
  try {
    if (
      process.argv.length > 3 ||
      (process.argv[2] && process.argv[2] !== "--confirm-idle")
    )
      throw Error(
        "Usage: bash scripts/manage.sh ops internal-production recover-lock [--confirm-idle]",
      );
    if (!existsSync("secrets/operations.json"))
      throw Error("缺少已固定的集群配置，停止恢复。");
    const run = (cmd, args) => {
      const r = spawnSync(cmd, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.error || r.status !== 0) throw commandFailure(cmd, r);
      return r;
    };
    const { settings } = operationSettings({ run, action: "recover-lock" });
    const kube = (args) =>
      run("kubectl", [
        "--context",
        settings.context,
        "-n",
        "mx-harbor",
        ...args,
        "--request-timeout=15s",
      ]);
    const get = (args) => {
      stage = args.slice(0, 3).join(" ");
      const value = kube([...args, "-o", "json"]).stdout.trim();
      return value ? JSON.parse(value) : null;
    };
    if (
      get(["get", "namespace", "kube-system"])?.metadata?.uid !==
      settings.clusterUid
    )
      throw Error("集群与固定部署目标不一致，停止恢复。");
    if (
      get(["get", "node", settings.node])?.metadata?.labels?.[
        "kubernetes.io/hostname"
      ] !== hostname()
    )
      throw Error("请在固定的 Internal 节点运行，停止恢复。");
    const result = recoverLock({
      get,
      confirmIdle: process.argv[2] === "--confirm-idle",
      processes: () => {
        stage = "只读检查本机操作进程";
        return harborProcesses(run("ps", ["-eo", "pid=,args="]).stdout);
      },
      report: (value) => console.log(`Harbor lock: ${JSON.stringify(value)}`),
      remove: (options) => {
        stage = "按 UID/resourceVersion 恢复部署锁";
        temp = mkdtempSync(join(tmpdir(), "mx-harbor-unlock-"));
        const file = join(temp, "delete-options.json");
        writeFileSync(file, JSON.stringify(options), { mode: 0o600 });
        kube([
          "delete",
          "--raw",
          `/api/v1/namespaces/mx-harbor/configmaps/${lockName}`,
          "-f",
          file,
        ]);
      },
    });
    console.log(
      result === "absent"
        ? "Harbor: 无部署锁，可以重新运行 enroll/deploy。"
        : result === "checked"
          ? "Harbor: 只读检查通过，未修改部署锁。确认所有 Harbor deploy/migrate/enroll 已退出后，可运行 recover-lock --confirm-idle；旧锁缺少持有者记录，不能仅凭锁龄判断。"
          : result === "replaced"
            ? "Harbor: 原部署锁已释放，但其他任务已取得新锁；请等待该任务结束。"
            : "Harbor: 遗留部署锁已释放，可以重新运行 enroll/deploy。",
    );
  } catch (error) {
    console.error(
      `Harbor recover-lock: [${stage}] ${error instanceof SyntaxError ? "响应无法解析（内容已隐藏），停止恢复。" : error.message}`,
    );
    process.exitCode = 1;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
