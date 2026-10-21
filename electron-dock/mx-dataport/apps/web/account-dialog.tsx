import { useEffect, useRef, useState } from "react";
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
  FieldError,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { request, loadAccountForm, navigateAfterLogin, loginFailureUncertain, type AccountOptions } from "./api";
type AccountDialogProps = {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onAuthenticated?: () => void;
  preview?: boolean;
};
export function AccountDialog(props: AccountDialogProps) {
  // Each opening starts fresh; no password or invitation survives closing.
  return props.open ? <AccountDialogSession {...props} /> : null;
}
function AccountDialogSession({
  open,
  onOpenChange,
  onAuthenticated,
  preview = false,
}: AccountDialogProps) {
  const active = useRef(true);
  const formRef = useRef<HTMLFormElement>(null);
  const focusPassword = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const [options, setOptions] = useState<AccountOptions | null>(null),
    [login, setLogin] = useState(""),
    [error, setError] = useState(""),
    [unavailable, setUnavailable] = useState(false),
    [retry, setRetry] = useState(0),
    [checking, setChecking] = useState(!preview && new URLSearchParams(location.search).has("account")),
    [busy, setBusy] = useState(false),
    [preparing, setPreparing] = useState(false),
    [preparedLogin, setPreparedLogin] = useState(""),
    [uncertain, setUncertain] = useState(false),
    [show, setShow] = useState(false);
  useEffect(() => {
    if (!preparing && focusPassword.current) {
      focusPassword.current = false;
      formRef.current?.querySelector<HTMLInputElement>('[name="password"]')?.focus();
    }
  }, [preparing]);
  useEffect(() => {
    if (!open || preview) return;
    let active = true;
    setChecking(new URLSearchParams(location.search).has("account") || retry > 0);
    setOptions(null);
    setUnavailable(false);
    setError("");
    loadAccountForm({
      canRestart: retry > 0,
      current: () => active,
    })
      .then((value) => {
        if (active) {
          if ("redirect" in value) {
            location.replace(value.redirect);
            return;
          }
          setOptions(value.options);
          setLogin((current) => current || value.options.loginHint || "");
          setUnavailable(false);
        }
      })
      .catch((error) => {
        if (!active) return;
        // A new public dialog has no MX transaction yet. Local accounts can
        // submit immediately; the server starts OIDC only for an MX identity.
        if ((error as {status?: number}).status === 410 && !new URLSearchParams(location.search).has("account")) return;
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
  }, [open, preview, retry]);
  async function prepareLogin(form: HTMLFormElement | null) {
    if (!form || preview || checking || preparing || busy || uncertain || options || !login.trim() || preparedLogin === login.trim()) return;
    const data = new FormData(form);
    // Connect MX before entering credentials. Autofilled secrets are never
    // discarded by a blur-triggered redirect; submission handles that case.
    if (data.get("password") || data.get("inviteCode")) return;
    setPreparing(true);
    setError("");
    try {
      const result = await request<{redirect?:string;ready?:boolean}>("/auth/login/prepare", {
        method:"POST",signal:AbortSignal.timeout(15000),body:JSON.stringify({login:login.trim()}),
      });
      if (active.current && result.redirect) location.assign(result.redirect);
      else if (active.current && result.ready) {
        setPreparedLogin(login.trim());
        focusPassword.current = true;
      }
    } catch (e) {
      if (active.current) {
        focusPassword.current = true;
        setError((e as Error).name === "TimeoutError" ? "连接超时，请重试。" : (e as Error).message);
      }
    } finally {
      if (active.current) setPreparing(false);
    }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (checking || preparing || busy || uncertain) return;
    if (unavailable) {
      setRetry((value) => value + 1);
      return;
    }
    if (preview) {
      setError("组件预览不创建账号或提交登录。");
      return;
    }
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await request<{ redirect: string }>("/auth/login", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        ...(options ? {headers: { "x-mx-csrf": options.csrf }} : {}),
        body: JSON.stringify({
          ...Object.fromEntries(data),
          ...(options ? {formId: options.formId} : {}),
        }),
      });
      if (typeof result.redirect !== "string") throw Object.assign(new Error("登录响应尚未确认。"), {code:"invalid_response"});
      navigateAfterLogin(result.redirect, location, history, onAuthenticated);
    } catch (e) {
      const unconfirmed = loginFailureUncertain(e);
      if (unconfirmed) setUncertain(true);
      setError(
        unconfirmed
          ? "提交结果尚未确认，请先核对登录状态，勿重复提交。"
          : (e as Error).message,
      );
      if (["account_flow_expired", "account_form_changed"].includes((e as {code?: string}).code || "") || (e as {status?: number}).status === 410) {
        setOptions(null);
        setUnavailable(true);
      }
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
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
            <DialogTitle>登录数港</DialogTitle>
            <DialogDescription>登录后查询 IP 风险画像</DialogDescription>
          </DialogHeader>
          <form ref={formRef} onSubmit={submit} aria-busy={busy || checking || preparing}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="auth-login">账号</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="auth-login"
                    name="login"
                    required
                    maxLength={255}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={login}
                    onChange={(event) => setLogin(event.target.value)}
                    onBlur={(event) => { void prepareLogin(event.currentTarget.form); }}
                    placeholder="输入管理员提供的账号"
                    disabled={busy || preparing}
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
                    maxLength={128}
                    autoComplete="current-password"
                    placeholder="输入密码"
                    disabled={busy || preparing}
                  />
                  <InputGroupAddon>
                    <LockKeyhole />
                  </InputGroupAddon>
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="button"
                      disabled={busy || preparing}
                      aria-pressed={show}
                      size="icon-sm"
                      aria-label={show ? "隐藏密码" : "显示密码"}
                      onClick={() => setShow(!show)}
                    >
                      {show ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="auth-invite-code">邀请码 <span className="auth-optional">（选填）</span></FieldLabel>
                <Input id="auth-invite-code" name="inviteCode" maxLength={128} autoComplete="off" disabled={busy || preparing}
                  placeholder="企业超管首次开通时填写" aria-describedby="auth-invite-hint" />
                <p id="auth-invite-hint" className="auth-invite-hint">企业超管首次开通数港时填写，已开通账号及子账号无需填写。</p>
              </Field>
              {error && <FieldError className="auth-error" role="alert">{error}</FieldError>}
              <Button
                type={unavailable ? "button" : "submit"}
                onClick={
                  unavailable ? () => setRetry((value) => value + 1) : undefined
                }
                className="auth-submit w-full"
                size="lg"
                disabled={busy || checking || preparing || uncertain}
              >
                {busy || checking || preparing ? <Spinner data-icon="inline-start" /> : null}
                {checking || preparing
                  ? "连接中"
                  : unavailable
                    ? "重试连接"
                    : busy ? "正在登录…" : "登录"}
                {!busy && !checking && !preparing && <ArrowRight data-icon="inline-end" />}
              </Button>
            </FieldGroup>
          </form>
          {uncertain && <Button type="button" variant="outline" className="auth-check-session" onClick={() => {
            if (onAuthenticated) onAuthenticated();
            else location.reload();
          }}>核对登录状态</Button>}
          <p className="managed-account-note">
            账号由管理员统一开通
            <br />
            如需开通或重置密码，请联系管理员
          </p>
          <nav className="auth-legal-links" aria-label="登录法律信息">
            <a href="/terms" target="_blank" rel="noopener">用户协议</a>
            <span>·</span>
            <a href="/privacy" target="_blank" rel="noopener">隐私政策</a>
            <span>·</span>
            <a href="/cookies" target="_blank" rel="noopener">Cookie 说明</a>
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
