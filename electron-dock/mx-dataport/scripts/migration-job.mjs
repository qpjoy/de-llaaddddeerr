import { setTimeout as sleep } from "node:timers/promises";
import { commandFailure } from "./enroll.mjs";

const reasons = new Set([
  "BackoffLimitExceeded", "DeadlineExceeded", "PodFailurePolicy", "FailedCreate",
  "Unschedulable", "SchedulingGated", "ContainerCreating", "PodInitializing",
  "ErrImageNeverPull", "ErrImagePull", "ImagePullBackOff", "InvalidImageName",
  "CreateContainerConfigError", "CreateContainerError", "RunContainerError",
  "CrashLoopBackOff", "OOMKilled", "Error", "Completed", "Evicted", "NodeLost",
  "FailedScheduling", "FailedMount", "FailedAttachVolume", "FailedCreatePodSandBox",
  "Failed", "FailedSync", "FailedKillPod", "Killing", "Unhealthy",
]);
const reason = (value) => reasons.has(value) ? value : "unknown";
const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function read(kube, args) {
  const result = kube([...args, "-o", "json", "--request-timeout=15s"], {
    optional: true, timeout: 20000,
  });
  if (result.error || result.status !== 0) throw commandFailure("kubectl", result);
  try {
    const value = JSON.parse(result.stdout);
    if (!value || typeof value !== "object") throw Error();
    return value;
  } catch {
    throw Error("Kubernetes response could not be parsed (content hidden)");
  }
}

// A wait for Complete alone also waits the entire timeout after a Job fails.
// Only Complete authorizes publishing; an API error never implies success.
export async function waitForMigration(kube, job, {
  timeoutMs = 310000, now = Date.now, pause = sleep,
} = {}) {
  const deadline = now() + timeoutMs;
  let snapshot;
  while (now() < deadline) {
    try {
      snapshot = read(kube, ["get", `job/${job}`]);
    } catch (error) {
      return { outcome: "unavailable", detail: error.message, snapshot };
    }
    const conditions = snapshot.status?.conditions || [];
    const failed = conditions.find(c =>
      ["Failed", "FailureTarget"].includes(c.type) && c.status === "True");
    if (failed) return { outcome: "failed", detail: reason(failed.reason), snapshot };
    if (conditions.some(c => c.type === "Complete" && c.status === "True"))
      return { outcome: "complete", snapshot };
    await pause(Math.max(0, Math.min(2000, deadline - now())));
  }
  return { outcome: "timeout", detail: "Job completion deadline exceeded", snapshot };
}

const stages = new Set(["validate", "load", "connect", "begin", "lock", "history", "checksum", "apply", "commit"]);
const codes = new Set([
  "DATABASE_URL_INVALID", "CHECKSUM_MISMATCH", "ETIMEDOUT", "ECONNREFUSED",
  "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "CONNECTION_TIMEOUT", "QUERY_TIMEOUT", "UNKNOWN",
]);
export function migrationLogSummary(log) {
  const entries = [];
  for (const line of (log || "").split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry?.event !== "dataport_migration" || !stages.has(entry.stage) ||
          !["started", "complete", "failed"].includes(entry.status)) continue;
      entries.push({ stage: entry.stage, status: entry.status,
        ...(entry.code ? { code: codes.has(entry.code) || /^[0-9A-Z]{5}$/.test(entry.code) ? entry.code : "UNKNOWN" } : {}),
      });
    } catch { /* Old stacks and arbitrary container output are not safe diagnostics. */ }
  }
  return entries.slice(-30);
}

// Project only known status fields. Job/Pod specs, events' free text and raw
// logs can contain credentials, so they must never be printed wholesale.
export function migrationDiagnostics(kube, job, snapshot) {
  const report = { job, conditions: (snapshot?.status?.conditions || []).map(c => ({
    type: ["Complete", "Failed", "FailureTarget", "SuccessCriteriaMet"].includes(c.type) ? c.type : "unknown",
    status: ["True", "False", "Unknown"].includes(c.status) ? c.status : "Unknown",
    reason: reason(c.reason),
  })) };
  try {
    const pods = read(kube, ["get", "pods", "-l", `job-name=${job}`]);
    report.pods = (pods.items || []).map(pod => ({
      phase: ["Pending", "Running", "Succeeded", "Failed", "Unknown"].includes(pod.status?.phase) ? pod.status.phase : "Unknown",
      scheduled: ["True", "False"].includes(pod.status?.conditions?.find(c => c.type === "PodScheduled")?.status)
        ? pod.status.conditions.find(c => c.type === "PodScheduled").status : "Unknown",
      schedulingReason: reason(pod.status?.conditions?.find(c => c.type === "PodScheduled")?.reason),
      containers: (pod.status?.containerStatuses || []).map(c => ({
        state: c.state?.terminated ? "terminated" : c.state?.running ? "running" : "waiting",
        reason: reason(c.state?.terminated?.reason || c.state?.waiting?.reason),
        exitCode: number(c.state?.terminated?.exitCode),
      })),
    }));
  } catch { report.podsUnavailable = true; }
  try {
    // Include only this Job's and its Pods' warning reasons, not other workloads.
    const events = read(kube, ["get", "events", "--field-selector=type=Warning"]);
    report.warnings = [...new Set((events.items || [])
      .filter(e => e.involvedObject?.name === job || e.involvedObject?.name?.startsWith(`${job}-`))
      .map(e => reason(e.reason)))];
  } catch { report.eventsUnavailable = true; }
  const logs = kube(["logs", `job/${job}`, "-c", "migrate", "--tail=100", "--limit-bytes=16384",
    "--pod-running-timeout=5s", "--request-timeout=15s"], { optional: true, timeout: 20000 });
  report.migration = logs.status === 0 && !logs.error ? migrationLogSummary(logs.stdout) : [];
  if (!report.migration.length) report.migrationLogsUnavailable = true;
  return report;
}
