import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConsoleShell } from "../../apps/web/main";
import { AccountDialog } from "../../apps/web/account-dialog";
import { PublicIpSearch } from "../../apps/web/public-ip-search";
import { AccessContext } from "../../apps/web/public-access";
import { PublicHeader } from "../../apps/web/public-header";
import { Button } from "@/components/ui/button";
function Gallery() {
  const [login, setLogin] = useState(false),
    [consoleView, setConsole] = useState(false);
  return (
    <AccessContext.Provider
      value={{
        signedIn: false,
        enter: () => setLogin(true),
        account: () => setLogin(true),
      }}
    >
      <div className="harbor-gallery-banner">
        设计组件预览 · 无真实账号、订单或查询{" "}
        <Button variant="ghost" onClick={() => setConsole(!consoleView)}>
          {consoleView ? "查看首页" : "查看控制台"}
        </Button>
        <Button variant="ghost" onClick={() => setLogin(true)}>
          登录 / 邀请注册
        </Button>
      </div>
      {consoleView ? (
        <ConsoleShell
          page="intelligence"
          go={() => {}}
          name="预览账号"
          onLogout={() => setConsole(false)}
        >
          <PublicIpSearch />
        </ConsoleShell>
      ) : (
        <div className="public-site query-backdrop">
          <PublicHeader />
          <main className="public-query-main">
            <PublicIpSearch />
          </main>
        </div>
      )}
      <AccountDialog open={login} onOpenChange={setLogin} preview />
    </AccessContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Gallery />);
