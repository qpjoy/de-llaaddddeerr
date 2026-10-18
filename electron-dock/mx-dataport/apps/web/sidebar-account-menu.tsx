import { useEffect, useRef, useState } from "react";
import {
  ChevronUp,
  LogOut,
  Users,
  ClipboardList,
  Bell,
  CircleArrowUp,
} from "lucide-react";
import { canOpenPage, enterpriseUrl, hasPermission } from "./permissions";
import { request } from "./api";
import { currentSubscription } from "./commerce-state";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar";

// Keep the original DataPort account menu layout; actions use DataPort's SSO/BFF.
export function SidebarAccountMenu({
  name,
  page,
  navigate,
  onLogout,
  session,
  tenant,
  unread,
}: {
  name: string;
  page: string;
  navigate: (page: string) => void;
  onLogout: () => void;
  session?: any;
  tenant?: string;
  unread?: number;
}) {
  const [open, setOpen] = useState(false),
    [quota, setQuota] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [quotaError, setQuotaError] = useState("");
  useEffect(() => {
    if (!open || !hasPermission(session, tenant || "", "usage.read")) return;
    const c = new AbortController();
    setQuota(null);
    setLoading(true);
    setQuotaError("");
    request(enterpriseUrl(tenant || "", "query-access"), { signal: c.signal })
      .then((v) => {
        if (!c.signal.aborted)
          setQuota(currentSubscription(v.data.subscriptions));
      })
      .catch((e) => {
        if (!c.signal.aborted) setQuotaError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [open, tenant, session]);
  const { isMobile, setOpenMobile } = useSidebar();
  const navigating = useRef(false);
  function select(next: string) {
    setOpen(false);
    navigating.current = isMobile;
    navigate(next);
    setOpenMobile(false);
  }
  return (
    <SidebarMenu className="sidebar-account-wrap">
      <SidebarMenuItem>
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="sidebar-account-trigger"
              aria-label="账户信息"
              isActive={page === "account" || page === "orders"}
            >
              <Avatar aria-hidden="true">
                <AvatarFallback>
                  {name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="sidebar-account-name" title={name}>
                {name}
              </span>
              <ChevronUp
                className="sidebar-account-chevron"
                aria-hidden="true"
              />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="sidebar-account-menu"
            side="top"
            align="start"
            sideOffset={10}
            collisionPadding={12}
            onCloseAutoFocus={(event) => {
              if (navigating.current) event.preventDefault();
              navigating.current = false;
            }}
          >
            <DropdownMenuLabel className="sidebar-account-label account-profile-header">
              <Avatar aria-hidden="true">
                <AvatarFallback>
                  {name.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <strong title={name}>{name}</strong>
                <span>
                  {loading
                    ? "加载中…"
                    : quotaError
                      ? "套餐暂不可用"
                      : quota
                        ? quota.product?.name || "企业订阅"
                        : "尚未订阅"}
                </span>
              </div>
            </DropdownMenuLabel>
            {hasPermission(session, tenant || "", "usage.read") && (
              <div className="account-plan-summary" aria-live="polite">
                {loading ? (
                  <p>正在读取额度…</p>
                ) : quotaError ? (
                  <p>额度暂不可用</p>
                ) : (
                  <>
                    <div>
                      <span>剩余查询</span>
                      <b>
                        {quota
                          ? Math.max(
                              0,
                              quota.quota - quota.used - quota.held,
                            ).toLocaleString("zh-CN")
                          : 0}
                        <small> 次</small>
                      </b>
                    </div>
                    {quota && (
                      <p>
                        {new Date(quota.endsAt).toLocaleDateString("zh-CN")}{" "}
                        到期{quota.held > 0 ? ` · ${quota.held} 次待确认` : ""}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
            <DropdownMenuGroup>
              {session?.identityProvider === "dataport-local" && (
                <DropdownMenuItem onSelect={() => select("account")}>
                  <Users />账户安全
                </DropdownMenuItem>
              )}
              {(session === undefined ||
                canOpenPage(session, tenant || "", "services")) && (
                <DropdownMenuItem
                  className="account-upgrade"
                  onSelect={() => select("services")}
                >
                  <CircleArrowUp />
                  升级套餐
                </DropdownMenuItem>
              )}
              {(session === undefined ||
                canOpenPage(session, tenant || "", "messages")) && (
                <DropdownMenuItem onSelect={() => select("messages")}>
                  <Bell />
                  消息通知
                  {!!unread && <span className="harbor-unread">{unread}</span>}
                </DropdownMenuItem>
              )}
              {(session === undefined ||
                canOpenPage(session, tenant || "", "team")) && (
                <DropdownMenuItem onSelect={() => select("team")}>
                  <Users />
                  企业账号
                </DropdownMenuItem>
              )}
              {(session === undefined ||
                canOpenPage(session, tenant || "", "audit")) && (
                <DropdownMenuItem onSelect={() => select("audit")}>
                  <ClipboardList />
                  日志审阅
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout}>
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
