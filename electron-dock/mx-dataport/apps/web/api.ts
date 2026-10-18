export const validIpv4 = (value: string) =>
  /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) &&
  value.split(".").every((v) => Number(v) <= 255);
export async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    redirect: "error",
    credentials: options.credentials ?? "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  // Successful local sign-out intentionally has no JSON body.
  if (response.status === 204) return undefined as T;
  let result;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(new Error("服务响应异常，请稍后重试。"), {
      status: response.status,
      code: "invalid_response",
      requestId: response.headers.get("x-request-id"),
    });
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        result.message || result.error?.message || "服务暂不可用，请稍后重试",
      ),
      {
        status: response.status,
        code: result.code || result.error?.code,
        requestId: result.requestId || response.headers.get("x-request-id"),
      },
    );
  return result;
}
export type AccountOptions = {
  csrf: string;
  formId: string;
  view?: string;
  policy?: { mode: string; version: number };
  admissionRequired?: boolean;
  loginHint?: string;
};

// A fragment-only navigation does not remount App or reload its session. Login
// has already set the cookie, so explicitly load a new document in that case.
export function navigateAfterLogin(
  redirect: string,
  target: Pick<Location, "href" | "assign" | "reload"> = location,
  navigation: Pick<History, "replaceState"> = history,
) {
  const current = new URL(target.href);
  const destination = new URL(redirect, current);
  if (
    destination.origin === current.origin &&
    destination.pathname === current.pathname &&
    destination.search === current.search
  ) {
    navigation.replaceState(null, "", destination.href);
    target.reload();
  } else {
    target.assign(destination.href);
  }
}
export const startAccountSession = (register = false) =>
  request<{ redirect: string }>(
    `/auth/sso/start?view=${register ? "register" : "login"}`,
    { method: "POST", body: "{}", signal: AbortSignal.timeout(15000) },
  );

// A 410 can come from either the local transaction or the issuer's interaction.
// They have different error codes but both require a NEW OIDC round trip.
export async function loadAccountForm({
  register = false,
  canRestart = false,
  current = (): boolean => true,
  read = () =>
    request<AccountOptions>("/auth/sso/form", {
      signal: AbortSignal.timeout(15000),
    }),
  start = startAccountSession,
} = {}): Promise<{ options: AccountOptions } | { redirect: string }> {
  try {
    return { options: await read() };
  } catch (error) {
    if (
      (error as { status?: number }).status === 410 &&
      canRestart &&
      current()
    )
      return start(register);
    throw error;
  }
}
