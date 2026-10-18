import { IpLocationMap } from "./ip-location-map";
import { ipLocation } from "./ip-location";
import { useState } from "react";
import { ArrowRight, Clock3, Copy, Check, Sparkles, Info } from "lucide-react";
import { riskAdvice, riskBand, riskLevelLabel } from "./risk-advice";
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

export function RiskLevel({ level }: { level: unknown }) {
  return (
    <span
      className="harbor-risk-level"
      data-level={String(level || "")}
      data-band={riskBand(level)}
    >
      {riskLevelLabel(level)}
    </span>
  );
}

export function QueryResult({
  result,
  busy,
  canQuery,
  onQueryAgain,
  onReport,
}: {
  result: any;
  busy: boolean;
  canQuery: boolean;
  onQueryAgain: () => void;
  onReport?: () => void;
}) {
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState("");
  const profile = result.response?.data?.data,
    state = portraitState(result);
  const location = ipLocation(profile);
  const issue = result.error || result.response?.error;
  const tagDescriptions: Record<string, string> = {
    行为风险: "请求或访问行为相关的风险线索。",
    关联设备风险: "与该 IP 关联的设备异常线索。",
    恶意事件风险: "与恶意攻击、失陷事件或恶意软件相关的线索。",
    其他标签: "IP 网络属性及其他非威胁行为标签。",
  };
  const tags: Record<string, any[]> = Object.fromEntries(
    Object.keys(tagDescriptions).map((name) => [name, []]),
  );
  const aliases: Record<string, string> = {
    风险行为: "行为风险",
    网络属性: "其他标签",
    基础属性: "其他标签",
    "IP 基础属性": "其他标签",
    IP基础属性: "其他标签",
    IP网络属性: "其他标签",
    归属信息: "其他标签",
    network: "其他标签",
    infrastructure: "其他标签",
  };
  for (const tag of profile?.risk_tags || []) {
    const category = aliases[tag.category] || tag.category || "其他标签";
    (tags[category] ||= []).push(tag);
  }
  const repeatable =
    !result.historical &&
    (["success", "partial", "no_data"].includes(state) ||
      (state === "error" && result.status >= 400 && issue?.code));
  return (
    <Card className="harbor-portrait parity-portrait">
      <CardHeader className="harbor-report-heading risk-report-heading">
        <div>
          <h2>{result.ip || "查询结果"}</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="复制 IP 地址"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(result.ip);
                setCopied(true);
                setCopyError("");
              } catch {
                setCopyError("复制失败，请手动复制 IP 地址。");
              }
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
          <RiskLevel level={profile?.risk_level} />
          <span
            className="harbor-result-state"
            data-state={state}
            hidden={state === "success"}
          >
            {result.historical ? "历史画像" : states[state]}
          </span>
        </div>
        {onReport && (
          <Button variant="link" onClick={onReport}>
            信息报错
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {copyError && <p role="status">{copyError}</p>}
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
            <div className="harbor-profile-overview risk-profile">
              <div className="harbor-profile-summary">
                <div
                  className="harbor-risk-summary"
                  data-level={String(profile.risk_level || "")}
                  data-band={riskBand(profile.risk_level)}
                >
                  <div
                    className="risk-score"
                    data-risk={riskBand(profile.risk_level)}
                    data-display="level"
                    role="img"
                    aria-label={`风险等级 ${riskLevelLabel(profile.risk_level)}`}
                  >
                    <svg viewBox="0 0 120 120" aria-hidden="true">
                      <circle
                        className="risk-score-track"
                        cx="60"
                        cy="60"
                        r="51"
                      />
                      <circle
                        className="risk-score-progress"
                        cx="60"
                        cy="60"
                        r="51"
                        pathLength="100"
                        strokeDasharray="100 100"
                      />
                    </svg>
                    <div>
                      <strong>
                        {riskLevelLabel(profile.risk_level)}
                      </strong>
                      <span>风险等级</span>
                    </div>
                  </div>
                  {profile.risk_score != null && (
                    <small>风险评分 {profile.risk_score}</small>
                  )}
                </div>
                <dl className="harbor-profile-fields">
                  {[
                    [
                      "归属地",
                      [
                        profile.country,
                        profile.province,
                        profile.city,
                        profile.district,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    ],
                    ["应用场景", profile.scene],
                    ["运营商", profile.isp],
                    ["归属机构", profile.organization],
                    [
                      "经纬度",
                      location ? `${location.lng}, ${location.lat}` : null,
                    ],
                    ["更新时间", profile.data_date],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{valueText(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <IpLocationMap
                key={`${result.ip}:${result.response?.meta?.capturedAt}`}
                profile={profile}
              />
            </div>
            <section
              className="harbor-tag-section risk-report-overview"
              aria-label="风险标签"
            >
              <h3>风险标签</h3>
              {Object.keys(tags).length ? (
                <div className="harbor-tag-groups risk-tag-groups">
                  {Object.entries(tags).map(([category, values]) => (
                    <section key={category}>
                      <h4>
                        {category}
                        <span
                          className="risk-category-help"
                          tabIndex={0}
                          aria-label={`${category}说明：仅展示接口已返回的标签，未返回不代表无风险。`}
                          title="仅展示接口已返回的标签，未返回不代表无风险。"
                        >
                          <Info size={13} />
                        </span>
                      </h4>
                      <div className="harbor-risk-tags">
                        {!values.length && (
                          <span
                            className="parity-tag-missing"
                            title="未返回此类标签，不代表无风险。"
                          >
                            未返回此类标签
                          </span>
                        )}
                        {values.map((tag, index) => (
                          <span
                            key={index}
                            data-neutral={[
                              "网络属性",
                              "基础属性",
                              "IP 基础属性",
                              "IP基础属性",
                              "IP网络属性",
                              "归属信息",
                              "network",
                              "infrastructure",
                            ].includes(tag.category)}
                            title={tag.description || undefined}
                          >
                            {tag.name || tag.code || "未命名标签"}
                          </span>
                        ))}
                      </div>
                      <p>
                        {tagDescriptions[category] ||
                          "数据源提供的其他分类标签。"}
                      </p>
                    </section>
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
            <section className="dp-risk-advice risk-advice-summary">
              <div className="ai-advice-heading">
                <span className="ai-advice-symbol">
                  <Sparkles aria-hidden="true" />
                </span>
                <h3>风险参考建议</h3>
              </div>
              <p>{riskAdvice(profile.risk_level)}</p>
              <small>
                当前建议依据风险等级规则生成，AI
                模型尚未接入。仅供业务风控参考。
              </small>
            </section>
          </>
        ) : (
          <p className="harbor-result-message">
            本次没有可用画像，不代表无风险。
          </p>
        )}
        <details className="harbor-record-details parity-record-details">
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
        {!!history.length && (
          <p className="harbor-hint" aria-live="polite">
            已显示 {history.length} 条
            {more ? "，可继续加载更早记录。" : "，已显示全部记录。"}
          </p>
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
