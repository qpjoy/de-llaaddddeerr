import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { PublicIpSearch } from "./public-ip-search";
import { request } from "./api";
import {
  currentSubscription,
  dateTime,
  hasCapability,
  PRODUCT_CAPABILITY,
  subscriptionState,
  queryIntent,
  portraitState,
  type Subscription,
} from "./commerce-state";

const states: Record<string, string> = {
  success: "查询成功",
  partial: "部分数据",
  no_data: "暂无数据",
  unknown: "结果待核对",
  error: "查询失败",
};
const valueText = (value: unknown) =>
  value == null || value === "" ? "未提供" : String(value);
export function IpQuery({
  tenant,
  session,
  csrf,
  go,
  initialIp,
}: {
  tenant: string;
  session: any;
  csrf: string;
  go: (page: string) => void;
  initialIp: string;
}) {
  const [subscription, setSubscription] = useState<Subscription | undefined>(),
    [credential, setCredential] = useState<any>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<any>(null),
    [history, setHistory] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const lock = useRef(false),
    live = useRef(true);
  const canUse = hasCapability(session, tenant, "apikey.write"),
    canRead = hasCapability(session, tenant, "billing.read");
  const post = (path: string, body: any) =>
    request(`/bff/v1${path}`, {
      method: "POST",
      headers: { "x-mx-csrf": csrf },
      body: JSON.stringify(body),
    });
  const publicRead = (path: string, key: any, options: RequestInit = {}) =>
    request(`/api/v1/data/ip/risk${path}`, {
      ...options,
      credentials: "omit",
      headers: { Authorization: `Bearer ${key.secret}`, ...options.headers },
    });
  async function loadHistory(key: any, next?: string) {
    const data = await publicRead(
      `/history?limit=10${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      key,
    );
    if (!live.current) return;
    setHistory((previous) =>
      next ? [...previous, ...data.items] : data.items,
    );
    setCursor(data.nextCursor);
  }
  async function connect(keyId: string) {
    const { data } = await post("/demo-credentials", { keyId });
    if (
      !data.access?.platforms?.includes("ip_risk") ||
      !data.access?.capabilities?.includes(PRODUCT_CAPABILITY)
    )
      throw Error("当前访问身份未包含已购产品的查询权限，请联系空间管理员。");
    if (!live.current) return null;
    setCredential(data);
    await loadHistory(data);
    return data;
  }
  async function load() {
    setLoading(true);
    setCredential(null);
    setError("");
    try {
      if (!tenant || !canRead) return;
      const [purchases, keys] = await Promise.all([
        request(`/bff/v1/commerce/tenants/${tenant}`),
        canUse ? request("/bff/v1/api-keys") : Promise.resolve({ data: [] }),
      ]);
      if (!live.current) return;
      setSubscription(currentSubscription(purchases.data.subscriptions));
      const key = keys.data.find(
        (item: any) =>
          item.tenantId === tenant &&
          (item.effectiveStatus || item.status) === "active" &&
          item.environment === "live" &&
          item.capabilities?.includes(PRODUCT_CAPABILITY),
      );
      if (key) await connect(key.id);
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setLoading(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [tenant]);
  async function perform(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e: any) {
      if (live.current)
        setError(
          `${e.message}${e.requestId ? ` · 请求编号：${e.requestId}` : ""}`,
        );
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  const active = subscription && subscriptionState(subscription) === "active";
  const ready =
    credential?.access?.operations?.[PRODUCT_CAPABILITY]?.ready === true;
  const hint = loading
    ? "正在读取空间订阅…"
    : error && !credential
      ? "暂时无法确认查询权限，请重新检查。"
      : !tenant
        ? "请先开通或加入使用空间。"
        : !canUse || !canRead
          ? "网页查询需要当前空间的 Key 管理和账单查看权限，请联系空间管理员。"
          : !subscription
            ? "购买并完成付款后，即可使用空间共享的查询次数。"
            : !active
              ? "本期次数已用尽或正在处理，请查看订阅状态。"
              : !credential
                ? "订阅已开通，启用网页查询后即可使用。"
                : !ready
                  ? "已开通订阅，数据服务暂不可用，请稍后重新检查。"
                  : `本期已用 ${subscription.used} / ${subscription.quota} 次 · 到期 ${dateTime(subscription.endsAt)}；回看历史不增加调用。`;
  async function query(ip: string) {
    if (!subscription) {
      go("market");
      return;
    }
    if (!active || !credential || !ready) return;
    await perform(async () => {
      setResult(null);
      // Renew a temporary credential without replacing the real Key or request identity.
      const key =
        credential.expiresAt <= Date.now() + 1000
          ? await connect(credential.keyId)
          : credential;
      if (!key) return;
      const signature = `${tenant}:${key.keyId}:${ip}`;
      // Preserve the request identity even if an uncertain response is followed by reload.
      // Temporary credentials and returned portraits remain in memory only.
      const intent = queryIntent(sessionStorage, signature);
      try {
        const data = await publicRead("/service", key, {
          method: "POST",
          body: JSON.stringify({ ip }),
          headers: { "Idempotency-Key": intent.key },
          signal: AbortSignal.timeout(90000),
        });
        if (!live.current) return;
        const item = data.data?.[0];
        if (!item) throw Error("查询返回格式异常，请核对原请求。");
        setResult({
          ...item,
          batchId: data.batchId,
          intentName: intent.name,
          historical: false,
        });
      } catch (e: any) {
        throw Error(
          `${e.message}。请求可能已执行；再次查询同一 IP 将使用原请求编号核对，不自动重试。${e.requestId ? `请求编号：${e.requestId}` : ""}`,
        );
      } finally {
        if (live.current) {
          try {
            const [{ data }] = await Promise.all([
              request(`/bff/v1/commerce/tenants/${tenant}`),
              loadHistory(key),
            ]);
            if (live.current)
              setSubscription(currentSubscription(data.subscriptions));
          } catch {
            /* Keep the actual query outcome. */
          }
        }
      }
    });
  }
  async function openHistory(item: any) {
    await perform(async () => {
      const key =
        credential.expiresAt <= Date.now() + 1000
          ? await connect(credential.keyId)
          : credential;
      if (!key) return;
      const record = await publicRead(
        `/history/${item.kind}/${item.recordId}`,
        key,
      );
      if (!live.current) return;
      const payload = record.payload;
      setResult(
        Array.isArray(payload.data)
          ? {
              ...payload.data[item.index],
              batchId: payload.batchId,
              historical: true,
            }
          : {
              ip: record.request.ip,
              status: record.status,
              response: payload,
              historical: true,
            },
      );
    });
  }
  const profile = result?.response?.data?.data;
  const resultState = portraitState(result);
  return (
    <>
      <PublicIpSearch
        initialIp={initialIp}
        showIntro={!result}
        validateInput={!!subscription}
        available={
          !loading &&
          !busy &&
          canUse &&
          canRead &&
          (active ? !!credential && ready : !subscription && canUse && canRead)
        }
        busy={busy}
        actionLabel={!subscription ? "去选购" : "查询"}
        hint={hint}
        onQuery={query}
      />
      <div className="harbor-query-workspace">
        {error && (
          <p role="alert" className="harbor-error">
            {error}
          </p>
        )}
        <div className="harbor-actions">
          <Button
            variant="outline"
            disabled={busy || loading}
            onClick={() => perform(load)}
          >
            重新检查
          </Button>
          <Button
            variant="outline"
            onClick={() => go(subscription ? "services" : "market")}
          >
            {subscription ? "查看订阅 / 续订" : "选购数据服务"}
          </Button>
          {active && canUse && !credential && (
            <Button
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const { data } = await post(
                    `/commerce/tenants/${tenant}/access`,
                    {},
                  );
                  await connect(data.keyId);
                })
              }
            >
              启用网页查询
            </Button>
          )}
        </div>
        {result && (
          <Card className="harbor-portrait">
            <CardHeader>
              <CardTitle>
                {result.ip}{" "}
                <span>
                  {result.historical
                    ? "历史画像"
                    : states[resultState] || "查询失败"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {result.error || result.response?.error ? (
                <p role="alert">
                  {result.error?.message || result.response?.error?.message} ·{" "}
                  {result.error?.code || result.response?.error?.code}
                </p>
              ) : profile ? (
                <>
                  <dl className="harbor-profile-fields">
                    {[
                      ["风险等级", profile.risk_level],
                      ["风险评分", profile.risk_score],
                      ["国家 / 地区", profile.country],
                      ["省份", profile.province],
                      ["城市", profile.city],
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
                  <h3>风险标签</h3>
                  <div className="harbor-risk-tags">
                    {profile.risk_tags?.length ? (
                      profile.risk_tags.map((tag: any, index: number) => (
                        <span key={index}>
                          {tag.name || tag.code || "未命名标签"}
                        </span>
                      ))
                    ) : (
                      <p>
                        {profile.risk_tags == null
                          ? "未提供标签信息"
                          : "本次返回空标签集合"}
                        ，不能据此判断无风险。
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <p>本次没有可用画像，不等于无风险。</p>
              )}
              <p>查询时间：{dateTime(result.response?.meta?.capturedAt)}</p>
              <p className="harbor-order-id">
                请求编号：
                {result.response?.requestId || result.batchId || "未返回"}
              </p>
              {!result.historical &&
                (["success", "partial", "no_data"].includes(resultState) ||
                  (resultState === "error" &&
                    result.status >= 400 &&
                    !!(
                      result.error?.code || result.response?.error?.code
                    ))) && (
                  <Button
                    variant="outline"
                    disabled={busy || !active}
                    onClick={() => {
                      sessionStorage.removeItem(result.intentName);
                      void query(result.ip);
                    }}
                  >
                    重新查询此 IP（计入本期次数）
                  </Button>
                )}
            </CardContent>
          </Card>
        )}
        {credential && (
          <Card className="harbor-history">
            <CardHeader>
              <CardTitle>查询记录</CardTitle>
              <p>仅查看当前调用身份已保存的结果。</p>
            </CardHeader>
            <CardContent>
              {history.map((item) => (
                <div className="harbor-history-row" key={item.id}>
                  <span>{item.ip || "处理中批次"}</span>
                  <span>{states[item.state] || "查询失败"}</span>
                  <time>{dateTime(item.createdAt)}</time>
                  <Button
                    variant="ghost"
                    disabled={busy || !item.available}
                    onClick={() => openHistory(item)}
                  >
                    查看记录
                  </Button>
                </div>
              ))}
              {!history.length && <p>暂无查询记录</p>}
              {cursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => perform(() => loadHistory(credential, cursor))}
                >
                  更多记录
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
