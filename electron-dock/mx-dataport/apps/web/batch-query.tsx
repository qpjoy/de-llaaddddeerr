import { useEffect, useRef, useState } from "react";
import { Upload, Download, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { request, validIpv4 } from "./api";
import { enterpriseUrl, hasPermission } from "./permissions";
import { runBatchRows, type BatchRow } from "./batch-runner";
import { downloadExcel } from "./download";
import { riskAdvice, riskLevelLabel } from "./risk-advice";
import { AiAssessment } from "./ai-assessment";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog";
export function BatchQuery({
  tenant,
  session,
  csrf,
  onComplete,
}: {
  tenant: string;
  session: any;
  csrf: string;
  onComplete: () => void;
}) {
  const [rows, setRows] = useState<BatchRow[]>([]),
    [busy, setBusy] = useState(false),
    [running, setRunning] = useState(false),
    [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<any>(null);
  const stop = useRef(false),
    alive = useRef(true),
    lock = useRef(false),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
    };
  }, []);
  async function load(file: File) {
    setError("");
    if (file.size > 5 * 1024 * 1024) {
      setError("文件不能超过 5 MB。");
      return;
    }
    if (!/\.xlsx?$/i.test(file.name)) {
      setError("请上传 .xlsx 或 .xls 文件。");
      return;
    }
    setBusy(true);
    try {
      const { parseIpWorkbook } = await import("./batch-ips");
      setRows(
        parseIpWorkbook(await file.arrayBuffer()).map((ip) => ({
          ip,
          intent: crypto.randomUUID(),
          status: validIpv4(ip) ? "待查询" : "格式错误",
        })),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  async function run() {
    if (lock.current) return;
    lock.current = true;
    stop.current = false;
    setRunning(true);
    setError("");
    try {
      await runBatchRows(
        rows,
        async (row) => {
          const { data } = await request(enterpriseUrl(tenant, "query"), {
            method: "POST",
            headers: { "x-mx-csrf": csrf, "Idempotency-Key": row.intent },
            body: JSON.stringify({ ip: row.ip, batch: true }),
            signal: AbortSignal.timeout(120000),
          });
          return data;
        },
        () => stop.current,
        (next) => {
          if (alive.current) setRows(next);
        },
      );
    } finally {
      lock.current = false;
      if (alive.current) {
        setRunning(false);
        onComplete();
      }
    }
  }
  const validRows = rows.filter((r) => r.status !== "格式错误");
  const invalidCount = rows.length - validRows.length;
  const done = validRows.filter(
    (r) => !["待查询", "查询中"].includes(r.status),
  ).length;
  return (
    <Card className="dp-batch-panel">
      <CardContent>
        <p className="parity-batch-instructions">
          上传 .xlsx / .xls 文件，第一行为 IP 列。最多 500 行、5 MB，重复 IP
          自动合并。
        </p>
        <div className="dp-toolbar">
          <Button
            variant="outline"
            disabled={busy || running}
            onClick={() => input.current?.click()}
          >
            <Upload size={16} />
            上传文件
          </Button>
          <Button
            variant="outline"
            disabled={busy || running}
            onClick={() =>
              void downloadExcel("IP批量查询模板", ["IP"], [["8.8.8.8"]]).catch(
                (e) => setError(e.message),
              )
            }
          >
            下载模板
          </Button>
          {rows.length > 0 &&
            hasPermission(session, tenant, "history.export") && (
              <Button
                variant="outline"
                disabled={busy || running}
                onClick={() =>
                  void downloadExcel(
                    "IP批量查询结果",
                    ["IP", "状态", "风险等级", "参考建议", "错误"],
                    rows.map((r) => [
                      r.ip,
                      r.status,
                      r.result
                        ? riskLevelLabel(
                            r.result.response?.data?.data?.risk_level,
                          )
                        : "—",
                      r.result
                        ? riskAdvice(r.result.response?.data?.data?.risk_level)
                        : "",
                      r.error || r.result?.error?.message || "",
                    ]),
                  ).catch((e) => setError(e.message))
                }
              >
                <Download size={16} />
                导出结果
              </Button>
            )}
        </div>
        <input
          ref={input}
          hidden
          type="file"
          accept=".xlsx,.xls"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void load(file);
          }}
        />
        <p className="harbor-hint">
          每个 IP 分别查询并消耗企业额度；遇到渠道限流或防重复保护时暂停后续查询，不会自动重试。
        </p>
        {error && (
          <p role="alert" className="harbor-error">
            {error}
          </p>
        )}
        {rows.length > 0 && (
          <>
            <div className="dp-toolbar">
              <span aria-live="polite">
                已完成 {done} / {validRows.length} 条
                {invalidCount > 0 && ` · 格式错误 ${invalidCount} 条（不参与查询）`}
              </span>
              <progress
                max={validRows.length || 1}
                value={done}
                aria-label="批量查询进度"
              />
              {running ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    stop.current = true;
                  }}
                >
                  <Square size={14} />
                  停止后续查询
                </Button>
              ) : (
                <Button
                  disabled={
                    !rows.some((r) => r.status === "待查询") ||
                    !hasPermission(session, tenant, "query.batch")
                  }
                  onClick={() => void run()}
                >
                  开始查询
                </Button>
              )}
            </div>
            <div className="dp-batch-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>IP 地址</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>风险等级</TableHead>
                    <TableHead>AI 分析</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.ip}>
                      <TableCell>
                        <code>{r.ip}</code>
                      </TableCell>
                      <TableCell>
                        {r.status}
                        {r.error && <small>{r.error}</small>}
                      </TableCell>
                      <TableCell>
                        {r.result
                          ? riskLevelLabel(
                              r.result.response?.data?.data?.risk_level,
                            )
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Button variant="link" disabled={!r.result?.id} onClick={()=>setAnalysis(r.result)}>查看分析</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        <Dialog open={!!analysis} onOpenChange={open=>{if(!open)setAnalysis(null);}}>
          <DialogContent>
            <DialogHeader><DialogTitle>{analysis?.ip} · AI 风险分析</DialogTitle></DialogHeader>
            {analysis && <AiAssessment key={analysis.id} tenant={tenant} queryId={analysis.id} initial={analysis.aiAnalysis} />}
            <small>AI 分析基于本次查询画像生成，仅供业务风控参考。</small>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
