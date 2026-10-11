import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  Layers3,
  SquarePen,
  ChartNoAxesCombined,
  KeyRound,
  BookOpen,
  Wallet,
  Plug,
  Users,
  UserRound,
  ShoppingBag,
} from "lucide-react";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
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
import { Input } from "@/components/ui/input";
import { PublicHeader } from "./public-header";
import { emptySession, loadHarborSession } from "./session";
import { PublicIpSearch } from "./public-ip-search";
import { AccessContext } from "./public-access";
import { AccountDialog } from "./account-dialog";
import { SidebarAccountMenu } from "./sidebar-account-menu";
import { request } from "./api";
import { AccountSecurity } from "./account-security";
import { Commerce } from "./commerce";
import { IpQuery } from "./ip-query";
import { paymentReturnTrade } from "./commerce-state";
import "@/styles/harbor.css";
import "./design-scale.css";
import "./harbor.css";
const pages = [
  ["intelligence", "新建查询", SquarePen],
  ["overview", "用量概览", ChartNoAxesCombined],
  ["team", "空间权限", Users],
  ["keys", "API Keys", KeyRound],
  ["market", "数据商城", ShoppingBag],
  ["services", "我的订阅", Plug],
  ["orders", "支付订单", Wallet],
  ["docs-ip", "接口文档", BookOpen],
  ["account", "账户安全", UserRound],
] as const;
function Navigation({
  page,
  go,
}: {
  page: string;
  go: (page: string) => void;
}) {
  const sidebar = useSidebar();
  return (
    <SidebarMenu>
      {pages
        .filter(([id]) => id !== "account" && id !== "orders")
        .map(([id, title, Icon]) => (
          <SidebarMenuItem
            key={id}
            className={id === "market" ? "nav-divider" : ""}
          >
            <SidebarMenuButton
              className="nav-button"
              isActive={page === id}
              aria-current={page === id ? "page" : undefined}
              onClick={() => {
                go(id);
                if (sidebar.isMobile) sidebar.setOpenMobile(false);
              }}
            >
              <Icon size={18} />
              <span>{title}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
    </SidebarMenu>
  );
}
export function ConsoleShell({
  page,
  go,
  name,
  children,
  onLogout,
}: {
  page: string;
  go: (page: string) => void;
  name: string;
  children: React.ReactNode;
  onLogout: () => void;
}) {
  return (
    <SidebarProvider
      className="harbor-shell"
      style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
    >
      <Sidebar className="app-sidebar">
        <SidebarHeader>
          <a className="brand" href="/">
            <span className="brand-symbol">
              <Layers3 size={24} />
            </span>
            <strong>
              数港<span>Harbor</span>
            </strong>
          </a>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <Navigation page={page} go={go} />
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="console-sidebar-footer">
          <SidebarAccountMenu
            name={name}
            page={page}
            navigate={go}
            onLogout={onLogout}
          />
        </SidebarFooter>
      </Sidebar>
      <div
        className={`app-main ${page === "intelligence" ? "query-backdrop" : ""}`}
      >
        <main className="content harbor-console">
          <SidebarTrigger
            className="console-mobile-trigger"
            aria-label="展开导航"
          />
          {children}
          <footer className="harbor-footer">数港 Harbor</footer>
        </main>
      </div>
    </SidebarProvider>
  );
}
function RemotePanel({
  page,
  session,
  tenant,
  csrf,
  go,
  reloadSession,
  initialIp,
}: {
  csrf: string;
  go: (page: string) => void;
  reloadSession: () => void;
  initialIp: string;
  page: string;
  session: any;
  tenant: string;
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  const endpoints: Record<string, string> = {
    overview: `/me/overview${tenant ? "?tenantId=" + tenant : ""}`,
    keys: "/api-keys",
    team: "/session",
    "docs-ip": "/documentation?path=%2Fdocs%2Fopenapi.json",
  };
  useEffect(() => {
    setData(null);
    setError("");
    if (!endpoints[page] || (!tenant && ["services", "orders"].includes(page)))
      return;
    let active = true;
    request(`/bff/v1${endpoints[page]}`)
      .then((v) => {
        if (active) setData(v.data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [page, tenant]);
  if (page === "account") return <AccountSecurity />;
  if (page === "intelligence")
    return (
      <IpQuery
        tenant={tenant}
        session={session}
        csrf={csrf}
        go={go}
        initialIp={initialIp}
      />
    );
  if (["market", "services", "orders"].includes(page))
    return (
      <Commerce
        page={page}
        tenant={tenant}
        session={session}
        csrf={csrf}
        go={go}
        reloadSession={reloadSession}
      />
    );
  const title = pages.find((p) => p[0] === page)?.[1] || "服务";
  return (
    <>
      <div className="page-heading">
        <h1>{title}</h1>
      </div>
      {error ? (
        <div className="harbor-empty" role="alert">
          {error}
        </div>
      ) : !data ? (
        <div className="harbor-empty">
          {!tenant ? "当前账号尚无可用空间，请联系空间管理员。" : "正在读取…"}
        </div>
      ) : page === "keys" ? (
        <Card className="harbor-table-panel">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>标识</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((key: any) => (
                <TableRow key={key.id}>
                  <TableCell>{key.name}</TableCell>
                  <TableCell>{key.prefix || key.id}</TableCell>
                  <TableCell>{key.effectiveStatus || key.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!data.length && <p className="harbor-empty">尚无 API Key</p>}
        </Card>
      ) : page === "docs-ip" ? (
        <Card>
          <CardHeader>
            <CardTitle>接口文档</CardTitle>
            <CardDescription>仅包含当前空间已授权的数据服务。</CardDescription>
          </CardHeader>
          <CardContent>
            {!Object.keys(data.schema?.paths || {}).length && (
              <p className="harbor-empty">当前空间暂无已授权的接口文档。</p>
            )}
            {Object.entries(data.schema?.paths || {}).map(
              ([path, methods]: any) => (
                <div className="harbor-endpoint" key={path}>
                  <code>
                    {location.origin}/api/v1{path}
                  </code>
                  {Object.entries(methods).map(([method, value]: any) => (
                    <p key={method}>
                      {method.toUpperCase()} · {value.summary}
                    </p>
                  ))}
                </div>
              ),
            )}
          </CardContent>
        </Card>
      ) : page === "overview" ? (
        <div className="harbor-grid">
          {data.tenants?.map((space: any) => (
            <Card key={space.id}>
              <CardHeader>
                <CardTitle>{space.name}</CardTitle>
                <CardDescription>{space.status}</CardDescription>
              </CardHeader>
              <CardContent>
                <p>{space.consumers?.length || 0} 个服务身份</p>
              </CardContent>
            </Card>
          ))}
          {!data.tenants?.length && (
            <p className="harbor-empty">暂无已授权服务</p>
          )}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{session.displayName} 的空间</CardTitle>
          </CardHeader>
          <CardContent>
            {session.memberships?.map((m: any) => (
              <p key={m.tenantId}>
                {m.tenantName || m.tenantId} · {m.role}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
function App() {
  const [queryIp, setQueryIp] = useState(
    sessionStorage.getItem("harbor:query-ip") || "",
  );
  const [queryRevision, setQueryRevision] = useState(0);
  const [auth, setAuth] = useState(false),
    [boot, setBoot] = useState(emptySession),
    [checking, setChecking] = useState(true),
    [retry, setRetry] = useState(0),
    [tenant, setTenant] = useState(""),
    [page, setPage] = useState(location.hash.slice(2) || "intelligence"),
    [bootError, setBootError] = useState("");
  const { active: signedIn, customer: session, csrf, issue } = boot;
  const go = (p: string) => {
    location.hash = `/${p}`;
    setPage(p);
  };
  useEffect(() => {
    const listener = () => setPage(location.hash.slice(2) || "intelligence");
    addEventListener("hashchange", listener);
    if (new URLSearchParams(location.search).has("account")) setAuth(true);
    if (
      location.pathname === "/payment/return" ||
      new URLSearchParams(location.search).get("method") ===
        "alipay.trade.page.pay.return"
    ) {
      const trade = paymentReturnTrade(location.search);
      if (trade)
        sessionStorage.setItem(
          "harbor:payment-return",
          JSON.stringify({ trade, expires: Date.now() + 30 * 60_000 }),
        );
      history.replaceState(null, "", "/#/orders");
      setPage("orders");
      sessionStorage.setItem("harbor:return", "orders");
    }
    return () => removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    let current = true;
    setChecking(true);
    setBoot(emptySession);
    setBootError("");
    loadHarborSession(request)
      .then((value) => {
        if (!current) return;
        setBoot(value);
        if (value.customer) {
          setTenant(value.customer.tenantIds?.[0] || "");
          const destination = sessionStorage.getItem("harbor:return");
          if (pages.some((p) => p[0] === destination)) {
            go(destination!);
            sessionStorage.removeItem("harbor:return");
          }
          let returned;
          try {
            returned = JSON.parse(
              sessionStorage.getItem("harbor:payment-return") || "null",
            );
          } catch {
            /* Ignore a damaged locator; never infer payment state. */
          }
          sessionStorage.removeItem("harbor:payment-return");
          if (
            returned?.expires > Date.now() &&
            /^MXP[0-9a-f]{32}$/i.test(returned.trade)
          ) {
            void request(
              `/bff/v1/payments/return-order?trade=${encodeURIComponent(returned.trade)}`,
            )
              .then(({ data }) => {
                if (!current) return;
                if (data.businessType !== "purchase")
                  throw Error(
                    "该返回记录不是数据订阅订单，请到原购买应用查看。",
                  );
                setTenant(data.tenantId);
                go("orders");
              })
              .catch((error) => {
                if (current) setBootError(error.message);
              });
          }
        } else setTenant("");
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [retry]);
  const retrySession = () => setRetry((value) => value + 1);
  const access = {
    signedIn: signedIn === true,
    enter: (dest: string, ip?: string) => {
      if (ip) {
        setQueryIp(ip);
        sessionStorage.setItem("harbor:query-ip", ip);
      }
      if (checking) return;
      if (signedIn) go(dest);
      else {
        sessionStorage.setItem("harbor:return", dest);
        if (signedIn === null) retrySession();
        else setAuth(true);
      }
    },
    account: () => {
      if (checking) return;
      if (signedIn) go("account");
      else if (signedIn === null) retrySession();
      else setAuth(true);
    },
  };
  const sessionNotice = issue && (
    <section className="harbor-session-notice" role="alert">
      <h2>
        {signedIn
          ? "已登录，客户服务暂不可用"
          : signedIn === false
            ? "请重新登录"
            : "暂时无法确认登录状态"}
      </h2>
      <p>{issue.message}</p>
      {signedIn && (
        <p>
          无需重新注册或再次兑换邀请码。服务恢复后，点击重试即可读取空间与权限。
        </p>
      )}
      {(issue.code || issue.requestId) && (
        <p className="harbor-session-reference">
          {issue.code}
          {issue.requestId ? ` · 请求编号：${issue.requestId}` : ""}
        </p>
      )}
      <Button
        variant="outline"
        onClick={signedIn === false ? () => setAuth(true) : retrySession}
      >
        {signedIn === false ? "重新登录" : "重试连接"}
      </Button>
    </section>
  );
  return (
    <AccessContext.Provider value={access}>
      {signedIn ? (
        <ConsoleShell
          page={page}
          go={(destination) => {
            if (destination === "intelligence" && page === "intelligence") {
              setQueryIp("");
              sessionStorage.removeItem("harbor:query-ip");
              setQueryRevision((value) => value + 1);
            }
            go(destination);
          }}
          name={session?.displayName || "已登录"}
          onLogout={async () => {
            try {
              await request("/auth/sso/logout", {
                method: "POST",
                headers: { "x-mx-csrf": csrf },
                body: "{}",
              });
              location.assign("/");
            } catch (e) {
              setBootError((e as Error).message);
            }
          }}
        >
          {session?.memberships?.length > 1 && (
            <label className="harbor-space">
              使用空间
              <select
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
              >
                {session.memberships.map((m: any) => (
                  <option value={m.tenantId} key={m.tenantId}>
                    {m.tenantName || m.tenantId}
                  </option>
                ))}
              </select>
            </label>
          )}
          {bootError && <p role="alert">{bootError}</p>}
          {sessionNotice}
          {session ? (
            <RemotePanel
              key={`${page}:${tenant}:${queryRevision}`}
              page={page}
              session={session}
              tenant={tenant}
              csrf={csrf}
              go={go}
              reloadSession={retrySession}
              initialIp={queryIp}
            />
          ) : page === "account" ? (
            <AccountSecurity />
          ) : null}
        </ConsoleShell>
      ) : (
        <div
          className={`public-site ${location.pathname === "/pricing" ? "harbor-pricing" : "query-backdrop"}`}
        >
          <PublicHeader
            current={location.pathname === "/pricing" ? "pricing" : "home"}
            accountPending={checking}
            accountLabel={
              checking
                ? "正在确认…"
                : signedIn === null
                  ? "重试连接"
                  : undefined
            }
          />
          {sessionNotice}
          <main
            id="main-content"
            className={
              location.pathname === "/pricing" ? undefined : "public-query-main"
            }
          >
            {location.pathname === "/pricing" ? (
              <section className="ip-pricing-section">
                <div className="public-container">
                  <div className="ip-pricing-heading">
                    <h1>IP 风险画像 · 年度服务</h1>
                    <p>登录后查看你的空间服务与可购买商品。</p>
                    <Button onClick={() => access.enter("market")}>
                      登录查看数据商城
                    </Button>
                  </div>
                </div>
              </section>
            ) : (
              <PublicIpSearch />
            )}
          </main>
          <footer className="harbor-footer">数港 Harbor</footer>
        </div>
      )}
      <AccountDialog open={auth} onOpenChange={setAuth} />
    </AccessContext.Provider>
  );
}
if (document.getElementById("root") && !location.pathname.startsWith("/demos/"))
  createRoot(document.getElementById("root")!).render(<App />);
