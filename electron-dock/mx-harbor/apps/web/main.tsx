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
  LogOut,
  UserRound,
} from "lucide-react";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
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
import { PublicIpSearch } from "./public-ip-search";
import { AccessContext } from "./public-access";
import { AccountDialog } from "./account-dialog";
import { request } from "./api";
import "@/styles/dataport.css";
import "./harbor.css";
const pages = [
  ["intelligence", "新建查询", SquarePen],
  ["overview", "用量概览", ChartNoAxesCombined],
  ["team", "空间权限", Users],
  ["keys", "API Keys", KeyRound],
  ["services", "我的接入", Plug],
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
      {pages.map(([id, title, Icon]) => (
        <SidebarMenuItem
          key={id}
          className={id === "services" ? "nav-divider" : ""}
        >
          <button
            className={`nav-button ${page === id ? "active" : ""}`}
            aria-current={page === id ? "page" : undefined}
            onClick={() => {
              go(id);
              if (sidebar.isMobile) sidebar.setOpenMobile(false);
            }}
          >
            <Icon size={18} />
            <span>{title}</span>
          </button>
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
      style={{ "--sidebar-width": "224px" } as React.CSSProperties}
    >
      <Sidebar className="app-sidebar">
        <SidebarHeader>
          <a className="brand" href="/">
            <span className="brand-symbol">
              <Layers3 size={24} />
            </span>
            <strong>
              数港<span>DataPort</span>
            </strong>
          </a>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <Navigation page={page} go={go} />
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="console-sidebar-footer">
          <button className="nav-button" onClick={() => go("account")}>
            <UserRound size={18} />
            <span>{name}</span>
          </button>
          <button className="nav-button" onClick={onLogout}>
            <LogOut size={18} />
            <span>退出登录</span>
          </button>
        </SidebarFooter>
      </Sidebar>
      <div
        className={`app-main ${page === "intelligence" ? "query-backdrop" : ""}`}
      >
        <main className="content">
          <SidebarTrigger
            className="console-mobile-trigger"
            aria-label="展开导航"
          />
          {children}
          <footer className="harbor-footer">数港 DataPort · Data Harbor</footer>
        </main>
      </div>
    </SidebarProvider>
  );
}
function AccountSecurity() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = () =>
    request("/auth/sso/account")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      body = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError("");
    try {
      const result = await request("/auth/sso/account", {
        method: "POST",
        headers: { "x-mx-csrf": data.csrf },
        body: JSON.stringify(body),
      });
      form.reset();
      if (result.signedOut || body.action === "password") {
        location.assign("/");
        return;
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>账户安全</h1>
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p>正在读取账户…</p>
      ) : (
        <div className="harbor-grid">
          <Card>
            <CardHeader>
              <CardTitle>个人资料</CardTitle>
              <CardDescription>{data.account}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="harbor-form">
                <input type="hidden" name="action" value="profile" />
                <label>
                  显示名称
                  <Input
                    name="displayName"
                    defaultValue={data.displayName}
                    required
                    maxLength={80}
                  />
                </label>
                <label>
                  当前密码
                  <Input
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <Button disabled={busy}>保存资料</Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>修改密码</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="harbor-form">
                <input type="hidden" name="action" value="password" />
                <label>
                  当前密码
                  <Input
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <label>
                  新密码
                  <Input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={128}
                    required
                  />
                </label>
                <Button disabled={busy}>保存并重新登录</Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>登录设备</CardTitle>
            </CardHeader>
            <CardContent>
              <p>{data.sessions?.length ?? 0} 个登录会话</p>
              <form className="harbor-form" onSubmit={submit}>
                <input type="hidden" name="action" value="revoke" />
                <input type="hidden" name="target" value="all" />
                <label>
                  验证密码
                  <Input
                    name="currentPassword"
                    type="password"
                    required
                    autoComplete="current-password"
                  />
                </label>
                <Button variant="outline" disabled={busy}>
                  撤销全部会话
                </Button>
              </form>
              <a href="/auth/sso/login?select=1">切换账号</a>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
function RemotePanel({
  page,
  session,
  tenant,
}: {
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
    services: `/commerce/tenants/${tenant}`,
    orders: `/commerce/tenants/${tenant}`,
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
  if (page === "intelligence") return <PublicIpSearch available={false} />;
  const title = pages.find((p) => p[0] === page)?.[1] || "服务";
  return (
    <>
      <div className="harbor-page-heading">
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
        <Card>
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
      ) : ["services", "orders"].includes(page) ? (
        <div className="harbor-grid">
          {(page === "services" ? data.subscriptions : data.orders).map(
            (item: any) => (
              <Card key={item.id}>
                <CardHeader>
                  <CardTitle>{item.product?.name || "IP 风险画像"}</CardTitle>
                  <CardDescription>{item.id}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p>
                    {item.status || `已使用 ${item.used} / ${item.quota} 次`}
                  </p>
                  <p>
                    {item.endsAt
                      ? `有效期至 ${new Date(item.endsAt).toLocaleDateString()}`
                      : ""}
                  </p>
                  {item.product && (
                    <p>¥{(item.product.amountMinor / 100).toFixed(2)}</p>
                  )}
                </CardContent>
              </Card>
            ),
          )}
          {!(page === "services" ? data.subscriptions : data.orders).length && (
            <div className="harbor-empty">暂无记录</div>
          )}
        </div>
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
  const [auth, setAuth] = useState(false),
    [session, setSession] = useState<any>(null),
    [csrf, setCsrf] = useState(""),
    [tenant, setTenant] = useState(""),
    [page, setPage] = useState(location.hash.slice(2) || "intelligence"),
    [bootError, setBootError] = useState("");
  const go = (p: string) => {
    location.hash = `/${p}`;
    setPage(p);
  };
  useEffect(() => {
    const listener = () => setPage(location.hash.slice(2) || "intelligence");
    addEventListener("hashchange", listener);
    request("/auth/sso/session")
      .then(async (s) => {
        setCsrf(s.csrf || "");
        if (s.active) {
          const user = await request("/bff/v1/session");
          setSession(user.data);
          setTenant(user.data.tenantIds?.[0] || "");
          const destination = sessionStorage.getItem("harbor:return");
          if (pages.some((p) => p[0] === destination)) {
            go(destination!);
            sessionStorage.removeItem("harbor:return");
          }
        }
      })
      .catch((e) => setBootError(e.message));
    if (new URLSearchParams(location.search).has("account")) setAuth(true);
    return () => removeEventListener("hashchange", listener);
  }, []);
  const access = {
    signedIn: !!session,
    enter: (dest: string) => {
      if (session) go(dest);
      else {
        sessionStorage.setItem("harbor:return", dest);
        setAuth(true);
      }
    },
    account: () => (session ? go("account") : setAuth(true)),
  };
  return (
    <AccessContext.Provider value={access}>
      {session ? (
        <ConsoleShell
          page={page}
          go={go}
          name={session.displayName}
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
          {session.memberships?.length > 1 && (
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
          <RemotePanel page={page} session={session} tenant={tenant} />
        </ConsoleShell>
      ) : (
        <div className="public-site query-backdrop">
          <PublicHeader
            current={location.pathname === "/pricing" ? "pricing" : "home"}
          />
          <main id="main-content">
            {location.pathname === "/pricing" ? (
              <section className="ip-pricing-section">
                <div className="public-container">
                  <div className="ip-pricing-heading">
                    <h1>IP 风险画像 · 年度服务</h1>
                    <p>登录后查看你的空间服务与可购买商品。</p>
                    <Button onClick={() => setAuth(true)}>受邀进入数港</Button>
                  </div>
                </div>
              </section>
            ) : (
              <PublicIpSearch />
            )}
          </main>
          {bootError && (
            <p className="harbor-note" role="status">
              账号服务暂未就绪，可先浏览产品介绍。
            </p>
          )}
          <footer className="harbor-footer">数港 DataPort · Data Harbor</footer>
        </div>
      )}
      <AccountDialog open={auth} onOpenChange={setAuth} />
    </AccessContext.Provider>
  );
}
if (document.getElementById("root") && !location.pathname.startsWith("/demos/"))
  createRoot(document.getElementById("root")!).render(<App />);
