import { useRef } from "react";
import { ChevronUp, LogOut, UserRound, Wallet } from "lucide-react";
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

// Keep the original DataPort account menu layout; actions use Harbor's SSO/BFF.
export function SidebarAccountMenu({
  name,
  page,
  navigate,
  onLogout,
}: {
  name: string;
  page: string;
  navigate: (page: string) => void;
  onLogout: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const navigating = useRef(false);
  function select(next: string) {
    navigating.current = isMobile;
    navigate(next);
    setOpenMobile(false);
  }
  return (
    <SidebarMenu className="sidebar-account-wrap">
      <SidebarMenuItem>
        <DropdownMenu>
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
            <DropdownMenuLabel className="sidebar-account-label">
              <strong>{name}</strong>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                aria-current={page === "orders" ? "page" : undefined}
                onSelect={() => select("orders")}
              >
                <Wallet />
                支付订单
              </DropdownMenuItem>
              <DropdownMenuItem
                aria-current={page === "account" ? "page" : undefined}
                onSelect={() => select("account")}
              >
                <UserRound />
                账户安全
              </DropdownMenuItem>
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
