import { mobileOrigin, serialNumber } from "./model.mjs";

const text = (v, max = 120) =>
  typeof v === "string"
    ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max)
    : "";
const object = (v) => v && typeof v === "object" && !Array.isArray(v);

async function readJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (
      r.status !== 200 ||
      r.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      throw Error("Invalid status response");
    const chunks = [];
    let size = 0;
    for await (const part of r.body) {
      size += part.length;
      if (size > 512 * 1024) throw Error("Status response too large");
      chunks.push(part);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

// Only read cached device metadata and runner summaries. Never use /api/state,
// refresh=1, task/config/action endpoints, or return upstream logs/configuration.
export async function inspectMobile(device, fetchImpl = fetch) {
  if (device.mode !== "real" || !device.observer)
    throw Error("Real observer required");
  const origin = mobileOrigin(device.observer.origin),
    serial = serialNumber(device.observer.serial);
  const [detail, runners] = await Promise.allSettled([
    readJson(
      new URL(`/api/devices/${encodeURIComponent(serial)}`, origin),
      fetchImpl,
    ),
    readJson(new URL("/api/run", origin), fetchImpl),
  ]);
  const raw = detail.status === "fulfilled" ? detail.value?.device : null;
  const found = object(raw) && raw.serial === serial;
  const runs = runners.status === "fulfilled" ? runners.value : null;
  const wellFormed =
    object(runs) &&
    Array.isArray(runs.runs) &&
    runs.runs.length <= 128 &&
    object(runs.legacy) &&
    [...runs.runs, runs.legacy].every(
      (r) => object(r) && typeof r.running === "boolean" && object(r.meta),
    );
  const entries = wellFormed ? [...runs.runs, runs.legacy] : [];
  const running = entries.filter((r) => r.running);
  const own = running.filter(
    (r) => (r.meta.device_serial || r.meta.device) === serial,
  );
  const unattributed = running.some(
    (r) =>
      typeof (r.meta.device_serial || r.meta.device) !== "string" ||
      !(r.meta.device_serial || r.meta.device),
  );
  const taskId =
    found &&
    Number.isSafeInteger(raw.current_task_id) &&
    raw.current_task_id > 0
      ? raw.current_task_id
      : null;
  const noTask =
    found &&
    Object.hasOwn(raw, "current_task_id") &&
    raw.current_task_id === null;
  const occupied = taskId !== null || own.length > 0;
  const battery =
    found && /^(100|[1-9]?\d)%$/.test(raw.battery_level)
      ? raw.battery_level
      : "";
  return {
    deviceRecord: found ? "available" : "unavailable",
    runnerReport: wellFormed ? "available" : "unavailable",
    serial,
    connection:
      found && ["online", "offline"].includes(raw.status)
        ? raw.status
        : "unknown",
    model: found ? text(raw.model, 80) : "",
    androidVersion: found ? text(raw.android_version, 30) : "",
    resolution:
      found && /^\d{2,5}x\d{2,5}$/.test(raw.resolution) ? raw.resolution : "",
    battery,
    currentApp:
      found &&
      typeof raw.current_app === "string" &&
      /^[a-zA-Z0-9_.]{1,160}$/.test(raw.current_app)
        ? raw.current_app
        : "",
    lastSeenRaw: found ? text(raw.last_seen_at, 80) : "",
    taskId,
    runningCount: wellFormed ? own.length : null,
    occupancy: occupied
      ? "reported-busy"
      : noTask && wellFormed && !unattributed
        ? "not-reported"
        : "unknown",
    unassignedRunner: unattributed,
    controlAuthority: "unverified",
  };
}
