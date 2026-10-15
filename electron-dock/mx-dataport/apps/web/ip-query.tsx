import { riskAdvice } from "./risk-advice";
import { useEffect, useRef, useState } from "react";
import { Search, Download, Clock3, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { PublicIpSearch } from "./public-ip-search";
import { QueryResult, RiskLevel } from "./ip-query-results";
import { BatchQuery } from "./batch-query";
import { request } from "./api";
import { dateTime, portraitState, queryIntent } from "./commerce-state";
import { enterpriseUrl, hasPermission } from "./permissions";
import { Pagination } from "./pagination";
import { downloadExcel } from "./download";

export function IpQuery({
  tenant,
  session,
  csrf,
  go,
  initialIp = "",
}: {
  tenant: string;
  session: any;
  csrf: string;
  go: (page: string) => void;
  initialIp?: string;
}) {
  const [result, setResult] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [history, setHistory] = useState<any>(null),
    [historyError, setHistoryError] = useState(""),
    [page, setPage] = useState(1),
    [q, setQ] = useState(""),
    [version, setVersion] = useState(0),
    [batch, setBatch] = useState(false),
    [showHistory, setShowHistory] = useState(false),
    [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState({ ip: initialIp, revision: 0 }),
    live = useRef(true),
    lock = useRef(false),
    resultRef = useRef<HTMLDivElement>(null);
  const canQuery = hasPermission(session, tenant, "query.execute"),
    canRead = hasPermission(session, tenant, "history.read"),
    canExport = hasPermission(session, tenant, "history.export");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!canRead) return;
    const c = new AbortController();
    setHistory(null);
    setHistoryError("");
    request(
      enterpriseUrl(
        tenant,
        `history?page=${page}&pageSize=5&q=${encodeURIComponent(q)}`,
      ),
      { signal: c.signal },
    )
      .then((v) => {
        if (!c.signal.aborted) setHistory(v.data);
      })
      .catch((e) => {
        if (!c.signal.aborted) setHistoryError(e.message);
      });
    return () => c.abort();
  }, [tenant, page, q, version, canRead]);
  useEffect(() => {
    if (result) {
      resultRef.current?.focus({ preventScroll: true });
      resultRef.current?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    }
  }, [result]);
  async function query(ip: string, fresh = false) {
    if (lock.current || !canQuery) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const intent = queryIntent(
      sessionStorage,
      `${tenant}:${session.memberId}:${ip}`,
    );
    if (fresh) {
      sessionStorage.removeItem(intent.name);
      intent.key = queryIntent(
        sessionStorage,
        `${tenant}:${session.memberId}:${ip}`,
      ).key;
    }
    try {
      const { data } = await request(enterpriseUrl(tenant, "query"), {
        method: "POST",
        headers: { "x-mx-csrf": csrf, "Idempotency-Key": intent.key },
        body: JSON.stringify({ ip }),
        signal: AbortSignal.timeout(120000),
      });
      if (["success", "partial", "no_data"].includes(portraitState(data)))
        sessionStorage.removeItem(intent.name);
      if (live.current) {
        setResult(data);
        setSearch((s) => ({ ip, revision: s.revision + 1 }));
        setPage(1);
        setVersion((v) => v + 1);
      }
    } catch (e) {
      if (live.current)
        setError(
          (e as Error).message +
            " 请先查看历史确认上次结果，重试会沿用原操作编号。",
        );
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function exportHistory() {
    setExporting(true);
    try {
      let items: any[] = [];
      for (let n = 1; ; n++) {
        const { data } = await request(
          enterpriseUrl(
            tenant,
            `history?page=${n}&pageSize=100&q=${encodeURIComponent(q)}&export=1`,
          ),
        );
        items.push(...data.items);
        if (items.length >= data.total) break;
      }
      await downloadExcel(
        "数港查询历史",
        ["IP", "风险等级", "查询时间", "状态", "风险参考建议"],
        items.map((i) => [
          i.ip,
          i.payload?.response?.data?.data?.risk_level || "未提供",
          dateTime(i.createdAt),
          i.payload ? portraitState(i.payload) : "待确认",
          riskAdvice(i.payload?.response?.data?.data?.risk_level),
        ]),
      );
    } catch (e) {
      setHistoryError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="intelligence-page" data-result={!!result}>
      <PublicIpSearch
        key={search.revision}
        initialIp={search.ip}
        consoleView
        showIntro={false}
        validateInput
        available={canQuery && !busy}
        busy={busy}
        busyLabel="查询中"
        hint={
          canQuery
            ? "与企业共享订阅次数；查看历史不消耗次数。"
            : "当前角色仅可查看已授权的历史记录。"
        }
        tools={
          hasPermission(session, tenant, "query.batch") && (
            <Button
              type="button"
              variant="ghost"
              className="query-upload"
              disabled={busy}
              onClick={() => setBatch((v) => !v)}
              aria-expanded={batch}
            >
              <Upload />
              <span>Excel 导入</span>
            </Button>
          )
        }
        onQuery={(ip) => query(ip)}
      >
        {batch && (
          <div className="batch-query-content parity-batch-inline">
            <BatchQuery
              tenant={tenant}
              session={session}
              csrf={csrf}
              onComplete={() => {
                setPage(1);
                setVersion((v) => v + 1);
              }}
            />
          </div>
        )}
      </PublicIpSearch>
      <div className="harbor-query-workspace">
        {error && (
          <p role="alert" className="harbor-error">
            {error}
          </p>
        )}
        {result && (
          <div
            ref={resultRef}
            tabIndex={-1}
            className="harbor-result-focus"
            aria-label="IP 风险画像查询结果"
          >
            <QueryResult
              result={result}
              busy={busy}
              canQuery={canQuery}
              onQueryAgain={() => void query(result.ip, true)}
              onReport={() => {
                sessionStorage.setItem(
                  "dataport:report-error",
                  `IP：${result.ip}\n查询编号：${result.id || result.batchId || ""}\n问题描述：`,
                );
                go("support");
              }}
            />
          </div>
        )}
        {result && canRead && (
          <Button
            className="history-reveal"
            variant="link"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? "收起最近查询" : "查看最近查询"}
          </Button>
        )}
        {canRead && (!result || showHistory) && (
          <Card className="harbor-history">
            <CardHeader className="harbor-history-heading">
              <CardTitle>
                <h2>最近查询</h2>
              </CardTitle>
              <div className="history-tools">
                <div className="dp-history-search">
                  <Search size={16} />
                  <Input
                    aria-label="搜索查询历史"
                    placeholder="搜索 IP 地址"
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                {canExport && (
                  <Button
                    variant="ghost"
                    className="history-export"
                    aria-label="导出查询历史"
                    title="导出查询历史"
                    disabled={exporting || !history?.total}
                    onClick={() => void exportHistory()}
                  >
                    <Download size={16} />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {historyError ? (
                <div className="harbor-empty" role="alert">
                  {historyError}
                  <Button
                    variant="link"
                    onClick={() => setVersion((v) => v + 1)}
                  >
                    重新加载
                  </Button>
                </div>
              ) : !history ? (
                <p className="harbor-empty">正在读取查询记录…</p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>IP 地址</TableHead>
                        <TableHead>查询状态</TableHead>
                        <TableHead>风险等级</TableHead>
                        <TableHead>查询时间</TableHead>
                        <TableHead>
                          <span className="sr-only">操作</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.items.map((i: any) => {
                        const state = i.payload
                          ? portraitState(i.payload)
                          : "unknown";
                        const label =
                          (
                            {
                              success: "成功",
                              partial: "部分数据",
                              no_data: "暂无数据",
                              unknown: "待确认",
                              error: "失败",
                            } as Record<string, string>
                          )[state] || "待确认";
                        return (
                          <TableRow key={i.id}>
                            <TableCell>{i.ip}</TableCell>
                            <TableCell>
                              <span
                                className={`status ${state === "success" ? "good" : state === "error" ? "bad" : "pending"}`}
                              >
                                {label}
                              </span>
                            </TableCell>
                            <TableCell>
                              <RiskLevel
                                level={
                                  i.payload?.response?.data?.data?.risk_level
                                }
                              />
                            </TableCell>
                            <TableCell>{dateTime(i.createdAt)}</TableCell>
                            <TableCell>
                              <Button
                                variant="link"
                                aria-label={`查看 ${i.ip} 的查询记录`}
                                disabled={!i.payload || busy}
                                onClick={() => {
                                  setResult({
                                    ...i.payload,
                                    id: i.id,
                                    historical: true,
                                  });
                                  setSearch((s) => ({
                                    ip: i.ip,
                                    revision: s.revision + 1,
                                  }));
                                }}
                              >
                                详情
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {!history.items.length && (
                    <div className="harbor-history-empty">
                      <Clock3 />
                      <h3>{q ? "没有匹配的查询记录" : "尚无查询记录"}</h3>
                      <p>完成查询后，可在这里回看画像。</p>
                    </div>
                  )}
                  <Pagination
                    label="查询历史"
                    {...history}
                    onChange={setPage}
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
