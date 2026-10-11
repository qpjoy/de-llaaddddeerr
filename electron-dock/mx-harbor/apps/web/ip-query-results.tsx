import { IpLocationMap } from "./ip-location-map";
import { ArrowRight, Clock3, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { dateTime, portraitState } from "./commerce-state";

const states: Record<string, string> = {
  success: "查询成功",
  partial: "部分数据",
  no_data: "暂无数据",
  unknown: "结果待核对",
  error: "查询失败",
};
const valueText = (value: unknown) =>
  value == null || value === "" ? "未提供" : String(value);

function RiskLevel({ level }: { level: unknown }) {
  return (
    <span className="harbor-risk-level" data-level={String(level || "")}>
      {valueText(level)}
    </span>
  );
}

export function QueryResult({
  result,
  busy,
  canQuery,
  onQueryAgain,
}: {
  result: any;
  busy: boolean;
  canQuery: boolean;
  onQueryAgain: () => void;
}) {
  const profile = result.response?.data?.data,
    state = portraitState(result);
  const issue = result.error || result.response?.error;
  const tags: Record<string, any[]> = Object.create(null);
  for (const tag of profile?.risk_tags || []) {
    const category = tag.category || "其他标签";
    (tags[category] ||= []).push(tag);
  }
  const repeatable =
    !result.historical &&
    (["success", "partial", "no_data"].includes(state) ||
      (state === "error" && result.status >= 400 && issue?.code));
  return (
    <Card className="harbor-portrait">
      <CardHeader className="harbor-report-heading">
        <div>
          <h2>{result.ip || "查询结果"}</h2>
          <span className="harbor-result-state" data-state={state}>
            {result.historical ? "历史画像" : states[state]}
          </span>
        </div>
        <time>{dateTime(result.response?.meta?.capturedAt)}</time>
      </CardHeader>
      <CardContent>
        {issue ? (
          <div className="harbor-result-message" role="status">
            <h3>{states[state]}</h3>
            <p>
              {state === "unknown"
                ? "本次查询仍待确认，请保留原查询，在最近查询中查看后续结果。"
                : "本次未取得可用画像，请查看查询详情。"}
            </p>
          </div>
        ) : profile ? (
          <>
            <div className="harbor-profile-overview">
              <div className="harbor-risk-summary">
                <ShieldCheck aria-hidden="true" />
                <span>风险等级</span>
                <RiskLevel level={profile.risk_level} />
                {profile.risk_score != null && (
                  <small>风险评分 {profile.risk_score}</small>
                )}
              </div>
              <dl className="harbor-profile-fields">
                {[
                  [
                    "归属地",
                    [profile.country, profile.province, profile.city]
                      .filter(Boolean)
                      .join(" · "),
                  ],
                  ["运营商", profile.isp],
                  ["应用场景", profile.scene],
                  ["代理类型", profile.proxy_type],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{valueText(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <IpLocationMap key={`${result.ip}:${result.response?.meta?.capturedAt}`} profile={profile} />
            <section className="harbor-tag-section" aria-label="风险标签">
              <h3>风险标签</h3>
              {Object.keys(tags).length ? (
                <div className="harbor-tag-groups">
                  {Object.entries(tags).map(([category, values]) => (
                    <div key={category}>
                      <h4>{category}</h4>
                      <div className="harbor-risk-tags">
                        {values.map((tag, index) => (
                          <span key={index}>
                            {tag.name || tag.code || "未命名标签"}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="harbor-muted">
                  {profile.risk_tags == null
                    ? "未提供标签信息"
                    : "本次未返回风险标签"}
                  ，不代表无风险。
                </p>
              )}
            </section>
          </>
        ) : (
          <p className="harbor-result-message">
            本次没有可用画像，不代表无风险。
          </p>
        )}
        <details className="harbor-record-details">
          <summary>查询详情</summary>
          <p>查询时间：{dateTime(result.response?.meta?.capturedAt)}</p>
          <p>
            请求编号：{result.response?.requestId || result.batchId || "未返回"}
          </p>
          {issue && (
            <p>
              {issue.message} · {issue.code}
            </p>
          )}
          {repeatable && (
            <div className="harbor-query-repeat">
              <p>重新查询将获取最新画像，成功后计入本期次数。</p>
              <Button
                variant="outline"
                disabled={busy || !canQuery}
                onClick={onQueryAgain}
              >
                重新查询此 IP
              </Button>
            </div>
          )}
        </details>
      </CardContent>
    </Card>
  );
}

export function QueryHistory({
  history,
  loading,
  error,
  busy,
  more,
  onRetry,
  onMore,
  onOpen,
}: {
  history: any[];
  loading: boolean;
  error: string;
  busy: boolean;
  more: boolean;
  onRetry: () => void;
  onMore: () => void;
  onOpen: (item: any) => void;
}) {
  return (
    <Card className="harbor-history">
      <CardHeader className="harbor-history-heading">
        <CardTitle>
          <h2>最近查询</h2>
        </CardTitle>
        <span>回看不消耗次数</span>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="harbor-inline-issue" role="status">
            <span>查询记录暂时无法加载。</span>
            <Button
              variant="link"
              size="sm"
              disabled={busy || loading}
              onClick={onRetry}
            >
              重新加载
            </Button>
          </div>
        )}
        {loading && !history.length ? (
          <p className="harbor-empty" role="status">
            正在读取查询记录…
          </p>
        ) : history.length ? (
          <Table className="harbor-history-table">
            <TableHeader>
              <TableRow>
                <TableHead>IP 地址</TableHead>
                <TableHead>风险等级</TableHead>
                <TableHead>查询状态</TableHead>
                <TableHead>查询时间</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="harbor-history-ip">
                    {item.ip || "批次查询"}
                  </TableCell>
                  <TableCell>
                    <RiskLevel level={item.profile?.risk_level} />
                  </TableCell>
                  <TableCell>
                    <span
                      className="harbor-result-state"
                      data-state={item.state}
                    >
                      {states[item.state] || "查询失败"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <time>{dateTime(item.createdAt)}</time>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="link"
                      size="sm"
                      disabled={busy || !item.available}
                      aria-label={`查看 ${item.ip || "批次"} 的查询记录`}
                      onClick={() => onOpen(item)}
                    >
                      查看 <ArrowRight aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          !error && (
            <div className="harbor-history-empty">
              <Clock3 aria-hidden="true" />
              <h3>尚无查询记录</h3>
              <p>完成查询后，可在这里回看画像。</p>
            </div>
          )
        )}
        {more && (
          <div className="harbor-history-more">
            <Button variant="ghost" disabled={busy || loading} onClick={onMore}>
              {loading ? "正在读取…" : "更多记录"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
