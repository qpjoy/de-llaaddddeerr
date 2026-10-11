import React, { useEffect, useState } from "react";
import { UserRound, LockKeyhole, Monitor, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { request, startAccountSession } from "./api";
export function AccountSecurity() {
  const [section, setSection] = useState("profile");
  const [notice, setNotice] = useState("");
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
    if (body.action === "password" && body.password !== body.confirmPassword) {
      setError("两次输入的新密码不一致。");
      return;
    }
    delete body.confirmPassword;
    setNotice("");
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
      setNotice("账户资料已保存。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sections = [
    {
      id: "profile",
      title: "个人资料",
      detail: data?.account || "统一 MX 账号",
      Icon: UserRound,
    },
    {
      id: "password",
      title: "登录密码",
      detail: "修改后需要重新登录",
      Icon: LockKeyhole,
    },
    {
      id: "sessions",
      title: "登录会话",
      detail: `${data?.sessions?.length ?? 0} 个登录会话`,
      Icon: Monitor,
    },
  ];
  return (
    <div className="harbor-account">
      <div className="page-heading">
        <h1>账户安全</h1>
        <p>管理你的统一 MX 账号资料与登录安全。</p>
      </div>
      {error && (
        <p role="alert" className="harbor-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!data ? (
        <p>
          {error ? "账户信息暂不可用。" : "正在读取账户…"}
          <Button variant="link" onClick={load}>
            重新读取
          </Button>
        </p>
      ) : (
        <>
          <div className="harbor-account-summary">
            <span className="harbor-avatar">
              {(data.displayName || data.account || "M").slice(0, 1)}
            </span>
            <div>
              <strong>{data.displayName || data.account}</strong>
              <p>{data.account}</p>
            </div>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const result = await startAccountSession();
                  location.assign(result.redirect);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              切换账号
            </Button>
          </div>
          <div className="harbor-settings">
            {sections.map(({ id, title, detail, Icon }) => (
              <section className="harbor-setting" key={id}>
                <button
                  className="harbor-setting-heading"
                  aria-expanded={section === id}
                  aria-controls={`settings-${id}`}
                  onClick={() => {
                    setSection(section === id ? "" : id);
                    setError("");
                    setNotice("");
                  }}
                >
                  <Icon />
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </span>
                  <ChevronDown />
                </button>
                {section === id && (
                  <div id={`settings-${id}`} className="harbor-setting-body">
                    <form onSubmit={submit} className="harbor-form">
                      <input
                        type="hidden"
                        name="action"
                        value={id === "sessions" ? "revoke" : id}
                      />
                      {id === "profile" && (
                        <label>
                          显示名称
                          <Input
                            name="displayName"
                            defaultValue={data.displayName}
                            required
                            maxLength={80}
                          />
                        </label>
                      )}
                      {id === "sessions" && (
                        <>
                          <input type="hidden" name="target" value="all" />
                          <p>
                            撤销后需要重新登录。此操作使用统一账号服务的会话撤销规则。
                          </p>
                        </>
                      )}
                      <label>
                        {id === "sessions" ? "验证密码" : "当前密码"}
                        <Input
                          name="currentPassword"
                          type="password"
                          autoComplete="current-password"
                          required
                        />
                      </label>
                      {id === "password" && (
                        <>
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
                          <label>
                            确认新密码
                            <Input
                              name="confirmPassword"
                              type="password"
                              autoComplete="new-password"
                              minLength={8}
                              maxLength={128}
                              required
                            />
                          </label>
                        </>
                      )}
                      <div>
                        <Button disabled={busy}>
                          {busy
                            ? "正在保存…"
                            : id === "profile"
                              ? "保存资料"
                              : id === "password"
                                ? "保存并重新登录"
                                : "撤销全部会话"}
                        </Button>
                      </div>
                    </form>
                  </div>
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
