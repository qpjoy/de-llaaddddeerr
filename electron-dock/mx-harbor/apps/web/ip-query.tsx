import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PublicIpSearch } from "./public-ip-search";
import { QueryHistory, QueryResult } from "./ip-query-results";
import { request } from "./api";
import {
  currentSubscription,
  hasCapability,
  PRODUCT_CAPABILITY,
  subscriptionState,
  queryIntent,
  type Subscription,
} from "./commerce-state";

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
    [error, setError] = useState(""),
    [accessError, setAccessError] = useState("");
  const [result, setResult] = useState<any>(null),
    [history, setHistory] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(""),
    [historyLoading, setHistoryLoading] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [search, setSearch] = useState({ ip: initialIp, revision: 0 });
  const resultRef = useRef<HTMLDivElement>(null);
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
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const data = await publicRead(
        `/history?limit=10${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        key,
      );
      if (!live.current) return;
      setHistory((previous) =>
        next ? [...previous, ...data.items] : data.items,
      );
      setCursor(data.nextCursor);
    } catch (e) {
      if (live.current) setHistoryError((e as Error).message);
    } finally {
      if (live.current) setHistoryLoading(false);
    }
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
    setAccessError("");
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
      if (live.current) setAccessError((e as Error).message);
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
  useEffect(() => {
    if (!result) return;
    resultRef.current?.focus({ preventScroll: true });
    resultRef.current?.scrollIntoView({ block: "nearest" });
  }, [result]);
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
      if (live.current) {
        setBusy(false);
        setQuerying(false);
      }
    }
  }
  const active = subscription && subscriptionState(subscription) === "active";
  const ready =
    credential?.access?.operations?.[PRODUCT_CAPABILITY]?.ready === true;
  const hint = loading
    ? "正在读取空间订阅…"
    : accessError
      ? "查询服务暂时无法连接。"
      : !tenant
        ? "请先开通或加入使用空间。"
        : !canUse || !canRead
          ? "当前账号没有网页查询权限，请联系空间管理员。"
          : !subscription
            ? "购买并完成付款后，即可使用空间共享的查询次数。"
            : !active
              ? "本期可用次数不足，请到「我的订阅」查看。"
              : !credential
                ? "订阅已开通，启用查询后即可使用。"
                : !ready
                  ? "数据服务暂不可用，请稍后再试。"
                  : `本期已用 ${subscription.used.toLocaleString()} / ${subscription.quota.toLocaleString()} 次 · ${new Date(subscription.endsAt).toLocaleDateString("zh-CN")} 到期`;
  async function query(ip: string) {
    if (!subscription) {
      go("market");
      return;
    }
    if (!active) return;
    if (!credential) {
      await perform(async () => {
        const { data } = await post(`/commerce/tenants/${tenant}/access`, {});
        await connect(data.keyId);
      });
      return;
    }
    if (!ready) return;
    await perform(async () => {
      setQuerying(true);
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
      setSearch((previous) => ({
        ip: item.ip || "",
        revision: previous.revision + 1,
      }));
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
  const accessUnavailable =
    !loading && (accessError || (active && credential && !ready));
  return (
    <div className="harbor-query-page" data-result={!!result}>
      <PublicIpSearch
        key={search.revision}
        initialIp={search.ip}
        showIntro={false}
        validateInput={!!credential}
        available={
          !loading &&
          !busy &&
          !accessError &&
          canUse &&
          canRead &&
          (active ? !credential || ready : !subscription)
        }
        busy={busy}
        busyLabel={querying ? "正在查询…" : "请稍候…"}
        actionLabel={
          loading
            ? "加载中"
            : accessUnavailable
              ? "暂不可用"
              : !subscription
                ? "去选购"
                : active && !credential
                  ? "启用查询"
                  : "查询"
        }
        hint={
          accessUnavailable ? (
            <span className="harbor-access-issue" role="status">
              查询服务暂不可用
              <Button
                variant="link"
                size="sm"
                disabled={busy || loading}
                onClick={() => perform(load)}
              >
                重新连接
              </Button>
            </span>
          ) : (
            hint
          )
        }
        onQuery={query}
      />
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
            aria-label={`${result.ip || "IP"} 风险画像查询结果`}
          >
            <QueryResult
              result={result}
              busy={busy}
              canQuery={!!active && ready}
              onQueryAgain={() => {
                sessionStorage.removeItem(result.intentName);
                void query(result.ip);
              }}
            />
          </div>
        )}
        {credential && (
          <QueryHistory
            history={history}
            loading={historyLoading}
            error={historyError}
            busy={busy}
            more={!!cursor}
            onRetry={() => perform(() => loadHistory(credential))}
            onMore={() => perform(() => loadHistory(credential, cursor!))}
            onOpen={openHistory}
          />
        )}
      </div>
    </div>
  );
}
