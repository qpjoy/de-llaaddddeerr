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
} from "@/components/ui/dialog";
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
import { request, startAccountSession, type AccountOptions } from "./api";
export function AccountDialog({
  open,
  onOpenChange,
  preview = false,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  preview?: boolean;
}) {
  const [options, setOptions] = useState<AccountOptions | null>(null),
    [register, setRegister] = useState(false),
    [error, setError] = useState(""),
    [unavailable, setUnavailable] = useState(false),
    [retry, setRetry] = useState(0),
    [checking, setChecking] = useState(false),
    [busy, setBusy] = useState(false),
    [show, setShow] = useState(false);
  useEffect(() => {
    if (!open || preview) return;
    let active = true;
    setChecking(true);
    setOptions(null);
    setUnavailable(false);
    setError("");
    request<AccountOptions>("/auth/sso/form")
      .then((value) => {
        if (active) {
          setOptions(value);
          setUnavailable(false);
          setRegister(value.view === "register");
        }
      })
      .catch(async (error) => {
        if (!active) return;
        // Establish issuer cookies through a top-level OIDC round trip, then
        // return to this form. Never loop when the returned flow is invalid.
        if (
          error.code === "account_flow_expired" &&
          (!new URLSearchParams(location.search).has("account") || retry > 0)
        ) {
          try {
            const result = await startAccountSession(register);
            if (active) location.replace(result.redirect);
            return;
          } catch (startError) {
            error = startError;
          }
        }
        if (active) {
          setOptions(null);
          setUnavailable(true);
          setError(error.message || "账号服务暂不可用，请稍后重试。");
        }
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [open, preview, retry]);
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
    if (!options) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await request<{ redirect: string }>("/auth/sso/form", {
        method: "POST",
        headers: { "x-mx-csrf": options.csrf },
        body: JSON.stringify({
          action: register ? "register" : "login",
          formId: options.formId,
          policyVersion: options.policy?.version,
          ...Object.fromEntries(data),
        }),
      });
      location.assign(result.redirect);
    } catch (e) {
      setError((e as Error).message);
      if ([409, 410].includes((e as { status?: number }).status ?? 0)) {
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
            <DialogTitle>{register ? "受邀加入数港" : "登录数港"}</DialogTitle>
            <DialogDescription>
              使用统一 MX 账号，首次进入需邀请或管理员开通
            </DialogDescription>
          </DialogHeader>
          <div
            className="harbor-auth-tabs"
            role="group"
            aria-label="登录或注册"
          >
            <Button
              type="button"
              variant={!register ? "secondary" : "ghost"}
              disabled={busy || checking}
              onClick={() => {
                setRegister(false);
                if (!unavailable) setError("");
              }}
            >
              登录
            </Button>
            <Button
              type="button"
              variant={register ? "secondary" : "ghost"}
              disabled={busy || checking}
              onClick={() => {
                setRegister(true);
                if (!unavailable) setError("");
              }}
            >
              邀请码注册
            </Button>
          </div>
          <form onSubmit={submit} aria-busy={busy || checking}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="auth-login">MX 账号</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="auth-login"
                    name="login"
                    required
                    maxLength={64}
                    autoComplete="username"
                    defaultValue={options?.loginHint || ""}
                    placeholder="输入你的 MX 账号"
                    disabled={busy || (!options && !preview)}
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
                    disabled={busy || (!options && !preview)}
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
                      disabled={busy || (!options && !preview)}
                    />
                  </InputGroup>
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="auth-invite">
                  {register ? "Harbor 邀请码" : "Harbor 邀请码（选填）"}
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="auth-invite"
                    name="inviteCode"
                    required={register}
                    maxLength={128}
                    autoComplete="off"
                    aria-describedby={
                      !register ? "auth-invite-help" : undefined
                    }
                    placeholder="输入邀请人提供的邀请码"
                    disabled={busy || (!options && !preview)}
                  />
                </InputGroup>
                {!register && (
                  <FieldDescription id="auth-invite-help">
                    仅尚未开通数港的账号首次进入时填写。已开通或由管理员授权的账号可留空。
                  </FieldDescription>
                )}
              </Field>
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
          <p className="auth-register-hint">
            {register
              ? "使用 Harbor 专用邀请码创建 MX 账号并开通数港。已有 MX 账号请在登录页使用邀请码开通。"
              : "可直接填写其他 MX 账号登录。忘记密码或需要开通数港，请联系管理员。"}
          </p>
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
