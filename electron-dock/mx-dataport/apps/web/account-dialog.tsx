import { useEffect, useState } from "react";
import {
  Layers3,
  ShieldCheck,
  Eye,
  EyeOff,
  Mail,
  LockKeyhole,
  ArrowRight,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "./dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { request, loadAccountForm, navigateAfterLogin, type AccountOptions } from "./api";
type AccountDialogProps = {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onAuthenticated?: () => void;
  preview?: boolean;
};
export function AccountDialog(props: AccountDialogProps) {
  // Each opening obtains a fresh form before mounting the dialog. A cold SSO
  // redirect must not briefly display a form that will immediately disappear.
  return props.open ? <AccountDialogSession {...props} /> : null;
}
function AccountDialogSession({
  open,
  onOpenChange,
  onAuthenticated,
  preview = false,
}: AccountDialogProps) {
  const [options, setOptions] = useState<AccountOptions | null>(null),
    [employee, setEmployee] = useState(!new URLSearchParams(location.search).has("account")),
    [register, setRegister] = useState(false),
    [error, setError] = useState(""),
    [unavailable, setUnavailable] = useState(false),
    [retry, setRetry] = useState(0),
    [checking, setChecking] = useState(!preview),
    [busy, setBusy] = useState(false),
    [show, setShow] = useState(false);
  useEffect(() => {
    if (!open || preview) return;
    if (employee) { setChecking(false); setUnavailable(false); setError(""); return; }
    let active = true;
    setChecking(true);
    setOptions(null);
    setUnavailable(false);
    setError("");
    loadAccountForm({
      register,
      canRestart:
        !new URLSearchParams(location.search).has("account") || retry > 0,
      current: () => active,
    })
      .then((value) => {
        if (active) {
          if ("redirect" in value) {
            location.replace(value.redirect);
            return;
          }
          setOptions(value.options);
          setUnavailable(false);
          if (!retry) setRegister(value.options.view === "register" && value.options.policy?.mode === "invite_code");
        }
      })
      .catch((error) => {
        if (!active) return;
        if (active) {
          setOptions(null);
          setUnavailable(true);
          setError(
            error.name === "TimeoutError"
              ? "连接超时，请重试。"
              : error.message || "账号服务暂不可用，请稍后重试。",
          );
        }
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [open, preview, retry, employee]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (checking) return;
    if (unavailable) {
      setRetry((value) => value + 1);
      return;
    }
    if (preview) {
      setError("组件预览不创建账号或提交登录。");
      return;
    }
    if (!employee && !options) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (employee) {
        const result = await request<{redirect:string}>("/auth/local/login", {
          method:"POST",signal:AbortSignal.timeout(15000),
          body:JSON.stringify({account:data.get("login"),password:data.get("password")}),
        });
        navigateAfterLogin(result.redirect, location, history, onAuthenticated);
        return;
      }
      const result = await request<{ redirect: string }>("/auth/sso/form", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: { "x-mx-csrf": options!.csrf },
        body: JSON.stringify({
          action: register ? "register" : "login",
          formId: options!.formId,
          policyVersion: options!.policy?.version,
          ...Object.fromEntries(data),
        }),
      });
      navigateAfterLogin(result.redirect);
    } catch (e) {
      setError(
        (e as Error).name === "TimeoutError"
          ? "提交结果尚未确认，请先尝试登录；注册请求请勿重复提交。"
          : (e as Error).message,
      );
      if ([409, 410].includes((e as { status?: number }).status ?? 0)) {
        setOptions(null);
        setUnavailable(true);
      }
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open && (employee || preview || !!options || unavailable || checking)}
      onOpenChange={(value) => {
        if (!busy) {
          onOpenChange(value);
          setError("");
          setShow(false);
        }
      }}
    >
      <DialogContent
        className="auth-dialog risk-auth-dialog"
        showCloseButton={false}
      >
        <aside className="auth-brand-panel">
          <div className="auth-wordmark">
            <Layers3 />
            <strong>
              数港<span>DataPort</span>
            </strong>
          </div>
          <div className="risk-auth-message">
            <div className="risk-auth-shield">
              <ShieldCheck />
            </div>
            <h2>IP 风险画像</h2>
            <p>
              查询风险等级、行为标签与网络归属，了解 IP
              来源特征，为业务风控与安全研判提供参考。
            </p>
          </div>
        </aside>
        <div className="auth-form-panel">
          <div className="auth-mobile-brand" aria-hidden="true">
            <Layers3 />
            数港 DataPort
          </div>
          <DialogHeader>
            <DialogTitle>{register ? "受邀加入数港" : "登录数港"}</DialogTitle>
            <DialogDescription>{employee ? "使用企业超管创建的数港子账号登录。" : "企业超管使用统一 MX 账号，首次开通需 DataPort 专用邀请。"}</DialogDescription>
          </DialogHeader>
          <div className="auth-login-modes" role="group" aria-label="登录方式">
            <Button type="button" variant={employee ? "outline" : "default"} disabled={busy} onClick={() => {setEmployee(false);setError("");}}>企业超管 · MX 登录</Button>
            <Button type="button" variant={employee ? "default" : "outline"} disabled={busy} onClick={() => {setEmployee(true);setRegister(false);setError("");}}>子账号登录</Button>
          </div>
          {!employee && options?.policy?.mode === "invite_code" && (
            <div className="auth-owner-actions" role="group" aria-label="超管登录或注册">
              <Button type="button" variant={!register ? "secondary" : "ghost"} disabled={busy || checking} onClick={() => {setRegister(false);setError("");}}>已有 MX 账号登录</Button>
              <Button type="button" variant={register ? "secondary" : "ghost"} disabled={busy || checking} onClick={() => {setRegister(true);setError("");}}>邀请码注册</Button>
            </div>
          )}
          <form onSubmit={submit} aria-busy={busy || checking}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="auth-login">{employee ? "数港子账号" : "MX 账号"}</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="auth-login"
                    name="login"
                    required
                    maxLength={64}
                    autoComplete="username"
                    defaultValue={options?.loginHint || ""}
                    placeholder={employee ? "输入企业超管分配的子账号" : "输入你的 MX 账号"}
                    disabled={busy}
                  />
                  <InputGroupAddon>
                    <Mail />
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="auth-password">密码</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="auth-password"
                    name="password"
                    type={show ? "text" : "password"}
                    required
                    minLength={register ? 8 : undefined}
                    maxLength={128}
                    autoComplete={
                      register ? "new-password" : "current-password"
                    }
                    placeholder="输入密码"
                    disabled={busy}
                  />
                  <InputGroupAddon>
                    <LockKeyhole />
                  </InputGroupAddon>
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="button"
                      aria-label={show ? "隐藏密码" : "显示密码"}
                      onClick={() => setShow(!show)}
                    >
                      {show ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              {register && (
                <Field>
                  <FieldLabel htmlFor="auth-confirm">确认密码</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="auth-confirm"
                      name="passwordConfirm"
                      type="password"
                      required
                      minLength={8}
                      maxLength={128}
                      autoComplete="new-password"
                      disabled={busy}
                    />
                  </InputGroup>
                </Field>
              )}
              {!employee && (
                <Field>
                  <FieldLabel htmlFor="auth-invite">{register ? "DataPort 专用邀请码" : "DataPort 专用邀请码（首次开通时填写）"}</FieldLabel>
                  <InputGroup>
                    <InputGroupInput id="auth-invite" name="inviteCode" required={register} maxLength={128} autoComplete="off" placeholder="输入 Launcher 提供的 DataPort 专用邀请码" disabled={busy} aria-describedby="auth-invite-help" />
                  </InputGroup>
                  <FieldDescription id="auth-invite-help">
                    {register
                      ? "注册新 MX 账号必须填写有效的 DataPort 专用邀请码。已有 MX 账号请切换到登录。"
                      : "已开通数港的 MX 账号可留空。此处用于开通数港，企业超管身份仍需后续校验。"}
                  </FieldDescription>
                </Field>
              )}
              {register &&
              options &&
              options?.policy?.mode !== "invite_code" &&
              !preview ? (
                <FieldError>
                  {options.policy?.mode === "closed"
                    ? "暂未开放邀请注册，请联系管理员。"
                    : "邀请注册设置暂不可用，请稍后重新打开登录窗口。"}
                </FieldError>
              ) : null}
              {error && <FieldError role="alert">{error}</FieldError>}
              <Button
                type={unavailable ? "button" : "submit"}
                onClick={
                  unavailable ? () => setRetry((value) => value + 1) : undefined
                }
                className="auth-submit"
                disabled={
                  busy ||
                  checking ||
                  (register &&
                    !!options &&
                    !unavailable &&
                    options.policy?.mode !== "invite_code")
                }
              >
                {busy || checking ? <Spinner /> : null}
                {checking
                  ? "连接中"
                  : unavailable
                    ? "重试连接"
                    : register
                      ? "注册并进入数港"
                      : "登录"}
                <ArrowRight />
              </Button>
            </FieldGroup>
          </form>
          <p
            className={register ? "auth-register-hint" : "managed-account-note"}
          >
            {register ? (
              "使用 DataPort 专用邀请码创建 MX 账号并开通数港。已有 MX 账号请在登录页使用邀请码开通。"
            ) : (
              <>
                {employee ? "子账号由企业超管创建" : "专用邀请由 Launcher 用户中心签发"}
                <br />
                如需开通或重置密码，请联系管理员
              </>
            )}
          </p>
          <nav className="auth-legal-links" aria-label="登录法律信息">
            <a href="/terms">用户协议</a>
            <span>·</span>
            <a href="/privacy">隐私政策</a>
            <span>·</span>
            <a href="/cookies">Cookie 说明</a>
          </nav>
          <DialogClose
            className="auth-close"
            aria-label="关闭登录"
            disabled={busy}
          >
            <X />
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
