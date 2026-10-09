import { useEffect, useState, useCallback, useRef } from "react";
export async function api(path, mode, body, signal) {
  const response = await fetch(`/api/${path}${mode ? `?mode=${mode}` : ""}`, {
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
const empty = { devices: [], jobs: [], attempts: [], events: [], workers: [] };
export function useSnapshot(mode, onExpired) {
  const [state, setState] = useState(empty),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    reload = useRef(() => {});
  useEffect(() => {
    let alive = true,
      busy = false;
    const controller = new AbortController();
    setState(empty);
    setLoading(true);
    const load = async () => {
      if (busy || !alive) return;
      busy = true;
      try {
        const next = await api("state", mode, null, controller.signal);
        if (alive) {
          setState(next);
          setError("");
        }
      } catch (e) {
        if (alive) {
          setError(e.message);
          if (e.status === 401) onExpired();
        }
      } finally {
        busy = false;
        if (alive) setLoading(false);
      }
    };
    reload.current = load;
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 1500);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [mode, onExpired]);
  return {
    state,
    error,
    loading,
    refresh: useCallback(() => reload.current(), []),
  };
}
export const labels = {
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  unknown: "结果待核验",
  blocked: "依赖阻塞",
  skipped: "已跳过",
  cancelled: "已取消",
  interrupted: "模拟中断",
  idle: "空闲",
  quarantined: "已隔离",
  online: "接口可达",
  offline: "模拟离线",
};
export const time = (value) =>
  value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
export const jobTitle = (j) =>
  j.operation === "search"
    ? `搜索 · ${j.input.keyword}`
    : j.sourceJobId
      ? "详情 · 等待搜索结果"
      : "笔记详情";
