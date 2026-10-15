import { hasPermission, enterpriseUrl } from "./permissions";
import { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { request } from "./api";
import { Pagination, useLocalPage } from "./pagination";
import { dateTime, hasCapability, type Subscription } from "./commerce-state";

const roleNames: Record<string, string> = {
  owner: "所有者",
  admin: "管理员",
  billing: "财务",
  analyst: "分析员",
  viewer: "只读成员",
};
const capabilityNames: Record<string, string> = {
  "tenant.read": "查看空间",
  "tenant.write": "编辑空间",
  "consumer.read": "查看服务身份",
  "consumer.write": "管理服务身份",
  "apikey.read": "查看 API Keys",
  "apikey.write": "管理 API Keys",
  "usage.read": "查看用量",
  "membership.write": "管理成员权限",
  "billing.read": "查看订阅与订单",
  "recharge.create": "创建付款订单",
  "invoice.request": "申请发票",
};
const meterName = (key: string) =>
  key === "ip.risk.subscription.product" ||
  key === "ip.risk.subscription.v2" ||
  key === "ip.risk.subscription.query"
    ? "IP 风险画像 · 空间订阅"
    : key;
const n = (value: number) => value.toLocaleString("zh-CN");
function Heading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}

export function UsageOverview({
  tenant,
  session,
  go,
}: {
  tenant: string;
  session: any;
  go: (page: string) => void;
}) {
  const [days, setDays] = useState("7"),
    [version, setVersion] = useState(0);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(
      null,
    ),
    [subscriptionError, setSubscriptionError] = useState("");
  const [subscriptionCount, setSubscriptionCount] = useState(0);
  const meters = useLocalPage<[string, any]>(
    Object.entries(data?.meters || {}),
    10,
  );
  const canRead = hasPermission(session, tenant, "usage.read"),
    canBill = hasPermission(session, tenant, "subscriptions.read");
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    setSubscriptions(null);
    setSubscriptionError("");
    setSubscriptionCount(0);
    if (!tenant || !canRead) return;
    request(
      `/bff/v1/me/usage?tenantId=${encodeURIComponent(tenant)}&days=${days}`,
    )
      .then(({ data }) => {
        if (active) setData(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    if (canBill)
      request(enterpriseUrl(tenant, "subscriptions?pageSize=20"))
        .then(({ data }) => {
          if (active) {
            setSubscriptions(data.subscriptions);
            setSubscriptionCount(
              data.summary?.activeSubscriptionCount ??
                data.subscriptions.filter(
                  (s: Subscription) =>
                    Date.parse(s.startsAt) <= Date.now() &&
                    Date.parse(s.endsAt) > Date.now(),
                ).length,
            );
          }
        })
        .catch((e) => {
          if (active) setSubscriptionError(e.message);
        });
    return () => {
      active = false;
    };
  }, [tenant, canRead, canBill, days, version]);
  const daily = data
    ? Array.from({ length: data.days }, (_, i) => {
        const day = new Date(data.from);
        day.setUTCDate(day.getUTCDate() + i);
        const stamp = day.toISOString().slice(0, 10);
        return {
          day: stamp,
          requests: 0,
          committed: 0,
          ...data.daily.find((item: any) => item.day === stamp),
        };
      })
    : [];
  const max = Math.max(1, ...daily.map((day) => day.requests));
  const current = subscriptions?.filter(
    (s) =>
      new Date(s.startsAt) <= new Date() && new Date(s.endsAt) > new Date(),
  );
  const primary = current?.find((s) => s.selected) || current?.[0];
  return (
    <>
      <Heading title="用量概览" description="查看调用趋势与当前订阅额度。">
        <div className="overview-tools">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger aria-label="时间范围">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">近 7 天</SelectItem>
              <SelectItem value="30">近 30 天</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新用量"
            disabled={!canRead || (!data && !error)}
            onClick={() => setVersion((v) => v + 1)}
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </Heading>
      {!canRead ? (
        <p className="harbor-empty">当前企业未授予用量查看权限。</p>
      ) : error ? (
        <p className="harbor-error" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p className="harbor-empty">正在读取用量…</p>
      ) : (
        <>
          <div className="usage-metrics">
            {[
              {
                label: "调用请求",
                value: data.requests,
                icon: Activity,
                note: "所选时间范围内",
              },
              {
                label: "已完成",
                value: data.committed,
                icon: CheckCircle2,
                note: "成功返回的调用结果",
              },
              {
                label: "未完成",
                value: data.released,
                icon: XCircle,
                note: "未完成并已释放的请求",
              },
              {
                label: "处理中 / 待确认",
                value: data.pending + data.unknown,
                icon: Clock3,
                note: `${n(data.pending)} 次处理中 · ${n(data.unknown)} 次待确认`,
              },
            ].map(({ label, value, icon: Icon, note }) => (
              <section className="panel" key={label}>
                <div>
                  <span>{label}</span>
                  <Icon />
                </div>
                <strong>
                  {n(value)}
                  <small> 次</small>
                </strong>
                <p>{note}</p>
              </section>
            ))}
          </div>
          <section className="panel">
            <h3>调用趋势</h3>
            <p className="muted">
              按 UTC 自然日统计 · 截至 {dateTime(data.to)}
            </p>
            <div
              className="usage-trend"
              role="img"
              aria-label={daily
                .map((d) => `${d.day}：${d.requests} 次`)
                .join("；")}
            >
              {daily.map((day) => (
                <div key={day.day}>
                  <span>{n(day.requests)}</span>
                  <div className="usage-bar-track">
                    <i style={{ height: `${(day.requests / max) * 100}%` }} />
                  </div>
                  <small>{day.day.slice(5)}</small>
                </div>
              ))}
            </div>
            <p className="muted">
              调用次数与订阅消耗分别统计；回看历史不发起新查询。
            </p>
          </section>
          <div className="usage-bottom">
            <section className="panel subscription-current">
              <div className="section-title">
                <h3>本期订阅</h3>
                {hasPermission(session, tenant, "subscriptions.buy") && (
                  <button className="text-link" onClick={() => go("market")}>
                    升级订阅
                  </button>
                )}
              </div>
              {!canBill ? (
                <p>当前角色没有订阅查看权限。</p>
              ) : subscriptionError ? (
                <p role="alert">{subscriptionError}</p>
              ) : !subscriptions ? (
                <p>正在加载…</p>
              ) : primary ? (
                <div className="subscription-entry">
                  <h2>{primary.product?.name || "IP 风险画像 · 企业订阅"}</h2>
                  <p className="subscription-count">
                    <strong>{n(primary.used)}</strong> / {n(primary.quota)}{" "}
                    次已用
                  </p>
                  <progress
                    max={primary.quota}
                    value={primary.used + primary.held}
                  />
                  <p>
                    剩余{" "}
                    {n(
                      Math.max(0, primary.quota - primary.used - primary.held),
                    )}{" "}
                    次 · 待确认 {n(primary.held)} 次
                  </p>
                  <p>{dateTime(primary.endsAt)} 到期</p>
                </div>
              ) : (
                <p>暂无有效订阅，可选择套餐领取试用或购买订阅。</p>
              )}
              {canBill && (
                <Button variant="outline" onClick={() => go("services")}>
                  查看全部订阅
                  {subscriptionCount > 1 ? `（${subscriptionCount} 份）` : ""}
                </Button>
              )}
            </section>
            <section className="panel">
              <h3>服务用量</h3>
              <Table className="simple-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>数据服务</TableHead>
                    <TableHead>调用</TableHead>
                    <TableHead>已完成</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {meters.items.map(([key, entry]: any) => (
                    <TableRow key={key}>
                      <TableCell>{meterName(key)}</TableCell>
                      <TableCell>{n(entry.requests)}</TableCell>
                      <TableCell>{n(entry.committed)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {Object.keys(data.meters).length > 10 && (
                <Pagination
                  label="服务用量"
                  {...meters.pagination}
                  onChange={meters.setPage}
                />
              )}{" "}
              {!Object.keys(data.meters).length && (
                <p className="muted">所选时间范围内暂无调用。</p>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}

export function SpacePermissions({ tenant, session }: { tenant: string; session: any }) {
  const [data, setData] = useState<any>(null), [error, setError] = useState(""), [version, setVersion] = useState(0);
  const members = useLocalPage<any>(data?.members || [], 20);
  useEffect(() => {
    let active = true; setData(null); setError("");
    if (tenant) request(`/bff/v1/me/workspace?tenantId=${encodeURIComponent(tenant)}`).then(({ data }) => { if (active) setData(data); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [tenant, version]);
  return <><Heading title="空间权限" description="查看当前空间成员及你的操作权限。"><Button variant="outline" onClick={() => setVersion(v => v + 1)} disabled={!tenant || (!data && !error)}><RefreshCw size={16} />刷新</Button></Heading>
    {!tenant ? <p className="harbor-empty">当前账号尚无可用空间。</p> : error ? <p className="harbor-empty" role="alert">{error}</p> : !data ? <p className="harbor-empty">正在读取空间权限…</p> : <>
      <div className="harbor-dashboard-grid"><Card><CardHeader><CardTitle>{data.tenant.name}</CardTitle><CardDescription>空间正常 · {data.members.length} 位成员</CardDescription></CardHeader><CardContent><div className="harbor-role-summary"><ShieldCheck size={26} /><div><strong>{roleNames[data.role] || "成员"}</strong><p>{session.displayName} · 你的当前角色</p></div></div><p className="harbor-hint">空间内共享已购订阅；每把 API Key 仍按各自授权调用。</p></CardContent></Card>
        <Card><CardHeader><CardTitle>你可以执行的操作</CardTitle><CardDescription>权限由当前空间角色决定。</CardDescription></CardHeader><CardContent><div className="harbor-permission-tags">{data.capabilities.map((cap: string) => <span key={cap}><CheckCircle2 size={14} />{capabilityNames[cap] || cap}</span>)}</div></CardContent></Card></div>
      <Card className="harbor-workspace-panel"><CardHeader><CardTitle>空间成员</CardTitle><CardDescription>如需邀请成员或调整角色，请联系空间所有者或服务管理员。此处展示当前生效的权限。</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>成员</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{members.items.map((m: any) => <TableRow key={m.id}><TableCell><span className="harbor-member"><Users size={16} />{m.displayName || "未设置姓名"}{m.id === data.memberId && <small>你</small>}</span></TableCell><TableCell>{roleNames[m.role] || m.role}</TableCell><TableCell>{m.memberStatus === "active" ? "正常" : "已停用"}</TableCell></TableRow>)}</TableBody></Table><Pagination label="空间成员" {...members.pagination} onChange={members.setPage} /></CardContent></Card>
      <Card><CardHeader><CardTitle>角色与权限</CardTitle><CardDescription>查看各个角色的实际授权范围。</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>操作</TableHead>{data.roles.map((r: any) => <TableHead key={r.role}>{roleNames[r.role]}</TableHead>)}</TableRow></TableHeader><TableBody>{Object.entries(capabilityNames).map(([cap, label]) => <TableRow key={cap}><TableCell>{label}</TableCell>{data.roles.map((r: any) => <TableCell key={r.role}>{r.capabilities.includes(cap) ? <CheckCircle2 size={16} aria-label="允许" className="harbor-allowed" /> : <span aria-label="未授权">—</span>}</TableCell>)}</TableRow>)}</TableBody></Table></CardContent></Card>
    </>}
  </>;
}
