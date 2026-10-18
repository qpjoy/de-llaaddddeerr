import { useEffect, useState, useCallback, useRef } from "react";
import { applyPatch } from "../server/state-patch.mjs";
// Embedded behind a Hub reverse proxy (V2-5) the page lives under the
// proxy's prefix, so API calls are relative to it: /device-center/api/… is
// forwarded to /embed/api/…. The server marks the embedded page.
export const EMBEDDED =
  typeof document !== "undefined" &&
  !!document.querySelector('meta[name="mx-embed"]');
const API = EMBEDDED ? "api/" : "/api/";
export async function api(path, mode, body, signal) {
  const query = mode ? `${path.includes("?") ? "&" : "?"}mode=${mode}` : "";
  const response = await fetch(`${API}${path}${query}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000),
  });
  const value = await response.json();
  if (!response.ok) {
    const e = Error(value.error || "请求失败");
    e.status = response.status;
    throw e;
  }
  return value;
}
const empty = {
  devices: [],
  jobs: [],
  attempts: [],
  events: [],
  workers: [],
  resources: [],
  apps: [],
  definitions: [],
  commandDefinitions: [],
  ruleDefinitions: [],
  strategyDefinitions: [],
  commands: [],
  loopPolicies: [],
};
/** Live state of one realm. Prefers the SSE stream (a snapshot, then
 * patches applied to a local model); falls back to polling /api/state every
 * 1.5 s when streaming is unavailable. live: "stream" | "poll" | "connecting". */
export function useSnapshot(mode, onExpired) {
  const [state, setState] = useState(empty),
    [stateMode, setStateMode] = useState(mode),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [live, setLive] = useState("connecting"),
    reload = useRef(() => Promise.resolve());
  useEffect(() => {
    let alive = true,
      busy = false,
      timer = null,
      source = null,
      model = null,
      waiters = [];
    const controller = new AbortController();
    setState(empty);
    setStateMode(mode);
    setError("");
    setLoading(true);
    setLive("connecting");
    const show = (next) => {
      model = next;
      setState(next);
      setError("");
      setLoading(false);
      for (const resolve of waiters.splice(0)) resolve();
    };
    const load = async () => {
      if (busy || !alive) return;
      busy = true;
      try {
        const next = await api("state", mode, null, controller.signal);
        if (alive) show(next);
      } catch (e) {
        if (alive) {
          setError(e.message);
          setLoading(false);
          if (e.status === 401) onExpired();
        }
      } finally {
        busy = false;
      }
    };
    const poll = () => {
      if (timer || !alive) return;
      setLive("poll");
      void load();
      timer = setInterval(() => {
        if (!document.hidden) void load();
      }, 1500);
    };
    if (typeof EventSource === "function") {
      let failures = 0;
      source = new EventSource(`${API}stream?mode=${mode}`);
      source.addEventListener("snapshot", (e) => {
        failures = 0;
        setLive("stream");
        show(JSON.parse(e.data).state);
      });
      source.addEventListener("patch", (e) => {
        if (model) show(applyPatch(model, JSON.parse(e.data)));
      });
      source.onerror = () => {
        // The browser retries on its own; give up after repeated failures
        // (or a refused stream) and poll instead, which also detects 401.
        if (source.readyState === EventSource.CLOSED || ++failures >= 3) {
          source.close();
          source = null;
          poll();
        }
      };
    } else poll();
    // After an action: the server pushes the change; wait for it (or poll).
    reload.current = () =>
      source
        ? new Promise((resolve) => {
            waiters.push(resolve);
            setTimeout(resolve, 1500);
          })
        : load();
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      source?.close();
      for (const resolve of waiters.splice(0)) resolve();
    };
  }, [mode, onExpired]);
  return {
    state: stateMode === mode ? state : empty,
    error: stateMode === mode ? error : "",
    loading: stateMode !== mode || loading,
    live,
    refresh: useCallback(() => reload.current(), []),
  };
}
export const labels = {
  queued: "排队中",
  running: "执行中",
  yielded: "检查点等待",
  succeeded: "已完成",
  failed: "业务输入未满足",
  unknown: "结果待核验",
  blocked: "依赖阻塞",
  skipped: "已跳过",
  cancelled: "已取消",
  expired: "已过期",
  stopping: "停止中",
  planned: "已计划",
  interrupted: "模拟中断",
  idle: "空闲",
  quarantined: "已隔离",
  online: "接口可达",
  offline: "模拟离线",
};
export const time = (value) =>
  value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
export const appName = (appId = "xhs") =>
  ({ xhs: "小红书", weibo: "微博", xianyu: "闲鱼", pdd: "拼多多" })[appId] ||
  appId;
const operationTitle = (j) =>
  j.operation === "search"
    ? `搜索 · ${j.input.keyword}`
    : j.sourceJobId
      ? "详情 · 搜索结果"
      : "笔记详情";

export const jobTitle = (j) =>
  j.workflow ? j.workflow.name : `${appName(j.appId)} · ${operationTitle(j)}`;

export {
  defaultDurationMs,
  estimatedDuration,
  taskLane,
} from "../server/task-contract.mjs";
