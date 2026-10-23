import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { request } from "./api";
import { enterpriseUrl } from "./permissions";

export type Assessment = { status: string; text?: string | null; error?: string | null; retryAfterMs?: number; canPoll?: boolean };
const pending = new Set(["created", "submitting", "queued", "running", "retrying", "resuming", "pausing"]);
const messages: Record<string, string> = {
  loading: "正在读取 AI 分析…",
  submitting: "正在提交 AI 分析…",
  created: "AI 分析任务已创建。",
  queued: "AI 分析排队中…",
  running: "AI 正在分析此 IP 画像…",
  retrying: "AI 分析任务正在重试…",
  resuming: "AI 分析正在恢复…",
  pausing: "AI 分析正在暂停…",
  paused: "AI 分析已暂停，待平台处理后可查看最新状态。",
  canceled: "AI 分析已取消。",
  stale: "AI 分析已中断。",
  failed: "AI 分析未完成，原始画像仍可正常查看。",
  unavailable: "AI 分析暂不可用，原始画像仍可正常查看。",
  not_configured: "AI 分析尚未配置，原始画像仍可正常查看。",
  not_requested: "此历史记录尚未生成 AI 分析。",
  not_applicable: "本次没有可供 AI 分析的有效画像。",
  submission_unknown: "AI 任务是否受理尚未确认，系统不会重复提交。请联系管理员核对。",
  denied: "当前账号无权查看此分析。",
};
export function AiAssessment({ tenant, queryId, initial }: { tenant?: string; queryId?: string; initial?: Assessment }) {
  const [value, setValue] = useState<Assessment>(initial || { status: "loading" });
  const [waiting, setWaiting] = useState(false), [version, setVersion] = useState(0);
  useEffect(() => {
    if (!tenant || !/^[0-9a-f-]{36}$/i.test(queryId || "")) {
      setValue({status:"not_requested"}); return;
    }
    const controller = new AbortController(), deadline = Date.now() + 120000;
    let timer: ReturnType<typeof setTimeout>, failures = 0;
    setValue(initial || {status:"loading"}); setWaiting(false);
    async function poll() {
      try {
        const response = await request<{data:Assessment}>(enterpriseUrl(tenant!, `assessments/${queryId}`), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        if (controller.signal.aborted) return;
        const next = response.data;
        setValue(next);
        failures = next.error && pending.has(next.status) ? failures + 1 : 0;
        if (!pending.has(next.status)) return;
        if (Date.now() >= deadline || failures >= 6) { setWaiting(true); return; }
        timer = setTimeout(poll, Math.max(1500, Math.min(30000, next.retryAfterMs || 2000)));
      } catch (error) {
        if (controller.signal.aborted) return;
        if ([401,403,404].includes((error as {status?:number}).status || 0)) {
          setValue({status:"denied"});return;
        }
        if (++failures >= 6 || Date.now() >= deadline) {
          setValue(current=>({...current,error:"poll_unavailable"}));setWaiting(true);return;
        }
        timer = setTimeout(poll, Math.min(30000, 1000 * 2 ** failures));
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tenant, queryId, version]);
  return (
    <div aria-live="polite" aria-atomic="true">
      {value.status === "succeeded" && value.text
        ? <p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{value.text}</p>
        : <p>{messages[value.status] || "AI 分析状态待确认。"}</p>}
      {waiting && <p>本次等待已结束，任务仍可能继续执行。稍后可继续查看，无需重新查询 IP。</p>}
      {(waiting || value.status === "paused" || value.error === "configuration_unavailable" || (value.status === "submission_unknown" && value.canPoll)) && (
        <Button variant="outline" size="sm" onClick={()=>setVersion(v=>v+1)}>继续查看分析</Button>
      )}
    </div>
  );
}
