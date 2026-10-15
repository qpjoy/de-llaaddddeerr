import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { PublicPricing } from "./public-pricing";
import { UsageOverview } from "./workspace";
import { Documentation } from "./documentation";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  Layers3,
  SquarePen,
  LayoutDashboard,
  Headphones,
  KeyRound,
  BookOpen,
  Wallet,
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
} from "@/components/ui/card";
import { PublicHeader } from "./public-header";
import { emptySession, loadHarborSession } from "./session";
import { PublicIpSearch } from "./public-ip-search";
import { AccessContext } from "./public-access";
import { AccountDialog } from "./account-dialog";
import { SidebarAccountMenu } from "./sidebar-account-menu";
import { request } from "./api";
import {
  EnterpriseMembers,
  OwnerChallenge,
  Support,
  Audit,
  JoinEnterprise,
} from "./enterprise";
import { ApiKeys } from "./keys";
import { LegalDocument, LegalFooter } from "./legal";
import { canOpenPage, membershipFor } from "./permissions";
import { AccountSecurity } from "./account-security";
import { Commerce } from "./commerce";
import { IpQuery } from "./ip-query";
import { paymentReturnTrade } from "./commerce-state";
import { Messages, useMessageInbox } from "./messages";
import "@/styles/dataport.css";
import "./design-scale.css";
import "./dataport.css";
import "./alignment.css";
import "./prototype-parity.css";
const pages = [
  ["intelligence", "新建查询", SquarePen],
  ["overview", "用量概览", LayoutDashboard],
  ["keys", "API Keys", KeyRound],
  ["services", "我的订阅", Layers3],
  ["orders", "账单与发票", Wallet],
  ["docs-ip", "接口文档", BookOpen],
] as const;
function Navigation({
  page,
  go,
  unread,
  session,
  tenant,
}: {
  session?: any;
  tenant?: string;
  page: string;
  go: (page: string) => void;
  unread?: number;
}) {
  const sidebar = useSidebar();
  return (
    <SidebarMenu>
      {pages
        .filter(
          ([id]) =>
            session === undefined || canOpenPage(session, tenant || "", id),
        )
        .map(([id, title, Icon]) => (
          <SidebarMenuItem
            key={id}
            className={id === "services" ? "nav-divider" : ""}
          >
            <SidebarMenuButton
              className="nav-button"
              isActive={page === id || (id === "services" && page === "market")}
              aria-current={
                page === id || (id === "services" && page === "market")
                  ? "page"
                  : undefined
              }
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
function ConsoleBrand({ go }: { go: (page: string) => void }) {
  const sidebar = useSidebar();
  return (
    <a
      className="brand"
      href="/#/intelligence"
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        go("intelligence");
        if (sidebar.isMobile) sidebar.setOpenMobile(false);
      }}
    >
      <span className="brand-symbol">
        <Layers3 size={24} />
      </span>
      <strong>
        数港<span>DataPort</span>
      </strong>
    </a>
  );
}
export function ConsoleShell({
  page,
  go,
  name,
  children,
  onLogout,
  unread,
  session,
  tenant,
  onNotifications,
}: {
  onNotifications?: () => void;
  session?: any;
  tenant?: string;
  page: string;
  go: (page: string) => void;
  name: string;
  children: React.ReactNode;
  onLogout: () => void;
  unread?: number;
}) {
  return (
    <SidebarProvider
      className="harbor-shell"
      style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
    >
      <Sidebar className="app-sidebar">
        <SidebarHeader>
          <ConsoleBrand go={go} />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <Navigation
              page={page}
              go={go}
              unread={unread}
              session={session}
              tenant={tenant}
            />
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="console-sidebar-footer">
          {(session === undefined ||
            canOpenPage(session, tenant || "", "support")) && (
            <Button
              variant="ghost"
              className="support-card"
              onClick={() => go("support")}
            >
              <Headphones size={23} />
              <span>联系客服</span>
            </Button>
          )}
          <SidebarAccountMenu
            name={name}
            session={session}
            tenant={tenant}
            unread={unread}
            page={page}
            navigate={(next) => {
              if (next === "messages" && onNotifications) onNotifications();
              else go(next);
            }}
            onLogout={onLogout}
          />
        </SidebarFooter>
      </Sidebar>
      <div
        className={`app-main ${page === "intelligence" ? "query-backdrop" : ""}`}
      >
        <main className="content harbor-console" data-page={page}>
          <SidebarTrigger
            className="console-mobile-trigger"
            aria-label="展开导航"
          />
          {children}
          <LegalFooter inConsole />
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
  messages,
}: {
  csrf: string;
  go: (page: string) => void;
  reloadSession: () => void;
  initialIp: string;
  page: string;
  session: any;
  tenant: string;
  messages: ReturnType<typeof useMessageInbox>;
}) {
  if (!canOpenPage(session, tenant, page))
    return (
      <Card>
        <CardHeader>
          <CardTitle>无权访问此页面</CardTitle>
          <CardDescription>
            当前角色没有页面所需权限，请联系企业超管。
          </CardDescription>
        </CardHeader>
      </Card>
    );
  if (page === "team")
    return <EnterpriseMembers tenant={tenant} session={session} csrf={csrf} />;
  if (page === "audit")
    return <Audit tenant={tenant} session={session} csrf={csrf} />;
  if (page === "support")
    return <Support tenant={tenant} session={session} csrf={csrf} />;
  if (page === "keys")
    return <ApiKeys tenant={tenant} session={session} csrf={csrf} />;
  if (page === "overview")
    return <UsageOverview tenant={tenant} session={session} go={go} />;
  if (page === "docs-ip")
    return <Documentation tenant={tenant} session={session} />;
  if (page === "account") return <AccountSecurity />;
  if (page === "messages")
    return (
      <Messages
        tenant={tenant}
        csrf={csrf}
        enabled={true}
        state={messages}
        go={go}
      />
    );
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
  return null;
}

function App() {
  useEffect(() => {
    document.cookie = "sidebar_state=; Path=/; Max-Age=0; SameSite=Lax";
    try {
      for (const key of [
        "dataport_cookie_consent",
        "harbor_cookie_consent",
        "dataport:cookie-notice",
      ])
        localStorage.removeItem(key);
    } catch {
      /* Storage can be disabled. */
    }
  }, []);

  const [queryIp, setQueryIp] = useState(
    sessionStorage.getItem("harbor:query-ip") || "",
  );
  const [queryRevision, setQueryRevision] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [auth, setAuth] = useState(false),
    [boot, setBoot] = useState(emptySession),
    [checking, setChecking] = useState(true),
    [retry, setRetry] = useState(0),
    [tenant, setTenant] = useState(""),
    [page, setPage] = useState(location.hash.slice(2) || "intelligence"),
    [bootError, setBootError] = useState("");
  const { active: signedIn, customer: session, csrf, issue } = boot;
  const messages = useMessageInbox(
    tenant,
    signedIn === true && !!tenant && canOpenPage(session, tenant, "messages"),
  );
  const go = (p: string) => {
    location.hash = `/${p}`;
    setPage(p);
  };
  useEffect(() => {
    const joinToken = new URLSearchParams(location.search).get("token");
    if (
      location.pathname === "/join" &&
      /^[A-Za-z0-9_-]{43}$/.test(joinToken || "")
    )
      sessionStorage.setItem("dataport:join-token", joinToken!);
    const listener = () => setPage(location.hash.slice(2) || "intelligence");
    addEventListener("hashchange", listener);
    if (new URLSearchParams(location.search).has("account")) setAuth(true);
    if (new URLSearchParams(location.search).get("signedOut") === "1") {
      history.replaceState(null, "", "/");
      setAuth(true);
    }
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
    setBootError("");
    loadHarborSession(request)
      .then((value) => {
        if (!current) return;
        setBoot(value);
        if (value.customer) {
          const joinToken = sessionStorage.getItem("dataport:join-token");
          if (
            joinToken &&
            /^[A-Za-z0-9_-]{43}$/.test(joinToken) &&
            location.pathname !== "/join"
          )
            history.replaceState(null, "", `/join?token=${joinToken}`);
          setTenant((previous) =>
            value.customer.tenantIds?.includes(previous)
              ? previous
              : value.customer.tenantIds?.[0] || "",
          );
          const destination = sessionStorage.getItem("harbor:return");
          if (
            destination &&
            [
              "intelligence",
              "overview",
              "keys",
              "services",
              "market",
              "orders",
              "docs-ip",
              "support",
              "team",
              "audit",
              "account",
              "messages",
            ].includes(destination)
          ) {
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
          const validReturn =
            returned?.expires > Date.now() &&
            /^MXP[0-9a-f]{32}$/i.test(returned.trade || "");
          if (!validReturn) sessionStorage.removeItem("harbor:payment-return");
          if (
            validReturn &&
            value.customer.memberships?.some(
              (m: any) =>
                canOpenPage(value.customer, m.tenantId, "orders") ||
                canOpenPage(value.customer, m.tenantId, "market"),
            )
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
                sessionStorage.removeItem("harbor:payment-return");
                setTenant(data.tenantId);
                go(
                  canOpenPage(value.customer, data.tenantId, "orders")
                    ? "orders"
                    : "services",
                );
              })
              .catch((error) => {
                if (current) setBootError(error.message);
              });
          }
        } else {
          setTenant("");
          if (
            value.active === false &&
            sessionStorage.getItem("dataport:join-token")
          )
            setAuth(true);
        }
      })
      .finally(() => {
        if (current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [retry]);
  const retrySession = () => setRetry((value) => value + 1);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const refresh = () => {
      if (document.hidden) return;
      void loadHarborSession(request).then((value) => {
        if (live) {
          setBoot(value);
          // A recovered service or changed membership must also reconcile the
          // selected enterprise; otherwise a valid owner session has no match.
          setTenant((previous) =>
            value.customer?.tenantIds.includes(previous)
              ? previous
              : value.customer?.tenantIds[0] || "",
          );
        }
      });
    };
    addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 30000);
    return () => {
      live = false;
      clearInterval(timer);
      removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [signedIn]);
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
        <p>登录身份已确认。服务恢复后，点击重试即可读取企业与权限。</p>
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
      {["/privacy", "/terms", "/cookies"].includes(location.pathname) ? (
        <LegalDocument kind={location.pathname.slice(1)} />
      ) : signedIn ? (
        <ConsoleShell
          page={page}
          session={session}
          tenant={tenant}
          go={(destination) => {
            if (destination === "intelligence" && page === "intelligence") {
              setQueryIp("");
              sessionStorage.removeItem("harbor:query-ip");
              setQueryRevision((value) => value + 1);
            }
            go(destination);
          }}
          name={session?.displayName || "已登录"}
          onNotifications={() => setNotificationsOpen(true)}
          unread={messages.inbox?.unread}
          onLogout={async () => {
            try {
              await request("/auth/sso/logout", {
                method: "POST",
                headers: { "x-mx-csrf": csrf },
                body: "{}",
              });
              sessionStorage.removeItem("harbor:return");
              sessionStorage.removeItem("harbor:query-ip");
              location.replace("/?signedOut=1");
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
          {location.pathname === "/join" && session ? (
            <JoinEnterprise
              token={new URLSearchParams(location.search).get("token") || ""}
              csrf={csrf}
              onJoined={(target) => {
                sessionStorage.removeItem("dataport:join-token");
                setTenant(target);
                go("intelligence");
                retrySession();
              }}
            />
          ) : membershipFor(session, tenant)?.dataport
              ?.ownerChallengeRequired ? (
            <OwnerChallenge
              tenant={tenant}
              csrf={csrf}
              onVerified={retrySession}
            />
          ) : session ? (
            <RemotePanel
              key={`${page}:${tenant}:${queryRevision}`}
              page={page}
              session={session}
              tenant={tenant}
              csrf={csrf}
              go={go}
              reloadSession={retrySession}
              initialIp={queryIp}
              messages={messages}
            />
          ) : page === "account" ? (
            <AccountSecurity />
          ) : null}
        </ConsoleShell>
      ) : signedIn === null ? (
        <main className="harbor-session-pending query-backdrop">
          <div className="brand">
            <span className="brand-symbol">
              <Layers3 size={24} />
            </span>
            <strong>
              数港<span>DataPort</span>
            </strong>
          </div>
          {checking ? <p role="status">正在确认登录状态…</p> : sessionNotice}
        </main>
      ) : (
        <div
          className={`public-site query-site ${location.pathname === "/pricing" ? "pricing-site harbor-pricing" : "query-home"}`}
        >
          <PublicHeader
            current={location.pathname === "/pricing" ? "pricing" : "home"}
            accountPending={checking || auth}
            accountLabel={
              checking || auth
                ? auth
                  ? "正在连接…"
                  : "正在确认…"
                : signedIn === null
                  ? "重试连接"
                  : undefined
            }
          />
          {sessionNotice}
          <main
            id="main-content"
            className={
              location.pathname === "/pricing"
                ? undefined
                : "public-query-main query-backdrop"
            }
          >
            {location.pathname === "/pricing" ? (
              <PublicPricing />
            ) : (
              <PublicIpSearch />
            )}
          </main>
          <LegalFooter />
        </div>
      )}

      <Dialog
        open={notificationsOpen && canOpenPage(session, tenant, "messages")}
        onOpenChange={setNotificationsOpen}
      >
        <DialogContent className="notification-dialog parity-notifications">
          <DialogHeader>
            <DialogTitle>消息通知</DialogTitle>
            <DialogDescription className="sr-only">
              企业订阅动态与到期提醒
            </DialogDescription>
          </DialogHeader>
          <Messages
            key={tenant}
            compact
            tenant={tenant}
            csrf={csrf}
            enabled={true}
            state={messages}
            go={(next) => {
              setNotificationsOpen(false);
              go(next);
            }}
          />
        </DialogContent>
      </Dialog>
      <AccountDialog open={auth} onOpenChange={setAuth} />
    </AccessContext.Provider>
  );
}
if (document.getElementById("root") && !location.pathname.startsWith("/demos/"))
  createRoot(document.getElementById("root")!).render(<App />);
